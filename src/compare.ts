import { collectRawEpoch, type Sources } from './collect'
import { buildFacts } from './facts'
import { gradeAll } from './learn'
import type { LlmProvider } from './llm'
import { recallForEpoch, type MemoryStore } from './memory'
import { notebookLines } from './templates'
import type { Followup, Observation } from './types'
import { composeReport } from './write'

/**
 * The same epoch written twice, once with what the gardener remembers and once
 * without: for showing what the memory changes. Both get the same facts and the
 * same instructions; the first also gets its earlier observations, their grades
 * and the operator's notes. The earlier reports are left out of both, so that the
 * only difference is the memory. Nothing is stored, remembered, counted or posted.
 */

export type Side = {
  text: { en: string; ja: string }
  cast: string
  observations: Observation[]
  notebook: { en: string[]; ja: string[] }
  fallback: boolean
  attempts: number
}

export type Comparison = {
  withMemory: Side
  withoutMemory: Side
  /** What the memory gave the first: how many earlier observations, graded ones, and notes. */
  recalled: { observations: number; graded: number; notes: number }
}

export type CompareDeps = {
  src: Sources
  memory: MemoryStore
  llm: LlmProvider
  systemPrompt: string
  reportUrl: string
}

export async function compareWithAndWithoutMemory(deps: CompareDeps, epoch: number): Promise<Comparison> {
  const { raw } = await collectRawEpoch(deps.src, epoch, { spentThisEpoch: 0n })
  const facts = buildFacts(raw)
  const recalled = await recallForEpoch(deps.memory)
  const followups: Followup[] = gradeAll(recalled.observations, new Set(), facts)

  const write = async (observations: Observation[], notes: typeof recalled.notes, graded: Followup[]): Promise<Side> => {
    const r = await composeReport(deps.llm, {
      facts,
      followups: graded,
      observations,
      notes,
      previousReports: [],
      systemPrompt: deps.systemPrompt,
      reportUrl: deps.reportUrl,
    })
    return {
      text: r.text,
      cast: r.cast,
      observations: r.observations,
      notebook: { en: notebookLines(graded, 'en'), ja: notebookLines(graded, 'ja') },
      fallback: r.fallback,
      attempts: r.attempts,
    }
  }

  return {
    withMemory: await write(recalled.observations, recalled.notes, followups),
    withoutMemory: await write([], [], []),
    recalled: { observations: recalled.observations.length, graded: followups.length, notes: recalled.notes.length },
  }
}
