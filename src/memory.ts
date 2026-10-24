import { holdsSecret } from './redact'
import { OBSERVATION_METRICS, type EditorNote, type Facts, type Followup, type Observation } from './types'

/**
 * The gardener's learning memory, kept in Walrus Memory (MemWal): its own
 * observations, the checks of those observations, the epoch facts it saw, and
 * the operator's notes. Public chain facts and the gardener's own words only —
 * the relay can see plaintext before it encrypts, so no secret and nothing a
 * player wrote ever goes in (`remember` refuses anything key-shaped).
 *
 * One memory is one short record: the first line is machine-readable
 * (`gardener:<kind> <json>`), the second a plain sentence for semantic recall.
 */

export type MemoryKind = 'epoch-facts' | 'observation' | 'followup' | 'editor-note'

export type StoredRecall = { text: string; blobId: string }

/** What the rest of the code needs from a memory; MemWal is one implementation. */
export interface MemoryStore {
  remember(text: string): Promise<{ blobId: string }>
  recall(query: string, limit: number): Promise<StoredRecall[]>
  /** Memories this account holds in its namespace. */
  count(): Promise<number>
}

/** `--no-memory`: reads nothing, writes nothing. */
export const nullStore: MemoryStore = {
  async remember() {
    return { blobId: '' }
  },
  async recall() {
    return []
  },
  async count() {
    return 0
  },
}

// ── MemWal ────────────────────────────────────────────────────────────────

/** The slice of `MemWal` used here — a structural type so a test can pass a fake. `analyze` is deliberately absent. */
export interface MemWalLike {
  rememberAndWait(text: string): Promise<{ blob_id: string }>
  recall(params: { query: string; limit?: number; sort?: 'relevance' | 'recent' }): Promise<{ results: { text: string; blob_id: string }[] }>
  listMemories(options?: { cursor?: string; limit?: number; namespace?: string }): Promise<{
    memories: unknown[]
    next_cursor: string | null
    has_more: boolean
  }>
}

export function memwalStore(memwal: MemWalLike, namespace: string): MemoryStore {
  return {
    async remember(text) {
      const r = await memwal.rememberAndWait(text)
      return { blobId: r.blob_id }
    },
    async recall(query, limit) {
      const r = await memwal.recall({ query, limit, sort: 'recent' })
      return r.results.map((m) => ({ text: m.text, blobId: m.blob_id }))
    },
    async count() {
      let total = 0
      let cursor: string | undefined
      for (let page = 0; page < 1000; page++) {
        const r = await memwal.listMemories({ cursor, namespace, limit: 500 })
        total += r.memories.length
        if (!r.has_more) break
        cursor = r.next_cursor ?? undefined
      }
      return total
    },
  }
}

// ── Records ───────────────────────────────────────────────────────────────

const PREFIX = 'gardener:'

export function encodeRecord(kind: MemoryKind, payload: unknown, sentence: string): string {
  const text = `${PREFIX}${kind} ${JSON.stringify(payload)}\n${sentence}`
  if (holdsSecret(text)) throw new Error(`refusing to remember a ${kind} record that holds a secret`)
  return text
}

export function decodeRecord(text: string): { kind: MemoryKind; payload: unknown } | null {
  const first = text.split('\n', 1)[0]
  if (!first.startsWith(PREFIX)) return null
  const space = first.indexOf(' ')
  if (space === -1) return null
  const kind = first.slice(PREFIX.length, space)
  if (kind !== 'epoch-facts' && kind !== 'observation' && kind !== 'followup' && kind !== 'editor-note') return null
  try {
    return { kind, payload: JSON.parse(first.slice(space + 1)) }
  } catch {
    return null
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function asObservation(p: unknown): Observation | null {
  const o = p as Partial<Observation> | null
  if (!o || typeof o.id !== 'string' || !isNum(o.epoch) || !isNum(o.baseline) || typeof o.statement !== 'string') return null
  if (!(OBSERVATION_METRICS as readonly string[]).includes(o.metric as string)) return null
  if (o.direction !== 'up' && o.direction !== 'down' && o.direction !== 'flat') return null
  return o as Observation
}

export function asFollowup(p: unknown): Followup | null {
  const f = p as Partial<Followup> | null
  if (!f || typeof f.observationId !== 'string' || !isNum(f.fromEpoch) || !isNum(f.toEpoch) || !isNum(f.before) || !isNum(f.after)) return null
  if (f.verdict !== 'continued' && f.verdict !== 'reversed' && f.verdict !== 'flat') return null
  return f as Followup
}

export function asEditorNote(p: unknown): EditorNote | null {
  const n = p as Partial<EditorNote> | null
  if (!n || !isNum(n.epoch) || typeof n.note !== 'string') return null
  return n as EditorNote
}

export const records = {
  epochFacts(facts: Facts): string {
    const summary = {
      epoch: facts.epoch,
      players: facts.players,
      burns: facts.burns,
      bonexpBurned: facts.bonexpBurned,
      prizeOut: facts.prize?.awarded ?? null,
      mints: facts.mints?.delta ?? null,
      drains: facts.drains,
      // The Arena can only be read as it stands now, so these are null for an epoch long past.
      arenaTrees: facts.arena?.trees ?? null,
      seededTrees: facts.arena?.seeded ?? null,
      pruneStanding: facts.prune?.standingEmission ?? null,
      pruneHolder: facts.prune?.holderEmission ?? null,
    }
    return encodeRecord('epoch-facts', summary, `Epoch ${facts.epoch}: ${facts.players ?? 'unknown'} players, ${facts.burns ?? 'unknown'} burns.`)
  },
  observation(o: Observation): string {
    return encodeRecord('observation', o, `Epoch ${o.epoch} observation about ${o.metric} (${o.direction}): ${o.statement}`)
  },
  followup(f: Followup): string {
    return encodeRecord('followup', f, `Observation ${f.observationId} checked in epoch ${f.toEpoch}: ${f.verdict}.`)
  },
  editorNote(n: EditorNote): string {
    return encodeRecord('editor-note', n, `Operator note from epoch ${n.epoch}: ${n.note}`)
  },
}

// ── One round's reads and writes ──────────────────────────────────────────

export type Recalled = {
  /** Unanswered observations from earlier epochs, newest first, at most 10. */
  observations: Observation[]
  /** The operator's last 5 notes, newest first. */
  notes: EditorNote[]
  /** Blob ids of everything that was read, for the report's `memory.recalled`. */
  blobIds: string[]
}

/**
 * Reads what the next report needs. Observations that already have a
 * follow-up are dropped, so each is graded once. A single memory that does
 * not decode contributes nothing. A relay that fails throws: the caller
 * (the round's entry point) catches it and writes the report without memory
 * rather than not at all.
 */
export async function recallForEpoch(store: MemoryStore): Promise<Recalled> {
  const [obsRaw, followRaw, noteRaw] = await Promise.all([
    store.recall(`${PREFIX}observation`, 40),
    store.recall(`${PREFIX}followup`, 60),
    store.recall(`${PREFIX}editor-note`, 20),
  ])
  const answered = new Set<string>()
  for (const m of followRaw) {
    const d = decodeRecord(m.text)
    const f = d?.kind === 'followup' ? asFollowup(d.payload) : null
    if (f) answered.add(f.observationId)
  }
  const blobIds: string[] = []
  const observations: Observation[] = []
  for (const m of obsRaw) {
    const d = decodeRecord(m.text)
    const o = d?.kind === 'observation' ? asObservation(d.payload) : null
    if (o && !answered.has(o.id) && !observations.some((x) => x.id === o.id)) {
      observations.push(o)
      blobIds.push(m.blobId)
    }
  }
  observations.sort((a, b) => b.epoch - a.epoch)
  const notes: EditorNote[] = []
  for (const m of noteRaw) {
    const d = decodeRecord(m.text)
    const n = d?.kind === 'editor-note' ? asEditorNote(d.payload) : null
    if (n) {
      notes.push(n)
      blobIds.push(m.blobId)
    }
  }
  notes.sort((a, b) => b.epoch - a.epoch)
  return { observations: observations.slice(0, 10), notes: notes.slice(0, 5), blobIds }
}

/**
 * The epochs this namespace already holds an `epoch-facts` memory for. The memory itself is the
 * record of what was written, so a backfill that is run twice, or from two machines, writes each
 * epoch once.
 */
export async function epochsRemembered(store: MemoryStore): Promise<Set<number>> {
  const found = new Set<number>()
  for (const m of await store.recall(`${PREFIX}epoch-facts`, 200)) {
    const d = decodeRecord(m.text)
    const epoch = d?.kind === 'epoch-facts' ? (d.payload as { epoch?: unknown } | null)?.epoch : undefined
    if (typeof epoch === 'number' && Number.isInteger(epoch)) found.add(epoch)
  }
  return found
}

export type WriteOutcome = {
  written: string[]
  failed: number
  /** The records that did not go in, to try again next round. */
  failedTexts: string[]
}

/**
 * Writes records one at a time. A relay that fails loses only that record and
 * is counted, never thrown: the report is the product, memory is the extra,
 * and a failed write is retried by writing again next round.
 */
export async function writeRecords(store: MemoryStore, texts: string[]): Promise<WriteOutcome> {
  const written: string[] = []
  const failedTexts: string[] = []
  for (const t of texts) {
    try {
      const r = await store.remember(t)
      written.push(r.blobId)
    } catch {
      failedTexts.push(t)
    }
  }
  return { written, failed: failedTexts.length, failedTexts }
}
