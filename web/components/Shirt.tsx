"use client";

/**
 * One player on the pitch: a jersey, a name tag and a price tag.
 *
 * The price tag is the point of it. A pitch view that only showed positions
 * would be a diagram; showing what each shirt is worth, and colouring it by
 * what just happened to that player, is the thing the product does.
 */

export type ShirtState = "on" | "held" | "frozen" | "sent-off" | "subbed";

export interface ShirtProps {
  surname: string;
  number?: number;
  price: string;
  colour: string;
  state: ShirtState;
  selected?: boolean;
  /** Re-keyed by the caller when the price changes, to flash the tag. */
  flashKey?: number;
  dimmed?: boolean;
  onSelect: () => void;
}

/**
 * What the colour of a shirt already says, said out loud.
 *
 * State is carried visually by fill and price-tag tone. A screen reader gets
 * none of that, so it is spelled into the accessible name instead.
 */
const STATE_NOTE: Record<ShirtState, string> = {
  on: "",
  held: ", held",
  frozen: ", frozen",
  "sent-off": ", sent off",
  subbed: ", substituted",
};

const PRICE_TONE: Record<ShirtState, string> = {
  on: "bg-up text-ground",
  held: "bg-blue text-ground",
  frozen: "bg-down text-ground",
  "sent-off": "bg-down text-ground",
  subbed: "bg-line text-muted",
};

export function Shirt({
  surname, number, price, colour, state, selected, flashKey, dimmed, onSelect,
}: ShirtProps) {
  const off = state === "sent-off";
  const subbed = state === "subbed";
  const fill = off ? "#3A1519" : subbed ? "#2A2A30" : colour;
  const stroke = off ? "#FF7B72" : subbed ? "#8C8C95" : "rgba(255,255,255,0.75)";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group absolute flex min-h-[44px] w-[68px] -translate-x-1/2 -translate-y-1/2 flex-col
                  items-center focus-visible:outline-none ${dimmed ? "opacity-35" : ""}`}
      style={{ opacity: subbed && !dimmed ? 0.7 : undefined }}
    >
      {/*
        The name comes from what is on screen, plus the two things that are not:
        the unit, and the state the colour is carrying. An aria-label here used
        to REPLACE the visible text rather than extend it, so a voice-control
        user saying "Cech 6.45" — what they can see — matched nothing.
      */}
      {number !== undefined && <span className="sr-only">Number {number}, </span>}

      <svg viewBox="0 0 40 36" className="h-[26px] w-[30px]" aria-hidden focusable="false">
        {/* A jersey: body, two sleeves, a collar notch. */}
        <path
          d="M13 4 L7 7 L3 13 L8 17 L10 13 V32 H30 V13 L32 17 L37 13 L33 7 L27 4 L20 8 Z"
          fill={fill}
          stroke={selected ? "#F3F3F5" : stroke}
          strokeWidth={selected ? 2 : 1.2}
          strokeLinejoin="round"
        />
        {number !== undefined && (
          <text
            x="20" y="25" textAnchor="middle"
            className="tnum"
            fontSize="12" fontWeight="800" fill="rgba(255,255,255,0.92)"
          >
            {number}
          </text>
        )}
      </svg>

      <span className="mt-0.5 max-w-full truncate rounded-[3px] bg-white px-1 py-[1px] font-display text-[7px] font-extrabold uppercase tracking-tight text-ground">
        {surname}
      </span>
      <span
        key={flashKey}
        className={`tnum mt-[1px] rounded-[3px] px-1 py-[1px] text-[8px] font-bold ${PRICE_TONE[state]}
                    ${flashKey ? "animate-flash" : ""}`}
      >
        {price}
      </span>
      <span className="sr-only"> USDC{STATE_NOTE[state]}</span>
    </button>
  );
}
