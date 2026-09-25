"use client";

/**
 * "Signed in as operator": one wallet signature per session, no shared secret.
 *
 * The page asks the connected wallet to sign `Whistle sim · <fixtureId> · <unix
 * minute>` and keeps the signature in `sessionStorage`; every sim and assign call
 * sends it, and the server recovers the signer and compares it with
 * `AgentRegistry.operator()`. Good for {@link SIM_SESSION_HOURS} hours and for one
 * fixture — switching fixture asks again, which is also the moment to check the
 * switcher reads PRE_MATCH.
 *
 * `isOperator` is only a hint for the UI. The server makes the decision.
 */

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useAccount, useReadContract, useSignMessage } from "wagmi";

import { agentRegistryAbi } from "../../vendor/oracle/abi";
import { SIM_AUTH_HEADER, SIM_SESSION_HOURS, encodeSession, simSessionMessage, type SimSession } from "./session-message";

const storageKey = (fixtureId: string) => `whistle:sim:session:${fixtureId}`;

function stillValid(s: SimSession | null, fixtureId: string, address: Address | undefined): s is SimSession {
  if (!s || !address) return false;
  const age = Math.floor(Date.now() / 60_000) - s.minute;
  return s.fixtureId === fixtureId && s.address.toLowerCase() === address.toLowerCase() && age <= SIM_SESSION_HOURS * 60 - 5;
}

export function useOperatorSession(fixtureId: string, agentRegistry: Address) {
  const { address } = useAccount();
  const operator = useReadContract({ address: agentRegistry, abi: agentRegistryAbi, functionName: "operator" });
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<SimSession | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stored: SimSession | null = null;
    try {
      const raw = sessionStorage.getItem(storageKey(fixtureId));
      stored = raw ? (JSON.parse(raw) as SimSession) : null;
    } catch {
      /* private window: sign in again */
    }
    setSession(stillValid(stored, fixtureId, address) ? stored : null);
  }, [fixtureId, address]);

  const isOperator = Boolean(address && operator.data && address.toLowerCase() === operator.data.toLowerCase());

  const signIn = useCallback(async (): Promise<SimSession | null> => {
    if (!address) {
      setError("Connect the operator wallet first.");
      return null;
    }
    setSigning(true);
    setError(null);
    try {
      const minute = Math.floor(Date.now() / 60_000);
      const signature = await signMessageAsync({ message: simSessionMessage(fixtureId, minute) });
      const next: SimSession = { fixtureId, minute, signature, address };
      setSession(next);
      try {
        sessionStorage.setItem(storageKey(fixtureId), JSON.stringify(next));
      } catch {
        /* still signed in for this page */
      }
      return next;
    } catch (err) {
      setError(/reject|denied/i.test(String(err)) ? "Signature declined." : `Sign-in failed: ${String(err).split("\n")[0]}`);
      return null;
    } finally {
      setSigning(false);
    }
  }, [address, fixtureId, signMessageAsync]);

  /** Forget the signature — after the server refuses it, so the page offers to sign again. */
  const clear = useCallback(() => {
    setSession(null);
    try {
      sessionStorage.removeItem(storageKey(fixtureId));
    } catch {
      /* ignore */
    }
  }, [fixtureId]);

  const headersFor = (s: SimSession | null): Record<string, string> => (s ? { [SIM_AUTH_HEADER]: encodeSession(s) } : {});

  return { address, operator: operator.data as Address | undefined, isOperator, session, signIn, signing, error, clear, headersFor };
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
