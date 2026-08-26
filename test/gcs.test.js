import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/nonexistent/.env';

const { findOrphanObjects } = await import('../src/gcs.js');
const { gcsInputUri } = await import('../src/datastore.js');

test('findOrphanObjects はローカルに無い .txt を削除対象にする', () => {
  const remote = ['faq_docs/faq_1.txt', 'faq_docs/faq_2.txt'];
  const local = new Set(['faq_docs/faq_1.txt']);
  assert.deepEqual(findOrphanObjects(remote, local), ['faq_docs/faq_2.txt']);
});

test('findOrphanObjects は .txt 以外を巻き込まない', () => {
  const remote = ['faq_docs/manual.pdf', 'backup.zip', 'faq_docs/faq_1.txt'];
  assert.deepEqual(findOrphanObjects(remote, new Set()), ['faq_docs/faq_1.txt']);
});

test('gcsInputUri は prefix ありのときスラッシュを補う', () => {
  assert.equal(gcsInputUri({ bucket: 'my-bucket', prefix: 'faq_docs' }), 'gs://my-bucket/faq_docs/*.txt');
});

test('gcsInputUri は prefix なしでもバケット直下を指す', () => {
  assert.equal(gcsInputUri({ bucket: 'my-bucket', prefix: '' }), 'gs://my-bucket/*.txt');
});
