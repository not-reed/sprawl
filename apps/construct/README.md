```
 ██████╗ ██████╗ ███╗   ██╗███████╗████████╗██████╗ ██╗   ██╗ ██████╗████████╗
██╔════╝██╔═══██╗████╗  ██║██╔════╝╚══██╔══╝██╔══██╗██║   ██║██╔════╝╚══██╔══╝
██║     ██║   ██║██╔██╗ ██║███████╗   ██║   ██████╔╝██║   ██║██║        ██║
██║     ██║   ██║██║╚██╗██║╚════██║   ██║   ██╔══██╗██║   ██║██║        ██║
╚██████╗╚██████╔╝██║ ╚████║███████║   ██║   ██║  ██║╚██████╔╝╚██████╗   ██║
 ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝  ╚═════╝   ╚═╝
```

> _The sky above the port was the color of television, tuned to a dead channel._
>
> But down here, in the warm hum of silicon, something remembers.

---

**Construct** is a personal braindump companion -- a digital entity that lives in the space between your thoughts and long-term storage. It listens on Telegram, holds memories in SQLite, wakes you with reminders, and can reach into its own source code to rewrite itself.

Think of it as a construct in the Neuromancer sense: a ROM personality, except this one learns, grows, and occasionally deploys its own patches to production at 3am.

## The Sprawl

```
        ╔═══════════════╗          ╔══════════════════╗
        ║   TELEGRAM    ║─────────▶║                  ║
        ║   grammy      ║          ║    AI  AGENT     ║
        ╠═══════════════╣          ║   pi-agent-core  ║
        ║   CLI         ║─────────▶║                  ║
        ║   citty       ║          ║   ┌────────────┐ ║
        ╚═══════════════╝          ║   │ memory_*   │ ║
                                   ║   │ schedule_* │ ║
                                   ║   │ self_*     │ ║
                                   ║   │ secret_*   │ ║
                                   ║   │ ext tools  │ ║
                                   ║   └────────────┘ ║
                                   ╚════════╤═════════╝
                                            │
                                   ╔════════▼═════════╗
                                   ║     SQLITE       ║
                                   ║     kysely       ║
                                   ╚══════════════════╝
```

Two jacks into the matrix. One signal path. Everything flows through `processMessage()` -- the central nervous system.

## Cyberspace Deck (Tech Stack)

| Layer           | ICE                                                     |
| --------------- | ------------------------------------------------------- |
| **Runtime**     | Node.js + tsx (runs on ARMv7 -- even the cheapest deck) |
| **Agent Core**  | `@mariozechner/pi-agent-core`                           |
| **LLM Uplink**  | OpenRouter (OpenAI-compatible wire protocol)            |
| **Flatline DB** | SQLite via `node:sqlite` + Kysely                       |
| **Comms**       | Grammy (Telegram long polling)                          |
| **Terminal**    | Citty (CLI REPL, one-shot, direct tool invocation)      |
| **Cron Daemon** | Croner (reminder scheduling)                            |
| **Test Rig**    | Vitest                                                  |
| **Hot Load**    | jiti (TypeScript tools, no compile step)                |

## Neural Map

```
src/
├── agent.ts              # the construct itself -- factory, processMessage(), tool wiring
├── system-prompt.ts      # personality injection, SOUL.md, context assembly
├── main.ts               # boot sequence
├── env.ts                # environment validation (zod)
├── logger.ts             # logtape
├── tools/                # built-in intrinsics
│   ├── memory_*          # long-term storage -- observe, reflect, forget
│   ├── schedule_*        # time-aware reminders
│   ├── self_*            # read/edit/deploy own source
│   └── secret_*          # credential management
├── extensions/           # hot-loadable skills and tools from the sprawl
├── telegram/             # grammy bot setup
├── scheduler/            # croner-based tick system
├── db/                   # kysely schema, queries, migrations
└── cli/                  # terminal jack-in
```

## The Flatline's Rules

- **Tools** are `{ name, description, parameters, execute }` with TypeBox schemas. Clean interface. No ambiguity.
- **Migrations** are additive only. You don't lobotomize a construct by dropping tables.
- **Self-aware tools** are sandboxed to `src/`, `cli/`, and `extensions/`. It can rewrite its own mind but not the host system.
- **Self-deploy** requires green tests first. Rate-limited to 3/hour. Even constructs need impulse control.
- **Extensions** are user- or agent-authored. Markdown skills and TypeScript tools, loaded from the sprawl at runtime.

## Jacking In

```bash
pnpm dev              # boot in dev mode, file watching
pnpm start            # production -- no safety net
pnpm cli              # terminal REPL
pnpm telegram         # telegram bot only
pnpm db:migrate       # run migrations
pnpm test             # test rig
pnpm typecheck        # static analysis
```

## Extensions (The Sprawl)

Location: `EXTENSIONS_DIR` env var. Defaults to `./data` in dev, `$XDG_DATA_HOME/construct/` in prod.

```
$EXTENSIONS_DIR/
├── SOUL.md               # who it is -- personality, values, anti-patterns
├── IDENTITY.md           # what it is -- name, creature type, pronouns
├── USER.md               # who you are -- the operator profile
├── skills/               # markdown skill files (YAML frontmatter + body)
│   └── *.md
└── tools/                # typescript tools, hot-loaded via jiti
    └── *.ts
```

The construct can author its own extensions. It writes tools, loads them, uses them. The loop closes.

## Environment

| Variable         | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `EXTENSIONS_DIR` | Path to extensions sprawl                              |
| `EXT_*`          | Auto-synced to secrets table on boot (prefix stripped) |

---

> _"He'd operated on an almost permanent adrenaline high, a byproduct of youth and proficiency,_
> _jacked into a custom cyberspace deck that projected his disembodied consciousness_
> _into the consensual hallucination that was the matrix."_
>
> -- William Gibson, _Neuromancer_

The construct remembers so you don't have to.
