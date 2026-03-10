import { z } from 'zod'

/** Parse env string as integer. Use: `intFromEnv('300')` for default, `intFromEnv()` for required. */
export function intFromEnv(defaultValue?: string) {
  const base = z.string()
  const withDefault = defaultValue !== undefined ? base.default(defaultValue) : base
  return withDefault.transform((s) => parseInt(s, 10))
}

/** Parse env string as float. Use: `floatFromEnv('0.5')` for default, `floatFromEnv()` for required. */
export function floatFromEnv(defaultValue?: string) {
  const base = z.string()
  const withDefault = defaultValue !== undefined ? base.default(defaultValue) : base
  return withDefault.transform((s) => parseFloat(s))
}

/** Split comma-separated env string into string[]. Use: `csvFromEnv('a,b')` for default, `csvFromEnv()` for required. */
export function csvFromEnv(defaultValue?: string) {
  const base = z.string()
  const withDefault = defaultValue !== undefined ? base.default(defaultValue) : base
  return withDefault.transform((s) => s.split(',').filter(Boolean))
}
