"use client";

/**
 * The pitch.
 *
 * Home occupies the top half with its keeper nearest the top touchline, away
 * mirrors it below. Positions come from the match file's starting eleven rather
 * than from a hand-placed layout, so the drawing cannot drift from the lineup it
 * claims to show.
 *
 * Only starters are drawn. A substitute has no place on a pitch, and inventing
 * one would make the picture disagree with the table beside it.
 */

import { Shirt, type ShirtState } from "./Shirt";
import { formation, slots } from "../lib/squad";

export interface PitchPlayer {
  id: number;
  surname: string;
  number?: number;
  price: string;
  state: ShirtState;
  flashKey?: number;
}

interface Props {
  home: Map<number, PitchPlayer>;
  away: Map<number, PitchPlayer>;
  colours: [string, string];
  names: [string, string];
  /** Ten men after a red card, per side. */
  reduced: [boolean, boolean];
  selected: number | null;
  /** MY CARDS: dim every shirt the wallet does not hold. */
  onlyHeld: boolean;
  onSelect: (id: number) => void;
}

/**
 * Pitch markings.
 *
 * `preserveAspectRatio="none"` because the phone pitch is drawn a little taller
 * than broadcast (see below): the markings should stretch with it rather than
 * letterbox inside it and leave bare turf at the ends.
 */
function Markings() {
  const line = "#3E5A48";
  return (
    <svg
      viewBox="0 0 780 480"
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
      aria-hidden
      focusable="false"
    >
      <g stroke={line} strokeWidth="2" fill="none">
        <rect x="14" y="10" width="752" height="460" rx="3" />
        <line x1="14" y1="240" x2="766" y2="240" />
        <circle cx="390" cy="240" r="54" />
        <circle cx="390" cy="240" r="3" fill={line} />
        {/* Penalty and goal areas, top then bottom. */}
        <rect x="245" y="10" width="290" height="76" />
        <rect x="325" y="10" width="130" height="30" />
        <rect x="245" y="394" width="290" height="76" />
        <rect x="325" y="440" width="130" height="30" />
      </g>
    </svg>
  );
}

export function Pitch({
  home, away, colours, names, reduced, selected, onlyHeld, onSelect,
}: Props) {
  /**
   * A shirt is not a point.
   *
   * Each one is a jersey with a name tag and a price tag stacked below it, about
   * 54px tall, anchored at its centre — so a player standing on his own goal line
   * has half that hanging past the edge of a container that clips. Both keepers
   * lost their price tag to it.
   *
   * The band depths stay honest (a keeper is on his line); the drawing insets the
   * usable area instead, which is the same thing a broadcast graphic does.
   */
  const INSET = 0.07;

  /** Home fills the top half; away is mirrored into the bottom. */
  const place = (team: 0 | 1) =>
    slots(team).map((s) => {
      const half = team === 0 ? s.y * 0.5 : 1 - s.y * 0.5;
      return {
        ...s,
        left: `${(team === 0 ? s.x : 1 - s.x) * 100}%`,
        top: `${(INSET + half * (1 - 2 * INSET)) * 100}%`,
      };
    });

  return (
    /*
     * The container is taller than broadcast on a phone, and only there.
     *
     * Shirts are anchored at their centres, so the tappable band between two of
     * them is the ROW SPACING, not the shirt size — at a 780x480 pitch on a
     * 360px screen that band is 22px, under the 24px a thumb needs, and no
     * amount of shrinking the jersey changes it. Ten percent more height is the
     * whole fix. The proportions are exact again from `sm` up.
     */
    <div
      className="relative aspect-[780/545] max-h-full w-full max-w-[780px] overflow-hidden
                 rounded-[12px] sm:aspect-[780/480] sm:max-h-none"
      style={{
        // Striped turf: eight bands, alternating.
        background:
          "repeating-linear-gradient(180deg, #17261D 0 60px, #1B2C22 60px 120px)",
      }}
    >
      <Markings />

      {([0, 1] as const).map((team) => {
        const src = team === 0 ? home : away;
        return place(team).map((s) => {
          const p = src.get(s.id);
          if (!p) return null;
          return (
            <span key={s.id} className="absolute" style={{ left: s.left, top: s.top }}>
              <Shirt
                surname={p.surname}
                number={p.number}
                price={p.price}
                colour={colours[team]}
                state={p.state}
                selected={selected === s.id}
                flashKey={p.flashKey}
                dimmed={onlyHeld && p.state !== "held"}
                onSelect={() => onSelect(s.id)}
              />
            </span>
          );
        });
      })}

      <span
        className="absolute left-3 top-3 rounded-[6px] px-2 py-1 font-display text-[10px] font-extrabold uppercase tracking-wide text-white"
        style={{ background: colours[0] }}
      >
        {names[0]} · {formation(0)}
        {reduced[0] ? " · 10 men" : ""}
      </span>
      <span
        className="absolute bottom-3 right-3 rounded-[6px] px-2 py-1 font-display text-[10px] font-extrabold uppercase tracking-wide text-white"
        style={{ background: colours[1] }}
      >
        {names[1]} · {formation(1)}
        {reduced[1] ? " · 10 men" : ""}
      </span>
    </div>
  );
}
