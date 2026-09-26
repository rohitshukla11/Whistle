"use client";

/**
 * An agent's cap, from its card — World ID on.
 *
 * The rule: increasing an agent's authority needs a fresh World ID proof;
 * decreasing it never does. So Raise cap (and Resume, which is a raise from 0)
 * goes through `WorldVerify` and the server writes `spend-cap` only after the
 * proof checks out, while Lower cap and Pause are ordinary transactions from the
 * connected wallet, one click each. Revoke stays where it is on each card.
 */

import { useEffect, useState } from "react";
import { parseAbi, toHex, type Address } from "viem";
import { usePublicClient, useWalletClient, useAccount } from "wagmi";

import { describe } from "../lib/useWhistle";
import { confirm } from "../vendor/oracle/tx";
import { Btn } from "./agent-ui";
import { TxRef } from "./TxRef";
import { WorldVerify, type Phase } from "./WorldVerify";

const setTextAbi = parseAbi(["function setText(bytes name, string key, string value)"]);

const dnsEncode = (name: string): `0x${string}` =>
  toHex(new Uint8Array(name.split(".").flatMap((l) => [l.length, ...new TextEncoder().encode(l)]).concat([0])));

export const STOP_NOTE = "Stopping or limiting an agent never needs verification.";

export function CapControls({
  agent,
  fixtureId,
  agentRegistry,
  onChanged,
  compact = false,
}: {
  agent: { address: Address; fqdn: string; resolver: Address; spendCap: bigint; state: "active" | "paused" | "revoked" };
  fixtureId: string;
  agentRegistry: Address;
  onChanged: () => void;
  compact?: boolean;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();
  const currentUSDC = Number(agent.spendCap) / 1e6;
  const [value, setValue] = useState(String(currentUSDC || ""));
  useEffect(() => setValue(String(currentUSDC || "")), [currentUSDC]);
  const [busy, setBusy] = useState<"lower" | "pause" | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string; hash?: string } | null>(null);
  /**
   * The verification in flight, frozen. The server writes the cap before it
   * records the result, so the next poll can show the new cap (or an agent no
   * longer paused) first — which would unmount the button that is waiting to
   * hear the outcome. While locked, that one stays put.
   */
  const [locked, setLocked] = useState<{ payload: Record<string, unknown>; label: string; resume: boolean } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  if (agent.state === "revoked") return null;
  const n = Number(value);
  const valid = Number.isFinite(n) && n > 0;
  const raising = valid && n > currentUSDC;
  const lowering = valid && n < currentUSDC;
  const paused = agent.state === "paused" && !(locked && !locked.resume);
  // One verification control, in one place, whatever the row shows around it.
  const verify = locked
    ?? (agent.state === "paused"
      ? { payload: { agent: agent.address }, label: "Resume · verify with World ID", resume: true }
      : raising
        ? { payload: { agent: agent.address, capUSDC: n }, label: `Raise cap to ${n.toLocaleString("en-US")} · verify with World ID`, resume: false }
        : null);
  const showInput = agent.state !== "paused" && !locked;

  async function write(cap: string, what: "lower" | "pause") {
    if (!wallet || !publicClient || !address) return;
    setBusy(what);
    setNote(null);
    try {
      const { request } = await publicClient.simulateContract({
        address: agent.resolver, abi: setTextAbi, functionName: "setText",
        args: [dnsEncode(agent.fqdn), "spend-cap", cap], account: address,
      });
      const hash = await wallet.writeContract(request);
      await confirm(publicClient, hash);
      setNote({ kind: "ok", text: what === "pause" ? "Paused." : `Cap lowered to ${Number(cap) / 1e6} USDC.`, hash });
      onChanged();
    } catch (err) {
      setNote({ kind: "error", text: describe(err) });
    } finally {
      setBusy(null);
    }
  }

  const LABEL = "mb-1 block font-display text-[10px] font-bold uppercase tracking-[0.16em] text-muted";
  const INPUT = "tnum w-full min-w-0 rounded-[8px] border border-line bg-surface px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-up";

  return (
    <div className="space-y-2" data-testid="cap-controls" data-agent={agent.fqdn}>
      <div className={`flex flex-wrap items-end gap-2 ${compact ? "" : "max-w-[560px]"}`}>
        {showInput && (
          <label key="cap" className="block w-[120px]">
            <span className={LABEL}>Cap · USDC</span>
            <input className={INPUT} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`New spend cap for ${agent.fqdn}`} />
          </label>
        )}
        {verify ? (
          <WorldVerify
            key="verify"
            inline
            className={paused ? "" : "min-w-[200px] flex-1"}
            action="raise-cap"
            fixtureId={fixtureId}
            agentRegistry={agentRegistry}
            payload={verify.payload}
            label={verify.label}
            disabled={!address}
            onPhase={(p) => {
              setPhase(p);
              if (p === "starting") setLocked(verify);
            }}
            onApproved={(d) => {
              setNote({
                kind: "ok",
                text: d.resumed
                  ? `Resumed at ${Number(d.capTo ?? 0) / 1e6} USDC after a World ID check.`
                  : `Cap raised ${Number(d.capFrom ?? 0) / 1e6} → ${Number(d.capTo ?? 0) / 1e6} USDC after a World ID check.`,
                ...(d.hash ? { hash: String(d.hash) } : {}),
              });
              setLocked(null);
              onChanged();
            }}
          />
        ) : (
          <Btn key="lower" disabled={!lowering || busy !== null || !address} onClick={() => void write(BigInt(Math.round(n * 1e6)).toString(), "lower")}>
            {busy === "lower" ? "Lowering…" : "Lower cap"}
          </Btn>
        )}
        {!paused && (
          <Btn key="pause" disabled={busy !== null || !address} onClick={() => void write("0", "pause")}>
            {busy === "pause" ? "Pausing…" : "Pause"}
          </Btn>
        )}
      </div>
      {locked && !locked.resume && phase !== "starting" && phase !== "pending" && (
        <button type="button" className="text-[12px] text-muted underline underline-offset-2" onClick={() => setLocked(null)}>
          Change the amount
        </button>
      )}
      <p className="text-[11px] text-dim">
        Raising the cap or resuming needs a fresh World ID proof. {STOP_NOTE}
      </p>
      {note && (
        <p className={`text-[12px] ${note.kind === "ok" ? "text-up" : "text-down"}`} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text} {note.hash && <TxRef hash={note.hash} />}
        </p>
      )}
    </div>
  );
}
