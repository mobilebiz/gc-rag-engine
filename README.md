# Google Cloud Vertex AI Agent Builder - RAG Engine

Google Vertex AI Agent Builder (旧 Discovery Engine) を利用した自然言語検索システムです。
FAQデータ（CSV）をGeminiで最適化（メタデータ付与）し、高精度な検索とAIによる回答生成機能を提供します。

## 必要要件

-   Node.js (v18以降)
-   Google Cloud Account & Project
-   Google Cloud CLI (`gcloud`)

## セットアップ

### 1. インストール
依存ライブラリをインストールします。
```bash
npm install
```

### 2. 環境変数の設定
`.env.sample` をコピーして `.env` を作成し、必要な値を入力してください。

```bash
cp .env.sample .env
```

| 変数名 | 説明 | 取得場所 |
| :--- | :--- | :--- |
| `PROJECT_ID` | プロジェクトID (文字列, 例: `my-project`) | Google Cloud Console |
| `PROJECT_NUMBER` | プロジェクト番号 (数値, 例: `123456789`) | Google Cloud Console ダッシュボード |
| `LOCATION` | リージョン (通常は `global`) | Agent Builder作成時の設定 |
| `AI_APPLICATION_ID` | アプリ(エンジン)のID | Agent Builder コンソール |
| `API_KEY` | Gemini API キー | [Google AI Studio](https://aistudio.google.com/) (データ作成用) |

### 3. Google Cloud 認証
ローカル環境で実行する場合、以下の手順で認証ツールとプロジェクトを設定します。

1.  **Google Cloud CLI へのログイン**
    ```bash
    gcloud auth login
    ```
2.  **プロジェクトの設定**
    利用するプロジェクトIDを指定します。
    ```bash
    gcloud config set project [PROJECT_ID]
    ```
3.  **ライブラリ用認証情報の取得 (ADC)**
    ローカルでのコード実行用に認証情報を取得します。
    ```bash
    gcloud auth application-default login
    ```

---

## 構築ワークフロー

### Step 1: データの準備 (CSV)
`faq_data.sample.csv` をコピーして `faq_data.csv` を作成し、実際のデータを入力してください。
フォーマットは、ヘッダーなし、1列目が質問、2列目が回答です。

```bash
cp faq_data.sample.csv faq_data.csv
```

**faq_data.csv 例:**
```csv
解約方法を教えて,マイページから解約手続きが可能です。
パスワードを忘れた,ログイン画面の「パスワードを忘れた方」から再発行してください。
```

### Step 2: データの最適化 (Gemini)
Gemini API を使用して、CSVデータを検索しやすい形式（メタデータ、類義語、キーワード付きのテキストファイル）に変換します。

```bash
node optimize_with_llm.js
```
*   **入力**: `faq_data.csv`
*   **出力**: `optimized_docs/` フォルダ内に `faq_001.txt` のようなファイルが生成されます。

### Step 3: クラウドストレージ (GCS) の準備
Google Cloud Console で Cloud Storage バケットを作成し、生成された `optimized_docs/` 内のファイルをアップロードします。

1.  [Cloud Storage コンソール](https://console.cloud.google.com/storage) でバケットを作成（例: `my-faq-bucket`）。
2.  作成したバケット内にフォルダを作成（例: `faq_docs`）。
3.  `optimized_docs/` 内の全 `.txt` ファイをアップロードします。

### Step 4: Vertex AI Agent Builder の作成
1.  [Agent and Gen App Builder コンソール](https://console.cloud.google.com/gen-app-builder) にアクセスします。
2.  **新しいアプリ**を作成します。
    *   タイプ: **検索 (Search)**
    *   機能: **汎用 (Generic)** または **メディア向け** など（推奨設定を確認）
    *   設定: **Enterprise エディション** は無効、**生成レスポンス**は有効
3.  **データストア** を作成し、アプリに紐付けます。
    *   ソース: **Cloud Storage**
    *   インポートするデータ: Step 3でアップロードしたフォルダを選択 (例: `gs://my-faq-bucket/faq_docs/*`)
    *   データの種類: **非構造化データ** (Unstructured documents)
4.  アプリ作成後、**アプリID** (App ID) を取得し、`.env` に設定します。
    *   変数名は `AI_APPLICATION_ID` です。

### Step 5: 動作確認
設定が完了したら、`query.js` を実行して検索と回答生成をテストします。

```bash
# 基本的な検索
node query.js "解約方法について教えて下さい"

# カスタムクエリ
node query.js "月額料金はいくらですか？"
```

スクリプトは以下の挙動をします：
1.  **検索**: ユーザーの質問に関連するドキュメントを検索。
2.  **回答生成**: 検索結果を元に、AIが要約回答を作成して表示（200文字以内、丁寧語の設定など）。

## ファイル構成
-   `optimize_with_llm.js`: CSVを読み込み、GeminiでRAG向けに最適化してファイル出力するスクリプト。
-   `query.js`: Discovery Engine API (v1alpha) を使用して検索・回答生成を行うクライアントスクリプト。
-   `package.json`: 依存関係の定義。

---

## Cloud Run へのデプロイ (本番運用)

Cloud Run で実行する場合、セキュリティのため **Service Account キーファイル (JSON) は使用しません**。
代わりに、専用の Service Account を作成し、Cloud Run にアタッチして実行します。

### 1. サービスアカウント (SA) の作成
```bash
# SAの作成
gcloud iam service-accounts create rag-app-runner \
  --display-name="RAG App Runner"

# 権限の付与 (検索実行用)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:rag-app-runner@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/discoveryengine.user"
```

### 2. デプロイ
`deploy.sh` スクリプトを実行します。このスクリプトは `.env` ファイルから環境変数を読み込み、Cloud Run へデプロイします。

```bash
./deploy.sh
```
※ `API_KEY` はデータ作成スクリプト (`optimize_with_llm.js`) でのみ使用するため、検索用アプリには不要です（スクリプト内でも除外されています）。

## API 仕様 (Function Calling 用)

デプロイされたサービスは、Web API として検索機能を提供します。

**Service URL**: `https://rag-engine-service-xxxxxxxxx-an.a.run.app` (環境により異なります)

### エンドポイント: `/search`

**アクセス権限**: パブリック (未認証アクセス許可 / `Allow unauthenticated` 設定済み)
※Function Calling など外部からの呼び出しを容易にするため、`deploy.sh` で未認証アクセスを許可しています。

**メソッド**: `POST` (推奨) または `GET`

**リクエスト (POST)**
```json
{
  "q": "検索したいキーワードや質問"
}
```

**レスポンス (JSON)**
```json
{
  "answer": "AIによる生成された回答...",
  "references": [
    { "title": "ドキュメントタイトル", "link": "gs://..." }
  ],
  "relatedQuestions": [
    "関連する質問1",
    "関連する質問2"
  ]
}
```

**使用例 (curl)**
```bash
curl -X POST https://[YOUR_SERVICE_URL]/search \
  -H "Content-Type: application/json" \
  -d '{"q": "解約方法を教えて"}'
```
