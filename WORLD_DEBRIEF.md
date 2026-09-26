# World ID for Agents — integration debrief

Whistle (ETHGlobal Tokyo 2026) gates every increase in an agent's authority on a
fresh World ID proof: creating an agent, raising its spend cap, and resuming a
paused one (a raise from 0). Decreasing authority — pause, lower the cap, revoke —
never needs verification. The integration is OIDC against the sandbox IdP
(`https://sandbox.auth.world.org`): authorization code + PKCE S256,
`private_key_jwt` (RS256), `scope=openid`, `max_age=0` + `prompt=login`. The
server holds the pending action; the browser never performs it.

## Time to first success

All times UTC, 26 Sep 2026.

| | time | elapsed |
|---|---|---|
| Started research (discovery document, MCP guides) | 05:02 | — |
| Client registered (portal UI, `private_key_jwt`, public JWKS) | 05:26 | 24 min |
| Registration verified: authorize → 302, token endpoint with a signed assertion → `invalid_grant` (client auth accepted) | ~05:27 | 25 min |
| **First end-to-end success**: fresh sandbox proof → code redeemed with a fresh assertion → ID token validated (iss, aud, exp, nonce, state, auth_time) → `createAgent` performed server-side on an anvil fork → `human.agent-15` written | ~05:58 | **56 min** |

About 30 minutes of that went to things outside World ID: the HTTPS proxy, and
discovering that the agent's own ENS resolver cannot take a new record without
a contract change (the human record lives on a separate resolver for the user's
name). The OIDC part itself — start, callback, validation — worked the first
time it was run against the real IdP.

## Friction

1. **Sandbox World App access withdrawn; mocked proofs instead.** There is no
   device in the loop. The page the authorize request lands on (the
   "initiator") starts the ceremony by itself, the mock proof verifies at
   once, and the same page approves and redirects — about two seconds, no
   human action at all. We only found this by watching network traffic and
   reading the page bundle. Consequences:
   - `auth_time` freshness is trivially satisfied, so the property that matters
     most for step-up (a person just did something) cannot be demonstrated.
   - Each fresh browser profile is a new fake identity (a different `sub`), so
     "the same human must approve a later raise" failed in our first runs for
     reasons that had nothing to do with our code. The identity is stable per
     profile once you know to reuse one.
   - To get a person into the loop at all, we held the initiator page's own
     ceremony and had a second browser open the page's **Approval link**
     (*Authenticate with World ID* → *Approve sign-in*).
2. **No deny in the sandbox's browser flow.** *Deny sign-in* exists only in the
   device-flow approval view (with a user code). `POST
   /authorization-transactions/{id}/deny` returns `invalid_request` from both
   the `ready` and `verified` states of a code-flow transaction, so our
   `error=access_denied` path can only be tested with mocks. In the sandbox,
   "denied" means "not approved within five minutes".
3. **HTTPS-only callbacks.** Right for production, but a local stack now needs
   a local CA (mkcert, whose `-install` needs sudo), a TLS proxy in front of
   `next start`, and every local URL, script and RPC allow-list moved to
   `https://localhost:3100`. The sector is the redirect hostname and is fixed at
   registration, so `127.0.0.1` and `localhost` are not interchangeable.
4. **MCP portal sign-in.** The portal tools need `developer-portal:manage`,
   granted through a separate Google sign-in. The `insufficient_scope`
   challenge arrives in `_meta` inside the tool result; Claude Code did not act
   on it, and re-authenticating from `/mcp` kept the old scope. We registered the
   client by hand in the portal UI instead. That worked, but it defeated the
   point of an agent-driven registration flow.

## Missing capability or documentation

- **What the human approves.** The approval screen says "sign in to Whistle".
  It cannot say "raise agent-10's cap from 1 to 300 USDC", and the ID token
  carries nothing that binds the proof to that action. We bind it ourselves
  (the action is stored server-side under `state`, single-use, five-minute TTL),
  but the human is approving a sign-in, not the action.
- **Sandbox test controls**: a documented way to force deny, expiry or an
  older `auth_time`, and a stable, selectable fake identity.
- **Documented hand-off semantics**: that the initiator page auto-approves as
  soon as any device verifies, and what the Approval link is for when the
  initiator is a browser rather than an agent.
- **Error contract**: which OAuth `error` values the callback can receive
  (we handle `access_denied` and treat anything else as a failure) and whether
  a declined World App request maps to `access_denied`.

## The single most impactful improvement

**Let the relying party say what is being approved, and sign it back.** Accept
a short `binding_message` (or RAR `authorization_details`) on the authorize
request, show it on the approval screen, and return it in the ID token. For
agents this turns "a human signed in recently" into "a human approved *this*
increase in authority", which is the whole reason to ask. It also makes every
approval auditable after the fact from the token alone.
