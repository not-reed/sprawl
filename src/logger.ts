import { configure, getConsoleSink, getLogger } from '@logtape/logtape'

export async function setupLogging(level: string = 'info') {
  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: ({ level, category, message, timestamp, properties }) => {
          const ts = new Date(timestamp).toISOString()
          const cat = category.join('.')
          const props = Object.keys(properties).length > 0
            ? ' ' + JSON.stringify(properties)
            : ''
          return `${ts} [${level}] ${cat}: ${message.join('')}${props}`
        },
      }),
    },
    filters: {},
    loggers: [
      {
        category: 'nullclaw',
        lowestLevel: level as 'debug' | 'info' | 'warning' | 'error' | 'fatal',
        sinks: ['console'],
      },
    ],
  })
}

export const log = getLogger(['nullclaw'])
export const agentLog = getLogger(['nullclaw', 'agent'])
export const toolLog = getLogger(['nullclaw', 'tool'])
export const telegramLog = getLogger(['nullclaw', 'telegram'])
export const schedulerLog = getLogger(['nullclaw', 'scheduler'])
export const dbLog = getLogger(['nullclaw', 'db'])
