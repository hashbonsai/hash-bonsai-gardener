import { describe, expect, it } from 'vitest'
import { holdsSecret, redact } from '../src/redact'

// Built at run time so no secret-shaped string sits in this file whole.
const suiKey = ['suiprivkey', '1', 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'].join('')
const webhook = ['https://discord', '.com/api/webhooks/', '123456/abc-DEF_ghi'].join('')
const anthropic = ['sk-ant', '-api03-', 'abcdefghijklmnop'].join('')
const rawKey = 'ab12'.repeat(16)

describe('redact', () => {
  it.each([
    ['a Sui private key', suiKey],
    ['a Discord webhook', webhook],
    ['an Anthropic key', anthropic],
    ['a raw 64-hex key', rawKey],
  ])('removes %s', (_name, secret) => {
    const out = redact(`before ${secret} after`)
    expect(out).not.toContain(secret)
    expect(out).toMatch(/^before \[redacted/)
    expect(out).toMatch(/after$/)
  })

  it('removes an exact secret passed in, wherever it appears', () => {
    expect(redact('token=abc123 and abc123 again', ['abc123'])).toBe('token=[redacted] and [redacted] again')
  })

  it('leaves a normal 0x-prefixed Sui address alone', () => {
    const address = '0x' + 'ab12'.repeat(16)
    expect(redact(`owner ${address}`)).toBe(`owner ${address}`)
  })

  it('leaves ordinary text alone', () => {
    expect(redact('Epoch 5 closed with 12 players.')).toBe('Epoch 5 closed with 12 players.')
  })

  it('says whether text holds a secret', () => {
    expect(holdsSecret(`x ${suiKey}`)).toBe(true)
    expect(holdsSecret('plain')).toBe(false)
    expect(holdsSecret('has abc', ['abc'])).toBe(true)
  })
})
