/**
 * 検索 API を提供する Express アプリ。
 * Function Calling などの外部連携から呼び出される想定。
 */
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { search } from './search.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // GET /search?q=... と POST /search {"q": "..."} は同じ処理
  const handleSearch = async (req, res, next) => {
    const query = (req.method === 'GET' ? req.query.q : req.body?.q) ?? '';
    if (typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({
        error: 'Bad Request',
        details: req.method === 'GET' ? 'Query parameter "q" is required' : 'Body parameter "q" is required',
      });
    }

    const startedAt = performance.now();
    try {
      const result = await search(query.trim());
      res.json(result);
      // src/search.js の searchMs / answerMs と突き合わせると、
      // アプリ側のオーバーヘッドがどれだけあるか分かる
      logger.info('リクエスト完了', {
        path: req.path,
        requestMs: Math.round(performance.now() - startedAt),
      });
    } catch (err) {
      next(err);
    }
  };

  app.get('/search', handleSearch);
  app.post('/search', handleSearch);

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  // 既存の疎通確認用エンドポイント (後方互換のため維持)
  app.get('/', (req, res) => res.send('RAG Engine Service is running.'));

  app.use((err, req, res, _next) => {
    logger.error('リクエスト処理に失敗しました', { path: req.path, error: err?.message });
    res.status(500).json({ error: 'Internal Server Error', details: err?.message });
  });

  return app;
}

/**
 * サーバを起動し、SIGTERM/SIGINT で graceful shutdown する。
 * Cloud Run は停止時に SIGTERM を送るため、処理中のリクエストを取りこぼさない。
 */
export function startServer({ port = config.port, gracePeriodMs = 8000 } = {}) {
  const server = createApp().listen(port, () => {
    logger.info(`Server listening on port ${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} を受信しました。シャットダウンします。`);

    server.close(() => process.exit(0));
    // keep-alive の待機中コネクションがあると server.close() が返らないため明示的に閉じる
    server.closeIdleConnections();

    // Cloud Run が SIGKILL を送るまでに終われるよう、処理中リクエストにも上限を設ける
    setTimeout(() => {
      logger.warn('処理中のリクエストが残っているため強制終了します。');
      server.closeAllConnections();
      process.exit(0);
    }, gracePeriodMs).unref();
  };

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => shutdown(signal));
  }

  return server;
}
