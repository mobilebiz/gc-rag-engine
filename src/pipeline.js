/**
 * 同期パイプラインのオーケストレーション。
 *
 *   kintone → Gemini 最適化 → GCS アップロード → データストア再取り込み → スモークテスト
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { optimizeAll } from './optimize.js';
import { syncToGcs } from './gcs.js';
import { importFromGcs } from './datastore.js';
import { search } from './search.js';

/** 検索が実際に回答を返せる状態かを 1 クエリで確認する。 */
export async function smokeTest(query = config.search.smokeTestQuery) {
  if (!query) {
    logger.warn(
      'SMOKE_TEST_QUERY が未設定のためスモークテストをスキップします。' +
        ' FAQ の内容に合った質問を .env に設定してください。'
    );
    return true;
  }
  logger.info(`Smoke test query: "${query}"`);
  try {
    const result = await search(query);
    if (result?.answer) {
      logger.info('Smoke test OK ✅');
      return true;
    }
    logger.warn('Smoke test: 回答が空でした');
    return false;
  } catch (error) {
    logger.error('Smoke test 失敗', { error: error?.message });
    return false;
  }
}

/**
 * @param {object} options
 * @param {boolean} [options.full] 全件再生成する
 * @param {boolean} [options.resume] 中断したインポート Operation の待機だけ行う
 * @param {boolean} [options.skipOptimize]
 * @param {boolean} [options.skipUpload]
 * @param {boolean} [options.skipImport]
 * @param {boolean} [options.skipSmoke]
 * @param {boolean} [options.allowPartial] 最適化に失敗した文書があっても公開まで進める
 * @returns {Promise<{ok: boolean}>}
 */
export async function runPipeline(options = {}) {
  const { full = false, resume = false } = options;
  const { skipOptimize = false, skipUpload = false, skipImport = false, skipSmoke = false } = options;
  const { allowPartial = false } = options;
  // 最適化を実行したときだけ「kintone が 0 件」を確定できる
  let sourceConfirmedEmpty = false;

  if (resume) {
    logger.info('=== Resume mode: 前回のインポートOperationのみ待機 ===');
    await importFromGcs({ resumeOnly: true });
    const ok = skipSmoke ? true : await smokeTest();
    logger.info('\nパイプライン完了 ✅');
    return { ok };
  }

  logger.info('=== Step 1/4: kintone → Gemini 最適化 ===');
  if (skipOptimize) {
    logger.info('skipped');
  } else {
    const diff = await optimizeAll({ full });
    logger.info('差分結果', {
      added: diff.added.length,
      updated: diff.updated.length,
      removed: diff.removed.length,
      failed: diff.failed.length,
      unchanged: diff.unchanged,
    });

    // 生成に失敗した文書があるまま公開すると、新規 FAQ は欠落し
    // 更新 FAQ は古い内容のまま FULL インポートで確定してしまう。
    if (diff.failed.length > 0 && !allowPartial) {
      throw new Error(
        `${diff.failed.length}件の最適化に失敗したため公開を中止します: ${diff.failed.join(', ')}\n` +
          '再実行するか、承知のうえで進める場合は --allow-partial を付けてください。'
      );
    }

    sourceConfirmedEmpty = diff.sourceCount === 0;

    const noChanges =
      diff.added.length === 0 && diff.updated.length === 0 && diff.removed.length === 0;
    if (noChanges && !full) {
      logger.info('変更がないためパイプラインを終了します。');
      return { ok: true };
    }
  }

  logger.info('\n=== Step 2/4: GCS アップロード ===');
  if (skipUpload) logger.info('skipped');
  else logger.info('アップロード完了', await syncToGcs({ sourceConfirmedEmpty }));

  logger.info('\n=== Step 3/4: データストア再取り込み ===');
  if (skipImport) logger.info('skipped');
  else await importFromGcs();

  logger.info('\n=== Step 4/4: Smoke test ===');
  let ok = true;
  if (skipSmoke) logger.info('skipped');
  else ok = await smokeTest();

  logger.info('\nパイプライン完了 ✅');
  return { ok };
}
