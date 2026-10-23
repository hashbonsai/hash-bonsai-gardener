import type { Sources } from './collect'

/**
 * Whether epoch N can be written about yet. A report that is stored on Walrus
 * cannot be taken back, so it waits for everything that makes its figures
 * final:
 *  - the epoch is over (the board has moved on);
 *  - its PRUNE distribution is confirmed (the house bot's `advance`);
 *  - if N is a ballot epoch, the ballot's result has been applied (the house
 *    bot's `execute`, which can only be called once the ballot's epoch is over).
 *    Without it the report would go out missing the vote's result.
 * A wait that outlasts six hours is told to the operator, since it means the
 * house bot is likely stopped. An `execute` that has not come by the time the
 * board is two epochs on is given up on, and the report is written without it.
 */

export const NOTIFY_AFTER_MS = 6 * 60 * 60 * 1000

/** `governance::BALLOT_INTERVAL`. */
const BALLOT_INTERVAL = 4

export type ReadyInput = {
  epoch: number
  nowMs: number
  /** When epoch N became final: its settle event's time, else the first time this gardener saw it final. */
  finalSinceMs: number
  boardEpoch: number
  distributor: { bootstrapped: boolean; startEpoch: number; nextEpoch: number }
  governance: { bootstrapped: boolean; firstBallotEpoch: number }
  /** Whether a `BallotExecutedEvent` for this epoch's ballot exists. */
  executedForEpoch: boolean
}

export type Notice = { key: string; text: string }

export type Readiness =
  | {
      action: 'write'
      /** True when the epoch ran a ballot whose result was never applied in time: the report carries none. */
      executeMissing: boolean
    }
  | { action: 'wait'; reason: 'running' | 'distribution' | 'execute'; notice: Notice | null }

/** Ballots run in epochs `first`, `first + 4`, `first + 8`, ... */
export function isBallotEpoch(epoch: number, governance: { bootstrapped: boolean; firstBallotEpoch: number }): boolean {
  return governance.bootstrapped && epoch >= governance.firstBallotEpoch && (epoch - governance.firstBallotEpoch) % BALLOT_INTERVAL === 0
}

export function decideReadiness(i: ReadyInput): Readiness {
  if (i.boardEpoch <= i.epoch) return { action: 'wait', reason: 'running', notice: null }

  const overdue = i.nowMs - i.finalSinceMs >= NOTIFY_AFTER_MS

  const distributes = i.distributor.bootstrapped && i.epoch >= i.distributor.startEpoch
  if (distributes && i.distributor.nextEpoch <= i.epoch) {
    return {
      action: 'wait',
      reason: 'distribution',
      notice: overdue
        ? { key: `distribution-stalled-${i.epoch}`, text: `Epoch ${i.epoch} ended more than 6 hours ago and its PRUNE distribution is not confirmed. The house bot may be stopped.` }
        : null,
    }
  }

  if (isBallotEpoch(i.epoch, i.governance) && !i.executedForEpoch) {
    if (i.boardEpoch >= i.epoch + 2) return { action: 'write', executeMissing: true }
    return {
      action: 'wait',
      reason: 'execute',
      notice: overdue
        ? { key: `execute-stalled-${i.epoch}`, text: `Epoch ${i.epoch} ran a ballot that ended more than 6 hours ago and its result has not been applied. The house bot may be stopped.` }
        : null,
    }
  }

  return { action: 'write', executeMissing: false }
}

/**
 * Reads what `decideReadiness` needs. The board is read first, and nothing else
 * is asked for an epoch that is still running.
 * `firstSeenFinalMs` is when this gardener first saw the epoch final, from its own state; it
 * stands in for the settle event's time when there is no such event (an epoch rolled by a burn
 * because nobody had settled it), and `nowMs` when this is the first sighting.
 */
export async function checkReady(
  src: Pick<Sources, 'board' | 'distributor' | 'governance' | 'settles' | 'ballotsExecuted'>,
  epoch: number,
  nowMs: number,
  firstSeenFinalMs: number | null,
): Promise<Readiness> {
  const board = await src.board()
  if (board.epoch <= epoch) return { action: 'wait', reason: 'running', notice: null }

  const [distributor, governance, settles] = await Promise.all([src.distributor(), src.governance(), src.settles()])
  const ballotEpoch = isBallotEpoch(epoch, governance)
  const executed = ballotEpoch ? (await src.ballotsExecuted()).some((e) => e.ballotEpoch === epoch) : false
  const finalSinceMs = settles.find((e) => e.epoch === epoch)?.timestampMs ?? firstSeenFinalMs ?? nowMs

  return decideReadiness({
    epoch,
    nowMs,
    finalSinceMs,
    boardEpoch: board.epoch,
    distributor: { bootstrapped: distributor.bootstrapped, startEpoch: distributor.startEpoch, nextEpoch: distributor.nextEpoch },
    governance: { bootstrapped: governance.bootstrapped, firstBallotEpoch: governance.firstBallotEpoch },
    executedForEpoch: executed,
  })
}
