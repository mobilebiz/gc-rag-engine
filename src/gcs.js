/**
 * optimized_docs/ を Cloud Storage に同期する。
 * ローカルに存在しない .txt はバケットからも削除して、データストアの取り込み元を
 * ローカルの状態と一致させる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';
import { config } from './config.js';
import { logger } from './logger.js';
import { mapWithConcurrency } from './concurrency.js';

const UPLOAD_CONCURRENCY = 8;

/**
 * バケット上に残っている不要オブジェクトを判定する。
 * .txt 以外 (バケット直下に別用途のファイルがある場合) は巻き込まない。
 * @param {string[]} remoteNames バケット上のオブジェクト名
 * @param {Set<string>} localNames アップロード後に存在すべきオブジェクト名
 * @returns {string[]}
 */
export function findOrphanObjects(remoteNames, localNames) {
  return remoteNames.filter((name) => name.endsWith('.txt') && !localNames.has(name));
}

/**
 * optimized_docs/ の .txt をすべてアップロードし、孤立オブジェクトを削除する。
 * @param {{sourceConfirmedEmpty?: boolean}} [options]
 *   sourceConfirmedEmpty=true は「データソースが 0 件であると確認できた」ことを表す。
 *   このときだけローカルが空でもリモートを空にしてよい。
 * @returns {Promise<{uploaded: number, deleted: number, uri: string}>}
 */
export async function syncToGcs({ sourceConfirmedEmpty = false } = {}) {
  const { bucket: bucketName, prefix } = config.gcs;
  const storage = new Storage({ projectId: config.projectId || undefined });
  const bucket = storage.bucket(bucketName);

  const outputDir = config.paths.outputDir;
  if (!fs.existsSync(outputDir)) {
    throw new Error(
      `${outputDir}/ が存在しません。先に最適化を実行してください (npm run sync)。`
    );
  }

  const prefixPath = prefix ? `${prefix}/` : '';
  const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.txt'));

  logger.info(`GCSアップロード: ${files.length}件 → gs://${bucketName}/${prefixPath}`);

  const [existing] = await bucket.getFiles(prefixPath ? { prefix: prefixPath } : {});

  await mapWithConcurrency(files, UPLOAD_CONCURRENCY, (file) =>
    bucket.upload(path.join(outputDir, file), { destination: `${prefixPath}${file}` })
  );

  const localNames = new Set(files.map((f) => `${prefixPath}${f}`));
  // ローカルが空のままバケットを全消しすると、reconciliationMode: FULL で
  // データストアまで空になる。データソースが本当に 0 件だと確認できた場合だけ許可する。
  const skipDeletion = files.length === 0 && !sourceConfirmedEmpty;
  const orphans = skipDeletion
    ? []
    : findOrphanObjects(
        existing.map((o) => o.name),
        localNames
      );

  if (skipDeletion && existing.length > 0) {
    logger.warn(
      `${outputDir}/ が空ですが、データソースが 0 件だと確認できていないため` +
        ` バケット上の ${existing.length} 件は削除しません。`
    );
  } else if (files.length === 0 && sourceConfirmedEmpty) {
    logger.warn('データソースが 0 件のため、バケット上のドキュメントをすべて削除します。');
  }

  for (const name of orphans) {
    logger.info(`削除: gs://${bucketName}/${name}`);
    await bucket.file(name).delete();
  }

  return {
    uploaded: files.length,
    deleted: orphans.length,
    uri: `gs://${bucketName}/${prefixPath}*.txt`,
  };
}
