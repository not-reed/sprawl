import { Type, type Static } from '@sinclair/typebox'
import { execFile } from 'node:child_process'
import { readFile, access } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const SelfLogsParams = Type.Object({
  lines: Type.Optional(
    Type.Number({ description: 'Number of recent log lines to return (default: 50)' }),
  ),
  since: Type.Optional(
    Type.String({
      description: 'Show logs since this time (e.g. "5 minutes ago", "1 hour ago")',
    }),
  ),
  grep: Type.Optional(
    Type.String({ description: 'Filter log lines containing this string' }),
  ),
})

type SelfLogsInput = Static<typeof SelfLogsParams>

/**
 * Parse relative time strings like "5 minutes ago", "1 hour ago" into a Date.
 */
function parseSince(since: string): Date | null {
  const match = since.match(/^(\d+)\s+(second|minute|hour|day|week)s?\s+ago$/i)
  if (!match) {
    // Try parsing as an ISO date
    const d = new Date(since)
    return isNaN(d.getTime()) ? null : d
  }
  const amount = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const ms: Record<string, number> = {
    second: 1_000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
  }
  return new Date(Date.now() - amount * ms[unit])
}

async function readFromLogFile(
  logFile: string,
  args: SelfLogsInput,
): Promise<{ output: string; details: unknown } | null> {
  try {
    await access(logFile)
  } catch {
    return null // file doesn't exist, fall through to journalctl
  }

  const content = await readFile(logFile, 'utf-8')
  let lines = content.split('\n').filter(Boolean)

  // Filter by "since" — lines start with ISO timestamps
  if (args.since) {
    const cutoff = parseSince(args.since)
    if (cutoff) {
      lines = lines.filter((line) => {
        const ts = line.slice(0, 24) // ISO 8601 with ms
        const d = new Date(ts)
        return !isNaN(d.getTime()) && d >= cutoff
      })
    }
  }

  // Filter by grep
  if (args.grep) {
    const term = args.grep.toLowerCase()
    lines = lines.filter((line) => line.toLowerCase().includes(term))
  }

  // Take last N lines
  const n = args.lines ?? 50
  lines = lines.slice(-n)

  if (lines.length === 0) {
    return {
      output: 'No log output found for the given criteria.',
      details: { lines: 0, source: 'file' },
    }
  }

  const text = lines.join('\n').slice(-3000)
  return {
    output: `Recent logs (file):\n${text}`,
    details: { lines: lines.length, source: 'file' },
  }
}

async function readFromJournalctl(
  serviceUnit: string,
  args: SelfLogsInput,
): Promise<{ output: string; details: unknown }> {
  const lines = args.lines ?? 50
  const cmdArgs = [
    '-u', serviceUnit,
    '-n', String(lines),
    '--no-pager',
    '-o', 'short-iso',
  ]
  if (args.since) {
    cmdArgs.push('--since', args.since)
  }

  let { stdout } = await exec('journalctl', cmdArgs, { timeout: 10_000 })

  if (args.grep && stdout) {
    stdout = stdout
      .split('\n')
      .filter((line) => line.toLowerCase().includes(args.grep!.toLowerCase()))
      .join('\n')
  }

  if (!stdout.trim()) {
    return {
      output: 'No log output found for the given criteria.',
      details: { lines: 0, source: 'journalctl' },
    }
  }

  return {
    output: `Recent logs (${serviceUnit}):\n${stdout.slice(-3000)}`,
    details: { lines: stdout.split('\n').length, source: 'journalctl' },
  }
}

export function createSelfLogsTool(logFile?: string, serviceUnit = 'construct') {
  return {
    name: 'self_view_logs',
    description:
      'View your own service logs. Use this to diagnose errors or verify that a fix worked after deployment.',
    parameters: SelfLogsParams,
    execute: async (_toolCallId: string, args: SelfLogsInput) => {
      try {
        // Try log file first (works in dev and prod)
        if (logFile) {
          const result = await readFromLogFile(logFile, args)
          if (result) return result
        }

        // Fall back to journalctl (systemd / production)
        return await readFromJournalctl(serviceUnit, args)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          output: `Error reading logs: ${msg}`,
          details: { error: msg },
        }
      }
    },
  }
}
