/** Error during trade execution (paper or live). */
export class ExecutionError extends Error {
  override name = "ExecutionError" as const;
}

/** Error during risk management checks. */
export class RiskError extends Error {
  override name = "RiskError" as const;
}
