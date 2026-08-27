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

# .env は shell スクリプトではないので source しない。
# source すると `KEY=Answer briefly` の `briefly` がコマンドとして実行され
# (set -e で即終了)、`$VAR` や `` ` `` も展開されてしまう。
# dotenv と同じ解釈になるよう自前で読む。
load_dotenv() {
  local file="$1" line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"          # 先頭の空白を落とす
    case "$line" in '' | '#'*) continue ;; esac      # 空行とコメント行
    line="${line#export }"
    case "$line" in *=*) ;; *) continue ;; esac      # KEY=VALUE 以外は無視

    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      [A-Za-z_]*) ;;
      *) continue ;;
    esac
    case "$key" in *[!A-Za-z0-9_]*) continue ;; esac

    value="${value#"${value%%[![:space:]]*}"}"       # 値の先頭の空白を落とす
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;   # "..." はそのまま
      \'*\') value="${value#\'}"; value="${value%\'}" ;;   # '...' はそのまま
      \`*\`) value="${value#\`}"; value="${value%\`}" ;;   # dotenv はバッククォートも引用符扱い
      *)
        value="${value%%#*}"                         # 引用符なしは # 以降をコメント扱い
        value="${value%"${value##*[![:space:]]}"}"   # 末尾の空白を落とす
        ;;
    esac

    export "${key}=${value}"
  done < "$file"
}

load_dotenv ./.env

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
for var in SEARCH_PREAMBLE ANSWER_MAX_REFERENCES SEARCH_PAGE_SIZE LOG_LEVEL ALLOW_UNAUTHENTICATED; do
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

# 検索 API のキーは環境変数に直接置かず、Secret Manager から注入する。
# SEARCH_API_KEY_SECRET が未設定で、かつ認証なし公開を明示していない場合は
# 起動時にアプリが落ちるので、その前にここで止める。
SECRET_ARGS=()
if [ -n "${SEARCH_API_KEY_SECRET:-}" ]; then
  SECRET_ARGS=(--set-secrets "SEARCH_API_KEYS=${SEARCH_API_KEY_SECRET}:latest")
  echo "  API Key Secret:  ${SEARCH_API_KEY_SECRET}:latest"
elif [ "${ALLOW_UNAUTHENTICATED:-}" = "true" ]; then
  echo "  ⚠ 認証なしで公開します (ALLOW_UNAUTHENTICATED=true)"
else
  cat >&2 <<'MSG'
Error: 検索 API のキーが設定されていません。

  .env に SEARCH_API_KEY_SECRET=<Secret Manager のシークレット名> を設定してください。
  シークレットの作り方は README の「検索 API の認証」を参照してください。

  意図して認証なしで公開する場合のみ ALLOW_UNAUTHENTICATED=true を設定してください。
MSG
  exit 1
fi

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
  --max-instances="${CLOUD_RUN_MAX_INSTANCES:-10}" \
  --set-env-vars="${ENV_VARS_ARG}" \
  "${SECRET_ARGS[@]}"
