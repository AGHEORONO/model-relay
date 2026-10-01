---
name: shelf
description: "Show every model-router backend and its models drawn as books on a shelf, with the effort levels each supports. Trigger: /shelf, \"show the shelf\", \"what models do I have\". Optional argument: a backend name (antigravity, codex, cursor, opencode, ...) or \"all\"."
---

# /shelf

Run this and print its stdout **verbatim inside a ```text code block** — no edits,
no retelling of the books. It takes ~5-10s because it asks each CLI for its models.

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/src/shelf.js" $ARGUMENTS
```

`CLAUDE_PLUGIN_ROOT` is the plugin root. If it is empty in your shell, use the
directory two levels above this skill's base directory instead.

After the block, add at most one line, in the user's language, and only if a
backend failed (a ⚠ line) or the user asked something about the shelf.
