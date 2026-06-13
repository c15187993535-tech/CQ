#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outboxRoot = path.resolve(process.env.PERSONAL_MCP_OUTBOX || path.join(projectRoot, "outbox"));
const vaultRoot = path.resolve(process.env.OBSIDIAN_VAULT_PATH || "/Users/mac/Desktop/知识库");

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const files = [];
  if (!(await exists(dir))) return files;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function syncObsidian() {
  const sourceRoot = path.join(outboxRoot, "obsidian");
  const files = await walk(sourceRoot);
  const synced = [];
  for (const source of files) {
    const rel = path.relative(sourceRoot, source);
    const target = path.resolve(vaultRoot, rel);
    if (!target.startsWith(vaultRoot + path.sep)) {
      throw new Error(`Refusing to sync outside vault: ${rel}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    synced.push({ source, target });
  }
  return synced;
}

async function main() {
  const obsidian = await syncObsidian();
  const lark = await walk(path.join(outboxRoot, "lark"));

  console.log(JSON.stringify({
    ok: true,
    vaultRoot,
    outboxRoot,
    obsidianSynced: obsidian.length,
    obsidian,
    larkPending: lark.length,
    lark,
    note: lark.length
      ? "Lark outbox files need a valid lark-cli session and document target before manual update."
      : undefined,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
