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

  it('says the epoch 「が確定しました」, and never that anyone 「を確定しました」 it, in the glossary’s Settle row', () => {
    const row = prompt.split('\n').find((l) => l.includes('| Settle |')) ?? ''
    expect(row).toContain('「シーズン N が確定しました」')
    expect(row).toContain('never 「シーズン N を確定しました」 or 「…を確定した」')
    expect(row).toContain('the Gardener calls no game function')
  })

  describe('the Voice section', () => {
    const voice = prompt.slice(prompt.indexOf('## Voice'), prompt.indexOf('## Rules'))

    it('sits between what to write and the rules', () => {
      expect(prompt.indexOf('## What to write')).toBeLessThan(prompt.indexOf('## Voice'))
      expect(voice.length).toBeGreaterThan(200)
    })
    it('makes the writer a quiet one who speaks as "I" and 「私」, in short calm sentences', () => {
      expect(voice).toContain('walks the garden once an epoch')
      expect(voice).toContain('"I" in English, 「私」 in Japanese')
      expect(voice).toContain('Short, calm sentences')
    })
    it('asks for one first-person sentence of looking back when there are follow-ups, with the numbers as given, and honesty about a miss', () => {
      expect(voice).toContain('exactly one sentence')
      expect(voice).toContain('`before` and `after` numbers')
      expect(voice).toContain('If it did not come true, say so plainly')
      expect(voice).toContain('With none, do not look back')
    })
    it('allows one garden image at most, in the last sentence, and never for a game term or a figure', () => {
      expect(voice).toContain('once at most, and only for the impression of the last sentence')
      expect(voice).toContain('Never use an image in place of a game term or a figure')
      expect(prompt).not.toContain('metaphor is welcome')
    })
    it('leaves the figures to the table: at most 4 from the facts per language, the look back and the epoch number not counted', () => {
      expect(prompt).toContain('does not need to repeat them')
      expect(voice).toContain('do not read the figures out')
      expect(voice).toContain('Use at most 4 figures from `facts` in each language')
      expect(voice).toContain('The figures of the look back below do not count toward the 4, nor does an epoch\'s number')
      expect(prompt).toContain('no more than 4 numbers from `facts` in each language')
    })
    it('never writes a wallet address, not even a short one', () => {
      expect(voice).toContain('A wallet address is never written in the commentary')
      expect(prompt).toContain('Never write a wallet address (anything that starts with 0x)')
      expect(prompt).not.toContain('Mention a player only through the short address')
    })
    it('counts the PRUNE sentence’s amounts among the 4', () => {
      expect(prompt).toContain('The amounts in that sentence count toward the 4 figures of rule 1.')
    })
    it('lists what not to write', () => {
      for (const line of [
        'Do not state a cause or a reason that the facts do not give',
        'Do not tell any player what to do',
        'prices, profit, returns or an advantage to those who came early',
        'Do not call a player a gardener (「庭師」), and do not use emoji',
        'Do not write "$PRUNE"',
        '「剪定」 or 「刈り取」',
      ]) {
        expect(voice).toContain(line)
      }
    })
    it('takes 庭師 out of the glossary’s Gardener row: the commentary does not name itself', () => {
      const row = prompt.split('\n').find((l) => l.includes('| Gardener |')) ?? ''
      expect(row).toContain('you speak as 「私」')
      expect(row).toContain('Never 「庭師」')
    })
  })

  it('names the Japanese term to use where the check refuses a spelling', () => {
    for (const term of ['盆栽', 'エポック', '精算', 'バーン']) expect(prompt).toContain(term)
    expect(prompt).toContain('ランキング')
    expect(prompt).toContain('庭師')
  })
})
