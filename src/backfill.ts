import { collectRawEpoch, NotFinalError, type Sources } from './collect'
import { buildFacts } from './facts'
import { epochsRemembered, records, type MemoryStore } from './memory'
import { redact } from './redact'

/**
 * Gives the gardener a memory of the epochs before it began: one `epoch-facts`
 * record for each epoch that is already final and that the hourly rounds will
 * not write about (those before `firstEpoch`). No observations are made up for
 * them. The memory itself is the record of what was written, so running this
 * twice, or from two machines, writes each epoch once.
 *
 * The Arena can only be read as it stands now, so only the most recent final
 * epoch carries it; run this soon after an epoch ends to keep that figure.
 */

export type BackfillDeps = {
  src: Sources
  memory: MemoryStore
  /** The first epoch the hourly rounds write about; the backfill stops before it, so no epoch is written by both. */
  firstEpoch: number
  dryRun: boolean
  log: (line: string) => void
}

export type BackfillResult = {
  /** Written (or, in a dry run, that would be). */
  written: number[]
  /** Already in the memory. */
  already: number[]
  /** Before `firstEpoch` but not over yet. */
  notFinal: number[]
  failed: { epoch: number; reason: string }[]
  /** How many memories the namespace holds afterwards; null if it could not be counted. */
  memories: number | null
}

export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const result: BackfillResult = { written: [], already: [], notFinal: [], failed: [], memories: null }
  const board = await deps.src.board()
  const remembered = await epochsRemembered(deps.memory)

  for (let epoch = 1; epoch < deps.firstEpoch; epoch++) {
    if (epoch >= board.epoch) {
      result.notFinal.push(epoch)
      continue
    }
    if (remembered.has(epoch)) {
      result.already.push(epoch)
      continue
    }
    try {
      const { raw, problems } = await collectRawEpoch(deps.src, epoch, { spentThisEpoch: 0n })
      for (const p of problems) deps.log(`epoch ${epoch}: unreadable: ${p}`)
      const text = records.epochFacts(buildFacts(raw))
      if (deps.dryRun) {
        deps.log(`epoch ${epoch}: would write\n${text}`)
      } else {
        await deps.memory.remember(text)
        deps.log(`epoch ${epoch}: written`)
      }
      result.written.push(epoch)
    } catch (e) {
      const reason = redact(e instanceof Error ? e.message : String(e)).slice(0, 200)
      if (e instanceof NotFinalError) result.notFinal.push(epoch)
      else result.failed.push({ epoch, reason })
      deps.log(`epoch ${epoch}: ${e instanceof NotFinalError ? 'not final yet' : `failed: ${reason}`}`)
    }
  }

  result.memories = await deps.memory.count().catch(() => null)
  return result
}
