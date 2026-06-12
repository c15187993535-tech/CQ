# Personal MCP

This MCP server wraps the personal integrations that have already been verified on this machine:

- Obsidian vault files at `/Users/mac/Desktop/知识库`
- GitHub API via `GITHUB_PERSONAL_ACCESS_TOKEN`
- Feishu/Lark via `lark-cli`

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
```

`GITHUB_PERSONAL_ACCESS_TOKEN` is read from the environment.

