/**
 * Sweep every derived signer back to the owner — all 28: the service key,
 * fixture A's three agents, the seven demo fixtures' 21, and the three legacy
 * `C-1..3` signers from the first plan.
 *
 *   npx tsx scripts/sweep.ts            # dry run: prints what WOULD move, sends nothing
 *   npx tsx scripts/sweep.ts --send     # sends each balance, less its own gas, to 0x6834…
 *
 * Every service signer is derived from the owner key (see scripts/derive-keys.ts),
 * so their ETH was always the owner's; this returns it once a fixture is done.
 * USDC is MockUSDC here and not worth moving, so only ETH is swept.
 *
 * Refuses to send if the owner key in the environment is not the owner's, and
 * never prints a key — addresses and amounts only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPublicClient, createWalletClient, formatEther, formatGwei, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { OWNER } from "./derive-keys.js";

const RPC = process.env.WHISTLE_RPC_URL ?? process.env.SEPOLIA_RPC_URL_INFURA ?? process.env.SEPOLIA_RPC_URL;
if (!RPC) throw new Error("Set SEPOLIA_RPC_URL (or WHISTLE_RPC_URL).");

/** A plain transfer is 21,000 gas; price it at 2x the current fee for headroom. */
const TRANSFER_GAS = 21_000n;

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const file = resolve(import.meta.dirname ?? ".", "..", ".secrets", "derived.json");
  const derived = JSON.parse(readFileSync(file, "utf8")) as {
    owner: string;
    signers: Record<string, { address: string; key: Hex }>;
    fixtures?: Record<string, { n: number; address: string; key: Hex }[]>;
  };
  // Every signer once: roles first, then each fixture's agents, deduplicated by
  // address (fixture A's agents appear under both).
  const all = new Map<string, { label: string; address: string; key: Hex }>();
  for (const [role, s] of Object.entries(derived.signers)) all.set(s.address.toLowerCase(), { label: role, ...s });
  for (const [id, agents] of Object.entries(derived.fixtures ?? {})) {
    for (const a of agents) {
      if (!all.has(a.address.toLowerCase())) all.set(a.address.toLowerCase(), { label: `${id}:${a.n}`, address: a.address, key: a.key });
    }
  }
  if (derived.owner.toLowerCase() !== OWNER.toLowerCase()) throw new Error("derived.json is for a different owner");

  const pc = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const fee = (await pc.getGasPrice()) * 2n;
  const cost = TRANSFER_GAS * fee;

  let total = 0n;
  console.log(`${send ? "SWEEPING" : "dry run"} -> ${OWNER}   (gas priced at ${formatGwei(fee)} gwei, 2x current)\n`);
  for (const s of all.values()) {
    const role = s.label;
    const account = privateKeyToAccount(s.key);
    if (account.address.toLowerCase() !== s.address.toLowerCase()) throw new Error(`${role}: key/address mismatch`);
    const balance = await pc.getBalance({ address: account.address });
    const amount = balance > cost ? balance - cost : 0n;
    console.log(`  ${role.padEnd(12)} ${account.address}  balance ${formatEther(balance).padStart(22)}  sweep ${formatEther(amount)}`);
    if (amount === 0n) continue;
    total += amount;
    if (!send) continue;
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
    const hash = await wallet.sendTransaction({ to: OWNER as `0x${string}`, value: amount, gas: TRANSFER_GAS, gasPrice: fee });
    const rc = await pc.waitForTransactionReceipt({ hash });
    console.log(`           ${rc.status}  ${hash}`);
  }
  console.log(`\n${all.size} signers; ${send ? "swept" : "would sweep"} ${formatEther(total)} ETH`);
}

void main();
