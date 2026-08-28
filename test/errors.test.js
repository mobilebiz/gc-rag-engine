import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/nonexistent';

const { asRateLimitError, RateLimitError, windowSecondsFromUnit } = await import('../src/errors.js');

/** 実際に Discovery Engine が返したエラーの形をそのまま再現したもの。 */
const quotaError = ({ windowStart = 1_787_891_966, unit = '1/min/{project}' } = {}) =>
  Object.assign(new Error("8 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'LLM query requests'"), {
    code: 8,
    reason: 'RATE_LIMIT_EXCEEDED',
    statusDetails: [
      {
        reason: 'RATE_LIMIT_EXCEEDED',
        domain: 'googleapis.com',
        metadata: {
          quota_metric: 'discoveryengine.googleapis.com/llm_requests',
          quota_limit_value: '10',
          quota_unit: unit,
          window_start_time: String(windowStart),
        },
      },
    ],
  });

test('クォータ超過を RateLimitError に変換する', () => {
  const e = asRateLimitError(quotaError());
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.status, 429);
  assert.equal(e.quotaMetric, 'discoveryengine.googleapis.com/llm_requests');
  assert.equal(e.quotaLimit, '10');
});

test('窓の残り時間から Retry-After を計算する', () => {
  const windowStart = 1_787_891_966;
  // 窓が開いてから 20 秒経過 → 残り 40 秒
  const now = (windowStart + 20) * 1000;
  assert.equal(asRateLimitError(quotaError({ windowStart }), now).retryAfterSeconds, 40);
});

test('窓の情報が古くても 1 秒以上、窓長以下に収める', () => {
  const windowStart = 1_787_891_966;
  // 窓をとうに過ぎている → 負値にしない
  const late = asRateLimitError(quotaError({ windowStart }), (windowStart + 500) * 1000);
  assert.equal(late.retryAfterSeconds, 1);
  // 窓より前の時刻 → 窓長を超えない
  const early = asRateLimitError(quotaError({ windowStart }), (windowStart - 500) * 1000);
  assert.equal(early.retryAfterSeconds, 60);
});

test('window_start_time が無ければ窓長をそのまま使う', () => {
  const e = quotaError();
  delete e.statusDetails[0].metadata.window_start_time;
  assert.equal(asRateLimitError(e).retryAfterSeconds, 60);
});

test('statusDetails が無くても 429 にはする', () => {
  const e = Object.assign(new Error('8 RESOURCE_EXHAUSTED'), { code: 8 });
  const r = asRateLimitError(e);
  assert.equal(r.status, 429);
  assert.equal(r.retryAfterSeconds, 60);
});

test('クォータ超過以外は null を返す', () => {
  assert.equal(asRateLimitError(Object.assign(new Error('boom'), { code: 3 })), null);
  assert.equal(asRateLimitError(new Error('boom')), null);
  assert.equal(asRateLimitError(null), null);
});

test('クォータ単位から窓の長さを読む', () => {
  assert.equal(windowSecondsFromUnit('1/min/{project}'), 60);
  assert.equal(windowSecondsFromUnit('1/d/{project}'), 86_400);
  assert.equal(windowSecondsFromUnit('100/h/{project}'), 3600);
  assert.equal(windowSecondsFromUnit('謎'), null);
  assert.equal(windowSecondsFromUnit(undefined), null);
});
