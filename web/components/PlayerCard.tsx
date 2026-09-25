/**
 * A player card, as the product would print it.
 *
 * **No real photographs or crests are in this repo.** The portrait is a
 * silhouette tinted per club and the club is a three-letter code, because
 * shipping likenesses or badges we have no licence for would be a problem long
 * before it was a design decision. `portraitSrc` exists so a licensed asset can
 * be dropped in later without touching the layout.
 */

export type Tint = "purple-blue" | "green" | "orange-pink" | "yellow-green" | "purple-pink";
export type RibbonTone = "up" | "down" | "warn";
export type CardSize = "sm" | "md" | "lg";

/** What the chain says a player did, and how the card should wear it. */
export type CardState =
  | { kind: "goal"; minute: number }
  | { kind: "assist"; minute: number }
  | { kind: "subbed"; minute: number }
  | { kind: "conceded"; minute: number }
  | { kind: "yellow"; minute: number }
  | { kind: "sent-off"; minute: number }
  | { kind: "none" };

const STATE_STYLE: Record<
  Exclude<CardState["kind"], "none">,
  { label: (m: number) => string; bar: string; text: string }
> = {
  goal: { label: (m) => `GOAL ${m}'`, bar: "bg-up", text: "text-ground" },
  assist: { label: (m) => `ASSIST ${m}'`, bar: "bg-up/70", text: "text-ground" },
  subbed: { label: (m) => `SUBBED ${m}'`, bar: "bg-line", text: "text-muted" },
  conceded: { label: (m) => `CONCEDED ${m}'`, bar: "bg-line", text: "text-muted" },
  yellow: { label: () => "YELLOW", bar: "bg-warn", text: "text-ground" },
  "sent-off": { label: (m) => `SENT OFF ${m}'`, bar: "bg-down", text: "text-ground" },
};

export interface Club {
  /** Three-letter code, e.g. `RMA`. Stands in for a crest. */
  code: string;
  /** The club's colour, used for the roundel and the portrait silhouette. */
  colour: string;
}

export interface PlayerCardProps {
  firstName: string;
  lastName: string;
  number: number;
  club: Club;
  tint: Tint;
  /** A match moment and what it did to the price. */
  ribbon?: { text: string; tone: RibbonTone };
  /** A licensed portrait, if one is ever available. */
  portraitSrc?: string;
  size?: CardSize;
  className?: string;
  /** Overrides the name band, for the agent card. */
  bandLabel?: string;
  /** A small mark shown beside `bandLabel`. */
  bandIcon?: React.ReactNode;
}

/** The board card: a fixed 176x250 tile carrying live numbers and one action. */
export interface CompactCardProps {
  name: string;
  surname: string;
  number?: number;
  position: string;
  club: Club;
  tint: Tint;
  price: string;
  minutes: number;
  points: string;
  move: string;
  moveUp: boolean;
  state: CardState;
  /** Missing pool: the only thing you can do is mint. */
  mintOnly?: boolean;
  /** Settled: there is nothing left to do here but redeem, on another screen. */
  settled?: boolean;
  /** Flashes the price for 600ms. Re-keyed by the caller on change. */
  flashKey?: number;
  onBuy?: () => void;
  onSell?: () => void;
  portraitSrc?: string;
}

export function CompactPlayerCard({
  name, surname, number, position, club, tint, price, minutes, points, move, moveUp,
  state, mintOnly, settled, flashKey, onBuy, onSell, portraitSrc,
}: CompactCardProps) {
  const sentOff = state.kind === "sent-off";
  const s = state.kind === "none" ? null : STATE_STYLE[state.kind];

  return (
    <article
      tabIndex={0}
      aria-label={`${name} ${surname}, ${position}, ${price} USDC`}
      className={`flex w-[176px] shrink-0 flex-col overflow-hidden rounded-[18px] border bg-panel
                  transition-colors ${sentOff ? "border-down" : "border-line-soft hover:border-line"}`}
    >
      <div className={`relative h-[128px] ${TINTS[tint]}`}>
        <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2.5">
          <span>
            <span
              key={flashKey}
              className={`tnum block font-display text-[30px] font-extrabold leading-none text-ground
                          ${flashKey ? "animate-flash" : ""}`}
            >
              {price}
            </span>
            <span className="mt-0.5 block text-[10px] font-semibold tracking-wide text-ground/70">
              {position}
            </span>
          </span>
          {number !== undefined && (
            <span className="tnum font-display text-[16px] font-extrabold leading-none text-ground/80">
              {number}
            </span>
          )}
        </div>

        <div className="absolute inset-x-0 bottom-0 top-8 grid place-items-end">
          <div className="h-[86px] w-[72px] opacity-90">
            {portraitSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={portraitSrc} alt="" className="h-full w-full object-cover object-top" />
            ) : (
              <Silhouette colour={club.colour} />
            )}
          </div>
        </div>

        {s && (
          <p className={`absolute inset-x-0 bottom-0 ${s.bar} px-2.5 py-1 text-[10px] font-bold tracking-wide ${s.text}`}>
            {s.label("minute" in state ? state.minute : 0)}
          </p>
        )}
      </div>

      <div className="flex flex-1 flex-col p-2.5">
        <h3 className="truncate font-display text-[20px] font-bold leading-tight">{surname}</h3>

        <dl className="mt-2 grid grid-cols-3 gap-1">
          {[
            ["MIN", `${minutes}'`, "", "minutes played"],
            // EXP until full time: the expected final score, which is what the
            // price is a share of. PTS once the score is final.
            settled
              ? ["PTS", points, "", "final score"]
              : ["EXP", points, "", "expected final score — this drives the price"],
            ["MOVE", move, moveUp ? "text-up" : "text-down", "against the price at kick-off"],
          ].map(([label, value, tone, title]) => (
            <div key={label}>
              <dt className="cursor-help text-[11px] text-dim" title={title}>
                {label}
              </dt>
              <dd className={`tnum text-[13px] font-semibold ${tone}`}>{value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-auto flex gap-1.5 pt-2.5">
          {settled ? (
            // Offering Buy or Sell after settlement would be offering something
            // the contract refuses; redemption lives on the settlement screen.
            <p className="w-full rounded-[10px] border border-line-soft px-2 py-1.5 text-center text-[12px] text-dim">
              Settled
            </p>
          ) : mintOnly ? (
            <button
              type="button"
              onClick={onBuy}
              className="w-full rounded-[10px] border border-line px-2 py-1.5 text-[12px] font-semibold
                         text-muted transition-colors hover:border-dim hover:text-text"
            >
              Mint only
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onBuy}
                className="flex-1 rounded-[10px] border border-line px-2 py-1.5 text-[12px] font-semibold
                           transition-colors hover:border-up hover:text-up"
              >
                Buy
              </button>
              <button
                type="button"
                onClick={onSell}
                className="flex-1 rounded-[10px] bg-surface px-2 py-1.5 text-[12px] font-semibold text-muted
                           transition-colors hover:text-text"
              >
                Sell
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

const TINTS: Record<Tint, string> = {
  "purple-blue": "bg-tint-purple-blue",
  green: "bg-tint-green",
  "orange-pink": "bg-tint-orange-pink",
  "yellow-green": "bg-tint-yellow-green",
  "purple-pink": "bg-tint-purple-pink",
};

const RIBBON_TONE: Record<RibbonTone, string> = {
  up: "text-up",
  down: "text-down",
  warn: "text-warn",
};

const SIZES: Record<CardSize, { w: string; pad: string; name: string; num: string; mark: string }> = {
  sm: { w: "w-[92px]", pad: "p-2", name: "text-[9px]", num: "text-[11px]", mark: "text-[6px]" },
  md: { w: "w-[168px]", pad: "p-3", name: "text-[12px]", num: "text-[16px]", mark: "text-[8px]" },
  lg: { w: "w-[252px]", pad: "p-4", name: "text-[13px]", num: "text-[22px]", mark: "text-[10px]" },
};

/** Head and shoulders. Deliberately generic — see the note at the top. */
function Silhouette({ colour }: { colour: string }) {
  return (
    <svg viewBox="0 0 100 120" className="h-full w-full" aria-hidden focusable="false">
      <circle cx="50" cy="40" r="22" fill={colour} opacity="0.92" />
      <path d="M12 120c0-23 17-38 38-38s38 15 38 38z" fill={colour} opacity="0.92" />
    </svg>
  );
}

export function PlayerCard({
  firstName,
  lastName,
  number,
  club,
  tint,
  ribbon,
  portraitSrc,
  size = "md",
  className = "",
  bandLabel,
  bandIcon,
}: PlayerCardProps) {
  const s = SIZES[size];
  const label = bandLabel ?? `${firstName} ${lastName}`;

  return (
    <figure
      className={`${s.w} ${TINTS[tint]} overflow-hidden rounded-card border border-white/10 ${className}`}
    >
      <div className={`relative ${s.pad}`}>
        <div className="flex items-start justify-between">
          <span className={`${s.mark} font-display font-black tracking-[0.18em] text-panel/80`}>
            WHISTLE
          </span>
          <span className={`${s.num} tnum font-display font-extrabold leading-none text-panel`}>
            {number}
          </span>
        </div>

        <div className="mx-auto mt-1 aspect-[5/6] w-[78%]">
          {portraitSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={portraitSrc} alt="" className="h-full w-full object-cover object-top" />
          ) : (
            <Silhouette colour={club.colour} />
          )}
        </div>
      </div>

      <figcaption className="bg-panel/90 px-2.5 py-2">
        <div className="flex items-center gap-2">
          <span
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[8px] font-bold text-panel"
            style={{ background: club.colour }}
            aria-hidden
          >
            {club.code.slice(0, 1)}
          </span>
          <span className={`${s.name} min-w-0 flex-1 truncate font-semibold text-text`}>
            {label}
          </span>
          {bandIcon}
        </div>
        {ribbon && (
          <p className={`tnum mt-1 text-[10px] font-semibold ${RIBBON_TONE[ribbon.tone]}`}>
            {ribbon.text}
          </p>
        )}
      </figcaption>
      <span className="sr-only">
        {firstName} {lastName}, number {number}, {club.code}
      </span>
    </figure>
  );
}
