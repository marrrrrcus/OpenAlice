# Backtest spec - Capitulation Mean Reversion v1a

This is a **new pre-registered research hypothesis**, not a rescue of v0.
v0 was tested and rejected as a `directionSource`; v1a starts over with a
different detector: **liquidity sweep + RVOL**, using only already-validated
Binance OHLCV data.

Until this spec passes out-of-sample and concentration checks, it must not drive
any proposal, alert, or capital-risking action.

## Status

- Research spec only.
- No live signal.
- No proposal.
- No execution.
- No Open Alice runtime changes.

## Hypothesis

Simple price-drop + lower-wick rules did not survive time-stability checks.
The next test is whether **BTC-only capitulation candidates are better when the
drop also sweeps an obvious prior low and prints abnormal volume**.

Plain language:

> Buy weakness only after price takes liquidity below a recent low, then closes
> back above it on unusually high volume.

This is still a long-only mean-reversion hypothesis. It is not a prediction
engine and not a discretionary bottom-calling rule.

## Relationship to v0

v0 failed because the mainline result was concentrated in 2025Q1:

- BTC d2 looked positive in the full sample but turned negative when 2025Q1 was
  removed.
- ETH was clearly negative and is excluded from v1a.
- d3 was only a sensitivity check; it may inspire future work, but it did not
  validate v0.

v1a changes the **candidate detector**, but keeps the trade simulator close to
v0 so the test asks one clean question:

> Does adding liquidity-sweep structure and RVOL improve the candidate quality?

## Universe / venue / data

- **Universe:** BTCUSDT only.
- **Venue:** Binance USD-M futures.
- **Data:** v8 warehouse 1-minute OHLCV:
  `C:\Users\Marcus\OneDrive\Desktop\20250926-binance_trader_v8\data\warehouse\symbol=btcusdt\`
- **Resampling:** derive 1h signal bars from the 1m data.
- **Official window:** same validated window as v0:
  `2024-07-19T00:00:00Z` to `2026-06-01T00:00:00Z` exclusive.
- **Regime:** BTC daily close > BTC 200D SMA, using the last completed daily
  candle only.

This satisfies the constitution invariant: **execution venue must match data
venue**.

## Layer 1 - Candidate detector

A 1h bar is a candidate only when all of the following hold.

### 1. Regime

BTC is in the up-regime:

```text
previous_completed_daily_close > previous_completed_daily_SMA200
```

No current, still-open daily candle may be used.

### 2. Liquidity sweep and reclaim

Define a prior-low reference from bars that are fully known before the signal
bar:

```text
prior_low_N = min(low[t-N : t-1])
```

v1a mainline:

```text
N = 48 one-hour bars
signal_low < prior_low_N
signal_close > prior_low_N
```

Meaning: price trades below a recent obvious low, then closes back above it.
This avoids treating every lower wick as a sweep.

Sensitivity checks:

- `N = 24`
- `N = 72`

These are sensitivity checks only. Do not pick the best one after seeing the
result and call it the mainline.

### 3. Abnormal volume (RVOL)

Define RVOL against prior fully closed bars:

```text
rvol = signal_volume / mean(volume[t-M : t-1])
```

v1a mainline:

```text
M = 48 one-hour bars
rvol >= 3.0
```

Sensitivity checks:

- `rvol >= 2.0`
- `rvol >= 5.0`

RVOL is the main difference from v0. It tries to distinguish a real panic flush
from a quiet drift lower.

### 4. Sharp-drop context (auxiliary, not the main detector)

Keep the v0 `d2` sharp-drop condition as an auxiliary context filter:

```text
24-bar close-to-close return <= -5%
```

However, report sensitivity with and without this filter. If liquidity sweep +
RVOL works only when `d2` is removed, that is a different hypothesis and must be
renamed.

### 5. Close holds

Reuse the v0 close-holds requirement:

```text
lower_shadow / (high - low) >= 0.4
close_position = (close - low) / (high - low) >= 0.5
```

This keeps the rule from buying a bar that sweeps a low but closes near the
bottom.

## Entry rule

- Confirm only after the 1h signal bar closes.
- Enter at the next 1h open.
- If the next open is already at or above the target, skip the trade.
- If the next open is already at or below the stop, enter and stop immediately
  at the entry price (fee/slippage loss only). Do not fill at a stale stop price
  above entry.
- No overlapping trades per symbol.

## Layer 2 - Trade simulation

Reuse the v0 event simulator defaults unless explicitly changed:

- Target: fixed EMA20 at the signal bar.
- Stop: signal low - 0.5 * ATR14.
- Time stop: 8 wall-clock hours.
- Costs: 0.05% fee per side + 0.03% slippage per side.
- Target/stop ordering: use the 1m path; if the same 1m bar touches both,
  pessimistically choose stop first.

The goal is not to optimize exits in v1a. The goal is to test whether the new
candidate detector is better than v0.

## Deliberately OUT of v1a

Keep these out of the mainline engine:

- ETH and other symbols.
- Funding as an entry condition.
- Open interest.
- Liquidation data.
- News / black-swan NLP.
- Order book replay.
- Parameter search.

Funding may be attached as a post-hoc label only:

```text
funding_before_candidate
funding_after_candidate
funding_sign
funding_percentile
```

If funding appears useful, it becomes v1b, not a silent v1a change.

## Evaluation

Report at minimum:

- candidate count
- entered trade count
- average return per trade
- profit factor
- sequence max drawdown
- average adverse excursion
- target / stop / time-stop rates
- time to target
- random-entry baseline with the same regime, same count, same no-overlap rule
- leave-one-quarter-out
- first-half / second-half split
- per-month contribution table

Passing the full-sample random baseline is not enough. The rule must not depend
on a single quarter or a small event cluster.

## Passing bar

v1a is only allowed to become a `backtested_rule:*` candidate if all hold:

1. Full-sample result is positive after costs.
2. Random percentile is materially high in the full sample.
3. Leave-one-quarter-out remains positive or at least materially better than
   random after removing the strongest quarter.
4. The result is not dominated by one month or one event cluster.
5. Sensitivity checks do not flip the rule from clearly positive to clearly
   negative under small parameter changes.

If it only works in one quarter, it is rejected like v0.

## Expected failure modes

- Too few candidates after adding sweep + RVOL.
- RVOL catches news-driven crashes that continue lower.
- Sweep definition overfits a visual pattern.
- EMA20 target is too far after high-volatility panic bars.
- Stop is too tight after a true liquidation cascade.
- The result is still just 2025Q1 in disguise.

These are not bugs; they are exactly what the backtest must reveal.

## Research artifacts to save

When implemented, save:

- simulator script
- config JSON
- output JSON
- candidates CSV
- trades CSV
- time-stability CSV
- leave-one-quarter-out CSV

Do not rely on a one-off console table.

## Final rule before implementation

If v1a fails, do not add more conditions until the failure mode is understood.
Do not stack OI, liquidation, funding, and news just to rescue a weak signal.

The research question must stay narrow:

> Does BTC liquidity sweep + RVOL produce better mean-reversion candidates than
> v0's simple price-drop + lower-wick detector?
