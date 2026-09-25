"use client";

/**
 * The two ways into the market, one per fixture state.
 *
 * PRE_MATCH mints at `P0` straight from the pot. LIVE queues an order that will
 * not fill for `L` seconds — so the form shows the countdown and the `R` the order
 * was submitted at, because those are the two numbers that decide whether the fill
 * is the one the trader agreed to.
 */

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { maxUint256, parseUnits, type Address } from "viem";

import { useFixture } from "../lib/fixtures";
import { seconds, usdc, WAD } from "../lib/format";
import { describe, settlementPotAbi, whistleHookAbi, type PlayerRow } from "../lib/useWhistle";
import { Button, Field, Line, Notice, Panel, PanelHeader, TxLink, inputClass } from "./ui";
import { confirm } from "../vendor/oracle/tx";

const usdcAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

interface Props {
  players: PlayerRow[];
  state: number;
  orderDelayL: number;
  onDone: () => void;
}

export function OrderForms({ players, state, orderDelayL, onDone }: Props) {
  // Minting goes through the pot and works for the whole squad. Queueing an order
  // goes through the hook, which only knows cards that were given a pool.
  const mintable = useMemo(() => players.filter((p) => p.supply > 0n), [players]);
  const tradable = useMemo(() => mintable.filter((p) => p.pooled), [mintable]);
  const choices = state === 1 ? tradable : mintable;
  const [cardId, setCardId] = useState<number | null>(null);
  const selected = choices.find((p) => p.id === cardId) ?? choices[0];

  useEffect(() => {
    if (cardId === null && choices[0]) setCardId(choices[0].id);
  }, [cardId, choices]);

  if (!selected) return null;

  return (
    <Panel>
      <PanelHeader title={state === 0 ? "Mint before kick-off" : state === 1 ? "Queue an order" : "Market closed"} />
      <div className="space-y-3 p-4">
        <Field label="Card">
          <select
            className={inputClass}
            value={selected.id}
            onChange={(e) => setCardId(Number(e.target.value))}
          >
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — R {usdc(p.referencePrice)}
                {state === 0 && !p.pooled ? " (mint only)" : ""}
              </option>
            ))}
          </select>
        </Field>

        {state === 0 && <MintForm card={selected} onDone={onDone} />}
        {state === 1 && selected.pooled && (
          <QueueForm card={selected} orderDelayL={orderDelayL} onDone={onDone} />
        )}
        {state === 1 && !selected.pooled && (
          <Notice kind="info" next="Pick a card with a market, or wait for settlement to redeem.">
            {selected.name} is mint only — this card has no pool, so there is nothing
            to trade against while the match is live.
          </Notice>
        )}
        {state === 2 && (
          <Notice kind="info">
            The fixture has settled. Positions are redeemed on the Settlement screen.
          </Notice>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- pre-match

function MintForm({ card, onDone }: { card: PlayerRow; onDone: () => void }) {
  const { deployment: D } = useFixture();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();

  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  const unitsWad = safeUnits(amount);
  const cost = (card.preMatchPrice * unitsWad) / WAD;

  async function submit() {
    if (!wallet || !publicClient || !address) return;
    setBusy(true);
    setError(null);
    setHash(null);
    try {
      const allowance = await publicClient.readContract({
        address: D.usdc,
        abi: usdcAbi,
        functionName: "allowance",
        args: [address, D.settlementPot],
      });
      if (allowance < cost) {
        const approveHash = await wallet.writeContract({
          address: D.usdc,
          abi: usdcAbi,
          functionName: "approve",
          args: [D.settlementPot, maxUint256],
          chain: wallet.chain,
          account: address,
        });
        await confirm(publicClient, approveHash);
      }

      const { request } = await publicClient.simulateContract({
        address: D.settlementPot,
        abi: settlementPotAbi,
        functionName: "mintPreMatch",
        args: [card.card, unitsWad, address],
        account: address,
      });
      const txHash = await wallet.writeContract(request);
      await confirm(publicClient, txHash);
      setHash(txHash);
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Field label="Units" hint={`Pre-match price is ${usdc(card.preMatchPrice)} USDC per card.`}>
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <div className="rounded border border-rule px-3 py-2.5">
        <Line label="Cost" value={`${usdc(cost)} USDC`} />
      </div>
      <Button onClick={submit} disabled={busy || !address || unitsWad === 0n}>
        {busy ? "Minting…" : address ? "Mint" : "Connect a wallet"}
      </Button>
      {error && (
        <Notice kind="error" next="Check your USDC balance and that the fixture is still pre-match.">
          {error}
        </Notice>
      )}
      {hash && (
        <Notice kind="ok">
          Minted {amount} units.
          <TxLink hash={hash} />
        </Notice>
      )}
    </>
  );
}

// --------------------------------------------------------------------- live

function QueueForm({ card, orderDelayL, onDone }: { card: PlayerRow; orderDelayL: number; onDone: () => void }) {
  const { deployment: D, fixtureId } = useFixture();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();

  const [side, setSide] = useState<0 | 1>(0);
  const [amount, setAmount] = useState("10");
  const [slippage, setSlippage] = useState("500");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ id: bigint; hash: string; rAtSubmit: bigint; at: number } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const unitsWad = safeUnits(amount);
  const notional = (card.referencePrice * unitsWad) / WAD;

  async function submit() {
    if (!wallet || !publicClient || !address) return;
    setBusy(true);
    setError(null);
    try {
      // Approve whichever asset this side of the trade pays with.
      const token: Address = side === 0 ? D.usdc : card.card;
      const allowance = await publicClient.readContract({
        address: token,
        abi: usdcAbi,
        functionName: "allowance",
        args: [address, D.whistleHook],
      });
      const needed = side === 0 ? notional * 2n : unitsWad;
      if (allowance < needed) {
        const approveHash = await wallet.writeContract({
          address: token,
          abi: usdcAbi,
          functionName: "approve",
          args: [D.whistleHook, maxUint256],
          chain: wallet.chain,
          account: address,
        });
        await confirm(publicClient, approveHash);
      }

      const rAtSubmit = card.referencePrice;
      const { request, result } = await publicClient.simulateContract({
        address: D.whistleHook,
        abi: whistleHookAbi,
        functionName: "queueOrder",
        args: [fixtureId, card.card, side, unitsWad, Number(slippage), false],
        account: address,
      });
      const txHash = await wallet.writeContract(request);
      await confirm(publicClient, txHash);

      setQueued({ id: result, hash: txHash, rAtSubmit, at: Math.floor(Date.now() / 1000) });
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  const remaining = queued ? queued.at + orderDelayL - now : 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {(["Buy", "Sell"] as const).map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => setSide(i as 0 | 1)}
            aria-pressed={side === i}
            className={`rounded border px-3 py-2 text-[14px] font-semibold transition-colors ${
              side === i ? "border-signal text-signal" : "border-rule text-slate hover:text-chalk"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Field label="Units">
        <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>

      <Field label="Price tolerance, bps" hint="The order is cancelled if the reference price moves further than this, in either direction.">
        <input className={inputClass} inputMode="numeric" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
      </Field>

      <div className="space-y-1.5 rounded border border-rule px-3 py-2.5">
        <Line label="Reference price" value={`${usdc(card.referencePrice)} USDC`} />
        <Line label="Notional" value={`${usdc(notional)} USDC`} />
        <Line label="Fills in" value={`${orderDelayL}s after submit`} />
      </div>

      <Button onClick={submit} disabled={busy || !address || unitsWad === 0n}>
        {busy ? "Queueing…" : address ? "Queue order" : "Connect a wallet"}
      </Button>

      {error && (
        <Notice kind="error" next="Check your balance and allowance, then try a smaller size.">
          {error}
        </Notice>
      )}

      {queued && (
        <div className="space-y-1.5 rounded border border-signal/40 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[13px] font-semibold">Order {queued.id.toString()}</span>
            <span className="tnum font-mono text-[13px] text-signal">
              {remaining > 0 ? seconds(remaining) : "Waiting for the keeper"}
            </span>
          </div>
          <Line label="Price at submit" value={`${usdc(queued.rAtSubmit)} USDC`} />
          <Line label="Price now" value={`${usdc(card.referencePrice)} USDC`} />
          <Line label="Moved" value={moveLabel(card.referencePrice, queued.rAtSubmit)} />
          <Line label="Your tolerance" value={`${slippage} bps`} tone="muted" />
          <TxLink hash={queued.hash} />
        </div>
      )}
    </>
  );
}

function moveLabel(now: bigint, before: bigint): string {
  if (before === 0n) return "—";
  const b = Number(((now - before) * 10_000n) / before);
  return `${b >= 0 ? "+" : ""}${b} bps`;
}

function safeUnits(input: string): bigint {
  try {
    const v = parseUnits(input.trim() === "" ? "0" : input.trim(), 18);
    return v < 0n ? 0n : v;
  } catch {
    return 0n;
  }
}
