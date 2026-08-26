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

/** クライアントは初回利用時に生成する (import 時に副作用を出さないため)。 */
function getClients() {
  if (!clients) {
    const options = { apiEndpoint: apiHost() };
    clients = {
      search: new SearchServiceClient(options),
      conversational: new ConversationalSearchServiceClient(options),
    };
  }
  return clients;
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
  const { search: searchClient, conversational: conversationalClient } = getClients();

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

  logger.info('検索を実行します', { query });

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

  const references = toReferences(results ?? []);
  logger.debug('検索結果', { hits: results?.length ?? 0, references });

  const answerRequest = {
    servingConfig,
    query: { text: query },
    relatedQuestionsSpec: { enable: true },
    answerGenerationSpec: {
      ignoreAdversarialQuery: true,
      ignoreNonAnswerSeekingQuery: false,
      ignoreLowRelevantContent: true,
      includeCitations: true,
      modelSpec: { modelVersion: 'stable' },
      promptSpec: { preamble: config.search.preamble },
    },
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

  const [answerResponse] = await conversationalClient.answerQuery(answerRequest);

  const answer = answerResponse.answer?.answerText ?? null;
  const relatedQuestions = answerResponse.relatedQuestions ?? [];

  logger.info('回答を生成しました', { hasAnswer: Boolean(answer), related: relatedQuestions.length });

  return { answer, references, relatedQuestions };
}
