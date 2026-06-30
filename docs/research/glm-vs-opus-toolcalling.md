# GLM (Zhipu / Z.ai) vs Claude Opus: Tool-Calling & Agentic Behavior

**Purpose:** Resolve the apparent contradiction — GLM scores *well* on tool-calling/function-calling benchmarks yet often performs *worse* in sustained multi-step agentic loops — so a router can decide whether to delegate a coding subtask to GLM (cheap) or keep it on Opus.

**Research date:** 2026-06-30. Sources are cited inline. Vendor claims vs independent results are flagged.

---

## TL;DR (the resolution of the contradiction)

The contradiction is **mostly real but mostly fixable, and the cause is state-handling, not raw capability.**

1. **One-shot schema adherence:** GLM is genuinely excellent. It matches or beats Opus on BFCL and tau-bench. Clean JSON, refuses unknown tools, minimal argument hallucination.
2. **Sustained agentic loops:** GLM degrades — but the dominant observed failure mode is **NOT** "GLM is dumb at planning." It is that **GLM requires its `reasoning_content` (thinking blocks) to be fed back into the conversation on every turn** ("Preserved Thinking"). When a harness drops that field, GLM **loses its plan after each tool call and falls into infinite loops** — redoing work, corrupting files, spawning redundant subagents.
3. **"Plan-then-act" framing:** Independent analysis confirms GLM's default tool-use pattern is more "Thinking/Planning → Calling tools as planned → Synthesizing" (front-loaded planning) than Opus's turn-by-turn interleave. This makes GLM more brittle when downstream steps depend on earlier *tool results* it didn't anticipate during the upfront plan.
4. **Opus interleaves natively.** Claude 4+ reasons *between* tool calls (interleaved thinking), adapting mid-execution. On Opus 4.6+ adaptive mode it is automatic. This is the structural reason Opus holds up over long loops.
5. **Routing rule of thumb:** GLM is fine for *one tool call or a short, independent fan-out of calls with a clean schema*. Keep Opus for *long, dependent, MCP-heavy agentic loops* — **especially in any harness whose `reasoning_content` passthrough you have not verified.** Within Claude Code (which does preserve thinking), GLM is far more usable for multi-turn work than in third-party harnesses.

---

## 1. How GLM-4.7 / GLM-5.x handle multi-turn tool use

### The hybrid reasoning model
GLM is not purely interleaved *or* purely plan-then-execute. Z.ai documents a **hybrid** that supports several modes: thinking, non-thinking, **interleaved reasoning**, **planned-before-response**, and **planned-before-tool-call** ([GLM-4.5 GitHub](https://github.com/zai-org/GLM-4.5), [Z.AI Thinking Mode docs](https://docs.z.ai/guides/capabilities/thinking-mode)). Interleaved thinking has been *supported* since GLM-4.5 — GLM can think between tool calls and after receiving tool results.

GLM-4.7 adds:
- **Interleaved Thinking** — "thinks before every response and tool calling."
- **Preserved Thinking** — "in coding agent scenarios, the model automatically retains all thinking blocks across multi-turn conversations, reusing existing reasoning instead of re-deriving from scratch."
- **Turn-level / per-turn thinking control.**
- Thinking is **enabled by default** in GLM-4.7+ (different from GLM-4.6's hybrid default).
([GLM-4.7 README](https://huggingface.co/zai-org/GLM-4.7/blob/main/README.md))

### The catch: Preserved Thinking is a hard dependency, and harnesses break it
This is the heart of the "worse at agentic loops" observation. GLM via Z.AI **requires `reasoning_content` to be passed back to the API on every assistant turn**, using `thinking: {type: "enabled", clear_thinking: false}` and appending `reasoning_content` into each assistant message. If the harness **drops `reasoning_content`**, GLM loses its reasoning state and **loops**.

Concrete independent evidence:
- **Goose issue #7363:** GLM-4.7/GLM-5 "lose all reasoning context after every single action and spiral into infinite loops — redoing completed work, corrupting files, and spawning redundant subagents." The *same task* completed in **Claude Code in ~2 minutes**, but in Goose took **40+ tool calls and 40+ minutes with no completion** ([goose#7363](https://github.com/aaif-goose/goose/issues/7363)).
- **oh-my-pi issue #517:** GLM-5 "gets stuck repeating the same actions" after **2–5 messages/tool calls**; reasoning resets between turns; root cause is the harness dropping `reasoning_content`. **GLM-4.7 is NOT affected** by the same loop ([oh-my-pi#517](https://github.com/can1357/oh-my-pi/issues/517)). This is important: GLM-5's *stronger* reasoning made it *more* dependent on state preservation, so it breaks in harnesses that GLM-4.7 tolerated.
- **ClawsBench (cited via secondary):** GLM-5 reportedly entered a **137-step loop of identical failing calls with zero argument adaptation**, with the actual plan only appearing at the final step — a severe variant of the same stop-and-replan / state-loss pattern.

**The fix** (per [Cerebras GLM-4.7 migration guide](https://www.cerebras.ai/blog/glm-4-7-migration-guide)): set `clear_thinking: false` for agent loops / multi-step plans / coding sessions so internal state carries across calls; use `clear_thinking: true` only for one-off calls, batch jobs, or when you see drift.

### Plan-then-act vs interleave (the observed default)
Independent technical analysis of GLM-4.6 tool calling describes the default trace as: **"Thinking/Planning… Calling tool(s) as planned… Synthesizing final answer"** — i.e., **explicit planning before execution rather than interleaved improvisation** ([Cirra: GLM-4.6 Tool Calling & MCP analysis](https://cirra.ai/articles/glm-4-6-tool-calling-mcp-analysis)). So even when the *capability* to interleave exists, GLM's behavioral tendency skews toward front-loaded plans. That is exactly what hurts in loops where step N's correct action only becomes knowable after step N-1's tool *result*.

### Known issues summary
- **Reasoning suppressed/lost during tool use** → caused by harness dropping `reasoning_content`, not the model. Fixable.
- **Stop-and-replan / infinite loops** → same root cause; worse on GLM-5 than GLM-4.7.
- **Streaming tool-call corruption** → not strongly documented as a GLM-specific defect; MoE latency variability noted as a general caveat ([Cirra](https://cirra.ai/articles/glm-4-6-tool-calling-mcp-analysis)).

---

## 2. How Opus handles interleaved reasoning + tool use (and why it helps loops)

Claude 4 models support **interleaved thinking**: reason *between* tool calls, not just before them — "think, call a tool, see the result, think again, proceed" ([Anthropic adaptive thinking docs](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking), [Grokipedia: Interleaved thinking](https://grokipedia.com/page/Interleaved_thinking_Claude_AI)).

Why it matters for long loops:
- **Mid-execution adaptability.** Without it, Claude commits to a plan upfront; with it, Claude adapts after each tool result. This is decisive when downstream decisions depend on what earlier calls returned.
- **Automatic on Opus 4.6+ adaptive mode** (no beta header). On older Claude 4 models, enable via `interleaved-thinking-2025-05-14`. *Caveat:* Opus 4.6 **manual** mode does **not** support interleaved thinking — use adaptive mode for agentic work.
- **Thinking budget can exceed `max_tokens`** within a turn (whole context window available), and a `task_budget` beta (`task-budgets-2026-03-13`) lets the model pace itself across an *entire* loop. Both are built for long-horizon agentic runs.

Anthropic explicitly recommends adaptive thinking for "multi-step tool use, complex coding tasks, and long-horizon agent loops." The practical upshot, mirrored by the Goose data point, is that **Claude Code preserves thinking state for you**, so Opus rarely hits the state-loss loop that bites GLM in third-party harnesses.

---

## 3. Single-shot schema adherence vs sustained orchestration — clearly distinguished

| Dimension | Single tool call / structured extraction | Sustained agentic orchestration (many dependent calls) |
|---|---|---|
| **What's tested** | Correct function name, correct/typed args, valid JSON, refuse unknown tools | Carrying intent across N turns, adapting to tool *results*, not looping, recovering from errors |
| **GLM** | **Strong.** "Boring magic": strict schema compliance, won't fabricate extra params, JSON-native, explicit errors, "zero hallucination in tool calls" ([Cirra](https://cirra.ai/articles/glm-4-6-tool-calling-mcp-analysis)) | **Fragile in practice.** Plan-then-act tendency + Preserved-Thinking dependency → loops/state loss when harness imperfect ([goose#7363](https://github.com/aaif-goose/goose/issues/7363), [oh-my-pi#517](https://github.com/can1357/oh-my-pi/issues/517)) |
| **Opus** | Strong (slightly lower raw BFCL than GLM, see §4) | **Strong & robust** via native interleaved thinking + harness-managed state |
| **Bench proxy** | BFCL v3 | tau/tau²-bench, SWE-bench Verified/Pro, Terminal Bench |

GLM may be *fully fine* at the former and *weak/unreliable* at the latter. The benchmarks that conflate the two are what create the illusion of contradiction.

---

## 4. Benchmarks that separate the two (with numbers vs Opus)

### Function-calling / schema benchmarks (GLM looks great)
- **BFCL v3 (GLM technical report, vendor):** GLM-4.5 **77.8** vs Claude Opus 4 **74.4**, Claude Sonnet 4 **75.2** — GLM best overall ([GLM-4.5 paper](https://arxiv.org/pdf/2508.06471)).
- **BFCL v3 live leaderboard (independent, ~Jun 2026):** GLM-4.5 **76.7%**, Claude Opus 4.7 **76.6%**, Gemini 3.1 Flash Lite **76.5%** — essentially tied at the top ([pricepertoken BFCL v3](https://pricepertoken.com/leaderboards/benchmark/bfcl-v3)).

### Agentic tool-use benchmarks (close; GLM competitive, Opus edges some)
- **tau-bench (GLM-4.5 report, vendor):** Retail GLM **79.7** vs Opus 4 **81.4**; Airline GLM **60.4** vs Opus 4 **59.6** — basically on par ([GLM-4.5 paper](https://arxiv.org/pdf/2508.06471)).
- **τ²-bench (GLM-4.7 README, vendor):** GLM-4.7 **87.4%** (GLM-4.6 75.2%). Strong, but vendor-reported, no head-to-head Opus number in same table ([GLM-4.7 README](https://huggingface.co/zai-org/GLM-4.7/blob/main/README.md)).

### Agentic SWE benchmarks (Opus leads, gap narrowing)
- **SWE-bench Verified (GLM-4.7 README, vendor):** **73.8%** (+5.8 over GLM-4.6); SWE-bench Multilingual 66.7%; Terminal Bench 2.0 41% ([GLM-4.7 README](https://huggingface.co/zai-org/GLM-4.7/blob/main/README.md)).
- **SWE-bench Pro ([morphllm leaderboard](https://www.morphllm.com/swe-bench-pro)):**
  - Claude **Opus 4.8** 69.2% (vendor aggregate, tuned scaffold)
  - Claude **Opus 4.7** 64.3% (vendor aggregate)
  - **GLM-5.2** **62.1%** (third-party measured; "Z.ai published no SWE-bench number at launch")
  - Claude Opus 4.6 51.9% on *Scale standardized* public set — note the huge gap vs vendor aggregates, driven by scaffold/harness differences.
- **GLM-4.6 vs Claude Sonnet 4, CC-Bench (vendor, multi-turn coding):** ~**48.6% win rate** (near parity), with ~15% fewer tokens than GLM-4.5 ([Cirra](https://cirra.ai/articles/glm-4-6-tool-calling-mcp-analysis), [IntuitionLabs](https://intuitionlabs.ai/articles/glm-4-6-open-source-coding-model)). Z.ai itself conceded GLM-4.6 "still lags Claude Sonnet 4.5 in coding."

**Interpretation:** GLM **wins/ties pure function-calling (BFCL)**, **ties tau-bench**, and **trails Opus on agentic SWE** — and the SWE gap is where dependent, long-horizon orchestration is actually stressed. **Strong caveat:** SWE numbers are extremely scaffold-sensitive (Opus 4.6 swings 51.9% → 69.2% by harness), and many GLM figures are vendor-reported. Treat absolute numbers as directional, not exact.

### Naming note
"GLM-5.2" exists: it is the latest iterative release in the GLM-5 family (after GLM-5, GLM-5-Turbo, GLM-5.1), MoE 744B total / 40B active, 1M context, MIT-licensed, released ~mid-June 2026, ~$1.40/$4.40 per M tokens vs Opus ~$5/$25 ([trendingtopics](https://www.trendingtopics.eu/glm-5-2-chinas-zhipu-ai-beats-even-googles-top-models-with-its-new-open-llm/), [SCMP](https://www.scmp.com/tech/tech-trends/article/3357115/zhipu-ais-stock-rockets-after-chinese-firm-makes-glm-52-open-source)). The agentic loop/state-loss issues are documented for **GLM-4.7 and GLM-5**; expect GLM-5.2 to inherit the same Preserved-Thinking dependency (uncertain — not yet independently confirmed for 5.2 specifically).

---

## 5. Concrete routing rules (GLM vs Opus, with why)

Fit weight scale: **-3 = strongly Opus … 0 = neutral … +2 = GLM-favored.**

| # | Scenario | Route | Weight | Why |
|---|---|---|---|---|
| 1 | Single structured extraction / one function call, clean schema | **GLM** | +2 | GLM's schema adherence is best-in-class; cheap; no loop risk in one shot |
| 2 | Short fan-out of *independent* tool calls (no cross-dependency) | **GLM** | +1 | No state-carry needed; plan-then-act is fine when steps don't depend on each other |
| 3 | Boilerplate/CRUD/scaffolding codegen, no long tool loop | **GLM** | +2 | Self-contained, well-specified; ~10× cheaper; quality near-parity |
| 4 | Docs / summarization / local refactor, few or no tool calls | **GLM** | +2 | Plays to GLM strengths; minimal orchestration |
| 5 | Algorithmic codegen with a couple of verification calls | **GLM** | +1 | Short, mostly self-contained; verify output |
| 6 | MCP-heavy task with many dependent tool calls | **Opus** | -3 | Dependent chains need interleaved adapt-to-result; GLM plan-then-act + loop risk |
| 7 | Long-horizon agentic loop (20+ turns, build-on-prior-state) | **Opus** | -3 | Preserved-Thinking fragility → loops; Opus interleaves + harness preserves state |
| 8 | Running in a 3rd-party harness with **unverified** `reasoning_content` passthrough | **Opus** | -3 | This is the exact trigger for GLM infinite loops (goose#7363, oh-my-pi#517) |
| 9 | Multi-step debugging where each fix depends on prior tool output | **Opus** | -2 | Needs mid-execution replanning on results; GLM tends to lose the thread |
| 10 | Subtle/long debugging, large multi-step refactor across many files | **Opus** | -3 | Long + complex; policy + capability both favor Opus |
| 11 | Multi-turn coding *inside Claude Code* (state preserved), medium length | **GLM** then verify | 0 | Claude Code preserves thinking, so GLM is usable; still verify, escalate on drift |
| 12 | Security-sensitive / proprietary / parallel-agent / latency-critical | **Opus** | -3 | Project policy hard rule regardless of capability |

**Operational guardrails:**
- If delegating an agentic task to GLM, ensure `clear_thinking: false` and that the harness re-sends `reasoning_content`. If you can't guarantee that, treat it as scenario #8 → Opus.
- GLM-5/5.2 are *more* sensitive to dropped reasoning state than GLM-4.7. Bias newer GLM toward Opus for loops unless state handling is verified.
- Always verify GLM output on anything past a single call; retry once, then escalate to Opus (per project policy).

---

## Confidence & caveats
- **High confidence:** the loop/state-loss root cause (`reasoning_content` passthrough) — multiple independent harness bug reports converge.
- **Medium confidence:** the "plan-then-act vs interleave" behavioral characterization — supported by one strong independent analysis (Cirra) plus vendor mode docs.
- **Lower confidence / directional only:** absolute benchmark deltas — scaffold-sensitive and partly vendor-reported. GLM-5.2-specific agentic-loop behavior is extrapolated, not independently confirmed.
