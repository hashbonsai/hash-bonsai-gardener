import { describe, expect, it } from 'vitest'
import { runBackfill } from '../src/backfill'
import { decodeRecord } from '../src/memory'
import { memory, sources, U } from './roundkit'

const player = (n: number) => '0x' + String(n).padStart(64, '0')

/** Epochs 1 to 4 are over; each has burns by `epoch` players, and the board is on `board`. */
function chain(board: number) {
  return sources({
    board: async () => ({ epoch: board, endsAtMs: 0 }),
    distributor: async () => ({ bootstrapped: true, startEpoch: 5, nextEpoch: 5, unallocated: 1n, holderUnallocated: 1n, pool: 1n }),
    settles: async () =>
      [1, 2, 3, 4].map((epoch) => ({ digest: `S${epoch}`, timestampMs: 1_000_000 * epoch, epoch, extracted: BigInt(epoch) * U, awarded: BigInt(epoch) * U })),
    burns: async () =>
      [1, 2, 3, 4].flatMap((epoch) =>
        Array.from({ length: epoch }, (_, i) => ({ digest: `b${epoch}${i}`, timestampMs: 1_000_000 * epoch - 1, player: player(i + 1), epoch, burned: U, gained: U, newScore: U })),
      ),
    // The settle transaction is not needed for this: its parts become null, with a note.
    transaction: async () => Promise.reject(new Error('not needed here')),
    epochMinted: async () => null,
  })
}

const quiet = () => {
  const lines: string[] = []
  return { lines, log: (l: string) => void lines.push(l) }
}

const epochsIn = (texts: string[]) => texts.map((t) => (decodeRecord(t) as { payload: { epoch: number } }).payload.epoch)

describe('runBackfill', () => {
  it('writes one record for each final epoch before the first the rounds write about, oldest first', async () => {
    const m = memory()
    const out = await runBackfill({ src: chain(5), memory: m, firstEpoch: 5, dryRun: false, ...quiet() })
    expect(out).toMatchObject({ written: [1, 2, 3, 4], already: [], notFinal: [], failed: [], memories: 4 })
    expect(epochsIn(m.texts)).toEqual([1, 2, 3, 4])
    expect(decodeRecord(m.texts[3])?.payload).toMatchObject({ epoch: 4, players: 4, burns: 4 })
  })

  it('keeps the Arena only for the latest final epoch, the only one it can be read for', async () => {
    const m = memory()
    await runBackfill({ src: chain(5), memory: m, firstEpoch: 5, dryRun: false, ...quiet() })
    const payloads = m.texts.map((t) => decodeRecord(t)?.payload as { arenaTrees: number | null })
    expect(payloads.map((p) => p.arenaTrees)).toEqual([null, null, null, 70])
  })

  it('writes each epoch once, however often it is run', async () => {
    const m = memory()
    const run = () => runBackfill({ src: chain(5), memory: m, firstEpoch: 5, dryRun: false, ...quiet() })
    await run()
    const second = await run()
    expect(second).toMatchObject({ written: [], already: [1, 2, 3, 4] })
    expect(m.texts).toHaveLength(4)
  })

  it('fills in only what is missing', async () => {
    const m = memory()
    await runBackfill({ src: chain(3), memory: m, firstEpoch: 5, dryRun: false, ...quiet() }) // epochs 1 and 2
    const out = await runBackfill({ src: chain(5), memory: m, firstEpoch: 5, dryRun: false, ...quiet() })
    expect(out).toMatchObject({ written: [3, 4], already: [1, 2] })
    expect(epochsIn(m.texts)).toEqual([1, 2, 3, 4])
  })

  it('does not write an epoch that is not over', async () => {
    const m = memory()
    const out = await runBackfill({ src: chain(3), memory: m, firstEpoch: 5, dryRun: false, ...quiet() })
    expect(out).toMatchObject({ written: [1, 2], notFinal: [3, 4] })
    expect(epochsIn(m.texts)).toEqual([1, 2])
  })

  it('leaves the epochs from the first one on to the hourly rounds, however far the chain has gone', async () => {
    const m = memory()
    const out = await runBackfill({ src: chain(9), memory: m, firstEpoch: 5, dryRun: false, ...quiet() })
    expect(out.written).toEqual([1, 2, 3, 4])
    expect(epochsIn(m.texts)).not.toContain(5)
  })

  it('makes up no observations', async () => {
    const m = memory()
    await runBackfill({ src: chain(5), memory: m, firstEpoch: 5, dryRun: false, ...quiet() })
    expect(m.texts.every((t) => t.startsWith('gardener:epoch-facts '))).toBe(true)
  })

  it('writes nothing in a dry run, and shows the records it would write', async () => {
    const m = memory()
    const q = quiet()
    const out = await runBackfill({ src: chain(5), memory: m, firstEpoch: 5, dryRun: true, ...q })
    expect(out.written).toEqual([1, 2, 3, 4])
    expect(m.texts).toEqual([])
    expect(q.lines.join('\n')).toContain('would write')
    expect(q.lines.join('\n')).toContain('gardener:epoch-facts')
  })

  it('reports an epoch the memory would not take and goes on with the rest', async () => {
    const m = memory()
    m.failNext = 1
    const q = quiet()
    const out = await runBackfill({ src: chain(5), memory: m, firstEpoch: 5, dryRun: false, ...q })
    expect(out.written).toEqual([2, 3, 4])
    expect(out.failed).toEqual([{ epoch: 1, reason: 'relay down' }])
    expect(q.lines.join('\n')).toContain('epoch 1: failed: relay down')
  })

  it('says what could not be read about an epoch and writes the rest of it', async () => {
    const q = quiet()
    const src = chain(5)
    const m = memory()
    await runBackfill({ src: { ...src, drains: async () => Promise.reject(new Error('GraphQL answered HTTP 503')) }, memory: m, firstEpoch: 5, dryRun: false, ...q })
    expect(q.lines.join('\n')).toMatch(/epoch 1: unreadable: drain events: GraphQL answered HTTP 503/)
    expect(decodeRecord(m.texts[0])?.payload).toMatchObject({ epoch: 1, players: 1, drains: null })
  })
})
