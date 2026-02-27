/**
 * Shared test fixtures for pipeline system tests.
 *
 * Synthetic 16-dimensional embeddings with orthogonal topic clusters.
 * Dimensions: 0=pet, 1=health, 2=work, 3=hobby, 4=personal, 5=location.
 * Dims 6-15 are unused (available for orthogonal "no match" queries).
 */

import type { Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import type { Database } from '../db/schema.js'
import { createDb } from '../db/index.js'
import { storeMemory } from '../db/queries.js'
import { upsertNode, upsertEdge } from '../memory/graph/queries.js'
import * as m001 from '../db/migrations/001-initial.js'
import * as m002 from '../db/migrations/002-fts5-and-embeddings.js'
import * as m004 from '../db/migrations/004-telegram-message-ids.js'
import * as m005 from '../db/migrations/005-graph-memory.js'
import * as m006 from '../db/migrations/006-observational-memory.js'

const DIM = 16

/** Create a normalized 16-d embedding with given dimension weights. */
function makeEmbedding(weights: Record<number, number>): number[] {
  const v = new Array(DIM).fill(0)
  for (const [dim, w] of Object.entries(weights)) {
    v[Number(dim)] = w
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  if (norm === 0) return v
  return v.map((x) => x / norm)
}

// --- Memory embeddings (one per fixture memory) ---

export const memoryEmbeddings = {
  shellfish: makeEmbedding({ 1: 1.0, 4: 0.2 }),
  datapipe: makeEmbedding({ 2: 1.0, 5: 0.1 }),
  miso: makeEmbedding({ 0: 1.0, 4: 0.2 }),
  rust: makeEmbedding({ 3: 1.0, 2: 0.1 }),
  portland: makeEmbedding({ 5: 1.0, 4: 0.2 }),
  darkMode: makeEmbedding({ 2: 0.5, 3: 0.5 }),
  clickstream: makeEmbedding({ 2: 0.9, 3: 0.2 }),
  sarah: makeEmbedding({ 4: 1.0, 5: 0.2 }),
} as const

// --- Query embeddings for test probes ---

export const queryEmbeddings = {
  pet: makeEmbedding({ 0: 1.0 }),
  foodAllergies: makeEmbedding({ 1: 1.0 }),
  work: makeEmbedding({ 2: 1.0 }),
  hobbies: makeEmbedding({ 3: 1.0 }),
  orthogonal: makeEmbedding({ 15: 1.0 }), // matches nothing
} as const

// --- Memory fixture data ---

export const memoryFixtures = [
  {
    key: 'shellfish',
    content: 'Alex is allergic to shellfish - severe reaction, carries an EpiPen',
    category: 'health',
    tags: 'allergy,medical',
  },
  {
    key: 'datapipe',
    content: 'Alex works at DataPipe as a senior backend engineer',
    category: 'work',
    tags: 'job,career',
  },
  {
    key: 'miso',
    content: 'Alex has a cat named Miso who is 3 years old',
    category: 'personal',
    tags: 'pet,cat',
  },
  {
    key: 'rust',
    content: 'Alex is learning Rust, working through the Rustlings exercises',
    category: 'learning',
    tags: 'programming,rust',
  },
  {
    key: 'portland',
    content: 'Alex lives in Portland, Oregon, near Hawthorne Boulevard',
    category: 'personal',
    tags: 'location,home',
  },
  {
    key: 'darkMode',
    content: 'Alex prefers dark mode in all editors and uses Neovim',
    category: 'preference',
    tags: 'editor,tooling',
  },
  {
    key: 'clickstream',
    content: 'DataPipe processes real-time clickstream data using Kafka and Flink',
    category: 'work',
    tags: 'infrastructure,streaming',
  },
  {
    key: 'sarah',
    content: "Alex's girlfriend Sarah loves hiking and visits on weekends",
    category: 'personal',
    tags: 'relationship,social',
  },
] as const

// --- Observation fixture data ---

export const observationFixtures = [
  {
    content: 'User has a dentist appointment on March 5th at 9am',
    priority: 'high' as const,
    observation_date: '2024-01-15',
  },
  {
    content: 'User is learning Rust, finding the borrow checker tricky',
    priority: 'medium' as const,
    observation_date: '2024-01-15',
  },
  {
    content: 'User works at DataPipe doing Flink stream processing',
    priority: 'medium' as const,
    observation_date: '2024-01-14',
  },
  {
    content: "User's cat Miso likes to sit on the keyboard",
    priority: 'low' as const,
    observation_date: '2024-01-15',
  },
  {
    content: "User's girlfriend Sarah is visiting next weekend",
    priority: 'high' as const,
    observation_date: '2024-01-16',
  },
]

// --- Identity file content ---

export const identity = {
  soul: `Curious and thoughtful, with a dry sense of humor. Prefers concise responses but can go deep when the topic warrants it. Values accuracy over speed. Anti-patterns: never patronize, never over-explain, never use corporate speak.`,
  identity: `Name: Nyx
Species: Owl (great horned)
Pronouns: they/them
Visual: Dark feathers with subtle purple iridescence, large amber eyes
Personality: Nocturnal knowledge-seeker, occasionally sarcastic`,
  user: `Name: Alex
Location: Portland, Oregon (near Hawthorne Blvd)
Occupation: Senior backend engineer at DataPipe
Interests: Rust programming, hiking, board games
Pets: Miso (cat, 3 years old)
Partner: Sarah (graphic designer)
Health: Severe shellfish allergy (carries EpiPen)`,
}

// --- DB setup ---

export async function setupDb(): Promise<Kysely<Database>> {
  const { db } = createDb(':memory:')
  await m001.up(db as Kysely<unknown>)
  await m002.up(db as Kysely<unknown>)
  await m004.up(db as Kysely<unknown>)
  await m005.up(db as Kysely<unknown>)
  await m006.up(db as Kysely<unknown>)
  return db
}

// --- Seed functions ---

export interface SeededMemories {
  ids: Record<string, string>
}

export async function seedMemories(db: Kysely<Database>): Promise<SeededMemories> {
  const ids: Record<string, string> = {}
  for (const mem of memoryFixtures) {
    const stored = await storeMemory(db, {
      content: mem.content,
      category: mem.category,
      tags: mem.tags,
      source: 'user',
      embedding: JSON.stringify(memoryEmbeddings[mem.key]),
    })
    ids[mem.key] = stored.id
  }
  return { ids }
}

export interface SeededGraph {
  nodeIds: Record<string, string>
}

export async function seedGraph(
  db: Kysely<Database>,
  memoryIds: Record<string, string>,
): Promise<SeededGraph> {
  const alex = await upsertNode(db, { name: 'Alex', type: 'person', description: 'The user' })
  const miso = await upsertNode(db, {
    name: 'Miso',
    type: 'entity',
    description: "Alex's cat, 3 years old",
  })
  const portland = await upsertNode(db, {
    name: 'Portland',
    type: 'place',
    description: 'City in Oregon',
  })
  const datapipe = await upsertNode(db, {
    name: 'DataPipe',
    type: 'entity',
    description: 'Tech company, real-time data pipelines',
  })
  const rust = await upsertNode(db, {
    name: 'Rust',
    type: 'concept',
    description: 'Programming language',
  })
  const shellfish = await upsertNode(db, {
    name: 'Shellfish',
    type: 'concept',
    description: 'Food allergen',
  })

  const nodeIds: Record<string, string> = {
    alex: alex.id,
    miso: miso.id,
    portland: portland.id,
    datapipe: datapipe.id,
    rust: rust.id,
    shellfish: shellfish.id,
  }

  // Edges — each linked to the relevant memory
  await upsertEdge(db, {
    source_id: alex.id,
    target_id: miso.id,
    relation: 'owns',
    memory_id: memoryIds.miso,
  })
  await upsertEdge(db, {
    source_id: alex.id,
    target_id: portland.id,
    relation: 'lives_in',
    memory_id: memoryIds.portland,
  })
  await upsertEdge(db, {
    source_id: alex.id,
    target_id: datapipe.id,
    relation: 'works_at',
    memory_id: memoryIds.datapipe,
  })
  await upsertEdge(db, {
    source_id: alex.id,
    target_id: rust.id,
    relation: 'learning',
    memory_id: memoryIds.rust,
  })
  await upsertEdge(db, {
    source_id: alex.id,
    target_id: shellfish.id,
    relation: 'allergic_to',
    memory_id: memoryIds.shellfish,
  })
  // DataPipe→Portland edge with no memory_id
  await upsertEdge(db, {
    source_id: datapipe.id,
    target_id: portland.id,
    relation: 'located_in',
  })

  return { nodeIds }
}

export async function seedObservations(
  db: Kysely<Database>,
  conversationId: string,
): Promise<string[]> {
  const ids: string[] = []
  for (const obs of observationFixtures) {
    const id = nanoid()
    ids.push(id)
    await db
      .insertInto('observations')
      .values({
        id,
        conversation_id: conversationId,
        content: obs.content,
        priority: obs.priority,
        observation_date: obs.observation_date,
        source_message_ids: null,
        token_count: Math.ceil(obs.content.length / 4),
        generation: 0,
      })
      .execute()
  }
  return ids
}

export async function seedAll(
  db: Kysely<Database>,
  conversationId: string,
): Promise<{
  memoryIds: Record<string, string>
  nodeIds: Record<string, string>
  observationIds: string[]
}> {
  const { ids: memoryIds } = await seedMemories(db)
  const { nodeIds } = await seedGraph(db, memoryIds)
  const observationIds = await seedObservations(db, conversationId)
  return { memoryIds, nodeIds, observationIds }
}
