import { fundsAllowance, llmAllowance, budgetedProvider, type LlmLimits } from './budget'
import { collectRawEpoch, type Sources } from './collect'
import { buildFacts } from './facts'
import type { LlmProvider } from './llm'
import { gradeAll } from './learn'
import { records, recallForEpoch, writeRecords, type MemoryStore, type Recalled } from './memory'
import { tell, type Notifier } from './notify'
import { checkReady } from './ready'
import { redact } from './redact'
import { buildReport, readEarlier, sha256Hex } from './report'
import type { Draft, Pending, State, StateStore } from './state'
import { castSuffix, GARDENER_SHORT_EN, voteAnnouncement, voteResult } from './templates'
import type { ReportStore } from './walrus'
import { composeReport, operatorNotice } from './write'

/**
 * One hourly round of the gardener (plan §4-2). It does one of: wait (an epoch
 * is not final), stop (a cost brake), draft a report for a person to approve,
 * or publish one. A report is saved as a draft before anything is published,
 * so a failure at Walrus is retried next round without calling the model again.
 */

export type RoundConfig = {
  /** Hold every report for a person to approve (`npm run approve`) before it is stored. */
  requireApproval: boolean
  /** Read and write Walrus Memory; off for `--no-memory`. */
  useMemory: boolean
  /** Compose and show, but store, remember, post and save nothing. */
  dryRun: boolean
}

export type RoundDeps = {
  config: RoundConfig
  nowMs: () => number
  state: StateStore
  src: Sources
  memory: MemoryStore
  llm: LlmProvider
  store: ReportStore
  notifier: Notifier
  systemPrompt: string
  /** Replaces the model-call limits; only a testnet rehearsal may (see `config.ts`). */
  limits?: LlmLimits
  log: (line: string) => void
}

export type RoundOutcome =
  | { kind: 'waiting'; epoch: number; reason: 'running' | 'distribution' | 'execute' }
  | { kind: 'blocked'; epoch: number; reason: string }
  | { kind: 'awaiting-approval'; epoch: number }
  | { kind: 'published'; epoch: number; blobId: string }
  | { kind: 'dry-run'; epoch: number; draft: Draft }
  | { kind: 'failed'; epoch: number | null; error: string }

/** About how big a report is, for working out what a save will cost before the model is called. */
const ESTIMATED_REPORT_BYTES = 30_000
/** The ones before it that the model reads for continuity. */
const PREVIOUS_REPORTS = 4
/** More than this many epochs behind, the gardener skips to the latest rather than write old news. */
const MAX_LAG = 1
/** A real blob id is 43 characters; only its length matters for the cast. */
const PLACEHOLDER_BLOB_ID = '0'.repeat(43)

export async function runRound(deps: RoundDeps): Promise<RoundOutcome> {
  const state = deps.state.load()
  const now = deps.nowMs()
  let epoch: number | null = state.pending?.epoch ?? null
  const persist = () => {
    if (!deps.config.dryRun) deps.state.save(state)
  }
  const say = (key: string | null, text: string) => (deps.config.dryRun ? deps.notifier.send(text) : tell(deps.notifier, state, now, key, text))

  try {
    if (state.pending) {
      const p = state.pending
      if (p.status === 'awaiting') {
        await say(`awaiting-${p.epoch}`, `Epoch ${p.epoch}'s draft is waiting for a decision: npm run approve -- ${p.epoch}  or  npm run reject -- ${p.epoch}`)
        persist()
        return { kind: 'awaiting-approval', epoch: p.epoch }
      }
      return await publish(deps, state, p, persist, say)
    }

    // Which epoch is next. An epoch is written once it is final; one that fell far behind is skipped.
    const board = await deps.src.board()
    epoch = state.lastReportedEpoch + 1
    if (board.epoch - 1 > epoch + MAX_LAG) {
      const latest = board.epoch - 1
      await say(`skipped-to-${latest}`, `The gardener is ${latest - epoch} epochs behind (next was epoch ${epoch}, the latest final is ${latest}); it will write epoch ${latest} and not the ones between.`)
      state.lastReportedEpoch = latest - 1
      epoch = latest
    }
    if (board.epoch > epoch && state.firstSeenFinalMs[String(epoch)] === undefined) state.firstSeenFinalMs[String(epoch)] = now

    const ready = await checkReady(deps.src, epoch, now, state.firstSeenFinalMs[String(epoch)] ?? null)
    if (ready.action === 'wait') {
      if (ready.notice) await say(ready.notice.key, ready.notice.text)
      persist()
      return { kind: 'waiting', epoch, reason: ready.reason }
    }

    // The facts.
    const balances = await deps.src.balances()
    const spent = state.lastBalances && BigInt(state.lastBalances.sui) > balances.sui ? BigInt(state.lastBalances.sui) - balances.sui : 0n
    const { raw, problems } = await collectRawEpoch(deps.src, epoch, { spentThisEpoch: spent })
    const facts = buildFacts(raw)
    for (const p of problems) deps.log(`unreadable: ${p}`)

    // The cost brakes, before anything is spent.
    const maxEpochs = await deps.store.maxEpochs()
    const cost = await deps.store.estimate(ESTIMATED_REPORT_BYTES, maxEpochs)
    const gate = [llmAllowance(state.llmCallsMs, now, deps.limits), fundsAllowance(balances, cost)].find((a) => !a.ok)
    if (gate && !gate.ok) {
      await say(`budget-${epoch}`, `Epoch ${epoch}'s report is held back: ${gate.reason}. Nothing was stored or posted.`)
      persist()
      return { kind: 'blocked', epoch, reason: gate.reason }
    }

    // What the gardener remembers, and the reports before this one.
    let recalled: Recalled = { observations: [], notes: [], blobIds: [] }
    if (deps.config.useMemory) {
      try {
        recalled = await recallForEpoch(deps.memory)
      } catch (e) {
        deps.log(`memory could not be read: ${redact(e instanceof Error ? e.message : String(e))}`)
        await say('memory-unreadable', 'Walrus Memory could not be read this round; the report is written without it.')
      }
    }
    const followups = gradeAll(recalled.observations, new Set(), facts)
    const previousReports = await loadPrevious(deps.store, state.previousBlobId, deps.log)

    // The words.
    const llm = budgetedProvider(deps.llm, state, deps.nowMs, deps.limits)
    const written = await composeReport(llm, {
      facts,
      followups,
      observations: recalled.observations,
      notes: recalled.notes,
      previousReports,
      systemPrompt: deps.systemPrompt,
      reportUrl: deps.store.url(PLACEHOLDER_BLOB_ID),
    })
    const notice = operatorNotice(written, epoch)
    if (notice) await say(`fallback-${epoch}`, notice)

    const draft: Draft = {
      facts,
      followups,
      commentary: written.fallback ? { en: '', ja: '' } : written.text,
      cast: written.cast,
      observations: written.observations,
      fallback: written.fallback,
      fallbackReason: written.fallbackReason,
      executeMissing: ready.executeMissing,
      model: llm.servedModel?.() ?? 'none',
      promptSha256: sha256Hex(deps.systemPrompt),
      attempts: written.attempts,
      generatedAt: new Date(now).toISOString(),
      recalledBlobIds: recalled.blobIds,
      readable: written.text,
    }

    if (deps.config.dryRun) {
      deps.log(`dry run: epoch ${epoch} composed (${draft.fallback ? `figures only: ${draft.fallbackReason}` : `${draft.attempts} attempt(s), model ${draft.model}`}); nothing stored`)
      await deps.notifier.send(draftMessage(epoch, draft, deps.store.url(PLACEHOLDER_BLOB_ID), false))
      return { kind: 'dry-run', epoch, draft }
    }

    const pending: Pending = {
      epoch,
      createdAtMs: now,
      status: deps.config.requireApproval ? 'awaiting' : 'approved',
      note: null,
      draft,
      memoryWritten: null,
    }
    state.pending = pending
    persist()

    if (pending.status === 'awaiting') {
      await deps.notifier.send(draftMessage(epoch, draft, deps.store.url(PLACEHOLDER_BLOB_ID), true))
      return { kind: 'awaiting-approval', epoch }
    }
    return await publish(deps, state, pending, persist, say)
  } catch (e) {
    const message = redact(e instanceof Error ? e.message : String(e))
    deps.log(`round failed: ${message}`)
    await say('round-failed', `The gardener's round failed${epoch === null ? '' : ` (epoch ${epoch})`}: ${message.slice(0, 400)}`).catch(() => {})
    persist()
    return { kind: 'failed', epoch, error: message }
  }
}

// ── Publishing ──────────────────────────────────────────────────────────────

type Say = (key: string | null, text: string) => Promise<unknown>

async function publish(deps: RoundDeps, state: State, pending: Pending, persist: () => void, say: Say): Promise<RoundOutcome> {
  const epoch = pending.epoch
  const now = deps.nowMs()
  // A draft the operator rejected goes out as the figures alone, and teaches the gardener nothing it said.
  const draft: Draft =
    pending.status === 'rejected'
      ? { ...pending.draft, commentary: { en: '', ja: '' }, fallback: true, fallbackReason: 'withheld', observations: [] }
      : pending.draft

  const balances = await deps.src.balances()
  const maxEpochs = await deps.store.maxEpochs()
  const cost = await deps.store.estimate(ESTIMATED_REPORT_BYTES, maxEpochs)
  const funds = fundsAllowance(balances, cost)
  if (!funds.ok) {
    await say(`budget-${epoch}`, `Epoch ${epoch}'s report is approved but held back: ${funds.reason}. Nothing was stored or posted; it is tried again next round.`)
    persist()
    return { kind: 'blocked', epoch, reason: funds.reason }
  }

  // Memory first, so the stored report can name the memories it wrote. A relay that fails
  // costs only the memories, which are tried again next round; the report goes out regardless.
  if (pending.memoryWritten === null) {
    const texts = [
      ...state.memoryBacklog,
      records.epochFacts(draft.facts),
      ...draft.followups.map(records.followup),
      ...draft.observations.map(records.observation),
      ...(pending.note ? [records.editorNote({ epoch, note: pending.note })] : []),
    ]
    const outcome = deps.config.useMemory ? await writeRecords(deps.memory, texts) : { written: [], failed: 0, failedTexts: [] as string[] }
    state.memoryBacklog = outcome.failedTexts
    pending.memoryWritten = outcome.written.filter((id) => id !== '')
    if (outcome.failed > 0) await say('memory-write-failed', `${outcome.failed} memory record(s) could not be written to Walrus Memory; they will be tried again next round.`)
    persist()
  }

  const report = buildReport(draft, state.previousBlobId, pending.memoryWritten)
  let saved
  try {
    saved = await deps.store.save(report, maxEpochs)
  } catch (e) {
    const message = redact(e instanceof Error ? e.message : String(e))
    await say(`save-failed-${epoch}`, `Epoch ${epoch}'s report could not be stored on Walrus: ${message.slice(0, 300)}. It is kept and tried again next round.`)
    persist()
    return { kind: 'failed', epoch, error: message }
  }

  state.reports = [...state.reports, { epoch, blobId: saved.blobId, objectId: saved.objectId, endEpoch: saved.endEpoch, savedAtMs: now }].slice(-50)
  state.previousBlobId = saved.blobId
  state.lastReportedEpoch = epoch
  state.pending = null
  state.lastBalances = { sui: balances.sui.toString(), wal: balances.wal.toString() }
  delete state.firstSeenFinalMs[String(epoch)]
  persist()

  const url = deps.store.url(saved.blobId)
  const memoryCount = deps.config.useMemory ? await deps.memory.count().catch(() => null) : null
  await deps.notifier.send(publishedMessage(epoch, draft, url, saved.objectId, saved.endEpoch, pending.memoryWritten.length, memoryCount, balances))

  // The ballot's fixed notices, each made once.
  const ballot = draft.facts.ballot
  if (ballot?.open && !state.announced.opened.includes(ballot.open.epoch)) {
    state.announced.opened.push(ballot.open.epoch)
    await deps.notifier.send(`Ballot notice for Farcaster and X (fixed text):\n${voteAnnouncement('en', ballot.open.epoch).join('\n')}\n\n${voteAnnouncement('ja', ballot.open.epoch).join('\n')}`)
  }
  if (ballot?.executed && !state.announced.applied.includes(ballot.executed.epoch)) {
    const { epoch: e, quorumMet, applied } = ballot.executed
    state.announced.applied.push(e)
    await deps.notifier.send(`Ballot result for Farcaster and X (fixed text):\n${voteResult('en', e, quorumMet, applied).join('\n')}\n\n${voteResult('ja', e, quorumMet, applied).join('\n')}`)
  }
  persist()
  return { kind: 'published', epoch, blobId: saved.blobId }
}

// ── Reading earlier reports ─────────────────────────────────────────────────

/** The English commentary of up to four earlier reports, newest first, following each report's link to the one before. */
export async function loadPrevious(store: ReportStore, newestBlobId: string | null, log: (line: string) => void): Promise<string[]> {
  const out: string[] = []
  let blobId = newestBlobId
  for (let i = 0; i < PREVIOUS_REPORTS && blobId !== null; i++) {
    try {
      const earlier = readEarlier(await store.read(blobId))
      if (!earlier) {
        log(`blob ${blobId} is not a report of this schema; the earlier reports are left out`)
        break
      }
      if (earlier.commentaryEn.trim() !== '') out.push(earlier.commentaryEn)
      blobId = earlier.previousBlobId
    } catch (e) {
      log(`an earlier report could not be read: ${redact(e instanceof Error ? e.message : String(e))}`)
      break
    }
  }
  return out
}

// ── What the operator is shown ──────────────────────────────────────────────

function draftMessage(epoch: number, draft: Draft, url: string, awaiting: boolean): string {
  const how = draft.fallback ? `figures only (${draft.fallbackReason})` : `${draft.attempts} attempt(s), model ${draft.model}`
  return [
    `Epoch ${epoch} draft${awaiting ? ' — waiting for your decision' : ' (dry run)'}: ${how}${draft.executeMissing ? '; the ballot result was never applied in time' : ''}`,
    '',
    '— English —',
    draft.readable.en,
    '',
    '— 日本語 —',
    draft.readable.ja,
    '',
    '— Farcaster cast (by hand for now) —',
    `${draft.cast}${castSuffix(url)}`,
    ...(awaiting ? ['', `Approve:  npm run approve -- ${epoch} [--note "how to write next time"]`, `Reject:   npm run reject -- ${epoch} [--note "why"]`] : []),
  ].join('\n')
}

function publishedMessage(
  epoch: number,
  draft: Draft,
  url: string,
  objectId: string,
  endEpoch: number,
  memoriesWritten: number,
  memoryCount: number | null,
  balances: { sui: bigint; wal: bigint },
): string {
  return [
    `Epoch ${epoch} report published${draft.fallback ? ` (figures only: ${draft.fallbackReason})` : ''}.`,
    `Walrus blob: ${url}`,
    `object ${objectId}, stored through Walrus epoch ${endEpoch}, not deletable`,
    '',
    '— Farcaster cast / X announcement (by hand for now) —',
    `${draft.cast}\n${url}\n${GARDENER_SHORT_EN}`,
    '',
    `Memories written this round: ${memoriesWritten}${memoryCount === null ? '' : `; the namespace now holds ${memoryCount}`}`,
    `Gardener balances: ${Number(balances.sui) / 1e9} SUI, ${Number(balances.wal) / 1e9} WAL`,
  ].join('\n')
}
