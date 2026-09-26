/**
 * Fund and seed the demo cast: 8 human wallets and 6 agents.
 *
 * Mirrors what `test/integrations/uniswap/FullMatchReplay.t.sol` builds in its
 * `setUp`, so the on-chain demo and the integration test are the same scenario:
 * the same portfolio shapes, the same three-template split, the same spend caps.
 * If the test passes, this is what the demo will look like.
 *
 *   pnpm demo-wallets -- --fixture fixtures/che-bar-2009-05-06.json
 *
 * Flags:
 *   --fixture <path>    fixture JSON                default fixtures/che-bar-...json
 *   --traded <ids>      comma-separated player ids  default 0,5,21
 *   --usdc <amount>     USDC per wallet, whole      default 500000
 *   --dry-run           print the plan, send nothing
 *
 * Wallet and agent keys come from `DEMO_WALLET_KEYS` and `AGENT_PRIVATE_KEYS`.
 * Agents must already exist in `AgentRegistry` — creating them is the operator's
 * job (`createAgent`), because it is the user's mandate being granted, not the
 * demo script's.
 */

import { maxUint256, type Account, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  agentRegistryAbi,
  matchOracleAbi,
  mockUsdcAbi,
  playerCardAbi,
  settlementPotAbi,
} from "../oracle/abi.js";
import { bindFixture, accountFromEnv, connect, walletFor } from "../oracle/chain.js";
import { loadFixture } from "../oracle/fixture.js";
import { USDC, fromUsdc, type Fixture } from "../oracle/types.js";
import { templateById } from "../agent/templates/index.js";
import { confirm } from "../oracle/tx.js";

interface Options {
  fixturePath: string;
  tradedIds: number[];
  usdcPerWallet: bigint;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    fixturePath: get("--fixture") ?? "fixtures/che-bar-2009-05-06.json",
    tradedIds: (get("--traded") ?? "0,5,21").split(",").map((s) => Number(s.trim())),
    usdcPerWallet: BigInt(get("--usdc") ?? 500_000) * USDC,
    dryRun: argv.includes("--dry-run"),
  };
}

function keysFrom(name: string): Account[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`));
}

/**
 * The same portfolio shape the integration test uses: wallet `i` is heavy in card
 * `i % 3` and lighter in the others, so no two demo screens look alike.
 */
function portfolioFor(walletIndex: number, cardIndex: number): bigint {
  const heavy = cardIndex === walletIndex % 3;
  return (heavy ? 400n : 80n) * 10n ** 18n + BigInt(walletIndex) * 10n ** 19n;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const fixture: Fixture = await loadFixture(opts.fixturePath);
  const { chain, rpcUrl, publicClient, deployment } = connect();
  bindFixture(fixture, deployment);

  const wallets = keysFrom("DEMO_WALLET_KEYS");
  const agents = keysFrom("AGENT_PRIVATE_KEYS");
  if (wallets.length === 0) throw new Error("DEMO_WALLET_KEYS is empty. See .env.example.");

  const operator = accountFromEnv("DEPLOYER_PRIVATE_KEY");
  const operatorWallet = walletFor(operator, chain, rpcUrl);

  // Resolve the traded cards.
  const cards: { playerId: number; name: string; card: Address }[] = [];
  for (const id of opts.tradedIds) {
    const player = fixture.players.find((p) => p.id === id);
    if (!player) throw new Error(`fixture has no player ${id}`);
    const card = await publicClient.readContract({
      address: deployment.matchOracle,
      abi: matchOracleAbi,
      functionName: "cardOf",
      args: [fixture.fixtureId, id],
    });
    cards.push({ playerId: id, name: player.name, card });
  }

  console.log(`network      ${chain.name} (${chain.id})`);
  console.log(`operator     ${operator.address}`);
  console.log(`wallets      ${wallets.length}`);
  console.log(`agents       ${agents.length}`);
  console.log(`traded cards ${cards.map((c) => `${c.name} (${c.card})`).join(", ")}`);
  console.log("");

  const settled = await publicClient.readContract({
    address: deployment.settlementPot,
    abi: settlementPotAbi,
    functionName: "settled",
  });
  if (settled) throw new Error("fixture is already settled; nothing to seed");

  if (opts.dryRun) {
    console.log("--dry-run: the plan only.\n");
    wallets.forEach((w, i) => {
      const lines = cards.map((c) => `${c.name} ${portfolioFor(i, cards.indexOf(c)) / 10n ** 18n}`);
      console.log(`  wallet ${i} ${w.address}  ${fromUsdc(opts.usdcPerWallet)} USDC  [${lines.join(", ")}]`);
    });
    for (const a of agents) {
      console.log(`  agent  ${a.address}  ${fromUsdc(opts.usdcPerWallet)} USDC`);
    }
    return;
  }

  const send = async (label: string, hash: `0x${string}`): Promise<void> => {
    const receipt = await confirm(publicClient, hash);
    console.log(`  ${label.padEnd(44)} ${hash}  gas ${receipt.gasUsed}`);
  };

  // ------------------------------------------------------------ human wallets

  for (const [i, wallet] of wallets.entries()) {
    console.log(`wallet ${i}  ${wallet.address}`);

    await send(
      "mint USDC",
      await operatorWallet.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: "mint",
        args: [wallet.address, opts.usdcPerWallet],
        chain,
        account: operator,
      }),
    );

    // The operator holds the float and hands out positions; pre-match minting is
    // the operator's call, not the wallet's.
    for (const [c, { name, card }] of cards.entries()) {
      const units = portfolioFor(i, c);
      await send(
        `mint ${units / 10n ** 18n} ${name}`,
        await operatorWallet.writeContract({
          address: deployment.settlementPot,
          abi: settlementPotAbi,
          functionName: "mintPreMatch",
          args: [card, units, wallet.address],
          chain,
          account: operator,
        }),
      );
    }

    // Approvals are the wallet's own, because the hook pulls from it at fill time.
    const client = walletFor(wallet, chain, rpcUrl);
    await send(
      "approve USDC -> hook",
      await client.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: "approve",
        args: [deployment.whistleHook, maxUint256],
        chain,
        account: wallet,
      }),
    );
    for (const { name, card } of cards) {
      await send(
        `approve ${name} -> hook`,
        await client.writeContract({
          address: card,
          abi: playerCardAbi,
          functionName: "approve",
          args: [deployment.whistleHook, maxUint256],
          chain,
          account: wallet,
        }),
      );
    }
    console.log("");
  }

  // ------------------------------------------------------------------ agents

  for (const agent of agents) {
    const info = await publicClient.readContract({
      address: deployment.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "agentInfo",
      args: [agent.address],
    });
    const [, , resolver, , agentFixtureId, templateId, , fqdn] = info;

    if (resolver === "0x0000000000000000000000000000000000000000") {
      console.warn(`! ${agent.address} is not a registered agent — run createAgent first. Skipping.`);
      continue;
    }
    if (agentFixtureId !== fixture.fixtureId) {
      console.warn(`! ${fqdn} is scoped to fixture ${agentFixtureId}, not ${fixture.fixtureId}. Skipping.`);
      continue;
    }

    console.log(`agent  ${fqdn}  ${agent.address}  template ${templateById(Number(templateId)).name}`);

    await send(
      "mint USDC",
      await operatorWallet.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: "mint",
        args: [agent.address, opts.usdcPerWallet],
        chain,
        account: operator,
      }),
    );

    for (const { name, card } of cards) {
      await send(
        `mint 300 ${name}`,
        await operatorWallet.writeContract({
          address: deployment.settlementPot,
          abi: settlementPotAbi,
          functionName: "mintPreMatch",
          args: [card, 300n * 10n ** 18n, agent.address],
          chain,
          account: operator,
        }),
      );
    }

    const client = walletFor(agent, chain, rpcUrl);
    await send(
      "approve USDC -> hook",
      await client.writeContract({
        address: deployment.usdc,
        abi: mockUsdcAbi,
        functionName: "approve",
        args: [deployment.whistleHook, maxUint256],
        chain,
        account: agent,
      }),
    );
    for (const { name, card } of cards) {
      await send(
        `approve ${name} -> hook`,
        await client.writeContract({
          address: card,
          abi: playerCardAbi,
          functionName: "approve",
          args: [deployment.whistleHook, maxUint256],
          chain,
          account: agent,
        }),
      );
    }
    console.log("");
  }

  console.log("demo cast is funded and approved.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
