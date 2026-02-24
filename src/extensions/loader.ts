import { readFile, readdir, access, symlink, lstat } from 'node:fs/promises'
import { join, basename, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { TSchema } from '@sinclair/typebox'
import type { Skill, ExtensionRequirements, DynamicToolContext, DynamicToolExport } from './types.js'
import type { InternalTool, ToolPack } from '../tools/packs.js'
import { toolLog } from '../logger.js'

/**
 * Parse a skill markdown file with YAML frontmatter.
 * Returns null if the file is invalid.
 */
export function parseSkillFile(content: string, filePath: string): Skill | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!fmMatch) {
    toolLog.warning`Skill file has no frontmatter: ${filePath}`
    return null
  }

  try {
    const frontmatter = parseYaml(fmMatch[1]) as {
      name?: string
      description?: string
      requires?: ExtensionRequirements
    }

    if (!frontmatter.name || !frontmatter.description) {
      toolLog.warning`Skill missing name or description: ${filePath}`
      return null
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      requires: frontmatter.requires ?? {},
      body: fmMatch[2].trim(),
      filePath,
    }
  } catch (err) {
    toolLog.warning`Failed to parse skill frontmatter in ${filePath}: ${err}`
    return null
  }
}

/**
 * Check whether an extension's requirements are met.
 * Returns list of unmet requirement descriptions.
 */
export function checkRequirements(
  requires: ExtensionRequirements,
  availableSecrets: Set<string>,
): string[] {
  const unmet: string[] = []

  if (requires.env) {
    for (const key of requires.env) {
      if (!process.env[key]) {
        unmet.push(`env: ${key}`)
      }
    }
  }

  if (requires.secrets) {
    for (const key of requires.secrets) {
      if (!availableSecrets.has(key)) {
        unmet.push(`secret: ${key}`)
      }
    }
  }

  // bins check is deferred — would need which() or similar
  // For now we just log a note
  if (requires.bins && requires.bins.length > 0) {
    // We don't block on bins, just note it
    toolLog.debug`Extension requires binaries: ${requires.bins.join(', ')}`
  }

  return unmet
}

/** Load a single markdown file from the extensions directory. Returns null if not found or empty. */
async function loadMarkdownFile(extensionsDir: string, filename: string): Promise<string | null> {
  try {
    const filePath = join(extensionsDir, filename)
    const content = await readFile(filePath, 'utf-8')
    return content.trim() || null
  } catch {
    return null
  }
}

/** Load SOUL.md from the extensions directory. Returns null if not found. */
export async function loadSoul(extensionsDir: string): Promise<string | null> {
  return loadMarkdownFile(extensionsDir, 'SOUL.md')
}

/** Load all identity files (SOUL.md, IDENTITY.md, USER.md) from the extensions directory. */
export async function loadIdentityFiles(extensionsDir: string): Promise<{
  soul: string | null
  identity: string | null
  user: string | null
}> {
  const [soul, identity, user] = await Promise.all([
    loadMarkdownFile(extensionsDir, 'SOUL.md'),
    loadMarkdownFile(extensionsDir, 'IDENTITY.md'),
    loadMarkdownFile(extensionsDir, 'USER.md'),
  ])
  return { soul, identity, user }
}

/** Recursively discover and parse all skill .md files under skills/. */
export async function loadSkills(extensionsDir: string): Promise<Skill[]> {
  const skillsDir = join(extensionsDir, 'skills')
  const skills: Skill[] = []

  try {
    await access(skillsDir)
  } catch {
    return skills
  }

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        try {
          const content = await readFile(fullPath, 'utf-8')
          const skill = parseSkillFile(content, fullPath)
          if (skill) {
            skills.push(skill)
          }
        } catch (err) {
          toolLog.warning`Failed to read skill file ${fullPath}: ${err}`
        }
      }
    }
  }

  await walk(skillsDir)
  return skills
}

/**
 * Ensure that node_modules from the project root is accessible from the
 * extensions directory via symlink. This allows dynamic tool .ts files
 * to import project dependencies like @sinclair/typebox.
 */
async function ensureNodeModulesLink(extensionsDir: string): Promise<void> {
  const linkPath = join(extensionsDir, 'node_modules')

  // Already exists (real dir or symlink) — skip
  try {
    await lstat(linkPath)
    return
  } catch {
    // Doesn't exist — create it
  }

  // Walk up from the project source to find node_modules
  const thisFile = fileURLToPath(import.meta.url)
  let dir = dirname(thisFile)
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'node_modules')
    try {
      await access(candidate)
      await symlink(candidate, linkPath)
      toolLog.debug`Symlinked node_modules from ${candidate} to ${linkPath}`
      return
    } catch {
      dir = dirname(dir)
    }
  }
}

/**
 * Load dynamic tool .ts files from the tools/ directory within extensions.
 * - Root-level .ts files → standalone packs (single tool)
 * - Subdirectories → grouped into packs (dir name = pack name)
 */
export async function loadDynamicTools(
  extensionsDir: string,
  toolCtx: DynamicToolContext,
  availableSecrets: Set<string>,
): Promise<ToolPack[]> {
  const toolsDir = join(extensionsDir, 'tools')
  const packs: ToolPack[] = []

  try {
    await access(toolsDir)
  } catch {
    return packs
  }

  // Ensure tool files can resolve project dependencies
  await ensureNodeModulesLink(extensionsDir)

  const entries = await readdir(toolsDir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(toolsDir, entry.name)

    if (entry.isFile() && extname(entry.name) === '.ts') {
      // Standalone tool file → single-tool pack
      const tool = await loadSingleToolFile(fullPath, toolCtx, availableSecrets)
      if (tool) {
        const packName = `ext:${basename(entry.name, '.ts')}`
        packs.push({
          name: packName,
          description: tool.description,
          alwaysLoad: false,
          factories: [() => tool],
        })
      }
    } else if (entry.isDirectory()) {
      // Directory → grouped pack
      const pack = await directoryToPack(fullPath, entry.name, toolCtx, availableSecrets)
      if (pack) {
        packs.push(pack)
      }
    }
  }

  return packs
}

/** Load a single .ts tool file using jiti. Returns null if invalid or requirements unmet. */
export async function loadSingleToolFile(
  filePath: string,
  toolCtx: DynamicToolContext,
  availableSecrets: Set<string>,
): Promise<InternalTool<TSchema> | null> {
  try {
    const { createJiti } = await import('jiti')
    const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false })

    const mod = (await jiti.import(filePath)) as DynamicToolExport

    // Check requirements
    if (mod.meta?.requires) {
      const unmet = checkRequirements(mod.meta.requires, availableSecrets)
      if (unmet.length > 0) {
        toolLog.info`Skipping tool ${filePath}: unmet requirements: ${unmet.join(', ')}`
        return null
      }
    }

    // Resolve tool: factory function or plain object
    const exported = mod.default
    let tool: InternalTool<TSchema>

    if (typeof exported === 'function') {
      tool = exported(toolCtx) as InternalTool<TSchema>
    } else {
      tool = exported as InternalTool<TSchema>
    }

    // Validate tool shape
    if (!tool?.name || !tool?.description || !tool?.parameters || !tool?.execute) {
      toolLog.warning`Invalid tool export in ${filePath}: missing name/description/parameters/execute`
      return null
    }

    return tool
  } catch (err) {
    toolLog.warning`Failed to load dynamic tool ${filePath}: ${err}`
    return null
  }
}

/** Convert a directory of .ts files into a ToolPack. */
async function directoryToPack(
  dirPath: string,
  dirName: string,
  toolCtx: DynamicToolContext,
  availableSecrets: Set<string>,
): Promise<ToolPack | null> {
  const packName = `ext:${dirName}`
  const tools: InternalTool<TSchema>[] = []

  // Check for pack.md description override
  let description = ''
  try {
    const packMd = await readFile(join(dirPath, 'pack.md'), 'utf-8')
    description = packMd.trim()
  } catch {
    // No pack.md — auto-generate from tool descriptions below
  }

  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name) === '.ts') {
      const tool = await loadSingleToolFile(
        join(dirPath, entry.name),
        toolCtx,
        availableSecrets,
      )
      if (tool) tools.push(tool)
    }
  }

  if (tools.length === 0) return null

  // Auto-generate description from tool descriptions if no pack.md
  if (!description) {
    description = tools.map((t) => t.description).join('. ')
  }

  return {
    name: packName,
    description,
    alwaysLoad: false,
    factories: tools.map((t) => () => t),
  }
}
