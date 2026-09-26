# Submission — prize qualification and where the evidence is

Requirement text below is **verbatim from each prize page**. One row per
requirement, with the file and line that satisfies it.

**Legend:** ✅ done and verifiable in the repo · ⬜ outstanding · 🔶 done but
needs Saturday's addresses substituted · N/A optional and deliberately not done.

---

## ENS — Best Use of ENSv2 ($6,000)

> "Project must be built on ENSv2 (Sepolia). ENSv2 features should be central to
> the product, not a cosmetic add-on. Your demo must be functional and not just
> include hard-coded values. Upon submission, your project showcase must have a
> link to a live demo and the code needs to be open source and accessible on
> Github or a similar platform."
>
> Bonus language: *"agents as namespaces, each with their own identity and
> permissions."*

| # | Requirement | | Evidence |
|---|---|---|---|
| 1 | Built on ENSv2 (Sepolia) | ✅ | ENSv2 Sepolia beta throughout — `IPermissionedRegistry`, `IPermissionedResolver`, `VerifiableFactory`. Addresses in [`EnsSepolia.sol`](../contracts/src/integrations/ens/EnsSepolia.sol). `whistle.eth` registered to `0x68343Aa0598b7FCAA102769D172e59cdDfae10f2`, expiring 2027-09-21. |
| 2 | ENSv2 features **central**, not cosmetic | ✅ | Every order is authorised by an ENS read on the execution path: `WhistleHook.queueOrder` → [`AgentRegistry.isAuthorized:370-397`](../contracts/src/integrations/ens/AgentRegistry.sol#L370-L397), which reads five text records live. **Delete ENS and the hook cannot decide anything.** Enhanced Access Control splits write rights per record key at [`_delegateRecordRights:327-345`](../contracts/src/integrations/ens/AgentRegistry.sol#L327-L345); Whistle drops its own `ROLE_SET_TEXT` in the same transaction that mints the name. |
| 3 | Demo **functional, not hard-coded values** | ✅ | Every number on every screen is read from Sepolia — `/fixture`, `/agents`, `/profile`, `/settlement`, and the live board on `/`. Records resolve through `UniversalResolverV2`, not from Whistle's storage. **A production build contains no fallback data:** when the board cannot be read it renders one line, "Live board unavailable", and the Launch app button. Verified against a build pointed at a dead RPC — the served HTML contains the unavailable line and zero invented prices. The illustrative rows exist only behind `NEXT_PUBLIC_ILLUSTRATIVE=on` for local work. |
| 4 | Showcase links to a **live demo** | ⬜ | **Not deployed yet.** `web/` builds standalone and is Vercel-ready — see [web/README.md](../web/README.md). This must be done before submitting. |
| 5 | Code open source on GitHub | ⬜ | Repo must be public at submission time. |
| 6 | *Bonus:* agents as namespaces, each with own identity and permissions | ✅ | Exactly the design. Each agent **is** a namespace: `agent-N.<user>.whistle.eth`, minted by [`createAgent:252-297`](../contracts/src/integrations/ens/AgentRegistry.sol#L252-L297), with **its own resolver instance** and its own role grants. Its identity is the name; its permissions are roles on that name's records. It may write `status`, `last-action`, `pnl-live`; the user alone may write `spend-cap`, `slippage`, `strategy`, `fixture`. |

**One screen proves rows 2 and 6 together:** `/profile/agent-1.<user>.whistle.eth`.
The "Writable by" column is not a claim the page makes — for each key it derives
the argument-scoped resource from a `setText` setter and asks the resolver who
holds the role. `status` returns AGENT, `spend-cap` returns YOU.

**Why one resolver per agent:** ENSv2 resolver roles are scoped to
(resolver, record key) with **no per-name scoping**, so agents sharing a resolver
could overwrite each other's records. Written up in [ENS_NOTES.md](../ENS_NOTES.md)
and [FEEDBACK.md](../FEEDBACK.md) §3.

---

## Uniswap Foundation — Best Uniswap Stack Contribution ($6,000)

> "A public GitHub repository with open-source code, a FEEDBACK.md file, and a
> completed submission to the Uniswap Developer Feedback Form
> (https://developers.uniswap.org/hackathon-feedback) that includes the link to
> your FEEDBACK.md file. Submissions without it will be reviewed and audited
> before winners are finalized. Make sure your README clearly points to the
> relevant contracts and lines of code so we can verify your integration."

This prize is for the **contribution to the stack** — the feedback — not for the
hook itself. The rows are the deliverables it names.

| # | Requirement | | Evidence |
|---|---|---|---|
| 1 | Public GitHub repository, open-source code | ⬜ | Repo must be public at submission time. |
| 2 | A `FEEDBACK.md` file | ✅ | [FEEDBACK.md](../FEEDBACK.md) — seven findings from building against v4 and ENSv2, each with the symptom, the cost, and what would have prevented it. §1 `Hooks.sol:253` self-call short-circuit · §2 gas cost of a live permission read · §4 misrouted settlement inside `beforeSwap` surfacing as `Panic(0x11)` · §6 viem estimating a whole batch before sending any of it · §7 unfiltered `getLogs` on a multi-fixture contract. |
| 3 | **Completed submission to the Uniswap Developer Feedback Form**, including the link to FEEDBACK.md | ⬜ | **Not submitted.** https://developers.uniswap.org/hackathon-feedback — needs the public URL of `FEEDBACK.md`, so it depends on row 1. The prize text says submissions without it are audited before winners are finalised; treat this as mandatory, not optional. |
| 4 | README points clearly to the relevant contracts and lines so the integration can be verified | ✅ | [README.md](../README.md) "Where to look" — a table of exact line ranges, re-verified against the source. Hook permissions [`228-245`](../contracts/src/integrations/uniswap/WhistleHook.sol#L228-L245) · `queueOrder` [`380-433`](../contracts/src/integrations/uniswap/WhistleHook.sol#L380-L433) · `tick` [`493-509`](../contracts/src/integrations/uniswap/WhistleHook.sol#L493-L509) · batch netting and pro-rata rationing [`712-733`](../contracts/src/integrations/uniswap/WhistleHook.sol#L712-L733) · `_beforeSwap` [`992-1014`](../contracts/src/integrations/uniswap/WhistleHook.sol#L992-L1014) · `BeforeSwapDelta` with its `take`/`settle` [`1018-1050`](../contracts/src/integrations/uniswap/WhistleHook.sol#L1018-L1050) · [`WhistleFillRouter.sol`](../contracts/src/integrations/uniswap/WhistleFillRouter.sol). |

**Supporting, though not required by the text:** 150 Foundry tests run against a
**fork of Sepolia** — the real PoolManager and PositionManager, not mocks
(`pnpm test`).

---

## Curvegrid — Best AI Agent Project ($1,000)

> "Judging is based on your idea and technical execution. A GitHub repository
> with your project artifacts (contracts, tests, documentation) and a solid
> README. Your README should include: 1. A one-sentence summary of your project
> 2. How you used MultiBaas in your project (optional) 3. A brief intro to your
> team and their social handles 4. Clear setup and testing instructions 5. Your
> experience with MultiBaas if you used it (feedback, challenges, wins)."
>
> *"Using our blockchain development platform MultiBaas is not a requirement to
> apply for this prize."*

| # | Requirement | | Evidence |
|---|---|---|---|
| 1 | GitHub repo with project artifacts — contracts, tests, documentation | ✅ | [`contracts/src`](../contracts/src) · 150 tests in [`contracts/test`](../contracts/test) · [PLAN.md](../PLAN.md), [ENS_NOTES.md](../ENS_NOTES.md), [FEEDBACK.md](../FEEDBACK.md), [docs/](.) |
| 2 | A solid README | ✅ | [README.md](../README.md) |
| 3 | README: one-sentence summary | ✅ | First line, in bold: *"Trade a live football match: every player is an ERC-20 whose price moves with the match clock, and the agent you hand a mandate to can only act inside limits the chain enforces."* |
| 4 | README: how you used MultiBaas | N/A | Not used. Explicitly optional — *"not a requirement to apply for this prize."* |
| 5 | README: brief intro to the team and social handles | ⬜ | Team table exists with **placeholders**. Fill in before submitting. |
| 6 | README: clear setup and testing instructions | ✅ | README "Setup & testing": `pnpm install`, `pnpm test` (150 Foundry tests), `pnpm typecheck`, `pnpm test:all`. Full stack in [docs/run-local.md](run-local.md); front end in [web/README.md](../web/README.md). |
| 7 | README: experience with MultiBaas | N/A | Not used. |
| 8 | *Judged on:* idea and technical execution | ✅ | The agent argument in one line: **an agent cannot exceed its mandate by choosing to.** `isAuthorized` runs inside `queueOrder` on every order and re-runs at fill; the agent holds no role over the records that bound it. Six agents, three playbooks in [`agent/templates/`](../agent/templates/), one order book, rationed pro-rata at a single price. Pause and Revoke are user-held ENS writes the agent cannot undo. |

---

## ETHGlobal — showcase requirements

| # | Requirement | | Evidence / action |
|---|---|---|---|
| 1 | Public repository | ⬜ | Make the repo public. Blocks ENS row 5 and Uniswap rows 1 and 3. |
| 2 | Live demo link on the showcase | ⬜ | Deploy `web/` (Vercel: root directory `web`, two `NEXT_PUBLIC_*` variables, plus `SNAPSHOT_RPC_URL`). See [web/README.md](../web/README.md). |
| 3 | Demo video | ⬜ | Record Saturday. The Revoke beat is the one to capture — the agent's next `queueOrder` reverts on screen, and the panel showing it is a live simulation, not a message we wrote. |
| 4 | Prize tracks selected on the showcase | ⬜ | Select **ENS — Best Use of ENSv2**, **Uniswap Foundation — Best Uniswap Stack Contribution**, **Curvegrid — Best AI Agent Project**. |
| 5 | Project description and images | ⬜ | Screenshots available in [`web/docs/screens/`](../web/docs/screens/). |

---

## Before you submit — the blocking list

Everything below is ⬜ and cheap except the last two.

1. **Make the repo public.** Three prize rows depend on it.
2. **Fill in the Team table** in the README (names + social handles).
3. **Submit the Uniswap Developer Feedback Form** with the public link to
   `FEEDBACK.md`. https://developers.uniswap.org/hackathon-feedback
4. **Deploy `web/` and put the URL on the showcase.** ENS requires a live demo
   link explicitly.
5. **Select the three prize tracks** on the showcase.
6. Run `pnpm deploy:sepolia -- --plan saturday`, then refresh the README's
   deployment table.
7. **Record the video.**
