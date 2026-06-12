#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const vaultRoot = path.resolve(process.env.OBSIDIAN_VAULT_PATH || "/Users/mac/Desktop/知识库");
const defaultGithubOwner = process.env.GITHUB_OWNER || "c15187993535-tech";
const googleConfigDir = path.resolve(process.env.GOOGLE_MCP_CONFIG_DIR || path.join(process.env.HOME || ".", ".config", "personal-mcp"));
const googleCredentialsPath = path.resolve(process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(googleConfigDir, "google_credentials.json"));
const googleTokenPath = path.resolve(process.env.GOOGLE_OAUTH_TOKEN || path.join(googleConfigDir, "google_token.json"));

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
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}\n${stderr || stdout}`));
      }
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function githubRequest(endpoint, options = {}) {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (!token) throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN is not set");
  const url = endpoint.startsWith("http") ? endpoint : `https://api.github.com${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
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
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed?.message ? parsed.message : body;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }
  return parsed;
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
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${body.error_description || body.error || response.status}`);
  }
  const updated = {
    ...token,
    ...body,
    expires_at: Date.now() + ((body.expires_in || 3600) * 1000),
  };
  await saveGoogleToken(updated);
  return updated;
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
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
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
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed?.error?.message ? parsed.error.message : body;
    throw new Error(`Google API ${response.status}: ${message}`);
  }
  return parsed;
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
    return json({ login: user.login, id: user.id, name: user.name });
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
