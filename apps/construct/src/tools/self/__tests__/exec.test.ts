import { describe, it, expect, vi, beforeEach } from 'vitest'

// Create mock before vi.mock so it's available in the factory (both are hoisted)
const mockExec = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => {
  const fn = vi.fn()
  // Attach as the custom promisify implementation so that
  // `promisify(execFile)` returns our controllable async mock
  ;(fn as any)[Symbol.for('nodejs.util.promisify.custom')] = mockExec
  return { execFile: fn }
})

import { createSelfTestTool } from '../self-test.js'
import { createSelfLogsTool } from '../self-logs.js'

function queueExec(result: { stdout?: string; stderr?: string } | Error) {
  if (result instanceof Error) {
    mockExec.mockRejectedValueOnce(result)
  } else {
    mockExec.mockResolvedValueOnce({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    })
  }
}

// ---------- self_run_tests ----------

describe('self_run_tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports PASSED when tests succeed', async () => {
    queueExec({ stdout: 'Tests  5 passed\n ✓ all good' })

    const tool = createSelfTestTool('/project')
    const result = await tool.execute('t1', {})

    expect(result.output).toContain('Tests PASSED')
    expect((result.details as any).passed).toBe(true)
  })

  it('reports FAILED when stdout contains "failed"', async () => {
    queueExec({ stdout: 'Tests  2 failed | 3 passed' })

    const tool = createSelfTestTool('/project')
    const result = await tool.execute('t1', {})

    expect(result.output).toContain('Tests FAILED')
    expect((result.details as any).passed).toBe(false)
  })

  it('forwards filter as -t arg', async () => {
    queueExec({ stdout: 'Tests  1 passed' })

    const tool = createSelfTestTool('/project')
    await tool.execute('t1', { filter: 'memory' })

    const call = mockExec.mock.calls[0]
    // promisify.custom receives (cmd, args, opts)
    const args = call[1] as string[]
    expect(args).toContain('-t')
    expect(args).toContain('memory')
  })

  it('reports FAILED with stdout/stderr when execFile throws', async () => {
    const err = Object.assign(new Error('exit code 1'), {
      stdout: 'Tests  1 failed\nsome output',
    })
    queueExec(err)

    const tool = createSelfTestTool('/project')
    const result = await tool.execute('t1', {})

    expect(result.output).toContain('Tests FAILED')
    expect(result.output).toContain('1 failed')
    expect((result.details as any).passed).toBe(false)
  })

  it('truncates output to last 2000 chars', async () => {
    const longOutput = 'x'.repeat(5000) + 'Tests  3 passed'
    queueExec({ stdout: longOutput })

    const tool = createSelfTestTool('/project')
    const result = await tool.execute('t1', {})

    const afterPrefix = result.output.replace(/^Tests (PASSED|FAILED):\n/, '')
    expect(afterPrefix.length).toBeLessThanOrEqual(2000)
  })
})

// ---------- self_view_logs ----------

describe('self_view_logs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns log lines on success', async () => {
    queueExec({ stdout: 'Jan 01 12:00 construct: booting\nJan 01 12:01 construct: ready' })

    const tool = createSelfLogsTool(undefined, 'construct')
    const result = await tool.execute('t1', {})

    expect(result.output).toContain('Recent logs (construct)')
    expect(result.output).toContain('booting')
    expect(result.output).toContain('ready')
  })

  it('forwards custom lines param as -n', async () => {
    queueExec({ stdout: 'line1\nline2' })

    const tool = createSelfLogsTool(undefined, 'construct')
    await tool.execute('t1', { lines: 100 })

    const call = mockExec.mock.calls[0]
    const args = call[1] as string[]
    expect(args).toContain('-n')
    expect(args).toContain('100')
  })

  it('forwards since param as --since', async () => {
    queueExec({ stdout: 'recent log' })

    const tool = createSelfLogsTool(undefined, 'construct')
    await tool.execute('t1', { since: '5 minutes ago' })

    const call = mockExec.mock.calls[0]
    const args = call[1] as string[]
    expect(args).toContain('--since')
    expect(args).toContain('5 minutes ago')
  })

  it('filters lines case-insensitively with grep', async () => {
    queueExec({
      stdout: 'ERROR: something broke\nINFO: all good\nerror: another one',
    })

    const tool = createSelfLogsTool(undefined, 'construct')
    const result = await tool.execute('t1', { grep: 'error' })

    expect(result.output).toContain('ERROR: something broke')
    expect(result.output).toContain('error: another one')
    expect(result.output).not.toContain('INFO: all good')
  })

  it('returns "No log output found" when empty', async () => {
    queueExec({ stdout: '   \n  ' })

    const tool = createSelfLogsTool(undefined, 'construct')
    const result = await tool.execute('t1', {})

    expect(result.output).toContain('No log output found')
    expect((result.details as any).lines).toBe(0)
  })

  it('returns error message on journalctl failure', async () => {
    queueExec(new Error('Failed to get journal: Permission denied'))

    const tool = createSelfLogsTool(undefined, 'construct')
    const result = await tool.execute('t1', {})

    expect(result.output).toContain('Error reading logs')
    expect(result.output).toContain('Permission denied')
  })

  it('truncates output to last 3000 chars', async () => {
    const longOutput = 'x'.repeat(5000)
    queueExec({ stdout: longOutput })

    const tool = createSelfLogsTool(undefined, 'construct')
    const result = await tool.execute('t1', {})

    const logContent = result.output.replace(/^Recent logs \([^)]+\):\n/, '')
    expect(logContent.length).toBeLessThanOrEqual(3000)
  })
})
