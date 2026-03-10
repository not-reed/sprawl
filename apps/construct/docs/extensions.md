---
title: Extension System
description: User-authored skills and dynamic tools
---

# Extension System

## Overview

The extension system allows Construct to be customized with user-authored skills (Markdown instruction sets) and tools (TypeScript modules) without modifying core source code. Extensions live in a configurable directory (`EXTENSIONS_DIR`) and are loaded at startup, with the ability to hot-reload via the `extension_reload` tool.

The extension system also manages three **identity files** (SOUL.md, IDENTITY.md, USER.md) that shape the agent's personality and context.

## Key Files

| File                           | Role                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `src/extensions/index.ts`      | Singleton registry, `initExtensions()`, `reloadExtensions()`, selection helpers      |
| `src/extensions/loader.ts`     | File loading: identity files, skills (Markdown), dynamic tools (TypeScript via jiti) |
| `src/extensions/embeddings.ts` | Embedding caches for skills and dynamic packs, selection functions                   |
| `src/extensions/secrets.ts`    | Secret management: store, get, list, delete, env sync, secrets map builder           |
| `src/extensions/types.ts`      | TypeScript interfaces for Skill, DynamicToolExport, ExtensionRegistry, etc.          |

## Extensions Directory Layout

```
$EXTENSIONS_DIR/
  SOUL.md                      # Personality: traits, values, communication style
  IDENTITY.md                  # Agent metadata: name, creature type, pronouns
  USER.md                      # Human context: name, location, preferences
  skills/
    daily-standup.md           # Standalone skill (YAML frontmatter + body)
    coding/
      code-review.md           # Skills can be nested in subdirectories
  tools/
    weather.ts                 # Standalone tool file -> single-tool pack (ext:weather)
    music/                     # Directory -> grouped pack (ext:music)
      pack.md                  # Optional description override for the pack
      play.ts                  # Tool: music_play
      search.ts                # Tool: music_search
```

The default `EXTENSIONS_DIR` is:

- **Development**: `./data` (relative to project root)
- **Production**: `$XDG_DATA_HOME/construct/` (typically `~/.local/share/construct/`)

## Identity Files

Three Markdown files injected into the system prompt:

| File          | Purpose                                                  | System Prompt Section |
| ------------- | -------------------------------------------------------- | --------------------- |
| `SOUL.md`     | Personality traits, values, communication anti-patterns  | `## Soul`             |
| `IDENTITY.md` | Name, creature type, visual description, pronouns        | `## Identity`         |
| `USER.md`     | Human's name, location, preferences, interests, schedule | `## User`             |

These are loaded by `loadIdentityFiles()` in `src/extensions/loader.ts` and stored in the `ExtensionRegistry.identity` field. They are read/written by the `identity_read` and `identity_update` tools.

When an identity file is updated via `identity_update`, the tool:

1. Writes the new content to disk
2. Calls `invalidateSystemPromptCache()` to clear the cached system prompt
3. Calls `reloadExtensions()` to refresh the registry

## Skills

Skills are Markdown files with YAML frontmatter, found recursively under `$EXTENSIONS_DIR/skills/`.

### Skill File Format

```markdown
---
name: daily-standup
description: Run a daily standup summarizing recent activity and upcoming plans
requires:
  secrets:
    - JIRA_TOKEN
  env:
    - JIRA_URL
  bins:
    - curl
---

When the user asks for a standup or morning briefing:

1. Check recent memories for what was worked on yesterday
2. Look up today's schedule
3. Summarize in a concise format
```

### Frontmatter Fields

| Field              | Required | Description                                         |
| ------------------ | :------: | --------------------------------------------------- |
| `name`             |   Yes    | Unique skill name                                   |
| `description`      |   Yes    | Short description (used for embedding)              |
| `requires.secrets` |    No    | Secret keys that must exist in the `secrets` table  |
| `requires.env`     |    No    | Environment variables that must be set              |
| `requires.bins`    |    No    | Binary executables needed (logged but not enforced) |

### How Skills Are Selected

Skills are **not** tools. They are instruction sets injected into the context preamble when relevant. Selection uses embedding similarity:

1. At extension load time, `initSkillEmbeddings()` generates an embedding for each skill from `"name: description"`.
2. At message time, `selectSkills()` compares the message embedding against skill embeddings.
3. Skills with cosine similarity >= 0.35 are included (up to 3 max).
4. If embedding generation failed for the message, no skills are selected (skills are optional context).

Selected skills appear in the context preamble as:

```
[Active skills -- follow these instructions when relevant]

### daily-standup
When the user asks for a standup...
```

### Requirement Checking

`checkRequirements()` in `src/extensions/loader.ts` validates:

- `requires.env` -- checks `process.env`
- `requires.secrets` -- checks against available secrets from the database
- `requires.bins` -- logged only (not enforced)

Skills with unmet requirements are still loaded but may not function correctly. (Requirement checking is primarily used for dynamic tools, where unmet requirements cause the tool to be skipped.)

## Dynamic Tools

Dynamic tools are TypeScript files under `$EXTENSIONS_DIR/tools/`. They are loaded at runtime using **jiti** (a JIT TypeScript transpiler that works without a compile step).

### Tool File Format

A dynamic tool file must export:

```typescript
import { Type, type Static } from "@sinclair/typebox";

// Optional: declare requirements
export const meta = {
  requires: {
    secrets: ["OPENWEATHERMAP_API_KEY"],
  },
};

// Default export: either a tool object or a factory function
export default (ctx: DynamicToolContext) => ({
  name: "weather_current",
  description: "Get current weather for a location",
  parameters: Type.Object({
    location: Type.String({ description: "City name" }),
  }),
  execute: async (_id: string, args: { location: string }) => {
    const apiKey = ctx.secrets.get("OPENWEATHERMAP_API_KEY");
    // ... fetch weather ...
    return { output: `Weather in ${args.location}: ...` };
  },
});
```

The default export can be:

- A **factory function** `(ctx: DynamicToolContext) => InternalTool` -- receives secrets and context
- A **plain tool object** `InternalTool` -- for tools that don't need secrets

### DynamicToolContext

```typescript
interface DynamicToolContext {
  secrets: Map<string, string>; // All secrets from the secrets table
}
```

### Loading Process

1. `loadDynamicTools()` scans `$EXTENSIONS_DIR/tools/`
2. **Standalone .ts files** at the root level become single-tool packs (name: `ext:<filename>`)
3. **Subdirectories** become grouped packs (name: `ext:<dirname>`)
   - All `.ts` files in the directory are loaded as tools in the pack
   - Optional `pack.md` provides a description override; otherwise, tool descriptions are concatenated
4. Each file is loaded via `jiti.import()` with `moduleCache: false` (for reload support)
5. Requirements are checked -- tools with unmet requirements are skipped with a log message
6. Tool shape is validated: must have `name`, `description`, `parameters`, `execute`

### node_modules Symlink

Dynamic tools may import project dependencies (like `@sinclair/typebox`). To support this, `ensureNodeModulesLink()` creates a symlink from `$EXTENSIONS_DIR/node_modules` to the project's `node_modules/`. This happens once during tool loading.

### Dynamic Pack Embedding and Selection

Dynamic packs follow the same embedding-based selection as builtin packs:

1. `initDynamicPackEmbeddings()` generates embeddings for each dynamic pack description
2. `selectDynamicPacks()` filters by cosine similarity >= 0.3
3. If no message embedding is available, all dynamic packs are loaded (graceful fallback)

## Extension Registry

The singleton registry holds all loaded extension data:

```typescript
interface ExtensionRegistry {
  identity: IdentityFiles; // { soul, identity, user } -- string | null each
  skills: Skill[]; // Parsed skill objects
  dynamicPacks: ToolPack[]; // Dynamic tool packs (same ToolPack type as builtins)
}
```

Access via `getExtensionRegistry()`. Updated by `reloadExtensions()`.

## Secrets System

Secrets enable dynamic tools to access API keys and tokens without hardcoding them.

### Storage

Secrets are stored in the `secrets` table with columns: `key`, `value`, `source` (`'agent'` or `'env'`), `created_at`, `updated_at`.

### Sources

1. **Environment variables**: Any `EXT_*` env var is synced to the secrets table on startup. The `EXT_` prefix is stripped (e.g., `EXT_OPENWEATHERMAP_API_KEY` becomes `OPENWEATHERMAP_API_KEY`). Source is set to `'env'`.
2. **Agent-created**: The agent can store secrets via the `secret_store` tool. Source is set to `'agent'`.

Environment-sourced secrets always overwrite on restart.

### Access

- **Built-in tools**: Use `secret_store`, `secret_list`, `secret_delete` tools (in core pack)
- **Dynamic tools**: Receive a `Map<string, string>` of all secrets via `DynamicToolContext.secrets`
- **Never exposed**: `secret_list` returns only key names and sources, never values

## Reload Flow

When `extension_reload` is called (or `identity_update` triggers a reload):

1. `invalidateSystemPromptCache()` -- clears the cached system prompt
2. `clearExtensionEmbeddings()` -- clears skill and dynamic pack embedding caches
3. `loadIdentityFiles()` -- re-reads SOUL.md, IDENTITY.md, USER.md
4. `loadSkills()` -- re-scans and parses all skill files
5. `buildSecretsMap()` -- rebuilds the secrets map from the database
6. `loadDynamicTools()` -- re-scans and loads all dynamic tool files (with `moduleCache: false`)
7. Update the singleton registry
8. `initSkillEmbeddings()` + `initDynamicPackEmbeddings()` -- recompute embeddings
