import { setupLogging as setup, rotateLogs, createLogger } from '@repo/log'

export { rotateLogs }

export async function setupLogging(level?: string, logFile?: string): Promise<void> {
  await setup({
    appName: 'construct',
    level: level as 'debug' | 'info' | 'warning' | 'error' | 'fatal',
    logFile,
  })
}

export const log = createLogger('construct')
export const agentLog = createLogger('construct', 'agent')
export const toolLog = createLogger('construct', 'tool')
export const telegramLog = createLogger('construct', 'telegram')
export const schedulerLog = createLogger('construct', 'scheduler')
export const dbLog = createLogger('construct', 'db')
