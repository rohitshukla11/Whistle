# Running Whistle locally against Sepolia

Everything here talks to the **live Sepolia deployment**. Nothing is mocked and
there is no local chain: the frontend, the oracle and the agents all read and
write the same contracts the judges will look at on Etherscan.

Four terminals. Copy each block whole.

---

## 0. Once, in every terminal

```bash
cd ~/whistle
set -a && . .env && set +a
export WHISTLE_CHAIN=sepolia
export ORACLE_PRIVATE_KEY="$SEPOLIA_ORACLE_KEY"
export KEEPER_PRIVATE_KEY="$SEPOLIA_KEEPER_KEY"
export AGENT_PRIVATE_KEYS="$TOKYO_AGENT_KEYS"
export DEMO_WALLET_KEYS="$SEPOLIA_WALLET_KEYS"
export DEPLOYER_PRIVATE_KEY="$SEPOLIA_DEPLOYER_KEY"
```

Check the deployment is whole before anything else. This reads the chain and
sends nothing:

```bash
pnpm deploy:sepolia -- --check
```

Six lines, all `done`. If any is not, drop `--check` — the command only does what
is still owed, so it is safe to run at any point.

---

## 1. Frontend

```bash
cd web
export NEXT_PUBLIC_RPC_URL="$SEPOLIA_RPC_URL"            # state
export NEXT_PUBLIC_LOGS_RPC_URL="$SEPOLIA_RPC_URL"       # history
pnpm install          # first time only
pnpm dev              # http://localhost:3000 — landing page
```

**Two RPC variables, on purpose.** State reads and log scans want different
things from an endpoint and not every provider does both:

| | needs |
|---|---|
| `NEXT_PUBLIC_RPC_URL` | to serve the fixture screen's ~200 multicalls. Alchemy and Infura do; publicnode, drpc and 1rpc stall or fail. |
| `NEXT_PUBLIC_SIM` | *(optional)* `on` adds START MATCH to the pre-match screen and the MATCH SIMULATION panel to the live screen (`/fixtures/<id>`). Needs the `SIM_*` server variables below. There is no admin token: the panel asks the connected wallet to sign `Whistle sim · <fixtureId> · <unix minute>`, and the routes accept it for 6 hours if the signer is `AgentRegistry.operator()`. |
| `SIM_SERVICE_KEY` | *(secret, server only)* The single-owner deployment's **one service key**: it posts events *and* runs the keeper. When set it overrides `SIM_ORACLE_KEY` / `SIM_KEEPER_KEY`. It must be the owner of `oracle.whistle.eth`, because `EnsRoleAuth` grants the post-event role to that name's owner and nobody else. Get it from `.secrets/derived.json` (`service`); `scripts/derive-keys.ts` regenerates it. |
| `SIM_DERIVED_FILE` | *(server only)* Path to `.secrets/derived.json`. The step route takes each fixture's agents from it by fixture id (agents 1–3, plus any managed key already assigned), and `/api/agents/assign` hands out the managed pool (agents 4–6) from it and marks them assigned. Leave `SIM_AGENT_KEYS` unset. |
| `SIM_ORACLE_KEY`, `SIM_KEEPER_KEY`, `SIM_AGENT_KEYS` | *(secret, server only, legacy two-key setup)* The keys the simulation signs with. `SIM_AGENT_KEYS` is comma-separated, overrides `SIM_DERIVED_FILE`, and its agents must be registered **for the fixture being driven**. No `NEXT_PUBLIC_` prefix, so none of it can reach a browser bundle. |
| `NEXT_PUBLIC_DEBRIEF` | *(optional)* `on` shows the AI match debrief on `/profile/[agent]`. Needs `ANTHROPIC_API_KEY` set on the server; without it the panel says so rather than sitting blank. |
| `ANTHROPIC_API_KEY` | *(optional, server only)* Used by `/api/debrief`. No `NEXT_PUBLIC_` prefix, on purpose — it must never reach the browser. `DEBRIEF_MODEL` overrides the model, `ANTHROPIC_BASE_URL` the endpoint. |
| `NEXT_PUBLIC_LOGS_RPC_URL` | to serve `eth_getLogs` over thousands of blocks. **Alchemy's free tier answers a ten-block range** and returns HTTP 400 for anything wider, which shows up as an empty event feed and a settlement screen with no cost basis. Infura and publicnode are fine. |

Infura does both, so pointing them at the same URL works. If you only have a free
Alchemy key, use it for state and
`https://ethereum-sepolia-rpc.publicnode.com` for logs.

Both variables ship to the browser. Restrict them in the provider dashboard to
`http://localhost:3000` (Allowlist → HTTP referrers) and never put a signing key
in either.

`/` is the landing page. The app lives one click further in:

| Route | Screen |
|---|---|
| `/` | Landing — "Launch app" goes to the fixture list |
| `/fixtures` | The app's home: every deployed fixture with its state from the chain, your holdings, agents and what you can redeem |
| `/fixtures/[id]` | One fixture, by state. **PRE_MATCH**: the market table (mint at the fixed price), the match panel with START MATCH, your cards, your agents on this match and an inline Add agent — one screen. **LIVE**: the board — lineups, live `R`, order bar, sim panel. **SETTLED**: final scores, payouts, Redeem. The same URL swaps screens by itself at kickoff and at `postFinal`. |
| `/agents` | **My agents**: your mandates across fixtures — create, Pause, Revoke (and, with World ID on, Raise cap / Lower cap) |
| `/profile/[agent]` | One agent's ENS records, and who may write each one.<br>Takes the full name, the bare label or the key: `/profile/agent-1.tokyo.whistle.eth`, `/profile/agent-1` or `/profile/0x…`. A bare `/profile` redirects to `/agents`. |
| `/fixture`, `/settlement` | Old routes; redirect to `/fixtures` (`?f=<id>` goes straight to that fixture) |
| `/api/agents/assign` | Operator-signed. Hands the New agent form the next unused Whistle-managed key for the fixture, funds it and marks it for the step runner; returns the address only. |
| `/api/sim/step` | Server route behind `NEXT_PUBLIC_SIM=on`. Does **one** unit of work per POST — post the next due event, run one `tick()`, let the agents decide, or `postFinal` — and returns without waiting for inclusion. The browser calls it every 3 s. **The server stores nothing**: the browser sends the clock with every call and the cursor through the match is the oracle's own minute, so a cold instance can take the next step correctly and local and Vercel behave identically. |
| `/api/sim/start` | Kickoff, and the only irreversible thing the simulation does — so the two guards live here rather than on a call the tab makes every three seconds. Refuses a fixture that is not PRE_MATCH; needs `confirm=1` for anything in `PROTECTED_FIXTURES`. |
| `/api/sim/status` | Read-only. What the chain says, for a mid-match reload. |
| `/api/world/start` | Behind `NEXT_PUBLIC_WORLD_IDP=on`, operator-signed. Stores a protected action (create agent, raise cap / resume) server-side for five minutes and returns the World ID authorize URL. |
| `/api/world/callback` | The registered redirect URI. Redeems the code, validates the ID token, and only then performs the stored action with the operator key. Anything else: no chain call, redirect to `/world/done` with the reason. |
| `/api/world/status` | What became of one attempt; the page that started it polls this. |
| `/api/debrief` | Server route behind `NEXT_PUBLIC_DEBRIEF=on`. Asks a model for three sentences on what one agent did, from the records and fills the profile page already shows. Off by default; the key stays on the server. |

Open **http://localhost:3000/fixtures**. Each row reads its state from the chain;
open one to reach its pre-match, live or settlement screen at `/fixtures/<id>`.

### HTTPS on :3100, and World ID

The World ID sandbox accepts only HTTPS callbacks, and the one registered for
Whistle is `https://localhost:3100/api/world/callback`. So the local server on
:3100 is HTTPS: `next start` listens on `127.0.0.1:3101` and
`scripts/serve-https.mjs` terminates TLS on :3100 with a mkcert certificate and
forwards to it.

Once per machine:

```bash
~/.local/bin/mkcert -install            # trusts the local CA (asks for your password)
mkdir -p .secrets/tls && ~/.local/bin/mkcert \
  -cert-file .secrets/tls/localhost.pem -key-file .secrets/tls/localhost-key.pem localhost 127.0.0.1 ::1
```

Then build and serve with the sim env:

```bash
cd web
set -a; source ../.secrets/sim.env; set +a
pnpm build && pnpm start:https           # https://localhost:3100
```

Node scripts that talk to it (`rehearse-ui.mjs`, `shots.mjs`, …) default to
`https://localhost:3100`; give them the CA with
`export NODE_EXTRA_CA_CERTS="$(~/.local/bin/mkcert -CAROOT)/rootCA.pem"`.
Use `localhost`, not `127.0.0.1`: the certificate and the World ID sector
(the redirect hostname, fixed at registration) are both `localhost`.

**World ID** is behind `NEXT_PUBLIC_WORLD_IDP=on`. The rule it enforces:
*increasing an agent's authority needs a fresh World ID proof; decreasing it
never does.* With the flag on, creating an agent, raising a cap and resuming a
paused agent (a raise from 0) each show **Verify with World ID**; the browser
only asks the server to start the verification, and the server performs the
action itself after a valid callback. Pause, lowering the cap and revoke stay
one-click wallet transactions ("Stopping or limiting an agent never needs
verification."). A verified action writes `human.agent-N = keccak256(iss ‖ sub)`
on `tokyo.whistle.eth` through its own resolver (`scripts/setup-human-resolver.ts`,
run once per chain); the profile shows it as **human-backed · World ID**.

| variable | |
|---|---|
| `NEXT_PUBLIC_WORLD_IDP` | `on` to require World ID for the actions above |
| `NEXT_PUBLIC_APP_URL` | `https://localhost:3100` |
| `WORLD_ISSUER` | `https://sandbox.auth.world.org` |
| `WORLD_CLIENT_ID` | the registered client |
| `WORLD_REDIRECT_URI` | `https://localhost:3100/api/world/callback`, exactly as registered |
| `WORLD_PRIVATE_KEY_FILE` | *(secret, server only)* the RS256 key for `private_key_jwt`, `.secrets/world-client.pem` |
| `SIM_OPERATOR_KEY` | *(secret, server only)* the operator key the server signs protected actions with |

The sandbox uses mocked proofs: the World ID tab that opens completes by itself
in a couple of seconds with a fake identity. To have a person approve instead,
give them the **Approval link** on that page; they choose *Authenticate with
World ID*, then *Approve sign-in*. There is no Deny in the sandbox's browser
flow — not approving within five minutes is the no, and nothing changes.
`scripts/verify-world-fork.mjs` runs all six cases against a fork.

Unit tests for the callback (bad signature, wrong aud, stale auth_time, state
mismatch, replayed code — each proving the action never runs):

```bash
npx tsx --test web/lib/world/flow.test.ts
```

---

## 2. Oracle and keeper

The keeper runs inside `replay.ts` on its own key, so this one command is both.

```bash
pnpm replay -- --clock 3m --fast-until 60 --cards 4 --page 8
```

- `--clock 3m` — ninety match minutes in three wall-clock minutes.
- `--fast-until 60` — everything up to minute 60 posts back-to-back (about 90
  seconds), then the compressed clock takes over **from that moment**. The 66'
  red card lands live rather than after half an hour of heartbeats.
- `--cards 4 --page 8` — the keeper clears at most four cards and eight orders
  per card per `tick`, which keeps each call inside a comfortable block.

Add `--dry-run` to derive the final scores and send nothing.

> **The keeper needs its own key.** The oracle and keeper both send throughout,
> and one key means two transactions claiming one nonce. `replay.ts` warns if it
> sees the same address twice.

---

## 3. Agents

```bash
pnpm agents -- --fixture fixtures/che-bar-2009-05-06.json
```

Six agents, each reading its template id **from its own ENS name** rather than
from configuration, then queueing orders from its own key. After every fill it
writes `last-action` and `status` back to its own resolver.

Start this **before** the replay, so the agents are watching when kickoff lands.

---

## 4. Resetting to a clean PRE_MATCH fixture

The replay settles the fixture it runs on, so a second rehearsal needs a new one.
A new fixture is a new venue — `MMVault.pot` is immutable and
`WhistleHook.setVault` is one-shot — so it is two commands, not one:

```bash
# a) new pot, 36 cards, mined hook, router, vault  (~12 txs, ~3 min on Sepolia)
cd contracts
NEW_FIXTURE_ID=$(date +%Y%m%d) \
FIXTURE_FACTORY=0xc73D44244D746c1Fb808fa78f0378D215ED71Fda \
AGENT_REGISTRY=0x38E67Af1161ce02AFaC03f2A6002661AeB5aCa2a \
DEPLOYER_PRIVATE_KEY="$SEPOLIA_DEPLOYER_KEY" \
forge script script/DeployFixture.s.sol:DeployFixture \
  --rpc-url "$SEPOLIA_RPC_URL" --broadcast --slow --no-storage-caching
cd ..

# b) point the app at it, then seed it
#    (merge the new addresses into deployments/fixture-<id>.json and
#     deployments/11155111.json, then:)
pnpm deploy:sepolia
```

`deploy:sepolia` asks the chain what is missing and does only that, so a crash
costs the transaction it crashed on and nothing else. Rerun it as often as you
like.

**Six fresh agent keys are needed for a new fixture.** `createAgent` reverts
`AgentAddressInUse` rather than re-mandate an address, which is deliberate — a
revoked mandate should not be resurrectable by reusing the key. Generate them,
put them in `TOKYO_AGENT_KEYS`, and `deploy:sepolia` registers the user and the
mandates itself.

Pass `--user <label>` to register under a different name; the ENS salt is derived
from the label (`keccak256("whistle:user:<label>")`) rather than hand-picked, so a
new label can never collide with an old one and a rerun for the same label is a
no-op rather than a bare `execution reverted`.

---

## Rehearsing without touching the demo fixture

`PROTECTED_FIXTURES` in `.env` lists the fixture ids no script may write to on a
real network — `20260923`, the one the demo runs on. `replay.ts`, the agent
runtime and `deploy:sepolia` all refuse before their first write:

```
Error: refusing to replay against fixture 20260923: it is listed in PROTECTED_FIXTURES.
```

Replaying a fixture settles it, and a settled fixture cannot be reopened: it
needs a new pot, 36 new cards, a newly mined hook and six fresh agent keys.

A **local node is exempt**, because a guard that blocked rehearsals would only
get switched off. Fork Sepolia, pin the block, and point everything at it.

**The fork gets its own provider key.** `FORK_RPC_URL` is a second app in the
provider dashboard and is used by `anvil --fork-url` and nothing else:

| Variable | Who uses it |
|---|---|
| `SEPOLIA_RPC_URL` | frontend, keeper, oracle, agents, every script |
| `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_LOGS_RPC_URL` | the browser (origin-restricted) |
| `FORK_RPC_URL` | `anvil --fork-url`, and nothing else |

The split is not tidiness. A fork re-fetches every storage slot it touches from
upstream, so one rehearsal outweighs the rest of the stack put together — sharing
a key earned HTTP 429s everywhere at once, including anvil refusing to start with
`failed to fetch network chain ID`. Keeping them apart means a rehearsal cannot
rate-limit the key the demo runs on.

```bash
set -a && . .env && set +a
: "${FORK_RPC_URL:?set FORK_RPC_URL in .env — a second provider key, just for the fork}"

BLOCK=$(cast block-number --rpc-url "$SEPOLIA_RPC_URL")
anvil --fork-url "$FORK_RPC_URL" --fork-block-number "$BLOCK" --port 8545 &

export WHISTLE_CHAIN=sepolia WHISTLE_RPC_URL=http://127.0.0.1:8545
export AGENT_PRIVATE_KEYS="$TOKYO2_AGENT_KEYS"
export ORACLE_PRIVATE_KEY="$SEPOLIA_ORACLE_KEY" KEEPER_PRIVATE_KEY="$SEPOLIA_KEEPER_KEY"

# the fork's accounts need gas, and the demo user needs to be impersonated
cast rpc anvil_setBalance "$SEPOLIA_ORACLE_ADDRESS" 0x8AC7230489E80000 --rpc-url http://127.0.0.1:8545
cast rpc anvil_setBalance "$SEPOLIA_KEEPER_ADDRESS" 0x8AC7230489E80000 --rpc-url http://127.0.0.1:8545
cast rpc anvil_impersonateAccount "$TOKYO2_USER_ADDRESS" --rpc-url http://127.0.0.1:8545
```

Build the frontend against the fork (`NEXT_PUBLIC_RPC_URL` **and**
`NEXT_PUBLIC_LOGS_RPC_URL` both `http://127.0.0.1:8545` — the fork's own blocks
hold the new events, so pointing logs at Sepolia would miss every one), then run
the agents and the replay as usual. The guard prints a warning and continues.

To drive all five beats headlessly and time them:

```bash
cd web && node scripts/rehearse-ui.mjs \
  --url https://localhost:3100 --rpc http://127.0.0.1:8545 --user "$TOKYO2_USER_ADDRESS"
```

Screenshots and a timing report land in `web/docs/screens/rehearsal/`. The
injected wallet forwards `eth_sendTransaction` to anvil, which signs as the
impersonated account — no private key is handled by the driver at all.

> **Forks are slow and hosted endpoints ration you.** anvil executes each
> transaction by fetching every storage slot it touches from upstream, so the
> RPC timeout is raised to 120 s for a local node (`WHISTLE_RPC_TIMEOUT_MS`
> overrides). Repeatedly restarting a fork will also exhaust a free tier — a
> run of this died with `failed to fetch network chain ID … 429`. Pin the block,
> and reuse the fork rather than recreating it.

---

## If something looks wrong

| Symptom | Cause | Fix |
|---|---|---|
| Event feed empty, settlement shows "never minted" | `NEXT_PUBLIC_LOGS_RPC_URL` caps `eth_getLogs` | Use Infura or publicnode for logs |
| "Reading the fixture…" forever | `NEXT_PUBLIC_RPC_URL` cannot serve the multicall load | Use Alchemy or Infura for state |
| Every `postEvent` reverts `FutureEvent` | The oracle key does not hold `oracle.whistle.eth` | `cast call <EnsRoleAuth> 'roleHolder()(address)'` should equal your oracle address |
| A transaction "times out" waiting for a receipt | The RPC gave up; the transaction is usually fine | Everything re-checks the hash before failing. Rerun — nothing is paid twice |
| A card offers no trade form, only "Mint only" | That card has no pool | By design: 11 of 36 are pooled |
| Agents list is empty | The mandates are scoped to the other fixture | Check the header selector matches the fixture the agents were created for |


## The in-page simulation: two behaviours that look like bugs

`NEXT_PUBLIC_SIM=on` puts START MATCH on the pre-match screen and a MATCH SIMULATION panel on the live screen (`/fixtures/<id>`). Two things it
does are deliberate.

**Pause really stops the chain.** No events are posted while paused, so neither
the minute counter nor any reference price moves. An order queued during a pause
waits in the queue.

It does **not** fill at the price it was queued at, though. The fill takes the
reference price at the moment the keeper ticks it, so once the match resumes an
intervening event moves it — measured on a fork, queued at 1.254061 and filled
at 1.253832. The delay `L` is enforced on chain; the price is read at the fill.

**Closing the tab pauses the match.** The clock lives in the tab
(`sessionStorage`), and a `pagehide` handler freezes it on unload. Without that,
a match left running with no tab would keep real time and post the rest of the
fixture at once when someone reopened it. Reopen and press Resume.

> **`pagehide` on tab close: verify manually.** The handler is wired and the
> frozen clock is written synchronously to `sessionStorage`, but the headless
> driver closes the browser rather than the tab and did not exercise it. Open
> a fixture, start a match, close the tab, reopen it: the panel should come back
> **paused** at the minute it stopped, not running. This is the one behaviour in
> the simulation that has not been observed end to end.


## Single-signer mode

The fresh deployment has **one** service account for the oracle and the keeper
(see `docs/saturday.md` → Accounts). Both drivers support it:

| driver | how | what makes it safe |
|---|---|---|
| browser (`/api/sim/step`) | `SIM_SERVICE_KEY=<service key>` | a step does one unit of work, and refuses to send from an account whose `pending` nonce is ahead of `latest` |
| terminal (`replay.ts`) | `pnpm replay -- --single-signer --clock 3m` with `SERVICE_PRIVATE_KEY` (falls back to `ORACLE_PRIVATE_KEY`) | every write goes through one queue that waits for the previous write's inclusion |

Both stop on a **reverted** transaction. Before this, a reverted event printed
like a good one and the match carried on — and because the cursor is the chain's
clock, a reverted event is *skipped*, not retried. It surfaced ninety minutes
later as `FinalScoreMismatch`. On a fork the 65' substitution ran out of gas on an
estimate 2,800 gas short, which is also why `postEvent` and `postFinal` now carry
fixed gas ceilings.

The browser driver goes one step further: the panel hands back the hashes each
step sent, and the next step waits until every one has a receipt and refuses to
continue past a failed one. On real Sepolia that means roughly one write per
block, so a 3m match takes longer than three minutes. That's the right trade:
nothing gets skipped.
