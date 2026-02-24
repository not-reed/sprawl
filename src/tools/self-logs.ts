import { Type, type Static } from '@sinclair/typebox'
import { execFile } from 'node:child_process'
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

export function createSelfLogsTool(serviceUnit = 'nullclaw') {
  return {
    name: 'self_view_logs',
    description:
      'View your own service logs from journald. Use this to diagnose errors or verify that a fix worked after deployment.',
    parameters: SelfLogsParams,
    execute: async (_toolCallId: string, args: SelfLogsInput) => {
      const lines = args.lines ?? 50
      const cmdArgs = [
        '-u',
        serviceUnit,
        '-n',
        String(lines),
        '--no-pager',
        '-o',
        'short-iso',
      ]

      if (args.since) {
        cmdArgs.push('--since', args.since)
      }

      try {
        let { stdout } = await exec('journalctl', cmdArgs, {
          timeout: 10_000,
        })

        if (args.grep && stdout) {
          stdout = stdout
            .split('\n')
            .filter((line) => line.toLowerCase().includes(args.grep!.toLowerCase()))
            .join('\n')
        }

        if (!stdout.trim()) {
          return {
            output: 'No log output found for the given criteria.',
            details: { lines: 0 },
          }
        }

        return {
          output: `Recent logs (${serviceUnit}):\n${stdout.slice(-3000)}`,
          details: { lines: stdout.split('\n').length },
        }
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
