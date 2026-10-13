# TRAFFIC — Update 11: Conditions panel (the sentence) + cleanup pass

Supplement to _Updates 8–10_.

---

## Part A — CONDITIONS panel

A panel that looks back over seven horizons, scores each one with the same four measures, stacks them, and boils the result down to **one sentence in caps** plus a short reason line. It sits above the Go button so it is the last thing read before pressing.

It is a conditions read, not a forecast: it says where price is in its recent ranges, which way it has been going, how active the tape is, and whether the move looks stretched. Those are the things the driver already reads off a chart; the panel reads them for every horizon at once.

### Horizons

`1m · 15m · 1h · 4h · 1d · 1w · 1y`. Three groups: **local** (1m, 15m, 1h), **mid** (4h, 1d), **long** (1w, 1y).

### Four measures per horizon

All computed from candles of that horizon's natural resolution (1m uses 1 s bars, 1y uses 1 d bars). `ATR_h` is the ATR of that horizon's bars.

```
range_pos   = (P − low_h) / (high_h − low_h)             # 0 = at the low, 1 = at the high
trend       = slope of EMA(close, n) over the window, in ATR_h per window   # +up / −down; |trend| < 0.5 = flat
activity    = ATR_h(now) / ATR_h(average over 10× window) # 1 = normal; < 0.6 quiet; > 1.6 hot
stretch     = (P − EMA(close, n)) / ATR_h                 # how many ATRs above/below the mean; |stretch| > 2 = extended
accel       = d/dt of trend (last 20% of window vs the prior 80%)   # is the move speeding up or fading
```

Per-horizon classification:

| Measure         | Labels                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| range_pos       | `at lows` (< 0.2) · `low` · `mid` · `high` · `at highs` (> 0.8)                                       |
| trend           | `falling` · `flat` · `rising`                                                                         |
| activity        | `dead` · `quiet` · `normal` · `active` · `hot`                                                        |
| stretch + accel | `stretched up, fading` · `stretched up, still going` · `stretched down, fading` · … · `not stretched` |

### The stack → one sentence

Rules evaluated top to bottom; first match wins. `N×` is the current leverage.

```
1. ACTIVITY GATE
   if activity(1m) is dead/quiet AND activity(15m) is dead/quiet:
      "WAIT · MARKET TOO QUIET FOR N× TRADES"
      reason: "1m range $0.04 · fees would eat a 0.05% move"

2. STRETCHED TOP, FADING  (short setup)
   if range_pos(15m or 1h) is at highs AND stretch(1h) > 2 AND accel(1h) < 0 AND activity ≥ normal:
      if range_pos(1d) or (1w) is also high/at highs:
         "SHORT · LOCAL AND LONG-TERM TOP · MOVE FADING"
      else:
         "SHORT · LOCAL TOP IN A LARGER DOWNTREND"   (if trend(1d) falling)
         "SHORT · LOCAL TOP · LARGER TREND STILL UP · TAKE PROFIT QUICK"   (if trend(1d) rising)

3. STRETCHED BOTTOM, FADING  (long setup) — mirror of 2.

4. STRONG MOMENTUM, NOT FADING
   if |stretch(1h)| > 2 AND accel(1h) > 0:
      "WAIT · <UP/DOWN> MOVE STILL ACCELERATING · DON'T FADE IT"
      (or, if the driver's side matches the direction: "<LONG/SHORT> WITH THE MOVE · TIGHT · IT CAN TURN FAST")

5. TREND, NOT STRETCHED
   if trend(1h) and trend(4h) agree and |stretch| < 1:
      "<LONG/SHORT> WITH THE TREND · PULLBACK ENTRY · <RISING/FALLING> ON 1H AND 4H"

6. MID-RANGE, NORMAL ACTIVITY
      "NO EDGE · MID-RANGE ON EVERY HORIZON · WAIT FOR A SPIKE"

7. CONFLICT
   if local and long disagree strongly (e.g. 15m at highs, 1w at lows, both stretched):
      "MIXED · LOCAL TOP, LONG-TERM BOTTOM · SHORT ONLY WITH A SHORT HORIZON"
```

Every sentence is followed by a reason line in plain units, e.g.
`15m: at highs (0.93) · 1h: +2.4 ATR above mean, fading · 1d: high (0.81) · activity 1.7× normal`.

The side word in the sentence is coloured (SHORT red, LONG green, WAIT yellow). If the sentence's side matches the driver's selected side, the Go button gets a thin matching outline; if it conflicts, the Go button shows the sentence's side word beside it. The driver can always press Go either way.

### The grid under the sentence

Seven rows, one per horizon, four columns, all glanceable:

```
      position in range        trend     activity   stretch
1m    [·······●··]  high       ↗ rising  ▮▮▮▯▯ hot   +1.2 ATR
15m   [·········●]  at highs   ↗ rising  ▮▮▮▯▯       +2.6 ATR fading
1h    [········●·]  high       → flat    ▮▮▯▯▯       +2.1 ATR fading
4h    [·····●····]  mid        ↗ rising  ▮▮▯▯▯       +0.4
1d    [········●·]  high       ↗ rising  ▮▯▯▯▯ quiet +1.1
1w    [···●······]  low        ↘ falling ▮▮▯▯▯       −0.8
1y    [·●········]  at lows    ↘ falling ▮▮▯▯▯       −1.4
```

The range bar is the horizon's low→high with the current price as the dot; the colours follow the same rule as everywhere (red = toward the side that would hurt the selected trade). Hover any cell for the numbers and the formula.

### Data

- 1m / 15m / 1h from the local tick buffer and locally aggregated candles (already there).
- 4h / 1d / 1w / 1y need history the buffer does not have: **one backfill per horizon at startup** from a CEX candle REST endpoint (Coinbase candles: 1 request per resolution), cached to disk, then maintained from the live stream. One-time cost, no polling.
- Recompute: 1m/15m rows every tick; 1h every 10 s; 4h–1y every minute. Sentence re-evaluated whenever any row changes class.

### Replay honesty

The sentence is logged with every frame. In Rewind and replay the panel shows what it would have said at that moment, so the driver can see how often it was right for them. Over time this is the thing that earns or loses its place on the screen.

---

## Part B — Cleanup from the three screenshots

1. **Sign mismatch:** `P&L −$0.22 (+20.2%)` and `−$1.22 (+15.7%)`. The `$` is after fees, the `%` is gross on collateral. Both must share one basis: after fees. `−$0.22 (−1.0%)`. Gross goes to a dim second line only.
2. **Top bar overflow.** `MODE · R…`, `···`, `driver seat`, `3D`, `driver cam` overlap and bleed into the red REAL border. One chip row, overflow into `···`, never two rows, 8 px inset from the border.
3. **REAL selectable while Phantom is not connected.** `REAL` is disabled (greyed, tooltip "connect Phantom") until a wallet is connected. The red border appears only when REAL _and_ connected.
4. **Top-down label collisions.** `liq 107.382 · not closing` overlaps `…07.391 · not closing`; `if Go 21 s ago: −$5.` is truncated under the next tag; four `liq` tags stack at the bottom right. Labels get collision avoidance (push apart vertically, leader line to the car) and truncate with ellipsis never under a neighbour. In top-down the `liq` labels go on the left margin aligned to the car's row, one per lane, never floating.
5. **A tooltip is stuck on screen** (`road flow 3.6%/min … t = 15:12:08`) covering the P&L tile in all three shots. Tooltips follow the cursor and disappear on mouse-out; the `I` inspect panel is the pinned version and is a drawer, not a floating box.
6. **Strip legend too dense.** Under the strip: `last 1 m · ● safe · ● < 21 s · ● < 7 s · ● < 1.8 s` on one line; drop "history" and "white = value (log)" into the hover.
7. **Panel title duplicates the value.** `TIME TO LIQUIDATION · PREVIEW · NOT CLOSING` then `not closing` in 40 px. Title is `TIME TO LIQUIDATION` only; the PREVIEW tag goes top-left with the mode chips; the value is said once.
8. **Lane list is a wall.** Six entries × four lines of mixed red. Make it a six-row table, one line each:
   `LONG  if Go 1 m 45 s ago  entry 107.201  −$0.22 (−1.0%)  to liq $0.14  liquidated 4×  2 m 41 s`
   Row click focuses the lane. Side word coloured, the rest white; red only on the time-to-liq cell when under threshold.
9. **`Collateral after fees $22.12 · 303.0x`** when the slider says 250x — correct but surprising. Label it `effective 303× after fees` so it reads as intended.
10. **Big price in the lane view** (`107.328` 60 px in the road area) is fine in the driver's seat but in top-down it sits on top of the lanes. Move it to the chip row in top-down.
11. **Street-light flares** are still on in the driver's seat (Update 9 C). Remove.
12. **Bridge chart axis**: `107.149` label is cut at the bottom right; pad the axis 12 px.

## Checklist

- [ ] CONDITIONS panel: seven horizons × four measures, rule stack, sentence + reason, grid, hover, logging into replay.
- [ ] Startup candle backfill for 4h–1y, cached.
- [ ] B1–B12.
- [ ] Acceptance: on a tape that has run up for an hour and is now flattening at a 15m high with normal activity, the panel reads a SHORT sentence with a correct reason line within one recompute; on a dead tape it reads WAIT; P&L $ and % always share a sign.
