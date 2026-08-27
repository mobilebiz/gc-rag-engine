#!/usr/bin/env node
/**
 * CLI: kintone → Gemini → GCS → データストア の同期パイプラインを実行する。
 *
 *   npm run sync                        # 差分同期
 *   npm run sync:full                   # 全件再生成
 *   npm run sync:resume                 # 中断したインポートの待機を再開
 *   npm run sync -- --skip-import       # 個別ステップのスキップ
 */
import { parseArgs } from 'node:util';
import { assertSteps, config, ConfigError } from '../src/config.js';
import { logger } from '../src/logger.js';
import { runPipeline } from '../src/pipeline.js';

const USAGE = `
使い方: npm run sync [-- <options>]

  --full            差分を無視して全件再生成する
  --resume          中断したインポート Operation の待機だけ行う
  --skip-optimize   kintone 取得と Gemini 最適化をスキップ
  --skip-upload     GCS アップロードをスキップ
  --skip-import     データストア再取り込みをスキップ
  --skip-smoke      スモークテストをスキップ
  --allow-partial   一部の最適化が失敗しても公開まで進める
  -h, --help        このヘルプを表示
`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      full: { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      'skip-optimize': { type: 'boolean', default: false },
      'skip-upload': { type: 'boolean', default: false },
      'skip-import': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      'allow-partial': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }));
} catch (error) {
  console.error(error.message);
  console.error(USAGE);
  process.exit(1);
}

if (values.help) {
  console.log(USAGE.trim());
  process.exit(0);
}

const options = {
  full: values.full,
  resume: values.resume,
  skipOptimize: values['skip-optimize'],
  skipUpload: values['skip-upload'],
  skipImport: values['skip-import'],
  skipSmoke: values['skip-smoke'],
  allowPartial: values['allow-partial'],
};

// 実際に走るステップだけを検証する。スキップしたステップの環境変数は要求しない。
const steps = [];
if (!options.resume && !options.skipOptimize) steps.push('optimize');
if (!options.resume && !options.skipUpload) steps.push('upload');
if (options.resume || !options.skipImport) steps.push('import');
// スモークテストはクエリ未設定なら実行されない
if (!options.skipSmoke && config.search.smokeTestQuery) steps.push('search');

try {
  assertSteps(steps, `実行するステップ: ${steps.join(', ') || 'なし'}`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

try {
  const { ok } = await runPipeline(options);
  if (!ok) process.exitCode = 2;
} catch (error) {
  logger.error('パイプライン失敗', { error: error?.message ?? String(error) });
  console.error(error);
  process.exit(1);
}
