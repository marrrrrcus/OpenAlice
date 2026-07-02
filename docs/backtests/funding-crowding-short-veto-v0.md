# Backtest spec — Funding Crowding Short Veto v0 (restrict-only)

A **pre-registered design spec for a risk-gate study**, not a strategy and
not a signal. Like [regime-risk-gate-v0.md](regime-risk-gate-v0.md) (the
validated predecessor), it asks a permission question about a
**human-supplied intent**, never a direction question:

> When BTC perpetual funding is extremely positive (longs are crowded and
> paying an expensive carry), does a **new naked directional short** face
> materially worse left-tail outcomes — enough to justify a restrict-only
> `BLOCK` — **and does that add anything beyond the already-deployed
> `SHORT in BULL → BLOCK` regime veto?**

> **Status:** REGISTERED — NOT RUN. All thresholds below are red-pen
> proposals until this spec is locked; the run happens outside both repos
> and only on explicit authorization. A validated verdict makes an
> onboarding spec *eligible* (regime-veto-onboarding precedent) — it wires
> nothing by itself.

## Motivation — and the discovery-degrees-of-freedom disclosure

[funding-pulse-v1.md](funding-pulse-v1.md) **falsified the fade**: shorting
into extreme positive funding *lost*, and lost more the more extreme the
funding (p90 tail mean −0.15%, p95 −0.54%, p99 −0.93% at 24h — the support
ladder strengthened in the *continuation* direction). That is exactly the
shape of evidence a **veto** wants: the falsification of an entry idea is
the motivation for blocking that entry.

**Honesty:** v1 already spent this dataset's discovery degrees of freedom
on the positive side. This study is **confirm-on-fresh-criteria** — a veto
frame (left-tail separation, risk-adjusted bar, incremental-value test)
that v1 never evaluated — *not* a re-claim of a pulse. A pass on the
primary window alone carries a replication caveat; the pre-registered
extension arm (2019-09 → 2024-07, data v1 never touched) is the genuinely
fresh sample.

## Constitution alignment

- `Alice has veto power, not endorsement power` — output is `BLOCK` or
  nothing. The absence of a block is **never** clearance to short.
- `ALLOW is not endorsement` — pass wording is "no funding-crowding block
  detected", never "safe to short".
- `UNKNOWN is not SAFE` — if funding data cannot be computed at runtime,
  a wired version blocks the gated intent; that behavior is inherited from
  the pipeline, not re-litigated here.
- `Safety flow does not create edge` — a validated veto cuts tail risk;
  it earns nothing.

## Scope (pinned)

- Gates **new naked directional short-increasing intents** on the BTC perp
  only (pipeline intent-ledger definition of short-increasing; provably
  risk-reducing sells stay exempt).
- **NOT in scope:** the short-perp leg of a delta-neutral carry **pair**
  ([funding-carry-harvest-v0.md](funding-carry-harvest-v0.md) territory —
  a pair is an atomic intent with its own future classification, never a
  naked short); LONG intents; extreme *negative* funding (the mirrored
  long-side veto is a separate hypothesis, not to be added after seeing
  results); ETH/alts; OI/liquidation/news conditioning.

## Data / venue / window

- **Primary window:** V8 warehouse — `data/funding_rates/symbol=btcusdt/`
  (8h settled funding: `timestamp`/`funding_rate`/`mark_price`) + BTCUSDT
  1m OHLCV, `2024-07-19 → 2026-06-01` (the v0/v1-validated window).
- **Extension arm (pre-registered, conditional):** activated **only if**
  the vetoed bucket misses the sample bar below — Binance USD-M
  `fundingRate` history via public API back to **2019-09**, with 1h klines
  for outcomes (1m is not required at that depth; the entry anchor becomes
  the first 1h open after availability). QC pinned: 8h cadence continuity,
  duplicate rows, gap inventory, |funding| > 5σ outliers inspected and
  documented before use. The arm is pinned **now**; it is not a post-hoc
  rescue.
- Venue consistency: signal and outcomes both Binance USD-M.

## Signal (pinned — funding-pulse-v1 machinery verbatim)

- `funding_sum_24h(row_i) = funding_i + funding_{i-1} + funding_{i-2}`
  by **row order** after sorting by timestamp (never exact `F − 8h`
  equality — the v0 ms-jitter lesson).
- Trailing standardization: past-only rows (`timestamp < F`) over 365
  calendar days, ≥ 180 days of history required; `z = (sum24h − μ)/σ`.
- **Veto fires** when `z ≥` the trailing p90 of the positive side (v1's
  tail definition — the definition under which the motivating evidence was
  measured). No absolute floor in the mainline; the funding-exhaustion
  floors (0.0004 / 0.0006) are a **sensitivity axis only**, reported for
  the production-hardening question, never swapped into the mainline.

## Exposure frame (pinned)

- Unit = **settlement window** `W(F) = [F + 1min, F_next + 1min)` — the
  span during which a runtime gate would act on row `F`'s information.
- Hypothetical naked short entered at the first 1m open (primary) / 1h
  open (extension) after `F + 1min`.
- **Vetoed set** = windows where the veto fires. **Reference set** = all
  other windows meeting the history requirement (the operational contrast:
  fires vs does not fire).

## Outcomes (pinned)

Signed short log returns from the entry anchor `t0`:

```text
short_ret_h = −ln( P(t0 + h) / P(t0) )    h ∈ {1D, 3D, 7D}
```

- **Primary horizon 3D**, secondary 1D, diagnostic 7D (funding crowding is
  a faster phenomenon than the macro regime's 60D frame).
- Metrics per set: median, P5, CVaR5, and max adverse excursion over the
  horizon using highs (adverse for a short).

## Overlap / inference (pinned)

- **Monthly block bootstrap** (B = 2000, fixed seed) for all CIs — raw
  window counts are descriptive only (8h windows overlap heavily at 3D
  horizons).
- **Episodes** = maximal runs of consecutive vetoed windows with gaps
  ≤ 24h (funding-pulse rule) — the effective sample unit.
- LOQO and leave-one-month-out on every gated statistic.

## Raw passing bar (all must hold, 3D primary, vetoed vs reference)

1. `CVaR5(vetoed) ≤ CVaR5(reference) − 1.5 pp`
2. `P5(vetoed) ≤ P5(reference) − 0.75 pp`
3. Monthly-block bootstrap **90% CI of the CVaR5 difference entirely
   below 0**.
4. LOQO + LOM: the separation sign never flips.
5. Sample tiers (episodes in the vetoed set): **≥ 30** full judgement;
   20–29 weakly testable (reported, no promotion); below tiers →
   extension arm (see activation rule below).

**Extension-arm activation (pinned):** the arm activates when **either**
the raw vetoed bucket **or** the residual vetoed bucket (the onboarding
decider — see below) misses the full sample bar. Only after the extension
still leaves the deciding bucket short is the verdict a **final
INCONCLUSIVE** — a pre-registered data arm that could answer the question
must not be skipped just because the raw bucket happened to suffice.

## Incremental value after existing gates (the onboarding gate)

Raw separation is **not** onboarding value — the deployed
`SHORT in BULL → BLOCK` may already cover these windows, and a veto that
re-blocks blocked trades is a renamed defense, not a new one.

- Regime zone computed exactly as production does (Binance spot daily,
  SMA200 ± 3%, stateless `computeZone`) — **no-lookahead pinned: the zone
  for window `W(F)` uses the latest COMPLETED Binance spot daily close
  available at the entry anchor `t0`** (i.e. what the deployed gate would
  actually have read at that moment), never that calendar day's own close.
  A residual set built on same-day closes would peek and pollute the
  incremental check.
- **Report the overlap rate:** `|vetoed ∩ BULL| / |vetoed|`.
- **Residual sets:** `vetoed′ = vetoed ∧ zone ≠ BULL`,
  `reference′ = reference ∧ zone ≠ BULL` (in production every short in
  BULL is already blocked — incremental value lives entirely outside BULL).
- **Re-run the full raw bar (1–5) on `vetoed′` vs `reference′`.**
- Decision rules (pinned):
  - overlap ≥ 90% → verdict leans **`REDUNDANT / not worth onboarding`**,
    regardless of how good the raw separation looks;
  - residual bucket below the sample tiers → **`INCONCLUSIVE for
    onboarding / raw effect not independently actionable`** — never PASS;
  - onboarding-eligible only if **both** the raw and the residual bars
    pass.

## Over-filter check (reported, judged in the human review)

- Fraction of all windows vetoed (raw and residual) — a veto that fires
  constantly is a trading ban, not a filter.
- **Forgone right tail:** median and P95 of the vetoed windows' signed
  short returns — what profitable shorting the veto costs. A valid veto
  must cut CVaR5 materially more than it cuts the P95 opportunity
  (`right metric` per trade-proposal-principles: risk-adjusted, not
  raw filtering).

## Language discipline

Wired or not, the only permitted copy:

```text
BLOCK: Funding crowding is extreme against new shorts; trade blocked.
(pass): No funding-crowding block detected. This is not an endorsement.
```

Never "funding supports this short", never "safe".

## Deliberately OUT of v0

- Extreme-negative-funding long veto (separate hypothesis, separately
  pre-registered if ever).
- ETH / SOL / alts; OI, liquidation, news, order-book stacking.
- SIZE-DOWN variants (needs the pipeline's SIZE-DOWN verb — future work).
- Any runtime wiring; any `directionSource` implication in either
  direction.

## Research artifacts to save (when run)

Standalone, outside both repos, deterministic seed: study script,
`config.json` (window, percentile, horizons, block size, seed),
`output.json`, vetoed/reference window CSVs with per-window outcomes,
episode inventory, bootstrap distributions, LOQO/LOM CSVs, overlap-rate
and residual-set CSVs, over-filter table. No one-off console tables.

## Related

- [funding-pulse-v1.md](funding-pulse-v1.md) — the falsification that
  motivates this veto; its machinery is reused verbatim.
- [funding-exhaustion-v0.md](funding-exhaustion-v0.md) — timestamp /
  cashflow landmines; the floor values borrowed as a sensitivity axis.
- [regime-risk-gate-v0.md](regime-risk-gate-v0.md) — the validated
  tail-separation frame and the deployed veto this study must beat
  *incrementally*.
- [../trade-proposal-principles.md](../trade-proposal-principles.md) —
  funding extremes were always tiered as gates, never as direction.
- [funding-carry-harvest-v0.md](funding-carry-harvest-v0.md) — the
  delta-neutral pair premise this veto explicitly does NOT govern.
