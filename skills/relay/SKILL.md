---
name: relay
description: Turn model-relay on, off or automatic, set the usage threshold, or show plan usage. Relay mode makes Claude delegate self-contained work to other models (Gemini, GPT, Grok...) to save Claude plan usage. Trigger: /relay, "relay on", "relay off", "switch to other models", "save my Claude usage".
disable-model-invocation: true
---

# /relay

Run the command and print its output verbatim in a ```text block:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/relay.mjs" $ARGUMENTS
```

`CLAUDE_PLUGIN_ROOT` is the plugin root. If it is empty in your shell, use the
directory two levels above this skill's base directory instead.

Arguments: `status` (default) · `on` · `off` · `auto` · `threshold <1-100>` ·
`window any|5h|7d` · `setup` · `uninstall`.

- `on` — relay starts with the user's next message, regardless of usage.
- `auto` — relay switches itself on when the 5-hour or weekly plan usage
  reaches the threshold (default 50%) and off again when it drops.
- `off` — never relay.

If the output says the status line is not installed, offer `/relay setup` in one line.
Then stop — the mode applies from the next message on.
