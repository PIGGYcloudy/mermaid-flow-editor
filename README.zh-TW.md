# Mermaid Flow Editor

[English](README.md) · **繁體中文**

一個可自行部署的 Mermaid 工作區，提供即時預覽、匯出工具，以及相容
OpenAI API 格式的 BYOK AI 助手。

[![License: MIT](https://img.shields.io/badge/License-MIT-2f6f68.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-43853d.svg)](package.json)
[![CI](https://github.com/PIGGYcloudy/mermaid-flow-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/PIGGYcloudy/mermaid-flow-editor/actions/workflows/ci.yml)

> 本專案由 [OpenAI Codex](https://openai.com/codex/) 協作製作並完成開源。
> 這是獨立的社群專案，並非 OpenAI 官方產品。

> **純 BYOK：**專案沒有帳號系統，也不保存伺服器端 AI 金鑰。使用者輸入的
> API Key 只存在瀏覽器 `sessionStorage`，並僅在該使用者發出 AI 請求時經由
> 應用程式 proxy 送往所選的 API endpoint。

## 主要功能

- Monaco Mermaid 編輯器、即時渲染及可理解的語法錯誤
- 使用 OpenAI-compatible API 生成、改寫與修正 Mermaid
- 從供應商的 `/models` 取得模型清單並測試連線
- 可移動、縮放 Editor、Preview 與 AI Assistant 視窗
- 工作區與圖表各自具備獨立的縮放和平移控制
- 匯入 `.mmd`、`.mermaid`、`.txt`
- 匯出 Mermaid、SVG、PNG 及 PDF
- Mermaid strict security mode
- Docker image 與 `/healthz` 健康檢查端點

不使用 AI 時，編輯、預覽與匯出功能仍可正常使用。

## 使用 Docker 部署

Docker 是本專案支援的正式環境部署方式。Linux 使用 Docker Engine，Windows
使用 Docker Desktop；Windows 請切換到 Linux containers 模式。兩個平台使用
相同的 Compose 設定。

Linux：

```bash
cp .env.example .env
docker compose up -d --build
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
docker compose up -d --build
```

部署完成後開啟 `http://localhost:3000`。使用下列指令確認狀態與查看 log：

```bash
docker compose ps
docker compose logs -f app
```

停止並移除應用程式容器：

```bash
docker compose down
```

帶有版本 tag 的 Release 與手動發布 workflow 也會提供預先建置的 image：

```text
ghcr.io/piggycloudy/mermaid-flow-editor-byok
```

容器提供 `/healthz` 端點，Compose 已設定健康檢查與 `unless-stopped` 自動重啟
策略。目前不提供原生 Node.js 背景服務的正式部署文件；production 環境請使用
Docker。

## 本機開發

本機開發需要 Node.js 22.12 或更新版本。以下會啟動前後端兩個 process，僅供
開發使用，不是 production 部署方式。

Linux 或 macOS：

```bash
npm ci
cp .env.example .env
npm run server
```

Windows PowerShell：

```powershell
npm ci
Copy-Item .env.example .env
npm run server
```

在第二個終端機執行：

```bash
npm run dev
```

開啟 `http://localhost:5173`。CI 會在 Linux 與 Windows 自動驗證安裝、後端
測試與 production build。若要使用 AI，請在介面輸入：

- **API URL：**相容 OpenAI API 格式的 base URL，例如
  `https://api.openai.com/v1`
- **API Key：**供應商的 token
- **Model：**從模型清單選擇，或直接輸入模型 ID

API URL 與模型會保存在瀏覽器 localStorage；API Key 只保存在
`sessionStorage`，關閉分頁後即清除。應用程式不會把金鑰寫入資料庫或磁碟。

## 公開部署

這個專案沒有內建登入或存取控制。公開部署時，請依需求在 reverse proxy、VPN
或平台層加入驗證，並使用 HTTPS。

後端 proxy 預設允許使用者輸入任何 HTTP(S) API host，方便本機與私人環境使用。
若服務可從網際網路存取，強烈建議設定允許清單，避免 SSRF：

```dotenv
AI_API_ALLOWED_HOSTS=api.openai.com,openrouter.ai
```

設定後只允許清單內的 `host[:port]`，且不會跟隨 upstream redirect。這是部署者的
安全設定，不是一般使用者啟動專案的必要步驟。更多注意事項請見
[SECURITY.md](SECURITY.md)。

## 設定

| 環境變數 | 用途 | 預設值 |
| --- | --- | --- |
| `APP_API_PORT` / `PORT` | 開發／production server port | `3001` / `3000` |
| `AI_API_ALLOWED_HOSTS` | 可選的 `host[:port]` proxy 允許清單 | 不限制 |
| `MODELS_TIMEOUT_MS` | 取得模型清單的 timeout | `15000` |
| `CHAT_TIMEOUT_MS` | AI chat timeout | `120000` |
| `JSON_BODY_LIMIT` | JSON request body 上限 | `256kb` |

## 驗證

```bash
npm test
npm run build
npm run test:browser
```

## 架構

Vite/React client 負責編輯與渲染 Mermaid 圖表。小型 Express proxy 會驗證
BYOK request、正規化 OpenAI-compatible URL、轉送 `/models` 與
`/chat/completions`，並套用可選的 host 允許清單。伺服器沒有使用者資料庫，
也沒有內建或共用的 AI credential。

## 參與貢獻

歡迎提出 issue 與範圍明確的 pull request。請先閱讀
[CONTRIBUTING.md](CONTRIBUTING.md)；安全問題請依照
[SECURITY.md](SECURITY.md) 使用私密管道回報。

## 授權

採用 [MIT License](LICENSE)。Mermaid Flow Editor 是獨立專案，與 Mermaid
Chart、OpenAI 或任何 AI 供應商均無從屬關係。
