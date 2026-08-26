import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/nonexistent/.env';

const { hashRecord, docFilename, findOrphanDocs } = await import('../src/optimize.js');

test('hashRecord は同じ内容に対して安定した値を返す', () => {
  const record = { question: '解約方法は？', answer: 'マイページから手続きできます。' };
  assert.equal(hashRecord(record), hashRecord({ ...record }));
});

test('hashRecord は回答が変わると別の値になる', () => {
  const base = { question: '解約方法は？', answer: 'A' };
  assert.notEqual(hashRecord(base), hashRecord({ ...base, answer: 'B' }));
});

test('hashRecord は question と answer の境界を区別する', () => {
  // 区切りがなければ "ab"+"" と "a"+"b" が衝突してしまう
  assert.notEqual(
    hashRecord({ question: 'ab', answer: '' }),
    hashRecord({ question: 'a', answer: 'b' })
  );
});

test('docFilename は kintone のレコードIDからファイル名を作る', () => {
  assert.equal(docFilename('42'), 'faq_42.txt');
});

test('findOrphanDocs は kintone に存在しない faq_*.txt だけを返す', () => {
  const existing = ['faq_1.txt', 'faq_2.txt', 'faq_3.txt', '.gitkeep', 'notes.md'];
  const valid = new Set(['faq_1.txt', 'faq_3.txt']);
  assert.deepEqual(findOrphanDocs(existing, valid), ['faq_2.txt']);
});

test('findOrphanDocs は faq_ 以外のファイルを巻き込まない', () => {
  const existing = ['README.txt', 'other_1.txt', '.gitkeep'];
  assert.deepEqual(findOrphanDocs(existing, new Set()), []);
});
