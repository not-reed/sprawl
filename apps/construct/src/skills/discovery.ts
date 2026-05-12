import { agentLog } from "../logger.js";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";

export interface ExtractedSkill {
  name: string;
  description: string;
  body: string;
  confidence: number;
}

export interface SkillConflict {
  instructionA: { id: string; text: string; skillId: string };
  instructionB: { id: string; text: string; skillId: string };
  conflictType: "negation" | "opposite" | "semantic";
  similarity: number;
}

/**
 * Extract behavioral rules from observations to create emergent skills.
 * Post-observer pass: looks for patterns like "To accomplish X, do Y then Z."
 */
export async function extractSkillsFromObservations(
  observations: Array<{ content: string }>,
  apiKey: string,
  _embeddingModel?: string,
): Promise<ExtractedSkill[]> {
  if (observations.length === 0) {
    return [];
  }

  // Combine observations into context window
  const context = observations.map((obs) => obs.content).join("\n");

  const prompt = `Extract behavioral rules from these observations.
Each rule is a pattern the agent discovered: "To accomplish X, do Y then Z."

Observations:
${context}

Rules should:
- Be actionable patterns the agent demonstrated working
- Be specific enough to repeat (names, APIs, specific conditions)
- Not be general knowledge (everyone knows "test before deploy")
- Be things the user might want to remember and reuse

Return only JSON (no markdown, no code fences):
{
  "rules": [
    {
      "name": "Skill name",
      "description": "One-line summary",
      "body": "Full procedural description with steps"
    }
  ]
}

Return empty array if no rules found.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
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

    // Parse JSON
    const result = JSON.parse(content) as { rules: ExtractedSkill[] };

    if (!Array.isArray(result.rules)) {
      throw new Error("Invalid extraction result structure");
    }

    // Add confidence scores (would be higher if extracted from longer context)
    return result.rules.map((rule) => ({
      ...rule,
      confidence: Math.min(0.95, 0.5 + observations.length * 0.05), // Rough heuristic
    }));
  } catch (err) {
    agentLog.warning`Failed to extract skills from observations: ${err}`;
    return [];
  }
}

/**
 * Find contradictory instructions across active skills.
 * Returns pairs where instructions contradict each other.
 */
export async function detectConflicts(
  db: Kysely<Database>,
  _apiKey?: string,
  _embeddingModel?: string,
): Promise<SkillConflict[]> {
  try {
    // Load all active instructions
    const instructions = await db
      .selectFrom("skill_instructions as si")
      .innerJoin("skills as s", "s.id", "si.skill_id")
      .where("s.status", "=", "active")
      .select(["si.id", "si.skill_id", "si.instruction"])
      .execute();

    if (instructions.length < 2) {
      return [];
    }

    const conflicts: SkillConflict[] = [];

    // Pairwise conflict detection using heuristics
    for (let i = 0; i < instructions.length; i++) {
      for (let j = i + 1; j < instructions.length; j++) {
        const a = instructions[i]!;
        const b = instructions[j]!;

        // Skip same skill
        if (a.skill_id === b.skill_id) {
          continue;
        }

        const conflict = detectPairConflict(a, b);
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    }

    return conflicts;
  } catch (err) {
    agentLog.warning`Failed to detect conflicts: ${err}`;
    return [];
  }
}

type Instruction = { id: string; skill_id: string; instruction: string };

function makeConflict(
  a: Instruction,
  b: Instruction,
  conflictType: SkillConflict["conflictType"],
  similarity: number,
): SkillConflict {
  return {
    instructionA: { id: a.id, text: a.instruction, skillId: a.skill_id },
    instructionB: { id: b.id, text: b.instruction, skillId: b.skill_id },
    conflictType,
    similarity,
  };
}

function checkNegationConflict(textA: string, textB: string): boolean {
  const alwaysMatch = textA.match(/always\s+(\w+(?:\s+\w+)*)/);
  const neverMatch = textB.match(/never\s+(\w+(?:\s+\w+)*)/);
  if (!alwaysMatch || !neverMatch) return false;
  const alwaysTerm = alwaysMatch[1]!.trim();
  const neverTerm = neverMatch[1]!.trim();
  return (
    alwaysTerm === neverTerm || alwaysTerm.includes(neverTerm) || neverTerm.includes(alwaysTerm)
  );
}

const OPPOSITE_SETTINGS = ["recursive", "cache", "compress", "validate", "verify"];

function checkOppositeSettings(textA: string, textB: string): boolean {
  for (const setting of OPPOSITE_SETTINGS) {
    if (
      (textA.includes(`${setting}=true`) && textB.includes(`${setting}=false`)) ||
      (textA.includes(`${setting}=false`) && textB.includes(`${setting}=true`)) ||
      (textA.includes(`always ${setting}`) && textB.includes(`never ${setting}`))
    ) {
      return true;
    }
  }
  return false;
}

const OPPOSITE_VERB_PAIRS = [
  ["enable", "disable"],
  ["require", "allow"],
  ["use", "skip"],
  ["always", "never"],
];

function checkSemanticOpposition(textA: string, textB: string): boolean {
  const verbsA = textA.match(/\b(use|skip|set|enable|disable|require|allow)\b/g) || [];
  const verbsB = textB.match(/\b(use|skip|set|enable|disable|require|allow)\b/g) || [];

  for (const [v1, v2] of OPPOSITE_VERB_PAIRS) {
    const opposed =
      (verbsA.some((v) => v === v1) && verbsB.some((v) => v === v2)) ||
      (verbsA.some((v) => v === v2) && verbsB.some((v) => v === v1));
    if (!opposed) continue;

    const nounWordsA = textA.split(/\s+/).filter((w) => w.length > 4);
    const nounWordsB = new Set(textB.split(/\s+/).filter((w) => w.length > 4));
    const overlap = nounWordsA.filter((w) => nounWordsB.has(w));
    if (overlap.length >= 2) return true;
  }
  return false;
}

/**
 * Check if two instructions contradict each other.
 * Uses heuristics: negation patterns, opposites, semantic opposition.
 */
function detectPairConflict(a: Instruction, b: Instruction): SkillConflict | null {
  const textA = a.instruction.toLowerCase();
  const textB = b.instruction.toLowerCase();

  if (checkNegationConflict(textA, textB)) return makeConflict(a, b, "negation", 0.95);
  if (checkOppositeSettings(textA, textB)) return makeConflict(a, b, "opposite", 0.9);
  if (checkSemanticOpposition(textA, textB)) return makeConflict(a, b, "semantic", 0.75);

  return null;
}

/**
 * Check if a new skill's instructions conflict with existing ones.
 * Called before creating a skill to warn about contradictions.
 */
export async function checkNewSkillForConflicts(
  db: Kysely<Database>,
  newInstructions: string[],
): Promise<SkillConflict[]> {
  try {
    const existing = await db
      .selectFrom("skill_instructions as si")
      .innerJoin("skills as s", "s.id", "si.skill_id")
      .where("s.status", "=", "active")
      .select(["si.id", "si.skill_id", "si.instruction"])
      .execute();

    const conflicts: SkillConflict[] = [];

    for (const newInstr of newInstructions) {
      for (const existingInstr of existing) {
        const conflict = detectPairConflict(
          { id: "new", skill_id: "new", instruction: newInstr },
          existingInstr,
        );

        if (conflict) {
          // Replace the new ID with actual existing ID
          conflicts.push({
            ...conflict,
            instructionA: { ...conflict.instructionA, id: existingInstr.id },
          });
        }
      }
    }

    return conflicts;
  } catch (err) {
    agentLog.warning`Failed to check new skill for conflicts: ${err}`;
    return [];
  }
}
