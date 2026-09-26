"use client";

/**
 * The New agent form: a managed key from `/api/agents/assign`, then
 * `createAgent` from the connected wallet. Shared by My agents and the
 * pre-match screen, so both run exactly one flow.
 */

import { useEffect, useId, useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { useFixture } from "../lib/fixtures";
import { useOperatorSession } from "../lib/sim/useOperatorSession";
import { agentRegistryAbi, describe } from "../lib/useWhistle";
import { confirm } from "../vendor/oracle/tx";
import { Btn, Card, CardHead, Note, PLAYBOOKS, PLAYBOOK_BLURB, PLAYBOOK_DOT, PLAYBOOK_ID, PLAYBOOK_RULE, type Playbook } from "./agent-ui";
import { TxRef } from "./TxRef";
import { WORLD_ON, WorldVerify } from "./WorldVerify";


/** How long a mandate may live. Anything longer than the match is a smell. */
const DURATIONS = [
  { label: "2 hours", hours: 2 },
  { label: "6 hours", hours: 6 },
  { label: "24 hours", hours: 24 },
] as const;

/**
 * `compact` is the pre-match screen's 320px column: playbooks as three rows,
 * the selected rule below them, cap and max move only (authority runs 6 hours),
 * cap defaulting to 500. The full form is the one on My agents.
 */
export function NewAgentForm({ onCreated, compact = false }: { onCreated: () => void; compact?: boolean }) {
  const { deployment: D, fixtureId } = useFixture();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();

  const [playbook, setPlaybook] = useState<Playbook>(compact ? "momentum" : "protect");
  const radioName = `playbook-${useId()}`;
  /**
   * Always a managed key: the server assigns a derived agent key for this fixture
   * and returns only its address. An external agent address is a direct
   * `createAgent` call — see the README's Agents section — not a field here.
   */
  const defaultCap = compact ? "500" : (D.agentCapUSDC ?? "2000");
  const [cap, setCap] = useState(defaultCap);
  useEffect(() => setCap(defaultCap), [defaultCap]);
  const op = useOperatorSession(fixtureId.toString(), D.agentRegistry);
  const [stage, setStage] = useState<"signing" | "assigning" | "creating" | null>(null);
  const [move, setMove] = useState("10");
  const [hours, setHours] = useState<number>(6);
  /**
   * The label the registry will mint next, and whether this wallet has an
   * account at all. `createAgent` reverts `UnknownUser()` without one, so the
   * button has to say that rather than offer a transaction that cannot work.
   */
  const [next, setNext] = useState<number | null>(null);
  const [hasAccount, setHasAccount] = useState<boolean | null>(null);
  /** Bumped when an agent is created elsewhere (the server, after World ID), so `next` moves on. */
  const [created, setCreated] = useState(0);
  /** The expiry clock is a client-only value; rendering it on the server would
   *  hydrate to a different minute. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ fqdn: string; hash: string; agent: Address } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicClient || !address) {
      setNext(null);
      setHasAccount(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const account = await publicClient.readContract({
          address: D.agentRegistry, abi: agentRegistryAbi, functionName: "userAccounts", args: [address],
        });
        if (cancelled) return;
        setHasAccount(account[3]);
        setNext(account[3] ? Number(account[2]) + 1 : null);
      } catch {
        if (!cancelled) {
          setNext(null);
          setHasAccount(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, address, D, created]);

  /*
   * The displayed end time ticks with the clock; the one sent is computed when
   * Create is pressed. It used to be fixed when the page opened, so a pre-match
   * screen left open for five hours created a mandate with one hour to live.
   */
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const endsAt = useMemo(() => new Date(clockNow + hours * 3_600_000), [clockNow, hours]);

  async function submit() {
    if (!wallet || !publicClient || !address) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // One operator signature per session, then the server picks and funds a key.
      let session = op.session;
      if (!session) {
        setStage("signing");
        session = await op.signIn();
        if (!session) throw new Error(op.error ?? "Sign in as the operator to get a managed agent key.");
      }
      setStage("assigning");
      const res = await fetch("/api/agents/assign", {
        method: "POST",
        headers: { "content-type": "application/json", ...op.headersFor(session) },
        body: JSON.stringify({ fixtureId: fixtureId.toString() }),
      });
      const json = (await res.json()) as { address?: Address; error?: string };
      if (!res.ok || !json.address) {
        if (res.status === 401 || res.status === 403) op.clear();
        throw new Error(json.error ?? `Could not assign an agent key (HTTP ${res.status}).`);
      }
      const agent = json.address;
      setStage("creating");
      // Now, not when the page loaded: see endsAt.
      const expiry = BigInt(Math.floor((Date.now() + hours * 3_600_000) / 1000));
      const salt = BigInt(Math.floor(Math.random() * 1_000_000_000));

      const { request } = await publicClient.simulateContract({
        address: D.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "createAgent",
        args: [
          {
            user: address,
            agent,
            fixtureId,
            templateId: BigInt(PLAYBOOK_ID[playbook]),
            spendCapUSDC: BigInt(cap || "0") * 1_000_000n,
            slippageBps: BigInt(Math.round(Number(move || "0") * 100)),
            expiry,
            salt,
          },
        ],
        account: address,
      });
      const hash = await wallet.writeContract(request);
      await confirm(publicClient, hash);

      const info = await publicClient.readContract({
        address: D.agentRegistry, abi: agentRegistryAbi, functionName: "agentInfo",
        args: [agent],
      });
      setResult({ fqdn: info[7], hash, agent });
      onCreated();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  const ready =
    Boolean(address) && hasAccount !== false && Number(cap) > 0;

  return (
    <Card>
      {compact ? <CardHead title="Add agent" /> : <CardHead title="New agent" hint="A name, a resolver and a spend cap, in one transaction." />}
      <div className={compact ? "space-y-4 p-4" : "space-y-5 p-5"}>
        <fieldset>
          <legend className="mb-2 font-display text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
            Playbook
          </legend>
          <div className={compact ? "flex flex-col gap-2" : "grid gap-2 sm:grid-cols-3"}>
            {PLAYBOOKS.map((p) => {
              const on = playbook === p;
              return (
                <label
                  key={p}
                  className={`cursor-pointer rounded-[14px] border transition-colors focus-within:ring-2 focus-within:ring-up ${
                    compact ? "px-3 py-2" : "p-3"
                  } ${on ? "border-up bg-surface" : "border-line-soft hover:border-line"}`}
                >
                  <input
                    type="radio"
                    name={radioName}
                    className="sr-only"
                    checked={on}
                    onChange={() => setPlaybook(p)}
                  />
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: PLAYBOOK_DOT[p] }}
                      aria-hidden
                    />
                    <span
                      className="font-display text-[13px] font-extrabold capitalize"
                      style={compact ? { color: PLAYBOOK_DOT[p] } : undefined}
                    >
                      {p}
                    </span>
                  </span>
                  {!compact && <span className="mt-1.5 block text-[12px] leading-snug text-dim">{PLAYBOOK_RULE[p]}</span>}
                </label>
              );
            })}
          </div>
          <p className="mt-2 max-w-[68ch] text-[12px] leading-relaxed text-dim">
            {compact ? PLAYBOOK_RULE[playbook] : PLAYBOOK_BLURB[playbook]}
          </p>
        </fieldset>

        <div className={compact ? "grid grid-cols-2 gap-3" : "grid gap-3 sm:grid-cols-3"}>
          <label className="block">
            <span className="mb-1.5 block font-display text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
              {compact ? "Cap" : "Spend cap"}
            </span>
            <div className="flex items-center gap-2">
              <input className={INPUT} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
              <span className="shrink-0 text-[12px] text-dim">USDC</span>
            </div>
          </label>

          <label className="block">
            <span className="mb-1.5 block font-display text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
              {compact ? "Max move" : "Max price move"}
            </span>
            <div className="flex items-center gap-2">
              <input className={INPUT} inputMode="decimal" value={move} onChange={(e) => setMove(e.target.value)} />
              <span className="shrink-0 text-[12px] text-dim">%</span>
            </div>
          </label>

          <label className={compact ? "hidden" : "block"}>
            <span className="mb-1.5 block font-display text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
              Authority ends
            </span>
            <select className={INPUT} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d.hours} value={d.hours}>
                  {d.label}
                </option>
              ))}
            </select>
            <span className="mt-1.5 block text-[12px] text-dim">
              {mounted ? endsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "\u00a0"}
            </span>
          </label>
        </div>

        {compact && (
          <p className="text-[12px] text-dim">
            Authority ends{" "}
            <span className="tnum text-muted">
              {mounted ? endsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "\u00a0"}
            </span>{" "}
            · {hours} hours from when you create it
          </p>
        )}

        {WORLD_ON ? (
          <>
            <WorldVerify
              action="create-agent"
              fixtureId={fixtureId.toString()}
              agentRegistry={D.agentRegistry}
              label={!address ? "Connect a wallet" : hasAccount === false ? "This wallet has no Whistle name" : `Verify with World ID · create agent-${next ?? ""}`}
              disabled={!ready}
              payload={{
                templateId: PLAYBOOK_ID[playbook],
                capUSDC: Number(cap || "0"),
                slippageBps: Math.round(Number(move || "0") * 100),
                hours,
              }}
              onApproved={(d) => {
                setResult({ fqdn: String(d.fqdn ?? ""), hash: String(d.createHash ?? ""), agent: d.agent as Address });
                setCreated((n) => n + 1);
                onCreated();
              }}
            />
          </>
        ) : (
        <Btn tone="cta" className="w-full py-3 text-[13px]" disabled={!ready || busy} onClick={submit}>
          {busy
            ? stage === "signing"
              ? "Sign in with your wallet…"
              : stage === "assigning"
                ? "Preparing the agent key…"
                : "Creating…"
            : !address
              ? "Connect a wallet"
              : hasAccount === false
                ? "This wallet has no Whistle name"
                : `Create agent-${next ?? ""}`}
        </Btn>
        )}

        {hasAccount === false && (
          <Note>
            <code className="text-muted">createAgent</code> mints a subname of your own name, and this
            wallet does not have one yet. <code className="text-muted">registerUser</code> creates it —
            the deploy script does that for the demo accounts.
          </Note>
        )}

        {error && <Note kind="error">{error}</Note>}
        {result && (
          <Note kind="ok">
            Created <strong>{result.fqdn}</strong> with its own resolver
            , on the Whistle-managed key <code className="text-muted">{result.agent}</code>.{" "}
            <TxRef hash={result.hash} />
            {WORLD_ON && <> · human-backed · World ID</>}
          </Note>
        )}
      </div>
    </Card>
  );
}


const INPUT =
  "tnum w-full min-w-0 rounded-[10px] border border-line bg-surface px-3 py-2 text-[14px] text-text " +
  "outline-none transition-colors focus:border-up";

