import { Type, type Static } from '@sinclair/typebox'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { toolLog } from '../../logger.js'

const isDocker = existsSync('/.dockerenv')

const exec = promisify(execFile)

const SelfDeployParams = Type.Object({
  confirm: Type.Boolean({
    description:
      'Must be true to proceed. This is a safety gate — set to true only after you are confident the change is correct.',
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
  serviceUnit = 'construct',
) {
  return {
    name: 'self_deploy',
    description:
      'Deploy changes after a verified self-edit. Runs typecheck and tests automatically, commits to git with a backup tag, restarts the service, and verifies it came up healthy. Auto-rolls back if the service fails to start. Rate limited to 3/hour.',
    parameters: SelfDeployParams,
    execute: async (_toolCallId: string, args: SelfDeployInput) => {
      if (!args.confirm) {
        return {
          output: 'Deploy aborted: confirm must be true.',
          details: { deployed: false, reason: 'not_confirmed' },
        }
      }

      // Rate limit check (prune old entries)
      const now = Date.now()
      const oneHourAgo = now - 60 * 60 * 1000
      while (deployHistory.length > 0 && deployHistory[0] <= oneHourAgo) {
        deployHistory.shift()
      }
      if (deployHistory.length >= MAX_DEPLOYS_PER_HOUR) {
        return {
          output: `Deploy rate limited: ${deployHistory.length}/${MAX_DEPLOYS_PER_HOUR} deploys in the last hour. Wait before trying again.`,
          details: { deployed: false, reason: 'rate_limited' },
        }
      }

      const execOpts = { cwd: projectRoot, timeout: 60_000 }

      // 1. Typecheck
      toolLog.info`Running typecheck before deploy`
      try {
        await exec('npx', ['tsc', '--noEmit'], execOpts)
      } catch (err) {
        const msg = err instanceof Error
          ? (err as Error & { stdout?: string; stderr?: string }).stderr ?? err.message
          : String(err)
        return {
          output: `Deploy aborted: typecheck failed.\n${String(msg).slice(-1500)}`,
          details: { deployed: false, reason: 'typecheck_failed' },
        }
      }

      // 2. Run tests
      toolLog.info`Running tests before deploy`
      try {
        await exec('npx', ['vitest', 'run'], execOpts)
      } catch (err) {
        const msg = err instanceof Error
          ? (err as Error & { stdout?: string; stderr?: string }).stdout ?? err.message
          : String(err)
        return {
          output: `Deploy aborted: tests failed.\n${String(msg).slice(-1500)}`,
          details: { deployed: false, reason: 'tests_failed' },
        }
      }

      // 3. Tag current state as backup
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupTag = `pre-deploy-${timestamp}`
      try {
        await exec('git', ['tag', backupTag], execOpts)
        toolLog.info`Created backup tag: ${backupTag}`
      } catch {
        // Tag may fail if not a git repo — continue anyway
      }

      // 4. Stage and commit
      try {
        await exec('git', ['add', 'src/', 'cli/', 'extensions/'], execOpts)
        await exec('git', ['commit', '-m', args.commit_message], execOpts)
        toolLog.info`Committed: ${args.commit_message}`
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          output: `Deploy failed at git commit: ${msg}`,
          details: { deployed: false, reason: 'commit_failed', error: msg },
        }
      }

      // 5. Restart service
      if (isDocker) {
        // In Docker: exit the process and let restart policy bring it back
        deployHistory.push(now)
        toolLog.info`Docker detected — exiting process for container restart`
        // Use setImmediate so this tool call returns before the process exits
        setImmediate(() => process.exit(0))
        return {
          output: `Deployed successfully. Committed: "${args.commit_message}". Container will restart automatically.`,
          details: { deployed: true, tag: backupTag, docker: true },
        }
      }

      toolLog.info`Restarting service: ${serviceUnit}`
      try {
        await exec('sudo', ['systemctl', 'restart', serviceUnit], {
          timeout: 15_000,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          output: `Deploy failed at service restart: ${msg}. Changes are committed — you may need to manually investigate.`,
          details: { deployed: false, reason: 'restart_failed', error: msg, tag: backupTag },
        }
      }

      // 6. Health check — wait a few seconds then check if service is running
      toolLog.info`Waiting for health check`
      await setTimeout(5_000)

      try {
        const { stdout } = await exec(
          'systemctl', ['is-active', serviceUnit],
          { timeout: 5_000 },
        )
        if (stdout.trim() === 'active') {
          deployHistory.push(now)
          toolLog.info`Deploy successful`
          return {
            output: `Deployed successfully. Committed: "${args.commit_message}". Service is healthy.`,
            details: { deployed: true, tag: backupTag },
          }
        }
      } catch {
        // is-active returns non-zero if not active — fall through to rollback
      }

      // 7. Auto-rollback — service didn't come up healthy
      toolLog.error`Service failed health check — rolling back to ${backupTag}`
      try {
        await exec('git', ['revert', '--no-edit', 'HEAD'], execOpts)
        await exec('sudo', ['systemctl', 'restart', serviceUnit], {
          timeout: 15_000,
        })
        return {
          output: `Deploy ROLLED BACK. Service failed to start after restart. Reverted commit and restarted. Check logs with self_view_logs to diagnose.`,
          details: { deployed: false, reason: 'health_check_failed', rolledBack: true, tag: backupTag },
        }
      } catch (rollbackErr) {
        const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        return {
          output: `Deploy FAILED and ROLLBACK FAILED. Service is down. Manual intervention needed. Backup tag: ${backupTag}. Rollback error: ${msg}`,
          details: { deployed: false, reason: 'rollback_failed', tag: backupTag, error: msg },
        }
      }
    },
  }
}
