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
  await fs.writeFile(path.join(vaultRoot, "06-日常", "2026-06-12.md"), "# Daily Note\n\nMCP test fixture\n", "utf8");
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
      "obsidian_read_note",
      "obsidian_write_note",
      "sqlite_list_databases",
      "sqlite_list_tables",
      "sqlite_describe_table",
      "sqlite_query_readonly",
      "google_auth_status",
      "web_fetch",
    ]) {
      assert.ok(toolNames.includes(expected), `missing MCP tool: ${expected}`);
    }
    assert.equal(toolNames.length, 27, "unexpected registered MCP tool count");

    const notes = parseJsonResult(await client.callTool({
      name: "obsidian_list_notes",
      arguments: { subdir: ".", limit: 10 },
    }));
    assert.deepEqual(notes, ["06-日常/2026-06-12.md"]);

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
