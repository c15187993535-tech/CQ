# Personal MCP

This MCP server wraps the personal integrations that have already been verified on this machine:

- Obsidian vault files at `/Users/mac/Desktop/知识库`
- GitHub API via `GITHUB_PERSONAL_ACCESS_TOKEN`
- Feishu/Lark via `lark-cli`
- Feishu AI instruction inbox workflow for mobile task capture
- Google Drive/Docs/Sheets via local OAuth files
- Web search/fetch via optional Brave Search or free Bing RSS fallback
- SQLite readonly database inspection/query tools
- Unified knowledge tools across Obsidian plus optional network-backed sources
- Content generation workflow tools for WeChat Official Account-style articles
- Semi-automatic task dispatch tools for Feishu inbox tasks
- One-shot health checks across the configured integrations

## Run

```bash
npm install
npm start
```

## Test and audit

```bash
npm test
npm audit --omit=dev --audit-level=moderate
```

`npm test` creates temporary Obsidian, Google OAuth, and SQLite fixtures, starts the MCP server through the official SDK client, verifies core tools and readonly protections, then scans tracked project files for common secret patterns.

## Codex config

```toml
[mcp_servers.personal_mcp]
command = "node"
args = ["/Users/mac/Documents/MCP 建设/personal-mcp/src/index.js"]
startup_timeout_sec = 60

[mcp_servers.personal_mcp.env]
OBSIDIAN_VAULT_PATH = "/Users/mac/Desktop/知识库"
WEB_MCP_PROXY = "http://127.0.0.1:7897"
SQLITE_DB_ROOTS = "/Users/mac/Documents/MCP 建设/personal-mcp/data/sqlite"
```

`GITHUB_PERSONAL_ACCESS_TOKEN` is read from the environment.

GitHub auth is source-aware:

- Primary: `GITHUB_PERSONAL_ACCESS_TOKEN`
- Optional fallback: `gh auth token` when GitHub CLI is installed and logged in

Use `github_auth_status` or `mcp_health_check` to see the active source. PAT renewal cannot be fully automated without a delegated OAuth/GitHub App flow; the fallback path avoids downtime when `gh` is available.

Optional search upgrade:

```bash
export BRAVE_SEARCH_API_KEY=your_key_here
```

## Google OAuth

Google support is implemented without extra dependencies. It uses direct HTTP calls to Google APIs.

### 1. Download OAuth credentials

Create a Google Cloud OAuth client:

1. Open <https://console.cloud.google.com/apis/credentials>
2. Create or select a project.
3. Enable these APIs:
   - Google Drive API
   - Google Docs API
   - Google Sheets API
4. Create OAuth client ID.
5. Application type: Desktop app.
6. Download the JSON file.

Save it as:

```text
~/.config/personal-mcp/google_credentials.json
```

### 2. Generate an authorization URL

```bash
cd "/Users/mac/Documents/MCP 建设/personal-mcp"
npm run google:auth-url
```

Open the printed URL, approve access, and copy the authorization code.

### 3. Save the token

```bash
npm run google:token -- "PASTE_CODE_HERE"
```

This creates:

```text
~/.config/personal-mcp/google_token.json
```

### Google tools

- `google_auth_status`
- `google_profile`
- `google_drive_search`
- `google_docs_get`
- `google_sheets_values`

Google access tokens refresh automatically when `google_token.json` contains a valid `refresh_token`. If the refresh token is revoked, rerun `npm run google:auth-url` and `npm run google:token`.

## Feishu AI instruction inbox

Created inbox document:

```text
https://my.feishu.cn/docx/EkRedV11koOJbrxooz9cACasnPe
```

Template file:

```text
docs/lark-ai-inbox-template.md
```

Tools:

- `lark_inbox_template`: return the Markdown inbox template.
- `lark_inbox_parse_text`: parse inbox Markdown locally, useful for tests and dry runs.
- `lark_inbox_fetch_pending`: read a Feishu inbox doc and return tasks whose status is `待处理`.
- `lark_inbox_add_task`: append a task to the inbox doc.
- `lark_inbox_complete_task`: write a result and mark the task `已完成`.

Mobile workflow:

```text
手机飞书写任务 -> Mac 上 AI 读取待处理 -> AI 调用 personal_mcp 执行 -> 结果写回飞书
```

## Unified knowledge tools

These tools provide a single knowledge interface over local Obsidian and optional network-backed sources:

- `knowledge_sources`: list configured sources and capabilities.
- `knowledge_search`: search sources with one query. Defaults to local Obsidian only.
- `knowledge_read`: read an Obsidian note, Feishu doc, or web page.
- `knowledge_write_note`: write Markdown back to the Obsidian vault.

Examples:

```text
knowledge_search({ "query": "Google OAuth", "sources": "obsidian", "limit": 10 })
knowledge_read({ "source": "obsidian", "id": "03-工具库/Personal MCP 交接文档 2026-06-12.md" })
knowledge_write_note({ "notePath": "03-工具库/调研结果.md", "title": "调研结果", "content": "..." })
```

Set `includeNetwork: true` in `knowledge_search` to include `lark`, `google_drive`, or `web`.

## Content generation tools

These tools turn a mobile task or writing request into a structured article workflow:

- `content_brief_parse`: parse a raw Chinese writing request into topic, audience, purpose, style, length, and constraints.
- `content_research`: search knowledge sources for related materials.
- `content_outline`: generate a reusable article outline.
- `content_draft_pack`: create the drafting prompt and material pack for the AI writer.
- `content_publish_pack`: produce title options, summary, layout, and pre-publish checklist.
- `content_save_to_obsidian`: save the finished draft/publish pack into the Obsidian vault.

Recommended mobile flow:

```text
飞书 AI 指令收件箱写公众号任务
-> content_brief_parse
-> content_research
-> content_draft_pack
-> AI writes the article
-> content_publish_pack
-> lark_inbox_complete_task writes the result back to phone
```

## Semi-automatic task dispatch

These tools do not run on a timer and do not execute tasks by themselves. They classify pending tasks and produce a safe dry-run plan for the current AI session.

- `task_classify`: classify a task as content, knowledge, daily_report, code, data, web_research, or general.
- `task_plan`: create a semi-automatic execution plan and recommended tools.
- `task_result_template`: generate a standard result block for writing back to Feishu.
- `task_dispatch_pending`: read pending Feishu AI inbox tasks and return dispatch plans.

Recommended command:

```text
读取飞书 AI 指令收件箱，调用 task_dispatch_pending，然后按计划执行待处理任务。
```

## Web tools

The web tools work for free without an API key:

- `web_search`: uses Brave Search when `BRAVE_SEARCH_API_KEY` is set, otherwise falls back to Bing RSS.
- `web_fetch`: fetch a page and extract readable text from HTML.

Set `WEB_MCP_PROXY` when direct access is blocked:

```bash
export WEB_MCP_PROXY=http://127.0.0.1:7897
```

The free Bing RSS fallback is good enough for lightweight discovery. For higher search quality and lower drift, configure Brave Search; if Brave fails, `backend: "auto"` falls back to Bing RSS.

## SQLite readonly tools

SQLite support is local, free, and readonly. By default, database files are only allowed under:

```text
/Users/mac/Documents/MCP 建设/personal-mcp/data/sqlite
```

You can add more allowed roots with `SQLITE_DB_ROOTS` using colon-separated paths.

Tools:

- `sqlite_list_databases`: list allowed `.db`, `.sqlite`, and `.sqlite3` files.
- `sqlite_list_tables`: list tables and views.
- `sqlite_describe_table`: inspect columns and indexes.
- `sqlite_query_readonly`: run one `SELECT` or `WITH` query.

Safety limits:

- Opens databases with `sqlite3 -readonly`.
- Allows only one `SELECT` or `WITH` statement.
- Blocks write/admin keywords like `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `PRAGMA`, `ATTACH`, and `VACUUM`.
- Adds a default `LIMIT` when the query has no limit.
- Keeps a short execution timeout.

## Health check

- `mcp_health_check`: verifies Obsidian, Google OAuth files, search config, SQLite roots, and optionally GitHub, Lark, Google Drive, and web search.
- `mcp_health_local`: fast local checks for Obsidian, Google OAuth files, search config, and SQLite roots.
- `mcp_health_github`: GitHub token/API check only.
- `mcp_health_lark`: Lark/Feishu auth check only.
- `mcp_health_google`: Google OAuth files plus Google Drive API check only.
- `mcp_health_web`: search config plus live web-search check only.

Use `includeNetwork: false` for a fast local-only check, or `includeNetwork: true` for end-to-end validation.
When diagnosing failures, prefer the split tools first so one slow network provider does not hide the rest of the system.
