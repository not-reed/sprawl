import { Type, type Static } from '@sinclair/typebox'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const SelfDeployParams = Type.Object({
  confirm: Type.Boolean({
    description:
      'Must be true to proceed. This is a safety gate — set to true only after tests pass.',
  }),
  commit_message: Type.String({
    description: 'Git commit message describing the change',
  }),
})

type SelfDeployInput = Static<typeof SelfDeployParams>

// Rate limit: track deploy attempts
const deployHistory: number[] = []
const MAX_DEPLOYS_PER_HOUR = 3

export function createSelfDeployTool(
  projectRoot: string,
  serviceUnit = 'nullclaw',
) {
  return {
    name: 'self_deploy',
    description:
      'Deploy changes after a verified self-edit. Commits changes to git, tags a backup, and restarts the systemd service. Requires confirm=true and a commit message. Rate limited to 3 deploys per hour.',
    parameters: SelfDeployParams,
    execute: async (_toolCallId: string, args: SelfDeployInput) => {
      if (!args.confirm) {
        return {
          output: 'Deploy aborted: confirm must be true. Run self_run_tests first.',
          details: { deployed: false, reason: 'not_confirmed' },
        }
      }

      // Rate limit check
      const now = Date.now()
      const oneHourAgo = now - 60 * 60 * 1000
      const recentDeploys = deployHistory.filter((t) => t > oneHourAgo)
      if (recentDeploys.length >= MAX_DEPLOYS_PER_HOUR) {
        return {
          output: `Deploy rate limited: ${recentDeploys.length}/${MAX_DEPLOYS_PER_HOUR} deploys in the last hour. Wait before trying again.`,
          details: { deployed: false, reason: 'rate_limited' },
        }
      }

      const execOpts = { cwd: projectRoot, timeout: 30_000 }

      try {
        // 1. Tag current state as backup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        await exec(
          'git',
          ['tag', `pre-deploy-${timestamp}`],
          execOpts,
        ).catch(() => {
          // Tag may fail if not a git repo — that's ok
        })

        // 2. Stage and commit
        await exec('git', ['add', 'src/', 'cli/'], execOpts)
        await exec(
          'git',
          ['commit', '-m', args.commit_message],
          execOpts,
        )

        // 3. Restart service
        await exec('sudo', ['systemctl', 'restart', serviceUnit], {
          timeout: 15_000,
        })

        deployHistory.push(now)

        return {
          output: `Deployed successfully. Committed: "${args.commit_message}". Service ${serviceUnit} restarted. Check logs to verify.`,
          details: { deployed: true, tag: `pre-deploy-${timestamp}` },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          output: `Deploy failed: ${msg}`,
          details: { deployed: false, error: msg },
        }
      }
    },
  }
}
