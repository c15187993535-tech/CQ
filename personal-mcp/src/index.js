#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");
const vaultRoot = path.resolve(process.env.OBSIDIAN_VAULT_PATH || "/Users/mac/Desktop/知识库");
const defaultGithubOwner = process.env.GITHUB_OWNER || "c15187993535-tech";
const googleConfigDir = path.resolve(process.env.GOOGLE_MCP_CONFIG_DIR || path.join(process.env.HOME || ".", ".config", "personal-mcp"));
const googleCredentialsPath = path.resolve(process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(googleConfigDir, "google_credentials.json"));
const googleTokenPath = path.resolve(process.env.GOOGLE_OAUTH_TOKEN || path.join(googleConfigDir, "google_token.json"));
const googleProxy = process.env.GOOGLE_MCP_PROXY || "";
const webProxy = process.env.WEB_MCP_PROXY || process.env.GOOGLE_MCP_PROXY || "";
const braveSearchApiKey = process.env.BRAVE_SEARCH_API_KEY || "";
const sqliteRoots = (process.env.SQLITE_DB_ROOTS || path.join(projectRoot, "data", "sqlite"))
  .split(":")
  .filter(Boolean)
  .map((root) => path.resolve(root));
let githubCliTokenCache = null;

function text(content) {
  return { content: [{ type: "text", text: String(content ?? "") }] };
}

function json(value) {
  return text(JSON.stringify(value, null, 2));
}

function ensureInsideVault(inputPath) {
  const absolute = path.resolve(vaultRoot, inputPath || ".");
  const relative = path.relative(vaultRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside Obsidian vault: ${inputPath}`);
  }
  return absolute;
}

function ensureInsideRoots(inputPath, roots, label) {
  const absolute = path.resolve(inputPath);
  for (const root of roots) {
    const relative = path.relative(root, absolute);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return absolute;
  }
  throw new Error(`${label} path is outside allowed roots: ${inputPath}`);
}

function ensureSqlitePath(dbPath) {
  const absolute = ensureInsideRoots(dbPath, sqliteRoots, "SQLite database");
  if (!/\.(db|sqlite|sqlite3)$/i.test(absolute)) {
    throw new Error("SQLite database path must end with .db, .sqlite, or .sqlite3");
  }
  return absolute;
}

function assertReadonlySql(sql) {
  const normalized = String(sql || "")
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (!normalized) throw new Error("SQL is empty.");
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error("Only SELECT or WITH queries are allowed.");
  }
  if (normalized.includes(";")) {
    const statements = normalized.split(";").map((part) => part.trim()).filter(Boolean);
    if (statements.length > 1) throw new Error("Only one readonly SQL statement is allowed.");
  }
  const blocked = /\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|pragma|vacuum|reindex|analyze)\b/i;
  if (blocked.test(normalized)) {
    throw new Error("SQL contains a blocked write/admin keyword.");
  }
  return normalized.replace(/;+\s*$/, "");
}

function addLimit(sql, limit) {
  if (/\blimit\s+\d+/i.test(sql)) return sql;
  return `${sql} LIMIT ${limit}`;
}

function nowLocalIso() {
  const offsetMs = new Date().getTimezoneOffset() * 60_000;
  return new Date(Date.now() - offsetMs).toISOString().replace("T", " ").slice(0, 19);
}

function larkInboxTemplate() {
  return `# AI 指令收件箱

说明：
手机上把任务写到“待处理”下面。
Mac 上让 AI 读取本文档并执行。
AI 执行后，把状态改为“已完成”，并写入结果。

## 待处理

### 示例任务
状态：待处理
优先级：中
任务：
读取今天 Obsidian 日记，生成日报，写入 Obsidian，并同步到飞书。

## 已完成
`;
}

function parseLarkInboxTasks(markdown, options = {}) {
  const {
    status = "待处理",
    limit = 20,
  } = options;
  const content = String(markdown || "").replace(/\r\n/g, "\n");
  const headingRegex = /^###\s+(.+?)\s*$/gm;
  const headings = [];
  let match;
  while ((match = headingRegex.exec(content))) {
    headings.push({ title: match[1].trim(), start: match.index, bodyStart: headingRegex.lastIndex });
  }
  const sectionStarts = [...content.matchAll(/^#{1,3}\s+.+?\s*$/gm)].map((item) => item.index);
  const tasks = [];
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const nextStart = sectionStarts.find((start) => start > current.start) ?? content.length;
    const block = content.slice(current.start, nextStart).trim();
    const body = content.slice(current.bodyStart, nextStart).trim();
    const statusMatch = body.match(/^状态[:：]\s*(.+?)\s*$/m);
    const priorityMatch = body.match(/^优先级[:：]\s*(.+?)\s*$/m);
    const createdMatch = body.match(/^创建时间[:：]\s*(.+?)\s*$/m);
    const completedMatch = body.match(/^完成时间[:：]\s*(.+?)\s*$/m);
    const taskMatch = body.match(/^任务[:：]\s*([\s\S]*?)(?=^结果[:：]|^完成时间[:：]|^状态[:：]|^优先级[:：]|^创建时间[:：]|^###\s+|\s*$)/m);
    const resultMatch = body.match(/^结果[:：]\s*([\s\S]*?)(?=^完成时间[:：]|^###\s+|\s*$)/m);
    const taskStatus = statusMatch?.[1]?.trim() || "";
    if (status && taskStatus !== status) continue;
    tasks.push({
      id: Buffer.from(current.title).toString("base64url").slice(0, 24),
      title: current.title,
      status: taskStatus,
      priority: priorityMatch?.[1]?.trim() || "",
      createdAt: createdMatch?.[1]?.trim() || "",
      completedAt: completedMatch?.[1]?.trim() || "",
      task: (taskMatch?.[1] || "").trim(),
      result: (resultMatch?.[1] || "").trim(),
      block,
    });
    if (tasks.length >= limit) break;
  }
  return tasks;
}

function appendLarkInboxTask(markdown, task) {
  const content = String(markdown || "").trimEnd();
  const title = task.title?.trim() || `手机任务 ${nowLocalIso()}`;
  const priority = task.priority?.trim() || "中";
  const body = task.task?.trim() || "";
  const createdAt = task.createdAt?.trim() || nowLocalIso();
  const block = `### ${title}
状态：待处理
优先级：${priority}
创建时间：${createdAt}
任务：
${body}
`;
  if (content.includes("## 待处理")) {
    return content.replace(/(## 待处理\s*)/, `$1\n${block}\n`).trimEnd() + "\n";
  }
  return `${content || larkInboxTemplate().trimEnd()}

## 待处理

${block}
`.trimEnd() + "\n";
}

function updateLarkInboxTask(markdown, title, result, options = {}) {
  const content = String(markdown || "").replace(/\r\n/g, "\n");
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^###\\s+${escapedTitle}\\s*$)([\\s\\S]*?)(?=^#{1,3}\\s+|\\s*$)`, "m");
  const match = content.match(pattern);
  if (!match) throw new Error(`Task not found in inbox: ${title}`);
  let body = match[2].trimEnd();
  if (/^状态[:：]/m.test(body)) {
    body = body.replace(/^状态[:：].*$/m, `状态：${options.status || "已完成"}`);
  } else {
    body = `状态：${options.status || "已完成"}\n${body}`;
  }
  body = body
    .replace(/\n结果[:：][\s\S]*?(?=\n完成时间[:：]|\s*$)/m, "")
    .replace(/\n完成时间[:：].*$/m, "")
    .trimEnd();
  const completedAt = options.completedAt || nowLocalIso();
  const updated = `${match[1]}
${body}

结果：
${String(result || "").trim()}

完成时间：${completedAt}
`;
  return content.replace(pattern, updated).trimEnd() + "\n";
}

async function walkMarkdown(dir, options = {}) {
  const { maxFiles = 2000, includeTrash = false } = options;
  const files = [];
  async function visit(current) {
    if (files.length >= maxFiles) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name === ".obsidian" || entry.name === ".git") continue;
      if (!includeTrash && entry.name === ".trash") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }
  await visit(dir);
  return files;
}

async function walkSqliteDatabases(dir, options = {}) {
  const { maxFiles = 200 } = options;
  const files = [];
  async function visit(current) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && /\.(db|sqlite|sqlite3)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  await visit(dir);
  return files;
}

async function runCommand(command, args, options = {}) {
  const {
    input,
    timeoutMs = 30_000,
    env = {},
    cwd = process.cwd(),
  } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const label = options.errorLabel || `${command} ${args.join(" ")}`;
        reject(new Error(`${label} failed with ${code}\n${stderr || stdout}`));
      }
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubTokenCandidates() {
  const candidates = [];
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    candidates.push({
      source: "GITHUB_PERSONAL_ACCESS_TOKEN",
      token: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    });
  }
  if (githubCliTokenCache) {
    candidates.push(githubCliTokenCache);
    return candidates;
  }
  try {
    const result = await runCommand("gh", ["auth", "token"], {
      timeoutMs: 10_000,
      errorLabel: "GitHub CLI token lookup",
    });
    const token = result.stdout.trim();
    if (token) {
      githubCliTokenCache = { source: "gh auth token", token };
      candidates.push(githubCliTokenCache);
    }
  } catch {
    // GitHub CLI is optional; PAT remains the primary free path.
  }
  return candidates;
}

function githubRecoveryHint() {
  return "GitHub token recovery: regenerate a fine-grained PAT and update GITHUB_PERSONAL_ACCESS_TOKEN, or install/login GitHub CLI so personal_mcp can fall back to `gh auth token`.";
}

async function githubRequest(endpoint, options = {}) {
  const candidates = await githubTokenCandidates();
  if (!candidates.length) throw new Error(`No GitHub token source available. ${githubRecoveryHint()}`);
  const url = endpoint.startsWith("http") ? endpoint : `https://api.github.com${endpoint}`;
  const failures = [];
  for (const candidate of candidates) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${candidate.token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });
    const body = await response.text();
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = body;
    }
    if (response.ok) {
      if (parsed && typeof parsed === "object") {
        Object.defineProperty(parsed, "__tokenSource", {
          value: candidate.source,
          enumerable: false,
        });
      }
      return parsed;
    }
    const message = typeof parsed === "object" && parsed?.message ? parsed.message : body;
    failures.push(`${candidate.source}: HTTP ${response.status}: ${message}`);
    if (![401, 403].includes(response.status)) {
      throw new Error(`GitHub API ${response.status}: ${message}`);
    }
  }
  throw new Error(`${failures.join("; ")}. ${githubRecoveryHint()}`);
}

function repoParts(repository) {
  if (!repository.includes("/")) return `${defaultGithubOwner}/${repository}`;
  return repository;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function loadGoogleCredentials() {
  let raw;
  try {
    raw = await readJsonFile(googleCredentialsPath);
  } catch {
    throw new Error(`Google OAuth credentials not found at ${googleCredentialsPath}. Create an OAuth client and save credentials.json there.`);
  }
  const config = raw.installed || raw.web;
  if (!config?.client_id || !config?.client_secret) {
    throw new Error("Google OAuth credentials file must contain installed or web client_id/client_secret.");
  }
  const redirectUri = config.redirect_uris?.[0] || "http://localhost";
  return { clientId: config.client_id, clientSecret: config.client_secret, redirectUri };
}

async function loadGoogleToken() {
  try {
    return await readJsonFile(googleTokenPath);
  } catch {
    throw new Error(`Google OAuth token not found at ${googleTokenPath}. Run: npm run google:auth-url, then npm run google:token -- "<code>"`);
  }
}

async function saveGoogleToken(token) {
  await fs.mkdir(path.dirname(googleTokenPath), { recursive: true });
  await fs.writeFile(googleTokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
}

async function refreshGoogleToken(credentials, token) {
  if (!token.refresh_token) return token;
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token",
  });
  const body = await curlJson("https://oauth2.googleapis.com/token", {
    serviceName: "Google OAuth",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const updated = {
    ...token,
    ...body,
    expires_at: Date.now() + ((body.expires_in || 3600) * 1000),
  };
  await saveGoogleToken(updated);
  return updated;
}

async function curlJson(url, options = {}) {
  const statusMarker = "__PERSONAL_MCP_HTTP_STATUS__:";
  const maxAttempts = options.maxAttempts || 3;
  const timeoutMs = options.timeoutMs || 45_000;
  const proxy = options.proxy ?? googleProxy;
  const serviceName = options.serviceName || "HTTP API";
  const args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "-w",
    `\n${statusMarker}%{http_code}`,
  ];
  if (proxy) args.push("-x", proxy);
  if (options.method) args.push("-X", options.method);
  for (const [name, value] of Object.entries(options.headers || {})) {
    args.push("-H", `${name}: ${value}`);
  }
  if (options.body !== undefined) {
    args.push("--data-binary", "@-");
  }
  args.push(url);

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runCommand("curl", args, {
        input: options.body,
        timeoutMs: timeoutMs + 5_000,
        errorLabel: `${serviceName} curl request`,
      });
      const markerIndex = result.stdout.lastIndexOf(statusMarker);
      if (markerIndex < 0) {
        throw new Error(`${serviceName} response missing HTTP status marker`);
      }
      const rawBody = result.stdout.slice(0, markerIndex).trim();
      const status = Number(result.stdout.slice(markerIndex + statusMarker.length).trim());
      let parsed = null;
      if (rawBody) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          const excerpt = rawBody.replace(/\s+/g, " ").slice(0, 240);
          throw new Error(`${serviceName} HTTP ${status || "unknown"} returned non-JSON response: ${excerpt}`);
        }
      }

      const errorMessage = parsed?.error_description
        || parsed?.error?.message
        || parsed?.message
        || (typeof parsed?.error === "string" ? parsed.error : "");
      if (status < 200 || status >= 300 || parsed?.error) {
        const message = errorMessage || `unexpected response status ${status}`;
        const transient = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
        if (transient && attempt < maxAttempts) {
          lastError = new Error(`${serviceName} HTTP ${status}: ${message}`);
          await sleep(300 * attempt);
          continue;
        }
        throw new Error(`${serviceName} HTTP ${status}: ${message}`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
      const message = error.message || "";
      const transient = /timed out|Could not resolve host|Failed to connect|Connection refused|HTTP (408|409|425|429|5\d\d)/i.test(message);
      if (!transient || attempt === maxAttempts) break;
      await sleep(300 * attempt);
    }
  }
  throw lastError;
}

async function curlText(url, options = {}) {
  const args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time",
    String(Math.ceil((options.timeoutMs || 45_000) / 1000)),
    "-A",
    options.userAgent || "personal-mcp/0.1 (+https://modelcontextprotocol.io)",
  ];
  const proxy = options.proxy ?? webProxy;
  if (proxy) args.push("-x", proxy);
  for (const [name, value] of Object.entries(options.headers || {})) {
    args.push("-H", `${name}: ${value}`);
  }
  args.push(url);
  const result = await runCommand("curl", args, {
    timeoutMs: options.timeoutMs || 45_000,
  });
  return result.stdout;
}

async function sqliteJson(dbPath, sql, options = {}) {
  const database = ensureSqlitePath(dbPath);
  await fs.access(database);
  const result = await runCommand("sqlite3", [
    "-readonly",
    "-json",
    database,
    sql,
  ], {
    timeoutMs: options.timeoutMs || 15_000,
    errorLabel: "sqlite3 readonly query",
  });
  const output = result.stdout.trim();
  return output ? JSON.parse(output) : [];
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return String(value || "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity] || match;
  });
}

function stripHtml(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|header|footer|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function assertHttpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }
  return url;
}

function parseBingRss(xml, limit) {
  const items = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) && items.length < limit) {
    const item = match[1];
    const title = decodeHtmlEntities(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    const link = decodeHtmlEntities(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    const snippet = stripHtml(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "");
    const publishedAt = decodeHtmlEntities(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "").trim();
    if (title && link) items.push({ title, url: link, snippet, publishedAt });
  }
  return items;
}

function mapBraveResults(data, limit) {
  return (data.web?.results || []).slice(0, limit).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: stripHtml(item.description || ""),
    publishedAt: item.age || item.page_age || "",
  })).filter((item) => item.title && item.url);
}

async function braveSearch(query, options = {}) {
  if (!braveSearchApiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not set");
  }
  const {
    limit = 5,
    market = "zh-CN",
    freshness,
  } = options;
  const [language, country = ""] = market.split("-");
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(limit, 20)),
    search_lang: language || "zh",
  });
  if (country) params.set("country", country.toUpperCase());
  if (freshness) params.set("freshness", freshness);
  const data = await curlJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    serviceName: "Brave Search API",
    proxy: webProxy,
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": braveSearchApiKey,
    },
  });
  return mapBraveResults(data, limit);
}

async function bingRssSearch(query, options = {}) {
  const {
    limit = 5,
    market = "zh-CN",
  } = options;
  const params = new URLSearchParams({
    q: query,
    format: "rss",
    setlang: market,
  });
  const xml = await curlText(`https://www.bing.com/search?${params}`, {
    userAgent: "Mozilla/5.0 (compatible; personal-mcp/0.1)",
  });
  return parseBingRss(xml, limit);
}

async function webSearch(query, options = {}) {
  const requestedBackend = options.backend || "auto";
  const attempts = [];
  if ((requestedBackend === "auto" || requestedBackend === "brave") && braveSearchApiKey) {
    try {
      const results = await braveSearch(query, options);
      return { backend: "brave", results, attempts };
    } catch (error) {
      attempts.push({ backend: "brave", ok: false, error: error.message });
      if (requestedBackend === "brave") return { backend: "brave", results: [], attempts };
    }
  }
  if (requestedBackend === "brave") {
    return {
      backend: "brave",
      results: [],
      attempts: [{ backend: "brave", ok: false, error: "BRAVE_SEARCH_API_KEY is not set" }],
    };
  }
  try {
    const results = await bingRssSearch(query, options);
    return { backend: "bing-rss", results, attempts };
  } catch (error) {
    attempts.push({ backend: "bing-rss", ok: false, error: error.message });
    return { backend: "bing-rss", results: [], attempts };
  }
}

function healthResult(name, status, details = {}) {
  return { name, status, ...details };
}

async function runHealthProbe(name, fn) {
  const startedAt = Date.now();
  try {
    const details = await fn();
    return healthResult(name, details.status || "ok", {
      latencyMs: Date.now() - startedAt,
      ...details,
    });
  } catch (error) {
    return healthResult(name, "fail", {
      latencyMs: Date.now() - startedAt,
      error: error.message,
    });
  }
}

function summarizeHealth(checks) {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "ok";
}

async function googleAccessToken() {
  const credentials = await loadGoogleCredentials();
  let token = await loadGoogleToken();
  if (!token.access_token || Date.now() > (token.expires_at || 0) - 60_000) {
    token = await refreshGoogleToken(credentials, token);
  }
  return token.access_token;
}

async function googleRequest(url, options = {}) {
  const accessToken = await googleAccessToken();
  return await curlJson(url, {
    serviceName: "Google API",
    method: options.method,
    body: options.body,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
}

const server = new McpServer({
  name: "personal-mcp",
  version: "0.1.0",
});

server.tool(
  "obsidian_list_notes",
  "List markdown notes in the Obsidian vault.",
  {
    subdir: z.string().default(".").describe("Vault-relative directory to list."),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async ({ subdir, limit }) => {
    const root = ensureInsideVault(subdir);
    const files = await walkMarkdown(root, { maxFiles: limit });
    return json(files.map((file) => path.relative(vaultRoot, file)));
  },
);

server.tool(
  "obsidian_read_note",
  "Read a markdown note from the Obsidian vault.",
  {
    notePath: z.string().describe("Vault-relative markdown path."),
    head: z.number().int().min(1).max(1000).optional().describe("Return only the first N lines."),
  },
  async ({ notePath, head }) => {
    const file = ensureInsideVault(notePath);
    const content = await fs.readFile(file, "utf8");
    if (!head) return text(content);
    return text(content.split(/\r?\n/).slice(0, head).join("\n"));
  },
);

server.tool(
  "obsidian_search_notes",
  "Search markdown notes by file name and content.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ query, limit }) => {
    const files = await walkMarkdown(vaultRoot);
    const q = query.toLowerCase();
    const matches = [];
    for (const file of files) {
      if (matches.length >= limit) break;
      const rel = path.relative(vaultRoot, file);
      const content = await fs.readFile(file, "utf8");
      const idx = content.toLowerCase().indexOf(q);
      if (rel.toLowerCase().includes(q) || idx >= 0) {
        const excerpt = idx >= 0
          ? content.slice(Math.max(0, idx - 80), Math.min(content.length, idx + query.length + 160))
          : "";
        matches.push({ path: rel, excerpt });
      }
    }
    return json(matches);
  },
);

server.tool(
  "obsidian_write_note",
  "Create or overwrite a markdown note in the Obsidian vault.",
  {
    notePath: z.string().describe("Vault-relative markdown path."),
    content: z.string(),
  },
  async ({ notePath, content }) => {
    const file = ensureInsideVault(notePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return text(`Wrote ${path.relative(vaultRoot, file)}`);
  },
);

server.tool(
  "github_whoami",
  "Verify GitHub token and return the authenticated user.",
  {},
  async () => {
    const user = await githubRequest("/user");
    return json({ login: user.login, id: user.id, name: user.name, tokenSource: user.__tokenSource || "unknown" });
  },
);

server.tool(
  "github_auth_status",
  "Show GitHub authentication sources and recovery guidance.",
  {},
  async () => {
    const candidates = await githubTokenCandidates();
    const sources = candidates.map((candidate) => candidate.source);
    let user = null;
    let error = null;
    try {
      const current = await githubRequest("/user");
      user = {
        login: current.login,
        id: current.id,
        tokenSource: current.__tokenSource || "unknown",
      };
    } catch (err) {
      error = err.message;
    }
    return json({
      ok: Boolean(user),
      sources,
      user,
      error,
      recoveryHint: githubRecoveryHint(),
    });
  },
);

server.tool(
  "github_list_repos",
  "List repositories accessible to the configured GitHub token.",
  {
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ limit }) => {
    const repos = await githubRequest(`/user/repos?per_page=${limit}&sort=updated`);
    return json(repos.map((repo) => ({
      full_name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch,
      permissions: repo.permissions,
      html_url: repo.html_url,
    })));
  },
);

server.tool(
  "github_list_issues",
  "List issues in a GitHub repository.",
  {
    repository: z.string().describe("owner/name or repo name under the default owner."),
    state: z.enum(["open", "closed", "all"]).default("open"),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ repository, state, limit }) => {
    const repo = repoParts(repository);
    const issues = await githubRequest(`/repos/${repo}/issues?state=${state}&per_page=${limit}`);
    return json(issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      pull_request: Boolean(issue.pull_request),
      html_url: issue.html_url,
      updated_at: issue.updated_at,
    })));
  },
);

server.tool(
  "github_list_pull_requests",
  "List pull requests in a GitHub repository.",
  {
    repository: z.string().describe("owner/name or repo name under the default owner."),
    state: z.enum(["open", "closed", "all"]).default("open"),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ repository, state, limit }) => {
    const repo = repoParts(repository);
    const prs = await githubRequest(`/repos/${repo}/pulls?state=${state}&per_page=${limit}`);
    return json(prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      head: pr.head?.ref,
      base: pr.base?.ref,
      html_url: pr.html_url,
      updated_at: pr.updated_at,
    })));
  },
);

server.tool(
  "github_create_pull_request",
  "Create a pull request in a GitHub repository.",
  {
    repository: z.string().describe("owner/name or repo name under the default owner."),
    title: z.string(),
    head: z.string(),
    base: z.string().default("main"),
    body: z.string().default(""),
    draft: z.boolean().default(true),
  },
  async ({ repository, title, head, base, body, draft }) => {
    const repo = repoParts(repository);
    const pr = await githubRequest(`/repos/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, head, base, body, draft }),
    });
    return json({ number: pr.number, html_url: pr.html_url, draft: pr.draft, state: pr.state });
  },
);

server.tool(
  "lark_auth_status",
  "Show Feishu/Lark auth status.",
  {},
  async () => {
    const result = await runCommand("lark-cli", ["auth", "status"], { timeoutMs: 20_000 });
    return text(result.stdout);
  },
);

server.tool(
  "lark_calendar_agenda",
  "Read Feishu/Lark calendar agenda.",
  {
    start: z.string().optional().describe("Optional start date/time."),
    end: z.string().optional().describe("Optional end date/time."),
  },
  async ({ start, end }) => {
    const args = ["calendar", "+agenda", "--as", "user", "--format", "json"];
    if (start) args.push("--start", start);
    if (end) args.push("--end", end);
    const result = await runCommand("lark-cli", args, { timeoutMs: 30_000 });
    return text(result.stdout);
  },
);

server.tool(
  "lark_drive_search",
  "Search Feishu/Lark Drive and docs.",
  {
    query: z.string().default(""),
    mine: z.boolean().default(true),
    docTypes: z.string().optional().describe("Comma-separated doc types, e.g. docx,sheet,wiki."),
    pageSize: z.number().int().min(1).max(20).default(10),
  },
  async ({ query, mine, docTypes, pageSize }) => {
    const args = ["drive", "+search", "--query", query, "--page-size", String(pageSize), "--format", "json"];
    if (mine) args.push("--mine");
    if (docTypes) args.push("--doc-types", docTypes);
    const result = await runCommand("lark-cli", args, { timeoutMs: 30_000 });
    return text(result.stdout);
  },
);

server.tool(
  "lark_doc_fetch",
  "Fetch a Feishu/Lark document as markdown.",
  {
    doc: z.string().describe("Document URL or token."),
    format: z.enum(["markdown", "xml"]).default("markdown"),
  },
  async ({ doc, format }) => {
    const result = await runCommand("lark-cli", [
      "docs",
      "+fetch",
      "--api-version",
      "v2",
      "--doc",
      doc,
      "--doc-format",
      format,
      "--detail",
      "simple",
    ], { timeoutMs: 30_000 });
    return text(result.stdout);
  },
);

server.tool(
  "lark_my_tasks",
  "List incomplete Feishu/Lark tasks assigned to the current user.",
  {
    complete: z.boolean().default(false),
    pageLimit: z.number().int().min(1).max(40).default(5),
  },
  async ({ complete, pageLimit }) => {
    const result = await runCommand("lark-cli", [
      "task",
      "+get-my-tasks",
      `--complete=${complete}`,
      "--page-limit",
      String(pageLimit),
      "--as",
      "user",
    ], { timeoutMs: 30_000 });
    return text(result.stdout);
  },
);

server.tool(
  "lark_inbox_template",
  "Return a Markdown template for the Feishu AI instruction inbox.",
  {},
  async () => text(larkInboxTemplate()),
);

server.tool(
  "lark_inbox_parse_text",
  "Parse AI instruction inbox Markdown and return tasks.",
  {
    markdown: z.string(),
    status: z.string().default("待处理").describe("Task status to filter. Use empty string to return all statuses."),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ markdown, status, limit }) => json(parseLarkInboxTasks(markdown, { status, limit })),
);

async function larkFetchMarkdown(doc) {
  const result = await runCommand("lark-cli", [
    "docs",
    "+fetch",
    "--api-version",
    "v2",
    "--doc",
    doc,
    "--doc-format",
    "markdown",
    "--detail",
    "simple",
  ], { timeoutMs: 30_000 });
  const parsed = JSON.parse(result.stdout);
  return parsed.data?.document?.content || result.stdout;
}

async function larkOverwriteMarkdown(doc, markdown) {
  const result = await runCommand("lark-cli", [
    "docs",
    "+update",
    "--api-version",
    "v2",
    "--doc",
    doc,
    "--command",
    "overwrite",
    "--doc-format",
    "markdown",
    "--content",
    "-",
  ], {
    input: markdown,
    timeoutMs: 45_000,
  });
  return JSON.parse(result.stdout);
}

server.tool(
  "lark_inbox_fetch_pending",
  "Fetch a Feishu AI instruction inbox document and return pending tasks.",
  {
    doc: z.string().describe("Feishu document URL or token for the AI instruction inbox."),
    status: z.string().default("待处理"),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ doc, status, limit }) => {
    const markdown = await larkFetchMarkdown(doc);
    return json({
      doc,
      status,
      tasks: parseLarkInboxTasks(markdown, { status, limit }),
    });
  },
);

server.tool(
  "lark_inbox_add_task",
  "Append a task to a Feishu AI instruction inbox document.",
  {
    doc: z.string().describe("Feishu document URL or token for the AI instruction inbox."),
    title: z.string().min(1),
    task: z.string().min(1),
    priority: z.string().default("中"),
  },
  async ({ doc, title, task, priority }) => {
    const markdown = await larkFetchMarkdown(doc);
    const updated = appendLarkInboxTask(markdown, { title, task, priority });
    const response = await larkOverwriteMarkdown(doc, updated);
    return json({
      ok: Boolean(response.ok),
      doc,
      title,
      revisionId: response.data?.document?.revision_id,
      url: response.data?.document?.url,
    });
  },
);

server.tool(
  "lark_inbox_complete_task",
  "Write a task result to a Feishu AI instruction inbox document and mark it completed.",
  {
    doc: z.string().describe("Feishu document URL or token for the AI instruction inbox."),
    title: z.string().min(1).describe("Exact task heading text after ###."),
    result: z.string().min(1),
    status: z.string().default("已完成"),
  },
  async ({ doc, title, result, status }) => {
    const markdown = await larkFetchMarkdown(doc);
    const updated = updateLarkInboxTask(markdown, title, result, { status });
    const response = await larkOverwriteMarkdown(doc, updated);
    return json({
      ok: Boolean(response.ok),
      doc,
      title,
      status,
      revisionId: response.data?.document?.revision_id,
      url: response.data?.document?.url,
    });
  },
);

server.tool(
  "sqlite_list_databases",
  "List SQLite database files under allowed roots.",
  {
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ limit }) => {
    const files = [];
    for (const root of sqliteRoots) {
      const databases = await walkSqliteDatabases(root, { maxFiles: limit });
      for (const file of databases) {
        if (files.length >= limit) break;
        const stat = await fs.stat(file);
        files.push({
          path: file,
          root,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
      if (files.length >= limit) break;
    }
    return json({ allowedRoots: sqliteRoots, databases: files });
  },
);

server.tool(
  "sqlite_list_tables",
  "List tables and views in a readonly SQLite database.",
  {
    dbPath: z.string().describe("Path to an allowed .db/.sqlite/.sqlite3 file."),
  },
  async ({ dbPath }) => {
    const rows = await sqliteJson(dbPath, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
    return json(rows);
  },
);

server.tool(
  "sqlite_describe_table",
  "Describe columns and indexes for a SQLite table.",
  {
    dbPath: z.string().describe("Path to an allowed .db/.sqlite/.sqlite3 file."),
    table: z.string().min(1),
  },
  async ({ dbPath, table }) => {
    const safeTable = table.replaceAll("'", "''");
    const columns = await sqliteJson(dbPath, `SELECT cid, name, type, "notnull" AS not_null, dflt_value AS default_value, pk FROM pragma_table_info('${safeTable}')`);
    const indexes = await sqliteJson(dbPath, `SELECT name, "unique" AS is_unique, origin, partial FROM pragma_index_list('${safeTable}')`);
    return json({ table, columns, indexes });
  },
);

server.tool(
  "sqlite_query_readonly",
  "Run a single readonly SELECT/WITH query against an allowed SQLite database.",
  {
    dbPath: z.string().describe("Path to an allowed .db/.sqlite/.sqlite3 file."),
    sql: z.string().min(1).describe("Readonly SQL. Only SELECT or WITH is allowed."),
    limit: z.number().int().min(1).max(500).default(100),
  },
  async ({ dbPath, sql, limit }) => {
    const readonlySql = addLimit(assertReadonlySql(sql), limit);
    const rows = await sqliteJson(dbPath, readonlySql, { timeoutMs: 15_000 });
    return json({ sql: readonlySql, rowCount: rows.length, rows });
  },
);

server.tool(
  "web_search",
  "Search the web. Uses Brave Search when BRAVE_SEARCH_API_KEY is set, otherwise falls back to free Bing RSS.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(5),
    market: z.string().default("zh-CN").describe("Search language/market hint, e.g. zh-CN or en-US."),
    backend: z.enum(["auto", "brave", "bing-rss"]).default("auto"),
    freshness: z.enum(["pd", "pw", "pm", "py"]).optional().describe("Brave freshness filter: past day/week/month/year."),
  },
  async ({ query, limit, market, backend, freshness }) => {
    const search = await webSearch(query, { limit, market, backend, freshness });
    return json({
      query,
      backend: search.backend,
      results: search.results,
      attempts: search.attempts,
      note: search.results.length ? undefined : "No results returned by the configured search backends.",
    });
  },
);

server.tool(
  "web_fetch",
  "Fetch a web page and return readable text extracted from HTML.",
  {
    url: z.string().url(),
    maxChars: z.number().int().min(500).max(50000).default(8000),
  },
  async ({ url, maxChars }) => {
    const parsed = assertHttpUrl(url);
    const html = await curlText(parsed.toString(), {
      userAgent: "Mozilla/5.0 (compatible; personal-mcp/0.1)",
    });
    const content = stripHtml(html);
    return json({
      url: parsed.toString(),
      chars: content.length,
      content: content.slice(0, maxChars),
      truncated: content.length > maxChars,
    });
  },
);

server.tool(
  "mcp_health_check",
  "Run a quick health check across personal MCP integrations.",
  {
    includeNetwork: z.boolean().default(true).describe("Include network-backed checks for GitHub, Lark, Google, and web search."),
  },
  async ({ includeNetwork }) => {
    const checks = [];
    checks.push(await runHealthProbe("obsidian", async () => {
      await fs.access(vaultRoot);
      const notes = await walkMarkdown(vaultRoot, { maxFiles: 3 });
      return {
        status: notes.length ? "ok" : "warn",
        vaultRoot,
        sampleNotes: notes.map((file) => path.relative(vaultRoot, file)),
      };
    }));

    checks.push(await runHealthProbe("google_oauth_files", async () => {
      const token = await loadGoogleToken();
      await fs.access(googleCredentialsPath);
      return {
        status: token.refresh_token ? "ok" : "warn",
        credentialsPath: googleCredentialsPath,
        tokenPath: googleTokenPath,
        hasRefreshToken: Boolean(token.refresh_token),
        expiresAt: token.expires_at ? new Date(token.expires_at).toISOString() : null,
      };
    }));

    checks.push(await runHealthProbe("search_config", async () => ({
      status: "ok",
      braveConfigured: Boolean(braveSearchApiKey),
      fallback: "bing-rss",
      proxy: webProxy || null,
    })));

    checks.push(await runHealthProbe("sqlite_config", async () => {
      const roots = [];
      let databaseCount = 0;
      for (const root of sqliteRoots) {
        let exists = false;
        try {
          const stat = await fs.stat(root);
          exists = stat.isDirectory();
        } catch {}
        if (exists) {
          const databases = await walkSqliteDatabases(root, { maxFiles: 20 });
          databaseCount += databases.length;
        }
        roots.push({ root, exists });
      }
      return { status: "ok", roots, databaseCount };
    }));

    if (includeNetwork) {
      checks.push(await runHealthProbe("github", async () => {
        const user = await githubRequest("/user");
        return {
          status: "ok",
          login: user.login,
          tokenSource: user.__tokenSource || "unknown",
          fallbackAvailable: (await githubTokenCandidates()).some((candidate) => candidate.source === "gh auth token"),
        };
      }));

      checks.push(await runHealthProbe("lark", async () => {
        const result = await runCommand("lark-cli", ["auth", "status"], { timeoutMs: 20_000 });
        const parsed = JSON.parse(result.stdout);
        const userStatus = parsed.identities?.user?.status;
        return {
          status: ["ready", "needs_refresh"].includes(userStatus) ? "ok" : "warn",
          userStatus,
          userName: parsed.identities?.user?.userName,
          botStatus: parsed.identities?.bot?.status,
        };
      }));

      checks.push(await runHealthProbe("google_drive", async () => {
        const profile = await googleRequest("https://www.googleapis.com/drive/v3/about?fields=user");
        return {
          status: "ok",
          displayName: profile.user?.displayName,
          emailAddress: profile.user?.emailAddress,
        };
      }));

      checks.push(await runHealthProbe("web_search", async () => {
        const search = await webSearch("\"Model Context Protocol\"", { limit: 3, market: "en-US", backend: "auto" });
        return {
          status: search.results.length ? "ok" : "warn",
          backend: search.backend,
          results: search.results.length,
          braveConfigured: Boolean(braveSearchApiKey),
          attempts: search.attempts,
        };
      }));
    }

    return json({
      status: summarizeHealth(checks),
      checkedAt: new Date().toISOString(),
      checks,
    });
  },
);

server.tool(
  "google_auth_status",
  "Show local Google OAuth credential/token file status.",
  {},
  async () => {
    const status = {
      credentialsPath: googleCredentialsPath,
      tokenPath: googleTokenPath,
      credentialsExists: false,
      tokenExists: false,
    };
    try {
      await fs.access(googleCredentialsPath);
      status.credentialsExists = true;
    } catch {}
    try {
      const token = await loadGoogleToken();
      status.tokenExists = true;
      status.hasRefreshToken = Boolean(token.refresh_token);
      status.expiresAt = token.expires_at ? new Date(token.expires_at).toISOString() : null;
    } catch {}
    return json(status);
  },
);

server.tool(
  "google_profile",
  "Get the current Google Drive user profile.",
  {},
  async () => {
    const profile = await googleRequest("https://www.googleapis.com/drive/v3/about?fields=user");
    return json(profile.user);
  },
);

server.tool(
  "google_drive_search",
  "Search files in Google Drive.",
  {
    query: z.string().default("").describe("Search text. Empty lists recent files."),
    limit: z.number().int().min(1).max(100).default(10),
    mimeType: z.string().optional().describe("Optional exact MIME type filter."),
  },
  async ({ query, limit, mimeType }) => {
    const clauses = ["trashed = false"];
    if (query) {
      const safe = query.replaceAll("'", "\\'");
      clauses.push(`name contains '${safe}'`);
    }
    if (mimeType) clauses.push(`mimeType = '${mimeType.replaceAll("'", "\\'")}'`);
    const params = new URLSearchParams({
      q: clauses.join(" and "),
      pageSize: String(limit),
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))",
    });
    const data = await googleRequest(`https://www.googleapis.com/drive/v3/files?${params}`);
    return json(data.files || []);
  },
);

server.tool(
  "google_docs_get",
  "Read a Google Docs document as plain text with basic structural metadata.",
  {
    documentId: z.string().describe("Google Docs document ID."),
  },
  async ({ documentId }) => {
    const doc = await googleRequest(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
    const chunks = [];
    for (const element of doc.body?.content || []) {
      for (const child of element.paragraph?.elements || []) {
        if (child.textRun?.content) chunks.push(child.textRun.content);
      }
    }
    return json({
      title: doc.title,
      documentId: doc.documentId,
      text: chunks.join(""),
    });
  },
);

server.tool(
  "google_sheets_values",
  "Read values from a Google Sheets range.",
  {
    spreadsheetId: z.string(),
    range: z.string().default("A1:Z100"),
  },
  async ({ spreadsheetId, range }) => {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
    const data = await googleRequest(url);
    return json(data);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
