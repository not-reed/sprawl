# TODO

## Memory System Improvements (inspired by OpenClaw)

Ref: https://learnopenclaw.com/core-concepts/memory

1. **Daily conversation summaries** — auto-summarize at session end, append to `$EXTENSIONS_DIR/logs/YYYY-MM-DD.md`. Searchable but not injected into every prompt.
2. **`MEMORY.md` curated knowledge file** — always-loaded boot context for active projects, key decisions, recurring patterns. Agent-editable via `self_edit_source`.
3. **Memory compaction tool** — surface old unrecalled memories, propose consolidation/archival to maintain signal-to-noise over time.
4. **Context budget tracking** — surface approximate token usage in the preamble so the agent can self-regulate.
