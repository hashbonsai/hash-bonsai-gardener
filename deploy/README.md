# Running the gardener on a server

The gardener is one short program run once an hour by a systemd timer. Each run
decides whether an epoch can be written about yet, and does nothing if not.
The program is built on a development machine; the server needs only Node 20 or
later and the built files.

## 1. A user of its own

Give the gardener its own user, apart from any other bot on the machine, so that
neither can read the other's key files.

```
sudo useradd --system --home-dir /opt/gardener --shell /usr/sbin/nologin gardener
sudo install -d -o gardener -g gardener -m 755 /opt/gardener
sudo install -d -o gardener -g gardener -m 700 /etc/gardener /var/lib/gardener
```

## 2. Install the program

The built program does **not** contain its dependencies (Walrus's WASM package
cannot be bundled), so the server needs `node_modules`, and `npm ci --omit=dev`
installs only what the program runs on.

On a development machine:

```
npm ci
npm run build          # dist/gardener.mjs, approve.mjs, reject.mjs, backfill.mjs
```

Copy `dist/`, `prompts/`, `package.json` and `package-lock.json` to `/opt/gardener`
on the server (owned by `gardener`), then, as that user, in that directory:

```
npm ci --omit=dev
```

(Or build on the server itself: `npm ci && npm run build && npm prune --omit=dev`.)

## 3. The keys and the configuration

Each secret is one file, holding one value, in `/etc/gardener/`, owned by `gardener`,
mode 600: `sui-key`, `tatum-api-key`, `anthropic-api-key`, `memwal-delegate-key`, and
optionally `webhook` (the Discord webhook URL). Write each in your own terminal, so that
the value never appears on screen or in shell history:

```
read -s KEY && printf '%s' "$KEY" | sudo tee /etc/gardener/tatum-api-key > /dev/null && unset KEY
sudo chown gardener:gardener /etc/gardener/tatum-api-key && sudo chmod 600 /etc/gardener/tatum-api-key
```

Then copy `config.example.json` to `/etc/gardener/config.json` and fill in the
gardener's address, your MemWal account id and the namespace. The file holds the
**paths** of the secrets, never the secrets. `requireApproval` is on: leave it on
until you have read the first four reports.

## 4. Try it before it runs on its own

As the `gardener` user, from `/opt/gardener`:

```
node dist/gardener.mjs --config /etc/gardener/config.json --dry-run
```

See [../docs/dry-run.md](../docs/dry-run.md) for what to look for. Then, once, give the
memory its history (see the notes on timing in `scripts/backfill.ts`), the practice
namespace first:

```
npm run backfill -- --config /etc/gardener/config.json --namespace hash-bonsai-gardener-testnet --dry-run
npm run backfill -- --config /etc/gardener/config.json
```

## 5. Start the timer

```
sudo cp deploy/gardener.service deploy/gardener.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gardener.timer
systemctl list-timers gardener.timer
journalctl -u gardener -e
```

Every line in the journal has passed through the redaction; there are no secrets in it.

## 6. Day to day

**Approving.** While `requireApproval` is on, the gardener sends each draft to Discord
(or prints it, with no webhook) and waits. Decide with:

```
sudo -u gardener env GARDENER_CONFIG=/etc/gardener/config.json npm run approve -- 5 --note "Shorter next time."
sudo -u gardener env GARDENER_CONFIG=/etc/gardener/config.json npm run reject  -- 5 --note "Too cheerful."
```

The next hourly round carries the decision out. An approved draft is stored on Walrus; a
rejected one goes out as the figures alone. The note is kept as a memory that shapes how
later reports are written (the prompt tells the model to ignore a note that contradicts the
facts). Type notes yourself; never paste text a player wrote.

**Topping up.** The gardener stops, and says so, when its address holds under 0.1 SUI or
too little WAL for one more save (about 0.54 WAL for the longest storage Walrus sells).
Send both to the gardener's address from your own wallet.

**Stopping.** `sudo systemctl disable --now gardener.timer`. Nothing else runs.

**If the journal says `is not on the gardener's allowlist`.** Walrus upgraded its package
and the new one is not in `walrusPackageIds`. Check the call named in the message is
Walrus's, add its package id, and restart.

**If a key leaks.** Replace the key, then the file; if it is the Sui key, send the funds to
a new address and update `address`. Reports already stored on Walrus cannot be deleted and
hold no secrets.

## 7. Where things are

| Path | What |
|---|---|
| `/opt/gardener` | the program (`dist/`, `prompts/`, `node_modules/`) |
| `/etc/gardener/config.json` | the settings and the paths of the secrets |
| `/etc/gardener/*` | the secrets, one per file |
| `/var/lib/gardener/state.json` | what the gardener remembers between rounds (public data only) |

A damaged `state.json` stops the program with an error instead of starting over, because
starting over would write an epoch twice. Fix or move the file by hand.
