import { bcs } from '@mysten/sui/bcs'
import { Signer, type Keypair, type SignatureWithBytes } from '@mysten/sui/cryptography'
import type { IntentScope } from '@mysten/sui/cryptography'
import { Transaction } from '@mysten/sui/transactions'
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils'

/** What the gardener's key may sign. Everything else is refused before it is signed. */
export type SendPolicy = {
  /** The gardener's own address: the only sender, gas owner, and transfer recipient. */
  address: string
  /** Walrus package ids (current published-at of the system and blob packages) whose functions may be called. */
  walrusPackageIds: string[]
}

const FRAMEWORK = normalizeSuiAddress('0x2')

/**
 * The framework functions the Walrus SDK's storage transaction really uses,
 * read off a mainnet run of it: take the payment out of the address balance,
 * return the change to it, and throw away the empty coins. `send_funds` is the
 * one that can move value to someone else, so its recipient is checked
 * separately. A call that turns out to need one more is refused with its name
 * and is added here only after being read.
 */
const FRAMEWORK_CALLS = new Set(['coin::redeem_funds', 'coin::send_funds', 'coin::destroy_zero'])

/** `coin::send_funds(coin, recipient)`: the position of the recipient. */
const SEND_FUNDS_RECIPIENT = 1

/** A stored report must outlive the operator's wishes, so nothing that deletes a Blob is ever signed. */
const isDeletion = (fn: string) => fn.startsWith('delete') || fn.includes('burn')

type Data = ReturnType<Transaction['getData']>
type Argument = Extract<Data['commands'][number], { $kind: 'TransferObjects' }>['TransferObjects']['address']

function pureAddress(data: Data, arg: Argument): string {
  if (arg.$kind !== 'Input') throw new Error(`refused: a recipient must be a plain address, not ${arg.$kind}`)
  const input = data.inputs[arg.Input]
  if (!input || input.$kind !== 'Pure') throw new Error('refused: a recipient must be a plain address')
  return normalizeSuiAddress(bcs.Address.parse(fromBase64(input.Pure.bytes)))
}

/**
 * Throws unless the transaction is one the gardener may send: sent by the
 * gardener, paid for by the gardener, and made only of Walrus calls, the
 * framework's coin plumbing, coin splits and merges, and transfers back to the
 * gardener. Never a call into the game or the governance package.
 */
export function assertAllowed(tx: Transaction, policy: SendPolicy): void {
  const me = normalizeSuiAddress(policy.address)
  const walrus = new Set(policy.walrusPackageIds.map((id) => normalizeSuiAddress(id)))
  const data = tx.getData()

  if (!data.sender || normalizeSuiAddress(data.sender) !== me) throw new Error('refused: the sender is not the gardener')
  const gasOwner = data.gasData.owner
  if (gasOwner && normalizeSuiAddress(gasOwner) !== me) throw new Error('refused: the gas is not paid by the gardener')

  for (const input of data.inputs) {
    if (input.$kind === 'FundsWithdrawal' && input.FundsWithdrawal.withdrawFrom.$kind !== 'Sender') {
      throw new Error('refused: funds may only be withdrawn from the gardener\'s own balance')
    }
  }

  for (const command of data.commands) {
    switch (command.$kind) {
      case 'MoveCall': {
        const c = command.MoveCall
        const pkg = normalizeSuiAddress(c.package)
        const target = `${pkg}::${c.module}::${c.function}`
        if (isDeletion(c.function)) throw new Error(`refused: ${target} would delete or burn`)
        const ok = walrus.has(pkg) || (pkg === FRAMEWORK && FRAMEWORK_CALLS.has(`${c.module}::${c.function}`))
        if (!ok) throw new Error(`refused: ${target} is not on the gardener's allowlist`)
        if (pkg === FRAMEWORK && c.function === 'send_funds') {
          const recipient = c.arguments[SEND_FUNDS_RECIPIENT]
          if (!recipient || pureAddress(data, recipient) !== me) throw new Error('refused: funds may only be sent back to the gardener itself')
        }
        break
      }
      case 'SplitCoins':
      case 'MergeCoins':
      case 'MakeMoveVec':
        break
      case 'TransferObjects':
        if (pureAddress(data, command.TransferObjects.address) !== me) throw new Error('refused: objects may only be transferred to the gardener itself')
        break
      case '$Intent':
        if (command.$Intent.name !== 'CoinWithBalance') throw new Error(`refused: intent ${command.$Intent.name}`)
        break
      default:
        throw new Error(`refused: ${command.$kind} is not something the gardener does`)
    }
  }
}

/**
 * Wraps the gardener's keypair so that the only way to a signature for a
 * transaction runs through `assertAllowed`. The Walrus client signs through
 * `signAndExecuteTransaction` and `signTransaction`; both end in `signWithIntent`.
 * Raw `sign` is closed off so a digest cannot be signed around the check.
 */
export class GuardedSigner extends Signer {
  constructor(
    private readonly inner: Keypair,
    private readonly policy: SendPolicy,
  ) {
    super()
    if (normalizeSuiAddress(inner.toSuiAddress()) !== normalizeSuiAddress(policy.address)) {
      throw new Error('the key does not belong to the configured gardener address')
    }
  }

  override async signWithIntent(bytes: Uint8Array, intent: IntentScope): Promise<SignatureWithBytes> {
    if (intent === 'TransactionData') assertAllowed(Transaction.from(bytes), this.policy)
    return this.inner.signWithIntent(bytes, intent)
  }

  sign(): Promise<Uint8Array<ArrayBuffer>> {
    return Promise.reject(new Error('refused: raw signing is closed; sign a transaction or message instead'))
  }

  getKeyScheme() {
    return this.inner.getKeyScheme()
  }

  getPublicKey() {
    return this.inner.getPublicKey()
  }
}
