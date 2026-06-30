// router.js
// Peak-awareness + GLM-vs-Opus decision logic.
// Pure functions, no I/O, no API calls -> cheap to call, easy to unit test.
//
// Facts encoded here come from docs/research:
//  - GLM-5.2 quota multiplier: ~3x peak / ~2x off-peak (1x off-peak under promo).
//  - Peak window: ~14:00-18:00 China time (UTC+8).
//  - GLM-4.7 carries NO multiplier (a cheaper option, not the default).
//  - Concurrency cap is ~1 in-flight even on paid tiers.

const PEAK_START_HOUR_CN = intEnv("GLM_PEAK_START_CN", 14); // 14:00 UTC+8
const PEAK_END_HOUR_CN = intEnv("GLM_PEAK_END_CN", 18); // 18:00 UTC+8 (exclusive)

// Default model picks for "auto". Each may be a COMMA-SEPARATED LIST of candidate models;
// the router auto-picks one per task (most capable for hard / off-peak work, cheapest for
// easy / peak work) unless a specific model is requested. A single value works too.
// Example: GLM_OFFPEAK_MODEL="glm-5.2,glm-5-turbo"
const OFFPEAK_MODELS = splitModels(process.env.GLM_OFFPEAK_MODEL, "glm-5.2");
const PEAK_MODELS = splitModels(process.env.GLM_PEAK_MODEL, "glm-5.2");
const CHEAP_MODEL = process.env.GLM_CHEAP_MODEL || "glm-4.5-air";

function splitModels(val, fallback) {
  const list = (val || fallback).split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [fallback];
}

// Rough public-ish per-1M-token rates (USD) for cost estimation only.
// These are approximations from research and WILL drift -- treat as indicative.
const RATES = {
  "glm-5.2": { in: 0.6, out: 2.2 },
  "glm-5.2[1m]": { in: 1.2, out: 4.4 },
  "glm-5-turbo": { in: 0.3, out: 1.1 },
  "glm-4.7": { in: 0.4, out: 1.75 },
  "glm-4.6": { in: 0.4, out: 1.75 },
  "glm-4.5": { in: 0.4, out: 1.6 },
  "glm-4.5-air": { in: 0.1, out: 0.6 },
  // Opus reference, for comparison output only:
  "claude-opus": { in: 5.0, out: 25.0 },
};

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function numEnv(name, fallback) {
  const v = parseFloat(process.env[name] || "");
  return Number.isFinite(v) ? v : fallback;
}

function boolEnv(name, fallback) {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (/^(1|on|true|yes)$/.test(v)) return true;
  if (/^(0|off|false|no)$/.test(v)) return false;
  return fallback;
}

// Use the Haiku-orchestrated `glm` subagent? DEFAULT false -> skip Haiku and call GLM directly
// (mcp__glm__glm_agent), so the burden and the tokens stay on GLM (the Haiku subagent's own
// writing would spend Claude tokens). Set GLM_USE_HAIKU=on in .env to allow the subagent path.
export const USE_HAIKU = boolEnv("GLM_USE_HAIKU", false);

// GLM is ~10x cheaper than Opus, so by default GLM carries the overwhelming majority of the
// burden: with GLM_COST_BIAS=7, ~98-100% of tasks route to GLM (measured across all task types,
// peak and off-peak). Opus is used only for what GLM genuinely can't/shouldn't do -- vision,
// parallel fan-out, >128K context, sensitive code, and heavy dependent tool-loops (the hard
// overrides). LOWER GLM_COST_BIAS (e.g. 1.5) if you want Opus to handle more of the hard tasks
// (debugging, architecture, security, big refactors); set 0 to decide on capability alone.
const COST_BIAS = numEnv("GLM_COST_BIAS", 7);

// --- Output token policy ---------------------------------------------------
// max_tokens is a CEILING, not a target: GLM stops when done and you're billed for
// ACTUAL output, so being generous just prevents truncation at no extra cost.
//
// DEFAULT: the cap is OFF -> every call may use up to GLM_MAX_TOKENS_CEILING (131072, generous).
// Turn it ON with GLM_CAP=on to enforce GLM_MAX_TOKENS as a hard limit on every call and clamp
// any larger per-call request down to it -- handy when you want to control spend.
const CAP_ENABLED = /^(1|on|true|yes)$/i.test(process.env.GLM_CAP || "off");
const CAP_VALUE = intEnv("GLM_MAX_TOKENS", 32768);
const UNCAPPED_MAX = intEnv("GLM_MAX_TOKENS_CEILING", 131072);

/** Resolve max_tokens to send, honoring the on/off cap and any per-call request. */
export function resolveMaxTokens(requested) {
  const r = Number.isFinite(requested) ? requested : null;
  if (r != null) return CAP_ENABLED ? Math.min(r, CAP_VALUE) : r;
  return CAP_ENABLED ? CAP_VALUE : UNCAPPED_MAX;
}
export const MAXTOK = { capEnabled: CAP_ENABLED, capValue: CAP_VALUE, uncappedMax: UNCAPPED_MAX };

/** Current hour (0-23) in China time (UTC+8), independent of host TZ. */
export function chinaHour(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const cn = new Date(utcMs + 8 * 3600000);
  return cn.getHours();
}

/** Is `date` inside the GLM peak-billing window? */
export function isPeak(date = new Date()) {
  const h = chinaHour(date);
  if (PEAK_START_HOUR_CN <= PEAK_END_HOUR_CN) {
    return h >= PEAK_START_HOUR_CN && h < PEAK_END_HOUR_CN;
  }
  // window wraps midnight
  return h >= PEAK_START_HOUR_CN || h < PEAK_END_HOUR_CN;
}

/** Quota/cost multiplier currently in effect for the flagship model. */
export function peakMultiplier(date = new Date()) {
  return isPeak(date) ? 3 : 2;
}

/** Rough capability score from the model id (higher = more capable). */
function modelCapability(m) {
  const ver = parseFloat((m.match(/(\d+(?:\.\d+)?)/) || [])[1] || "0");
  let s = ver;
  if (/turbo/i.test(m)) s -= 0.3;
  if (/air/i.test(m)) s -= 0.6;
  if (/flash/i.test(m)) s -= 0.5;
  return s;
}

/** Effective per-call cost proxy for a model (in+out rate, peak multiplier for glm-5.x). */
function modelEffCost(m, date) {
  const r = RATES[m] || RATES[m.replace(/\[.*?\]/, "")] || { in: 0.4, out: 1.75 };
  const mult = /^glm-5/.test(m) ? peakMultiplier(date) : 1;
  return (r.in + r.out) * mult;
}

/** Auto-pick one model from a candidate list per the rules. */
function pickFromList(list, complexity, date) {
  if (!list || list.length <= 1) return list && list[0];
  const capDesc = [...list].sort((a, b) => modelCapability(b) - modelCapability(a));
  const costAsc = [...list].sort((a, b) => modelEffCost(a, date) - modelEffCost(b, date));
  if (complexity === "high") return capDesc[0]; // hardest task -> most capable
  if (complexity === "low") return costAsc[0]; // easy task -> cheapest
  return isPeak(date) ? costAsc[0] : capDesc[0]; // medium -> cheapest at peak, most capable off-peak
}

/**
 * Resolve a model id. "auto" -> auto-pick from the off-peak/peak candidate LIST per the rules
 * (capability for hard/off-peak work, cheapest for easy/peak work). A specific id is returned as-is.
 */
export function resolveModel(requested, date = new Date(), complexity = "medium") {
  if (requested && requested !== "auto") return requested;
  const list = isPeak(date) ? PEAK_MODELS : OFFPEAK_MODELS;
  return pickFromList(list, complexity, date);
}

/** Estimate USD cost for a call given a model and token counts. */
export function estimateCost(model, inputTokens, outputTokens, date = new Date()) {
  const base = RATES[model] || RATES["glm-4.7"];
  const mult = model.startsWith("glm-5") ? peakMultiplier(date) : 1; // 4.x = no multiplier
  const usd =
    ((inputTokens / 1e6) * base.in + (outputTokens / 1e6) * base.out) * mult;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Decide GLM vs Opus for a task. Pure advisory -- the caller (Claude) acts on it.
 * Encodes the rules synthesized in docs/RULES.md.
 *
 * @returns {{engine:"glm"|"opus", model:string|null, confidence:number, reasons:string[]}}
 */
export function recommend(opts = {}, date = new Date()) {
  const {
    taskType = "general", // see TASK_FIT below
    complexity = "medium", // "low" | "medium" | "high"
    sensitive = false, // proprietary/security-critical code or data
    needsParallel = false, // requires several concurrent agents
    longHorizon = false, // many sequential steps / multi-hour autonomy
    latencySensitive = false, // tight interactive loop
    // --- conditions surfaced by the scenario research ---
    vision = false, // input includes images/screenshots/GUI/computer-use
    inputTokens = 0, // approx size of context the task needs
    steps = 0, // approx number of dependent sequential steps
    toolPattern = "none", // "none" | "single" | "fanout" | "heavy" (dependent agentic loop)
    unfamiliarApi = false, // niche/post-cutoff/internal API the model can't know
    chinese = false, // Chinese or Chinese-English bilingual task
  } = opts;

  const reasons = [];

  // ---- Hard overrides -> Opus, regardless of cost ----
  if (sensitive) {
    return done("opus", null, 0.95, [
      "Sensitive/proprietary: GLM routes through servers in China and Zhipu is on the US Entity List; keep secrets/security-critical work on Opus.",
    ]);
  }
  if (vision) {
    return done("opus", null, 0.9, [
      "Vision input (images/screenshots/GUI): GLM's text endpoints have no native vision in this setup; Opus handles it.",
    ]);
  }
  if (needsParallel) {
    return done("opus", null, 0.85, [
      "Needs parallel/concurrent agents: GLM has a ~1 in-flight concurrency cap that breaks fan-out; Opus handles parallel subagents.",
    ]);
  }
  if (latencySensitive) {
    return done("opus", null, 0.7, [
      "Latency-sensitive loop: GLM is among the slowest frontier coders (~50-100 tok/s).",
    ]);
  }
  if (toolPattern === "heavy") {
    return done("opus", null, 0.88, [
      "Tool-heavy dependent agentic loop: GLM plans-then-acts and depends on reasoning-state passthrough, so it drifts/loops across many dependent tool calls; Opus interleaves thinking with tool use. (One-shot/short independent tool calls are fine on GLM.)",
    ]);
  }
  if (inputTokens > 128000) {
    return done("opus", null, 0.8, [
      `Large context (~${Math.round(inputTokens / 1000)}K tokens): GLM degrades well before its advertised limit (~100K usable); use Opus, or glm-5.2[1m] for pure retrieval/extraction only.`,
    ]);
  }
  if (steps > 20 || (longHorizon && complexity === "high")) {
    return done("opus", null, 0.85, [
      "Long-horizon (>20 dependent steps / sustained single goal): GLM exhibits goal drift; Opus holds the plan.",
    ]);
  }

  // ---- Capability-fit scoring. >0 favors GLM, <0 favors Opus ----
  const TASK_FIT = {
    // Strong GLM: well-specified, single-purpose, cheap-to-verify
    frontend: 2, ui: 2, boilerplate: 2, scaffolding: 2, config: 2, crud: 2,
    regex: 2, docs: 2, i18n: 2, type_lint: 2, unit_test: 2,
    refactor_local: 2, prototype: 2, toolcall_single: 2,
    // Mild GLM
    sql: 1, etl: 1, cicd: 1, cli: 1, notebook: 1, integration_test: 1,
    algorithm: 1, research: 1, summarization: 1, toolcall_fanout: 1,
    // Neutral / toss-up
    general: 0, ml_training: 0,
    // Lean Opus (errors costly or subtle)
    iac: -1, dependency_upgrade: -1,
    debugging: -2, code_review: -2, perf: -2, api_integration: -2,
    migration: -2, systems: -2,
    // Strong Opus
    refactor_large: -3, architecture: -3, security: -3,
    agentic_loop: -3, toolcall_heavy: -3,
  };
  let score = TASK_FIT[taskType] ?? 0;
  reasons.push(`Task type "${taskType}" capability fit ${score >= 0 ? "+" : ""}${score}.`);

  // Cost is a first-class factor: GLM is ~10x cheaper, so bias toward it. The
  // capability penalties above are what claw hard/risky work back to Opus.
  score += COST_BIAS;
  reasons.push(
    `GLM ~10x cheaper than Opus (still cheaper even at peak) -> cost bias +${COST_BIAS} toward GLM; Opus is the "pay up for quality" exception.`
  );

  // Soft signals from the research.
  if (unfamiliarApi) {
    score -= 2;
    reasons.push("Unfamiliar/niche/post-cutoff API: GLM hallucinates obscure APIs (-2). Paste authoritative docs into the prompt, or use Opus.");
  }
  if (chinese) {
    score += 1;
    reasons.push("Chinese / bilingual task: GLM is a strength here (+1).");
  }
  if (toolPattern === "single") {
    score += 1;
    reasons.push("Single one-shot tool call: GLM's schema adherence is best-in-class (+1).");
  }

  if (complexity === "high") {
    score -= 2;
    reasons.push("High complexity -2 (GLM self-correction is weaker than Opus).");
  } else if (complexity === "low") {
    score += 1;
    reasons.push("Low complexity +1 (well-specified work is GLM's sweet spot).");
  }

  // Cost-timing modifier. Off-peak nudges toward GLM. At peak, if the "auto" model carries the
  // multiplier (glm-5.x), penalize harder so GLM is called LESS during the surcharge window --
  // scaled by the multiplier. A non-multiplier peak model (e.g. glm-4.7) gets only a small nudge.
  if (!isPeak(date)) {
    score += 0.5;
    reasons.push("Off-peak in China (UTC+8): GLM cheapest now (+0.5).");
  } else {
    const m = resolveModel("auto", date, complexity);
    const mult = peakMultiplier(date);
    // Only penalize GLM at peak if the CHOSEN model actually carries the surcharge (glm-5.x).
    // If "auto" lands on a no-surcharge model (e.g. glm-4.7), peak is fine -> no penalty.
    const penalty = /^glm-5/.test(m) ? Math.min((mult - 1) * 0.5, 2) : 0;
    if (penalty > 0) {
      score -= penalty;
      reasons.push(`Peak window (UTC+8): "auto" model ${m} costs ~${mult}x now -> -${penalty} toward GLM (route less to GLM at peak).`);
    } else {
      reasons.push(`Peak window (UTC+8): "auto" model ${m} has no peak surcharge -> no GLM penalty (fine to use).`);
    }
  }

  if (score >= 1) {
    return done("glm", resolveModel("auto", date, complexity), clamp(0.5 + score * 0.1), reasons);
  }
  return done("opus", null, clamp(0.5 + Math.abs(score) * 0.1), reasons);

  function done(engine, model, confidence, rs) {
    return { engine, model, confidence: Math.round(confidence * 100) / 100, reasons: rs };
  }
}

function clamp(n) {
  return Math.max(0.5, Math.min(0.97, n));
}

export const MODELS = { OFFPEAK_MODELS, PEAK_MODELS, CHEAP_MODEL, RATES };
