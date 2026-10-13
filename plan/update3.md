# TRAFFIC — Update 3: Make it move

Supplement to _TRAFFIC build spec v1_, _Update 1_, _Update 2_. This update is about **feel**. The current build is mathematically right and perceptually dead: the ghost never changes position relative to the car ahead, and the road barely scrolls. This update fixes the three causes and then specifies the effects that sell relative motion.

---

## 1. Diagnosis (from the current build)

Observed on screen: `you 0.023 · ahead 0.023 · road 0.023 cl/s`, `drifting back 0.000/s`, gap pinned at 0.82.

Three causes:

1. **The ghost re-anchors every tick.** With entry = "market at current mark," the ghost's entry price is reset to `P` on every tick, so `gap` is always the at-entry gap and `v_gap` is always zero. The ghost is welded to the car ahead. Nothing it shows depends on what the market is doing.
2. **Velocity is over-smoothed.** A 30 s EMA of price velocity on a normal tape yields ~0.01–0.03 cl/s. At any sane render scale that is stationary. The 30 s window is right for _headway_ (a stable alarm) and wrong for _motion_ (the thing you feel).
3. **The primary feed is too slow to animate.** Doves updates on the order of once per second. Between updates the renderer has nothing, so everything holds still and then steps.

Each gets its own fix below. All three are required.

---

## 2. Fix 1 — Ghosts have an age

A ghost is a car that **merged N seconds ago** at whatever the mark was then. Its entry price is frozen at that moment; only its gap, speed and headway are recomputed live. This is the question the driver actually wants answered: _"if I'd pressed Go a moment ago, where would I be now?"_

```
ghost.t_entry   = now - age                       # age in seconds, fixed per ghost
ghost.P_entry   = price_at(ghost.t_entry)         # from the tick ring buffer; frozen
ghost.liq       = liq_formula(ghost.P_entry, L, s, collateral)
ghost.gap       = L * s * (P - ghost.liq) / P     # now actually changes as P moves
ghost.v_gap     = L * v_price_fast                # see Fix 2
...everything else as before
```

### Default: three ghosts in three lanes

| Lane   | Age   | What it shows                                                             |
| ------ | ----- | ------------------------------------------------------------------------- |
| Right  | 10 s  | What the last few ticks did to you. Twitchy.                              |
| Center | 60 s  | The last minute. This is the "feel of the tape right now." Default focus. |
| Left   | 5 min | The trend. Is this side being rewarded over the recent past?              |

All three use the driver's current side / leverage / size. Changing the leverage slider instantly re-places all three cars ahead. Changing side flips all three.

### Rolling re-merge

Each ghost's age is fixed, so its entry time slides forward with the clock (`t_entry = now − age`). Its entry price is therefore the mark from exactly `age` seconds ago, read from the ring buffer each tick. The effect: the 60 s ghost is always "a position opened one minute ago," continuously. The driver watches it get rewarded or punished in real time and never has to reset anything.

### Go

Go opens at the current mark (or the scrubbed limit), as before. The ghost lane the driver has focused becomes the real car; the other ghost lanes fade out. The real car then has a real, frozen entry and behaves exactly like a ghost of growing age — no code path difference.

### Liquidated ghosts

If a ghost's gap reaches 0, it crashes: it is shown hitting the car ahead, then respawns at the current mark after 2 s. Watching the 10 s ghost crash twice in a minute **is** the information: this leverage, this side, this tape = you would already be dead.

---

## 3. Fix 2 — Two timescales: trend and impulse

Replace the single 30 s velocity EMA with two, and split the motion between the two cars.

```
v_fast  = EMA(d/dt (s * ln P), window 2 s)        # impulse: what the last few ticks did
v_slow  = EMA(d/dt (s * ln P), window 60 s)       # trend: where the tape is going
a_slow  = EMA(d/dt v_slow, window 10 s)           # trend acceleration — "the car ahead is braking / pulling away"

v_impulse = v_fast - v_slow                       # the residual

# Motion assignment
v_ahead_rel = +L * v_slow                         # car ahead moves with the TREND (relative to road flow)
v_you_rel   = -L * v_impulse                      # you move with the IMPULSE (relative to road flow)
                                                  # note: v_ahead_rel - v_you_rel == L * v_fast == v_gap. Gap math unchanged.

# Headway stays on the stable signal
headway_s       = gap / max(0, -L * v_fast)       # uses v_fast so the alarm is responsive
headway_proj_s  = solve gap = v_close*t + 0.5*a_close*t^2 with v_close from v_fast, a_close from a_slow
```

What this produces:

- **Trend in your favor:** the car ahead steadily pulls away. Room opens. You are gliding.
- **Trend against you:** the car ahead is braking — its brake lights come on and stay on, proportional to `−a_slow`. You can see it well before the gap closes. This is the "traffic slowing ahead, ease off early" cue.
- **Sharp reversal against you** (`a_slow` below a threshold, or a single tick with `|v_impulse|` above a threshold): **slam**. Brake lights flash to full, the car ahead visibly drops back toward you.
- **A tick against you:** _you_ lurch forward — a surge as if your foot slipped onto the gas.
- **A tick for you:** you ease off — a drag deceleration.
- **No ticks / flat:** your impulse decays to zero over ~2 s (the EMA) and you settle back into flow. That is friction and coasting; it is free.

Thresholds (tunable, exposed in settings):

```
slam_a       = -0.02 cl/s^2       # a_slow below this => brake-light flash + camera jolt
lurch_v      =  0.05 cl/s         # |v_impulse| above this => your-car surge/drag jolt
```

---

## 4. Fix 3 — A fast tick source for animation

Doves remains the **truth** feed: liquidation price, gap, headway, P&L, and every number on the HUD come from it. But it updates ~1/s, which is too coarse to animate.

Add a **fast feed** for animation only: a centralized-exchange trade stream for the same asset (Coinbase or Binance SOL-USD(T) trades over websocket — hundreds of events per second in a busy tape, tens in a quiet one). The build already shows `coinbase +0.8bp`, so the connection exists.

```
P_truth  = Doves                           # drives: liq, gap, headway, P&L, all HUD numbers
P_fast   = CEX trades, offset-corrected    # drives: v_fast, v_impulse, road scroll, car jitter, sound

offset   = EMA(P_truth - P_fast, 30 s)     # keeps P_fast centred on Doves
P_anim   = P_fast + offset
```

- On every CEX trade: update `v_fast`, nudge the ghosts' and car-ahead screen positions, pulse the road.
- On every Doves tick: snap the truth values, and gently re-sync the animated positions to truth over ~200 ms (lerp). The driver sees continuous motion with periodic confirmation, not a 1 Hz step.
- If the CEX stream drops, fall back to interpolating between Doves ticks. Never freeze.

Still one subscription per source, shared by all clients. The fan-out websocket emits both `truth` and `anim` events.

---

## 5. Render scale

Numbers in car-lengths/s are tiny; the renderer must amplify, not display raw.

```
scroll_px_per_s  = v_you_screen * K_scroll     # K_scroll default 400 px per cl/s at 1080p — tune until a 0.05 cl/s impulse is unmistakable
car_ahead_z      = gap * K_gap                  # K_gap default 60 m per car length; gap 1.0 => 60 m ahead
```

Plus a nonzero **road flow** at all times so the world is never still:

```
v_road = max(v_road_min, k * L * ATR_rate)      # v_road_min default 0.10 cl/s — lane dashes always move
```

Everything is relative to flow, so a floor on flow does not change the gap math; it only guarantees the road is alive.

---

## 6. Effects that sell relative motion

These are the next-pass renderer requirements, in priority order.

1. **Road scrolls at your speed, always.** Lane dashes, asphalt texture, roadside posts all move at `v_road + v_you_rel`. Speeding up and slowing down must be visible in the ground even when the car ahead is holding.
2. **Car ahead brake lights** with bloom. Intensity continuous from `clamp(-a_slow)`. Hard flash + a small back-step on slam.
3. **Camera pitch.** Nose-up on your surge, nose-down on your drag and on braking. ±1–2° is enough.
4. **FOV with speed.** Widen ~5° at high `v_you`, narrow when slowing.
5. **Edge motion blur / speed lines** scaled to `|v_you|`.
6. **Background traffic** in other lanes drifting at `v_road ± noise`, density from ATR. You read your speed against them, not only against the one car.
7. **Headway shake.** Subtle under 10 s, strong under 5 s. Stops when headway clears.
8. **Sound.** Engine drone pitched to leverage, rising with `v_you`; tire hiss rising with `v_road` (volatility); brake-light slam gets a short squeal; headway alarm is a rising tone, not a beep.
9. **Coast feel.** Nothing snaps. Every quantity that drives a visual is lerped at ~100–200 ms so lift-off, drag and friction read as decay, not steps.
10. **Ghost crash.** Impact, fade, respawn at the mark. Make it legible from peripheral vision.

---

## 7. Checklist for the next pass

- [ ] Ghost entry frozen at `price_at(now − age)`; three default lanes (10 s / 60 s / 5 min); ghost crashes and respawns.
- [ ] `v_fast` (2 s) and `v_slow` (60 s) EMAs; car ahead moves with trend, you move with impulse; slam and lurch thresholds.
- [ ] CEX trade stream as animation feed, offset-corrected to Doves; lerp re-sync on each Doves tick.
- [ ] `K_scroll`, `K_gap`, `v_road_min` exposed in settings.
- [ ] Effects 1–5 at minimum; 6–10 if time.
- [ ] Acceptance test: in a quiet tape the road still visibly moves; in a moving tape the 60 s ghost's car ahead is visibly pulling away or closing within seconds of opening the page, and a 1%-in-a-minute move at 63x is unmistakable without reading any number.
