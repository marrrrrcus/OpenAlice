# Backtest spec — Funding Carry Harvest v0 (delta-neutral pair, structural income)

A **pre-registered design spec for a backtest**, not an implemented strategy
and not a signal. It tests a **structural-income** premise, not a prediction:

> When BTC perpetual funding is persistently positive, does a
> **delta-neutral pair** (long spot + short perp, USD-notional aligned)
> collect enough funding cashflow to beat a risk-free baseline **net of
> two-leg costs, basis drift, margin drag, and liquidation risk**, across
> multiple market states?

> **Status:** REGISTERED — NOT RUN. All thresholds are red-pen proposals
> until locked; the run happens outside both repos on explicit
> authorization only. If it ever validates, it is a **strategy, not a
> veto** — the promotion path runs through the Track B shadow first (see
> "If validated" below), never straight to `directionSource`.

## Premise boundary — why this does not reopen the closed funding family

[funding-pulse-v1.md](funding-pulse-v1.md) **closed** the funding family
*as a price predictor*: extreme funding does not predict a reversion
pulse. This study makes **no price claim at all** — the pair holds ≈ zero
net delta; its income is the funding cashflow the crowded side pays, and
its risks are basis drift, costs, and the short-perp leg's margin
mechanics. v1's one directional hint (positive funding weakly associates
with *continuation*, i.e. persistence) is, if anything, **pro-carry**:
persistent funding pays longer. A materially different premise, exactly
the kind v1's verdict said a future attempt must have.

## Pair-intent boundary (pinned — runtime collision disclosed now)

The short-perp leg *looks like* a naked short to the deployed pipeline
and would collide with `SHORT in BULL → BLOCK` in a bull regime. Pinned:

- A carry pair is an **atomic pair intent** — one unit, entered and
  exited as a unit, delta-neutral by construction. It is **not** a
  directional short, and
  [funding-crowding-short-veto-v0.md](funding-crowding-short-veto-v0.md)
  explicitly does not govern it.
- **Before any runtime contact**, the pipeline needs an atomic pair
  classification (a pair intent evaluated as one object). Sneaking the
  perp leg through the ordinary short path is forbidden — that is a
  misclassification, not a workaround.
- v0 is **pure research, zero runtime contact**. This section exists so
  the boundary is on record before anyone is tempted.

## Constitution alignment

- `Alice does not predict price` — the pair holds no directional view.
- `Strategy decides direction` — if validated, "direction" here is
  *pair-on / pair-off*, and even that must earn its way through the
  shadow track and a human verdict before `directionSource` discussion.
- `Safety flow does not create edge` — margin discipline below protects
  capital; the only income source is the funding cashflow itself.

## Data / venue / window

- **Funding:** Binance USD-M `BTCUSDT` settled funding history via public
  API (`/fapi/v1/fundingRate`, paginated), **2019-09 (perp listing) →
  2026-06-01** — the multi-cycle depth the V8 window lacks; carry must be
  judged across funding-rich and funding-poor eras.
- **Prices:** Binance spot `BTCUSDT` daily klines + USD-M perp `BTCUSDT`
  daily klines (public APIs). Daily marks suffice — entries/exits anchor
  to settled funding rows, and the pair's risk is a slow spread, not
  intraday timing. Perp daily **highs** are additionally required for the
  liquidation simulation.
- **QC arm (pinned, run before the study):** 8h cadence continuity and
  gap inventory on funding; duplicate rows; |funding| > 5σ outliers
  inspected and documented; spot/perp kline continuity and any
  contract-definition changes noted. Unresolved data anomalies exclude
  the affected span, disclosed in the verdict.
- Venue consistency: signal, both legs, and outcomes all Binance.

## Funding timestamp / cashflow accounting (pinned — the v0/v1 landmines, re-pinned)

- **Settled rows only.** All percentile/threshold computation uses rows
  with `timestamp < now` in **row order** (never exact 8h-boundary
  equality — the ms-jitter lesson). The current unsettled funding value
  is never visible to any decision.
- **Availability:** a row settling at `F` is usable from `F + 1 minute`.
- **Daily decision cadence (pinned — no 8h/daily mixing):** funding
  settles three times per UTC day, but v0 decides **once per day**: at
  each UTC daily close, the decision input is `funding_sum_24h` of the
  **latest funding row settled strictly before that close**; the decided
  entry/exit executes at the **next daily open**. One decision, one
  execution anchor, aligned with the daily mark — no ambiguity about
  which of the day's three rows has decision power.
- **Cashflow inclusion:** a settlement `T` pays/charges the pair iff
  `entry < T < exit` (strict inequalities; same-timestamp ambiguity
  excluded — the funding-exhaustion rule verbatim).
- **Signs (unit-tested before any run):** for the short-perp leg,
  positive funding → the leg **receives**; negative funding → the leg
  **pays**. The spot leg has no funding. Per settlement:
  `cashflow = +funding_rate(T) × mark_price(T) × qty_perp` for the short
  leg. The four sign cases (±funding × long/short) must pass unit tests
  in the study harness before results are read.
- **PnL is NOT funding alone — daily basis marking (pinned):** every day,
  each leg is marked at its own close:
  `pair_equity(t) = qty_spot × spot_close(t)
   + qty_perp × (perp_entry − perp_close(t))
   + accrued funding − accrued costs`, indexed to deployed capital.
  Spot/perp basis drift therefore appears **explicitly** in the equity
  curve and drawdowns — never hidden behind a convergence assumption.

## Pair sizing / rebalance / margin (pinned)

- **Sizing — USD-notional aligned at entry:**
  `qty_spot = N / spot_open(t0)`, `qty_perp = N / perp_open(t0)` for pair
  notional `N`. (BTC-quantity alignment would carry a residual delta
  whenever basis ≠ 0 — rejected.) The small residual delta that *develops*
  from basis drift is part of pair PnL, visibly.
- **No rebalancing in v0.** Legs are touched exactly twice: entry and
  exit. Drift costs stay honestly in the equity curve; no extra operating
  parameter.
- **Margin model (pinned):** short-perp leg on isolated margin at **2×
  leverage** (initial margin = `N/2`), maintenance margin **0.5%** of
  position notional. **Deployed capital = spot notional + perp initial
  margin = 1.5 × N** — every yield figure divides by this, not by `N`.
- **Liquidation simulation (pinned):** daily, using perp **highs**
  (adverse for the short leg):
  `leg_equity = initial_margin − (perp_high(t) − perp_entry)/perp_entry × N`;
  breach of maintenance margin = **simulated liquidation → that config
  FAILS outright** (no "would have topped up" rescue — v0 has no
  rebalancing, so it has no collateral top-ups either; stated, not
  assumed away). Report per config: margin-usage curve, max adverse
  perp move while open, and the **minimum distance to liquidation** ever
  observed.
- **Conservative-model disclosure (pinned, verbatim):** *the liquidation
  check uses initial isolated margin only; accrued funding is NOT
  credited to margin; no collateral transfers or top-ups exist; the
  daily high is a conservative path proxy.* This is deliberately **not**
  a full exchange margin engine — every simplification here points the
  conservative way (liquidates earlier than reality, never later), and a
  reader must not mistake it for one.

## Costs (pinned)

Per fill: spot taker **10 bps**, perp taker **5 bps**, slippage **3 bps**
per fill on either leg (entries are unhurried — no urgency premium, but
no maker fantasy either). One episode = 4 fills:

```text
entry: spot buy (10+3) + perp sell (5+3)   = 21 bps of N
exit:  spot sell (10+3) + perp buy (5+3)   = 21 bps of N
round trip                                  = 42 bps of N
```

Cash earns **0%** while un-deployed (conservative; the risk-free
comparison happens at the benchmark level, not inside the equity curve).

## Mainline rule (pinned)

Using the settled-funding machinery above (`funding_sum_24h`, past-only
trailing 365d distribution, ≥ 180d history):

```text
DECIDE at each UTC daily close, on funding_sum_24h of the latest funding
       row settled strictly before that close (daily cadence — pinned)
ENTER  pair at the NEXT daily open  when sum24h ≥ trailing p75 AND > 0
EXIT   pair at the NEXT daily open  when sum24h ≤ 0   (aggregate flips)
one pair at a time; re-entry allowed at the next qualifying daily decision
```

Sensitivity grid (pinned, reported only — never swapped into the
mainline): entry percentile ∈ {p60, p75, p90}; exit variant "any single
settled funding < 0"; leverage 3× (margin `N/3`, tighter liquidation
distance) as a stress column.

## Evaluation

Report, per config: episode count and durations; gross funding collected;
basis PnL; costs; net return; **net annualized yield on deployed capital
(1.5 N)**; pair-equity max drawdown; margin metrics (above); per-year net
returns; time deployed vs idle.

## Passing bar (mainline; all must hold)

1. **Net-of-costs annualized yield ≥ risk-free + 4 pp**, where risk-free
   = the period-average 3M US T-bill yield over the same window.
   **Source pinned: FRED `DTB3`** (daily 3-month T-bill secondary-market
   rate), forward-filled over non-trading days and missing values; any
   span of **> 5 consecutive business days** of missing data is flagged
   and disclosed in the QC report. The series snapshot is saved in
   artifacts.
2. **Zero simulated liquidations** (any liquidation = FAIL, per the
   margin section).
3. **Pair-equity max drawdown ≤ 10%.**
4. **Multi-state stability:** per-year net return positive in **≥ 4 of
   the six FULL calendar years (2020–2025)** AND positive in **both
   halves** of the window (2019-09→2023-01, 2023-01→2026-06) — carry
   must not be one era's artifact. **The partial years (2019, 2026) are
   reported but never gate** — a stub year must not decide a pass or a
   fail in either direction.
5. **LOQO** (leave-one-quarter-out): net annualized yield stays above
   risk-free in every refit.
6. **Sample tiers:** ≥ 30 completed episodes full judgement; 20–29
   weakly testable (no promotion); < 20 → INCONCLUSIVE. Per the batch
   verdict discipline: a bar that cannot be evaluated on its deciding
   bucket is **INCONCLUSIVE, never PASS**.

## Language discipline

A validated carry result is **income with risks priced**, not "free
money" and not a market view:

```text
(if validated): funding-carry-harvest-v0 passed its pre-registered bar
on historical data — a shadow track and a human verdict are still ahead.
```

Never "safe yield", never "arbitrage" (basis + liquidation risk make it
neither), never a recommendation.

## If validated — the promotion path (pinned)

1. This verdict alone changes **nothing** in the runtime.
2. The strategy must first run on the **Track B shadow**
   ([../strategy-shadow-track-v0.md](../strategy-shadow-track-v0.md)) —
   which requires the shadow's funding-data context slot (a planned
   interface extension) and a pair-aware stance/mark design, both their
   own reviewed changes.
3. Only after forward shadow survival and a human-written verdict does
   `directionSource` eligibility become **discussable** — and any runtime
   execution additionally requires the atomic pair classification from
   the boundary section.

## Deliberately OUT of v0

- ETH / alt pairs; cross-exchange carry; basis trades via dated futures.
- Rebalancing, collateral top-ups, dynamic sizing, compounding policy.
- Maker execution modeling; sub-daily entry timing.
- Any runtime wiring; any veto claim (this is not a gate study).

## Research artifacts to save (when run)

Standalone, outside both repos, deterministic seed: fetcher + QC report,
study script, `config.json`, `output.json`, episode ledger CSV
(entry/exit, funding collected, basis PnL, costs, margin metrics per
episode), daily pair-equity curve CSV, per-year table, LOQO CSV,
sensitivity grid, sign-convention unit-test results.

## Related

- [funding-pulse-v1.md](funding-pulse-v1.md) — closed funding as a price
  predictor; this premise is income, not prediction.
- [funding-exhaustion-v0.md](funding-exhaustion-v0.md) — the timestamp /
  cashflow / sign landmines re-pinned above.
- [funding-crowding-short-veto-v0.md](funding-crowding-short-veto-v0.md)
  — the naked-short veto that explicitly does NOT govern pair intents.
- [../strategy-shadow-track-v0.md](../strategy-shadow-track-v0.md) — the
  forward gauntlet any validated version must survive next.
- [../alice-trading-constitution.md](../alice-trading-constitution.md) —
  `Strategy decides direction`; nothing here bypasses it.
