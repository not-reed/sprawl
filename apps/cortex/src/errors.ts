/** Error during data ingestion (prices, news, RSS). */
export class IngestError extends Error {
  override name = "IngestError" as const;
}

/** Error during LLM signal analysis. */
export class AnalyzerError extends Error {
  override name = "AnalyzerError" as const;
}
