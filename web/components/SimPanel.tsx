"use client";

/**
 * Driving the match from the page you are demoing.
 *
 * The browser holds the clock and the intent; the server holds the keys and
 * does one unit of work per ask. Nothing is stored on the server at all — the
 * clock travels with every request — so a laptop and a Vercel instance behave
 * identically, and an instance that has never seen this match before can still
 * take the next step correctly.
 *
 * The status line is the most important control here. A step function has no
 * progress bar; if the panel ever shows nothing, the operator cannot tell a
 * paused match from a broken one in front of an audience. So it always says
 * something, in the words of whatever is actually happening.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { minuteOf, type Clock, type Speed } from "../lib/sim/clock";

const TOKEN_KEY = "whistle:sim:token";
const CLOCK_KEY = "whistle:sim:clock";
const STEP_MS = 3_000;

export interface SimView {
  fixtureId: string;
  chainState: number;
  chainMinute: number;
  simMinute?: number;
  nextEvent: { minute: number; label: string } | null;
  eventsPosted: number;
  eventsTotal: number;
  lastMinute: number;
  lastTx?: { hash: string; what: string } | null;
  tickInfo?: { head: string; queued: string } | null;
  agentOrders?: { hash: string; what: string }[];
  posted?: { minute: number };
  note?: string;
  protected?: boolean;
  error?: string;
}

interface Props {
  fixtureId: string;
  /** Why Start is unavailable, or null when it is. Decided by the page. */
  blockedReason: string | null;
  /** The page refetches the board after each step so the screen keeps up. */
  onStepped?: () => void;
}

const idleClock = (speed: Speed = 3): Clock => ({
  running: false, speed, originMs: Date.now(), originMinute: 0,
});

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function SimPanel({ fixtureId, blockedReason, onStepped }: Props) {
  const [token, setToken] = useState("");
  const [clock, setClock] = useState<Clock>(idleClock);
  const [view, setView] = useState<SimView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * The loop's inputs, held as refs rather than dependencies.
   *
   * This is the difference between a match that runs and one that stops. The
   * fixture page re-renders once a second for its own clock; with these in the
   * dependency array below, the three-second interval was torn down and rebuilt
   * every second and therefore NEVER fired a second time. The match died at 10'
   * with the panel cheerfully reporting the last thing it had managed to do.
   */
  const tokenRef = useRef("");
  const clockRef = useRef<Clock>(clock);
  const steppingRef = useRef(false);
  const onSteppedRef = useRef(onStepped);
  onSteppedRef.current = onStepped;

  /** One place that writes the clock, so the ref and the store cannot diverge. */
  const writeClock = useCallback((next: Clock) => {
    clockRef.current = next;
    setClock(next);
    try {
      sessionStorage.setItem(CLOCK_KEY, JSON.stringify(next));
    } catch {
      /* private window: the match still runs, it just will not survive a reload */
    }
  }, []);

  useEffect(() => {
    const t = readStored<string>(TOKEN_KEY, "");
    setToken(t);
    tokenRef.current = t;
    const stored = readStored<Clock | null>(CLOCK_KEY, null);
    if (stored) {
      clockRef.current = stored;
      setClock(stored);
    }
  }, []);

  const call = useCallback(
    async (path: string, extra: Record<string, unknown> = {}): Promise<SimView | null> => {
      const t = tokenRef.current;
      if (!t) {
        setError("Enter the admin token first.");
        return null;
      }
      try {
        const res = await fetch(`/api/sim/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
          body: JSON.stringify({ fixtureId, ...clockRef.current, ...extra }),
        });
        const json = (await res.json()) as SimView;
        if (!res.ok) {
          setError(json.error ?? `HTTP ${res.status}`);
          if (json.chainState !== undefined) setView(json);
          return null;
        }
        setError(null);
        setView(json);
        /*
         * Let the chain set the pace when it cannot keep up.
         *
         * The server says which minute it just posted; the clock re-anchors to
         * it. When the chain is keeping up this does nothing, so 3m and 6m still
         * differ — but it stops the clock running away from the oracle.
         */
        if (json.posted) {
          const c = clockRef.current;
          if (minuteOf(c) > json.posted.minute) {
            writeClock({ ...c, originMinute: json.posted.minute, originMs: Date.now(), skipTo: undefined });
          } else if (c.skipTo !== undefined && json.posted.minute >= c.skipTo) {
            writeClock({ ...c, skipTo: undefined });
          }
        }
        return json;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [fixtureId, writeClock],
  );

  // Read the chain on mount: a reload mid-match must resume, not restart.
  useEffect(() => {
    if (!token) return;
    void call("status");
  }, [token, call]);

  const running = clock.running;
  useEffect(() => {
    if (!running || !token) return;
    const id = setInterval(() => {
      if (steppingRef.current || !clockRef.current.running) return;
      steppingRef.current = true;
      void call("step")
        .then(() => onSteppedRef.current?.())
        .finally(() => {
          steppingRef.current = false;
        });
    }, STEP_MS);
    return () => clearInterval(id);
    // Deliberately NOT [view, onStepped]: see the refs above.
  }, [running, token, call]);

  /**
   * Closing the tab pauses the match.
   *
   * Now purely local: the clock lives here, so stopping it is a write to
   * `sessionStorage` rather than a request that may not survive the unload.
   * Without it, a match left running with no tab would come back an hour behind
   * and post the rest of the fixture at once.
   */
  useEffect(() => {
    const onHide = () => {
      const c = clockRef.current;
      if (!c.running) return;
      const frozen = { ...c, running: false, originMinute: minuteOf(c), originMs: Date.now() };
      try {
        sessionStorage.setItem(CLOCK_KEY, JSON.stringify(frozen));
      } catch {
        /* nothing else to try during unload */
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const saveToken = (v: string) => {
    setToken(v);
    tokenRef.current = v;
    try {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  };

  /**
   * Start, with the protected-fixture guard actually costing something.
   *
   * The server takes `confirm=1`; sending it automatically because the server
   * asked would be the same as not having the guard. A protected fixture is the
   * one the live demo runs on and `kickoff` is one-way, so the operator says yes
   * out loud.
   */
  const start = async () => {
    if (view?.protected) {
      const ok = window.confirm(
        `Fixture ${fixtureId} is PROTECTED — this is the one the live demo runs on, ` +
          `and kicking off cannot be undone.\n\nStart it anyway?`,
      );
      if (!ok) return;
    }
    setBusy("start");
    const res = await call("start", view?.protected ? { confirm: 1 } : {});
    if (res) writeClock({ running: true, speed: clockRef.current.speed, originMs: Date.now(), originMinute: 0 });
    setBusy(null);
    onStepped?.();
  };

  const pause = () => {
    const c = clockRef.current;
    writeClock({ ...c, running: false, originMinute: minuteOf(c), originMs: Date.now() });
  };
  const resume = () => writeClock({ ...clockRef.current, running: true, originMs: Date.now() });
  const skipTo60 = () => writeClock({ ...clockRef.current, running: true, originMs: Date.now(), skipTo: 60 });
  const setSpeed = (speed: Speed) => {
    const c = clockRef.current;
    writeClock({ ...c, speed, originMinute: minuteOf(c), originMs: Date.now() });
  };

  const live = view?.chainState === 1;
  const done = view?.chainState === 2;
  const canStart = !blockedReason && Boolean(token) && view?.chainState === 0;

  return (
    <section className="rounded-[14px] border border-line bg-surface p-4" aria-labelledby="sim-heading" data-testid="sim-panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="sim-heading" className="font-display text-[11px] font-extrabold tracking-[0.16em] text-text">
          MATCH SIMULATION
        </h2>
        {/*
          The CHAIN's minute, not the compressed clock's. They diverge whenever
          the match has more events than there are steps to post them, and of the
          two only one is the match.
        */}
        <span className="tnum text-[11px] text-dim" data-testid="sim-minute">
          {view ? `${view.chainMinute}' of ${view.lastMinute}'` : "—"}
          {view ? ` · ${view.eventsPosted}/${view.eventsTotal} events` : ""}
        </span>
      </div>

      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] text-dim">Admin token</span>
        <input
          type="password" value={token} onChange={(e) => saveToken(e.target.value)}
          placeholder="SIM_ADMIN_TOKEN" autoComplete="off"
          className="w-full rounded-[8px] border border-line bg-panel px-2.5 py-1.5 text-[12px] text-text outline-none focus-visible:border-blue"
        />
      </label>

      <div className="mb-3 flex flex-wrap gap-2">
        <button
          type="button" disabled={!canStart || busy !== null} onClick={() => void start()}
          className="rounded-[8px] bg-cta px-3 py-1.5 font-display text-[11px] font-extrabold uppercase tracking-[0.08em] text-ground disabled:bg-none disabled:bg-panel disabled:text-dim"
        >
          {busy === "start" ? "Starting…" : "Start simulation"}
        </button>

        {running ? (
          <button type="button" onClick={pause} className="rounded-[8px] border border-line px-3 py-1.5 text-[12px] text-text hover:border-blue">
            Pause
          </button>
        ) : (
          <button type="button" disabled={!live || done} onClick={resume} className="rounded-[8px] border border-line px-3 py-1.5 text-[12px] text-text hover:border-blue disabled:text-dim">
            Resume
          </button>
        )}

        <button
          type="button" disabled={!live || (view?.chainMinute ?? 0) >= 60} onClick={skipTo60}
          className="rounded-[8px] border border-line px-3 py-1.5 text-[12px] text-text hover:border-blue disabled:text-dim"
        >
          Skip to 60&apos;
        </button>

        <div className="flex overflow-hidden rounded-[8px] border border-line" role="group" aria-label="Speed">
          {([3, 6] as const).map((s) => (
            <button
              key={s} type="button" aria-pressed={clock.speed === s} onClick={() => setSpeed(s)}
              className={`px-2.5 py-1.5 text-[12px] transition-colors ${clock.speed === s ? "bg-panel text-text" : "text-dim hover:text-text"}`}
            >
              {s}m
            </button>
          ))}
        </div>
      </div>

      {/* The one line that must never be empty. */}
      <p className="tnum min-h-[18px] text-[12px] leading-relaxed text-muted" role="status" data-testid="sim-status">
        {error
          ? error
          : view?.lastTx
            ? `${view.lastTx.what} — sent, waiting for the chain`
            : (view?.note ?? "idle")}
      </p>

      {blockedReason && <p className="mt-2 text-[12px] leading-relaxed text-dim">{blockedReason}</p>}

      <p className="mt-2 text-[11px] leading-relaxed text-dim">
        Replays Chelsea–Barcelona 2009 against live Sepolia contracts.
      </p>
    </section>
  );
}
