import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOTENV_CONFIG_PATH = '/nonexistent/.env';
delete process.env.KINTONE_QUESTION_FIELD;
delete process.env.KINTONE_ANSWER_FIELD;

const { toFaqRecord } = await import('../src/sources/kintone.js');

test('kintone レコードを {id, question, answer} に正規化する', () => {
  const record = {
    $id: { type: '__ID__', value: '7' },
    question: { type: 'SINGLE_LINE_TEXT', value: '解約方法は？' },
    answer: { type: 'MULTI_LINE_TEXT', value: 'マイページから手続きできます。' },
  };
  assert.deepEqual(toFaqRecord(record), {
    id: '7',
    question: '解約方法は？',
    answer: 'マイページから手続きできます。',
  });
});

test('欠けているフィールドは空文字になる', () => {
  assert.deepEqual(toFaqRecord({ $id: { value: '1' } }), {
    id: '1',
    question: '',
    answer: '',
  });
});

test('フィールドコードを差し替えられる', () => {
  const record = {
    $id: { value: '9' },
    質問: { value: 'Q' },
    回答: { value: 'A' },
  };
  assert.deepEqual(toFaqRecord(record, { questionField: '質問', answerField: '回答' }), {
    id: '9',
    question: 'Q',
    answer: 'A',
  });
});
