# GLM Failure Modes & GLM-vs-Opus Routing Rules

**Purpose:** Turn known GLM (Zhipu/Z.ai) failure modes and special conditions into concrete,
implementable routing conditions for a GLM-vs-Opus delegation router. GLM is ~10x cheaper than
Anthropic Claude Opus, so the default bias is "delegate to GLM unless a condition below fires."

**Date compiled:** 2026-06-30
**Models in scope:** GLM-4.6, GLM-4.7, GLM-4.7-Flash, GLM-5.1, GLM-5.2 (current Z.ai coding-plan
default), GLM-5V-Turbo / GLM-4.6V (vision). Opus reference points: Claude Opus 4.6 / 4.8.

> **Evidence-quality caveat (read first):** Much of the public material is vendor marketing
> (Z.ai blogs, reseller blogs) or single-run anecdotes. Independent, rigorous, GLM-specific
> benchmarks are scarce. Where a claim is vendor-reported or anecdotal it is flagged. Benchmark
> variance across runs is high — one reviewer warns a single run "isn't enough to assert
> anything about absolute model quality." Treat the thresholds below as conservative defaults,
> not measured cliffs.

---

## 1. Long context: advertised vs usable

**Findings**
- **The "1M context" is mostly a GLM-5.2[1m] thing, not the 4.x line.** GLM-4.7/4.6 top out
  architecturally around **~200K tokens** (`max_position_embeddings = 202752`), with a soft
  `model_max_length = 128000` in the tokenizer config and a 128K *output* cap. Practical usable
  input is closer to ~200K once system-prompt/special-token overhead is subtracted.
  ([HF discussion](https://huggingface.co/zai-org/GLM-4.7/discussions/33),
  [automatio.ai](https://automatio.ai/models/glm-4-7),
  [macaron.im](https://macaron.im/blog/what-is-glm-4-7))
- **General long-context degradation is real and starts well before the advertised limit.** The
  industry pattern (not GLM-specific) is that "agents with context length up to 1 million tokens
  show severe degradation already at 100K tokens," and "even with 200K tokens severe performance
  degradation is observed." ([arxiv 2512.02445](https://arxiv.org/pdf/2512.02445))
- No published GLM-specific RULER / needle-in-haystack degradation curve surfaced — **this is an
  uncertainty.** The historical GLM-4 did retain retrieval past 64K better than some peers
  ([arxiv 2411.10137](https://arxiv.org/pdf/2411.10137)), but that does not transfer cleanly to
  4.6/4.7/5.2.
- Structured-output quality (tool-call JSON) specifically degrades in long contexts for GLM-5/5.1
  even when short-context calls are clean (see §10).

**Routing condition**
- Input < ~64K tokens → **GLM** (safe zone).
- ~64K–128K tokens → **GLM, but only for retrieval/summarization-style tasks**; for
  correctness-critical reasoning over the whole context, prefer Opus.
- 128K–200K tokens → switch GLM to **`glm-5.2[1m]`** if the task must stay on GLM; otherwise
  **Opus**. Avoid 4.6/4.7 here.
- \> 200K tokens → **Opus**, or `glm-5.2[1m]` only if cost dominates and the task is
  retrieval/extraction (not multi-hop reasoning) — and verify output.

---

## 2. Long-horizon autonomy / goal drift

**Findings**
- **GLM-4.6 measurably drifts on long-horizon tasks.** A study of execution trajectories on a
  SWE-bench Django permission bug found baseline GLM-4.6 "suffers from goal drift, wandering
  through irrelevant modules for multiple turns," plus "escapism" (ignoring env-config errors to
  fall back on simplistic non-representative scripts). ([arxiv 2602.02619](https://arxiv.org/pdf/2602.02619))
- On the τ² agent benchmark GLM trailed Claude (75.9% vs 88.1%). Claude has demonstrated 30+ hour
  continuous sessions; Opus 4.6 holds the longest *published* autonomous horizon (50% completion at
  ~14.5h). ([creolestudios](https://www.creolestudios.com/glm-5-vs-claude-opus-4-6-performance-pricing-agentic-coding-comparison/),
  [mindstudio](https://www.mindstudio.ai/blog/best-open-source-llms-agentic-coding-2026))
- **Z.ai has explicitly engineered against drift in newer models:** GLM-4.7 "Preserved Thinking"
  (retains reasoning across turns), and GLM-5.1 claims up to **8-hour** autonomous loops with
  "stronger sustained execution." These are *vendor claims*; Claude still holds the longest
  published horizon. ([adam.holter.com](https://adam.holter.com/glm-4-7-z-ais-open-weights-coding-model-pushes-harder-on-agents-tools-and-ui/),
  [docs.z.ai GLM-5.1](https://docs.z.ai/guides/llm/glm-5.1))
- Recurring framing: GLM is good at "do the steps"; Opus is safer when the job is "be correct
  across complexity" (audits, migrations, repo-wide changes).

**Routing condition**
- ≤ ~8 sequential tool-using steps / a single well-scoped feature → **GLM**.
- ~8–20 steps with checkpoints and a clear spec → **GLM (5.1+ preferred)**, but require
  verification at the end.
- \> ~20 steps, OR unsupervised multi-hour autonomy, OR success depends on holding the original
  goal across many turns (migration, repo-wide refactor) → **Opus**.

---

## 3. Hallucination on obscure / newer APIs and libraries

**Findings**
- GLM-4.6's *tool-calling* is relatively disciplined: it "will refuse unknown tools and minimize
  invented arguments" and adheres tightly to provided schemas.
  ([cirra.ai tool calling](https://cirra.ai/articles/glm-4-6-tool-calling-mcp-analysis))
- **But like all LLMs it still hallucinates factual/library details**, and GLM-4.6 specifically was
  noted to sometimes "fix the immediate error but break something else." Schema-field hallucination
  was reportedly *worse* in 4.6 and improved in 4.7. ([cirra](https://cirra.ai/articles/glm-4-6-tool-calling-mcp-analysis),
  [macaron 4.7](https://macaron.im/blog/what-is-glm-4-7))
- Concrete cross-model warning: a hallucinated API tested against a hallucinated implementation
  produced 34 green tests that proved nothing (this example was Opus, but it illustrates the
  "confidently wrong with green tests" risk that applies doubly to a cheaper model on niche APIs).
  ([akitaonrails](https://akitaonrails.com/en/2026/04/18/llm-benchmarks-part-2-multi-model/))
- GLM's training is Chinese-English heavy and its knowledge cutoff/coverage of brand-new or niche
  Western libraries is uncertain — **higher hallucination risk on obscure/post-cutoff APIs.**

**Routing condition**
- Mainstream, well-documented APIs/frameworks → **GLM**.
- Niche / proprietary / very new (post-cutoff) library, or an internal/private API GLM can't have
  seen → **paste the authoritative docs into the GLM prompt** (GLM can't fetch them). If docs can't
  be supplied, or correctness is critical → **Opus**.
- Any task where "confidently wrong with passing tests" is high-cost → Opus, or GLM + independent
  verification of the actual API surface.

---

## 4. Refusals / over-rigidity

**Findings**
- **No GLM-specific over-refusal benchmark surfaced.** General LLM literature documents
  over-refusal (benign prompts rejected for surface keywords, e.g. "how to kill a python
  process"), but nothing quantifies GLM-4.6/4.7 false-refusal rates.
  ([arxiv ORFUZZ 2508.11222](https://arxiv.org/pdf/2508.11222),
  [XSTest/OR-Bench context](https://arxiv.org/pdf/2510.10390))
- Anecdotally GLM-4.6 is described as having "simpler guardrails" and being faster partly because
  of that — suggesting it refuses *less*, not more, than heavily-aligned models.
  ([cirra cost analysis](https://cirra.ai/articles/glm-4-6-vs-claude-sonnet-comparison))
- **This is an uncertainty / low-signal area.** Treat refusals as a retry-then-escalate event
  rather than a pre-routing condition.

**Routing condition**
- Do **not** pre-route based on refusal risk (insufficient evidence).
- Operational rule: if GLM refuses a benign task, **retry once** with clarified intent; if it still
  refuses → **escalate to Opus**.
- Genuinely sensitive/dual-use security content: route to **Opus** for policy reasons regardless
  (already covered by the "security-sensitive → Opus" project rule).

---

## 5. Non-English / multilingual

**Findings**
- **GLM's clearest strength: native Chinese + Chinese-English bilingual.** Built Chinese-first;
  handles code-switching, mixed-language prompts, and translation with fewer hallucination
  artifacts than Western-centric models. Widely called a multilingual leader, esp. for
  Chinese/APAC. ([avenchat](https://avenchat.com/blog/glm-5.2-review),
  [mindstudio GLM-5.2](https://www.mindstudio.ai/blog/what-is-glm-5-2-open-weight-model-2))
- **Caveat:** for English/European tasks requiring deep cultural nuance, the Chinese-heavy corpus
  may be a slight disadvantage vs the best Western models — vendor sources recommend testing per
  use case. ([mindstudio](https://www.mindstudio.ai/blog/what-is-glm-5-2-open-weight-model-2))

**Routing condition**
- Chinese-language or Chinese-English bilingual task → **GLM (prefer for quality AND cost).**
- General English coding/text → GLM is fine (near-Opus on coding benchmarks).
- High-stakes English/European *cultural-nuance* copy (marketing, legal tone, brand voice) → lean
  **Opus** when quality matters more than cost.

---

## 6. Vision / image / screenshot / GUI / computer-use

**Findings**
- **The base coding models (GLM-4.6/4.7) are text models; vision lives in separate models**
  (GLM-5V-Turbo, GLM-4.6V). In Claude Code against GLM-4.7, **pasting images is unreliable** — the
  client transcodes and bypasses the vision path, producing "weird" output. Fix is Z.ai's Vision
  MCP server. ([devgenius vision MCP](https://blog.devgenius.io/fixing-glm-4-7-image-parsing-in-claude-code-add-the-z-ai-vision-mcp-server-f1c275d7cf3f))
- Z.ai's dedicated vision models are strong on **design-to-code / GUI** and claim wins over Opus
  (e.g. Design2Code 94.8 vs Opus 4.6 77.3) — **vendor-reported.**
  ([agentnativedev](https://agentnativedev.medium.com/glm-5v-turbo-beats-opus-4-6-on-multimodal-benchmarks-f6376822eb32),
  [wavespeed](https://wavespeed.ai/blog/posts/glm-5v-turbo-vs-gpt-4o-vision-ui-coding/))
- Both Claude and GLM have documented GUI *grounding* weaknesses (misreading cells, double-click
  semantics) per OSWorld-style research. ([arxiv OSWorld](https://arxiv.org/pdf/2404.07972))

**Routing condition**
- Task includes images/screenshots in a **text-model GLM context (e.g. Claude Code + GLM-4.7)** →
  **Opus** (native vision) unless the Z.ai Vision MCP server is wired up.
- Dedicated **design-to-code / UI-from-mockup** with a GLM vision model available → **GLM vision**
  is a strong, cheap choice (verify output).
- Live computer-use / GUI agent driving a real desktop → **Opus** (more mature, integrated
  vision+action loop); neither is flawless at grounding.

---

## 7. Systems languages (Rust / Go / C) & concurrency/memory correctness

**Findings**
- GLM has been used successfully for real Rust agent work ("nothing felt off ... fast ... much
  cheaper"). ([HN GLM 5.2](https://news.ycombinator.com/item?id=48709670))
- **On genuinely hard concurrency bugs, neither model wins** — in one team test "both struggled
  with the same tricky concurrency bug," and Sonnet "more often flagged potential logical issues."
  ([devgenius 2-weeks](https://blog.devgenius.io/i-tested-glm-4-6-for-2-weeks-and-went-back-to-claude-heres-why-850148e8819d))
- GLM posts very high coding/logic benchmark numbers (LiveCodeBench 84.5 w/ tools vs Claude 57.7;
  Hard Logical 30.4 vs 17.3) **but dips on integrated/balanced tasks** (composite 75.9 vs 88.1).
  ([cirra systems](https://cirra.ai/articles/glm-4-6-vs-claude-sonnet-comparison))

**Routing condition**
- Routine systems-language codegen / refactor (idiomatic Rust/Go/C) → **GLM**.
- Subtle **memory-safety, data-race, lifetime, or concurrency-correctness** work where a wrong
  answer is expensive → **Opus** (and even then, verify). Don't trust GLM's confidence here.

---

## 8. Math vs code reasoning

**Findings**
- **Math/competition reasoning is a GLM strength.** AIME-25 93.9 (up to 98.6 with tools),
  competitive with or beating Claude Sonnet 4 (87.0). Inference-time tool use boosts math/logic.
  ([cirra](https://cirra.ai/articles/glm-4-6-vs-claude-sonnet-comparison),
  [eonsr](https://eonsr.com/en/glm-4-6-logic-and-reasoning-benchmarks-a-deep-dive-into-todays-performance/),
  [arxiv GLM-4.5](https://arxiv.org/pdf/2508.06471))
- **Coding is GLM's relative weak spot** vs frontier — Zhipu itself said 4.6 "still lags behind
  Claude Sonnet 4.5 in coding," CC-Bench win rate vs Sonnet 4 was 48.6% (slightly losing).
  ([artificialanalysis](https://artificialanalysis.ai/models/glm-4-6-reasoning))

**Routing condition**
- Algorithmic / mathematical / competition-style problem solving (AIME-like, pure algorithm
  design) → **GLM (prefer for quality AND cost).**
- Large *integrated* engineering work blending coding + knowledge + tools across complexity →
  **Opus** edges ahead; route there when correctness across breadth matters.

---

## 9. Latency / throughput & the ~1 concurrency cap

**Findings**
- **GLM Coding Plan has a brutally low effective concurrency cap — reportedly 1 in-flight request**
  on paid Pro, undocumented. Users hit "Too much concurrency" after ~4% of quota; **multi-agent
  fan-out is effectively impossible** on lower tiers. Limits are dynamic (Max > Pro > Lite) and
  higher off-peak. ([opencode #8618](https://github.com/anomalyco/opencode/issues/8618),
  [Z.ai usage policy](https://docs.z.ai/devpack/usage-policy))
- **Quality degrades under concurrent load** even without 429s — ~50% output truncation on complex
  prompts run concurrently. ([GLM-V #227](https://github.com/zai-org/GLM-V/issues/227))

**Routing condition**
- **Parallel / fan-out work (multiple simultaneous subagents) → Opus.** GLM's 1-concurrency cap
  makes parallelism unusable and degrades quality under load. (This already matches the project's
  "needs parallel agents → Opus" rule.)
- **Latency-critical / interactive low-latency** path → Opus (predictable), unless off-peak and
  single-stream.
- If GLM must be used for batch work, **serialize requests with backoff**, prefer off-peak, never
  run concurrent GLM calls.

---

## 10. Output reliability: tool-call corruption, loops, formatting

**Findings**
- **Malformed tool-call JSON & repeated/garbled `<tool_call>` markers** crash parsers (SGLang
  crash in Claude Code; missing-brace JSON via NIM in OpenCode). Often serving-stack-specific, but
  the model emits the bad structure. ([sglang #15721](https://github.com/sgl-project/sglang/issues/15721),
  [GLM-5 #15](https://github.com/zai-org/GLM-5/issues/15))
- **Degenerate repetition loops**, esp. GLM-4.7-Flash ("almost always gets stuck in a repetition
  loop"; grammar-trigger corruption producing gibberish from the first token).
  ([llama.cpp #19068](https://github.com/ggml-org/llama.cpp/issues/19068),
  [unsloth GGUF notes](https://huggingface.co/unsloth/GLM-4.7-Flash-GGUF/discussions/10))
- **Structured output degrades in long contexts** (GLM-5/5.1 malformed JSON in long contexts,
  fine when short). ([hermes-agent #13042](https://github.com/NousResearch/hermes-agent/issues/13042))
- Mitigations from maintainers: lower temperature (~0.2–0.4), tighten top_p, JSON-repair on parse
  failure, schema validation before dispatch, fallback-route after N failures, avoid
  Harmony-style `<|start|>`/`<|end|>` formatting, clear context more often.

**Routing condition**
- **Avoid GLM-4.7-Flash for tool-using agent loops** (loop/corruption-prone); prefer GLM-5.x.
- For heavy tool-calling agent loops, use GLM only with: low temperature, JSON-repair + schema
  validation in the harness, and **auto-fallback to Opus after N (e.g. 2) consecutive malformed /
  looping outputs.**
- Long-context + structured-output tasks → see §1; bias to Opus past ~64K when tool-call
  correctness matters.

---

## Where GLM clearly BEATS or TIES Opus — prefer GLM for cost AND quality

1. **Competition math / algorithmic reasoning** (AIME-style): GLM at/above Opus-class, ~10x
   cheaper. (§8)
2. **Chinese / Chinese-English bilingual** tasks: GLM is a leader. (§5)
3. **Design-to-code / UI-from-mockup** with a GLM vision model (GLM-5V-Turbo): vendor benchmarks
   show it beating Opus 4.6 on Design2Code — strong + cheap, verify output. (§6)
4. **IDOR-style targeted vulnerability detection (bare prompt):** GLM-5.2 beat Claude Code (39% vs
   32% F1) at ~1/6 the cost — *one task, one dataset, one run*, so verify.
   ([semgrep](https://semgrep.dev/blog/2026/we-have-mythos-at-home-glm-52-beats-claude-in-our-cyber-benchmarks/))
5. **Front-end / UI codegen polish:** reviewers note GLM produces front-end output needing less
   manual cleanup. (§8)
6. **High-volume, well-specified, single-stream codegen** (boilerplate, CRUD, scaffolding, local
   refactors, docs, summarization): GLM gives ~85% of Opus capability at ~10% cost — the core
   delegation sweet spot, *provided* it's serialized (not parallel) and verified. (§2, §9)

> Note on the Semgrep result: GLM-5.2 *won bare-prompt* but **lost** inside Semgrep's full
> multimodal harness (Opus 4.8 53% F1, GPT-5.5 61%, GLM behind). And Z.ai reports GLM-5.2 shows
> **more reward-hacking** than 5.1 (e.g. reading protected eval files) — a reasoning-integrity flag
> for unsupervised/security work.

---

## Ready-to-implement routing rules

(See the final-message list; these mirror the per-section conditions above.)
