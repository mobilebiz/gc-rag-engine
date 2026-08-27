/**
 * Gemini Enterprise Agent Platform のデータストアへ GCS からドキュメントを取り込む。
 *
 * 取り込みは長時間 Operation になるため、SDK の promise ではなく REST で自前ポーリングする。
 * 数十分〜数時間かかる間にネットワークが瞬断しても落ちないよう、一過性エラーは再試行する。
 * Operation 名は .last_import_operation.json に保存し、中断しても --resume で待機を再開できる。
 */
import fs from 'node:fs';
import { v1 } from '@google-cloud/discoveryengine';
import { GoogleAuth } from 'google-auth-library';
import { apiHost, config } from './config.js';
import { logger } from './logger.js';

const stateFile = config.paths.importOperationState;

/** 1 回のポーリングリクエストの上限。Node の fetch は既定でタイムアウトしない。 */
const REQUEST_TIMEOUT_MS = 30_000;

const TRANSIENT_MESSAGE =
  /EHOSTUNREACH|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed|Transient HTTP/;

/**
 * 再試行してよいエラーか。
 * AbortSignal.timeout() による中断はエラー名で判定する (メッセージは Node のバージョンで変わる)。
 */
function isTransient(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  return TRANSIENT_MESSAGE.test(String(error?.message ?? error));
}

/** 取り込み元の GCS URI。gcs.js の出力先と一致させる。 */
export function gcsInputUri({ bucket, prefix } = config.gcs) {
  return `gs://${bucket}/${prefix ? `${prefix}/` : ''}*.txt`;
}

export function saveOperationState(name) {
  fs.writeFileSync(stateFile, JSON.stringify({ name, savedAt: new Date().toISOString() }, null, 2));
}

export function loadOperationState() {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearOperationState() {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
}

// 認証クライアントは使い回す。ポーリングごとに作り直すとライブラリ側の
// アクセストークンキャッシュが効かず、長時間 Operation で大量のトークン取得が走る。
let authClientPromise = null;

async function getAccessToken() {
  if (!authClientPromise) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    authClientPromise = auth.getClient();
  }
  try {
    const client = await authClientPromise;
    const { token } = await client.getAccessToken();
    return token;
  } catch (error) {
    // 失敗したクライアントを握り続けないよう破棄してから投げ直す
    authClientPromise = null;
    throw error;
  }
}

/** 完了した Operation が失敗を含んでいれば例外にする。 */
export function assertOperationSucceeded(operation) {
  if (!operation?.error) return operation;
  const { code, message } = operation.error;
  throw new Error(
    `インポートが失敗しました (code=${code ?? '?'}): ${message ?? JSON.stringify(operation.error)}`
  );
}

function logImportResult(operation) {
  const meta = operation?.metadata ?? {};
  logger.info(
    `インポート完了: success=${meta.successCount ?? 0} failure=${meta.failureCount ?? 0} total=${meta.totalCount ?? '?'}`
  );
}

/**
 * Operation が完了するまで REST でポーリングする。
 * @param {string} operationName
 * @param {{intervalMs?: number, maxWaitMs?: number, maxConsecutiveErrors?: number}} [options]
 * @throws {Error} Operation が失敗して完了した場合
 */
export async function pollOperationUntilDone(
  operationName,
  { intervalMs = 10_000, maxWaitMs = 3 * 60 * 60_000, maxConsecutiveErrors = 30 } = {}
) {
  const url = `https://${apiHost()}/v1/${operationName}`;
  const start = Date.now();
  let consecutiveErrors = 0;

  while (true) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Operation polling timed out after ${maxWaitMs}ms: ${operationName}`);
    }

    try {
      const token = await getAccessToken();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status >= 500 || res.status === 429) throw new Error(`Transient HTTP ${res.status}`);
      if (!res.ok) throw new Error(`Operation GET failed: ${res.status} ${await res.text()}`);

      const json = await res.json();
      consecutiveErrors = 0;

      const meta = json.metadata ?? {};
      if (meta.successCount !== undefined || meta.failureCount !== undefined) {
        logger.progress(
          `  進捗: success=${meta.successCount ?? 0} failure=${meta.failureCount ?? 0} total=${meta.totalCount ?? '?'}`
        );
      }

      if (json.done) {
        logger.progressEnd();
        // 失敗した Operation も done: true で返る。ここで検査しないと
        // 呼び出し側が再開用 state を消して「完了」と記録してしまう。
        return assertOperationSucceeded(json);
      }
    } catch (error) {
      consecutiveErrors += 1;
      if (!isTransient(error) || consecutiveErrors > maxConsecutiveErrors) throw error;

      const backoff = Math.min(60_000, intervalMs * Math.min(consecutiveErrors, 6));
      logger.warn(
        `[poll retry ${consecutiveErrors}] ${error?.message ?? error} — ${backoff}ms 後に再試行`
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 現在の GCS の内容で新しいインポート Operation を開始する。 */
async function startImport() {
  const client = new v1.DocumentServiceClient({ apiEndpoint: apiHost() });
  const parent = client.projectLocationCollectionDataStoreBranchPath(
    config.projectNumber,
    config.location,
    config.collectionId,
    config.dataStoreId,
    config.branchId
  );

  logger.info(`データストアへのインポート開始: ${parent}`);
  const [operation] = await client.importDocuments({
    parent,
    gcsSource: { inputUris: [gcsInputUri()], dataSchema: 'content' },
    reconciliationMode: 'FULL',
  });

  saveOperationState(operation.name);
  logger.info(`Operation: ${operation.name}`);
  return operation.name;
}

/**
 * GCS からデータストアへ全件再取り込みする (reconciliationMode: FULL)。
 *
 * 未完了の Operation が残っている場合はまずそれを解決する。
 * 通常実行ではそのあと**必ず新しいインポートを開始する** — 前回の Operation は
 * 今回アップロードした内容を含まないため、待機だけで終えると取り込み漏れになる。
 *
 * @param {{resumeOnly?: boolean}} [options] resumeOnly=true なら未完了 Operation の待機のみ行う
 * @returns {Promise<object|null>} 完了した Operation。再開対象がない場合は null。
 */
export async function importFromGcs({ resumeOnly = false } = {}) {
  const previous = loadOperationState();

  if (previous?.name) {
    logger.info(`前回のOperationを引き継ぎます: ${previous.name}`);
    logger.info('完了待機中 (RESTポーリング, ネットワーク瞬断は自動リトライ)...');
    const resumed = await pollOperationUntilDone(previous.name);
    clearOperationState();
    logImportResult(resumed);

    if (resumeOnly) return resumed;
    logger.info('前回のOperationが解決したため、現在のGCS内容で新規インポートを開始します。');
  } else if (resumeOnly) {
    logger.info('再開対象のOperationがありません。終了します。');
    return null;
  }

  const operationName = await startImport();
  logger.info('完了待機中 (RESTポーリング, ネットワーク瞬断は自動リトライ)...');
  const result = await pollOperationUntilDone(operationName);
  clearOperationState();
  logImportResult(result);
  return result;
}
