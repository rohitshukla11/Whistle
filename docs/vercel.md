# Deploying Whistle to Vercel

This deploys the app with **World ID on** and the **in-page match simulation off**:
visitors can browse fixtures, mint, create and manage agents; creating an agent
and raising a cap or resuming one need a fresh World ID proof, performed by
the server. Nothing here changes what the app does — it is packaging and
configuration.

## 1. Project settings

| Setting | Value |
|---|---|
| Framework | Next.js (detected) |
| Root Directory | `web` |
| Install Command | default — Vercel reads `packageManager: pnpm@9.15.0` from `web/package.json` and installs from `web/pnpm-lock.yaml` |
| Build Command | default (`pnpm build`, which runs `scripts/vendor.mjs` then `next build`) |
| Node.js | 20.x |
| **Fluid compute** | **On** (Settings → Functions). The World ID callback may run up to 120 s (`maxDuration = 120`) and `/api/agents/assign` up to 90 s: a create sends the agent's gas float, `createAgent` and the human record, each waited for on Sepolia. Without Fluid compute, Hobby caps functions at 60 s and the deploy fails. |
| "Include files outside the Root Directory" | On (the default). The build reads `deployments/`, `oracle/`, `agent/` and `fixtures/che-bar-2009-05-06.json` from the repo root; all are committed. |

The build needs no secrets. It reads `NEXT_PUBLIC_RPC_URL` and
`NEXT_PUBLIC_LOGS_RPC_URL` to check which fixtures exist and to freeze settled
fixtures' logs into `public/settled/`.

## 2. Environment variables

Minimum set for `NEXT_PUBLIC_SIM` **unset** and `NEXT_PUBLIC_WORLD_IDP=on` —
every variable the build and the runtime actually read in that mode. Set them
for **Production** (and Preview if you use it). Commands are run from the repo
root and print the value to paste; nothing else prints them.

### Browser (inlined at build time — visible to every visitor)

| Variable | Value | Get it |
|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | Sepolia state reads (Alchemy/Infura) | `sed -n 's/^NEXT_PUBLIC_RPC_URL=//p' web/.env.local` |
| `NEXT_PUBLIC_LOGS_RPC_URL` | Sepolia log scans (Infura or publicnode; **not** Alchemy free tier) | `sed -n 's/^NEXT_PUBLIC_LOGS_RPC_URL=//p' web/.env.local` |
| `NEXT_PUBLIC_WORLD_IDP` | `on` | — |
| `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` | — |

Both RPC URLs carry provider keys. Restrict them at the provider to the Vercel
domain (Allowlist → HTTP referrers).

### Server only (secrets — never `NEXT_PUBLIC_`)

| Variable | What | Get it |
|---|---|---|
| `SIM_OPERATOR_KEY` | 0x6834…, `AgentRegistry.operator()`. Signs `createAgent`, `spend-cap` raises and the `human.agent-N` records after a verified callback. | `sed -n 's/^export SIM_OPERATOR_KEY=//p' .secrets/sim.env \| tr -d '"'` |
| `SIM_SERVICE_KEY` | 0x7e05…, the service key. Funds each new managed agent key's gas float. | `sed -n 's/^export SIM_SERVICE_KEY=//p' .secrets/sim.env \| tr -d '"'` |
| `SIM_DERIVED_JSON` | The per-fixture agent keys and managed pool, base64. | `base64 < .secrets/derived.json` |
| `WORLD_CLIENT_ID` | The **Vercel** World client (see §3), not the localhost one. | from the portal |
| `WORLD_REDIRECT_URI` | `https://<your-domain>/api/world/callback`, exactly as registered | — |
| `WORLD_PRIVATE_KEY` | The RS256 `private_key_jwt` key, whole PEM. | `cat .secrets/world-client.pem` |
| `KV_REST_API_URL` | Shared store for pending World ID attempts. | set by the Vercel KV / Upstash integration |
| `KV_REST_API_TOKEN` | its token | set by the integration |

Optional: `WORLD_ISSUER` (defaults to `https://sandbox.auth.world.org`).
`VERCEL` is set by the platform; with it set, World ID refuses to start without
the KV store rather than lose attempts across instances.

Not needed in this mode: `SIM_DERIVED_FILE`, `WORLD_PRIVATE_KEY_FILE`,
`SIM_RPC_URL`, `SNAPSHOT_RPC_URL` (both fall back to the RPC URLs above — do
**not** point `SNAPSHOT_RPC_URL` elsewhere, the server signs through it),
`PROTECTED_FIXTURES`, `NEXT_PUBLIC_DEBRIEF`, `ANTHROPIC_API_KEY`,
`NEXT_PUBLIC_ILLUSTRATIVE` (must stay unset in production).

**Note — sim routes.** With `NEXT_PUBLIC_SIM` unset the sim panel and START
MATCH are not rendered, but `/api/sim/start` and `/api/sim/step` still answer
to a valid operator signature, and `SIM_SERVICE_KEY` is present for World ID.
Only the operator's wallet can use them; nobody else gets past the 401.

## 3. The second World ID client

A World ID client is bound to its redirect hostname (the sector), and that
cannot change after registration. The existing client
(`18520dd7-…`, redirect `https://localhost:3100/api/world/callback`) will not
work on the Vercel domain. Register a second one:

1. World Developer Portal (sandbox) → new OIDC client.
2. Redirect URI: `https://<your-domain>/api/world/callback` — exact.
3. Client authentication: `private_key_jwt`, and paste the **public** JWKS from
   `.secrets/world-client.jwks.json` (the same key pair is fine; the private
   half stays in `WORLD_PRIVATE_KEY`).
4. Put its client id in `WORLD_CLIENT_ID`.

Decide the domain first: a Vercel preview URL changes per deployment, so use the
production domain (or a fixed alias) for the redirect.

## 4. After deploying

- Open `https://<your-domain>/fixtures`; Demo 1 should read SETTLED 1–1.
- Sign in as the operator on a pre-match fixture and create one agent with
  World ID; its profile shows **human-backed · World ID**.
- Keep an eye on balances: one World ID create costs about **0.0016 ETH** from
  the operator (createAgent ≈ 1.44M gas + human record ≈ 0.18M) and **0.004 ETH**
  from the service key (the new agent's gas float, from which it pays its ~14
  approvals), at ~1 gwei. Scale with the gas price.

## 5. Post-event cleanup

1. **Remove the secrets from Vercel**: delete `SIM_OPERATOR_KEY`,
   `SIM_SERVICE_KEY`, `SIM_DERIVED_JSON`, `WORLD_PRIVATE_KEY` (or delete the
   project). Anyone with project access could read them.
2. **Treat those keys as exposed**: move what is left on 0x6834… and the service
   key to fresh accounts; sweep the managed agent keys' gas floats back.
3. **World ID**: disable or delete the Vercel client in the portal; generate a
   new key pair if the JWKS key is reused elsewhere.
4. **Shared store**: delete the KV / Upstash database.
5. **RPC provider keys**: remove the Vercel domain from the referrer allowlist,
   or rotate the keys.
6. **Agents**: revoke or pause the mandates created during the event
   (My agents → Revoke is one click and needs no verification).
7. **Domain**: remove the custom domain / alias if it was temporary.
