/**
 * Gemini Enterprise Agent Platform (旧 Vertex AI Agent Builder) に対する
 * 検索 + 回答生成クライアント。
 *
 * API は discoveryengine.googleapis.com の **v1 (GA)** を使う。
 * 旧実装は v1alpha を使っていたが、session / SessionInfo / answerQuery /
 * relatedQuestionsSpec はいずれも v1 で GA 済みのため機能差はない。
 *
 * 処理は 2 段構成:
 *   1. search()      … 関連ドキュメントを検索し、セッションを開始する
 *   2. answerQuery() … 検索結果を根拠に回答を生成する
 */
import { v1 } from '@google-cloud/discoveryengine';
import { apiHost, config } from './config.js';
import { logger } from './logger.js';

const { SearchServiceClient, ConversationalSearchServiceClient } = v1;

let clients = null;

/**
 * インスタンス上で最初に検索した 1 回だけ記録するコールドスタート情報。
 * 読み出すと消えるので、2 回目以降のログには載らない。
 */
let coldStartInfo = null;

/** クライアントは初回利用時に生成する (import 時に副作用を出さないため)。 */
function getClients() {
  if (!clients) {
    const startedAt = performance.now();
    const options = { apiEndpoint: apiHost() };
    clients = {
      search: new SearchServiceClient(options),
      conversational: new ConversationalSearchServiceClient(options),
    };
    coldStartInfo = {
      coldStart: true,
      // クライアント生成にかかった時間
      clientInitMs: Math.round(performance.now() - startedAt),
      // プロセス起動から最初のリクエストが届くまで = コンテナ起動ぶんの目安
      processUptimeMs: Math.round(process.uptime() * 1000),
    };
  }
  return clients;
}

function takeColdStartInfo() {
  const info = coldStartInfo;
  coldStartInfo = null;
  return info ?? {};
}

/**
 * 検索結果ドキュメントから structData / derivedStructData を横断してフィールドを取り出す。
 * protobuf の Value ラッパー ({stringValue: "..."}) にも対応する。
 */
function getField(doc, field) {
  if (!doc) return null;
  const struct = doc.structData ?? {};
  const derived = doc.derivedStructData ?? {};
  const value =
    (struct[field] !== undefined ? struct[field] : struct.fields?.[field]) ??
    (derived[field] !== undefined ? derived[field] : derived.fields?.[field]);
  if (value && typeof value === 'object' && value.stringValue) return value.stringValue;
  return value ?? null;
}

/**
 * answerQuery のレスポンスから参照元を組み立てる。
 *
 * Answer.references はドキュメント単位ではなく**チャンク単位**で返るため、
 * 同じファイルが複数回並ぶ。URI で重複排除してから件数を絞る。
 *
 * @param {object[]} references Answer.references
 * @param {number} max
 * @returns {{title: string, link: string}[]}
 */
export function toAnswerReferences(references, max = config.search.maxReferences) {
  const seen = new Set();
  const out = [];

  for (const ref of references ?? []) {
    // 非構造化ドキュメント / チャンク / 構造化ドキュメントのいずれかに入る
    const info =
      ref?.unstructuredDocumentInfo ??
      ref?.chunkInfo?.documentMetadata ??
      ref?.structuredDocumentInfo;
    if (!info) continue;

    const link = info.uri ?? '';
    // URI が無いものは重複判定できないのでタイトルで代用する。
    // 種別で前置きしないと、ある参照の URI が別の参照のタイトルと一致したときに
    // 別ドキュメントを取りこぼす。
    const key = link ? `uri:${link}` : info.title ? `title:${info.title}` : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);

    out.push({ title: info.title || 'No Title', link });
    if (out.length >= max) break;
  }

  return out;
}

function toReferences(results) {
  return results.slice(0, config.search.maxReferences).map((item) => ({
    title: getField(item.document, 'title') ?? 'No Title',
    link: getField(item.document, 'link') ?? '',
  }));
}

/**
 * 質問文に対して検索と回答生成を行う。
 * @param {string} query
 * @returns {Promise<{answer: string|null, references: {title: string, link: string}[], relatedQuestions: string[]}>}
 */
export async function search(query) {
  return config.search.singleRoundTrip ? searchSingleRoundTrip(query) : searchTwoRoundTrips(query);
}

/** answerQuery が根拠にする回答生成の設定。両方の経路で共通。 */
function answerGenerationSpec() {
  const spec = {
    ignoreAdversarialQuery: true,
    ignoreNonAnswerSeekingQuery: false,
    ignoreLowRelevantContent: true,
    includeCitations: true,
    modelSpec: { modelVersion: 'stable' },
  };
  // SEARCH_PREAMBLE 未設定ならモデルの既定の回答スタイルに任せる
  if (config.search.preamble) spec.promptSpec = { preamble: config.search.preamble };
  return spec;
}

function servingConfigPath(client) {
  return client.projectLocationCollectionEngineServingConfigPath(
    config.projectNumber,
    config.location,
    config.collectionId,
    config.engineId,
    config.servingConfigId
  );
}

/**
 * answerQuery だけで完結させる 1 往復の経路。
 * answerQuery は session を渡さなければ自前で検索するため、事前の search を省ける。
 */
async function searchSingleRoundTrip(query) {
  const { search: searchClient, conversational: conversationalClient } = getClients();
  const coldStart = takeColdStartInfo();
  const servingConfig = servingConfigPath(searchClient);

  logger.info('検索を実行します', { query, mode: 'single', ...coldStart });

  const startedAt = performance.now();
  const [answerResponse] = await conversationalClient.answerQuery({
    servingConfig,
    query: { text: query },
    relatedQuestionsSpec: { enable: true },
    searchSpec: { searchParams: { maxReturnResults: config.search.pageSize } },
    answerGenerationSpec: answerGenerationSpec(),
  });
  const answerMs = Math.round(performance.now() - startedAt);

  const answer = answerResponse.answer?.answerText ?? null;
  const references = toAnswerReferences(answerResponse.answer?.references);
  const relatedQuestions = answerResponse.relatedQuestions ?? [];

  logger.info('回答を生成しました', {
    mode: 'single',
    hasAnswer: Boolean(answer),
    related: relatedQuestions.length,
    references: references.length,
    searchMs: 0,
    answerMs,
    totalMs: answerMs,
    ...coldStart,
  });

  return { answer, references, relatedQuestions };
}

/** 検索とセッションを挟む従来の 2 往復の経路。 */
async function searchTwoRoundTrips(query) {
  const { search: searchClient, conversational: conversationalClient } = getClients();
  const coldStart = takeColdStartInfo();

  const servingConfig = searchClient.projectLocationCollectionEngineServingConfigPath(
    config.projectNumber,
    config.location,
    config.collectionId,
    config.engineId,
    config.servingConfigId
  );

  // "sessions/-" を指定すると、サーバ側が新しいセッションを払い出す
  const sessionParent =
    `projects/${config.projectNumber}/locations/${config.location}` +
    `/collections/${config.collectionId}/engines/${config.engineId}/sessions/-`;

  logger.info('検索を実行します', { query, mode: 'two-step', ...coldStart });

  const searchStartedAt = performance.now();
  const [results, , response] = await searchClient.search(
    {
      servingConfig,
      query,
      pageSize: config.search.pageSize,
      session: sessionParent,
      queryExpansionSpec: { condition: 'AUTO' },
      spellCorrectionSpec: { mode: 'AUTO' },
      contentSearchSpec: { snippetSpec: { returnSnippet: true } },
    },
    { autoPaginate: false }
  );

  const searchMs = Math.round(performance.now() - searchStartedAt);
  const references = toReferences(results ?? []);
  logger.debug('検索結果', { hits: results?.length ?? 0, searchMs, references });

  const answerRequest = {
    servingConfig,
    query: { text: query },
    relatedQuestionsSpec: { enable: true },
    answerGenerationSpec: answerGenerationSpec(),
  };

  // セッションが払い出せた場合は検索結果と紐付けて回答生成する。
  // 払い出せない場合 (ヒット 0 件など) でも answerQuery 単体で動作するのでフォールバックする。
  if (response?.sessionInfo?.name) {
    answerRequest.session = response.sessionInfo.name;
    answerRequest.query.queryId = response.sessionInfo.queryId;
    logger.debug('セッションを継続します', { session: response.sessionInfo.name });
  } else {
    logger.warn('SessionInfo が取得できなかったため、セッションなしで回答生成します', { query });
  }

  const answerStartedAt = performance.now();
  const [answerResponse] = await conversationalClient.answerQuery(answerRequest);
  const answerMs = Math.round(performance.now() - answerStartedAt);

  const answer = answerResponse.answer?.answerText ?? null;
  const relatedQuestions = answerResponse.relatedQuestions ?? [];

  // searchMs と answerMs の内訳を見れば、遅さの原因がコールドスタートなのか
  // 回答生成そのものなのかを切り分けられる
  logger.info('回答を生成しました', {
    mode: 'two-step',
    hasAnswer: Boolean(answer),
    related: relatedQuestions.length,
    searchMs,
    answerMs,
    totalMs: searchMs + answerMs,
    ...coldStart,
  });

  return { answer, references, relatedQuestions };
}
