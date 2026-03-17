import { toolLog } from "../logger.js";
import type { SkillInstructionDep } from "./types.js";

interface ExtractionResult {
  instructions: string[];
  dependencies: [number, number][]; // [fromIndex, toIndex] pairs
}

/**
 * Extract atomic behavioral instructions from a skill body using an LLM.
 * Returns array of instruction strings and dependency relationships.
 */
export async function extractInstructions(
  apiKey: string,
  skillName: string,
  skillBody: string,
  model?: string,
): Promise<ExtractionResult> {
  const modelToUse = model || "google/gemini-3-flash-preview";

  const prompt = `You are an expert at decomposing procedural knowledge into atomic, self-contained instructions.

Analyze the following skill body and extract the minimal set of behavioral instructions. Each instruction must be:
- Self-contained and actionable
- Specific enough to be useful
- Minimal (don't combine unrelated steps)
- Clear about prerequisites (e.g., "requires authentication")

Where one instruction depends on another (e.g., "authenticate first, then fetch"), record that dependency.

Skill name: ${skillName}

Skill body:
${skillBody}

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "instructions": ["instruction 1", "instruction 2", ...],
  "dependencies": [[0, 1], [1, 2], ...]
}

where dependencies[i] = [fromIndex, toIndex] means instruction[fromIndex] requires instruction[toIndex] to run first.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelToUse,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${err}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error("No content in API response");
    }

    // Strip thinking tags (some models emit <think>...</think> before JSON)
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();

    // Parse JSON response
    const result = JSON.parse(cleaned) as ExtractionResult;

    if (!Array.isArray(result.instructions) || !Array.isArray(result.dependencies)) {
      throw new Error("Invalid extraction result structure");
    }

    return result;
  } catch (err) {
    toolLog.warning`Failed to extract instructions for skill ${skillName}: ${err}`;
    // Fallback: treat the entire body as a single instruction
    return {
      instructions: [skillBody],
      dependencies: [],
    };
  }
}

/**
 * Build a transitive closure of dependency indices.
 * Given a set of direct dependencies, return all transitive dependencies.
 */
export function buildTransitiveDeps(direct: [number, number][]): Map<number, Set<number>> {
  const closure = new Map<number, Set<number>>();

  // Initialize
  for (const [from, to] of direct) {
    if (!closure.has(from)) {
      closure.set(from, new Set());
    }
    closure.get(from)!.add(to);
  }

  // Floyd-Warshall-like transitive closure
  const maxIdx = Math.max(...direct.flat(), -1) + 1;
  for (let k = 0; k < maxIdx; k++) {
    for (let i = 0; i < maxIdx; i++) {
      if (closure.has(i) && closure.get(i)!.has(k)) {
        const deps = closure.get(k);
        if (deps) {
          closure.get(i)!.forEach(() => deps.forEach((d) => closure.get(i)!.add(d)));
        }
      }
    }
  }

  return closure;
}

/**
 * Resolve instruction dependencies by index to IDs.
 * Maps direct dependencies (expressed as index pairs) to ID pairs.
 */
export function resolveDependencyIds(
  direct: [number, number][],
  instructionIds: string[],
): SkillInstructionDep[] {
  const deps: SkillInstructionDep[] = [];

  for (const [fromIdx, toIdx] of direct) {
    if (fromIdx < instructionIds.length && toIdx < instructionIds.length) {
      deps.push({
        fromId: instructionIds[fromIdx]!,
        toId: instructionIds[toIdx]!,
        relation: "requires",
      });
    }
  }

  return deps;
}
