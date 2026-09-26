/**
 * One command to stand up, or finish standing up, a Whistle deployment.
 *
 *   pnpm deploy:sepolia               # do whatever is not done yet
 *   pnpm deploy:sepolia -- --check    # print the checklist, send nothing
 *
 * ## Why this exists
 *
 * The first Sepolia deploy was a `forge script` broadcast of 136 transactions.
 * The RPC timed out waiting for a receipt at transaction 112 — on a transaction
 * that had *succeeded* — and the whole run aborted. Recovering meant reading the
 * chain by hand to work out which 24 calls were still owed. Then the wallet
 * seeding did the same thing at agent 2 of 6.
 *
 * At a hackathon there is no time for that. So every step here is defined by a
 * **question asked of the chain**, not by a position in a script:
 *
 *   - "does this card have a pool?" not "have I run step 4?"
 *   - "does this wallet hold its portfolio?" not "did the loop reach index 5?"
 *
 * A rerun therefore never pays twice, and a crash costs only the transaction it
 * crashed on. Combined with {@link confirm}, which refuses to treat a receipt
 * timeout as a failure, that makes the whole thing safe to simply run again.
 *
 * ## Parallelism
 *
 * Operator calls are serial — they share one nonce. Wallet and agent approvals
 * are not: fourteen accounts have fourteen independent nonces, so they run
 * concurrently and the approval phase costs a handful of blocks instead of a
 * hundred.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import "dotenv/config";

import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  http,
  maxUint256,
  type Account,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import {
  agentRegistryAbi,
  fixtureFactoryAbi,
  matchOracleAbi,
  mmVaultAbi,
  mmVaultWriteAbi,
  mockUsdcAbi,
  playerCardAbi,
  poolManagerAbi,
  settlementPotAbi,
  whistleHookAbi,
  whistleHookWriteAbi,
} from "../oracle/abi.js";
import { assertFixtureWritable, rpcUrlFor, walletFor, type Deployment } from "../oracle/chain.js";
import { loadFixture } from "../oracle/fixture.js";
import { confirm, POLL_INTERVAL_MS, send, sendBatch } from "../oracle/tx.js";
import { USDC, type Fixture } from "../oracle/types.js";
import { keccak256, toHex } from "viem";

// ----------------------------------------------------------------- constants

const POOL_MANAGER: Address = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";

/** Dynamic-fee flag; the hook overrides the fee per fill. */
const DYNAMIC_FEE = 0x800000;
const TICK_SPACING = 60;

/** Half the seed goes into concentrated liquidity, half stays as inventory. */
const LP_SHARE_BPS = 5000;
const USDC_FOR_LP = 20_000n * USDC;

/**
 * Units of each pooled card the operator holds as float.
 *
 * Large enough that the 5% holder cap never binds on a demo wallet, which would
 * otherwise reject a perfectly ordinary mint for reasons no one watching could
 * be expected to guess.
 */
const POOLED_FLOAT = (): bigint => BigInt(process.env.SEED_POOLED_FLOAT ?? "20000") * 10n ** 18n;

/** Units deposited into vault inventory on top of what `seedCard` retains. */
const VAULT_DEPOSIT = (): bigint => BigInt(process.env.SEED_VAULT_DEPOSIT ?? "5000") * 10n ** 18n;

const WALLET_USDC = 500_000n * USDC;

/**
 * What a pre-created mandate may spend, and what its agent starts with.
 *
 * Fixture A was seeded with a 2,000,000 USDC cap, which on stage reads as "no
 * limit" and undercuts the one thing a mandate is for. The demo fixtures use a
 * cap a judge reads as a limit (`SEED_AGENT_CAP_USDC=500`), and the agent's own
 * seed is sized to it, because the cap counts SELLS too: the hook debits the
 * full notional of every agent fill, and `isAuthorized` refuses an order that
 * would cross the cap. `protect` sells 40% of a hit holding without looking at
 * the cap, so a 300-card holding at ~7 USDC (an 840 USDC trim) could never
 * trade under 500. At 100 heavy / 25 light / 25 other, the largest trim is
 * ~40 cards (~300 USDC) and a second still fits; buys already size to the cap.
 *
 * `SEED_AGENT_CARDS` is heavy,light,other: the portfolio's heavy and light
 * cards, then every other pooled card. `SEED_AGENT_USDC` is each agent's USDC;
 * the cap, not the balance, is meant to be the limit. Defaults are fixture A's.
 */
//
// Every knob is read when it is used, not when the module loads: the demo
// orchestrator imports this file once and seeds several fixtures with different
// settings in one run.
const AGENT_CAP_USDC = (): bigint => BigInt(process.env.SEED_AGENT_CAP_USDC ?? "2000000") * USDC;
const agentCards = (): [bigint, bigint, bigint] =>
  (process.env.SEED_AGENT_CARDS ?? "400,80,300").split(",").map((x) => BigInt(x.trim()) * 10n ** 18n) as [bigint, bigint, bigint];
const AGENT_HEAVY = (): bigint => agentCards()[0];
const AGENT_LIGHT = (): bigint => agentCards()[1];
const AGENT_CARD_UNITS = (): bigint => agentCards()[2];
const AGENT_USDC = (): bigint => BigInt(process.env.SEED_AGENT_USDC ?? "500000") * USDC;
/**
 * `SEED_CAP_EXEMPT`: extra addresses exempted from the 5% holder cap, comma-separated.
 * A fixture seeded with a small supply per card (Demo 1: ~1,000 units) puts its
 * agents far over 5% of it, and a capped fill would revert the whole tick.
 */
const EXTRA_CAP_EXEMPT = (): Address[] =>
  (process.env.SEED_CAP_EXEMPT ?? "").split(",").map((x) => x.trim()).filter(Boolean) as Address[];
/**
 * `SEED_AGENT_TOPUP=1`: bring each agent up to `SEED_AGENT_CARDS`' third number
 * on every pooled card, not only mint where it holds none — for re-seeding a
 * fixture whose pool set grew (Demo 3: ~150 per pooled card).
 */
const AGENT_TOPUP = (): boolean => process.env.SEED_AGENT_TOPUP === "1";
/**
 * `SEED_OWNER_EXEMPT_ALL=1`: exempt the operator from the 5% holder cap on EVERY
 * card of the fixture, pooled or not. A card nobody holds cannot otherwise be
 * minted at all — the first mint is 100% of it — so without this the operator
 * could mint only the pooled cards, whose float made them exempt.
 */
const OWNER_EXEMPT_ALL = (): boolean => process.env.SEED_OWNER_EXEMPT_ALL === "1";
/** `SEED_WALLET_CARDS=none`: wallets get USDC and approvals only, no card portfolio. */
const WALLET_CARDS = (): boolean => process.env.SEED_WALLET_CARDS !== "none";

/**
 * USDC for a seeded wallet. In the single-owner split the owner keeps the large
 * balance and every agent gets `SEED_AGENT_USDC`; the owner is recognised by
 * address, not by position, so a fixture can seed agents without the owner.
 */
const walletUsdc = (wallet: Account, operator: Account): bigint =>
  OWNER_SHARE_PCT() !== null && wallet.address.toLowerCase() !== operator.address.toLowerCase() ? AGENT_USDC() : WALLET_USDC;
const VAULT_RESERVE = 5_000_000n * USDC;

/**
 * Gas float for every wallet and agent key.
 *
 * Easy to forget, because it is the one thing the contracts never mention — and
 * the failure is late and confusing: every approval in the final step reverts
 * with `insufficient funds` long after the interesting work succeeded. An agent
 * sends roughly a dozen transactions across a match; 0.015 ETH is generous at
 * Sepolia gas prices and cheap to top up.
 */
const GAS_FLOAT = 6_000_000_000_000_000n; // 0.006 ETH
const GAS_FLOOR = 2_000_000_000_000_000n; // 0.002 ETH — top up below this
const VAULT_FUND = 50_000_000n * USDC;

/**
 * The cards that get a Uniswap pool.
 *
 * Every one of these is traded in the demo; see the table this script prints. Cards not listed here are mint-and-redeem
 * only, which the app shows as "mint only".
 */
const TRADED = (): number[] => process.env.SEED_TRADED
  ? process.env.SEED_TRADED.split(",").map((x) => Number(x.trim()))
  : [0, 2, 4, 5, 9, 10, 18, 19, 21, 25, 26];

const WHY_TRADED: Record<number, string> = {
  0: "Petr Cech — concedes Iniesta's 93' equaliser",
  2: "John Terry — Chelsea defence on the 93' goal",
  4: "Ashley Cole — Chelsea defence on the 93' goal",
  5: "Michael Essien — scores at 9'",
  9: "Florent Malouda — substituted off at 65', line freezes",
  10: "Didier Drogba — momentum target when Barcelona go down to ten",
  18: "Victor Valdes — concedes Essien's 9' goal",
  19: "Carles Puyol — Barcelona defence on the 9' goal",
  21: "Eric Abidal — sent off at 66'",
  25: "Andres Iniesta — scores at 93'",
  26: "Lionel Messi — contrarian target after the red card",
};

// ------------------------------------------------------------------ plumbing

interface Ctx {
  publicClient: PublicClient;
  rpcUrl: string;
  deployment: Deployment;
  fixture: Fixture;
  operator: Account;
  operatorWallet: WalletClient;
  wallets: Account[];
  agents: Account[];
  cards: Map<number, Address>;
  traded: { id: number; name: string; card: Address }[];
  userLabel: string;
  userAddress: Address;
  check: boolean;
}

function keysFrom(...names: string[]): Account[] {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const accounts = raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`));
    if (accounts.length > 0) return accounts;
  }
  return [];
}

function accountFrom(...names: string[]): Account {
  const [a] = keysFrom(...names);
  if (!a) throw new Error(`none of ${names.join(", ")} is set. See .env.example.`);
  return a;
}

/** `√(price) · 2^96`, integer-only, matching `DeployWhistle._initPool`. */
function sqrtPriceX96(reference: bigint, usdcIsCurrency0: boolean): bigint {
  const WAD = 10n ** 18n;
  const Q96 = 1n << 96n;
  const ratio = usdcIsCurrency0 ? (WAD * Q96) / reference : (reference * Q96) / WAD;
  return isqrt(ratio) << 48n;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

function poolKey(usdc: Address, card: Address, hook: Address) {
  const usdcIsCurrency0 = usdc.toLowerCase() < card.toLowerCase();
  return {
    currency0: (usdcIsCurrency0 ? usdc : card) as Address,
    currency1: (usdcIsCurrency0 ? card : usdc) as Address,
    fee: DYNAMIC_FEE,
    tickSpacing: TICK_SPACING,
    hooks: hook,
  } as const;
}

/**
 * The portfolio shape from `FullMatchReplay.t.sol`: wallet `i` is heavy in card
 * `i % 3` and lighter elsewhere, so no two demo screens look alike.
 */
function portfolioFor(walletIndex: number, cardIndex: number): bigint {
  const heavy = cardIndex === walletIndex % 3;
  const OWNER_SHARE = OWNER_SHARE_PCT();
  if (OWNER_SHARE !== null) {
    /*
     * The single-owner split: wallet 0 is the owner, the rest are the fixture's
     * agents, and the owner holds OWNER_SHARE_PCT of everything seeded.
     *
     * Every holder gets the same shape (one heavy card, two light), so the split
     * is one multiplier: owner / agent = (pct / (100 - pct)) * agentCount. At
     * 60% with three agents that is 4.5x, and the totals come out 60/40 exactly.
     * No per-index stagger here — it would move the split off 60/40.
     */
    const base = heavy ? AGENT_HEAVY() : AGENT_LIGHT();
    if (walletIndex !== 0) return base;
    const agents = BigInt(Math.max(1, seededWalletCount - 1));
    return (base * BigInt(OWNER_SHARE) * agents) / BigInt(100 - OWNER_SHARE);
  }
  return (heavy ? 400n : 80n) * 10n ** 18n + BigInt(walletIndex) * 10n ** 19n;
}

/** `SEED_OWNER_SHARE=60` → wallet 0 (the owner) holds 60% of the seeded cards. */
const OWNER_SHARE_PCT = (): number | null => (process.env.SEED_OWNER_SHARE ? Number(process.env.SEED_OWNER_SHARE) : null);
let seededWalletCount = 0;

/**
 * The VerifiableFactory salt for a label, derived rather than chosen.
 *
 * A hand-picked number has to be unique across every proxy the factory has ever
 * deployed, and the failure when it is not is a bare `execution reverted` with no
 * reason — which cost a debugging round the first time `registerUser("tokyo")`
 * hit a number already used. Deriving it from the label means a new label can
 * never collide with an old one, and re-running for the same label lands on the
 * same address, which the caller skips because the name is already registered.
 */
function saltFor(kind: "user" | "agent", label: string): bigint {
  return BigInt(keccak256(toHex(`whistle:${kind}:${label}`)));
}

/** Run one job per account concurrently; accounts have independent nonces. */
async function perAccount<T>(items: T[], job: (item: T, index: number) => Promise<void>): Promise<void> {
  const results = await Promise.allSettled(items.map(job));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    for (const f of failed) console.error(`  ! ${(f as PromiseRejectedResult).reason}`);
    throw new Error(`${failed.length} of ${items.length} accounts failed; rerun to resume`);
  }
}

// --------------------------------------------------------------------- steps

interface Step {
  name: string;
  /** What is still owed. Empty means done. */
  pending(ctx: Ctx): Promise<string[]>;
  run(ctx: Ctx, pending: string[]): Promise<void>;
}

const steps: Step[] = [
  // ------------------------------------------------------------------------
  {
    name: "contracts",
    async pending(ctx) {
      const owed: string[] = [];
      for (const [label, address] of Object.entries({
        matchOracle: ctx.deployment.matchOracle,
        settlementPot: ctx.deployment.settlementPot,
        whistleHook: ctx.deployment.whistleHook,
        fillRouter: ctx.deployment.fillRouter,
        mmVault: ctx.deployment.mmVault,
        agentRegistry: ctx.deployment.agentRegistry,
        fixtureFactory: ctx.deployment.fixtureFactory,
        usdc: ctx.deployment.usdc,
      })) {
        const code = await ctx.publicClient.getCode({ address: address as Address });
        if (!code || code === "0x") owed.push(`${label} has no code at ${address}`);
      }
      return owed;
    },
    async run(_ctx, pending) {
      throw new Error(
        `${pending.join("; ")}.\n` +
          `Contract deployment is a forge script, not this file:\n` +
          `  cd contracts && forge script script/DeployWhistle.s.sol:DeployWhistle \\\n` +
          `    --rpc-url $SEPOLIA_RPC_URL --broadcast --slow --no-storage-caching\n` +
          `Then rerun this to finish the seeding.`,
      );
    },
  },

  // ------------------------------------------------------------------------
  {
    name: "ens",
    async pending(ctx) {
      const owed: string[] = [];
      const registry = await ctx.publicClient.readContract({
        address: ctx.deployment.agentRegistry, abi: agentRegistryAbi,
        functionName: "userAccounts", args: [ctx.userAddress],
      });
      if (registry[3] === false) owed.push(`user:${ctx.userLabel}`);

      for (const [i, agent] of ctx.agents.entries()) {
        const info = await ctx.publicClient.readContract({
          address: ctx.deployment.agentRegistry, abi: agentRegistryAbi,
          functionName: "agentInfo", args: [agent.address],
        });
        if (info[2] === "0x0000000000000000000000000000000000000000") owed.push(`agent${i + 1}`);
      }
      return owed;
    },
    async run(ctx, pending) {
      const { publicClient, operatorWallet: w, operator: account, deployment: d } = ctx;

      if (pending.some((p) => p.startsWith("user:"))) {
        await send(publicClient, w, `registerUser ${ctx.userLabel}`, {
          address: d.agentRegistry, abi: agentRegistryAbi, functionName: "registerUser",
          args: [
            ctx.userLabel,
            ctx.userAddress,
            saltFor("user", ctx.userLabel),
            BigInt(Math.floor(Date.now() / 1000) + 180 * 24 * 3600),
          ],
          chain: sepolia, account,
        });
      }

      // Mandates are serial: `createAgent` numbers labels off the user's own
      // counter, so two in flight would race for `agent-N`.
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
      for (const [i, agent] of ctx.agents.entries()) {
        if (!pending.includes(`agent${i + 1}`)) continue;
        // Three agents get one playbook each — protect, momentum, contrarian.
        // Six (the old layout) keep two of each.
        const templateId = BigInt(ctx.agents.length === 3 ? i + 1 : Math.floor(i / 2) + 1);
        await send(publicClient, w, `createAgent ${i + 1} (template ${templateId})`, {
          address: d.agentRegistry, abi: agentRegistryAbi, functionName: "createAgent",
          args: [{
            user: ctx.userAddress,
            agent: agent.address,
            fixtureId: ctx.fixture.fixtureId,
            templateId,
            spendCapUSDC: AGENT_CAP_USDC(),
            slippageBps: 1000n,
            expiry,
            salt: saltFor("agent", `${ctx.userLabel}:${agent.address}`),
          }],
          chain: sepolia, account,
        });
      }
    },
  },

  // ------------------------------------------------------------------------
  {
    name: "vault-funding",
    async pending(ctx) {
      const owed: string[] = [];
      const usdcBal = await ctx.publicClient.readContract({
        address: ctx.deployment.usdc,
        abi: mockUsdcAbi,
        functionName: "balanceOf",
        args: [ctx.deployment.mmVault],
      });
      // `fund` covers pool seeding; `fundReserve` is the fill-side reserve.
      if (usdcBal < VAULT_FUND / 2n) owed.push("vault USDC float");
      const reserve = await ctx.publicClient.readContract({
        address: ctx.deployment.mmVault,
        abi: mmVaultAbi,
        functionName: "availableUSDC",
      });
      if (reserve < VAULT_RESERVE / 2n) owed.push("vault reserve");
      return owed;
    },
    async run(ctx, pending) {
      const { publicClient, operatorWallet: w, operator: account, deployment: d } = ctx;
      // The operator has to be able to pay for both.
      await send(publicClient, w, "mint operator USDC", {
        address: d.usdc, abi: mockUsdcAbi, functionName: "mint",
        args: [account.address, VAULT_FUND + VAULT_RESERVE + 50_000_000n * USDC],
        chain: sepolia, account,
      });
      for (const spender of [d.settlementPot, d.mmVault]) {
        const allowance = await publicClient.readContract({
          address: d.usdc, abi: mockUsdcAbi, functionName: "allowance",
          args: [account.address, spender],
        });
        if (allowance < VAULT_FUND) {
          await send(publicClient, w, `approve USDC -> ${spender.slice(0, 10)}`, {
            address: d.usdc, abi: mockUsdcAbi, functionName: "approve",
            args: [spender, maxUint256], chain: sepolia, account,
          });
        }
      }
      if (pending.includes("vault USDC float")) {
        await send(publicClient, w, "vault.fund", {
          address: d.mmVault, abi: mmVaultWriteAbi, functionName: "fund",
          args: [VAULT_FUND], chain: sepolia, account,
        });
      }
      if (pending.includes("vault reserve")) {
        await send(publicClient, w, "vault.fundReserve", {
          address: d.mmVault, abi: mmVaultWriteAbi, functionName: "fundReserve",
          args: [VAULT_RESERVE], chain: sepolia, account,
        });
      }
    },
  },

  // ------------------------------------------------------------------------
  {
    name: "pools",
    async pending(ctx) {
      const owed: string[] = [];
      for (const { id, name, card } of ctx.traded) {
        const info = await ctx.publicClient.readContract({
          address: ctx.deployment.whistleHook, abi: whistleHookAbi,
          functionName: "cardInfo", args: [card],
        });
        if (!info.registered) {
          owed.push(`${id}:${name}`);
          continue;
        }
        const state = await ctx.publicClient.readContract({
          address: ctx.deployment.mmVault, abi: mmVaultAbi,
          functionName: "cardState", args: [card],
        });
        if (state.seeded === 0n) owed.push(`${id}:${name}`);
      }
      return owed;
    },
    async run(ctx, pending) {
      const { publicClient, operatorWallet: w, operator: account, deployment: d } = ctx;
      const ids = new Set(pending.map((p) => Number(p.split(":")[0])));
      const todo = ctx.traded.filter((t) => ids.has(t.id));

      /**
       * Two batches, not one.
       *
       * Cap exemptions and float mints are both independent operator calls, and
       * batching them saves a block each. But they cannot share a batch: viem
       * estimates gas for every call in a batch up front, against current state,
       * so a float mint queued alongside its own exemption is estimated while the
       * holder cap still applies and reverts `HolderCapExceeded` before it is
       * ever sent. Nonce ordering would have been fine; estimation is not.
       */
      const exemptions: { label: string; request: unknown }[] = [];
      const floats: { label: string; request: unknown }[] = [];
      for (const { id, name, card } of todo) {
        for (const who of [d.mmVault, d.whistleHook, d.fillRouter, POOL_MANAGER, account.address, ...EXTRA_CAP_EXEMPT()]) {
          const exempt = await publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "capExempt", args: [who],
          });
          if (!exempt) {
            exemptions.push({
              label: `${id} ${name} capExempt ${who.slice(0, 10)}`,
              request: { address: d.fixtureFactory, abi: fixtureFactoryAbi, functionName: "setCapExempt",
                         args: [card, who, true], chain: sepolia, account },
            });
          }
        }
        const held = await publicClient.readContract({
          address: card, abi: playerCardAbi, functionName: "balanceOf", args: [account.address],
        });
        if (held < POOLED_FLOAT()) {
          floats.push({
            label: `${id} ${name} mint float`,
            request: { address: d.settlementPot, abi: settlementPotAbi, functionName: "mintPreMatch",
                       args: [card, POOLED_FLOAT() - held, account.address], chain: sepolia, account },
          });
        }
      }
      await sendBatch(publicClient, w, "cap exemptions", exemptions as never[]);
      await sendBatch(publicClient, w, "card float", floats as never[]);

      // The rest is a chain per card: initialize -> register -> seed -> deposit.
      for (const { id, name, card } of todo) {
        console.log(`\npool for ${id} ${name}  ${card}`);
        const key = poolKey(d.usdc, card, d.whistleHook);
        const info = await publicClient.readContract({
          address: d.whistleHook, abi: whistleHookAbi, functionName: "cardInfo", args: [card],
        });
        if (!info.registered) {
          const reference = await publicClient.readContract({
            address: d.settlementPot, abi: settlementPotAbi, functionName: "referencePrice", args: [card],
          });
          const price = sqrtPriceX96(reference, key.currency0.toLowerCase() === d.usdc.toLowerCase());
          // Initialising a pool that already exists reverts; the hook registration
          // below is the real record, so tolerate a pre-existing pool.
          await send(publicClient, w, "pool initialize", {
            address: POOL_MANAGER, abi: poolManagerAbi, functionName: "initialize",
            args: [key, price], chain: sepolia, account,
          }).catch((e) => console.log(`  (pool already initialised: ${String(e).slice(0, 60)})`));

          await send(publicClient, w, "hook.registerCard", {
            address: d.whistleHook, abi: whistleHookWriteAbi, functionName: "registerCard",
            args: [BigInt(ctx.fixture.fixtureId), card, key], chain: sepolia, account,
          });
        }

        const state = await publicClient.readContract({
          address: d.mmVault, abi: mmVaultAbi, functionName: "cardState", args: [card],
        });
        if (!state.registered) {
          await send(publicClient, w, "vault.registerCard", {
            address: d.mmVault, abi: mmVaultWriteAbi, functionName: "registerCard",
            args: [card, key], chain: sepolia, account,
          });
        }
        if (state.seeded === 0n) {
          await send(publicClient, w, "vault.seedCard", {
            address: d.mmVault, abi: mmVaultWriteAbi, functionName: "seedCard",
            args: [card, LP_SHARE_BPS, USDC_FOR_LP], chain: sepolia, account,
          });
          const allowance = await publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "allowance",
            args: [account.address, d.mmVault],
          });
          if (allowance < VAULT_DEPOSIT()) {
            await send(publicClient, w, "approve card -> vault", {
              address: card, abi: playerCardAbi, functionName: "approve",
              args: [d.mmVault, maxUint256], chain: sepolia, account,
            });
          }
          await send(publicClient, w, "vault.depositCards", {
            address: d.mmVault, abi: mmVaultWriteAbi, functionName: "depositCards",
            args: [card, VAULT_DEPOSIT()], chain: sepolia, account,
          });
        }
      }
    },
  },

  // ------------------------------------------------------------------------
  {
    name: "owner-exempt",
    async pending(ctx) {
      if (!OWNER_EXEMPT_ALL()) return [];
      const count = Number(await ctx.publicClient.readContract({
        address: ctx.deployment.matchOracle, abi: matchOracleAbi, functionName: "playerCount", args: [ctx.fixture.fixtureId],
      }));
      const owed: string[] = [];
      for (let id = 0; id < count; id++) {
        const card = await ctx.publicClient.readContract({
          address: ctx.deployment.matchOracle, abi: matchOracleAbi, functionName: "cardOf", args: [ctx.fixture.fixtureId, id],
        });
        const exempt = await ctx.publicClient.readContract({
          address: card, abi: playerCardAbi, functionName: "capExempt", args: [ctx.operator.address],
        });
        if (!exempt) owed.push(`${id}:${card}`);
      }
      return owed;
    },
    async run(ctx, pending) {
      const { publicClient, operatorWallet: w, operator: account, deployment: d } = ctx;
      const calls = pending.map((p) => {
        const [id, card] = p.split(":") as [string, Address];
        return {
          label: `#${id} capExempt operator`,
          request: { address: d.fixtureFactory, abi: fixtureFactoryAbi, functionName: "setCapExempt",
                     args: [card, account.address, true], chain: sepolia, account },
        };
      });
      await sendBatch(publicClient, w, "operator cap exemptions", calls as never[]);
    },
  },

  // ------------------------------------------------------------------------
  {
    name: "gas",
    async pending(ctx) {
      const owed: string[] = [];
      for (const [i, a] of ctx.wallets.entries()) {
        if ((await ctx.publicClient.getBalance({ address: a.address })) < GAS_FLOOR) owed.push(`wallet${i}`);
      }
      for (const [i, a] of ctx.agents.entries()) {
        if ((await ctx.publicClient.getBalance({ address: a.address })) < GAS_FLOOR) owed.push(`agent${i + 1}`);
      }
      return owed;
    },
    async run(ctx, pending) {
      const { publicClient, operatorWallet: w, operator: account } = ctx;
      const targets = [
        ...ctx.wallets.map((a, i) => [`wallet${i}`, a] as const),
        ...ctx.agents.map((a, i) => [`agent${i + 1}`, a] as const),
      ].filter(([name]) => pending.includes(name));

      const needed = BigInt(targets.length) * GAS_FLOAT;
      const have = await publicClient.getBalance({ address: account.address });
      if (have < needed) {
        throw new Error(
          `operator holds ${have} wei but needs ${needed} to fund ${targets.length} keys. Send it more Sepolia ETH.`,
        );
      }

      // Plain transfers, all independent: one nonce sequence, sent together.
      let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      const sends: Promise<void>[] = [];
      for (const [name, a] of targets) {
        const balance = await publicClient.getBalance({ address: a.address });
        const top = GAS_FLOAT > balance ? GAS_FLOAT - balance : 0n;
        if (top === 0n) continue;
        const n = nonce++;
        sends.push(
          (async () => {
            const hash = await w.sendTransaction({ to: a.address, value: top, nonce: n, chain: sepolia, account });
            await confirm(publicClient, hash, `${name} gas`);
            console.log(`  ${name.padEnd(46)} ${hash}`);
          })(),
        );
      }
      await Promise.all(sends);
    },
  },

  // ------------------------------------------------------------------------
  {
    name: "wallets",
    async pending(ctx) {
      const owed: string[] = [];
      for (const [i, wallet] of ctx.wallets.entries()) {
        const usdcBal = await ctx.publicClient.readContract({
          address: ctx.deployment.usdc, abi: mockUsdcAbi, functionName: "balanceOf",
          args: [wallet.address],
        });
        const missing: string[] = [];
        if (usdcBal < walletUsdc(wallet, ctx.operator) / 2n) missing.push("usdc");
        for (const [c, { card }] of ctx.traded.entries()) {
          const bal = await ctx.publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "balanceOf", args: [wallet.address],
          });
          if (bal === 0n && c < 3 && WALLET_CARDS() && portfolioFor(i, c) > 0n) missing.push(`card${c}`);
          const allowance = await ctx.publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "allowance",
            args: [wallet.address, ctx.deployment.whistleHook],
          });
          if (allowance === 0n) missing.push(`approve${c}`);
        }
        if (missing.length > 0) owed.push(`wallet${i}`);
      }
      return owed;
    },
    async run(ctx, pending) {
      const { publicClient, operatorWallet: opWallet, operator, deployment: d } = ctx;
      const idx = new Set(pending.map((p) => Number(p.replace("wallet", ""))));

      // Every operator-side mint is independent, so they go out as one batch.
      const mints: { label: string; request: unknown }[] = [];
      for (const [i, wallet] of ctx.wallets.entries()) {
        if (!idx.has(i)) continue;
        const usdcBal = await publicClient.readContract({
          address: d.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [wallet.address],
        });
        if (usdcBal < walletUsdc(wallet, operator) / 2n) {
          mints.push({ label: `wallet${i} mint USDC`, request: {
            address: d.usdc, abi: mockUsdcAbi, functionName: "mint",
            args: [wallet.address, walletUsdc(wallet, operator)], chain: sepolia, account: operator } });
        }
        // Only the first three cards form the portfolio; the rest are approve-only
        // so a wallet can still trade them if the demo wanders.
        for (const [c, { name, card }] of ctx.traded.slice(0, 3).entries()) {
          const bal = await publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "balanceOf", args: [wallet.address],
          });
          if (bal === 0n && WALLET_CARDS() && portfolioFor(i, c) > 0n) {
            mints.push({ label: `wallet${i} mint ${name}`, request: {
              address: d.settlementPot, abi: settlementPotAbi, functionName: "mintPreMatch",
              args: [card, portfolioFor(i, c), wallet.address], chain: sepolia, account: operator } });
          }
        }
      }
      await sendBatch(publicClient, opWallet, "wallet mints", mints as never[]);

      // Approvals are the wallets' own, so they run in parallel.
      await perAccount([...idx], async (i) => {
        const wallet = ctx.wallets[i];
        if (!wallet) return;
        const client = walletFor(wallet, sepolia, ctx.rpcUrl);
        const usdcAllowance = await publicClient.readContract({
          address: d.usdc, abi: mockUsdcAbi, functionName: "allowance",
          args: [wallet.address, d.whistleHook],
        });
        if (usdcAllowance === 0n) {
          await send(publicClient, client, `wallet${i} approve USDC`, {
            address: d.usdc, abi: mockUsdcAbi, functionName: "approve",
            args: [d.whistleHook, maxUint256], chain: sepolia, account: wallet,
          });
        }
        for (const { name, card } of ctx.traded) {
          const allowance = await publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "allowance",
            args: [wallet.address, d.whistleHook],
          });
          if (allowance === 0n) {
            await send(publicClient, client, `wallet${i} approve ${name}`, {
              address: card, abi: playerCardAbi, functionName: "approve",
              args: [d.whistleHook, maxUint256], chain: sepolia, account: wallet,
            });
          }
        }
      });
    },
  },

  // ------------------------------------------------------------------------
  {
    name: "agents",
    async pending(ctx) {
      const owed: string[] = [];
      for (const [i, agent] of ctx.agents.entries()) {
        const info = await ctx.publicClient.readContract({
          address: ctx.deployment.agentRegistry, abi: agentRegistryAbi,
          functionName: "agentInfo", args: [agent.address],
        });
        if (info[2] === "0x0000000000000000000000000000000000000000") {
          owed.push(`agent${i + 1}:unregistered`);
          continue;
        }
        const usdcBal = await ctx.publicClient.readContract({
          address: ctx.deployment.usdc, abi: mockUsdcAbi, functionName: "balanceOf",
          args: [agent.address],
        });
        const missing = usdcBal < AGENT_USDC() / 2n;
        let needsCards = false;
        for (const { card } of ctx.traded) {
          const allowance = await ctx.publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "allowance",
            args: [agent.address, ctx.deployment.whistleHook],
          });
          if (allowance === 0n) needsCards = true;
          // Every pooled card, not just the portfolio's three, when the seed asks for them.
          if (AGENT_CARD_UNITS() > 0n) {
            const bal = await ctx.publicClient.readContract({
              address: card, abi: playerCardAbi, functionName: "balanceOf", args: [agent.address],
            });
            if (bal === 0n || (AGENT_TOPUP() && bal < AGENT_CARD_UNITS())) needsCards = true;
          }
        }
        if (missing || needsCards) owed.push(`agent${i + 1}`);
      }
      return owed;
    },
    async run(ctx, pending) {
      const unregistered = pending.filter((p) => p.endsWith(":unregistered"));
      if (unregistered.length > 0) {
        throw new Error(
          `${unregistered.join(", ")} not registered in AgentRegistry. ` +
            `Granting a mandate is the user's call, not this script's — ` +
            `run createAgent (see contracts/script/DeployWhistle.s.sol:_createAgents), then rerun.`,
        );
      }
      const { publicClient, operatorWallet: opWallet, operator, deployment: d } = ctx;
      const idx = new Set(pending.map((p) => Number(p.replace("agent", "")) - 1));

      const mints: { label: string; request: unknown }[] = [];
      for (const [i, agent] of ctx.agents.entries()) {
        if (!idx.has(i)) continue;
        const usdcBal = await publicClient.readContract({
          address: d.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [agent.address],
        });
        if (usdcBal < AGENT_USDC() / 2n) {
          mints.push({ label: `agent${i + 1} mint USDC`, request: {
            address: d.usdc, abi: mockUsdcAbi, functionName: "mint",
            args: [agent.address, AGENT_USDC()], chain: sepolia, account: operator } });
        }
        for (const { name, card } of ctx.traded) {
          const bal = await publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "balanceOf", args: [agent.address],
          });
          const want = AGENT_TOPUP() ? AGENT_CARD_UNITS() - (bal < AGENT_CARD_UNITS() ? bal : AGENT_CARD_UNITS()) : bal === 0n ? AGENT_CARD_UNITS() : 0n;
          if (want > 0n) {
            mints.push({ label: `agent${i + 1} mint ${name}`, request: {
              address: d.settlementPot, abi: settlementPotAbi, functionName: "mintPreMatch",
              args: [card, want, agent.address], chain: sepolia, account: operator } });
          }
        }
      }
      await sendBatch(publicClient, opWallet, "agent mints", mints as never[]);

      await perAccount([...idx], async (i) => {
        const agent = ctx.agents[i];
        if (!agent) return;
        const client = walletFor(agent, sepolia, ctx.rpcUrl);
        const usdcAllowance = await publicClient.readContract({
          address: d.usdc, abi: mockUsdcAbi, functionName: "allowance",
          args: [agent.address, d.whistleHook],
        });
        if (usdcAllowance === 0n) {
          await send(publicClient, client, `agent${i + 1} approve USDC`, {
            address: d.usdc, abi: mockUsdcAbi, functionName: "approve",
            args: [d.whistleHook, maxUint256], chain: sepolia, account: agent,
          });
        }
        for (const { name, card } of ctx.traded) {
          const allowance = await publicClient.readContract({
            address: card, abi: playerCardAbi, functionName: "allowance",
            args: [agent.address, d.whistleHook],
          });
          if (allowance === 0n) {
            await send(publicClient, client, `agent${i + 1} approve ${name}`, {
              address: card, abi: playerCardAbi, functionName: "approve",
              args: [d.whistleHook, maxUint256], chain: sepolia, account: agent,
            });
          }
        }
      });
    },
  },
];

// ---------------------------------------------------------------------- main

export interface SeedOptions {
  /** Arguments to parse instead of process.argv — the orchestrator passes its own. */
  argv?: string[];
  /**
   * Record every write instead of sending it (see `PLAN` in oracle/tx.ts). The
   * steps' own reads still run against the chain, so the plan is exactly what a
   * real run would send from this state.
   */
  planOnly?: boolean;
}

export async function main(opts: SeedOptions = {}): Promise<void> {
  const argv = opts.argv ?? process.argv.slice(2);

  /**
   * `--plan saturday` is a different job to this script's own.
   *
   * This script brings ONE fixture up to seeded. The plan runs it twice, with a
   * replay, a redeem and a web build in between, because the demo needs a
   * settled fixture and a waiting one and a replay settles what it runs on.
   */
  if (argv.includes("--plan")) {
    const plan = argv[argv.indexOf("--plan") + 1];
    if (plan !== "saturday") throw new Error(`unknown plan "${plan}". The only plan is "saturday".`);
    const { runSaturdayPlan } = await import("./saturday.js");
    const arg = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    await runSaturdayPlan({
      dryRun: argv.includes("--dry-run"),
      force: argv.includes("--force"),
      // A is played out and B is kept; distinct ids so both can exist at once.
      fixtureIdA: arg("--fixture-a") ?? `${stamp}1`,
      fixtureIdB: arg("--fixture-b") ?? `${stamp}2`,
    });
    return;
  }

  const check = argv.includes("--check") || argv.includes("--dry-run");
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
  const fixturePath =
    (argv.includes("--fixture") ? argv[argv.indexOf("--fixture") + 1] : undefined) ??
    "fixtures/che-bar-2009-05-06.json";

  const rpcUrl = rpcUrlFor(sepolia);
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { retryCount: 5, retryDelay: 1_000, timeout: 60_000 }),
    pollingInterval: POLL_INTERVAL_MS,
  }) as PublicClient;

  const path = resolve(process.env.WHISTLE_DEPLOYMENT ?? `deployments/${sepolia.id}.json`);
  if (!existsSync(path)) throw new Error(`no deployment at ${path}; run the forge script first`);
  const deployment = JSON.parse(readFileSync(path, "utf8")) as Deployment;

  const fixture = await loadFixture(fixturePath);
  // The fixture FILE describes the match; the DEPLOYMENT says which on-chain
  // fixture id that match was deployed as. A second run of the same match has a
  // different id, so the deployment wins.
  if (deployment.fixtureId) fixture.fixtureId = BigInt(deployment.fixtureId);
  const operator = accountFrom("SEPOLIA_DEPLOYER_KEY", "DEPLOYER_PRIVATE_KEY");
  const operatorWallet = walletFor(operator, sepolia, rpcUrl);
  const wallets = keysFrom("SEPOLIA_WALLET_KEYS", "DEMO_WALLET_KEYS");
  seededWalletCount = wallets.length;
  const agents = keysFrom("TOKYO_AGENT_KEYS", "SEPOLIA_AGENT_KEYS", "AGENT_PRIVATE_KEYS");

  const cards = new Map<number, Address>();
  const traded: Ctx["traded"] = [];
  for (const id of TRADED()) {
    const player = fixture.players.find((p) => p.id === id);
    if (!player) throw new Error(`fixture has no player ${id}`);
    const card = await publicClient.readContract({
      address: deployment.matchOracle, abi: matchOracleAbi,
      functionName: "cardOf", args: [fixture.fixtureId, id],
    });
    cards.set(id, card);
    traded.push({ id, name: player.name, card });
  }

  const userLabel = (argv.includes("--user") ? argv[argv.indexOf("--user") + 1] : undefined)
    ?? process.env.WHISTLE_USER_LABEL ?? "tokyo";
  /*
   * Who owns the mandates — and, by default, the operator.
   *
   * `createAgent` is `onlyOperator`, so the /agents form only works from the
   * operator's wallet: any other connected wallet simulates to `OnlyOperator`
   * and the page shows that revert instead of creating anything. For the demo
   * the simplest honest arrangement is one key that is both, so the presenter
   * can create a mandate live from the UI.
   *
   * That is a demo convenience, not the design. Production separates the two —
   * see the note on the profile page.
   */
  const userAddress = (process.env.DEMO_USER_ADDRESS
    ?? process.env.TOKYO_USER_ADDRESS
    ?? operator.address) as Address;

  const ctx: Ctx = {
    publicClient, rpcUrl, deployment, fixture,
    operator, operatorWallet, wallets, agents, cards, traded,
    userLabel, userAddress, check,
  };

  console.log(`network    Sepolia (${sepolia.id})`);
  console.log(`fixture    ${fixture.fixtureId}`);
  console.log(`operator   ${operator.address}`);
  console.log(`wallets    ${wallets.length}   agents ${agents.length}`);
  console.log(
    `user       ${userLabel}.whistle.eth -> ${userAddress}` +
      (userAddress.toLowerCase() === operator.address.toLowerCase()
        ? "  (same key as the operator — the demo arrangement)"
        : ""),
  );
  console.log(`pooled     ${traded.length} cards\n`);

  console.log("pool coverage — every card a beat of the demo touches");
  for (const { id, name, card } of traded) {
    console.log(`  ${String(id).padStart(2)}  ${name.padEnd(20)} ${card}  ${WHY_TRADED[id] ?? ""}`);
  }
  console.log("");

  // ------------------------------------------------------------- checklist
  const report: { name: string; pending: string[] }[] = [];
  for (const step of steps) {
    if (only && step.name !== only) continue;
    const pending = await step.pending(ctx);
    report.push({ name: step.name, pending });
    const mark = pending.length === 0 ? "done" : `${pending.length} owed`;
    console.log(`  [${pending.length === 0 ? "x" : " "}] ${step.name.padEnd(16)} ${mark}`);
    if (pending.length > 0 && pending.length <= 12) console.log(`        ${pending.join(", ")}`);
  }
  console.log("");

  if (check) {
    const owed = report.filter((r) => r.pending.length > 0);
    console.log(owed.length === 0 ? "Everything is done." : `${owed.length} step(s) outstanding. Rerun without --check.`);
    return;
  }

  // Seeding writes to the fixture — pools, float, mandates. `--check` above sends
  // nothing and is always allowed; from here on it is real.
  assertFixtureWritable(fixture.fixtureId, "seed");

  // ------------------------------------------------------------------ run
  for (const step of steps) {
    if (only && step.name !== only) continue;
    const pending = await step.pending(ctx);
    if (pending.length === 0) {
      console.log(`== ${step.name}: nothing to do`);
      continue;
    }
    console.log(`\n== ${step.name}: ${pending.length} outstanding`);
    if (opts.planOnly && step.name === "gas") {
      // The gas step sends ETH with sendTransaction, which the plan sink does not
      // see. Every demo signer is funded up front, so this must be empty.
      throw new Error(`plan mode: gas step owes ${pending.join(", ")} — fund those signers first`);
    }
    await step.run(ctx, pending);
    if (opts.planOnly) {
      console.log(`== ${step.name}: planned`);
      continue;
    }
    const after = await step.pending(ctx);
    if (after.length > 0) throw new Error(`${step.name} still owes: ${after.join(", ")}`);
    console.log(`== ${step.name}: done`);
  }

  // Record what is pooled, so the app and the docs agree with the chain.
  const out = { ...(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) };
  out.tradedPlayerIds = TRADED();
  out.pooledCards = Object.fromEntries(traded.map((t) => [t.id, { name: t.name, card: t.card }]));
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nwrote ${path}`);
  console.log("\nAll steps complete.");
}

// Run only when invoked directly; the demo orchestrator imports `main`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
