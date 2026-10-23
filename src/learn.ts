import type { Direction, Facts, Followup, Observation, ObservationMetric, Verdict } from './types'

/** The one place a metric name turns into a number in the facts. Null when the chain could not say. */
export function metricValue(facts: Facts, metric: ObservationMetric): number | null {
  switch (metric) {
    case 'players':
      return facts.players
    case 'burns':
      return facts.burns
    case 'bonexpBurned':
      return facts.bonexpBurned
    case 'prizeOut':
      return facts.prize ? facts.prize.awarded : null
    case 'mints':
      return facts.mints ? facts.mints.delta : null
    case 'arenaTrees':
      return facts.arena ? facts.arena.trees : null
    case 'seededTrees':
      return facts.arena ? facts.arena.seeded : null
    case 'drains':
      return facts.drains
  }
}

function actualDirection(before: number, after: number): Direction {
  if (after > before) return 'up'
  if (after < before) return 'down'
  return 'flat'
}

/**
 * Compares one earlier observation with this epoch's facts. The numbers and
 * the verdict are the code's; the model never grades itself.
 *
 *  - the metric did not move       → `flat`
 *  - it moved the way predicted    → `continued`
 *  - it moved the other way        → `reversed`
 *
 * An observation of "flat" that then moved either way counts as `reversed`:
 * the thing it said would hold did not.
 * Returns null when the metric is unreadable now (nothing to say).
 */
export function followUp(observation: Observation, facts: Facts): Followup | null {
  const after = metricValue(facts, observation.metric)
  if (after === null) return null
  const moved = actualDirection(observation.baseline, after)
  const verdict: Verdict = moved === 'flat' ? 'flat' : moved === observation.direction ? 'continued' : 'reversed'
  return {
    observationId: observation.id,
    fromEpoch: observation.epoch,
    toEpoch: facts.epoch,
    metric: observation.metric,
    before: observation.baseline,
    after,
    verdict,
  }
}

/**
 * Follow-ups for every observation not yet answered, for observations made
 * strictly before this epoch (an observation is never graded against its own
 * epoch), each graded once. Unreadable metrics are skipped, not guessed.
 */
export function gradeAll(observations: Observation[], answeredIds: Set<string>, facts: Facts): Followup[] {
  const out: Followup[] = []
  for (const o of observations) {
    if (o.epoch >= facts.epoch || answeredIds.has(o.id)) continue
    const f = followUp(o, facts)
    if (f) out.push(f)
  }
  return out
}

/** The numbers a follow-up gives the prose licence to use. */
export function derivedNumbers(followups: Followup[]): number[] {
  return followups.flatMap((f) => [f.before, f.after, f.fromEpoch, f.toEpoch])
}
