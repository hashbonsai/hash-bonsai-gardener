import { describe, expect, it } from 'vitest'
import { forbiddenTermJaIn, pruneReleasedSentenceIn } from '../src/policy'
import { castSuffix, factsTable, fallbackReport, GARDENER_LONG, GARDENER_SHORT_EN, notebookLines, voteAnnouncement, voteResult } from '../src/templates'
import type { Followup } from '../src/types'
import { sampleFacts } from './fixtures'

describe('the closing sentence', () => {
  it('is exactly the agreed text, in both languages and the short form', () => {
    expect(GARDENER_LONG.en).toBe(
      "The Gardener is an AI run by the Hash Bonsai operator. It holds no permissions over the game's contracts: it calls no game or governance function, holds no PRUNE and does not vote.",
    )
    expect(GARDENER_LONG.ja).toBe(
      '庭師は Hash Bonsai の運営が動かす AI です。コントラクトに対する権限は無く、ゲームと投票の関数を呼ばず、PRUNE を持たず、投票もしません。',
    )
    expect(GARDENER_SHORT_EN).toBe('The Gardener is an AI run by the Hash Bonsai operator, with no permissions over its contracts.')
  })
  it('does not claim to hold no permissions at all (it calls Walrus’s contracts)', () => {
    expect(GARDENER_LONG.en).not.toMatch(/no permissions\.|no permissions at all/)
  })
  it('is appended to a cast after the link', () => {
    expect(castSuffix('https://x.example/b')).toBe(`\nhttps://x.example/b\n${GARDENER_SHORT_EN}`)
  })
})

describe('factsTable', () => {
  it('lists the figures the facts hold, formatted', () => {
    const t = factsTable(sampleFacts(), 'en')
    expect(t).toContain('Epoch: 5')
    expect(t).toContain('Players: 12')
    expect(t).toContain('BONEXP burned: 8,500.5')
    expect(t).toContain('Prize awarded (SUI): 25.4')
    expect(t).toContain('Crown Seeds by tier: T1×1 T2×2 T3×4')
    expect(t).toContain('Top scores: 0xabc123…cdef 4,200, 0x111111…2222 3,100.25, 0x333333…4444 900')
  })
  it('leaves out a field the chain could not read instead of inventing it', () => {
    const t = factsTable(sampleFacts({ players: null, prize: null, treasury: null, top: null }), 'en').join('\n')
    expect(t).not.toMatch(/Players|Prize|Treasury|Top scores/)
    expect(t).toContain('Burns: 40')
  })
  it('lists both mint figures when the increase is known', () => {
    expect(factsTable(sampleFacts({ mints: { cumulative: 1_234, delta: 56 } }), 'en')).toEqual(expect.arrayContaining(['Minted this epoch: 56', 'Minted in total: 1,234']))
    expect(factsTable(sampleFacts({ mints: { cumulative: 1_234, delta: 56 } }), 'ja')).toEqual(expect.arrayContaining(['このシーズンのミント: 56', '累計のミント: 1,234']))
  })
  it('shows only the total, with no row for this epoch’s mints, when the increase is not known', () => {
    for (const lang of ['en', 'ja'] as const) {
      const t = factsTable(sampleFacts({ mints: { cumulative: 108, delta: null } }), lang).join('\n')
      expect(t).toContain(lang === 'en' ? 'Minted in total: 108' : '累計のミント: 108')
      expect(t).not.toMatch(/Minted this epoch|このシーズンのミント|null/)
    }
  })
  it('shows a real zero increase as zero', () => {
    expect(factsTable(sampleFacts({ mints: { cumulative: 108, delta: 0 } }), 'en')).toContain('Minted this epoch: 0')
  })
  it('says when the Treasury figure is only a current reading', () => {
    expect(factsTable(sampleFacts({ treasury: { value: 1, asOf: 'now' } }), 'en').join('\n')).toMatch(/as of now/)
  })
  it('writes Japanese with the game’s own word for an epoch', () => {
    const t = factsTable(sampleFacts(), 'ja')
    expect(t).toContain('シーズン: 5')
    expect(t.join('\n')).not.toContain('エポック')
  })
})

describe('notebookLines', () => {
  const f: Followup = { observationId: 'obs-5-1', fromEpoch: 5, toEpoch: 6, metric: 'players', before: 3, after: 5, verdict: 'continued' }
  it('states the numbers and the verdict the code computed', () => {
    expect(notebookLines([f], 'en')).toEqual(['Epoch 5 note on players in the Standing: 3 → epoch 6: 5. it held.'])
    expect(notebookLines([f], 'ja')).toEqual(['シーズン 5 の観察(ランキングの参加者): 3 → シーズン 6: 5。続いた。'])
  })
  it('has a line for each verdict', () => {
    const lines = (['continued', 'reversed', 'flat'] as const).map((v) => notebookLines([{ ...f, verdict: v }], 'en')[0])
    expect(lines.join('\n')).toMatch(/it held[\s\S]*the other way[\s\S]*no change/)
  })
})

describe('voting notices', () => {
  it('announces the ballot with all four items, their fixed options and the quorum rule', () => {
    const lines = voteAnnouncement('en', 9)
    expect(lines[0]).toMatch(/epoch 9 is open until that epoch ends/)
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(4)
    expect(lines.join('\n')).toMatch(/Top-heavy \/ Middle \/ Wide/)
    expect(lines.join('\n')).toMatch(/6% of the Treasury \/ 8% of the Treasury \/ 10% of the Treasury/)
    expect(lines.join('\n')).toMatch(/25% of unbanked BONEXP/)
    expect(lines.at(-1)).toMatch(/10% of the circulating PRUNE and at least 1,000,000 PRUNE/)
  })
  it('announces in Japanese too', () => {
    expect(voteAnnouncement('ja', 9).join('\n')).toMatch(/シーズン 9 の投票が開いています/)
  })
  it('reports no quorum as a ballot that changed nothing', () => {
    expect(voteResult('en', 9, false, [false, false, false, false])).toEqual(['The ballot of epoch 9 was applied without quorum: nothing changed.'])
  })
  it('reports each item as applied or unchanged when quorum was met, and when it takes effect', () => {
    const lines = voteResult('en', 9, true, [true, false, true, false])
    expect(lines[0]).toMatch(/reached quorum and was applied.*next epoch; the Drain share, immediately/)
    expect(lines.slice(1)).toEqual(['- Prize shape: applied', '- Prize ceiling: unchanged', '- Drain share: applied', '- Rate curve midpoint: unchanged'])
  })
})

describe('house style in the fixed Japanese text', () => {
  const f: Followup = { observationId: 'o', fromEpoch: 4, toEpoch: 5, metric: 'drains', before: 10, after: 22, verdict: 'continued' }
  it('never uses the spellings the model is forbidden to use', () => {
    const all = [
      GARDENER_LONG.ja,
      ...factsTable(sampleFacts(), 'ja'),
      ...notebookLines([f], 'ja'),
      ...voteAnnouncement('ja', 9),
      ...voteResult('ja', 9, true, [true, false, true, false]),
      ...voteResult('ja', 9, false, [false, false, false, false]),
      fallbackReport(sampleFacts(), [f], 'ja'),
    ].join('\n')
    expect(forbiddenTermJaIn(all)).toBeNull()
    // Nor does any fixed Japanese sentence say PRUNE was 放出: the SUI prize has that word.
    expect(pruneReleasedSentenceIn(all)).toBeNull()
  })
  it('uses the screens’ wording for burns, the epoch’s pool and the prize awarded', () => {
    const table = factsTable(sampleFacts(), 'ja').join('\n')
    expect(table).toContain('スコアに変換した回数: 40')
    expect(table).toContain('スコアに変換した BONEXP: 8,500.5')
    expect(table).toContain('シーズン 5 の放出額 (SUI): 25.5')
    expect(table).toContain('Crown Seed に封入した賞金 (SUI): 25.4')
    expect(table).not.toMatch(/今週の|焼却|焼いた|取り出した|配った/)
  })
  it('uses the same wording in the notebook lines', () => {
    const f: Followup = { observationId: 'o', fromEpoch: 4, toEpoch: 5, metric: 'prizeOut', before: 20, after: 25, verdict: 'continued' }
    expect(notebookLines([f], 'ja')[0]).toContain('Crown Seed に封入した賞金')
    expect(notebookLines([{ ...f, metric: 'burns' }], 'ja')[0]).toContain('スコアに変換した回数')
    expect(notebookLines([{ ...f, metric: 'bonexpBurned' }], 'ja')[0]).toContain('スコアに変換した BONEXP')
    expect(notebookLines([{ ...f, metric: 'seededTrees' }], 'ja')[0]).toContain('Crown Seed を付けた Bonsai')
  })
  it('says 確定 for settling, as the game does, and not 清算 or 精算', () => {
    const table = factsTable(sampleFacts(), 'ja').join('\n')
    expect(table).toContain('確定後の賞金プール (SUI): 310.75')
    expect(table).not.toMatch(/清算|精算/)
  })
})

describe('fallbackReport', () => {
  it('is the figures, the notebook and the closing sentence, and says why', () => {
    const f: Followup = { observationId: 'o', fromEpoch: 4, toEpoch: 5, metric: 'drains', before: 10, after: 22, verdict: 'continued' }
    const text = fallbackReport(sampleFacts(), [f], 'en')
    expect(text).toContain('Players: 12')
    expect(text).toContain('Epoch 4 note on drains: 10 → epoch 5: 22.')
    expect(text).toContain('did not pass its checks')
    expect(text.endsWith(GARDENER_LONG.en)).toBe(true)
  })
})
