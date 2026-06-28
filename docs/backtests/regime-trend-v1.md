# Backtest spec — BTC Regime Trend v1 (slow regime + fast crash breaker)

A **pre-registered design spec for a backtest**, not yet run.

`regime-trend-v0` was a disciplined near-miss: the slow 200-day regime filter
beat buy-and-hold on aggregate CAGR, maxDD, Calmar, Sharpe, and final equity, but
failed the pre-registered per-cycle gate because it did not protect the
2019-06 → 2020-03 fast crash. v1 tests the natural next hypothesis:

> A slow trend regime gate is useful for slow bears, but it needs an independent,
> a-priori **fast drawdown circuit-breaker** for rapid crashes.

This is still a **long / flat** beta-management rule. It is not a short signal,
not alpha, and not an intraday execution strategy.

> **Status:** PRE-REGISTERED DRAFT. Not run. No signal, no proposal, no
> execution until it validates.

## Why this v1 is dangerous

This hypothesis is explicitly motivated by a known v0 failure (COVID-style fast
crash). That makes it a high overfit-risk follow-up. Therefore:

- The fast-breaker parameters are pinned **before** the run.
- The parameters are deliberately broad and generic, not fitted to March 2020.
- Sensitivity is reported but never swapped into the mainline.
- Cross-asset behavior is used as an overfit warning, not a rescue mechanism.

If v1 only fixes BTC-COVID and does not behave sensibly elsewhere, it is not a
validated rule.

## Honest framing — what this is and is NOT

- **Is:** a two-layer beta risk manager:
  1. slow regime gate for slow bears,
  2. fast crash breaker for rapid drawdowns.
- **Is NOT:** market-neutral alpha or a prediction that price will rise.
- **Is NOT:** a short strategy. Bear / breaker states mean `long disabled`,
  never `short allowed`.
- **Benchmark is buy-and-hold BTC, NOT random.** The question is still whether
  the overlay improves risk-adjusted ownership of BTC versus simply holding.

## Universe / data / window

- **Mainline asset:** BTC spot daily, Binance `BTCUSDT` (public daily klines).
- **Support-only assets:** ETH (`ETHUSDT`), S&P 500, Gold.
- **Window:** listing → `2026-06-01`. With a 200-day SMA warmup, usable from the
  first executable open after the first completed SMA candle (about 2018-03).
- **Venue note:** spot daily data is acceptable for this slow macro filter even
  though live execution would be on the perp. This remains an explicit, limited
  relaxation of `Execution venue must match data venue`; it does not apply to
  order-book, funding, or execution-price signals.
- **Data is fetched read-only** and study artifacts live outside the repo and
  outside Alice runtime.

## Layer 1 — slow regime gate (unchanged from v0)

`SMA200` = 200-day simple moving average of daily close, completed candles only.
`±3%` band hysteresis:

```text
close > SMA200 * 1.03   -> slow_state = LONG_ALLOWED
close < SMA200 * 0.97   -> slow_state = LONG_DISABLED
otherwise               -> keep prior slow_state
```

- **No lookahead:** signal on the completed T-day close; execute at T+1 open.
- **Initial slow state:** `LONG_DISABLED` until the first upper-band trigger
  after warmup.

## Layer 2 — fast drawdown circuit-breaker (mainline pinned)

The fast breaker is intentionally simple and generic:

```text
lookback_high = max(close over trailing 30 completed daily closes)
drawdown_from_30d_high = close / lookback_high - 1

if drawdown_from_30d_high <= -20%:
    fast_state = BREAKER_ON

if fast_state == BREAKER_ON and cooldown_days_elapsed >= 10
   and drawdown_from_30d_high > -10%:
    fast_state = BREAKER_OFF
```

Mainline pins:

- **Lookback:** 30 completed daily closes.
- **Trip threshold:** `-20%` from the trailing 30D high.
- **Release threshold:** drawdown recovers to **better than `-10%`** from the
  trailing 30D high.
- **Cooldown:** at least **10 calendar days** after the breaker trip before it
  may release.
- **No lookahead:** trip/release is computed on the T-day completed close and
  affects the T+1 open.

Why these numbers: `30D / 20% / 10% / 10D` is a broad, a-priori crash heuristic,
not a COVID-fit threshold. It is designed to catch rapid crash regimes without
becoming a day-trading stop.

## Layer composition (AND gate)

The final position is:

```text
LONG iff slow_state == LONG_ALLOWED and fast_state == BREAKER_OFF
FLAT otherwise
```

Either layer may disable longs. Neither layer can enable shorts.

The breaker is **reduce-only** relative to v0: it can force `FLAT` or delay
re-entry, but it cannot turn a slow bear into a long and cannot create leverage
or partial sizing.

## Re-entry rule (single mainline)

There is only one mainline re-entry path after a breaker trip:

```text
breaker can release only if:
  cooldown_days_elapsed >= 10
  and drawdown_from_30d_high > -10%

then the strategy may be LONG only if the slow regime gate is also LONG_ALLOWED
```

No alternative `OR` re-entry path is part of the mainline. This avoids silently
loosening the rule after seeing results.

## Positions / costs / benchmark

Same as v0:

- `LONG` = 100% BTC, `FLAT` = 100% cash.
- No leverage, no shorting, no partial sizing.
- Per **executed leg** (each FLAT→LONG or LONG→FLAT): taker fee **0.07%** +
  slippage **0.03%**, applied on that leg.
- Cash earns **0%**.
- Buy-and-hold starts on the strategy's first tradable day, not listing date,
  and pays the same single entry cost.

## Metrics

Same primary metrics as v0:

- CAGR, maxDD, Calmar.
- Sharpe reported but not used as a gate.
- time in market, executed legs, round trips/year, missed upside, per-bear-cycle
  drawdown reduction, explicit CAGR sacrifice.
- Additional v1-only diagnostics:
  - breaker trips,
  - average breaker duration,
  - breaker-triggered exits,
  - breaker false positives (breaker exits followed by no meaningful drawdown),
  - breaker contribution by bear episode.

## Per-cycle evaluation

Same v0 definition:

Identify **major bears** as non-overlapping buy-and-hold drawdown episodes
exceeding **40%**, using running all-time-high peak → trough; include terminal
open drawdown episodes if the window ends before recovery.

For each major bear, report strategy drawdown over the same dates. The strategy
must reduce drawdown in **every** major bear.

## Pre-registered passing bar (set BEFORE running)

Accepted as a legal regime `directionSource` only if **all** hold:

1. **Drawdown materially reduced:** strategy `maxDD <= 0.70 ×` buy-and-hold
   `maxDD` (at least 30% relative reduction).
2. **Risk-adjusted improvement:** strategy `Calmar > buy-and-hold Calmar`.
3. **Per-cycle robustness:** in **every** major bear, strategy drawdown is
   smaller than B&H drawdown; split-half at the temporal midpoint of the usable
   window does not flip the maxDD / Calmar advantage.
4. **Turnover sane:** `<= 6 round trips/year` averaged, where one round trip =
   2 executed legs.
5. **Fast-crash hole closed:** for the known v0 failure episode
   `2019-06-26 → 2020-03-12`, strategy drawdown must be **strictly smaller**
   than B&H drawdown and also smaller than v0's recorded strategy drawdown
   (`-50.10%`). This does **not** relax Gate 3; it makes the v1 repair claim
   explicit.

Anything short of all five gates → **REJECTED**. Do not tune the breaker to
manufacture a pass.

**Epistemic note on Gate 5:** this gate is a **sanity check**, not independent
evidence of robustness. The fast breaker was added specifically because v0
failed the COVID-style fast crash, and Gate 3 already includes that bear. So
"Gate 5 passes" mostly proves that the repair actually repaired the known hole;
it does **not** prove v1 is valid. The real evidence must come from Gates 1–4
still passing, plus cross-asset / cross-episode generalisation.

## Sensitivity (pre-registered; reported, never swapped into mainline)

Breaker sensitivity grid:

- trip threshold: `{15%, 20%, 25%}`
- lookback: `{20D, 30D, 40D}`
- release threshold: `{5%, 10%, 15%}` from trailing high
- cooldown: `{5D, 10D, 20D}`

The mainline remains `30D / 20% / 10% / 10D`. A sensitivity variant may seed a
new hypothesis, but cannot rescue this v1.

Slow-layer sensitivity from v0 may be reported again (`SMA150`, `SMA250`,
3-day confirmation), but **must not** be combined with breaker sensitivity to
search for the best pair. That would be a new hypothesis and a multiple-testing
problem.

## Cross-asset support (overfit guard; cannot rescue BTC)

Run the identical two-layer rule on ETH, S&P 500, and Gold.

Interpretation:

- For each support asset, first identify actual fast-crash episodes matching the
  breaker premise: trailing 30D drawdown of **at least 20%**. Assets with no such
  episodes are marked **not applicable** (neither pass nor fail).
- In support assets with applicable fast-crash episodes, the breaker must reduce
  drawdown in those episodes **and** avoid degrading the asset's overall Calmar.
  This is support evidence, not a gate.
- If BTC passes only because it fixes BTC-COVID while applicable support-asset
  fast crashes do **not** improve, the result is a BTC-specific repair / high
  overfit-risk finding and should **not** be promoted without a separate forward
  test.
- If BTC fails, cross-asset results cannot rescue it.

Cross-asset support is stricter in v1 than v0 because v1 was born from a known
BTC failure episode.

## directionSource semantics (if it passes)

Output is still a **gate**, not a side:

- `long allowed` — slow regime is bullish and fast breaker is off.
- `long disabled` — slow regime is bearish **or** fast breaker is on.

`long disabled` means Alice vetoes new longs and de-risks existing long exposure.
It does **not** endorse a short.

Example proposal context:

```text
directionSource: regime-trend-v1 = long allowed
slow regime:     LONG_ALLOWED
fast breaker:    OFF
risk gates:      funding hot -> size down
execution:       limit-only / small batch
human approval:  required
```

## Decision rule

- **Passes all five gates** → legal `backtested_rule:regime-trend-v1`
  directionSource for the proposal layer, as a long-bias gate.
- **Fails** → record verdict and stop. Do not tune the breaker.

## Deliberately OUT of v1

- Shorting in bear regimes.
- Leverage or partial sizing.
- Intraday circuit-breakers.
- Funding, order book, news, or liquidation data.
- Choosing `SMA150` because it passed the v0 sensitivity grid.

## Research artifacts to save (when run)

Standalone, outside both repos, read-only:

- study script,
- `config.json` with spec commit,
- daily equity curves for strategy, v0 comparator, and B&H,
- trades / flips log,
- breaker events log,
- per-cycle drawdown table,
- split-half metrics,
- sensitivity grid,
- cross-asset support tables,
- final metrics JSON.

No one-off console-only verdicts.

## Research verdict

Not run yet.

## Related

- [regime-trend-v0.md](regime-trend-v0.md) — v1 is a targeted follow-up to v0's
  fast-crash hole, not a replacement via SMA tuning.
- [alice-trading-constitution.md](../alice-trading-constitution.md) — this is a
  `Strategy decides direction` long-bias gate; Alice still has veto power, not
  endorsement power.
- [trade-proposal-principles.md](../trade-proposal-principles.md) — any
  validated regime gate still passes through risk gates, execution gates, and
  human approval.
