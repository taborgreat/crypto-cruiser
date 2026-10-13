# TRAFFIC — Update 8: Bird's-eye for the entry decision

Supplement to _Updates 3–7_. The lanes stay (the "pressed Go 10 s / 1 m / 5 m ago" cars are useful). Two fixes make them readable.

## 1. Why the three cars in front look identical

They are at different distances, but in a flat tape the differences are a cent. In the screenshot the three entries are 108.199 / 108.211 / 108.196 — price moved ~0.01% in five minutes, so the three liquidation cars sit ~$0.01 apart. From the driver's seat that is sub-pixel. The lanes are correct; the view cannot show it.

## 2. Bird's-eye view in PREVIEW (default)

Before Go, the camera is **top-down**, looking straight down at the road, my car(s) at the bottom of the screen, the cars in front above them. After Go (or on `V`), it drops into the driver's seat. Rewind uses whichever view is active.

```
PREVIEW  → top-down   (spacing is the question)
LIVE     → driver seat (closing speed is the question)
V        → toggle any time
```

### Scale

Top-down uses its own distance scale, auto-fit so the differences are visible:

```
gaps        = [gap_10s, gap_1m, gap_5m]            # in price $ (Update 6 units)
spread      = max(gaps) − min(gaps)
scale_px    = fit so that spread spans ≥ 25% of the view height, min 1 px per $0.001
```

With a $0.01 spread the view zooms in until the three cars are visibly staggered; with a $2 spread it zooms out. A scale bar on the side shows the current `$ per screen-cm`and the`%` equivalent, so zoom level is never ambiguous.

### What is drawn, top-down

- Lanes labelled in plain words: **`if Go 10 s ago` · `if Go 1 m ago` · `if Go 5 m ago`** (no "H/6", no "ghost").
- My car in each lane at the bottom; its P&L next to it in $ and %.
- The car in front in each lane at its true distance (scaled); the distance printed between the two cars: `$0.38 · 0.35%`.
- A **brake-light glow** on each car in front sized by trend-against-you (Update 3).
- The entry line (yellow) across each lane at its true position.
- Both sides at once (toggle, default on in PREVIEW): three LONG lanes on the left half, three SHORT lanes on the right half, mirrored. Six cars, one glance: which side has more room and which side's room is growing.
- A thin **trail** behind each car in front showing where it was over the last `H`: a trail pointing away from me = pulling away; toward me = closing. This replaces needing to watch for motion.

### Motion still matters here

Top-down is not a static table. Road texture scrolls at the flow speed, cars nudge on every tick (Update 3), trails grow. The driver watches the six spacings change for a few seconds, then picks a lane.

### Pick and Go

Clicking a lane focuses it; **Go** opens at the current price in that side/leverage; the camera swoops from top-down into that lane's driver seat as the trade fills. The other five lanes fade.

## 3. Lane panel cleanup

Remove the per-lane checkboxes, "auto", "focus", "H/6" and the explanatory paragraph. Each lane is one row:

```
if Go 5 m ago   entry 108.199   P&L −$1.69 (−6.9%)   to liq $0.38 (0.35%)   not closing
```

Clicking the row focuses the lane. Lookbacks are set once in settings (default 10 s / 1 m / 5 m, scaled by `H`).

## Checklist

- [ ] Top-down camera as PREVIEW default; `V` toggles; swoop into driver seat on Go.
- [ ] Auto-fit spacing scale with visible scale bar.
- [ ] Six-lane both-sides layout with distances printed, brake glow, entry lines, trails.
- [ ] Lane panel reduced to one row per lane in plain words.
- [ ] Acceptance: in a flat tape the three cars in front are visibly staggered and the scale bar reads cents; in a moving tape the trails make it obvious which side's cars are pulling away, within a few seconds, from above.

# TRAFFIC — Update 9: Layout, visual cleanup, efficiency

Supplement to _Update 8_. Based on the two latest screenshots (PREVIEW with lanes; LIVE after a fill and a partial close). Numbered so the builder can tick them off.

## A. Things that are wrong on screen

1. **Positive P&L shown in red.** `+$0.88 (+3.6%)` and `+$0.49 (+2.7%)` are red because the colour follows the after-fees number. Fix: the **headline** P&L is after fees (that is the number that matters), coloured by its own sign; the gross number goes underneath, dimmer: `−$1.65 after fees` big, `gross +$0.49 · realized −$0.72` small. Never colour a number by a different number.
2. **Lane labels garbled across the road.** `SHORT · 5m15ago SHORT · 1m1agoSHO` is three labels overlapping. Lane labels are small billboards floating above each car in front, facing the camera, `if Go 5 m ago`, one per lane, and only in top-down. In the driver's seat the focused lane shows no label at all.
3. **Toasts stack over my car.** `Opened…`, `Filled…`, `♫ Consumed…`, `Closed 25%…` sit in a pile on the hood. Toasts go to a **single column, top-left under the status chips**, newest at top, auto-dismiss 6 s, max 3 visible, click to pin. Fill confirmations and closes are the only toasts; the music player is its own tiny widget bottom-left, not a toast. Nothing is ever drawn over the road between my car and the car in front.
4. **Bridge chart covers the road.** It takes the right third and hides the lane. Dock it as a **bottom drawer** across the full width, default height 160 px, drag to resize, `B` toggles, and it collapses to a 24 px strip showing just the price lines when closed. The road is never occluded.
5. **Road Behind and Bridge Chart duplicate each other.** Road Behind becomes the mirror's elevation strip only (Update 7 §2) at fixed 120 × 48 px top-right; the bridge chart is the chart. One timeline, two sizes.
6. **HUD tiles clip on the right** (`AVAILABLE AFTER ENT…`). Tiles are a flex row that always fits the width: at narrow widths drop `POSITION` and `AVAILABLE` into the left panel. Order by importance: `TO LIQUIDATION · P&L · FROM ENTRY · POSITION · AVAILABLE`.
7. **Pedal bar overlaps the HUD tiles.** Pedals get their own 48 px row below the tiles, nothing overlapping.
8. **Status chips wrap badly** top-left (`H 1 m 0 s · auto` collides with `PRACTICE`). One row of chips, ellipsise, never wrap; overflow goes into `···`.
9. **Chart axis labels collide** (`S 1m ago / mark / 108.21 / S 10s ago / S 5m ago` on top of each other). Group labels closer than 14 px into one stacked tag with a leader line; `mark` always wins the collision.
10. **`169.0x ghost`** on the speedometer → `169.0x` with a small `PREVIEW` tag under it (Update 7 terminology).
11. **Time-to-liquidation colour is always green.** The number and the bar follow the Update 4 thresholds (green / yellow / orange / red by `H`), and the bar's history segments already do — make the big number match.

## B. Layout, final

```
┌ status chips (1 row) ───────────────────────────── view buttons ┐
│ toasts (col, max 3)                             mirror strip     │
│                                                                  │
│                  [ road / top-down ]                             │
│                                                                  │
│ leverage dial    TO LIQ · P&L · FROM ENTRY · POSITION · AVAIL    │
│ pedals (1 row)                                                   │
└ bridge chart drawer (collapsible, full width) ───────────────────┘
left panel: side / asset / size / leverage / entry / lanes (1 row each) / Go / Rewind — scrolls independently, never overlaps the road
```

Rule: the centre column from my car to the car in front is always clear. Everything informational lives on the edges.

## C. Visual polish

- One accent colour per meaning, everywhere: **red = toward liquidation / loss**, **green = away / profit**, **yellow = entry**, **blue = stop**, white = neutral. The speedometer arc is currently red at all leverages; make it white, and only tint red when `time to liq` is red.
- Numbers in the HUD use a tabular monospace figure font so they don't jitter as digits change.
- Headline numbers 28 px, support text 12 px, labels 10 px uppercase tracked. No tile has more than three lines.
- Brake lights on the car in front get bloom; nothing else does. The road, posts and skyline stay flat so the brake lights are the brightest thing on screen.
- Remove the roadside light-post flares in the driver's seat — they compete with the brake lights and cost fill rate.
- Toasts and tiles share one panel style: 12 px radius, 1 px border at 20% white, 70% black fill, blur 8 px.

## D. Efficiency

- **One websocket message per animation frame.** Server batches ticks; client applies the latest per source on `requestAnimationFrame`. No per-tick DOM writes.
- HUD and chart are DOM/canvas-2D, not WebGL text; update at most 10 Hz for text, 60 Hz for the headway bar and dial needle.
- `document.hidden` → pause the render loop and chart; keep the websocket; resume with a snap.
- Buildings, posts, lane dashes as **instanced meshes**; skyline windows as one texture, not geometry. Target < 300 draw calls.
- Cap pixel ratio at 1.5; render at 60 fps max; expose `low` quality preset (no bloom, 30 fps) in settings.
- Tick ring buffer as a typed `Float64Array` (t, price) of fixed length; candles aggregated incrementally, never recomputed from scratch.
- Rewind reads from the same buffer; if the lookback exceeds the buffer, load the JSONL log for that range once and cache.

## Checklist

- [ ] A1–A11 fixed.
- [ ] B layout; centre column always clear.
- [ ] C colour and type rules applied through one theme file.
- [ ] D: per-frame batching, hidden-tab pause, instancing, draw-call budget, quality preset.
- [ ] Acceptance: at 1080p nothing overlaps, nothing clips, positive P&L is green, the road between the two cars is empty, and the page idles under 30% of one core with the chart open.

# TRAFFIC — Update 10: Make the headway strip and the mirror legible

Supplement to _Update 9_. Two widgets exist but explain nothing.

## 1. The strip under TIME TO LIQUIDATION

What it is: the last `H` seconds of time-to-liquidation, left = oldest, right = now, coloured by the threshold at that moment. It currently has no label, no axis, no legend, so it reads as decoration.

Fix:

- Caption directly under it, 10 px: **`last 60 s · green safe · yellow < 20 s · orange < 5 s · red < 1 s`** — the thresholds printed from the live `H`, so the legend is always true.
- Tick marks at the left edge (`−60 s`), middle (`−30 s`), right (`now`).
- Height 10 px → 16 px so the colours are readable.
- A thin white line drawn **over** the colours tracing the actual time-to-liq value on a log scale (∞ at the top, 0 at the bottom). Colours tell you _the state_, the line tells you _the shape_ — rising line = room opening, falling = closing.
- Hover shows `t −23 s · 1 m 40 s to liq · $0.31 away`. Click jumps the bridge chart crosshair there.
- Red segments also leave a small tick on the road behind (a post), so the strip and the mirror agree.

Rename the panel title to **TIME TO LIQUIDATION · 57 s** and the strip caption to **history** so the two are not confused.

## 2. The mirror (ROAD BEHIND)

What it is now: a purple line (price), a dashed yellow line (entry), a red line (liquidation), a cyan dot (now) — none of it labelled, and the layout reads like a second chart.

Fix: make it an actual rear-view mirror with three things in it, each labelled.

```
┌ MIRROR · last 7 m 47 s ───────────────────────────────┐
│  entry line    $0.05 behind you · 108.300             │
│  trailing stop none    [T to set]                     │
│                                                       │
│   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ entry ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │  ← yellow dashed, labelled on the line
│   ~~~~~~~~~~~~~~ you ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~●   │  ← white price trail ending at a car icon = now
│   ──────────── liquidation ──────────────────────────  │  ← red, labelled on the line
│  −7 m                      −4 m                   now │  ← time axis
└───────────────────────────────────────────────────────┘
```

- **Price trail is white** (purple means nothing; white = me, same as the road).
- Every line carries its own label on the line, right-aligned, so there is no legend to learn.
- **Orientation matches the road**: above the price trail = toward liquidation (for the current side), below = away. So for a short, liquidation is drawn above; for a long, below. The driver never has to think about which way is bad — up is always toward the car in front, as on the road.
- Vertical scale auto-fits entry, liquidation and the price range so all three are visible; a `$` scale on the right.
- Time axis along the bottom with three ticks; span = `10 × H` (Update 7).
- The cyan dot becomes a small car icon with the live price next to it.
- Posts (red ticks) at moments the headway strip was red.
- Hover: `−3 m 10 s · 108.27 · $0.33 to liq · P&L then +$0.80`.
- Trailing stop, when set, is a blue line labelled `stop` with its price; the `T` hint stays until one exists.

## 3. One rule for both

Any line, bar or dot on screen carries its label **on itself** or within 10 px. No unlabelled colour anywhere. If the builder cannot fit a label, the element is too small to be useful and should be removed.

## Checklist

- [ ] Strip: caption with live thresholds, time ticks, 16 px tall, white value line, hover, click-to-chart.
- [ ] Mirror: white trail, on-line labels, liq-is-up orientation, auto-fit $ scale, time axis, car icon with price, red posts, hover, stop line.
- [ ] Label-on-element rule applied to every widget.
- [ ] Acceptance: a first-time viewer can say what the strip and the mirror show without being told.
