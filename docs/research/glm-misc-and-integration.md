# GLM (Zhipu AI / Z.ai) in Claude Code — Misc & Integration Research

**Researcher focus:** Practical/operational + integration knowledge for building a real MCP that delegates to GLM via Claude Code's Anthropic-compatible path.
**Date compiled:** 2026-06-30.
**Confidence note:** Endpoint and env-var facts below are corroborated across the official Z.ai docs and multiple independent write-ups and are high-confidence. Exact *default* model mappings, per-tier concurrency limits, and "GLM 5.2" naming evolve fast — flagged inline where uncertain. WebFetch against `docs.z.ai`/`zcode.z.ai` failed during research (the fetch backend was itself routed to a broken `glm-4.7`), so direct-doc quotes below are reconstructed from search snippets of those same official pages, not first-party fetches. **Verify the two or three load-bearing values against the live docs before shipping.**

---

## 0. TL;DR for the MCP builder

- **Anthropic-compatible base URL (use this for Claude Code):** `https://api.z.ai/api/anthropic`
  Messages endpoint resolves to `https://api.z.ai/api/anthropic/v1/messages`.
- **Auth:** set `ANTHROPIC_AUTH_TOKEN` (NOT `ANTHROPIC_API_KEY`) to your Z.ai key. `AUTH_TOKEN` → `Authorization: Bearer <key>`; `API_KEY` → `x-api-key: <key>`. Gateways like Z.ai expect Bearer, so use `ANTHROPIC_AUTH_TOKEN`.
- **Current flagship model ID:** `glm-5.2` (and the 1M-context variant `glm-5.2[1m]`). "GLM 5.2" the user mentioned is **real** — released June 13–16, 2026.
- **Lightweight / cheap model:** `glm-4.5-air` (default Haiku mapping). Also `glm-5-turbo` exists as a faster GLM-5-class model.
- **Biggest operational gotcha for a *subagent/MCP* use case:** an **undocumented low concurrency limit (reported as 1 in-flight request on paid tiers)**. Parallel/background/multi-agent fan-out is exactly what triggers "Too much concurrency" errors. This is the single most important finding for delegating work to GLM.

---

## 1. Exact integration details

### 1.1 Base URLs (all three)

| Purpose | Base URL |
|---|---|
| **Anthropic-compatible** (Claude Code, Cline, etc.) | `https://api.z.ai/api/anthropic` |
| OpenAI-compatible — **general** | `https://api.z.ai/api/paas/v4` |
| OpenAI-compatible — **Coding Plan only** | `https://api.z.ai/api/coding/paas/v4` |

- **China-mainland / BigModel variant** (Zhipu's domestic brand `open.bigmodel.cn`): OpenAI-compatible general `https://open.bigmodel.cn/api/paas/v4`, coding-only `https://open.bigmodel.cn/api/coding/paas/v4`. The install script is hosted at `https://cdn.bigmodel.cn/install/claude_code_zai_env.sh`. `z.ai` is the **international** brand; `bigmodel.cn` is the **domestic (China)** brand of the same company. For non-China users, prefer the `api.z.ai` hosts.
- **Important:** the Coding Plan subscription quota is keyed to the *coding* endpoints. The general `/api/paas/v4` endpoint is billed against prepaid balance / resource packages, **not** the Coding Plan, and "is not applicable to general API scenarios" vice-versa. Don't cross them.
- Some older write-ups reference `https://open.z.ai/api/paas/v4`; treat as stale. If a request 404s, try the other host and re-check live docs.

Sources: [docs.z.ai HTTP API](https://docs.z.ai/guides/develop/http/introduction), [Z.ai API complete guide](https://www.aimadetools.com/blog/z-ai-api-complete-guide/), [ClaudeLog: Z.AI in Claude Code](https://claudelog.com/faqs/how-to-use-z-ai-in-claude-code/).

### 1.2 Headers (raw HTTP, if the MCP calls the API directly instead of through Claude Code)

- **Anthropic-compatible (`/v1/messages`):**
  - `Content-Type: application/json`
  - `x-api-key: <ZAI_KEY>`  *(or `Authorization: Bearer <ZAI_KEY>` — both observed working)*
  - `anthropic-version: 2023-06-01`
- **OpenAI-compatible (`/chat/completions`):**
  - `Content-Type: application/json`
  - `Authorization: Bearer <ZAI_KEY>`
  - body: `{"model":"glm-5.2","messages":[...]}`

### 1.3 API key format

- Pass the key directly as a bearer/`x-api-key` token for normal use.
- The key internally has the shape `<id>.<secret>` (a dot-separated pair) and can be used to mint a JWT for JWT-auth flows, but **you generally do not need to do this** — the raw key works as a bearer token.
- Common auth errors: `401/1000` "Authentication Failed" (wrong/revoked key, or a stray space/newline got pasted in — regenerate), `401/1003` "Authentication Token expired."

Source: [How to get a Z.AI API key](https://developer.puter.com/tutorials/how-to-get-zai-glm-api-key/), [docs.z.ai HTTP API](https://docs.z.ai/guides/develop/http/introduction).

### 1.4 Claude Code setup (the canonical method)

Edit `~/.claude/settings.json` (only add/replace these keys — don't clobber the file):

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your_zai_api_key",
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.2[1m]"
  }
}
```

Notes:
- `API_TIMEOUT_MS: 3000000` = 50 minutes. **Needed** — long 1M-context / Max-effort calls can take a long time to first token; the default timeout kills them mid-flight, producing confusing "connection error" failures.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW: 1000000` pairs with the `[1m]` suffix to actually use the million-token window.
- The `[1m]` suffix selects the 1M-context variant. If Claude Code says the `[1m]` model "does not exist," **upgrade Claude Code** to the latest version.
- **Z.ai recommends NOT hardcoding model mappings.** If you delete the three `ANTHROPIC_DEFAULT_*` keys, the server applies its own current default mapping (so you auto-track the latest GLM). Hardcoding pins you to a model that may be deprecated. For an MCP, decide deliberately: explicit IDs = reproducible/predictable; deleted = auto-latest.
- Use `ANTHROPIC_AUTH_TOKEN`, **not** `ANTHROPIC_API_KEY`. If both are set, Claude Code prefers the token. The token goes out as `Authorization: Bearer`, which Z.ai's gateway expects.
- Optional: in `~/.claude.json`, set `"hasCompletedOnboarding": true` to skip the first-run onboarding/auth prompt.
- macOS/Linux auto-installer: `curl -O "https://cdn.bigmodel.cn/install/claude_code_zai_env.sh" && bash ./claude_code_zai_env.sh` (**no Windows support** — Windows users must edit `settings.json` manually, which is the case for this MCP's host environment).

Source: [docs.z.ai Claude Code guide](https://docs.z.ai/scenario-example/develop-tools/claude), [docs.z.ai model switching](https://docs.z.ai/devpack/latest-model), [larridin GLM-5.2 in Claude Code](https://larridin.com/blog/use-glm-5-2-claude-code-cut-costs-50), [aiengineerguide](https://aiengineerguide.com/til/glm-5-2-claude-code/).

### 1.5 Confirmed / current model IDs

| Model ID | Role | Notes |
|---|---|---|
| `glm-5.2` | Current flagship coding/agentic model | ~753B MoE, ~40B active, 1M context (1,048,576 tok), up to ~128K–131K output. Released Jun 2026. |
| `glm-5.2[1m]` | 1M-context variant of 5.2 | Suffix form used in Claude Code mappings. |
| `glm-5-turbo` | Faster/cheaper GLM-5-class | Marketed alongside 5.2 on the Coding Plan. |
| `glm-4.7` | Prior-gen flagship | Still offered; cheaper-than-flagship general workhorse. Note: more rigid refusal behavior (see §4). |
| `glm-4.6` | Older coding model | Widely documented, OpenAI slug `z-ai/glm-4.6`. |
| `glm-4.5` | Older | First GLM gen to support Claude Code. |
| `glm-4.5-air` | Lightweight | **Default Haiku mapping**; good for cheap background tasks. |

**"GLM 5.2" disambiguation:** the user's "GLM 5.2" maps directly to model ID **`glm-5.2`** (or `glm-5.2[1m]` for full context). It is NOT a typo for 4.5/4.6 — GLM-5.2 is the genuine current flagship (open weights MIT-licensed on Hugging Face / ModelScope). Pricing on the standalone API: ~$1.40 / 1M input, ~$4.40 / 1M output.

- Aggregator slugs differ from bare IDs: OpenRouter `z-ai/glm-5.2`; AI/ML API `zhipu/glm-4.6`; Mastra `zhipuai-coding-plan/glm-4.5-air`. **Use bare IDs (`glm-5.2`, `glm-4.5-air`) when talking to Z.ai directly.**

Sources: [docs.z.ai GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2), [Together AI GLM-5.2](https://www.together.ai/models/glm-52), [eigent GLM-5.2](https://www.eigent.ai/blog/glm-5-2), [zai-org/GLM-5 GitHub](https://github.com/zai-org/GLM-5).

### 1.6 Quick verification

- Curl test: `POST https://api.z.ai/api/anthropic/v1/messages` with your key → response JSON should show `"model":"glm-..."`.
- In a Claude Code session: `/status` should show the settings source as your `~/.claude/settings.json` and the model as `glm-5.2` / `glm-5.2[1m]`. `/effort` switches thinking intensity (GLM-5.2 has **High** and **Max**; Z.ai recommends **Max** for coding).
- Identity probe ("what model are you?") and watching that the first call hits `api.z.ai` (not `api.anthropic.com`) catch silent fallback/misconfiguration.

---

## 2. claude-code-router (CCR) — how it routes to GLM (brief)

- **What it is:** an open-source local proxy (`musistudio/claude-code-router`, run via `ccr code`). Claude Code speaks Anthropic format only; CCR intercepts `/v1/messages`, converts to a unified OpenAI-style intermediate format, routes per-request to any provider, and converts the response back. Config: `~/.claude-code-router/config.json` with `Providers[]` + `Router{}` blocks.
- **Routing categories:** `default`, `background` (cheap/fast), `think` (reasoning), `longContext` (past `longContextThreshold`, default 60000 tok), `webSearch`. Models referenced as `provider,model`. Supports **fallback chains** (auto-retry next model on HTTP error).
- **GLM-specific quirk it fixes — reasoning:** GLM's `/chat/completions` has reasoning on by default but the model self-decides whether to think; Claude Code's heavy system prompt suppresses that, so GLM rarely reasons. CCR ships a small **`reasoning` transformer** (<40 lines) that explicitly signals GLM to think, restoring chain-of-thought for GLM-4.5/4.6. Other useful transformers: `enhancetool` (tolerance for malformed tool-call params, but disables streaming of tool calls), `cleancache` (strips `cache_control`).
- **When to use CCR vs. native env-vars:** the native `ANTHROPIC_BASE_URL` route (§1.4) is simpler and is the official Z.ai path — fine for a single GLM target. CCR is worth it when you want **per-request-type routing** (e.g., GLM for default/background but Claude for `think`), **fallback between providers**, or to fix GLM's reasoning suppression. The project is now sponsored by Z.ai via the GLM Coding Plan.

Sources: [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router), [CCR transformers](https://musistudio.github.io/claude-code-router/docs/server/config/transformers/), [CCR routing](https://musistudio.github.io/claude-code-router/docs/server/config/routing/), [CCR blog (GLM reasoning)](https://musistudio.github.io/claude-code-router/blog/).

---

## 3. Data privacy / residency / retention (CRITICAL for proprietary code)

- **Servers are in China.** Zhipu AI (international brand Z.ai) is Beijing-based. Latency ~100–200ms from EU/US.
- **Chinese jurisdiction risk:** API users are subject to China's **National Intelligence Law**, which can compel Chinese companies to cooperate with state intelligence. The privacy policy's "compliance with applicable laws" clause is the hook for this. Independent coverage explicitly flags "China data risk" for API (vs. self-hosted) use.
- **Entity List:** the US Bureau of Industry and Security added Zhipu AI to its **Entity List in January 2025** (AI / military-modernization rationale). Relevant for some corporate/government users' procurement and export-compliance posture.
- **Stated retention (per Z.ai privacy policy / DPA):** For API, the company says it **does not store** the content you input/generate — processed in real time, not saved — **except** that "Customer Data other than that covered above" may be **temporarily stored** to provide the service or "in compliance with applicable laws." Account-level data (account info + inputs) is retained while the account exists.
- **Practical guidance for an MCP handling proprietary code:**
  - Treat anything sent to GLM cloud as potentially exposed to a foreign jurisdiction, regardless of the no-storage claim. Do **not** route secrets, credentials, or regulated/IP-sensitive code through the cloud API without legal sign-off.
  - Consider a **sensitivity gate** in the MCP: only delegate non-sensitive tasks (boilerplate, scaffolding, public-API glue) to GLM; keep proprietary/regulated paths on a trusted provider or local model.
  - **Self-hosting the open weights** (MIT-licensed, on HF/ModelScope) fully removes the China-server/jurisdiction issue — the recommended route for strict-privacy orgs (at the cost of substantial GPU infra for a ~753B MoE).
- **Not legal advice** — have counsel assess against your specific compliance regime (GDPR, ITAR/EAR, sector rules).

Sources: [Z.ai privacy policy](https://docs.z.ai/legal-agreement/privacy-policy), [TechTimes: China data risk](https://www.techtimes.com/articles/318543/20260617/glm-52-open-weights-live-top-coding-benchmark-api-use-carries-china-data-risk.htm), [SCMP on GLM-5.2 open-source](https://www.scmp.com/tech/tech-trends/article/3357115/zhipu-ais-stock-rockets-after-chinese-firm-makes-glm-52-open-source).

---

## 4. Known limitations, failure modes, quirks

- **Tool-call streaming corruption:** during multi-step agentic editing, GLM responses intermittently emit **malformed / duplicated tool-call markers** in streamed text (non-deterministic, more frequent over long sessions), which can crash the agent. CCR's `enhancetool` transformer mitigates by tolerating malformed params (trade-off: tool calls stop streaming). On benchmarks GLM tool-calling is actually strong (GLM-4.5 ~90.6% success, edging Claude Sonnet 4's 89.5%), so this is a streaming/format issue, not a capability gap.
- **Reasoning suppression in Claude Code:** GLM often **won't think** under Claude Code's system prompt unless explicitly nudged (the CCR reasoning-transformer problem, §2). If GLM seems "shallow," this is likely why. Use `/effort` → Max.
- **Degenerate loops:** GLM-5 has been observed entering long identical-failing-call loops (e.g., 137 steps repeating a failing call with no argument adaptation). Note this is **not GLM-specific** — Claude Opus produced even longer empty-call trajectories in the same benchmark. Build loop/step caps into the MCP regardless of provider.
- **Refusals:** generally *lighter* than ChatGPT; GLM-4.6 described as a "happy medium." **But GLM-4.7 specifically has more rigid, dominant refusal behavior** that can interfere. If using 4.7 as the workhorse, watch for spurious refusals; `glm-5.2` is reportedly better (fewer false positives, better multi-turn jailbreak resilience).
- **Context degradation:** industry-wide degradation past ~100K tokens applies here too. Although 5.2 advertises 1M context, effective agentic reliability is best kept well under that; some sources note ~128K as the practical sweet spot for agentic loops. Don't assume 1M = 1M usable.
- **Non-coding weakness:** more hallucination and lower reliability on non-coding tasks; weaker on open-ended reasoning / nuanced judgment and graduate-level science (GLM-4.6 ranked ~#15 on GPQA). Best for **well-scoped coding**, not the hardest multi-file SWE or open-ended reasoning — keep those on a stronger model.
- **Self-hosted small variants** (`glm-4.7-flash` etc.) are notably flakier in Claude Code (context loss, tool errors) than the hosted flagship.

Sources: [Cirra: GLM-4.6 tool calling](https://cirra.ai/articles/glm-4-6-tool-calling-mcp-analysis), [sglang issue #15721 (4.7 tool calling in Claude Code)](https://github.com/sgl-project/sglang/issues/15721), [ollama issue #13820 (4.7-flash)](https://github.com/ollama/ollama/issues/13820), [MindStudio 5.2 vs GPT-5.5 vs Opus](https://www.mindstudio.ai/blog/glm-5-2-vs-gpt-5-5-vs-claude-opus-agentic-workflows), ["When Refusals Fail" arXiv](https://arxiv.org/pdf/2512.02445).

---

## 5. Reliability / uptime / regional access

- **General uptime:** considered reliable for single-session work; occasional slowdowns during **Chinese business hours**. No first-party public status/uptime page with historical incidents was found — monitor Z.ai's own channels.
- **Latency:** ~100–200ms from EU/US (servers in China). For interactive Claude Code sessions this is reportedly not very noticeable.
- **Regional timing upside:** Z.ai peak hours are 14:00–18:00 UTC+8 — i.e., early morning / overnight in EU/US, so Western users often hit off-peak naturally.
- **THE concurrency limit (most important for a subagent MCP):** an **undocumented low concurrency cap — reported as 1 in-flight request even on paid (Pro) tiers** for GLM-4.7. A paying user could only consume ~4% of their 5-hour quota before hitting "Too much concurrency." **Multi-agent / background-task fan-out overwhelms it immediately.** Z.ai's plan pages don't publish concurrency numbers. **This directly constrains using GLM as a parallel delegated subagent** — design the MCP to serialize requests (a queue / mutex), add exponential backoff on "Too much concurrency"/429, and avoid spawning concurrent GLM calls. Confirm current limits with Z.ai support before relying on parallelism.
- **Rate-limit/quota model:** quota is "prompts per 5 hours" + weekly caps, not classic RPM. Each "prompt" ≈ 15–20 model calls.

Sources: [opencode issue #8618 (concurrency=1)](https://github.com/anomalyco/opencode/issues/8618), [docs.z.ai FAQ](https://docs.z.ai/devpack/faq), [Z.ai rate limits](https://z.ai/manage-apikey/rate-limits), [Z.ai API guide](https://www.aimadetools.com/blog/z-ai-api-complete-guide/).

---

## 6. Other operationally important notes (for GLM as a delegated subagent)

- **Plan tiers & quota economics (approximate, USD/mo):** Lite ~$18 (~80 prompts/5h, ~400/wk), Pro ~$72 (~400/5h, ~2,000/wk), Max ~$160 (~1,600/5h, ~8,000/wk), plus monthly MCP web-search/reader allowances (100 / 1,000 / 4,000). A cheaper Lite tier near **$3/mo** has also been cited historically. **Pricing/tier names shift often — verify on [z.ai/subscribe](https://z.ai/subscribe).**
- **Quota burn multiplier:** GLM-5.2 and GLM-5-turbo deduct at **3× during peak, 2× off-peak** (vs. 1× standard for older models). A **1× off-peak promo runs through end of Sept 2026.** Z.ai's own guidance: use GLM-5.2 for complex tasks, fall back to GLM-4.7 for routine work to conserve quota. For an MCP, route cheap/background work to `glm-4.5-air` or `glm-4.7` and reserve `glm-5.2[1m]` for hard tasks.
- **Coding-plan quota only counts on the coding/Anthropic endpoints.** If the MCP accidentally hits the general `/api/paas/v4` endpoint, it bills prepaid balance instead of the plan — a silent cost leak.
- **Drop-in compatibility breadth:** Z.ai is (per its own marketing) the main non-Anthropic vendor offering an Anthropic-compatible endpoint, so the same `ANTHROPIC_BASE_URL` trick works for Cline, OpenCode, Cursor, Kilo Code, etc. — the MCP's approach is portable.
- **Settings isolation:** because GLM config is just env-vars in `~/.claude/settings.json`, it's global to Claude Code. To run GLM as a *delegated* path without hijacking the user's main Claude session, consider an **isolated settings dir / separate process** with its own `ANTHROPIC_BASE_URL`+token (cf. `MG-Cafe/claudecode-glm-stack` and `ankurkakroo2/claude-code-glm-setup`, which run GLM inside Claude Code with isolated settings + session indicators), or call the `/v1/messages` endpoint directly from the MCP rather than shelling out to a globally-reconfigured Claude Code.
- **Windows caveat:** the official auto-install script is macOS/Linux only; on this Windows host, configure `settings.json` manually.

Sources: [aipricing.guru GLM plan pricing](https://www.aipricing.guru/z-ai-subscription-pricing/), [z.ai/subscribe](https://z.ai/subscribe), [MG-Cafe/claudecode-glm-stack](https://github.com/MG-Cafe/claudecode-glm-stack), [ankurkakroo2/claude-code-glm-setup](https://github.com/ankurkakroo2/claude-code-glm-setup).

---

## Open items to verify against live docs before shipping the MCP
1. **Current default model mapping** when `ANTHROPIC_DEFAULT_*` are omitted (changes when Z.ai promotes a new flagship). Check [docs.z.ai/devpack/latest-model](https://docs.z.ai/devpack/latest-model).
2. **Exact concurrency limit per tier** (the "1" figure is a user report, not official). Confirm with Z.ai support.
3. Whether `glm-5.2[1m]` vs `glm-5.2` is needed for your context sizes, and current output-token cap.
4. Live pricing/tier names and the 1× off-peak promo end date.
