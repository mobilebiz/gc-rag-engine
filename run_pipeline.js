import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import { v1 } from '@google-cloud/discoveryengine';
import { GoogleAuth } from 'google-auth-library';
import { optimizeAll } from './optimize_with_llm.js';
import { search } from './query.js';

const operationStateFile = '.last_import_operation.json';

const PROJECT_ID = process.env.PROJECT_ID;
const PROJECT_NUMBER = process.env.PROJECT_NUMBER;
const LOCATION = process.env.LOCATION || 'global';
const DATA_STORE_ID = process.env.DATA_STORE_ID;
const GCS_BUCKET = process.env.GCS_BUCKET;
const GCS_PREFIX = (process.env.GCS_PREFIX ?? 'faq_docs').replace(/^\/+|\/+$/g, '');

const outputDir = 'optimized_docs';

function assert(name, val) {
  if (!val) {
    console.error(`Error: ${name} を .env に設定してください。`);
    process.exit(1);
  }
}

async function uploadAll() {
  assert('GCS_BUCKET', GCS_BUCKET);
  const storage = new Storage({ projectId: PROJECT_ID });
  const bucket = storage.bucket(GCS_BUCKET);

  const prefixPath = GCS_PREFIX ? `${GCS_PREFIX}/` : '';
  const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.txt'));
  console.log(`GCSアップロード: ${files.length}件 → gs://${GCS_BUCKET}/${prefixPath}`);

  // 既存オブジェクト一覧を取得して、ローカルに無いものは削除
  const listOpts = prefixPath ? { prefix: prefixPath } : {};
  const [existing] = await bucket.getFiles(listOpts);
  const localSet = new Set(files.map(f => `${prefixPath}${f}`));
  // バケット直下のときは .txt 以外を巻き込まないように限定
  const toDelete = existing
    .filter(o => o.name.endsWith('.txt'))
    .filter(o => !localSet.has(o.name));

  for (const f of files) {
    const dest = `${prefixPath}${f}`;
    await bucket.upload(path.join(outputDir, f), { destination: dest });
  }
  for (const o of toDelete) {
    console.log(`削除: gs://${GCS_BUCKET}/${o.name}`);
    await o.delete();
  }
  return { uploaded: files.length, deleted: toDelete.length };
}

function apiHost() {
  return LOCATION === 'global'
    ? 'discoveryengine.googleapis.com'
    : `${LOCATION}-discoveryengine.googleapis.com`;
}

async function getAccessToken() {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const t = await client.getAccessToken();
  return t.token;
}

/**
 * Operationが完了するまでRESTでポーリング。
 * 一過性のネットワークエラー(EHOSTUNREACH/ECONNRESET/タイムアウト/5xx)はリトライする。
 */
async function pollOperationUntilDone(operationName, { intervalMs = 10_000, maxWaitMs = 3 * 60 * 60_000 } = {}) {
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
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`Transient HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`Operation GET failed: ${res.status} ${await res.text()}`);
      }
      const json = await res.json();
      consecutiveErrors = 0;
      const meta = json.metadata || {};
      if (meta.successCount !== undefined || meta.failureCount !== undefined) {
        process.stdout.write(`\r  進捗: success=${meta.successCount ?? 0} failure=${meta.failureCount ?? 0} total=${meta.totalCount ?? '?'}   `);
      }
      if (json.done) {
        process.stdout.write('\n');
        return json;
      }
    } catch (e) {
      consecutiveErrors++;
      const transient = /EHOSTUNREACH|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed|Transient HTTP/.test(String(e?.message || e));
      if (!transient || consecutiveErrors > 30) {
        throw e;
      }
      const backoff = Math.min(60_000, intervalMs * Math.min(consecutiveErrors, 6));
      console.warn(`\n[poll retry ${consecutiveErrors}] ${e.message} — ${backoff}ms 後に再試行`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function saveOperationState(name) {
  fs.writeFileSync(operationStateFile, JSON.stringify({ name, savedAt: new Date().toISOString() }, null, 2));
}
function loadOperationState() {
  if (!fs.existsSync(operationStateFile)) return null;
  try { return JSON.parse(fs.readFileSync(operationStateFile, 'utf-8')); } catch { return null; }
}
function clearOperationState() {
  if (fs.existsSync(operationStateFile)) fs.unlinkSync(operationStateFile);
}

async function reimportToDataStore({ resumeOnly = false } = {}) {
  assert('PROJECT_NUMBER', PROJECT_NUMBER);
  assert('DATA_STORE_ID', DATA_STORE_ID);
  assert('GCS_BUCKET', GCS_BUCKET);

  let operationName;

  // 既存Operationの再開チェック
  const prev = loadOperationState();
  if (prev?.name) {
    console.log(`前回のOperationを引き継ぎます: ${prev.name}`);
    operationName = prev.name;
  } else if (resumeOnly) {
    console.log('再開対象のOperationがありません。終了します。');
    return null;
  } else {
    const client = new v1.DocumentServiceClient({ apiEndpoint: apiHost() });
    const parent = client.projectLocationCollectionDataStoreBranchPath(
      PROJECT_NUMBER, LOCATION, 'default_collection', DATA_STORE_ID, 'default_branch'
    );

    console.log(`Discovery Engine インポート開始: ${parent}`);
    const [operation] = await client.importDocuments({
      parent,
      gcsSource: {
        inputUris: [`gs://${GCS_BUCKET}/${GCS_PREFIX ? GCS_PREFIX + '/' : ''}*.txt`],
        dataSchema: 'content',
      },
      reconciliationMode: 'FULL',
    });
    operationName = operation.name;
    saveOperationState(operationName);
    console.log(`Operation: ${operationName}`);
  }

  console.log('完了待機中 (RESTポーリング, ネットワーク瞬断は自動リトライ)...');
  const result = await pollOperationUntilDone(operationName);
  clearOperationState();

  const meta = result.metadata || {};
  console.log(`インポート完了: success=${meta.successCount ?? 0} failure=${meta.failureCount ?? 0} total=${meta.totalCount ?? '?'}`);
  return result;
}

async function smokeTest() {
  const q = process.env.SMOKE_TEST_QUERY || '解約方法を教えて';
  console.log(`Smoke test query: "${q}"`);
  try {
    const r = await search(q);
    if (r?.answer) {
      console.log('Smoke test OK ✅');
      return true;
    }
    console.warn('Smoke test: 回答が空でした');
    return false;
  } catch (e) {
    console.error('Smoke test 失敗:', e.message);
    return false;
  }
}

async function main() {
  const skipOptimize = process.argv.includes('--skip-optimize');
  const skipUpload = process.argv.includes('--skip-upload');
  const skipImport = process.argv.includes('--skip-import');
  const skipSmoke = process.argv.includes('--skip-smoke');
  const full = process.argv.includes('--full');
  const resumeOnly = process.argv.includes('--resume');

  // 中断したOperationの再開モード
  if (resumeOnly) {
    console.log('=== Resume mode: 前回のインポートOperationのみ待機 ===');
    await reimportToDataStore({ resumeOnly: true });
    if (!skipSmoke) {
      console.log('\n=== Smoke test ===');
      await smokeTest();
    }
    console.log('\nパイプライン完了 ✅');
    return;
  }

  console.log('=== Step 1/4: kintone → Gemini 最適化 ===');
  if (!skipOptimize) {
    const r = await optimizeAll({ full });
    console.log(r);
    if (r.added.length === 0 && r.updated.length === 0 && r.removed.length === 0 && !full) {
      console.log('変更がないためパイプラインを終了します。');
      return;
    }
  } else {
    console.log('skipped');
  }

  console.log('\n=== Step 2/4: GCS アップロード ===');
  if (!skipUpload) await uploadAll(); else console.log('skipped');

  console.log('\n=== Step 3/4: Discovery Engine 再インポート ===');
  if (!skipImport) await reimportToDataStore(); else console.log('skipped');

  console.log('\n=== Step 4/4: Smoke test ===');
  if (!skipSmoke) {
    const ok = await smokeTest();
    if (!ok) process.exitCode = 2;
  } else {
    console.log('skipped');
  }

  console.log('\nパイプライン完了 ✅');
}

main().catch(e => {
  console.error('パイプライン失敗:', e);
  process.exit(1);
});
