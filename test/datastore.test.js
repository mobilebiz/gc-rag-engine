import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/nonexistent';

const { assertOperationSucceeded, gcsInputUri } = await import('../src/datastore.js');

test('成功した Operation はそのまま返す', () => {
  const op = { done: true, metadata: { successCount: 3 } };
  assert.equal(assertOperationSucceeded(op), op);
});

test('done: true でも error があれば例外にする', () => {
  // 失敗したインポートも done: true で返るため、ここで弾かないと
  // 呼び出し側が再開用 state を消して「完了」と記録してしまう
  assert.throws(
    () => assertOperationSucceeded({ done: true, error: { code: 3, message: 'bad input' } }),
    (error) => {
      assert.match(error.message, /code=3/);
      assert.match(error.message, /bad input/);
      return true;
    }
  );
});

test('error にメッセージが無くても例外にする', () => {
  assert.throws(() => assertOperationSucceeded({ done: true, error: {} }));
});

test('gcsInputUri は prefix の有無を吸収する', () => {
  assert.equal(gcsInputUri({ bucket: 'b', prefix: 'p' }), 'gs://b/p/*.txt');
  assert.equal(gcsInputUri({ bucket: 'b', prefix: '' }), 'gs://b/*.txt');
});
