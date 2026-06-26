# Backtest spec — Capitulation Mean Reversion v0

A **design spec for a backtest**, not an implemented strategy and not a live
signal. It exists so the rule is pinned on paper before any backtester is
written — and so, *if* it validates, it becomes a concrete
`backtested_rule:capitulation-mean-reversion-v0` that may serve as a
`directionSource` under
[trade-proposal-principles.md](../trade-proposal-principles.md). Until it
validates, it is **not** allowed to drive any proposal.

> **Status:** spec only. No backtester, no signal, no execution. v0 is
> deliberately narrow: OHLCV + BTC 200D SMA + a sharp drop + a close that holds
> + next-bar entry + explicit target / SL / time stop. Nothing else.

## Why two layers (the core methodological rule)

Build and measure these **separately**:

1. **Candidate detector** — does the condition set actually catch
   "post-capitulation bounce candidates"? (Are the candidates real?)
2. **Trade simulation** — traded with a given exit / SL / time stop, is the
   expectancy positive? (Is the *exit rule* any good?)

Conflating them is the trap: a losing result then can't tell you whether the
**signal** is bad or the **exit** is bad. Keep the candidate list and the
trade outcomes as two distinct artifacts.

## Universe / regime / timeframe

- **Universe:** BTC and ETH only for v0. No small-caps mixed in (thin books,
  fake wicks, more slippage — they pollute the result).
- **Regime filter:** BTC > BTC 200-day SMA, computed from the **last
  *completed* daily candle** at signal time — never the current, still-open
  daily close (using today's unclosed close is lookahead bias). (Mean-
  reversion-long only makes sense in an up-regime; this is not a short rule.)
- **Signal timeframe:** 1h or 4h. **Not 15m** for v0 — 15m is noisier and
  carries more slippage / fake lower-wicks.

## Layer 1 — Candidate detector

A bar is a candidate when **all** hold:

1. **Sharp drop — pin the unit (two different meanings, not the same
   condition).**
   - **(a) single signal-bar return ≤ −5%** — on a 1h/4h bar this is *very*
     strict (a 1h candle closing −5% is a rare, extreme move); few candidates.
   - **(b) rolling 24h drawdown ≥ 5%** — an *intraday* drop accumulated across
     the day; matches the original "當日跌幅 ≥ 5%" intent; more candidates.
   Pick one explicitly. v0 leans **(b)** if the target is "intraday
   capitulation"; use (a) only to study single-bar extremes. (Principled
   version of either: worst 5% of the last N same-tf bars — see "must pin".)
2. **The close holds (承接).** On the signal bar:
   - `lower_shadow / (high − low) ≥ 0.4`, **and**
   - `close_position = (close − low) / (high − low) ≥ 0.5`
   i.e. the close recovers to at least the middle of the bar's range.
3. **Regime.** BTC daily close > BTC 200D SMA (from the regime filter above).

**Entry rule.**
- Confirm on the **signal bar's close**.
- Enter at the **next bar's open**.
- No intrabar entry-and-exit within the same candle (no lookahead — the signal
  bar is fully closed before entry).

## Layer 2 — Trade simulation

Three simple exits for v0 — don't over-tune up front:

- **Target.** Mean-revert back toward the local mean: the EMA of the ~20 bars
  preceding the signal bar (EMA20 as a VWAP proxy when no VWAP). See "must pin"
  for fixed-vs-trailing.
- **Stop loss.** `signal_candle_low − 0.5 × ATR`. (Not `low − 1bp` — that gets
  swept by a second probe of the low.)
- **Time stop.** If target isn't hit within **8 × 1h bars** (or **4 × 4h
  bars**) after entry, close at market. ⚠️ These are **not** equal wall-clock:
  8×1h = 8h but 4×4h = 16h — see "must pin" #6 (equalise to 2×4h, or keep the
  longer 4h leash on purpose).
- **Collision rule.** If a single bar touches **both** target and stop, assume
  the **pessimistic** outcome — stop first.

## Deliberately OUT of v0 (veto / label only, not in the engine)

Keep these out of the backtest engine for v0; use them as live vetoes or
post-hoc labels so we don't confound the core signal:

- **Funding** — record funding state before/after each candidate; check
  *afterwards* whether it improves outcomes. Not an entry condition yet.
- **News** — manual veto only, never in the engine.
- **Liquidation data** — defer to v2, once the data source is stable.

## Evaluation metrics

Win rate is **not** the headline. Report:

- candidate count
- average return per trade
- profit factor
- max drawdown
- average adverse excursion (AAE)
- time-to-mean (bars to target)
- stop-hit rate
- time-stop rate
- **vs a random-entry control** — same regime, same universe, same exit
  rules, entries at random bars. If the signal can't beat random entry into
  the same exit machinery, the *signal* adds nothing (and any positive result
  is the exit rule, not the detector).

## Must pin before implementing (open spec gaps)

These would block a backtester on day one — decide them here, not in code:

1. **ATR period.** `0.5 × ATR` of *what* lookback? Propose **ATR14** on the
   signal timeframe. Pin it.
2. **Target: fixed level vs trailing.** Is the target the EMA20 value computed
   **as of the signal bar** (a fixed price level), or the live trailing EMA20
   that moves each bar? v0 default: **fixed level at signal-bar close** (no
   moving goalpost). Trailing is a v1 variant.
3. **Costs.** Even an OHLCV-only v0 must subtract an explicit cost assumption,
   or "positive expectancy" may be fees + slippage in disguise (the classic
   "profitable backtest, losing live"). Propose a flat **taker fee + a few bps
   slippage on next-bar-open entry** (e.g. ~0.05% × 2 + 2–5 bps); state the
   number so net expectancy is honest.
4. **Data source + venue.** OHLCV from where? Per the venue-consistency
   invariant, backtest on the **same venue you would execute on** (Binance vs
   OKX have different books/funding). Pin the source (e.g. CCXT historical from
   the chosen venue) so a later live deployment matches the backtest venue.
5. **Percentile window N.** For the "worst 5% of last N bars" version of the
   sharp-drop condition, pin N (e.g. a rolling ~500 same-timeframe bars). v0
   may start with the flat −5% and add the percentile version as a comparison.
6. **Time-stop wall-clock.** 8×1h = 8h but 4×4h = 16h — not equal. Decide: keep
   the 4h leash longer on purpose, or set the 4h time stop to **2 bars** so both
   timeframes risk ~8h. State which, so the two timeframes are comparable.

## Done / next

When all five "must pin" items are decided, the spec is implementable. Build
order: **candidate detector first** (just emit the candidate list + the metrics
that don't need exits — count, regime coverage), confirm the candidates look
sane, *then* add the trade simulation. Validate against the random control
before this rule is ever allowed near a proposal.

## Related

- [trade-proposal-principles.md](../trade-proposal-principles.md) — a validated
  rule here becomes a legal `directionSource`; an unvalidated one must not.
- [monitoring.md](../monitoring.md) — funding / order book live signals (v0 keeps
  these out of the engine).
