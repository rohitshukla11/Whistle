# Feedback — ENSv2 (Sepolia beta)

From building Whistle (ETHGlobal Tokyo 2026) on the ENSv2 Sepolia beta. Every agent is an ENS name
(`agent-N.<user>.whistle.eth`) with its own Permissioned Resolver, and Whistle's Uniswap v4 hook reads
that name live on every order to decide whether the agent may trade. Everything below was hit while
building or measured against deployed bytecode. Uniswap feedback is in [FEEDBACK.md](FEEDBACK.md).

Each item: **what happened**, **the evidence**, and **one concrete ask**.

---

## 1. Pin to the dated deployment tag, never to `main`

**What happened.** Interfaces reconstructed against `ensdomains/contracts-v2@main` compiled, and would
have drifted silently from the deployed bytecode. The Sepolia beta was redeployed on 2026-09-15; the
tag `sepolia-deployment-2026-09-15` resolves to commit `f2f0a05e6c1711134b73204a1e37f8e6c1aea6ab`,
which was **five weeks newer than `main`** when we pinned. The intuition that `main` is at least as new
as any deployment is false here.

**Evidence.** [`IENSv2.sol`](contracts/src/integrations/ens/IENSv2.sol) declares only the interfaces
Whistle calls, each copied from the pinned tag with its source path; addresses in
[`EnsSepolia.sol`](contracts/src/integrations/ens/EnsSepolia.sol) were re-derived from that tag's
`deployments/sepolia/*.json`; [`EnsSepoliaFork.t.sol`](contracts/test/integrations/ens/EnsSepoliaFork.t.sol)
exercises every selector we depend on against deployed bytecode, so a redeploy fails a test instead of
a transaction.

**Ask.** State on the deployments page that the dated `sepolia-deployment-*` tag, not `main`, is the
source of truth for the beta, and link the current tag from the docs.

---

## 2. `vm.makeAddr` can collide with an EIP-7702 delegation on a fork

**What happened.** Minting an ENS name to `makeAddr("alice")` in a Sepolia fork test reverted in the
ERC-1155 acceptance check. On the forked chain that address carries an EIP-7702 delegation indicator
(23 bytes, `0xef0100 || address`), so `code.length > 0` and OpenZeppelin's
`_checkOnERC1155Received` takes the contract branch and reverts. ENSv2 names are ERC-1155 tokens, so
any fork test that mints a name to a deterministic test address can hit this, more often as 7702
adoption grows.

**Evidence.** `EnsForkBase._eoa()` in
[`EnsForkBase.sol`](contracts/test/integrations/ens/EnsForkBase.sol) mints test addresses through
`vm.etch(account, "")`, which clears the delegation; every fork test that receives a name goes through
it.

**Ask.** A note in the ENSv2 testing docs (and upstream in Foundry) that fork tests should clear code on
recipient test addresses, or ship a `makeEOA`-style helper in the ENS test utilities.

---

## 3. `linkToNode` reads like an initializer and is not one

**What happened.** We called `IPermissionedResolver.linkToNode(dnsName, node)` on each fresh per-agent
resolver before writing records, and it reverted `InvalidRecord`. It points a name at a record that
**already exists** (aliasing); records are created lazily by the first setter call, which emits
`Linked` as a side effect.

**Evidence.** [`AgentRegistry._writeInitialRecords`](contracts/src/integrations/ens/AgentRegistry.sol#L311-L323)
simply writes, with a comment saying why there is no link step. Related trap: `resolve(name, data)`
takes a DNS-encoded name and ignores the node inside `data`, so a correct namehash with a malformed
encoding fails like a namehash bug.

**Ask.** One natspec line on `linkToNode`: *"aliases an existing record; records are created by the
first setter."*

---

## 4. Resolver roles are scoped per resolver instance and key, never per name

**What happened.** Permissioned Resolver roles are scoped to `(resolver instance, record key)` with no
per-name scoping. If agents shared one resolver, any agent holding the `status` role could overwrite
every other agent's `status`. The docs do say this, but it is the single most consequential sentence
for anyone putting several principals behind one resolver.

**Evidence.** Whistle deploys **one Permissioned Resolver per agent** through `VerifiableFactory`
inside [`createAgent`](contracts/src/integrations/ens/AgentRegistry.sol#L252-L297), then splits write
rights per key in [`_delegateRecordRights`](contracts/src/integrations/ens/AgentRegistry.sol#L327-L345).
A consequence we only met later: the only holder of `ROLE_SET_TEXT_ADMIN` on an agent's resolver is
`AgentRegistry`, which grants keys only inside `createAgent`, so a new record key (see §6) cannot be
added to an existing agent without a contract change.

**Ask.** Make the scoping impossible to miss (a callout on the Permissioned Resolver page), and
consider an optional per-name role scope — it would let one resolver safely serve many agents.

---

## 5. PublicResolverV2 rejects writes for unwrapped ENSv2 names

**What happened.** For the World ID human record (`human.agent-N` = `keccak256(iss ‖ sub)`) we first
tried the default PublicResolverV2 on the user's name. For a name that exists only in an ENSv2
registry, the name owner's `setText` reverts — as far as we can tell because PublicResolverV2
authorises writers through the NameWrapper / legacy-registry ownership path, which an unwrapped v2
name never enters.

**Evidence.** Simulated today on Sepolia: `PublicResolverV2.setText` at
`0xd7e590Ad0E92A6aC1d81f4483A9B951D3585a50F`, called by the owner of `oracle.whistle.eth` and by the
owner of `tokyo.whistle.eth`, **reverts** in both cases. We deployed ENS's own Permissioned Resolver for
`tokyo.whistle.eth` instead ([`scripts/setup-human-resolver.ts`](scripts/setup-human-resolver.ts);
deploy [`0x47992e60…`](https://sepolia.etherscan.io/tx/0x47992e60201fe3cb01884c1c8f220df5277fcde428bc5941b86f27d4334283a9),
repoint [`0xfc70a01b…`](https://sepolia.etherscan.io/tx/0xfc70a01b5c8f089ad768245a23a565dce1cb45a95aac59fc6786bc82653bf380)).

**Ask.** Either make PublicResolverV2 authorise via the ENSv2 registry's roles, or say plainly in the
v2 docs that v2-only names need a Permissioned Resolver, and have the registration flow default to one.

---

## 6. Mapping agent names to ENSIP-26 and ENSIP-25

Both ENSIPs are Drafts. We mapped our records to them and did **not** change any records.

| Our record | On | Written by | ENSIP-26 / ENSIP-25 |
|---|---|---|---|
| `strategy`, `spend-cap`, `slippage`, `fixture` | agent name | user | no equivalent — mandate parameters, not discovery |
| `status`, `last-action`, `pnl-live` | agent name | agent | no equivalent — self-reported state |
| `matches-played`, `pnl-history`, `revoked-at` | agent name | platform | no equivalent |
| — (nothing) | agent name | — | **`agent-context`** (ENSIP-26): not written — gap |
| — (nothing) | agent name | — | **`agent-endpoint[web]`** (ENSIP-26): the agent's profile page would fit — gap |
| — | agent name | — | `agent-endpoint[mcp]` / `[a2a]`: not applicable; our agents expose no protocol endpoint |
| — (nothing) | agent name | — | **`agent-registration[<registry>][<agentId>]`** (ENSIP-25): not written — gap |
| `human.agent-N` | user name | platform (after World ID) | no equivalent — neither ENSIP covers proof of personhood |

**Findings.**

- **ENSIP-25 fits our registry directly.** `AgentRegistry` is an agent registry that already maps each
  agent to its name (`agentInfo(agent).fqdn`). Verification would need the name side:
  `agent-registration[0x0001000003aa36a7140fd44f0e192f0091439554a5ed8195f5f0672f3d][<agentId>] = "1"`
  on each agent name — the ERC-7930 form of `AgentRegistry` on Sepolia, with the agent address as the
  id. The attestation is "by the ENS name owner"; our agent names are owned by the agent key itself, so
  the attesting party would be the agent, not its user.
- **We cannot add either set of keys without a contract change**, because of §4: text-record roles are
  granted per key only inside `createAgent`.
- **`agent-context` is free-form**; ours would describe the playbook and point at `strategy`,
  `spend-cap` and `fixture`. A convention for *machine-readable mandate limits* (cap, scope, expiry)
  would let any client — not only Whistle — check what an agent may do before trusting it.

**Ask.** In ENSIP-26, a registered key (or ENSIP) for an agent's **mandate** — the limits a client can
verify — alongside `agent-context`; and a note in ENSIP-25 on who should attest when the agent name is
owned by the agent rather than its principal.

---

## What worked well

- **Enhanced Access Control per record key is the product.** One transaction mints the agent name,
  deploys its resolver, gives the agent `status` / `last-action` / `pnl-live`, the user `spend-cap` /
  `slippage` / `strategy`, the platform its keys, and drops the registry's own write role
  ([`AgentRegistry.sol:252-297`](contracts/src/integrations/ens/AgentRegistry.sol#L252-L297)). The
  profile page reads `decodeSetter` + `hasRoles` back off the resolver to show who may write each key.
- **Live reads are affordable.** `isAuthorized` — registry status, expiry, roles, fixture scope and spend
  cap — costs **88,453 gas** cold, read on every order with no cache, so a revoke or a zero cap binds on
  the next block ([`AgentRegistry.sol:370-397`](contracts/src/integrations/ens/AgentRegistry.sol#L370-L397)).
- **Non-transferable, expiring, parent-revocable names** fall out of the role bitmap: omitting
  `ROLE_CAN_TRANSFER_ADMIN` makes agent names non-transferable, the registry expiry is the mandate's end,
  and the user's registry can unregister them.
- **UniversalResolverV2** resolved every agent record through `resolve(name, data)` with no special
  casing, and the ENS explorer shows Permissioned Resolver records.

**One observation.** On explorer.ens.dev, `tokyo.whistle.eth / Subnames` lists 10 of its 21 agent
names (it shows agent-1, -10, -12…-19 and omits the rest), and a new agent's records appear there only
after a delay, while the chain and the Universal Resolver have them immediately.
