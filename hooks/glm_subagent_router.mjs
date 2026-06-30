#!/usr/bin/env node
// glm_subagent_router.mjs
// PreToolUse hook for the Task (subagent) tool. Fires ONLY when a subagent is
// about to be spawned -> zero token cost the rest of the time.
//
// It infers the task profile from the Task description/prompt, runs the shared
// GLM-vs-Opus router logic, and injects a concise verdict as additionalContext
// so the orchestrator can route cheap work to the `glm` subagent automatically.
//
// It NEVER blocks: on any error or unsupported field it simply exits 0.

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

// Portable: resolve the router relative to this hook's own location.
// Layout: <claude>/hooks/glm_subagent_router.mjs  +  <claude>/glm-mcp/src/router.js
const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = resolve(HERE, "..", "glm-mcp", "src", "router.js");
const MCP_ENV = resolve(HERE, "..", "glm-mcp", ".env");

// Load the MCP server's .env so the hook honors the SAME settings the server uses
// (GLM_COST_BIAS, GLM_USE_HAIKU, peak window, ...). Best-effort; safe if the file is absent.
function loadMcpEnv() {
  try {
    for (const line of readFileSync(MCP_ENV, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {}
}

// Pull the most recent genuine human message from the transcript (skipping
// tool_result turns), so we can detect when the user explicitly picked an agent.
function lastUserText(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const m = o.message || o;
      if (o.type === "user" || m.role === "user") {
        const c = m.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          const texts = c.filter((b) => b && b.type === "text").map((b) => b.text);
          if (texts.length) return texts.join("\n"); // else it's a tool_result turn -> keep scanning
        }
      }
    }
  } catch {}
  return "";
}

// Did the user explicitly name an agent/model to use? Then honor it -- no nudge.
function explicitAgentRequested(text) {
  const t = (text || "").toLowerCase();
  return (
    /\b(use|using|with|via|run (?:this|it) (?:on|with)|delegate (?:this |it )?to|hand (?:this|it) to|switch to)\b[^.\n]*\b(glm|opus|sonnet|haiku|general[- ]purpose|explore|plan)\b/.test(t) ||
    /\b(glm|opus|sonnet|haiku|general[- ]purpose)\b\s+(agent|sub-?agent|model)\b/.test(t)
  );
}

function readStdin() {
  return new Promise((resolve) => {
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    // safety: if no stdin arrives, don't hang
    setTimeout(() => resolve(d), 2000);
  });
}

function inferProfile(text) {
  const t = (text || "").toLowerCase();
  const has = (...ks) => ks.some((k) => t.includes(k));
  const extra = {};

  // Cross-cutting condition flags (can co-exist with a task type).
  if (has("screenshot", "image", "diagram", "this photo", "the picture", "gui ", "computer use")) extra.vision = true;
  if (has("中文", "chinese", "mandarin", "bilingual", "translate to chinese")) extra.chinese = true;
  if (has("undocumented", "internal api", "proprietary api", "niche", "obscure api", "post-cutoff", "brand-new api", "newly released")) extra.unfamiliarApi = true;
  if (has("parallel", "concurrent", "fan out", "fan-out", "at the same time", "multiple agents")) extra.needsParallel = true;
  if (has("entire repo", "whole codebase", "across the codebase", "many files", "multi-hour", "long-running", "fully autonomous")) { extra.longHorizon = true; }
  // tool-use shape: heavy/dependent agentic loop -> Opus; one-shot/short -> GLM
  if (has("agent loop", "agentic", "many tool calls", "multi-step tool", "orchestrate tools", "chain of tool", "dependent tool", "tool-heavy", "long tool")) extra.toolPattern = "heavy";
  else if (has("single tool call", "one tool call", "structured extraction", "function call", "json schema", "extract fields")) extra.toolPattern = "single";

  // Hard-sensitive short-circuit.
  if (has("secret", "password", "credential", "api key", "private key", " auth", "authentication", "oauth", "crypto", "encrypt", "vulnerab", "proprietary", "security review"))
    return { taskType: "security", sensitive: true, ...extra };

  // Task type (first match wins; order = specificity).
  let taskType = "general";
  if (extra.toolPattern === "heavy") taskType = "toolcall_heavy";
  else if (has("migration", "migrate the database", "schema migration", "alembic", "flyway")) taskType = "migration";
  else if (has("code review", "review this diff", "review the pr", "review my code")) taskType = "code_review";
  else if (has("terraform", "kubernetes", "k8s", "helm", "dockerfile", "infrastructure as code", "cloudformation")) taskType = "iac";
  else if (has("github actions", "ci/cd", "ci pipeline", "gitlab ci", "jenkins", "workflow yaml")) taskType = "cicd";
  else if (has("sql", "query the", "select ", "join ", "optimize the query")) taskType = "sql";
  else if (has("regex", "regular expression")) taskType = "regex";
  else if (has("etl", "data pipeline", "ingest", "transform the data")) taskType = "etl";
  else if (has("integration test", "e2e", "end-to-end test")) taskType = "integration_test";
  else if (has("unit test", "write tests", "test coverage", "pytest", "jest", "vitest")) taskType = "unit_test";
  else if (has("type error", "typescript error", "lint", "eslint", "mypy", "type fix")) taskType = "type_lint";
  else if (has("upgrade", "bump version", "migrate to v", "dependency", "deprecat")) taskType = "dependency_upgrade";
  else if (has("performance", "optimize the", "speed up", "bottleneck", "profil")) taskType = "perf";
  else if (has("integrate with", "third-party api", "external api", "sdk for", "api integration")) taskType = "api_integration";
  else if (has("rust", "golang", " go ", "c++", "concurrency", "mutex", "memory safety", "data race")) taskType = "systems";
  else if (has("translate", "i18n", "localization", "localize")) taskType = "i18n";
  else if (has("notebook", "jupyter", "exploratory", "eda", "pandas analysis")) taskType = "notebook";
  else if (has("train a model", "training loop", "ml model", "fine-tune", "neural network")) taskType = "ml_training";
  else if (has("cli", "shell script", "bash script", "automation script")) taskType = "cli";
  else if (has("frontend", "react", "component", "css", "tailwind", " ui", "button", "styling", "html", "landing page", "dashboard")) taskType = "frontend";
  else if (has("boilerplate", "scaffold", "template", "stub", "starter")) taskType = "boilerplate";
  else if (has("config file", "yaml config", "set up config", ".env", "settings file")) taskType = "config";
  else if (has("prototype", "proof of concept", "poc", "quick demo", "mvp")) taskType = "prototype";
  else if (has("crud", "endpoint", "rest api", "data model")) taskType = "crud";
  else if (has("refactor")) taskType = has("large", "entire", "whole", "across the", "codebase-wide", "many files") ? "refactor_large" : "refactor_local";
  else if (has("debug", "why is", "not working", "stack trace", "root cause", "fix the bug", "intermittent")) taskType = "debugging";
  else if (has("architect", "system design", "high-level design", "trade-off", "tradeoff", "design the system")) taskType = "architecture";
  else if (has("document", "readme", "docstring", "changelog", "comment the")) taskType = "docs";
  else if (has("summar", "research", "find out", "look up", "investigate", "gather")) taskType = "research";
  else if (has("algorithm", "leetcode", "competitive programming", "time complexity", "dynamic programming")) taskType = "algorithm";
  else if (extra.toolPattern === "single") taskType = "toolcall_single";

  if (has("large", "entire", "whole codebase", "complex", "subtle", "tricky")) extra.complexity = "high";

  return { taskType, ...extra };
}

(async () => {
  try {
    loadMcpEnv(); // honor .env settings before importing the router
    const raw = await readStdin();
    const payload = JSON.parse(raw || "{}");
    const ti = payload.tool_input || {};
    const subagent = ti.subagent_type || "";

    // Already routing to the GLM delegate -> nothing to advise.
    if (subagent === "glm") process.exit(0);

    // User explicitly chose an agent/model ("use opus", "use the sonnet agent", ...)
    // -> honor their choice, do not inject a recommendation.
    if (explicitAgentRequested(lastUserText(payload.transcript_path))) process.exit(0);

    const text = [ti.description, ti.prompt].filter(Boolean).join("\n");
    const profile = inferProfile(text);
    const cwd = payload.cwd || "<the project root absolute path>";
    // Is this hands-on repo work (edit/create/run files) vs pure text generation?
    const pureText = ["research", "summarization"].includes(profile.taskType) ||
      /\b(explain|summari[sz]e|what is|describe|brainstorm|outline|draft an? (email|message|note))\b/.test(text.toLowerCase());
    const repoTask = !pureText;

    let verdict, peakNote = "";
    try {
      const { recommend, isPeak, USE_HAIKU } = await import(pathToFileURL(ROUTER).href);
      const rec = recommend(profile);
      const peak = isPeak();
      peakNote = peak
        ? `Currently CHINA PEAK (14:00-18:00 UTC+8): GLM-5.2 costs ~3x now, so the router routes LESS to GLM during peak (only stronger-fit tasks go to GLM).`
        : `Currently OFF-PEAK in China: "auto" uses GLM-5.2 (best capability, cheapest now).`;
      if (rec.engine !== "glm") {
        verdict = `KEEP ON OPUS (inferred: ${profile.taskType}, confidence ${rec.confidence}). Why: ${rec.reasons[0] || ""}`;
      } else if (repoTask) {
        // Hands-on repo task -> call glm_agent DIRECTLY (the only path that spends GLM tokens).
        const haikuClause = USE_HAIKU
          ? `The Haiku "glm" subagent is allowed (GLM_USE_HAIKU=on), but glm_agent direct is cheaper (no Claude orchestration tokens).`
          : `Do NOT do this inline yourself, and do NOT use the Haiku "glm" subagent — both burn Claude/Opus tokens and spend ZERO GLM.`;
        verdict =
          `GLM-SUITABLE repo task (inferred: ${profile.taskType}, confidence ${rec.confidence}). ` +
          `➤ CALL mcp__glm__glm_agent DIRECTLY with workdir="${cwd}" (model ${rec.model}) — the only path that ` +
          `actually spends GLM tokens (GLM reads/edits the files and runs tests itself). ${haikuClause} ` +
          `For oversight, pass dry_run:true first, then apply. Why: ${rec.reasons[rec.reasons.length - 1] || rec.reasons[0] || ""}`;
      } else {
        // Pure generation -> draft via glm_delegate (spends GLM tokens); not inline (Claude tokens).
        verdict =
          `GLM-SUITABLE generation (inferred: ${profile.taskType}, confidence ${rec.confidence}). ` +
          `➤ CALL mcp__glm__glm_delegate (model ${rec.model}) to generate this — that spends GLM tokens. ` +
          `Writing it yourself instead spends Claude tokens and zero GLM. Then place/verify the result. ` +
          `Why: ${rec.reasons[rec.reasons.length - 1] || rec.reasons[0] || ""}`;
      }
    } catch {
      verdict = `Could not load router; GLM delegate is still available (mcp__glm__glm_agent for repo tasks, mcp__glm__glm_delegate for drafts, mcp__glm__glm_recommend to decide).`;
    }

    // Compact reference (injected only on subagent spawn -> pay-per-use). Kept short to
    // minimize the Claude tokens spent reading it.
    const RULES =
      "Rule: GLM (~10x cheaper) = default for safe-to-be-wrong work; Opus only when being wrong is " +
      "costly. Always Opus: sensitive/secret code, vision, parallel agents, >128K context, heavy " +
      "dependent tool-loops. To spend GLM (not Claude) tokens, call mcp__glm__glm_agent directly " +
      "(files) or mcp__glm__glm_delegate (text); doing it inline or via the Haiku subagent = Claude tokens.";

    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `[GLM router] ${verdict}\n${peakNote}\n${RULES}`,
      },
    };
    process.stdout.write(JSON.stringify(out));
  } catch {
    // never block a subagent spawn on hook failure
  }
  process.exit(0);
})();
