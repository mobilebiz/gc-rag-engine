import 'dotenv/config';
import { v1alpha } from '@google-cloud/discoveryengine';
import { fileURLToPath } from 'url';

const { SearchServiceClient, ConversationalSearchServiceClient } = v1alpha;

// 環境変数から設定を読み込み
const projectNumber = process.env.PROJECT_NUMBER || '';
const location = process.env.LOCATION || 'global';
const collectionId = 'default_collection';
const engineId = process.env.AI_APPLICATION_ID || '';
const servingConfigId = 'default_search';

// 環境変数未設定チェック
if (!projectNumber || !engineId) {
  console.error('PROJECT_NUMBER and AI_APPLICATION_ID must be set in the environment variables.');
  process.exit(1);
}

const apiEndpoint =
  location === 'global'
    ? 'discoveryengine.googleapis.com'
    : `${location}-discoveryengine.googleapis.com`;

const searchClient = new SearchServiceClient({ apiEndpoint: apiEndpoint });
const conversationalClient = new ConversationalSearchServiceClient({ apiEndpoint: apiEndpoint });

export async function search(searchQuery) {
  console.log(`\nQuestion: "${searchQuery}"`);

  const servingConfig = searchClient.projectLocationCollectionEngineServingConfigPath(
    projectNumber,
    location,
    collectionId,
    engineId,
    servingConfigId
  );

  // --- Step 1: Search (Start Session) ---
  console.log('Searching...');

  const sessionParent = `projects/${projectNumber}/locations/${location}/collections/${collectionId}/engines/${engineId}/sessions/-`;

  const searchRequest = {
    servingConfig: servingConfig,
    query: searchQuery,
    pageSize: 10,
    session: sessionParent,
    queryExpansionSpec: { condition: "AUTO" },
    spellCorrectionSpec: { mode: "AUTO" },
    contentSearchSpec: { snippetSpec: { returnSnippet: true } },
  };

  try {
    const [results, request, response] = await searchClient.search(searchRequest, { autoPaginate: false });

    let references = [];
    if (results && results.length > 0) {
      console.log('\n--- References ---');
      references = results.slice(0, 3).map((item, i) => {
        const doc = item.document;
        const getField = (d, f) => {
          if (!d) return null;
          const s = d.structData || {};
          const ds = d.derivedStructData || {};
          const val = (s[f] !== undefined ? s[f] : s.fields?.[f]) || (ds[f] !== undefined ? ds[f] : ds.fields?.[f]);
          if (val && typeof val === 'object' && val.stringValue) return val.stringValue;
          return val;
        };
        const title = getField(doc, 'title') || 'No Title';
        const link = getField(doc, 'link') || '';
        console.log(`[${i + 1}] ${title} (${link})`);
        return { title, link };
      });
    }

    if (!response || !response.sessionInfo) {
      console.log('Session Info NOT found. Cannot proceed.');
      return { error: 'Session Info not found' };
    }

    const sessionInfo = response.sessionInfo;
    const sessionName = sessionInfo.name;
    const queryId = sessionInfo.queryId;

    console.log(`\nSession Name: ${sessionName}`);

    // --- Step 2: Answer (Generate Answer) ---
    console.log('\nThinking (Generating Answer)...');

    const answerRequest = {
      servingConfig: servingConfig,
      session: sessionName,
      query: {
        text: searchQuery,
        queryId: queryId
      },
      relatedQuestionsSpec: { enable: true },
      answerGenerationSpec: {
        ignoreAdversarialQuery: true,
        ignoreNonAnswerSeekingQuery: false,
        ignoreLowRelevantContent: true,
        includeCitations: true,
        modelSpec: { modelVersion: "stable" },
        promptSpec: {
          preamble: "音声での返答を想定するため、なるべく丁寧調で、かつ全体を200文字以内にまとめて回答してください。"
        }
      }
    };

    const [answerResponse] = await conversationalClient.answerQuery(answerRequest);

    const answerText = answerResponse.answer?.answerText || 'No answer generated.';
    console.log('\n--- Answer ---');
    console.log(answerText);

    if (answerResponse.relatedQuestions && answerResponse.relatedQuestions.length > 0) {
      console.log('\n--- Related Questions ---');
      answerResponse.relatedQuestions.forEach(q => console.log(`- ${q}`));
    }

    return {
      answer: answerText,
      references: references,
      relatedQuestions: answerResponse.relatedQuestions || []
    };

  } catch (err) {
    console.error('Error:', err);
    if (err.details) console.error('Details:', err.details);
    throw err;
  }
}

// 実行判定 (ES Modules)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const query = process.argv[2] || '解約方法について教えて下さい';
  search(query);
}