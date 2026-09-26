# Demo script — six minutes

Chelsea 1–1 Barcelona, Champions League semi-final second leg, 6 May 2009,
replayed on Sepolia against a compressed clock. Ninety match minutes in six
wall-clock minutes: **one wall second is fifteen match seconds.**

Seven beats. Each one lists the command to run and the single thing to point at
while it runs. Timings are the wall clock from kickoff, and they are arithmetic
rather than estimates: minute `m` of the match lands at `m / 90 x 6` minutes.

Each presentation runs on its own demo fixture, **Demo 1 … Demo 7**
(`2026092701` … `2026092707`; see the run sheet in `docs/saturday.md` for which
is which). Each demo has **three agents** under `tokyo.whistle.eth`, one per
playbook: **protect**, **momentum** and **contrarian**. **Demo 1**
(`2026092701`) is the same match, recorded and played to full time (1–1) with
positions still open, so its **redeem** path is populated — it is the settled
showcase, and beat 7 opens it from the fixture list.

**Before beat 1, every time:** open `/fixtures`, pick the demo's row (**JOIN**), and on the pre-match screen press **Activate** if it asks. START MATCH
stays disabled until the fixture is bound. `AgentRegistry` has one market, and
every fixture's deploy repoints it, so agents only trade on the fixture that was
activated last.

Connect **`0x68343Aa0…10f2`** on a **real Sepolia RPC**. It is the operator *and*
the owner of every mandate, so you can create and revoke agents from the UI.

> **Drive it from the browser.** The pre-match screen's START MATCH, then the MATCH SIMULATION panel on the live screen (`/fixtures/<id>`)
> (`NEXT_PUBLIC_SIM=on`) is the primary path: one window, no terminal, same
> contracts and the same fixture file. See **Variant: one window** below for the
> beat order — it is the one to rehearse. `pnpm replay` remains the fallback and
> the rest of this document still describes it faithfully; if the panel misbehaves
> on the day, kill it and run the terminal driver instead. They drive the same
> oracle through the same events.

Measured on an earlier full Sepolia run (fixture `20090506`): 23 events, 16
paginated `tick` calls, 40 agent orders, 22 ENS writes from agent keys, 3
cancellations (all `PRICE_MOVED`, each re-queued once), 126 redemptions, and
**59 wei** of dust left in a 1,844,592.89 USDC pot. Total gas 10,570,490.

---

## Before you start

Three terminals and a browser. Run this in each terminal:

```bash
cd ~/whistle
set -a && . .env && set +a
export WHISTLE_CHAIN=sepolia
export DEPLOYER_PRIVATE_KEY="$SEPOLIA_DEPLOYER_KEY"
export ORACLE_PRIVATE_KEY="$SEPOLIA_ORACLE_KEY"
export KEEPER_PRIVATE_KEY="$SEPOLIA_KEEPER_KEY"
export DEMO_WALLET_KEYS="$SEPOLIA_WALLET_KEYS"
export AGENT_PRIVATE_KEYS="$TOKYO_AGENT_KEYS"
```

Confirm everything is seeded and the fixture is at `PRE_MATCH`. This reads the
chain and sends nothing:

```bash
pnpm deploy:sepolia -- --check
```

Every line should say `done`. If any does not, drop `--check` — the script only
does what is still owed, so it is safe to run at any point.

Browser: **http://localhost:3100/fixtures**. (`/` is the landing page; "Launch
app" and the wordmark land here.) Open the demo's row: before kick-off it is the
pre-match screen; once kickoff lands the same URL is the live board (pitch view,
Cards/Pitch toggle right of the stats strip); after full time it is settlement.

| Route | What it is |
|---|---|
| `/fixtures` | Every fixture, its state from the chain, and the one thing to do next. |
| `/fixtures/<id>` | PRE_MATCH: mint, add an agent, Start — one screen. LIVE: the board and the sim panel. SETTLED: payouts and Redeem. |
| `/agents` (**My agents**) | Your mandates across fixtures: Pause, Revoke, and the full New agent form. |
| `/profile/<name>` | One agent's ENS records and who may write each. Reached with **VIEW** on any agent card; takes `agent-1`, the full name, or the key. |

`/fixture` and `/settlement` still resolve — they redirect to `/fixtures`.

**Eleven of the thirty-six cards have a pool** and can be traded; the rest are
mint-and-redeem only and the app labels them "Mint only". The eleven are exactly
the cards these beats touch:

| | | |
|---|---|---|
| 5 Michael Essien | 25 Andres Iniesta | the two goalscorers |
| 21 Eric Abidal | | sent off at 66' |
| 0 Petr Cech | 18 Victor Valdes | the two keepers, one concedes in each half |
| 2 John Terry, 4 Ashley Cole | 19 Carles Puyol | the defences in front of them |
| 9 Florent Malouda | | substituted off at 65' |
| 10 Didier Drogba | 26 Lionel Messi | the momentum and contrarian targets |

> **The demo fixture is protected.** `PROTECTED_FIXTURES` in `.env` lists
> `20260923`, and `replay.ts`, the agent runtime and `deploy:sepolia` all refuse
> to write to it on a real network. Replaying a fixture settles it, and a settled
> fixture cannot be reopened — it needs a new pot, 36 new cards, a newly mined
> hook and six fresh agent keys. To rehearse, fork Sepolia and point
> `WHISTLE_RPC_URL` at the fork; the guard exempts a local node and says so.
> Remove the id from `PROTECTED_FIXTURES` when it is time to run for real.

> **The keeper needs its own key.** The oracle and the keeper both send
> transactions throughout, and sharing one key means two transactions claiming
> one nonce — `waitForTransactionReceipt` then hangs forever. `replay.ts` warns
> if it sees the same address twice.

---

## Beat 1 — Kickoff and mints (0:00 – 0:36)

**Terminal 1**, the oracle and keeper:

```bash
pnpm replay -- --fixture fixtures/che-bar-2009-05-06.json --minutes 6 --cards 4 --page 8
```

**Terminal 2**, the three agents:

```bash
pnpm agents -- --fixture fixtures/che-bar-2009-05-06.json
```

**Point at:** the live screen (`/fixtures/<id>`). Thirty-six cards, two lineups, a price on every
one of them before a ball is kicked. Those prices are not a market opinion —
`R_i = Pot · E_i / D` is arithmetic on the expected-points priors, and it is why
the book has a reference price for a substitute who may never come on.

The state badge flips to **Live** and the clock starts moving. Everything from
here is a function of that minute.

---

## Beat 2 — 9', Essien scores (0:36)

*Measured: `postEvent` ~100k gas; the next `tick` clears at ~443k.*

Nothing to run. The replay posts it.

**Point at:** the Essien row going amber for one beat, then settling back. The
single bold colour in the whole app is spent on a price that just moved, and it
only moves because a footballer did something.

Read the number out: Essien's `R` steps up, and **every other card steps down** —
the pot is fixed, so `D` grew and everyone else's share of it shrank. That is the
part a bonding curve cannot do.

To see it as a table rather than a screen, Terminal 1 prints the full `R` table
after every event.

---

## Beat 3 — An agent, and a name that resolves (1:00 – 2:00)

Browser: the demo's **pre-match screen**, ADD AGENT on the right. Pick
**Momentum**, cap **500**, max move 10%, and press **CREATE AGENT-N**; it appears
under MY AGENTS ON THIS MATCH. (The full form is also on **My agents**.) There is no address to paste: the server
assigns a Whistle-managed key for this fixture, funds it and starts driving it,
and the success note shows the address. (If the wallet has not signed in yet,
the first click asks for the operator signature, then the `createAgent` prompt.)

> **Create it before Start.** A managed agent starts with USDC and no cards, so
> Protect has nothing to trim; Momentum buys the scorer of the next goal, and the
> step route gives agents their turn after goals, cards and subs. The next goal
> after kickoff is Essien at 9' (~18 s in at 3m) — created later, it waits for
> 93'. On a fork: created pre-match, it queued its buy on the 9' goal and filled
> 248.8 of its 500 USDC.

One transaction does three things: mints `agent-N.tokyo.whistle.eth` in our own
Permissioned Registry, writes the mandate into that name's text records, and
**drops `ROLE_SET_TEXT` from `AgentRegistry` itself**, so from that moment the
registry cannot rewrite the mandate it just issued.

Then prove the name is real — not a label in our database:

```bash
cast call 0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3 \
  'resolve(bytes,bytes)(bytes,address)' \
  0x076167656e742d3105746f6b796f0777686973746c650365746800 \
  $(cast calldata 'text(bytes32,string)' \
      $(cast namehash agent-1.tokyo.whistle.eth) template) \
  --rpc-url $SEPOLIA_RPC_URL
```

**Point at:** that is ENS's own UniversalResolverV2 on Sepolia, walking
`eth → whistle → tokyo → agent-1` through registries we do not control until the
last two hops, and handing back the template id the agent reads its instructions
from. The agent does not read its strategy from a config file.

---

## Beat 4 — 66', red card, and one price for everyone (4:24)

This is the beat the whole design exists for. Abidal is sent off; Barcelona's
expected points collapse; every card reprices at once; and both agents and humans
have orders sitting in the queue across that jump.

On the Sepolia run this is where the protect agents fired: **agent-1 and agent-2
both trimmed Eric Abidal at −7562 bps**, and the contrarians faded Victor Valdes
at −3666 bps after he conceded. Those are real log lines, not a script.

**Point at:** the keeper's `tick` output in Terminal 1, and specifically at
`BatchCleared`. Buyers and sellers in the same batch clear at **one** price —
the reference price at fill time, not the price each of them saw at submit. No
one at the front of the queue got a better fill than someone at the back, and
nothing could be sandwiched in between, because there is no curve to walk.

Orders whose `R` moved further than their tolerance are cancelled rather than
filled at a price the trader did not agree to. The count is printed.

If you want the receipt afterwards:

```bash
cast logs --from-block latest-40 --address 0xdF4c1b5fb7D20dbab0ff9Fa0E734845872E24088 \
  'BatchCleared(uint256,address,uint256,uint256,uint256)' --rpc-url $SEPOLIA_RPC_URL
```

---

## Beat 5 — Pause, then Revoke, then a transaction that fails (4:40 – 5:30)

Browser: **/agents**. The left pane is your six mandates, newest last; the right
pane is the form for a new one and the ledger of what the agents have done.

Press **Pause** — bottom-left of `agent-1`'s card. It writes `spend-cap = 0` to the agent's own ENS resolver — a
key only the user holds a role for. No flag, no contract call into Whistle. The
agent stops on the next block because `isAuthorized` reads the cap live, and it
would resume the moment the cap went back up.

Press **Revoke** — the red button on the far right of `agent-6`'s card. This one
is permanent: the agent's roles are revoked and its name is unregistered. The
card loses its buttons and keeps only **VIEW**, because there is nothing left to
do to it.

**Point at:** the panel that appears underneath. The app simulates that agent's
*next* `queueOrder` and shows you the revert. The mandate is not gone because we
stopped asking — it is gone because the ENS read the contract performs now fails.
There is no cached copy of the authorisation anywhere that could keep it alive.

Terminal 2 shows the same thing from the agent's side: it treats `REVOKED` as a
normal outcome and stops, rather than crashing.

---

## Beat 6 — Payouts, on the fixture that is already finished

**Full time is not a live beat.** Waiting for 93' and `postFinal` costs about
ninety seconds of chain time in which nothing new is demonstrated — the scoring
cross-check has already happened by then and cannot be seen happening. So the
payout screen comes from fixture `20260922`: the same match, played out and
fully redeemed, reachable from the header selector or directly:

```
http://localhost:3100/fixtures/2026092701
```

**Point at:** the five cells across the top — pot paid out, left in pot,
redemptions, vault result, protocol fees — then the returns, and where they come
from. `payoutPerUnit` is a live
view over the current pot, so on a fully redeemed fixture it reads zero — every
position would show −100%, which is the opposite of what happened. What the
screen shows instead is the **realised** payout from `Redeemed` events against
the **actual** cost from `Minted` events:

| | |
|---|---|
| Michael Essien | **+126.9%** — scored at 9' |
| Andres Iniesta | **+117.8%** — equalised at 93' |
| Eric Abidal | **−78.4%** — sent off at 66' |
| Petr Cech, Victor Valdes | **−23.2%** — a goal conceded each |
| Unused substitutes | **−100%** — they never came on |

Say the last row out loud. A card for a player who never played is worth nothing
at settlement, and the pot it was minted into paid that money to the players who
did. That is the whole mechanism in one line.

Then, if asked where the money went:

```bash
cast call 0x06CDa39407E90ccc8Ec47dd463c42C92fc0242Ae 'potBalance()(uint256)' \
  --rpc-url $SEPOLIA_RPC_URL
```

**59** — fifty-nine millionths of a cent left in a 1,844,592 USDC pot after 126
redemptions. Not float, rounding.

### Closing thirty seconds — the agent's own records

**Browser:** **/profile/agent-1.tokyo.whistle.eth**.

**Point at:** the `last-action` record, the **AGENT** chip in its Writable-by
column, and the address beside it. The agent wrote
that line itself, from its own key, using a role its user granted it in
`createAgent`. The `spend-cap` line next to it was written by the user, and the
agent cannot touch it. Same name, different keys, and you can tell which is which
by looking — which is the whole argument for putting the mandate in ENS rather
than in a database.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Every `postEvent` reverts `FutureEvent` | The chain's clock is behind the event stamps | `replay.ts` stamps from the chain; check the oracle key is the one holding `oracle.whistle.eth` |
| A transaction hangs forever waiting for a receipt | Oracle and keeper sharing a key | Separate keys; `replay.ts` warns if it sees one address twice |
| "Timed out waiting for transaction to be confirmed" | The RPC gave up on the receipt; the transaction is usually fine | Every script now re-checks the hash directly before failing. Rerun — nothing is paid for twice |
| `Unauthorized` on every agent order | The mandate expired | Mandates are time-bounded by design; re-run `createAgent` |
| The keeper falls behind the clock | Page size too large for the block gas limit | Lower `--page`; the tick is paginated by card |
| The app's event feed is empty and settlement says "no mint in last N blocks" | `NEXT_PUBLIC_LOGS_RPC_URL` points at an endpoint that caps `eth_getLogs` | Alchemy's free tier allows **ten blocks**. Use `https://ethereum-sepolia-rpc.publicnode.com` for logs |
| A card offers no trade form, only "Mint only" | That card has no pool | By design — eleven of thirty-six are pooled. Pick one from the table above |

---

## The three-minute judging variant

Judges arrive when they arrive, and ninety minutes of football compressed to
three still opens with half an hour of heartbeats. This variant spends none of
their time on them: the match is at 60' before they sit down, and the first thing
they see is the red card.

**The live fixture carries beats 1 to 5 only.** Full time is not worth waiting
for on stage — it is ninety seconds of chain time during which nothing new is
argued — so the payout screen comes from fixture `20260922`, which is already
played out and fully redeemed. Nothing is faked by doing this: it is the same
contracts, the same match, finished.

`--fast-until 60` sends every event up to minute 60 as **one batch of
transactions** and waits only for the last receipt. Earlier it waited for each,
which cost a Sepolia block apiece — 170 seconds of empty board.

**Two minutes before they arrive**, start the agents and the replay:

```bash
pnpm agents -- --fixture fixtures/che-bar-2009-05-06.json     # terminal 2
pnpm replay -- --clock 3m --fast-until 60 --cards 4 --page 8  # terminal 1
```

`--clock 3m` also sets the order delay it reports to **15 s** rather than the
production 30 s, because at this compression 30 s is fifteen match minutes — an
order queued on the red card would not fill until after full time. The banner
says so, and says what the chain's own `L` is, since that is the number that
actually decides when a fill happens.

### What to click, in order

The board opens on the **pitch view**. Everything below is one click from it.

| When | Where | Do this | Say this |
|---|---|---|---|
| −2:00 | terminal | Start agents, then the replay | Fourteen events go out in one batch; the board is at 60' in about forty seconds. |
| 0:00 | live screen | Nothing — let them look | Thirty-six shirts, a price on each, moving off a match clock rather than a bonding curve. The strip reads the pot, what you hold, the order delay, and the seconds to the next tick. |
| 0:05 | live screen | Click **ESSIEN**, the blue 5 in Chelsea's midfield | The order bar at the bottom loads him. Every shirt is a button; the bar is the only place an order is ever built. |
| 0:12 | live screen | Watch **ABIDAL** — Barcelona's 22, back line, right of centre | Sent off at 66'. His shirt goes dark red, his tag drops 5.13 → 1.25, and the chip in the corner turns **BAR · 4-3-3 · 10 MEN**. Every other card reprices in the same block, because the pot is fixed and his share of it just left. |
| 0:20 | live screen | Point at **NEXT TICK** counting down | Buyers and sellers in that batch fill at one price. Nobody at the front of the queue does better than the back, because there is no curve to walk. |
| 0:30 | live screen → **EVENTS** | Click the EVENTS overlay | Each line is a `MatchEvent` and one sentence on what it did to the board. |
| 0:40 | `/agents` | Top nav, second item | Six mandates, each an ENS name with its own resolver. The tint on the little card is the playbook: green protect, blue momentum, yellow contrarian. |
| 0:50 | `/agents` | Click **PAUSE** on `agent-1` (first card, bottom-left button) | It writes `spend-cap = 0` to that agent's own resolver — a key only you hold the role for. The badge turns **PAUSED** immediately and the button becomes **RESUME**; the chain confirms about twenty-five seconds later. |
| 1:10 | `/agents` | Click **REVOKE** on `agent-6` (last card, red button, far right) | Permanent. The name is unregistered, so `isAuthorized` fails at its first check and any order it has queued cancels `REVOKED` on the next tick. |
| 1:30 | `/agents` | Point at the panel that appears at the top | Whistle simulates that agent's *next* `queueOrder` and shows the revert verbatim. The mandate is not gone because we asked it to stop — it is gone because an ENS read the contract performs now fails. |
| 1:45 | `/profile/agent-6` | Click **VIEW** on the revoked card | Every record on the name, and who may write each one. `spend-cap` and `slippage` say **YOU**; `status` and `last-action` say **AGENT**; `matches-played` says **WHISTLE**. That column is read off the resolver's role grants, not asserted by this page. |
| 2:00 | `/profile/agent-6` | Point at **LAST WRITTEN** | The mandate records say *at creation · by Whistle* — set by the registry, which dropped its own write role in the same transaction. Anything the agent has written since carries the agent's own address and the match minute it wrote it. |
| 2:15 | header selector | Switch the dropdown, top right, to **Chelsea 1–1 Barcelona (settled)** | Same contracts, same match, already played out with positions still open — so the redeem path is populated. `?f=20260922` opens it directly. |
| 2:20 | settlement screen | Same URL after full time, or Demo 1 from `/fixtures` | The pot was fixed at full time and split by final score. |

**Judges sit down to settled payouts: about 2 minutes 30.**

**Where the time actually goes.** Measured on a fork of Sepolia at block
11767936, driving the real UI headlessly through all five beats:

| Beat | Wall | The wait, and what it is |
|---|---|---|
| live screen at 60' | 0.2 s | The warm-up batch has already landed. |
| 66' red card | 11.2 s | Waiting for the event itself — the compressed clock, not the chain. |
| Pause + Revoke | 5.9 s | Both transactions and the revert proof. |
| `/profile/agent-6` | 0.8 s | |
| settlement screen | 3.8 s | Log scan, cached after the first visit. |

**60' to the settlement screen: 89 seconds, zero console errors.**

Two of those numbers are fork numbers and will not hold on the day. Anvil mines
instantly, so **Pause is ~25 s and Revoke ~45 s on Sepolia** — real block
inclusion. The UI moves its badge the moment you click, on purpose: a button that
only greys out for twenty-five seconds reads as a dead click, so the badge runs
ahead of the chain and settles when the next read confirms it. If the transaction
fails, the badge goes back. The one thing you cannot speed up is block time, so
the script is built to have something to say during it.

---

## Morning of

Twenty minutes before. Each line is a command, not a judgement call.

**1. The deployment is whole.**

```bash
cd ~/whistle && set -a && . .env && set +a
pnpm deploy:sepolia -- --check
```

Six lines, all `done`. Anything else: rerun without `--check`.

**2. The RPC keys are origin-restricted.** Both `NEXT_PUBLIC_*` values ship to
every visitor's browser. In the provider dashboard (Alchemy or Infura →
Allowlist → HTTP referrers) confirm the app's key is limited to
`http://localhost:3000`, and that it is *not* the key any script signs with. A
key that has been pasted into a chat or a commit is spent — rotate it.

**3. History is readable.** The event feed and the settlement basis come from
`eth_getLogs`, and a capped endpoint empties them silently.

```bash
cast logs --from-block 11754576 \
  --address 0x06CDa39407E90ccc8Ec47dd463c42C92fc0242Ae \
  'Minted(address,address,uint256,uint256)' \
  --rpc-url "$NEXT_PUBLIC_LOGS_RPC_URL" | grep -c blockNumber
```

Prints `161`. If it errors with "up to a 10 block range", that endpoint cannot
serve history — use Infura or `https://ethereum-sepolia-rpc.publicnode.com`.

**4. Every key can pay.** The oracle and keeper send ~25 transactions each.

```bash
for k in SEPOLIA_DEPLOYER_KEY SEPOLIA_ORACLE_KEY SEPOLIA_KEEPER_KEY TOKYO_USER_KEY; do
  a=$(cast wallet address --private-key ${!k})
  echo "$k $a $(cast balance $a --rpc-url $SEPOLIA_RPC_URL --ether)"
done
for k in $(echo "$TOKYO_AGENT_KEYS" | tr ',' ' '); do
  a=$(cast wallet address --private-key $k)
  echo "  agent $a $(cast balance $a --rpc-url $SEPOLIA_RPC_URL --ether)"
done
```

Deployer above 0.05 ETH; oracle, keeper and every agent above 0.01.

**5. Clock drift.** `MatchOracle` rejects any event stamped ahead of
`block.timestamp`, so a laptop running fast makes every `postEvent` revert.

```bash
echo "local $(date +%s)  chain $(cast block --rpc-url $SEPOLIA_RPC_URL latest -f timestamp)"
```

A minute or two apart is fine; the replay stamps from the chain's own clock.

**6. The live fixture is at PRE_MATCH and its mandates are live.**

```bash
cast call 0x0333f424E73b9aeD547B115919Ea4a4fB472C5D6 'fixtureState(uint256)(uint8)' \
  20260922 --rpc-url $SEPOLIA_RPC_URL     # 0 = PRE_MATCH
cast call 0x38E67Af1161ce02AFaC03f2A6002661AeB5aCa2a 'agentCount()(uint256)' \
  --rpc-url $SEPOLIA_RPC_URL              # 12 — six per fixture
```

**7. The frontend is running and pointed at the live fixture.**

```bash
cd web && pnpm dev          # see docs/run-local.md for the two RPC variables
```

Open http://localhost:3100/fixtures. The demo's row reads **PRE-MATCH**, and its
pre-match screen lists thirty-six players with a price on each.

**8. The settled showcase opens from the list.** Open **Demo 1** (SETTLED). It
should read **Chelsea 1 – 1 Barcelona · FULL TIME · SETTLED** with a payout
column of real returns. If the returns read `—`, the logs endpoint is the
problem, not the data.

---

# The one-window flow (primary)

Same demo, same contracts, no terminal. **This is the path to rehearse.**

Verified end to end on a fork of the current deployment: 11/11 beats, 0 console
errors, 0 on-screen values disagreeing with chain state, and a separate re-run of
the Revoke → reload → full-time → settlement beats also green. `postFinal` is
accepted and the pot settles. Requires `NEXT_PUBLIC_SIM=on` and the
three `SIM_*` server variables (see [saturday.md](saturday.md)) — no admin token; the operator's wallet signature gates the routes. The terminal path is unchanged and is the **fallback**: `pnpm replay` drives the
same fixture file through the same oracle, and nothing here alters it.

The difference is only *who asks*. `replay.ts` is a process that sleeps between
events; the panel is a tab that asks the server "what needs doing?" every three
seconds, and the server does exactly one thing per ask. Same events, same order,
same monotonic-minute guard on chain.

| Beat | What you do | What to say |
|---|---|---|
| 0 | Open `/fixtures`, connect 0x6834…, open the demo's row. On the pre-match screen: **Activate** if asked, then **Sign in as operator** under START MATCH — one wallet signature; the line reads *Signed in as operator · replays 6 May 2009 on Sepolia*. | "No password on the server: it checks my signature against the contract's operator. The keys are on the server, the clock is in this tab, and the server stores nothing — it asks the chain what has happened and does one thing about it." |
| 1 | MINT a card from the market table (the order bar opens at the bottom of the pane), then ADD AGENT — Momentum, cap 500 — on the right. | MY CARDS and MY AGENTS ON THIS MATCH fill in on the same screen. |
| 2 | **START MATCH**. Confirm the dialog if the fixture is protected. The same URL becomes the live screen within a block. | "Kickoff is one-way, so it asks once." |
| 3 | Watch the status line: *posting 9' GOAL Essien…*, then *waiting for inclusion*. | "Every line is a transaction against Sepolia. Nothing here is a mock." |
| 4 | **Skip to 60'** | "The clock jumps; the chain does not. Every intervening event is still posted, one per call, because the scoring depends on having seen them." |
| 5 | The red card lands. Prices move. | Same beat as the terminal demo. |
| 6 | Go to `/agents`, **Revoke** one. Come back. | See the three proofs below. |
| 7 | Let it reach full time: the same URL becomes the settlement screen. Or open Demo 1 from `/fixtures` for a settled one with positions to redeem. | Unchanged. |

Two behaviours worth demonstrating deliberately, because they look like bugs
and are not:

- **Pause really stops the chain.** Press Pause, wait, point at the minute
  counter not moving — and at the card's reference price not moving either. An
  order queued during the pause sits in the queue at that price.

  Be precise about what happens next, because the obvious phrasing is wrong: the
  order fills at the reference price **when the keeper ticks it**, not at the
  price it was queued at. If you Resume and an event lands before the tick, the
  fill price has moved. Measured on a fork: queued at 1.254061, filled at
  1.253832 once the match restarted. What the pause guarantees is that nothing
  moves *while it is paused*, not that a queued order is price-locked.
- **Reload mid-match.** The panel reads `/api/sim/status`, finds the chain at
  61', and resumes from there. Closing the tab pauses it; it does not abandon it.

The minute shown in the panel header is the **chain's**, not the compressed
clock's. When the chain cannot keep up with the requested speed the clock
re-anchors to it, so the two never drift apart on screen.


## The Revoke beat: what the proof actually is

Say this precisely, because the obvious claim is not the one the chain supports.
A reverted `queueOrder` **emits no event**, so there is no log row showing a
refused order and nothing for `/agents` to index. If you promise the audience a
row that appears, it will not.

Three things do prove it, and all three are on screen:

1. **The REVOKED badge** on the agent's card — derived from
   `registrationStatus != REGISTERED`, read from the subregistry, not from
   anything Whistle stores.
2. **`isAuthorized` is false.** The card's simulated order shows the revert; the
   registry is the one answering.
3. **The agent's own refused entry.** `last-action` reads
   `refused: mandate revoked · 66'` and `status` reads `revoked`.

The third is the interesting one and it needs its caveat said out loud. Those are
records the **agent** holds the write role for, and `revokeAgent` revokes only
`ROLE_SET_RESOLVER` on the registry — never the per-key `setText` grants on the
agent's own resolver. So a cut-off agent keeps exactly enough authority to report
that it was cut off. Verified on a fork: after revocation `isAuthorized` is false
and registration status is 0, and both writes still land.

The UI labels it **"self-reported by the agent"** on the card and the profile, and
you should say the same: this is the agent's testimony, not the chain's verdict.
That is a stronger demo than pretending otherwise — the permission system is
what stops the order, and the agent is left able to say so.
