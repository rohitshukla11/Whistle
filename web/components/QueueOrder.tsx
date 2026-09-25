"use client";

/**
 * The order form on the board's rail.
 *
 * Three lanes, because the contracts have three: a pre-match mint straight from
 * the pot, a live mint at `R × 1.02`, and a queued buy or sell that fills `L`
 * seconds later at whatever the reference price is then. The form says which one
 * you are in rather than hiding it, because the price you get is different in
 * each and that is the whole design.
 */

import { useEffect, useRef, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { maxUint256, parseUnits, type Address } from "viem";

import { confirm } from "../vendor/oracle/tx";
import { usdc, WAD } from "../lib/format";
import { describe, settlementPotAbi, whistleHookAbi, type PlayerRow } from "../lib/useWhistle";
import { shirtNumber } from "../lib/squad";

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

type Side = "buy" | "sell" | "mint";

/** A human's default tolerance. Agents are given 10% in their mandate. */
const DEFAULT_SLIPPAGE_BPS = 500;

interface Props {
  player: PlayerRow | undefined;
  /** 0 PRE_MATCH, 1 LIVE, 2 SETTLED. */
  state: number;
  orderDelayL: number;
  addresses: { usdc: Address; settlementPot: Address; whistleHook: Address };
  fixtureId: bigint;
  /** The pitch view's single-line bar rather than the stacked rail form. */
  horizontal?: boolean;
  /** Units of this card the wallet holds, so SELL can be offered. */
  holding?: bigint;
  onDone: () => void;
}

export function QueueOrder({
  player, state, orderDelayL, addresses, fixtureId, horizontal, holding, onDone,
}: Props) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();

  const live = state === 1;
  const [side, setSide] = useState<Side>(live ? "buy" : "mint");
  const [units, setUnits] = useState("10");
  const [slippage, setSlippage] = useState(String(DEFAULT_SLIPPAGE_BPS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ id: bigint; at: number } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // `state` arrives a tick after mount, so the lane cannot be chosen at
  // initialisation: a live fixture would open on the mint lane.
  const settledOnce = useRef(false);
  useEffect(() => {
    if (!live) { setSide("mint"); return; }
    if (!settledOnce.current) {
      settledOnce.current = true;
      setSide(holding && holding > 0n ? "sell" : "buy");
    }
  }, [live, holding]);

  useEffect(() => {
    if (!queued) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, [queued]);

  if (state === 2) {
    return (
      <p className="text-[13px] leading-relaxed text-dim">
        The fixture has settled. Positions are redeemed on the settlement screen.
      </p>
    );
  }
  if (!player) {
    return <p className="text-[13px] text-dim">Pick a card to trade it.</p>;
  }

  const unitsWad = safeUnits(units);
  const unitPrice = side === "mint" && !live ? player.preMatchPrice : player.referencePrice;
  // The live mint lane pays a 2% premium; the pot mints new supply at that price.
  const premium = side === "mint" && live ? 102n : 100n;
  const total = (unitPrice * unitsWad * premium) / (WAD * 100n);
  const mintOnly = !player.pooled;

  async function submit() {
    if (!wallet || !publicClient || !address || !player) return;
    setBusy(true);
    setError(null);
    try {
      const spender = side === "mint" ? addresses.settlementPot : addresses.whistleHook;
      const token: Address = side === "sell" ? player.card : addresses.usdc;
      const needed = side === "sell" ? unitsWad : total * 2n;

      const allowance = await publicClient.readContract({
        address: token, abi: erc20Abi, functionName: "allowance", args: [address, spender],
      });
      if (allowance < needed) {
        const hash = await wallet.writeContract({
          address: token, abi: erc20Abi, functionName: "approve",
          args: [spender, maxUint256], chain: wallet.chain, account: address,
        });
        await confirm(publicClient, hash);
      }

      if (side === "mint" && !live) {
        const { request } = await publicClient.simulateContract({
          address: addresses.settlementPot, abi: settlementPotAbi, functionName: "mintPreMatch",
          args: [player.card, unitsWad, address], account: address,
        });
        await confirm(publicClient, await wallet.writeContract(request));
        setQueued(null);
      } else {
        const { request, result } = await publicClient.simulateContract({
          address: addresses.whistleHook, abi: whistleHookAbi, functionName: "queueOrder",
          args: [fixtureId, player.card, side === "sell" ? 1 : 0, unitsWad, Number(slippage), side === "mint"],
          account: address,
        });
        await confirm(publicClient, await wallet.writeContract(request));
        setQueued({ id: result, at: Math.floor(Date.now() / 1000) });
      }
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  const remaining = queued ? queued.at + orderDelayL - now : 0;
  const lanes: Side[] = live ? ["buy", "sell", "mint"] : ["mint"];
  const surname = player.name.split(" ").slice(-1)[0] ?? player.name;

  if (horizontal) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="tnum grid h-10 w-10 shrink-0 place-items-center rounded-[8px] font-display text-[14px] font-extrabold text-ground"
          style={{ background: player.team === 0 ? "#2F6FD0" : "#A6214B" }}
          aria-hidden
        >
          {shirtNumber(player.id) ?? surname.slice(0, 2).toUpperCase()}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-[13px] font-extrabold uppercase">
            <span className={side === "sell" ? "text-down" : "text-up"}>{side}</span>{" "}
            {units} × {surname} @ {usdc(unitPrice, 2)}
          </span>
          <span className="block truncate text-[12px] text-dim">
            ≈ {usdc(total, 2)} USDC · fills {orderDelayL} s after you confirm
            {side !== "mint" && ` · cancels if the price moves more than ${(Number(slippage) / 100).toFixed(0)}%`}
          </span>
        </span>

        {lanes.length > 1 && (
          <span className="flex shrink-0 gap-1" role="group" aria-label="Order side">
            {lanes.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setSide(l)}
                aria-pressed={side === l}
                disabled={mintOnly && l !== "mint"}
                className={`rounded-[8px] px-2.5 py-1.5 text-[11px] font-bold uppercase transition-colors
                  disabled:cursor-not-allowed disabled:opacity-40 ${
                    side === l ? "bg-panel text-text" : "text-dim hover:text-text"
                  }`}
              >
                {l}
              </button>
            ))}
          </span>
        )}

        <label className="shrink-0">
          <span className="sr-only">Units</span>
          <input
            className="tnum w-[64px] rounded-[8px] border border-line bg-panel px-2 py-2 text-right text-[14px]
                       outline-none transition-colors focus:border-up"
            inputMode="decimal"
            value={units}
            onChange={(e) => setUnits(e.target.value)}
          />
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={busy || !address || unitsWad === 0n}
          className="shrink-0 rounded-[10px] bg-cta px-4 py-2.5 text-[13px] font-bold uppercase text-ground
                     transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Sending…" : !address ? "Connect" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => { setQueued(null); setError(null); }}
          className="shrink-0 rounded-[10px] border border-line px-4 py-2.5 text-[13px] font-bold uppercase
                     text-muted transition-colors hover:text-text"
        >
          Cancel
        </button>

        {queued && (
          <span className="tnum w-full text-[12px] text-up">
            Order {queued.id.toString()} · {remaining > 0 ? `fills in ${remaining}s` : "waiting for the keeper"}
          </span>
        )}
        {error && <span className="w-full text-[12px] text-down">{error}</span>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {lanes.length > 1 && (
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Order side">
          {lanes.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setSide(l)}
              aria-pressed={side === l}
              disabled={mintOnly && l !== "mint"}
              className={`rounded-[10px] px-2 py-2 text-[13px] font-semibold capitalize transition-colors
                disabled:cursor-not-allowed disabled:opacity-40 ${
                  side === l ? "bg-surface text-text" : "text-dim hover:text-text"
                }`}
            >
              {l}
            </button>
          ))}
        </div>
      )}

      {mintOnly && (
        <p className="rounded-[10px] border border-line px-3 py-2 text-[12px] text-dim">
          {player.name} has no pool, so it is mint only — there is nothing to trade against.
        </p>
      )}

      <label className="block">
        <span className="mb-1 block text-[12px] text-dim">Units</span>
        <input
          className="tnum w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[15px]
                     outline-none transition-colors focus:border-up"
          inputMode="decimal"
          value={units}
          onChange={(e) => setUnits(e.target.value)}
        />
      </label>

      {side !== "mint" && (
        <label className="block">
          <span className="mb-1 block text-[12px] text-dim">Max price move, bps</span>
          <input
            className="tnum w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[15px]
                       outline-none transition-colors focus:border-up"
            inputMode="numeric"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
          />
        </label>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={busy || !address || unitsWad === 0n}
        className="w-full rounded-[12px] bg-cta px-4 py-3 text-[15px] font-bold text-ground
                   transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy
          ? "Sending…"
          : !address
            ? "Connect a wallet"
            : `Queue ${side} · ≈ ${usdc(total, 2)} USDC`}
      </button>

      {queued && (
        <div className="flex items-baseline justify-between gap-3 rounded-[10px] border border-up/40 px-3 py-2.5">
          <span className="text-[13px] font-semibold">Order {queued.id.toString()}</span>
          <span className="tnum text-[13px] text-up">
            {remaining > 0 ? `fills in ${remaining}s` : "waiting for the keeper"}
          </span>
        </div>
      )}

      {error && (
        <p className="rounded-[10px] border border-down/50 px-3 py-2.5 text-[12px] leading-relaxed text-down">
          {error}
        </p>
      )}
    </div>
  );
}

function safeUnits(input: string): bigint {
  try {
    const v = parseUnits(input.trim() === "" ? "0" : input.trim(), 18);
    return v < 0n ? 0n : v;
  } catch {
    return 0n;
  }
}
