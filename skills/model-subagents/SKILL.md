---
name: model-subagents
description: Delegate work to non-Claude models (Gemini Flash, GPT, Llama, DeepSeek, Grok, local Ollama) as subagents via the model-router MCP server. Use when the user asks to "ask Gemini", "get a second opinion", "compare models", "have another model check this", "use a cheaper model for this", or when facing bulk repetitive work across many files or records that does not need full reasoning. Also use for adversarial review, consensus checks, and cross-model verification. Trigger: /model-subagents
---

# Model subagents

Use other models as workers. `model-router` (MCP) provides the tools; this skill
decides when they are worth calling.

## Relay mode

When a prompt carries a `[model-relay ACTIVE …]` note, the user's Claude plan is
running low (or they switched relay on). Then the bar for delegating drops:
hand over anything self-contained — drafts, summaries, reviews, research
answers, bulk work — and keep for yourself only what needs tools, the repo, or
this conversation. Prefer `effort: "low"` and flash-class models unless the task
is genuinely hard. Still verify what comes back; you remain accountable.

Without that note, delegate only when it is clearly worth it (below).

## Two hard constraints, read first

**1. A delegated model is stateless and blind.** It gets exactly one string:
your prompt. It cannot see this conversation, read files, run tools, or ask a
follow-up. Everything it needs must be pasted in. If assembling the context
costs more than doing the task, do the task yourself.

**2. Subscription (CLI) backends are slow.** Each call spawns a whole agent
process — **roughly 11-20 seconds**, versus under a second for an API backend.
Never put one on the interactive path. It is worth it for parallel fan-out and
second opinions, where the wait buys several answers at once; it is not worth it
to save yourself a small amount of thinking.

Check `list_providers` if you are unsure which kind you are calling. Its output
labels each backend as a subscription CLI or an API-key provider.

## Tools

| Tool | Use it for |
|---|---|
| `list_providers` | Check what is configured. Run on any config error. |
| `list_models` | Discover exact model IDs. **Never guess an ID** — they change constantly. |
| `ask_model` | One prompt, one model. |
| `ask_models` | Same prompt, several models, in parallel. Second opinions and consensus. |
| `map_prompt` | One template over many inputs on one cheap model. Bulk work. |

## Naming a backend

- `<backend>:<model>` — explicit, e.g. `cursor:auto`, `antigravity:gemini-3.8-flash-low` (Gemini via the agy CLI, no key), `google:gemini-2.5-flash` (API key)
- `<backend>` alone — that backend's own default model, e.g. `codex`

Prefer the bare form for subscription CLIs unless the user wants a specific
model. Named models can be rejected by plan tier (Cursor free plans allow only
`auto`), and the bare form sidesteps that entirely.

## Choosing model and effort yourself

Every call takes an optional `effort`: `low` | `medium` | `high`. Pick it per task,
not per session — cheapest setting that will get it right:

| Task | Model | effort |
|---|---|---|
| Bulk triage, extraction, classification (`map_prompt`) | a flash/mini model, e.g. `antigravity:gemini-3.8-flash-low` | `low` |
| Summaries, rewrites, routine second opinion | backend default or a flash model | `medium` |
| Architecture call, subtle bug, adversarial review | a pro/frontier model, e.g. `antigravity:gemini-3.1-pro-high`, `codex` | `high` |

`list_providers` shows which backends honour `effort`. Cursor has no flag — its
effort is in the model id (`gpt-5.3-codex-high`). The usage footer says
`effort ignored` when a backend dropped it. The user can see everything with `/shelf`.

## Always resolve model IDs first

Model names churn faster than anyone's memory of them. When the user names a
model loosely ("Gemini Flash", "the new Gemini", "GPT mini"), call
`list_models` with a filter and use what actually comes back:

```
list_models(filter: "flash")
```

Then pass the returned ID verbatim. Do not invent version numbers. If the
filter returns nothing, widen it (`"gemini"`) and show the user the options
rather than asserting a model exists.

## When to delegate

**Good — delegate:**
- **Bulk fan-out.** Classify 200 log lines, summarise 40 files, extract fields
  from many records. `map_prompt` on a fast cheap model.
- **Second opinion on a hard call.** An architecture decision or a subtle bug.
  `ask_models` across 2-3 models, then judge the answers — do not just relay them.
- **Adversarial review.** Give a model your own proposed answer and ask it to
  find the flaw. Disagreement is the signal.
- **Cost or latency ceilings.** The user explicitly wants the cheap model.
- **The user asked.** "What does Gemini think?" — just ask it.

**Bad — do it yourself:**
- Anything needing this conversation's history, the repo, or tool access.
- Work where assembling context exceeds the work itself.
- Tasks you can already do well. Delegation adds latency and a second chance to
  be wrong.
- Anything where a wrong answer lands silently in the user's code.

## Rules

1. **Self-contained prompts.** Paste the code, the data, the constraints.
   Never write "the function above" or "as discussed".
2. **Pin the output shape.** Use `system` to demand a format — "Reply with only
   a JSON array of objects with keys `file` and `severity`." Free-form replies
   from a fan-out are painful to fuse.
3. **Verify before you trust.** A delegated answer is a *claim*, not a result.
   Check it against the actual code. Never paste generated code into the repo
   without reading it.
4. **Attribute plainly.** Say which model said what. If models disagree, show
   the disagreement rather than silently picking one.
5. **Set `max_tokens` on bulk runs.** Cost and latency scale with every item.
   Watch for `TRUNCATED` in the usage footer.
6. **Start `map_prompt` small.** Run 3 inputs, check the output shape, then run
   the rest. Do not discover a bad template on item 200.
7. **Budget the wall-clock.** On a CLI backend, 40 items at concurrency 5 is
   roughly 40/5 x 15s ≈ 2 minutes. Say so before starting a long run, and raise
   `concurrency` rather than letting it crawl.
8. **API backends cost money; CLI backends spend quota.** For a large fan-out
   (roughly 50+ calls), say what you are about to run and confirm first.

## Patterns

**Second opinion, then judge:**
```
ask_models(
  models: ["google:gemini-2.5-flash", "openrouter:deepseek/deepseek-chat"],
  system: "You are a senior engineer. Be concrete and brief. State your reasoning.",
  prompt: "<full code + the specific question>"
)
```
Then form your own view. You are the one accountable for the answer.

**Bulk triage:**
```
map_prompt(
  model: "gemini-2.5-flash",
  system: "Reply with exactly one word: BUG, STYLE, or FINE.",
  template: "Classify this diff hunk:\n\n{{input}}",
  inputs: [...],
  max_tokens: 5,
  concurrency: 5
)
```

**Adversarial check on your own work:**
```
ask_model(
  model: "<a strong model>",
  system: "Find the flaw. If the answer is correct, say CORRECT and stop.",
  prompt: "Problem:\n<problem>\n\nProposed answer:\n<your answer>"
)
```

## If nothing is configured

`list_providers` returns setup instructions covering both routes: install an
official CLI and sign in with an existing account (no key, uses a subscription
they already pay for), or set an API key. Relay it; do not try to work around it.

Never suggest driving a chat subscription through its web UI or an unofficial
endpoint. Those break vendor terms and get accounts banned. The official CLI is
the supported path, and it is the one this server uses.
