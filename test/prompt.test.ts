import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The instructions are part of the behaviour: these are the lines the checks and the glossary rely on.
const prompt = readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8')

describe('the system prompt', () => {
  it('tells the model to write figures as given and to put a unit on every amount', () => {
    expect(prompt).toContain('write them as given, with a comma between thousands (8,500.5), and do not round them further')
    expect(prompt).toContain('Always attach the unit to an amount of a token: SUI, BONEXP or PRUNE')
  })

  it('asks for a sentence about the PRUNE released, only when there is some, with the unit', () => {
    expect(prompt).toContain('`prune.standingEmission` or `prune.holderEmission` is greater than 0')
    expect(prompt).toContain('55,000 PRUNE went to the Standing and 600 PRUNE to holders')
    expect(prompt).toContain('When `prune` is null, or both amounts are 0, say nothing about PRUNE.')
  })

  it('says PRUNE is 配布 in Japanese, and never 放出, which is the SUI prize’s word', () => {
    expect(prompt).toContain('ランキングに 100,000 PRUNE、保有者に 50,000 PRUNE を配布しました')
    expect(prompt).toContain('ランキングに 55,000 PRUNE、保有者に 600 PRUNE を配布しました。')
    expect(prompt).not.toMatch(/PRUNE[^。\n]*が放出されました/)
    expect(prompt).toContain('放出額')
  })

  it('does not ask for the amount left, nor for what PRUNE is worth', () => {
    expect(prompt).toContain('Say nothing about how much is left or about what PRUNE is worth.')
  })

  it('names the Japanese term to use where the check refuses a spelling', () => {
    for (const term of ['盆栽', 'エポック', '精算', 'バーン']) expect(prompt).toContain(term)
    expect(prompt).toContain('ランキング')
    expect(prompt).toContain('庭師')
  })
})
