# Whistle — web

The front end. Four screens over a Sepolia deployment: the board, the agent
mandates, one agent's ENS records, and settlement.

This directory is **self-contained**. `scripts/vendor.mjs` copies everything it
needs from the repo before each build, so `web/` can be uploaded to a host on its
own — nothing here imports from outside it at build time.

---

## Build it

```bash
cd web
pnpm install
pnpm build
```

Two environment variables, and only two:

| Variable | What it must do |
|---|---|
| `NEXT_PUBLIC_RPC_URL` | serve the fixture screen's ~200 multicalls |
| `NEXT_PUBLIC_LOGS_RPC_URL` | serve `eth_getLogs` over thousands of blocks |
| `NEXT_PUBLIC_SIM` | *(optional)* `on` adds the MATCH SIMULATION panel to `/fixture` and enables `/api/sim/*` |
| `SIM_ORACLE_KEY`, `SIM_KEEPER_KEY`, `SIM_AGENT_KEYS`, `SIM_ADMIN_TOKEN` | *(secret, server only)* What the simulation signs with, and the bearer token gating every call. Never prefixed `NEXT_PUBLIC_`, so none of it reaches the browser. |
| `NEXT_PUBLIC_DEBRIEF` | *(optional)* `on` adds the AI match debrief to `/profile/[agent]` |
| `ANTHROPIC_API_KEY` | *(optional, server only)* what `/api/debrief` calls with. Never prefixed `NEXT_PUBLIC_`, so it stays out of the browser bundle. |

**They are different jobs and not every provider does both.** Alchemy's free tier
answers `eth_getLogs` over a *ten block* range and returns HTTP 400 for anything
wider, which shows up as an empty event feed and a settlement screen with no cost
basis — not as an error. Infura does both, so pointing them at the same URL
works. If you only have a free Alchemy key, use it for state and
`https://ethereum-sepolia-rpc.publicnode.com` for logs.

Both values ship to the browser. Restrict them in the provider dashboard to the
deployed origin, and never use a key that any script signs with.

```bash
# local
cp .env.example .env.local    # then fill in the two URLs
pnpm dev                      # http://localhost:3000
```

### One more, optional

| Variable | Effect |
|---|---|
| `SNAPSHOT_RPC_URL` | Used only by the build, to freeze settled fixtures' logs into `public/settled/`. Falls back to `NEXT_PUBLIC_LOGS_RPC_URL`. If it is unreachable the build still succeeds and those screens scan at runtime instead — slower, same answer. |

---

## What `pnpm build` actually does

`pnpm build` is `node scripts/vendor.mjs && next build`. The vendor step:

1. copies `deployments/*.json` and the contract ABIs into `vendor/`;
2. generates `vendor/fixtures.json`, the list of fixtures the app can switch
   between, from what is actually in `deployments/` — so deploying a new fixture
   cannot leave the app pointing at the old one;
3. generates `vendor/squad.json`, the shirt numbers and line-ups the chain does
   not store;
4. asks the chain which fixtures are `SETTLED` and freezes their whole log
   history into `public/settled/<id>.json`.

Step 4 is why `/settlement` paints in about two seconds instead of twenty: a
settled fixture's logs cannot change, so re-reading them from an RPC is the same
answer computed again at the worst possible moment.

`vendor/` and `public/settled/` are generated and gitignored. Edit the originals.

---

## Deploying

Any host that runs `pnpm install && pnpm build` on Node 20+ works. Set the two
`NEXT_PUBLIC_*` variables in the host's dashboard; set `SNAPSHOT_RPC_URL` too if
you want the settled-fixture speedup, which you do.

`deployments/` is committed — public contract addresses, fixture metadata and
transaction hashes, no key material — so a host building from a fresh `git clone`
has everything the vendor step needs.

---

## Routes

| Route | Screen |
|---|---|
| `/` | Landing |
| `/fixture` | The board: line-ups on a pitch, live reference prices, the order bar |
| `/agents` | Mandates: create, Pause, Revoke |
| `/profile/[agent]` | One agent's ENS records and who may write each one |
| `/settlement` | Final scores, payouts, Redeem |

See [../docs/run-local.md](../docs/run-local.md) for running the whole stack —
oracle, keeper and agents — against Sepolia or a fork.
