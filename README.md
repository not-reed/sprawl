# Construct

A self-aware AI braindump companion. Communicates via Telegram, stores long-term memories in SQLite, handles reminders, and can read/edit/test/deploy its own source code.

## Tech Stack

- **Runtime**: Node.js + tsx (ARMv7 compatible — no native dependencies)
- **Agent**: [@mariozechner/pi-agent-core](https://github.com/nicepkg/pi-agent)
- **LLM**: OpenRouter (OpenAI-compatible, any model)
- **Database**: SQLite via `node:sqlite` + Kysely
- **Telegram**: Grammy (long polling)
- **Scheduler**: Croner (cron-based reminders)
- **CLI**: Citty (REPL, one-shot, direct tool invocation)
- **Testing**: Vitest

## Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store a fact, note, preference, or reminder |
| `memory_recall` | Search memories by keyword |
| `memory_forget` | Archive (soft-delete) a memory |
| `schedule_create` | Create a one-shot or recurring reminder |
| `schedule_list` | List active reminders |
| `schedule_cancel` | Cancel a reminder |
| `self_read_source` | Read own source files |
| `self_edit_source` | Edit own source (search-and-replace) |
| `self_run_tests` | Run own test suite |
| `self_view_logs` | Read journald service logs |
| `self_deploy` | Commit changes + restart service (test-gated) |

## Setup

### Prerequisites

- Any Linux machine (ARMv7+ compatible)
- Node.js 20+ (`node:sqlite` requires Node 22+, Node 20 works but needs `--experimental-sqlite`)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenRouter API key (from [openrouter.ai](https://openrouter.ai))

### Install Node.js on the Pi

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
```

> **Note**: For `node:sqlite` support without the experimental flag, use Node 24+.
> Node 20/22 will work but you'll see an `ExperimentalWarning`.

### Clone and Install

```bash
git clone <repo> ~/construct
cd ~/construct
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Required
OPENROUTER_API_KEY=sk-or-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Optional (sensible defaults)
OPENROUTER_MODEL=anthropic/claude-sonnet-4
ALLOWED_TELEGRAM_IDS=123456         # Your Telegram user ID
TIMEZONE=America/New_York
DATABASE_URL=./data/construct.db
PROJECT_ROOT=/home/claw/construct    # For self-aware tools
```

### Run

```bash
# Start everything (Telegram bot + scheduler)
npm start

# Or just the CLI
npm run cli

# One-shot message
npm run cli -- "remember that my dentist appointment is March 5th"

# Direct tool invocation (for testing)
npm run cli -- --tool memory_recall --args '{"query": "dentist"}'
```

### Run Tests

```bash
npm test
```

## Deploy with systemd

Create the service file:

```bash
sudo tee /etc/systemd/system/construct.service << 'EOF'
[Unit]
Description=Construct Braindump Companion
After=network.target

[Service]
Type=simple
User=claw
WorkingDirectory=/home/claw/construct
ExecStart=/usr/bin/npx tsx src/main.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/claw/construct/.env

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable construct
sudo systemctl start construct
```

Check logs:

```bash
journalctl -u construct -f
```

## Updating

```bash
cd ~/construct
git pull
npm install
sudo systemctl restart construct
```

Or let the agent update itself — it has tools to read its own source, edit it, run tests, and restart the service.

## Project Structure

```
construct/
├── src/
│   ├── main.ts              # Entry point (Telegram + scheduler)
│   ├── agent.ts             # Agent factory, processMessage()
│   ├── system-prompt.ts     # Static system prompt (cached by LLM provider)
│   ├── env.ts               # Zod-validated environment variables
│   ├── tools/               # All tool implementations
│   │   ├── memory-store.ts
│   │   ├── memory-recall.ts
│   │   ├── memory-forget.ts
│   │   ├── schedule.ts
│   │   ├── self-read.ts
│   │   ├── self-edit.ts
│   │   ├── self-test.ts
│   │   ├── self-logs.ts
│   │   ├── self-deploy.ts
│   │   └── __tests__/       # Tool tests
│   ├── telegram/
│   │   ├── index.ts          # Bot startup
│   │   └── bot.ts            # Grammy message handlers
│   ├── db/
│   │   ├── index.ts          # node:sqlite + Kysely adapter
│   │   ├── schema.ts         # Table types
│   │   ├── queries.ts        # Query helpers
│   │   └── migrations/
│   └── scheduler/
│       └── index.ts          # Croner reminder daemon
├── cli/
│   └── index.ts              # CLI (REPL, one-shot, tool invocation)
├── CLAUDE.md                 # Self-reference for the agent
└── PLAN.md                   # Architecture decisions
```
