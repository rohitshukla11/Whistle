"use client";

/**
 * The order bar's selected player, shared by the pre-match and live screens.
 *
 * `/fixtures/<id>` swaps the pre-match screen for the live one the moment
 * kickoff lands. Component state would die with the screen and drop the
 * player someone had just picked; this lives in a module store mirrored to
 * `sessionStorage`, keyed by fixture, so the live screen mounts with the same
 * selection — and a reload keeps it too.
 */

import { useCallback, useSyncExternalStore } from "react";

const key = (fixtureId: string) => `whistle:selected:${fixtureId}`;
const listeners = new Set<() => void>();
const memory = new Map<string, number | null>();

function read(fixtureId: string): number | null {
  if (memory.has(fixtureId)) return memory.get(fixtureId)!;
  try {
    const raw = sessionStorage.getItem(key(fixtureId));
    const v = raw === null ? null : Number(raw);
    memory.set(fixtureId, Number.isInteger(v) ? v : null);
  } catch {
    memory.set(fixtureId, null);
  }
  return memory.get(fixtureId)!;
}

export function useSelectedPlayer(fixtureId: string): [number | null, (id: number | null) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(fixtureId),
    () => null,
  );
  const set = useCallback(
    (id: number | null) => {
      memory.set(fixtureId, id);
      try {
        if (id === null) sessionStorage.removeItem(key(fixtureId));
        else sessionStorage.setItem(key(fixtureId), String(id));
      } catch {
        /* private window: the selection still survives the swap in memory */
      }
      for (const l of listeners) l();
    },
    [fixtureId],
  );
  return [value, set];
}
