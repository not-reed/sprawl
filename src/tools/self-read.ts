import { Type, type Static } from '@sinclair/typebox'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const SelfReadParams = Type.Object({
  path: Type.String({
    description:
      'File path relative to project root (e.g. "src/tools/memory-store.ts"). Can also list a directory.',
  }),
})

type SelfReadInput = Static<typeof SelfReadParams>

export function createSelfReadTool(projectRoot: string) {
  return {
    name: 'self_read_source',
    description:
      'Read your own source files. Use this to understand your code when diagnosing bugs or planning changes. Path must be within the project src/ or cli/ directory.',
    parameters: SelfReadParams,
    execute: async (_toolCallId: string, args: SelfReadInput) => {
      const resolved = resolve(projectRoot, args.path)
      const rel = relative(projectRoot, resolved)

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
          output: `Access denied: "${args.path}" is outside the allowed scope (src/, cli/, config files).`,
          details: { error: 'scope_violation' },
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
            output: `Directory listing for ${rel}/:\n${listing}`,
            details: { type: 'directory', entries: entries.map((e) => e.name) },
          }
        }

        const content = await readFile(resolved, 'utf-8')
        const lines = content.split('\n')

        return {
          output: `${rel} (${lines.length} lines):\n${content}`,
          details: { type: 'file', path: rel, lines: lines.length },
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
