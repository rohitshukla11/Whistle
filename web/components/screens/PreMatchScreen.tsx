"use client";

/**
 * A fixture before kick-off: mint, hand an agent a playbook, press Start — one page.
 *
 * Left: the market table, exactly as on the live screen, with every row a
 * pre-match MINT at the fixed price; picking one opens the same order bar,
 * anchored to the bottom of the pane. Right (#16161A, scrolls on its own): the
 * match panel with Start, this wallet's cards on this fixture, and its agents on
 * this fixture beside the inline Add agent form.
 *
 * Everything is read from chain state at the app's usual cadence. When kickoff
 * lands, `/fixtures/<id>` swaps this screen for the live one; the selected player
 * (`lib/selection`), the operator signature and the sim clock (`sessionStorage`)
 * all survive the swap because none of them live here.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { Btn, MiniCard, PLAYBOOK_DOT, PLAYBOOK_RULE, Note } from "../agent-ui";
import { CapControls } from "../CapControls";
import { WORLD_ON } from "../WorldVerify";
import { NewAgentForm } from "../NewAgentForm";
import { QueueOrder } from "../QueueOrder";
import { SquadTable } from "../SquadTable";
import { TxRef } from "../TxRef";
import { useFixture } from "../../lib/fixtures";
import { POSITION_NAMES, usdc, usdcShort, WAD } from "../../lib/format";
import { useHoldings } from "../../lib/useHoldings";
import { useMyAgents, type MyAgent } from "../../lib/useMyAgents";
import { useSelectedPlayer } from "../../lib/selection";
import { useSimStart } from "../../lib/sim/useSimStart";
import { shirtNumber, TEAM_NAMES } from "../../lib/squad";
import { agentRegistryAbi, describe, useWhistle, type PlayerRow } from "../../lib/useWhistle";
import { confirm } from "../../vendor/oracle/tx";

const TEAM_COLOUR: [string, string] = ["#2F6FD0", "#A6214B"];
/** The live screen's club tints, as gradients for a compact portrait. */
const TEAM_TINT: [string, string] = [
  "linear-gradient(160deg, #6F7BF7 0%, #3FA9F5 100%)",
  "linear-gradient(160deg, #F7936F 0%, #E8508A 100%)",
];
const SIM_ON = process.env.NEXT_PUBLIC_SIM === "on";
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-up focus-visible:ring-offset-2 focus-visible:ring-offset-panel";

function Stat({ label, value, tone = "text-text", first, small }: { label: string; value: string; tone?: string; first?: boolean; small?: boolean }) {
  return (
    <div className={`min-w-0 px-4 py-3 ${first ? "" : "border-l border-line"}`}>
      <dt className="font-display text-[10px] font-bold tracking-[0.16em] text-muted">{label}</dt>
      <dd className={`tnum mt-1 font-display font-extrabold ${small ? "text-[15px] leading-tight" : "truncate text-[20px] leading-none"} ${tone}`}>{value}</dd>
    </div>
  );
}

function SectionHead({ title, count, right }: { title: string; count?: number; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="font-display text-[11px] font-extrabold tracking-[0.16em] text-text">
        {title}
        {count !== undefined && <span className="text-dim"> · {count}</span>}
      </h2>
      {right}
    </div>
  );
}

// ------------------------------------------------------------- match panel

function MatchPanel({ pot, orderDelay, youHold }: { pot: string; orderDelay: string; youHold: string }) {
  const { deployment: D } = useFixture();
  const { address } = useAccount();
  const sim = useSimStart(D);
  const { op, bound } = sim;
  const operatorKnown = Boolean(op.operator);
  const isOperator = op.isOperator;

  return (
    <section aria-label="Match" className="rounded-[14px] border border-line bg-surface">
      <div className="flex flex-col gap-4 p-4 2xl:flex-row 2xl:items-center">
        <dl className="grid min-w-0 flex-1 grid-cols-2 sm:grid-cols-4">
          <Stat first label="KICK-OFF" value="When you start" small />
          <Stat label="POT" value={pot} tone="text-blue" />
          <Stat label="ORDER DELAY" value={orderDelay} />
          <Stat label="YOU HOLD" value={youHold} tone="text-up" />
        </dl>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center 2xl:w-[260px] 2xl:flex-col 2xl:items-stretch">
          {!SIM_ON ? (
            <p className="text-[12px] leading-relaxed text-dim">Kick-off comes from the terminal replay on this server.</p>
          ) : address && operatorKnown && !isOperator ? (
            <p className="text-[12px] leading-relaxed text-dim">Only the operator can start this match.</p>
          ) : (
            <>
              {bound === false && isOperator ? (
                <Btn tone="ghost" className={`w-full py-3 ${FOCUS}`} disabled={sim.busy !== null} onClick={() => void sim.activate()}>
                  {sim.busy === "activate" ? "Activating…" : "Activate this fixture"}
                </Btn>
              ) : null}
              <Btn
                tone="cta"
                className={`w-full py-3 text-[13px] ${FOCUS}`}
                disabled={!address || !isOperator || bound !== true || sim.busy !== null || op.signing}
                onClick={() => void sim.start()}
              >
                {sim.busy === "start" ? "Starting…" : op.signing ? "Check your wallet…" : "Start match"}
              </Btn>
              {!address ? (
                <p className="text-[12px] text-dim">Connect the operator wallet to start this match.</p>
              ) : op.session ? (
                <p className="text-[12px] text-dim">
                  <span className="text-up">Signed in as operator</span> · replays 6 May 2009 on Sepolia
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => void op.signIn()}
                  disabled={op.signing}
                  className={`self-start rounded-[8px] text-[12px] text-muted underline underline-offset-2 hover:text-text ${FOCUS}`}
                >
                  {op.signing ? "Check your wallet…" : "Sign in as operator"}
                </button>
              )}
              {bound === false && isOperator && (
                <p className="text-[12px] text-warn">Agents are bound to another fixture — Activate before Start.</p>
              )}
            </>
          )}
          {(sim.error || op.error) && <p className="text-[12px] text-down" role="alert">{sim.error ?? op.error}</p>}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- my cards

function HoldingCard({ p, units, onMintMore }: { p: PlayerRow; units: bigint; onMintMore: () => void }) {
  const n = shirtNumber(p.id);
  const value = (p.referencePrice * units) / WAD;
  return (
    <article className="flex w-[150px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-line-soft bg-panel">
      <div className="relative h-[92px]" style={{ background: TEAM_TINT[p.team] }}>
        <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2">
          <span>
            <span className="tnum block font-display text-[20px] font-extrabold leading-none text-ground">
              {usdc(p.referencePrice, 2)}
            </span>
            <span className="mt-0.5 block text-[10px] font-semibold tracking-wide text-ground/70">
              {POSITION_NAMES[p.position] ?? "—"}
            </span>
          </span>
          {n !== undefined && <span className="tnum font-display text-[14px] font-extrabold text-ground/80">{n}</span>}
        </div>
        <svg viewBox="0 0 40 40" className="absolute bottom-0 left-1/2 h-14 w-14 -translate-x-1/2" aria-hidden focusable="false">
          <circle cx="20" cy="14" r="8" fill="rgba(0,0,0,0.28)" />
          <path d="M4 40c1-9 8-14 16-14s15 5 16 14z" fill="rgba(0,0,0,0.28)" />
        </svg>
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <h3 className="truncate text-[13px] font-semibold">{p.name}</h3>
        <p className="tnum text-[12px] text-dim">
          {(Number(units / 10n ** 16n) / 100).toLocaleString("en-US")} units
        </p>
        <p className="tnum text-[12px] text-muted">{usdc(value, 2)} USDC</p>
        <button
          type="button"
          onClick={onMintMore}
          className={`mt-1 rounded-[8px] border border-line px-2 py-1.5 font-display text-[10px] font-extrabold tracking-[0.1em] text-text hover:border-up ${FOCUS}`}
        >
          MINT MORE
        </button>
      </div>
    </article>
  );
}

// --------------------------------------------------------------- my agents

/** One of my agents on this match — shared by the pre-match and live screens. */
export function AgentRow({ a, onRevoked }: { a: MyAgent; onRevoked: () => void }) {
  const { deployment: D } = useFixture();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string; hash?: string } | null>(null);
  const revoked = a.state === "revoked";

  async function revoke() {
    if (!wallet || !publicClient || !address) return;
    setBusy(true);
    setNote(null);
    try {
      const { request } = await publicClient.simulateContract({
        address: D.agentRegistry, abi: agentRegistryAbi, functionName: "revokeAgent", args: [a.address], account: address,
      });
      const hash = await wallet.writeContract(request);
      await confirm(publicClient, hash);
      setNote({ kind: "ok", text: `Revoked ${a.fqdn}`, hash });
      onRevoked();
    } catch (err) {
      setNote({ kind: "error", text: describe(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-[12px] border border-line-soft bg-panel p-3">
      <div className="flex items-center gap-3">
        <MiniCard playbook={a.playbook} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold">{a.fqdn}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 font-display text-[9px] font-extrabold tracking-[0.12em] ${
                revoked ? "border border-line text-dim" : a.state === "paused" ? "bg-warn/15 text-warn" : "bg-[#1F3A2C] text-up"
              }`}
            >
              {revoked ? "REVOKED" : a.state === "paused" ? "PAUSED" : "READY"}
            </span>
          </p>
          <p className="mt-0.5 truncate text-[12px] text-dim">
            <span className="capitalize" style={{ color: PLAYBOOK_DOT[a.playbook] }}>{a.playbook}</span> · {PLAYBOOK_RULE[a.playbook]} · cap{" "}
            {(Number(a.spendCap) / 1e6).toLocaleString("en-US")} <span aria-label="USDC">◆</span>
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            href={`/profile/${encodeURIComponent(a.fqdn)}`}
            className={`rounded-[8px] border border-line px-2.5 py-1.5 font-display text-[10px] font-extrabold tracking-[0.1em] text-text hover:border-up ${FOCUS}`}
          >
            VIEW
          </Link>
          {!revoked && (
            <button
              type="button"
              disabled={busy || !address}
              onClick={() => void revoke()}
              className={`rounded-[8px] border border-down/60 px-2.5 py-1.5 font-display text-[10px] font-extrabold tracking-[0.1em] text-down hover:bg-down/10 disabled:opacity-50 ${FOCUS}`}
            >
              {busy ? "REVOKING…" : "REVOKE"}
            </button>
          )}
        </div>
      </div>
      {WORLD_ON && !revoked && (
        <div className="mt-3">
          <CapControls compact agent={a} fixtureId={D.fixtureId} agentRegistry={D.agentRegistry} onChanged={onRevoked} />
        </div>
      )}
      {note && (
        <div className="mt-2">
          <Note kind={note.kind}>
            {note.text} {note.hash && <TxRef hash={note.hash} />}
          </Note>
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ screen

export function PreMatchScreen() {
  const { players, header, loading, error, refresh } = useWhistle();
  const { deployment: D, fixtureId } = useFixture();
  const { address } = useAccount();
  const [selected, setSelected] = useSelectedPlayer(D.fixtureId);
  const cards = useMemo(() => players.map((p) => ({ id: p.id, card: p.card })), [players]);
  const { held, refresh: refreshHeld } = useHoldings(cards);
  const { agents, refresh: refreshAgents } = useMyAgents(D.agentRegistry);
  const mine = agents.filter((a) => a.fixtureId === fixtureId);

  const youHold = useMemo(() => {
    let total = 0n;
    for (const p of players) {
      const u = held.get(p.id);
      if (u) total += (p.referencePrice * u) / WAD;
    }
    return total;
  }, [players, held]);
  const heldPlayers = players.filter((p) => held.has(p.id));
  const selectedPlayer = selected === null ? undefined : players.find((p) => p.id === selected);
  const L = header?.orderDelayL ?? 30;

  return (
    <main className="lg:h-[calc(100dvh-3.5rem-3rem)]">
      <h1 className="sr-only">
        {D.label} — {TEAM_NAMES[0]} v {TEAM_NAMES[1]}, pre-match
      </h1>
      {error && <p className="mb-3 rounded-[12px] border border-down/50 px-3 py-2.5 text-[13px] text-down">{error}</p>}

      <div className="flex flex-col overflow-hidden rounded-[24px] border border-line-soft bg-panel lg:h-full lg:flex-row">
        {/* ----------------------------------------------------- market */}
        <section aria-label="Market" className="order-2 flex min-h-0 flex-col gap-3 p-5 lg:order-1 lg:h-full lg:w-[560px] lg:shrink-0 lg:p-6">
          <div className="flex min-h-[420px] flex-1 flex-col lg:min-h-0">
            {loading && players.length === 0 ? (
              <p className="py-10 text-center text-[14px] text-dim">Reading the fixture…</p>
            ) : (
              <SquadTable
                players={players}
                teamNames={TEAM_NAMES}
                teamColours={TEAM_COLOUR}
                held={new Set(held.keys())}
                settled={false}
                selected={selected}
                preMatch
                onSelect={(id) => setSelected(id)}
              />
            )}
          </div>

          {selectedPlayer && (
            <div className="relative rounded-[14px] border border-line bg-surface p-3" aria-label={`Order: ${selectedPlayer.name}`}>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close the order bar"
                className={`absolute right-2 top-2 rounded-[6px] px-1.5 text-[14px] text-dim hover:text-text ${FOCUS}`}
              >
                ×
              </button>
              <QueueOrder
                player={selectedPlayer}
                state={0}
                orderDelayL={L}
                fixtureId={fixtureId}
                horizontal
                {...(held.get(selectedPlayer.id) !== undefined ? { holding: held.get(selectedPlayer.id) } : {})}
                addresses={{ usdc: D.usdc, settlementPot: D.settlementPot, whistleHook: D.whistleHook }}
                onDone={() => {
                  refresh();
                  void refreshHeld();
                }}
              />
            </div>
          )}
        </section>

        {/* ------------------------------------------------------ right */}
        <section
          aria-label="Your match"
          className="order-1 flex min-w-0 flex-1 flex-col gap-6 border-line-soft p-5 lg:order-2 lg:h-full lg:overflow-y-auto lg:border-l lg:p-6"
          style={{ background: "#16161A" }}
        >
          <MatchPanel
            pot={usdcShort(header?.potBalance)}
            orderDelay={`${L} S`}
            youHold={address ? usdc(youHold, 2) : "—"}
          />

          <section aria-label="My cards">
            <SectionHead title="MY CARDS" count={heldPlayers.length} />
            <div className="flex flex-wrap gap-3">
              {heldPlayers.map((p) => (
                <HoldingCard key={p.id} p={p} units={held.get(p.id)!} onMintMore={() => setSelected(p.id)} />
              ))}
              <div className="flex w-[150px] min-h-[196px] shrink-0 flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-line p-3 text-center">
                <span className="font-display text-[20px] text-dim" aria-hidden>+</span>
                <span className="text-[12px] leading-snug text-muted">Pick a player on the left and mint</span>
              </div>
            </div>
            {heldPlayers.length === 0 && (
              <p className="mt-2 text-[12px] text-dim">
                {address ? "You haven't minted anyone for this match yet." : "Connect a wallet to see and mint your cards."}
              </p>
            )}
          </section>

          <div className="flex flex-col-reverse gap-6 lg:flex-row">
            <section aria-label="My agents on this match" className="min-w-0 flex-1">
              <SectionHead
                title="MY AGENTS ON THIS MATCH"
                count={mine.length}
                right={
                  <Link href="/agents" className={`rounded-[6px] text-[12px] text-muted underline underline-offset-2 hover:text-text ${FOCUS}`}>
                    each is an ENS name you can revoke
                  </Link>
                }
              />
              {mine.length === 0 ? (
                <p className="rounded-[12px] border border-line-soft px-4 py-6 text-center text-[12px] text-dim">
                  {address ? "No agents on this match yet — add one." : "Connect a wallet to see your agents."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {mine.map((a) => (
                    <AgentRow key={a.address} a={a} onRevoked={() => void refreshAgents()} />
                  ))}
                </ul>
              )}
            </section>
            <div className="lg:w-[320px] lg:shrink-0">
              <NewAgentForm compact onCreated={() => void refreshAgents()} />
            </div>
          </div>

        </section>
      </div>
    </main>
  );
}
