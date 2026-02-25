import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import type { ExtensionRegistry, Skill } from './types.js'
import type { ToolContext, InternalTool } from '../tools/packs.js'
import type { TSchema } from '@sinclair/typebox'
import { loadIdentityFiles, loadSkills, loadDynamicTools } from './loader.js'
import { buildSecretsMap } from './secrets.js'
import {
  initSkillEmbeddings,
  initDynamicPackEmbeddings,
  selectSkills as selectSkillsByEmbedding,
  selectDynamicPacks as selectDynamicPacksByEmbedding,
  clearExtensionEmbeddings,
} from './embeddings.js'
import { agentLog } from '../logger.js'

// Singleton registry
let registry: ExtensionRegistry = {
  identity: { soul: null, identity: null, user: null },
  skills: [],
  dynamicPacks: [],
}

let extensionsDir: string = ''
let apiKey: string = ''
let dbRef: Kysely<Database> | null = null
let reloadLock: Promise<ExtensionRegistry> | null = null

/** Ensure extensions directory and subdirectories exist. */
async function ensureDirs(dir: string): Promise<void> {
  await mkdir(join(dir, 'skills'), { recursive: true })
  await mkdir(join(dir, 'tools'), { recursive: true })
}

/**
 * Initialize the extensions system. Called once at startup.
 */
export async function initExtensions(
  dir: string,
  key: string,
  db: Kysely<Database>,
): Promise<ExtensionRegistry> {
  extensionsDir = dir
  apiKey = key
  dbRef = db

  await ensureDirs(dir)

  return reloadExtensions()
}

/**
 * Reload all extensions from disk. Called on startup and by extension_reload tool.
 * Returns the updated registry. Serialized via lock to prevent concurrent reloads.
 */
export async function reloadExtensions(): Promise<ExtensionRegistry> {
  if (reloadLock) {
    agentLog.info`Reload already in progress, waiting…`
    return reloadLock
  }

  reloadLock = doReload()
  try {
    return await reloadLock
  } finally {
    reloadLock = null
  }
}

async function doReload(): Promise<ExtensionRegistry> {
  if (!extensionsDir || !dbRef) {
    throw new Error('Extensions not initialized — call initExtensions() first')
  }

  agentLog.info`Reloading extensions from ${extensionsDir}`

  // Clear embedding caches
  clearExtensionEmbeddings()

  // Load identity files (SOUL.md, IDENTITY.md, USER.md)
  const identity = await loadIdentityFiles(extensionsDir)

  // Load skills
  const skills = await loadSkills(extensionsDir)
  agentLog.info`Loaded ${skills.length} skill(s)`

  // Build secrets map for dynamic tool context
  const secretsMap = await buildSecretsMap(dbRef!)
  const availableSecrets = new Set(secretsMap.keys())

  // Load dynamic tools
  const dynamicPacks = await loadDynamicTools(
    extensionsDir,
    { secrets: secretsMap },
    availableSecrets,
  )
  agentLog.info`Loaded ${dynamicPacks.length} dynamic pack(s)`

  // Update registry
  registry = { identity, skills, dynamicPacks }

  // Compute embeddings (non-blocking failures)
  await Promise.all([
    initSkillEmbeddings(apiKey, skills),
    initDynamicPackEmbeddings(apiKey, dynamicPacks),
  ])

  return registry
}

/** Get the current extension registry. */
export function getExtensionRegistry(): ExtensionRegistry {
  return registry
}

/** Select skills relevant to a query using embedding similarity. */
export function selectSkills(queryEmbedding: number[] | undefined): Skill[] {
  return selectSkillsByEmbedding(queryEmbedding, registry.skills)
}

/**
 * Select dynamic tool packs and instantiate tools for a query.
 * Merges dynamic packs that pass the embedding threshold.
 */
export function selectAndCreateDynamicTools(
  queryEmbedding: number[] | undefined,
  ctx: ToolContext,
): InternalTool<TSchema>[] {
  const selected = selectDynamicPacksByEmbedding(queryEmbedding, registry.dynamicPacks)

  if (selected.length > 0) {
    agentLog.info`Selected dynamic packs: ${selected.map((p) => p.name).join(', ')}`
  }

  const tools: InternalTool<TSchema>[] = []
  for (const pack of selected) {
    for (const factory of pack.factories) {
      const tool = factory(ctx)
      if (tool) tools.push(tool)
    }
  }
  return tools
}
