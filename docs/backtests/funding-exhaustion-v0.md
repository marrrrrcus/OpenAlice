# Backtest spec - BTC Funding Exhaustion v0

A **design spec for a backtest**, not an implemented strategy and not a live
signal. It exists so the rule is pinned on paper before any simulator is
written - and so, *if* it validates, it becomes a concrete
`backtested_rule:funding-exhaustion-v0` that may serve as a `directionSource`
under [trade-proposal-principles.md](../trade-proposal-principles.md). Until it
validates, it is **not** allowed to drive any proposal.

> **Status:** RUN — INCONCLUSIVE (sample-starved), 2026-06. The pre-registered
> mainline produced only 4 crowding events -> 3 trades; **no** pre-registered
> config (mainline or any sensitivity axis) reached even 25 trades. Not rejected
> as a concept, not accepted as edge, not a `directionSource`: no signal, no
> proposal, no execution. See "Research verdict" below. This file intentionally
> focuses on the three failure modes that can silently invalidate any funding
> backtest: timestamp alignment, funding cashflow accounting, and long/short sign
> handling.

## The one question v0 answers

> When BTC perpetual funding is extremely positive (longs are paying an
> expensive carry) and price then fails to continue higher, does a short trade
> have positive expectancy after fees, slippage, and actual funding cashflows?

This is **not** a generic "funding is high, short it" rule. High funding can
persist in a strong trend. v0 requires a **price-failure confirmation** after
the high-funding settlement. The hypothesis is exhaustion:

```text
crowded long carry + failure to push price higher -> long unwind pressure
```

Deliberately **out of v0**:

- negative-funding long trades (symmetric idea, separate v1)
- ETH / SOL pooling (different funding regimes, separate reports only)
- OI / liquidation / news filters (v1+ if v0 has a pulse)
- live proposal integration

## Universe / data / venue

- **Universe:** `BTCUSDT` only, Binance USD-M perp. No ETH / SOL in the
  mainline; they may be inspected later as separate hypotheses, never pooled.
- **OHLCV data:** V8 `data/warehouse/symbol=btcusdt/` - Binance USD-M
  **1-minute OHLCV** (`timestamp/open/high/low/close/volume`), resampled where
  needed.
- **Funding data:** V8 `data/funding_rates/symbol=btcusdt/` - Binance funding
  parquet files with columns:
  - `timestamp` (ms)
  - `funding_rate` (raw decimal, e.g. `0.0001` = `0.01%`)
  - `mark_price`
- **Observed funding cadence:** 00:00 / 08:00 / 16:00 UTC, one row per
  8-hour settlement. v0 treats each row as a **settled funding event**, not a
  forecast. Raw timestamps can have millisecond-level jitter around the
  scheduled 8-hour cadence, so the simulator must order rows by timestamp and
  use prior rows by **row order**, not by exact `F - 8h` timestamp equality.
- **Official window:** reuse the validated V8 research window
  `2024-07-19T00:00:00Z -> 2026-06-01T00:00:00Z` (exclusive), so OHLCV
  continuity / duplicate / bad-OHLC checks already validated for earlier
  studies carry over.
- **Venue consistency:** signal data = execution venue = Binance USD-M. This
  satisfies the constitution's `Execution venue must match data venue`.

## Landmine 1 - timestamp alignment (no lookahead)

Funding rows must be treated as **known only after settlement**.

For a funding row at timestamp `F`:

1. The row's `funding_rate` is **not available before `F`**.
2. v0 considers it available from `F + 1 minute` onward. This one-minute delay
   is intentionally conservative and avoids same-minute ordering ambiguity.
3. Any feature that ranks the current event against history must compute the
   historical distribution using rows with `timestamp < F` only.
4. The current event may be included in the **current** 24h funding sum after
   `F + 1 minute`, because it is then settled and known.

Pinned formula:

```text
funding_sum_24h(row_i) = funding_i + funding_{i-1} + funding_{i-2}
  where row_i is the funding row settling at F, after sorting by timestamp
  (row order — NOT exact F-8h / F-16h timestamp equality; see implementation note)

percentile_window(F) =
  all historical funding_sum_24h rows with timestamp < F
  over the trailing 365 calendar days
  require at least 180 calendar days of history
```

No current or future funding row is allowed inside `percentile_window(F)`.

Implementation note: because the V8 funding timestamps may differ from exact
8-hour boundaries by a few milliseconds, the code should compute
`funding_sum_24h(F)` as the current row plus the previous two rows for that
symbol after sorting by timestamp. Scheduled 00/08/16 UTC settlement labels may
be rounded for reporting only; they must not be used as exact join keys.

### Candidate event time

The candidate event time is the funding settlement `F`, but the earliest
possible price-confirmation bar must **close after** `F + 1 minute`.

Example:

```text
Funding settles at 16:00 UTC.
Funding row becomes usable at 16:01 UTC.
The 16:00-16:59 1h candle may be used only after it closes at 17:00 UTC.
Entry can occur only after that confirmation close.
```

## Layer 1 - funding crowding detector

A funding event `F` is crowded-long eligible when **all** hold:

1. `funding_sum_24h(F)` is at or above the **95th percentile** of its trailing
   historical distribution.
2. `funding_sum_24h(F) >= 0.0006` (raw decimal = `0.06%` over 24h). This
   absolute floor prevents a low-volatility period from labeling a tiny carry
   as "extreme" merely because it is locally high.
3. History requirement is satisfied (at least 180 calendar days before `F`).

This stage creates a **crowding event**, not a trade. It says only:

```text
longs are paying an unusually expensive 24h carry
```

It does **not** say price must fall.

## Layer 2 - price-failure confirmation

After a crowded-long funding event `F`, watch for price failure during the next
4 hours. The trade is allowed only if a completed 1h candle confirms that price
cannot hold the prior carry-supported level.

Past-only reference levels:

```text
pre_vwap_8h(F) = volume-weighted average price over [F - 8h, F)
pre_high_8h(F) = max 1m high over [F - 8h, F)
atr_1h_14(F)   = ATR14 on completed 1h candles ending before F
```

Confirmation rule:

```text
Find the first completed 1h candle C after F + 1 minute and before F + 4h.

Confirm short if:
  close(C) < pre_vwap_8h(F)
  and high(C) < pre_high_8h(F)
```

Rationale:

- `close < pre_vwap_8h` says the market has lost the level where the crowded
  long carry was built.
- `high < pre_high_8h` prevents shorting a still-expanding upside breakout.

If no confirmation occurs within 4 hours, the funding event is logged but **no
trade** is entered.

## Entry / direction

- **Direction:** short only.
- **Entry:** next 1m open after the confirming 1h candle closes.
- **Skip:** if the next 1m open is missing or outside the data window.
- **No re-entry:** one trade max per funding event.
- **Event overlap:** if a new eligible funding event occurs while a prior trade
  is open, ignore the new event for v0. Do not pyramid.

This short-only design is intentional. It tests one specific mechanism:

```text
positive funding crowding + upside failure -> short exhaustion trade
```

The negative-funding long side is a separate hypothesis. Do not silently add it
after seeing results.

## Layer 3 - trade simulation

Mainline exits:

- **Stop loss:** `max(pre_high_8h(F), high(C)) + 0.25 * atr_1h_14(F)`.
- **Risk unit:** `R = stop_price - entry_price`.
- **Target:** `entry_price - 1.0 * R`.
- **Time stop:** force-close after **16 hours** from entry, or earlier if the
  data window ends.
- **Collision rule:** if a single 1m bar touches both target and stop, assume
  the **pessimistic** outcome - stop first.
- **Same-minute funding ambiguity:** if a target/stop/time-stop exit occurs in
  the same minute as a funding settlement, v0 excludes that settlement from
  cashflow accounting. No ambiguous "free funding" is allowed.

Sensitivity axes, not mainline:

- **single 8h funding rate** instead of the 24h sum. The **24h sum is the
  mainline** (it tracks accumulated carry pressure, the actual exhaustion
  premise); the single 8h rate is reported only as a sensitivity, never swapped
  into the mainline after seeing results.
- target `1.5R`
- time stop `8h`
- absolute floor `0.0004` / `0.0008`
- percentile `90th` / `97.5th`

The mainline verdict is based only on the pinned values above.

## Landmine 2 - funding cashflow accounting

Funding cashflow is part of PnL. A funding strategy that ignores cashflow is not
testing a funding strategy.

For each trade, include every funding settlement `T` such that:

```text
entry_time < T < exit_time
```

Strict inequality is deliberate:

- if entry occurs exactly at `T`, the position was not safely open before
  settlement;
- if exit occurs exactly at `T`, ordering is ambiguous;
- ambiguity is resolved conservatively by excluding same-minute funding.

Cashflow is measured as a return fraction of entry notional:

```text
funding_cashflow_return(T) =
  -position_sign * funding_rate(T) * mark_price(T) / entry_price
```

where:

```text
position_sign = +1 for long
position_sign = -1 for short
```

For v0 short-only trades, this simplifies to:

```text
short funding cashflow = funding_rate(T) * mark_price(T) / entry_price
```

Therefore:

- positive funding -> short receives funding -> positive cashflow
- negative funding -> short pays funding -> negative cashflow

Do not approximate funding as a flat bonus at entry. Use only settlements that
occur while the position is actually open.

## Landmine 3 - price PnL and funding sign handling

Price PnL and funding PnL use different sign conventions. Pin both explicitly.

For one unit of BTC, measured as return on entry notional:

```text
price_return =
  position_sign * (exit_price - entry_price) / entry_price
```

So:

```text
long  price_return = (exit - entry) / entry
short price_return = (entry - exit) / entry
```

Total return:

```text
gross_return = price_return + sum(funding_cashflow_return)
net_return   = gross_return - fees - slippage
```

Costs:

```text
fee      = 0.05% per side
slippage = 0.04% per side
round_trip_cost = 0.18%
```

Why slippage is lower than ORB but higher than passive mean-reversion:

- this strategy enters after confirmation, not into an ORB stop-run;
- but it still expects adverse liquidity after a crowded funding event.

## Evaluation

Report:

- crowded funding event count
- confirmed trade count
- average price return
- average funding cashflow
- average net return
- profit factor
- max drawdown
- target / stop / time-stop mix
- average holding time
- funding settlements crossed per trade
- per-quarter and per-month results
- leave-one-quarter-out (LOQO)
- random-baseline percentile

The decomposition is mandatory:

```text
price PnL
funding cashflow
fees/slippage
net PnL
```

If the rule only "works" because funding cashflow was accidentally double-counted
or sign-flipped, it is rejected.

## Random baseline (pinned)

The random baseline must match the funding-event clock and short-only structure.

For each actual trade count `N`, run 1000 random trials:

1. Sample `N` funding settlement times from the eligible funding universe
   (same official window, same history/warmup requirement), without requiring
   extreme funding.
2. For each sampled settlement, choose a random entry time between `F + 1h` and
   `F + 4h`.
3. Direction is always **short** (same as v0).
4. Compute `pre_high_8h`, `atr_1h_14`, stop, target, time stop, costs, and
   funding cashflows using the exact same machinery as the real rule.

This asks:

```text
Is "extreme positive funding + price failure" better than a random short
around ordinary funding-settlement windows?
```

If the actual rule cannot beat this baseline, the funding detector adds no edge.
The passing-bar comparison is on `price_net` (funding **excluded**); the
`total_net` percentile is reported alongside but never gates acceptance.

## Pre-registered passing bar

**The gate is PRICE PnL, not net (this spec's P0).** Define:

```text
price_net = price_return - fees - slippage          # funding EXCLUDED — the reversion-edge metric
total_net = price_return + funding_cashflow - fees - slippage   # tradable number — REPORTED, never a gate
```

A short opened on positive funding *collects* funding carry while it waits. If
acceptance is judged on `total_net`, that carry can make a trade with **no price
reversion** look like an edge. So the reversion hypothesis is validated on
`price_net` alone; `total_net` is reported but never gates.

v0 is accepted as a **research lead** only if **all** hold:

1. **Sample sufficiency:** at least **40 entered trades**. If fewer than 40,
   the result is **INCONCLUSIVE**, not accepted and not rescued by adding more
   filters. If fewer than 25, stop interpreting anything beyond "too sparse."
2. **Price edge stands alone:** avg `price_net` / trade > 0 **and** profit factor
   computed on `price_net` > 1.15. Funding cashflow is excluded from this test.
3. **Beats random on price:** actual `price_net` at or above the 90th percentile
   of the random-baseline `price_net` distribution.
4. **Time stability on price:** every LOQO refit remains `price_net` positive. If
   one quarter is the whole edge, reject.
5. **Carry cannot rescue:** if `price_net` fails but `total_net` passes only
   because funding cashflow is positive, the reversion hypothesis is **REJECTED**
   — it is a fragile carry trade (funding can flip), not a `directionSource`.
6. **Decomposition is sane:** price-return, funding-cashflow, and fees/slippage
   columns are all reported with the pinned sign conventions (Landmine 3 unit
   tests pass); no hidden assumptions.

Anything short of all six -> **REJECT** or **INCONCLUSIVE**. Do not add OI,
liquidation, news, microstructure, or ETH/SOL to rescue a failed v0. A
continuation must be a new, separately pre-registered hypothesis.

## Research verdict — INCONCLUSIVE (sample-starved, 2026-06)

Run as a standalone research artifact at
`C:\Users\Marcus\OneDrive\Desktop\funding_exhaustion_v0_backtest\` (read-only on
the V8 warehouse, no Alice runtime, no commit): `funding_exhaustion_v0_sim.py`,
`funding_exhaustion_v0_sensitivity.py`, `output.json`, `trades.csv`,
`candidates.csv`, `funding_events.csv`, `monthly.csv`, `quarterly.csv`,
`loqo.csv`, `random_baseline.csv`. seed=42, reproducible.

**Mainline (p95 trailing + 24h-sum floor 0.0006), costs + funding decomposed:**

| metric | value | bar | pass |
|---|---|---|---|
| crowding events -> trades | 4 -> **3** | n >= 40 | ❌ (n=3) |
| price_net avg / trade | +0.1005% | > 0 | ✅ |
| price_net PF | 1.13 | > 1.15 | ❌ |
| beats random (price_net) | 69th pct | >= 90th | ❌ |
| LOQO all-positive | n/a (single quarter) | all > 0 | ❌ |

Sample n=3 is below 25, so the mainline is **INCONCLUSIVE**, not REJECTED.

**Pre-registered sensitivity grid — universal sample collapse.** No config on any
pinned axis (percentile 90/95/97.5, floor 0.0004/0.0006/0.0008, single-8h-rate
variant) reached even 25 trades; the largest sample anywhere is **14** (8h-rate,
p90). With de-clustering matched on **actual exit time**, the `sum24 p95` grid
cell reconciles exactly with the mainline simulator (3 trades, +0.1005%, PF 1.13)
— the grid is a faithful extension, not a separate engine. Every positive-looking
cell (+2.63% at n=1, +0.77% at n=4) is small-sample noise — the same trap that
sank capitulation v1a.

**Death cause:** the funding-extreme event set is small to begin with (floor-only
in-window counts: `sum24>=0.0004` 61, `>=0.0006` 29, `>=0.0008` 6 rows over
~22.5 months), and the **price-failure confirmation (close<pre_vwap_8h AND
high<pre_high_8h) plus no-pyramid de-clustering** — added precisely to make the
test *harder and more defensible* — shrink it to single digits. The tradable rule
as specified **cannot be evaluated** on BTC-only / 2-year data.

**What this is and is not:**

- **Not** proof that funding exhaustion is an invalid concept — the reversion
  edge was never measured with enough samples to confirm or deny.
- **Not** an accepted edge — `price_net` clears neither PF 1.15 nor the 90th
  random percentile even on the tiny sample.
- **INCONCLUSIVE / sample-starved.**

**Final v0 decision:** **no `directionSource`, no proposal, no trade.** Per the
constitution and the capitulation / ORB precedent, do **not** stack OI /
liquidation / news / multi-asset onto v0 to manufacture a sample.

**If this line is continued (not now):** it must be a **new, separately
pre-registered "Layer-1 pure funding pulse" spec** — drop the price-failure
confirmation and the de-clustering, and measure the *pure conditional forward
return* after extreme funding (8h / 24h / 48h, signed by the fade direction) over
the full ~60-event set, against a random-time control. That tests "is there any
reversion pulse at all" with a real sample; only if a pulse shows does a
confirmation-gated tradable rule become worth re-pinning.

## Research artifacts to save (when run)

Standalone, outside both repos, read-only on the V8 warehouse:

- simulator script
- config JSON
- output JSON
- funding events CSV
- confirmed candidates CSV
- trades CSV with price/funding/cost/net decomposition
- monthly / quarterly / LOQO CSV
- random-baseline distribution

Do not rely on a one-off console table.

## Implementation checklist before running

- [ ] Confirm funding `timestamp` is treated as settlement time, usable only
      from `F + 1 minute`.
- [ ] Verify no funding row with `timestamp >= F` enters the percentile history
      for event `F`.
- [ ] Verify price confirmation uses only completed 1h candles after the
      funding event.
- [ ] Unit-test short price PnL: entry 100, exit 99 -> +1%; exit 101 -> -1%.
- [ ] Unit-test funding cashflow:
      - short, funding +0.0001 -> positive cashflow
      - short, funding -0.0001 -> negative cashflow
      - long, funding +0.0001 -> negative cashflow
      - long, funding -0.0001 -> positive cashflow
- [ ] Unit-test same-minute settlement exclusion.
- [ ] Unit-test a trade that crosses two funding settlements and decomposes
      price return vs funding return correctly.

## Related

- [alice-trading-constitution.md](../alice-trading-constitution.md) - this rule
  must prove edge before it can become a legal `directionSource`.
- [trade-proposal-principles.md](../trade-proposal-principles.md) - a validated
  rule may propose direction; risk gates may only allow / size-down / block.
- [session-orb-v0.md](session-orb-v0.md) - rejected time-cycle hypothesis.
- [capitulation-mean-reversion-v0.md](capitulation-mean-reversion-v0.md) -
  rejected price-action mean-reversion hypothesis.
