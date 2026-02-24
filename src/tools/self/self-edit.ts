import { Type, type Static } from '@sinclair/typebox'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'

const SelfEditParams = Type.Object({
  path: Type.String({
    description:
      'File path relative to project root (e.g. "src/tools/memory-store.ts") or extensions directory (e.g. "extensions/skills/standup.md")',
  }),
  search: Type.String({
    description:
      'Exact string to find in the file (must be unique). Use empty string to create a new file.',
  }),
  replace: Type.String({
    description: 'String to replace the search match with, or full content for new files',
  }),
})

type SelfEditInput = Static<typeof SelfEditParams>

export function createSelfEditTool(projectRoot: string, extensionsDir?: string) {
  return {
    name: 'self_edit_source',
    description:
      'Edit your own source files or extension files using search-and-replace. Use empty search string with a path that doesn\'t exist to create a new file. Allowed scopes: src/, cli/, extensions/.',
    parameters: SelfEditParams,
    execute: async (_toolCallId: string, args: SelfEditInput) => {
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

        // Scope check: only allow src/ and cli/
        if ((!rel.startsWith('src/') && !rel.startsWith('cli/')) || rel.startsWith('..')) {
          return {
            output: `Access denied: "${args.path}" is outside the allowed scope (src/, cli/, extensions/).`,
            details: { error: 'scope_violation' },
          }
        }
      }

      try {
        // File creation: empty search + file doesn't exist
        if (args.search === '') {
          let fileExists = true
          try {
            await readFile(resolved, 'utf-8')
          } catch {
            fileExists = false
          }

          if (!fileExists) {
            // Create the file (and parent dirs)
            await mkdir(dirname(resolved), { recursive: true })
            await writeFile(resolved, args.replace, 'utf-8')
            return {
              output: `Created ${displayPath}`,
              details: { path: displayPath, created: true },
            }
          }

          // File exists but search is empty — this is ambiguous
          return {
            output: `File ${displayPath} already exists. Provide a non-empty search string to edit it, or use a new path to create a file.`,
            details: { error: 'file_exists' },
          }
        }

        const content = await readFile(resolved, 'utf-8')

        const occurrences = content.split(args.search).length - 1
        if (occurrences === 0) {
          return {
            output: `Search string not found in ${displayPath}. Make sure you're using the exact text from the file.`,
            details: { error: 'not_found' },
          }
        }
        if (occurrences > 1) {
          return {
            output: `Search string found ${occurrences} times in ${displayPath}. It must be unique — provide more surrounding context to disambiguate.`,
            details: { error: 'ambiguous', occurrences },
          }
        }

        const newContent = content.replace(args.search, args.replace)
        await writeFile(resolved, newContent, 'utf-8')

        return {
          output: `Edited ${displayPath}: replaced 1 occurrence.`,
          details: { path: displayPath, replaced: true },
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
