/**
 * kintone アプリから FAQ レコードを取得する。
 * 1 リクエストあたり最大 500 件のためカーソルなしのオフセットページングで全件走査する。
 */
import { config } from '../config.js';
import { logger } from '../logger.js';

const PAGE_SIZE = 500;

/** ゲストスペース配下のアプリはパスが異なる。 */
function basePath(guestSpaceId = config.kintone.guestSpaceId) {
  return guestSpaceId ? `/k/guest/${guestSpaceId}/v1` : '/k/v1';
}

/**
 * kintone のレコード JSON を {id, question, answer} に正規化する。
 * フィールドコードは KINTONE_QUESTION_FIELD / KINTONE_ANSWER_FIELD で変更できる。
 * @param {object} record
 * @param {{questionField?: string, answerField?: string}} [fields]
 */
export function toFaqRecord(record, fields = {}) {
  const questionField = fields.questionField ?? config.kintone.questionField;
  const answerField = fields.answerField ?? config.kintone.answerField;
  return {
    id: record?.$id?.value,
    question: record?.[questionField]?.value ?? '',
    answer: record?.[answerField]?.value ?? '',
  };
}

/**
 * FAQ レコードを全件取得する。
 * @returns {Promise<{id: string, question: string, answer: string}[]>}
 */
export async function fetchFaqRecords() {
  const { domain, appId, apiToken } = config.kintone;
  const records = [];
  let offset = 0;

  while (true) {
    const query = encodeURIComponent(`order by $id asc limit ${PAGE_SIZE} offset ${offset}`);
    const url = `https://${domain}${basePath()}/records.json?app=${appId}&query=${query}`;

    const res = await fetch(url, { headers: { 'X-Cybozu-API-Token': apiToken } });
    if (!res.ok) {
      throw new Error(`kintone API error: ${res.status} ${await res.text()}`);
    }

    const json = await res.json();
    for (const record of json.records) records.push(toFaqRecord(record));

    if (json.records.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  logger.info(`kintone: ${records.length}件取得`);
  return records;
}
