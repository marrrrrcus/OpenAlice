# Backtest spec — BTC Funding Pulse v1 (Layer-1 study)

A **pre-registered diagnostic study**, not a strategy and not a backtest of a
tradable rule. It exists because
[funding-exhaustion-v0.md](funding-exhaustion-v0.md) came back INCONCLUSIVE
(sample-starved): the price-failure confirmation + de-clustering starved an
already-rare event set, so we never measured the *underlying* question. v1 asks
only that question, with no trade machinery to muddy it:

> **Does extreme BTC perpetual funding itself predict a future price move
> *against the crowd* — a "reversion pulse" — beyond a matched random-time
> draw, with statistics that respect overlapping / clustered samples?**

If a pulse is confirmed here, *then* a confirmation-gated tradable rule becomes
worth re-pinning (a future v2). If not, the funding-exhaustion family is closed
on BTC-only / 2-year data. **v1 produces no signal, no `directionSource`, no
proposal, no trade — it is evidence about a hypothesis, nothing more.**

> **Status:** PRE-REGISTERED DRAFT. Not run. This file fixes every
> result-swinging definition — sign conventions, no-lookahead standardization,
> the overlap/independence handling, the primary cell, and the passing bar —
> before any code exists.

## What v1 is and is NOT

- **Is:** a measurement of conditional forward *price* return after extreme
  funding, per side, with block-aware inference.
- **Is NOT:** a trade. There is **no entry confirmation, no stop/target, no time
  stop, no de-clustering into trades, no fees, and no funding cashflow** —
  funding carry is irrelevant to "does price move," which is purely a price
  question. (That is the whole point of separating Layer-1 from a tradable rule.)
- **Is NOT** allowed to drive anything live regardless of outcome.

## Universe / data / window

- **Universe:** `BTCUSDT` (Binance USD-M perp). Signal + outcome both Binance.
- **Data:** V8 `data/funding_rates/symbol=btcusdt/` (8h realized funding:
  `timestamp` ms / `funding_rate` / `mark_price`) + the BTCUSDT 1m OHLCV
  warehouse (for forward returns). Funding cadence verified 8h at 00/08/16 UTC,
  ms-level jitter → **row order, never exact `F-8h` equality** (the v0 lesson).
- **Official window:** reuse `2024-07-19 → 2026-06-01` (exclusive), ≈ 22.5
  months.

## Signal — funding extremeness (no-lookahead, per side)

At each funding settlement row `i` (settlement time `F`), using **only rows with
timestamp < F**:

1. **24h funding sum (row order):**
   `funding_sum_24h(row_i) = funding_i + funding_{i-1} + funding_{i-2}`.
2. **Trailing standardization (past-only):** over valid `funding_sum_24h` rows
   with `timestamp < F` in the trailing **365 days** (require ≥ **180 days** of
   history, else the row is unusable), compute mean `μ` and std `σ`, then
   `z(i) = (funding_sum_24h(i) − μ) / σ`. No current/future row enters `μ, σ`.
3. **Per-side extremeness** (the two sides are **separate sub-hypotheses**, never
   pooled):
   - **Positive side** (crowded longs): extremeness `e⁺ = z`, considered over
     events with `z ≥ 0`.
   - **Negative side** (crowded shorts): extremeness `e⁻ = −z`, considered over
     events with `z ≤ 0`. (So "larger `e` = more extreme" on both sides.)
4. **p90 tail (primary):** an event is in the side's tail if its `z` is beyond
   the **trailing 90th percentile** of that side's `z` (positive side: `z ≥`
   trailing-p90; negative side: `z ≤` trailing-p10). p95 / p99 are computed for
   support only, never as a gate (their tails are too thin once split per side).

## Outcome — signed forward price return (per side)

Log return over the **primary horizon, pinned a priori at 24h**, signed so that
"the crowd is wrong" is **positive**:

```text
positive side (expect price DOWN):  signed_return = − ln( P_{F+24h} / P_F )
negative side (expect price UP):     signed_return = + ln( P_{F+24h} / P_F )
```

`P_F` = 1m close at/just after the settlement becomes usable (`F + 1 minute`,
the v0 conservative buffer); `P_{F+24h}` = 1m close 24h later. Horizons
**{1h, 4h, 12h, 48h}** are computed as **diagnostics only** — reported, never
gated, and never used to pick a "best" horizon after the fact.

## P0 — overlap / independence (statistics must not double-count)

Extreme funding clusters: it recurs across consecutive settlements, **and** the
24h forward windows of nearby events overlap (a T and a T+8h share 16h of
outcome). Treating these as independent makes any p-value / percentile falsely
tight. Therefore:

- **Raw samples** are kept only to *display* the distribution.
- **All inference** (slopes, CIs, the random percentile) uses a **monthly block
  bootstrap** — resample whole calendar-month blocks (preserving within-month
  clustering and forward-window overlap), recompute the statistic per resample,
  and read CIs / percentiles off the bootstrap distribution. Monthly (not
  weekly) is the pinned block size — weekly can leave 24h/48h overlap and funding
  regime persistence under-accounted.
- **Effective sample = episode count**, not raw rows. An **episode** = a maximal
  run of same-side tail events with gaps ≤ 24h (consecutive crowded settlements
  collapse into one episode for *counting*; raw rows remain for distribution).
- **Matched random baseline is itself block-aware:** the null is built by
  **monthly-block-resampling random settlement times** (matched side, matched
  count, same 24h horizon, same `P_F`/`P_{F+24h}` machinery), so the null's
  variance is not understated. A naive iid random draw is **not** acceptable.

## Sample-size tiers (per side, in episodes)

- **< 20 episodes → INCONCLUSIVE.** Not judged against the passing bar.
- **20–29 episodes → weakly testable / low confidence.** May be reported, but
  **no strong conclusion** is permitted (no "edge confirmed," no promotion path).
- **≥ 30 episodes →** eligible for full passing-bar judgement.

## Pre-registered passing bar

**Primary cell = 24h horizon × p90 tail × per-side.** A side shows a pulse only
if **all** hold *for that side* (passing one side validates only that side — a
positive-funding short pulse does **not** imply a negative-funding long pulse):

- **Gate A — the pulse exists (continuous).** Slope of `signed_return(24h)` on
  that side's extremeness `e` (over the side's `e ≥ 0` half) is in the predicted
  direction (slope **> 0**) with a **monthly block-bootstrap CI that excludes 0**.
  This uses all of the side's data and does **not** depend on tiny tail means.
  **The side-half slope is the gate (for sample size); a p90-tail-only slope is
  additionally reported as a *diagnostic, not a gate*** — the honesty check on
  whether the tail is genuinely more pulse-like than the body, without letting
  the dense, near-zero-extremeness centre dilute the gate.
- **Gate B — it lives in the tail and beats random.** The **p90 tail** mean
  `signed_return(24h)` beats the **monthly-block-aware matched-random** null at
  **≥ 90th percentile**.
- **Gate C — time-stable.** Leave-one-quarter-out (and leave-one-month-out as a
  finer check): the Gate-A slope sign and the Gate-B tail sign **do not flip**.
  No single period is the whole effect.

**Support only (never a hard gate):**

- p90 → p95 → p99 is **roughly strengthening** (Spearman rank-corr of
  `signed_return` on `e`, or the same regression slope) — directional support,
  **not** a strict raw-mean ladder.
- p99 must **not** be clearly opposite in sign (a pure sanity check; its tail is
  too thin to gate on).

Anything short of Gates A+B+C (on a side with ≥ 30 episodes) → that side shows
**no confirmed pulse**. Per the constitution and the v0 / ORB / capitulation
precedent, do **not** loosen definitions or stack filters to manufacture one.

## Decision rule (what each outcome means)

- **A side passes A+B+C (≥30 episodes):** a *pulse* is evidenced on that side.
  This still is not a tradable rule — it makes a **new, separately pre-registered
  v2** (confirmation-gated, with execution / costs / funding cashflow) worth
  pinning, for that side only.
- **No side passes, all sides ≥30 episodes:** the funding-exhaustion family is
  **closed** on BTC-only / 2-year data — there is no price pulse to gate a trade
  on. Stop the line.
- **Sides below 30 episodes:** **INCONCLUSIVE** — the question is unanswerable on
  this data; continuation needs more data (longer history / another venue), a
  separate decision.

## Deliberately OUT of v1

- Trade machinery (entry confirmation, stop/target, time stop), de-clustering
  into trades, fees, funding cashflow — all belong to a future v2, not to a
  pulse measurement.
- OI / liquidation / news / order book — not inputs to "is there a price pulse."
- ETH / SOL — separate hypotheses; never pooled with BTC.

## Research artifacts to save (when run)

Standalone, **outside both repos**, read-only on V8: study script, `config.json`
(window, horizon, percentile, trailing/history days, block size, seed),
`output.json`, per-side raw-events CSV (z, e, signed_return at all horizons),
per-side slope + bootstrap-CI, p90/p95/p99 tail means, monthly-block random null
distribution, LOQO / leave-one-month CSV, episode counts per side. Deterministic
seed; no one-off console tables.

## Research verdict

> _Pending — not yet run._

## Related

- [alice-trading-constitution.md](../alice-trading-constitution.md) — `Strategy
  decides direction`; a pulse here is *evidence*, not yet a `directionSource`.
  `Safety flow does not create edge`.
- [funding-exhaustion-v0.md](funding-exhaustion-v0.md) — the tradable rule whose
  INCONCLUSIVE verdict mandated this Layer-1 study first.
- [trade-proposal-principles.md](../trade-proposal-principles.md) — only a
  validated rule (a future v2, if v1 shows a pulse) may drive a proposal.
- [session-orb-v0.md](session-orb-v0.md),
  [capitulation-mean-reversion-v0.md](capitulation-mean-reversion-v0.md) — prior
  lines; v1 reuses their no-lookahead discipline, random-baseline-as-exam, and
  time-stability checks, and adds block-aware inference for clustered samples.
