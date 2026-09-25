"use client";

/**
 * "What it did, in English."
 *
 * A profile page is a lot of true things at once — ten ENS records, a spend bar,
 * a list of order ids — and none of them says *why* the agent moved when it did.
 * This asks for that one paragraph.
 *
 * Off by default. It costs a model call and it is the only thing on the screen
 * that is not read straight off the chain, so it ships behind
 * NEXT_PUBLIC_DEBRIEF=on and says plainly where the words came from.
 *
 * The flag lives in the page, not here, so this file can be code-split behind
 * it: when it is off the chunk is built but never fetched.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Card, CardHead, Note } from "./agent-ui";

interface Props {
  agent: string;
  fixtureId: string;
  playbook: string;
  rule: string;
  records: Record<string, string>;
  fills: string[];
  /** Nothing is asked for until the page has finished reading the chain. */
  ready: boolean;
}

export function Debrief({ agent, fixtureId, playbook, rule, records, fills, ready }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Per agent per match, so a tab switch does not buy the same paragraph twice. */
  const store = `whistle:debrief:${agent.toLowerCase()}:${fixtureId}`;
  const asked = useRef<string | null>(null);

  const ask = useCallback(
    async (force: boolean) => {
      if (loading) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/debrief", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent, fixtureId, playbook, rule, records, fills }),
        });
        const json = (await res.json()) as { text?: string; error?: string };
        if (!res.ok || !json.text) throw new Error(json.error ?? `HTTP ${res.status}`);
        setText(json.text);
        try {
          sessionStorage.setItem(store, json.text);
        } catch {
          /* private window; the server cache still covers the common case */
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        if (force) asked.current = null; // let the retry button work twice
      } finally {
        setLoading(false);
      }
    },
    [agent, fixtureId, playbook, rule, records, fills, store, loading],
  );

  useEffect(() => {
    if (!ready || asked.current === store) return;
    asked.current = store;
    let cached: string | null = null;
    try {
      cached = sessionStorage.getItem(store);
    } catch {
      /* ignore */
    }
    if (cached) {
      setText(cached);
      return;
    }
    void ask(false);
    // `ask` closes over the payload, which settles once `ready` is true; re-running
    // on every identity change would ask again for the same three sentences.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, store]);

  return (
    <Card>
      <CardHead title="Match debrief" hint="Written by a model from the records and fills on this page." />
      <div className="px-5 pb-5">
        {!ready && <p className="py-4 text-[13px] text-dim">Waiting for the match to finish reading…</p>}
        {ready && loading && !text && <p className="py-4 text-[13px] text-dim">Writing the debrief…</p>}
        {ready && error && !text && (
          <Note kind="error">
            No debrief: {error}
            <button
              type="button"
              onClick={() => void ask(true)}
              className="ml-2 underline underline-offset-2 hover:text-text"
            >
              Try again
            </button>
          </Note>
        )}
        {text && <p className="max-w-[72ch] text-[14px] leading-relaxed text-muted">{text}</p>}
      </div>
    </Card>
  );
}
