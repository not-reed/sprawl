import { Type, type Static } from '@sinclair/typebox'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import os from 'node:os'
import { rotateLogs } from '../../logger.js'

const exec = promisify(execFile)

const SelfStatusParams = Type.Object({
  rotate_logs: Type.Optional(
    Type.Boolean({
      description: 'Set to true to archive the current log file and start a fresh one',
    }),
  ),
})

type SelfStatusInput = Static<typeof SelfStatusParams>

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

async function getCpuTemp(): Promise<string | null> {
  try {
    const raw = await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf-8')
    return (parseInt(raw, 10) / 1000).toFixed(1) + '°C'
  } catch {
    return null
  }
}

async function getDiskUsage(): Promise<string> {
  try {
    const { stdout } = await exec('df', ['-h', '/'], { timeout: 5_000 })
    const lines = stdout.trim().split('\n')
    if (lines.length < 2) return 'unknown'
    const parts = lines[1].split(/\s+/)
    // size, used, avail, use%
    return `${parts[2]} used / ${parts[1]} total (${parts[4]})`
  } catch {
    return 'unknown'
  }
}

export function createSelfStatusTool(dbPath: string, logFile?: string) {
  return {
    name: 'self_system_status',
    description:
      'Check system health: CPU, RAM, disk, temperature, database size, log file size, and uptime. Can also rotate (archive) the log file when it grows large.',
    parameters: SelfStatusParams,
    execute: async (_toolCallId: string, args: SelfStatusInput) => {
      // Optionally rotate logs first
      let rotated = false
      if (args.rotate_logs && logFile) {
        await rotateLogs()
        rotated = true
      }

      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem
      const load = os.loadavg()
      const cpuCount = os.cpus().length

      const [cpuTemp, disk, dbSize, logSize] = await Promise.all([
        getCpuTemp(),
        getDiskUsage(),
        fileSize(dbPath),
        logFile ? fileSize(logFile) : Promise.resolve(null),
      ])

      const lines: string[] = [
        `System uptime:  ${formatUptime(os.uptime())}`,
        `Process uptime: ${formatUptime(process.uptime())}`,
        '',
        `CPU:  ${cpuCount} cores, load ${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)} (1/5/15m)`,
        ...(cpuTemp ? [`Temp: ${cpuTemp}`] : []),
        `RAM:  ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${((usedMem / totalMem) * 100).toFixed(0)}%)`,
        `Disk: ${disk}`,
        '',
        `Database: ${dbSize !== null ? formatBytes(dbSize) : 'not found'}`,
        ...(logFile
          ? [`Log file: ${logSize !== null ? formatBytes(logSize) : 'not found'}${rotated ? ' (just rotated)' : ''}`]
          : []),
      ]

      return {
        output: lines.join('\n'),
        details: {
          cpu_cores: cpuCount,
          load_1m: load[0],
          cpu_temp: cpuTemp,
          ram_used: usedMem,
          ram_total: totalMem,
          db_bytes: dbSize,
          log_bytes: logSize,
          process_uptime_s: Math.floor(process.uptime()),
          rotated,
        },
      }
    },
  }
}
