export type TradeDirection = 'buy' | 'sell'

export interface ExecutionResult {
  /** Actual execution price after slippage */
  price_usd: number
  /** Token quantity bought or sold */
  quantity: number
  /** Total USD value of the trade */
  size_usd: number
  /** Gas cost in USD */
  gas_usd: number
  /** Slippage applied in basis points */
  slippage_bps: number
}

export interface Executor {
  buy(tokenId: string, amountUsd: number): Promise<ExecutionResult>
  sell(tokenId: string, quantity: number): Promise<ExecutionResult>
}
