import { configure, getConsoleSink, getLogger } from '@logtape/logtape'
import {
  createWriteStream,
  statSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  type WriteStream,
} from 'node:fs'
import { dirname } from 'node:path'

const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5 MB
const MAX_ROTATED = 3

// --- Rotation ---

function shiftFiles(filePath: string) {
  for (let i = MAX_ROTATED; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`
    const dst = `${filePath}.${i}`
    try { if (i === MAX_ROTATED) unlinkSync(dst) } catch {}
    try { renameSync(src, dst) } catch {}
  }
}

function rotateIfOversized(filePath: string) {
  try {
    if (statSync(filePath).size >= MAX_LOG_SIZE) shiftFiles(filePath)
  } catch {}
}

// --- Custom file sink (swappable stream for runtime rotation) ---

let logFilePath: string | undefined
let logStream: WriteStream | undefined

function openStream(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true })
  logStream = createWriteStream(filePath, { flags: 'a' })
}

/**
 * Rotate the current log file. Safe to call at any time.
 * Closes the current stream, shifts files, opens a fresh stream.
 */
export async function rotateLogs(): Promise<void> {
  if (!logFilePath) return

  // Close current stream
  if (logStream) {
    await new Promise<void>((resolve, reject) => {
      logStream!.end((err: Error | null) => (err ? reject(err) : resolve()))
    })
    logStream = undefined
  }

  shiftFiles(logFilePath)
  openStream(logFilePath)
}

// --- Formatter (shared between console + file) ---

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

// --- Setup ---

export async function setupLogging(level: string = 'info', logFile?: string) {
  const sinks: Record<string, any> = {
    console: getConsoleSink({ formatter }),
  }

  if (logFile) {
    logFilePath = logFile
    mkdirSync(dirname(logFile), { recursive: true })
    rotateIfOversized(logFile)
    openStream(logFile)

    // Custom sink that writes to the swappable logStream
    sinks.file = (record: Parameters<typeof formatter>[0]) => {
      logStream?.write(formatter(record) + '\n')
    }
  }

  await configure({
    sinks,
    filters: {},
    loggers: [
      {
        category: 'construct',
        lowestLevel: level as 'debug' | 'info' | 'warning' | 'error' | 'fatal',
        sinks: Object.keys(sinks),
      },
    ],
  })
}

export const log = getLogger(['construct'])
export const agentLog = getLogger(['construct', 'agent'])
export const toolLog = getLogger(['construct', 'tool'])
export const telegramLog = getLogger(['construct', 'telegram'])
export const schedulerLog = getLogger(['construct', 'scheduler'])
export const dbLog = getLogger(['construct', 'db'])
