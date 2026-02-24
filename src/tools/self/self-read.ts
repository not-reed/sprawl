import { Type, type Static } from '@sinclair/typebox'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const SelfReadParams = Type.Object({
  path: Type.String({
    description:
      'File path relative to project root (e.g. "src/tools/memory-store.ts") or extensions directory (e.g. "extensions/skills/standup.md"). Can also list a directory.',
  }),
})

type SelfReadInput = Static<typeof SelfReadParams>

export function createSelfReadTool(projectRoot: string, extensionsDir?: string) {
  return {
    name: 'self_read_source',
    description:
      'Read your own source files or extension files. Path must be within src/, cli/, or extensions/ (skills, tools, SOUL.md).',
    parameters: SelfReadParams,
    execute: async (_toolCallId: string, args: SelfReadInput) => {
      // Resolve extensions/ prefix against extensionsDir
      let resolved: string
      let displayPath: string

      if (args.path.startsWith('extensions/') && extensionsDir) {
        const extRelative = args.path.slice('extensions/'.length)
        resolved = resolve(extensionsDir, extRelative)
        displayPath = args.path
      } else {
        resolved = resolve(projectRoot, args.path)
        const rel = relative(projectRoot, resolved)
        displayPath = rel

        // Scope check: only allow src/, cli/, package.json, tsconfig.json, CLAUDE.md
        const allowed =
          rel.startsWith('src/') ||
          rel.startsWith('cli/') ||
          rel === 'package.json' ||
          rel === 'tsconfig.json' ||
          rel === 'CLAUDE.md' ||
          rel === 'PLAN.md'

        if (!allowed || rel.startsWith('..')) {
          return {
            output: `Access denied: "${args.path}" is outside the allowed scope (src/, cli/, extensions/, config files).`,
            details: { error: 'scope_violation' },
          }
        }
      }

      try {
        const info = await stat(resolved)

        if (info.isDirectory()) {
          const entries = await readdir(resolved, { withFileTypes: true })
          const listing = entries
            .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
            .join('\n')
          return {
            output: `Directory listing for ${displayPath}/:\n${listing}`,
            details: { type: 'directory', entries: entries.map((e) => e.name) },
          }
        }

        const content = await readFile(resolved, 'utf-8')
        const lines = content.split('\n')

        return {
          output: `${displayPath} (${lines.length} lines):\n${content}`,
          details: { type: 'file', path: displayPath, lines: lines.length },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          output: `Error reading "${args.path}": ${msg}`,
          details: { error: msg },
        }
      }
    },
  }
}
