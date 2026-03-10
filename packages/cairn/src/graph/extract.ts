import type { WorkerModelConfig, ExtractionResult, CairnLogger } from "../types.js";
import { GraphError } from "../errors.js";

export const DEFAULT_ENTITY_TYPES = ["person", "place", "concept", "event", "entity"];

function buildExtractionPrompt(entityTypes: string[]): string {
  return `Extract entities and relationships from the following memory content.

Return a JSON object with:
- "entities": array of {name, type, description?} where type is one of: ${entityTypes.join(", ")}
- "relationships": array of {from, to, relation} where from/to are entity names and relation is a short verb phrase

Rules:
- Extract only clearly stated facts, not speculation
- Use the most specific entity type possible (prefer "person" over "entity")
- Keep relation phrases short and lowercase (e.g. "lives in", "works at", "likes")
- If no entities or relationships are found, return empty arrays
- Entity names should preserve original casing

Respond ONLY with the JSON object, no markdown fences or explanation.`;
}

/**
 * Extract entities and relationships from memory content using an LLM.
 * Normalizes entity types against the allowed set and validates relationship structure.
 * @param config - Worker model config (model name, API key, base URL).
 * @param content - Memory text to extract from.
 * @param logger - Optional logger for parse failure warnings.
 * @param entityTypes - Allowed entity types (defaults to DEFAULT_ENTITY_TYPES).
 * @returns Entities, relationships, and optional token usage stats.
 */
export async function extractEntities(
  config: WorkerModelConfig,
  content: string,
  logger?: CairnLogger,
  entityTypes?: string[],
): Promise<ExtractionResult> {
  const types = entityTypes ?? DEFAULT_ENTITY_TYPES;
  const response = await fetch(config.baseUrl ?? "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: buildExtractionPrompt(types) },
        { role: "user", content },
      ],
      temperature: 0,
      max_tokens: 1024,
      ...config.extraBody,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new GraphError(`Extraction API error: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = data.choices[0]?.message?.content?.trim();
  if (!text) {
    logger?.debug(`Empty extraction response for content: ${content.slice(0, 80)}`);
    return {
      entities: [],
      relationships: [],
      usage: data.usage
        ? {
            input_tokens: data.usage.prompt_tokens ?? 0,
            output_tokens: data.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  }

  // Parse JSON, stripping markdown fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger?.warning(`Failed to parse extraction response: ${text.slice(0, 200)}`);
    return { entities: [], relationships: [] };
  }

  // Validate structure
  const result = parsed as ExtractionResult;
  if (!Array.isArray(result.entities)) result.entities = [];
  if (!Array.isArray(result.relationships)) result.relationships = [];

  // Normalize entity types
  const validTypes = new Set(types);
  result.entities = result.entities.filter(
    (e) => e.name && typeof e.name === "string" && validTypes.has(e.type),
  );
  result.relationships = result.relationships.filter(
    (r) => r.from && r.to && r.relation && typeof r.from === "string" && typeof r.to === "string",
  );

  return {
    entities: result.entities,
    relationships: result.relationships,
    usage: data.usage
      ? {
          input_tokens: data.usage.prompt_tokens ?? 0,
          output_tokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}
