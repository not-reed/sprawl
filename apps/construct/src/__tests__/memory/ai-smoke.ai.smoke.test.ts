/**
 * Minimal AI smoke test (1 cheap call) to verify the LLM path works.
 * Skips if OPENROUTER_API_KEY is not set.
 */

import { describe, it, expect } from "vitest";
import { reflect, type WorkerModelConfig } from "@repo/cairn";

const API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const MODEL = process.env.MEMORY_WORKER_MODEL ?? "google/gemini-2.5-flash-lite";

const WORKER_CONFIG: WorkerModelConfig = {
  apiKey: API_KEY,
  model: MODEL,
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  extraBody: { max_tokens: 512 },
};

const shouldRun = API_KEY.length > 0;
const describeSmoke = shouldRun ? describe : describe.skip;

describeSmoke("memory AI smoke", () => {
  it("reflects a tiny observation set without errors", async () => {
    const result = await reflect(WORKER_CONFIG, {
      observations: [
        {
          id: "o1",
          conversation_id: "c1",
          content: "User moved to Portland in 2025",
          priority: "high",
          observation_date: "2025-01-15",
          source_message_ids: [],
          token_count: 10,
          generation: 0,
          superseded_at: null,
          created_at: "2025-01-15T10:00:00Z",
        },
        {
          id: "o2",
          conversation_id: "c1",
          content: "User prefers window seats on flights",
          priority: "medium",
          observation_date: "2025-01-15",
          source_message_ids: [],
          token_count: 12,
          generation: 0,
          superseded_at: null,
          created_at: "2025-01-15T10:01:00Z",
        },
      ],
    });

    expect(Array.isArray(result.observations)).toBe(true);
    expect(Array.isArray(result.superseded_ids)).toBe(true);

    const inputIds = new Set(["o1", "o2"]);
    for (const id of result.superseded_ids) {
      expect(inputIds.has(id)).toBe(true);
    }
  }, 30_000);
});
