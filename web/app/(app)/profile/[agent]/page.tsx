"use client";

/**
 * One agent, and the proof that the split is real.
 *
 * Every record on `agent-N.<user>.whistle.eth` is resolved through
 * `UniversalResolverV2`, exactly as any ENS client would — nothing here reads
 * Whistle's own storage. Beside each value is who may write it, and that is not a
 * table in this file: it is read back off the resolver. For each key we ask the
 * resolver to derive the argument-scoped resource from a `setText(bytes,string,
 * string)` setter, then ask whether the user, the agent or the platform holds the
 * write role on it.
 *
 * So `status` and `last-action` come back as the AGENT's to write, `spend-cap`
 * and `slippage` as YOURS, and `matches-played` as WHISTLE's — because the chain
 * says so, not because this screen claims it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address } from "viem";

import {
  Btn,
  Card,
  CardHead,
  MiniCard,
  Note,
  PLAYBOOK_BLURB,
  PLAYBOOK_DOT,
  PLAYBOOK_RULE,
  ResultChip,
  SpendBar,
  StateBadge,
  WriterChip,
  playbookOf,
  type AgentState,
  type Playbook,
  type Writer,
} from "../../../../components/agent-ui";
import { Wallet } from "../../../../components/Wallet";
import { UNIVERSAL_RESOLVER } from "../../../../lib/config";
import { EXPLORER_LIVE, addressUrl, txUrl } from "../../../../lib/explorer";
import { FIXTURES, useFixture } from "../../../../lib/fixtures";
import { short, usdc } from "../../../../lib/format";
import { scanAddressLogs } from "../../../../lib/logs";
import { scanOrders, type OrderRow } from "../../../../lib/orders";
import { agentRegistryAbi, describe, useWhistle } from "../../../../lib/useWhistle";
import { confirm } from "../../../../vendor/oracle/tx";

const universalResolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes result, address resolver)",
  "function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)",
]);

const textAbi = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);
const setTextAbi = parseAbi(["function setText(bytes name, string key, string value)"]);

/** The resolver's own view of who may write what. See the file header. */
const resolverRolesAbi = parseAbi([
  "function decodeSetter(bytes setter) pure returns (bytes arg, uint256 resource, uint256 roleBitmap)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function setText(bytes name, string key, string value)",
]);

const platformAbi = parseAbi(["function platform() view returns (address)"]);

/**
 * The fixture's state and clock, read AT the block a record was written.
 *
 * "Block 11758642" is a true answer to "when was this set" and a useless one.
 * The clock at that block is the answer somebody watching the match would give.
 */
const oracleClockAbi = parseAbi([
  "function fixtures(uint256 fixtureId) view returns (address pot, uint8 state, uint16 clock, uint16 playerCount, uint32 orderDelayL, uint32 staleTolerance, uint64 lastEventAt, bool team0Conceded, bool team1Conceded, bool finalized)",
]);
/**
 * `revokeAgent` unregisters the subname; it does not write `status`. So a revoked
 * mandate still resolves its old records, and the registry's own status is the
 * only honest signal — the same one `isAuthorized` checks first.
 */
const registryAbi = parseAbi([
  "function getExpiry(uint256 id) view returns (uint64)",
  "function getStatus(uint256 id) view returns (uint8)",
]);
const REGISTERED = 2;

/**
 * Every key the registry knows about, in the order a reader should meet them.
 *
 * The mandate first, then what the agent says about itself, then the history the
 * platform keeps. No writer is declared here — that comes off the resolver.
 */
const KEYS = [
  { key: "strategy", about: "Which playbook the agent runs." },
  { key: "spend-cap", about: "The most it may ever spend, in USDC. Zero means paused." },
  { key: "slippage", about: "How far the price may move against an order before it is cancelled." },
  { key: "fixture", about: "The one match this mandate is good for." },
  { key: "status", about: "What the agent says it is doing." },
  { key: "last-action", about: "The last order it placed." },
  { key: "pnl-live", about: "Its own running result." },
  { key: "matches-played", about: "How many fixtures it has worked." },
  { key: "pnl-history", about: "Its record across matches." },
  { key: "revoked-at", about: "Set when a mandate is pulled." },
] as const;

/**
 * The AI debrief, and whether the page has one.
 *
 * Loaded on demand rather than imported outright. Webpack emits the chunk either
 * way — a static `import()` is collected long before the flag is folded — but
 * with the flag off nothing ever references it, so the browser never asks for
 * it and no reader pays for a panel they cannot see.
 */
const DEBRIEF_ON = process.env.NEXT_PUBLIC_DEBRIEF === "on";
const Debrief = DEBRIEF_ON
  ? dynamic(() => import("../../../../components/Debrief").then((m) => m.Debrief))
  : null;

/** What Resume falls back to when this page did not see the pause. See /agents. */
const SEEDED_CAP = "2000000000000";

interface Agent {
  address: Address;
  user: Address;
  registry: Address;
  resolver: Address;
  tokenId: bigint;
  fixtureId: bigint;
  playbook: Playbook;
  spentUSDC: bigint;
  fqdn: string;
}

type Values = Map<string, string>;
type Writers = Map<string, Writer>;
interface WriteRef {
  from: Address;
  block: bigint;
  tx: `0x${string}`;
  /** Written by the registry inside `createAgent`, not by a direct call. */
  atCreation?: boolean;
  /** The writer's ENS name, where the registry knows one. */
  who?: string;
  /** When, in the match's own terms: `66'`, `pre-match`, or a date. */
  when?: string;
}

type Written = Map<string, WriteRef>;

// ---------------------------------------------------------------------- page

export default function AgentProfilePage() {
  const params = useParams<{ agent: string }>();
  const query = decodeURIComponent(params?.agent ?? "");

  const { deployment: D, fixtureId } = useFixture();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();
  const { players } = useWhistle();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [values, setValues] = useState<Values>(new Map());
  const [writers, setWriters] = useState<Writers>(new Map());
  const [written, setWritten] = useState<Written>(new Map());
  const [expiry, setExpiry] = useState<number | null>(null);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [ordersFailed, setOrdersFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState<"pause" | "resume" | "revoke" | null>(null);
  /** The cap before a pause, so Resume restores it rather than a guess. */
  const [capBeforePause, setCapBeforePause] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // ------------------------------------------------------------ find the name

  useEffect(() => {
    if (!publicClient || !query) return;
    let cancelled = false;
    void (async () => {
      try {
        const count = await publicClient.readContract({
          address: D.agentRegistry, abi: agentRegistryAbi, functionName: "agentCount",
        });
        const addresses = (await Promise.all(
          Array.from({ length: Number(count) }, (_, i) =>
            publicClient.readContract({
              address: D.agentRegistry, abi: agentRegistryAbi, functionName: "allAgents", args: [BigInt(i)],
            }),
          ),
        )) as Address[];
        const infos = await Promise.all(
          addresses.map((a) =>
            publicClient.readContract({
              address: D.agentRegistry, abi: agentRegistryAbi, functionName: "agentInfo", args: [a],
            }),
          ),
        );
        if (cancelled) return;

        // Accept the full name, the bare label, or the key itself — all three are
        // what somebody would naturally paste into the address bar.
        const wanted = query.toLowerCase();
        const matches = (n: number) => {
          const fqdn = infos[n]![7].toLowerCase();
          return addresses[n]!.toLowerCase() === wanted || fqdn === wanted || fqdn.split(".")[0] === wanted;
        };

        /**
         * A bare label is ambiguous across fixtures.
         *
         * Every match mints its own `agent-1`, so `/profile/agent-1` matches one
         * per fixture the deployment has served. The one the header is pointing
         * at is the one the reader means; falling back to any match keeps a full
         * name working when it names an older fixture.
         */
        const indices = addresses.map((_, n) => n);
        const i =
          indices.find((n) => matches(n) && infos[n]![4] === fixtureId) ??
          indices.find(matches) ??
          -1;
        if (i < 0) return setNotFound(true);

        const info = infos[i]!;
        setAgent({
          address: addresses[i]!,
          user: info[0],
          registry: info[1],
          resolver: info[2],
          tokenId: info[3],
          fixtureId: info[4],
          playbook: playbookOf(info[5]),
          spentUSDC: info[6],
          fqdn: info[7],
        });
      } catch (err) {
        if (!cancelled) setError(describe(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, query, D, fixtureId]);

  const dnsName = useMemo(() => (agent ? dnsEncode(agent.fqdn) : null), [agent]);

  // ------------------------------------------------- who may write each key

  useEffect(() => {
    if (!publicClient || !agent) return;
    let cancelled = false;
    void (async () => {
      try {
        const platform = await publicClient
          .readContract({ address: D.agentRegistry, abi: platformAbi, functionName: "platform" })
          .catch(() => null);

        const setters = KEYS.map(({ key }) =>
          encodeFunctionData({ abi: setTextAbi, functionName: "setText", args: ["0x", key, ""] }),
        );

        const decoded = (await publicClient.multicall({
          contracts: setters.map((setter) => ({
            address: agent.resolver, abi: resolverRolesAbi, functionName: "decodeSetter" as const,
            args: [setter] as const,
          })),
          allowFailure: true,
        })) as { status: string; result?: readonly [`0x${string}`, bigint, bigint] }[];

        const candidates: [Writer, Address | null][] = [
          ["you", agent.user],
          ["agent", agent.address],
          ["whistle", (platform as Address | null) ?? null],
        ];

        const checks: { key: string; writer: Writer; resource: bigint; roles: bigint; who: Address }[] = [];
        KEYS.forEach(({ key }, i) => {
          const d = decoded[i];
          if (d?.status !== "success" || !d.result) return;
          const [, resource, roles] = d.result;
          for (const [writer, who] of candidates) {
            if (who) checks.push({ key, writer, resource, roles, who });
          }
        });

        const held = (await publicClient.multicall({
          contracts: checks.map((c) => ({
            address: agent.resolver, abi: resolverRolesAbi, functionName: "hasRoles" as const,
            args: [c.resource, c.roles, c.who] as const,
          })),
          allowFailure: true,
        })) as { status: string; result?: boolean }[];

        if (cancelled) return;
        const out: Writers = new Map();
        checks.forEach((c, i) => {
          if (held[i]?.status === "success" && held[i]?.result === true && !out.has(c.key)) {
            out.set(c.key, c.writer);
          }
        });
        setWriters(out);
      } catch (err) {
        // A missing chip is honest; a guessed one is not. The whole point of the
        // column is that it came off the chain.
        console.warn("[profile] could not read role grants:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, agent, D]);

  // ------------------------------------------------------- the records, live

  const readRecords = useCallback(async () => {
    if (!publicClient || !agent || !dnsName) return;
    try {
      const results = (await publicClient.multicall({
        contracts: KEYS.map(({ key }) => ({
          address: UNIVERSAL_RESOLVER,
          abi: universalResolverAbi,
          functionName: "resolve" as const,
          args: [
            dnsName,
            encodeFunctionData({
              abi: textAbi,
              functionName: "text",
              args: [`0x${"0".repeat(64)}` as `0x${string}`, key],
            }),
          ] as const,
        })),
        allowFailure: true,
      })) as { status: string; result?: readonly [`0x${string}`, Address] }[];

      const out: Values = new Map();
      KEYS.forEach(({ key }, i) => {
        const r = results[i];
        out.set(key, r?.status === "success" && r.result ? decodeString(r.result[0]) : "");
      });
      setValues(out);

      const [ex, status, auth] = await Promise.all([
        publicClient
          .readContract({ address: agent.registry, abi: registryAbi, functionName: "getExpiry", args: [agent.tokenId] })
          .catch(() => null),
        publicClient
          .readContract({ address: agent.registry, abi: registryAbi, functionName: "getStatus", args: [agent.tokenId] })
          .catch(() => null),
        publicClient
          .readContract({
            address: D.agentRegistry, abi: agentRegistryAbi, functionName: "isAuthorized",
            args: [agent.address, agent.fixtureId, players[0]?.card ?? D.usdc, 1n],
          })
          .catch(() => null),
      ]);
      setExpiry(ex === null ? null : Number(ex));
      setRegistered(status === null ? null : Number(status) === REGISTERED);
      setAuthorized(auth === null ? null : Boolean(auth));
    } catch (err) {
      setError(describe(err));
    }
  }, [publicClient, agent, dnsName, D, players]);

  useEffect(() => {
    void readRecords();
    const t = setInterval(() => void readRecords(), 6_000);
    return () => clearInterval(t);
  }, [readRecords]);

  // --------------------------------------------- who actually wrote each one

  useEffect(() => {
    if (!publicClient || !agent) return;
    let cancelled = false;
    void (async () => {
      const w = await lastWriters(publicClient, agent.resolver, D.agentRegistry, BigInt(D.deployBlock));
      if (cancelled) return;
      setWritten(new Map(w));

      /**
       * Enrich the direct writes only.
       *
       * A creation-time record needs no name or minute: it was written by the
       * registry before the match existed, and saying so is the whole point.
       */
      const userName = await publicClient
        .readContract({
          address: D.agentRegistry, abi: agentRegistryAbi, functionName: "userAccounts", args: [agent.user],
        })
        .then((a) => (a[3] ? `${a[1]}.whistle.eth` : null))
        .catch(() => null);

      const nameFor = (who: Address): string | undefined => {
        if (who.toLowerCase() === agent.address.toLowerCase()) return agent.fqdn;
        if (who.toLowerCase() === agent.user.toLowerCase()) return userName ?? undefined;
        return undefined;
      };

      for (const ref of w.values()) {
        if (ref.atCreation) continue;
        ref.who = nameFor(ref.from);
        ref.when = await whenLabel(publicClient, D.matchOracle, agent.fixtureId, ref.block);
      }
      if (!cancelled) setWritten(new Map(w));
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, agent, D, values.size]);

  // ------------------------------------------------------------- its orders

  useEffect(() => {
    if (!publicClient || !agent) return;
    let cancelled = false;
    const run = async () => {
      try {
        const scan = await scanOrders(publicClient, D);
        if (!cancelled) {
          setOrders(scan.orders.filter((o) => o.owner.toLowerCase() === agent.address.toLowerCase()));
          setOrdersFailed(false);
        }
      } catch (err) {
        // See /agents: an empty timeline and an unreadable one are not the same
        // claim, so do not render the failure as "it did nothing".
        console.error("[profile] order scan failed:", err);
        if (!cancelled) {
          setOrders([]);
          setOrdersFailed(true);
        }
      }
    };
    void run();
    const t = setInterval(() => void run(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [publicClient, agent, D]);

  /**
   * The order list in words rather than ids, for the debrief.
   *
   * Sits above the early returns below because it is a hook: `notFound` and
   * the not-yet-resolved case both return before the render, and a `useMemo`
   * after them changes the hook count between renders.
   *
   * Built here because this is where card addresses can still be turned back
   * into player names; the route gets sentences, not a lookup problem.
   */
  const debriefFills = useMemo(
    () =>
      (orders ?? []).map((o) => {
        const name =
          players.find((p) => p.card.toLowerCase() === o.card.toLowerCase())?.name ?? short(o.card);
        const verb = o.side === 0 ? "buy" : "sell";
        if (o.result === "filled") {
          return `${verb} ${fmtUnits(o.filledUnits ?? o.amount)} ${name} — filled for ${usdc(o.filledUSDC, 2)} USDC at ${usdc(o.price, 2)}`;
        }
        if (o.result === null) return `${verb} ${fmtUnits(o.amount)} ${name} — still queued`;
        return `${verb} ${fmtUnits(o.amount)} ${name} — ${o.result}${o.reason ? ` (${o.reason.toLowerCase().replace(/_/g, " ")})` : ""}`;
      }),
    [orders, players],
  );

  // ------------------------------------------------------------- the actions

  async function setCap(value: string, label: string) {
    if (!wallet || !publicClient || !address || !agent) return;
    if (value === "0") setCapBeforePause(values.get("spend-cap") ?? null);
    setBusy(value === "0" ? "pause" : "resume");
    setNotice(null);
    try {
      const { request } = await publicClient.simulateContract({
        address: agent.resolver,
        abi: resolverRolesAbi,
        functionName: "setText",
        args: [dnsEncode(agent.fqdn), "spend-cap", value],
        account: address,
      });
      const hash = await wallet.writeContract(request);
      await confirm(publicClient, hash);
      setNotice({ kind: "ok", text: `${label} — ${short(hash)}` });
      await readRecords();
    } catch (err) {
      setNotice({ kind: "error", text: describe(err) });
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!wallet || !publicClient || !address || !agent) return;
    setBusy("revoke");
    setNotice(null);
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
      setNotice({ kind: "ok", text: `Revoked — ${short(hash)}` });
      await readRecords();
    } catch (err) {
      setNotice({ kind: "error", text: describe(err) });
    } finally {
      setBusy(null);
    }
  }

  // ------------------------------------------------------------------ render

  if (notFound) {
    return (
      <main className="space-y-4">
        <h1 className="font-display text-[26px] font-extrabold tracking-tight">No such agent</h1>
        <Note>
          Nothing in this deployment&apos;s registry answers to <code className="text-muted">{query}</code>.{" "}
          <Link href="/agents" className="underline underline-offset-2">
            Back to agents
          </Link>
          .
        </Note>
      </main>
    );
  }

  if (!agent) {
    return (
      <main className="space-y-4">
        <h1 className="font-display text-[26px] font-extrabold tracking-tight">Agent</h1>
        {error ? <Note kind="error">{error}</Note> : <Note>Looking the name up…</Note>}
      </main>
    );
  }

  const cap = BigInt(values.get("spend-cap") || "0");
  const status = values.get("status") ?? "";
  const state: AgentState =
    registered === false || status === "revoked" || busy === "revoke"
      ? "revoked"
      : busy === "pause" || (values.get("spend-cap") === "0" && busy !== "resume")
        ? "paused"
        : "active";
  const slippage = values.get("slippage") ?? "";

  return (
    <main className="space-y-5">
      <div className="flex items-center justify-between gap-3 lg:hidden">
        <Link href="/agents" className="text-[13px] text-dim underline underline-offset-2">
          ← Agents
        </Link>
        <Wallet />
      </div>

      {/* ------------------------------------------------------------ header */}
      <Card className="p-5">
        <div className="flex flex-col gap-5 sm:flex-row">
          <MiniCard playbook={agent.playbook} large />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="min-w-0 break-all font-display text-[22px] font-extrabold tracking-tight">
                {agent.fqdn}
              </h1>
              <StateBadge state={state} />
              {authorized !== null && state !== "revoked" && (
                <span className={`text-[12px] ${authorized ? "text-up" : "text-dim"}`}>
                  {authorized ? "authorised right now" : "not authorised"}
                </span>
              )}
              {state === "revoked" && (
                <span className="text-[12px] text-dim">name unregistered · orders revert</span>
              )}
            </div>

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[12px]">
              <Meta label="Owner">
                <Addr address={agent.user} />
              </Meta>
              <Meta label="Key">
                <Addr address={agent.address} />
              </Meta>
              <Meta label="Playbook">
                <span className="inline-flex items-center gap-1.5 capitalize text-muted">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: PLAYBOOK_DOT[agent.playbook] }}
                    aria-hidden
                  />
                  {agent.playbook}
                </span>
              </Meta>
              <Meta label="Authority ends">
                <span className="tnum text-muted">
                  {expiry === null || expiry === 0
                    ? "—"
                    : new Date(expiry * 1000).toLocaleString([], {
                        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                      })}
                </span>
              </Meta>
            </dl>

            <div className="mt-4 max-w-[420px] space-y-1.5">
              <SpendBar spent={agent.spentUSDC} cap={cap} />
              <p className="tnum text-[12px] text-dim">
                {usdc(agent.spentUSDC, 0)} of {usdc(cap, 0)} USDC spent
                {slippage ? ` · max move ${(Number(slippage) / 100).toFixed(1)}%` : ""}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col">
            {state !== "revoked" &&
              (state === "paused" ? (
                <Btn disabled={busy !== null || !address} onClick={() => setCap(capBeforePause ?? SEEDED_CAP, "Resumed")}>
                  {busy === "resume" ? "Resuming…" : "Resume"}
                </Btn>
              ) : (
                <Btn disabled={busy !== null || !address} onClick={() => setCap("0", "Paused")}>
                  {busy === "pause" ? "Pausing…" : "Pause"}
                </Btn>
              ))}
            {state !== "revoked" && (
              <Btn tone="danger" disabled={busy !== null || !address} onClick={revoke}>
                {busy === "revoke" ? "Revoking…" : "Revoke"}
              </Btn>
            )}
            {/* Both controls are greyed out without a wallet; say so rather than
                leaving the reader to guess the mandate is locked. */}
            {!address && state !== "revoked" && (
              <p className="max-w-[180px] text-[12px] leading-relaxed text-dim">
                Connect the wallet that owns this name to pause or revoke it.
              </p>
            )}
          </div>
        </div>

        {notice && (
          <div className="mt-4">
            <Note kind={notice.kind}>{notice.text}</Note>
          </div>
        )}
      </Card>

      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-5">
          {/* --------------------------------------------------- the records */}
          <Card>
            <CardHead
              title="On-chain records"
              hint="Resolved through UniversalResolverV2. The writer column is read off the resolver's role grants."
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="border-b border-line-soft font-display text-[10px] uppercase tracking-[0.16em] text-dim">
                    <th className="px-5 py-2 font-bold">Key</th>
                    <th className="px-3 py-2 font-bold">Value</th>
                    <th className="px-3 py-2 font-bold">Writable by</th>
                    <th className="px-5 py-2 text-right font-bold">Last written</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {KEYS.map(({ key, about }) => {
                    const value = values.get(key) ?? "";
                    const w = writers.get(key);
                    const last = written.get(key);
                    return (
                      <tr key={key} className="align-top">
                        <td className="px-5 py-3">
                          <code className="text-[13px] font-semibold">{key}</code>
                          <p className="mt-0.5 max-w-[24ch] text-[11px] leading-snug text-dim">{about}</p>
                        </td>
                        <td className="tnum break-all px-3 py-3 text-[13px]">
                          {value === "" ? <span className="text-dim">unset</span> : value}
                          {gloss(key, value) && (
                            <span className="mt-0.5 block text-[11px] text-dim">{gloss(key, value)}</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {w ? <WriterChip writer={w} /> : <span className="text-[12px] text-dim">—</span>}
                        </td>
                        <td className="px-5 py-3 text-right text-[12px] text-dim">
                          {last ? (
                            <>
                              {last.atCreation ? (
                                <span
                                  className="block cursor-help"
                                  title="Set by the registry when the mandate was created. Only you can change it now."
                                >
                                  at creation · by Whistle
                                </span>
                              ) : (
                                <>
                                  <Addr address={last.from} label={last.who} />
                                  {last.when && <span className="mt-0.5 block">{last.when}</span>}
                                </>
                              )}
                              <span className="tnum mt-0.5 block">
                                {EXPLORER_LIVE ? (
                                  <a
                                    href={txUrl(last.tx)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline underline-offset-2 hover:text-text"
                                  >
                                    block {last.block.toString()}
                                  </a>
                                ) : (
                                  `block ${last.block.toString()}`
                                )}
                              </span>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="border-t border-line-soft px-5 py-3 text-[12px] leading-relaxed text-dim">
              &quot;Writable by&quot; is not a claim this page makes. For each key it derives the
              argument-scoped resource from a <code className="text-muted">setText</code> setter and asks the
              resolver whether you, the agent or Whistle holds the write role on it. A dash means the
              resolver would not answer.
            </p>
          </Card>

          {/* -------------------------------------------------- the timeline */}
          <Card>
            <CardHead
              title="This match"
              right={<span className="tnum text-[11px] text-dim">{orders?.length ?? 0} orders</span>}
            />
            {orders === null && <p className="px-5 py-8 text-center text-[13px] text-dim">Reading the queue…</p>}
            {orders?.length === 0 && (
              <p className="px-5 py-8 text-center text-[13px] text-dim">
                {ordersFailed ? (
                  <>
                    Order history unavailable — this endpoint would not serve the logs.
                    <span className="mt-1 block">
                      Point NEXT_PUBLIC_LOGS_RPC_URL at an archive endpoint and reload.
                    </span>
                  </>
                ) : (
                  "This agent has not queued an order yet."
                )}
              </p>
            )}
            {orders && orders.length > 0 && (
              <ol className="divide-y divide-line-soft">
                {[...orders].reverse().map((o) => (
                  <li key={o.orderId.toString()} className="flex items-center gap-3 px-5 py-3">
                    <span className="tnum w-12 shrink-0 text-[12px] text-dim">#{o.orderId.toString()}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">
                        {o.side === 0 ? "Bought" : "Sold"} {fmtUnits(o.filledUnits ?? o.amount)}{" "}
                        {players.find((p) => p.card.toLowerCase() === o.card.toLowerCase())?.name ??
                          short(o.card)}
                      </span>
                      <span className="block truncate text-[12px] text-dim">
                        {o.result === "filled"
                          ? `${usdc(o.filledUSDC, 2)} USDC at ${usdc(o.price, 2)} · block ${o.resultBlock?.toString()}`
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
              </ol>
            )}
          </Card>

          {Debrief && (
            <Debrief
              agent={agent.fqdn}
              fixtureId={agent.fixtureId.toString()}
              playbook={agent.playbook}
              rule={PLAYBOOK_RULE[agent.playbook]}
              records={Object.fromEntries(values)}
              fills={debriefFills}
              ready={orders !== null && values.size > 0}
            />
          )}
        </div>

        {/* ------------------------------------------------------- the asides */}
        <div className="space-y-5 lg:w-[380px] lg:shrink-0">
          <Card>
            <CardHead title="What it may do" />
            <ul className="divide-y divide-line-soft text-[13px]">
              <Rule ok>Queue orders on this fixture ({agent.fixtureId.toString()}) and no other</Rule>
              <Rule ok>Spend up to {usdc(cap, 0)} USDC, counted by the registry</Rule>
              <Rule ok>
                Write its own <code>status</code>, <code>last-action</code> and <code>pnl-live</code>
              </Rule>
              <Rule>Hold, move or withdraw your USDC — it never touches the money</Rule>
              <Rule>
                Raise its own cap: <code>spend-cap</code> is yours to write
              </Rule>
              <Rule>Transfer or sell the name — the mandate is non-transferable by design</Rule>
              <Rule>Outlive its expiry, or survive a revoke</Rule>
            </ul>
          </Card>

          <Card>
            <CardHead title="How this works" />
            <div className="divide-y divide-line-soft">
              <Explainer title="Its own name">
                The agent is <code className="text-muted">{agent.fqdn}</code> — a subname of your account,
                minted when you granted the mandate. Anyone can resolve it; nobody has to trust Whistle to
                read it.
              </Explainer>
              <Explainer title="Its own resolver">
                Each agent gets a fresh resolver instance rather than a shared one, so a role granted on a
                key here cannot reach any other agent&apos;s records.
              </Explainer>
              <Explainer title="Roles, not promises">
                Whistle grants the write roles when the name is minted and drops its own in the same
                transaction. After that it cannot write <code className="text-muted">spend-cap</code> either.
              </Explainer>
            </div>
          </Card>

          <Card>
            <CardHead title="The playbook" />
            <div className="space-y-2 p-5">
              <p className="font-display text-[14px] font-extrabold capitalize">{agent.playbook}</p>
              <p className="text-[12px] text-muted">{PLAYBOOK_RULE[agent.playbook]}</p>
              <p className="text-[12px] leading-relaxed text-dim">{PLAYBOOK_BLURB[agent.playbook]}</p>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}

// -------------------------------------------------------------------- pieces

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-display text-[10px] font-bold uppercase tracking-[0.16em] text-dim">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Addr({ address, label }: { address: Address; label?: string }) {
  const text = label ?? short(address);
  if (!EXPLORER_LIVE) {
    return (
      <code className="tnum text-[12px] text-muted" title={address}>
        {text}
      </code>
    );
  }
  return (
    <a
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer"
      title={address}
      className="tnum text-[12px] text-muted underline underline-offset-2 hover:text-text"
    >
      {text}
    </a>
  );
}

/**
 * When a record was written, in the match's own terms.
 *
 * Reads the oracle AT that block, so a write during the game reports the minute
 * the clock was showing. Before kick-off there is no minute to report, and after
 * full time the minute has stopped meaning anything, so both fall back to plain
 * time.
 */
async function whenLabel(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  oracle: Address,
  fixtureId: bigint,
  block: bigint,
): Promise<string> {
  const stamp = async () => {
    try {
      const b = await publicClient.getBlock({ blockNumber: block });
      return new Date(Number(b.timestamp) * 1000).toLocaleString([], {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return `block ${block.toString()}`;
    }
  };

  try {
    const f = await publicClient.readContract({
      address: oracle, abi: oracleClockAbi, functionName: "fixtures", args: [fixtureId], blockNumber: block,
    });
    const state = Number(f[1]);
    if (state === 0) return "pre-match";
    if (state === 1) return `${Number(f[2])}'`;
    return `full time · ${await stamp()}`;
  } catch {
    // An endpoint without archive state for that block. The wall-clock time is
    // still true, and a wrong minute would not be.
    return stamp();
  }
}

function Rule({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 px-5 py-2.5">
      <span className={`shrink-0 font-bold ${ok ? "text-up" : "text-down"}`} aria-hidden>
        {ok ? "✓" : "✕"}
      </span>
      <span className={ok ? "text-muted" : "text-dim"}>{children}</span>
    </li>
  );
}

function Explainer({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-3.5">
      <h3 className="font-display text-[12px] font-extrabold uppercase tracking-[0.12em]">{title}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-dim">{children}</p>
    </div>
  );
}

// ------------------------------------------------------------------ helpers

/**
 * What a raw record means, in words.
 *
 * The value column stays exactly what the resolver returned — this is the screen
 * that argues records are readable by anyone, so paraphrasing them would undercut
 * it. The reading goes underneath, dimmed, for the keys where the raw form is a
 * number nobody can parse at a glance.
 */
function gloss(key: string, value: string): string | null {
  if (value === "") return null;
  if (key === "strategy") {
    const n = Number(value);
    return Number.isFinite(n) ? playbookOf(n) : null;
  }
  if (key === "spend-cap") {
    try {
      const v = BigInt(value);
      return v === 0n ? "paused — no order can be authorised" : `${usdc(v, 0)} USDC`;
    } catch {
      return null;
    }
  }
  if (key === "slippage") {
    const n = Number(value);
    return Number.isFinite(n) ? `${(n / 100).toFixed(1)}% of the reference price` : null;
  }
  if (key === "fixture") {
    return FIXTURES.find((f) => f.fixtureId === value)?.label ?? null;
  }
  if (key === "revoked-at") {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toLocaleString() : null;
  }
  return null;
}

function fmtUnits(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const whole = v / 10n ** 18n;
  const frac = ((v % 10n ** 18n) * 100n) / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

/**
 * Walk the resolver's logs, pull each transaction, and decode any `setText` call.
 * The last one per key wins, and `tx.from` is the sender of record rather than
 * something a contract chose to report about itself.
 *
 * The scan starts at the fixture's deploy block rather than a rolling window back
 * from the head. A window is the wrong shape for this: the records that matter
 * most were written when the mandate was granted, which is the oldest thing in
 * the resolver's history, and a window long enough to reach it is a window most
 * endpoints refuse.
 */
async function lastWriters(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  resolver: Address,
  registry: Address,
  fromBlock: bigint,
): Promise<Written> {
  const out: Written = new Map();
  try {
    const scan = await scanAddressLogs(fromBlock, resolver);
    const hashes = [...new Set(scan.logs.map((l) => l.transactionHash).filter(Boolean))] as `0x${string}`[];

    for (const hash of hashes) {
      const tx = await publicClient.getTransaction({ hash });
      const to = tx.to?.toLowerCase();
      const block = tx.blockNumber ?? 0n;

      // A direct write: somebody holding the role on that key called the
      // resolver themselves. This is what pause, resume and the agent's own
      // reporting look like.
      if (to === resolver.toLowerCase()) {
        try {
          const decoded = decodeFunctionData({ abi: setTextAbi, data: tx.input });
          if (decoded.functionName === "setText") {
            out.set(decoded.args[1] as string, { from: tx.from, block, tx: hash });
          }
        } catch {
          /* some other call on the resolver */
        }
        continue;
      }

      /**
       * A write through `createAgent`.
       *
       * The mandate's opening records are set inside that call, so the resolver
       * emitted the logs but the transaction went to the registry — filtering on
       * `tx.to === resolver` used to drop every one of them and leave this column
       * empty on a freshly granted mandate.
       *
       * The keys are not guessed: the calldata says `createAgent`, and
       * `_writeInitialRecords` writes exactly these five. Anything the agent or
       * the user has written since is a direct call and overwrites the entry
       * above, because the scan runs oldest to newest.
       */
      if (to === registry.toLowerCase()) {
        try {
          const decoded = decodeFunctionData({ abi: agentRegistryAbi, data: tx.input });
          if (decoded.functionName !== "createAgent") continue;
          for (const key of ["fixture", "strategy", "spend-cap", "slippage", "status"]) {
            out.set(key, { from: tx.from, block, tx: hash, atCreation: true });
          }
        } catch {
          /* not a call this screen can read */
        }
      }
    }
  } catch {
    /* best effort; the values and the role grants are the authoritative part */
  }
  return out;
}

function decodeString(hex: `0x${string}`): string {
  if (hex === "0x") return "";
  try {
    const body = hex.slice(2);
    const length = parseInt(body.slice(64, 128), 16);
    const bytes = body.slice(128, 128 + length * 2);
    return new TextDecoder().decode(
      Uint8Array.from(bytes.match(/../g)?.map((b) => parseInt(b, 16)) ?? []),
    );
  } catch {
    return "";
  }
}

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
