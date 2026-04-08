import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";
import 'dotenv/config';

// --- 設定 ---
const API_KEY = process.env.API_KEY; // Google AI Studioで取得
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const outputDir = 'optimized_docs';
const stateFile = '.optimize_state.json';

// --- kintone 設定 ---
const KINTONE_DOMAIN = process.env.KINTONE_DOMAIN; // 例: example.cybozu.com
const KINTONE_APP_ID = process.env.KINTONE_APP_ID;
const KINTONE_API_TOKEN = process.env.KINTONE_API_TOKEN;
const KINTONE_GUEST_SPACE_ID = process.env.KINTONE_GUEST_SPACE_ID; // 任意

const kintoneBasePath = KINTONE_GUEST_SPACE_ID
  ? `/k/guest/${KINTONE_GUEST_SPACE_ID}/v1`
  : '/k/v1';

export async function fetchFaqFromKintone() {
  if (!KINTONE_DOMAIN || !KINTONE_APP_ID || !KINTONE_API_TOKEN) {
    throw new Error('KINTONE_DOMAIN / KINTONE_APP_ID / KINTONE_API_TOKEN を .env に設定してください。');
  }
  const records = [];
  const limit = 500;
  let offset = 0;
  while (true) {
    const query = encodeURIComponent(`order by $id asc limit ${limit} offset ${offset}`);
    const url = `https://${KINTONE_DOMAIN}${kintoneBasePath}/records.json?app=${KINTONE_APP_ID}&query=${query}`;
    const res = await fetch(url, {
      headers: { 'X-Cybozu-API-Token': KINTONE_API_TOKEN },
    });
    if (!res.ok) {
      throw new Error(`kintone API error: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    for (const r of json.records) {
      records.push({
        id: r.$id?.value,
        question: r.question?.value ?? '',
        answer: r.answer?.value ?? '',
      });
    }
    if (json.records.length < limit) break;
    offset += limit;
  }
  return records;
}

async function optimizeRecord(id, question, answer) {
  const prompt = `
以下のFAQレコードを、RAG（検索拡張生成）システムが検索しやすいように最適化してください。
特に、ユーザーが検索しそうな「類義語」や「言い換え表現」を生成して含めてください。

【元のデータ】
質問: ${question}
回答: ${answer}

【出力フォーマット】
以下の形式のテキストのみを出力してください。
[[ID: faq_${id}]]
[[CATEGORY: カテゴリ名を推論]]
[[KEYWORDS: 重要単語を5〜10個抽出]]

[[SEARCH_QUERIES]]
- ユーザーがこの回答に辿り着くために検索しそうな話し言葉の質問文を4つ生成

QUESTION: 元の質問をより分かりやすく整えた文章
ANSWER: 元の回答を構造化した文章（箇条書きなどを活用）
`;

  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (e) {
      if (e.message.includes('429') || e.message.includes('Quota')) {
        retryCount++;
        const waitTime = Math.pow(2, retryCount) * 1000 + 5000;
        console.warn(`[Retry ${retryCount}/${maxRetries}] Quota exceeded at id ${id}. Waiting ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.error(`Error at id ${id}:`, e.message);
        return null;
      }
    }
  }
  console.error(`Failed at id ${id} after ${maxRetries} retries.`);
  return null;
}

function loadState() {
  if (!fs.existsSync(stateFile)) return {};
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function hashRecord(r) {
  return crypto.createHash('sha1').update(`${r.question}\n---\n${r.answer}`).digest('hex');
}

/**
 * kintoneからFAQを取得して最適化済みドキュメントを生成。
 * 差分のみGeminiに投げる。
 * @param {Object} opts
 * @param {boolean} [opts.full=false] trueなら全件再生成
 * @returns {Promise<{added:string[], updated:string[], removed:string[], unchanged:number, files:string[]}>}
 */
export async function optimizeAll({ full = false } = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, '.gitkeep'), '');
  }

  console.log('kintoneからFAQデータを取得しています...');
  const records = await fetchFaqFromKintone();
  console.log(`kintone: ${records.length}件取得`);

  const prevState = full ? {} : loadState();
  const nextState = { ...prevState };
  const added = [], updated = [], removed = [];

  // 差分判定 (nextStateには書き込み成功時のみ反映)
  const targets = [];
  const targetHash = {};
  for (const r of records) {
    const h = hashRecord(r);
    targetHash[r.id] = h;
    const filename = `faq_${r.id}.txt`;
    const filepath = path.join(outputDir, filename);
    if (!prevState[r.id]) {
      added.push(filename);
      targets.push(r);
    } else if (prevState[r.id] !== h || !fs.existsSync(filepath)) {
      updated.push(filename);
      targets.push(r);
    }
  }

  // 削除検知 (kintoneレコードIDに対応しないローカルファイルを全削除)
  const validFilenames = new Set(records.map(r => `faq_${r.id}.txt`));
  for (const f of fs.readdirSync(outputDir)) {
    if (!f.startsWith('faq_') || !f.endsWith('.txt')) continue;
    if (!validFilenames.has(f)) {
      fs.unlinkSync(path.join(outputDir, f));
      const id = f.replace(/^faq_|\.txt$/g, '');
      delete nextState[id];
      removed.push(f);
    }
  }

  console.log(`差分: 追加${added.length} / 更新${updated.length} / 削除${removed.length} / 変更なし${records.length - targets.length}`);

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    console.log(`[${i + 1}/${targets.length}] 解析中 (id=${r.id}): ${r.question.substring(0, 20)}...`);
    const content = await optimizeRecord(r.id, r.question, r.answer);
    if (content) {
      fs.writeFileSync(path.join(outputDir, `faq_${r.id}.txt`), content);
      nextState[r.id] = targetHash[r.id];
    }
    if (i < targets.length - 1) {
      await new Promise(res => setTimeout(res, 10000));
    }
  }

  saveState(nextState);

  const files = records.map(r => `faq_${r.id}.txt`);
  return { added, updated, removed, unchanged: records.length - targets.length, files };
}

// CLI実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const full = process.argv.includes('--full');
  optimizeAll({ full }).then(r => {
    console.log('完了:', r);
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
