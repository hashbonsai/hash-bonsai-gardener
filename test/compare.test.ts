import { describe, expect, it } from 'vitest'
import { compareWithAndWithoutMemory } from '../src/compare'
import { records } from '../src/memory'
import { GOOD, llm, memory, sources } from './roundkit'

const earlier = records.observation({ id: 'obs-4-1', epoch: 4, metric: 'players', direction: 'up', baseline: 1, statement: 'Players may keep growing.' })

const deps = (texts: string[] = []) => {
  const m = memory()
  m.texts.push(...texts)
  const model = llm(GOOD)
  return { m, model, deps: { src: sources(), memory: m, llm: model, systemPrompt: 'SYSTEM', reportUrl: 'https://aggregator.example/v1/blobs/x' } }
}

describe('compareWithAndWithoutMemory', () => {
  it('writes the epoch twice: with its earlier observations graded, and with none of them', async () => {
    const { model, deps: d } = deps([earlier, records.editorNote({ epoch: 4, note: 'Be brief.' })])
    const out = await compareWithAndWithoutMemory(d, 5)
    expect(out.recalled).toEqual({ observations: 1, graded: 1, notes: 1 })
    expect(model.calls).toHaveLength(2)

    const withMemory = JSON.parse(model.calls[0].user)
    expect(withMemory.yourEarlierObservations).toHaveLength(1)
    expect(withMemory.followups).toEqual([{ observationId: 'obs-4-1', fromEpoch: 4, toEpoch: 5, metric: 'players', before: 1, after: 2, verdict: 'continued' }])
    expect(model.calls[0].system).toContain('Be brief.')

    const without = JSON.parse(model.calls[1].user)
    expect(without.yourEarlierObservations).toEqual([])
    expect(without.followups).toEqual([])
    expect(model.calls[1].system).toBe('SYSTEM')
  })

  it('shows the notebook line only for the side that remembers', async () => {
    const out = await compareWithAndWithoutMemory(deps([earlier]).deps, 5)
    expect(out.withMemory.notebook.en).toEqual(['Epoch 4 note on players in the Standing: 1 → epoch 5: 2. it held.'])
    expect(out.withMemory.notebook.ja[0]).toContain('シーズン 4 の観察')
    expect(out.withoutMemory.notebook).toEqual({ en: [], ja: [] })
  })

  it('gives both the same facts and instructions, and leaves out earlier reports so memory is the only difference', async () => {
    const { model, deps: d } = deps([earlier])
    await compareWithAndWithoutMemory(d, 5)
    const [a, b] = model.calls.map((c) => JSON.parse(c.user))
    expect(a.facts).toEqual(b.facts)
    expect(a.previousReports).toEqual([])
    expect(b.previousReports).toEqual([])
  })

  it('writes nothing: no memory, no state', async () => {
    const { m, deps: d } = deps([earlier])
    await compareWithAndWithoutMemory(d, 5)
    expect(m.texts).toEqual([earlier])
  })

  it('says when nothing was recalled, so the two are not mistaken for a demonstration', async () => {
    const out = await compareWithAndWithoutMemory(deps().deps, 5)
    expect(out.recalled).toEqual({ observations: 0, graded: 0, notes: 0 })
  })

  it('refuses an epoch that is not over', async () => {
    await expect(compareWithAndWithoutMemory({ ...deps().deps, src: sources({ board: async () => ({ epoch: 5, endsAtMs: 0 }) }) }, 5)).rejects.toThrow(/still running/)
  })
})
