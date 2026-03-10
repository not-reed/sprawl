import { createLogger } from '@repo/log'

export const log = createLogger('cortex')
export const ingestLog = createLogger('cortex', 'ingest')
export const pipelineLog = createLogger('cortex', 'pipeline')
