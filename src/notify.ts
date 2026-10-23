import { redact } from './redact'
import type { State } from './state'

/**
 * Tells the operator. A notice never carries a key or the webhook's own URL,
 * the same problem is told once a day however often a round meets it, and a
 * Discord that does not answer is logged and never stops a round.
 */

export interface Notifier {
  send(text: string): Promise<void>
}

const DAY_MS = 24 * 60 * 60 * 1000
const DISCORD_LIMIT = 1900

/** Cuts `text` into pieces of at most `limit` characters, at line breaks where it can. */
export function chunk(text: string, limit = DISCORD_LIMIT): string[] {
  const pieces: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    const next = current === '' ? line : `${current}\n${line}`
    if (next.length <= limit) {
      current = next
      continue
    }
    if (current !== '') pieces.push(current)
    let rest = line
    while (rest.length > limit) {
      pieces.push(rest.slice(0, limit))
      rest = rest.slice(limit)
    }
    current = rest
  }
  if (current !== '') pieces.push(current)
  return pieces
}

/** Discord, by webhook. The URL is a secret: it is held here and never printed. A long text goes as several messages. */
export function discordNotifier(webhookUrl: string, options: { fetch?: typeof fetch; log?: (line: string) => void } = {}): Notifier {
  const doFetch = options.fetch ?? fetch
  const log = options.log ?? (() => {})
  return {
    async send(text) {
      for (const content of chunk(redact(text, [webhookUrl]))) {
        try {
          const response = await doFetch(webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application' + String.fromCharCode(47) + 'json' },
            body: JSON.stringify({ content }),
          })
          if (!response.ok) log(`Discord answered HTTP ${response.status}`)
        } catch (e) {
          log(`Discord could not be reached: ${redact(e instanceof Error ? e.message : String(e), [webhookUrl])}`)
        }
      }
    },
  }
}

/** Prints notices instead of sending them; for a dry run, and for a server with no webhook yet. */
export function consoleNotifier(log: (line: string) => void): Notifier {
  return { async send(text) { log(`[notice] ${redact(text)}`) } }
}

/**
 * Sends `text` unless a notice with the same `key` went out in the last day.
 * Records the send in `state` (the caller saves it). `key: null` always sends.
 */
export async function tell(notifier: Notifier, state: State, nowMs: number, key: string | null, text: string): Promise<boolean> {
  if (key !== null) {
    const last = state.notifiedMs[key]
    if (last !== undefined && nowMs - last < DAY_MS) return false
    state.notifiedMs[key] = nowMs
  }
  await notifier.send(text)
  return true
}
