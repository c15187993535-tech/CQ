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
| 飞书 AI 指令收件箱 | 已跑通 | 手机飞书写任务，Mac 上 AI 读取待处理任务并把结果写回 |
| Google Drive / Docs / Sheets | 已跑通 | 使用本地 OAuth 文件查询账号、搜索 Drive、读取 Docs / Sheets |
| 统一知识库 MCP | 已跑通 | 统一搜索/读取/写入 Obsidian，并可选接入飞书、Google Drive、网页 |
| 内容生成 MCP | 已跑通 | 面向公众号/长文写作，支持 brief 解析、素材检索、大纲、发布包和 Obsidian 保存 |
| 半自动任务调度 MCP | 已跑通 | 不定时、不后台执行；读取待处理任务后分类、生成计划和结果模板 |
| 网页搜索 / 网页读取 | 已跑通 | `web_search` 免费走 Bing RSS；可选 Brave Search；`web_fetch` 抓取网页正文 |
| SQLite 只读数据库 | 已跑通 | 仅允许访问白名单目录内的 `.db` / `.sqlite` / `.sqlite3`，只支持 `SELECT` / `WITH` 查询 |
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
SQLITE_DB_ROOTS = "/Users/mac/Documents/MCP 建设/personal-mcp/data/sqlite"
```

说明：

- `127.0.0.1:7897` 是本机代理端口，不是网页后台，浏览器直接打开无法加载是正常现象。
- `GITHUB_PERSONAL_ACCESS_TOKEN` 从 shell 环境读取，已写入本机 zsh 配置。
- GitHub CLI 已安装并登录，可作为 GitHub token 备用来源。
- `BRAVE_SEARCH_API_KEY` 是可选项，不配置时 `web_search` 自动回退到免费 Bing RSS。
- `SQLITE_DB_ROOTS` 是数据库白名单目录，多个目录用英文冒号 `:` 分隔。

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

### 飞书 AI 指令收件箱

手机入口文档：

```text
https://my.feishu.cn/docx/EkRedV11koOJbrxooz9cACasnPe
```

模板文件：

```text
/Users/mac/Documents/MCP 建设/personal-mcp/docs/lark-ai-inbox-template.md
```

已验证：

```text
lark_inbox_fetch_pending -> 成功读取“示例任务”
lark_inbox_add_task -> 成功追加“MCP 写回验证”
lark_inbox_complete_task -> 成功写入结果并标记已完成
tools_count=46（当时；当前工具总数见第 5 节）
```

手机使用方式：

```text
打开飞书 AI 指令收件箱
在“## 待处理”下面新增一个 “### 任务标题”
填写 状态：待处理 / 优先级 / 任务
回到 Mac 后让 AI 执行 lark_inbox_fetch_pending
AI 执行任务后用 lark_inbox_complete_task 写回结果并标记已完成
```

### Obsidian

知识库路径：

```text
/Users/mac/Desktop/知识库
```

已验证文件：

```text
06-日常/2026-06-12.md
```

### 统一知识库 MCP

本轮新增统一知识库工具，目标是让 AI 不必分别调用 Obsidian / 飞书 / Google Drive / 网页搜索，而是优先通过 `knowledge_*` 工具完成“查资料、读内容、写回知识库”。

新增工具：

```text
knowledge_sources
knowledge_search
knowledge_read
knowledge_write_note
```

默认策略：

```text
knowledge_search 默认只查本地 Obsidian
includeNetwork=true 后才允许查 lark / google_drive / web
knowledge_write_note 只写入 Obsidian 白名单知识库路径
knowledge_read 对 Obsidian 做路径越权保护
```

已验证：

```text
knowledge_sources -> 返回 obsidian/lark/google_drive/web
knowledge_search -> 可搜索 Obsidian 中 Knowledge MCP 测试内容
knowledge_read -> 可读取 Obsidian 笔记
knowledge_write_note -> 可写入 Obsidian 笔记
knowledge_read("../outside.md") -> 被路径保护拦截
```

### 内容生成 MCP

本轮新增内容生产工作流工具，目标是把手机飞书里的一句“写一篇公众号”变成可执行的写作链路。

新增工具：

```text
content_brief_parse
content_research
content_outline
content_draft_pack
content_publish_pack
content_save_to_obsidian
```

推荐流程：

```text
手机飞书 AI 指令收件箱写公众号任务
-> content_brief_parse 解析主题/读者/风格/字数/约束
-> content_research 从知识库找素材
-> content_draft_pack 生成大纲和写作提示
-> AI 根据提示写正文
-> content_publish_pack 生成标题/摘要/排版/检查清单
-> lark_inbox_complete_task 把结果写回飞书，手机查看
```

已验证：

```text
content_brief_parse -> 成功解析“MCP 个人工作台”公众号 brief
content_research -> 可从 Obsidian 找素材，并在 includeNetwork=false 时跳过 web
content_draft_pack -> 生成初稿写作提示
content_publish_pack -> 生成 5 个标题、摘要、发布排版和检查清单
content_save_to_obsidian -> 成功写入 03-工具库/content-test.md
```

### 半自动任务调度 MCP

本轮新增半自动调度工具。它不是定时器，也不会后台自动执行任务；它只负责在当前 AI 会话中读取待处理任务、分类、生成推荐工具和执行计划。

新增工具：

```text
task_classify
task_plan
task_result_template
task_dispatch_pending
```

调度类型：

```text
content -> 内容生成 / 公众号写作
knowledge -> 知识检索 / 文档总结
daily_report -> 日报 / 复盘
code -> 代码 / PR / GitHub
data -> SQLite / 数据分析
web_research -> 网页调研
general -> 通用任务，需人工判断
```

安全策略：

```text
task_dispatch_pending 只 dry-run，不执行任务
medium / manual_review 风险会标记 requiresConfirmation=true
真正执行仍由当前 AI 按计划调用现有 MCP 工具
执行结果再用 lark_inbox_complete_task 写回飞书
```

已验证：

```text
task_classify("写公众号...") -> content
task_plan("写公众号...") -> 推荐 content_* 工具，无需额外确认
task_plan("整理日报...") -> daily_report，需要确认
task_result_template -> 生成标准结果模板
```

### SQLite

数据库白名单目录：

```text
/Users/mac/Documents/MCP 建设/personal-mcp/data/sqlite
```

已验证样例库：

```text
/Users/mac/Documents/MCP 建设/personal-mcp/data/sqlite/personal_demo.sqlite
```

注意：

- SQLite 本身是本地文件数据库，不需要单独启动服务，也不需要付费。
- 当前 MCP 使用系统自带 `/usr/bin/sqlite3`，以 `-readonly` 打开数据库。
- 仓库已忽略 `data/sqlite/*.db`、`*.sqlite`、`*.sqlite3`，避免把个人数据库提交到 GitHub。
- 真正使用时，把需要分析的 SQLite 文件放到白名单目录，或把其所在目录加入 `SQLITE_DB_ROOTS`。

## 5. MCP 工具清单

当前 `personal_mcp` 一共注册 51 个工具：

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
lark_inbox_template
lark_inbox_parse_text
lark_inbox_fetch_pending
lark_inbox_add_task
lark_inbox_complete_task
web_search
web_fetch
mcp_health_check
mcp_health_local
mcp_health_github
mcp_health_lark
mcp_health_google
mcp_health_web
google_auth_status
google_profile
google_drive_search
google_docs_get
google_sheets_values
knowledge_sources
knowledge_search
knowledge_read
knowledge_write_note
content_brief_parse
content_research
content_outline
content_draft_pack
content_publish_pack
content_save_to_obsidian
task_classify
task_plan
task_result_template
task_dispatch_pending
sqlite_list_databases
sqlite_list_tables
sqlite_describe_table
sqlite_query_readonly
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
tests/run.mjs
```

### 自动化回归测试与安全审计

```bash
cd "/Users/mac/Documents/MCP 建设/personal-mcp"
npm test
npm audit --omit=dev --audit-level=moderate
```

`npm test` 会自动创建临时 fixture，不污染真实数据：

```text
临时 Obsidian vault
临时 Google OAuth credentials/token
临时 SQLite 数据库
```

覆盖内容：

```text
MCP 工具注册数量 = 51
飞书 AI 指令收件箱模板/解析工具
统一知识库 MCP 搜索/读取/写入/路径保护
内容生成 MCP brief/素材/大纲/发布包/保存
半自动任务调度 MCP 分类/计划/结果模板
Obsidian 读/写/路径越权拦截
SQLite 列库/列表/字段结构/聚合查询
SQLite DELETE、多语句、越权路径拦截
Google 本地 OAuth 文件状态
mcp_health_check(includeNetwork=false)
mcp_health_local
Git 跟踪文件中的常见密钥模式扫描
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
- SQLite 白名单目录与数据库数量
- GitHub API
- GitHub token 来源与 fallback 状态
- 飞书认证
- Google Drive API
- 网页搜索

### 分项健康检查

为避免 `mcp_health_check(includeNetwork=true)` 被单个外部服务拖慢或超时，本轮新增 5 个分项健康检查工具：

```text
mcp_health_local  -> Obsidian / Google OAuth 文件 / 搜索配置 / SQLite
mcp_health_github -> GitHub token 与 API
mcp_health_lark   -> 飞书 user / bot 认证
mcp_health_google -> Google OAuth 文件与 Google Drive API
mcp_health_web    -> 搜索配置与 live web search
```

建议排障顺序：

1. 先跑 `mcp_health_local`，确认本地配置没有坏。
2. 再按需要分别跑 `mcp_health_github`、`mcp_health_lark`、`mcp_health_google`、`mcp_health_web`。
3. 只有需要端到端总览时，再跑 `mcp_health_check({ "includeNetwork": true })`。

本轮实测结果：

```text
mcp_health_local=status ok
mcp_health_lark=status ok
GitHub / Google / Web 在当前 Codex 沙箱内表现为 DNS 受限；分项工具能清楚显示具体失败项。
```

### DNS / 代理处理

本轮已加入自动代理 fallback：

```text
直连失败 -> 自动尝试 http://127.0.0.1:7897
```

相关环境变量：

```text
GOOGLE_MCP_PROXY=http://127.0.0.1:7897
WEB_MCP_PROXY=http://127.0.0.1:7897
PERSONAL_MCP_DISABLE_AUTO_PROXY=1  # 如需关闭自动代理
```

说明：

- 当前 Codex 沙箱内无法连接本机代理端口，因此仍可能显示 `Failed to connect to 127.0.0.1:7897`。
- 在真实 Mac 终端或 Claude Code 正常本机环境中，若代理软件监听 `127.0.0.1:7897`，GitHub / Google / Web 请求会自动走 fallback。
- 健康检查中的 `search_config.autoProxy` 会显示当前自动代理地址。

### Obsidian / 飞书写入失败处理

本轮已加入 outbox 保护：

```text
Obsidian 写入 EPERM/EACCES -> 写入 personal-mcp/outbox/obsidian
飞书 docs +update 失败 -> 写入 personal-mcp/outbox/lark
```

同步 Obsidian outbox：

```bash
cd "/Users/mac/Documents/MCP 建设/personal-mcp"
npm run sync:outbox
```

注意：

- `outbox/` 已加入 `.gitignore`，不会把个人内容提交到 GitHub。
- `npm run sync:outbox` 会把 `outbox/obsidian` 复制回真实 Obsidian vault。
- 飞书 outbox 会被列出；需要在 `lark-cli auth status` ready 后重试写入。

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

## 6.2 SQLite 只读数据库验证

已完成的 MCP 实测：

```text
sqlite_list_databases -> 找到 personal_demo.sqlite
sqlite_list_tables -> 找到 expenses 表
sqlite_describe_table -> 正确返回 id/date/category/amount/note 字段
sqlite_query_readonly -> 聚合查询成功，自动补 LIMIT
sqlite_query_readonly(DELETE FROM expenses) -> 被拦截，只允许 SELECT 或 WITH
mcp_health_check(includeNetwork=false) -> sqlite_config=ok, databaseCount=1
```

示例查询：

```sql
SELECT category, SUM(amount) AS total
FROM expenses
GROUP BY category
ORDER BY total DESC
```

返回摘要：

```text
software = 38.7
learning = 12.5
```

## 6.3 飞书 AI 指令收件箱验证

创建的飞书文档：

```text
AI 指令收件箱
https://my.feishu.cn/docx/EkRedV11koOJbrxooz9cACasnPe
```

新增 MCP 工具：

```text
lark_inbox_template
lark_inbox_parse_text
lark_inbox_fetch_pending
lark_inbox_add_task
lark_inbox_complete_task
```

验证结果：

```text
tools_count=46（当时；当前工具总数见第 5 节）
lark_inbox_fetch_pending -> 读取到示例任务
lark_inbox_add_task -> revision_id=5
lark_inbox_complete_task -> revision_id=7
任务状态=待处理
任务优先级=中
```

## 6.4 统一知识库 MCP 验证

新增 MCP 工具：

```text
knowledge_sources
knowledge_search
knowledge_read
knowledge_write_note
```

验证结果：

```text
tools_count=46（当时；当前工具总数见第 5 节）
knowledge_sources -> ok
knowledge_search(query="Knowledge MCP", sources="obsidian,web", includeNetwork=false) -> 返回 Obsidian 结果并跳过 web
knowledge_read(source="obsidian") -> 成功读取测试笔记
knowledge_write_note -> 成功写入 03-工具库/knowledge-test.md
knowledge_read("../outside.md") -> 被拦截
```

## 6.5 内容生成 MCP 验证

新增 MCP 工具：

```text
content_brief_parse
content_research
content_outline
content_draft_pack
content_publish_pack
content_save_to_obsidian
```

验证结果：

```text
tools_count=46（当时；当前工具总数见第 5 节）
content_brief_parse -> topic=MCP 个人工作台
content_research -> 返回 Obsidian 素材，web 因 includeNetwork=false 被跳过
content_outline -> 生成 7 段式公众号大纲
content_draft_pack -> 生成初稿写作提示
content_publish_pack -> 生成 5 个标题和发布前检查
content_save_to_obsidian -> 写入 03-工具库/content-test.md
```

## 6.6 半自动任务调度 MCP 验证

新增 MCP 工具：

```text
task_classify
task_plan
task_result_template
task_dispatch_pending
```

验证结果：

```text
tools_count=46（当时；当前工具总数见第 5 节）
task_classify("写一篇公众号...") -> content
task_plan("写公众号：MCP 个人工作台") -> semi_auto，推荐 content_draft_pack
task_plan("整理日报") -> daily_report，requiresConfirmation=true
task_result_template -> 生成标准执行结果模板
```

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
        "WEB_MCP_PROXY": "http://127.0.0.1:7897",
        "SQLITE_DB_ROOTS": "/Users/mac/Documents/MCP 建设/personal-mcp/data/sqlite"
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
- 数据库 MCP 已按只读模式接入；后续如果接入 MySQL/PostgreSQL，应继续使用只读账号，只允许 `SELECT`。
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
        "WEB_MCP_PROXY": "http://127.0.0.1:7897",
        "SQLITE_DB_ROOTS": "/Users/mac/Documents/MCP 建设/personal-mcp/data/sqlite"
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
mcp_health_check status=ok（当时全链路结果；当前优先跑分项健康检查）
GitHub fallbackAvailable=true
```

注意：飞书健康检查可能显示 `needs_refresh`，但整体状态仍为 `ok`，因为用户态 token 可在后续飞书 API 调用中自动刷新。

## 12. 后续建议

优先级建议：

1. 配置 Brave Search API Key，提高搜索质量与稳定性。
2. 手机端优先使用飞书 AI 指令收件箱下发任务。
3. 将常用真实 SQLite 数据库目录加入 `SQLITE_DB_ROOTS`，并保持只读访问。
4. 扩展本地文件白名单，但默认只读。
5. 为内部后台优先找 API，没有 API 再做浏览器自动化。
6. 定期运行 `mcp_health_check`，把它作为跨客户端迁移和故障排查的第一步。

## 13. 今日验收摘要

最后一次端到端验证通过：

```text
TOOLS_COUNT=51
SQLite tools=ok
Lark inbox tools=ok
Lark inbox writeback=ok
Knowledge tools=ok
Content tools=ok
Task dispatch tools=ok
npm test=passed
npm audit=前次 0 vulnerabilities；本轮未改依赖，沙箱 DNS 限制导致未能复跑
mcp_health_local=status ok
lark=ok
github=sandbox DNS restricted during latest Codex run
google_drive=sandbox DNS restricted during latest Codex run
web_search=sandbox DNS restricted during latest Codex run
```

这份文档可作为后续 AI 接手的起点。
