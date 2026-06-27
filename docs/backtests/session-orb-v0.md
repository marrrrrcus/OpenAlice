# Backtest spec — BTC Session ORB v0

A **design spec for a backtest**, not an implemented strategy and not a live
signal. It exists so the rule is pinned on paper *before* any backtester is
written — and so, *if* it validates, it becomes a concrete
`backtested_rule:session-orb-v0` that may serve as a `directionSource` under
[trade-proposal-principles.md](../trade-proposal-principles.md). Until it
validates, it is **not** allowed to drive any proposal.

> **Status:** RUN AND REJECTED (2026-06). The pre-registered run failed all four
> S2 passing-bar criteria, and failed *cleanly* — S2 is negative in every
> quarter and stays negative under every leave-one-quarter-out refit, i.e. there
> is no edge to concentrate. `session-orb-v0` is **not** a `directionSource`: no
> signal, no proposal, no execution. See "Research verdict" below.

## The one question v0 answers (and the honest prior)

> Does a session opening-range breakout on BTC produce **more short-term
> continuation than a random-time, random-direction entry into the same exit
> machinery**?

Honest prior, stated up front because it shapes the whole test: **BTC trades
24/7.** There is no opening auction, no closing auction, and no overnight gap to
fade. So the equity-market basis for an "ORB session" is physically weaker here.
That means the **random-time baseline is not a sanity check — it is the entire
exam.** If the OR breakout cannot beat a random intraday entry into identical
TP/SL/time-stop geometry, it is folklore and the line stops here.

Deliberately **out of v0**: funding, news, order book. v0 asks only the question
above. If it shows an edge, funding / microstructure get discussed later as
*execution* filters, never as the v0 detector.

## Why two layers (same methodological rule as capitulation v0)

Build and measure **separately**:

1. **Candidate detector** — did a qualifying breakout actually occur this
   session? (Are the entries real and lookahead-free?)
2. **Trade simulation** — with the fixed TP / SL / time stop, is expectancy
   positive net of cost? (Is the *exit rule* any good?)

Conflating them hides whether a losing result is a bad signal or a bad exit.

## Universe / data / venue

- **Universe:** `BTCUSDT` only (Binance USD-M perp). No alts in v0.
- **Data:** V8 `data/warehouse/symbol=btcusdt/` — Binance USD-M **1-minute
  OHLCV** (`timestamp/open/high/low/close/volume`). 1m is the native grid; the
  OR and all fills are resolved on 1m. Satisfies the constitution's
  `Execution venue must match data venue` (signal venue = execution venue =
  Binance).
- **Official window (pinned):** reuse the validated capitulation window
  `2024-07-19T00:00:00Z → 2026-06-01T00:00:00Z` (exclusive), ≈ 22.5 months, so
  the data-integrity work already done (0 missing minutes / 0 dup ts / 0 bad
  OHLC; 39 filled volume=0 bars across 3 months) carries over unchanged.

## Sessions (pinned — exact UTC, DST handled)

Two session types, **reported separately, never pooled** (their priors differ):

- **S1 — "UTC-00:00".** OR window = the 15 one-minute bars `00:00–00:14 UTC`.
  Trade window = `00:15 → 04:00 UTC`, force-close at `04:00`.
  ⚠️ **Honesty flag:** 00:00 UTC is the Binance funding/daily boundary, **not a
  real liquidity session with an open/close auction.** The 4-hour horizon is an
  *explicit arbitrary pin*, not a market-defined close. Treat S1 as the weaker
  hypothesis; do not let it average with S2.
- **S2 — "US equity open".** Session start = `09:30 America/New_York`,
  converted to UTC **per day, DST-aware** (EDT → 13:30 UTC, EST → 14:30 UTC) —
  the whole hypothesis is equity-open liquidity, so it must track the real open,
  not a fixed UTC clock. OR window = first 15 one-minute bars from session
  start. Trade window = OR-close → `16:00 America/New_York` (US cash close,
  DST-aware), force-close at the close. No overnight.

  **S2 runs ONLY on regular NYSE trading days (pinned).** If the hypothesis is
  "equity-open liquidity," then a non-trading day has no equity open to track,
  and counting it would pollute S2 with pure-crypto noise (a Saturday 09:30 ET
  has no auction behind it). Therefore:
  - **Exclude weekends** (by the **ET** calendar date, not UTC).
  - **Exclude full NYSE holidays.**
  - **Exclude early-close (half) days entirely** (option A — simplest, cleanest
    for v0). Using the official 13:00 ET close (option B) is deferred to v1; v0
    drops these days so no day has an ambiguous force-close time.

  The simulator pins an **explicit, auditable NYSE calendar** for the official
  window (a vetted `XNYS` calendar / baked-in date list) and **writes the list
  of excluded S2 dates into the run artifacts**, so the gate is reproducible and
  reviewable — not a hidden library default.

## Layer 1 — Candidate detector (pinned)

For a given session on a given day:

1. **Opening range.** `OR_high = max(high)` and `OR_low = min(low)` over the 15
   OR-window 1m bars. `OR_range = OR_high − OR_low`.
2. **Breakout trigger = 1m *close* beyond the level** (not an intrabar touch —
   touch-based gets swept by wicks and is dishonest to model):
   - Long: a 1m bar **closes > OR_high**.
   - Short: a 1m bar **closes < OR_low**.
   - Watched only from the first bar *after* the OR window until trade-window
     end.
3. **One trade per session.** The **first** qualifying close (long or short,
   whichever fires first chronologically) is the trade. After a stop, **no
   re-entry** that session.
4. **Direction:** symmetric (long and short both eligible). **No regime
   filter** — ORB is direction-neutral intraday.

**Entry fill (no lookahead):** the **next 1m bar's open** after the trigger bar.
If that next bar is at/after trade-window end, **skip** (no trade).

### RVOL — deliberately OFF in the mainline

The user's spec lists an RVOL filter. It is **pre-registered but kept OUT of the
v0 mainline**, for two reasons:

- **Sample preservation.** v0's job is to answer the core question with maximum
  statistical power; a filter that thins the sample first (the v1a failure mode)
  defeats that.
- **A real trap on S2.** The US-open breakout bar is *almost always* high-volume
  versus the quiet pre-open hour, so a naïve `breakout_vol / trailing-60-mean`
  RVOL is ≈ always above threshold on S2 — the filter does nothing but pretends
  to. **The trailing-60 RVOL is therefore rejected.**

RVOL enters only as a **sensitivity overlay**, and only in its meaningful form:
`breakout_bar_vol / median(volume at the same minute-of-session across the
trailing K same-type sessions)`, threshold ∈ {1.5, 2.0, 3.0}. This isolates
"unusually active *for this session*," which is the actual hypothesis.

## Layer 2 — Trade simulation (pinned)

- **Risk unit.** `R = |entry − SL|`.
- **Stop loss = opposite OR side.** Long: `SL = OR_low`. Short: `SL = OR_high`.
- **Target (mainline = 1R).** Long: `entry + 1R`. Short: `entry − 1R`.
  **1.5R is a sensitivity axis, not a second mainline** (avoids the v1a "every
  positive variant is n=3..6" trap — one pinned mainline only).
- **Time stop.** Force-close at market at **trade-window end** (S1 04:00 UTC /
  S2 16:00 ET). No overnight.
- **Collision rule.** If a single 1m bar touches **both** TP and SL, assume the
  **pessimistic** outcome — **stop first** (same as capitulation v0).
- **Gap handling.** If the entry-fill open is already at/through the SL, the
  trade is a `gap_stop` filled at that open (the v0 simulator's P2 fix).

## Costs (pinned — breakout entries cost more)

Breakout fills are adverse by nature (you buy strength / sell weakness), so v0
uses a **higher slippage than the mean-reversion v0**:

- Fee: `0.05%` per side (taker).
- Slippage: **`0.06%` per side** (vs 0.03% for capitulation) — a breakout stop
  fill is worse than a limit fill.
- Round-trip `RT = (0.0005 + 0.0006) × 2 = 0.0022` (22 bps).

Net per trade subtracts `RT`. For a 1R intraday strategy the edge is small, so
an honest, slightly pessimistic cost is the difference between a real result and
"profitable backtest, losing live."

## Evaluation (pinned)

Win rate is **not** the headline. Per **session type separately** (S1, S2 — never
pooled) report:

- candidate count and entered count
- average return / trade (net of cost), profit factor, sum return
- target / stop / time-stop mix
- **per quarter**, **per month**, and **leave-one-quarter-out (LOQO)** — the
  capitulation killer was time-concentration; LOQO-min must stay positive
- **first-half vs second-half** split
- **Random baseline (the real exam) — geometry pinned exactly.** For each real
  session, randomize **entry minute** (any 1m bar inside that session's trade
  window) and **direction** (50/50). Risk scale is fixed to the session's
  opening range:

  ```text
  R = OR_range
  Long:  SL = entry − R,        TP = entry + target_R × R
  Short: SL = entry + R,        TP = entry − target_R × R
  ```

  (`target_R` = the mainline 1R, or the sensitivity value being tested.) Same
  exit machinery as the real trade — pessimistic stop-first collision,
  force-close at trade-window end, costs subtracted. 1000 draws → report the
  actual ORB result's percentile in that distribution. This isolates the one
  thing v0 tests: **at the same per-session risk scale, is the ORB *trigger
  time + direction* better than a random time + random direction?**

  > **Known approximation (on the record, not hidden):** the *real* ORB trade's
  > `R = |entry − opposite_OR_side|`, and because entry is the next-bar open
  > *beyond* the OR edge, real `R` is slightly **larger** than `OR_range` (by the
  > breakout overshoot). The baseline uses `R = OR_range` exactly. This small
  > mismatch is accepted for v0 because matching the *risk scale per session* is
  > the clean comparison; if the headline result lands borderline (just over /
  > under the 90th-pct bar), re-run a stricter baseline variant with
  > `R = real per-session |entry − SL|` before drawing a conclusion.

## Pre-registered passing bar (set BEFORE running — do not move after)

v0 is **accepted as a research lead** only if **all** hold:

1. **Sample sufficiency.** ≥ **100 trades per session type** over the window.
   ORB fires ~daily, so far fewer means a definition is over-filtering — stop
   and inspect, don't celebrate a tiny positive.
2. **S2 carries it.** S2 (the real session) net-of-cost avg/trade **> 0** and
   PF **> 1.1**. S1 is reported but is *not* allowed to rescue a failed S2.
3. **Beats random.** S2 actual at **≥ 90th percentile** of the random-baseline
   distribution.
4. **Time stability.** S2 survives LOQO — **every** leave-one-quarter-out
   refit stays **> 0** (no single quarter is the whole edge).

Anything short of all four → **REJECT**. Per the constitution and the
capitulation precedent: **do not stack funding / OI / liquidation / news filters
to rescue a failed v0.** A continuation must be a new, separately pre-registered
hypothesis.

## Research artifacts to save (when run)

Standalone, **outside both repos**, read-only on the V8 warehouse (same
discipline as `capitulation_v0_backtest/`):

- simulator script, config JSON, output JSON
- candidates CSV, trades CSV (per session type)
- per-quarter / per-month / LOQO CSV
- random-baseline distribution

Do not rely on a one-off console table.

## Research verdict — REJECTED (2026-06)

The simulator was built as a standalone research artifact at
`C:\Users\Marcus\OneDrive\Desktop\session_orb_v0_backtest\` (read-only on the V8
warehouse, no Alice runtime touched) and preserves: `orb_v0_sim.py`,
`config.json`, `output.json`, `sessions.csv`, `excluded_s2_dates.csv`,
`candidates.csv`, `trades.csv`, `monthly.csv`, `quarterly.csv`, `loqo.csv`,
`random_baseline.csv`. Costs included (fee 0.05% + slip 0.06% per side, RT
22 bps); mainline `target_R = 1`; seed 42; NYSE gate via
`pandas_market_calendars XNYS` (462 regular S2 sessions, 220 excluded dates).

Mainline result (net of cost):

| Session | Sessions | Trades | Avg / trade | PF | Sum | Random pct |
|---|---:|---:|---:|---:|---:|---:|
| S1 — UTC 00:00 | 682 | 679 | **−0.249%** | 0.224 | −168.95% | 1.1 |
| S2 — US open | 462 | 462 | **−0.246%** | 0.555 | −113.58% | 22.1 |

**Pre-registered passing bar — failed on every S2 criterion:**

| Criterion | Result |
|---|---|
| Sample sufficiency (≥100 / session type) | ✅ S1 679, S2 462 |
| S2 avg/trade > 0 | ❌ −0.246% |
| S2 PF > 1.1 | ❌ 0.555 |
| S2 beats random ≥ 90th pct | ❌ 22.1th |
| S2 LOQO all-positive | ❌ every quarter negative |

**The headline read (S2 is the real exam):**

> US-equity-open ORB has **no short-term continuation edge on BTC.** It does not
> merely fail to win — it **loses to a random-time / random-direction entry**
> into the identical exit machinery (22.1th percentile, i.e. ~78% of random
> draws did better).

And it is **not** a time-concentration artifact (the way capitulation v0's
apparent edge was a single quarter). S2 is negative in **all 8 quarters**
(`−0.15%` to `−0.42%`), and LOQO leaves it negative whichever quarter is dropped
(`−0.219%` to `−0.257%`). There is simply no edge present to begin with — the
cleanest possible rejection.

**Why it fails structurally (not a tuning miss):**

- **Cost devours the risk unit.** A 15-minute opening range on BTC gives a small
  `R`; a 22 bps round-trip is a large fraction of it, so even on a rough *gross*
  read S2 sits near zero or slightly negative. There is no edge headroom to tune
  into.
- **ORB is not a rare signal here.** It fires on ~99% of sessions (679/682 S1,
  462/462 S2) — it is a routine volatility artifact, not a selective setup. A
  signal that triggers every day and loses to random is folklore, not edge.
- **S1 is worse and cannot rescue S2** (PF 0.224, 1.1th pct). The two were never
  pooled, exactly so S1's noise could not flatter S2.

**RVOL overlay was correctly not run.** The spec left the trailing-`K`
same-session baseline unpinned, so running it would have meant inventing an
unauthorized parameter. It is moot anyway: an overlay can only *shrink* a sample
that is already structurally negative in every quarter (the v1a lesson) — it
cannot manufacture an edge that the unfiltered signal does not have.

**Final v0 decision:** **REJECTED. Do not trade. Do not promote to proposal. Do
not use as `directionSource`.** Per the constitution and the capitulation
precedent: do **not** stack funding / OI / liquidation / news / RVOL filters to
rescue a signal that is negative in every quarter. Any future ORB work must be a
new, separately pre-registered hypothesis with a materially different premise
(e.g. a different instrument with a real session structure, or a cost regime
where `R` is large relative to fees) — not a filter bolted onto this one.

## Related

- [alice-trading-constitution.md](../alice-trading-constitution.md) — North
  Star. `Strategy decides direction`; a rule may drive a `directionSource` only
  after it passes here. `Safety flow does not create edge`.
- [trade-proposal-principles.md](../trade-proposal-principles.md) — a validated
  rule becomes a legal `directionSource`; an unvalidated one must not.
- [capitulation-mean-reversion-v0.md](capitulation-mean-reversion-v0.md) —
  prior line (rejected); this spec reuses its window, data-integrity work, two-
  layer method, pessimistic collision rule, and gap-stop fix.
