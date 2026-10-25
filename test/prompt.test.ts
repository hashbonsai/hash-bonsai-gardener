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
    expect(prompt).toContain('ランキングに 100,000 PRUNE、保有者に 50,000 PRUNE が配布されました')
    expect(prompt).toContain('ランキングに 55,000 PRUNE、保有者に 600 PRUNE が配布されました。')
    expect(prompt).not.toMatch(/PRUNE[^。\n]*が放出されました/)
    expect(prompt).toContain('放出額')
  })

  it('says the game hands PRUNE out, never that the Gardener did: not 「を配布しました」 or 「を配布した」, and the examples do not use them', () => {
    const glossary = prompt.split('\n').find((l) => l.includes('| PRUNE handed out')) ?? ''
    expect(glossary).toContain('Never 「を配布しました」 or 「を配布した」')
    expect(glossary).toContain('the Gardener holds no PRUNE')
    const rule = prompt.split('\n').find((l) => l.startsWith('10. ')) ?? ''
    expect(rule).toContain('it is handed out by the game, not by you')
    expect(rule).toContain('Never 「を配布しました」 or 「を配布した」')
    // Outside of the sentences that forbid them, the two phrases appear nowhere in the instructions.
    const without = prompt.replaceAll('Never 「を配布しました」 or 「を配布した」', '')
    expect(without).not.toContain('を配布しました')
    expect(without).not.toContain('を配布した')
  })

  describe('rule 2 and the observations', () => {
    const rule2 = prompt.split('\n').find((l) => l.startsWith('2. ')) ?? ''
    const observations = prompt.split('\n').find((l) => l.startsWith('- `observations`')) ?? ''

    it('forbids talk of price, markets, profit and the urging of a player, and no longer forbids every prediction', () => {
      expect(rule2).toContain('Never talk about the price of a token, markets, profit, returns, worth or investment, whether as a forecast or not')
      expect(rule2).toContain('Never urge a player to do anything')
      for (const urge of ['「遊べ」', '「買え」', '「こう動け」', '「裏をかけ」']) expect(rule2).toContain(urge)
      expect(rule2).not.toContain('Do not predict')
    })
    it('allows the Gardener’s own view of how the game’s measures will move', () => {
      expect(rule2).toContain('your own view of the game\'s measures')
      expect(rule2).toContain('go up, go down or stay level next epoch')
    })
    it('asks for 1 to 3 observations that say the direction they carry', () => {
      expect(observations).toContain('1 to 3 things worth checking next epoch; a report with none is refused')
      expect(observations).not.toContain('0 to 3')
      expect(observations).toContain('says the same thing as `direction`')
      expect(observations).toContain('Never write a levelling-off sentence ("keeps on at the same pace") for "up" or "down"')
    })
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
    it('has one first-person sentence of outlook on an observation, with no new number and the measure named by its glossary term', () => {
      expect(voice).toContain('Say your outlook in exactly one sentence, in the first person')
      expect(voice).toContain('Add no number to it')
      expect(voice).toContain('Name the measure with the term for its `metric`')
      for (const pair of [
        '`players` is 参加者',
        '`burns` is スコアに変換した回数',
        '`bonexpBurned` is スコアに変換した BONEXP',
        '`prizeOut` is Crown Seed に封入した賞金',
        '`mints` is ミント',
        '`arenaTrees` is アリーナの Bonsai',
        '`seededTrees` is Crown Seed を付けた Bonsai',
        '`drains` is ドレイン',
      ]) {
        expect(voice).toContain(pair)
      }
      expect(voice).toContain('Next epoch I expect a few more players in the garden.')
      expect(voice).toContain('次のシーズン、庭の参加者はもう少し増えると見ています。')
      expect(voice).toContain('but never in place of the measure')
      expect(voice).toContain('「庭が訪問者を迎えるでしょう」')
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
