"use client";

/**
 * What the connected wallet holds of each card on one fixture. The same
 * multicall the live screen makes, shared so the pre-match screen and the
 * fixture list read holdings the same way.
 */

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { playerCardAbi } from "../vendor/oracle/abi";

export function useHoldings(cards: { id: number; card: Address }[], refreshMs = 6_000) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [held, setHeld] = useState<Map<number, bigint>>(new Map());
  const key = cards.map((c) => c.card).join(",");

  const load = useCallback(async () => {
    if (!publicClient || !address || cards.length === 0) {
      setHeld(new Map());
      return;
    }
    try {
      const out = (await publicClient.multicall({
        contracts: cards.map((c) => ({
          address: c.card, abi: playerCardAbi, functionName: "balanceOf" as const, args: [address] as const,
        })),
        allowFailure: true,
      })) as { status: string; result?: bigint }[];
      const next = new Map<number, bigint>();
      cards.forEach((c, i) => {
        const r = out[i];
        if (r?.status === "success" && typeof r.result === "bigint" && r.result > 0n) next.set(c.id, r.result);
      });
      setHeld(next);
    } catch {
      /* a nicety: the screen reads fine without it */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, address, key]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  return { held, refresh: load };
}
