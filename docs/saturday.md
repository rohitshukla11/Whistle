# Saturday

The operational half of [demo-script.md](demo-script.md). That one says what to
show; this one says what to check before you show it, and what to say while the
chain is thinking.

Read it twice: once twenty minutes before, once in the two minutes before they
sit down.

---

## Twenty minutes before

Each line is a command, not a judgement call.

### 1. The deployment is whole

```bash
cd ~/whistle && set -a && . .env && set +a
pnpm deploy:sepolia -- --check
```

Six lines, all `done`. Anything else: rerun without `--check` — it does only what
is still owed.

### 2. The demo fixture is still protected

```bash
grep PROTECTED_FIXTURES .env      # PROTECTED_FIXTURES=20260923
```

While that id is listed, `replay.ts`, the agent runtime and `deploy:sepolia` all
refuse to write to it on a real network. **Leave it listed until you are about to
run for real**, then remove it. A replay settles the fixture it runs on, and a
settled fixture cannot be reopened — it costs a new pot, 36 new cards, a newly
mined hook and six fresh agent keys.

A local node is exempt, so rehearsals on a fork need no change.

### 3. The RPC keys are separated and restricted

Three distinct roles, and they must not be one key:

| Variable | Used by | Check |
|---|---|---|
| `SEPOLIA_RPC_URL` | oracle, keeper, agents, scripts | signs nothing, but everything reads through it |
| `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_LOGS_RPC_URL` | the browser | origin-restricted to `http://localhost:3000` |
| `FORK_RPC_URL` | `anvil --fork-url`, nothing else | a second free app, so a rehearsal cannot rate-limit the demo |

In the provider dashboard (Alchemy or Infura → Allowlist → HTTP referrers)
confirm the browser key is limited to localhost and is *not* a key any script
signs with. **A key that has been pasted into a chat or a commit is spent —
rotate it.**

### 4. History is readable

The event feed and the settlement basis come from `eth_getLogs`, and a capped
endpoint empties them silently rather than erroring where you can see it.

```bash
cast logs --from-block 11754576 \
  --address 0x06CDa39407E90ccc8Ec47dd463c42C92fc0242Ae \
  'Minted(address,address,uint256,uint256)' \
  --rpc-url "$NEXT_PUBLIC_LOGS_RPC_URL" | grep -c blockNumber
```

Prints `161`. If it errors with "up to a 10 block range", that endpoint cannot
serve history — use Infura or `https://ethereum-sepolia-rpc.publicnode.com`.

### 5. Every key can pay

The oracle and keeper send about twenty-five transactions each.

```bash
for k in SEPOLIA_DEPLOYER_KEY SEPOLIA_ORACLE_KEY SEPOLIA_KEEPER_KEY TOKYO2_USER_KEY; do
  a=$(cast wallet address --private-key ${!k})
  echo "$k $a $(cast balance $a --rpc-url $SEPOLIA_RPC_URL --ether)"
done
for k in $(echo "$TOKYO2_AGENT_KEYS" | tr ',' ' '); do
  a=$(cast wallet address --private-key $k)
  echo "  agent $a $(cast balance $a --rpc-url $SEPOLIA_RPC_URL --ether)"
done
```

Deployer above 0.05 ETH; oracle, keeper and every agent above 0.01.

### 6. Clock drift

`MatchOracle` rejects any event stamped ahead of `block.timestamp`, so a laptop
running fast makes every `postEvent` revert.

```bash
echo "local $(date +%s)  chain $(cast block --rpc-url $SEPOLIA_RPC_URL latest -f timestamp)"
```

A minute or two apart is fine; the replay stamps from the chain's own clock.

### 7. The live fixture is at PRE_MATCH and its mandates are live

```bash
cast call 0x0333f424E73b9aeD547B115919Ea4a4fB472C5D6 'fixtureState(uint256)(uint8)' \
  20260923 --rpc-url $SEPOLIA_RPC_URL     # 0 = PRE_MATCH
cast call 0x38E67Af1161ce02AFaC03f2A6002661AeB5aCa2a 'agentCount()(uint256)' \
  --rpc-url $SEPOLIA_RPC_URL              # six per fixture
```

### 8. The frontend is running and on the live fixture

```bash
cd web && pnpm dev          # see docs/run-local.md for the two RPC variables
```

Open http://localhost:3100/fixtures — the app's home. Every row carries its
state from the chain: **Demo 1** reads SETTLED, **Demo 2** and
**Demo 3** read PRE-MATCH. Open the demo's row: before kick-off that is the
pre-match screen (market table left, match panel, your cards and agents right).

### 9. Open the settled showcase once, now

```
http://localhost:3100/fixtures/2026092701
```

**Do this before they arrive, not in front of them.** Two reasons:

- It is the last beat of the demo, and the one place a slow load is fatal — there
  is nothing to narrate over a blank payout table.
- It proves the whole history path end to end: the payouts column needs `Minted`
  and `Redeemed`, and if the logs endpoint is capped you will see `—` in the
  Move column here rather than discovering it on stage.

It should show a snapshot of **1,844,592**, **Left in pot 0**, and real returns —
Essien **+126.9%**, Abidal **−78.4%**. If the returns read `—`, the logs endpoint
is the problem, not the data; fix it at step 4 and reload.

The build ships a frozen copy of this fixture's logs (`web/public/settled/`), so
the payouts and the Move column arrive together in about **2.3 seconds**. If it
takes tens of seconds, the snapshot is missing — rerun `pnpm vendor` with a
logs-capable `SNAPSHOT_RPC_URL` and rebuild. Confirm it exists:

```bash
ls web/public/settled/          # 20090506.json, 20260922.json
```

**Then switch the selector back to the live fixture before you start.**

---

## How long the build itself takes

Measured on Sepolia, not estimated. These are why the plan runs the night before
rather than on the morning:

| Phase | Sepolia | What dominates |
|---|---|---|
| Venue deploy (`DeployFixture`) | **~3 min** | ~12 transactions, `--slow`, one block each |
| Seed (pools, float, wallets, mandates) | **~35 min** | 55 cap exemptions, 11 pools and 8 wallet portfolios, all block-bound |
| Settlement replay (`--clock 3m`) | **~20 min** | 23 events plus keeper ticks; the 3-minute clock is the *match*, not the wall |

**Two fixtures is roughly 1 hour 40 minutes of mostly waiting**, and the replay
only runs on the one being settled. `pnpm deploy:sepolia -- --plan saturday`
drives all of it and resumes from wherever it stopped, so a crash costs the phase
it crashed in rather than the evening — but it is not a thing to start an hour
before judging.

---

## The waits, and what to say during them

Block time is the one thing you cannot speed up. Every wait below is expected, and
each has a sentence that is *about* the wait rather than an apology for it. The UI
moves its badge the moment you click, so the screen is never dead — but the chain
has not agreed yet, and that gap is worth narrating rather than hiding.

| Wait | How long | What is actually happening | Say this |
|---|---|---|---|
| **Pause → chain agrees** | ~25 s | One `setText` on the agent's own resolver, writing `spend-cap = 0` | "That is a write to the agent's own ENS resolver, on a key only I hold the role for. The badge has already moved because the app knows what I asked for; in about twenty-five seconds the chain will agree, and from that block `isAuthorized` returns false. Nothing was asked of the agent — it has no say in this." |
| **Revoke → chain agrees** | ~45 s | `revokeAgent`: roles revoked, then the subname unregistered — two storage writes and a burn | "This one is permanent. It is not a flag being set to false; the name itself stops existing. Any order that agent already has in the queue will cancel `REVOKED` on the next tick, and its next `queueOrder` will revert." |
| **Revoke → revert proof appears** | ~5 s after the above | The app simulates that agent's *next* `queueOrder` and shows the revert verbatim | "That panel is not a message we wrote. The app asked the chain to simulate the agent's next order and is showing you what came back. The mandate is gone because an ENS read the contract performs now fails — there is no cached copy of the authorisation anywhere that could keep it alive." |
| **Red card → the tick clears** | ~30 s (the fixture's `L`) | The order delay: orders sit for `L` seconds before the keeper can fill them | "Every order waits thirty seconds before it can be filled, agents included. That is the whole anti-frontrunning design: the delay is the same for a bot that saw the red card in the mempool and for someone who saw it on television. When it clears, everyone in that batch fills at one price." |
| **First paint of `/fixture`** | ~3 s | About two hundred multicalls for thirty-six players | "Thirty-six cards, each with a price, an expected score and a status, all read from contract state." |
| **First paint of `/settlement`** | ~1 s | A frozen snapshot of the settled fixture's logs, shipped with the build | "That fixture is finished, so its history cannot change — we read it once at build time instead of asking the chain again." |

Two rules for all of them:

1. **Do not fill the silence by clicking.** A second Pause while the first is
   pending sends a second transaction and makes the badge flicker between states.
2. **If a transaction fails, the badge goes back on its own.** Say so and move on
   — it is the app correcting itself, not the demo breaking.

---

## If something goes wrong

| Symptom | Almost certainly | Do this |
|---|---|---|
| `/settlement` sits on "Reading the fixture…" | The logs endpoint is capped, or the snapshot is missing | Switch `NEXT_PUBLIC_LOGS_RPC_URL` to Infura and reload |
| Score reads `–` with a yellow caption | Same — the score is counted from `MatchEvent` logs | Same. Prices and points are unaffected; say so |
| A card offers only "Mint only" | That card has no pool | By design: 11 of 36 are pooled |
| The agents list is empty | The header is on the other fixture | Switch the selector |
| Every `postEvent` reverts `FutureEvent` | Laptop clock ahead of the chain, or the oracle key does not hold `oracle.whistle.eth` | Step 6, then step 1 |
| `refusing to replay against fixture 20260923` | The guard is doing its job | Remove the id from `PROTECTED_FIXTURES` when you genuinely mean to run |

---

## If you are demoing from the browser (one window)

The in-page driver (`NEXT_PUBLIC_SIM=on`) replaces the terminal for the match
itself. `replay.ts` is unchanged and remains the fallback — if the panel misbehaves
on the day, kill it and run `pnpm replay` exactly as below; they drive the same
contracts through the same fixture file.

**Vercel needs three server-only variables set in the dashboard** (Project →
Settings → Environment Variables), none of them prefixed `NEXT_PUBLIC_`:

| Variable | What it is |
|---|---|
| `SIM_ORACLE_KEY` | Posts `kickoff` and every `postEvent`. Must hold `ROLE_POST_EVENT`. |
| `SIM_KEEPER_KEY` | Runs the paginated `tick()`. |
| `SIM_AGENT_KEYS` | Six, comma-separated. Must be the agents registered **for Saturday's fixture** — agents minted against another one are skipped. |
| *(no token)* | The sim routes and `/api/agents/assign` are gated by the **operator's signature**, not a shared secret: the panel asks the connected wallet to sign `Whistle sim · <fixtureId> · <unix minute>` once per session, and the server recovers the signer and requires it to equal `AgentRegistry.operator()`. Accepted for 6 hours, for that fixture. Any other wallet is refused with a plain sentence. |

Plus `NEXT_PUBLIC_SIM=on` to show the panel at all. **No KV, no database, nothing
else.** The server stores nothing: the browser sends the clock with every call
and the cursor through the match is the oracle's own minute, so an instance that
has never seen this match can still take the next step correctly. A match survives
being load-balanced across instances because there is no per-instance state to
lose.

**Connect the operator wallet.** `AgentRegistry.createAgent` is `onlyOperator`,
so creating a mandate from the /agents form only works from that key — any other
wallet simulates to `OnlyOperator` and the page shows the revert. The Saturday
plan therefore registers the user name to the operator address by default
(`DEMO_USER_ADDRESS`, falling back to the deployer), so one wallet can both own
the mandates and mint them live on stage.

> That is a demo arrangement, and worth saying out loud if anyone asks. In the
> demo the operator and the mandate owner are the same key. Production separates
> them: `createAgent` moves behind a server route, or takes a user-signed
> request, so the person granting a mandate never needs the operator's key.

Two things to know before you stand up:

- **Closing the tab pauses the match.** That is deliberate; a match with nobody
  watching would otherwise run on wall-clock time and post twenty events at once
  when someone reopened it. Reopen and press Resume.
- **Start on a protected fixture asks you to confirm.** Saturday's fixture is in
  `PROTECTED_FIXTURES`, so the panel puts up a dialog naming the id. Read it
  before you click — `kickoff` is one-way.


---

## Which fixture is which — fresh single-owner deployment (26 Sep)

| | id | purpose | state |
|---|---|---|---|
| **Today** (A) — hidden | `20260926` | Not listed (`hidden: true`); still opens at `/fixtures/20260926`. The 26 Sep rehearsal, settled (it read 2–1 on chain: its 9' goal was posted twice, since fixed). 0x6834's positions all redeemed. | SETTLED |
| **Demo 1** | `2026092701` | The video run and the settled showcase. Owner 150 / agents 450 / vault 500 + 100 in the pool per card; agents 11–14 at 500 USDC. Settled 1–1. | SETTLED, protected |
| **Demo 2** | `2026092702` | Main judging — paused live. Six pools, vault seeded (20,100 per card), **no owner positions** (you mint), three agents at 500 USDC holding USDC only. | PRE_MATCH, **not** protected |
| **Demo 3** | `2026092703` | Spare. Normal seed. | PRE_MATCH, protected |
| **Demo 4 … 7** | `2026092704` … `2026092707` | Deployed on the morning, as the run sheet needs them (~10 min each). | not deployed |

`/fixtures` lists every deployed fixture with its state read from the chain
(`PRE-MATCH` / `LIVE · <minute>` / `SETTLED`), so a used demo is obvious before
anyone opens it. `/fixture` and `/settlement` still work — they redirect to the list.

**Deploying Demo 1–7** is one command, resumable, from the owner key:

```bash
npx tsx scripts/deploy-demos.ts            # venues, then the seed pipelined across all seven
npx tsx scripts/deploy-demos.ts --report-only   # the morning table: docs/demo-fixtures-report.md
```

Six pools per demo (Čech, Essien, Malouda, Valdés, Abidal, Messi). Venues deploy
back to back; the seed then runs one step at a time **across all seven** — each
step planned from the chain, then sent as one owner-nonce-ordered stream with 8
in flight, so fixture k+1's writes go out while fixture k's are pending. Fixed
gas ceilings, every receipt checked, a dropped transaction resent on its own
nonce, stop on the first revert; rerunning resumes. Fork-tested on Demo 1–2:
6/6 pools, 3 mandates at 500 USDC, PRE_MATCH, `--check` clean, ~5 min of seed.

The previous deployment's files (`20090506`, `20260922`, `20260923`) are archived
in `deployments/archive-2026-09-26-pre-fresh/`. They still exist on chain, but
the app no longer lists them.

## Run sheet

Every presentation, on one screen, connected as 0x6834…:
**/fixtures → the demo's row (JOIN) → on the pre-match screen: Activate
if it asks → Sign in as operator → mint a player or two (MINT on a row, then
Confirm in the order bar) → Add agent (Momentum, cap 500) → START MATCH.** The
same URL turns into the live screen when kickoff lands — your selection, the
operator signature and the sim clock carry over — and into the settlement
screen at full time.

There is no admin token. The match panel reads **Signed in as operator ·
replays 6 May 2009 on Sepolia** once the wallet has signed; the signature covers
that fixture for 6 hours, so a new fixture asks for one more. A wallet that is
not the operator sees the panel without Start: "Only the operator can start
this match."

**Creating an agent live** (the pre-match screen's Add agent, or My agents → New agent): pick the playbook and cap,
press Create. There is no key to paste — the server hands the form the next
unused Whistle-managed key for the fixture (`whistle:agent:<fixtureId>:<n>`,
n = 4..6), funds its gas from the service key, mints its USDC, approves the
hook, and starts driving it; the success note shows the assigned address. It
takes ~10 s before the wallet prompt. The form has no address field at all; an
external agent address is a direct `createAgent` call (README → Agents).

**Caps.** Demo 1–7's three pre-created mandates are 500 USDC each (the form
defaults to 500 as well), and their agents' seed is sized so they can trade
inside it: 100 heavy / 25 light / 25 other cards and 1,000 USDC each. Sells count
against the cap too, and `protect`'s 40% trim of a 100-card holding is ~300 USDC.
The Settled showcase (A) keeps its original 2,000,000 USDC caps.

Why Activate comes first: `AgentRegistry` has **one** market (the hook allowed
to record agent spend), and each fixture's deploy repoints it at its own hook,
so agents can trade on only one fixture at a time. Activate is one `setMarket`
from the connected operator wallet: one block, about 30k gas. Start stays
disabled until it has landed. The same step from a terminal is
`npx tsx scripts/activate-fixture.ts <id>`.

- [x] **Demo 1 — video** (`2026092701`): done 26 Sep — recorded, settled 1–1; now the settled showcase.
- [ ] **Demo 2 — main judging** (`2026092702`): /fixtures → Demo 2 → Activate → Sign in → mint → Add agent → Start; pause live. Not protected, so no confirm dialog.
- [ ] **Demo 3 — ENS** (`2026092703`): /fixtures → Demo 3 → Activate → Sign in → mint → Add agent → Start (confirm: protected).
- [ ] **Demo 4 — Uniswap** (`2026092704`): deploy first (`npx tsx scripts/deploy-demos.ts --from 4 --to 4`, ~10 min), then as Demo 3.
- [ ] **Demo 5 — Curvegrid** (`2026092705`): deploy first (`--from 5 --to 5`), then as Demo 3.
- [ ] **Demo 6 — World, or spare** (`2026092706`): deploy first (`--from 6 --to 6`), then as Demo 3.
- [ ] **Demo 7 — spare** (`2026092707`): deploy first (`--from 7 --to 7`), then as Demo 3.

Terminal fallback for any demo, with nothing in `.env` changing:

```bash
npx tsx scripts/activate-fixture.ts <id>          # bind the agents to this fixture
pnpm replay -- --single-signer --fixture-id <id> --confirm <id> --clock 3m
pnpm agents -- --fixture-id <id>                  # that fixture's three agents, from .secrets/derived.json
```

`--confirm <id>` opens only the one protected fixture it names, the same bargain
as the panel's confirm dialog.

## Accounts — one owner, everything derived from it

**Connect `0x68343Aa0598b7FCAA102769D172e59cdDfae10f2`, on a real Sepolia RPC.**
It is every admin at once: the deployer, `AgentRegistry.operator`, the hook's
operator and fee recipient, `MMVault.operator`, the owner of `whistle.eth`, and
the `tokyo` user that owns every mandate. Its key is `DEPLOYER_PRIVATE_KEY`.

Two fields are not an EOA, by design, and the ownership table says so:

- **Root registry admin** is the `AgentRegistry` contract — it has to be, to mint
  subnames — and `AgentRegistry.operator()` is 0x6834.
- **`oracle.whistle.eth`** is owned by the **service** key, because
  `EnsRoleAuth` grants the post-event role to that name's owner and to nobody
  else. The service key is derived from 0x6834's, so 0x6834 still controls it.

Every signer is derived deterministically from the owner key as
`keccak256(ownerKey ‖ tag)`:

| signer | derivation tag | used for |
|---|---|---|
| `service` | `whistle:service` | the oracle **and** the keeper — one key, one nonce sequence |
| `A-1..3` | `whistle:A-1..3` | the settled showcase's agents: protect, momentum, contrarian |
| Demo *n* agents 1..3 | `whistle:agent:<fixtureId>:<n>` | each demo's own three: protect, momentum, contrarian |
| `C-1..3` (legacy) | `whistle:C-1..3` | from the first one-demo plan; funded, never used, swept back |

That's **25 active** derived signers (1 + 3 + 7 × 3), plus 3 legacy, so **28**
for the sweep. `.secrets/derived.json` carries a `fixtures` map (fixture id → its
three agent keys), which is how the step route and the terminal drivers pick
agents by fixture id.

`npx tsx scripts/derive-keys.ts --check` prints the seven addresses from the
owner key and writes nothing; without `--check` it (re)writes
`.secrets/derived.json` (gitignored, 0600). No key is ever printed. After a
fixture is done, `npx tsx scripts/sweep.ts --send` returns every signer's ETH to
0x6834 (without `--send` it is a dry run).

Agents cannot be shared across fixtures (`createAgent` reverts
`AgentAddressInUse` for any address that has held a mandate), which is why every
fixture has its own three. Seeded card positions are split **60/40**: 0x6834
holds 60%, and the fixture's three agents hold the other 40% between them.

### One service key, safely

Both drivers now run the oracle and the keeper from one key:

- **Browser** — set `SIM_SERVICE_KEY`. A step does one unit of work and will not
  send from an account that still has a transaction in flight.
- **Terminal fallback** — `pnpm replay -- --single-signer --clock 3m` with
  `SERVICE_PRIVATE_KEY`. Every write is queued behind the previous one's
  inclusion, so the keeper and the event loop never race the nonce.

Both also stop on a reverted transaction instead of carrying on. A reverted
event is otherwise **skipped** — the cursor is the chain's clock — and the
damage only shows at `postFinal` as `FinalScoreMismatch`. That happened on a
fork: the 65' substitution ran out of gas on an under-estimate. `postEvent` and
`postFinal` now carry fixed gas ceilings (unused gas is not charged), and both
drivers were re-run to `postFinal` on a fork in single-signer mode.

