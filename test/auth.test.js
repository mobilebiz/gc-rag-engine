import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/nonexistent';

const { matchesAnyKey, extractCredential } = await import('../src/auth.js');

/** req.get() だけを持つ最小のダミー。ヘッダ名は大小を区別しない。 */
const fakeReq = (headers) => ({
  get: (name) => headers[name.toLowerCase()],
});

test('正しいキーは一致する', () => {
  assert.equal(matchesAnyKey('secret', ['secret']), true);
});

test('誤ったキーは一致しない', () => {
  assert.equal(matchesAnyKey('wrong', ['secret']), false);
});

test('長さが違うキーでも例外にならず false を返す', () => {
  // ダイジェスト同士を比較しているので timingSafeEqual が長さで落ちない
  assert.equal(matchesAnyKey('x', ['a-much-longer-secret']), false);
  assert.equal(matchesAnyKey('a-much-longer-presented-value', ['x']), false);
});

test('複数キーのどれかに一致すればよい (ローテーション)', () => {
  assert.equal(matchesAnyKey('new', ['new', 'old']), true);
  assert.equal(matchesAnyKey('old', ['new', 'old']), true);
  assert.equal(matchesAnyKey('other', ['new', 'old']), false);
});

test('キーが未設定なら常に一致しない', () => {
  assert.equal(matchesAnyKey('anything', []), false);
});

test('空の提示値は一致しない', () => {
  assert.equal(matchesAnyKey('', ['secret']), false);
});

test('X-API-Key ヘッダから取り出す', () => {
  assert.equal(extractCredential(fakeReq({ 'x-api-key': 'secret' })), 'secret');
});

test('Authorization: Bearer から取り出す', () => {
  assert.equal(extractCredential(fakeReq({ authorization: 'Bearer secret' })), 'secret');
  // スキーム名の大小は区別しない
  assert.equal(extractCredential(fakeReq({ authorization: 'bearer secret' })), 'secret');
});

test('X-API-Key を Authorization より優先する', () => {
  const req = fakeReq({ 'x-api-key': 'from-header', authorization: 'Bearer from-bearer' });
  assert.equal(extractCredential(req), 'from-header');
});

test('前後の空白は落とす', () => {
  assert.equal(extractCredential(fakeReq({ 'x-api-key': '  secret  ' })), 'secret');
  assert.equal(extractCredential(fakeReq({ authorization: 'Bearer   secret  ' })), 'secret');
});

test('認証情報が無ければ空文字', () => {
  assert.equal(extractCredential(fakeReq({})), '');
  assert.equal(extractCredential(fakeReq({ authorization: 'Basic abc' })), '');
});
