import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockExec = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => {
  const fn = vi.fn()
  ;(fn as any)[Symbol.for('nodejs.util.promisify.custom')] = mockExec
  return { execFile: fn }
})

vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../logger.js', () => ({
  toolLog: { info: () => {}, error: () => {}, warning: () => {} },
}))

import { createSelfDeployTool } from '../self-deploy.js'

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

function queueSuccessfulDeploy() {
  queueExec({ stdout: '' })                  // tsc --noEmit
  queueExec({ stdout: 'Tests  2 passed' })   // vitest run
  queueExec({ stdout: '' })                  // git tag
  queueExec({ stdout: '' })                  // git add
  queueExec({ stdout: '' })                  // git commit
  queueExec({ stdout: '' })                  // systemctl restart
  queueExec({ stdout: 'active\n' })          // systemctl is-active
}

// Advance Date.now() by >1 hour between tests so that deployHistory entries
// from previous tests are filtered out by the rate limiter.
let fakeTime = 1_000_000_000_000

describe('self_deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeTime += 2 * 60 * 60 * 1000 // +2 hours
    vi.spyOn(Date, 'now').mockReturnValue(fakeTime)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('aborts when confirm is false', async () => {
    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: false,
      commit_message: 'test',
    })

    expect(result.output).toContain('aborted')
    expect((result.details as any).reason).toBe('not_confirmed')
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('rate limits after max deploys per hour', async () => {
    const tool = createSelfDeployTool('/project')

    for (let i = 0; i < 3; i++) {
      queueSuccessfulDeploy()
      const res = await tool.execute(`d${i}`, {
        confirm: true,
        commit_message: `deploy ${i}`,
      })
      expect((res.details as any).deployed).toBe(true)
    }

    const result = await tool.execute('d3', {
      confirm: true,
      commit_message: 'one too many',
    })
    expect(result.output).toContain('rate limited')
    expect((result.details as any).reason).toBe('rate_limited')
  })

  it('aborts when typecheck fails', async () => {
    const err = Object.assign(new Error('tsc failed'), { stderr: 'Type error in foo.ts' })
    queueExec(err)

    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: true,
      commit_message: 'test deploy',
    })

    expect(result.output).toContain('typecheck failed')
    expect((result.details as any).reason).toBe('typecheck_failed')
  })

  it('aborts when tests fail', async () => {
    queueExec({ stdout: '' }) // tsc passes
    const err = Object.assign(new Error('tests failed'), { stdout: '1 test failed' })
    queueExec(err)

    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: true,
      commit_message: 'test deploy',
    })

    expect(result.output).toContain('tests failed')
    expect((result.details as any).reason).toBe('tests_failed')
  })

  it('continues when git tag fails (non-fatal)', async () => {
    queueExec({ stdout: '' })                        // tsc
    queueExec({ stdout: 'Tests  2 passed' })         // vitest
    queueExec(new Error('tag already exists'))        // git tag fails
    queueExec({ stdout: '' })                        // git add
    queueExec({ stdout: '' })                        // git commit
    queueExec({ stdout: '' })                        // systemctl restart
    queueExec({ stdout: 'active\n' })                // systemctl is-active

    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: true,
      commit_message: 'deploy with tag failure',
    })

    expect((result.details as any).deployed).toBe(true)
  })

  it('returns error on git commit failure', async () => {
    queueExec({ stdout: '' })                        // tsc
    queueExec({ stdout: 'Tests  2 passed' })         // vitest
    queueExec({ stdout: '' })                        // git tag
    queueExec({ stdout: '' })                        // git add
    queueExec(new Error('nothing to commit'))         // git commit fails

    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: true,
      commit_message: 'empty deploy',
    })

    expect(result.output).toContain('git commit')
    expect((result.details as any).reason).toBe('commit_failed')
  })

  it('returns error with backup tag on service restart failure', async () => {
    queueExec({ stdout: '' })                        // tsc
    queueExec({ stdout: 'Tests  2 passed' })         // vitest
    queueExec({ stdout: '' })                        // git tag
    queueExec({ stdout: '' })                        // git add
    queueExec({ stdout: '' })                        // git commit
    queueExec(new Error('systemctl: connection timed out'))

    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: true,
      commit_message: 'restart fail',
    })

    expect(result.output).toContain('service restart')
    expect((result.details as any).reason).toBe('restart_failed')
    expect((result.details as any).tag).toMatch(/^pre-deploy-/)
  })

  it('returns success when health check passes', async () => {
    queueSuccessfulDeploy()

    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: true,
      commit_message: 'good deploy',
    })

    expect(result.output).toContain('Deployed successfully')
    expect((result.details as any).deployed).toBe(true)
    expect((result.details as any).tag).toMatch(/^pre-deploy-/)
  })

  it('auto-rolls back when health check fails', async () => {
    queueExec({ stdout: '' })                        // tsc
    queueExec({ stdout: 'Tests  2 passed' })         // vitest
    queueExec({ stdout: '' })                        // git tag
    queueExec({ stdout: '' })                        // git add
    queueExec({ stdout: '' })                        // git commit
    queueExec({ stdout: '' })                        // systemctl restart
    queueExec({ stdout: 'inactive\n' })              // is-active → not "active"
    queueExec({ stdout: '' })                        // git revert
    queueExec({ stdout: '' })                        // systemctl restart (rollback)

    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: true,
      commit_message: 'unhealthy deploy',
    })

    expect(result.output).toContain('ROLLED BACK')
    expect((result.details as any).rolledBack).toBe(true)
  })

  it('reports catastrophic error when rollback fails', async () => {
    queueExec({ stdout: '' })                        // tsc
    queueExec({ stdout: 'Tests  2 passed' })         // vitest
    queueExec({ stdout: '' })                        // git tag
    queueExec({ stdout: '' })                        // git add
    queueExec({ stdout: '' })                        // git commit
    queueExec({ stdout: '' })                        // systemctl restart
    queueExec(new Error('is-active: inactive'))       // is-active throws
    queueExec(new Error('revert conflict'))           // git revert fails

    const tool = createSelfDeployTool('/project')
    const result = await tool.execute('t1', {
      confirm: true,
      commit_message: 'catastrophic deploy',
    })

    expect(result.output).toContain('ROLLBACK FAILED')
    expect(result.output).toContain('Manual intervention')
    expect((result.details as any).reason).toBe('rollback_failed')
    expect((result.details as any).tag).toMatch(/^pre-deploy-/)
  })
})
