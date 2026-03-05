import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createSelfReadTool } from '../self-read.js'
import { createSelfEditTool } from '../self-edit.js'

// Simulates monorepo root as projectRoot
const testRoot = resolve(import.meta.dirname, '../../../../.test-project')

function setupTestProject() {
  rmSync(testRoot, { recursive: true, force: true })
  mkdirSync(resolve(testRoot, 'apps/construct/src/tools'), { recursive: true })
  mkdirSync(resolve(testRoot, 'apps/construct/cli'), { recursive: true })
  mkdirSync(resolve(testRoot, 'packages/cairn/src'), { recursive: true })
  writeFileSync(
    resolve(testRoot, 'apps/construct/src/tools/example.ts'),
    'export const hello = "world"\n',
  )
  writeFileSync(
    resolve(testRoot, 'packages/cairn/src/index.ts'),
    'export const cairn = true\n',
  )
  writeFileSync(resolve(testRoot, 'CLAUDE.md'), '# Test Project\n')
  writeFileSync(resolve(testRoot, 'package.json'), '{"name": "test"}\n')
  writeFileSync(resolve(testRoot, 'Justfile'), 'dev:\n\techo dev\n')
}

function cleanupTestProject() {
  rmSync(testRoot, { recursive: true, force: true })
}

describe('self_read_source', () => {
  it('reads a file within apps/', async () => {
    setupTestProject()
    try {
      const tool = createSelfReadTool(testRoot)
      const result = await tool.execute('t1', { path: 'apps/construct/src/tools/example.ts' })

      expect(result.output).toContain('hello')
      expect(result.output).toContain('world')
      expect((result.details as any).type).toBe('file')
    } finally {
      cleanupTestProject()
    }
  })

  it('reads a file within packages/', async () => {
    setupTestProject()
    try {
      const tool = createSelfReadTool(testRoot)
      const result = await tool.execute('t1', { path: 'packages/cairn/src/index.ts' })

      expect(result.output).toContain('cairn')
      expect((result.details as any).type).toBe('file')
    } finally {
      cleanupTestProject()
    }
  })

  it('lists directory contents', async () => {
    setupTestProject()
    try {
      const tool = createSelfReadTool(testRoot)
      const result = await tool.execute('t1', { path: 'apps/construct/src/tools' })

      expect(result.output).toContain('example.ts')
      expect((result.details as any).type).toBe('directory')
    } finally {
      cleanupTestProject()
    }
  })

  it('allows reading CLAUDE.md', async () => {
    setupTestProject()
    try {
      const tool = createSelfReadTool(testRoot)
      const result = await tool.execute('t1', { path: 'CLAUDE.md' })

      expect(result.output).toContain('Test Project')
    } finally {
      cleanupTestProject()
    }
  })

  it('allows reading Justfile', async () => {
    setupTestProject()
    try {
      const tool = createSelfReadTool(testRoot)
      const result = await tool.execute('t1', { path: 'Justfile' })

      expect(result.output).toContain('dev')
    } finally {
      cleanupTestProject()
    }
  })

  it('blocks reading outside allowed scope', async () => {
    setupTestProject()
    try {
      const tool = createSelfReadTool(testRoot)
      const result = await tool.execute('t1', { path: '../../../etc/passwd' })

      expect(result.output).toContain('Access denied')
      expect((result.details as any).error).toBe('scope_violation')
    } finally {
      cleanupTestProject()
    }
  })

  it('blocks reading .env', async () => {
    setupTestProject()
    writeFileSync(resolve(testRoot, '.env'), 'SECRET=abc')
    try {
      const tool = createSelfReadTool(testRoot)
      const result = await tool.execute('t1', { path: '.env' })

      expect(result.output).toContain('Access denied')
    } finally {
      cleanupTestProject()
    }
  })

  it('blocks path traversal through allowed prefix', async () => {
    setupTestProject()
    try {
      const tool = createSelfReadTool(testRoot)
      const result = await tool.execute('t1', { path: 'apps/../../../../etc/passwd' })

      expect(result.output).toContain('Access denied')
    } finally {
      cleanupTestProject()
    }
  })
})

describe('self_edit_source', () => {
  it('edits a file with search and replace', async () => {
    setupTestProject()
    try {
      const tool = createSelfEditTool(testRoot)
      const result = await tool.execute('t1', {
        path: 'apps/construct/src/tools/example.ts',
        search: '"world"',
        replace: '"universe"',
      })

      expect(result.output).toContain('replaced 1 occurrence')

      // Verify the edit
      const read = createSelfReadTool(testRoot)
      const readResult = await read.execute('t2', { path: 'apps/construct/src/tools/example.ts' })
      expect(readResult.output).toContain('universe')
      expect(readResult.output).not.toContain('world')
    } finally {
      cleanupTestProject()
    }
  })

  it('edits a file in packages/', async () => {
    setupTestProject()
    try {
      const tool = createSelfEditTool(testRoot)
      const result = await tool.execute('t1', {
        path: 'packages/cairn/src/index.ts',
        search: 'true',
        replace: 'false',
      })

      expect(result.output).toContain('replaced 1 occurrence')
    } finally {
      cleanupTestProject()
    }
  })

  it('rejects edits outside apps/ and packages/', async () => {
    setupTestProject()
    try {
      const tool = createSelfEditTool(testRoot)
      const result = await tool.execute('t1', {
        path: '.env',
        search: 'a',
        replace: 'b',
      })

      expect(result.output).toContain('Access denied')
    } finally {
      cleanupTestProject()
    }
  })

  it('rejects ambiguous search strings', async () => {
    setupTestProject()
    writeFileSync(
      resolve(testRoot, 'apps/construct/src/tools/example.ts'),
      'const a = 1\nconst b = 1\n',
    )
    try {
      const tool = createSelfEditTool(testRoot)
      const result = await tool.execute('t1', {
        path: 'apps/construct/src/tools/example.ts',
        search: '= 1',
        replace: '= 2',
      })

      expect(result.output).toContain('found 2 times')
    } finally {
      cleanupTestProject()
    }
  })

  it('reports when search string not found', async () => {
    setupTestProject()
    try {
      const tool = createSelfEditTool(testRoot)
      const result = await tool.execute('t1', {
        path: 'apps/construct/src/tools/example.ts',
        search: 'nonexistent',
        replace: 'something',
      })

      expect(result.output).toContain('not found')
    } finally {
      cleanupTestProject()
    }
  })

  it('blocks path traversal through allowed prefix', async () => {
    setupTestProject()
    try {
      const tool = createSelfEditTool(testRoot)
      const result = await tool.execute('t1', {
        path: 'apps/../../../../etc/passwd',
        search: 'a',
        replace: 'b',
      })

      expect(result.output).toContain('Access denied')
    } finally {
      cleanupTestProject()
    }
  })
})
