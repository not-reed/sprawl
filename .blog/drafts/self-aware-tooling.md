---
title: "The AI That Patches Itself: Building a Safe Self-Modification Loop"
date: 2026-02-26
tags: [self-modification, deployment, security, testing]
description: "How Construct reads, edits, tests, and deploys its own source code with path allowlists, test gates, and rate limiting."
---

# The AI That Patches Itself: Building a Safe Self-Modification Loop

Self-modifying AI sounds dramatic. In practice it's a set of well-scoped tools, a path allowlist checked against `resolve()`, and a deploy gate that won't let anything through until the tests pass.

Construct is a personal AI companion running as a Telegram bot. It stores memories, manages reminders, and (the part worth writing about) can read and modify its own TypeScript source code, run its test suite, and deploy a new version of itself, all in a single conversation.

This article covers how that works and what makes it safe enough to run in production.

## The Tool Set

The self-aware capabilities live in `src/tools/self/` as six independent tool implementations:

- `self_read_source`: reads files in `src/`, `cli/`, `extensions/`, and a handful of config files
- `self_edit_source`: search-and-replace edits to those same files
- `self_run_tests`: runs `vitest` and returns pass/fail output
- `self_deploy`: typechecks, tests, commits, restarts the service, health-checks, and rolls back if anything goes wrong
- `self_view_logs`: reads from a log file or falls back to `journalctl`
- `self_system_status`: CPU, RAM, disk, temperature, database size, log size

They form a complete feedback loop: read → understand → edit → test → deploy → verify.

## The Security Model: Allowlists, Not Blocklists

The key decision is how scope is enforced. The naive approach would be to block known dangerous paths: deny `/etc`, deny `~/.ssh`, deny `.env`. That's a blocklist, and blocklists always have holes.

Construct uses an allowlist instead. In `src/tools/self/self-read.ts`:

```typescript
const allowed =
  rel.startsWith('src/') ||
  rel.startsWith('cli/') ||
  rel === 'package.json' ||
  rel === 'tsconfig.json' ||
  rel === 'CLAUDE.md' ||
  rel === 'PLAN.md'

if (!allowed || rel.startsWith('..')) {
  return {
    output: `Access denied: "${args.path}" is outside the allowed scope (src/, cli/, extensions/, config files).`,
    details: { error: 'scope_violation' },
  }
}
```

Everything not on the list is denied. The agent cannot read `.env`, cannot read SSH keys, cannot read the database file itself. If a path traverses out of the project root (the `rel.startsWith('..')` check catches `../../../etc/passwd` after `resolve()` normalizes it), it's blocked.

The `self_edit_source` scope is even tighter. Read access includes config files like `package.json`, useful for understanding the project, but write access is restricted to `src/` and `cli/` only. The agent can inspect its own dependencies but cannot modify them.

Extensions get their own parallel scope. Files prefixed with `extensions/` are resolved against `extensionsDir` rather than the project root, and the same path-traversal check runs independently:

```typescript
if (!resolved.startsWith(resolve(extensionsDir) + '/') && resolved !== resolve(extensionsDir)) {
  return {
    output: `Access denied: "${args.path}" escapes the extensions directory.`,
    details: { error: 'scope_violation' },
  }
}
```

Two separate containment zones, each with their own boundary.

## The Edit API: Unique Match Required

The edit tool takes three parameters: a path, a search string, and a replacement string. It finds the search string in the file and replaces it. If the search appears zero times, it fails. If it appears more than once, it fails:

```typescript
const occurrences = content.split(args.search).length - 1
if (occurrences === 0) {
  return {
    output: `Search string not found in ${displayPath}. Make sure you're using the exact text from the file.`,
    details: { error: 'not_found' },
  }
}
if (occurrences > 1) {
  return {
    output: `Search string found ${occurrences} times in ${displayPath}. It must be unique -provide more surrounding context to disambiguate.`,
    details: { error: 'ambiguous', occurrences },
  }
}
```

This uniqueness requirement is intentional friction. An LLM editing its own source code needs to commit to exactly what it's changing. A search string like `= 1` would hit every variable initialization; the agent has to look at the actual code (via `self_read_source`) and pick a search string specific enough to identify one location.

This pattern also means edits are always surgical. There's no "replace file with contents" operation. You can only create new files (via empty search string + non-existent path) or modify existing ones with targeted replacements. Wholesale rewrites require multiple sequential edits, which creates a natural audit trail in the conversation.

## The Deploy Gate

The deploy tool is where the safety architecture gets interesting. It runs this exact sequence:

```
1. Confirm flag must be true
2. Rate limit: ≤ 3 deploys per hour
3. typecheck: npx tsc --noEmit
4. test: npx vitest run
5. git tag pre-deploy-<timestamp>    ← backup
6. git add src/ cli/ extensions/
7. git commit -m <message>
8. systemctl restart construct       ← or process.exit(0) in Docker
9. Wait 5 seconds
10. systemctl is-active construct    ← health check
11. If unhealthy: git revert HEAD + restart ← auto-rollback
```

Each step is a hard gate. A type error stops the deploy before any files are touched. A test failure stops it before git is involved. The backup tag (created immediately before the commit) gives a named recovery point the agent can tell you about when something goes wrong.

The rollback path handles the worst case explicitly:

```typescript
// 7. Auto-rollback -service didn't come up healthy
try {
  await exec('git', ['revert', '--no-edit', 'HEAD'], execOpts)
  await exec('sudo', ['systemctl', 'restart', serviceUnit], { timeout: 15_000 })
  return {
    output: `Deploy ROLLED BACK. Service failed to start after restart. Reverted commit and restarted.`,
    details: { deployed: false, reason: 'health_check_failed', rolledBack: true, tag: backupTag },
  }
} catch (rollbackErr) {
  return {
    output: `Deploy FAILED and ROLLBACK FAILED. Service is down. Manual intervention needed. Backup tag: ${backupTag}.`,
    details: { deployed: false, reason: 'rollback_failed', tag: backupTag, error: msg },
  }
}
```

The catastrophic failure case (deploy broke, rollback broke) is explicitly named and returns the backup tag so a human knows exactly where to start recovery. The agent cannot fix this; it tells you.

The Docker path is handled separately. In a container, `systemctl` isn't available, so the deploy tool calls `process.exit(0)` and trusts the restart policy. It uses `setImmediate` to let the tool response return before the process exits, so the agent gets to say "container will restart automatically" before going dark.

## Rate Limiting in Process Memory

The rate limiter is simple: an in-process array of timestamps:

```typescript
const deployHistory: number[] = []
const MAX_DEPLOYS_PER_HOUR = 3

const now = Date.now()
const oneHourAgo = now - 60 * 60 * 1000
while (deployHistory.length > 0 && deployHistory[0] <= oneHourAgo) {
  deployHistory.shift()
}
if (deployHistory.length >= MAX_DEPLOYS_PER_HOUR) {
  return {
    output: `Deploy rate limited: ${deployHistory.length}/${MAX_DEPLOYS_PER_HOUR} deploys in the last hour.`,
    details: { deployed: false, reason: 'rate_limited' },
  }
}
```

This resets on process restart. A successful deploy (which restarts the service) also resets the rate limit counter. You'd need database-backed tracking to prevent gaming this with intentional restarts, but for a personal AI companion the in-process approach is honest about what it does and easy to understand.

## How the Tools Are Loaded

The self tools live in the `self` pack in `src/tools/packs.ts`:

```typescript
{
  name: 'self',
  description: 'Read, edit, test, and deploy own source code. View service logs and system health. Self-modification.',
  alwaysLoad: false,
  factories: [
    (ctx) => createSelfReadTool(ctx.projectRoot, ctx.extensionsDir),
    (ctx) => createSelfEditTool(ctx.projectRoot, ctx.extensionsDir),
    (ctx) => createSelfTestTool(ctx.projectRoot),
    (ctx) => createSelfLogsTool(ctx.logFile),
    (ctx) => createSelfStatusTool(ctx.dbPath, ctx.logFile),
    (ctx) => ctx.isDev ? null : createSelfDeployTool(ctx.projectRoot),
    () => createExtensionReloadTool(),
  ],
}
```

Two details here. First, `alwaysLoad: false`. The self pack is only activated when the incoming message embedding has sufficient cosine similarity to the pack description. The agent doesn't have self-modification tools in scope when you're asking about the weather; they appear when the conversation is semantically about the code itself.

Second, `ctx.isDev ? null : createSelfDeployTool(...)`. Deploy is disabled in development mode. You can read and edit source in dev, you can run tests, but the deploy tool simply doesn't exist. This prevents accidental live deploys during development without any runtime checks inside the tool itself.

## The Feedback Loop in Practice

A typical self-modification session looks like this:

1. User reports a bug or requests a feature via Telegram
2. Agent invokes `self_read_source` to understand the relevant code
3. Agent invokes `self_edit_source` with the minimal targeted change
4. Agent invokes `self_run_tests`, sometimes with a filter to run only the relevant suite
5. If tests pass, agent invokes `self_deploy` with `confirm: true` and a descriptive commit message
6. Deploy runs typecheck + tests again (yes, twice: belt and suspenders), commits, restarts
7. Agent invokes `self_view_logs` after a moment to confirm the service came up cleanly

The double test run is intentional. The agent-invoked test run gives immediate feedback with verbose output. The deploy-internal test run is the actual gate. It runs without the filter, against the full suite, with no opportunity for the agent to skip it.

## The Extension Authoring Loop

The self-modification tools don't stop at the main codebase. The same `self_edit_source` and `self_read_source` tools accept paths prefixed with `extensions/`, which get resolved against `$EXTENSIONS_DIR` (the user's extensions directory) rather than the project root.

This means the agent can write an entirely new capability, pick it up without restarting, and use it in the same conversation:

1. Agent writes `extensions/tools/weather.ts` via `self_edit_source` with `extensions/` path prefix
2. Agent calls `extension_reload` (part of the self pack) to pick up the new file
3. Agent calls `secret_store` to provision the API key the new tool declared in its `requires` block
4. Agent uses the weather tool in the next message

The same cycle works for skills. If the agent observes that it's repeatedly asked to run standups in a specific format, it can write `extensions/skills/standup.md` with the instructions formalized in frontmatter, reload, and the skill will activate automatically on future standup requests via the embedding router.

Nothing in this cycle touches the main source tree. The extensions directory is a separate containment zone with its own boundary check. Paths that would traverse out of it are denied independently of the `src/` and `cli/` checks. An agent authoring a weather extension cannot accidentally write to `src/agent.ts`.

The cycle closes entirely within a conversation: write → reload → use. No pull request, no restart, no human in the loop for the extension step (though the deploy gate still guards main codebase changes).

## Tradeoffs

This system has real limits and it's worth naming them.

**Scope is necessary but not sufficient.** The allowlist prevents reading `/etc/passwd`, but the agent can still make a change to `src/agent.ts` that introduces a subtle behavioral regression. The tests are the real defense against that, and the tests only cover what was written. An agent making novel changes can find the gaps.

**The rate limit is cosmetic at the current ceiling.** Three deploys per hour is enough friction to prevent runaway iteration but not enough to stop a determined sequence of intentional deploys. For a single-user personal AI this is fine. A multi-user deployment would want something harder to circumvent.

**The agent cannot deploy itself in development.** This is the right call for safety, but it means you can't test the full loop locally. The deploy tool behavior is tested by mocking `execFile` in `src/tools/self/__tests__/deploy.test.ts`, which covers the state machine thoroughly but doesn't exercise the actual subprocess calls.

**Path traversal is checked, but the search-and-replace is not sanitized.** The edit tool writes whatever replacement string the agent provides. If the agent were compromised and provided a malicious replacement, the allowlist wouldn't stop it. It only restricts which files can be written, not what can be written to them.

## Summary

The self-aware tooling in Construct works because it commits to a specific philosophy: narrow the surface, make failures explicit, and trust tests over runtime guards.

Every tool returns structured error details (`error: 'scope_violation'`, `reason: 'typecheck_failed'`, `reason: 'rate_limited'`) that give the agent (and any human reading the conversation) clear signal about what happened and why. There are no silent failures. The worst outcome (rollback failed, service is down) produces a message that says exactly that, includes the recovery tag, and tells you to intervene manually.

The pattern is applicable well beyond AI self-modification. Any system where an automated process needs to make controlled changes to a live production artifact benefits from the same structure: allowlists over blocklists, uniqueness requirements on edits, sequential gates that stop at the first failure, a named recovery point before each destructive step, and explicit worst-case handling.

The difference between scary and pragmatic is whether you wrote down what happens when it fails.
