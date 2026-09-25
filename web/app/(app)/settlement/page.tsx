"use client";

/**
 * Settlement: what the match paid, who it paid, and what is left.
 *
 * Three numbers on this screen are easy to get wrong in ways that look right:
 *
 *   - The **basis** is not `preMatchPrice`. That is a live view — `0.5 · E_i(now)`
 *     — so after settlement it reads `0.5 · S_i`, and comparing a payout against
 *     it compares a number with itself. The basis here is the volume-weighted
 *     average of what was actually charged, recovered from `Minted`.
 *   - The **payout** is not `payoutPerUnit` once anyone has redeemed. That view
 *     divides by a pot that drains as holders take their money, so a fully
 *     redeemed fixture would report every position down 100%. Realised payouts
 *     come from `Redeemed`.
 *   - The **score** is counted from match events, not stored. If the log scan was
 *     incomplete it shows a dash rather than 0–0.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Abi, Address } from "viem";

import {
  Btn,
  Card,
  CardHead,
  Cell,
  Note,
  PositionTag,
  ResultChip,
} from "../../../components/agent-ui";
import { FixtureSwitcher } from "../../../components/ui";
import { Wallet } from "../../../components/Wallet";
import { useFixture } from "../../../lib/fixtures";
import { POSITION_NAMES, usdc, units as fmtUnits, wad, WAD } from "../../../lib/format";
import { scanLogs } from "../../../lib/logs";
import { loadSnapshot } from "../../../lib/settled";
import { scanOrders, type OrderRow } from "../../../lib/orders";
import { scoreFrom } from "../../../lib/score";
import { shirtNumber, TEAM_NAMES } from "../../../lib/squad";
import {
  agentRegistryAbi,
  describe,
  playerCardAbi,
  settlementPotAbi,
  useWhistle,
  whistleHookAbi,
  type PlayerRow,
} from "../../../lib/useWhistle";
import { confirm } from "../../../vendor/oracle/tx";

type Filter = "all" | "mine" | "winners";

const TEAM_COLOUR: [string, string] = ["#2F6FD0", "#A6214B"];

export default function SettlementPage() {
  const { deployment: D, select, all } = useFixture();
  const { players, header, vault, feed, feedComplete, error, refresh } = useWhistle();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();

  const [balances, setBalances] = useState<Map<number, bigint>>(new Map());
  /** Volume-weighted average price actually paid to mint each card. */
  const [basis, setBasis] = useState<Map<string, bigint>>(new Map());
  /** What holders were actually paid per unit, from `Redeemed`. */
  const [realised, setRealised] = useState<Map<string, bigint>>(new Map());
  const [redemptions, setRedemptions] = useState<{ count: number; holders: number } | null>(null);
  const [protocolFees, setProtocolFees] = useState<bigint | null>(null);
  const [scanned, setScanned] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const settled = header?.settled ?? false;

  // ----------------------------------------------------------- your holdings

  const loadBalances = useCallback(async () => {
    if (!publicClient || !address || players.length === 0) return;
    const results = (await publicClient.multicall({
      contracts: players.map((p) => ({
        address: p.card, abi: playerCardAbi, functionName: "balanceOf" as const, args: [address] as const,
      })),
      allowFailure: true,
    })) as { status: string; result?: bigint }[];
    setBalances(new Map(players.map((p, i) => [p.id, (results[i]?.result as bigint | undefined) ?? 0n])));
  }, [publicClient, address, players]);

  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  // ------------------------------------------------------------- the history

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    setBasis(new Map());
    setRealised(new Map());
    setRedemptions(null);
    setScanned(false);
    setScanError(null);

    void (async () => {
      try {
        // Settled fixtures answer from the build snapshot; see lib/settled.ts.
        await loadSnapshot(D.fixtureId, D.settled);

        const [minted, paid] = await Promise.all([
          scanLogs<{ args?: { card?: Address; units?: bigint; costUSDC?: bigint } }>(
            publicClient, BigInt(D.deployBlock),
            { address: D.settlementPot, abi: settlementPotAbi as Abi, eventName: "Minted" },
          ),
          scanLogs<{ args?: { card?: Address; from?: Address; units?: bigint; payoutUSDC?: bigint } }>(
            publicClient, BigInt(D.deployBlock),
            { address: D.settlementPot, abi: settlementPotAbi as Abi, eventName: "Redeemed" },
          ),
        ]);
        if (cancelled) return;

        const paidOut = new Map<string, bigint>();
        const paidUnits = new Map<string, bigint>();
        const holders = new Set<string>();
        for (const log of paid.logs) {
          const a = log.args ?? {};
          if (!a.card || !a.units || a.units === 0n) continue;
          const k = a.card.toLowerCase();
          paidOut.set(k, (paidOut.get(k) ?? 0n) + (a.payoutUSDC ?? 0n));
          paidUnits.set(k, (paidUnits.get(k) ?? 0n) + a.units);
          if (a.from) holders.add(a.from.toLowerCase());
        }
        const avgPaid = new Map<string, bigint>();
        for (const [k, u] of paidUnits) if (u > 0n) avgPaid.set(k, ((paidOut.get(k) ?? 0n) * WAD) / u);

        const cost = new Map<string, bigint>();
        const qty = new Map<string, bigint>();
        for (const log of minted.logs) {
          const a = log.args ?? {};
          if (!a.card || !a.units || a.units === 0n) continue;
          const k = a.card.toLowerCase();
          cost.set(k, (cost.get(k) ?? 0n) + (a.costUSDC ?? 0n));
          qty.set(k, (qty.get(k) ?? 0n) + a.units);
        }
        const avg = new Map<string, bigint>();
        for (const [k, u] of qty) if (u > 0n) avg.set(k, ((cost.get(k) ?? 0n) * WAD) / u);

        setRealised(avgPaid);
        setBasis(avg);
        setRedemptions({ count: paid.logs.length, holders: holders.size });
        setScanned(true);
      } catch (err) {
        // Never silent. A swallowed throw renders as a permanent "loading", which
        // is indistinguishable from a slow RPC.
        console.error("[settlement] history scan failed:", err);
        if (!cancelled) setScanError(describe(err));
      }
    })();

    return () => {
      cancelled = true;
    };
    // `D` matters: switching fixture changes which pot's history to read.
  }, [publicClient, D]);

  /** Fees the hook is holding for the protocol. */
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    void publicClient
      .readContract({ address: D.whistleHook, abi: whistleHookAbi, functionName: "accruedFeesUSDC" })
      .then((v) => {
        if (!cancelled) setProtocolFees(v as bigint);
      })
      .catch(() => {
        if (!cancelled) setProtocolFees(null);
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, D]);

  // ----------------------------------------------------------------- redeem

  async function redeem(p: PlayerRow) {
    if (!wallet || !publicClient || !address) return;
    const balance = balances.get(p.id) ?? 0n;
    if (balance === 0n) return;
    setBusy(p.id);
    setNotice(null);
    try {
      const { request } = await publicClient.simulateContract({
        address: D.settlementPot,
        abi: settlementPotAbi,
        functionName: "redeem",
        args: [p.card, balance, address],
        account: address,
      });
      const hash = await wallet.writeContract(request);
      await confirm(publicClient, hash);
      setNotice({ kind: "ok", text: `Redeemed ${fmtUnits(balance)} ${p.name} — ${hash.slice(0, 10)}…` });
      await Promise.all([loadBalances(), refresh()]);
    } catch (err) {
      setNotice({ kind: "error", text: describe(err) });
    } finally {
      setBusy(null);
    }
  }

  // ------------------------------------------------------------ the numbers

  const score = useMemo(
    () => scoreFrom(feed, players, feedComplete, header?.clock),
    [feed, players, feedComplete, header?.clock],
  );

  const payoutOf = useCallback(
    (p: PlayerRow) => realised.get(p.card.toLowerCase()) ?? p.payoutPerUnit,
    [realised],
  );
  const basisOf = useCallback((p: PlayerRow) => basis.get(p.card.toLowerCase()) ?? 0n, [basis]);

  /** A card nobody minted and nobody played is noise, not a result. */
  const isBench = useCallback(
    (p: PlayerRow) =>
      p.minutes === 0 && p.supply === 0n && !basis.has(p.card.toLowerCase()) && (balances.get(p.id) ?? 0n) === 0n,
    [basis, balances],
  );

  const listed = useMemo(() => players.filter((p) => !isBench(p)), [players, isBench]);
  const bench = useMemo(() => players.filter(isBench), [players, isBench]);

  const rows = useMemo(() => {
    if (filter === "mine") return listed.filter((p) => (balances.get(p.id) ?? 0n) > 0n);
    if (filter === "winners")
      return listed.filter((p) => {
        const b = basisOf(p);
        return b > 0n && payoutOf(p) > b;
      });
    return listed;
  }, [listed, filter, balances, basisOf, payoutOf]);

  const held = players.filter((p) => (balances.get(p.id) ?? 0n) > 0n);
  const proceeds = held.reduce((sum, p) => sum + (payoutOf(p) * (balances.get(p.id) ?? 0n)) / WAD, 0n);

  const paidOutTotal =
    header === null ? undefined : header.potSnapshot > header.potBalance ? header.potSnapshot - header.potBalance : 0n;

  return (
    <main className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-extrabold tracking-tight">Settlement</h1>
          <p className="mt-0.5 max-w-[68ch] text-[13px] text-dim">
            The pot was fixed at full time and split by final score. Every card redeems at the same rate for
            everyone holding it.
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2 lg:hidden">
          <FixtureSwitcher all={all} current={D.fixtureId} onSelect={select} />
          <Wallet />
        </div>
      </header>

      {error && <Note kind="error">{error}</Note>}
      {notice && <Note kind={notice.kind}>{notice.text}</Note>}

      {/* ----------------------------------------------------- result strip */}
      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
          <Side name={TEAM_NAMES[0]} colour={TEAM_COLOUR[0]} />
          <p className="tnum font-display text-[38px] font-black leading-none">
            {score.known ? `${score.home} – ${score.away}` : "– : –"}
          </p>
          <Side name={TEAM_NAMES[1]} colour={TEAM_COLOUR[1]} reverse />
          <span
            className={`rounded-[7px] px-2.5 py-1 font-display text-[10px] font-extrabold uppercase tracking-[0.12em] ${
              header === null
                ? "border border-line text-dim"
                : settled
                  ? "bg-surface text-muted"
                  : "bg-up text-ground"
            }`}
          >
            {header === null
              ? "Reading…"
              : settled
                ? "Full time · settled"
                : header.state === 1
                  ? `Live · ${header.clock}'`
                  : "Pre-match"}
          </span>
        </div>
        {!score.known && (
          <p className="mt-2 text-center text-[12px] text-warn">
            {header === null
              ? "Reading the fixture…"
              : "Score unavailable — this endpoint would not serve the match history."}
          </p>
        )}
      </Card>

      {/* ------------------------------------------------------------ stats */}
      <Card>
        <dl className="flex flex-wrap divide-line-soft sm:flex-nowrap sm:divide-x">
          <Cell label="Pot paid out" value={usdc(paidOutTotal, 0)} sub="USDC to holders" />
          <Cell label="Left in pot" value={usdc(header?.potBalance, 0)} sub="not yet redeemed" />
          <Cell
            label="Redemptions"
            value={redemptions === null ? "—" : redemptions.count.toString()}
            sub={redemptions === null ? "reading…" : `${redemptions.holders} holders`}
          />
          <Cell
            label="Vault result"
            value={
              vault ? `${vault.pnl >= 0n ? "+" : "−"}${usdc(vault.pnl < 0n ? -vault.pnl : vault.pnl, 0)}` : "—"
            }
            tone={vault ? (vault.pnl >= 0n ? "text-up" : "text-down") : ""}
            sub="market making, net of fees"
          />
          <Cell
            label="Protocol fees"
            value={protocolFees === null ? "—" : usdc(protocolFees, 2)}
            sub="10% of the fill fee"
          />
        </dl>
      </Card>

      <div className="flex flex-col gap-5 lg:flex-row">
        {/* --------------------------------------------------------- payouts */}
        <div className="min-w-0 flex-1 space-y-4">
          <Card>
            <CardHead
              title="Payouts"
              right={
                <span className="flex gap-1 rounded-[9px] border border-line bg-surface p-0.5" role="group">
                  {(["all", "mine", "winners"] as Filter[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFilter(f)}
                      aria-pressed={filter === f}
                      className={`rounded-[7px] px-2.5 py-1 font-display text-[10px] font-extrabold uppercase
                                  tracking-[0.1em] transition-colors ${
                                    filter === f ? "bg-panel text-text" : "text-dim hover:text-text"
                                  }`}
                    >
                      {f}
                    </button>
                  ))}
                </span>
              }
            />

            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-left">
                <thead>
                  <tr className="border-b border-line-soft font-display text-[10px] uppercase tracking-[0.14em] text-dim">
                    <th className="px-5 py-2 font-bold">Player</th>
                    <th className="px-3 py-2 text-right font-bold" title="final score">
                      PTS
                    </th>
                    <th className="px-3 py-2 text-right font-bold">Min</th>
                    <th className="px-3 py-2 text-right font-bold">Paid in</th>
                    <th className="px-3 py-2 text-right font-bold">Pays out</th>
                    <th className="px-3 py-2 text-right font-bold">Move</th>
                    <th className="px-5 py-2 text-right font-bold">Yours</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-8 text-center text-[13px] text-dim">
                        {players.length === 0
                          ? "Reading the fixture…"
                          : filter === "mine"
                            ? address
                              ? "You hold no cards in this fixture."
                              : "Connect a wallet to see your positions."
                            : filter === "winners"
                              ? "No card paid out more than it cost."
                              : "Nothing to show."}
                      </td>
                    </tr>
                  )}
                  {rows.map((p) => {
                    const cost = basisOf(p);
                    const payout = payoutOf(p);
                    const move = cost > 0n ? Number(((payout - cost) * 10_000n) / cost) : null;
                    const yours = balances.get(p.id) ?? 0n;
                    const n = shirtNumber(p.id);
                    return (
                      <tr key={p.id}>
                        <td className="px-5 py-2.5">
                          <span className="flex items-center gap-2">
                            <span className="tnum w-5 shrink-0 text-[12px] text-dim">{n ?? ""}</span>
                            <span className="min-w-0 truncate text-[13px]">{p.name}</span>
                            <PositionTag position={POSITION_NAMES[p.position] ?? "—"} />
                          </span>
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-[13px]">{wad(p.finalScore, 2)}</td>
                        <td className="tnum px-3 py-2.5 text-right text-[13px] text-dim">{p.minutes}&apos;</td>
                        <td className="tnum px-3 py-2.5 text-right text-[13px] text-muted">
                          {cost > 0n ? (
                            usdc(cost, 2)
                          ) : (
                            <span className="text-dim">
                              {scanError ? "unavailable" : scanned ? "never minted" : "…"}
                            </span>
                          )}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right text-[13px] font-semibold">
                          {usdc(payout, 2)}
                        </td>
                        <td
                          className={`tnum px-3 py-2.5 text-right text-[13px] ${
                            move === null ? "text-dim" : move > 0 ? "text-up" : move < 0 ? "text-down" : "text-dim"
                          }`}
                        >
                          {settled && move !== null ? `${move > 0 ? "+" : ""}${(move / 100).toFixed(1)}%` : "—"}
                        </td>
                        <td className="tnum px-5 py-2.5 text-right text-[13px]">
                          {yours > 0n ? fmtUnits(yours) : <span className="text-dim">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {bench.length > 0 && (
              <details className="border-t border-line-soft">
                <summary className="cursor-pointer px-5 py-2.5 font-display text-[11px] font-extrabold uppercase tracking-[0.14em] text-dim hover:text-text">
                  Unused bench · {bench.length}
                </summary>
                <ul className="px-5 pb-4 text-[12px] text-dim">
                  {bench.map((p) => (
                    <li key={p.id} className="flex justify-between gap-4 py-1">
                      <span className="truncate">{p.name}</span>
                      <span className="tnum shrink-0">{wad(p.finalScore, 2)} pts · never minted</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {scanError && (
              <p className="border-t border-line-soft px-5 py-2.5 text-[12px] text-warn">
                Mint history unavailable, so &quot;paid in&quot; and the move column are blank: {scanError}
              </p>
            )}
          </Card>
        </div>

        {/* ---------------------------------------------------------- asides */}
        <div className="space-y-5 lg:w-[380px] lg:shrink-0">
          <Card>
            <CardHead
              title="Redeem"
              right={<span className="tnum text-[11px] text-dim">{held.length} positions</span>}
            />
            <div className="space-y-3 p-5">
              {!address && <Note>Connect a wallet to see and redeem your positions.</Note>}
              {address && held.length === 0 && <Note>You hold no cards in this fixture.</Note>}

              {held.map((p) => {
                const balance = balances.get(p.id) ?? 0n;
                const value = ((settled ? payoutOf(p) : p.referencePrice) * balance) / WAD;
                return (
                  <div key={p.id} className="rounded-[14px] border border-line bg-surface p-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[13px]">{p.name}</span>
                      <span className="tnum shrink-0 text-[13px]">{fmtUnits(balance)}</span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-3 text-[12px] text-dim">
                      <span>{settled ? "Redeems for" : "Worth now"}</span>
                      <span className="tnum text-muted">{usdc(value, 2)} USDC</span>
                    </div>
                    <Btn
                      tone={settled ? "cta" : "ghost"}
                      className="mt-3 w-full"
                      disabled={!settled || busy === p.id}
                      onClick={() => redeem(p)}
                    >
                      {busy === p.id ? "Redeeming…" : settled ? "Redeem" : "After full time"}
                    </Btn>
                  </div>
                );
              })}

              {held.length > 1 && settled && (
                <p className="tnum text-right text-[12px] text-dim">
                  {usdc(proceeds, 2)} USDC in total
                </p>
              )}
            </div>
          </Card>

          <AgentResult
            settled={settled}
            players={players}
            payoutOf={payoutOf}
          />

          <Card>
            <CardHead title="How this was settled" />
            <div className="space-y-2.5 p-5 text-[12px] leading-relaxed text-dim">
              <p>
                At full time the oracle posted each player&apos;s final score and the pot stopped moving. Its
                balance at that moment is the snapshot everything below divides.
              </p>
              <p>
                A card&apos;s payout is its share of that snapshot:{" "}
                <code className="text-muted">payout = pot × Sᵢ / ΣS</code>, where{" "}
                <code className="text-muted">Sᵢ</code> is the player&apos;s final score. Thirty-six cards,
                one denominator, no discretion.
              </p>
              <p>
                Redemption burns your units and pays that rate. It is the same rate whether you redeem first
                or last, so there is nothing to race for.
              </p>
              <p>
                The vault&apos;s result is what is left after it market-made all match: fees earned, less
                whatever its inventory was worth against what it paid.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}

// -------------------------------------------------------------------- pieces

function Side({ name, colour, reverse }: { name: string; colour: string; reverse?: boolean }) {
  const code = name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
  return (
    <span className={`flex items-center gap-2.5 ${reverse ? "flex-row-reverse" : ""}`}>
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] font-display text-[11px] font-extrabold text-white"
        style={{ background: colour }}
        aria-hidden
      >
        {code}
      </span>
      <span className="font-display text-[15px] font-extrabold">{name}</span>
    </span>
  );
}

/**
 * What the agents did to the result, measured against doing nothing.
 *
 * A sold card is compared with what those units would have redeemed for; a bought
 * one with what it cost. That counterfactual is only meaningful once the payout
 * is fixed, and only computable when the order history loaded — so the panel
 * hides itself rather than printing a zero it cannot stand behind.
 */
function AgentResult({
  settled,
  players,
  payoutOf,
}: {
  settled: boolean;
  players: PlayerRow[];
  payoutOf: (p: PlayerRow) => bigint;
}) {
  const { deployment: D } = useFixture();
  const publicClient = usePublicClient();
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!publicClient || !settled) return;
    let cancelled = false;
    void (async () => {
      try {
        const [scan, count] = await Promise.all([
          scanOrders(publicClient, D),
          publicClient.readContract({
            address: D.agentRegistry, abi: agentRegistryAbi, functionName: "agentCount",
          }),
        ]);
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
        const map = new Map<string, string>();
        addresses.forEach((a, i) => map.set(a.toLowerCase(), infos[i]![7].split(".")[0] ?? infos[i]![7]));
        setNames(map);
        setOrders(scan.orders);
      } catch (err) {
        console.warn("[settlement] agent result unavailable:", err);
        if (!cancelled) setOrders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, D, settled]);

  const lines = useMemo(() => {
    if (!orders) return [];
    const byCard = new Map(players.map((p) => [p.card.toLowerCase(), p]));
    const out = new Map<string, { name: string; delta: bigint; fills: number }>();

    for (const o of orders) {
      if (o.result !== "filled" || !o.filledUnits || o.filledUSDC === undefined) continue;
      const who = names.get(o.owner.toLowerCase());
      if (!who) continue;
      const player = byCard.get(o.card.toLowerCase());
      if (!player) continue;

      const atSettlement = (payoutOf(player) * o.filledUnits) / WAD;
      // A sell beat the settlement if it took more than the card ended up paying;
      // a buy beat it if the card ended up paying more than it cost.
      const delta = o.side === 1 ? o.filledUSDC - atSettlement : atSettlement - o.filledUSDC;

      const row = out.get(who) ?? { name: who, delta: 0n, fills: 0 };
      row.delta += delta;
      row.fills += 1;
      out.set(who, row);
    }
    return [...out.values()].sort((a, b) => (b.delta > a.delta ? 1 : -1));
  }, [orders, names, players, payoutOf]);

  if (!settled || lines.length === 0) return null;

  const total = lines.reduce((sum, l) => sum + l.delta, 0n);

  return (
    <Card>
      <CardHead title="What your agents did" hint="Against holding to full time." />
      <ul className="divide-y divide-line-soft">
        {lines.map((l) => (
          <li key={l.name} className="flex items-baseline justify-between gap-3 px-5 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-[13px]">{l.name}</span>
              <span className="block text-[11px] text-dim">
                {l.fills} fill{l.fills === 1 ? "" : "s"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <ResultChip result="filled" />
              <span className={`tnum text-[14px] font-semibold ${l.delta >= 0n ? "text-up" : "text-down"}`}>
                {l.delta >= 0n ? "+" : "−"}
                {usdc(l.delta < 0n ? -l.delta : l.delta, 2)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="flex items-baseline justify-between gap-3 border-t border-line-soft px-5 py-3">
        <span className="font-display text-[11px] font-extrabold uppercase tracking-[0.14em] text-dim">
          Net
        </span>
        <span className={`tnum font-display text-[18px] font-extrabold ${total >= 0n ? "text-up" : "text-down"}`}>
          {total >= 0n ? "+" : "−"}
          {usdc(total < 0n ? -total : total, 2)} USDC
        </span>
      </p>
    </Card>
  );
}
