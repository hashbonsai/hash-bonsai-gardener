# Rehearsing on testnet

A rehearsal runs the whole gardener, approval and all, against a copy of the game on
testnet whose epochs last minutes. A week of mainnet becomes a few hours: settling,
distributing, a ballot and its result all come round. Nothing here touches the real
game, the real report or the real memory namespace.

What it can show that a [dry run](dry-run.md) cannot: that a report really is stored
on Walrus and cannot be deleted, that Walrus Memory carries an observation from one
report to the next, that the approval commands work, that a failure part-way through
is picked up cleanly, and what the operator sees at each step.

## What you need

- A copy of the game on testnet with short epochs, and the people who run it. From
  that deployment you need the object ids of the game's shared objects, the package
  ids that first declared its types, and the testnet WAL coin type. The game's own
  deployment is not part of this repository.
- A **separate** testnet key for the gardener: `sui client new-address ed25519`, in
  your own terminal. Never reuse the mainnet key.
- Testnet SUI from the faucet, and testnet WAL (exchange SUI for it with the Walrus
  command line, `walrus get-wal`).
- The Tatum key (the same one: the testnet host is chosen by `network`), the
  Anthropic key and the MemWal delegate key.
- Walrus Memory is **not** run on testnet. The rehearsal uses the mainnet MemWal
  relayer and account and keeps its memories apart by namespace:
  `hash-bonsai-gardener-testnet` for the rehearsal, `hash-bonsai-gardener` for the real
  thing. The rehearsal's memories do not count towards the real namespace.

## 1. Find Walrus's package on testnet

The gardener signs only what a Walrus storage transaction contains, and the package
whose functions it may call is a setting. Learn it from one real transaction:

```
npx tsx scripts/check-walrus.ts --network testnet \
  --key-file <testnet gardener key file> --tatum-key-file <tatum key file> \
  --epochs 1 --confirm-permanent
```

It prints the package, module and function of each call it signs (all public) and the
blob it stored. Put the Walrus package from those lines in `walrusPackageIds`. If it
refuses a call, the message names it; add only what you have read and understood.

## 2. The configuration

Start from `deploy/config.example.json` and change:

```json
{
  "network": "testnet",
  "address": "<the testnet gardener address>",
  "keyFile": "<testnet gardener key file>",
  "memwal": { "keyFile": "<delegate key file>", "accountId": "<account id>", "namespace": "hash-bonsai-gardener-testnet" },
  "stateFile": "<a fresh path, never the real state file>",
  "walrusPackageIds": ["<from step 1>"],
  "aggregatorUrl": "https://aggregator.walrus-testnet.walrus.space",
  "graphqlUrl": "https://graphql.testnet.sui.io/graphql",
  "firstEpoch": "<the first rehearsal epoch to write about>",
  "requireApproval": true,
  "llmLimits": { "perDay": 200, "perMonth": 2000 },
  "chain": {
    "ids": {
      "epochBoard": "<id>", "gameBank": "<id>", "arena": "<id>",
      "distributor": "<id>", "governance": "<id>", "operatorLock": "<id>",
      "epochKeyPackageId": "<package that first declared EpochMintedKey>",
      "walType": "<the testnet WAL coin type>"
    },
    "eventPackages": { "game": "<package that first declared economy and bonsai>", "gov": "<the governance package>" }
  }
}
```

- `chain` is required on testnet. The mainnet addresses are built in; testnet's are not.
- `llmLimits` raises the model-call limits, because four a day would stop a rehearsal
  of ten-minute epochs at once. The program refuses it on mainnet.
- `firstEpoch` is a number, not text. Keep `requireApproval` on to rehearse approval.
- Check the aggregator answers: `curl -s -o /dev/null -w '%{http_code}\n' <aggregatorUrl>/v1/blobs/<43 letters>`
  should print `404` (a blob that does not exist), not a connection error.

The rehearsal's `stateFile` is its own. Never point the real server at it, and never start the rehearsal from the real server's state.

## 3. Run it

An hourly timer would be far too slow. Run a round by hand, or in a loop, every few minutes:

```
while true; do npm run once -- --config <rehearsal config>; sleep 300; done
```

`Ctrl-C` stops it. Without a `webhookFile` the notices print to the terminal; with one
they go to the channel the file names.

## 4. The scenes

Watch for each of these, in any order they come.

| Scene | What to do | What you should see |
|---|---|---|
| An epoch not over | just run | `round: waiting (epoch N)` and nothing else |
| Distribution not confirmed | let an epoch end without the house bot's `advance` | `waiting`, and no report. (The six-hour notice counts from the epoch's settling, which a rehearsal of ten-minute epochs cannot wait out; that rule is covered by the unit tests.) |
| A draft | an epoch is over and confirmed | a draft in the notices, with `npm run approve` and `npm run reject` lines; nothing on Walrus yet |
| Approval | `npm run approve -- N --note "Be brief."` then a round | `Epoch N report published`, a blob link that opens in a browser, `not deletable`; the note appears among the memories written |
| Rejection | `npm run reject -- N --note "Too cheerful."` then a round | a report with the figures alone, "withheld by the operator" |
| The chain of reports | publish two in a row | the second blob's `previousBlobId` is the first's id, and its prompt includes the first's commentary |
| Memory | publish two in a row | the second draft's notebook has a line for the first's observation; the namespace's memory count grows (the published notice shows it) |
| No commentary | set `"model": "no-such-model"` for one round | a figures-only draft, "the commentary could not be written", and a notice with the model's own message |
| A ballot | the replica reaches its first ballot epoch | the fixed announcement once, and the fixed result once the ballot is applied |
| A ballot not applied | stop the house bot's `execute` | `waiting` through the ballot epoch's report; after the board is two epochs on, a report that says the result was never applied |
| Cost brakes | set `llmLimits` to `{ "perDay": 1, "perMonth": 1 }`; or let the gardener's SUI fall under 0.1 | `Epoch N's report is held back: …`, nothing stored |
| An approved report held back | approve a draft, then empty the gardener's WAL, run, and then refill and run again | the first round says the report is "approved but held back", with the amount of WAL it needs, and stores nothing; the second publishes it, without another model call |

## 5. Afterwards

- Search the terminal log, the Discord channel and a blob's JSON for key shapes
  (an `sk-ant-` prefix, a `suiprivkey` prefix, a long run of hex digits with no `0x`)
  and for the webhook URL. There should be none. The program redacts every line it
  prints, so any hit is a bug to report.
- Read one stored blob end to end. It is public and permanent; anything in it is
  there for good.
- Delete the rehearsal state file and keep it out of the real server.
- Run `scripts/precheck-public.sh` before any push, as always.
