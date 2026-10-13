# TRAFFIC — Update 2: Win fee → Savings

Supplement to _TRAFFIC build spec v1_ and _Update 1_. Adds section 4.1 "Win fee" and a line to the live adapter.

## Rule

**5% of realized profit on every winning close goes to the Savings wallet.** The Savings wallet is a single address owned by the site operator, set in server config (`SAVINGS_WALLET`). Losing closes pay nothing. Practice mode pays nothing (log it as `fee_simulated` so the user sees what it would have been).

## Definition of "profit"

```
realized_pnl = collateral_returned - collateral_contributed    # over the life of the position, in USDC
win_fee      = realized_pnl > 0 ? 0.05 * realized_pnl : 0
```

- Computed per **close event**, including partial closes: fee applies to the realized portion of that close only.
- Jupiter's own open/close/borrow fees are already inside `collateral_returned`, so the 5% is on net profit after Jupiter, not gross.
- "Collateral contributed" includes any added collateral (the back-off pedal). Withdrawn collateral counts as returned.

## How it is collected (live mode)

The pedal layer builds the Jupiter close (or decrease) instruction. When the computed `realized_pnl` is positive, the server appends a **transfer instruction** to the same transaction: `win_fee` in USDC from the user's token account to `SAVINGS_WALLET`'s USDC account. The user signs once in Phantom; the close and the fee land together or not at all.

- No separate approval, no second signature, no server-held keys.
- If the close is a market close whose exact PnL is only known at fill, the builder has two options: (a) compute off the latest oracle tick and accept small drift, or (b) use Jupiter's close-position flow and send the fee in an immediately following transaction. Prefer (a) for atomicity; fall back to (b) if the instruction set does not allow it. Builder to confirm against current Jupiter Perps instructions.
- If a USDC token account does not exist for the Savings wallet, create it once at deploy.

## Display

- HUD shows the fee as part of the trip odometer: `+$41.20 (−$2.06 to savings)`.
- Ghost mode's one-line readout includes projected fee on the current P&L.
- Session log records `{type: "win_fee", close_id, realized_pnl, fee, tx}` per event.
- A plain line in the UI's first-run / about screen: "5% of every winning close goes to the site's savings wallet. Losses pay nothing."

## Accounting

The Savings wallet is just a wallet; its balance is the running total. For a ledger, the server already logs every `win_fee` event, so a one-line script sums them per day/user. No database beyond the existing JSONL.

## Builder notes

- Fee is a pure function of the close; put it in the kinematics/paper engine module next to `realized_pnl` so practice and live share one implementation.
- Multiple users: fee comes from each user's own close transaction, so it scales with zero server involvement beyond building the instruction.

---

## Constraint for the builder: no custom on-chain program

Nothing in this spec or its updates deploys a Solana program. No Rust, no Anchor, no program deployment. All on-chain pieces are already deployed by others and are only _used_:

| Need                                     | What is used                             | How                                                                            |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| Live price                               | Jupiter's existing oracle price accounts | `accountSubscribe` over RPC websocket, decode bytes in TS                      |
| Position state                           | Jupiter's existing position accounts     | same                                                                           |
| Open / close / add collateral / decrease | Jupiter Perps program (already deployed) | build instruction with Jupiter's TS SDK or HTTP API, Phantom signs             |
| 5% win fee                               | SPL Token program (already deployed)     | `createTransferInstruction` from `@solana/spl-token`, appended to the close tx |
| Wallet                                   | Phantom                                  | wallet-adapter in the browser                                                  |

Entire stack is Node/TypeScript server + Three.js browser, talking JSON-RPC, websocket and HTTP. Where the spec says "program" it means Jupiter's.
