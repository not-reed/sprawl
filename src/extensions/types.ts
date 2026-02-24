import type { TSchema } from '@sinclair/typebox'
import type { InternalTool, ToolPack } from '../tools/packs.js'

/** Requirements that an extension declares in its frontmatter / meta */
export interface ExtensionRequirements {
  env?: string[]
  bins?: string[]
  secrets?: string[]
}

/** Parsed skill from a markdown file with YAML frontmatter */
export interface Skill {
  name: string
  description: string
  requires: ExtensionRequirements
  body: string
  filePath: string
}

/** What a dynamic tool .ts file exports */
export interface DynamicToolExport {
  meta?: {
    requires?: ExtensionRequirements
  }
  /** Factory function (receives context) or plain tool object */
  default: ((ctx: DynamicToolContext) => InternalTool<TSchema>) | InternalTool<TSchema>
}

/** Context passed to dynamic tool factory functions */
export interface DynamicToolContext {
  secrets: Map<string, string>
}

/** Identity files loaded from the extensions directory */
export interface IdentityFiles {
  soul: string | null
  identity: string | null
  user: string | null
}

/** The full loaded extension registry */
export interface ExtensionRegistry {
  identity: IdentityFiles
  skills: Skill[]
  dynamicPacks: ToolPack[]
}
