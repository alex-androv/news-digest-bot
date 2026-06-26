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
  Accept: "application/json, text/html, */*",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
};

// Маппинг популярных запросов к именам хабов Хабра
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

// Выбирает период для Habr API на основе даты отсечения.
// API поддерживает: daily, weekly, monthly, yearly, alltime.
// Мы используем monthly (до 30 дней) или yearly (до года), чтобы
// перекрыть всю историю за запрошенный период с запасом.
function apiPeriod(since) {
  const diffDays = (Date.now() - since.getTime()) / 86400000;
  if (diffDays <= 31) return "monthly";
  return "yearly";
}

// Ищет статьи через неофициальный Habr API (/kek/v2/articles/).
// Преимущество над RSS: поддерживает пагинацию — можно получить статьи
// за любой период, не ограничиваясь последними 40 записями RSS.
async function searchHabrAPI(hubName, since, safeLimit) {
  const results = [];
  let page = 1;
  const perPage = 20;
  const period = apiPeriod(since);
  const MAX_PAGES = 10;

  while (results.length < safeLimit && page <= MAX_PAGES) {
    let res;
    try {
      res = await axios.get("https://habr.com/kek/v2/articles/", {
        params: { hub: hubName, sort: "date", page, perPage, hl: "ru", fl: "ru", period },
        headers: REQUEST_HEADERS,
        timeout: 12000,
      });
    } catch (err) {
      throw new Error(`Habr API error (page ${page}): ${err.message}`);
    }

    const ids = Object.values(res.data.publicationIds || {});
    const refs = res.data.publicationRefs || {};
    const pagesCount = res.data.pagesCount || 1;

    if (ids.length === 0) break;

    for (const id of ids) {
      if (results.length >= safeLimit) break;
      const a = refs[id];
      if (!a) continue;

      const publishedAt = a.timePublished ? new Date(a.timePublished) : null;
      if (publishedAt && publishedAt < since) continue;

      const title = (a.titleHtml || "").replace(/<[^>]*>/g, "").trim();
      if (!title) continue;

      const url = `https://habr.com/ru/articles/${id}/`;
      const snippet = (a.leadData?.textHtml || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 300);

      results.push({
        title,
        url,
        published_at: publishedAt ? publishedAt.toISOString() : "",
        source: "habr.com",
        snippet,
      });
    }

    if (page >= pagesCount) break;
    page++;
  }

  return results;
}

// Запасной поиск через RSS — используется для произвольных запросов
// (не совпадающих с именем хаба).
async function searchHabrRSS(query, since, safeLimit) {
  const rssUrl =
    `https://habr.com/ru/rss/search/?` +
    `q=${encodeURIComponent(query)}&order_by=date&target_type=posts&hl=ru`;

  let xml;
  try {
    const res = await axios.get(rssUrl, {
      headers: {
        ...REQUEST_HEADERS,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      },
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
    const guid = $el.find("guid").text().trim();
    const url = guid.split("?")[0];
    const pubDateStr = $el.find("pubDate").text().trim();
    const publishedAt = pubDateStr ? new Date(pubDateStr) : null;

    const rawDesc = $el.find("description").text().trim();
    const snippet = rawDesc
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 300);

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

// Основная функция поиска: для известных хабов использует API (пагинация,
// глубокая история), для произвольных запросов — RSS поиск.
async function searchHabr(query, period = "7d", limit = 10) {
  const since = parsePeriod(period);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 20);

  const hubName = getHubName(query);
  if (hubName) {
    return searchHabrAPI(hubName, since, safeLimit);
  }
  return searchHabrRSS(query, since, safeLimit);
}

// Загружает полный текст статьи с Хабра по URL
async function fetchArticle(url) {
  if (!url.includes("habr.com")) {
    throw new Error("Поддерживаются только URL с habr.com");
  }

  let html;
  try {
    const res = await axios.get(url, {
      headers: {
        ...REQUEST_HEADERS,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      },
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
    $(".tm-user-info__username, .user-info__username").first().text().trim() || "";
  const dateStr =
    $("meta[property='article:published_time']").attr("content") ||
    $("time[itemprop='datePublished']").attr("datetime") ||
    $("time").first().attr("datetime") ||
    "";

  const bodyEl = $(
    ".article-formatted-body, .tm-article-body, [data-article-content]"
  );
  bodyEl.find("script, style, .banner, .ads, nav, footer").remove();

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
    text: text.substring(0, 12000),
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
        "Для известных тем (python, javascript, rust, docker и др.) использует хаб Хабра через официальный API — " +
        "поддерживает пагинацию и возвращает статьи за любой период, не ограничиваясь RSS-окном. " +
        "Для произвольных запросов использует RSS-поиск. " +
        "Возвращает список статей: заголовок, URL, дата публикации, источник, краткое описание. " +
        "Вызывай первым, чтобы найти релевантные материалы по теме дайджеста.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Поисковый запрос — тема или ключевые слова " +
              "(например: 'python', 'Rust async', 'искусственный интеллект')",
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

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", server: "mcp-news" }));
    }

    if (req.method === "GET" && req.url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => transports.delete(transport.sessionId);
      server.connect(transport).catch((err) => {
        process.stderr.write(`SSE connect error: ${err.message}\n`);
      });
      return;
    }

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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
