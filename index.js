/**
 * Cloud Run のエントリポイント。
 * 設定を検証してから HTTP サーバを起動する。
 */
import { assertConfig, assertServerAuth, ConfigError } from './src/config.js';
import { logger } from './src/logger.js';
import { startServer } from './src/server.js';

try {
  assertConfig('serve');
  assertServerAuth();
} catch (error) {
  if (error instanceof ConfigError) {
    logger.error(error.message);
    process.exit(1);
  }
  throw error;
}

startServer();
