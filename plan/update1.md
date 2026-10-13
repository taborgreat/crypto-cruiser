# TRAFFIC — Update 1: Data feed architecture + Ghost mode (pre-entry preview)

Supplement to _TRAFFIC build spec v1_. Two changes: (A) replaces the Feed module in section 6.1 and the Phase 0 deliverable; (B) adds section 3.6 "Ghost mode" and inserts it into the phase table.

---

## A. Data feed: one subscription, one truth, any number of viewers

### Principle

The server holds **one** live price for each market, received by push, and every client reads that one value. Upstream load is therefore flat: one subscription per market regardless of whether one person or a thousand are watching. The only per-user upstream traffic is the Jupiter transaction path when someone actually acts, and for the foreseeable user count (author + a friend) that is negligible.

No polling of any REST price API. No per-client upstream requests.

### Primary feed: subscribe to the oracle account Jupiter Perps actually uses

Jupiter Perps' primary oracle is Edge (Chaos Labs), with Chainlink and Pyth as verifiers/fallbacks. Each asset's price is written to an **on-chain oracle price account** (referenced from the market's custody account via the `dovesAgOracle` field; SOL, ETH, BTC each have one). The account updates on every trade execution and via an independent keeper. This is the price the liquidation engine sees, so it is the price the car-ahead distance must be computed from.

Solana RPC exposes `accountSubscribe` over websocket: one long-lived connection, and the node pushes the new account bytes every time the account changes. No request count, no rate-limit burn, latency of roughly one slot.

```
Feed daemon (Node/TS, runs on the author's homelab)
  |
  |-- 1 websocket to an RPC endpoint
  |     accountSubscribe(oracle_account_SOL)
  |     accountSubscribe(oracle_account_ETH)   (as markets are added)
  |     accountSubscribe(position_account_*)   (each connected wallet's open positions)
  |
  |-- decode account bytes -> { t, price, conf }  (layouts from Jupiter developer docs)
  |-- decode position bytes -> { size, collateral, entry, liq, side, borrow_fee_accrued }
  |
  |-- in-memory ring buffer: last N hours of ticks per market
  |-- append-only JSONL / SQLite on disk (feeds replay + history)
  |-- local candle aggregation: 1s / 1m / 5m bars, ATR, swing highs/lows
  |
  '-- fan-out websocket (localhost / LAN / behind the site)
        -> every TRAFFIC client, replay tool, future bots
        -> THIS is the internal data API. Serves any number of clients at any tick rate.
```

RPC endpoint: public mainnet RPC works for a handful of subscriptions. A free-tier dedicated provider key (Helius, Triton, QuickNode or similar) gives a steadier websocket; it is still one connection. Provider choice is the builder's.

### Secondary feed: Pyth Hermes stream as a cross-check

Pyth's public Hermes REST is limited to 10 requests per 10 seconds per IP and now requires an API key, so it is not usable as a polled primary. Its **SSE stream** endpoint is one connection pushing updates on the order of every 400 ms, which is fine as a second opinion. Use it to:

- flag divergence between the Jupiter oracle and Pyth (render as fog / "visibility" in the road layers), and
- keep the car moving if the Jupiter subscription drops.

Do **not** self-host Hermes. It requires a Pythnet RPC and still rides the Wormhole latency path; Pyth's own guidance is that self-hosting does not make the feed faster.

### What is explicitly out of scope

- Running a Solana validator or full RPC node (hundreds of GB RAM, NVMe, constant catch-up). Not needed.
- Polling any REST price endpoint on a timer.
- Any external candle / OHLCV API. Candles are built locally from the tick stream.

Later optimization only (phase 5+): Geyser / Yellowstone gRPC from a provider for tighter account-change streaming than public websocket.

### Revised Phase 0

> **Phase 0 — Done when:** the feed daemon is subscribed to the SOL oracle account, decodes ticks, prints `{t, price}` to the console at every change, writes them to JSONL, and the paper engine opens a 100x short from the terminal and prints gap / headway live off those ticks. Liquidation fires at the right price.

### Revised 6.1 Feed module text

> **Feed module.** One RPC websocket; `accountSubscribe` on each market's Jupiter oracle price account and on each connected wallet's position accounts. Decodes to ticks and position state. Maintains an in-memory ring buffer and an append-only on-disk log. Aggregates candles, ATR and swing structure locally. Optional Pyth Hermes SSE stream as cross-check / fallback. Exposes a single fan-out websocket that all clients read; this is the only data API the front end knows about.

---

## B. Ghost mode: you are already driving before you commit

### What it is

Before a position exists, the driver is **already in the lane**. A ghost car — translucent, outlined — is driving the position the driver is _about to_ take, computed from the live tick stream every tick, exactly as a real car would be. The car ahead, the gap, the speedometer, headway, the road scrolling, the brake lights — all live, for a position that has not been placed.

The driver dials side, leverage, size and entry and watches the ghost's situation respond in real time. The question "is this a good trade?" becomes "does this car look like it is about to drive well?" When it does, press **Go** and the ghost becomes the real car with no visual discontinuity. If it does not, the ghost just keeps driving and the driver keeps watching.

This is not a waiting area. It is a simulation of the next few seconds, running continuously, that the driver steps into.

### Inputs

| Control             | Effect on the ghost                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Side (long / short) | Which direction of price moves the ghost toward the car ahead. Flips the road under invert. |
| Leverage            | Speedometer. The rate at which the gap moves (gap still starts ~1.0 car length).            |
| Collateral / size   | Post-entry fuel gauge; how much is riding on the gap.                                       |
| Entry price         | Default = current mark (market order). Can be dragged forward/back on the road for a limit. |
| Mode / invert       | Same toggles as live.                                                                       |

### Kinematics

All section 3 quantities, computed each tick with the **proposed** `P_entry`, `L`, `s`, and `P_liq` from the paper engine's liquidation formula:

```
ghost.liq            = liq_formula(P_entry_prop, L_prop, s_prop, collateral_prop)
ghost.gap            = L * s * (P - ghost.liq) / P      # where the car ahead would be RIGHT NOW
ghost.v_gap          = L * v_price                      # drifting back or closing in RIGHT NOW
ghost.v_close        = -ghost.v_gap
ghost.headway_s      = ghost.gap / ghost.v_close   (if v_close > 0, else inf)
ghost.headway_proj_s = same with acceleration (3.4)
ghost.v_you          = v_road - ghost.v_gap
```

`v_price`, `a_price`, `v_road`, ATR and swing structure are properties of the market, shared between the ghost and any real car. Only gap, headway and v_you are per-ghost.

### Rendering

- Ghost car translucent / outlined, in the lane, moving with the road.
- Car ahead at `ghost.gap`, brake lights reacting to `ghost.v_close`. If price is currently running against the proposed side, the brake lights are lit **before** the driver commits.
- Headway number and color live.
- **Headway history strip** under the HUD: rolling 60 s of what `ghost.headway_s` has been. Solid green = calm. Flickering red = this is stop-and-go.
- Fuel gauge showing post-entry free collateral.

### The one-line readout

Above the Go button, the whole picture in driving words:

```
100x SHORT  |  gap 0.98  |  drifting back 0.021/s  |  headway inf  |  flow moderate  |  slight uphill (paying funding)
100x LONG   |  gap 0.98  |  CLOSING 0.034/s        |  headway 29s  |  flow heavy     |  brake lights ahead
```

The second line is a no-Go without reading a chart.

### Entry timing: the surf model lives here

Section 3.5's swing-structure road elevation does its real work in ghost mode:

- **Crest ahead** (recent swing-high structure projecting up): a short entered here starts drifting back as the road falls away. Good short.
- **Trough ahead**: good long.
- **Mid-hill**: entering a move already in progress; headway says how much of it is left.

The entry line can be **scrubbed** forward along the road to a crest or trough; the ghost recomputes as a limit at that price. Go then places a limit (paper limit in practice; Jupiter limit/trigger order in live where supported).

### Multiple ghosts (phase 3+)

Up to three ghosts in adjacent lanes — e.g. 50x / 100x / 150x on one side, or short vs long. Each has its own car ahead and headway. The driver picks the lane that is driving best. Only one becomes real on Go.

### Transition on Go

1. Freeze the ghost's current frame.
2. Submit the entry (paper or live).
3. On fill, swap ghost → real car in place. Paint the entry line where the fill actually landed; if it differs from the proposed price (slippage), show it as a small jolt.
4. The ghost's headway history strip continues as the live headway strip.

If the fill fails or is rejected, the ghost keeps driving and the reason is shown.

### Builder notes

- The paper engine exposes `preview(side, L, collateral, entry) -> frame`, a pure function of (live tick, proposed params). It never mutates real position state. It emits a `preview` event type to the session log so replay can show what the driver was looking at before each entry.
- Ghost headway in single-digit seconds at 100x+ in a fast tape is expected and correct: it is the tool saying this is not the moment.

### Phase insertions

| Phase | Addition                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------- |
| 0     | Feed daemon as revised above. Paper engine exposes `preview()`.                                       |
| 1     | 2D ghost: outlined rectangle in lane, car ahead, headway, history strip, one-line readout, Go button. |
| 2     | 3D ghost rendered translucent; seamless swap on Go.                                                   |
| 3     | Crests/troughs on the road; scrub-to-limit; multi-ghost lanes.                                        |
| 4     | Live Go: builds the Jupiter open-position transaction from the ghost's parameters; Phantom signs.     |
| 5+    | Geyser/Yellowstone gRPC feed upgrade if websocket latency ever matters.                               |

---

## Sources for the builder

- Pyth Hermes rate limits: https://docs.pyth.network/price-feeds/core/rate-limits
- Pyth Hermes API instances / API key: https://docs.pyth.network/price-feeds/core/api-instances-and-providers/hermes
- Pyth forum on self-hosting Hermes: https://dev-forum.pyth.network/t/hermes-configuration/196
- Jupiter Perps technical reference (oracles, account fields): https://docs.jup.ag/user-docs/trade/perps/technical-reference
- Jupiter developer docs for perps account layouts: https://developers.jup.ag/docs/perps
