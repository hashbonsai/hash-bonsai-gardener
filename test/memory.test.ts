import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeRecord,
  encodeRecord,
  memwalStore,
  nullStore,
  recallForEpoch,
  records,
  writeRecords,
  type MemWalLike,
  type MemoryStore,
} from '../src/memory'
import type { Followup, Observation } from '../src/types'
import { sampleFacts } from './fixtures'

const observation = (over: Partial<Observation> = {}): Observation => ({
  id: 'obs-5-1',
  epoch: 5,
  metric: 'players',
  direction: 'up',
  baseline: 12,
  statement: 'Players should rise.',
  ...over,
})

const followup = (over: Partial<Followup> = {}): Followup => ({
  observationId: 'obs-5-1',
  fromEpoch: 5,
  toEpoch: 6,
  metric: 'players',
  before: 12,
  after: 20,
  verdict: 'continued',
  ...over,
})

/** A store holding whatever was remembered, matching a query by the record kind it names. */
function fakeStore(initial: string[] = []): MemoryStore & { texts: string[]; recalls: string[] } {
  const texts = [...initial]
  const recalls: string[] = []
  return {
    texts,
    recalls,
    async remember(text) {
      texts.push(text)
      return { blobId: `blob-${texts.length}` }
    },
    async recall(query, limit) {
      recalls.push(query)
      return texts
        .map((text, i) => ({ text, blobId: `blob-${i + 1}` }))
        .filter((m) => m.text.startsWith(query))
        .slice(0, limit)
    },
    async count() {
      return texts.length
    },
  }
}

describe('records', () => {
  it('round-trips each kind through encode and decode', () => {
    const text = records.observation(observation())
    const d = decodeRecord(text)
    expect(d?.kind).toBe('observation')
    expect(d?.payload).toEqual(observation())
  })
  it('puts the machine-readable line first and a plain sentence second', () => {
    const text = records.followup(followup())
    const [first, second] = text.split('\n')
    expect(first.startsWith('gardener:followup {')).toBe(true)
    expect(second).toMatch(/obs-5-1 checked in epoch 6: continued/)
  })
  it('does not decode text that is not one of its own', () => {
    expect(decodeRecord('hello')).toBeNull()
    expect(decodeRecord('gardener:nonsense {}')).toBeNull()
    expect(decodeRecord('gardener:observation not-json')).toBeNull()
  })
  it('refuses to remember anything key-shaped', () => {
    const secret = ['suiprivkey', '1', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')
    expect(() => encodeRecord('editor-note', { epoch: 5, note: secret }, 'note')).toThrow(/secret/)
  })
  it('summarises an epoch without embedding the whole facts object', () => {
    const d = decodeRecord(records.epochFacts(sampleFacts()))
    expect(d?.kind).toBe('epoch-facts')
    expect(d?.payload).toMatchObject({ epoch: 5, players: 12, burns: 40 })
    expect(JSON.stringify(d?.payload)).not.toContain('gardener')
  })
})

describe('recallForEpoch', () => {
  it('returns unanswered observations newest first, and the operator notes', async () => {
    const store = fakeStore([
      records.observation(observation({ id: 'obs-3-1', epoch: 3 })),
      records.observation(observation({ id: 'obs-4-1', epoch: 4 })),
      records.editorNote({ epoch: 4, note: 'shorter please' }),
    ])
    const got = await recallForEpoch(store)
    expect(got.observations.map((o) => o.id)).toEqual(['obs-4-1', 'obs-3-1'])
    expect(got.notes).toEqual([{ epoch: 4, note: 'shorter please' }])
    expect(got.blobIds).toHaveLength(3)
  })
  it('drops an observation that already has a follow-up, so it is graded once', async () => {
    const store = fakeStore([records.observation(observation()), records.followup(followup())])
    expect((await recallForEpoch(store)).observations).toEqual([])
  })
  it('ignores a memory that does not decode rather than failing', async () => {
    const store = fakeStore(['gardener:observation {broken', records.observation(observation())])
    expect((await recallForEpoch(store)).observations).toHaveLength(1)
  })
  it('keeps at most 10 observations and 5 notes', async () => {
    const store = fakeStore([
      ...Array.from({ length: 12 }, (_, i) => records.observation(observation({ id: `o${i}`, epoch: i }))),
      ...Array.from({ length: 8 }, (_, i) => records.editorNote({ epoch: i, note: `n${i}` })),
    ])
    const got = await recallForEpoch(store)
    expect(got.observations).toHaveLength(10)
    expect(got.notes).toHaveLength(5)
  })
  it('reads nothing and writes nothing under --no-memory', async () => {
    expect(await recallForEpoch(nullStore)).toEqual({ observations: [], notes: [], blobIds: [] })
    expect(await nullStore.count()).toBe(0)
  })
})

describe('writeRecords', () => {
  it('returns the blob id of each record it wrote', async () => {
    const store = fakeStore()
    const out = await writeRecords(store, [records.observation(observation()), records.followup(followup())])
    expect(out).toEqual({ written: ['blob-1', 'blob-2'], failed: 0, failedTexts: [] })
  })
  it('counts a failed write instead of throwing, and carries on with the rest', async () => {
    let n = 0
    const store: MemoryStore = {
      async remember() {
        if (++n === 1) throw new Error('relay down')
        return { blobId: 'ok' }
      },
      async recall() {
        return []
      },
      async count() {
        return 0
      },
    }
    // The record that did not go in comes back as text, so it can be tried again.
    expect(await writeRecords(store, ['a', 'b', 'c'])).toEqual({ written: ['ok', 'ok'], failed: 1, failedTexts: ['a'] })
  })
})

describe('memwalStore', () => {
  function fakeMemwal(pages: number): MemWalLike & { calls: unknown[] } {
    const calls: unknown[] = []
    return {
      calls,
      async rememberAndWait(text) {
        calls.push({ remember: text })
        return { blob_id: 'b1' }
      },
      async recall(params) {
        calls.push({ recall: params })
        return { results: [{ text: 'x', blob_id: 'b2' }] }
      },
      async listMemories(options) {
        const page = options?.cursor ? Number(options.cursor) : 0
        return {
          memories: [{}, {}],
          next_cursor: String(page + 1),
          has_more: page + 1 < pages,
        }
      },
    }
  }

  it('remembers through rememberAndWait and reads the blob id', async () => {
    const m = fakeMemwal(1)
    expect(await memwalStore(m, 'ns').remember('hi')).toEqual({ blobId: 'b1' })
  })
  it('recalls newest first', async () => {
    const m = fakeMemwal(1)
    expect(await memwalStore(m, 'ns').recall('q', 5)).toEqual([{ text: 'x', blobId: 'b2' }])
    expect(m.calls.at(-1)).toEqual({ recall: { query: 'q', limit: 5, sort: 'recent' } })
  })
  it('counts memories across every page, not just the first', async () => {
    expect(await memwalStore(fakeMemwal(3), 'ns').count()).toBe(6)
  })
  it('never calls analyze, which would hand text to the relay’s own model', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'memory.ts'), 'utf8')
    expect(source).not.toMatch(/\.analyze(AndWait)?\(/)
    expect(source).not.toMatch(/analyze\??:/)
  })
})
