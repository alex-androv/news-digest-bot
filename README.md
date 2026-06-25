# News Digest Bot

Telegram-бот на базе [Hermes Agent](https://github.com/NousResearch/hermes-agent), который собирает дайджест новостей с Хабра по запросу пользователя.

Тестовое задание Junior AI Developer.

## Что умеет

Пользователь пишет в Telegram:
> «собери дайджест по теме Python за последнюю неделю»

Бот:
1. Ищет статьи на Хабре через `search_habr` (RSS-лента хаба или поиск)
2. Загружает полный текст каждой через `fetch_article`
3. Аннотирует каждую статью (TL;DR 2–4 предложения)
4. Собирает связную обзорную статью с вводкой и выводом
5. Отвечает в тот же чат

**Level 2:** аннотации + цельная обзорная статья (не просто список ссылок)

## Стек

| Компонент | Роль |
|---|---|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Агентный фреймворк, Telegram из коробки |
| MCP-сервер `mcp-news` (Node.js) | Инструменты: `search_habr`, `fetch_article` |
| Skill `news-digest` | Инструкция агенту: как составить дайджест |
| OpenRouter (`openai/gpt-oss-120b:free`) | Бесплатная LLM |
| Docker Compose | Запуск всего одной командой |

## Быстрый старт

> **Требования:** Docker Desktop запущен (проверь иконку в трее)

### 1. Получи токены

- **Telegram:** [@BotFather](https://t.me/BotFather) → `/newbot` → скопируй токен
- **OpenRouter:** [openrouter.ai/keys](https://openrouter.ai/keys) → создай ключ (бесплатно)

### 2. Клонируй Hermes Agent

> **Важно для Windows:** флаг `--config core.autocrlf=false` обязателен. Без него s6-overlay в Docker упадёт из-за CRLF-окончаний.

```bash
git clone --config core.autocrlf=false https://github.com/NousResearch/hermes-agent.git hermes-agent
```

### 3. Настрой `.env`

```bash
cp .env.example .env
```

Открой `.env` и вставь токены:

```
TELEGRAM_TOKEN=123456789:ABC-ваш-токен
OPENROUTER_API_KEY=sk-or-ваш-ключ
```

### 4. Запусти

```bash
docker compose up --build
```

При первом запуске Docker соберёт образы (~5–10 минут, Hermes собирается из исходников).  
При последующих запусках — `docker compose up` (без `--build`).

### 5. Напиши боту в Telegram

Найди своего бота и напиши:

```
собери дайджест по теме «Python» за неделю
```

> **Время ответа:** бесплатные модели на OpenRouter отвечают медленно (~10–15 минут на полный дайджест из 5 статей). Это ограничение бесплатного тира OpenRouter, а не архитектуры.

## Структура проекта

```
news_digest_bot/
├── hermes-agent/          # git clone NousResearch/hermes-agent (шаг 2)
├── mcp-news/
│   ├── index.js           # MCP-сервер: search_habr + fetch_article
│   ├── package.json
│   └── Dockerfile
├── skills/
│   └── news-digest/
│       └── SKILL.md       # Инструкция агенту как писать дайджест
├── hermes-config/
│   └── config.yaml        # LLM, Telegram, MCP, Skills
├── docker-compose.yml
├── .env.example
└── README.md
```

## Архитектура

```
Telegram (запрос) ──► Hermes Agent ──► skill: news-digest
                           │
                           ├──► MCP: mcp-news (http://mcp-news:3000/sse)
                           │       ├── search_habr(query, period, limit)
                           │       └── fetch_article(url)
                           │
                           └──► Telegram (дайджест-статья)

Docker: hermes-agent + mcp-news в общей сети agent-net
        Volume hermes-data: память агента, история сессий
```

### Разделение ответственности

- **MCP** = «руки»: знает как достать данные с Хабра (RSS хаба / поиск + fetch)
- **Skill** = «привычка»: знает как из данных собрать статью (структура, тон, дедупликация)
- **Hermes** = «голова»: оркестрирует вызовы инструментов, отвечает в Telegram

## Примеры запросов

```
собери дайджест по AI за неделю
что нового по Rust за месяц?
обзор новостей про Docker за 3 дня
дайджест по теме безопасность за 14 дней
```

## Используемая модель

`openai/gpt-oss-120b:free` через [OpenRouter](https://openrouter.ai) — бесплатная.

Модель можно сменить в `hermes-config/config.yaml`:

```yaml
model:
  provider: openrouter
  default: openai/gpt-oss-120b:free
  context_length: 131072
```

> **Требования к модели:** поддержка tool use, контекст ≥ 64K токенов.

## Пример дайджеста

Реальный вывод бота на запрос «собери дайджест по теме Python за неделю»:

---

**Дайджест: Python — неделя 7 дней**

За последнюю неделю Хабр опубликовал несколько статей, где Python фигурирует в центре внимания — от рынка труда и образовательных программ до реальных проектов и библиотек.

---

**Python‑разработчик Нетология 2026: цена, программа и отзывы выпускников**  
Зарплаты Python‑разработчиков в начале 2026 года выросли ≈ 40% (медиана ≈ 200 тыс. ₽, сеньоры > 450 тыс. ₽). Нетология предлагает пять программ — от "Python с нуля" до расширенного курса с AI‑модулями.  
[Ссылка](https://habr.com/ru/articles/1051124/)

**Crashprobe: как я заделал критическую уязвимость в версии 0.4.1**  
Библиотека crashprobe собирает детали ошибок в Python‑проектах. В версии 0.4.0 отсутствовало экранирование заголовка ошибки, что позволяло выполнить XSS. Автор исправил проблему, добавив `html.escape()`.  
[Ссылка](https://habr.com/ru/articles/1050268/)

**graphlens: превращаем репозиторий в типизированный граф**  
graphlens парсит код через Tree‑sitter, строит тип‑aware граф и экспортирует в Neo4j/JSON. Поддерживает Python, TypeScript, Go, Rust в одной модели.  
[Ссылка](https://habr.com/ru/articles/1050204/)

---

**Вывод:** рынок Python‑разработки растёт, инструменты анализа кода становятся сложнее, тема безопасности остаётся актуальной.

---

## Остановка

```bash
docker compose down          # остановить, сохранить данные агента
docker compose down -v       # остановить и удалить volume (сброс памяти)
```
