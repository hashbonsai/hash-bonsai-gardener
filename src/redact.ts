const KEY = /suiprivkey1[0-9a-z]+/gi
const WEBHOOK = /https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi
const ANTHROPIC = /sk-ant-[A-Za-z0-9_-]+/g
// A bare 64-hex string (no 0x) is how a raw Ed25519 key is written.
const RAW_KEY = /(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g

/**
 * Strips anything key- or webhook-shaped, plus any exact secret passed in,
 * before text leaves the process. Every exit — log, Discord, Walrus,
 * Farcaster, memory — goes through this: a chain or API error can echo its
 * inputs back, and an exception can carry a file's contents.
 */
export function redact(text: string, secrets: string[] = []): string {
  let out = text
    .replace(KEY, '[redacted key]')
    .replace(WEBHOOK, '[redacted webhook]')
    .replace(ANTHROPIC, '[redacted key]')
    .replace(RAW_KEY, '[redacted key]')
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]')
  return out
}

/** True when `redact` would change the text — i.e. it holds something that must not leave. */
export function holdsSecret(text: string, secrets: string[] = []): boolean {
  return redact(text, secrets) !== text
}
