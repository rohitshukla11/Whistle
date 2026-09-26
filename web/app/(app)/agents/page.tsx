"use client";

/**
 * Agents: grant a mandate, watch it work, pause it, pull it.
 *
 * "Pause" and "Revoke" are deliberately different things, and both are ENS
 * operations rather than flags in Whistle's own contracts:
 *
 *   Pause  — write `spend-cap = 0` on the agent's own resolver. `isAuthorized`
 *            reads the cap live, so the agent stops being able to trade on the
 *            next block, and raising the cap brings it straight back.
 *   Revoke — `revokeAgent` revokes the agent's roles and unregisters its name.
 *            Its queued orders cancel REVOKED on the next tick and its next
 *            `queueOrder` reverts. Permanent.
 *
 * The user holds the write role on `spend-cap`; the agent does not. That is the
 * split the whole design rests on, so pause is not a courtesy — it is the user
 * exercising a right the agent has no way to take back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { parseAbi, type Address } from "viem";

import {
  Btn,
  Card,
  CardHead,
  MiniCard,
  Note,
  PLAYBOOKS,
  PLAYBOOK_BLURB,
  PLAYBOOK_DOT,
  PLAYBOOK_ID,
  PLAYBOOK_RULE,
  ResultChip,
  SpendBar,
  StateBadge,
  playbookOf,
  type AgentState,
  type Playbook,
} from "../../../components/agent-ui";
import { Wallet } from "../../../components/Wallet";
import { ALL_FIXTURES, useFixture } from "../../../lib/fixtures";
import { short, usdc } from "../../../lib/format";
import { scanOrders, type OrderRow } from "../../../lib/orders";
import { EXPLORER_LIVE, txUrl } from "../../../lib/explorer";
import { agentRegistryAbi, describe, useWhistle, whistleHookAbi } from "../../../lib/useWhistle";
import { confirm } from "../../../vendor/oracle/tx";
import { NewAgentForm } from "../../../components/NewAgentForm";
import { TxRef } from "../../../components/TxRef";
import { CapControls, STOP_NOTE } from "../../../components/CapControls";
import { WORLD_ON } from "../../../components/WorldVerify";
import { shortAddress, useOperatorSession } from "../../../lib/sim/useOperatorSession";

const permissionedResolverAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
]);

/**
 * The one question that separates paused from revoked.
 *
 * `revokeAgent` unregisters the subname; it does not write `status`. So a revoked
 * mandate still resolves its old records — including `status: active` — and the
 * only honest signal is the registry's own: the name is no longer REGISTERED.
 * `isAuthorized` checks exactly this first, so the badge and the contract agree.
 */
const registryStatusAbi = parseAbi(["function getStatus(uint256 id) view returns (uint8)"]);
const REGISTERED = 2;

/**
 * The cap `Resume` falls back to.
 *
 * Pausing overwrites the cap with zero, so the old value only survives if this
 * page remembers it — and a reload between the two clicks loses that. The
 * fallback is what `deploy-sepolia.ts` seeds every demo mandate with, so a resume
 * after a reload restores the mandate rather than inventing a smaller one.
 */
const SEEDED_CAP = "2000000000000";

/** The fixture's seeded cap in 6dp, when its deployment file records one. */
const seededCapOf = (D: { agentCapUSDC?: string }) =>
  D.agentCapUSDC ? (BigInt(D.agentCapUSDC) * 1_000_000n).toString() : SEEDED_CAP;

interface AgentView {
  address: Address;
  /** The match this mandate is scoped to. */
  fixtureId: bigint;
  fqdn: string;
  resolver: Address;
  registry: Address;
  tokenId: bigint;
  playbook: Playbook;
  spentUSDC: bigint;
  spendCap: string;
  slippage: string;
  status: string;
  lastAction: string;
  registered: boolean;
  authorized: boolean;
}

function stateOf(a: AgentView, pending: "pause" | "resume" | "revoke" | null): AgentState {
  if (!a.registered || a.status === "revoked" || pending === "revoke") return "revoked";
  if (pending === "resume") return "active";
  if (a.spendCap === "0" || pending === "pause") return "paused";
  return "active";
}

// ---------------------------------------------------------------------- page

export default function AgentsPage() {
  const { deployment: D, fixtureId, select, all } = useFixture();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();
  const { players } = useWhistle();

  const [agents, setAgents] = useState<AgentView[]>([]);
  const [loaded, setLoaded] = useState(false);
  /**
   * Which agent is mid-transaction, and what for.
   *
   * Pause takes about 25 seconds on Sepolia and Revoke about 45 — long enough
   * that a button which merely greys out reads as a dead click. Naming the
   * pending action lets the badge move ahead of inclusion and settle when the
   * next read confirms it.
   */
  const [busy, setBusy] = useState<{ address: string; action: "pause" | "resume" | "revoke" } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string; hash?: string } | null>(null);
  const [revertProof, setRevertProof] = useState<{ agent: string; reason: string } | null>(null);
  /** What each agent's cap was before it was paused, so Resume puts it back. */
  const capBeforePause = useRef<Map<string, string>>(new Map());
  /** The last complete read of each agent, to fall back on during a transition. */
  const lastGood = useRef<Map<string, AgentView>>(new Map());

  const load = useCallback(async () => {
    if (!publicClient) return;
    try {
      /**
       * A read that tolerates a record disappearing mid-revoke.
       *
       * `revokeAgent` unregisters the name, so a read landing between the
       * registry update and the resolver update gets empty return data and viem
       * raises "Cannot decode zero data". It is a transition, not a failure, so
       * it must not become a banner saying the page is broken.
       */
      const soft = async <R,>(what: string, read: () => Promise<R>, fallback: R): Promise<R> => {
        try {
          return await read();
        } catch (err) {
          if (/zero data|returned no data/i.test(String(err))) {
            console.warn(`[agents] ${what} returned no data (mid-transition), keeping last value`);
            return fallback;
          }
          throw err;
        }
      };

      const count = await publicClient.readContract({
        address: D.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "agentCount",
      });

      /**
       * Every agent is read in parallel.
       *
       * Sequentially this is five round trips per agent, and the registry
       * accumulates agents across every fixture the deployment has served. At
       * twelve agents that was fifteen seconds of an empty panel, which reads as
       * "you have none" rather than "still loading".
       */
      const indices = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
      const addresses = (await Promise.all(
        indices.map((i) =>
          publicClient.readContract({
            address: D.agentRegistry, abi: agentRegistryAbi, functionName: "allAgents", args: [i],
          }),
        ),
      )) as Address[];

      const infos = await Promise.all(
        addresses.map((agent) =>
          publicClient.readContract({
            address: D.agentRegistry, abi: agentRegistryAbi, functionName: "agentInfo", args: [agent],
          }),
        ),
      );

      // My agents: this wallet's mandates on every fixture, each labelled with
      // its match. With no wallet connected, the current fixture's, as before.
      const mine = addresses
        .map((agent, i) => ({ agent, info: infos[i]! }))
        .filter(({ info }) => (address ? info[0].toLowerCase() === address.toLowerCase() : info[4] === fixtureId));

      const out: AgentView[] = await Promise.all(
        mine.map(async ({ agent, info }) => {
          const [, registry, resolver, tokenId, , templateId, spentUSDC, fqdn] = info;
          const prior = lastGood.current.get(agent);
          const keys = ["spend-cap", "slippage", "status", "last-action"] as const;
          const priorValues = [prior?.spendCap ?? "", prior?.slippage ?? "", prior?.status ?? "", prior?.lastAction ?? ""];
          const [spendCap, slippage, status, lastAction, authorized, registryStatus] = await Promise.all([
            ...keys.map((key, i) =>
              soft(
                `${agent} ${key}`,
                () =>
                  publicClient.readContract({
                    address: D.agentRegistry, abi: agentRegistryAbi, functionName: "readText", args: [agent, key],
                  }),
                priorValues[i] as string,
              ),
            ),
            soft(
              `${agent} isAuthorized`,
              () =>
                publicClient.readContract({
                  address: D.agentRegistry, abi: agentRegistryAbi, functionName: "isAuthorized",
                  args: [agent, info[4], players[0]?.card ?? D.usdc, 1n],
                }),
              prior?.authorized ?? false,
            ),
            soft(
              `${agent} getStatus`,
              () =>
                publicClient.readContract({
                  address: registry, abi: registryStatusAbi, functionName: "getStatus", args: [tokenId],
                }),
              prior?.registered === false ? 0 : REGISTERED,
            ),
          ]);

          const view: AgentView = {
            address: agent,
            fixtureId: info[4],
            fqdn,
            resolver,
            registry,
            tokenId,
            playbook: playbookOf(templateId),
            spentUSDC,
            spendCap: spendCap as string,
            slippage: slippage as string,
            status: status as string,
            lastAction: lastAction as string,
            registered: Number(registryStatus) === REGISTERED,
            authorized: Boolean(authorized),
          };
          lastGood.current.set(agent, view);
          return view;
        }),
      );

      setAgents(out);
      setNotice((n) => (n?.kind === "error" ? null : n));
    } catch (err) {
      setNotice({ kind: "error", text: describe(err) });
    } finally {
      setLoaded(true);
    }
  }, [publicClient, players, D, fixtureId, address]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 6_000);
    return () => clearInterval(t);
  }, [load]);

  // ------------------------------------------------------------ pause/resume

  async function setCap(agent: AgentView, value: string, label: string) {
    if (!wallet || !publicClient || !address) return;
    if (value === "0" && agent.spendCap !== "0") capBeforePause.current.set(agent.address, agent.spendCap);
    setBusy({ address: agent.address, action: value === "0" ? "pause" : "resume" });
    setNotice(null);
    try {
      const { request } = await publicClient.simulateContract({
        address: agent.resolver,
        abi: permissionedResolverAbi,
        functionName: "setText",
        args: [dnsEncode(agent.fqdn), "spend-cap", value],
        account: address,
      });
      const hash = await wallet.writeContract(request);
      await confirm(publicClient, hash);
      setNotice({ kind: "ok", text: `${label} ${agent.fqdn}`, hash });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: describe(err) });
    } finally {
      setBusy(null);
    }
  }

  // ------------------------------------------------------------------ revoke

  async function revoke(agent: AgentView) {
    if (!wallet || !publicClient || !address) return;
    setBusy({ address: agent.address, action: "revoke" });
    setNotice(null);
    setRevertProof(null);
    try {
      const { request } = await publicClient.simulateContract({
        address: D.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "revokeAgent",
        args: [agent.address],
        account: address,
      });
      const hash = await wallet.writeContract(request);
      await confirm(publicClient, hash);
      setNotice({ kind: "ok", text: `revoked ${agent.fqdn}`, hash });

      // Prove it. Simulate the order the agent would place next and surface the
      // revert verbatim — the mandate is gone, and this is what that looks like
      // from the agent's side. No log can show this: a reverted `queueOrder`
      // emits nothing.
      const own = ALL_FIXTURES.find((f) => f.fixtureId === String(agent.fixtureId));
      const reason = await probeRevert(publicClient, agent.address, players[0]?.card, own?.whistleHook ?? D.whistleHook, agent.fixtureId);
      setRevertProof({ agent: agent.fqdn, reason });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: describe(err) });
    } finally {
      setBusy(null);
    }
  }

  const live = agents.filter((a) => stateOf(a, null) !== "revoked").length;

  return (
    <main className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-extrabold tracking-tight">Agents</h1>
          <p className="mt-0.5 max-w-[68ch] text-[13px] text-dim">
            Each mandate is an ENS name with its own resolver. You keep the keys to what it may spend;
            it keeps the keys to what it reports.
          </p>
        </div>
      </header>

      {notice && (
        <Note kind={notice.kind}>
          {notice.text}
          {notice.hash && (
            <>
              {" "}
              <TxRef hash={notice.hash} />
            </>
          )}
        </Note>
      )}

      {revertProof && (
        <Card className="border-down/40">
          <CardHead title="Mandate revoked" right={<ResultChip result="reverted" />} />
          <div className="space-y-2 p-5">
            <p className="text-[13px] text-muted">
              {revertProof.agent}&apos;s next <code className="text-text">queueOrder</code> now reverts:
            </p>
            <code className="block rounded-[10px] border border-down/40 px-3 py-2 text-[13px] font-semibold text-down">
              {revertProof.reason}
            </code>
            <p className="text-[12px] text-dim">
              Nothing was cached and nothing was asked to stop — the ENS read simply stopped returning true.
            </p>
          </div>
        </Card>
      )}

      <div className="flex flex-col gap-5 lg:flex-row">
        {/* ------------------------------------------------------- mandates */}
        <div className="space-y-4 lg:w-[620px] lg:shrink-0">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-[12px] font-extrabold uppercase tracking-[0.18em]">
              Your mandates
            </h2>
            <span className="tnum text-[12px] text-dim">
              {live} live · {agents.length} {address ? "across fixtures" : "this fixture"}
            </span>
          </div>

          {!loaded && <Card className="px-5 py-8 text-center text-[13px] text-dim">Reading the registry…</Card>}
          {loaded && agents.length === 0 && (
            <Card className="px-5 py-8 text-center text-[13px] text-dim">
              No agents yet. Grant one on the right, or from a fixture before kick-off.
            </Card>
          )}

          {agents.map((a) => {
            const pending = busy?.address === a.address ? busy.action : null;
            const state = stateOf(a, pending);
            const cap = BigInt(a.spendCap || "0");
            return (
              <Card key={a.address} className="p-4">
                <div className="flex gap-4">
                  <MiniCard playbook={a.playbook} />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={`/profile/${encodeURIComponent(a.fqdn)}`}
                          className="block truncate font-display text-[15px] font-extrabold hover:underline"
                        >
                          {a.fqdn}
                        </Link>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-dim">
                          <Link href={`/fixtures/${a.fixtureId}`} className="text-muted hover:text-text hover:underline">
                            {ALL_FIXTURES.find((f) => f.fixtureId === String(a.fixtureId))?.label ?? `Fixture ${a.fixtureId}`}
                          </Link>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1.5 capitalize">
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ background: PLAYBOOK_DOT[a.playbook] }}
                              aria-hidden
                            />
                            {a.playbook}
                          </span>
                          <span aria-hidden>·</span>
                          <span className="tnum">{short(a.address)}</span>
                        </p>
                      </div>
                      <StateBadge state={state} />
                    </div>

                    <p className="mt-2 text-[12px] text-muted">{PLAYBOOK_RULE[a.playbook]}</p>

                    <div className="mt-3 space-y-1.5">
                      <SpendBar spent={a.spentUSDC} cap={state === "paused" ? 0n : cap} />
                      <div className="flex items-baseline justify-between gap-3 text-[11px]">
                        <span className="font-display font-bold uppercase tracking-[0.14em] text-dim">
                          Spent
                        </span>
                        <span className="tnum text-muted">
                          {usdc(a.spentUSDC, 0)} of {state === "paused" ? "0" : usdc(cap, 0)} USDC
                          {a.slippage ? ` · max move ${(Number(a.slippage) / 100).toFixed(1)}%` : ""}
                        </span>
                      </div>
                    </div>

                    {/*
                      Attributed, because this line is the agent's own testimony.
                      `last-action` is a record the AGENT holds the write role for,
                      and it keeps that role after revocation — so a revoked agent
                      can and does file "refused: mandate revoked". That is useful
                      and it is not the chain's verdict, so it is not dressed as one.
                    */}
                    {a.lastAction && (
                      <p className="mt-2 text-[12px] text-dim">
                        <span className="truncate">
                          Last action <span className="text-muted">{a.lastAction}</span>
                        </span>
                        <span className="mt-0.5 block text-[11px] text-dim/80">self-reported by the agent</span>
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {state === "revoked" ? (
                    <p className="flex-1 text-[12px] text-dim">
                      The name is unregistered. Its orders revert and nothing can bring it back.
                    </p>
                  ) : WORLD_ON ? null : state === "paused" ? (
                    <Btn
                      disabled={pending !== null || !address}
                      onClick={() => setCap(a, capBeforePause.current.get(a.address) ?? seededCapOf(D), "resumed")}
                    >
                      {pending === "resume" ? "Resuming…" : "Resume"}
                    </Btn>
                  ) : (
                    <Btn disabled={pending !== null || !address} onClick={() => setCap(a, "0", "paused")}>
                      {pending === "pause" ? "Pausing…" : "Pause"}
                    </Btn>
                  )}

                  <Link
                    href={`/profile/${encodeURIComponent(a.fqdn)}`}
                    className="rounded-[10px] border border-line px-4 py-2 font-display text-[12px] font-extrabold
                               uppercase tracking-[0.1em] text-text transition-colors hover:border-muted"
                  >
                    View
                  </Link>

                  {state !== "revoked" && (
                    <Btn
                      tone="danger"
                      className="ml-auto"
                      disabled={pending !== null || !address}
                      onClick={() => revoke(a)}
                    >
                      {pending === "revoke" ? "Revoking…" : "Revoke"}
                    </Btn>
                  )}
                </div>

                {WORLD_ON && state !== "revoked" && (
                  <div className="mt-3 border-t border-line-soft pt-3">
                    <CapControls
                      agent={{ address: a.address, fqdn: a.fqdn, resolver: a.resolver, spendCap: /^\d+$/.test(a.spendCap) ? BigInt(a.spendCap) : 0n, state }}
                      fixtureId={String(a.fixtureId)}
                      agentRegistry={ALL_FIXTURES.find((f) => f.fixtureId === String(a.fixtureId))?.agentRegistry ?? D.agentRegistry}
                      onChanged={() => void load()}
                    />
                  </div>
                )}
              </Card>
            );
          })}

          <p className="max-w-[62ch] px-1 text-[12px] leading-relaxed text-dim">
            Pause writes <code className="text-muted">spend-cap = 0</code> on the agent&apos;s own resolver,
            and it is reversible. Revoke unregisters the name, so authorisation fails at its first check and
            any queued order cancels on the next tick. Neither asks the agent for anything — it holds no key
            that can write either record.
            {WORLD_ON && (
              <>
                {" "}
                <strong className="text-muted">{STOP_NOTE}</strong> Raising a cap or resuming does: a fresh
                World ID proof from the human bound to the agent.
              </>
            )}
          </p>
        </div>

        {/* ------------------------------------------------- create + ledger */}
        <div className="min-w-0 flex-1 space-y-5">
          <NewAgentForm onCreated={load} />
          <WhatTheyDid agents={agents} />
        </div>
      </div>
    </main>
  );
}

// -------------------------------------------------------------- what they did

function WhatTheyDid({ agents }: { agents: AgentView[] }) {
  const { deployment: D } = useFixture();
  const publicClient = usePublicClient();
  const { players } = useWhistle();

  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [incomplete, setIncomplete] = useState(false);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    const run = async () => {
      try {
        const scan = await scanOrders(publicClient, D);
        if (cancelled) return;
        setOrders(scan.orders);
        setIncomplete(scan.failed > 0);  // a retry that worked clears the mark
      } catch (err) {
        // An empty list and a failed scan look identical on screen, and one of
        // them is a lie. Mark it, so the panel says which it is.
        console.error("[agents] order history scan failed:", err);
        if (!cancelled) {
          setOrders([]);
          setIncomplete(true);
        }
      }
    };
    void run();
    // Slower than the state poll: three log scans is the expensive read on the
    // page, and an order's life is measured in ticks, not seconds.
    const t = setInterval(() => void run(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [publicClient, D]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.address.toLowerCase(), a.fqdn.split(".")[0] ?? a.fqdn);
    return m;
  }, [agents]);

  const cards = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of players) m.set(p.card.toLowerCase(), p.name);
    return m;
  }, [players]);

  const rows = useMemo(
    () => (orders ?? []).filter((o) => names.has(o.owner.toLowerCase())).reverse(),
    [orders, names],
  );

  return (
    <Card testId="what-they-did">
      <CardHead
        title="What they did"
        right={<span className="tnum text-[11px] text-dim">{rows.length} orders</span>}
      />

      {orders === null && <p className="px-5 py-8 text-center text-[13px] text-dim">Reading the queue…</p>}
      {orders !== null && rows.length === 0 && (
        <p className="px-5 py-8 text-center text-[13px] text-dim">
          {incomplete ? (
            <>
              Order history unavailable — this endpoint would not serve the logs.
              <span className="mt-1 block text-dim">
                Point NEXT_PUBLIC_LOGS_RPC_URL at an archive endpoint and reload.
              </span>
            </>
          ) : (
            "No agent has queued an order for this fixture yet."
          )}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-line-soft">
          {rows.map((o) => (
            <li key={o.orderId.toString()} className="flex items-center gap-3 px-5 py-2.5">
              <span className="tnum w-12 shrink-0 text-[12px] text-dim">#{o.orderId.toString()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">
                  <span className="font-semibold">{names.get(o.owner.toLowerCase())}</span>{" "}
                  <span className="text-muted">
                    {o.side === 0 ? "bought" : "sold"} {fmt(o.filledUnits ?? o.amount)}{" "}
                    {cards.get(o.card.toLowerCase()) ?? short(o.card)}
                  </span>
                </span>
                <span className="block truncate text-[12px] text-dim">
                  {o.result === "filled"
                    ? `${usdc(o.filledUSDC, 2)} USDC at ${usdc(o.price, 2)}`
                    : o.result === null
                      ? "waiting for the next tick"
                      : `${o.reason?.toLowerCase().replace(/_/g, " ")} · block ${o.resultBlock?.toString()}`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <ResultChip result={o.result ?? "re-queued"} />
                {EXPLORER_LIVE && (
                  <a
                    href={txUrl(o.resultTx ?? o.tx)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-dim underline underline-offset-2 hover:text-text"
                  >
                    tx
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {incomplete && rows.length > 0 && (
        <p className="border-t border-line-soft px-5 py-2.5 text-[12px] text-warn">
          Some log windows failed — this list may be missing orders.
        </p>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------- helpers

function fmt(units: bigint | undefined): string {
  if (units === undefined) return "—";
  const whole = units / 10n ** 18n;
  const frac = ((units % 10n ** 18n) * 100n) / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

async function probeRevert(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  agent: Address,
  card: Address | undefined,
  hook: Address,
  fixtureId: bigint,
): Promise<string> {
  if (!card) return "Unauthorized";
  try {
    await publicClient.simulateContract({
      address: hook,
      abi: whistleHookAbi,
      functionName: "queueOrder",
      args: [fixtureId, card, 0, 10n ** 18n, 1000, false],
      account: agent,
    });
    return "no revert — the mandate still holds";
  } catch (err) {
    const message = describe(err);
    const named = /reverted with the following reason:\s*(\w+)/.exec(message)?.[1];
    if (named) return `${named}()`;
    const custom = /Error:\s*(\w+)\(\)/.exec(message)?.[1];
    return custom ? `${custom}()` : message;
  }
}

/** DNS wire format, mirroring `WhistleNames.dnsEncode`. */
function dnsEncode(name: string): `0x${string}` {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    if (label.length === 0) continue;
    const encoded = new TextEncoder().encode(label);
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
