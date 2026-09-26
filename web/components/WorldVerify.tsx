"use client";

/**
 * "Verify with World ID" for a protected action.
 *
 * The browser never performs the action. It asks the server to start a World ID
 * verification (operator-signed), opens the IdP page, and shows the pending
 * state while the human approves there — the sandbox page's Approval link →
 * "Approve sign-in" or "Deny sign-in". The server redeems the callback and, only
 * on a valid fresh proof, performs the action itself; this component polls the
 * outcome and reports it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";

import { useOperatorSession } from "../lib/sim/useOperatorSession";
import { Btn } from "./agent-ui";

export const WORLD_ON = process.env.NEXT_PUBLIC_WORLD_IDP === "on";

export type Phase = "idle" | "starting" | "pending" | "approved" | "denied" | "failed";

const REASON: Record<string, string> = {
  access_denied: "Denied on the World ID page — nothing was changed.",
  expired: "Not approved within five minutes — nothing was changed.",
  state_mismatch: "That verification was already used — nothing was changed.",
  stale_auth_time: "World ID returned an older sign-in, not a fresh proof — nothing was changed.",
};

export function WorldVerify({
  action,
  payload,
  fixtureId,
  agentRegistry,
  label = "Verify with World ID",
  disabled,
  onApproved,
  onPhase,
  inline = false,
  className = "",
}: {
  action: "create-agent" | "raise-cap";
  payload: Record<string, unknown>;
  fixtureId: string;
  agentRegistry: Address;
  label?: string;
  disabled?: boolean;
  onApproved?: (detail: Record<string, unknown>) => void;
  /** Every phase change, so a parent can keep this mounted while it is in flight. */
  onPhase?: (phase: Phase) => void;
  /** A row button (Resume, Approve) rather than the form's full-width CTA. */
  inline?: boolean;
  className?: string;
}) {
  const op = useOperatorSession(fixtureId, agentRegistry);
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const onApprovedRef = useRef(onApproved);
  onApprovedRef.current = onApproved;
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;
  useEffect(() => onPhaseRef.current?.(phase), [phase]);

  const start = useCallback(async () => {
    setReason(null);
    setPhase("starting");
    let session = op.session;
    if (!session) {
      session = await op.signIn();
      if (!session) {
        setPhase("failed");
        setReason(op.error ?? "Sign in as the operator first.");
        return;
      }
    }
    try {
      const res = await fetch("/api/world/start", {
        method: "POST",
        headers: { "content-type": "application/json", ...op.headersFor(session) },
        body: JSON.stringify({ action, payload: { fixtureId, ...payload } }),
      });
      const json = (await res.json()) as { id?: string; authorizeUrl?: string; expiresAt?: number; error?: string };
      if (!res.ok || !json.id || !json.authorizeUrl) throw new Error(json.error ?? `HTTP ${res.status}`);
      idRef.current = json.id;
      setExpiresAt(json.expiresAt ?? Date.now() + 5 * 60_000);
      setUrl(json.authorizeUrl);
      setPhase("pending");
      window.open(json.authorizeUrl, "_blank", "noopener");
    } catch (err) {
      setPhase("failed");
      setReason(err instanceof Error ? err.message : String(err));
    }
  }, [op, action, payload, fixtureId]);

  useEffect(() => {
    if (phase !== "pending") return;
    const t = setInterval(async () => {
      if (expiresAt) setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
      const id = idRef.current;
      if (!id) return;
      try {
        const r = (await (await fetch(`/api/world/status?id=${encodeURIComponent(id)}`)).json()) as {
          status?: Phase; reason?: string; detail?: Record<string, unknown>;
        };
        if (r.status === "approved") {
          setPhase("approved");
          onApprovedRef.current?.(r.detail ?? {});
        } else if (r.status === "denied" || r.status === "failed") {
          setPhase(r.status);
          setReason(r.reason ?? null);
        }
      } catch {
        /* keep polling; the next tick retries */
      }
    }, 1_000);
    return () => clearInterval(t);
  }, [phase, expiresAt]);

  const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-up focus-visible:ring-offset-2 focus-visible:ring-offset-panel";

  return (
    <div className={`space-y-2 ${inline && phase !== "idle" && phase !== "starting" ? "basis-full" : ""} ${className}`} data-testid={`world-${action}`}>
      {phase !== "pending" && (
        <Btn
          tone={inline ? "ghost" : "cta"}
          className={inline ? "" : "w-full py-3 text-[13px]"}
          disabled={disabled || phase === "starting"}
          onClick={() => void start()}
        >
          {phase === "starting" ? (op.signing ? "Check your wallet…" : "Starting…") : label}
        </Btn>
      )}
      {phase === "pending" && url && (
        <div className="rounded-[10px] border border-line bg-surface p-3 text-[12px] leading-relaxed text-muted" role="status">
          <p className="font-semibold text-text">
            Waiting for World ID{secondsLeft !== null ? ` · ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} left` : "…"}
          </p>
          <p className="mt-1">
            World ID opened in a new tab. Verify there, or give the <strong>Approval link</strong> on that page to the
            person whose World ID this is and have them choose <strong>Approve sign-in</strong>. Unless they approve
            within five minutes, nothing happens. This tab updates by itself.
          </p>
          <a href={url} target="_blank" rel="noreferrer" className={`mt-2 inline-block rounded-[6px] text-up underline underline-offset-2 ${FOCUS}`}>
            Open the World ID page again
          </a>
        </div>
      )}
      {phase === "approved" && <p className="text-[12px] text-up" role="status">Verified with World ID — done.</p>}
      {(phase === "denied" || phase === "failed") && (
        <p className="text-[12px] text-down" role="alert">
          {phase === "denied" ? "Verification denied — nothing was changed." : (REASON[reason ?? ""] ?? `Not done: ${reason ?? "verification failed"} — nothing was changed.`)}
        </p>
      )}
    </div>
  );
}
