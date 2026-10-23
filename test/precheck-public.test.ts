import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'precheck-public.sh')

// This file is scanned by the very script it tests, so no secret-shaped
// string may appear in it contiguously: every fake below is assembled from
// parts at run time, and the words and identities are made-up placeholders.
const AUTHOR = 'Dummy Author'
const EMAIL = 'dummy-author@example.invalid'

const fake = {
  suiKey: (tail = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abc') => ['suiprivkey', '1', tail].join(''),
  webhook: () => ['https://discord', '.com/api/webhooks/', '123456789/abcDEF-ghiJKL_mno'].join(''),
  anthropicKey: () => ['sk-ant', '-api03-', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
  rawKey: () => 'a'.repeat(64),
  address: (ch: string) => ['0', 'x', ch.repeat(64)].join(''),
}

let repo: string
let dir: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
}

function commit(author = AUTHOR, email = EMAIL, message = 'a commit'): void {
  execFileSync('git', ['-c', `user.name=${author}`, '-c', `user.email=${email}`, 'commit', '-m', message], {
    cwd: repo,
    stdio: 'pipe',
  })
}

function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content)
}

/** Runs the script against `repo`; never throws on a non-zero exit. */
function run(opts: { patterns?: string[]; addresses?: string[]; allow?: string[]; name?: string; email?: string } = {}): {
  code: number
  stdout: string
} {
  const patternsFile = join(dir, 'patterns.txt')
  const addressesFile = join(dir, 'addresses.txt')
  writeFileSync(patternsFile, (opts.patterns ?? []).join('\n') + '\n')
  writeFileSync(addressesFile, (opts.addresses ?? []).join('\n') + '\n')
  const args = [
    SCRIPT,
    '--forbidden-patterns', patternsFile,
    '--forbidden-addresses', addressesFile,
    '--author-name', opts.name ?? AUTHOR,
    '--author-email', opts.email ?? EMAIL,
  ]
  for (const a of opts.allow ?? []) args.push('--allow', a)
  try {
    return { code: 0, stdout: execFileSync('sh', args, { cwd: repo, encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { status: number | null; stdout: Buffer | string }
    return { code: err.status ?? 1, stdout: String(err.stdout) }
  }
}

function commitFile(content: string): void {
  write('file.txt', content)
  git('add', '.')
  commit()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'precheck-aux-'))
  repo = mkdtempSync(join(tmpdir(), 'precheck-repo-'))
  git('init', '-q')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe('precheck-public.sh', () => {
  it('passes a clean repo with only the expected author', () => {
    commitFile('Hello.\n')
    const { code, stdout } = run()
    expect(code).toBe(0)
    expect(stdout).toMatch(/all checks passed/)
  })

  it.each(['--forbidden-patterns', '--forbidden-addresses', '--author-name', '--author-email'])(
    'requires %s',
    (flag) => {
      commitFile('Hello.\n')
      const all: Record<string, string> = {
        '--forbidden-patterns': join(dir, 'p.txt'),
        '--forbidden-addresses': join(dir, 'a.txt'),
        '--author-name': AUTHOR,
        '--author-email': EMAIL,
      }
      writeFileSync(all['--forbidden-patterns'], '\n')
      writeFileSync(all['--forbidden-addresses'], '\n')
      const args = [SCRIPT]
      for (const [k, v] of Object.entries(all)) if (k !== flag) args.push(k, v)
      let code = 0
      try {
        execFileSync('sh', args, { cwd: repo, stdio: 'pipe' })
      } catch (e) {
        code = (e as { status: number }).status
      }
      expect(code).toBe(2)
    },
  )

  it('catches a Sui private key in the working tree', () => {
    commitFile(fake.suiKey() + '\n')
    const { code, stdout } = run()
    expect(code).toBe(1)
    expect(stdout).toMatch(/Sui private key/)
  })

  it('catches a Sui private key that only exists in history, not the current tree', () => {
    commitFile(fake.suiKey() + '\n')
    commitFile('fixed now\n')
    const { code, stdout } = run()
    expect(code).toBe(1)
    expect(stdout).toMatch(/Sui private key/)
  })

  it('catches a Discord webhook URL', () => {
    commitFile(fake.webhook() + '\n')
    const { code, stdout } = run()
    expect(code).toBe(1)
    expect(stdout).toMatch(/Discord webhook/)
  })

  it('catches an Anthropic API key', () => {
    commitFile(fake.anthropicKey() + '\n')
    const { code, stdout } = run()
    expect(code).toBe(1)
    expect(stdout).toMatch(/Anthropic API key/)
  })

  it('catches a bare 64-hex-character string', () => {
    commitFile('key: ' + fake.rawKey() + '\n')
    const { code, stdout } = run()
    expect(code).toBe(1)
    expect(stdout).toMatch(/64-hex/)
  })

  it('does not flag a normal 0x-prefixed Sui object id', () => {
    commitFile(`The package id is ${fake.address('a')}.\n`)
    expect(run().code).toBe(0)
  })

  it('catches a word from --forbidden-patterns', () => {
    const word = `placeholder-word-${Date.now()}`
    commitFile(`mentions ${word} here\n`)
    const { code, stdout } = run({ patterns: [word] })
    expect(code).toBe(1)
    expect(stdout).toMatch(/forbidden word or phrase/)
  })

  it('catches a forbidden word that only exists in history', () => {
    const word = `placeholder-word-${Date.now()}`
    commitFile(`mentions ${word} here\n`)
    commitFile('clean now\n')
    expect(run({ patterns: [word] }).code).toBe(1)
  })

  it('does not flag a pattern that is also passed with --allow', () => {
    const word = `placeholder-word-${Date.now()}`
    commitFile(`mentions ${word} here\n`)
    expect(run({ patterns: [word], allow: [word] }).code).toBe(0)
  })

  it('catches a forbidden address', () => {
    commitFile(`operator: ${fake.address('b')}\n`)
    const { code, stdout } = run({ addresses: [fake.address('b')] })
    expect(code).toBe(1)
    expect(stdout).toMatch(/account address/)
  })

  it('does not flag a forbidden address that is also passed with --allow', () => {
    const addr = fake.address('c')
    commitFile(`gardener address: ${addr}\n`)
    expect(run({ addresses: [addr], allow: [addr] }).code).toBe(0)
  })

  it('scans its own script and test: a secret-shaped string in either would be caught', () => {
    // The scan has no exclusions, so a file at either of these paths is in scope.
    write('precheck-public.sh', fake.suiKey() + '\n')
    git('add', '.')
    commit()
    expect(run().code).toBe(1)
  })

  it('catches a commit whose author name differs', () => {
    write('f.txt', 'x\n')
    git('add', '.')
    commit('Someone Else', EMAIL)
    const { code, stdout } = run()
    expect(code).toBe(1)
    expect(stdout).toMatch(/author identity/)
  })

  it('catches a commit whose author email differs even when the name matches', () => {
    write('f.txt', 'x\n')
    git('add', '.')
    commit(AUTHOR, 'someone-else@example.invalid')
    const { code, stdout } = run()
    expect(code).toBe(1)
    expect(stdout).toMatch(/author identity/)
  })

  it('does not print the matched secret itself', () => {
    const secret = fake.suiKey('SECRETVALUEDONOTPRINTTHISANYWHEREOK0123456789abc')
    commitFile(secret + '\n')
    expect(run().stdout).not.toContain(secret)
  })
})
