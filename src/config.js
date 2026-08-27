/**
 * 環境変数の読み込みと検証を一元化するモジュール。
 *
 * 方針:
 *   - import しただけでは絶対にプロセスを落とさない (旧 query.js はトップレベルで
 *     process.exit していたため、env 不足時に Express サーバごと死んでいた)。
 *   - 検証はエントリポイント (bin/*, index.js) から assertConfig() を明示的に呼ぶ。
 */
import dotenv from 'dotenv';
import { logger } from './logger.js';

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
    // true にすると search を省き answerQuery だけで回答する (1 往復)。
    // 実測で中央値 4.2 秒 → 2.6 秒。ただし answerQuery 内部の検索は
    // queryExpansion / spellCorrection を伴わないため、想定質問から離れた
    // 言い回しでは根拠が弱くなり得る。既定は従来どおりの 2 往復。
    singleRoundTrip: str(process.env.SEARCH_SINGLE_ROUNDTRIP).toLowerCase() === 'true',
  },

  // --- 検索 API の認証 ---
  auth: {
    // カンマ区切りで複数指定できる。ローテーション中は新旧を並べる。
    // Cloud Run へは Secret Manager から SEARCH_API_KEYS として渡す。
    keys: str(process.env.SEARCH_API_KEYS)
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
    // 認証なしで公開することを明示的に選んだ場合のみ true にする
    allowUnauthenticated: str(process.env.ALLOW_UNAUTHENTICATED).toLowerCase() === 'true',
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

/**
 * 実行ステップごとの必須設定 (表示名は .env のキー名に合わせる)。
 *
 * モード単位ではなくステップ単位で持つ。スキップしたステップの環境変数まで
 * 要求すると、ローカル生成だけしたい場合に GCS やデータストアの設定を
 * 強いることになるため。
 */
const STEP_REQUIREMENTS = {
  // kintone 取得と Gemini 最適化
  optimize: [
    ['GEMINI_API_KEY', () => config.gemini.apiKey],
    ['KINTONE_DOMAIN', () => config.kintone.domain],
    ['KINTONE_APP_ID', () => config.kintone.appId],
    ['KINTONE_API_TOKEN', () => config.kintone.apiToken],
  ],
  // GCS へのアップロード
  upload: [['GCS_BUCKET', () => config.gcs.bucket]],
  // データストアへの取り込み
  import: [
    ['PROJECT_NUMBER', () => config.projectNumber],
    ['DATA_STORE_ID', () => config.dataStoreId],
    ['GCS_BUCKET', () => config.gcs.bucket],
  ],
  // 検索 API の実行 (Cloud Run / npm run search / スモークテスト)
  search: [
    ['PROJECT_NUMBER', () => config.projectNumber],
    ['AI_APPLICATION_ID', () => config.engineId],
  ],
};

/** 後方互換のためのモード → ステップの対応。 */
const MODE_STEPS = {
  serve: ['search'],
  import: ['import', 'search'],
  sync: ['optimize', 'upload', 'import', 'search'],
};

/**
 * 実行するステップに必要な環境変数が揃っているか検証する。
 * 不足はまとめて 1 度に報告する (旧実装は 1 個ずつしか教えてくれなかった)。
 * @param {string[]} steps STEP_REQUIREMENTS のキー
 * @param {string} [label] エラーメッセージに出す文脈
 * @throws {ConfigError}
 */
export function assertSteps(steps, label = steps.join(' + ')) {
  const missing = [];
  for (const step of steps) {
    const requirements = STEP_REQUIREMENTS[step];
    if (!requirements) throw new ConfigError(`Unknown config step: ${step}`);
    for (const [name, get] of requirements) {
      if (!get() && !missing.includes(name)) missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `.env に以下の環境変数を設定してください (${label}): ${missing.join(', ')}\n` +
        '雛形は .env.sample を参照してください。'
    );
  }
}

/**
 * 検索 API を公開する前に、認証の設定が意図的なものか確認する。
 *
 * キー未設定を「認証なしで公開」と黙って解釈すると、設定漏れがそのまま
 * 公開エンドポイントになる。無効化するには明示的な指定を必要とする。
 * @throws {ConfigError}
 */
export function assertServerAuth() {
  if (config.auth.keys.length > 0) return;
  if (config.auth.allowUnauthenticated) {
    logger.warn(
      '認証なしで検索 API を公開します (ALLOW_UNAUTHENTICATED=true)。' +
        ' URL を知っていれば誰でも課金対象のクエリを実行できます。'
    );
    return;
  }
  throw new ConfigError(
    '検索 API のキーが設定されていません。\n' +
      '  SEARCH_API_KEYS にキーを設定してください (カンマ区切りで複数可)。\n' +
      '  意図して認証なしで公開する場合のみ ALLOW_UNAUTHENTICATED=true を設定してください。'
  );
}

/**
 * モード指定での検証。
 * @param {'serve'|'import'|'sync'} mode
 * @throws {ConfigError}
 */
export function assertConfig(mode) {
  const steps = MODE_STEPS[mode];
  if (!steps) throw new ConfigError(`Unknown config mode: ${mode}`);
  assertSteps(steps, `${mode} モード`);
}
