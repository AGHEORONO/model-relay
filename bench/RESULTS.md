# Benchmark results — 2026-10-01

Six tasks, each run through `claude -p` with relay off and on, scored by a
hidden check. Cost is Claude Code's own `total_cost_usd` (list price) for the
whole run. Every one of the 24 counted runs passed its check.

| Task | Opus off → on | Sonnet off → on | Delegated (Opus / Sonnet) |
|---|---|---|---|
| code-module — module + tests from a spec | $0.96 → $0.49 (**−49%**) | $0.30 → $0.25 (**−17%**) | codex ×2 / codex ×2 |
| code-review — find 6 planted bugs | $0.46 → $0.49 (+7%) | $0.23 → $0.23 | codex ×1 / — |
| docs-guide — 700+ word user guide | $0.54 → $0.65 (+20%) | $0.27 → $0.31 | gemini-3.1-pro ×1 / — |
| bulk-logs — root-cause 12 logs | $0.54 → $0.63 (+17%) | $0.29 → $0.29 | gemini-3.1-pro ×12 / — |
| agent-bugfix — fix 3 bugs | $0.40 → $0.40 | $0.23 → $0.23 | — / — |
| image-logo — 256×256 PNG | $0.39 → $0.41 (+5%) | $0.19 → $0.18 | codex ×1 / — |
| **Total** | **$3.29 → $3.07 (−7%)** | **$1.51 → $1.49 (−1%)** | |

## What it shows

- **Large generated output is where relay pays**: the ~200-line module plus
  tests cost half as much when Codex wrote it straight to disk.
- **Small outputs cost more when delegated.** Each delegation adds a round trip
  in which Claude re-reads its whole context; for a short review or report that
  outweighs the tokens saved.
- **~$0.28 of every run is fixed start-up cost** (Claude Code's system prompt),
  so these short tasks understate savings in long real sessions.
- An earlier round, with a vaguer hook note, delegated in only 1 of 12 relay-on
  runs. That led to the concrete per-task rules — and, after this round, to the
  "delegate only ~100+ lines of output" threshold.

Raw data: `results/2026-10-01T08-08-49.*` (Opus off), `08-21-50` (Sonnet off),
`11-12-15` (Opus on), `11-22-03` (Sonnet on), `11-26-11` / `11-27-18`
(docs-guide and image-logo off re-runs after a fixture fix).
