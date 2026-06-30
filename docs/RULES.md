# GLM-vs-Opus Routing Rules (synthesized)

This is the single source of truth for *when* to delegate to GLM. It is the human-readable
version of the logic in [`glm-mcp/src/router.js`](../glm-mcp/src/router.js) (`recommend()`),
synthesized from the three research docs in [`docs/research/`](research/).

> **Group 3, Agent A deliverable:** synthesized decision rules.

## The one-line policy
**Default to GLM for the routine ~80%; escalate to Opus for the expensive-if-wrong minority.**

## Why cost makes GLM the default (not just a "cheap option")
GLM is **~10× cheaper** than Opus, and **still ~3–4× cheaper even at peak** (3× multiplier):

| Model | ~$/1M in/out | vs Opus |
|---|---|---|
| Opus | 5 / 25 | 1× |
| GLM-5.2 off-peak | 0.6 / 2.2 | ~10× cheaper |
| GLM-5.2 at peak | 1.8 / 6.6 | ~3–4× cheaper |
| GLM-4.7 (no multiplier) | 0.4 / 1.75 | ~12× cheaper |

So the router applies a standing **cost bias toward GLM** (`GLM_COST_BIAS`, default `7` →
GLM carries ~98–100% of tasks; lower it to hand more hard tasks to Opus):
GLM is the default for safe-to-be-wrong work, and Opus is the exception you *pay up* for only
when quality/risk justifies it. The catch cost can't override: on hard tasks, *cheaper-but-wrong*
is **more** expensive (rework + Opus tokens to fix), so the capability penalties for
debugging/architecture/large-refactor/security claw those back to Opus despite the price gap.
Tune `GLM_COST_BIAS` up to push more to GLM, or to `0` to decide on capability alone.

## Hard overrides — always Opus (no matter the cost saving)
| Condition | Why |
|---|---|
| Proprietary / security-critical code or secrets | GLM routes through servers in China; Zhipu is on the US Entity List. Don't send sensitive IP. |
| Needs parallel / concurrent agents | GLM caps in-flight requests at ~1 even on paid tiers; fan-out breaks. |
| Long-horizon **and** high complexity (30+ sequential steps, multi-hour autonomy) | GLM drifts off-plan; Opus holds the plan. |
| Latency-sensitive interactive loop | GLM is among the slowest frontier coders (~50–100 tok/s). |

## Tool-calling: the important nuance
GLM is **strong at one-shot / short tool calls** (clean schema adherence, near-zero argument
hallucination) but **weak at long, dependent agentic loops**. Root cause from research: GLM
"plans-then-acts" and depends on its reasoning state (`reasoning_content`) being fed back each
turn; in long loops it drifts or loops infinitely. Opus *interleaves* thinking with tool use,
so it adapts mid-execution. One report: a task that looped 40+ tool calls on GLM finished in
~2 min on Claude. So:
- `toolcall_single` (one structured call / extraction) → **GLM** (+2)
- `toolcall_fanout` (a few independent calls, no shared state) → **GLM** (+1)
- `toolcall_heavy` / `agentic_loop` (many *dependent* calls, long horizon) → **Opus** (hard override)

## Scenario matrix (capability-fit weight, before cost bias)
Weight scale: +2 strongly GLM … −3 strongly Opus. Cost bias (+1.5) + timing then applied;
net effect: fit ≥ −1 usually routes GLM, fit ≤ −2 routes Opus.

| Lean GLM (+1/+2) | Lean / strong Opus (−1…−3) |
|---|---|
| frontend/UI, boilerplate, scaffolding, config (+2) | iac/Terraform/K8s, dependency upgrades (−1) |
| CRUD, regex, docs, i18n, type/lint fixes (+2) | debugging, code review, perf optimization (−2) |
| unit tests, local refactor, prototype (+2) | DB migrations, 3rd-party API integration (−2) |
| toolcall_single (+2) | systems langs (Rust/Go/C) (−2) |
| SQL, ETL, CI/CD, CLI, notebook, integration tests (+1) | large refactor, architecture, security (−3) |
| algorithm, research, summarization, toolcall_fanout (+1) | toolcall_heavy, agentic_loop (−3) |
| general, ml_training (0 / toss-up → cost breaks tie to GLM) | |

**Principle:** route by *cost of being wrong*, not token price. GLM where output verifies fast
(compiler/linter/test runner is ground truth) and a retry is cheap; Opus where errors are
silent, cascading, or expensive (migrations, security, review, perf).

## Conditional overrides (force Opus regardless of task type)
- **Vision** (images/screenshots/GUI/computer-use) → Opus (GLM text endpoint has no vision).
- **Input > ~128K tokens** → Opus (GLM degrades past ~100K despite 1M advertised); use
  `glm-5.2[1m]` only for pure retrieval/extraction.
- **> 20 dependent steps / sustained single goal** → Opus (GLM goal-drift).
- **Unfamiliar / niche / post-cutoff API** → −2: paste authoritative docs into the prompt, or Opus.
- **Chinese / bilingual** → +1 toward GLM (genuine strength).

**Complexity adjusts the call:** `low` nudges toward GLM, `high` nudges toward Opus.

## Cost-timing rule (the "use GLM less at peak" requirement)
- **Peak window:** ~**14:00–18:00 China time (UTC+8)** ≈ 02:00–06:00 US Eastern.
- Flagship **GLM-5.2 costs ~3× at peak, ~2× off-peak** (1× off-peak under a promo through ~Sep 2026).
- **Default `model: "auto"` is GLM-5.2 in both windows.** Since GLM-5.2 carries the ~3× peak
  surcharge, the router **routes less work to GLM during peak** (a peak penalty scaled by the
  multiplier) instead of switching models — only stronger-fit tasks go to GLM at peak.
- GLM-4.7 carries no multiplier and stays available as a cheaper option: set `GLM_PEAK_MODEL=glm-4.7`
  if you'd rather switch to a no-surcharge model at peak instead of routing less.
- Western working hours fall in GLM off-peak → GLM is *most* attractive during your normal day.

## Model picks
| Use | Model |
|---|---|
| Off-peak default | `glm-5.2` |
| Peak default | `glm-5.2` (router sends less to GLM at peak due to ~3× cost) |
| No-surcharge alternative for peak | `glm-4.7` (set `GLM_PEAK_MODEL=glm-4.7`) |
| Cheapest / trivial work | `glm-4.5-air` |
| Huge context (>200K) | `glm-5.2[1m]` |

> `GLM_OFFPEAK_MODEL` / `GLM_PEAK_MODEL` each accept a **comma-separated list** (e.g.
> `glm-5.2,glm-5-turbo`); the router auto-picks one — most capable for hard tasks, cheapest for
> easy/peak ones. Put a no-surcharge model in the peak list (e.g. `glm-5.2,glm-4.7`) and it's
> preferred at peak, so GLM stays fine to use during the surcharge window.

## Escalation contract
If GLM's output is wrong, low-quality, or it refuses: retry once with a sharper prompt,
then **escalate to Opus**. Never let cost-saving degrade correctness on work that matters.

> ⚠️ Pricing, peak windows, and the concurrency cap are vendor-set and drift. Verify against
> `z.ai/subscribe` and `docs.z.ai` periodically; tune via env vars (see `.env.example`).
