---
title: Sprawl
description: Monorepo for personal AI tools
---

Documentation for the Sprawl monorepo: five apps, two shared packages, one memory pipeline. Everything converges in SQLite.

## Apps

- **[Construct](/construct/)** -- Personal AI braindump companion. Telegram + CLI + scheduler, LLM agent with tools, three-layer memory, self-modification, extensions.
- **[Cortex](/cortex/)** -- Crypto market intelligence daemon. Prices + news through Cairn's memory pipeline, LLM-grounded trading signals.
- **[Synapse](/synapse/)** -- Paper trading daemon. Reads Cortex signals, sizes positions by confidence, manages risk.
- **[Deck](/deck/)** -- Memory graph explorer. Hono REST API + React SPA with D3-force graph, memory browser, observation timeline.
- **[Loom](/loom/)** -- Interactive rulebook companion with TTS audio generation.
- **[Optic](/optic/)** -- Terminal trading dashboard. Ratatui TUI reading Cortex + Synapse DBs.

## Packages

- **[Cairn](/cairn/)** -- Memory substrate. Observer/reflector pipeline, embeddings, graph extraction, context building.
- **[DB](/db/)** -- Shared Kysely database factory with node:sqlite dialect.

## Guides

- **[Deployment](/guides/deployment/)** -- Docker and systemd deployment
- **[Security](/guides/security/)** -- Self-modification safety, secrets, trust boundaries
- **[Environment](/guides/environment/)** -- Environment variables and configuration
- **[Development](/guides/development/)** -- Just commands, testing, logging
