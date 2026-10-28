import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

interface FinnhubArticle {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image?: string;
  related?: string;
  source: string;
  summary: string;
  url: string;
}

const ROOT_DIR = process.cwd();
const STATE_FILE = path.join(ROOT_DIR, 'processed_articles.json');
const FRAMEWORK_FILE = path.join(ROOT_DIR, 'TRADING_FRAMEWORK.md');

function sanitizeLog(text: string): string {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  let sanitized = text;
  if (finnhubKey) sanitized = sanitized.split(finnhubKey).join('***');
  if (geminiKey) sanitized = sanitized.split(geminiKey).join('***');
  if (webhookUrl) sanitized = sanitized.split(webhookUrl).join('***');
  return sanitized;
}

function logInfo(message: string): void {
  console.log(`[INFO] ${sanitizeLog(message)}`);
}

function logError(message: string): void {
  console.error(`[ERROR] ${sanitizeLog(message)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProcessedIds(): Set<number> {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return new Set<number>();
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf-8').trim();
    if (!raw) return new Set<number>();
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return new Set<number>(data.filter((id) => typeof id === 'number'));
    }
  } catch (err) {
    logError(`Could not read ${STATE_FILE}: ${(err as Error).message}`);
  }
  return new Set<number>();
}

function saveProcessedIds(ids: Set<number>): void {
  const arr = Array.from(ids);
  // Keep the most recent 1000 IDs to avoid unbounded growth over long runs
  const trimmed = arr.length > 1000 ? arr.slice(arr.length - 1000) : arr;
  fs.writeFileSync(STATE_FILE, JSON.stringify(trimmed, null, 2) + '\n', 'utf-8');
}

function readTradingFramework(): { hasContent: boolean; content: string } {
  if (!fs.existsSync(FRAMEWORK_FILE)) {
    return { hasContent: false, content: '' };
  }
  const content = fs.readFileSync(FRAMEWORK_FILE, 'utf-8');
  // Strip HTML comments, markdown headers, and whitespace to see if actual reference material exists
  const clean = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#+.*$/gm, '')
    .trim();

  // If clean length is less than 30 characters, it is only a placeholder
  if (clean.length < 30) {
    return { hasContent: false, content };
  }
  return { hasContent: true, content };
}

function formatDateISO(timestampSeconds: number): string {
  try {
    const d = new Date(timestampSeconds * 1000);
    return d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  } catch {
    return String(timestampSeconds);
  }
}

function isRelevantNvidiaNews(item: FinnhubArticle): boolean {
  if (!item.headline) return false;
  const text = `${item.headline} ${item.summary || ''}`.toLowerCase();
  
  // High confidence keywords related to NVIDIA and AI semiconductor ecosystem
  const keywords = [
    'nvidia',
    'nvda',
    'huang',
    'geforce',
    'blackwell',
    'hopper',
    'h100',
    'h200',
    'b200',
    'cuda',
    'tensor',
    'gpu',
    'semiconductor',
    'ai chip',
    'foundry',
    'tsmc',
    'data center',
    'ai server',
  ];

  return keywords.some((kw) => text.includes(kw));
}

async function fetchFinnhubNews(apiKey: string): Promise<FinnhubArticle[]> {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  const fromDate = twoDaysAgo.toISOString().split('T')[0];
  const toDate = now.toISOString().split('T')[0];

  const url = `https://finnhub.io/api/v1/company-news?symbol=NVDA&from=${fromDate}&to=${toDate}&token=${apiKey}`;

  logInfo(`Fetching NVIDIA news from Finnhub (from: ${fromDate} to: ${toDate})...`);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Finnhub API returned status ${response.status} (${response.statusText})`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('Finnhub response was not an array of articles');
  }

  return data as FinnhubArticle[];
}

async function analyzeArticle(
  ai: GoogleGenAI,
  modelName: string,
  article: FinnhubArticle,
  tradingFrameworkContent: string,
): Promise<string> {
  const prompt = `คุณคือนักวิเคราะห์ตลาดที่มีความเชี่ยวชาญด้านปัจจัยพื้นฐานและพฤติกรรมราคา
หน้าที่ของคุณคือวิเคราะห์ข่าวเกี่ยวกับ NVIDIA ("NVDA") / ปัญญาประดิษฐ์ (AI) โดยใช้ "เอกสารอ้างอิงและกรอบแนวคิดในการวิเคราะห์ตลาด" (Trading Framework) ที่ระบุไว้ด้านล่างนี้อย่างเคร่งครัด

--- เอกสารอ้างอิงและกรอบแนวคิดในการวิเคราะห์ตลาด (TRADING FRAMEWORK) ---
${tradingFrameworkContent}
-------------------------------------------------------------

--- ข้อมูลข่าวจริงที่นำมาวิเคราะห์ ---
หัวข้อข่าว (Headline): ${article.headline}
แหล่งข่าว (Source): ${article.source}
เวลาเผยแพร่ (Publication Time): ${formatDateISO(article.datetime)}
ลิงก์ข่าวต้นฉบับ (URL): ${article.url}
เนื้อหาข่าวเบื้องต้น (Summary): ${article.summary || 'ไม่มีเนื้อหาย่อ'}
-------------------------------------------------------------

ข้อกำหนดในการวิเคราะห์ (บังคับ):
1. เขียนเนื้อหาการวิเคราะห์เป็นภาษาไทยอย่างละเอียด ชัดเจน และเป็นกลาง
2. ใช้กรอบแนวคิดและทฤษฎีจากเอกสารอ้างอิงที่ให้ไว้ด้านบนเท่านั้น ห้ามแต่งหรืออุปโลกน์แนวคิดจากหนังสืออื่นที่ไม่ได้มีในเอกสารอ้างอิง
3. ครอบคลุมเฉพาะหัวข้อที่เกี่ยวข้องและมีข้อมูลสนับสนุนเพียงพอ:
   - กรอบแนวคิดเชิงวิเคราะห์ (Analytical framework): ระบุแนวคิดที่เจาะจงจากเอกสารอ้างอิง พร้อมระบุชื่อหนังสือ บท หน้า หรือหัวข้อ หากมีปรากฏในเอกสาร
   - เหตุผลเชิงสาเหตุ (Causal reasoning): อธิบายกลไกการส่งผ่านที่เหตุการณ์นี้จะส่งผลต่อ NVIDIA, อุตสาหกรรม AI, ห่วงโซ่เซมิคอนดักเตอร์, ความคาดหวัง หรือพฤติกรรมของตลาด
   - ผลกระทบต่อสภาวะตลาด (Market implications): อธิบายการตีความทั้งด้านบวกและด้านลบที่เป็นไปได้ พร้อมสมมติฐานและข้อโต้แย้ง
   - เงื่อนไขการสิ้นสุดผลและการระบุความไม่แน่นอน (Invalidation and uncertainty): ระบุหลักฐานหรือปัจจัยที่อาจทำให้การวิเคราะห์นี้อ่อนลงหรือไม่เป็นจริง แยกแยะข้อเท็จจริงที่ทราบแน่ชัดออกจากการตีความและการคาดการณ์
4. ข้อห้ามเด็ดขาด:
   - ห้ามเขียนส่วนสรุปข่าวแยกต่างหาก (Do not include a separate news-summary section)
   - ห้ามออกคำสั่งซื้อหรือขาย (Do not produce buy/sell signals)
   - ห้ามรับประกันหรือยืนยันแนวโน้มราคาในอนาคต (Do not guarantee future price movements)
   - หากข้อมูลในข่าวหรือเอกสารอ้างอิงไม่เพียงพอต่อการวิเคราะห์ในข้อใด ให้ระบุอย่างตรงไปตรงมาว่าข้อมูลไม่เพียงพอ ห้ามคิดคาดเดาเอาเอง
`;

  const response = await ai.models.generateContent({
    model: modelName,
    contents: prompt,
  });

  const text = response.text;
  if (!text || !text.trim()) {
    throw new Error('Gemini API returned empty analysis text');
  }

  return text.trim();
}

async function sendToDiscordWebhook(
  webhookUrl: string,
  article: FinnhubArticle,
  analysis: string,
): Promise<void> {
  // Truncate headline and description if they exceed Discord limits
  const safeHeadline = article.headline.length > 250 
    ? article.headline.substring(0, 247) + '...' 
    : article.headline;

  const safeAnalysis = analysis.length > 4000
    ? analysis.substring(0, 3990) + '\n\n...(เนื้อหาส่วนที่เหลือถูกตัดเนื่องจากความยาว)'
    : analysis;

  const publishedStr = formatDateISO(article.datetime);

  const payload = {
    embeds: [
      {
        title: safeHeadline,
        url: article.url,
        color: 0x76B900, // NVIDIA green
        description: safeAnalysis,
        fields: [
          {
            name: 'แหล่งข่าว (Source)',
            value: article.source || 'Unknown',
            inline: true,
          },
          {
            name: 'เวลาเผยแพร่ (Published)',
            value: publishedStr,
            inline: true,
          },
        ],
        footer: {
          text: 'NVIDIA / AI Market Analysis',
        },
        timestamp: new Date(article.datetime * 1000).toISOString(),
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Discord Webhook failed with status ${response.status}: ${errorBody}`);
  }
}

async function main(): Promise<void> {
  const finnhubKey = process.env.FINNHUB_API_KEY?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  const geminiModel = (process.env.GEMINI_MODEL?.trim()) || 'gemini-3.5-flash-lite';

  if (!finnhubKey) {
    logError('FINNHUB_API_KEY environment variable is missing.');
    process.exit(1);
  }
  if (!geminiKey) {
    logError('GEMINI_API_KEY environment variable is missing.');
    process.exit(1);
  }
  if (!discordWebhookUrl) {
    logError('DISCORD_WEBHOOK_URL environment variable is missing.');
    process.exit(1);
  }

  // Check trading framework reference material
  const framework = readTradingFramework();
  if (!framework.hasContent) {
    logInfo('------------------------------------------------------------');
    logInfo('NOTICE: Reference material in TRADING_FRAMEWORK.md is missing or contains only the placeholder.');
    logInfo('Per project instructions, skipping news analysis and Discord publishing until actual trading reference material is supplied in TRADING_FRAMEWORK.md.');
    logInfo('This prevents generating unverified opinions or fabricating book frameworks.');
    logInfo('------------------------------------------------------------');
    process.exit(0);
  }

  logInfo('Trading framework reference material loaded successfully.');

  // Initialize Gemini client with standard user agent header
  const ai = new GoogleGenAI({
    apiKey: geminiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  // Load processed IDs
  const processedIds = loadProcessedIds();
  logInfo(`Loaded ${processedIds.size} previously processed article ID(s).`);

  // Fetch NVDA company news from Finnhub
  let articles: FinnhubArticle[];
  try {
    articles = await fetchFinnhubNews(finnhubKey);
  } catch (err) {
    logError(`Failed to fetch Finnhub news: ${(err as Error).message}`);
    process.exit(1);
  }

  logInfo(`Fetched ${articles.length} article(s) from Finnhub.`);

  // Filter unprocessed and relevant articles
  const newArticles = articles
    .filter((item) => typeof item.id === 'number' && !processedIds.has(item.id))
    .filter(isRelevantNvidiaNews)
    // Sort ascending by datetime so oldest new article is analyzed and posted first
    .sort((a, b) => a.datetime - b.datetime);

  if (newArticles.length === 0) {
    logInfo('No new relevant NVIDIA articles to process at this time. Exiting.');
    process.exit(0);
  }

  logInfo(`Found ${newArticles.length} new relevant article(s) to analyze.`);

  // Process in batches (limit to max 5 per 10-minute run to respect rate limits)
  const batchToProcess = newArticles.slice(0, 5);
  let processedCount = 0;

  for (const article of batchToProcess) {
    logInfo(`Processing article [${article.id}]: "${article.headline}" (${article.source})`);

    try {
      // 1. Analyze with Gemini using supplied trading framework
      const analysis = await analyzeArticle(ai, geminiModel, article, framework.content);
      logInfo(`Analysis generated successfully for article [${article.id}].`);

      // 2. Dispatch to Discord Webhook
      await sendToDiscordWebhook(discordWebhookUrl, article, analysis);
      logInfo(`Delivered article [${article.id}] to Discord successfully.`);

      // 3. Mark as processed only after successful Discord delivery
      processedIds.add(article.id);
      saveProcessedIds(processedIds);
      processedCount++;

      // Small pause between webhooks
      await sleep(1500);
    } catch (err) {
      logError(`Failed processing article [${article.id}]: ${(err as Error).message}`);
      // Do not mark article as processed on failure so it can be retried on next run
    }
  }

  logInfo(`Run completed. Successfully processed and delivered ${processedCount} article(s).`);
}

main().catch((err) => {
  logError(`Unhandled exception in main: ${(err as Error).message}`);
  process.exit(1);
});
