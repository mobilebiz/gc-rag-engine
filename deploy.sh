#!/bin/bash

# .env ファイルの存在確認と読み込み
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
else
  echo "Error: .env file not found."
  exit 1
fi

# 必須変数のチェック
REQUIRED_VARS=("PROJECT_ID" "PROJECT_NUMBER" "LOCATION" "AI_APPLICATION_ID")
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "Error: Environment variable $var is not set."
    exit 1
  fi
done

echo "Deploying to Cloud Run using variables from .env..."
echo "Project ID: $PROJECT_ID"
echo "Service Account: rag-app-runner@${PROJECT_ID}.iam.gserviceaccount.com"

# Deploy to Cloud Run
gcloud run deploy rag-engine-service \
  --source . \
  --region asia-northeast1 \
  --service-account="rag-app-runner@${PROJECT_ID}.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --set-env-vars="PROJECT_ID=${PROJECT_ID},PROJECT_NUMBER=${PROJECT_NUMBER},LOCATION=${LOCATION},AI_APPLICATION_ID=${AI_APPLICATION_ID}"
