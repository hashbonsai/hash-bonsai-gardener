# Hash Bonsai Gardener

An AI that writes an epoch-by-epoch report for [Hash Bonsai](https://hashbonsai.wal.app),
an on-chain game on Sui; keeps each report on Walrus as a blob that nobody can delete;
and **remembers what it said** in Walrus Memory, so that next time it can check whether
it was right.

Built for the Total Recall hackathon (Walrus × Tatum).

- **The numbers are not the AI's.** Every figure in a report is read from the chain and
  computed by code. The model writes a short commentary around them, and a set of
  mechanical checks refuse any text that quotes a number the chain did not give.
- **The record cannot be taken back.** Reports are stored as undeletable Walrus blobs, each
  linked to the one before, for as long as Walrus will sell storage.
- **It learns.** Each report ends with observations ("players may keep growing"). Next epoch the
  code, not the model, grades them against the new figures: continued, reversed or flat. Both the
  observation and the verdict are kept in Walrus Memory and come back into the next report.
- **It has no power over the game.** It calls no game or governance function, holds no PRUNE and does
  not vote. The only transactions its key can sign are Walrus storage transactions.

## What a round does

A systemd timer runs the program once an hour. Most runs do nothing. A run:

1. Works out the next epoch to report on, and waits until that epoch is over, its PRUNE
   distribution is confirmed and, if the epoch ran a ballot, the ballot's result is applied
   (a separate bot run by the game's operator does those two; the gardener only waits, and
   says so after six hours).
2. Reads the epoch's facts: players, burns, BONEXP burned, the final standings, the prize
   and its Crown Seeds, the Treasury after settling, mints, the PRUNE released, the ballot,
   the Arena, drains, the rules in force. A part it cannot read becomes `null` and is not
   mentioned. Nothing is estimated.
3. Checks its cost brakes (below), recalls its earlier observations from Walrus Memory and
   grades them, and reads the last four reports back from Walrus.
4. Asks the model for the commentary in English and Japanese, a short post, and up to three
   observations to check next epoch. The answer is checked (below); a failed check gets one
   retry with the reasons; a second failure gives a report of figures alone.
5. Holds the report as a **draft** for a person to approve (`npm run approve -- <epoch>`), or
   publishes it: memories first, then the report to Walrus.
6. Tells the operator where it is, with the post to share.

A draft is saved before anything is published. If Walrus is unreachable, the next round publishes the
same draft; it does not ask the model again and does not write the memories twice.

## How it uses Tatum

All reading of the chain's objects, dynamic fields and balances, and the sending of every
transaction, go through Tatum's Sui **gRPC** endpoint. Tatum speaks plain gRPC over HTTP/2, not
gRPC-Web, so the client is built on `@protobuf-ts/grpc-transport` with the API key as request
metadata (`src/tatum.ts`). The free plan allows three requests a second; the client paces itself
to two and a half, and a call answered with a rate limit waits and tries again (`src/throttle.ts`).

Tatum's gRPC has no event search, so the one thing it cannot do, finding the game's events, goes
to Sui's public GraphQL (`src/events.ts`). Everything else is gRPC.

Objects are read as JSON, not BCS (`src/read.ts`), and every value is checked on the way in: a
struct that changed shape stops the part it feeds instead of turning into a wrong number.

## How it uses Walrus and Walrus Memory

**Walrus** holds the reports (`src/walrus.ts`). Each is a JSON document (`src/report.ts`) stored with
`deletable: false` for the longest period Walrus sells (read from the chain at the time), owned by the
gardener's address. After storing, the program checks that the object really is undeletable. Read a
report back with any aggregator:

```
https://<aggregator>/v1/blobs/<blob id>
```

A report holds the facts with every digit, the commentary, the notebook of graded observations, the
model and the SHA-256 of the instructions it wrote under, the previous report's blob id, and the
ids of the memories it drew on and wrote.

**Walrus Memory** (MemWal) holds what the gardener learns (`src/memory.ts`, `src/learn.ts`). Four kinds of
record: the epoch's facts, an observation, its grade, and an operator's note on how to write. The grading
is done by code on numbers from the chain, never by the model. A note typed by the operator when approving
changes how later reports are written; the prompt tells the model to ignore a note that contradicts the
facts. Only public chain facts and the gardener's own words are ever remembered; a record that looks
like a key is refused. The relay's `analyze` is never used.

`npm run backfill` gives a new gardener a memory of the epochs before it began.

## What keeps it honest and safe

| | |
|---|---|
| **Numbers** | The report may use only numbers that appear in the facts it was shown, rounded the way the game's screens round (`src/display.ts`). A number must match a fact to the last place it is written to. A number written as a word is refused too, since the check could not see it. |
| **Words** | No price, profit, yield or market talk (English and Japanese). Nothing about voting: the ballot's announcements are fixed text. The Japanese must use the game's own terms (`prompts/system.md`). |
| **Addresses** | Only the short addresses of the top three, as given. |
| **The closing sentence** | "The Gardener is an AI run by the Hash Bonsai operator…" is fixed text added by code, not written by the model. |
| **What the key can sign** | `src/chain.ts` wraps the key. It signs a transaction only if it is sent by the gardener, paid by the gardener, and made of Walrus calls, three framework calls, coin splits and merges, and transfers back to itself. Anything else, including a call into the game, is refused before signing. |
| **Cost** | At most 4 model calls a day and 16 a month; nothing is stored unless the address holds 0.1 SUI and enough WAL for the save. |
| **Approval** | Every report waits for a person until they turn it off. |
| **Secrets** | Keys live in files outside the repository and the configuration holds only paths. Every line printed or sent passes through a redaction, and `scripts/precheck-public.sh` searches the whole tree and history before any push. |
| **State** | One file, written through a rename. A damaged file stops the program rather than start over. |

## Running it

Requires Node 20 or later.

```
npm ci
npm test               # every external service is replaced by a fake
npm run typecheck
npm run lint
npm run build          # dist/*.mjs
```

The built program does not bundle its dependencies, so on a server run `npm ci --omit=dev`
next to `dist/`. See [deploy/README.md](deploy/README.md) for the server, the timer and the keys.

| Command | |
|---|---|
| `npm run once -- --config <file> [--dry-run] [--no-memory]` | one round, from source |
| `npm start -- --config <file>` | one round, from the build (what the timer runs) |
| `npm run approve -- <epoch> [--note "…"]` | approve the waiting draft |
| `npm run reject -- <epoch> [--note "…"]` | publish it as figures alone |
| `npm run backfill -- --config <file> [--namespace <ns>] [--dry-run]` | remember the epochs before the first report |
| `npx tsx scripts/compare-memory.ts --config <file> --epoch <n>` | one finished epoch written twice, with and without memory, side by side (stores nothing) |

Set `GARDENER_CONFIG` instead of repeating `--config`.

Before trusting it, read:

- [docs/dry-run.md](docs/dry-run.md): run a round with your real keys on your own machine, saving nothing.
- [docs/testnet-rehearsal.md](docs/testnet-rehearsal.md): run the whole thing against a copy of the game with short epochs.
- `scripts/check-*.ts`: one small call to each service (Tatum, the chain, Anthropic, Walrus Memory, Walrus).

## Layout

```
src/
  main.ts  round.ts  ready.ts      the program, one round, and when an epoch may be written about
  collect.ts  read.ts  events.ts   the facts: gRPC objects, GraphQL events, assembled with nulls for the unreadable
  facts.ts  display.ts             whole units, and the rounding the screens use
  write.ts  anthropic.ts  llm.ts   the report: the model behind a small interface, one retry, a fixed fallback
  check.ts  policy.ts  numbers.ts  the mechanical checks
  templates.ts                     every fixed text, English and Japanese
  memory.ts  learn.ts  backfill.ts what it remembers and how it grades itself
  walrus.ts  report.ts             storing and reading reports
  chain.ts  tatum.ts  throttle.ts  what the key may sign; the Tatum client
  budget.ts  notify.ts  state.ts   cost brakes, notices, the state file
prompts/system.md                  the model's instructions (their hash is stored with each report)
test/                              unit tests; test/fixtures/chain holds real mainnet responses with addresses replaced
```

## License

MIT. See [LICENSE](LICENSE).
