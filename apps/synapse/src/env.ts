import { z } from 'zod'
import { intFromEnv, floatFromEnv } from '@repo/env'

const envSchema = z.object({
  // Database paths
  CORTEX_DATABASE_URL: z.string().default('./data/cortex.db'),
  DATABASE_URL: z.string().default('./data/synapse.db'),

  // Portfolio
  INITIAL_BALANCE_USD: floatFromEnv('10000'),

  // Loop intervals (seconds)
  POLL_INTERVAL: intFromEnv('60'),
  RISK_CHECK_INTERVAL: intFromEnv('30'),

  // Signal filtering
  MIN_CONFIDENCE_SHORT: floatFromEnv('0.4'),
  MIN_CONFIDENCE_LONG: floatFromEnv('0.6'),

  // Position sizing
  MIN_TRADE_USD: floatFromEnv('50'),
  SIMULATED_GAS_USD: floatFromEnv('0.50'),
  MAX_GAS_PCT: floatFromEnv('2'),
  MAX_POSITION_PCT: floatFromEnv('25'),

  // Risk management
  MAX_PORTFOLIO_DRAWDOWN_PCT: floatFromEnv('15'),
  STOP_LOSS_PCT: floatFromEnv('8'),
  TAKE_PROFIT_PCT: floatFromEnv('20'),
  MAX_OPEN_POSITIONS: intFromEnv('8'),

  // Paper executor
  SLIPPAGE_BPS: intFromEnv('30'),
})

export type Env = z.infer<typeof envSchema>

export const env = envSchema.parse(process.env)
