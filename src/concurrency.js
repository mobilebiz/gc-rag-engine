/**
 * items を最大 limit 並列で処理する軽量ワーカープール。
 * 外部依存を増やさずに、API のレート制限や同時接続数を抑えるために使う。
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit 同時実行数 (1 以上)
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>} items と同じ順序の結果
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    })
  );

  return results;
}
