/**
 * 依存追加なしの軽量ロガー。
 *
 * Cloud Run 上 (K_SERVICE が設定されている) では Cloud Logging が解釈できる
 * 構造化 JSON を 1 行で出力し、ローカルでは人が読みやすい平文で出力する。
 */
const structured = Boolean(process.env.K_SERVICE);

const SEVERITY = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

const LEVEL_ORDER = ['debug', 'info', 'warn', 'error'];
const minLevel = LEVEL_ORDER.includes((process.env.LOG_LEVEL ?? '').toLowerCase())
  ? process.env.LOG_LEVEL.toLowerCase()
  : 'info';

function enabled(level) {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(minLevel);
}

function emit(level, message, fields) {
  if (!enabled(level)) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;

  if (structured) {
    stream.write(`${JSON.stringify({ severity: SEVERITY[level], message, ...fields })}\n`);
    return;
  }

  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  stream.write(`${message}${suffix}\n`);
}

export const logger = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),

  /**
   * 同一行を上書きする進捗表示。TTY 以外 (Cloud Run / CI / パイプ) では
   * 行が積み上がらないよう何も出力しない。
   * @param {string} message
   */
  progress(message) {
    if (structured || !process.stdout.isTTY) return;
    process.stdout.write(`\r${message}   `);
  },

  /** progress() で書いた行を閉じる。 */
  progressEnd() {
    if (structured || !process.stdout.isTTY) return;
    process.stdout.write('\n');
  },
};
