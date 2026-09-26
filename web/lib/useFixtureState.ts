"use client";

/**
 * One fixture's on-chain state and clock, polled at the app's usual pace.
 *
 * The fixture route swaps screens on this — PRE_MATCH, LIVE, SETTLED — so it is
 * read from `MatchOracle.fixtures`, never from the deployment file's `settled`
 * flag, which is only a hint written at deploy time.
 */

import { useReadContract } from "wagmi";

import { matchOracleAbi } from "../vendor/oracle/abi";
import type { FixtureDeployment } from "./fixtures";

export const STATE_LABEL = ["PRE-MATCH", "LIVE", "SETTLED"] as const;

/** Four seconds: fast enough that kickoff swaps the screen within a block, and never faster than 3 s. */
const REFRESH_MS = 4_000;

export function useFixtureState(D: Pick<FixtureDeployment, "matchOracle" | "fixtureId"> | undefined) {
  const read = useReadContract({
    address: D?.matchOracle,
    abi: matchOracleAbi,
    functionName: "fixtures",
    args: D ? [BigInt(D.fixtureId)] : undefined,
    query: { enabled: Boolean(D), refetchInterval: REFRESH_MS },
  });
  const t = read.data as readonly unknown[] | undefined;
  return {
    state: t ? Number(t[1]) : undefined,
    clock: t ? Number(t[2]) : undefined,
    orderDelayL: t ? Number(t[4]) : undefined,
    loading: read.isLoading,
    error: read.error,
  };
}
