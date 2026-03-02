import type { Executor, ExecutionResult } from '../types.js'
import type { CortexReader } from '../cortex/reader.js'
import { getTokenPrice } from './pricing.js'

export interface PaperExecutorConfig {
  slippageBps: number
  gasUsd: number
}

/**
 * Paper trading executor. Reads real prices from cortex,
 * applies simulated slippage and flat gas cost.
 */
export class PaperExecutor implements Executor {
  #cortex: CortexReader
  #config: PaperExecutorConfig

  constructor(cortex: CortexReader, config: PaperExecutorConfig) {
    this.#cortex = cortex
    this.#config = config
  }

  async buy(tokenId: string, amountUsd: number): Promise<ExecutionResult> {
    const basePrice = await getTokenPrice(this.#cortex, tokenId)
    if (basePrice === undefined) {
      throw new Error(`No price data for ${tokenId}`)
    }

    // Apply slippage (buying pushes price up)
    const slippageMultiplier = 1 + this.#config.slippageBps / 10000
    const executionPrice = basePrice * slippageMultiplier

    const effectiveAmount = amountUsd - this.#config.gasUsd
    const quantity = effectiveAmount / executionPrice

    return {
      price_usd: executionPrice,
      quantity,
      size_usd: amountUsd,
      gas_usd: this.#config.gasUsd,
      slippage_bps: this.#config.slippageBps,
    }
  }

  async sell(tokenId: string, quantity: number): Promise<ExecutionResult> {
    const basePrice = await getTokenPrice(this.#cortex, tokenId)
    if (basePrice === undefined) {
      throw new Error(`No price data for ${tokenId}`)
    }

    // Apply slippage (selling pushes price down)
    const slippageMultiplier = 1 - this.#config.slippageBps / 10000
    const executionPrice = basePrice * slippageMultiplier

    const grossUsd = quantity * executionPrice
    const netUsd = grossUsd - this.#config.gasUsd

    return {
      price_usd: executionPrice,
      quantity,
      size_usd: netUsd,
      gas_usd: this.#config.gasUsd,
      slippage_bps: this.#config.slippageBps,
    }
  }
}
