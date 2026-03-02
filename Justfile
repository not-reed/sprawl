# sprawl monorepo task runner

# Default: show help
default:
    @just --list

# --- Dev ---

# Run construct in dev mode (default instance)
dev: construct-dev

# Run construct in dev mode with file watching
construct-dev:
    node --env-file=.env --import=tsx --watch-path=apps/construct/src apps/construct/src/main.ts

# Run deck in dev mode
deck-dev instance:
    node --env-file=.env.{{instance}} --import=tsx apps/deck/src/server.ts

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

# --- Synapse ---

# Run synapse in dev mode with file watching
synapse-dev:
    node --env-file=.env.synapse --import=tsx --watch-path=apps/synapse/src apps/synapse/src/main.ts

# Run synapse (production)
synapse-start:
    node --env-file=.env.synapse --import=tsx apps/synapse/src/main.ts

# Show synapse portfolio status
synapse-status:
    node --env-file=.env.synapse --import=tsx apps/synapse/src/status.ts

# Run synapse tests
test-synapse:
    pnpm --filter @repo/synapse vitest run

# --- Optic TUI ---

# Run optic TUI (Rust)
optic db="./data/cortex.db" synapse="./data/synapse.db":
    cd apps/optic && cargo run -- "{{justfile_directory()}}/{{db}}" --synapse "{{justfile_directory()}}/{{synapse}}"

# Build optic
optic-build:
    cd apps/optic && cargo build --release

# --- Blog ---

# Run blog commands
blog *args="":
    cd .blog && just {{args}}
