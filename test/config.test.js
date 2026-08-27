import test from 'node:test';
import assert from 'node:assert/strict';

// config.js は import 時に環境変数を読み切るので、先に process.env を整えてから
// 動的 import する。DOTENV_CONFIG_PATH で実物の .env を読ませないようにする。
process.env.DOTENV_CONFIG_PATH = '/nonexistent/.env';
process.env.PROJECT_NUMBER = '123456789012';
process.env.AI_APPLICATION_ID = 'my-engine';
process.env.LOCATION = 'global';
process.env.GCS_PREFIX = '/faq_docs/';
process.env.API_KEY = 'legacy-key';
delete process.env.GEMINI_API_KEY;
delete process.env.DATA_STORE_ID;
delete process.env.GCS_BUCKET;
delete process.env.KINTONE_DOMAIN;

const { config, apiHost, assertConfig, ConfigError } = await import('../src/config.js');

test('apiHost は global のときリージョン接頭辞を付けない', () => {
  assert.equal(apiHost('global'), 'discoveryengine.googleapis.com');
});

test('apiHost は global 以外でリージョン接頭辞を付ける', () => {
  assert.equal(apiHost('us'), 'us-discoveryengine.googleapis.com');
  assert.equal(apiHost('eu'), 'eu-discoveryengine.googleapis.com');
});

test('GCS_PREFIX は前後のスラッシュを取り除いて正規化される', () => {
  assert.equal(config.gcs.prefix, 'faq_docs');
});

test('GEMINI_API_KEY 未設定時は旧名 API_KEY にフォールバックする', () => {
  assert.equal(config.gemini.apiKey, 'legacy-key');
});

test('serve モードは必要な変数が揃っていれば通る', () => {
  assert.doesNotThrow(() => assertConfig('serve'));
});

test('sync モードは不足している変数をまとめて報告する', () => {
  assert.throws(
    () => assertConfig('sync'),
    (error) => {
      assert.ok(error instanceof ConfigError);
      for (const name of ['DATA_STORE_ID', 'GCS_BUCKET', 'KINTONE_DOMAIN', 'KINTONE_APP_ID']) {
        assert.match(error.message, new RegExp(name));
      }
      // 揃っているものは報告しない
      assert.doesNotMatch(error.message, /PROJECT_NUMBER/);
      return true;
    }
  );
});

test('未知のモードは ConfigError になる', () => {
  assert.throws(() => assertConfig('unknown'), ConfigError);
});

test('assertSteps は実行するステップの分だけ要求する', async () => {
  const { assertSteps } = await import('../src/config.js');
  // optimize だけなら GCS やデータストアは不要 (serve 用の値は設定済み)
  assert.throws(
    () => assertSteps(['optimize']),
    (error) => {
      assert.match(error.message, /GEMINI_API_KEY|KINTONE_DOMAIN/);
      assert.doesNotMatch(error.message, /GCS_BUCKET|DATA_STORE_ID/);
      return true;
    }
  );
});

test('assertSteps は同じ変数を重複して報告しない', async () => {
  const { assertSteps } = await import('../src/config.js');
  assert.throws(
    () => assertSteps(['upload', 'import']),
    (error) => {
      // GCS_BUCKET は upload と import の両方が要求する
      assert.equal(error.message.match(/GCS_BUCKET/g).length, 1);
      return true;
    }
  );
});

test('assertSteps は未知のステップを拒否する', async () => {
  const { assertSteps } = await import('../src/config.js');
  assert.throws(() => assertSteps(['nope']), ConfigError);
});
