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
const TRANSIENT_ERROR =
  /EHOSTUNREACH|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed|Transient HTTP/;

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

async function getAccessToken() {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

/**
 * Operation が完了するまで REST でポーリングする。
 * @param {string} operationName
 * @param {{intervalMs?: number, maxWaitMs?: number, maxConsecutiveErrors?: number}} [options]
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
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

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
        return json;
      }
    } catch (error) {
      consecutiveErrors += 1;
      const message = String(error?.message ?? error);
      if (!TRANSIENT_ERROR.test(message) || consecutiveErrors > maxConsecutiveErrors) throw error;

      const backoff = Math.min(60_000, intervalMs * Math.min(consecutiveErrors, 6));
      logger.warn(`[poll retry ${consecutiveErrors}] ${message} — ${backoff}ms 後に再試行`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * GCS からデータストアへ全件再取り込みする (reconciliationMode: FULL)。
 * @param {{resumeOnly?: boolean}} [options] resumeOnly=true なら未完了 Operation の待機のみ行う
 * @returns {Promise<object|null>} 完了した Operation。再開対象がない場合は null。
 */
export async function importFromGcs({ resumeOnly = false } = {}) {
  let operationName;

  const previous = loadOperationState();
  if (previous?.name) {
    logger.info(`前回のOperationを引き継ぎます: ${previous.name}`);
    operationName = previous.name;
  } else if (resumeOnly) {
    logger.info('再開対象のOperationがありません。終了します。');
    return null;
  } else {
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

    operationName = operation.name;
    saveOperationState(operationName);
    logger.info(`Operation: ${operationName}`);
  }

  logger.info('完了待機中 (RESTポーリング, ネットワーク瞬断は自動リトライ)...');
  const result = await pollOperationUntilDone(operationName);
  clearOperationState();

  const meta = result.metadata ?? {};
  logger.info(
    `インポート完了: success=${meta.successCount ?? 0} failure=${meta.failureCount ?? 0} total=${meta.totalCount ?? '?'}`
  );
  return result;
}
