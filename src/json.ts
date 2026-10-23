/**
 * Readers for the JSON the chain APIs return. Move's `u64` arrives as a
 * string, `u8` as a number, an `Option` as its value or `null`, a `Balance` as
 * a plain string. Every reader throws, with the field's name, on anything that
 * is not what it expects: a value that drifted must stop the section it feeds,
 * not turn into a quiet zero.
 */

export type Json = Record<string, unknown>

export function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function record(v: unknown, what: string): Json {
  if (!isRecord(v)) throw new Error(`${what}: not an object`)
  return v
}

export function field(obj: Json, name: string): unknown {
  if (!(name in obj)) throw new Error(`missing field "${name}"`)
  return obj[name]
}

/** A `u64` (or any unsigned integer) sent as a decimal string, or as a safe integer. */
export function big(obj: Json, name: string): bigint {
  const v = field(obj, name)
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  throw new Error(`field "${name}": not an unsigned integer`)
}

/** A count or an epoch number: an unsigned integer that fits a JavaScript number exactly. */
export function num(obj: Json, name: string): number {
  const n = big(obj, name)
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`field "${name}": too large for a number`)
  return Number(n)
}

export function bool(obj: Json, name: string): boolean {
  const v = field(obj, name)
  if (typeof v !== 'boolean') throw new Error(`field "${name}": not a boolean`)
  return v
}

export function str(obj: Json, name: string): string {
  const v = field(obj, name)
  if (typeof v !== 'string') throw new Error(`field "${name}": not a string`)
  return v
}

export function list(obj: Json, name: string): unknown[] {
  const v = field(obj, name)
  if (!Array.isArray(v)) throw new Error(`field "${name}": not a list`)
  return v
}

export function child(obj: Json, name: string): Json {
  return record(field(obj, name), `field "${name}"`)
}

/** An `Option<T>`: the value, or null when none. */
export function optional(obj: Json, name: string): unknown | null {
  const v = field(obj, name)
  return v === undefined ? null : v
}
