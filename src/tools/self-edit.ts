import { Type, type Static } from '@sinclair/typebox'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const SelfEditParams = Type.Object({
  path: Type.String({
    description: 'File path relative to project root (e.g. "src/tools/memory-store.ts")',
  }),
  search: Type.String({
    description: 'Exact string to find in the file (must be unique within the file)',
  }),
  replace: Type.String({
    description: 'String to replace the search match with',
  }),
})

type SelfEditInput = Static<typeof SelfEditParams>

export function createSelfEditTool(projectRoot: string) {
  return {
    name: 'self_edit_source',
    description:
      'Edit your own source files using search-and-replace. The search string must be an exact, unique match. Only files in src/ or cli/ can be edited.',
    parameters: SelfEditParams,
    execute: async (_toolCallId: string, args: SelfEditInput) => {
      const resolved = resolve(projectRoot, args.path)
      const rel = relative(projectRoot, resolved)

      // Scope check: only allow src/ and cli/
      if ((!rel.startsWith('src/') && !rel.startsWith('cli/')) || rel.startsWith('..')) {
        return {
          output: `Access denied: "${args.path}" is outside the allowed scope (src/, cli/).`,
          details: { error: 'scope_violation' },
        }
      }

      try {
        const content = await readFile(resolved, 'utf-8')

        const occurrences = content.split(args.search).length - 1
        if (occurrences === 0) {
          return {
            output: `Search string not found in ${rel}. Make sure you're using the exact text from the file.`,
            details: { error: 'not_found' },
          }
        }
        if (occurrences > 1) {
          return {
            output: `Search string found ${occurrences} times in ${rel}. It must be unique — provide more surrounding context to disambiguate.`,
            details: { error: 'ambiguous', occurrences },
          }
        }

        const newContent = content.replace(args.search, args.replace)
        await writeFile(resolved, newContent, 'utf-8')

        return {
          output: `Edited ${rel}: replaced 1 occurrence.`,
          details: { path: rel, replaced: true },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          output: `Error editing "${args.path}": ${msg}`,
          details: { error: msg },
        }
      }
    },
  }
}
