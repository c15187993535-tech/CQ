#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const home = process.env.HOME || ".";
const downloadsDir = path.join(home, "Downloads");
const configDir = path.resolve(process.env.GOOGLE_MCP_CONFIG_DIR || path.join(home, ".config", "personal-mcp"));
const targetPath = path.resolve(process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(configDir, "google_credentials.json"));

function looksLikeOAuthCredentials(json) {
  const config = json.installed || json.web;
  return Boolean(config?.client_id && config?.client_secret);
}

async function main() {
  const entries = await fs.readdir(downloadsDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    if (!/(client_secret|credentials|oauth)/i.test(entry.name)) continue;
    const fullPath = path.join(downloadsDir, entry.name);
    const stat = await fs.stat(fullPath);
    candidates.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    try {
      const json = JSON.parse(await fs.readFile(candidate.fullPath, "utf8"));
      if (!looksLikeOAuthCredentials(json)) continue;
      await fs.mkdir(configDir, { recursive: true });
      await fs.copyFile(candidate.fullPath, targetPath);
      await fs.chmod(targetPath, 0o600);
      console.log(`Imported ${candidate.fullPath}`);
      console.log(`Saved to ${targetPath}`);
      return;
    } catch {
      // Keep scanning candidates.
    }
  }

  console.error(`No Google OAuth credential JSON found in ${downloadsDir}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

