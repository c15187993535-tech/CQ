# Personal MCP

This MCP server wraps the personal integrations that have already been verified on this machine:

- Obsidian vault files at `/Users/mac/Desktop/知识库`
- GitHub API via `GITHUB_PERSONAL_ACCESS_TOKEN`
- Feishu/Lark via `lark-cli`
- Google Drive/Docs/Sheets via local OAuth files
- Web search/fetch via free RSS search and direct page fetching

## Run

```bash
npm install
npm start
```

## Codex config

```toml
[mcp_servers.personal_mcp]
command = "node"
args = ["/Users/mac/Documents/MCP 建设/personal-mcp/src/index.js"]
startup_timeout_sec = 60

[mcp_servers.personal_mcp.env]
OBSIDIAN_VAULT_PATH = "/Users/mac/Desktop/知识库"
WEB_MCP_PROXY = "http://127.0.0.1:7897"
```

`GITHUB_PERSONAL_ACCESS_TOKEN` is read from the environment.

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

## Web tools

The web tools are free and do not require an API key:

- `web_search`: lightweight search using Bing RSS.
- `web_fetch`: fetch a page and extract readable text from HTML.

Set `WEB_MCP_PROXY` when direct access is blocked:

```bash
export WEB_MCP_PROXY=http://127.0.0.1:7897
```
