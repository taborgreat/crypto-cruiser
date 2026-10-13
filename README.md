# TRAFFIC

A driver's-seat simulator for leveraged perp positions on Solana (Jupiter Perps). Your car is the mark
price. The car ahead is your liquidation price. Time to liquidation is the seconds until you hit it at the
current closing rate. Everything on the road moves; what you feel is the relative motion. Every number
you read is in dollars, SOL, price, percent or seconds; the car metaphor lives in the picture.

## Run

```
npm install
npm run dev          # server on :8787 + Vite on :5173 -> open http://localhost:5173
```

Production-style: `npm run build` then `npm start` and open http://127.0.0.1:8787.

Console:

```
npm run feed                                             # print every oracle tick {t, price}
npm run console -- --side short --lev 100 --collateral 50 # paper 100x short, numbers live
```

Tests and typecheck: `npm test`, `npm run typecheck`. Configuration is by environment variables, see
`.env.example`.

## Modes

**PRACTICE** (default). Live Jupiter oracle price, simulated position, no wallet. The paper engine uses
Jupiter's exact liquidation formula and fee schedule (6 bps open/close, price-impact bps from the custody
scalar, hourly borrow rate from Jupiter's pool-info), so practice numbers match live numbers. Collateral
comes from a practice bankroll.

**REAL**. Connect Phantom. Opening, every pedal, closing and limit orders are built by Jupiter's
Perpetuals API, signed in Phantom, and executed by Jupiter's keeper. The server never holds a key. A red
border stays on screen the whole time. You need SOL in Phantom (keep ~0.03 for fees); shorts use USDC
collateral and Jupiter swaps your SOL on the way in.

Both modes look identical. Switch with the toggle at the top of the panel.

## PREVIEW: bird's-eye

Before Go the camera looks straight down at the road. Six lanes: three LONG lanes on the left, three SHORT
lanes on the right, mirrored so the two shortest lookbacks meet at the centre. In each lane my car sits
at the bottom with its P&L, and the car in front at its true distance in dollars. Lanes are labelled in
plain words (`if Go 10 s ago · if Go 1 m ago · if Go 5 m ago`; lookbacks are 5 H, H, H / 6, set in
settings). The distance is printed between the two cars (`$0.38 · 0.35%`), the car in front glows red
by how hard the trend is turning against that side, the entry line sits at its true position, and a thin
trail shows where the car in front was over the last H: pointing away from me = pulling away, toward me
= closing.

The scale auto-fits: the spread of the gaps spans at least a quarter of the view, zooming in no further
than 1 px per $0.001. When the far cars would not fit at that scale the axis breaks: the near road keeps
the true scale, a marked break follows, and the far region starts at the nearest car. The scale bar on
the right reads `$ per screen-cm` and the percent equivalent, so in a flat tape three cars a cent apart
are visibly staggered and the bar reads cents. Road texture scrolls at the flow speed and cars nudge on
every trade, so the six spacings move.

Clicking a lane (on the road or in the panel) focuses it; Go opens at the current price in that
side / leverage and the camera swoops into that lane's driver seat as the trade fills. `V` toggles
top-down and driver seat at any time; a rewind uses whichever view is active.

## The lane (ghost mode)

Each lane drives the position as if it had been opened a while ago: its entry is the oracle price from
that long ago, read from the tick history and rolling forward with the clock, so its distance to
liquidation, its speed and its time to liquidation actually move with the tape. A lane that reaches its
liquidation price crashes into the car ahead and respawns 2 s later; the crash count is the information.
One-line readout, plain units:

```
if opened 60 s ago at 107.600: P&L +$3.10 (+6.2%) · to liq $0.71 (0.66%) · time to liq 2 m 10 s
· moving toward liq $0.021/s (0.020%/s) · volatility 0.21%/min (1 m ATR) · borrow −$0.44/h (−0.0007%/h)
```

- Dial side, leverage and what you pay (SOL or USDC, shown in USD at the live price). The summary shows
  entry, liquidation price, dollars and percent to liquidation, fees and borrow. `GO` (Enter) commits
  the focused lane; the real car appears in place and the other lanes fade.
- Scrub the entry forward along the road (drag on the road, click the chart, `[` / `]`, or type a price)
  to turn the entry into a limit. Paper limits fill when the price crosses; real limits are Jupiter
  limit orders.
- On fill, if the real entry differs from the proposed one you get a jolt and the slippage in dollars.

## Driving

| Key         | Pedal                                                        | Jupiter action                                                               |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| W           | gas                                                          | increase size + proportional collateral                                      |
| Shift+W     | HARD gas                                                     | increase size only (leverage up)                                             |
| C           | back off                                                     | add collateral only                                                          |
| S           | brake                                                        | partial close (25%)                                                          |
| Space       | full brake                                                   | close all                                                                    |
| X           | withdraw (danger)                                            | remove collateral                                                            |
| T / Shift+T | trailing stop on / off                                       | client-side watcher; in REAL mode the close is prepared for signing when hit |
| V           | top-down / driver seat                                       |                                                                              |
| N, Shift+V  | invert road, data view (price-only / full dash / combined)   |                                                                              |
| 2 / 3, K    | 2D / 3D renderer, chase / driver camera                      |                                                                              |
| R, B, I, L  | rewind, bridge chart drawer, inspect panel, label everything |                                                                              |
| Q (hold), M | look back at the road behind, drop a flag                    |                                                                              |
| Esc, H      | settings, help                                               |                                                                              |

Hover any pedal for exactly what it does right now in dollars (`S brake: close 25% ≈ $503 (4.68 SOL)`).
Every tuning constant is in the settings panel (`Esc`).

## Layout (Update 9)

Left panel: side / asset / size / leverage / horizon / entry / lanes (one row each) / Go / Rewind /
recent trades. It scrolls on its own and never overlaps the road. Stage: one row of status chips with
the view buttons; toasts in a single column top-left (newest first, 6 s, max 3, click to pin); TIME TO
LIQUIDATION top-centre; the mirror top-right; the leverage dial and the tiles `TO LIQUIDATION · P&L ·
FROM ENTRY · POSITION · AVAILABLE` in one row that always fits (narrow widths move POSITION and AVAILABLE
under the dial); the pedals in their own row; the bridge chart as a full-width bottom drawer (drag to
resize, `B` toggles, collapsed it is a 24 px strip of just the price lines). The centre column from my
car to the car in front is always clear. The race music player is its own tiny widget bottom-left.

Colour has one meaning everywhere: red = toward liquidation / loss, green = away / profit, yellow =
entry, blue = stop, white = me / the mark. The headline P&L is after fees and coloured by its own sign;
the gross and realized numbers sit underneath. The speedometer arc is white and tints red only when time
to liquidation is red. Figures are tabular so digits do not jitter. Only the brake lights of the cars in
front bloom. All of it lives in `web/src/theme.css`.

Efficiency: the server sends one websocket message per animation frame (ticks batched, latest per
source); the client applies the latest frame on `requestAnimationFrame`, updates HUD text at 10 Hz and
the needle / strip at 60 Hz, pauses rendering when the tab is hidden, caps the pixel ratio at 1.5, and a
`low` quality preset (settings) drops bloom and runs at 30 fps. Buildings, poles, posts, flags and
speed streaks are instanced or merged; cars are one merged geometry each; the frame stays under 300
draw calls.

## Time to liquidation and the mirror

The strip under TIME TO LIQUIDATION is the last H seconds of time to liquidation (left = oldest,
right = now), coloured by the threshold at that moment, with the thresholds printed from the live H in
the caption, tick marks at `−H`, `−H/2` and `now`, and a white line tracing the value on a log scale
(not closing at the top, 0 at the bottom): the colours tell you the state, the line tells you the shape.
Hover reads `t −23 s · 1 m 40 s to liq · $0.31 away`; click jumps the chart crosshair there. Red moments
also leave red posts on the road behind.

The mirror is a rear-view mirror of the last 10 H: a white price trail ending at a car icon with the live
price, the entry line (yellow, dashed), the liquidation line (red) and the trailing stop (blue) each
labelled on the line, a `$` scale on the right, a time axis along the bottom, red posts where the strip
was red. Up is always toward liquidation for the current side, as on the road. Hover reads
`−3 m 10 s · 108.27 · $0.33 to liq · P&L then +$0.80`.

Rule: any line, bar or dot on screen carries its label on itself or within 10 px.

## Horizon ()

One knob, H: how many seconds of market should feel like about 20 seconds of driving. Chips 1m / 5m /
15m / 1h / 4h / 1d / 1w and a slider. Everything that decides what counts as "now" derives from it: the
impulse EMA (H / 30), the trend EMA (H), the trend-acceleration EMA (H / 6), the lane lookbacks (5 H, H,
H / 6 by default), the headway thresholds (green H, yellow H / 3, orange H / 12, critical H / 60), the
render amplification (60 / H), how fast animated positions re-sync to the oracle, and the camera lift.
Gap and headway math are untouched.

Auto from room (on by default): `H = H_base × clamp(gap / gap_at_entry, 0.5, 20)^1.5`, slow-lerped over
5 s. Auto from volatility (off): quiet tape lengthens H. The 1-second guarantee: at any H every trade
event is still a visible nudge of the car ahead and an audible tick. When you have been pulling away for
H / 3 with everything green and no lane crashed, the CLEAR tag shows and the scene brightens.

## Legibility

- Hover anything on the road: your car, the car ahead, the entry line, the trailing stop, each lane
  and its car ahead, the limit line, the road, hills, traffic, light poles, posts, flags, the mirror,
  the strip. Every tooltip ends with the oracle timestamp of the value. Click to pin. `L` labels every object.
- The bridge chart (`B`): candles built from the local tick history, with every road object as a price
  line in its road colour, swing highs/lows as triangles, flags and rewind liquidations as markers. Labels
  live in their own column: neighbours within 14 px merge into one stacked tag with leader lines and
  `mark` always wins. Hover a line and the road object rings; hover the road and the line thickens. The
  crosshair reads price, time, dollars to liquidation and P&L if closed there. In preview a click sets the
  limit entry. The timeframe follows H (H / 60) unless you pick one.
- The inspect panel (`I`): every live value in the frame with its formula and source.

## Rewind drive (Update 7)

`R`: pick a lookback (5m … 1w) and a playback length (45 s by default). The road becomes the past: two
lanes, LONG and SHORT, each holding your proposed position from `now − lookback`, driven by the recorded
oracle ticks at `lookback / duration` speed with H = lookback / 20. A liquidated lane respawns at the
mark immediately; the timeline bar shows each lane's P&L path labelled at the playhead, every
liquidation counted per side, your flags (`M`) and the playhead with its time. Click the bar to scrub,
Space pauses, ← → step, +/− or the wheel change speed. The drive lands on now with a per-lane readout.

## Feed and history

One RPC websocket for the whole process. `accountSubscribe` on each market's Jupiter oracle account (the
Doves aggregated price feed referenced by the custody's `dovesAgOracle`; this is the price the liquidation
engine sees) and on the connected wallet's position account. Bytes are decoded in TypeScript
(`shared/solana.ts`). Ticks go to a typed-array history in memory and an append-only `{t, p}` file in
`data/ticks/` that is compacted to `TICK_HISTORY_DAYS` at startup; from it the 1 s … 1 d candles (built
incrementally), ATR, swing structure, lane lookbacks and the rewind are built locally. The Coinbase trade
stream, offset-corrected to the oracle, animates the car ahead between oracle updates and carries the
price if the subscription drops. No REST price polling, no event log: the only records are the price
history and the trades themselves (on Solana for Real, listed from Jupiter's `/trades`; in the practice
engine for Practice).

Verified against live data in October 2026: oracle accounts (SOL `FYq2…`, ETH `AFZn…`, BTC `hUqA…`), the
Position account layout, the liquidation formula against Jupiter quotes (within $0.02), and the live API
request schema (which differs from the published OpenAPI doc; see `server/engine/live.ts`).

## Make it move (Update 3)

Two timescales: `v_fast` (H / 30) is the impulse, `v_slow` (H) the trend, `a_slow` (H / 6) the trend
acceleration. The car ahead carries the trend (brake lights from `−a_slow`, slam flash past
`slamThreshold`), your car carries the impulse (surge / drag past `lurchThreshold`, decaying back to the
flow). Time to liquidation uses `v_fast`; the projected one uses `a_slow`. The road never stops
(`roadMin`). Effects in the seat: road, poles, grid and skyline scroll at your speed, traffic drifts at
`v_road − v_you`, FOV with speed and horizon, speed streaks, camera pitch, lurch kick, headway shake,
brake-light bloom with a back-step on slam, crash flare on lanes, engine / tire / rising alarm audio,
race music while driving. Every drive ends in a results card.

## Layout of the code

```
shared/     types, kinematics, horizon, Jupiter math, candles/ATR/hills, tick history, readout, format, batch, decoders
server/     feed (rpc websocket, doves, coinbase, hermes, manager), engines (paper, live), layers, rewind, session, http/ws, cli
web/        Vite + Three.js front end: HUD, 2D and 3D renderers, trade form, bridge chart, rewind, inspect, hover, settings, Phantom, music, theme
test/       vitest unit tests (kinematics, horizon, batching, liquidation vs live quotes, candles, paper engine, readout, history, decoders)
data/       tick history (data/ticks) and the live position ledger
```

## Conditions (Update 11)

A panel above Go that looks back over seven horizons (1m · 15m · 1h · 4h · 1d · 1w · 1y), scores each
with the same four measures, and boils it down to one sentence in caps plus a reason line:

```
SHORT · LOCAL TOP IN A LARGER DOWNTREND
15m: at highs (0.93) · 1h: +2.4 ATR above mean, fading · 1d: falling (−1.2 ATR/window) · activity 1.7× normal
```

Per horizon, from candles of its natural resolution: `range_pos` (where the price sits in the window's
low→high), `trend` (EMA slope over the window in ATRs), `activity` (ATR now against its 10× window
average), `stretch` (ATRs from the mean) and `accel` (last 20% of the window against the prior 80%,
signed in the direction of the stretch: fading or still going). A rule stack reads them top to bottom:
activity gate (WAIT), stretched top fading (SHORT), stretched bottom fading (LONG), momentum still
accelerating (WAIT, or go with it when the side matches), trend not stretched (pullback entry), local vs
long-term conflict (MIXED), otherwise NO EDGE. The side word is coloured; the Go button gets an outline
when it agrees with the selected side and a hint when it does not. The grid under the sentence shows
every horizon; hover any cell for the numbers and the formula.

The short horizons come from the local tick history; 4h–1y are backfilled once at startup from Coinbase
candles (one request per resolution, cached in `data/candles/`) and maintained from the live stream.
The sentence rides on every frame, so in a rewind the panel says what it would have said at that moment.
Cleanup in the same update: one P&L basis everywhere (after fees, on collateral), REAL disabled until
Phantom is connected and the red border only then, a single chip row with a `⋯` menu, liq tags in the
left margin of the top-down view with label collision avoidance, tooltips that never stick, a one-line
strip legend, the lanes as a six-row table.

## Exits and the pay slider (Update 12)

On the driving page the **exits** button opens a drawer to arm partial take-profit / stop-loss orders:
pick TAKE PROFIT or STOP LOSS, a share (25 / 50 / 75 / 100%), and a price (type it, or a quick 0.25 / 0.5 /
1 / 2% from the mark in the right direction). The server watches the oracle price and closes that share
at the market when it is reached: practice closes at once, REAL prepares the close for Phantom like the
trailing stop does. Armed exits are drawn on the road (green TP behind you, orange SL ahead) and as price
lines on the chart; a filled exit shows as a toast and in recent trades, and the rest of the position keeps
driving. Exits clear when the position closes. Up to 8 armed at a time.

"You're paying" has a slider and 25 / 50 / 75 / MAX chips over what is available: the SOL balance minus
the fee reserve or the USDC balance in REAL (both read from the wallet), the practice bankroll otherwise.

## Instant signing (Update 13)

Phantom will not auto-approve for a site, so the only way to make actions instant is a key the app can
sign with. The panel's **Instant signing** box creates a small trading wallet whose keypair lives in
`data/trading-wallet.json` (or `TRADING_WALLET_SECRET`). Fund it from Phantom (a transfer you sign
once), press **use instant**, and from then on every open, pedal, exit and trailing stop
is signed on the server and handed to Jupiter at once, with no approve screen. Positions belong to the
trading wallet while it is in use; **withdraw all to Phantom** sends the SOL back; **back to Phantom**
returns to approve-per-action signing. It is a hot key: anyone with the file controls its funds, so keep
the balance small. Gas needs no tuning: Jupiter builds the transactions with its own compute budget and
priority fee and its keeper lands them.

Also in this update: the wallet poller starts even when the first read fails, the panel shows how many
open positions Jupiter reports for the wallet with a **check positions** button, and the app switches to
REAL on its own whenever the connected wallet holds a position.

## Positions from the chain (Update 14)

The first real trade exposed a silent failure: Jupiter's `GET /positions` had renamed its fields
(`sizeUsd` → `size`, `entryPriceUsd` → `entryPrice`, `liquidationPriceUsd` → `liquidationPrice`,
`asset` → `marketMint`), so an open short parsed as size 0, was filtered out, and the app showed
"0 open positions", no car and no pedals while the position lived and died on Jupiter. The fill watch
never resolved either, so "WAITING FOR KEEPER" hung until the 120 s warning.

The chain is now the source of truth. A wallet's position accounts are PDAs of
`("position", owner, pool, custody, collateralCustody, side)`: longs use the asset custody as collateral,
shorts USDC or USDT, so a wallet owns at most nine accounts on the JLP pool. `server/engine/chainPositions.ts`
derives them (verified against a real account) and reads all nine in one `getMultipleAccounts` per poll;
`shared/solana.ts` decodes them. Size > 0 means open. Jupiter's endpoint is still read alongside: when it
answers, its liquidation price and accrued fees are used; when it is silent or renames fields again, the
liquidation price is computed locally from the fee schedule and the current borrow rate. If the RPC is
down, the API rows (with the new names) are used alone.

Two more things from the incident: a submitted transaction's signature is followed with
`getSignatureStatuses`, so an on-chain failure is reported within seconds instead of after the watchdog,
and the trade history mapping uses the current row names (`size`, `pnl`, `txHash`, `orderType`).
"check positions" on the wallet box now says what the chain and the API each report.

## The "if Go now" lane (Update 14)

The three lookback lanes ("if Go 5 m / 1 m / 10 s ago") answer what the trade would have done. They lost
the one lane that shows the placement Go actually makes: my car for the dialled side, leverage and size,
entered at the current mark. That lane is back as the fourth lane per side, `if Go now`, white, the
default focus, nearest the divider in the bird's-eye view so the LONG and SHORT "now" cars sit side by
side. Its car in front stands at the at-entry distance for that leverage (the dollar distance in the
bird's-eye view, the headway and trend in the seat), it never crashes, and Go turns it into the real car
without a jump. In the driver's seat the road widens to four lanes of the LIVE lane width and the camera
sits behind the focused lane; after Go the road narrows back to three with my car in the middle.

## After the second real session (Update 14)

- **Realized P&L of a REAL close comes from Jupiter.** The HUD said +$1.76 and the results card said
  "CLOSED · LOSS −$0.74": the account subscription had written size 0 into the still-selected position, one
  frame showed P&L 0 with the fee estimate attached, and the card froze that. Jupiter's trade row said
  +$2.41 before fees, $0.86 fees. Now a closed account is left to the refresh (the position goes null in
  one step), and after every decrease the engine reads the trade row Jupiter wrote for it (`pnl` is before
  fees, `fee` separate) and reports `closed` or `liquidated` with those figures; the results card waits for
  that (15 s fallback to the frame stats). A position that ends without a transaction of ours is reconciled
  the same way, so a liquidation shows a LIQUIDATED card.
- **REAL pedals need a second press.** In REAL mode the first press of W / S / C / X / Space only arms the
  pedal (the button turns yellow); the same key again, the button again, or Enter within 4 s sends it.
  Practice sends at once. Esc disarms.
- **The entry line is labelled.** It is where you merged. While the trade is in profit the line is behind
  you (you have driven past your entry); while it is in loss it is ahead of you, between you and the car in
  front. The label says `entry 104.280 · $0.21 behind you · in profit`.
- **The chart drawer cannot squeeze the road.** It takes at most 30 % of the window and leaves ~300 px of
  road above the HUD stack. If the seat view ever looks like a thin strip, that was this.
- **Spacing.** Bird's-eye: the true distance first. The farthest car in front sits at 70 % of the depth
  and every distance is in proportion from my car, so with one lane drawn the gap you see is the gap. Only
  when several lanes are drawn and their differences would be invisible (under 12 % of the depth) does the
  axis break engage, compressing what the lanes share and stretching the spread to half the depth. The
  lanes span ~85 % of the width, and the labels are the dollar figures only (the percent is on hover and in
  the lane table). Seat: in PREVIEW the chase camera rises and looks
  further down the road so four lanes of cars in front are visible instead of piling on the horizon.
- The K key toggles the chase and the first-person driver camera; in the driver camera your own car is
  not drawn.

## Look around, and the LAN (Update 14)

- **Mouse look-around in the seat.** Move the mouse up and the chase camera rises and looks further down
  the road, over your own car, so the car in front is in plain view; sideways glances left or right. It
  eases back when the mouse leaves the road. Top-down ignores it.
- **LAN mode.** `npm run dev:lan` (or `npm run start:lan` after a build, or `HOST=0.0.0.0`) listens on
  every interface; the server log prints the address to open from another device (port 5173 with the dev
  server, 8787 with `start:lan`). Vite proxies the API and the websocket to the server on the same machine.
  Anyone on that network can drive the connected wallet, including the in-app trading wallet, so use it
  only on a network you trust.

## Phones (Update 14)

No separate design. Under 820 px wide, everything that overlays the road on a desktop becomes a full-width
block in document order and the page scrolls: the start panel, then the road (about 56 % of the screen
height, labels over it), then the chips, the price, time to liquidation and the mirror, the dial and the
tiles, the pedals (big enough to tap, two or three per row), then the chart. Toasts, the WAITING banner,
the results card and the sign modal float over the page. `web/src/mobile.css` holds all of it; the
desktop stylesheet is untouched. To test from a phone, run `npm run dev:lan` and open the address the
server log prints, port 5173.

## Which lanes are drawn, and the USDC swap (Update 14)

- **Only the focused lane is drawn by default.** Eight cars and eight cars in front were a mess. The lane
  table still shows every lane's numbers; the road draws the focused lane (the one Go uses) plus any lane
  you tick in the table, and "all lanes" in the table header draws everything. The bird's-eye view packs
  the drawn lanes from the divider outward, so with one lane per side the two "if Go now" cars sit side by
  side with their liquidation tags beside their cars in front. The panel also pushes its lanes as soon as
  the server answers, so the road is never empty before the first click.
- **Swap USDC → SOL.** Closed shorts leave USDC in the trading wallet. The trading-wallet box shows a
  "swap … USDC → SOL" button when there is at least $0.50; it asks Jupiter Ultra for an order, signs it
  with the trading wallet and lets Jupiter land it. Instant-signing wallets only; with Phantom, swap on
  jup.ag.

## The camera, and the dashes (Update 14)

- **The dashes ran backwards.** The road plane is rotated −90° about X, so the texture's v axis grows away
  from the camera; the scroll offset had the wrong sign and sent the lane dashes forward while the poles
  came toward you. Fixed, and the road no longer reverses on a favourable tick (the scroll speed is floored
  at zero).
- **Orbit camera.** The camera is anchored to a point above your car. The mouse wheel zooms from a high,
  far chase all the way in to first person (closer than 1.6 m your own car is not drawn); a plain drag
  orbits (right moves round to the right, up raises the camera); double-click resets; K jumps between
  first person and the home chase. The chase / driver setting and its HUD button are gone. In PREVIEW the
  limit entry is now scrubbed with shift-drag (or the chart, or [ ]). The camera is remembered.
- **Tags.** The tags above the cars cycle with the "tags" button: on, faded, parked in a column at the right
  edge, or off. Hover still works in every mode.

## Pedals are the driver only; the market is motion (Update 15)

The THROTTLE and BRAKE bars moved with no input: the Update 3 market impulse was folded into the pedal
values, so the tape's push read as auto-gas and auto-brake, and the motion it should have put into the
seat went into a little bar instead. Split:

- `throttle` and `brake` on the car frame are the driver's pedals only (a press, decaying over about a
  second). Hands off, they read zero. The smoke run checks this on a live tape.
- `impulse` is a new signed −1..1 figure: `−v_gap_impulse / 0.05`, so a tick against you is a positive
  surge and a tick for you a negative drag. It is the single source for the camera pitch, the FOV, the nose
  of your car and its brake lights, and the engine note (up on a surge, down on a drag). The road speed
  already carried it through `v_you`. Nothing downstream reads the pedal values any more.
- Under the dial, "price · trend" became `market: pushing you +0.04%/s` / `market: easing −0.02%/s`
  / `market: steady`, with the trend and the liquidation drift after it.
- The dial shows the effective leverage big and, when it differs, the leverage the position was opened at
  small: `131.0x · effective · 250× set`. A changed effective leverage (fees, added collateral, the price
  moving) is a fact, not a glitch.

## Update 16: zoom from above, quiet, a steady clock, and CHASE

- **The bird's-eye zooms.** The wheel zooms the top-down view in and out (0.3× to 4×); the dollar scale
  follows and is remembered.
- **Quiet.** The tyre hiss plays only while a position is on the road, at a tenth of its old level. A
  speaker button in the top row mutes everything: engine, hiss, roar and music.
- **"driver seat" is now "drive"** on the button and in the help.
- **A steady time to liquidation.** It ran on the tick-to-tick closing speed, which crosses zero every few
  seconds, so the panel flipped between 12 s and hours. It now runs on the trend plus the liquidation
  drift, and the figure is smoothed in log space with a 2.5 s time constant per car; "not closing" enters
  the average as four hours so one flip cannot snap it. Projected time, the colour and the history strip
  all follow the same figure.
- **CHASE mode** (K, or the "chase" button): Kade's model. The same position, every number identical; only
  where it is drawn changes. The car in front becomes a **monster behind you**: its distance is your
  distance to liquidation, its gaining is your closing speed, time until it catches you is the headway.
  It lives in a **mirror strip** near the top of the screen (a second camera above your car looking back),
  looms as it gains, its eyes brighten when the trend turns against you, and it **roars** louder the
  closer it gets; when time is red the screen edges pulse. The road ahead is open: distance is the score.
  The entry line keeps its meaning; the trailing stop is a **wall ahead** that you choose to hit. Lanes
  work the same, one monster each; top-down and rewind are unchanged. The panel reads TIME UNTIL CAUGHT
  and DISTANCE AHEAD OF IT. The impulse still moves your car, the trend moves the monster.

## Update 17: details

- **Zoom keeps the spacing.** The bird's-eye dollar scale is fixed at zoom 1, so the wheel adds road around
  the cars instead of re-spacing them.
- **Side tags on the left**, since the right is the panels' column; "faded" also fades the price.
- **The chaser is a police car**: white, a red and blue light bar on the roof that alternates and brightens
  the more it is gaining and the trend turns against you, headlights facing you.
- **The chart opens tight**: ±0.4 % of the mark (about a dollar on SOL), widened only to keep the
  liquidation and entry lines and the last twenty bars in view, never beyond ±1.5 %.
- **Every pedal and every state-changing hotkey needs a second push** (Enter, M, N, V, Shift+V, 2, 3, K, R;
  pedals in practice too): the first press says "push again to confirm". A stray key does nothing.
- **The rear-view is a rectangle** in the middle: 30 % margins each side.
- **TRADES page** (⋯ menu or the "full page" button on Recent trades): every trade of a wallet — the practice
  engine, the connected wallet, the trading wallet or any address — with net after fees, win rate, fees,
  volume, liquidations, best and worst, the split by side and market, the best and worst hour of day, a
  cumulative P&L chart, a P&L-per-close chart and the full table with Solscan links. Live rows now carry
  P&L after fees like the practice records.
- **CONDITIONS page** (⋯ menu or the button under the panel): the sentence and reason big, a card per
  horizon with a sparkline of its closes (EMA in purple, the window's range shaded), every figure behind the
  grid, and the rule stack that decides the sentence. Refreshes every 5 s while open.
- Both pages take over the stage; X, the same button again, or Esc closes them. The drive keeps running.

## Update 18: the ticket, the confirm sheet, a usable clock, the guide

- **The order ticket.** Side, market, what you pay, size, leverage, entry and the fees now sit in one framed
  card, red-edged for SHORT and green for LONG, headed PLACE A POSITION. The horizon knob moved below it,
  after the fees; the lanes and the conditions follow.
- **REAL confirm sheet.** The red frame around the screen is gone. Instead, Go in REAL opens a sheet that
  says exactly what is about to be placed: ▲ LONG in green or ▼ SHORT in red, what you pay, the size and
  leverage, the entry, the liquidation price and how far it is, the fees. PLACE or cancel.
- **Time to liquidation** was jittery on the tick-to-tick speed and mute ("not closing") on the pure trend.
  It now uses a closing speed smoothed over about 4 s, the trend when that closes faster, then the time
  smoothed in log space. A number most of the time, no flicker, "not closing" only when nothing closes.
- **The seat draws the same lanes as the bird's-eye**, both sides side by side, packed from the divider; the
  road is as many lanes wide as are drawn. "All lanes" now shows all eight in the seat too. In the bird's-eye,
  if the outer lanes seem missing, the wheel has zoomed in: zoom out.
- **Tags** park at the side by default (left, since the right is the panels'); the chaser's tag is red, not
  pink; "faded" is a touch brighter. The mirror strip no longer has a frame.
- **The chase button names the mode you are in**: TRAFFIC or CHASE.
- **Lanes survive a server restart**: the browser re-pushes them when the socket reconnects, and a failed push
  retries quietly instead of a red toast. (The "every 30 s" resets were the server restarting on each code
  change while you drove.)
- **The conditions guide**: the CONDITIONS page opens with BIAS, THE READ (a plain sentence per horizon, in
  three groups), SIGNALS (each with a clear sign and colour), RISK AT N× (your room to liquidation against a
  normal move on each horizon) and WATCH (the levels that change the read), above the cards and the rules.

## Update 19: more details

- **Side tags** are never pushed off the bottom and may be wider, so they are not cut off.
- **Roadside poles** (the T-shaped lights) are off by default; a setting turns them on.
- **The entry line is white**, drawn on the road under the car instead of through it; its tag is white too.
- **The panel order**: the ticket, the horizon, then GO right under it; the lanes; two big buttons side by
  side, CONDITIONS and TRADES, that open the pages; then the inline conditions, rewind and the recent trades.
- **"Only mine"** in the lane table header draws only the focused lane. The focused lane's car is solid with
  a cyan edge and a "YOU · price" tag; the other lanes are ghosted in their lane colour.
- **The horizon from inside the drive**: click the H chip in the top row for the presets or auto.
- **CHASE from above**: the bird's-eye now draws the police car in place of the car in front, so switching
  modes is visible there too; in the seat it is behind you as before.

## Update 20: the crowd is made of real trades

The background cars used to cruise. Now every print on the fast feed (the Coinbase ticker already carries
the taker side and the size; the server now keeps them) is classified against the last minute's median
size and the last hour's trade rate, and may move one car:

- **Buys drift right, sells left** (invert flips it). A buy-heavy minute visibly leans the field before the
  price has moved: the early tell. Order flow is the one piece of market information the road did not show.
- **The odds grow with size**: a median print moves a car about 3 % of the time, a 5× print always.
- **Big prints (8× the median and more) are big cars that cut in close**: ahead of you when the trade is
  against your side, behind you when it is with you; the car leaves your lane a few seconds later.
- **Readable**: the turn signal blinks for half a second, then a smooth one-second slide; two seconds between
  moves per car; the whole field at most one change per two cars a second, so it never swarms. Hover a car
  that moved: `buy $42,000 · 6.1× median · 20:21:08`.
- **Dead tape, nobody changes lanes**: that calm is now a signal. Density is still volatility (how many
  cars); movement is flow (how often they move).
- **Red lights stay the car in front's**: the crowd signals amber, never red.
- **Toggleable** (settings → Crowd, on by default). With it on the road gains a lane each side: five in LIVE,
  a shoulder on each side of the lanes in PREVIEW. The two cars that matter are untouched.

## Update 21: the cars are the focus

- **The price is smaller.** It was the biggest thing on the page and covered the mirror on a laptop. It is a
  22 px figure now, at the top; the cars are the focus.
- **Side tags fit.** Every tag carried a −40 px margin for centring over its object; in the side column that
  pushed the first 40 px off the left edge. Side tags have no margin now. The entry tag lost "in profit /
  in loss"; it reads `entry 104.280 · $0.21 behind you`.
- **The right column is wider and its words a point larger on screens over 1500 px.**
- **Pedals say what they do.** GAS · add size, closer to it. HARD GAS · add size, no collateral. BACK OFF ·
  add collateral, more room. BRAKE · close part, the exit. FULL BRAKE · CLOSE EVERYTHING, the exit, in red.
  WITHDRAW · pull collateral, closer to it. CRUISE · trailing stop. The colours say add (green), exit (red),
  danger (orange). The meanings are the same in TRAFFIC and CHASE: closing always buys you room; adding size
  always brings it closer.
- **The mirror is resizable** by the grip under it; it starts a little shorter.
- **Popovers close** when you click anywhere else, so the horizon and ⋯ menus cannot get stuck open.
- **Every load starts in 3D, in CHASE, with the camera just behind your car**; a saved camera inside the
  car is reset.

### Phantom over the LAN, and the traffic switch (Update 21)

- **Other cars** (settings) removes the traffic entirely, leaving you and the car in front. **Crowd** is the
  separate switch for whether the traffic changes lanes on real trades.
- **Phantom freezes on a LAN address** because `http://10.0.0.x:5173` is not a secure origin, and Phantom
  (extension and mobile) only answers on https or localhost: its popup never comes and the connect promise
  hangs. The connect now times out and says so. Two ways through: use the trading wallet (instant signing)
  on the other device, which needs no Phantom; or run `npm run dev:lan:https` and open the **https** address
  the server prints. The certificate is self-signed, so the browser shows a warning once; accept it and
  Phantom connects. The API and the websocket are proxied over the same https origin.

## Update 22: one engine per wallet

- **Phantom and the trading wallet can each hold a position at the same time.** Every connected wallet runs
  its own live engine (its own chain reads, fills, trailing stop). The wallet box lists them, one row each,
  with the position it holds and a button: **RESUME** puts that wallet's position on the road, **use**
  makes a wallet without a position the one Go opens on, **DRIVING** marks the one on the road. Events from
  a wallet that is not on the road arrive as toasts tagged with the wallet; a trading-wallet stop still
  signs itself; a Phantom stop asks you to switch to that wallet.
- **REAL is never blocked by a position.** Only a wallet that already holds one cannot open a second; its
  row says RESUME instead.
- **The PRACTICE / REAL tabs follow the server**, so a resumed real position no longer looks like practice.
- "Back to Phantom" no longer disconnects the trading wallet; it keeps running in the background.

## Update 23: the pedals follow the picture

- **In CHASE the pedals are re-labelled and re-keyed** so the picture and the action agree: **W PULL AWAY**
  closes part (the exit; more room), **⇧W or Space ESCAPE** closes everything, **S LET IT GAIN** adds size
  (it closes in), **C BACK OFF** adds collateral, **X WITHDRAW** pulls collateral (it closes in), **T
  CRUISE** is the trailing stop, and HARD (add size, no collateral) is a button only. In TRAFFIC the pedals
  are as before: gas adds size and closes on the car in front, brake closes size and opens room. Same
  actions underneath, same colours: red is always the exit.
- **Background hovers** (road flow, hills, fog, poles, plain traffic) are behind a setting, off by default;
  crowd cars that moved on a real trade still show their trade.
- **Collateral is free to move, size is not.** Adding or withdrawing collateral costs only the transaction
  fee (no Jupiter fee); it changes your room, not your exposure. Changing size costs 6 bps plus impact each
  way. Jupiter's limits: withdrawing must leave the position under 250× and above its minimum collateral;
  adding must keep it above 1.1×.
