#!/usr/bin/env bash
#
# Cloud Run へ検索 API をデプロイする。
#
# .env の値をそのまま Cloud Run の環境変数として渡す。
# ただし Gemini API キーと kintone の認証情報は同期パイプライン専用なので渡さない。
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Error: .env file not found." >&2
  exit 1
fi

# 値に空白・引用符・# が含まれていても壊れないように source で読み込む
# (旧実装の `export $(grep -v '^#' .env | xargs)` はこれらで壊れる)
set -a
# shellcheck disable=SC1091
. ./.env
set +a

REQUIRED_VARS=(PROJECT_ID PROJECT_NUMBER LOCATION AI_APPLICATION_ID)
missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Error: .env に以下の環境変数を設定してください: ${missing[*]}" >&2
  exit 1
fi

SERVICE_NAME="${CLOUD_RUN_SERVICE:-rag-engine-service}"
REGION="${CLOUD_RUN_REGION:-asia-northeast1}"
SERVICE_ACCOUNT="${CLOUD_RUN_SERVICE_ACCOUNT:-rag-app-runner@${PROJECT_ID}.iam.gserviceaccount.com}"

# 検索 API の実行に必要な変数だけを渡す
ENV_VARS=(
  "PROJECT_ID=${PROJECT_ID}"
  "PROJECT_NUMBER=${PROJECT_NUMBER}"
  "LOCATION=${LOCATION}"
  "AI_APPLICATION_ID=${AI_APPLICATION_ID}"
)
# 任意設定 (未設定ならサービス側の既定値に任せる)
for var in SEARCH_PREAMBLE ANSWER_MAX_REFERENCES SEARCH_PAGE_SIZE LOG_LEVEL; do
  if [ -n "${!var:-}" ]; then
    ENV_VARS+=("${var}=${!var}")
  fi
done

# 既定の区切り文字はカンマだが、preamble などの文面にカンマが含まれ得るため
# gcloud の代替区切り文字構文 (^DELIM^) を使う
DELIM='@@'
joined=""
for kv in "${ENV_VARS[@]}"; do
  if [[ "$kv" == *"$DELIM"* ]]; then
    echo "Error: 環境変数の値に区切り文字 '${DELIM}' が含まれています: ${kv%%=*}" >&2
    exit 1
  fi
  if [ -z "$joined" ]; then joined="$kv"; else joined="${joined}${DELIM}${kv}"; fi
done
ENV_VARS_ARG="^${DELIM}^${joined}"

echo "Deploying to Cloud Run..."
echo "  Service:         ${SERVICE_NAME}"
echo "  Region:          ${REGION}"
echo "  Project ID:      ${PROJECT_ID}"
echo "  Service Account: ${SERVICE_ACCOUNT}"

gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --service-account="${SERVICE_ACCOUNT}" \
  --allow-unauthenticated \
  --cpu-boost \
  --min-instances="${CLOUD_RUN_MIN_INSTANCES:-0}" \
  --set-env-vars="${ENV_VARS_ARG}"
