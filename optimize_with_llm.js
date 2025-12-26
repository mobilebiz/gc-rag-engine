import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from "@google/generative-ai";
import 'dotenv/config';

// --- 設定 ---
const API_KEY = process.env.API_KEY; // Google AI Studioで取得
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

const inputCsv = 'faq_data.csv';
const outputDir = 'optimized_docs';

if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
fs.mkdirSync(outputDir);
fs.writeFileSync(path.join(outputDir, '.gitkeep'), '');

async function optimizeRecord(index, question, answer) {
  const prompt = `
以下のFAQレコードを、RAG（検索拡張生成）システムが検索しやすいように最適化してください。
特に、ユーザーが検索しそうな「類義語」や「言い換え表現」を生成して含めてください。

【元のデータ】
質問: ${question}
回答: ${answer}

【出力フォーマット】
以下の形式のテキストのみを出力してください。
[[ID: faq_${String(index).padStart(3, '0')}]]
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
        const waitTime = Math.pow(2, retryCount) * 1000 + 5000; // Exponential backoff + base 5s
        console.warn(`[Retry ${retryCount}/${maxRetries}] Quota exceeded at index ${index}. Waiting ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.error(`Error at index ${index}:`, e.message);
        return null;
      }
    }
  }
  console.error(`Failed at index ${index} after ${maxRetries} retries.`);
  return null;
}

async function main() {
  const data = fs.readFileSync(inputCsv, 'utf-8');
  const lines = data.split(/\r?\n/).filter(line => line.trim());

  console.log(`${lines.length}件の処理を開始します。API制限に注意してください...`);

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const q = parts[0];
    const a = parts.slice(1).join(',');

    console.log(`[${i + 1}/${lines.length}] 解析中: ${q.substring(0, 15)}...`);

    const optimizedContent = await optimizeRecord(i + 1, q, a);

    if (optimizedContent) {
      fs.writeFileSync(path.join(outputDir, `faq_${String(i + 1).padStart(3, '0')}.txt`), optimizedContent);
    }

    // 無料版APIの場合、レート制限(RPM: 10 requests/min)を考慮して10秒待機
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  console.log("すべてのファイルの生成が完了しました！");
}

main();