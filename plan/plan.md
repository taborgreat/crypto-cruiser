# **TRAFFIC**

A driver's-seat simulator for leveraged perp positions on Solana (Jupiter Perps)

Build specification v1 - October 2026 - author: Tabor Holly

## **1. What this is**

A local program that connects to live Solana market prices and renders an open leveraged position as **driving on a freeway in traffic** . The driver does not steer. The driver watches the car ahead, the mirror, and the speedometer, and decides moment by moment whether to ease on the gas, back off, brake, or stop. Everything on the road is moving; what the driver feels is the _relative_ motion.

The goal is not a chart in disguise. It is a different sensory channel for the same information: distance-to-liquidation, how fast that distance is changing, and how much room there is to act. The author already uses this model mentally while trading 50x-150x shorts in 1-2 hour sessions. The program makes it explicit, live, and eventually executable.

Priority order for the builder: **(1) the math and data loop, (2) a flat 2D line view that proves it, (3) the 3D road, (4) extra market-data layers, (5) live execution.** If only step 1 and 2 ship, that is a success.

## **2. The core mapping**

| **Driving thing**                 | **Trading thing**                                     | **Notes**                                                                                             |
| --------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Your car                          | Current mark price                                    | Camera is always on your car. You never leave the<br>center of the view.                              |
| Car directly ahead                | Liquidation price                                     | The thing you must not hit. Hitting it = liquidation =<br>session over.                               |
| Freeway flow / all cars<br>moving | The market moving through time                        | Nothing is parked. Every car rides the road's flow.                                                   |
| Your speedometer                  | Leverage                                              | Higher leverage = faster cruise. 50x: a few cents is a lot<br>of road. 100x: twice that.              |
| Gap to car ahead                  | Distance from mark to<br>liquidation, leverage-scaled | The primary thing the driver watches.                                                                 |
| Headway (seconds)                 | Seconds until liquidation at<br>current adverse rate  | The single most important number on screen. See 3.4.                                                  |
| Drifting back from car<br>ahead   | Price moving in your favor                            | Feels like slowing down even though the car ahead kept<br>its speed. This feeling is the whole point. |
| Closing in on car ahead           | Price moving against you                              | Feels like accelerating toward its bumper.                                                            |
| Painted line behind you           | Entry price (breakeven)                               | Once it is in the mirror you are in profit. Trip odometer =<br>unrealized P&L.;                       |
| Car behind you (optional)         | Trailing stop                                         | Follows at a fixed distance. If price snaps back hard you<br>get rear-ended = stop fills.             |
| Fuel gauge                        | Free collateral in the account                        | How much more gas you could give.                                                                     |

| **Driving thing**                       | **Trading thing**                     | **Notes**                                                                   |
| --------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| Gas pedal                               | Add size / add collateral             | See section 4.                                                              |
| Brake pedal                             | Partial close                         | Braking is always a sell. Light brake = partial, full brake =<br>close all. |
| Backing off (lifting foot,<br>coasting) | Add collateral without adding<br>size | Leverage drops, car ahead recedes. Jupiter supports<br>this. Underused.     |

## **3. Kinematics (the math the builder implements)**

All quantities below are computed every tick (target 100-250 ms, driven by the price feed). Direction is normalized so the math is identical for longs and shorts: define **s = +1 for a long, -1 for a short** .

### **3.1 Base quantities**

```
P = current mark price
P_entry  = entry price of the position
P_liq = liquidation price (from Jupiter for live, from paper engine for practice)
L = effective leverage = position_size_usd / collateral_usd
s = +1 long, -1 short
```

```
fav(t)   = s * (P - P_entry) / P_entry # favorable move, as a fraction (+ = in profit)
gap_pct  = s * (P - P_liq) / P # raw distance to liquidation, fraction of price (always > 0 while alive
)
gap = L * gap_pct # LEVERAGE-SCALED GAP. ~1.0 at entry, 0 at liquidation.
 # This is 'car lengths'. Position-independent and leverage-independent at entry.
```

Because liquidation sits roughly 1/L away from entry (minus fees and maintenance margin), the leverage-scaled gap starts near 1.0 for every position. A 50x and a 100x position look the same at entry; they differ in how fast the gap moves. That is exactly the 'speed = leverage' intuition.

### **3.2 Velocities**

```
v_price(t) = EMA-smoothed d/dt of (s * ln P) # favorable price velocity, in fraction/second
             window: default 30 s, user-adjustable 5 s - 120 s
```

```
v_gap = L * v_price # how fast the gap is OPENING (positive = good)
v_close = -v_gap # how fast you are closing on the car ahead (positive = bad)
```

```
a_gap = EMA-smoothed d/dt of v_gap # 'my car changing speed on its own' - price acceleration x leverage
```

### **3.3 The freeway frame (what makes it feel like traffic)**

Every car moves with the road. The road scrolls at a base flow speed; relative motion between cars carries the signal.

```
v_road = k * L * ATR_rate # base freeway speed. ATR_rate = recent avg |price velocity|.
 # Higher leverage or more volatility = faster freeway. k is a tuning constant.
v_ahead = v_road # the car ahead cruises at flow speed
v_you = v_road - v_gap # you are slower than it when price favors you (you drift back),
 # faster than it when price goes against you (you close in)
speedometer shows: L as the needle, with v_you as a small relative-speed readout
```

```
Road scroll in the renderer = v_you. Car ahead screen-distance = gap (in car lengths).
Nothing is ever parked. In a flat tape, v_gap ~ 0 and you simply cruise behind the car ahead at the sam
e speed.
```

### **3.4 Headway - the alarm**

```
if v_close > 0:  headway_s = gap / v_close # seconds until impact at current closing rate
else:            headway_s = infinity # gap is opening or flat
Thresholds (defaults, user-tunable):
  green   > 60 s
  yellow  20 - 60 s
  orange   5 - 20 s
  red     <  5 s   (audible + visual; brake lights on car ahead flash)
```

Also show a **projected headway** that includes acceleration: solve gap = v_close*t + 0.5*a_close\*t^2 for t. This is the 'traffic is slowing ahead, brake early' signal - it goes red before the plain headway does.

### **3.5 Traffic density, hills, weather (the road itself)**

| **Road feature**            | **Data**                                                              | **Render**                                                                                                        |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Traffic density             | Volatility: ATR over last N candles (1 m / 5<br>m)                    | Number and spacing of background cars.<br>Bumper-to-bumper = chaotic tape.                                        |
| Hills and crests ahead      | Recent swing structure (last K swing<br>highs/lows) projected forward | Road elevation. This is the original 'surfing'<br>model - a crest coming up is where a short<br>would be entered. |
| Brake lights ahead          | Liquidation clusters and large order-book<br>walls in your direction  | Red glow on cars ahead at that road distance.<br>Price gets pulled toward clusters and bounces<br>off walls.      |
| Road grade (uphill<br>drag) | Funding rate / borrow fee                                             | Paying = slight uphill, constant bleed. Receiving<br>= gentle downhill.                                           |
| Weather / fog               | Spread and expected slippage                                          | Visibility distance. Fog = your brake will not<br>land cleanly.                                                   |
| Oncoming traffic            | Open interest piling onto your side                                   | Crowded trade = squeeze risk. Headlights in<br>the opposite lane.                                                 |

## **4. Pedals -> real Jupiter Perps actions**

| **Pedal**             | **Jupiter action**                               | **Effect on the road**                                                                                   |
| --------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Gas, light            | Increase size AND add proportional<br>collateral | Same leverage, bigger position. Speed unchanged,<br>stakes up. Fuel gauge drops.                         |
| Gas, hard             | Increase size, no new collateral                 | Leverage rises. Speedometer climbs, car ahead<br>jumps closer. The dangerous pedal.                      |
| Back off / coast      | Add collateral only                              | Leverage falls, gap opens, speed falls. The most<br>useful pedal in the car.                             |
| Brake, light          | Partial close (reduce size)                      | Realizes part of P&L;, lowers exposure. Gap barely<br>changes; what changes is how much is riding on it. |
| Brake, full           | Close position                                   | Session segment ends. Car pulls off the freeway.                                                         |
| Danger move<br>(warn) | Withdraw collateral while in profit              | Feels like free money. Actually pulls the car ahead<br>toward you. Render with an explicit warning.      |

| **Pedal**      | **Jupiter action**                                                                                         | **Effect on the road**                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Cruise control | Set / move trailing stop (client-side watcher<br>in practice; on-chain TP/SL where Jupiter<br>supports it) | Car behind you at a fixed distance.                                     |
| Invert switch  | None - render flag only                                                                                    | Flips the road so a long renders as a descent. Zero<br>change to logic. |

The builder should confirm against current Jupiter Perps docs which of these are single instructions versus combinations (e.g. increase-with-collateral may be one call). Keep the pedal layer as a thin adapter so the practice engine and the live engine expose the same interface.

## **5. Modes**

- **Price-only.** Your car, the car ahead, the entry line, the speedometer, headway. Nothing else. This is the author's native mode and the first one to ship.

- **Full dash.** All road layers from 3.5 visible, plus numeric readouts (funding, OI, ATR, spread).

- **Combined.** Looks like price-only, but road shape, traffic density, lighting and weather are driven by the other data. You do not read numbers; you feel a steeper hill or worse fog.

- **Invert.** Orthogonal toggle, works with any of the above.

- **Practice / Live.** Orthogonal toggle. Practice runs a paper engine on real prices. Live sends transactions through Phantom. The UI must make the current state unmistakable (e.g. live mode has a persistent red border).

- **Replay.** Every session is logged tick by tick. Any session can be replayed at 1x-10x with the same renderer. This is how the author will study his own driving.

## **6. Architecture**

```
[ Price feeds ]  --->  [ Node server (TypeScript) ]  --ws-->  [ Browser: Three.js front end ]
                            |                                      |
                   paper engine | live adapter                 Phantom wallet (signs)
                            |
                      session log (append-only JSONL)
```

### **6.1 Server (Node / TypeScript, runs locally)**

- **Feed module.** Subscribe to mark price for the traded market (SOL-PERP first; ETH, BTC next). Use the same oracle Jupiter Perps liquidates against - builder to confirm current source (Pyth via Hermes stream, or Jupiter's own price endpoint). Also pull 1 m candles for ATR and swing detection. Fallback: poll at 250 ms if no stream.

- **Kinematics module.** Pure functions from section 3. Input: price tick + position state. Output: a single _frame_ object (see 6.3). No rendering logic here. Unit-tested.

- **Paper engine.** Holds a simulated position. Applies pedal actions. Computes liquidation price using Jupiter's formula (entry, leverage, maintenance margin, open/close fees, accrued borrow fee) - builder pulls the exact formula from Jupiter Perps docs so practice headway matches live headway. Marks liquidated when gap <= 0.

- **Live adapter.** Reads the real position from the Jupiter Perps program for the connected wallet. Pedal actions build unsigned transactions and hand them to the browser for Phantom to sign. Never holds a key.

- **Market layers module (phase 4).** Funding/borrow rate, open interest, order-book depth if available, liquidation cluster estimate. Each layer is optional and degrades to 'unknown' - never block the core loop on them.

- **Session recorder.** Append every frame and every pedal action to a JSONL file. Replay reads it back through the same websocket path.

### **6.2 Front end (Three.js)**

- Camera fixed behind-and-above your car (driver's seat or chase cam, toggle). Your car never moves on screen. The road and the other cars move.

- Car ahead placed at **gap** car-lengths. Its brake lights intensity = clamp(v_close). Flashing when headway is red.
  - Road scroll speed = v_you. Background traffic density from ATR.

- HUD: speedometer (leverage), headway (big, color-coded), gap, trip odometer (P&L;), fuel (free collateral), mode indicators.
  - Mirror: entry line distance and, if set, the trailing-stop car.

- Pedals: keyboard first (W gas, S brake, space = full brake, C = back off, hold Shift for 'hard'). Gamepad triggers as a later nicety.

- **Phase 2 ships a 2D top-down version of all of the above using plain lines and rectangles.** Same frame object, same HUD. The 3D road is a renderer swap, not a rewrite.

### **6.3 The frame object (server -> client, every tick)**

```
{
  t: 1728740000123,          // ms
  market: 'SOL-PERP',
  side: -1,                  // +1 long, -1 short
  price: 142.37,
  entry: 143.10,
  liq: 144.52,
  leverage: 100,
  gap: 0.72,                 // leverage-scaled, car lengths
  v_gap: 0.013,              // car lengths / s  (+ opening)
  v_close: -0.013,
  a_gap: -0.002,
  headway_s: Infinity,
  headway_proj_s: 41.2,
  v_road: 0.05, v_you: 0.037,
  pnl_pct: 51.0,             // leverage-scaled unrealized P&L; on collateral
  free_collateral: 18.40,
  layers: { atr: 0.0021, funding: 0.0001, oi: null, walls: [], liq_clusters: [] },
  mode: { view: 'price-only', invert: false, live: false }
}
```

## **7. Build phases**

| **Phase** | **Deliverable**                                                                                                              | **Done when**                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0         | Feed + kinematics + paper engine, console output<br>only                                                                     | Open a paper 100x short on SOL from the terminal<br>and watch gap / headway print live. Liquidation fires at<br>the right price. |
| 1         | 2D line view in the browser + keyboard pedals +<br>session log                                                               | The author can 'drive' a paper position for a full 1-2<br>hour session and replay it.                                            |
| 2         | 3D freeway renderer (price-only mode), invert,<br>chase/driver cam                                                           | Same frames, same controls, the road feels like traffic.                                                                         |
| 3         | Market layers: ATR traffic, swing hills, funding grade,<br>spread fog                                                        | Full dash and combined modes work; each layer can<br>be toggled.                                                                 |
| 4         | Live adapter: Phantom connect, read real position,<br>pedals build real transactions, live-mode red border,<br>confirmations | A small real position can be opened, backed off,<br>partially closed and closed from the road.                                   |
| 5         | Liquidation clusters / order-book brake lights,<br>gamepad, multi-market                                                     | Nice-to-haves.                                                                                                                   |

## **8. Tuning constants (expose all of these in a settings panel)**

- Velocity EMA window (default 30 s). Acceleration EMA window (default 10 s).

- Road-speed constant k. ATR window (default 14 x 1 m).

- Headway color thresholds (60 / 20 / 5 s).

- Swing detection lookback for hills (default 60 candles).
  - Tick rate (default 200 ms).

- Trailing-stop distance in car lengths.

## **9. Things the builder must verify against current docs**

- Jupiter Perps liquidation formula (maintenance margin %, fee treatment, borrow-fee accrual) - this must be exact or practice mode lies.

- Which oracle/price Jupiter Perps uses for mark price and liquidation, and the lowest-latency way to subscribe to it.

- Available position instructions: increase size, add collateral, remove collateral, decrease size, close, and whether TP/SL exist on-chain.

- Rate limits on any REST endpoints used for candles and funding.

- Whether order-book / liquidation-cluster data is available for a Jupiter perp market at all (it is an oracle-priced pool, not an order book - 'walls' may have to come from spot venues or be dropped).

## **10. A note on what this tool can and cannot do**

This changes how a position is _perceived and managed_ . It does not change the odds of the underlying trade. At 50x-150x the headway will frequently read in single-digit seconds, and the replay feature will show plainly how much of each outcome was tape noise versus driver input. That is useful information and should be

treated as such. Practice mode first, small size in live, and the live-mode red border is not optional.
