# TRAFFIC — Update 4: Horizon (the time scale of feel)

Supplement to _Update 3_. Changes the single fixed set of EMA windows and render constants into one knob, **horizon**, that scales them together.

## The requirement

Driving gives you something to react to within **1 second** and lets you feel a stretch over **~20 seconds**. TRAFFIC must do the same regardless of whether the trade is a 5-minute scalp, a multi-day hold, or a scalp that gained room and turned into a 2-week ride. One second of screen must always carry "the slice I need to react to," and twenty seconds must always carry "the stretch where I know I'm clear or not."

Today everything is pinned to one implicit horizon (30–60 s smoothing) that is far too slow for a scalp. A tick that should be felt instantly takes a minute to appear.

## Definition

`H` = horizon, in seconds. It is the market duration that should feel like **~20 seconds of driving**. Default for the author's style: **H = 60** (a 1–5 min trade). Everything below derives from `H`.

```
tau_fast     = H / 30                      # impulse EMA.   H=60 → 2 s;   H=3600 → 2 min
tau_slow     = H                           # trend EMA.     H=60 → 60 s;  H=3600 → 1 h
tau_accel    = H / 6                       # trend-accel EMA
ghost_ages   = [H/6, H, H*5]               # the three ghost lanes. H=60 → 10 s / 60 s / 5 min
headway_thr  = {green: H, yellow: H/3, orange: H/12, red: H/60}   # H=60 → 60/20/5/1 s

K_scroll     = K_scroll_base * (60 / H)    # render amplification: slower market per screen-second at long H
K_gap        = unchanged                   # gap is already leverage-scaled; car ahead distance does not change with H
v_road_min   = v_road_min_base             # road always moves; unchanged
tick_lerp    = clamp(H / 300, 0.1, 1.0) s  # how fast animated positions re-sync to truth
```

Headway and gap math are untouched. `H` only decides what counts as "now" and what counts as "the stretch."

## Three ways to set H

1. **Manual.** A horizon control on the panel: `1m · 5m · 15m · 1h · 4h · 1d · 1w` chips plus a slider. Picking a chip re-tunes everything instantly, including the ghost lanes.
2. **Auto from room (default on).** As the gap grows, the horizon widens; as it shrinks, the horizon tightens. This is the "I've got room, let it ride" feeling without touching anything.

   ```
   H_auto = H_base * clamp(gap / gap_at_entry, 0.5, 20)^1.5
   ```

   At entry (gap ≈ gap_at_entry) `H = H_base`. If the gap doubles, `H ≈ 2.8 × H_base` — the camera eases back, the road slows, the ghosts age out, you are cruising on a longer horizon. If the gap halves, `H ≈ 0.35 × H_base` — everything tightens, the road speeds up, the 1-second cue is sharper. Update `H_auto` with a slow lerp (~5 s) so the transition feels like the car settling, not a cut.

   Set `H_base` with the manual control; auto scales from there.

3. **Auto from volatility (optional, off by default).** `H = H_base * (ATR_ref / ATR_now)`. Quiet tape → longer horizon; violent tape → shorter. Can stack with 2. Exposed as a toggle.

## What the driver sees as H changes

|                | Short H (scalp, or gap closing)          | Long H (hold, or lots of room)                             |
| -------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Road           | fast, bright, every tick a visible nudge | slow glide, ticks are texture not events                   |
| Car ahead      | twitchy, brake lights react to seconds   | steady, brake lights react to the trend over minutes/hours |
| Ghost lanes    | 10 s / 60 s / 5 min                      | e.g. 10 min / 1 h / 5 h                                    |
| Headway colors | red under ~1 s                           | red under ~1 min                                           |
| Camera         | low and close, narrow FOV                | pulled back and high, wide FOV                             |
| Sound          | high engine note, busy tire hiss         | low drone                                                  |

Camera height / FOV should follow `H` on the same slow lerp as `H_auto`, so gaining room reads as the camera lifting off the bumper.

## The 1-second guarantee

Independent of `H`, every CEX trade event (Update 3, Fix 3) must produce a visible nudge within one frame and an audible tick if the sound is on. `tau_fast` smooths the _velocity_, not the _event_; the raw event always lands. That is the "within one second I have something to react to" requirement, and it holds at any horizon.

## The 20-second stretch

At `H = 60`, the 60 s ghost lane and the trend-driven car ahead are what the driver watches to feel the stretch. "I'm in the clear and could gas" = the car ahead has been pulling away on `v_slow` for most of the last `H/3`, the headway history strip is solid green, and the 10 s ghost has not crashed. Render that explicitly: when all three hold, the road brightens slightly and the HUD shows a faint **CLEAR** tag. When any one fails, it drops. No numbers needed.

## Settings exposed

`H_base` (chips + slider), `auto_from_room` (on), `auto_from_volatility` (off), `K_scroll_base`, `v_road_min_base`, `H_auto` exponent (1.5), `H_auto` lerp (5 s).

## Checklist

- [ ] All EMA windows, ghost ages, headway thresholds and `K_scroll` derived from one `H`.
- [ ] Horizon chips + slider on the panel; changing it re-tunes ghosts live.
- [ ] `H_auto` from gap ratio, slow-lerped, camera and FOV follow.
- [ ] Raw CEX trade events always produce a same-frame nudge regardless of `H`.
- [ ] CLEAR tag logic.
- [ ] Acceptance: at `H=60` in a moving tape, a single trade against the position is felt within 1 s; after a 2× gap gain with auto on, the road visibly slows and the camera lifts without any input.

# TRAFFIC — Update 5: Legibility (hover + bridge chart)

Supplement to _Updates 3–4_. Purpose: the driver has years of chart/perps experience; the road must let that experience transfer. Every object on the road must be able to say what price it is, and a small conventional chart must show the same objects so the two views are visibly one dataset.

## 1. Hover on everything

Raycast on pointer move (Three.js `Raycaster`). Any hit on an object below shows a tooltip near the cursor; the object highlights. On touch, tap toggles the tooltip. A `?` key (or settings toggle) turns on **label-all** mode: every labelled object shows a small persistent tag.

| Object                    | Tooltip                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Your car                  | `mark 107.521 (Doves) · coinbase 107.510 · P&L −$2.18 (−8.7%) · 107.5x`                                |
| Car ahead                 | `liquidation 108.143 · 0.58% away · 0.622 cl · headway 28 m · trend: holding / braking / pulling away` |
| Yellow line               | `entry 107.434 · 0.087 cl ahead · you are 0.08% from breakeven`                                        |
| Stop car (mirror)         | `trailing stop 106.9 · 0.5% behind · will fill at ~−$X`                                                |
| Ghost (any lane)          | `ghost merged 60 s ago at 107.60 · gap 0.71 · P&L if real: +$3.10 · headway 2 m`                       |
| Lane dashes / road        | `road flow 0.10 cl/s = ATR(14×1m) 0.21% · horizon H=60 s`                                              |
| Brake lights on car ahead | `trend accel −0.012 cl/s² (60 s) · last 1 m: −0.31%`                                                   |
| Road grade (hill)         | `funding −0.0007%/h → paying $0.44/h`                                                                  |
| Fog                       | `spread 1.0 bp · est. slippage $0.06 on close`                                                         |
| Background cars           | `volatility: ATR 0.21% (1 m) · 0.9% (5 m)`                                                             |
| Headway bar segments      | time + value at that moment; click to scrub replay to it                                               |
| HUD tiles                 | formula used, e.g. `gap = L × s × (P − liq) / P` with live numbers substituted                         |

Every tooltip ends with the **time** of the value (`t = 11:50:03.410`, Doves tick) so stale vs live is never ambiguous.

## 2. Bridge chart

A small, dockable, ordinary candlestick chart (lightweight-charts or similar, canvas) in a corner — default bottom-right above the HUD, collapsible, resizable, can pop out to a second window.

- Timeframe chips: `1s · 5s · 15s · 1m · 5m · 15m · 1h · 4h · 1d`. Default follows horizon: `H/60` rounded to the nearest chip (H=60 → 1 s or 5 s).
- Candles built from the local tick buffer (Doves truth, Coinbase for sub-second). No external candle API.
- **Road objects drawn as horizontal price lines on the chart, same colors as on the road:**
  - entry — yellow
  - liquidation — red (the car ahead)
  - trailing stop — blue
  - each ghost's entry — translucent, with its age
  - current mark — white, with the car icon
- Swing highs/lows the road uses for hills marked on the chart as small triangles, so the "crest ahead" on the road is visibly the same swing high on the chart.
- Hovering a line on the chart highlights the object on the road, and vice versa.
- Crosshair on the chart shows `price · time · distance from liq in cl · P&L if you closed here`.
- Click a point on the chart in ghost mode → sets the ghost's entry to that price (limit) — same as scrubbing the road.

The chart is a **translation device**, not a second trading UI: no indicators beyond the lines above, no drawing tools. The goal is that after a few sessions the driver no longer needs it; it should default to collapsed once the driver has closed it three sessions in a row.

## 3. Inspect panel

`I` key or the HUD `⋯` opens a plain table of every live value with its source, formula and timestamp — the full frame object from spec §6.3, formatted. For when the tooltip is not enough.

## 4. Checklist

- [ ] Raycast hover + tooltip on all objects in §1, with timestamps; label-all toggle.
- [ ] Bridge chart with timeframe chips, road objects as price lines, two-way hover link, click-to-set-ghost-entry.
- [ ] Inspect panel.
- [ ] Acceptance: with the chart open and the road visible, the driver can point at the car ahead and the red line on the chart and read the same number on both; a new user can learn what every road object means by hovering, without reading docs.

# TRAFFIC — Update 6: Units policy

Supplement to _Update 5_. Rule: **the metaphor is in the picture, never in the numbers.** Every number a human reads is in USD, SOL, price, %, or seconds. "Car lengths," "cl/s," "ahead/behind," "gap," "headway," "trip odometer," "fuel" do not appear as labels or units anywhere a value is shown. They may remain as internal variable names and in tooltips' _formula_ line only.

## Replacements

| Current                                        | Replace with                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GAP · CAR LENGTHS 0.662`                      | **TO LIQUIDATION** `$0.64 · 0.60% · liq 108.144` (price distance first, % second, liq price third)                     |
| `ENTRY LINE 0.041 AHEAD`                       | **FROM ENTRY** `−$0.02 (−0.02%) · entry 107.456` — sign in P&L direction, red/green                                    |
| `TRIP ODOMETER · P&L`                          | **P&L** `−$0.75 (−4.1%) · after fees −$2.16 · realized −$2.07`                                                         |
| `SIZE · COLLATERAL`                            | **POSITION** `$2,011 (18.71 SOL) · collateral $18.32 · 107.5x`                                                         |
| `FUEL · FREE COLLATERAL`                       | **AVAILABLE** `$977.14 · 9.09 SOL`                                                                                     |
| `HEADWAY 28m`                                  | **TIME TO LIQ** `28 m 10 s at current rate` · `projected ∞` → `projected: not closing`                                 |
| `you 0.100 · ahead 0.100 · road 0.100 cl/s`    | `price −0.12%/min · trend −0.04%/min · liq moving: no` (or `liq moving: +$0.01/min` when collateral/borrow changes it) |
| `drifting back 0.021/s`                        | `moving away from liq $0.013/s (0.012%/s)`                                                                             |
| `CLOSING 0.034/s`                              | `moving toward liq $0.021/s (0.020%/s)`                                                                                |
| `Brake: closed $670.29 (25%), realized $-0.75` | `Closed 25% ($670.29, 6.24 SOL) · realized −$0.75 · remaining $2,011`                                                  |
| `flow moderate`                                | `volatility 0.21%/min (1 m ATR)`                                                                                       |
| `slight uphill (paying funding)`               | `borrow −$0.44/h (−0.0007%/h)`                                                                                         |
| `fog`                                          | `spread 1.0 bp · est. slippage $0.06`                                                                                  |
| `brake lights ahead`                           | `trend turned against you: −0.31% in last 60 s`                                                                        |
| Ghost readout                                  | `if opened 60 s ago at 107.60: P&L +$3.10 · to liq $0.71 · time to liq 2 m`                                            |
| Speedometer dial                               | keep the dial, label it **LEVERAGE 107.5x** (already fine)                                                             |

## Format rules

- Money: `$` with 2 decimals under $1,000, thousands separators above. SOL to 2–3 decimals next to any USD position/collateral figure.
- Price: the asset's native tick precision (SOL 3 dp).
- Percent: 2 dp below 1%, 1 dp above.
- Time: `s` under 60, `m s` under 1 h, `h m` above. Never `∞` — write `not closing`.
- Rates: `/s` for anything under 1 min horizon, `/min` for 1 min–1 h, `/h` above. Pick by current `H`.
- Signs: always in P&L direction. Negative is red, positive is green, regardless of long/short. "Toward liq" is always bad and red.
- Pedal labels: keep the car words on the keys (`gas`, `brake`, `back off`) since they are actions, but the tooltip on each says the exact Jupiter action and the dollar amount it will move: `W gas: add $100 collateral + $10,750 size`, `S brake: close 25% ≈ $670`, `C back off: add $50 collateral → liq moves to 108.60`.
- Toasts after an action: state what happened in USD/SOL/price only, as in the Brake row above.

## Where the car words still live

- The 3D scene (the car, the car ahead, the yellow line, the road, lights, sound).
- Button key names.
- Tooltip formula line (`to_liq_cl = L × s × (P − liq) / P = 0.662`) — shown last, in dim text, for the curious.
- Internal code and the frame object.

## Checklist

- [ ] Every HUD tile relabelled per the table; no `cl`, `cl/s`, `ahead/behind`, `headway`, `odometer`, `fuel` visible as a unit or heading.
- [ ] Format rules applied globally through one formatter module.
- [ ] Pedal tooltips show the exact action and dollar amounts before pressing.
- [ ] Acceptance: a Jupiter user who has never seen TRAFFIC reads every tile correctly on first look.

# TRAFFIC — Update 7: Rewind (drive the past to now)

Supplement to _Updates 3–6_. **Terminology correction first:** the word "ghost" is retired everywhere in the spec, the code and the UI. There are only two cars: **my car** and **the car in front**. Before a trade is placed, my car is simply drawn for the trade I have dialled in (side, leverage, size) as if I had already placed it — that is the whole of what "ghost mode" meant. Call that state **PREVIEW** in the UI. After Go it is **LIVE** (or PRACTICE). Same two cars, same math, only the entry price goes from "would be" to "is." Anything in Updates 3–5 that says "ghost" means "my car in PREVIEW."

## Problem

A chart shows change over time. The road shows only now. The driver cannot see "three days of uptrend, now stalling" from the car. This update puts the past in the driver's seat.

## 1. Rewind

From PREVIEW, press `R` / **Rewind**. Pick:

- **How far back**: `5m · 15m · 1h · 4h · 1d · 3d · 1w`
- **How long the replay takes**: default **45 s** regardless of how far back
- Side / leverage / size: whatever is dialled in

My car is then placed at the price from that far back and **driven forward through the recorded prices to now** in 45 s, with the full road: the car in front, its brake lights, the road scrolling, the hills. No pedals — it is "what holding this trade from then until now would have felt like." When the replay reaches now it eases into real-time PREVIEW in place; the trend is in the driver's body and Go is one press away.

```
t0        = now − lookback
P_entry   = price_at(t0)
speed     = lookback / duration            # e.g. 3 d in 45 s ≈ 5,760×
each frame: t += speed·dt; P = price_at(t); frame = kinematics(P, side, L, size)
H         = lookback / 20                  # Update 4 horizon, so a 3-day replay reads as one smooth drive
```

If my car hits the car in front during the replay it crashes, a post is planted on the road, and it respawns at that price so the drive continues. The number of posts is the information.

### Controls

- Space pause/resume · `←` `→` scrub ±5% · wheel speed ± · click the timeline to jump
- **Timeline bar** along the bottom: the whole lookback, P&L path filled green/red, crash marks, playhead
- `M` drops a flag; flags persist onto the road behind and the bridge chart in LIVE

## 2. Both sides at once (default on)

Run the replay with **two of my car**, side by side in two lanes: one LONG, one SHORT, same leverage. Each has its own car in front. Watch:

- which lane has been pulling away from its car in front, and for how long → the trend
- whether that lane's car in front has started braking in the last stretch → the trend losing steam
- how many posts the other lane planted → how violent the move was

End-of-replay readout, plain units (Update 6):

```
LONG  107x from 3 d ago:  liquidated 4×  · last 6 h −$12.40 · trend: braking (−0.3%/h)
SHORT 107x from 3 d ago:  liquidated 11× · last 6 h  +$9.80 · trend: pulling away (+0.3%/h)
```

Reads as: long has been winning for three days and is now braking; short just started pulling away. Merge short.

Toggle off to replay one side only.

## 3. The road behind you (always on)

The road already driven is the recent past as terrain: hills behind = the climb or drop that just happened; crash posts from the replay; the entry line and flags at their true spots. The mirror panel becomes a small elevation strip — past on the left, my car at the right edge. Hover it for price and time (Update 5). `Q` swings the camera to look back.

## 4. Linked to the bridge chart

The replay playhead and the bridge chart crosshair are one object. Drag on the chart to scrub the replay; the lookback chips set the chart's range.

## 5. The entry sequence this gives

1. **Rewind** a day or three, both lanes, 45 s. Feel which side has been winning and whether it is turning.
2. Land on **now** in PREVIEW. Watch my car against the car in front for a few seconds to feel the current tape.
3. **Go** in the lane that is pulling away.

## Checklist

- [ ] Replace "ghost" with PREVIEW throughout spec, code, UI.
- [ ] Rewind: lookback chips, duration, speed, pause/scrub/jump, timeline with P&L path and crash marks, flags.
- [ ] Two-lane default with per-lane end readout.
- [ ] `H` from lookback during replay; eases to live `H` on landing.
- [ ] Road-behind terrain, mirror elevation strip, crash posts.
- [ ] Playhead ↔ chart crosshair.
- [ ] Acceptance: on a tape with a multi-day uptrend that stalls in the last hours, a 3-day two-lane rewind makes it obvious within 45 s, without reading numbers, that long has been winning and is now braking.
