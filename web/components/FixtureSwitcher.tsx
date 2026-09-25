"use client";

/**
 * Which match you are looking at — and whether it has already been played.
 *
 * With seven demo fixtures, one per presentation, the most expensive mistake on
 * the day is starting a fixture someone already used: `kickoff` is one-way, and a
 * settled fixture cannot be replayed. So every option carries its live state,
 * read from the chain rather than from the deployment file, and a used demo reads
 * as used before anyone presses Start.
 *
 * It reads as a quiet control rather than a headline: the fixture is context,
 * and the loud thing on screen should still be a price that just moved.
 */

import { useReadContracts } from "wagmi";
import type { Address } from "viem";

import { matchOracleAbi } from "../vendor/oracle/abi";

const STATE: Record<number, string> = { 0: "PRE-MATCH", 1: "LIVE", 2: "SETTLED" };

export function FixtureSwitcher({
  all,
  current,
  onSelect,
}: {
  all: { fixtureId: string; label: string; settled: boolean; matchOracle?: Address }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  const withOracle = all.filter((f) => f.matchOracle);
  const { data } = useReadContracts({
    contracts: withOracle.map((f) => ({
      address: f.matchOracle!,
      abi: matchOracleAbi,
      functionName: "fixtures" as const,
      args: [BigInt(f.fixtureId)] as const,
    })),
    allowFailure: true,
    query: { refetchInterval: 15_000 },
  });

  const stateOf = new Map<string, string>();
  withOracle.forEach((f, i) => {
    const r = data?.[i];
    if (r?.status === "success") stateOf.set(f.fixtureId, STATE[Number((r.result as readonly unknown[])[1])] ?? "?");
  });

  if (all.length < 2) return null;
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="sr-only">Fixture</span>
      <select
        value={current}
        onChange={(e) => onSelect(e.target.value)}
        className="min-w-0 max-w-[260px] truncate rounded border border-rule bg-dusk px-2 py-1.5
                   text-[12px] text-slate outline-none transition-colors
                   hover:text-chalk focus-visible:border-signal"
      >
        {all.map((f) => (
          <option key={f.fixtureId} value={f.fixtureId}>
            {f.label}
            {stateOf.has(f.fixtureId) ? ` · ${stateOf.get(f.fixtureId)}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
