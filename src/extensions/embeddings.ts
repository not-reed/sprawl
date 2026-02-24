import { generateEmbedding, cosineSimilarity } from '../embeddings.js'
import { agentLog } from '../logger.js'
import type { Skill } from './types.js'
import type { ToolPack } from '../tools/packs.js'

/** Skill embedding cache: skill name → embedding vector */
const skillEmbeddings = new Map<string, number[]>()

/** Dynamic pack embedding cache: pack name → embedding vector */
const dynamicPackEmbeddings = new Map<string, number[]>()

/** Compute embeddings for all skills. Non-fatal on failure. */
export async function initSkillEmbeddings(
  apiKey: string,
  skills: Skill[],
): Promise<void> {
  skillEmbeddings.clear()

  if (skills.length === 0) return

  const results = await Promise.allSettled(
    skills.map(async (skill) => {
      const text = `${skill.name}: ${skill.description}`
      const embedding = await generateEmbedding(apiKey, text)
      skillEmbeddings.set(skill.name, embedding)
    }),
  )

  let failed = 0
  for (const r of results) {
    if (r.status === 'rejected') failed++
  }

  agentLog.info`Skill embeddings: ${skillEmbeddings.size}/${skills.length} cached${failed > 0 ? `, ${failed} failed` : ''}`
}

/** Compute embeddings for dynamic tool packs. Non-fatal on failure. */
export async function initDynamicPackEmbeddings(
  apiKey: string,
  packs: ToolPack[],
): Promise<void> {
  dynamicPackEmbeddings.clear()

  const toEmbed = packs.filter((p) => !p.alwaysLoad)
  if (toEmbed.length === 0) return

  const results = await Promise.allSettled(
    toEmbed.map(async (pack) => {
      const embedding = await generateEmbedding(apiKey, pack.description)
      dynamicPackEmbeddings.set(pack.name, embedding)
    }),
  )

  let failed = 0
  for (const r of results) {
    if (r.status === 'rejected') failed++
  }

  agentLog.info`Dynamic pack embeddings: ${dynamicPackEmbeddings.size}/${toEmbed.length} cached${failed > 0 ? `, ${failed} failed` : ''}`
}

/**
 * Select skills relevant to the query based on embedding similarity.
 * Returns skills sorted by relevance.
 */
export function selectSkills(
  queryEmbedding: number[] | undefined,
  skills: Skill[],
  threshold = 0.35,
  maxSkills = 3,
): Skill[] {
  if (skills.length === 0) return []

  // No query embedding → return nothing (skills are optional context)
  if (!queryEmbedding) return []

  const scored = skills
    .map((skill) => {
      const emb = skillEmbeddings.get(skill.name)
      if (!emb) return { skill, score: 0 }
      return { skill, score: cosineSimilarity(queryEmbedding, emb) }
    })
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSkills)

  return scored.map((s) => s.skill)
}

/**
 * Select dynamic tool packs relevant to the query.
 * Returns packs that meet the similarity threshold.
 */
export function selectDynamicPacks(
  queryEmbedding: number[] | undefined,
  packs: ToolPack[],
  threshold = 0.3,
): ToolPack[] {
  // No query embedding → load all dynamic packs (graceful fallback)
  if (!queryEmbedding) return packs

  return packs.filter((pack) => {
    if (pack.alwaysLoad) return true

    const emb = dynamicPackEmbeddings.get(pack.name)
    // No embedding → load it (graceful fallback)
    if (!emb) return true

    return cosineSimilarity(queryEmbedding, emb) >= threshold
  })
}

/** Clear all extension embedding caches. Called on reload. */
export function clearExtensionEmbeddings(): void {
  skillEmbeddings.clear()
  dynamicPackEmbeddings.clear()
}
