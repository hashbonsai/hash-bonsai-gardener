import { describe, expect, it } from 'vitest'
import { LlmCallError } from '../src/llm'
import { NOTIFY_AFTER_MS } from '../src/ready'
import { applyDecision } from '../src/state'
import { GOOD, HOUR, kit, NOW, T5, U } from './roundkit'

const approve = (k: ReturnType<typeof kit>, note: string | null = null) => k.state.save(applyDecision(k.state.load(), 5, 'approved', note))
const reject = (k: ReturnType<typeof kit>, note: string | null = null) => k.state.save(applyDecision(k.state.load(), 5, 'rejected', note))

describe('waiting', () => {
  it('does nothing while the epoch is still running, and does not call the model', async () => {
    const k = kit({ src: { board: async () => ({ epoch: 5, endsAtMs: 0 }) } })
    expect(await k.round()).toEqual({ kind: 'waiting', epoch: 5, reason: 'running' })
    expect(k.llm.calls).toHaveLength(0)
    expect(k.notifier.messages).toEqual([])
  })

  it('waits for the distribution, and tells the operator once after six hours', async () => {
    const unconfirmed = { distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 5, unallocated: 0n, holderUnallocated: 0n, pool: 0n }) }
    const k = kit({ src: unconfirmed })
    expect(await k.round()).toMatchObject({ kind: 'waiting', reason: 'distribution' })
    expect(k.notifier.messages).toEqual([])
    k.advance(NOTIFY_AFTER_MS)
    await k.round()
    expect(k.notifier.messages).toHaveLength(1)
    expect(k.notifier.messages[0]).toMatch(/PRUNE distribution is not confirmed/)
    // The same problem is not told again within a day.
    k.advance(HOUR)
    await k.round()
    expect(k.notifier.messages).toHaveLength(1)
    expect(k.llm.calls).toHaveLength(0)
  })

  it('waits for a ballot epoch’s result, and gives up on it once the board is two epochs on', async () => {
    const ballotEpoch = {
      governance: async () => ({ bootstrapped: true, firstBallotEpoch: 5, ballotsTableId: '0xtable' }),
    }
    const k = kit({ src: ballotEpoch })
    expect(await k.round()).toMatchObject({ kind: 'waiting', reason: 'execute' })
    expect(k.llm.calls).toHaveLength(0)

    k.setSources({ board: async () => ({ epoch: 7, endsAtMs: 0 }), distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 7, unallocated: 1n, holderUnallocated: 1n, pool: 1n }) })
    const outcome = await k.round()
    expect(outcome).toMatchObject({ kind: 'awaiting-approval', epoch: 5 })
    expect(k.state.current.pending!.draft.executeMissing).toBe(true)
  })

  it('skips to the latest final epoch when it has fallen more than one behind', async () => {
    const k = kit({
      state: { lastReportedEpoch: 3 },
      src: {
        board: async () => ({ epoch: 8, endsAtMs: 0 }),
        distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 8, unallocated: 1n, holderUnallocated: 1n, pool: 1n }),
      },
    })
    await k.round()
    expect(k.notifier.messages.join('\n')).toMatch(/behind/)
    expect(k.state.current.lastReportedEpoch).toBe(6)
  })

  it('does not skip when it is only one epoch behind', async () => {
    const k = kit({ state: { lastReportedEpoch: 4 }, src: { board: async () => ({ epoch: 7, endsAtMs: 0 }), distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 7, unallocated: 1n, holderUnallocated: 1n, pool: 1n }) } })
    await k.round()
    expect(k.state.current.lastReportedEpoch).toBe(4)
    expect(k.state.current.pending?.epoch).toBe(5)
  })
})

describe('a report that needs a person’s approval', () => {
  it('is composed once, kept as a draft, and shown to the operator with how to decide', async () => {
    const k = kit()
    expect(await k.round()).toEqual({ kind: 'awaiting-approval', epoch: 5 })
    expect(k.llm.calls).toHaveLength(1)
    const pending = k.state.current.pending!
    expect(pending).toMatchObject({ epoch: 5, status: 'awaiting', note: null, memoryWritten: null })
    expect(pending.draft.commentary).toEqual({ en: GOOD.en, ja: GOOD.ja })
    expect(pending.draft.model).toBe('claude-sonnet-5-5')
    expect(pending.draft.promptSha256).toMatch(/^[0-9a-f]{64}$/)

    const message = k.notifier.messages.join('\n')
    expect(message).toContain(GOOD.en)
    expect(message).toContain(GOOD.ja)
    expect(message).toContain('npm run approve -- 5')
    expect(message).toContain('npm run reject -- 5')
    // Nothing has been stored, remembered or counted as reported.
    expect(k.store.saved).toHaveLength(0)
    expect(k.memory.texts).toHaveLength(0)
    expect(k.state.current.lastReportedEpoch).toBe(4)
  })

  it('does not compose again while it waits, and reminds only once a day', async () => {
    const k = kit()
    await k.round()
    const before = k.notifier.messages.length
    k.advance(HOUR)
    expect(await k.round()).toEqual({ kind: 'awaiting-approval', epoch: 5 })
    expect(k.llm.calls).toHaveLength(1)
    expect(k.notifier.messages.length).toBe(before + 1)
    k.advance(HOUR)
    await k.round()
    expect(k.notifier.messages.length).toBe(before + 1)
  })

  it('is stored, remembered and counted once approved, with the operator’s note kept as a memory', async () => {
    const k = kit()
    await k.round()
    approve(k, 'Shorter next time.')
    k.advance(HOUR)
    const outcome = await k.round()
    expect(outcome).toEqual({ kind: 'published', epoch: 5, blobId: 'blob-1' })
    expect(k.llm.calls).toHaveLength(1)

    const { report, saved } = k.store.saved[0]
    expect(saved.blobId).toBe('blob-1')
    expect(report).toMatchObject({
      schema: 1,
      epoch: 5,
      text: { en: GOOD.en, ja: GOOD.ja },
      fallback: false,
      fallbackReason: null,
      executeMissing: false,
      model: 'claude-sonnet-5-5',
      previousBlobId: null,
    })
    // The stored facts keep every digit; the treasury had 9 decimals.
    expect(report.facts.treasury).toEqual({ value: 360.123456789, asOf: 'after-settle' })
    expect(report.notebook).toEqual({ en: [], ja: [] })

    const s = k.state.current
    expect(s).toMatchObject({ lastReportedEpoch: 5, previousBlobId: 'blob-1', pending: null })
    expect(s.reports).toEqual([{ epoch: 5, blobId: 'blob-1', objectId: '0xobject1', endEpoch: 95, savedAtMs: NOW + HOUR }])

    // Memory: the epoch's facts, the observation, and the note; the report names them.
    expect(k.memory.texts.map((t) => t.split(' ')[0])).toEqual(['gardener:epoch-facts', 'gardener:observation', 'gardener:editor-note'])
    expect(k.memory.texts[2]).toContain('Shorter next time.')
    expect(report.memory.written).toEqual(['mem-1', 'mem-2', 'mem-3'])
  })

  it('tells the operator where the report is, with the cast to post by hand', async () => {
    const k = kit()
    await k.round()
    approve(k)
    await k.round()
    const message = k.notifier.messages.at(-1)!
    expect(message).toContain('Epoch 5 report published')
    expect(message).toContain('https://aggregator.example/v1/blobs/blob-1')
    expect(message).toContain('not deletable')
    expect(message).toContain(GOOD.cast)
    expect(message).toContain('The Gardener is an AI run by the Hash Bonsai operator')
  })

  it('goes out as the figures alone when rejected, and remembers none of what the model said', async () => {
    const k = kit()
    await k.round()
    reject(k, 'Too cheerful.')
    expect(await k.round()).toMatchObject({ kind: 'published', epoch: 5 })
    const { report } = k.store.saved[0]
    expect(report).toMatchObject({ text: { en: '', ja: '' }, fallback: true, fallbackReason: 'withheld' })
    expect(k.memory.texts.map((t) => t.split(' ')[0])).toEqual(['gardener:epoch-facts', 'gardener:editor-note'])
  })
})

describe('a report that needs no approval', () => {
  it('is composed and published in one round', async () => {
    const k = kit({ config: { requireApproval: false } })
    expect(await k.round()).toMatchObject({ kind: 'published', epoch: 5 })
    expect(k.store.saved).toHaveLength(1)
    expect(k.llm.calls).toHaveLength(1)
  })

  it('links the next report to this one, and shows the model the earlier commentary', async () => {
    const k = kit({ config: { requireApproval: false } })
    await k.round()
    // Epoch 6 is final and its distribution confirmed.
    k.setSources({
      board: async () => ({ epoch: 7, endsAtMs: 0 }),
      distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 7, unallocated: 1n, holderUnallocated: 1n, pool: 78_500n * U }),
      settles: async () => [
        { digest: 'SETTLE5', timestampMs: T5, epoch: 5, extracted: 1n, awarded: 1n },
        { digest: 'SETTLE6', timestampMs: T5 + 7 * 24 * HOUR, epoch: 6, extracted: 1n, awarded: 1n },
      ],
      burns: async () => [{ digest: 'b', timestampMs: T5 + 1, player: '0x' + '1'.repeat(64), epoch: 6, burned: U, gained: U, newScore: U }],
    })
    k.llm.calls.length = 0
    await k.round()
    expect(k.llm.calls).toHaveLength(1)
    expect(JSON.parse(k.llm.calls[0].user).previousReports).toEqual([GOOD.en])
    expect(k.state.current.lastReportedEpoch).toBe(6)
    expect(k.store.saved[1].report).toMatchObject({ epoch: 6, previousBlobId: 'blob-1' })
  })

  it('reads the earlier reports through their links, at most four', async () => {
    const k = kit({ config: { requireApproval: false } })
    for (let i = 1; i <= 6; i++) {
      await k.store.save({ schema: 1, epoch: i, text: { en: `Report ${i}`, ja: '' }, previousBlobId: i === 1 ? null : `blob-${i - 1}` } as never, 53)
    }
    const { loadPrevious } = await import('../src/round')
    expect(await loadPrevious(k.store, 'blob-6', () => {})).toEqual(['Report 6', 'Report 5', 'Report 4', 'Report 3'])
  })

  it('leaves out an earlier report that is not one of ours, instead of passing it to the model', async () => {
    const k = kit()
    const { loadPrevious } = await import('../src/round')
    const logs: string[] = []
    k.store.read = async () => ({ hello: 'a stranger’s blob' })
    expect(await loadPrevious(k.store, 'blob-x', (l) => logs.push(l))).toEqual([])
    expect(logs.join()).toMatch(/not a report of this schema/)
  })
})

describe('when the model cannot give usable text', () => {
  it('writes the figures only, says why, and still goes through approval', async () => {
    const k = kit({ llmOutputs: [new LlmCallError('401 Invalid bearer token', 'permanent')] })
    expect(await k.round()).toMatchObject({ kind: 'awaiting-approval' })
    expect(k.state.current.pending!.draft).toMatchObject({ fallback: true, fallbackReason: 'unavailable', model: 'none' })
    expect(k.notifier.messages.join('\n')).toMatch(/commentary could not be written/)
  })

  it('says the checks failed when they did', async () => {
    const k = kit({ llmOutputs: [{ ...GOOD, en: 'Epoch 5 had 99 players.' }] })
    await k.round()
    expect(k.state.current.pending!.draft).toMatchObject({ fallback: true, fallbackReason: 'checks' })
    expect(k.llm.calls).toHaveLength(2)
    expect(k.notifier.messages.join('\n')).toMatch(/failed its checks/)
  })

  it('remembers no observation from a report that has no commentary', async () => {
    const k = kit({ config: { requireApproval: false }, llmOutputs: [new LlmCallError('401', 'permanent')] })
    await k.round()
    expect(k.memory.texts.map((t) => t.split(' ')[0])).toEqual(['gardener:epoch-facts'])
  })
})

describe('the cost brakes', () => {
  it('stops before calling the model once the day’s limit is used', async () => {
    // Four calls earlier the same UTC day.
    const k = kit({ state: { llmCallsMs: [40, 30, 20, 10].map((m) => NOW - m * 60_000) } })
    const outcome = await k.round()
    expect(outcome).toMatchObject({ kind: 'blocked', epoch: 5 })
    expect(k.llm.calls).toHaveLength(0)
    expect(k.notifier.messages.join()).toMatch(/4 times today/)
    expect(k.state.current.pending).toBeNull()
  })

  it('lets a rehearsal raise the model-call limit through its deps', async () => {
    const k = kit({ state: { llmCallsMs: [40, 30, 20, 10].map((m) => NOW - m * 60_000) } })
    k.deps.limits = { perDay: 50, perMonth: 500 }
    expect(await k.round()).toMatchObject({ kind: 'awaiting-approval' })
    expect(k.llm.calls).toHaveLength(1)
  })

  it('stops when the gardener holds less than 0.1 SUI', async () => {
    const k = kit({ src: { balances: async () => ({ sui: 50_000_000n, wal: 9_990_000_000n }) } })
    expect(await k.round()).toMatchObject({ kind: 'blocked' })
    expect(k.llm.calls).toHaveLength(0)
    expect(k.notifier.messages.join()).toMatch(/0\.05 SUI, below the 0\.1 SUI floor/)
  })

  it('stops when the WAL cannot pay for a save', async () => {
    const k = kit({ src: { balances: async () => ({ sui: 2n * U, wal: 100_000_000n }) } })
    expect(await k.round()).toMatchObject({ kind: 'blocked' })
    expect(k.notifier.messages.join()).toMatch(/0\.1 WAL and one save costs about 0\.54 WAL/)
  })

  it('tells the operator once a day, not every round, and tries again when funds arrive', async () => {
    const k = kit({ src: { balances: async () => ({ sui: 50_000_000n, wal: 9_990_000_000n }) } })
    await k.round()
    k.advance(HOUR)
    await k.round()
    expect(k.notifier.messages).toHaveLength(1)
    k.setSources({ balances: async () => ({ sui: 2n * U, wal: 9_990_000_000n }) })
    expect(await k.round()).toMatchObject({ kind: 'awaiting-approval' })
  })

  it('counts the calls it makes against the day’s limit', async () => {
    const k = kit({ llmOutputs: [{ ...GOOD, en: 'Epoch 5 had 99 players.' }] })
    await k.round()
    expect(k.state.current.llmCallsMs).toEqual([NOW, NOW])
  })

  it('holds an approved report back, keeping it, when the funds are gone by the time it is published', async () => {
    const k = kit()
    await k.round()
    approve(k)
    k.setSources({ balances: async () => ({ sui: 2n * U, wal: 0n }) })
    expect(await k.round()).toMatchObject({ kind: 'blocked' })
    expect(k.state.current.pending).toMatchObject({ status: 'approved' })
    expect(k.store.saved).toHaveLength(0)
    expect(k.memory.texts).toHaveLength(0)
  })
})

describe('when Walrus fails', () => {
  it('keeps the approved report and tries again next round without calling the model or remembering twice', async () => {
    const k = kit({ config: { requireApproval: false } })
    k.store.failSaves = 1
    const first = await k.round()
    expect(first).toMatchObject({ kind: 'failed', epoch: 5 })
    expect(k.notifier.messages.join('\n')).toMatch(/could not be stored on Walrus: storage nodes did not answer/)
    expect(k.state.current).toMatchObject({ lastReportedEpoch: 4, pending: { epoch: 5, status: 'approved' } })
    const memoriesAfterFirst = k.memory.texts.length

    k.advance(HOUR)
    expect(await k.round()).toMatchObject({ kind: 'published', epoch: 5 })
    expect(k.llm.calls).toHaveLength(1)
    expect(k.memory.texts).toHaveLength(memoriesAfterFirst)
    expect(k.store.saved).toHaveLength(1)
  })
})

describe('Walrus Memory', () => {
  it('is left out when it cannot be read, and the operator is told', async () => {
    const k = kit()
    k.memory.readFails = true
    expect(await k.round()).toMatchObject({ kind: 'awaiting-approval' })
    expect(k.notifier.messages.join('\n')).toMatch(/Walrus Memory could not be read/)
    expect(k.state.current.pending!.draft.recalledBlobIds).toEqual([])
  })

  it('does not hold the report back when it cannot be written; the records wait for next round', async () => {
    const k = kit({ config: { requireApproval: false } })
    k.memory.failNext = 2 // the epoch's facts and the one observation
    expect(await k.round()).toMatchObject({ kind: 'published' })
    expect(k.state.current.memoryBacklog).toHaveLength(2)
    expect(k.store.saved[0].report.memory.written).toEqual([])
    expect(k.notifier.messages.join('\n')).toMatch(/2 memory record\(s\) could not be written/)
  })

  it('writes the waiting records ahead of the next report’s', async () => {
    const k = kit({ config: { requireApproval: false } })
    k.memory.failNext = 2
    await k.round()
    k.setSources({
      board: async () => ({ epoch: 7, endsAtMs: 0 }),
      distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 7, unallocated: 1n, holderUnallocated: 1n, pool: 78_500n * U }),
      settles: async () => [
        { digest: 'SETTLE5', timestampMs: T5, epoch: 5, extracted: 1n, awarded: 1n },
        { digest: 'SETTLE6', timestampMs: T5 + 7 * 24 * HOUR, epoch: 6, extracted: 1n, awarded: 1n },
      ],
      burns: async () => [{ digest: 'b', timestampMs: T5 + 1, player: '0x' + '1'.repeat(64), epoch: 6, burned: U, gained: U, newScore: U }],
    })
    k.advance(HOUR)
    await k.round()
    expect(k.state.current.memoryBacklog).toEqual([])
    expect(k.memory.texts[0]).toContain('"epoch":5')
  })

  it('is neither read nor written with --no-memory', async () => {
    const k = kit({ config: { requireApproval: false, useMemory: false } })
    await k.round()
    expect(k.memory.texts).toEqual([])
    expect(k.store.saved[0].report.memory).toEqual({ recalled: [], written: [] })
  })

  it('brings the earlier observations back, graded, into the next report', async () => {
    const k = kit({ config: { requireApproval: false } })
    await k.round()
    k.setSources({
      board: async () => ({ epoch: 7, endsAtMs: 0 }),
      distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 7, unallocated: 1n, holderUnallocated: 1n, pool: 78_500n * U }),
      settles: async () => [
        { digest: 'SETTLE5', timestampMs: T5, epoch: 5, extracted: 1n, awarded: 1n },
        { digest: 'SETTLE6', timestampMs: T5 + 7 * 24 * HOUR, epoch: 6, extracted: 1n, awarded: 1n },
      ],
      burns: async () => ['1', '2', '3'].map((n) => ({ digest: n, timestampMs: T5 + 1, player: '0x' + n.repeat(64), epoch: 6, burned: U, gained: U, newScore: U })),
    })
    k.llm.calls.length = 0
    await k.round()
    const user = JSON.parse(k.llm.calls[0].user)
    expect(user.followups).toEqual([{ observationId: 'obs-5-1', fromEpoch: 5, toEpoch: 6, metric: 'players', before: 2, after: 3, verdict: 'continued' }])
    expect(user.yourEarlierObservations).toHaveLength(1)
  })
})

describe('the ballot’s fixed notices', () => {
  const ballotAt = (first: number) => ({
    governance: async () => ({ bootstrapped: true, firstBallotEpoch: first, ballotsTableId: '0xtable' }),
  })

  it('announces a ballot that has just opened, once', async () => {
    // Epoch 5 has just ended and the board is on 6, a ballot epoch.
    const k = kit({ config: { requireApproval: false }, src: ballotAt(6) })
    await k.round()
    const announcements = k.notifier.messages.filter((m) => m.startsWith('Ballot notice'))
    expect(announcements).toHaveLength(1)
    expect(announcements[0]).toContain('The ballot of epoch 6 is open')
    expect(announcements[0]).toContain('シーズン 6 の投票が開いています')
    expect(k.state.current.announced.opened).toEqual([6])
  })

  it('announces what an applied ballot decided, once', async () => {
    const executed = [{ digest: 'EX', timestampMs: 1, ballotEpoch: 1, quorumMet: true, applied: [true, false, true, false] }]
    const k = kit({ config: { requireApproval: false }, src: { ballotsExecuted: async () => executed } })
    await k.round()
    const results = k.notifier.messages.filter((m) => m.startsWith('Ballot result'))
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('reached quorum and was applied')
    expect(k.state.current.announced.applied).toEqual([1])
  })

  it('says nothing about a ballot while none is open or applied', async () => {
    const k = kit({ config: { requireApproval: false } })
    await k.round()
    expect(k.notifier.messages.some((m) => m.startsWith('Ballot'))).toBe(false)
  })
})

describe('a dry run', () => {
  it('composes and shows the report and changes nothing', async () => {
    const k = kit({ config: { dryRun: true, requireApproval: false } })
    const before = JSON.stringify(k.state.current)
    const outcome = await k.round()
    expect(outcome).toMatchObject({ kind: 'dry-run', epoch: 5 })
    expect(JSON.stringify(k.state.current)).toBe(before)
    expect(k.store.saved).toHaveLength(0)
    expect(k.memory.texts).toHaveLength(0)
    expect(k.notifier.messages.join('\n')).toContain(GOOD.en)
    expect(k.notifier.messages.join('\n')).toContain('(dry run)')
  })
})

describe('a failure in the round', () => {
  it('is reported with no secret in it, and does not lose the state', async () => {
    const fakeKey = ['sk', 'ant', 'api03', 'abcdefghijklmnop'].join('-')
    const k = kit({ src: { board: async () => Promise.reject(new Error(`gRPC failed with key ${fakeKey}`)) } })
    const outcome = await k.round()
    expect(outcome).toMatchObject({ kind: 'failed' })
    const everything = [...k.notifier.messages, ...k.logs, JSON.stringify(outcome)].join('\n')
    expect(everything).not.toContain(fakeKey)
    expect(everything).toContain('[redacted key]')
  })
})
