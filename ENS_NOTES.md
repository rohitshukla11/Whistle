# ENS integration notes

Things that cost real time building against the ENSv2 Sepolia beta, written down
so they cost nobody else any. Each one is a case where the obvious reading was
wrong and the code had to change.

Live deployment addresses and the role tables are in [PLAN.md](PLAN.md) §0, §9
and §10; this file is only the surprises.

---

## 1. `makeAddr` collides with an EIP-7702 delegation on Sepolia

**Symptom.** Minting an ENS name to `makeAddr("alice")` inside a Sepolia fork
test reverts in the ERC-1155 acceptance check, as though the test EOA were a
contract that failed to implement `onERC1155Received`.

**Cause.** `makeAddr` derives a deterministic address from a label. It is only an
EOA in the sense that the test knows its private key — on a *forked* chain the
address is whatever the real chain says it is. `makeAddr("alice")` resolves to an
address that carries an EIP-7702 delegation indicator on Sepolia: 23 bytes of
`0xef0100 || address`. ENSv2 registries mint names as ERC-1155 tokens, and
OpenZeppelin's `_checkOnERC1155Received` branches on `to.code.length > 0`. A
7702 delegation makes `code.length == 23`, so the mint takes the contract branch
and reverts.

Nothing about this is specific to `"alice"`. Any `makeAddr` label can land on a
delegated account, and more will over time as 7702 adoption grows — so this is a
latent failure in *any* fork test, not a one-off.

**Fix.** `EnsForkBase._eoa()` mints test addresses through `vm.etch(account, "")`,
which clears the delegation and restores plain-EOA semantics:

```solidity
function _eoa(string memory label) internal returns (address account) {
    account = makeAddr(label);
    vm.etch(account, "");
}
```

**Rule.** On a fork, any address that will *receive* a token must go through
`_eoa()`. Using `makeAddr` directly is only safe for addresses that merely send.

---

## 2. `linkToNode` is not the record-creation call

**Symptom.** `IPermissionedResolver.linkToNode(dnsName, node)`, called on a fresh
per-agent resolver before writing any text records, reverts with
`InvalidRecord`.

**Cause.** The name reads like "bind this name to this node so records can be
written", i.e. an initialization step. It is the opposite: `linkToNode` points a
name at a record that **already exists**, which is how two names come to share
one record set. On a resolver that has never been written to there is no record
to link to, so it reverts.

Records are created **lazily by the first setter call**. `setText(name, key,
value)` on an unlinked name creates the record and emits `Linked` as a side
effect. The explicit link call is for aliasing, not bootstrapping.

**Fix.** `AgentRegistry._writeInitialRecords` simply writes. There is no link
step, and the comment at
[AgentRegistry.sol:315](contracts/src/integrations/ens/AgentRegistry.sol#L315)
says why, so nobody adds one back.

**Related.** `resolve(name, data)` takes a **DNS-encoded** name and *ignores the
node inside `data`*, re-deriving it from `name`. Passing a correct namehash with
a malformed DNS encoding therefore fails in a way that looks like a namehash bug.
`WhistleNames.dnsEncode` exists for exactly this, and the encoding is computed
once per agent and stored rather than rebuilt per authorization check.

---

## 3. Pin ENS to the dated deployment tag, never to `main`

**Symptom.** None, which is the problem. Interfaces reconstructed against
`ensdomains/contracts-v2@main` compile, and would have drifted silently from the
deployed bytecode.

**Cause.** The Sepolia v2 beta was redeployed on **2026-09-15**, days before this
build (`ensdomains/ensjs#380`). The repo tags its deployments, and
`sepolia-deployment-2026-09-15` resolves to commit
**`f2f0a05e6c1711134b73204a1e37f8e6c1aea6ab`**.

That commit is **five weeks newer than `main` was at the time**. The intuition
that `main` is "at least as new as" a deployment is simply false here: the
deployment branch ran ahead. Pinning to `main` would have produced interfaces
older than the chain.

**Fix, in three layers.**

1. `src/integrations/ens/IENSv2.sol` declares only the interfaces Whistle calls,
   each copied verbatim from the pinned tag with its source path in a comment.
   Nothing is reconstructed from documentation or memory.
2. Addresses in `EnsSepolia.sol` were re-derived from
   `contracts/deployments/sepolia/*.json` **at that tag** and each confirmed to
   carry code on-chain, rather than copied from the docs site.
3. Provenance is enforced at runtime.
   `test/integrations/ens/EnsSepoliaFork.t.sol` exercises every selector Whistle
   depends on against deployed bytecode, so a redeploy surfaces as a failing
   test rather than a silent mismatch.

**Standing risk.** The beta has been redeployed at least four times (tags exist
for 2026-05-28, 06-29, 07-31, 09-15) and every ENSv2 doc page still carries *"not
yet final and may change prior to mainnet deployment."* Assume it will move
again.

### Run this before demo day

```bash
set -a && . .env && set +a
cd contracts && forge test --match-path 'test/integrations/ens/*'
```

If it fails: look for a newer `sepolia-deployment-*` tag, re-derive the addresses
from that tag's `contracts/deployments/sepolia/*.json`, and update
`EnsSepolia.sol`.

---

## 4. The root name, as registered

`whistle.eth` is registered on the ENSv2 Sepolia beta, for one year.

| | |
|---|---|
| Owner | `0x68343Aa0598b7FCAA102769D172e59cdDfae10f2` |
| Token id | `77474160758127339678909674125913588668985955761662131695396809860743165902848` |
| Registered | block 11,753,322 |
| Expires | `1821559656` — 2027-09-21T20:47:36Z |
| Fee paid | 8,000,021 units of ENS's beta MockUSDC (premium 0) |
| Subregistry | **placeholder (`address(0)`)** — repointed in step 8 |

| Step | Transaction |
|---|---|
| `commit` | `0xfe46f6c3b67e0fc2fe368fdda208aa53b7fd53371531f33b816fe2321363cbbf` |
| `mint` fee token | `0xd868c1ee1677bfcea96d0818c11691a78215c32798003a8c4b5825348d75ff63` |
| `approve` | `0x9e76d5736e84129fca2857ee1afe90f101e55fe4543c8374ac46d0529e50fdff` |
| `register` | `0x19d0bdeac2947707d45e4117b71a5354e6f35c41b113c191b343204dd3764696` |

Registration is commit/reveal with a live `MIN_COMMITMENT_AGE` of 60 seconds, so
the two steps are separate transactions and separate script entry points.
`ETHRegistrar.REGISTRATION_ROLE_BITMAP` leaves the owner holding
`ROLE_SET_SUBREGISTRY` (with admin), which is what makes the placeholder-now,
repoint-later path safe — proved against deployed bytecode in
`EnsRootName.t.sol`, not merely read off the source.

### Two fork-test modes, both of which must pass

| `WHISTLE_ROOT_OWNER` | Fork block | Behaviour |
|---|---|---|
| set | `LIVE_NAME_FORK_BLOCK` = 11,753,325 | binds to the **real** registered name and pranks its owner |
| unset | `FORK_BLOCK` = 11,748,867 | self-registers `whistle.eth` in the fork via genuine commit/reveal |

The fork block has to follow the mode. The self-register path needs a block where
the label is still `AVAILABLE`; the live path needs one where it is already
`REGISTERED`. Running either at the other's block fails, and the failure looks
like a broken test rather than a misconfiguration. `ENS_FORK_BLOCK` overrides
both.

`.env` now sets `WHISTLE_ROOT_OWNER`, so the live path is the default.

### One more environment trap

`DEPLOYER_PRIVATE_KEY` **must** carry the `0x` prefix. `cast` accepts a bare hex
string; `forge script` reads the key with `vm.envUint`, which rejects it with
*"missing hex prefix"*. The mismatch only shows up when a script first
broadcasts, which is the least convenient moment to find out.
