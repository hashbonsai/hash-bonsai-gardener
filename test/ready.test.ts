import { describe, expect, it } from 'vitest'
import { checkReady, decideReadiness, isBallotEpoch, NOTIFY_AFTER_MS, type ReadyInput } from '../src/ready'

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 10, 7)

/** Epoch 9 is the first ballot epoch; the board is on 10; distribution is confirmed through 9; no execute yet. */
const base = (over: Partial<ReadyInput> = {}): ReadyInput => ({
  epoch: 9,
  nowMs: T0 + HOUR,
  finalSinceMs: T0,
  boardEpoch: 10,
  distributor: { bootstrapped: true, startEpoch: 5, nextEpoch: 10 },
  governance: { bootstrapped: true, firstBallotEpoch: 9 },
  executedForEpoch: false,
  ...over,
})

describe('isBallotEpoch', () => {
  const gov = { bootstrapped: true, firstBallotEpoch: 9 }
  it.each([9, 13, 17, 21])('%i runs a ballot', (n) => expect(isBallotEpoch(n, gov)).toBe(true))
  it.each([5, 8, 10, 11, 12, 14])('%i does not', (n) => expect(isBallotEpoch(n, gov)).toBe(false))
  it('has no ballots until the governance is bootstrapped', () => {
    expect(isBallotEpoch(9, { bootstrapped: false, firstBallotEpoch: 9 })).toBe(false)
  })
})

describe('an epoch that has not ended', () => {
  it('waits, and says nothing however long it has been', () => {
    const r = decideReadiness(base({ boardEpoch: 9, nowMs: T0 + 100 * HOUR }))
    expect(r).toEqual({ action: 'wait', reason: 'running', notice: null })
  })
})

describe('the distribution', () => {
  it('is waited for, quietly at first', () => {
    const r = decideReadiness(base({ distributor: { bootstrapped: true, startEpoch: 5, nextEpoch: 9 } }))
    expect(r).toEqual({ action: 'wait', reason: 'distribution', notice: null })
  })

  it('is told to the operator once six hours have passed since the epoch ended, and not a second before', () => {
    const stalled = { distributor: { bootstrapped: true, startEpoch: 5, nextEpoch: 9 } }
    const early = decideReadiness(base({ ...stalled, nowMs: T0 + NOTIFY_AFTER_MS - 1 }))
    expect(early).toMatchObject({ reason: 'distribution', notice: null })
    const late = decideReadiness(base({ ...stalled, nowMs: T0 + NOTIFY_AFTER_MS }))
    expect(late).toMatchObject({ reason: 'distribution', notice: { key: 'distribution-stalled-9' } })
    expect((late as { notice: { text: string } }).notice.text).toMatch(/house bot may be stopped/)
  })

  it('is not asked for an epoch before distribution began, or while the distributor is not bootstrapped', () => {
    expect(decideReadiness(base({ epoch: 3, boardEpoch: 4, distributor: { bootstrapped: true, startEpoch: 5, nextEpoch: 5 } }))).toEqual({ action: 'write', executeMissing: false })
    expect(decideReadiness(base({ epoch: 8, boardEpoch: 9, distributor: { bootstrapped: false, startEpoch: 0, nextEpoch: 0 } }))).toEqual({ action: 'write', executeMissing: false })
  })
})

describe('a ballot epoch also waits for the ballot to be applied', () => {
  it('does not write while the board is on the next epoch and nothing has been applied', () => {
    expect(decideReadiness(base())).toEqual({ action: 'wait', reason: 'execute', notice: null })
  })

  it('tells the operator after six hours that the result has not been applied', () => {
    expect(decideReadiness(base({ nowMs: T0 + NOTIFY_AFTER_MS - 1 }))).toMatchObject({ reason: 'execute', notice: null })
    const late = decideReadiness(base({ nowMs: T0 + NOTIFY_AFTER_MS }))
    expect(late).toMatchObject({ reason: 'execute', notice: { key: 'execute-stalled-9' } })
    expect((late as { notice: { text: string } }).notice.text).toMatch(/result has not been applied/)
  })

  it('writes once the result is applied', () => {
    expect(decideReadiness(base({ executedForEpoch: true }))).toEqual({ action: 'write', executeMissing: false })
  })

  it('gives up on the result when the board is two epochs on, and writes without it', () => {
    expect(decideReadiness(base({ boardEpoch: 11, nowMs: T0 + 200 * HOUR }))).toEqual({ action: 'write', executeMissing: true })
    expect(decideReadiness(base({ boardEpoch: 12 }))).toEqual({ action: 'write', executeMissing: true })
  })

  it('does not call it missing if the result arrived in time', () => {
    expect(decideReadiness(base({ boardEpoch: 11, executedForEpoch: true }))).toEqual({ action: 'write', executeMissing: false })
  })

  it('holds for later ballot epochs in the same way', () => {
    expect(decideReadiness(base({ epoch: 13, boardEpoch: 14, distributor: { bootstrapped: true, startEpoch: 5, nextEpoch: 14 } }))).toMatchObject({ reason: 'execute' })
    expect(decideReadiness(base({ epoch: 13, boardEpoch: 15, distributor: { bootstrapped: true, startEpoch: 5, nextEpoch: 14 } }))).toEqual({ action: 'write', executeMissing: true })
  })

  it('is not asked of an epoch that ran no ballot', () => {
    for (const epoch of [5, 8, 10, 12]) {
      const r = decideReadiness(base({ epoch, boardEpoch: epoch + 1, distributor: { bootstrapped: true, startEpoch: 5, nextEpoch: epoch + 1 } }))
      expect(r).toEqual({ action: 'write', executeMissing: false })
    }
  })

  it('is not asked while there is no governance', () => {
    expect(decideReadiness(base({ governance: { bootstrapped: false, firstBallotEpoch: 9 } }))).toEqual({ action: 'write', executeMissing: false })
  })

  it('still waits for the distribution first, even when the board is two epochs on', () => {
    const r = decideReadiness(base({ boardEpoch: 11, distributor: { bootstrapped: true, startEpoch: 5, nextEpoch: 9 } }))
    expect(r).toMatchObject({ action: 'wait', reason: 'distribution' })
  })
})

describe('checkReady, reading the chain for it', () => {
  type Src = Parameters<typeof checkReady>[0]
  function source(over: { board?: number; nextEpoch?: number; executed?: number[]; settleAt?: number | null; first?: number } = {}) {
    const calls = { settles: 0, ballotsExecuted: 0, distributor: 0 }
    const src: Src = {
      board: async () => ({ epoch: over.board ?? 10, endsAtMs: 0 }),
      distributor: async () => {
        calls.distributor += 1
        return { bootstrapped: true, startEpoch: 5, nextEpoch: over.nextEpoch ?? 10, unallocated: 0n, holderUnallocated: 0n, pool: 0n }
      },
      governance: async () => ({ bootstrapped: true, firstBallotEpoch: over.first ?? 9, ballotsTableId: '0x' }),
      settles: async () => {
        calls.settles += 1
        return over.settleAt === null ? [] : [{ digest: 'S', timestampMs: over.settleAt ?? T0, epoch: 9, extracted: 0n, awarded: 0n }]
      },
      ballotsExecuted: async () => {
        calls.ballotsExecuted += 1
        return (over.executed ?? []).map((ballotEpoch) => ({ digest: 'E', timestampMs: 1, ballotEpoch, quorumMet: true, applied: [true] }))
      },
    }
    return { src, calls }
  }

  it('asks for nothing but the board while the epoch is still running', async () => {
    const { src, calls } = source({ board: 9 })
    expect(await checkReady(src, 9, T0, null)).toMatchObject({ action: 'wait', reason: 'running' })
    expect(calls).toEqual({ settles: 0, ballotsExecuted: 0, distributor: 0 })
  })

  it('waits for the ballot’s result, and writes when it has been applied', async () => {
    expect(await checkReady(source().src, 9, T0 + HOUR, null)).toMatchObject({ action: 'wait', reason: 'execute' })
    expect(await checkReady(source({ executed: [9] }).src, 9, T0 + HOUR, null)).toEqual({ action: 'write', executeMissing: false })
  })

  it('does not take another ballot’s execution for this one', async () => {
    expect(await checkReady(source({ executed: [1, 13] }).src, 9, T0 + HOUR, null)).toMatchObject({ reason: 'execute' })
  })

  it('does not look for executions of an epoch that ran no ballot', async () => {
    const { src, calls } = source({ first: 9 })
    expect(await checkReady(src, 8, T0, null)).toEqual({ action: 'write', executeMissing: false })
    expect(calls.ballotsExecuted).toBe(0)
  })

  it('times the six hours from the settle event', async () => {
    const early = await checkReady(source({ settleAt: T0 }).src, 9, T0 + NOTIFY_AFTER_MS - 1, T0 + 5 * HOUR)
    expect(early).toMatchObject({ reason: 'execute', notice: null })
    const late = await checkReady(source({ settleAt: T0 }).src, 9, T0 + NOTIFY_AFTER_MS, null)
    expect(late).toMatchObject({ reason: 'execute', notice: { key: 'execute-stalled-9' } })
  })

  it('times them from the first sighting when the epoch has no settle event, and from now on the first sighting', async () => {
    const fromSighting = await checkReady(source({ settleAt: null }).src, 9, T0 + NOTIFY_AFTER_MS, T0)
    expect(fromSighting).toMatchObject({ reason: 'execute', notice: { key: 'execute-stalled-9' } })
    const firstTime = await checkReady(source({ settleAt: null }).src, 9, T0 + 100 * HOUR, null)
    expect(firstTime).toMatchObject({ reason: 'execute', notice: null })
  })

  it('writes without the result when the board has moved two epochs on', async () => {
    expect(await checkReady(source({ board: 11, nextEpoch: 11 }).src, 9, T0 + 300 * HOUR, null)).toEqual({ action: 'write', executeMissing: true })
  })
})
