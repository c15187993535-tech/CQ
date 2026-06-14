#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const configDir = path.resolve(process.env.GOOGLE_MCP_CONFIG_DIR || path.join(process.env.HOME || ".", ".config", "personal-mcp"));
const credentialsPath = path.resolve(process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(configDir, "google_credentials.json"));
const tokenPath = path.resolve(process.env.GOOGLE_OAUTH_TOKEN || path.join(configDir, "google_token.json"));
const googleProxy = process.env.GOOGLE_MCP_PROXY || "";
const scopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
];

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function loadCredentials() {
  let raw;
  try {
    raw = await readJson(credentialsPath);
  } catch {
    throw new Error(`Missing Google OAuth credentials at ${credentialsPath}`);
  }
  const config = raw.installed || raw.web;
  if (!config?.client_id || !config?.client_secret) {
    throw new Error("Credentials file must include installed or web client_id/client_secret.");
  }
  return {
    clientId: config.client_id,
    clientSecret: config.client_secret,
    redirectUri: config.redirect_uris?.[0] || "http://localhost",
  };
}

async function curlJson(url, options = {}) {
  const args = ["-sS"];
  if (googleProxy) args.push("-x", googleProxy);
  if (options.method) args.push("-X", options.method);
  for (const [name, value] of Object.entries(options.headers || {})) {
    args.push("-H", `${name}: ${value}`);
  }
  if (options.body !== undefined) args.push("--data-binary", "@-");
  args.push(url);

  const result = await new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`curl failed with ${code}: ${stderr || stdout}`));
    });
    if (options.body !== undefined) child.stdin.write(options.body);
    child.stdin.end();
  });

  const body = JSON.parse(result.stdout);
  if (body?.error) {
    throw new Error(`Token exchange failed: ${body.error_description || body.error}`);
  }
  return body;
}

function usage() {
  console.log(`Usage:
  npm run google:auth-url
  npm run google:token -- "<authorization-code>"

Files:
  credentials: ${credentialsPath}
  token:       ${tokenPath}

Optional:
  GOOGLE_MCP_PROXY=http://127.0.0.1:7897`);
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  const credentials = await loadCredentials();

  if (command === "url") {
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: credentials.redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
    });
    console.log(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    return;
  }

  if (command === "token") {
    const code = process.argv[3];
    if (!code) throw new Error("Missing authorization code.");
    const params = new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: credentials.redirectUri,
      grant_type: "authorization_code",
    });
    const body = await curlJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const token = {
      ...body,
      expires_at: Date.now() + ((body.expires_in || 3600) * 1000),
    };
    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    await fs.writeFile(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
    console.log(`Saved Google OAuth token to ${tokenPath}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
