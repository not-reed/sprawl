// OpenRouter model pricing ($/M tokens). Update from https://openrouter.ai as needed.
// [inputPricePerM, outputPricePerM]
export const MODEL_PRICING: Record<string, [number, number]> = {
  "deepseek/deepseek-v3-2": [0.26, 0.38],
  "minimax/minimax-m2.5": [0, 0], // TODO: fill in
  "qwen/qwen3.5-flash-02-23": [0, 0], // TODO: fill in
  "google/gemini-3-flash-preview": [0, 0], // TODO: fill in
  "google/gemini-3.1-flash-lite-preview": [0, 0], // TODO: fill in
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing || (pricing[0] === 0 && pricing[1] === 0)) return 0;
  return (inputTokens * pricing[0] + outputTokens * pricing[1]) / 1_000_000;
}
