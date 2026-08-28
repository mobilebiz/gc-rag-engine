/**
 * 呼び出し側に意味のあるステータスで返すためのエラー型。
 */

/** gRPC の RESOURCE_EXHAUSTED。 */
const GRPC_RESOURCE_EXHAUSTED = 8;

/** クォータ単位 (`1/min/{project}` など) から、リセットまでの窓の長さ(秒)を得る。 */
const WINDOW_SECONDS = { s: 1, min: 60, h: 3600, d: 86_400 };

/**
 * レート制限。`status` を持たせてあるので、Express のエラーハンドラは
 * 他のクライアントエラーと同じ経路で 429 を返せる。
 */
export class RateLimitError extends Error {
  constructor(message, { retryAfterSeconds = 60, quotaMetric = '', quotaLimit = '' } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
    this.quotaMetric = quotaMetric;
    this.quotaLimit = quotaLimit;
  }
}

/** `1/min/{project}` のような単位表記から窓の長さ(秒)を取り出す。 */
export function windowSecondsFromUnit(unit) {
  const matched = /^\d+\/([a-z]+)\b/i.exec(String(unit ?? ''));
  return WINDOW_SECONDS[matched?.[1]?.toLowerCase()] ?? null;
}

/**
 * Discovery Engine のクォータ超過エラーを RateLimitError に変換する。
 * 該当しないエラーは null を返す (呼び出し側でそのまま投げ直す)。
 *
 * Google のエラーは `RetryInfo` を返さない代わりに、`statusDetails` の
 * ErrorInfo に `window_start_time` と `quota_unit` を載せてくる。
 * そこから「次の窓が開くまで何秒か」を計算する。
 *
 * @param {unknown} error
 * @param {number} [nowMs] テスト用に現在時刻を差し替える
 * @returns {RateLimitError|null}
 */
export function asRateLimitError(error, nowMs = Date.now()) {
  if (error?.code !== GRPC_RESOURCE_EXHAUSTED) return null;

  const info = (error.statusDetails ?? []).find((d) => d?.reason === 'RATE_LIMIT_EXCEEDED');
  const meta = info?.metadata ?? {};

  const windowSeconds = windowSecondsFromUnit(meta.quota_unit) ?? 60;
  const windowStart = Number(meta.window_start_time);

  let retryAfterSeconds = windowSeconds;
  if (Number.isFinite(windowStart) && windowStart > 0) {
    const remaining = Math.ceil((windowStart + windowSeconds - nowMs / 1000));
    // 窓の情報が古い場合に負値や過大な値にならないよう丸める
    retryAfterSeconds = Math.min(windowSeconds, Math.max(1, remaining));
  }

  return new RateLimitError(
    'Agent Search のクォータ上限に達しました。時間をおいて再試行してください。',
    {
      retryAfterSeconds,
      quotaMetric: meta.quota_metric ?? '',
      quotaLimit: meta.quota_limit_value ?? '',
    }
  );
}
