import { describe, expect, it } from 'vitest'
import { derivedNumbers, followUp, gradeAll, metricValue } from '../src/learn'
import type { Observation } from '../src/types'
import { sampleFacts } from './fixtures'

const obs = (over: Partial<Observation> = {}): Observation => ({
  id: 'obs-5-1',
  epoch: 5,
  metric: 'players',
  direction: 'up',
  baseline: 12,
  statement: 'Players should rise.',
  ...over,
})

const next = (over: Parameters<typeof sampleFacts>[0]) => sampleFacts({ epoch: 6, ...over })

describe('metricValue', () => {
  it('reads each metric from the facts, and null when the chain could not say', () => {
    const f = sampleFacts()
    expect(metricValue(f, 'players')).toBe(12)
    expect(metricValue(f, 'prizeOut')).toBe(25.4)
    expect(metricValue(f, 'mints')).toBe(56)
    expect(metricValue(f, 'arenaTrees')).toBe(70)
    expect(metricValue(f, 'seededTrees')).toBe(18)
    expect(metricValue(f, 'drains')).toBe(22)
    expect(metricValue(sampleFacts({ prize: null, arena: null }), 'prizeOut')).toBeNull()
    expect(metricValue(sampleFacts({ arena: null }), 'seededTrees')).toBeNull()
  })
  it('reads the mints of the epoch as unknown when only the total is known', () => {
    expect(metricValue(sampleFacts({ mints: { cumulative: 108, delta: null } }), 'mints')).toBeNull()
    expect(metricValue(sampleFacts({ mints: { cumulative: 108, delta: 0 } }), 'mints')).toBe(0)
    expect(metricValue(sampleFacts({ mints: null }), 'mints')).toBeNull()
  })
})

describe('followUp', () => {
  it('says continued when it moved the way predicted', () => {
    expect(followUp(obs(), next({ players: 20 }))).toMatchObject({ verdict: 'continued', before: 12, after: 20, fromEpoch: 5, toEpoch: 6 })
    expect(followUp(obs({ direction: 'down' }), next({ players: 3 }))?.verdict).toBe('continued')
  })
  it('says reversed when it moved the other way', () => {
    expect(followUp(obs(), next({ players: 3 }))?.verdict).toBe('reversed')
    expect(followUp(obs({ direction: 'down' }), next({ players: 30 }))?.verdict).toBe('reversed')
  })
  it('says flat when it did not move, whatever was predicted', () => {
    expect(followUp(obs(), next({ players: 12 }))?.verdict).toBe('flat')
    expect(followUp(obs({ direction: 'flat' }), next({ players: 12 }))?.verdict).toBe('flat')
  })
  it('counts a predicted "flat" that then moved as reversed', () => {
    expect(followUp(obs({ direction: 'flat' }), next({ players: 13 }))?.verdict).toBe('reversed')
  })
  it('returns null when the metric is unreadable now', () => {
    expect(followUp(obs(), next({ players: null }))).toBeNull()
  })
})

describe('gradeAll', () => {
  it('grades each earlier observation once and never against its own epoch', () => {
    const o1 = obs({ id: 'a' })
    const o2 = obs({ id: 'b', epoch: 6 })
    const o3 = obs({ id: 'c', metric: 'drains', baseline: 22, direction: 'down' })
    const got = gradeAll([o1, o2, o3], new Set(['c']), next({ players: 14 }))
    expect(got.map((f) => f.observationId)).toEqual(['a'])
  })
  it('skips an observation whose metric is unreadable instead of guessing', () => {
    expect(gradeAll([obs()], new Set(), next({ players: null }))).toEqual([])
  })
})

describe('derivedNumbers', () => {
  it('licenses the before, after and both epochs', () => {
    const f = followUp(obs(), next({ players: 20 }))!
    expect(derivedNumbers([f])).toEqual([12, 20, 5, 6])
  })
})
