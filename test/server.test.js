import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/nonexistent';
process.env.PROJECT_NUMBER = '1';
process.env.AI_APPLICATION_ID = 'engine';
delete process.env.SEARCH_API_KEYS;

const { createApp } = await import('../src/server.js');
const { asRateLimitError } = await import('../src/errors.js');

/** 実際に Discovery Engine が返したクォータ超過エラーの再現。 */
const quotaError = (elapsedSeconds = 15) =>
  Object.assign(new Error('8 RESOURCE_EXHAUSTED'), {
    code: 8,
    reason: 'RATE_LIMIT_EXCEEDED',
    statusDetails: [
      {
        reason: 'RATE_LIMIT_EXCEEDED',
        metadata: {
          quota_metric: 'discoveryengine.googleapis.com/llm_requests',
          quota_limit_value: '10',
          quota_unit: '1/min/{project}',
          window_start_time: String(Math.floor(Date.now() / 1000) - elapsedSeconds),
        },
      },
    ],
  });

/** 一時サーバを立てて 1 リクエスト投げる。 */
async function call(searchFn, path = '/search?q=test') {
  const server = createApp({ searchFn }).listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
  } finally {
    server.close();
  }
}

test('クォータ超過は 429 と Retry-After で返す', async () => {
  const r = await call(() => {
    throw asRateLimitError(quotaError(15));
  });
  assert.equal(r.status, 429);
  // 窓が開いて 15 秒 → 残り 45 秒前後
  assert.ok(Number(r.retryAfter) > 40 && Number(r.retryAfter) <= 60, `retryAfter=${r.retryAfter}`);
  assert.equal(r.body.error, 'Too Many Requests');
});

test('通常の障害は 500 のままで Retry-After を付けない', async () => {
  const r = await call(() => {
    throw new Error('boom');
  });
  assert.equal(r.status, 500);
  assert.equal(r.retryAfter, null);
  assert.equal(r.body.error, 'Internal Server Error');
});

test('正常時は検索結果をそのまま返す', async () => {
  const payload = { answer: 'ok', references: [], relatedQuestions: [] };
  const r = await call(async () => payload);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, payload);
});

test('q が無ければ検索を呼ばずに 400', async () => {
  let called = false;
  const r = await call(() => {
    called = true;
  }, '/search');
  assert.equal(r.status, 400);
  assert.equal(called, false);
});
