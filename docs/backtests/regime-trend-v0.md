# Backtest spec — BTC Regime Trend v0 (long / flat)

A **pre-registered design spec for a backtest**, not yet run. Unlike the prior
lines, this does **not** hunt a short-term predictive edge. It tests one humble,
externally-supported idea:

> *I am long BTC for the long run, but I do not want to ride a full bear market
> down.* Does a slow regime filter (long in up-regime, **flat** in down-regime)
> beat buy-and-hold BTC on a **risk-adjusted** basis (max drawdown / Calmar),
> across multiple cycles, **net of whipsaw costs**?

If it validates, it becomes a legal `backtested_rule:regime-trend-v0` whose
output is a **regime gate** — `long allowed` / `long disabled` — that may serve
as a `directionSource` under
[trade-proposal-principles.md](../trade-proposal-principles.md). It is **not** a
short signal and **not** alpha (see framing).

> **Status:** RUN — REJECTED (2026-06), but a *disciplined near-miss*, not a
> dud. Spec was locked at `b72ee3e` and committed **before** the run; the study
> was verified to implement it faithfully. BTC mainline **beat buy-and-hold on
> every aggregate metric** (CAGR, maxDD, Calmar, Sharpe, final equity) yet
> **failed Gate 3**: the 200-day filter did not protect in the 2019–2020 fast
> crash (strategy −50.10% vs B&H −49.43%, a 0.67 pp near-tie). Per the
> pre-registered "smaller DD in *every* major bear" rule, that is a REJECT — not
> a `directionSource`. See verdict below.

## Honest framing — what this is and is NOT

- **Is:** trend-following / regime management of BTC **beta**. Its value is
  **drawdown reduction** (getting out of the worst bears), not market-beating
  return. Trend-following is one of the few effects with multi-decade, cross-asset
  out-of-sample evidence — so this is **not folklore** like the prior lines.
- **Is NOT** market-neutral alpha. In a bull-dominated sample, "long above the
  SMA" ≈ buy-and-hold; the only honest edge is the **downside trim**.
- **Is NOT** a price prediction. It **reacts** to the current regime and holds
  until it changes — consistent with `Alice does not predict price`.
- **Benchmark is buy-and-hold BTC, NOT random.** The question is purely "does the
  regime overlay improve risk-adjusted outcomes over simply holding?" If it
  cannot beat buy-and-hold on max drawdown / Calmar, it has **no value**.

## Universe / data / window

- **Mainline asset:** **BTC spot daily, Binance `BTCUSDT`** (public klines,
  free, reproducible). Spot history reaches back to listing (2017-08-17).
- **Venue note (accepted mismatch):** the signal uses spot daily closes while
  live execution is on the perp. This is acceptable **only because** the signal
  is a slow 200-day macro regime filter, not an execution-price signal — the
  spot/perp basis is negligible at that timescale. Stated explicitly so it is on
  the record (cf. the constitution's `Execution venue must match data venue`,
  which this consciously relaxes for a macro filter, not a trade-price signal).
- **Window:** listing → `2026-06-01`. With a 200-day SMA warmup the strategy is
  **usable from ≈ 2018-03**, giving ≈ 8 years that span **multiple full cycles**
  (2018 bear, 2019 run, 2020 COVID crash, 2021 bull, 2022 bear, 2023–2025 bull) —
  the multi-cycle coverage that V8's 2.5-year window structurally lacked.
- **External data:** fetched read-only at run time (Binance public API for
  BTC/ETH; a public daily source — e.g. Stooq — for SPX / Gold). Lives **outside
  both repos**; never touches Alice runtime.

## Mainline rule (pinned)

`SMA200` = 200-day simple moving average of daily close, **completed candles
only**. `±3%` band hysteresis (single clean mechanism — opens high, closes low,
holds in between):

```text
close > SMA200 * 1.03   -> long allowed   (state = LONG)
close < SMA200 * 0.97   -> long disabled  (state = FLAT)
otherwise               -> keep prior state
```

- **No lookahead:** state is computed on the **T-day completed close**; the
  position change is executed at the **T+1 day open**.
- **Positions:** `LONG` = 100% BTC, `FLAT` = 100% cash. Binary, no leverage, no
  partial sizing in v0.
- **Initial state:** FLAT until the first `close > SMA200*1.03` after warmup.

## Costs (pinned — so the buy-and-hold comparison is fair)

- Per **executed leg** (each FLAT→LONG or LONG→FLAT): taker fee **0.07%** +
  slippage **0.03%**, applied on that leg. (One round trip = 2 legs, so its cost
  is ~`2 × 0.10% = 0.20%` — consistent with the turnover units above.)
- **Cash (FLAT) earns 0%** — conservative; no T-bill / stablecoin yield credited.
- Buy-and-hold pays the same entry cost once and nothing thereafter. (The regime
  strategy must overcome its *extra* turnover cost to win — that is the point.)

## Benchmark

**Buy-and-hold BTC**, started on the **strategy's first tradable day** — the
first executable open *after* the 200-day SMA warmup (≈ 2018-03), **not** the
listing date. Both the strategy and B&H equity curves are indexed from that same
common start, so B&H does **not** get an unfair extra ~200 days of exposure (the
strategy simply begins FLAT and goes LONG on its first valid signal). Same single
entry cost. Every metric below is reported for **both**, over the identical
window from that common start.

## Metrics

- **CAGR**, **max drawdown** (peak-to-trough on the equity curve), **Calmar**
  (`CAGR / |maxDD|`) — *primary*.
- **Sharpe** — *secondary only* (crypto returns are fat-tailed / non-normal; do
  not lead with it).
- **time in market** (% days LONG), **turnover** (`executed legs` = each
  entry/exit; `round trips = executed legs / 2`), **missed upside** (return given
  up vs B&H in up-moves), **per-bear-cycle drawdown reduction**, and the explicit
  **CAGR sacrifice** (the price of the insurance).

## Per-cycle evaluation (operationalises "not one cycle only")

Identify **major bears** as **non-overlapping** buy-and-hold drawdown episodes
exceeding **40%**: track the running all-time high; a bear episode runs from a
running-high **peak** to its subsequent **trough** (the lowest close before a new
all-time high is made); episodes whose peak-to-trough drawdown exceeds 40% are
the major bears. By construction they cannot double-count the same decline. **If
the window ends while price is still below a prior running high** (an unfinished
decline), that **terminal open drawdown episode** (peak → lowest close through
the window end) is **also included** when it exceeds 40%, so the last bear is
never silently dropped. For **each** such bear, report the strategy's drawdown
over the same dates. The drawdown-reduction claim must hold in **every** major
bear, not on average — a filter that only dodged one bear is curve-fit to that
bear.

## Pre-registered passing bar (set BEFORE running)

Accepted as a legal regime `directionSource` only if **all** hold:

1. **Drawdown materially reduced:** strategy `maxDD ≤ 0.70 ×` buy-and-hold
   `maxDD` (≥ 30% relative reduction).
2. **Risk-adjusted improvement:** strategy **Calmar > buy-and-hold Calmar**
   (i.e., the drawdown trim more than pays for the CAGR given up).
3. **Per-cycle robustness:** in **every** major bear (B&H peak-to-trough > 40%),
   the strategy's drawdown is smaller than B&H's; and a split-half at the
   **temporal midpoint of the usable window** (≈ 2022-04; exact date recorded in
   `config.json`) does not flip the maxDD / Calmar advantage.
4. **Turnover sane:** ≤ **6 round trips per year** averaged, where one round trip
   = 2 executed legs (one FLAT→LONG + one LONG→FLAT). A 200-day ±3% filter should
   flip rarely; more means it is whipsawing and the costs are not honest
   insurance.

Sharpe is reported but is **not** a gate. Anything short of all four → **REJECT**
(it does not beat simply holding, risk-adjusted). Per the constitution and the
prior-line precedent, do **not** tune the band / SMA / costs to manufacture a
pass.

## Sensitivity (pre-registered; reported, never swapped into the mainline)

- `3-day confirmation` variant (require 3 consecutive closes beyond the band
  before flipping) instead of the instantaneous ±3% band.
- `SMA` ∈ {100, 150, 250} and band ∈ {±2%, ±5%} — to show the result is not a
  knife-edge on 200 / ±3%. **The best variant is not adopted**; 200 / ±3% is the
  pinned convention.

## Cross-asset support (NOT a gate; cannot rescue BTC)

Run the **identical** rule on **ETH, S&P 500, Gold** (daily). If most show the
same pattern (lower maxDD, higher Calmar vs their own buy-and-hold), it supports
the conclusion that this is a **general property of trend-following**, not a BTC
curve-fit — the closest thing to true OOS when BTC gives only one asset's
history.

> **Hard rule:** cross-asset results are **support only**. If the **BTC
> mainline** fails its passing bar, the line is **REJECTED** regardless of how
> good ETH / SPX / Gold look. Good behaviour elsewhere never rescues a failed
> mainline.

## directionSource semantics (if it passes)

Output is a **gate**, not a side:

- `long allowed` (bull regime) — Alice **may** propose / hold longs; the risk
  gates + microstructure + human approval still govern *whether and how*.
- `long disabled` (bear regime) — Alice **vetoes new longs and de-risks**. It
  does **not** flip to short. This is exactly `Alice has veto power, not
  endorsement power`: a bear regime withholds long-endorsement, it does not
  endorse a short.

Example proposal context this would feed:

```text
directionSource: regime-trend-v0 = long allowed   (regime: bull)
risk gates:      funding hot -> size down
execution:       limit-only / small batch
human approval:  required
```

## Decision rule

- **Passes all four gates** → a legal regime `directionSource` (long-bias gate)
  for the proposal layer. The first validated rule of the whole research arc —
  and an honest one, because it claims only drawdown management, not alpha.
- **Fails** → the regime filter adds no risk-adjusted value over buy-and-hold on
  this history; record it and stop (do not tune to rescue).

## Deliberately OUT of v0

- **The short side** (bear → short) — a separate, higher-risk hypothesis
  (crypto bear rallies are vicious); never mixed into v0.
- **Leverage, partial sizing, intraday timing** — v0 is binary daily long/flat.
- **Funding / order book / news** — these are Alice's *execution / veto* layers
  on top of the regime gate, not inputs to the regime backtest.

## Research artifacts to save (when run)

Standalone, outside both repos, read-only: study script, `config.json`, daily
equity curves (strategy + B&H, per asset), per-cycle drawdown table, flips log,
metrics JSON (CAGR/maxDD/Calmar/Sharpe/turnover/missed-upside per asset),
sensitivity grid. Deterministic; no one-off console tables.

## Research verdict — REJECTED (disciplined near-miss, 2026-06)

Run as a standalone study at
`C:\Users\Marcus\OneDrive\Desktop\regime_trend_v0_backtest\` (read-only; data
fetched from Binance/Yahoo public APIs; no Alice runtime). `config.json` records
`spec_commit: b72ee3e`. The implementation was **independently verified against
the locked spec** — no-lookahead (signal on completed close, execute next open),
±3% band hysteresis, **benchmark common-start on the strategy's first tradable
day** (2018-03-05, not listing), **cost per executed leg** (0.10%) + cash 0%,
**non-overlapping running-ATH bears incl. the terminal episode**, and the verdict
taken from **BTC only**. All faithful.

**BTC mainline (SMA200 ±3%, long/flat, costs in) — strong in aggregate:**

| metric | strategy | buy-and-hold |
|---|---|---|
| CAGR | **30.28%** | 24.78% |
| max drawdown | **−52.36%** | −76.63% |
| Calmar | **0.578** | 0.323 |
| Sharpe | 0.826 | 0.671 |
| final equity (×) | **8.84** | 6.20 |
| turnover | 1.58 round trips/yr | — |
| time in market | 53% | 100% |

It beat buy-and-hold on **every** aggregate metric — there was no CAGR/upside
sacrifice (final equity ended *above* B&H).

**Why it is REJECTED — the per-cycle gate (set before the run):**

| gate | result | pass |
|---|---|---|
| 1 — maxDD ≤ 0.70 × B&H | ratio 0.683 | ✅ |
| 2 — Calmar > B&H | 0.578 > 0.323 | ✅ |
| 4 — ≤ 6 round trips/yr | 1.58 | ✅ |
| **3 — smaller DD in *every* major bear + split-half** | split-half ✅, but **one bear failed** | ❌ |

The failing bear is the **2019-06-26 → 2020-03-12** episode (the slow 2019
decline running into the **COVID fast crash**): strategy **−50.10%** vs B&H
**−49.43%** — a 0.67 pp near-tie, but **not smaller**, so Gate 3 fails. The
aggregate −52% maxDD came from the *slow* 2021–2023 bear, which the filter **did**
cushion; its hole is the **fast V-crash**, exactly where protection matters most.

This is a **harsh-but-correct** reject. A less disciplined process would accept a
strategy that wins on every headline number. But Gate 3 was pre-registered to
catch precisely "the drawdown protection is not universal," and relaxing it now
(to call −50.10 vs −49.43 "a tie") would be moving the goalpost after seeing the
data — the one thing pre-registration exists to prevent. **REJECTED as a
`directionSource`; not promoted; no proposal, no trade.**

**Sensitivity (cannot rescue v0 — recorded honestly):** of six pre-registered
variants, **only `SMA150 ±3%` passed all four gates**. But it is a **single
fragile grid point flanked by failures** — `SMA100` fails Gate 1 (whipsaw),
`SMA200`/`SMA250` fail Gate 3 (the COVID bear). That shape carries **strong
overfit risk — consistent with a COVID-specific fit**, not a robust plateau.
(Strictly: we can show only that it is an isolated grid pass that happens to fix
exactly the COVID weakness; we cannot *prove* it is curve-fit.) It may **seed a
separately pre-registered `regime-trend-v1`**, but its grid-pass is discounted
for multiple comparisons (1 of 6) and **does not count as validation** and
**cannot change v0's REJECT**.

**Cross-asset support (support-only, mixed):** BTC and SPX both reduce maxDD and
beat B&H on Calmar but fail the per-cycle gate; ETH and Gold are weaker (fail
Gate 1). The cross-asset picture is **mixed**, so it does not strongly establish
a universal effect — and is moot regardless, since the BTC mainline failed and
support cannot rescue it.

## What v0 tells us about v1 (clear signpost)

The death cause is specific and useful: **a 200-day regime filter cushions slow
bears but cannot react to a fast V-crash.** So the next hypothesis is not "tune
the SMA" — it is a **two-layer** design, separately pre-registered:

> **slow regime gate** (manages slow bears, as here) **+ an independent fast
> drawdown circuit-breaker** (a volatility / rapid-drawdown trip that handles the
> COVID-style crash the slow filter misses).

`SMA150` is only the fragile accidental hint that "faster helps the fast crash";
a robust `regime-trend-v1` should add an explicit fast-crash layer, not lean on a
single grid-point SMA value that carries strong overfit risk.

## Related

- [alice-trading-constitution.md](../alice-trading-constitution.md) — a regime
  rule is a `Strategy decides direction` source (long-allowed gate), not a price
  prediction; `Alice has veto power, not endorsement power`; `Safety flow does
  not create edge` (this rule manages beta, it does not create alpha).
- [trade-proposal-principles.md](../trade-proposal-principles.md) — a validated
  regime gate becomes a legal `directionSource`.
- [funding-pulse-v1.md](funding-pulse-v1.md),
  [session-orb-v0.md](session-orb-v0.md),
  [capitulation-mean-reversion-v0.md](capitulation-mean-reversion-v0.md) — the
  rejected short-term-edge lines whose closure motivated this pivot from "find
  alpha" to "manage beta honestly."
