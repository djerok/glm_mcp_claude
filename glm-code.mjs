#!/usr/bin/env node
// glm-code.mjs — launch Claude Code with the ENTIRE session running on GLM (main model = GLM).
// This is "full-GLM mode": ~100% of tokens go to GLM, ~zero to Claude, because GLM *is* the agent.
// Trade-off: no Opus/Claude in the loop at all (no Opus-quality orchestration or oversight).
//
// Your normal `claude` command is untouched (stays hybrid: Opus main + GLM delegate).
// Usage:  node glm-code.mjs [any claude args]     (or via the glm-code.cmd wrapper)
//
// It reads your GLM key + endpoint from ~/.claude/glm-mcp/.env (falls back to env vars).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// --- load key/endpoint from the MCP .env ---
const envPath = join(homedir(), ".claude", "glm-mcp", ".env");
const cfg = {};
try {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    cfg[m[1]] = v;
  }
} catch {}

const KEY = cfg.GLM_API_KEY || process.env.GLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
const BASE = cfg.GLM_BASE_URL || process.env.GLM_BASE_URL || "https://api.z.ai/api/anthropic";
if (!KEY) {
  console.error("No GLM key found. Set GLM_API_KEY in ~/.claude/glm-mcp/.env");
  process.exit(1);
}

// Model aliases: everything Claude Code asks for (opus/sonnet/haiku) -> GLM models.
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: BASE,
  ANTHROPIC_AUTH_TOKEN: KEY,
  ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.GLM_OFFPEAK_MODEL || "glm-5.2",
  ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.GLM_OFFPEAK_MODEL || "glm-5.2",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.GLM_CHEAP_MODEL || "glm-4.5-air",
  API_TIMEOUT_MS: cfg.API_TIMEOUT_MS || "3000000",
};

console.error("⚡ Launching Claude Code in FULL-GLM mode (main model = GLM, ~100% GLM tokens, no Opus). Endpoint: " + BASE);
const r = spawnSync("claude", process.argv.slice(2), { stdio: "inherit", env, shell: true });
process.exit(r.status ?? 0);
