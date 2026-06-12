# 2026-06-12 Personal MCP 交接文档

> 面向对象：后续接手的 AI、Claude Code、Codex、Cursor 或工程师。
> 目标：说明今天完成的个人 MCP 工作台建设、当前配置、验证方式、迁移方式和故障排查路径。

## 1. 当前结论

今天已经完成并验证了一套本地 `personal_mcp` 服务。它把个人常用系统统一封装为 MCP 工具，当前可用能力包括：

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| Obsidian | 已跑通 | 读取、搜索、写入 `/Users/mac/Desktop/知识库` 下的 Markdown 笔记 |
| GitHub | 已跑通 | 使用 `GITHUB_PERSONAL_ACCESS_TOKEN` 查询账号、仓库、Issue、PR，并可创建 PR；PAT 失效时可自动回退 `gh auth token` |
| 飞书 / Lark | 已跑通 | 通过 `lark-cli` 查询认证、日程、云文档、任务 |
| Google Drive / Docs / Sheets | 已跑通 | 使用本地 OAuth 文件查询账号、搜索 Drive、读取 Docs / Sheets |
| 网页搜索 / 网页读取 | 已跑通 | `web_search` 免费走 Bing RSS；可选 Brave Search；`web_fetch` 抓取网页正文 |
| 健康检查 | 已跑通 | `mcp_health_check` 一键检查整套集成 |

最新全链路健康检查结果：`ok`。

## 2. 代码位置与 Git 状态

项目目录：

```text
/Users/mac/Documents/MCP 建设/personal-mcp
```

主服务入口：

```text
/Users/mac/Documents/MCP 建设/personal-mcp/src/index.js
```

当前 Git 分支：

```text
codex/mcp-verification
```

GitHub PR：

```text
https://github.com/c15187993535-tech/CQ/pull/1
```

关键提交：

| 提交 | 内容 |
| --- | --- |
| `63d655f` | Add personal MCP server |
| `410baaf` | Add Google OAuth tools to personal MCP |
| `b17989a` | Verify Google Drive MCP access |
| `c6b945b` | Add free web search MCP tools |
| `6aef3de` | Add MCP health check and search fallback |
| `1599d3a` | Tighten MCP process checks |
| `359db49` | Harden HTTP JSON handling |
| `7f38451` | Automate token fallback handling |

## 3. Codex MCP 配置

当前 Codex 配置文件：

```text
~/.codex/config.toml
```

核心配置：

```toml
[mcp_servers.personal_mcp]
command = "node"
args = ["/Users/mac/Documents/MCP 建设/personal-mcp/src/index.js"]
startup_timeout_sec = 60

[mcp_servers.personal_mcp.env]
WEB_MCP_PROXY = "http://127.0.0.1:7897"
GOOGLE_MCP_PROXY = "http://127.0.0.1:7897"
OBSIDIAN_VAULT_PATH = "/Users/mac/Desktop/知识库"
```

说明：

- `127.0.0.1:7897` 是本机代理端口，不是网页后台，浏览器直接打开无法加载是正常现象。
- `GITHUB_PERSONAL_ACCESS_TOKEN` 从 shell 环境读取，已写入本机 zsh 配置。
- GitHub CLI 已安装并登录，可作为 GitHub token 备用来源。
- `BRAVE_SEARCH_API_KEY` 是可选项，不配置时 `web_search` 自动回退到免费 Bing RSS。

## 4. 认证与本地文件

### GitHub

环境变量：

```bash
GITHUB_PERSONAL_ACCESS_TOKEN
```

验证过的账号：

```text
c15187993535-tech
```

注意：

- 当前 GitHub token 已能访问仓库 `c15187993535-tech/CQ`。
- GitHub 认证现在是双来源：优先 `GITHUB_PERSONAL_ACCESS_TOKEN`，PAT 过期或缺失时自动尝试 `gh auth token`。
- 已实测把 `GITHUB_PERSONAL_ACCESS_TOKEN` 置空后，`github_whoami` 仍可通过，返回 `tokenSource = gh auth token`。
- 新增 `github_auth_status` 可查看当前 token 来源和恢复建议。
- HTTPS push 曾经卡住；稳定推送方式是 SSH：

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519_cq_github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git push git@github.com:c15187993535-tech/CQ.git codex/mcp-verification
```

### Google

OAuth 文件：

```text
~/.config/personal-mcp/google_credentials.json
~/.config/personal-mcp/google_token.json
```

已启用 API：

- Google Drive API
- Google Docs API
- Google Sheets API

验证过的账号：

```text
陈青 / c15187993535@gmail.com
```

注意：

- Google 请求通过 `GOOGLE_MCP_PROXY=http://127.0.0.1:7897` 访问。
- OAuth client secret 曾在一次调试输出中出现过。个人本地使用问题不大，但长期建议在 Google Cloud 重新生成 OAuth client 做密钥轮换。

### 飞书 / Lark

依赖：

```bash
lark-cli
```

当前版本曾更新到：

```text
1.0.52
```

验证过的用户：

```text
陈青
```

健康检查中 `lark` 状态为 `ok`，user / bot 均 ready。

### Obsidian

知识库路径：

```text
/Users/mac/Desktop/知识库
```

已验证文件：

```text
06-日常/2026-06-12.md
```

## 5. MCP 工具清单

当前 `personal_mcp` 一共注册 23 个工具：

```text
obsidian_list_notes
obsidian_read_note
obsidian_search_notes
obsidian_write_note
github_whoami
github_auth_status
github_list_repos
github_list_issues
github_list_pull_requests
github_create_pull_request
lark_auth_status
lark_calendar_agenda
lark_drive_search
lark_doc_fetch
lark_my_tasks
web_search
web_fetch
mcp_health_check
google_auth_status
google_profile
google_drive_search
google_docs_get
google_sheets_values
```

## 6. 验证命令

### 语法检查

```bash
cd "/Users/mac/Documents/MCP 建设/personal-mcp"
npm run check
```

`npm run check` 现在会检查 3 个入口：

```text
src/index.js
scripts/google-auth.js
scripts/google-import-credentials.js
```

### MCP 全链路健康检查

通过 MCP 工具调用：

```text
mcp_health_check({ "includeNetwork": true })
```

预期：

```json
{
  "status": "ok"
}
```

健康检查覆盖：

- Obsidian 路径与样例笔记
- Google OAuth 文件
- 搜索配置
- GitHub API
- GitHub token 来源与 fallback 状态
- 飞书认证
- Google Drive API
- 网页搜索

### 网页搜索验证

```text
web_search({
  "query": "\"Model Context Protocol\"",
  "limit": 2,
  "market": "en-US",
  "backend": "auto"
})
```

当前默认后端：

```text
bing-rss
```

## 6.1 Token 自动化

### Google

Google access token 会自动刷新：

- `google_token.json` 中有 `refresh_token`。
- `personal_mcp` 在 access token 快过期时自动调用 Google OAuth refresh。
- 刷新成功后会写回 `~/.config/personal-mcp/google_token.json`。

已实测刷新成功：

```text
expiresAt: 2026-06-12T08:52:03.077Z
```

如果 refresh token 被撤销，则需要重新授权：

```bash
cd "/Users/mac/Documents/MCP 建设/personal-mcp"
npm run google:auth-url
npm run google:token -- "PASTE_CODE_HERE"
```

### GitHub

GitHub PAT 不能在本地无授权自动续期，因此采用双来源恢复：

1. 优先读取 `GITHUB_PERSONAL_ACCESS_TOKEN`。
2. 如果 PAT 缺失、过期或 401/403，自动尝试 `gh auth token`。
3. GitHub CLI 已安装并完成登录。

验证命令：

```text
github_auth_status
```

当前状态：

```text
sources = ["GITHUB_PERSONAL_ACCESS_TOKEN", "gh auth token"]
fallbackAvailable = true
```

如果未来配置 `BRAVE_SEARCH_API_KEY`，`backend: "auto"` 会优先 Brave Search，失败后回退 Bing RSS。

## 7. HTTP JSON 稳定性优化

今天最后修复了 `curlJson` 的稳定性问题。

修复前的问题：

- 只解析 stdout，不读取 HTTP 状态码。
- 4xx / 5xx / HTML 错误页会表现成笼统的 JSON 解析错误。
- Brave / Google 的错误标签可能混淆。
- curl 命令失败时，错误信息可能带出请求 header，存在 token 泄露风险。

当前优化：

- 使用 curl `-w` 附加 HTTP status marker。
- 2xx 之外统一按 `ServiceName HTTP status: message` 报错。
- 支持 408、409、425、429、5xx 和连接类错误短重试，默认最多 3 次。
- 对 curl 失败使用 `errorLabel`，避免把 header/token 打入错误。
- Google OAuth、Google API、Brave Search API 的错误标签分开。

## 8. 网页搜索策略

当前原则是：高效、稳定、免费。

| 方案 | 是否免费 | 稳定性 | 当前状态 |
| --- | --- | --- | --- |
| Bing RSS | 免费 | 中等 | 默认可用 |
| Brave Search API | 有免费额度 / 需 Key | 较高 | 可选，未配置 Key |
| 公共 SearXNG | 免费 | 较低 | 测试中多次限流或失败，不作为默认 |
| DuckDuckGo Lite | 免费 | 较低 | 触发验证码，不作为默认 |

使用建议：

- 搜索专业概念时使用引号，例如 `"Model Context Protocol"`。
- 如果对搜索质量要求更高，配置 `BRAVE_SEARCH_API_KEY`。
- 无 Key 时不要依赖网页搜索做高风险判断，优先结合 `web_fetch` 读取原文。

## 9. 迁移到 Claude Code

迁移不需要重写 MCP 服务，只要让 Claude Code 指向同一个 Node 服务。

示例配置：

```json
{
  "mcpServers": {
    "personal_mcp": {
      "command": "node",
      "args": [
        "/Users/mac/Documents/MCP 建设/personal-mcp/src/index.js"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/Users/mac/Desktop/知识库",
        "GOOGLE_MCP_PROXY": "http://127.0.0.1:7897",
        "WEB_MCP_PROXY": "http://127.0.0.1:7897"
      }
    }
  }
}
```

迁移后第一步：

```text
mcp_health_check({ "includeNetwork": true })
```

通过后再验证：

- 读取 Obsidian 今日笔记
- 查询 GitHub PR
- 查询飞书日程
- 查询 Google Drive 账号
- 搜索网页并抓取官方页面

## 10. 常见故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `127.0.0.1:7897` 浏览器打不开 | 这是代理端口，不是网页 | 正常，不需要打开 |
| Google API 失败 | 代理未运行、API 未启用、token 过期 | 跑 `mcp_health_check` 看 `google_drive` |
| 网页搜索结果跑偏 | Bing RSS 对短词不稳定 | 使用完整关键词和引号 |
| Brave 搜索不可用 | 未配置 `BRAVE_SEARCH_API_KEY` | 不配置也能回退 Bing RSS |
| 飞书显示 `needs_refresh` | 用户 token 待刷新 | 大多数调用会自动刷新；失败时重新 `lark-cli auth login` |
| Git push 卡住 | HTTPS 网络路径不稳定 | 使用 SSH push 命令 |
| MCP 工具不出现 | Codex / Claude 未重启或配置未加载 | 重启客户端并检查 MCP 配置 |

## 11. 安全注意事项

- 不要把 `GITHUB_PERSONAL_ACCESS_TOKEN`、Google OAuth secret、refresh token 写入文档或仓库。
- `~/.config/personal-mcp/google_token.json` 应保持本机私有。
- GitHub token 权限建议只授予必要仓库。
- 数据库 MCP 如果后续接入，建议先做只读账号，只允许 `SELECT`。
- 微信 MCP 不建议直接自动发消息，优先做导出记录读取和总结。

## 11.1 Claude / Codex 配置安全优化

已在 2026-06-12 对 Claude Code / Codex 本机配置做过一次安全收敛，目标是减少明文密钥和过宽权限。

### 已完成的调整

| 项目 | 调整前 | 调整后 |
| --- | --- | --- |
| Claude `ANTHROPIC_AUTH_TOKEN` | 写在 `~/.claude/settings.json` | 已移除，改由 shell 环境变量提供 |
| Codex `ANTHROPIC_AUTH_TOKEN` | 写在 `~/.codex/config.toml` | 已移除，改由 shell 环境变量提供 |
| Claude allow 权限 | 约 70 条，含 `curl *`、`open *`、`npm install *` 等宽泛项 | 收窄到 41 条，移除高风险通配规则 |
| Claude `additionalDirectories` | 包含整个 `/Users/mac` 和旧临时目录 | 收窄到 `/Users/mac/Desktop/知识库` 与 `/Users/mac/Documents/MCP 建设` |
| Claude MCP | 未配置 `personal_mcp` | 已配置 `personal_mcp`，指向本项目入口 |

### 当前 Claude MCP 配置

位置：

```text
~/.claude/settings.json
```

关键配置：

```json
{
  "mcpServers": {
    "personal_mcp": {
      "command": "node",
      "args": [
        "/Users/mac/Documents/MCP 建设/personal-mcp/src/index.js"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/Users/mac/Desktop/知识库",
        "GOOGLE_MCP_PROXY": "http://127.0.0.1:7897",
        "WEB_MCP_PROXY": "http://127.0.0.1:7897"
      }
    }
  }
}
```

### 当前 token 策略

`ANTHROPIC_AUTH_TOKEN` 不再放在 Claude / Codex 配置文件中，而是写入：

```text
~/.zshrc
~/.zprofile
```

验证方式：

```bash
zsh -lc 'source ~/.zshrc >/dev/null 2>&1; if [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then echo present; else echo missing; fi'
```

### 备份文件

调整前已自动备份：

```text
~/.claude/settings.json.bak-mcp-opt-20260612112922
~/.claude/settings.local.json.bak-mcp-opt-20260612112922
~/.codex/config.toml.bak-mcp-opt-20260612112922
~/.zshrc.bak-mcp-opt-20260612112922
~/.zprofile.bak-mcp-opt-20260612112922
```

### 配置优化后的验证结果

已完成以下验证：

```text
Claude JSON 配置可解析
配置文件脱敏扫描未发现明文 ANTHROPIC_AUTH_TOKEN
shell 环境变量 ANTHROPIC_AUTH_TOKEN=present
npm run check 通过
mcp_health_check status=ok
GitHub fallbackAvailable=true
```

注意：飞书健康检查可能显示 `needs_refresh`，但整体状态仍为 `ok`，因为用户态 token 可在后续飞书 API 调用中自动刷新。

## 12. 后续建议

优先级建议：

1. 配置 Brave Search API Key，提高搜索质量与稳定性。
2. 增加只读数据库 MCP。
3. 扩展本地文件白名单，但默认只读。
4. 为内部后台优先找 API，没有 API 再做浏览器自动化。
5. 定期运行 `mcp_health_check`，把它作为跨客户端迁移和故障排查的第一步。

## 13. 今日验收摘要

最后一次端到端验证通过：

```text
TOOLS_COUNT=23
mcp_health_check=status ok
github=ok
lark=ok
google_drive=ok
web_search=ok
```

这份文档可作为后续 AI 接手的起点。
