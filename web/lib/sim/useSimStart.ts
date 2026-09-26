"use client";

/**
 * Start a match from the pre-match screen — the same start the sim panel runs.
 *
 * Operator signature (one per session, shared with the panel through
 * `sessionStorage`), the protected-fixture confirm, and the market check: Start
 * waits until this fixture's hook is the registry's market, and Activate gets it
 * there. On success the clock is written where the panel reads it, so when the
 * route swaps to the live screen the panel picks the running match straight up.
 */

import { useCallback, useEffect, useState } from "react";
import { useReadContract, useWriteContract } from "wagmi";

import type { FixtureDeployment } from "../fixtures";
import { agentRegistryAbi } from "../../vendor/oracle/abi";
import { useOperatorSession } from "./useOperatorSession";

const CLOCK_KEY = "whistle:sim:clock";

export function useSimStart(D: FixtureDeployment) {
  const op = useOperatorSession(D.fixtureId, D.agentRegistry);
  const market = useReadContract({
    address: D.agentRegistry, abi: agentRegistryAbi, functionName: "market", query: { refetchInterval: 8_000 },
  });
  const bound = market.data ? market.data.toLowerCase() === D.whistleHook.toLowerCase() : null;
  const activateTx = useWriteContract();
  const [isProtected, setProtected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"activate" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/sim/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixtureId: D.fixtureId }) })
      .then((r) => r.json())
      .then((j: { protected?: boolean }) => !cancelled && setProtected(Boolean(j.protected)))
      .catch(() => !cancelled && setProtected(null));
    return () => {
      cancelled = true;
    };
  }, [D.fixtureId]);

  const activate = useCallback(async () => {
    setBusy("activate");
    setError(null);
    try {
      await activateTx.writeContractAsync({
        address: D.agentRegistry, abi: agentRegistryAbi, functionName: "setMarket", args: [D.whistleHook],
      });
      for (let i = 0; i < 30; i++) {
        const r = await market.refetch();
        if (r.data && r.data.toLowerCase() === D.whistleHook.toLowerCase()) break;
        await new Promise((res) => setTimeout(res, 3_000));
      }
    } catch (err) {
      setError(`Activate failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [activateTx, market, D.agentRegistry, D.whistleHook]);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    let session = op.session;
    if (!session) {
      session = await op.signIn();
      if (!session) return false;
    }
    if (isProtected) {
      const ok = window.confirm(
        `${D.label} is PROTECTED — kicking off cannot be undone, and a settled fixture cannot be replayed.\n\nStart it anyway?`,
      );
      if (!ok) return false;
    }
    setBusy("start");
    try {
      const res = await fetch("/api/sim/start", {
        method: "POST",
        headers: { "content-type": "application/json", ...op.headersFor(session) },
        body: JSON.stringify({ fixtureId: D.fixtureId, ...(isProtected ? { confirm: 1 } : {}) }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) op.clear();
        setError(json.error ?? `Start failed (HTTP ${res.status}).`);
        return false;
      }
      // Where the sim panel reads its clock: the live screen continues this match.
      try {
        sessionStorage.setItem(CLOCK_KEY, JSON.stringify({ running: true, speed: 3, originMs: Date.now(), originMinute: 0 }));
      } catch {
        /* private window: the panel will read the chain and offer Resume */
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }, [op, isProtected, D.fixtureId, D.label]);

  return { op, bound, isProtected, activate, start, busy, error };
}
