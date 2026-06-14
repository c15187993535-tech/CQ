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
const outboxRoot = path.resolve(process.env.PERSONAL_MCP_OUTBOX || path.join(projectRoot, "outbox"));
const defaultGithubOwner = process.env.GITHUB_OWNER || "c15187993535-tech";
const googleConfigDir = path.resolve(process.env.GOOGLE_MCP_CONFIG_DIR || path.join(process.env.HOME || ".", ".config", "personal-mcp"));
const googleCredentialsPath = path.resolve(process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(googleConfigDir, "google_credentials.json"));
const googleTokenPath = path.resolve(process.env.GOOGLE_OAUTH_TOKEN || path.join(googleConfigDir, "google_token.json"));
const googleProxy = process.env.GOOGLE_MCP_PROXY || "";
const webProxy = process.env.WEB_MCP_PROXY || process.env.GOOGLE_MCP_PROXY || "";
const defaultLocalProxy = process.env.PERSONAL_MCP_DISABLE_AUTO_PROXY === "1" ? "" : "http://127.0.0.1:7897";
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

function proxyCandidates(primaryProxy) {
  return [primaryProxy || "", "", defaultLocalProxy].filter((proxy, index, list) => (
    proxy !== undefined && list.indexOf(proxy) === index
  ));
}

function ensureInsideVault(inputPath) {
  const absolute = path.resolve(vaultRoot, inputPath || ".");
  const relative = path.relative(vaultRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside Obsidian vault: ${inputPath}`);
  }
  return absolute;
}

function safeOutboxSegment(value) {
  return String(value || "untitled").replace(/[^\w.-]+/g, "_").slice(0, 120) || "untitled";
}

async function writeOutbox(kind, target, content) {
  const relative = kind === "obsidian"
    ? target
    : `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeOutboxSegment(target)}.md`;
  const file = path.resolve(outboxRoot, kind, relative);
  if (!file.startsWith(path.resolve(outboxRoot, kind) + path.sep)) {
    throw new Error(`Outbox path escapes allowed root: ${target}`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return file;
}

async function writeVaultMarkdown(notePath, content, options = {}) {
  const file = ensureInsideVault(notePath);
  const mode = options.mode || "overwrite";
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (mode === "append") {
      await fs.appendFile(file, `\n${content}`, "utf8");
    } else {
      await fs.writeFile(file, content, "utf8");
    }
    return {
      status: "written",
      path: path.relative(vaultRoot, file),
      file,
    };
  } catch (error) {
    if (!["EACCES", "EPERM"].includes(error.code)) throw error;
    const outboxFile = await writeOutbox("obsidian", notePath, content);
    return {
      status: "queued",
      path: path.relative(vaultRoot, file),
      file,
      outboxFile,
      error: error.message,
      note: "Obsidian vault is not writable in this runtime; content was saved to the MCP outbox.",
    };
  }
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

> 手机把任务写到「待处理」下面；Mac 上让 AI 读取并执行。完成结果不堆在这里，统一写入「AI 指令完成归档」。

## 手机填写区

最短只写四行：

任务标题
状态：待处理
资料来源：Obsidian + 飞书 / 联网 / 不联网
任务：一句话说明你要 AI 做什么

可选字段：

优先级：高 / 中 / 低
截止时间：今天 18:00
补充：资料、链接、格式要求

## 待处理

把新任务写在这里。

## 已完成归档

填入 AI 指令完成归档链接。

## 示例区（不要执行）

### 简单任务示例
状态：示例
资料来源：Obsidian + 飞书 + 联网
优先级：中
任务：结合我的知识库和最新资料，写一篇关于认知 AI 的公众号文章。
`;
}

function markdownSection(content, heading) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^##\\s+${escaped}\\s*$`, "m");
  const match = normalized.match(pattern);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = normalized.slice(start).search(/^##\s+/m);
  const end = next >= 0 ? start + next : normalized.length;
  return normalized.slice(start, end).trim();
}

function parseLarkInboxTasks(markdown, options = {}) {
  const {
    status = "待处理",
    limit = 20,
    section = "",
  } = options;
  const fullContent = String(markdown || "").replace(/\r\n/g, "\n");
  const scoped = section ? markdownSection(fullContent, section) : "";
  const content = scoped || fullContent;
  const headingRegex = /^###\s+(.+?)\s*$/gm;
  const taskStarts = [];
  let match;
  while ((match = headingRegex.exec(content))) {
    taskStarts.push({ title: match[1].trim(), start: match.index, bodyStart: headingRegex.lastIndex, heading: match[0] });
  }
  const plainTaskRegex = /^(?!#{1,6}\s)([^\n:：]{1,80}?)\s*\n\s*(?=状态[:：]|任务[:：])/gm;
  while ((match = plainTaskRegex.exec(content))) {
    const title = match[1].trim();
    if (title && !["说明", "任务", "结果", "状态", "优先级", "创建时间", "完成时间"].includes(title)) {
      taskStarts.push({ title, start: match.index, bodyStart: plainTaskRegex.lastIndex, heading: match[0].trimEnd() });
    }
  }
  taskStarts.sort((a, b) => a.start - b.start);
  const sectionStarts = [...content.matchAll(/^#{1,3}\s+.+?\s*$/gm)].map((item) => item.index);
  const tasks = [];
  for (let index = 0; index < taskStarts.length; index += 1) {
    const current = taskStarts[index];
    const nextTaskStart = taskStarts.find((item) => item.start > current.start)?.start;
    const nextSectionStart = sectionStarts.find((start) => start > current.start);
    const nextStart = Math.min(nextTaskStart ?? content.length, nextSectionStart ?? content.length);
    const block = content.slice(current.start, nextStart).trim();
    const body = content.slice(current.bodyStart, nextStart).trim();
    const statusMatch = body.match(/^状态[:：]\s*(.+?)\s*$/m);
    const priorityMatch = body.match(/^优先级[:：]\s*(.+?)\s*$/m);
    const sourcesMatch = body.match(/^资料来源[:：]\s*(.+?)\s*$/m);
    const createdMatch = body.match(/^创建时间[:：]\s*(.+?)\s*$/m);
    const completedMatch = body.match(/^完成时间[:：]\s*(.+?)\s*$/m);
    const taskMatch = body.match(/^任务[:：]\s*([\s\S]*?)(?=^结果[:：]|^完成时间[:：]|^状态[:：]|^优先级[:：]|^资料来源[:：]|^创建时间[:：]|^###\s+|\s*$)/m);
    const resultMatch = body.match(/^结果[:：]\s*([\s\S]*?)(?=^完成时间[:：]|^###\s+|\s*$)/m);
    const taskStatus = statusMatch?.[1]?.trim() || "";
    if (status && taskStatus !== status) continue;
    tasks.push({
      id: Buffer.from(current.title).toString("base64url").slice(0, 24),
      title: current.title,
      status: taskStatus,
      priority: priorityMatch?.[1]?.trim() || "",
      sources: sourcesMatch?.[1]?.trim() || "",
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
资料来源：${task.sources?.trim() || "未指定"}
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

function auditLarkInbox(markdown) {
  const content = String(markdown || "").replace(/\r\n/g, "\n");
  const pendingSection = markdownSection(content, "待处理");
  const exampleSection = markdownSection(content, "示例区（不要执行）");
  const pendingTasks = parseLarkInboxTasks(content, { status: "待处理", limit: 100, section: "待处理" });
  const issues = [];
  const warnings = [];

  if (!/^##\s+手机填写区\s*$/m.test(content)) issues.push("缺少「手机填写区」二级标题。");
  if (!/^##\s+待处理\s*$/m.test(content)) issues.push("缺少「待处理」二级标题。");
  if (!/^##\s+已完成归档\s*$/m.test(content)) issues.push("缺少「已完成归档」二级标题。");
  if (!/^##\s+示例区（不要执行）\s*$/m.test(content)) warnings.push("缺少「示例区（不要执行）」二级标题。");
  if (!/资料来源[:：]/.test(markdownSection(content, "手机填写区"))) {
    issues.push("手机填写区缺少「资料来源」字段。");
  }
  if (!/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(markdownSection(content, "已完成归档"))) {
    warnings.push("已完成归档区缺少可点击的归档链接。");
  }
  if (/状态[:：]\s*已完成/.test(pendingSection) || /^结果[:：]/m.test(pendingSection)) {
    issues.push("待处理区包含已完成状态或结果正文，应迁移到归档。");
  }
  if (/状态[:：]\s*待处理/.test(exampleSection)) {
    issues.push("示例区包含「状态：待处理」，会被误识别为真实任务。");
  }
  if (/^##\s+已完成\s*$/m.test(content)) {
    warnings.push("发现旧版「已完成」区，建议只保留「已完成归档」链接。");
  }

  return {
    status: issues.length ? "fail" : warnings.length ? "warn" : "ok",
    issues,
    warnings,
    pendingTaskCount: pendingTasks.length,
    pendingTasks,
    sections: {
      hasMobileInput: /^##\s+手机填写区\s*$/m.test(content),
      hasPending: /^##\s+待处理\s*$/m.test(content),
      hasArchive: /^##\s+已完成归档\s*$/m.test(content),
      hasExample: /^##\s+示例区（不要执行）\s*$/m.test(content),
    },
  };
}

function updateLarkInboxTask(markdown, title, result, options = {}) {
  const content = String(markdown || "").replace(/\r\n/g, "\n");
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^###\\s+${escapedTitle}\\s*$|^\\s*${escapedTitle}\\s*$)([\\s\\S]*?)(?=^#{1,3}\\s+|^(?!#{1,6}\\s)[^\\n:：]{1,80}?\\s*\\n\\s*(?:状态[:：]|任务[:：])|\\s*$)`, "m");
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

function makeExcerpt(content, query, radius = 160) {
  const textContent = String(content || "");
  const q = String(query || "").trim().toLowerCase();
  if (!q) return textContent.slice(0, radius * 2).trim();
  const idx = textContent.toLowerCase().indexOf(q);
  if (idx < 0) return textContent.slice(0, radius * 2).trim();
  return textContent.slice(Math.max(0, idx - radius), Math.min(textContent.length, idx + q.length + radius)).trim();
}

async function searchObsidianKnowledge(query, options = {}) {
  const { limit = 10 } = options;
  const files = await walkMarkdown(vaultRoot);
  const q = query.toLowerCase();
  const results = [];
  for (const file of files) {
    if (results.length >= limit) break;
    const rel = path.relative(vaultRoot, file);
    const content = await fs.readFile(file, "utf8");
    const haystack = `${rel}\n${content}`.toLowerCase();
    if (!haystack.includes(q)) continue;
    const stat = await fs.stat(file);
    results.push({
      source: "obsidian",
      id: rel,
      title: path.basename(rel, ".md"),
      path: rel,
      modifiedAt: stat.mtime.toISOString(),
      excerpt: makeExcerpt(content, query),
    });
  }
  return results;
}

async function searchLarkKnowledge(query, options = {}) {
  const { limit = 5 } = options;
  const result = await runCommand("lark-cli", [
    "drive",
    "+search",
    "--query",
    query,
    "--page-size",
    String(Math.min(limit, 20)),
    "--format",
    "json",
    "--mine",
  ], { timeoutMs: 30_000 });
  const parsed = JSON.parse(result.stdout);
  const items = parsed.data?.files || parsed.data?.items || parsed.files || parsed.items || [];
  return items.slice(0, limit).map((item) => ({
    source: "lark",
    id: item.token || item.file_token || item.docs_token || item.url || item.web_url || item.name,
    title: item.name || item.title || "",
    url: item.url || item.web_url || item.link || "",
    type: item.type || item.doc_type || item.mime_type || "",
    modifiedAt: item.modified_time || item.update_time || item.modifiedAt || "",
    excerpt: item.summary || item.snippet || "",
    raw: item,
  }));
}

async function searchGoogleDriveKnowledge(query, options = {}) {
  const { limit = 5 } = options;
  const clauses = ["trashed = false"];
  if (query) clauses.push(`name contains '${query.replaceAll("'", "\\'")}'`);
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: String(Math.min(limit, 100)),
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  const data = await googleRequest(`https://www.googleapis.com/drive/v3/files?${params}`);
  return (data.files || []).map((file) => ({
    source: "google_drive",
    id: file.id,
    title: file.name,
    url: file.webViewLink,
    type: file.mimeType,
    modifiedAt: file.modifiedTime,
    excerpt: "",
  }));
}

async function searchWebKnowledge(query, options = {}) {
  const { limit = 5 } = options;
  const search = await webSearch(query, { limit, market: options.market || "zh-CN", backend: "auto" });
  return search.results.map((item) => ({
    source: "web",
    id: item.url,
    title: item.title,
    url: item.url,
    type: "web_page",
    modifiedAt: item.publishedAt || "",
    excerpt: item.snippet || "",
  }));
}

function parseKnowledgeSources(sources) {
  if (Array.isArray(sources)) return sources;
  return String(sources || "obsidian").split(",").map((source) => source.trim()).filter(Boolean);
}

function parseKeyValueLines(textValue) {
  const result = {};
  for (const line of String(textValue || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([^:：]{2,20})[:：]\s*(.+?)\s*$/);
    if (!match) continue;
    result[match[1].trim()] = match[2].trim();
  }
  return result;
}

function parseContentBrief(input) {
  const textValue = String(input || "").trim();
  const fields = parseKeyValueLines(textValue);
  const topic = fields["主题"] || fields.topic || textValue.match(/主题[是为：:]\s*([^\n，。]+)/)?.[1]?.trim() || textValue.slice(0, 80);
  const audience = fields["目标读者"] || fields["读者"] || fields.audience || "对这个主题感兴趣的普通读者";
  const purpose = fields["文章目的"] || fields["目的"] || fields.purpose || "讲清楚观点，并给读者可执行的建议";
  const style = fields["风格"] || fields.style || "通俗、具体、有故事感";
  const length = fields["字数"] || fields.length || "1500 字左右";
  const mustInclude = fields["必须包含"] || fields["结构"] || fields["输出"] || "";
  const reference = fields["参考资料"] || fields.reference || "";
  return {
    topic,
    audience,
    purpose,
    style,
    length,
    mustInclude,
    reference,
    raw: textValue,
  };
}

function contentOutline(brief) {
  return [
    { heading: "开头：用一个真实问题引入", goal: `让${brief.audience}意识到这个主题和自己有关。` },
    { heading: `为什么要关注：${brief.topic}`, goal: "解释背景、痛点和机会，避免直接堆概念。" },
    { heading: "核心概念：用普通话讲清楚", goal: "给出简明定义、类比和边界。" },
    { heading: "我的做法：拆成可复用步骤", goal: "按步骤说明方法，让读者能照着做。" },
    { heading: "踩坑与取舍", goal: "写出限制、风险、安全边界和替代方案。" },
    { heading: "普通人怎么开始", goal: "给出低门槛行动清单。" },
    { heading: "结尾：给一个明确行动建议", goal: "收束观点，鼓励读者做第一步。" },
  ];
}

function contentDraftScaffold(brief, outline, materials = []) {
  const materialNotes = materials.length
    ? materials.slice(0, 5).map((item, index) => `${index + 1}. ${item.title || item.id}: ${item.excerpt || item.content || ""}`).join("\n")
    : "暂无外部素材，先基于任务要求生成初稿。";
  return `# ${brief.topic}

## 写作要求

- 目标读者：${brief.audience}
- 文章目的：${brief.purpose}
- 风格：${brief.style}
- 字数：${brief.length}
- 必须包含：${brief.mustInclude || "按大纲完整展开"}

## 可用素材

${materialNotes}

## 建议大纲

${outline.map((item, index) => `${index + 1}. ${item.heading}\n   - ${item.goal}`).join("\n")}

## 初稿写作提示

请按上面大纲写一篇完整中文文章。要求：

1. 开头不要空泛，先写一个具体场景或问题。
2. 每个小节只讲一个重点，少用抽象口号。
3. 把工具、流程、限制和行动建议讲清楚。
4. 结尾给读者一个今天就能做的动作。
5. 输出时包含标题备选、摘要、正文和可发布排版。`;
}

function contentPublishPack(brief, draft = "") {
  const cleanTopic = brief.topic.replace(/^写公众号[:：]?\s*/, "").trim();
  const topicLabel = cleanTopic.replace(/\s+/g, " ");
  const firstTitle = /工作台/.test(topicLabel)
    ? `我如何搭建自己的 ${topicLabel}`
    : `我用 ${topicLabel} 搭了一个个人 AI 工作台`;
  const titles = [
    firstTitle,
    `${topicLabel}：普通人也能上手的 AI 效率方案`,
    `从手机一句话开始：我的 ${topicLabel} 实践`,
    `别只会聊天了：用 ${topicLabel} 让 AI 真正干活`,
    `一篇讲清楚 ${topicLabel} 的搭建思路`,
  ];
  const summary = `这篇文章面向${brief.audience}，用${brief.style}的方式讲清楚${topicLabel}，并给出可执行的开始路径。`;
  const layout = `# 标题
${titles[0]}

> 摘要：${summary}

## 正文

${draft || "在这里粘贴正文初稿。"}

---

## 发布前检查

- 标题是否具体
- 开头是否有场景
- 每节是否有明确结论
- 是否给出行动建议
- 是否删除敏感 token、个人密钥和不可公开链接`;
  return { titles, summary, layout };
}

function classifyTaskText(input) {
  const textValue = String(input || "").trim();
  const lower = textValue.toLowerCase();
  const rules = [
    {
      type: "content",
      label: "内容生成",
      pattern: /(公众号|文章|小红书|知乎|视频脚本|文案|写一篇|标题|摘要|发布)/i,
      tools: ["content_brief_parse", "content_research", "content_draft_pack", "content_publish_pack", "lark_inbox_complete_task"],
      risk: "low",
    },
    {
      type: "daily_report",
      label: "日报复盘",
      pattern: /(日报|日记|今日|今天.*总结|复盘|周报)/i,
      tools: ["knowledge_search", "obsidian_read_note", "github_list_pull_requests", "lark_my_tasks", "knowledge_write_note", "lark_inbox_complete_task"],
      risk: "medium",
    },
    {
      type: "knowledge",
      label: "知识检索",
      pattern: /(知识库|搜索|查一下|查询|资料|总结.*文档|读取.*笔记|Obsidian|飞书文档|Google Drive)/i,
      tools: ["knowledge_search", "knowledge_read", "knowledge_write_note", "lark_inbox_complete_task"],
      risk: "low",
    },
    {
      type: "code",
      label: "代码任务",
      pattern: /(代码|bug|修复|测试|提交|PR|pull request|GitHub|仓库|commit|push)/i,
      tools: ["github_list_issues", "github_list_pull_requests", "github_create_pull_request"],
      risk: /提交|push|创建PR|create pull request|删除|改/.test(textValue) ? "medium" : "low",
    },
    {
      type: "data",
      label: "数据分析",
      pattern: /(SQLite|数据库|SQL|表格|数据|统计|分析|金额|支出|报表)/i,
      tools: ["sqlite_list_databases", "sqlite_list_tables", "sqlite_query_readonly", "knowledge_write_note", "lark_inbox_complete_task"],
      risk: "low",
    },
    {
      type: "web_research",
      label: "网页调研",
      pattern: /(网页|官网|搜索互联网|调研|价格|最新|资料来源|链接|web|search)/i,
      tools: ["web_search", "web_fetch", "knowledge_write_note", "lark_inbox_complete_task"],
      risk: "low",
    },
  ];
  const matched = rules.find((rule) => rule.pattern.test(textValue) || rule.pattern.test(lower));
  if (matched) {
    return {
      type: matched.type,
      label: matched.label,
      confidence: 0.82,
      risk: matched.risk,
      recommendedTools: matched.tools,
      reason: `Matched ${matched.label} keywords.`,
    };
  }
  return {
    type: "general",
    label: "通用任务",
    confidence: 0.45,
    risk: "manual_review",
    recommendedTools: ["knowledge_search", "knowledge_read", "lark_inbox_complete_task"],
    reason: "No specific task pattern matched; needs manual review.",
  };
}

function taskPlanFor(classification, task) {
  const title = task?.title || "未命名任务";
  const body = task?.task || String(task || "");
  const commonLastStep = "用 lark_inbox_complete_task 将结果写回飞书 AI 指令收件箱。";
  const plans = {
    content: [
      "用 content_brief_parse 解析写作主题、读者、风格、字数和约束。",
      "用 content_research 从 Obsidian/知识库检索相关素材。",
      "用 content_draft_pack 生成大纲、素材包和写作提示。",
      "由当前 AI 根据写作提示生成正文。",
      "用 content_publish_pack 生成标题备选、摘要、可发布排版和发布前检查。",
      commonLastStep,
    ],
    knowledge: [
      "用 knowledge_search 搜索本地 Obsidian；必要时 includeNetwork=true 扩展到飞书/Google Drive/网页。",
      "用 knowledge_read 精读关键结果。",
      "汇总答案，必要时用 knowledge_write_note 写回 Obsidian。",
      commonLastStep,
    ],
    daily_report: [
      "读取当天 Obsidian 日记或相关知识库记录。",
      "视需要查询 GitHub PR、飞书任务和日程。",
      "整理完成事项、问题、原因、解决方案和明日计划。",
      "写回 Obsidian 日报/复盘位置。",
      commonLastStep,
    ],
    code: [
      "读取仓库状态和相关 issue/PR。",
      "生成修改计划并运行测试。",
      "如涉及提交、推送或 PR，先确认范围和风险。",
      "完成后汇总代码变更、测试结果和 PR 链接。",
      commonLastStep,
    ],
    data: [
      "用 sqlite_list_databases 定位数据库。",
      "用 sqlite_list_tables 和 sqlite_describe_table 查看结构。",
      "用 sqlite_query_readonly 执行只读 SELECT/WITH 分析。",
      "生成结论和必要图表/表格说明。",
      commonLastStep,
    ],
    web_research: [
      "用 web_search 找候选来源。",
      "优先读取官方/权威页面。",
      "用 web_fetch 抽取正文并交叉核验。",
      "总结结论、来源链接和不确定性。",
      commonLastStep,
    ],
    general: [
      "人工阅读任务，确认目标和风险。",
      "优先用 knowledge_search 查已有资料。",
      "按任务内容选择合适 MCP 工具。",
      "执行前对写入、提交、删除、公开分享等动作再次确认。",
      commonLastStep,
    ],
  };
  return {
    title,
    task: body,
    classification,
    dryRun: true,
    executionMode: "semi_auto",
    steps: plans[classification.type] || plans.general,
    requiresConfirmation: ["medium", "high", "manual_review"].includes(classification.risk),
  };
}

function taskResultTemplate(task, classification) {
  return `## 执行结果

任务：${task?.title || "未命名任务"}
类型：${classification.label}
风险级别：${classification.risk}

### 结果摘要

- 

### 执行过程

1. 

### 产出链接 / 文件

- 

### 后续建议

- 
`;
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
    const headers = {
      "Authorization": `Bearer ${candidate.token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    };
    let response;
    let body;
    let parsed;
    try {
      if (webProxy) {
        parsed = await curlJson(url, {
          serviceName: "GitHub API",
          method: options.method,
          body: options.body,
          headers,
          proxy: webProxy,
        });
        if (parsed && typeof parsed === "object") {
          Object.defineProperty(parsed, "__tokenSource", {
            value: candidate.source,
            enumerable: false,
          });
        }
        return parsed;
      }
      response = await fetch(url, {
        ...options,
        headers,
      });
      body = await response.text();
    } catch (error) {
      try {
        parsed = await curlJson(url, {
          serviceName: "GitHub API",
          method: options.method,
          body: options.body,
          headers,
          proxy: webProxy,
        });
        if (parsed && typeof parsed === "object") {
          Object.defineProperty(parsed, "__tokenSource", {
            value: candidate.source,
            enumerable: false,
          });
        }
        return parsed;
      } catch (curlError) {
        failures.push(`${candidate.source}: ${error.message}; ${curlError.message}`);
      }
      continue;
    }
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
  const serviceName = options.serviceName || "HTTP API";

  let lastError;
  for (const proxy of proxyCandidates(options.proxy ?? googleProxy)) {
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

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await runCommand("curl", args, {
          input: options.body,
          timeoutMs: timeoutMs + 5_000,
          errorLabel: `${serviceName} curl request${proxy ? ` via ${proxy}` : ""}`,
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
  }
  throw lastError;
}

async function curlText(url, options = {}) {
  let lastError;
  for (const proxy of proxyCandidates(options.proxy ?? webProxy)) {
    const args = [
      "-sS",
      "-L",
      "--compressed",
      "--max-time",
      String(Math.ceil((options.timeoutMs || 45_000) / 1000)),
      "-A",
      options.userAgent || "personal-mcp/0.1 (+https://modelcontextprotocol.io)",
    ];
    if (proxy) args.push("-x", proxy);
    for (const [name, value] of Object.entries(options.headers || {})) {
      args.push("-H", `${name}: ${value}`);
    }
    args.push(url);
    try {
      const result = await runCommand("curl", args, {
        timeoutMs: options.timeoutMs || 45_000,
        errorLabel: `curl${proxy ? ` via ${proxy}` : ""}`,
      });
      return result.stdout;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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

function healthPayload(checks) {
  return {
    status: summarizeHealth(checks),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

async function probeObsidianHealth() {
  await fs.access(vaultRoot);
  const notes = await walkMarkdown(vaultRoot, { maxFiles: 3 });
  return {
    status: notes.length ? "ok" : "warn",
    vaultRoot,
    sampleNotes: notes.map((file) => path.relative(vaultRoot, file)),
  };
}

async function probeGoogleOAuthFilesHealth() {
  const token = await loadGoogleToken();
  await fs.access(googleCredentialsPath);
  return {
    status: token.refresh_token ? "ok" : "warn",
    credentialsPath: googleCredentialsPath,
    tokenPath: googleTokenPath,
    hasRefreshToken: Boolean(token.refresh_token),
    expiresAt: token.expires_at ? new Date(token.expires_at).toISOString() : null,
  };
}

async function probeSearchConfigHealth() {
  return {
    status: "ok",
    braveConfigured: Boolean(braveSearchApiKey),
    fallback: "bing-rss",
    proxy: webProxy || null,
    autoProxy: defaultLocalProxy || null,
  };
}

async function probeSqliteConfigHealth() {
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
}

async function probeGithubHealth() {
  const user = await githubRequest("/user");
  return {
    status: "ok",
    login: user.login,
    tokenSource: user.__tokenSource || "unknown",
    fallbackAvailable: (await githubTokenCandidates()).some((candidate) => candidate.source === "gh auth token"),
  };
}

async function probeLarkHealth() {
  const result = await runCommand("lark-cli", ["auth", "status"], { timeoutMs: 20_000 });
  const parsed = JSON.parse(result.stdout);
  const userStatus = parsed.identities?.user?.status;
  return {
    status: ["ready", "needs_refresh"].includes(userStatus) ? "ok" : "warn",
    userStatus,
    userName: parsed.identities?.user?.userName,
    botStatus: parsed.identities?.bot?.status,
  };
}

async function probeGoogleDriveHealth() {
  const profile = await googleRequest("https://www.googleapis.com/drive/v3/about?fields=user");
  return {
    status: "ok",
    displayName: profile.user?.displayName,
    emailAddress: profile.user?.emailAddress,
  };
}

async function probeWebSearchHealth() {
  const search = await webSearch("\"Model Context Protocol\"", { limit: 3, market: "en-US", backend: "auto" });
  return {
    status: search.results.length ? "ok" : "warn",
    backend: search.backend,
    results: search.results.length,
    braveConfigured: Boolean(braveSearchApiKey),
    attempts: search.attempts,
  };
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
    const result = await writeVaultMarkdown(notePath, content);
    if (result.status === "written") return text(`Wrote ${result.path}`);
    return json(result);
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
    section: z.string().default("").describe("Optional second-level heading to parse, e.g. 待处理."),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ markdown, status, section, limit }) => json(parseLarkInboxTasks(markdown, { status, section, limit })),
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
  try {
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
  } catch (error) {
    const outboxFile = await writeOutbox("lark", doc, markdown);
    return {
      ok: false,
      queued: true,
      outboxFile,
      error: error.message,
      note: "Lark document update failed in this runtime; content was saved to the MCP outbox.",
    };
  }
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
      tasks: parseLarkInboxTasks(markdown, { status, limit, section: "待处理" }),
    });
  },
);

server.tool(
  "lark_inbox_audit",
  "Audit a Feishu AI instruction inbox document for mobile-friendly structure and parsing safety.",
  {
    doc: z.string().describe("Feishu document URL or token for the AI instruction inbox."),
  },
  async ({ doc }) => {
    const markdown = await larkFetchMarkdown(doc);
    return json({
      doc,
      ...auditLarkInbox(markdown),
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
    sources: z.string().default("未指定"),
  },
  async ({ doc, title, task, priority, sources }) => {
    const markdown = await larkFetchMarkdown(doc);
    const updated = appendLarkInboxTask(markdown, { title, task, priority, sources });
    const response = await larkOverwriteMarkdown(doc, updated);
    return json({
      ok: Boolean(response.ok),
      queued: Boolean(response.queued),
      doc,
      title,
      revisionId: response.data?.document?.revision_id,
      url: response.data?.document?.url,
      outboxFile: response.outboxFile,
      note: response.note,
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
      queued: Boolean(response.queued),
      doc,
      title,
      status,
      revisionId: response.data?.document?.revision_id,
      url: response.data?.document?.url,
      outboxFile: response.outboxFile,
      note: response.note,
    });
  },
);

server.tool(
  "knowledge_sources",
  "List configured personal knowledge sources and their capabilities.",
  {},
  async () => json([
    {
      source: "obsidian",
      status: "local",
      capabilities: ["search", "read", "write"],
      root: vaultRoot,
    },
    {
      source: "lark",
      status: "network",
      capabilities: ["search", "read"],
      note: "Uses lark-cli Drive search and docs fetch.",
    },
    {
      source: "google_drive",
      status: "network",
      capabilities: ["search"],
      note: "Uses Google Drive metadata search.",
    },
    {
      source: "web",
      status: "network",
      capabilities: ["search", "read"],
      note: "Uses web_search/web_fetch backends.",
    },
  ]),
);

server.tool(
  "knowledge_search",
  "Search personal knowledge sources with one query. Defaults to local Obsidian only.",
  {
    query: z.string().min(1),
    sources: z.string().default("obsidian").describe("Comma-separated sources: obsidian,lark,google_drive,web."),
    limit: z.number().int().min(1).max(50).default(10),
    includeNetwork: z.boolean().default(false).describe("Allow network-backed sources. Obsidian is always local."),
  },
  async ({ query, sources, limit, includeNetwork }) => {
    const requested = parseKnowledgeSources(sources);
    const results = [];
    const errors = [];
    for (const source of requested) {
      const remaining = Math.max(1, limit - results.length);
      try {
        if (source === "obsidian") {
          results.push(...await searchObsidianKnowledge(query, { limit: remaining }));
        } else if (!includeNetwork) {
          errors.push({ source, error: "Network-backed source skipped because includeNetwork=false." });
        } else if (source === "lark") {
          results.push(...await searchLarkKnowledge(query, { limit: remaining }));
        } else if (source === "google_drive") {
          results.push(...await searchGoogleDriveKnowledge(query, { limit: remaining }));
        } else if (source === "web") {
          results.push(...await searchWebKnowledge(query, { limit: remaining }));
        } else {
          errors.push({ source, error: "Unknown knowledge source." });
        }
      } catch (error) {
        errors.push({ source, error: error.message });
      }
      if (results.length >= limit) break;
    }
    return json({ query, sources: requested, results: results.slice(0, limit), errors });
  },
);

server.tool(
  "knowledge_read",
  "Read one knowledge item by source and id/path/url.",
  {
    source: z.enum(["obsidian", "lark", "web"]),
    id: z.string().describe("Obsidian note path, Feishu doc URL/token, or web URL."),
    maxChars: z.number().int().min(500).max(50000).default(12000),
  },
  async ({ source, id, maxChars }) => {
    if (source === "obsidian") {
      const file = ensureInsideVault(id);
      const content = await fs.readFile(file, "utf8");
      return json({
        source,
        id,
        title: path.basename(id, ".md"),
        chars: content.length,
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars,
      });
    }
    if (source === "lark") {
      const content = await larkFetchMarkdown(id);
      return json({
        source,
        id,
        chars: content.length,
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars,
      });
    }
    const parsed = assertHttpUrl(id);
    const html = await curlText(parsed.toString(), {
      userAgent: "Mozilla/5.0 (compatible; personal-mcp/0.1)",
    });
    const content = stripHtml(html);
    return json({
      source,
      id: parsed.toString(),
      chars: content.length,
      content: content.slice(0, maxChars),
      truncated: content.length > maxChars,
    });
  },
);

server.tool(
  "knowledge_write_note",
  "Write a Markdown note into the Obsidian knowledge vault.",
  {
    notePath: z.string().describe("Vault-relative markdown path."),
    title: z.string().optional(),
    content: z.string(),
    mode: z.enum(["overwrite", "append"]).default("overwrite"),
  },
  async ({ notePath, title, content, mode }) => {
    const body = title ? `# ${title}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    const result = await writeVaultMarkdown(notePath, body, { mode });
    return json({
      source: "obsidian",
      path: result.path,
      mode,
      bytes: Buffer.byteLength(body),
      status: result.status,
      outboxFile: result.outboxFile,
      note: result.note,
    });
  },
);

server.tool(
  "content_brief_parse",
  "Parse a Chinese content-writing request into a structured brief.",
  {
    input: z.string().min(1).describe("Raw content request, e.g. from Feishu AI inbox."),
  },
  async ({ input }) => json(parseContentBrief(input)),
);

server.tool(
  "content_outline",
  "Create a reusable article outline from a structured or raw writing brief.",
  {
    brief: z.string().min(1).describe("Raw request or JSON/stringified structured brief."),
  },
  async ({ brief }) => {
    let parsed;
    try {
      parsed = JSON.parse(brief);
    } catch {
      parsed = parseContentBrief(brief);
    }
    return json({ brief: parsed, outline: contentOutline(parsed) });
  },
);

server.tool(
  "content_research",
  "Search knowledge sources for materials related to a content brief.",
  {
    brief: z.string().min(1),
    sources: z.string().default("obsidian"),
    limit: z.number().int().min(1).max(20).default(5),
    includeNetwork: z.boolean().default(false),
  },
  async ({ brief, sources, limit, includeNetwork }) => {
    const parsed = parseContentBrief(brief);
    const requested = parseKnowledgeSources(sources);
    const results = [];
    const errors = [];
    for (const source of requested) {
      const remaining = Math.max(1, limit - results.length);
      try {
        if (source === "obsidian") {
          results.push(...await searchObsidianKnowledge(parsed.topic, { limit: remaining }));
        } else if (!includeNetwork) {
          errors.push({ source, error: "Network-backed source skipped because includeNetwork=false." });
        } else if (source === "lark") {
          results.push(...await searchLarkKnowledge(parsed.topic, { limit: remaining }));
        } else if (source === "google_drive") {
          results.push(...await searchGoogleDriveKnowledge(parsed.topic, { limit: remaining }));
        } else if (source === "web") {
          results.push(...await searchWebKnowledge(parsed.topic, { limit: remaining }));
        } else {
          errors.push({ source, error: "Unknown knowledge source." });
        }
      } catch (error) {
        errors.push({ source, error: error.message });
      }
      if (results.length >= limit) break;
    }
    return json({ brief: parsed, results: results.slice(0, limit), errors });
  },
);

server.tool(
  "content_draft_pack",
  "Generate an article drafting pack: brief, outline, materials, and drafting prompt.",
  {
    brief: z.string().min(1),
    materialsJson: z.string().default("[]").describe("Optional JSON array of materials from content_research/knowledge_search."),
  },
  async ({ brief, materialsJson }) => {
    const parsed = parseContentBrief(brief);
    let materials = [];
    try {
      materials = JSON.parse(materialsJson);
      if (!Array.isArray(materials)) materials = [];
    } catch {}
    const outline = contentOutline(parsed);
    return json({
      brief: parsed,
      outline,
      draftingPrompt: contentDraftScaffold(parsed, outline, materials),
    });
  },
);

server.tool(
  "content_publish_pack",
  "Create a WeChat Official Account publishing package from a brief and draft.",
  {
    brief: z.string().min(1),
    draft: z.string().default(""),
  },
  async ({ brief, draft }) => {
    const parsed = parseContentBrief(brief);
    return json({ brief: parsed, ...contentPublishPack(parsed, draft) });
  },
);

server.tool(
  "content_save_to_obsidian",
  "Save generated content to the Obsidian knowledge vault.",
  {
    notePath: z.string().describe("Vault-relative markdown path."),
    brief: z.string().min(1),
    draft: z.string().min(1),
  },
  async ({ notePath, brief, draft }) => {
    const parsed = parseContentBrief(brief);
    const pack = contentPublishPack(parsed, draft);
    const body = `${pack.layout}

---

## 写作 Brief

\`\`\`json
${JSON.stringify(parsed, null, 2)}
\`\`\`
`;
    const result = await writeVaultMarkdown(notePath, body);
    return json({
      source: "obsidian",
      path: result.path,
      title: pack.titles[0],
      bytes: Buffer.byteLength(body),
      status: result.status,
      outboxFile: result.outboxFile,
      note: result.note,
    });
  },
);

server.tool(
  "task_classify",
  "Classify a task into a semi-automated workflow type.",
  {
    task: z.string().min(1),
  },
  async ({ task }) => json(classifyTaskText(task)),
);

server.tool(
  "task_plan",
  "Create a dry-run execution plan for a task. This does not execute the task.",
  {
    title: z.string().default("未命名任务"),
    task: z.string().min(1),
  },
  async ({ title, task }) => {
    const classification = classifyTaskText(`${title}\n${task}`);
    return json(taskPlanFor(classification, { title, task }));
  },
);

server.tool(
  "task_result_template",
  "Create a standard result template for a task classification.",
  {
    title: z.string().default("未命名任务"),
    task: z.string().min(1),
  },
  async ({ title, task }) => {
    const classification = classifyTaskText(`${title}\n${task}`);
    return text(taskResultTemplate({ title, task }, classification));
  },
);

server.tool(
  "task_dispatch_pending",
  "Fetch pending Feishu AI inbox tasks and return semi-automatic dispatch plans. Does not execute tasks.",
  {
    doc: z.string().describe("Feishu AI instruction inbox document URL or token."),
    limit: z.number().int().min(1).max(50).default(10),
    status: z.string().default("待处理"),
  },
  async ({ doc, limit, status }) => {
    const markdown = await larkFetchMarkdown(doc);
    const tasks = parseLarkInboxTasks(markdown, { status, limit, section: "待处理" });
    const dispatches = tasks.map((task) => {
      const classification = classifyTaskText(`${task.title}\n${task.task}`);
      return {
        task,
        plan: taskPlanFor(classification, task),
        resultTemplate: taskResultTemplate(task, classification),
      };
    });
    return json({
      doc,
      status,
      mode: "semi_auto",
      note: "This tool only classifies and plans. The current AI must execute the recommended tools and write results back.",
      count: dispatches.length,
      dispatches,
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
    checks.push(await runHealthProbe("obsidian", probeObsidianHealth));
    checks.push(await runHealthProbe("google_oauth_files", probeGoogleOAuthFilesHealth));
    checks.push(await runHealthProbe("search_config", probeSearchConfigHealth));
    checks.push(await runHealthProbe("sqlite_config", probeSqliteConfigHealth));

    if (includeNetwork) {
      checks.push(await runHealthProbe("github", probeGithubHealth));
      checks.push(await runHealthProbe("lark", probeLarkHealth));
      checks.push(await runHealthProbe("google_drive", probeGoogleDriveHealth));
      checks.push(await runHealthProbe("web_search", probeWebSearchHealth));
    }

    return json(healthPayload(checks));
  },
);

server.tool(
  "mcp_health_local",
  "Run local-only health checks for files, OAuth token files, search config, and SQLite roots.",
  {},
  async () => {
    const checks = [
      await runHealthProbe("obsidian", probeObsidianHealth),
      await runHealthProbe("google_oauth_files", probeGoogleOAuthFilesHealth),
      await runHealthProbe("search_config", probeSearchConfigHealth),
      await runHealthProbe("sqlite_config", probeSqliteConfigHealth),
    ];
    return json(healthPayload(checks));
  },
);

server.tool(
  "mcp_health_github",
  "Run the GitHub MCP health check only.",
  {},
  async () => {
    const checks = [await runHealthProbe("github", probeGithubHealth)];
    return json(healthPayload(checks));
  },
);

server.tool(
  "mcp_health_lark",
  "Run the Lark/Feishu auth health check only.",
  {},
  async () => {
    const checks = [await runHealthProbe("lark", probeLarkHealth)];
    return json(healthPayload(checks));
  },
);

server.tool(
  "mcp_health_google",
  "Run Google OAuth file and Drive API health checks only.",
  {},
  async () => {
    const checks = [
      await runHealthProbe("google_oauth_files", probeGoogleOAuthFilesHealth),
      await runHealthProbe("google_drive", probeGoogleDriveHealth),
    ];
    return json(healthPayload(checks));
  },
);

server.tool(
  "mcp_health_web",
  "Run web search configuration and live search health checks only.",
  {},
  async () => {
    const checks = [
      await runHealthProbe("search_config", probeSearchConfigHealth),
      await runHealthProbe("web_search", probeWebSearchHealth),
    ];
    return json(healthPayload(checks));
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
