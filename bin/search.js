#!/usr/bin/env node
/**
 * CLI: 検索と回答生成を 1 回実行して結果を表示する。
 *
 *   npm run search -- "解約方法について教えて下さい"
 */
import { assertConfig, ConfigError } from '../src/config.js';
import { search } from '../src/search.js';

const query = process.argv.slice(2).join(' ').trim() || '解約方法について教えて下さい';

try {
  assertConfig('serve');
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

try {
  const { answer, references, relatedQuestions } = await search(query);

  console.log('\n--- Answer ---');
  console.log(answer ?? '回答を生成できませんでした。');

  if (references.length > 0) {
    console.log('\n--- References ---');
    references.forEach((ref, i) => console.log(`[${i + 1}] ${ref.title} (${ref.link})`));
  }

  if (relatedQuestions.length > 0) {
    console.log('\n--- Related Questions ---');
    relatedQuestions.forEach((q) => console.log(`- ${q}`));
  }
} catch (error) {
  console.error('検索に失敗しました:', error?.message ?? error);
  if (error?.details) console.error('Details:', error.details);
  process.exit(1);
}
