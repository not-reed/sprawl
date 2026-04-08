// OpenRouter model pricing ($/M tokens). Update from https://openrouter.ai as needed.
// [inputPricePerM, outputPricePerM]
export const MODEL_PRICING: Record<string, [number, number]> = {
  "deepseek/deepseek-v3.2": [0.26, 0.38],
  "minimax/minimax-m2.5": [0.118, 0.99],
  "openai/gpt-oss-120b": [0.039, 0.19],
  "google/gemini-2.5-flash-lite": [0.1, 0.4],
  "google/gemini-3-flash-preview": [0.5, 3],
  "google/gemini-3.1-flash-lite-preview": [0.25, 1.5],
  "xiaomi/mimo-v2-flash": [0.09, 0.29],
  "xiaomi/mimo-v2-omni": [0.4, 2],
  "stepfun/step-3.5-flash": [0.1, 0.3],
  "qwen/qwen3.5-flash-02-23": [0.065, 0.26],
  "z-ai/glm-4.5-air": [0.13, 0.85],
  "z-ai/glm-4.7-flash": [0.06, 0.4],
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing || (pricing[0] === 0 && pricing[1] === 0)) return 0;
  return (inputTokens * pricing[0] + outputTokens * pricing[1]) / 1_000_000;
}
