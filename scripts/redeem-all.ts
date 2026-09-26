/**
 * Redeem every holder's position after settlement, and report what is left.
 *
 *   pnpm tsx scripts/redeem-all.ts
 *
 * The pot only fully drains if *every* unit is redeemed: a holder who sits on
 * their cards leaves their share locked in it. So this walks every card against
 * every known holder — the deployer, the vault, the hook, the six agents and the
 * eight demo wallets — and then reports the residue, which should be dust:
 *
 *   - every redemption rounds its payout down by at most one unit of USDC;
 *   - a few wei of card units stay stranded inside the PoolManager as liquidity
 *     rounding, and nothing can redeem those because the PoolManager cannot call
 *     `redeem`.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account, Address } from "viem";

import { matchOracleAbi, mmVaultAbi, playerCardAbi, settlementPotAbi } from "../oracle/abi.js";
import { bindFixture, accountFromEnv, connect, walletFor } from "../oracle/chain.js";
import { loadFixture } from "../oracle/fixture.js";
import { fromUsdc } from "../oracle/types.js";
import { confirm } from "../oracle/tx.js";

function keysFrom(name: string): Account[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`));
}

async function main(): Promise<void> {
  const fixturePath = process.argv[2] ?? "fixtures/che-bar-2009-05-06.json";
  const fixture = await loadFixture(fixturePath);
  const { chain, rpcUrl, publicClient, deployment } = connect();
  bindFixture(fixture, deployment);

  const settled = await publicClient.readContract({
    address: deployment.settlementPot,
    abi: settlementPotAbi,
    functionName: "settled",
  });
  if (!settled) throw new Error("fixture is not settled yet");

  const snapshot = await publicClient.readContract({
    address: deployment.settlementPot,
    abi: settlementPotAbi,
    functionName: "potSnapshot",
  });

  const operator = accountFromEnv("DEPLOYER_PRIVATE_KEY");
  const holders: Account[] = [operator, ...keysFrom("AGENT_PRIVATE_KEYS"), ...keysFrom("DEMO_WALLET_KEYS")];

  console.log(`settlement snapshot  ${fromUsdc(snapshot)} USDC`);
  console.log(`holders to redeem    ${holders.length} signers + the vault`);
  console.log("");

  // The vault closes out through its own path: burn the LP position, convert
  // inventory claims back to ERC-20, redeem. Only the operator may call it.
  const operatorWallet = walletFor(operator, chain, rpcUrl);
  for (const p of fixture.players) {
    const card = await publicClient.readContract({
      address: deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "cardOf",
      args: [fixture.fixtureId, p.id],
    });
    const state = await publicClient.readContract({
      address: deployment.mmVault,
      abi: mmVaultAbi,
      functionName: "cardState",
      args: [card],
    });
    if (!state.registered || state.closed) continue;

    const hash = await operatorWallet.writeContract({
      address: deployment.mmVault,
      abi: mmVaultAbi,
      functionName: "closeCard",
      args: [card],
      chain,
      account: operator,
    });
    await confirm(publicClient, hash);
    console.log(`vault closeCard ${p.name.padEnd(20)} ${hash}`);
  }

  const reserve = await publicClient.readContract({
    address: deployment.mmVault,
    abi: mmVaultAbi,
    functionName: "availableUSDC",
  });
  if (reserve > 0n) {
    const hash = await operatorWallet.writeContract({
      address: deployment.mmVault,
      abi: mmVaultAbi,
      functionName: "closeReserve",
      chain,
      account: operator,
    });
    await confirm(publicClient, hash);
    console.log(`vault closeReserve ${hash}`);
  }
  console.log("");

  let redemptions = 0;
  let paid = 0n;

  for (const p of fixture.players) {
    const card = await publicClient.readContract({
      address: deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "cardOf",
      args: [fixture.fixtureId, p.id],
    });

    for (const holder of [...holders, { address: deployment.mmVault } as Account]) {
      const balance = await publicClient.readContract({
        address: card,
        abi: playerCardAbi,
        functionName: "balanceOf",
        args: [holder.address],
      });
      if (balance === 0n) continue;
      if (holder.address === deployment.mmVault) continue; // closeCard already did it

      const before = await publicClient.readContract({
        address: deployment.settlementPot,
        abi: settlementPotAbi,
        functionName: "potBalance",
      });

      const wallet = walletFor(holder, chain, rpcUrl);
      const hash = await wallet.writeContract({
        address: deployment.settlementPot,
        abi: settlementPotAbi,
        functionName: "redeem",
        args: [card, balance, holder.address],
        chain,
        account: holder,
      });
      await confirm(publicClient, hash);

      const after = await publicClient.readContract({
        address: deployment.settlementPot,
        abi: settlementPotAbi,
        functionName: "potBalance",
      });
      paid += before - after;
      redemptions += 1;
    }
  }

  const residue = await publicClient.readContract({
    address: deployment.settlementPot,
    abi: settlementPotAbi,
    functionName: "potBalance",
  });

  console.log("");
  console.log(`redemptions          ${redemptions}`);
  console.log(`paid out             ${fromUsdc(paid)} USDC`);
  console.log(`snapshot             ${fromUsdc(snapshot)} USDC`);
  console.log(`residue (dust)       ${residue} wei  (${fromUsdc(residue)} USDC)`);
  console.log(
    `residue as fraction  ${Number((residue * 1_000_000_000n) / snapshot) / 1e9} of the pot`,
  );

  // Anything still outstanding keeps its share locked.
  for (const p of fixture.players) {
    const card = await publicClient.readContract({
      address: deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "cardOf",
      args: [fixture.fixtureId, p.id],
    });
    const left = await publicClient.readContract({
      address: card,
      abi: playerCardAbi,
      functionName: "totalSupply",
    });
    if (left > 10n ** 12n) console.log(`  UNREDEEMED ${p.name}: ${left}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
