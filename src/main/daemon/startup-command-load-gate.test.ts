import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldDeferStartupCommand } from './startup-command-load-gate'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

// Hoisted: vi.mock factories are lifted to module scope regardless of where
// they appear, so it must be declared here to apply to the import graph.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = {
    ...actual,
    loadavg: (): number[] => [99, 0, 0],
    cpus: () => new Array(8)
  }
  return { ...mocked, default: mocked }
})

function mockSubprocess(): SubprocessHandle {
  return {
    pid: 1,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: () => {},
    dispose: vi.fn()
  } as SubprocessHandle
}

const fixedInputs = (load1: number, cpuCount = 8) => ({
  loadavg: () => [load1, 0, 0] as number[],
  cpuCount
})

describe('shouldDeferStartupCommand', () => {
  it('never defers when the env var is unset or empty (default off)', () => {
    expect(shouldDeferStartupCommand({}, fixedInputs(99))).toEqual({ deferred: false })
    expect(shouldDeferStartupCommand({ ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '' }, fixedInputs(99)))
      .toEqual({ deferred: false })
  })

  it('never defers on unparseable or non-positive values', () => {
    for (const bad of ['abc', '0', '-2']) {
      expect(
        shouldDeferStartupCommand({ ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: bad }, fixedInputs(99))
      ).toEqual({ deferred: false })
    }
  })

  it('does not defer when 1-min load is within limit × cpus', () => {
    expect(
      shouldDeferStartupCommand(
        { ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '2' },
        fixedInputs(16, 8)
      )
    ).toEqual({ deferred: false })
  })

  it('defers with measured details when 1-min load exceeds limit × cpus', () => {
    expect(
      shouldDeferStartupCommand(
        { ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '2' },
        fixedInputs(16.5, 8)
      )
    ).toEqual({ deferred: true, load1: 16.5, limit: 16, cpuCount: 8 })
  })

  it('never defers on a non-finite loadavg reading', () => {
    expect(
      shouldDeferStartupCommand(
        { ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '2' },
        { loadavg: () => [Number.NaN], cpuCount: 8 }
      )
    ).toEqual({ deferred: false })
  })
})

// Why an integration test on top of the unit tests: the gate only protects the
// loop described in #19828 if the delivery site actually consults it — a pure
// unit test cannot catch a wiring regression.
describe('TerminalHost startup command load gate', () => {
  const ENV_KEY = 'ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU'

  let sub: SubprocessHandle
  let host: TerminalHost
  let readinessEvents: Array<{ event: string; details: Record<string, unknown> }>

  beforeEach(() => {
    sub = mockSubprocess()
    readinessEvents = []
    host = new TerminalHost({
      spawnSubprocess: () => sub,
      reportReadinessEvent: (event, details) => readinessEvents.push({ event, details })
    })
  })

  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('delivers the startup command when the gate is not configured', async () => {
    await host.createOrAttach({
      sessionId: 's-nogate',
      cols: 80,
      rows: 24,
      command: 'claude',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(vi.mocked(sub.write)).toHaveBeenCalledWith('claude\n')
  })

  it('defers delivery and reports the event when load exceeds the limit', async () => {
    process.env[ENV_KEY] = '2' // limit = 2 × 8 = 16, mocked loadavg(1m) = 99
    await host.createOrAttach({
      sessionId: 's-gated',
      cols: 80,
      rows: 24,
      command: 'run-heavy-tests',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    const writes = vi.mocked(sub.write).mock.calls.map((c) => String(c[0]))
    expect(writes).not.toContain('run-heavy-tests\n')
    expect(writes.join('')).toContain('startup command deferred')
    const deferred = readinessEvents.find((e) => e.event === 'startup-command-deferred-load')
    expect(deferred).toBeDefined()
    expect(deferred?.details.commandLength).toBe('run-heavy-tests'.length)
    expect(deferred?.details.load1).toBe(99)
  })
})
