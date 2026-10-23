import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { describe, expect, it } from 'vitest'
import { assertAllowed, GuardedSigner, type SendPolicy } from '../src/chain'

const keypair = new Ed25519Keypair()
const ME = normalizeSuiAddress(keypair.toSuiAddress())
const OTHER = normalizeSuiAddress('0x' + 'ab'.repeat(32))
const WALRUS = normalizeSuiAddress('0x' + '11'.repeat(32))
const GAME = normalizeSuiAddress('0x' + '22'.repeat(32))
const GOV = normalizeSuiAddress('0x' + '33'.repeat(32))
const policy: SendPolicy = { address: ME, walrusPackageIds: [WALRUS] }

const REF = { objectId: normalizeSuiAddress('0x' + '44'.repeat(32)), version: '7', digest: '11111111111111111111111111111111' }

function base(sender: string | null = ME): Transaction {
  const tx = new Transaction()
  if (sender) tx.setSender(sender)
  return tx
}

describe('assertAllowed', () => {
  it('lets a Walrus call, coin plumbing and a transfer to the gardener through', () => {
    const tx = base()
    const [coin] = tx.splitCoins(tx.gas, [100])
    const [blob] = tx.moveCall({ target: `${WALRUS}::system::register_blob`, arguments: [tx.object(REF.objectId), coin] })
    tx.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: ['0x2::sui::SUI'], arguments: [tx.splitCoins(tx.gas, [0])[0]] })
    tx.mergeCoins(tx.gas, [coin])
    tx.transferObjects([blob], tx.pure.address(ME))
    expect(() => assertAllowed(tx, policy)).not.toThrow()
  })

  describe('the Walrus storage transaction as the SDK builds it', () => {
    const WAL = '0x' + '55'.repeat(32) + '::wal::WAL'

    function storageTransaction(over: { change?: string; from?: 'sender' | 'sponsor' } = {}): Transaction {
      const tx = base()
      const funds = tx.withdrawal({ amount: 1000, type: WAL, from: over.from ?? 'sender' })
      const [payment] = tx.moveCall({ target: '0x2::coin::redeem_funds', typeArguments: [WAL], arguments: [funds] })
      const [part] = tx.splitCoins(payment, [500])
      tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [WAL], arguments: [payment, tx.pure.address(over.change ?? ME)] })
      const [space] = tx.moveCall({ target: `${WALRUS}::system::reserve_space`, arguments: [part] })
      tx.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: [WAL], arguments: [part] })
      const [blob] = tx.moveCall({ target: `${WALRUS}::system::register_blob`, arguments: [space] })
      tx.moveCall({ target: '0x2::coin::destroy_zero', typeArguments: [WAL], arguments: [part] })
      tx.transferObjects([blob], tx.pure.address(ME))
      return tx
    }

    it('lets the whole first transaction through, and the certify call', () => {
      expect(() => assertAllowed(storageTransaction(), policy)).not.toThrow()
      const certify = base()
      certify.moveCall({ target: `${WALRUS}::system::certify_blob`, arguments: [certify.object(REF.objectId)] })
      expect(() => assertAllowed(certify, policy)).not.toThrow()
    })

    it('refuses the change being sent to someone else', () => {
      expect(() => assertAllowed(storageTransaction({ change: OTHER }), policy)).toThrow(/sent back to the gardener/)
    })

    it('refuses sending funds to a recipient that is computed rather than a plain address', () => {
      const tx = base()
      const [coin] = tx.moveCall({ target: '0x2::coin::redeem_funds', typeArguments: [WAL], arguments: [tx.withdrawal({ amount: 1, type: WAL })] })
      const [who] = tx.moveCall({ target: `${WALRUS}::system::something`, arguments: [] })
      tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [WAL], arguments: [coin, who] })
      expect(() => assertAllowed(tx, policy)).toThrow(/plain address/)
    })

    it('refuses sending funds with no recipient at all', () => {
      const tx = base()
      const [coin] = tx.moveCall({ target: '0x2::coin::redeem_funds', typeArguments: [WAL], arguments: [tx.withdrawal({ amount: 1, type: WAL })] })
      tx.moveCall({ target: '0x2::coin::send_funds', typeArguments: [WAL], arguments: [coin] })
      expect(() => assertAllowed(tx, policy)).toThrow(/sent back to the gardener/)
    })

    it('refuses a withdrawal from anyone but the gardener', () => {
      expect(() => assertAllowed(storageTransaction({ from: 'sponsor' }), policy)).toThrow(/gardener's own balance/)
    })

    it('refuses framework coin calls the SDK was not seen to use', () => {
      const tx = base()
      tx.moveCall({ target: '0x2::coin::from_balance', typeArguments: [WAL], arguments: [] })
      expect(() => assertAllowed(tx, policy)).toThrow(/not on the gardener's allowlist/)
    })
  })

  it('refuses a call into the game package', () => {
    const tx = base()
    tx.moveCall({ target: `${GAME}::bonsai::harvest_to_sender`, arguments: [] })
    expect(() => assertAllowed(tx, policy)).toThrow(/not on the gardener's allowlist/)
  })

  it('refuses a call into the governance package', () => {
    const tx = base()
    tx.moveCall({ target: `${GOV}::governance::vote`, arguments: [] })
    expect(() => assertAllowed(tx, policy)).toThrow(/not on the gardener's allowlist/)
  })

  it('refuses framework calls other than the coin plumbing', () => {
    const tx = base()
    tx.moveCall({ target: '0x2::transfer::public_transfer', typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'], arguments: [tx.gas, tx.pure.address(OTHER)] })
    expect(() => assertAllowed(tx, policy)).toThrow(/not on the gardener's allowlist/)
  })

  it('refuses a Walrus call that deletes a Blob', () => {
    const tx = base()
    tx.moveCall({ target: `${WALRUS}::system::delete_blob`, arguments: [tx.object(REF.objectId)] })
    expect(() => assertAllowed(tx, policy)).toThrow(/delete or burn/)
  })

  it('refuses a transfer to anyone but the gardener', () => {
    const tx = base()
    const [coin] = tx.splitCoins(tx.gas, [1])
    tx.transferObjects([coin], tx.pure.address(OTHER))
    expect(() => assertAllowed(tx, policy)).toThrow(/only be transferred to the gardener/)
  })

  it('refuses a transfer whose recipient is computed rather than a plain address', () => {
    const tx = base()
    const [coin] = tx.splitCoins(tx.gas, [1])
    const [who] = tx.moveCall({ target: `${WALRUS}::system::something`, arguments: [] })
    tx.transferObjects([coin], who)
    expect(() => assertAllowed(tx, policy)).toThrow(/plain address/)
  })

  it('refuses publishing and upgrading', () => {
    const tx = base()
    tx.publish({ modules: [], dependencies: [] })
    expect(() => assertAllowed(tx, policy)).toThrow(/Publish is not something/)
  })

  it('refuses another sender, a missing sender and a sponsor', () => {
    expect(() => assertAllowed(base(OTHER), policy)).toThrow(/sender is not the gardener/)
    expect(() => assertAllowed(base(null), policy)).toThrow(/sender is not the gardener/)
    const sponsored = base()
    sponsored.setGasOwner(OTHER)
    expect(() => assertAllowed(sponsored, policy)).toThrow(/gas is not paid by the gardener/)
  })

  it('compares addresses in normal form, so short and long spellings agree', () => {
    const tx = base()
    tx.moveCall({ target: `${WALRUS.replace(/^0x0*/, '0x')}::system::register_blob`, arguments: [] })
    expect(() => assertAllowed(tx, policy)).not.toThrow()
  })
})

describe('GuardedSigner', () => {
  function built(add: (tx: Transaction) => void): Promise<Uint8Array> {
    const tx = base()
    tx.setGasPayment([REF])
    tx.setGasBudget(1_000_000)
    tx.setGasPrice(1000)
    add(tx)
    return tx.build()
  }

  it('signs an allowed transaction', async () => {
    const signer = new GuardedSigner(keypair, policy)
    const bytes = await built((tx) => {
      const [blob] = tx.moveCall({ target: `${WALRUS}::system::register_blob`, arguments: [] })
      tx.transferObjects([blob], tx.pure.address(ME))
    })
    const signed = await signer.signTransaction(bytes)
    expect(signed.signature.length).toBeGreaterThan(0)
  })

  it('refuses to sign a game call, and signs nothing', async () => {
    const signer = new GuardedSigner(keypair, policy)
    const bytes = await built((tx) => {
      tx.moveCall({ target: `${GAME}::bonsai::harvest_to_sender`, arguments: [] })
    })
    await expect(signer.signTransaction(bytes)).rejects.toThrow(/not on the gardener's allowlist/)
  })

  it('refuses to sign the same bytes through signWithIntent', async () => {
    const signer = new GuardedSigner(keypair, policy)
    const bytes = await built((tx) => {
      tx.moveCall({ target: `${GOV}::governance::vote`, arguments: [] })
    })
    await expect(signer.signWithIntent(bytes, 'TransactionData')).rejects.toThrow(/allowlist/)
  })

  it('has no raw signing to go around the check', async () => {
    const signer = new GuardedSigner(keypair, policy)
    await expect(signer.sign()).rejects.toThrow(/raw signing is closed/)
  })

  it('refuses a key that is not the configured address', () => {
    expect(() => new GuardedSigner(new Ed25519Keypair(), policy)).toThrow(/does not belong/)
  })

  it('reports the same address and public key as the key it wraps', () => {
    const signer = new GuardedSigner(keypair, policy)
    expect(normalizeSuiAddress(signer.toSuiAddress())).toBe(ME)
  })
})
