#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

function parseJsonResult(result) {
  const text = result.content?.[0]?.text || "";
  return JSON.parse(text);
}

function textResult(result) {
  return result.content?.[0]?.text || "";
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
}

async function createSqliteFixture(dbPath) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const sql = `
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT
    );
    INSERT INTO expenses (date, category, amount, note) VALUES
      ('2026-06-10', 'software', 29.9, 'tool subscription'),
      ('2026-06-11', 'learning', 12.5, 'course material'),
      ('2026-06-12', 'software', 8.8, 'api test');
  `;
  await execFileAsync("sqlite3", [dbPath, sql]);
}

async function assertToolError(client, name, args, pattern) {
  const result = await client.callTool({ name, arguments: args });
  const output = textResult(result);
  assert.match(output, pattern, `${name} should reject unsafe input; got: ${output}`);
}

async function auditTrackedFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "personal-mcp"], { cwd: path.resolve(projectRoot, "..") });
  const files = stdout.split(/\r?\n/).filter(Boolean);
  const secretPatterns = [
    /github_pat_[A-Za-z0-9_]{20,}/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}/,
    /\bAIza[0-9A-Za-z_-]{20,}/,
    /ANTHROPIC_AUTH_TOKEN\s*[:=]\s*["'][^"']+["']/,
    /client_secret"\s*:\s*"[^"]{12,}"/,
    /refresh_token"\s*:\s*"[^"]{12,}"/,
  ];
  const offenders = [];
  for (const file of files) {
    if (file.includes("package-lock.json")) continue;
    const absolute = path.resolve(path.resolve(projectRoot, ".."), file);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > 1_000_000) continue;
    const content = await fs.readFile(absolute, "utf8");
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) offenders.push({ file, pattern: String(pattern) });
    }
  }
  assert.deepEqual(offenders, [], `Tracked files contain possible secrets: ${JSON.stringify(offenders, null, 2)}`);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "personal-mcp-test-"));
  const vaultRoot = path.join(tempRoot, "vault");
  const sqliteRoot = path.join(tempRoot, "sqlite");
  const googleConfigRoot = path.join(tempRoot, "google");
  const credentialsPath = path.join(googleConfigRoot, "credentials.json");
  const tokenPath = path.join(googleConfigRoot, "token.json");
  const dbPath = path.join(sqliteRoot, "test.sqlite");

  await fs.mkdir(path.join(vaultRoot, "06-日常"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "06-日常", "2026-06-12.md"), "# Daily Note\n\nMCP test fixture\n\nKnowledge MCP seed.\n", "utf8");
  await fs.mkdir(path.join(vaultRoot, "03-工具库"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "03-工具库", "mcp-content.md"), "# MCP 个人工作台\n\n用 MCP 搭建个人 AI 工作台，可以连接 Obsidian、飞书和 GitHub。\n", "utf8");
  await createSqliteFixture(dbPath);
  await writeJson(credentialsPath, {
    installed: {
      client_id: "test-client-id.apps.googleusercontent.com",
      client_secret: "test-secret",
      redirect_uris: ["http://localhost"],
    },
  });
  await writeJson(tokenPath, {
    access_token: "test-access-token",
    ["refresh_" + "token"]: "test-refresh-token",
    expires_at: Date.now() + 3_600_000,
  });

  const transport = new StdioClientTransport({
    command: "node",
    args: ["./src/index.js"],
    env: {
      ...process.env,
      OBSIDIAN_VAULT_PATH: vaultRoot,
      SQLITE_DB_ROOTS: sqliteRoot,
      GOOGLE_OAUTH_CREDENTIALS: credentialsPath,
      GOOGLE_OAUTH_TOKEN: tokenPath,
      GITHUB_PERSONAL_ACCESS_TOKEN: "",
      BRAVE_SEARCH_API_KEY: "",
    },
  });
  const client = new Client({ name: "personal-mcp-test", version: "0.1.0" });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    for (const expected of [
      "mcp_health_check",
      "mcp_health_local",
      "mcp_health_github",
      "mcp_health_lark",
      "mcp_health_google",
      "mcp_health_web",
      "obsidian_read_note",
      "obsidian_write_note",
      "sqlite_list_databases",
      "sqlite_list_tables",
      "sqlite_describe_table",
      "sqlite_query_readonly",
      "google_auth_status",
      "web_fetch",
      "lark_inbox_template",
      "lark_inbox_parse_text",
      "lark_inbox_fetch_pending",
      "lark_inbox_add_task",
      "lark_inbox_complete_task",
      "knowledge_sources",
      "knowledge_search",
      "knowledge_read",
      "knowledge_write_note",
      "content_brief_parse",
      "content_outline",
      "content_research",
      "content_draft_pack",
      "content_publish_pack",
      "content_save_to_obsidian",
      "task_classify",
      "task_plan",
      "task_result_template",
      "task_dispatch_pending",
    ]) {
      assert.ok(toolNames.includes(expected), `missing MCP tool: ${expected}`);
    }
    assert.equal(toolNames.length, 51, "unexpected registered MCP tool count");

    const inboxTemplate = textResult(await client.callTool({ name: "lark_inbox_template", arguments: {} }));
    assert.match(inboxTemplate, /# AI 指令收件箱/);
    assert.match(inboxTemplate, /状态：待处理/);

    const inboxMarkdown = `# AI 指令收件箱

## 待处理

### 整理今天日报
状态：待处理
优先级：高
创建时间：2026-06-12 20:00:00
任务：
读取 Obsidian 今日笔记，生成日报。

### 已完成示例
状态：已完成
优先级：低
任务：
这条不应该进入待处理。

结果：
已处理。

完成时间：2026-06-12 20:10:00

## 已完成
`;
    const pendingTasks = parseJsonResult(await client.callTool({
      name: "lark_inbox_parse_text",
      arguments: { markdown: inboxMarkdown, status: "待处理", limit: 10 },
    }));
    assert.equal(pendingTasks.length, 1);
    assert.equal(pendingTasks[0].title, "整理今天日报");
    assert.equal(pendingTasks[0].priority, "高");
    assert.match(pendingTasks[0].task, /读取 Obsidian/);

    const allInboxTasks = parseJsonResult(await client.callTool({
      name: "lark_inbox_parse_text",
      arguments: { markdown: inboxMarkdown, status: "", limit: 10 },
    }));
    assert.equal(allInboxTasks.length, 2);

    const contentTask = "写一篇公众号，主题是 MCP 个人工作台，1500 字，教程型。";
    const contentTaskClass = parseJsonResult(await client.callTool({
      name: "task_classify",
      arguments: { task: contentTask },
    }));
    assert.equal(contentTaskClass.type, "content");
    assert.ok(contentTaskClass.recommendedTools.includes("content_brief_parse"));

    const contentTaskPlan = parseJsonResult(await client.callTool({
      name: "task_plan",
      arguments: { title: "写公众号：MCP 个人工作台", task: contentTask },
    }));
    assert.equal(contentTaskPlan.executionMode, "semi_auto");
    assert.equal(contentTaskPlan.classification.type, "content");
    assert.equal(contentTaskPlan.requiresConfirmation, false);
    assert.ok(contentTaskPlan.steps.some((step) => step.includes("content_draft_pack")));

    const reportTaskPlan = parseJsonResult(await client.callTool({
      name: "task_plan",
      arguments: { title: "整理日报", task: "读取今天 Obsidian 日记，结合 GitHub PR 和飞书任务生成日报。" },
    }));
    assert.equal(reportTaskPlan.classification.type, "daily_report");
    assert.equal(reportTaskPlan.requiresConfirmation, true);

    const taskTemplate = textResult(await client.callTool({
      name: "task_result_template",
      arguments: { title: "写公众号：MCP 个人工作台", task: contentTask },
    }));
    assert.match(taskTemplate, /执行结果/);
    assert.match(taskTemplate, /内容生成/);

    const knowledgeSources = parseJsonResult(await client.callTool({ name: "knowledge_sources", arguments: {} }));
    assert.ok(knowledgeSources.some((source) => source.source === "obsidian" && source.capabilities.includes("write")));

    const knowledgeSearch = parseJsonResult(await client.callTool({
      name: "knowledge_search",
      arguments: { query: "Knowledge MCP", sources: "obsidian,web", includeNetwork: false, limit: 10 },
    }));
    assert.equal(knowledgeSearch.results.length, 1);
    assert.equal(knowledgeSearch.results[0].source, "obsidian");
    assert.equal(knowledgeSearch.errors[0].source, "web");

    const knowledgeRead = parseJsonResult(await client.callTool({
      name: "knowledge_read",
      arguments: { source: "obsidian", id: "06-日常/2026-06-12.md", maxChars: 1000 },
    }));
    assert.match(knowledgeRead.content, /Knowledge MCP seed/);

    const knowledgeWrite = parseJsonResult(await client.callTool({
      name: "knowledge_write_note",
      arguments: {
        notePath: "03-工具库/knowledge-test.md",
        title: "Knowledge Test",
        content: "Unified knowledge write path.",
        mode: "overwrite",
      },
    }));
    assert.equal(knowledgeWrite.path, "03-工具库/knowledge-test.md");
    assert.match(await fs.readFile(path.join(vaultRoot, "03-工具库", "knowledge-test.md"), "utf8"), /Unified knowledge write path/);
    await assertToolError(client, "knowledge_read", { source: "obsidian", id: "../outside.md", maxChars: 1000 }, /outside Obsidian vault/i);

    const contentBriefText = `主题：MCP 个人工作台
目标读者：想用 AI 提高效率的普通用户
风格：通俗、教程型、有故事感
字数：1500 字左右
必须包含：手机飞书输入任务、知识库搜索、结果写回飞书`;
    const contentBrief = parseJsonResult(await client.callTool({
      name: "content_brief_parse",
      arguments: { input: contentBriefText },
    }));
    assert.equal(contentBrief.topic, "MCP 个人工作台");
    assert.match(contentBrief.audience, /普通用户/);

    const contentOutlineResult = parseJsonResult(await client.callTool({
      name: "content_outline",
      arguments: { brief: JSON.stringify(contentBrief) },
    }));
    assert.ok(contentOutlineResult.outline.length >= 5);

    const contentResearch = parseJsonResult(await client.callTool({
      name: "content_research",
      arguments: { brief: contentBriefText, sources: "obsidian,web", includeNetwork: false, limit: 5 },
    }));
    assert.ok(contentResearch.results.some((item) => item.source === "obsidian"));
    assert.ok(contentResearch.errors.some((item) => item.source === "web"));

    const draftPack = parseJsonResult(await client.callTool({
      name: "content_draft_pack",
      arguments: { brief: contentBriefText, materialsJson: JSON.stringify(contentResearch.results) },
    }));
    assert.match(draftPack.draftingPrompt, /初稿写作提示/);

    const publishPack = parseJsonResult(await client.callTool({
      name: "content_publish_pack",
      arguments: { brief: contentBriefText, draft: "这是一篇测试正文。" },
    }));
    assert.equal(publishPack.titles.length, 5);
    assert.match(publishPack.layout, /发布前检查/);

    const savedContent = parseJsonResult(await client.callTool({
      name: "content_save_to_obsidian",
      arguments: {
        notePath: "03-工具库/content-test.md",
        brief: contentBriefText,
        draft: "这是一篇测试正文。",
      },
    }));
    assert.equal(savedContent.path, "03-工具库/content-test.md");
    assert.match(await fs.readFile(path.join(vaultRoot, "03-工具库", "content-test.md"), "utf8"), /写作 Brief/);

    const notes = parseJsonResult(await client.callTool({
      name: "obsidian_list_notes",
      arguments: { subdir: ".", limit: 10 },
    }));
    assert.ok(notes.includes("06-日常/2026-06-12.md"));
    assert.ok(notes.includes("03-工具库/knowledge-test.md"));

    const dailyNote = textResult(await client.callTool({
      name: "obsidian_read_note",
      arguments: { notePath: "06-日常/2026-06-12.md", head: 1 },
    }));
    assert.equal(dailyNote, "# Daily Note");

    await client.callTool({
      name: "obsidian_write_note",
      arguments: { notePath: "99-test/output.md", content: "written by test\n" },
    });
    assert.equal(await fs.readFile(path.join(vaultRoot, "99-test", "output.md"), "utf8"), "written by test\n");
    await assertToolError(client, "obsidian_read_note", { notePath: "../outside.md" }, /outside Obsidian vault/i);

    const databases = parseJsonResult(await client.callTool({
      name: "sqlite_list_databases",
      arguments: { limit: 5 },
    }));
    assert.equal(databases.databases.length, 1);
    assert.equal(databases.databases[0].path, dbPath);

    const tables = parseJsonResult(await client.callTool({
      name: "sqlite_list_tables",
      arguments: { dbPath },
    }));
    assert.equal(tables[0].name, "expenses");

    const tableInfo = parseJsonResult(await client.callTool({
      name: "sqlite_describe_table",
      arguments: { dbPath, table: "expenses" },
    }));
    assert.deepEqual(tableInfo.columns.map((column) => column.name), ["id", "date", "category", "amount", "note"]);

    const query = parseJsonResult(await client.callTool({
      name: "sqlite_query_readonly",
      arguments: {
        dbPath,
        sql: "SELECT category, SUM(amount) AS total FROM expenses GROUP BY category ORDER BY total DESC",
        limit: 10,
      },
    }));
    assert.equal(query.rowCount, 2);
    assert.match(query.sql, /LIMIT 10$/);
    assert.deepEqual(query.rows[0], { category: "software", total: 38.7 });

    await assertToolError(client, "sqlite_query_readonly", { dbPath, sql: "DELETE FROM expenses", limit: 10 }, /Only SELECT or WITH/i);
    await assertToolError(client, "sqlite_query_readonly", { dbPath, sql: "SELECT 1; SELECT 2", limit: 10 }, /Only one readonly SQL statement/i);
    await assertToolError(client, "sqlite_query_readonly", { dbPath: path.join(tempRoot, "outside.sqlite"), sql: "SELECT 1", limit: 10 }, /outside allowed roots/i);

    const googleStatus = parseJsonResult(await client.callTool({ name: "google_auth_status", arguments: {} }));
    assert.equal(googleStatus.credentialsExists, true);
    assert.equal(googleStatus.tokenExists, true);
    assert.equal(googleStatus.hasRefreshToken, true);

    const health = parseJsonResult(await client.callTool({
      name: "mcp_health_check",
      arguments: { includeNetwork: false },
    }));
    assert.equal(health.status, "ok");
    assert.equal(health.checks.find((check) => check.name === "sqlite_config")?.databaseCount, 1);

    const localHealth = parseJsonResult(await client.callTool({
      name: "mcp_health_local",
      arguments: {},
    }));
    assert.equal(localHealth.status, "ok");
    assert.equal(localHealth.checks.find((check) => check.name === "sqlite_config")?.databaseCount, 1);
  } finally {
    await client.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  await auditTrackedFiles();
  console.log("personal-mcp test suite passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
