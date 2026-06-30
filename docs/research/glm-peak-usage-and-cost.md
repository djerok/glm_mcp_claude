# GLM (Zhipu AI / Z.ai) — When to Use vs. Avoid: Peak Hours, Cost & Throttling

**Research date:** 2026-06-30
**Scope:** When is it most cost- and time-ideal to lean on GLM (GLM-5.2 / GLM-4.7 / "GLM Coding Plan", which the user calls "GLM 5.2") inside Claude Code as a cheaper alternative to Anthropic Opus — and when to avoid it.

> **Reliability warning.** GLM pricing, quotas, and the peak/off-peak rules change *frequently* and are heavily promotional. Several numbers below are reported by third-party guides and individual users, not all confirmed on official pages (and the official pages are JS-rendered and could not be fetched directly during this research). Treat specific numbers as "last-known, verify before relying." Where a figure is uncertain it is explicitly flagged. **Always confirm live at [z.ai/subscribe](https://z.ai/subscribe) and [docs.z.ai/devpack/usage-policy](https://docs.z.ai/devpack/usage-policy).**

---

## TL;DR — the decision rules that matter

1. **GLM bills the flagship model (GLM-5.2 / GLM-5-Turbo) at a time-of-day multiplier: ~3x quota during peak hours, ~2x off-peak** — currently **1x off-peak under a promo through ~end of Sept 2026**. ([docs.z.ai](https://docs.z.ai/devpack/usage-policy), [aipricing.guru](https://www.aipricing.guru/z-ai-subscription-pricing/))
2. **Peak window is most commonly cited as 14:00–18:00 China time (UTC+8).** That is roughly **02:00–06:00 US Eastern / 06:00–10:00 UTC** — i.e. the **middle of the night in the Americas**, which is *good* for Western users. (A separate Z.ai promo described the restricted window as "2–6 AM ET," which is consistent with the UTC+8 afternoon window. The exact billing-peak definition is **not fully confirmed** and the two phrasings don't perfectly align — see "Uncertainties.")
3. **Quota is metered in PROMPTS per 5-hour rolling window + a weekly cap, not tokens or RPM.** Heavy/agentic use hits the prompt ceiling, not a token budget. ([docs.z.ai FAQ](https://docs.z.ai/devpack/faq))
4. **Concurrency is the real-world choke point.** Limits are dynamic (Max > Pro > Lite) and *not published as numbers*; users have reported effectively **1 in-flight request** on lower tiers, breaking multi-agent/subagent workflows. Concurrency is raised during off-peak. ([opencode #8618](https://github.com/anomalyco/opencode/issues/8618), [docs.z.ai usage-policy](https://docs.z.ai/devpack/usage-policy))
5. **GLM is much cheaper but slower and less reliable than Opus.** Among the slowest frontier coding models in interactive use (~50–100 tok/s on standard servers), with documented uptime wobbles under load. Best as a *complement* to Opus, not a replacement. ([aitoolanalysis](https://aitoolanalysis.com/glm-coding-plan-review/), [cirra.ai](https://cirra.ai/articles/glm-4-6-vs-claude-sonnet-comparison))

---

## 1. Pricing & subscription tiers

### GLM Coding Plan (subscription — the relevant product for Claude Code)

Flat monthly subscription that exposes an OpenAI-compatible endpoint usable inside Claude Code, Cline, Roo Code, etc. All tiers include the **same models** (GLM-5.2 flagship, GLM-5-Turbo, GLM-4.7, GLM-4.5-air); tiers differ by **quota, MCP allowance, and concurrency/priority**, not model access. ([z.ai/subscribe](https://z.ai/subscribe), [docs.z.ai/devpack/overview](https://docs.z.ai/devpack/overview))

| Tier | Std monthly (mid-2026)* | Prompts / 5h | Prompts / week | MCP calls/mo | Concurrency guidance |
|------|------------------------|--------------|----------------|--------------|----------------------|
| **Lite** | ~$18 (promo ~$12.60) | ~80 | ~400 | 100 | 1 project at a time |
| **Pro** | ~$72 (promo ~$50.40) | ~400 | ~2,000 | 1,000 | 1–2 projects |
| **Max** | ~$160 (promo ~$112) | ~1,600 | ~8,000 | 4,000 | 2+ projects |
| **Team** | custom | higher shared | — | — | org-level |

\* **Pricing has moved a lot.** Earlier 2026 tiers were Lite **$10** / Pro **$30** / Max **$80** (post-Feb 2026 reset; original launch had a $3/mo promo, now gone). Some sources still quote Pro at $15/mo. Billing discounts ~10% monthly / 20% quarterly / 30% yearly; a ~30% intro promo has also been live. **Verify the live number.** ([aipricing.guru](https://www.aipricing.guru/z-ai-subscription-pricing/), [codingplan.run](https://codingplan.run/plans/glm-coding-plan), [distk.in](https://distk.in/blog/glm-coding-plan-pricing-guide-2026.html), [vibecoding.app](https://vibecoding.app/blog/zhipu-ai-glm-pricing-2026))

**Restriction:** the Coding Plan only works inside officially supported coding tools — it is *not* a general API-key replacement. ([grokipedia](https://grokipedia.com/page/GLM_Coding_Plan))

### Pay-as-you-go API token pricing (for comparison)

| Model | Input $/M | Output $/M | Source |
|-------|-----------|-----------|--------|
| GLM-4.6 (list) | $0.60 | $2.20 | [docs.z.ai/guides/overview/pricing](https://docs.z.ai/guides/overview/pricing) |
| GLM-4.6 (OpenRouter) | $0.43 | $1.74 | [openrouter](https://openrouter.ai/z-ai/glm-4.6) |
| GLM-4.7 (OpenRouter) | $0.40 | $1.75 | [openrouter](https://openrouter.ai/z-ai/glm-4.7) |
| GLM-5.2 (approx) | ~$1.40 | ~$4.40 | [pricepertoken](https://pricepertoken.com/pricing-page/provider/z-ai) |

### Anthropic Claude (for the cost gap)

| Model | Input $/M | Output $/M |
|-------|-----------|-----------|
| Claude Opus 4.8 / 4.7 | $5.00 | $25.00 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $1.00 | $5.00 |

Source: [platform.claude.com/docs/pricing](https://platform.claude.com/docs/en/about-claude/pricing).

**Cost gap:** On raw tokens GLM-4.7 (~$0.40/$1.75) is roughly **~10x cheaper input and ~14x cheaper output than Opus** ($5/$25). GLM-5.2 (~$1.40/$4.40) is ~3.5x/5.7x cheaper than Opus. Via the subscription, Z.ai claims effective cost ~1% of standard API rates for heavy users. GLM also uses ~15% fewer tokens/task than GLM-4.5, partly offsetting slower speed. ([cirra.ai](https://cirra.ai/articles/glm-4-6-vs-claude-sonnet-comparison), [docs.z.ai FAQ](https://docs.z.ai/devpack/faq))

---

## 2. Peak vs. off-peak — the core timing rule

**Mechanism:** GLM-5.2 and GLM-5-Turbo (the "Opus-class" flagships) consume your prompt quota at a **multiplier based on time of day**:

- **Peak hours: ~3x** quota burn
- **Off-peak: ~2x** normally — **currently 1x under a promo valid through ~end of September 2026**

Older models (GLM-4.7, GLM-4.5-air) do **not** carry this premium multiplier — they burn quota at the base rate. ([docs.z.ai/devpack/usage-policy](https://docs.z.ai/devpack/usage-policy), [aipricing.guru](https://www.aipricing.guru/z-ai-subscription-pricing/), [Ivan Fioravanti / X](https://x.com/ivanfioravanti/status/2043685076186120442))

**Peak window (timezone-critical):**
- Most-cited: **14:00–18:00 China Standard Time (UTC+8)**.
- That converts to **≈06:00–10:00 UTC**, **≈02:00–06:00 US Eastern**, **≈23:00–03:00 US Pacific (prev night)**, **≈07:00–11:00 UK**.
- A Z.ai promo separately described its restricted window as **"2–6 AM ET"** (consistent with the UTC+8 afternoon). ([Z.ai / X](https://x.com/Zai_org/status/2033233961669783600))

**Implication for a US/European Claude Code user:** your normal working day **lands almost entirely in GLM's off-peak window** → you currently pay **1x** (promo) and avoid the 3x peak surcharge. This is the single biggest reason GLM is attractive *right now* for Western-timezone devs. The exception is late-night US-East work (roughly 2–6 AM ET) which hits peak.

---

## 3. Quotas, rate limits & concurrency

- **Quota unit = prompts, not tokens.** One "prompt" = one user query, internally fanning out to ~15–20 model calls. Measured per **5-hour rolling window** plus a **weekly cap** (weekly counter starts at purchase, resets on a 7-day cycle). ([docs.z.ai FAQ](https://docs.z.ai/devpack/faq))
- **No published RPM limit.** The constraint is prompts/cycle, not requests-per-minute.
- **Concurrency limits are dynamic and unpublished**, ordered Max > Pro > Lite; "recommended concurrent projects" = 1 (Lite) / 1–2 (Pro) / 2+ (Max). Raised during off-peak. ([docs.z.ai/devpack/usage-policy](https://docs.z.ai/devpack/usage-policy))
- **Real-world concurrency complaint (important):** a Pro user reported an *undocumented* effective concurrent limit of **~1 in-flight request**, hitting "Too much concurrency" after using only ~4% of the 5h quota — making subagent / parallel-agent workflows fail. ([opencode #8618](https://github.com/anomalyco/opencode/issues/8618))

**Takeaway:** for **parallel / multi-agent / subagent** workflows, GLM lower tiers can be unusable regardless of remaining quota. Use Opus for fan-out work, or budget Max tier + run during off-peak when concurrency is lifted.

---

## 4. Latency & reliability

- **Speed:** Among the **slowest** frontier coding models for interactive use. ~**50–100 tok/s** on standard optimized servers; noticeably slower than Opus/Grok. Prompt loading / input processing also adds latency, especially on local quantized variants. The exception is **Cerebras-hosted GLM-4.7 at ~1,000–1,700 tok/s** — but that is a different deployment, not the standard Z.ai Coding Plan endpoint. ([aitoolanalysis](https://aitoolanalysis.com/glm-coding-plan-review/), [cerebras.ai](https://www.cerebras.ai/blog/glm-4-7))
- **Reliability:** Documented instability under load — after the GLM-5 launch, traffic spiked ~10x, the service was unstable for days, new subscriptions were briefly capped, and Z.ai issued a public apology. GLM-4.6 hallucinates / produces erroneous code (off-by-one, edge-case misses) somewhat more than Claude; Claude leads on deep debugging and tricky reasoning. GLM-4.7 improved stability and tool-use consistency. ([cirra.ai](https://cirra.ai/articles/glm-4-6-vs-claude-sonnet-comparison), [medium/leucopsis](https://medium.com/@leucopsis/glm-4-6-review-0600e9425c73))
- **Data-residency note:** the cloud API routes through servers in China — a consideration for sensitive code. ([aitoolanalysis](https://aitoolanalysis.com/glm-coding-plan-review/))

---

## 5. Recommendation table — when to use GLM heavily / lightly / avoid

Times shown in **US Eastern** with **UTC+8** in parentheses (peak = 14:00–18:00 UTC+8 ≈ 02:00–06:00 ET).

| Condition | Recommendation | Why |
|-----------|----------------|-----|
| **Western working hours (≈08:00–24:00 ET = off-peak in UTC+8)** | **USE GLM HEAVILY** for routine/bulk/boilerplate coding | Off-peak = currently 1x quota (promo) on flagship; cheapest possible. |
| **Late night US-East ~02:00–06:00 ET (= 14:00–18:00 UTC+8 peak)** | **AVOID flagship GLM-5.2 / use lightly** | 3x quota burn on GLM-5.2/Turbo; concurrency tightened. Switch to GLM-4.7 (no multiplier) or to Opus. |
| **Routine edits, refactors, tests, scaffolding (any time)** | **USE GLM** (prefer GLM-4.7 to dodge the multiplier) | Cheap; GLM-4.7 has no peak surcharge; quality is adequate. |
| **Hard debugging, tricky reasoning, architecture, correctness-critical code** | **AVOID GLM → use Opus** | GLM hallucinates/errs more; Opus more reliable for deep work. |
| **Parallel / multi-agent / subagent fan-out** | **AVOID GLM on Lite/Pro → use Opus** (or Max off-peak) | Effective concurrency can be ~1; subagent workflows fail. |
| **Latency-sensitive / tight interactive loop** | **Prefer Opus**; GLM only if cost dominates | GLM among slowest models; ~50–100 tok/s. |
| **Promo ends (after ~Sept 2026), off-peak reverts to 2x** | **Re-evaluate**; shift more flagship load to GLM-4.7, keep Opus for hard tasks | Off-peak flagship cost doubles; GLM-4.7 stays base-rate. |
| **Big context / long-running autonomous loop where speed matters less** | **USE GLM** | Token efficiency + low cost outweigh slowness when not waiting on it. |
| **Sensitive / proprietary code with data-residency concerns** | **AVOID GLM cloud API** | Routes through China-based servers. |

**Codified cost rule of thumb:** If you must run the flagship **GLM-5.2 during peak (3x)**, its effective subscription cost-per-prompt roughly triples — at that point Opus's reliability/speed often wins. **During off-peak (currently 1x), GLM is dramatically cheaper than Opus** and is the default choice for non-critical work. **GLM-4.7 sidesteps the multiplier entirely** and is the safest "always-on cheap" pick.

---

## Uncertainties / verify-before-relying

- **Exact peak window** — 14:00–18:00 UTC+8 is the most-cited figure but not confirmed on a fetched official page; the "2–6 AM ET" promo phrasing is from Z.ai's X account and roughly aligns. The *billing*-peak definition vs. *promo-availability* window may differ. **Confirm on [docs.z.ai/devpack/usage-policy](https://docs.z.ai/devpack/usage-policy).**
- **Off-peak 1x promo end date** — reported "end of September 2026"; earlier promos said "end of April." Dates shift.
- **Tier prices** — range across sources ($10/$30/$80 vs $18/$72/$160 vs Pro $15). Region-, cycle-, and promo-dependent.
- **Concurrency numbers** — not officially published; "~1 in-flight" is a user report on one tier/tool.
- **GLM-5.2 token pricing** (~$1.40/$4.40) is approximate from an aggregator.
- Official Z.ai pages are JS-rendered; WebFetch could not load them directly, so the above leans on WebSearch summaries and third-party guides.

## Sources
- Z.ai subscribe / plans: https://z.ai/subscribe
- Z.ai dev docs overview: https://docs.z.ai/devpack/overview
- Z.ai usage policy: https://docs.z.ai/devpack/usage-policy
- Z.ai FAQ: https://docs.z.ai/devpack/faq
- Z.ai API pricing: https://docs.z.ai/guides/overview/pricing
- AI Pricing Guru: https://www.aipricing.guru/z-ai-subscription-pricing/
- BuyGLM guide: https://buyglm.com/guides/glm-coding-plan-guide
- Distk guide: https://distk.in/blog/glm-coding-plan-pricing-guide-2026.html
- codingplan.run: https://codingplan.run/plans/glm-coding-plan
- vibecoding.app: https://vibecoding.app/blog/zhipu-ai-glm-pricing-2026
- pricepertoken (Z-ai): https://pricepertoken.com/pricing-page/provider/z-ai
- OpenRouter GLM-4.6: https://openrouter.ai/z-ai/glm-4.6
- OpenRouter GLM-4.7: https://openrouter.ai/z-ai/glm-4.7
- Cirra GLM-4.6 vs Sonnet: https://cirra.ai/articles/glm-4-6-vs-claude-sonnet-comparison
- AI Tool Analysis review: https://aitoolanalysis.com/glm-coding-plan-review/
- Cerebras GLM-4.7 speed: https://www.cerebras.ai/blog/glm-4-7
- opencode concurrency bug #8618: https://github.com/anomalyco/opencode/issues/8618
- Ivan Fioravanti / X (multiplier): https://x.com/ivanfioravanti/status/2043685076186120442
- Z.ai / X (peak window promo): https://x.com/Zai_org/status/2033233961669783600
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
