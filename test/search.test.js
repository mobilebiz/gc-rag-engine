import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/nonexistent';

const { toAnswerReferences } = await import('../src/search.js');

const unstructured = (uri, title) => ({ unstructuredDocumentInfo: { uri, title } });

test('非構造化ドキュメントから {title, link} を取り出す', () => {
  assert.deepEqual(toAnswerReferences([unstructured('gs://b/faq_1.txt', 'faq_1')]), [
    { title: 'faq_1', link: 'gs://b/faq_1.txt' },
  ]);
});

test('同じドキュメントの複数チャンクを 1 件にまとめる', () => {
  // Answer.references はチャンク単位で返るため、同じファイルが並ぶ
  const refs = [
    unstructured('gs://b/faq_1.txt', 'faq_1'),
    unstructured('gs://b/faq_1.txt', 'faq_1'),
    unstructured('gs://b/faq_2.txt', 'faq_2'),
  ];
  assert.deepEqual(toAnswerReferences(refs).map((r) => r.link), [
    'gs://b/faq_1.txt',
    'gs://b/faq_2.txt',
  ]);
});

test('max を超えたら打ち切る', () => {
  const refs = ['a', 'b', 'c', 'd'].map((n) => unstructured(`gs://b/${n}.txt`, n));
  assert.equal(toAnswerReferences(refs, 2).length, 2);
});

test('chunkInfo.documentMetadata からも取り出せる', () => {
  const refs = [{ chunkInfo: { documentMetadata: { uri: 'gs://b/x.txt', title: 'x' } } }];
  assert.deepEqual(toAnswerReferences(refs), [{ title: 'x', link: 'gs://b/x.txt' }]);
});

test('structuredDocumentInfo からも取り出せる', () => {
  const refs = [{ structuredDocumentInfo: { uri: 'https://e/x', title: 'x' } }];
  assert.deepEqual(toAnswerReferences(refs), [{ title: 'x', link: 'https://e/x' }]);
});

test('URI が無ければタイトルで重複排除する', () => {
  const refs = [
    { unstructuredDocumentInfo: { title: 'same' } },
    { unstructuredDocumentInfo: { title: 'same' } },
    { unstructuredDocumentInfo: { title: 'other' } },
  ];
  assert.deepEqual(toAnswerReferences(refs).map((r) => r.title), ['same', 'other']);
});

test('タイトルが無ければ No Title で埋める', () => {
  assert.deepEqual(toAnswerReferences([unstructured('gs://b/x.txt', '')]), [
    { title: 'No Title', link: 'gs://b/x.txt' },
  ]);
});

test('参照が無い / 未定義でも空配列を返す', () => {
  assert.deepEqual(toAnswerReferences([]), []);
  assert.deepEqual(toAnswerReferences(undefined), []);
  assert.deepEqual(toAnswerReferences([{}, { unknownInfo: {} }]), []);
});
