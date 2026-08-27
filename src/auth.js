/**
 * 検索 API の共有シークレット認証。
 *
 * Cloud Run 自体は `--allow-unauthenticated` で公開しておき、アプリ側でキーを検証する。
 * 呼び出し側 (Function Calling や音声応答プラットフォーム) が Google の ID トークンを
 * 取得できないことが多く、任意ヘッダなら送れるためこの形にしている。
 */
import crypto from 'node:crypto';
import { logger } from './logger.js';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();

/**
 * 提示されたキーが有効なキーのいずれかと一致するか。
 *
 * 生の文字列ではなく SHA-256 ダイジェスト同士を比較する。長さが常に 32 バイトに
 * 揃うため、timingSafeEqual に渡せるうえキー長も漏れない。
 * 一致してもループを打ち切らないのは、何番目のキーで一致したかを実行時間から
 * 推測されないようにするため。
 *
 * @param {string} presented
 * @param {string[]} keys
 * @returns {boolean}
 */
export function matchesAnyKey(presented, keys) {
  if (!presented || keys.length === 0) return false;

  const presentedDigest = sha256(presented);
  let matched = false;
  for (const key of keys) {
    if (crypto.timingSafeEqual(presentedDigest, sha256(key))) matched = true;
  }
  return matched;
}

/**
 * リクエストから提示された認証情報を取り出す。
 * `X-API-Key` を優先し、無ければ `Authorization: Bearer <key>` を見る。
 * @param {import('express').Request} req
 * @returns {string}
 */
export function extractCredential(req) {
  const apiKeyHeader = (req.get('x-api-key') ?? '').trim();
  if (apiKeyHeader) return apiKeyHeader;

  const authorization = (req.get('authorization') ?? '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  return bearer ? bearer[1].trim() : '';
}

/**
 * API キーを要求するミドルウェアを作る。
 * @param {string[]} keys 有効なキー。空配列なら認証を行わない (呼び出し側で明示的に許可した場合のみ)
 */
export function requireApiKey(keys) {
  if (keys.length === 0) {
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const presented = extractCredential(req);
    if (matchesAnyKey(presented, keys)) return next();

    // キーそのものは絶対にログに出さない
    logger.warn('認証に失敗しました', {
      path: req.path,
      hasCredential: Boolean(presented),
    });
    res.status(401).json({
      error: 'Unauthorized',
      details: 'X-API-Key ヘッダ、または Authorization: Bearer <key> に有効なキーを設定してください',
    });
  };
}
