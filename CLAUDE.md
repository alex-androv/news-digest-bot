# Проект: News Digest Agent

## Задача
Telegram-бот на базе Hermes Agent, который собирает дайджест новостей по запросу.
Тестовое задание Junior AI Developer.

## Целевой уровень реализации
Level 2 (основной) + Level 3 (бонус, в конце).
Level 1 не делаем — сразу Level 2.

## Стек
- Hermes Agent (Python) — агент, работает с Telegram из коробки
- MCP-сервер (Node.js) — инструменты search_habr и fetch_article
- Skill news-digest — инструкция для агента как писать дайджест
- Docker Compose — два контейнера: hermes-agent + mcp-news

## Структура проекта
news-digest-agent/
├── mcp-news/          # Node.js MCP-сервер
├── skills/            # Skill для Hermes
├── hermes-config/     # Конфиг Hermes (config.yaml)
├── docker-compose.yml
├── .env.example
└── README.md

## Статус
[ ] Шаг 1 — Токены (Telegram + OpenRouter) — делает разработчик вручную
[ ] Шаг 2 — MCP-сервер (mcp-news)
[ ] Шаг 3 — Skill news-digest
[ ] Шаг 4 — Docker Compose
[ ] Шаг 5 — Конфиг Hermes
[ ] Шаг 6 — Тест

## Важные решения
- LLM: бесплатная модель через OpenRouter
- Источник новостей: Хабр (search + fetch)
- OS разработчика: Windows, Docker Desktop установлен

## Ключи (в .env, не в коде)
- TELEGRAM_TOKEN=
- OPENROUTER_API_KEY=

---

## ПОЛНОЕ ТЕХНИЧЕСКОЕ ЗАДАНИЕ

прочитай файл и TASK.md в корне проекта.