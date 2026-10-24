import { applyDecision, applyRedo, type StateStore } from './state'

/**
 * `npm run approve -- <epoch> [--note "..."]`, `npm run reject -- <epoch> [--note "..."]` and
 * `npm run redo -- <epoch> [--note "..."]`: the operator's decision on the draft that is waiting.
 * The next hourly round carries it out. The note is typed by the operator on the server, never
 * taken from a player. With approve or reject it becomes a memory that shapes how later reports
 * are written; with redo it goes to the model for the draft that replaces this one, and is not
 * kept as a memory. The prompt tells the model to ignore a note that disagrees with the facts.
 */

/** The epoch and the note out of the command line (anything after the program's own flags). */
export function parseDecisionArgs(argv: string[]): { epoch: number; note: string | null } {
  const rest: string[] = []
  let note: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') {
      i += 1 // the path is read elsewhere
    } else if (a === '--note') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error('--note needs the note as its next argument')
      note = next
      i += 1
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`)
    } else {
      rest.push(a)
    }
  }
  if (rest.length !== 1 || !/^\d+$/.test(rest[0])) throw new Error('give the epoch of the waiting draft, e.g. npm run approve -- 5')
  return { epoch: Number(rest[0]), note }
}

export function decide(argv: string[], status: 'approved' | 'rejected' | 'redo', store: StateStore): string {
  const { epoch, note } = parseDecisionArgs(argv)
  if (status === 'redo') {
    store.save(applyRedo(store.load(), epoch, note))
    return `Epoch ${epoch}'s draft is dropped and the next hourly round writes it again${note ? ', with your note' : ''}. The model-call limits still count the calls already made (4 a day, 16 a month).`
  }
  store.save(applyDecision(store.load(), epoch, status, note))
  const what = status === 'approved' ? 'approved' : 'rejected (it will go out as the figures alone)'
  return `Epoch ${epoch}'s draft is ${what}${note ? ', with your note' : ''}. The next hourly round carries it out.`
}
