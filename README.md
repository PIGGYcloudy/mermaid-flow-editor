# Mermaid Flow Editor

**English** · [繁體中文](README.zh-TW.md)

A self-hosted Mermaid workspace with live preview, export tools, and a BYOK AI
assistant for OpenAI-compatible APIs.

[![License: MIT](https://img.shields.io/badge/License-MIT-2f6f68.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-43853d.svg)](package.json)
[![CI](https://github.com/PIGGYcloudy/mermaid-flow-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/PIGGYcloudy/mermaid-flow-editor/actions/workflows/ci.yml)

> This project was built and open-sourced with help from
> [OpenAI Codex](https://openai.com/codex/). It is an independent community
> project, not an official OpenAI product.

> **BYOK only:** the project has no account system and stores no server-side AI
> credentials. A user-provided API key stays in browser `sessionStorage` and is
> sent through the application proxy only for that user's AI requests.

## Features

- Monaco Mermaid editor with live rendering and readable syntax errors
- Generate, rewrite, and repair Mermaid with any OpenAI-compatible API
- Load models from the provider's `/models` endpoint and test connections
- Movable and scalable Editor, Preview, and AI Assistant windows
- Independent workspace and diagram pan and zoom controls
- Import `.mmd`, `.mermaid`, and `.txt`
- Export Mermaid, SVG, PNG, and PDF
- Mermaid strict security mode
- Docker image and `/healthz` endpoint

Editing, previewing, and exporting work without configuring AI.

## Deploy with Docker

Docker is the supported production deployment path. The same Compose workflow
works with Docker Engine on Linux and Docker Desktop on Windows. On Windows,
use Docker Desktop in Linux containers mode.

Linux:

```bash
cp .env.example .env
docker compose up -d --build
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

Open `http://localhost:3000`. Confirm the deployment and inspect logs with:

```bash
docker compose ps
docker compose logs -f app
```

Stop and remove the application container with:

```bash
docker compose down
```

Tagged releases and the manual publish workflow also provide a prebuilt image:

```text
ghcr.io/piggycloudy/mermaid-flow-editor-byok
```

The container includes a `/healthz` endpoint and uses the Compose health check
and `unless-stopped` restart policy. Native Node.js deployment as a background
service is not currently documented or supported; use Docker for production.

## Local development

Local development requires Node.js 22.12 or newer. This two-process workflow is
for development, not production deployment.

Linux or macOS:

```bash
npm ci
cp .env.example .env
npm run server
```

Windows PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
npm run server
```

In a second terminal, run:

```bash
npm run dev
```

Open `http://localhost:5173`. CI validates installation, server tests, and the
production build on both Linux and Windows. To use AI, enter:

- **API URL:** an OpenAI-compatible base URL, such as
  `https://api.openai.com/v1`
- **API Key:** your provider token
- **Model:** select a discovered model or enter its model ID

The API URL and model are saved in localStorage. The API key is kept only in
`sessionStorage` and is cleared when the tab closes. The application never
writes it to a database or disk.

## Internet-facing deployments

This project does not include authentication or access control. Add it at your
reverse proxy, VPN, or hosting platform when needed, and use HTTPS.

The proxy accepts any HTTP(S) API host by default for convenient local and
private use. For an internet-facing deployment, strongly consider an allowlist
to reduce SSRF risk:

```dotenv
AI_API_ALLOWED_HOSTS=api.openai.com,openrouter.ai
```

When configured, only listed `host[:port]` values are accepted and upstream
redirects are not followed. This is an operator control, not a requirement for
ordinary local use. See [SECURITY.md](SECURITY.md) for more guidance.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `APP_API_PORT` / `PORT` | Development / production server port | `3001` / `3000` |
| `AI_API_ALLOWED_HOSTS` | Optional `host[:port]` proxy allowlist | unrestricted |
| `MODELS_TIMEOUT_MS` | Model-list timeout | `15000` |
| `CHAT_TIMEOUT_MS` | AI chat timeout | `120000` |
| `JSON_BODY_LIMIT` | JSON request body limit | `256kb` |

## Validation

```bash
npm test
npm run build
npm run test:browser
```

## Architecture

The Vite/React client edits and renders Mermaid diagrams. A small Express proxy
validates BYOK requests, normalizes OpenAI-compatible URLs, forwards `/models`
and `/chat/completions`, and applies the optional host allowlist. The server has
no user database and no built-in or shared AI credential.

## Contributing

Issues and focused pull requests are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first. Report suspected vulnerabilities
privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Mermaid Flow Editor is independent and is not affiliated with
Mermaid Chart, OpenAI, or any AI provider.
