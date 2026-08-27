/**
 * kintone の FAQ を Gemini で RAG 向けに書き換え、optimized_docs/ に出力する。
 *
 * SDK は後継の @google/genai を使う (@google/generative-ai は 2025-11-30 に非推奨化)。
 *
 * 差分同期:
 *   質問+回答の SHA-1 を .optimize_state.json に記録し、変化したレコードだけ
 *   Gemini に投げる。kintone 側で削除されたレコードのファイルはローカルからも消す。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { logger } from './logger.js';
import { mapWithConcurrency } from './concurrency.js';
import { fetchFaqRecords } from './sources/kintone.js';

const outputDir = config.paths.outputDir;
const stateFile = config.paths.optimizeState;

let ai = null;
function getClient() {
  if (!ai) ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return ai;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** レコード内容のハッシュ。差分判定のキーになる。 */
export function hashRecord(record) {
  return crypto
    .createHash('sha1')
    .update(`${record.question}\n---\n${record.answer}`)
    .digest('hex');
}

export function docFilename(id) {
  return `faq_${id}.txt`;
}

/** レート制限・一時的なサーバエラーかどうか。@google/genai の ApiError は status を持つ。 */
function isRetryable(error) {
  const status = error?.status ?? error?.code;
  if (status === 429 || status === 503 || status === 500) return true;
  return /\b429\b|RESOURCE_EXHAUSTED|Quota|UNAVAILABLE|\b503\b/i.test(String(error?.message ?? ''));
}

function buildPrompt(id, question, answer) {
  return `
以下のFAQレコードを、RAG（検索拡張生成）システムが検索しやすいように最適化してください。
特に、ユーザーが検索しそうな「類義語」や「言い換え表現」を生成して含めてください。

【元のデータ】
質問: ${question}
回答: ${answer}

【出力フォーマット】
以下の形式のテキストのみを出力してください。
[[ID: faq_${id}]]
[[CATEGORY: カテゴリ名を推論]]
[[KEYWORDS: 重要単語を5〜10個抽出]]

[[SEARCH_QUERIES]]
- ユーザーがこの回答に辿り着くために検索しそうな話し言葉の質問文を4つ生成

QUESTION: 元の質問をより分かりやすく整えた文章
ANSWER: 元の回答を構造化した文章（箇条書きなどを活用）
`;
}

/**
 * 1 レコードを最適化する。リトライ可能なエラーのみ指数バックオフで再試行。
 * @returns {Promise<string|null>} 生成テキスト。失敗時は null。
 */
async function optimizeRecord(record) {
  const { model, thinkingLevel, maxRetries } = config.gemini;
  const request = {
    model,
    contents: buildPrompt(record.id, record.question, record.answer),
  };
  // 空文字を指定するとモデル既定の思考量に任せる
  if (thinkingLevel) request.config = { thinkingConfig: { thinkingLevel } };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await getClient().models.generateContent(request);
      return response.text ?? null;
    } catch (error) {
      if (!isRetryable(error) || attempt === maxRetries) {
        logger.error(`最適化に失敗しました (id=${record.id})`, { error: error?.message });
        return null;
      }
      const wait = 2 ** attempt * 1000 + 5000;
      logger.warn(
        `レート制限のため待機します (id=${record.id}, ${attempt + 1}/${maxRetries})`,
        { waitMs: wait }
      );
      await sleep(wait);
    }
  }
  return null;
}

function loadState() {
  if (!fs.existsSync(stateFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function ensureOutputDir() {
  if (fs.existsSync(outputDir)) return;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, '.gitkeep'), '');
}

/**
 * kintone に存在しない faq_*.txt を optimized_docs/ から削除する。
 * @param {string[]} existingFilenames ディレクトリ内のファイル名一覧
 * @param {Set<string>} validFilenames 残すべきファイル名
 * @returns {string[]} 削除対象のファイル名
 */
export function findOrphanDocs(existingFilenames, validFilenames) {
  return existingFilenames.filter(
    (name) => name.startsWith('faq_') && name.endsWith('.txt') && !validFilenames.has(name)
  );
}

/**
 * kintone から FAQ を取得し、差分のみ Gemini で最適化してファイル出力する。
 * @param {{full?: boolean}} [options] full=true で全件再生成
 * @returns {Promise<{added: string[], updated: string[], removed: string[], failed: string[], unchanged: number, sourceCount: number, files: string[]}>}
 */
export async function optimizeAll({ full = false } = {}) {
  ensureOutputDir();

  logger.info('kintoneからFAQデータを取得しています...');
  const records = await fetchFaqRecords();

  const prevState = full ? {} : loadState();
  const nextState = { ...prevState };
  const added = [];
  const updated = [];
  const removed = [];
  const failed = [];

  // --- 差分判定 (nextState への反映は書き込み成功時のみ) ---
  const targets = [];
  const targetHash = {};
  for (const record of records) {
    const hash = hashRecord(record);
    targetHash[record.id] = hash;
    const filename = docFilename(record.id);
    const filepath = path.join(outputDir, filename);

    if (!prevState[record.id]) {
      added.push(filename);
      targets.push(record);
    } else if (prevState[record.id] !== hash || !fs.existsSync(filepath)) {
      updated.push(filename);
      targets.push(record);
    }
  }

  // --- 削除検知 ---
  const validFilenames = new Set(records.map((r) => docFilename(r.id)));
  for (const filename of findOrphanDocs(fs.readdirSync(outputDir), validFilenames)) {
    fs.unlinkSync(path.join(outputDir, filename));
    delete nextState[filename.replace(/^faq_|\.txt$/g, '')];
    removed.push(filename);
  }

  logger.info(
    `差分: 追加${added.length} / 更新${updated.length} / 削除${removed.length} / ` +
      `変更なし${records.length - targets.length}`
  );

  // --- 最適化 ---
  // 旧実装はレコード間に無条件で 10 秒スリープしていたため 50 件で 8 分以上かかっていた。
  // 並列実行に変え、待つのはレート制限に当たったときだけにする。
  let done = 0;
  await mapWithConcurrency(targets, config.gemini.concurrency, async (record) => {
    const content = await optimizeRecord(record);
    if (content) {
      fs.writeFileSync(path.join(outputDir, docFilename(record.id)), content);
      nextState[record.id] = targetHash[record.id];
    } else {
      failed.push(docFilename(record.id));
    }
    done += 1;
    logger.info(`[${done}/${targets.length}] id=${record.id} ${content ? '完了' : '失敗'}`);
  });

  saveState(nextState);

  if (failed.length > 0) {
    logger.warn(`${failed.length}件の最適化に失敗しました。次回実行時に再試行されます。`, { failed });
  }

  return {
    added,
    updated,
    removed,
    failed,
    unchanged: records.length - targets.length,
    // kintone 側の件数。0 なら「全件削除された」と確定できる
    sourceCount: records.length,
    files: records.map((r) => docFilename(r.id)),
  };
}
