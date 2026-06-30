// glmAgent.js
// Runs GLM as a real tool-using agent against the local filesystem, with oversight
// built in so Opus can regulate and see exactly what GLM did:
//   - returns a unified DIFF of every change (isolated to the files GLM touched)
//   - returns an ACTION LOG of every read/write/edit/bash
//   - records a non-invasive git checkpoint + revert hint (when in a git repo)
//   - supports dry_run: GLM proposes changes to an in-memory overlay and writes NOTHING,
//     so Opus can approve the diff before a real apply pass.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { execSync } from "node:child_process";
import { glmMessage } from "./glmClient.js";

const MAX_ITERS = parseInt(process.env.GLM_AGENT_MAX_ITERS || "30", 10);
const BASH_TIMEOUT = parseInt(process.env.GLM_AGENT_BASH_TIMEOUT_MS || "120000", 10);
const FILE_READ_CAP = 100000;
const BASH_OUT_CAP = 30000;
const DIFF_CAP = 20000;
const DIFF_LINE_CAP = 3000;

const TOOLS = [
  { name: "read_file", description: "Read a UTF-8 text file (path relative to working dir or absolute).",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file. Creates parent dirs as needed.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace an exact substring in a file. old_string must appear exactly once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } },
  { name: "list_dir", description: "List entries in a directory (relative or absolute). Defaults to '.'.",
    input_schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "run_bash", description: "Run a shell command in the working dir; returns stdout+stderr. Disabled in dry_run.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

function safeResolve(root, p) {
  return isAbsolute(p || "") ? resolve(p) : resolve(root, p || ".");
}

function unifiedDiff(oldStr, newStr, path) {
  if (oldStr === newStr) return "";
  const A = oldStr.length ? oldStr.split("\n") : [];
  const B = newStr.length ? newStr.split("\n") : [];
  if (A.length > DIFF_LINE_CAP || B.length > DIFF_LINE_CAP) {
    return `--- ${path}\n+++ ${path}\n@@ large file: ${A.length} -> ${B.length} lines (detailed diff omitted) @@\n`;
  }
  const n = A.length, m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { rows.push([" ", A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push(["-", A[i]]); i++; }
    else { rows.push(["+", B[j]]); j++; }
  }
  while (i < n) rows.push(["-", A[i++]]);
  while (j < m) rows.push(["+", B[j++]]);
  const out = [`--- ${path}`, `+++ ${path}`];
  let ctx = [];
  const flush = () => {
    if (ctx.length > 6) {
      out.push(" " + ctx[0], " " + ctx[1], `@@ ... ${ctx.length - 4} unchanged ... @@`, " " + ctx[ctx.length - 2], " " + ctx[ctx.length - 1]);
    } else for (const c of ctx) out.push(" " + c);
    ctx = [];
  };
  for (const [t, l] of rows) {
    if (t === " ") ctx.push(l);
    else { flush(); out.push(t + l); }
  }
  flush();
  return out.join("\n") + "\n";
}

function gitCheckpoint(root) {
  try {
    execSync(`git -C "${root}" rev-parse --is-inside-work-tree`, { stdio: "ignore" });
  } catch {
    return { isRepo: false, baseline: null, revertHint: "Not a git repo — review the diff below; revert manually if needed." };
  }
  let baseline = "";
  try { baseline = execSync(`git -C "${root}" stash create`, { encoding: "utf8" }).trim(); } catch {}
  if (!baseline) {
    try { baseline = execSync(`git -C "${root}" rev-parse HEAD`, { encoding: "utf8" }).trim(); } catch {}
  }
  return {
    isRepo: true,
    baseline,
    revertHint: baseline
      ? `To revert GLM's changes: \`git -C "${root}" checkout ${baseline} -- .\` then \`git -C "${root}" clean -fd\` to drop any new files. (Baseline is a non-invasive snapshot; your working tree was not modified by the checkpoint.)`
      : "Git repo detected but baseline capture failed; use `git diff` / `git stash` to review and revert.",
  };
}

export async function runGlmAgent({ model, task, context, workdir, maxTokens = 32768, thinking = false, dryRun = false }) {
  const root = workdir && workdir.trim() ? resolve(workdir) : process.cwd();
  const log = [];
  const originals = new Map(); // abs -> pre-run disk content (string|null if didn't exist)
  const overlay = new Map(); // dry_run staging: abs -> proposed content
  const checkpoint = dryRun ? { isRepo: false, baseline: null, revertHint: "dry_run: nothing written." } : gitCheckpoint(root);

  const recordOriginal = (abs) => {
    if (!originals.has(abs)) {
      try { originals.set(abs, readFileSync(abs, "utf8")); } catch { originals.set(abs, null); }
    }
  };
  const readCurrent = (abs) => {
    if (dryRun && overlay.has(abs)) return overlay.get(abs);
    return readFileSync(abs, "utf8");
  };
  const writeCurrent = (abs, content) => {
    if (dryRun) { overlay.set(abs, content); return; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };

  function runTool(name, input) {
    try {
      switch (name) {
        case "read_file": {
          const abs = safeResolve(root, input.path);
          const txt = readCurrent(abs);
          log.push(`read ${relative(root, abs) || input.path}`);
          return txt.length > FILE_READ_CAP ? txt.slice(0, FILE_READ_CAP) + "\n…[truncated]" : txt;
        }
        case "write_file": {
          const abs = safeResolve(root, input.path);
          recordOriginal(abs);
          writeCurrent(abs, input.content ?? "");
          log.push(`${dryRun ? "[dry] " : ""}write ${relative(root, abs) || input.path}`);
          return `${dryRun ? "(dry_run, staged) " : ""}Wrote ${(input.content ?? "").length} chars to ${input.path}.`;
        }
        case "edit_file": {
          const abs = safeResolve(root, input.path);
          let cur;
          try { cur = readCurrent(abs); } catch { return `ERROR: cannot read ${input.path} to edit.`; }
          const occ = cur.split(input.old_string).length - 1;
          if (occ === 0) return `ERROR: old_string not found in ${input.path}. Read the file and retry with an exact match.`;
          if (occ > 1) return `ERROR: old_string appears ${occ} times in ${input.path}; add surrounding lines to make it unique.`;
          recordOriginal(abs);
          writeCurrent(abs, cur.replace(input.old_string, input.new_string));
          log.push(`${dryRun ? "[dry] " : ""}edit ${relative(root, abs) || input.path}`);
          return `${dryRun ? "(dry_run, staged) " : ""}Edited ${input.path} (1 replacement).`;
        }
        case "list_dir": {
          const abs = safeResolve(root, input.path || ".");
          const entries = readdirSync(abs).map((e) => {
            try { return statSync(join(abs, e)).isDirectory() ? e + "/" : e; } catch { return e; }
          });
          return entries.join("\n") || "(empty)";
        }
        case "run_bash": {
          if (dryRun) return `[dry_run] bash disabled. Use read_file/list_dir to inspect. (cmd was: ${input.command})`;
          log.push(`bash: ${String(input.command).slice(0, 80)}`);
          let out;
          try {
            out = execSync(input.command, { cwd: root, timeout: BASH_TIMEOUT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true });
          } catch (e) {
            out = `${e.stdout || ""}${e.stderr || ""}\n[exit ${e.status ?? "?"}] ${e.message}`;
          }
          return (out || "(no output)").slice(0, BASH_OUT_CAP);
        }
        default:
          return `ERROR: unknown tool ${name}`;
      }
    } catch (e) {
      return `ERROR (${name}): ${e.message}`;
    }
  }

  const system =
    `You are a capable coding agent operating directly on a local repository.\n` +
    `Working directory: ${root}\n` +
    (dryRun
      ? `DRY RUN: your write_file/edit_file are STAGED, not written to disk, and run_bash is disabled. ` +
        `Produce the complete set of intended changes, then stop and summarize them.\n`
      : `Make changes yourself with the tools; run tests/builds to verify. `) +
    `Tools: read_file, write_file, edit_file, list_dir, run_bash. When fully done, stop calling ` +
    `tools and reply with a concise summary of what you changed and how you verified it.`;

  const messages = [{ role: "user", content: context ? `${task}\n\n--- CONTEXT ---\n${context}` : task }];
  let lastText = "";
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  let iters = 0;

  for (; iters < MAX_ITERS; iters++) {
    const { raw, usage } = await glmMessage({ model, system, messages, maxTokens, thinking, tools: TOOLS });
    totalUsage.input_tokens += usage.input_tokens || 0;
    totalUsage.output_tokens += usage.output_tokens || 0;
    const content = raw.content || [];
    const textParts = content.filter((b) => b.type === "text").map((b) => b.text);
    if (textParts.length) lastText = textParts.join("\n").trim();
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (raw.stop_reason !== "tool_use" || toolUses.length === 0) break;
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: toolUses.map((tu) => ({ type: "tool_result", tool_use_id: tu.id, content: String(runTool(tu.name, tu.input || {})) })),
    });
  }

  // Build the diff from captured originals.
  let diff = "";
  for (const [abs, orig] of originals) {
    let now;
    if (dryRun) now = overlay.has(abs) ? overlay.get(abs) : orig ?? "";
    else now = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const d = unifiedDiff(orig ?? "", now ?? "", relative(root, abs) || abs);
    if (d) diff += (orig == null ? `(new file)\n` : "") + d + "\n";
  }
  if (diff.length > DIFF_CAP) diff = diff.slice(0, DIFF_CAP) + "\n…[diff truncated]";

  return {
    text: lastText || "(GLM finished without a summary)",
    actions: log,
    iters,
    hitCap: iters >= MAX_ITERS,
    usage: totalUsage,
    root,
    dryRun,
    diff: diff.trim(),
    changedFiles: [...originals.keys()].map((a) => relative(root, a) || a),
    git: checkpoint,
  };
}
