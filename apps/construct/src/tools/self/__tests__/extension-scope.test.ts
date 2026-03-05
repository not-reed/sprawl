import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSelfReadTool } from '../self-read.js'
import { createSelfEditTool } from '../self-edit.js'

describe('self-read with extensions scope', () => {
  let projectRoot: string
  let extensionsDir: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'proj-'))
    extensionsDir = await mkdtemp(join(tmpdir(), 'ext-'))

    // Create project files (monorepo layout)
    await mkdir(join(projectRoot, 'apps/construct/src'), { recursive: true })
    await writeFile(join(projectRoot, 'apps/construct/src', 'main.ts'), 'console.log("hello")')

    // Create extension files
    await mkdir(join(extensionsDir, 'skills'), { recursive: true })
    await writeFile(join(extensionsDir, 'SOUL.md'), 'I am a friendly bot.')
    await writeFile(join(extensionsDir, 'skills', 'test.md'), '---\nname: test\n---\nBody')
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true })
    await rm(extensionsDir, { recursive: true })
  })

  it('reads files from extensions/ prefix', async () => {
    const tool = createSelfReadTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', { path: 'extensions/SOUL.md' })
    expect(result.output).toContain('I am a friendly bot.')
  })

  it('reads nested extension files', async () => {
    const tool = createSelfReadTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', { path: 'extensions/skills/test.md' })
    expect(result.output).toContain('name: test')
  })

  it('lists extension directories', async () => {
    const tool = createSelfReadTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', { path: 'extensions/skills' })
    expect(result.output).toContain('test.md')
  })

  it('still reads project apps/ files', async () => {
    const tool = createSelfReadTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', { path: 'apps/construct/src/main.ts' })
    expect(result.output).toContain('console.log')
  })

  it('denies access to files outside scope', async () => {
    const tool = createSelfReadTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', { path: '/etc/passwd' })
    expect(result.output).toContain('Access denied')
  })
})

describe('self-edit with extensions scope', () => {
  let projectRoot: string
  let extensionsDir: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'proj-'))
    extensionsDir = await mkdtemp(join(tmpdir(), 'ext-'))

    await mkdir(join(projectRoot, 'apps/construct/src'), { recursive: true })
    await writeFile(join(projectRoot, 'apps/construct/src', 'test.ts'), 'const x = 1')

    await mkdir(join(extensionsDir, 'skills'), { recursive: true })
    await writeFile(join(extensionsDir, 'skills', 'existing.md'), 'old content')
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true })
    await rm(extensionsDir, { recursive: true })
  })

  it('edits existing extension files', async () => {
    const tool = createSelfEditTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', {
      path: 'extensions/skills/existing.md',
      search: 'old content',
      replace: 'new content',
    })
    expect(result.output).toContain('Edited')

    const content = await readFile(join(extensionsDir, 'skills', 'existing.md'), 'utf-8')
    expect(content).toBe('new content')
  })

  it('creates new extension files with empty search', async () => {
    const tool = createSelfEditTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', {
      path: 'extensions/skills/new-skill.md',
      search: '',
      replace: '---\nname: new\n---\nNew skill body',
    })
    expect(result.output).toContain('Created')

    const content = await readFile(join(extensionsDir, 'skills', 'new-skill.md'), 'utf-8')
    expect(content).toBe('---\nname: new\n---\nNew skill body')
  })

  it('creates new files in new subdirectories', async () => {
    const tool = createSelfEditTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', {
      path: 'extensions/tools/music/play.ts',
      search: '',
      replace: 'export default {}',
    })
    expect(result.output).toContain('Created')

    const content = await readFile(join(extensionsDir, 'tools', 'music', 'play.ts'), 'utf-8')
    expect(content).toBe('export default {}')
  })

  it('returns error when trying to create existing file', async () => {
    const tool = createSelfEditTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', {
      path: 'extensions/skills/existing.md',
      search: '',
      replace: 'should fail',
    })
    expect(result.output).toContain('already exists')
  })

  it('denies editing files outside scope', async () => {
    const tool = createSelfEditTool(projectRoot, extensionsDir)
    const result = await tool.execute('t1', {
      path: 'package.json',
      search: 'x',
      replace: 'y',
    })
    expect(result.output).toContain('Access denied')
  })
})
