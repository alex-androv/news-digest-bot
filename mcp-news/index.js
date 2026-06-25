import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as cheerio from "cheerio";

const server = new Server(
  { name: "mcp-news", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Парсит строку периода в дату отсечения.
// Поддерживает: "24h", "7d", "2w", "1m", "30d"
function parsePeriod(period = "7d") {
  const p = (period || "7d").trim().toLowerCase();
  const match = p.match(/^(\d+)(h|d|w|m)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    const seconds = { h: 3600, d: 86400, w: 604800, m: 2592000 }[match[2]];
    return new Date(Date.now() - n * seconds * 1000);
  }
  // Диапазон дат: "2024-01-01..2024-01-31"
  const rangeMatch = p.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (rangeMatch) return new Date(rangeMatch[1]);
  // По умолчанию — 7 дней
  return new Date(Date.now() - 7 * 86400 * 1000);
}

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
};

// Маппинг запросов к именам хабов Хабра — возвращает статьи строго по теме
const HABR_HUB_MAP = {
  "python": "python",
  "питон": "python",
  "javascript": "javascript",
  "js": "javascript",
  "typescript": "typescript",
  "ts": "typescript",
  "rust": "rust",
  "go": "go",
  "golang": "go",
  "java": "java",
  "kotlin": "kotlin",
  "swift": "swift",
  "php": "php",
  "ruby": "ruby",
  "docker": "docker",
  "kubernetes": "kubernetes",
  "k8s": "kubernetes",
  "linux": "linux",
  "git": "git",
  "devops": "devops",
  "ai": "artificial_intelligence",
  "ml": "machine_learning",
  "llm": "machine_learning",
  "нейросети": "machine_learning",
  "нейросеть": "machine_learning",
  "machine learning": "machine_learning",
  "deep learning": "machine_learning",
  "искусственный интеллект": "artificial_intelligence",
  "информационная безопасность": "information_security",
  "кибербезопасность": "information_security",
  "безопасность": "information_security",
  "react": "reactjs",
  "vue": "vuejs",
  "angular": "angular",
  "node.js": "nodejs",
  "nodejs": "nodejs",
};

function getHubName(query) {
  return HABR_HUB_MAP[query.trim().toLowerCase()] || null;
}

// Ищет статьи на Хабре: для известных хабов — через RSS хаба (только релевантные статьи),
// для остальных — через RSS поиска
async function searchHabr(query, period = "7d", limit = 10) {
  const since = parsePeriod(period);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 20);

  const hubName = getHubName(query);
  const rssUrl = hubName
    ? `https://habr.com/ru/rss/hubs/${hubName}/articles/`
    : `https://habr.com/ru/rss/search/?q=${encodeURIComponent(query)}&order_by=date&target_type=posts&hl=ru`;

  let xml;
  try {
    const res = await axios.get(rssUrl, {
      headers: REQUEST_HEADERS,
      timeout: 12000,
    });
    xml = res.data;
  } catch (err) {
    throw new Error(`Habr RSS search failed: ${err.message}`);
  }

  const $ = cheerio.load(xml, { xmlMode: true });
  const results = [];

  $("item").each((_, el) => {
    if (results.length >= safeLimit) return false;
    const $el = $(el);

    const title = $el.find("title").text().trim();
    // guid с isPermaLink="true" содержит чистый URL без UTM
    const guid = $el.find("guid").text().trim();
    const url = guid.split("?")[0];
    const pubDateStr = $el.find("pubDate").text().trim();
    const publishedAt = pubDateStr ? new Date(pubDateStr) : null;

    // Описание в RSS — HTML, вырезаем теги
    const rawDesc = $el.find("description").text().trim();
    const snippet = rawDesc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().substring(0, 300);

    if (!title || !url) return;

    if (!publishedAt || publishedAt >= since) {
      results.push({
        title,
        url,
        published_at: publishedAt ? publishedAt.toISOString() : "",
        source: "habr.com",
        snippet,
      });
    }
  });

  return results;
}

// Загружает полный текст статьи с Хабра по URL
async function fetchArticle(url) {
  if (!url.includes("habr.com")) {
    throw new Error("Поддерживаются только URL с habr.com");
  }

  let html;
  try {
    const res = await axios.get(url, {
      headers: REQUEST_HEADERS,
      timeout: 15000,
    });
    html = res.data;
  } catch (err) {
    if (err.response?.status === 404) throw new Error("Статья не найдена (404)");
    throw new Error(`Ошибка загрузки статьи: ${err.message}`);
  }

  const $ = cheerio.load(html);

  const title =
    $("h1.tm-title, h1").first().text().trim() || "Без заголовка";
  const author =
    $(".tm-user-info__username, .user-info__username").first().text().trim() ||
    "";
  const dateStr =
    $("meta[property='article:published_time']").attr("content") ||
    $("time[itemprop='datePublished']").attr("datetime") ||
    $("time").first().attr("datetime") ||
    "";

  const bodyEl = $(
    ".article-formatted-body, .tm-article-body, [data-article-content]"
  );
  bodyEl.find("script, style, .banner, .ads, nav, footer").remove();

  // Собираем текст из абзацев для более чистого результата
  const paragraphs = [];
  bodyEl.find("p, h2, h3, li").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 10) paragraphs.push(text);
  });

  const text =
    paragraphs.length > 0
      ? paragraphs.join("\n\n")
      : bodyEl.text().replace(/\s+/g, " ").trim();

  return {
    title,
    text: text.substring(0, 12000), // Ограничиваем размер для LLM
    author,
    published_at: dateStr,
  };
}

// Регистрируем инструменты (MCP tool list)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_habr",
      description:
        "Ищет статьи на Хабре (habr.com) по ключевому запросу за указанный период. " +
        "Возвращает список статей: заголовок, URL, дата публикации, источник, краткое описание. " +
        "Вызывай первым, чтобы найти релевантные материалы по теме дайджеста.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Поисковый запрос — тема или ключевые слова " +
              "(например: 'искусственный интеллект', 'Rust async', 'LLM 2024')",
          },
          period: {
            type: "string",
            description:
              "Период: '24h' (сутки), '7d' (неделя), '14d' (2 недели), '1m' (месяц), '30d' (30 дней). " +
              "По умолчанию '7d'. Фильтрация по дате выполняется на стороне MCP.",
            default: "7d",
          },
          limit: {
            type: "number",
            description: "Количество статей (1–20). По умолчанию 10.",
            default: 10,
          },
        },
        required: ["query"],
      },
    },
    {
      name: "fetch_article",
      description:
        "Загружает полный текст статьи с Хабра по URL. " +
        "Возвращает: заголовок, текст (до 12000 символов), автор, дата публикации. " +
        "Вызывай после search_habr для каждой статьи, чтобы прочитать содержание и написать аннотацию.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "URL статьи на Хабре, например: https://habr.com/ru/articles/123456/",
          },
        },
        required: ["url"],
      },
    },
  ],
}));

// Обработчик вызовов инструментов
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "search_habr") {
      const { query, period = "7d", limit = 10 } = args;
      if (!query || typeof query !== "string") {
        throw new Error("Параметр query обязателен");
      }
      const articles = await searchHabr(query, period, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(articles, null, 2) }],
      };
    }

    if (name === "fetch_article") {
      const { url } = args;
      if (!url || typeof url !== "string") {
        throw new Error("Параметр url обязателен");
      }
      const article = await fetchArticle(url);
      return {
        content: [{ type: "text", text: JSON.stringify(article, null, 2) }],
      };
    }

    throw new Error(`Неизвестный инструмент: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

// Выбор транспорта: stdio (по умолчанию) или HTTP/SSE (для Docker)
const HTTP_PORT = process.env.HTTP_PORT;

if (HTTP_PORT) {
  // HTTP/SSE режим — когда сервер запущен в отдельном Docker-контейнере
  let SSEServerTransport;
  try {
    ({ SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js"));
  } catch (err) {
    process.stderr.write(`FATAL: cannot load SSEServerTransport: ${err.message}\n`);
    process.exit(1);
  }

  const { createServer } = await import("http");
  const transports = new Map();

  const httpServer = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      return res.end();
    }

    // Health check для Docker — отвечает первым, до любой MCP-логики
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", server: "mcp-news" }));
    }

    // SSE endpoint — Hermes подключается сюда
    if (req.method === "GET" && req.url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => transports.delete(transport.sessionId);
      server.connect(transport).catch((err) => {
        process.stderr.write(`SSE connect error: ${err.message}\n`);
      });
      return;
    }

    // Messages endpoint — Hermes отправляет запросы сюда
    if (req.method === "POST" && req.url?.startsWith("/messages")) {
      const sessionId = new URL(req.url, "http://x").searchParams.get("sessionId");
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404);
        return res.end("Session not found");
      }
      transport.handlePostMessage(req, res).catch((err) => {
        process.stderr.write(`handlePostMessage error: ${err.message}\n`);
        if (!res.headersSent) { res.writeHead(500); res.end(err.message); }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.on("error", (err) => {
    process.stderr.write(`HTTP server error: ${err.message}\n`);
    process.exit(1);
  });

  httpServer.listen(Number(HTTP_PORT), "0.0.0.0", () => {
    process.stderr.write(
      `mcp-news HTTP/SSE server on http://0.0.0.0:${HTTP_PORT}/sse\n`
    );
  });
} else {
  // Stdio режим — для локального запуска без Docker
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
