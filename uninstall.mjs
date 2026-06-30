#!/usr/bin/env node
// uninstall.mjs -- removes what install.mjs added.
//   node uninstall.mjs                 # remove from ~/.claude
//   node uninstall.mjs --claude-dir P  # custom dir
//   node uninstall.mjs --purge         # also delete the glm-mcp server folder (and your .env!)

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const getOpt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const CLAUDE = getOpt("--claude-dir") || join(homedir(), ".claude");
const PURGE = args.includes("--purge");

console.log("Uninstalling GLM hybrid from " + CLAUDE);

try { execSync("claude mcp remove glm -s user", { stdio: "inherit" }); } catch { console.log("  (claude mcp remove skipped/failed)"); }

const settingsPath = join(CLAUDE, "settings.json");
if (existsSync(settingsPath)) {
  try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (s.hooks?.PreToolUse) {
      s.hooks.PreToolUse = s.hooks.PreToolUse.filter(
        (e) => !(e.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("glm_subagent_router"))
      );
      if (!s.hooks.PreToolUse.length) delete s.hooks.PreToolUse;
      writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
      console.log("  removed hook from settings.json");
    }
  } catch (e) { console.log("  settings.json edit failed: " + e.message); }
}

for (const f of [join(CLAUDE, "agents", "glm.md"), join(CLAUDE, "hooks", "glm_subagent_router.mjs")]) {
  if (existsSync(f)) { rmSync(f); console.log("  removed " + f); }
}

if (PURGE && existsSync(join(CLAUDE, "glm-mcp"))) {
  rmSync(join(CLAUDE, "glm-mcp"), { recursive: true, force: true });
  console.log("  purged glm-mcp/ (including .env)");
}

console.log("\nNote: the '# Delegation (GLM hybrid)' block in CLAUDE.md was left in place -- remove it by hand if you want.");
console.log("Done. Restart Claude Code.");
