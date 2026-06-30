# Auto-Select: routing subagent work between GLM and Opus

> **Group 3, Agents B & C deliverables:** the auto-selection mechanism and the
> end-to-end smoothness contract.

## How auto-selection actually works (and its honest limits)

Claude Code does **not** let you swap a subagent's underlying model to a non-Anthropic
provider — `model:` in an agent file only chooses among Anthropic models. So "make GLM a
subagent" is delivered as a **delegation tool** the orchestrator calls, plus rules that tell
the orchestrator *when* to call it. There is no hidden background process; routing is a
decision Claude makes using the rules below. That keeps it cheap, transparent, and accurate.

Three cooperating pieces:

1. **The rule (cheap, no tokens):** `glm_recommend` and the table in [`RULES.md`](RULES.md)
   decide GLM vs Opus locally — no GLM call needed to make the decision.
2. **The execution:** `glm_delegate` runs the work on GLM with peak-aware model choice and
   the concurrency gate; or the `glm` subagent wraps that with context-gathering.
3. **The policy in context:** the snippet in [`CLAUDE.md`](../CLAUDE.md) makes every Claude
   Code session in this project *consider GLM whenever it would otherwise spawn a subagent.*

## The decision flow (what happens on every subagent-worthy task)

```
Need to delegate a subtask?
        │
        ▼
Is it sensitive / parallel / long+complex / latency-critical?  ──yes──▶  Opus subagent
        │ no
        ▼
Quick fit check (RULES.md table; glm_recommend if unsure)
        │
   GLM ◀┴▶ Opus
        │
        ▼
GLM picked → `glm` subagent gathers context → glm_delegate (auto model, peak-aware)
        │
        ▼
Verify output. Wrong/low-quality? → retry once → still bad? → escalate to Opus
```

## Smoothness / efficiency contract (the E2E checklist)

- **Consideration is automatic** — the CLAUDE.md policy ensures GLM is weighed on every
  subagent dispatch, without the user asking.
- **Deciding is near-free** — the GLM-vs-Opus choice is a local rule lookup
  (`glm_recommend` / the table), not an extra LLM round-trip. No meaningful token/latency tax.
- **Decisions are accurate** — overrides protect correctness (sensitive→Opus, hard→Opus);
  cost-timing only shifts *which* engine handles the safe-to-delegate majority.
- **GLM behaves predictably** — it gets full context pasted in (it can't read files/tools),
  output is verified, and failures escalate rather than silently degrade.
- **Plug-and-play** — to add this to any other Claude Code project: copy `glm-mcp/`,
  `.mcp.json`, `.claude/agents/glm.md`, and the CLAUDE.md block. Set the key. Done.

## Tuning knobs
All behavior is env-driven (see `glm-mcp/.env.example`): peak window hours, peak/off-peak
model picks, concurrency cap, retries, timeout. No code edits needed to adjust policy.
