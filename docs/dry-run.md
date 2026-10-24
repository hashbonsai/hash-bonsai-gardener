# A dry run with real keys

A dry run reads the live chain, asks the language model for a report, runs every
check on it and shows the result. It stores nothing on Walrus, writes nothing to
Walrus Memory, saves no state and posts nothing. It is how to see, on your own
machine and with your own keys, exactly what the gardener would publish.

It does call the model (one call, two if the first answer fails a check: a few
cents), and it counts for nothing against the daily limit, because no state is saved.

## What you need

- Node 20 or later, and `npm ci` run in this directory.
- Four key files, each holding one value and nothing else, readable only by you
  (`chmod 600`):

  | File | Holds |
  |---|---|
  | `sui-key` | the gardener's Sui key (a Bech32 `suiprivkey` string) |
  | `tatum-api-key` | the Tatum API key |
  | `anthropic-api-key` | the Anthropic API key |
  | `memwal-delegate-key` | the MemWal delegate key (its public half is registered on the MemWal account) |

  Keep them outside this repository, for example in `~/.config/the-gardener/`.
  Nothing in this guide prints a key, and none of the commands needs you to paste one.

- A configuration file, also outside the repository. Copy `deploy/config.example.json`
  and change:
  - `address`: the gardener's own address (the key above must belong to it),
  - `keyFile`, `tatumKeyFile`, `anthropicKeyFile`, `memwal.keyFile`: the paths of your key files,
  - `memwal.accountId`: your MemWal account id,
  - `stateFile`: any writable path (a dry run does not write it, but the program needs the setting),
  - `webhookFile`: leave it out for now (see "Where the draft goes" below).

## Step 1: check each service alone

Each script makes one small call, prints what it found and never prints a key.
Run them from the repository root.

```
npx tsx scripts/check-tatum.ts --network mainnet --key-file ~/.config/the-gardener/tatum-api-key --address <the gardener's address>
npx tsx scripts/check-chain.ts --epoch 3 --tatum-key-file ~/.config/the-gardener/tatum-api-key
npx tsx scripts/check-anthropic.ts --key-file ~/.config/the-gardener/anthropic-api-key
npx tsx scripts/check-memwal.ts --key-file ~/.config/the-gardener/memwal-delegate-key --account-id <account id> --namespace hash-bonsai-gardener-testnet
```

- `check-tatum` should print `ok`. Tatum's free plan allows three requests a second;
  the client keeps under that and waits when it is told to, printing
  `Tatum answered 429; waiting …` each time.
- `check-chain` prints the facts of a finished epoch as JSON and `problems: none`.
  Any line under `problems` names a part that could not be read.
- `check-anthropic` runs the whole writing step on an invented epoch and prints each
  attempt, why a check failed, if one did, and whether it fell back to the figures.
- `check-memwal` writes one memory to the **practice** namespace and reads it back.

There is a fifth, `scripts/check-walrus.ts`, which stores a real, undeletable blob and
spends a little WAL. It needs `--confirm-permanent`. Run it once, on purpose.

## Step 2: the dry run

```
npm run once -- --config ~/.config/the-gardener/config.json --dry-run
```

It prints `reading and sending through Tatum: <host>`, then one of these.

**`round: waiting (epoch N)`** — the epoch it would write about is not over, or its
distribution (or, for an epoch that ran a ballot, the ballot's result) is not
confirmed yet. Nothing is wrong. To see a whole report before the first real epoch is
over, give the dry run an older one: in a copy of the configuration set
`"firstEpoch"` to the latest finished epoch below 5 (the first epoch with a PRUNE
distribution). Epochs before the distribution began need no distribution to be
confirmed, so the round goes straight on.

**`dry run: epoch N composed (…); nothing stored`** — followed by the draft: the
English text, the Japanese text, and the post for Farcaster. Read it for:

- every figure written with the game screens' digits (SUI to three decimals, BONEXP,
  PRUNE and scores to two, counts whole) and each amount with its unit,
- the Japanese using the game's own words (シーズン, ランキング, アリーナ, 確定,
  スコアに変換, 配布 for PRUNE, 放出額 for the SUI prize),
- one sentence on the PRUNE released, only if there was some,
- no mention of voting, of price or profit, or of any player but by short address.

The program also prints `unreadable: …` for each part of the facts it could not read.
Those parts are left out of the report, and the model is told nothing about them.

**`round: failed: …`** — see "If it fails".

## Step 3: with and without memory

```
npm run once -- --config ~/.config/the-gardener/config.json --dry-run --no-memory
```

`--no-memory` reads and writes no Walrus Memory. Compare the two drafts: the first shows
what the gardener remembers of its earlier observations (in the notebook lines and in
what the model is told); the second is the same epoch without any of it.

To see the two side by side from one command, write a finished epoch twice, with and
without what the gardener remembers (it stores nothing, and calls the model twice):

```
npx tsx scripts/compare-memory.ts --config ~/.config/the-gardener/config.json --epoch 6
```

It says how many earlier observations it recalled and how many were graded against that
epoch. It only has something to show once the memory holds an observation from an earlier
epoch.

## Where the draft goes

A dry run prints the draft to the terminal unless the configuration names a
`webhookFile`, in which case it is also sent to that Discord channel. Leave the
webhook out for a private first run.

## If it fails

| Message | Meaning |
|---|---|
| `the key file does not belong to the configured address` | `address` and `keyFile` are for different keys; nothing was signed |
| `Received HTTP status code 401` | the Tatum key is wrong or not active |
| `Tatum answered 429; waiting …` | a rate limit; the client waits and retries up to four times, no action needed |
| `the model call failed and will not be retried: 401 …` | the Anthropic key is wrong |
| `the commentary could not be written` | the model could not be reached; the report would be the figures alone |
| `the commentary failed its checks` | both attempts broke a rule (a number not in the facts, a banned word, a length…); the reasons are printed |
| `the configuration file … could not be read as JSON` or `config: "…" is missing` | the setting named is missing or wrong |

## What a dry run does not test

Storing on Walrus, writing to Walrus Memory, the approval commands and the state file.
Those are exercised by `scripts/check-walrus.ts`, `scripts/check-memwal.ts` and the
[testnet rehearsal](testnet-rehearsal.md).
