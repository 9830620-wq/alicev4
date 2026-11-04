// api/index.js

const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SERPER_URL = "https://google.serper.dev/search";
const MAX_HISTORY = 6;
const MAX_TEXT_LENGTH = 1024;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Проверка доступности вебхука из консоли Яндекс Диалогов
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-openrouter-serper",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const request = body.request || {};
  const previous = safeHistory(body.state?.session?.history);
  const userText = String(
    request.command || request.original_utterance || ""
  ).trim();

  // Запуск навыка (пустая команда)
  if (!userText) {
    const greeting = "Привет! Чем я могу помочь?";
    return res.status(200).json(aliceResponse(greeting, false, previous));
  }

  // Прощание → закрываем сессию
  const endSession = /(пока|до свидания|хватит|выход|закончим)/i.test(userText);

  // Serper — только когда нужно и когда есть ключ
  let searchSnippet = null;
  if (isSearchIntent(userText) && process.env.SERPER_API_KEY) {
    try {
      searchSnippet = await serperSearch(userText);
    } catch (e) {
      console.error("Serper error:", e.message);
    }
  }

  const history = [...previous, { role: "user", text: userText.slice(0, 500) }];
  const prompt = buildPrompt(history, searchSnippet);

  let answer;
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is not set in Vercel env variables");
    }
    answer = await callOpenRouter(prompt);
  } catch (e) {
    console.error("OpenRouter error:", e.message);
    answer = "Извините, я не смогла обработать запрос. Попробуйте переформулировать.";
  }

  const safeAnswer = fitAliceText(answer);
  const updatedHistory = safeHistory([
    ...history,
    { role: "model", text: safeAnswer },
  ]);

  return res
    .status(200)
    .json(aliceResponse(safeAnswer, endSession, updatedHistory));
}

// ---------- Экспортируемые помощники (для тестов и переиспользования) ----------

export function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text,
      tts: text,
      end_session: Boolean(endSession),
    },
    session_state: {
      history: Array.isArray(history) ? history : [],
    },
  };
}

export function fitAliceText(text) {
  const source = String(text || "").trim();
  if (source.length <= MAX_TEXT_LENGTH) return source;

  const cut = source.slice(0, MAX_TEXT_LENGTH);
  const lastBoundary = Math.max(
    cut.lastIndexOf("."),
    cut.lastIndexOf("!"),
    cut.lastIndexOf("?")
  );

  if (lastBoundary > MAX_TEXT_LENGTH * 0.5) {
    return cut.slice(0, lastBoundary + 1).trim();
  }

  return cut.trim();
}

export function isSearchIntent(text) {
  const value = String(text || "");
  return /(найди|поищи|погода|курс|новости|что нового|сколько стоит|где купить|последние|сейчас|сегодня|latest|news|weather|price|today|current)/i.test(
    value
  );
}

export function safeHistory(input) {
  if (!Array.isArray(input)) return [];

  return input
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "model") &&
        typeof item.text === "string" &&
        item.text.trim()
    )
    .slice(-MAX_HISTORY)
    .map((item) => ({
      role: item.role,
      text: item.text.slice(0, 500),
    }));
}

// ---------- Внутренние функции ----------
console.log(
  "OPENROUTER_API_KEY diagnostic:",
  process.env.OPENROUTER_API_KEY
    ? `set (starts with "${process.env.OPENROUTER_API_KEY.slice(0, 8)}...", length=${process.env.OPENROUTER_API_KEY.length})`
    : "NOT SET"
);
async function serperSearch(query) {
  const res = await fetch(SERPER_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: 3 }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Serper ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  return (
    data.answerBox?.answer ||
    data.answerBox?.snippet ||
    data.knowledgeGraph?.description ||
    data.organic?.[0]?.snippet ||
    null
  );
}

async function callOpenRouter(prompt) {
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const siteUrl =
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://alice-skill.vercel.app";

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": siteUrl,
      "X-Title": "Alice Skill",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "Ты — голосовой ассистент Алиса. Отвечай кратко (1–2 предложения), дружелюбно и по-русски.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 150,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  return text ? text.trim() : "Не удалось получить ответ.";
}

function buildPrompt(history, searchSnippet) {
  const dialog = history
    .map((m) => `${m.role === "user" ? "Пользователь" : "Ассистент"}: ${m.text}`)
    .join("\n");

  let prompt = `История диалога:\n${dialog}\n\n`;
  if (searchSnippet) {
    prompt += `Актуальная информация из поиска:\n${searchSnippet}\n\n`;
  }
  prompt += "Ответь пользователю:";
  return prompt;
}
