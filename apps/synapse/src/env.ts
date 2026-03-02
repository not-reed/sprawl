import { z } from 'zod'

const envSchema = z.object({
  // Database paths
  CORTEX_DATABASE_URL: z.string().default('./data/cortex.db'),
  DATABASE_URL: z.string().default('./data/synapse.db'),

  // Portfolio
  INITIAL_BALANCE_USD: z
    .string()
    .default('10000')
    .transform((s) => parseFloat(s)),

  // Loop intervals (seconds)
  POLL_INTERVAL: z
    .string()
    .default('60')
    .transform((s) => parseInt(s, 10)),
  RISK_CHECK_INTERVAL: z
    .string()
    .default('30')
    .transform((s) => parseInt(s, 10)),

  // Signal filtering
  MIN_CONFIDENCE_SHORT: z
    .string()
    .default('0.4')
    .transform((s) => parseFloat(s)),
  MIN_CONFIDENCE_LONG: z
    .string()
    .default('0.6')
    .transform((s) => parseFloat(s)),

  // Position sizing
  MIN_TRADE_USD: z
    .string()
    .default('50')
    .transform((s) => parseFloat(s)),
  SIMULATED_GAS_USD: z
    .string()
    .default('0.50')
    .transform((s) => parseFloat(s)),
  MAX_GAS_PCT: z
    .string()
    .default('2')
    .transform((s) => parseFloat(s)),
  MAX_POSITION_PCT: z
    .string()
    .default('25')
    .transform((s) => parseFloat(s)),

  // Risk management
  MAX_PORTFOLIO_DRAWDOWN_PCT: z
    .string()
    .default('15')
    .transform((s) => parseFloat(s)),
  STOP_LOSS_PCT: z
    .string()
    .default('8')
    .transform((s) => parseFloat(s)),
  TAKE_PROFIT_PCT: z
    .string()
    .default('20')
    .transform((s) => parseFloat(s)),
  MAX_OPEN_POSITIONS: z
    .string()
    .default('8')
    .transform((s) => parseInt(s, 10)),

  // Paper executor
  SLIPPAGE_BPS: z
    .string()
    .default('30')
    .transform((s) => parseInt(s, 10)),
})

export type Env = z.infer<typeof envSchema>

export const env = envSchema.parse(process.env)
