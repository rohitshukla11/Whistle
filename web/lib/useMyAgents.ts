"use client";

/**
 * The connected wallet's mandates, across every fixture.
 *
 * `AgentRegistry` is shared by all fixtures, so one enumeration answers both
 * "my agents on this match" (filter by fixture id) and the fixture list's
 * per-row counts. A mandate belongs to the wallet whose `user` it names.
 */

import { useCallback, useEffect, useState } from "react";
import { parseAbi, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { playbookOf, type AgentState, type Playbook } from "../components/agent-ui";
import { agentRegistryAbi } from "../vendor/oracle/abi";

const registryStatusAbi = parseAbi(["function getStatus(uint256 id) view returns (uint8)"]);
const REGISTERED = 2;

export interface MyAgent {
  address: Address;
  fqdn: string;
  /** The agent's own resolver, where `spend-cap` lives. */
  resolver: Address;
  fixtureId: bigint;
  playbook: Playbook;
  spentUSDC: bigint;
  /** 6dp, as written on the agent's resolver. */
  spendCap: bigint;
  state: AgentState;
}

export function useMyAgents(registry: Address, refreshMs = 6_000) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [agents, setAgents] = useState<MyAgent[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!publicClient || !address) {
      setAgents([]);
      setLoaded(true);
      return;
    }
    try {
      const count = Number(await publicClient.readContract({ address: registry, abi: agentRegistryAbi, functionName: "agentCount" }));
      const addrs = (await publicClient.multicall({
        contracts: Array.from({ length: count }, (_, i) => ({
          address: registry, abi: agentRegistryAbi, functionName: "allAgents" as const, args: [BigInt(i)] as const,
        })),
        allowFailure: false,
      })) as Address[];
      const infos = (await publicClient.multicall({
        contracts: addrs.map((a) => ({ address: registry, abi: agentRegistryAbi, functionName: "agentInfo" as const, args: [a] as const })),
        allowFailure: false,
      })) as unknown as readonly [Address, Address, Address, bigint, bigint, bigint, bigint, string][];
      const mine = addrs.map((a, i) => ({ a, info: infos[i]! })).filter(({ info }) => info[0].toLowerCase() === address.toLowerCase());
      const [caps, statuses] = await Promise.all([
        publicClient.multicall({
          contracts: mine.map(({ a }) => ({ address: registry, abi: agentRegistryAbi, functionName: "readText" as const, args: [a, "spend-cap"] as const })),
          allowFailure: true,
        }),
        publicClient.multicall({
          contracts: mine.map(({ info }) => ({ address: info[1], abi: registryStatusAbi, functionName: "getStatus" as const, args: [info[3]] as const })),
          allowFailure: true,
        }),
      ]);
      setAgents(
        mine.map(({ a, info }, i) => {
          const capText = caps[i]?.status === "success" ? String(caps[i]!.result) : "";
          const registered = statuses[i]?.status === "success" ? Number(statuses[i]!.result) === REGISTERED : true;
          const spendCap = /^\d+$/.test(capText) ? BigInt(capText) : 0n;
          return {
            address: a,
            fqdn: info[7],
            resolver: info[2],
            fixtureId: info[4],
            playbook: playbookOf(info[5]),
            spentUSDC: info[6],
            spendCap,
            state: !registered ? "revoked" : spendCap === 0n ? "paused" : "active",
          } satisfies MyAgent;
        }),
      );
    } catch {
      /* keep the last good list; the next poll retries */
    } finally {
      setLoaded(true);
    }
  }, [publicClient, address, registry]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  return { agents, loaded, refresh: load };
}
