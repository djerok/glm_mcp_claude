#!/usr/bin/env node
// install.mjs -- one-shot installer for the GLM hybrid setup.
// Installs GLM as a cheap, full-capability subagent for Claude Code, with auto-routing.
//
// Usage:
//   node install.mjs                       # install for the current user (global)
//   node install.mjs --key YOUR_ZAI_KEY    # also write the API key into .env
//   node install.mjs --claude-dir PATH     # target a custom .claude dir (default ~/.claude)
//   node install.mjs --no-register         # skip `claude mcp add` (do it manually)
//   node install.mjs --skip-npm            # skip `npm install` (deps already present)
//
// It is idempotent: re-running updates files without duplicating hook/policy entries.

import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const SELF = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getFlag = (n) => args.includes(n);
const getOpt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const CLAUDE = getOpt("--claude-dir") || join(homedir(), ".claude");
const KEY = getOpt("--key") || process.env.GLM_API_KEY || "";
const NO_REGISTER = getFlag("--no-register");
const SKIP_NPM = getFlag("--skip-npm");

const log = (s) => console.log(s);
const step = (s) => console.log(`\n→ ${s}`);

log(`GLM hybrid installer`);
log(`  source : ${SELF}`);
log(`  target : ${CLAUDE}`);

// 1. Copy the MCP server (skip node_modules and any stray .env).
step("Installing MCP server -> " + join(CLAUDE, "glm-mcp"));
mkdirSync(CLAUDE, { recursive: true });
cpSync(join(SELF, "glm-mcp"), join(CLAUDE, "glm-mcp"), {
  recursive: true,
  filter: (src) => {
    const base = src.split(/[\\/]/).pop();
    return base !== "node_modules" && base !== ".env";
  },
});

// 2. .env
step("Setting up .env");
const envPath = join(CLAUDE, "glm-mcp", ".env");
if (!existsSync(envPath)) {
  copyFileSync(join(CLAUDE, "glm-mcp", ".env.example"), envPath);
  log("  created .env from .env.example");
}
if (KEY) {
  let env = readFileSync(envPath, "utf8");
  env = /^GLM_API_KEY=/m.test(env)
    ? env.replace(/^GLM_API_KEY=.*$/m, `GLM_API_KEY=${KEY}`)
    : `GLM_API_KEY=${KEY}\n` + env;
  writeFileSync(envPath, env);
  log("  wrote GLM_API_KEY into .env");
} else if (!/^GLM_API_KEY=\S+/m.test(readFileSync(envPath, "utf8"))) {
  log("  ⚠ No API key set yet. Edit " + envPath + " and set GLM_API_KEY=... before use.");
}

// 3. npm install
if (!SKIP_NPM) {
  step("Installing dependencies (npm install)");
  execSync("npm install --no-audit --no-fund", { cwd: join(CLAUDE, "glm-mcp"), stdio: "inherit" });
}

// 4. Subagent + hook
step("Installing subagent and auto-delegation hook");
mkdirSync(join(CLAUDE, "agents"), { recursive: true });
mkdirSync(join(CLAUDE, "hooks"), { recursive: true });
copyFileSync(join(SELF, "agents", "glm.md"), join(CLAUDE, "agents", "glm.md"));
copyFileSync(join(SELF, "hooks", "glm_subagent_router.mjs"), join(CLAUDE, "hooks", "glm_subagent_router.mjs"));
log("  agents/glm.md, hooks/glm_subagent_router.mjs");

// 4b. Optional full-GLM launcher (`glm-code`) — runs the whole session on GLM (~100% GLM, no Opus).
try {
  copyFileSync(join(SELF, "glm-code.mjs"), join(CLAUDE, "glm-code.mjs"));
  writeFileSync(join(CLAUDE, "glm-code.cmd"), '@echo off\r\nnode "%~dp0glm-code.mjs" %*\r\n');
  writeFileSync(join(CLAUDE, "glm-code"), '#!/bin/sh\nexec node "$(dirname "$0")/glm-code.mjs" "$@"\n');
  log("  glm-code launcher (full-GLM mode) -> run: node ~/.claude/glm-code.mjs");
} catch {}

// 5. Merge the PreToolUse hook into settings.json (idempotent, with backup).
step("Wiring the hook into settings.json");
const settingsPath = join(CLAUDE, "settings.json");
let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { settings = {}; }
  writeFileSync(settingsPath + ".bak-" + Date.now(), readFileSync(settingsPath));
}
const hookCmd = `node "${join(CLAUDE, "hooks", "glm_subagent_router.mjs").replace(/\\/g, "/")}"`;
settings.hooks ||= {};
settings.hooks.PreToolUse ||= [];
const already = settings.hooks.PreToolUse.some((e) =>
  (e.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("glm_subagent_router"))
);
if (!already) {
  settings.hooks.PreToolUse.push({ matcher: "Task", hooks: [{ type: "command", command: hookCmd }] });
  log("  added PreToolUse(Task) -> glm_subagent_router");
} else {
  log("  hook already present (left as-is)");
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

// 6. Append the global delegation policy (idempotent).
step("Adding global delegation policy to CLAUDE.md");
const claudeMd = join(CLAUDE, "CLAUDE.md");
const policy = `\n# Delegation (GLM hybrid)\n\nPrefer offloading well-specified, self-contained subtasks to GLM. When you spawn a subagent (the\n\`Task\` tool), a PreToolUse hook injects a \`[GLM router]\` line advising GLM vs Opus -- follow it.\nIf the user explicitly named an agent, honor it. Full rules: \`~/.claude/glm-mcp/README.md\`.\n\n**To actually spend GLM tokens (not Claude tokens): call \`mcp__glm__glm_agent\` directly** for repo\nwork, or \`mcp__glm__glm_delegate\` for pure generation. Prefer calling \`glm_agent\` directly over the\n\`glm\` subagent (which runs on Haiku -- its own writing spends Claude tokens; only the glm_* tools\nspend GLM).\n\n## Maximize GLM's share (you are the expensive one)\nThe main agent is Claude, so keep the burden on GLM: delegate WHOLE tasks, not pre-chewed slivers.\nFor ANY implementation/codegen/edit/refactor/test/docs/analysis task, your FIRST move is\n\`mcp__glm__glm_agent\` with the goal + workdir -- do NOT read/analyze the files yourself first (that\nburns Claude tokens); let GLM read/write/run end-to-end. Spend your own tokens only on understanding\nthe request, delegating, a brief check of the result, and the hard-override cases. Bigger hand-offs\n= more burden on GLM; when unsure, delegate more and do less yourself.\n`;
const existing = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
if (!existing.includes("[GLM router]")) {
  writeFileSync(claudeMd, existing + policy);
  log("  policy appended");
} else {
  log("  policy already present");
}

// 7. Register the MCP server (user scope) via the claude CLI.
if (!NO_REGISTER) {
  step("Registering MCP server with Claude Code (user scope)");
  const idx = join(CLAUDE, "glm-mcp", "src", "index.js").replace(/\\/g, "/");
  try {
    try { execSync("claude mcp remove glm -s user", { stdio: "ignore" }); } catch {}
    execSync(`claude mcp add glm -s user -- node "${idx}"`, { stdio: "inherit" });
    log("  registered (key is read from .env).");
  } catch (e) {
    log("  ⚠ Could not run `claude mcp add` (" + e.message + ").");
    log("  Register manually:");
    log(`    claude mcp add glm -s user -- node "${idx}"`);
  }
}

log("\n✅ Done. Next steps:");
log("  1. Ensure GLM_API_KEY is set in " + envPath);
log("  2. RESTART Claude Code, then run `glm_status` to verify (api_key_loaded: true).");
log("  3. Your main agent stays on whatever model Claude Code uses; GLM handles delegated subtasks.");
