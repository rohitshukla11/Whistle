# Whistle — design tokens and layout plan

Written before the revision, so the code has something to be checked against.

---

## The principle

**The match clock is the spine.** Every number in this app is a function of the
minute, so the minute is never off screen, and the only thing that moves is a
price reacting to an event.

That is the thing a generic dashboard cannot claim. A dashboard shows you the
current state of something; Whistle shows you a number *being pushed* by a match
that is still going on. So the clock is sticky, the price column is the loudest
element on the page, and nothing else animates at all — if something moved, a
footballer did something.

---

## Colour — six names

Grounded in a floodlit evening kick-off rather than a trading terminal: a
blue-grey ground the colour of dusk under lights, pitch-marking white, and two
team colours that belong to the fixture rather than to the brand.

| Token | Value | Role |
|---|---|---|
| `dusk` | `#11151a` | Ground. Cool blue-grey, not near-black. |
| `chalk` | `#e9edf1` | Primary text. Pitch-marking white, slightly cool. |
| `slate` | `#737f8b` | Secondary text, rules, disabled. |
| `signal` | `#f2a33c` | **The one bold colour.** Live badge, a price that just moved, focus ring, positive outcome. |
| `home` | `#4a7fd4` | Team 0 identity rule. |
| `away` | `#b35566` | Team 1 identity rule, and negative outcome. |

Boldness is spent in exactly one place: **a price that has just changed**. It goes
`signal` for one beat and fades back to `chalk`. Nothing else in the app is amber.

Direction is carried by an explicit `▲`/`▼` and a signed number, not by colour
alone — colour only reinforces it, and only on realised outcomes.

## Type — two faces, two jobs

| Face | Role |
|---|---|
| System sans | **What the app says.** Headings, labels, copy, buttons. Sentence case throughout, tight tracking on headings, normal tracking everywhere else. |
| System mono, tabular figures | **What the market says.** Every price, clock, minute, point total, address and transaction hash. |

The split is the point: scoreboards and price boards have always been monospaced,
and it means you can tell at a glance whether a number came from the chain or a
word came from us. Tabular figures are not decoration — every one of these numbers
updates in place, and proportional digits make a column jitter.

---

## Layout, one concept per screen

### Fixture — "a team sheet with a price column, under a clock that never leaves"

```
┌────────────────────────────────┐
│ Whistle              [Connect] │
├════════════════════════════════┤  ← sticky
│  45'   Live        pot 718,822 │
├════════════════════════════════┤
│▌Chelsea                        │  ← 3px home rule, full height
│▌ Petr Cech        GK    6.95   │
│▌ on pitch  45'  banked 0       │
│▌ John Terry       DEF   7.03 ▲ │  ← amber for one beat
│▌ ...                           │
├────────────────────────────────┤
│▌Barcelona                      │  ← 3px away rule
│▌ Victor Valdes    GK    3.55 ▼ │
├────────────────────────────────┤
│ Queue an order                 │
│ [Petr Cech ▾]  [Buy] [Sell]    │
│ R at submit  6.95              │
│ R now        7.03  +115        │
│ Fills in     22s               │
├────────────────────────────────┤
│ 66'  Red card    Eric Abidal   │
│ 65'  Substitution  Malouda ▸   │
└────────────────────────────────┘
```

The two lineups are one continuous ruled sheet, not a grid of cards — a team sheet
is a list, and making it a list is what stops this looking like a generic
dashboard. The coloured rule down the left edge is the only team branding.

### Agents — "a stack of mandates, each one readable and revocable"

```
┌────────────────────────────────┐
│ Agents               [Connect] │
├────────────────────────────────┤
│ Grant a mandate                │
│ Agent address  [0x…          ] │
│ Template       [Protect     ▾] │
│ Sells a slice of any held card │
│ Cap [2000]   Slippage [1000]   │
│ [        Create agent        ] │
├────────────────────────────────┤
│ agent-1.demo.whistle.eth       │
│ Protect             Authorised │
│ Cap      2,000,000             │
│ Spent          618             │
│ Slippage       10%             │
│ [ Pause ]          [ Revoke  ] │
├────────────────────────────────┤
│ Recent fills                   │
└────────────────────────────────┘
```

### Profile — "a ledger where every line is signed"

```
┌────────────────────────────────┐
│ agent-1.demo.whistle.eth       │
│ Resolver 0x6BAd…F0BA           │
├────────────────────────────────┤
│ last-action            Agent   │
│ protect: trimmed Iniesta…      │
│ Written by 0x7099…79C8         │
├────────────────────────────────┤
│ spend-cap               User   │
│ 2000000000000                  │
└────────────────────────────────┘
```

### Settlement — "the final table, and what it was worth"

```
┌────────────────────────────────┐
│ Settlement            Settled  │
│ Pot 718,822    Left 718,822    │
├────────────────────────────────┤
│ Vault    +21,619               │
│ Fees         47.55             │
├────────────────────────────────┤
│ Michael Essien    9.91   +65%  │
│ 22.00 pts  90'  paid 6.00      │
├────────────────────────────────┤
│ Your positions                 │
│ Essien  24 units    [ Redeem ] │
└────────────────────────────────┘
```

---

## Checked against the defaults

| Default to avoid | Present before? | What changed |
|---|---|---|
| Warm cream, serif display, terracotta | No | — |
| Near-black with a single acid-green accent | **Yes** — `#0b0d10` ground with `#1d8a4e`/`#3ecf8e` green | Ground moved to a cool `dusk` blue-grey; the single accent is amber `signal`, and green is gone entirely |
| Broadsheet hairlines, zero radius | No | — |
| Identical rounded cards, same soft shadow everywhere | **Yes** — every panel was `rounded-xl border` | The lineup is now one ruled sheet, not cards; panels differ by role and carry no shadow |
| Tracked-out all-caps eyebrow labels | **Yes** — every `PanelHeader` and `Stat` | Sentence case, normal tracking |
| Middle-dot meta strings | **Yes** — `on-pitch · 45' · banked 0` | A small labelled grid; no dots |
| `→` on every link | No | — |
| Numbered `01/02/03` markers | No | — |

## Quality floor

Mobile first at 400px. Visible `:focus-visible` ring in `signal`. All motion behind
`prefers-reduced-motion`. Prose capped at 66 characters. One action name per action
across the whole flow: **Revoke → Revoking… → Revoked**, never "Cancel mandate" in
one place and "Revoke" in another.
