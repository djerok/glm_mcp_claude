// glmClient.js
// Thin client over the GLM Anthropic-compatible endpoint with two things that
// matter for GLM specifically:
//   1. A concurrency gate (GLM caps in-flight requests at ~1 even on paid tiers).
//   2. Exponential backoff on 429 / "concurrency" / 5xx errors.

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Local usage ledger: every GLM call is appended here so you have independent, on-disk
// proof of GLM usage (model + tokens), regardless of what the z.ai dashboard shows.
// View it: cat ~/.claude/glm-mcp/usage.jsonl
const USAGE_LOG = join(dirname(fileURLToPath(import.meta.url)), "..", "usage.jsonl");
function logUsage(model, usage) {
  try {
    appendFileSync(
      USAGE_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        model,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
      }) + "\n"
    );
  } catch {}
}

/** Cumulative GLM usage from the local ledger — independent proof of GLM token spend. */
export function usageSummary() {
  const out = { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, by_model: {}, log_path: USAGE_LOG };
  try {
    for (const l of readFileSync(USAGE_LOG, "utf8").trim().split(/\r?\n/)) {
      if (!l) continue;
      const e = JSON.parse(l);
      out.calls++;
      out.input_tokens += e.input_tokens || 0;
      out.output_tokens += e.output_tokens || 0;
      out.by_model[e.model] = (out.by_model[e.model] || 0) + 1;
    }
    out.total_tokens = out.input_tokens + out.output_tokens;
  } catch {}
  return out;
}

const BASE_URL = (process.env.GLM_BASE_URL || "https://api.z.ai/api/anthropic").replace(/\/$/, "");
const API_KEY = process.env.GLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.GLM_MAX_CONCURRENT || "1", 10));
const MAX_RETRIES = Math.max(0, parseInt(process.env.GLM_MAX_RETRIES || "4", 10));
const TIMEOUT_MS = parseInt(process.env.GLM_TIMEOUT_MS || "300000", 10);

// ---- tiny semaphore so we never exceed GLM's concurrency cap ----
let active = 0;
const waiters = [];
async function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise((res) => waiters.push(res));
  active++;
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(status, bodyText) {
  if (status === 429 || status === 503 || status === 502 || status === 500) return true;
  if (bodyText && /concurren|rate.?limit|too\s+much/i.test(bodyText)) return true;
  return false;
}

/**
 * Call GLM's /v1/messages (Anthropic Messages API shape).
 * @param {object} p
 * @param {string} p.model
 * @param {Array}  p.messages  Anthropic-style messages
 * @param {string} [p.system]
 * @param {number} [p.maxTokens]
 * @param {boolean}[p.thinking]
 * @returns {Promise<{text:string, usage:object, raw:object}>}
 */
export async function glmMessage({ model, messages, system, maxTokens = 32768, thinking = false, tools }) {
  if (!API_KEY) {
    throw new Error(
      "GLM_API_KEY (or ANTHROPIC_AUTH_TOKEN) is not set. Add it to glm-mcp/.env or the MCP server env in .mcp.json."
    );
  }

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(tools && tools.length ? { tools } : {}),
    ...(thinking ? { thinking: { type: "enabled", budget_tokens: Math.min(maxTokens, 8000) } } : {}),
  };

  await acquire();
  try {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res, txt;
      try {
        res = await fetch(`${BASE_URL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${API_KEY}`,
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        txt = await res.text();
      } catch (e) {
        clearTimeout(t);
        if (attempt < MAX_RETRIES) {
          await sleep(backoff(attempt++));
          continue;
        }
        throw new Error(`GLM request failed (network/timeout): ${e.message}`);
      }
      clearTimeout(t);

      if (!res.ok) {
        if (isRetryable(res.status, txt) && attempt < MAX_RETRIES) {
          await sleep(backoff(attempt++, txt));
          continue;
        }
        throw new Error(`GLM API error ${res.status}: ${truncate(txt, 800)}`);
      }

      let json;
      try {
        json = JSON.parse(txt);
      } catch {
        throw new Error(`GLM returned non-JSON response: ${truncate(txt, 800)}`);
      }

      const text = (json.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      logUsage(model, json.usage || {}); // on-disk proof of GLM usage
      return { text, usage: json.usage || {}, raw: json };
    }
  } finally {
    release();
  }
}

function backoff(attempt, bodyText) {
  // Honor concurrency errors with a slightly longer floor.
  const concurrency = bodyText && /concurren|too\s+much/i.test(bodyText);
  const base = concurrency ? 2000 : 800;
  const jitter = Math.random() * 400;
  return Math.min(base * 2 ** attempt + jitter, 30000);
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}

export const config = { BASE_URL, MAX_CONCURRENT, MAX_RETRIES, hasKey: Boolean(API_KEY) };
