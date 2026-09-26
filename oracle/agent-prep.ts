/**
 * Make a derived agent key able to trade: gas, USDC, and the hook's approvals.
 *
 * Shared by `/api/agents/assign` (the New agent form) and
 * `scripts/prepare-agent.ts` (the terminal), so the two cannot drift. Every step
 * reads first and only sends what is missing, so running it twice costs reads.
 *
 *   1. Gas, from the service key, only when the agent is below `GAS_FLOOR`. The
 *      service key is also the sim's single signer, so the transfer waits for a
 *      quiet moment (nothing pending) and for its receipt, and the step route's
 *      own busy check keeps the two from sharing a nonce.
 *   2. USDC. `MockUSDC.mint` is open, so the agent mints its own — on its own
 *      nonce, not the service key's.
 *   3. `approve(hook, max)` for USDC and every registered card: a buy pulls USDC
 *      at the tick and a sell pulls the card, both by `transferFrom`.
 *
 * The agent's own writes go out together with explicit nonces and fixed gas, so
 * the whole thing is two blocks: the gas transfer, then everything else.
 */

import {
  maxUint256,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";

import { mockUsdcAbi, playerCardAbi } from "./abi.js";

/** Covers the mint, a dozen approvals and a match's worth of `queueOrder`s at Sepolia prices. */
export const AGENT_GAS_FLOAT = 4_000_000_000_000_000n; // 0.004 ETH
export const AGENT_GAS_FLOOR = 2_000_000_000_000_000n; // 0.002 ETH

/** Enough to trade the whole of a small cap many times over; the cap, not the balance, is the limit. */
export const AGENT_USDC = 1_000n * 1_000_000n;

const APPROVE_GAS = 120_000n;
const MINT_GAS = 120_000n;

export interface PrepTarget {
  usdc: Address;
  whistleHook: Address;
  /** Every card the hook has registered for this fixture. */
  cards: Address[];
}

export interface PrepResult {
  funded: Hash | null;
  minted: Hash | null;
  approvals: Hash[];
}

async function waitQuiet(pc: PublicClient, address: Address, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [latest, pending] = await Promise.all([
      pc.getTransactionCount({ address, blockTag: "latest" }),
      pc.getTransactionCount({ address, blockTag: "pending" }),
    ]);
    if (pending <= latest) return;
    if (Date.now() > until) throw new Error("The service key has had a transaction pending for 90 seconds; try again.");
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

export async function prepareAgent(
  pc: PublicClient,
  service: WalletClient,
  agent: WalletClient,
  t: PrepTarget,
): Promise<PrepResult> {
  const serviceAccount = service.account as Account;
  const agentAccount = agent.account as Account;
  const who = agentAccount.address;
  const out: PrepResult = { funded: null, minted: null, approvals: [] };

  // 1. Gas from the service key.
  if ((await pc.getBalance({ address: who })) < AGENT_GAS_FLOOR) {
    await waitQuiet(pc, serviceAccount.address);
    const nonce = await pc.getTransactionCount({ address: serviceAccount.address, blockTag: "pending" });
    const hash = await service.sendTransaction({
      account: serviceAccount, chain: service.chain ?? null, to: who, value: AGENT_GAS_FLOAT, nonce, gas: 21_000n,
    });
    const rc = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success") throw new Error(`gas transfer to ${who} failed: ${hash}`);
    out.funded = hash;
  }

  // 2 + 3. The agent's own writes, all at once on consecutive nonces.
  const [usdcBal, usdcAllowance, cardAllowances] = await Promise.all([
    pc.readContract({ address: t.usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [who] }),
    pc.readContract({ address: t.usdc, abi: mockUsdcAbi, functionName: "allowance", args: [who, t.whistleHook] }),
    Promise.all(t.cards.map((card) =>
      pc.readContract({ address: card, abi: playerCardAbi, functionName: "allowance", args: [who, t.whistleHook] }),
    )),
  ]);

  let nonce = await pc.getTransactionCount({ address: who, blockTag: "pending" });
  const sent: Promise<Hash>[] = [];
  const write = (req: Record<string, unknown>, gas: bigint) =>
    agent.writeContract({ ...req, account: agentAccount, chain: agent.chain ?? null, nonce: nonce++, gas } as never);

  if ((usdcBal as bigint) < AGENT_USDC / 2n) {
    const p = write({ address: t.usdc, abi: mockUsdcAbi, functionName: "mint", args: [who, AGENT_USDC] }, MINT_GAS);
    sent.push(p.then((h) => (out.minted = h)));
  }
  if ((usdcAllowance as bigint) === 0n) {
    sent.push(write({ address: t.usdc, abi: mockUsdcAbi, functionName: "approve", args: [t.whistleHook, maxUint256] }, APPROVE_GAS));
  }
  t.cards.forEach((card, i) => {
    if ((cardAllowances[i] as bigint) === 0n) {
      sent.push(write({ address: card, abi: playerCardAbi, functionName: "approve", args: [t.whistleHook, maxUint256] }, APPROVE_GAS));
    }
  });

  const hashes = await Promise.all(sent);
  const receipts = await Promise.all(hashes.map((hash) => pc.waitForTransactionReceipt({ hash, timeout: 120_000 })));
  const failed = receipts.find((r) => r.status !== "success");
  if (failed) throw new Error(`an agent setup transaction reverted: ${failed.transactionHash}`);
  out.approvals = hashes.filter((h) => h !== out.minted);
  return out;
}
