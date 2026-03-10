import { configure, getConsoleSink, getLogger, type Logger } from '@logtape/logtape'
import {
  createWriteStream,
  statSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  type WriteStream,
} from 'node:fs'
import { dirname } from 'node:path'

export type { Logger }

export interface LogConfig {
  /** Root category name (e.g. 'construct', 'cortex'). */
  appName: string
  /** Minimum log level. Default: 'info'. */
  level?: 'debug' | 'info' | 'warning' | 'error' | 'fatal'
  /** File path for rotating file sink. If omitted, console only. */
  logFile?: string
  /** Max log file size in bytes before rotation. Default: 5MB. */
  maxFileSize?: number
  /** Max rotated file count. Default: 3. */
  maxRotated?: number
}

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const DEFAULT_MAX_ROTATED = 3

// --- Rotation state ---

let logFilePath: string | undefined
let logStream: WriteStream | undefined
let maxFileSize = DEFAULT_MAX_FILE_SIZE
let maxRotated = DEFAULT_MAX_ROTATED

function shiftFiles(filePath: string) {
  for (let i = maxRotated; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`
    const dst = `${filePath}.${i}`
    try { if (i === maxRotated) unlinkSync(dst) } catch {}
    try { renameSync(src, dst) } catch {}
  }
}

function rotateIfOversized(filePath: string) {
  try {
    if (statSync(filePath).size >= maxFileSize) shiftFiles(filePath)
  } catch {}
}

function openStream(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true })
  logStream = createWriteStream(filePath, { flags: 'a' })
}

// --- Formatter ---

const formatter = ({ level, category, message, timestamp, properties }: {
  level: string
  category: readonly string[]
  message: readonly unknown[]
  timestamp: number
  properties: Record<string, unknown>
}) => {
  const ts = new Date(timestamp).toISOString()
  const cat = category.join('.')
  const msg = message.map(String).join('')
  const props = Object.keys(properties).length > 0
    ? ' ' + JSON.stringify(properties)
    : ''
  return `${ts} [${level}] ${cat}: ${msg}${props}`
}

// --- Public API ---

/**
 * Set up logtape with console sink + optional rotating file sink.
 * Call once at app boot.
 */
export async function setupLogging(config: LogConfig): Promise<void> {
  const level = config.level ?? 'info'
  maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  maxRotated = config.maxRotated ?? DEFAULT_MAX_ROTATED

  const sinks: Record<string, any> = {
    console: getConsoleSink({ formatter }),
  }

  if (config.logFile) {
    logFilePath = config.logFile
    mkdirSync(dirname(config.logFile), { recursive: true })
    rotateIfOversized(config.logFile)
    openStream(config.logFile)

    sinks.file = (record: Parameters<typeof formatter>[0]) => {
      logStream?.write(formatter(record) + '\n')
    }
  }

  await configure({
    sinks,
    filters: {},
    loggers: [
      {
        category: config.appName,
        lowestLevel: level,
        sinks: Object.keys(sinks),
      },
    ],
  })
}

/**
 * Rotate the current log file. Safe to call at any time.
 * No-op if no file sink is configured.
 */
export async function rotateLogs(): Promise<void> {
  if (!logFilePath) return

  if (logStream) {
    await new Promise<void>((resolve, reject) => {
      logStream!.end((err: Error | null) => (err ? reject(err) : resolve()))
    })
    logStream = undefined
  }

  shiftFiles(logFilePath)
  openStream(logFilePath)
}

/**
 * Get a category logger. Pass hierarchical names:
 * `createLogger('construct', 'agent')` → category ['construct', 'agent']
 */
export function createLogger(...category: string[]): Logger {
  return getLogger(category)
}
