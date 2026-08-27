/**
 * 環境変数の読み込みと検証を一元化するモジュール。
 *
 * 方針:
 *   - import しただけでは絶対にプロセスを落とさない (旧 query.js はトップレベルで
 *     process.exit していたため、env 不足時に Express サーバごと死んでいた)。
 *   - 検証はエントリポイント (bin/*, index.js) から assertConfig() を明示的に呼ぶ。
 */
import dotenv from 'dotenv';

// quiet: true で dotenv v17 の起動バナーを抑制する。
// path はテストから DOTENV_CONFIG_PATH で差し替えられるようにしておく (未設定なら ./.env)。
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH, quiet: true });

/** 検証エラー。呼び出し側でメッセージだけ表示して終了できるようにする。 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const str = (value, fallback = '') => (value ?? '').trim() || fallback;
const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  // --- Google Cloud ---
  projectId: str(process.env.PROJECT_ID),
  projectNumber: str(process.env.PROJECT_NUMBER),
  location: str(process.env.LOCATION, 'global'),

  // Gemini Enterprise Agent Platform (旧 Vertex AI Agent Builder) のリソース識別子。
  // API は引き続き discoveryengine.googleapis.com。
  collectionId: 'default_collection',
  engineId: str(process.env.AI_APPLICATION_ID),
  servingConfigId: 'default_search',
  dataStoreId: str(process.env.DATA_STORE_ID),
  branchId: 'default_branch',

  // --- Cloud Storage ---
  gcs: {
    bucket: str(process.env.GCS_BUCKET),
    // 前後のスラッシュを落として正規化する
    prefix: str(process.env.GCS_PREFIX, 'faq_docs').replace(/^\/+|\/+$/g, ''),
  },

  // --- Gemini API (ドキュメント最適化用) ---
  gemini: {
    // API_KEY は旧名称。既存の .env を壊さないためフォールバックとして残す。
    apiKey: str(process.env.GEMINI_API_KEY) || str(process.env.API_KEY),
    model: str(process.env.GEMINI_MODEL, 'gemini-3.7-flash'),
    // 'low' | 'medium' | 'high' | '' (空文字でモデル既定に委ねる)
    thinkingLevel: str(process.env.GEMINI_THINKING_LEVEL, 'low').toLowerCase(),
    concurrency: Math.max(1, int(process.env.OPTIMIZE_CONCURRENCY, 3)),
    maxRetries: Math.max(0, int(process.env.OPTIMIZE_MAX_RETRIES, 4)),
  },

  // --- kintone (FAQ データソース) ---
  kintone: {
    domain: str(process.env.KINTONE_DOMAIN),
    appId: str(process.env.KINTONE_APP_ID),
    apiToken: str(process.env.KINTONE_API_TOKEN),
    guestSpaceId: str(process.env.KINTONE_GUEST_SPACE_ID),
    questionField: str(process.env.KINTONE_QUESTION_FIELD, 'question'),
    answerField: str(process.env.KINTONE_ANSWER_FIELD, 'answer'),
  },

  // --- 検索・回答生成 ---
  search: {
    pageSize: Math.max(1, int(process.env.SEARCH_PAGE_SIZE, 10)),
    maxReferences: Math.max(1, int(process.env.ANSWER_MAX_REFERENCES, 3)),
    // 回答生成のプロンプト前置き。用途に依存するため既定値は持たない。
    // 空のままならモデルの既定の回答スタイルになる。
    preamble: str(process.env.SEARCH_PREAMBLE),
    // スモークテストのクエリ。FAQ の内容に依存するため既定値は持たない。
    // 未設定ならスモークテストはスキップされる。
    smokeTestQuery: str(process.env.SMOKE_TEST_QUERY),
  },

  // --- ローカルファイル ---
  paths: {
    outputDir: str(process.env.OUTPUT_DIR, 'optimized_docs'),
    optimizeState: '.optimize_state.json',
    importOperationState: '.last_import_operation.json',
  },

  // --- サーバ ---
  port: int(process.env.PORT, 8080),
};

/**
 * Discovery Engine の API ホスト名。location が global 以外の場合はリージョン接頭辞が付く。
 * @param {string} [location]
 * @returns {string}
 */
export function apiHost(location = config.location) {
  return location === 'global'
    ? 'discoveryengine.googleapis.com'
    : `${location}-discoveryengine.googleapis.com`;
}

/** モードごとの必須設定 (表示名は .env のキー名に合わせる)。 */
const SERVE_REQUIREMENTS = [
  ['PROJECT_NUMBER', () => config.projectNumber],
  ['AI_APPLICATION_ID', () => config.engineId],
];

const IMPORT_REQUIREMENTS = [
  ...SERVE_REQUIREMENTS,
  ['DATA_STORE_ID', () => config.dataStoreId],
  ['GCS_BUCKET', () => config.gcs.bucket],
];

const REQUIREMENTS = {
  // 検索 API を動かすだけ (Cloud Run / npm run search)
  serve: SERVE_REQUIREMENTS,
  // GCS アップロードとデータストア取り込みまで (--resume / --skip-optimize)
  import: IMPORT_REQUIREMENTS,
  // kintone 取得と Gemini 最適化を含むフル同期
  sync: [
    ...IMPORT_REQUIREMENTS,
    ['GEMINI_API_KEY', () => config.gemini.apiKey],
    ['KINTONE_DOMAIN', () => config.kintone.domain],
    ['KINTONE_APP_ID', () => config.kintone.appId],
    ['KINTONE_API_TOKEN', () => config.kintone.apiToken],
  ],
};

/**
 * 指定モードに必要な環境変数が揃っているか検証する。
 * 不足はまとめて 1 度に報告する (旧実装は 1 個ずつしか教えてくれなかった)。
 * @param {'serve'|'import'|'sync'} mode
 * @throws {ConfigError}
 */
export function assertConfig(mode) {
  const requirements = REQUIREMENTS[mode];
  if (!requirements) throw new ConfigError(`Unknown config mode: ${mode}`);

  const missing = requirements.filter(([, get]) => !get()).map(([name]) => name);
  if (missing.length > 0) {
    throw new ConfigError(
      `.env に以下の環境変数を設定してください (${mode} モード): ${missing.join(', ')}\n` +
        '雛形は .env.sample を参照してください。'
    );
  }
}
