# nullclaw-ts monorepo task runner

# Default: show help
default:
    @just --list

# --- Dev ---

# Run construct in dev mode (default instance)
dev: construct-dev

# Run construct in dev mode with file watching
construct-dev:
    node --env-file=.env --import=tsx --watch-path=apps/construct/src apps/construct/src/main.ts

# Run explorer in dev mode
explorer-dev instance:
    node --env-file=.env.{{instance}} --import=tsx apps/explorer/src/server.ts

# --- Test ---

# Run all tests
test:
    pnpm -r run test

# Run cairn tests
test-cairn:
    pnpm --filter @repo/cairn vitest run

# Run construct tests
test-construct:
    pnpm --filter @repo/construct vitest run

# Run AI integration tests (requires OPENROUTER_API_KEY)
test-ai:
    pnpm --filter @repo/construct vitest run --config apps/construct/vitest.ai.config.ts

# --- Typecheck ---

# Typecheck all packages
typecheck:
    pnpm -r run typecheck

# --- DB ---

# Run database migrations
db-migrate instance="":
    node --env-file=.env.{{instance}} --import=tsx apps/construct/src/db/migrate.ts

# --- CLI ---

# Run construct CLI
cli instance="" *args="":
    node --env-file=.env.{{instance}} --import=tsx apps/construct/src/cli/index.ts {{args}}

# --- Multi-instance ---

# Start a specific construct instance
start instance:
    node --env-file=.env.{{instance}} --import=tsx apps/construct/src/main.ts

# --- Cortex ---

# Run cortex in dev mode with file watching
cortex-dev:
    node --env-file=.env.cortex --import=tsx --watch-path=apps/cortex/src apps/cortex/src/main.ts

# Run cortex (production)
cortex-start:
    node --env-file=.env.cortex --import=tsx apps/cortex/src/main.ts

# Backfill cortex with historical data
cortex-backfill days="30":
    node --env-file=.env.cortex --import=tsx apps/cortex/src/main.ts --backfill {{days}}

# Backfill news only (skips CoinGecko price fetches)
cortex-backfill-news days="30":
    node --env-file=.env.cortex --import=tsx apps/cortex/src/main.ts --backfill-news {{days}}

# Backfill prices only (skips news fetches)
cortex-backfill-prices days="30":
    node --env-file=.env.cortex --import=tsx apps/cortex/src/main.ts --backfill-prices {{days}}

# --- Cortex TUI ---

# Run cortex-ink TUI (TypeScript/Ink)
cortex-ink db="./data/cortex.db":
    node --import=tsx apps/cortex-ink/src/main.tsx {{db}}

# Run cortex-ratatui TUI (Rust)
cortex-ratatui db="./data/cortex.db":
    cd apps/cortex-ratatui && cargo run -- "{{justfile_directory()}}/{{db}}"

# Build cortex-ratatui
cortex-ratatui-build:
    cd apps/cortex-ratatui && cargo build --release

# Run cortex-bubbletea TUI (Go)
cortex-bubbletea db="./data/cortex.db":
    cd apps/cortex-bubbletea && go run . "{{justfile_directory()}}/{{db}}"

# Build cortex-bubbletea
cortex-bubbletea-build:
    cd apps/cortex-bubbletea && go build -o cortex-bubbletea .

# --- Blog ---

# Run blog commands
blog *args="":
    cd .blog && just {{args}}
