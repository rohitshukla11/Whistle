# Feedback — Uniswap v4 and ENSv2

Notes from building Whistle (ETHGlobal Tokyo 2026) against Uniswap v4 and the
ENSv2 Sepolia beta. Everything below was measured on a Sepolia fork against
deployed bytecode, not read off documentation.

---

## 1. A hook cannot fill against its own custom curve, and nothing tells you

**Severity: high.** Silent, and silently profitable for the wrong party.

### What happens

`Hooks.beforeSwap` opens with a self-call short circuit:

```solidity
// v4-core/src/libraries/Hooks.sol:253
amountToSwap = params.amountSpecified;
if (msg.sender == address(self)) return (amountToSwap, BeforeSwapDeltaLibrary.ZERO_DELTA, lpFeeOverride);
```

`msg.sender` here is `PoolManager.swap`'s caller. So when a hook calls
`poolManager.swap` on its own pool — from inside its own `unlockCallback`, which is
the obvious way to write a keeper-driven fill — **its own `beforeSwap` is never
invoked**. No `BeforeSwapDelta` is returned, `amountToSwap` stays at the full
amount, and the swap executes against the AMM curve at the AMM price.

`Hooks.afterSwap` carries the identical guard at line 293.

Nothing reverts. No event distinguishes the two cases. A hook that believes it is
filling at an oracle price is instead filling at whatever the pool says, and the
only symptom is that the numbers are wrong.

### Measured

Real Sepolia PoolManager (`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`). A probe
hook configured to fill at 0.75 out per 1.00 in — deliberately far from the pool's
1:1 price, so an AMM fill and a hook fill cannot be confused:

| Route | Caller of `swap` | `beforeSwap` invocations | 1,000.000000 in → out |
|---|---|---|---|
| A | the hook itself | **0** | **987.158034** (AMM curve) |
| B | a separate contract | 1 | **750.000000** (hook price, exact) |

On route B the pool's `sqrtPriceX96` is unchanged afterwards, confirming
`amountToSwap` reached `Pool.swap` as zero and the curve really was bypassed. On
route A the hook's `lastSender` is never written, which is how we could tell the
callback had not merely declined to override — it had never been asked.

Reproduction: `contracts/test/integrations/uniswap/proto/FillPathProbe.t.sol`.

### The fix we shipped

One extra contract whose only job is to be a different `msg.sender`:

```
tick()
  └─ fillRouter.fill(key, ...)
       └─ poolManager.unlock()
            └─ poolManager.swap(key, ...)
                 └─ hook.beforeSwap(sender = fillRouter)   ← now fires
                      require(sender == fillRouter)
                      take(USDC) / settle(card)            ← fill at the oracle price
                      return BeforeSwapDelta(full amount)
```

The router holds no inventory between calls and accepts calls from the hook alone.
The hook honours a `BeforeSwapDelta` only when `sender == fillRouter`, so the
custom-curve path stays closed to everyone else. Roughly sixty lines, and the
custom-accounting design survives intact — the mechanism was never the problem,
only the caller.

### What would have saved us the afternoon

Either would have been enough, in rough order of preference:

1. **Revert.** If `msg.sender == address(self)` and the hook has
   `BEFORE_SWAP_RETURNS_DELTA_FLAG` set, revert rather than silently returning
   `ZERO_DELTA`. A hook that has declared it returns deltas and then gets skipped is
   almost certainly a bug, not an intentional passthrough. If some hook genuinely
   wants to trade its own pool on the curve, make that opt-in and explicit.
2. **Document it where people will hit it.** The custom-accounting guide
   (`developers.uniswap.org/contracts/v4/guides/custom-accounting`) walks through
   returning a `BeforeSwapDelta` and never mentions that the hook itself is excluded
   from the callback. One sentence there — "a hook cannot trigger its own hook
   callbacks; route through a separate contract" — plus a note in the `Hooks.sol`
   natspec would close the gap.

The short circuit itself is reasonable; the reentrancy and recursion it prevents are
real. It is the silence that costs money.

---

## 2. Gas: what a live on-chain permission read actually costs

Not a complaint — a data point, because the "read permissions from ENS on every
call, never cache" design is one the ENS team encourages and we could find no
published number for it.

`AgentRegistry.isAuthorized` resolves an agent's ENSv2 name and checks registration
status, expiry, roles, fixture scope and spend cap. Three registry reads plus two
resolver `resolve()` calls, all against the live Sepolia beta:

| Operation | Gas |
|---|---|
| `isAuthorized`, live ENS read (cold) | **88,453** |
| `queueOrder`, human (no ENS read) | 200,110 |
| `queueOrder`, agent (one ENS read) | 258,554 |

That is the honest price of not trusting a cache, and we think it is worth paying:
a revocation the user makes in ENS takes effect on the next block, with no
invalidation protocol and nothing to go stale.

### It also shapes the architecture

88k per check is affordable per *order* but not per *fill* when fills are batched.
So authorization is memoized per agent for the duration of one `tick()` call — in
memory, never in storage, so it dies with the call and a revocation between two
ticks is always seen.

Batch clearing on a Sepolia fork, with the real PoolManager and the real ENS beta:

| Orders in the tick | Total gas | Average per order |
|---|---|---|
| 1 | 415,901 | 415,901 |
| 3 | 437,153 | 145,717 |
| 20 | 998,698 | **49,934** |

The shape that matters is **a large fixed cost and a small marginal one**: roughly
**416k of fixed overhead per tick, about 31k per additional order**, which averages
out to **about 50k per order at twenty**. Four things sit in that fixed block rather
than scaling with the book — the residual swap against the pool, the reference price
read, the fee computation, and the settlement to the market-maker vault — and the
memo collapses repeated agents down to a single ENS read regardless of how many
orders they have in the batch.

The observation worth generalising: an on-chain permission read that looks
prohibitive per transaction can be perfectly affordable per batch. Protocols
designing around ENS-based authorization should look at their amortised cost before
concluding they need a cache, because a cache is the thing that breaks revocation.

### One number that is easy to get wrong

Those figures are for a batch clearing a single pool. Batching across *several*
pools costs more than the per-order figure implies, because the per-pool work — the
price read, the fee computation, and above all the `PoolManager` unlock and swap —
repeats per pool. Measured, holding everything else constant:

| Batch | Gas | Marginal |
|---|---|---|
| 4 orders, 1 pool, balanced book | 475,675 | — |
| 12 orders, 1 pool, balanced book | 859,006 | +47.9k per order |
| 4 orders, 2 pools, balanced book | 530,261 | +54.6k per extra pool |
| 4 orders, 1 pool, **one-sided book** | 602,524 | **+126.8k for the swap** |

The last row is the one worth knowing about: a book that nets internally never
calls `unlock`/`swap` at all, and that is ~127k. Anyone writing a batched hook
should expect the swap, not the per-order bookkeeping, to dominate — and should
size batches so that each pool's orders clear together rather than spreading a
fixed page across many pools.

---

## 3. Smaller notes on the ENSv2 beta

Detail and reproductions in [ENS_NOTES.md](ENS_NOTES.md).

- **`linkToNode` reads like an initializer and is not one.** It points a name at a
  record that already exists; on a fresh resolver it reverts `InvalidRecord`.
  Records are created lazily by the first setter call, which emits `Linked` as a
  side effect. A natspec line saying "this is for aliasing an existing record, not
  for creating one" would prevent the wrong guess.
- **Deployment tags outrank `main`.** When we pinned, `sepolia-deployment-2026-09-15`
  (`f2f0a05e`) was **five weeks newer** than `main`. The natural assumption that
  `main` is at least as new as any deployment is false here, and pinning to it would
  have produced interfaces older than the chain. Worth stating explicitly in the
  deployments docs.
- **Role scoping is `(resolver instance, record key)`, with no per-name scoping.**
  The Permissioned Resolver docs do say this, and it is the single most important
  sentence on the page — it forces one resolver instance per agent if agents are not
  to be able to overwrite each other's records. It deserves to be louder.

---

## 4. A misrouted settlement inside `beforeSwap` surfaces as `Panic(0x11)`

**Severity: low, but it is pure developer-experience cost.**

When a hook settles a custom-curve fill against ERC-6909 claims, the settlement
target is a parameter — the claims can belong to the hook, or to a separate vault
the hook is an operator for. Point it at the wrong holder and the failure is:

```
WrappedError(<hook>, 0x575e24b4, 0x4e487b71...0011, 0xa9e35b2f)
```

That is `Panic(0x11)` — arithmetic overflow/underflow — wrapped twice. The actual
cause is `PoolManager.burn` trying to debit a claims balance the named holder does
not have, so `_burn`'s subtraction underflows inside ERC-6909.

The diagnosis costs real time, because `Panic(0x11)` reads as a bug in the hook's
own price arithmetic — the last place the hook did any arithmetic before calling
out. The trace does eventually show `PoolManager::burn(... ) → panic`, but only at
`-vvvv`, and the number in the call is a currency id rather than anything
recognisable.

**Suggestion:** give `ERC6909Claims._burn` an explicit balance check with a named
error — `InsufficientClaimsBalance(owner, id, have, want)` or similar. Every other
failure mode in this path already has one (`CurrencyNotSettled`,
`HookDeltaExceedsSwapAmount`), and this is the one that fires when a hook author
gets custody wrong, which is exactly the mistake a first implementation makes.

The same applies to `mint`: an under-collateralised `mint` fails later and
elsewhere, as `CurrencyNotSettled`, which points at the caller rather than the
accounting error.

---

## 5. Not a bug, but it cost an afternoon of test debugging

`vm.makeAddr` addresses are not EOAs on a fork. `makeAddr("alice")` resolves to an
address carrying an **EIP-7702 delegation** on Sepolia — 23 bytes of
`0xef0100 || address` — so `code.length > 0`, and minting an ERC-1155 to it takes
the contract branch of `_checkOnERC1155Received` and reverts.

This will get worse as 7702 adoption grows, and it affects any fork test that mints
a token to a deterministic test address, on any chain. A note in the Foundry docs
for `makeAddr`, or a `vm.makeEOA` helper that clears code on a fork, would help a
lot of people who are currently going to lose an afternoon to it.

---

## 6. viem estimates a whole batch before it sends any of it

**For the viem maintainers. Not a bug — a sharp edge worth a line in the docs.**

Sending many independent transactions from one key means assigning nonces
yourself and letting the mempool order them, rather than waiting a block each.
The Sepolia seed is ~225 operator calls; serially that is forty-five minutes of
waiting for work the chain does in a handful of blocks.

The trap is that **nonce order is not execution order as far as estimation is
concerned.** `writeContract` estimates gas at call time, against current state.
So this looks right and is not:

```ts
// Two calls, correctly ordered by nonce: the exemption is nonce n, the mint n+1.
const calls = [
  { fn: "setCapExempt", args: [card, operator, true] },   // nonce n
  { fn: "mintPreMatch", args: [card, 20_000e18, operator] }, // nonce n+1
];
await Promise.all(calls.map((c, i) => wallet.writeContract({ ...c, nonce: base + i })));
```

The mint is estimated while the holder cap still applies, reverts
`HolderCapExceeded`, and throws **before it is ever sent** — leaving a nonce gap
that stalls everything behind it. On-chain ordering was never the problem.

What made it expensive to find: the error names a contract-level revert
(`HolderCapExceeded`), which reads as "your transaction is wrong" rather than
"this transaction was simulated against state that has not happened yet". The
fix is to split into batches at every dependency boundary — exemptions, then
mints — which is obvious once seen and invisible beforehand.

Two things would have saved the hour:

- A sentence in the `writeContract` docs saying that an explicit `nonce` does not
  defer estimation, and that batches must be split where one call's success
  depends on another's effect.
- Optionally `gas` accepting `"skip-estimate"` (today you must supply a number to
  avoid estimation, which means guessing). A first-class "I know what I'm doing,
  do not simulate" would make nonce-parallel batching safe by construction.

Related: the same batching earns `Transaction creation failed` from Alchemy's
free tier above about ten concurrent sends. That one *is* throttling, but it
arrives as a generic creation failure rather than a 429, so the natural reading
is "my call is malformed" rather than "slow down".

---

## 7. One contract, many fixtures: an unfiltered `getLogs` is a silent wrong answer

Not a bug in anyone's library — a shape that is easy to get wrong and impossible
to notice, so worth writing down.

`MatchOracle` is deployed once and serves every fixture; the fixture id is the
first indexed topic on `MatchEvent`. Each of our screens scans from *its own*
fixture's deploy block to the head:

```ts
scanLogs(client, BigInt(deployment.deployBlock), {
  address: deployment.matchOracle,
  abi: matchOracleAbi,
  eventName: "MatchEvent",
});
```

For the **newest** fixture this is correct by accident: older fixtures' events
fall before its deploy block, so the range excludes them. For any **older**
fixture it is wrong, and wrong in the worst way — the scan runs forward past the
end of that match and sweeps up every later fixture's events too.

Our settled showcase fixture came back with **46 `MatchEvent` logs where it has
23, and four goals in a 1-1 match.** The payout screen — the last thing a judge
sees — would have read 2-2. Nothing errored. Every count was a plausible number.

The fix is one line, `args: { fixtureId }`, and it is the sort of line you only
add after you have been burned:

```ts
scanLogs(client, from, { address, abi, eventName: "MatchEvent", args: { fixtureId } });
```

Two things that would have caught it earlier:

- **Cache keys that include the filter.** Ours did not, so a filtered and an
  unfiltered scan of the same event shared an entry and whichever ran first won.
  viem cannot fix our cache, but it is worth saying in the docs that
  `getContractEvents` results are only interchangeable when `args` match.
- **A lint or a type-level nudge** when an event has indexed parameters and the
  call supplies none. It is legal and sometimes intended, so it cannot be an
  error — but for an event whose first indexed field is an id, "you are asking
  about all of them" is nearly always a mistake.

The general lesson, which applies to any singleton contract with a per-entity
indexed id: **a block range is not a filter.** If the only thing separating your
entity's logs from another's is where they happen to sit in history, you do not
have a query, you have a coincidence.

## 8. An oracle that accepts two events in the same minute cannot tell a resend from a new event

`MatchOracle._validate` rejects only `minute < clock`:

```solidity
if (minute < f.clock) revert NonMonotonicMinute(minute, f.clock);
```

Equal minutes have to be legal. The 65th minute of Chelsea–Barcelona 2009 holds
two events — a heartbeat and the substitution that takes Malouda off — and a
real feed delivers several events in a minute routinely. So the guard is right.

The consequence is not. A `postEvent` posted twice at the current minute is
**applied twice**, not rejected, and for a substitution that means the player is
subbed off again: his minutes stop accruing from a second, later point, his final
score changes, and `postFinal` rejects the whole settlement with
`FinalScoreMismatch`. The failure surfaces ninety minutes after the cause.

Two ways to arrive there, and we hit both:

1. **A missed receipt.** viem's watcher gives up while the transaction mines;
   the caller treats it as dropped and resends. The nonce argument that makes
   resends safe elsewhere does not apply, because the original landed.
2. **A minute-based cursor.** Our browser-driven replay used the oracle's own
   clock to decide what to post next — `first event with minute > clock` — which
   is correct only if minutes are unique. It silently skipped the substitution
   and produced the same `FinalScoreMismatch` from the opposite direction.

**What we do now.** Events for a minute are posted as a group, and before any
resend the caller asks the chain whether that exact event — fixture, minute,
type, and the full player list — is already in the logs. Matching on minute
alone is not enough: the heartbeat at 65' would stand in for the substitution at
65' and suppress a resend that was genuinely needed.

**What would have prevented it.** A monotonic **event sequence number** on the
fixture, incremented by `postEvent` and readable with the fixture record:

```solidity
struct Fixture { ...; uint32 eventSeq; }
function postEvent(..., uint32 expectedSeq) external onlyPoster {
    if (expectedSeq != f.eventSeq) revert OutOfSequence(expectedSeq, f.eventSeq);
    f.eventSeq++;
}
```

That makes a duplicate revert instead of applying, makes "what is the next event"
answerable in one `eth_call` instead of a log scan, and makes a driver's cursor
exact without any off-chain state. It costs one storage slot and one comparison.
We would take that trade.
