# Backtest spec — Post-Spike Chase Cooldown v0 (restrict-only, dual-side)

A **pre-registered design spec for a risk-gate study**, not a strategy and
not a signal. It asks a permission question about a **human-supplied
intent**:

> After BTC moves violently in one direction, does a **new entry chasing
> that same direction** within the next few days face materially worse
> left-tail outcomes — enough to justify a restrict-only cooldown `BLOCK`?

> **Status:** REGISTERED — NOT RUN. All thresholds are red-pen proposals
> until locked; the run happens outside both repos on explicit
> authorization only.
> 2026-07-03 amendment (inside the pre-registration window, before any
> run): the macro-event sensitivity DIAGNOSTIC below was added —
> diagnostic-only by ruling, never a gate, never a rescue.

## Honest framing — this veto may well FAIL

The momentum / time-series-continuation literature is the strongest
survivor in the anomaly record, and it points the **other way**: big moves
tend to continue, so blocking chases could cut winners, not losers. This
study is worth running precisely because "chasing is obviously bad" is
folklore — a clean **REJECT closes that folklore**; a validated veto would
be a genuine (and mildly surprising) tail finding. The spec is worded to
accept either outcome; nothing here is allowed to *want* a pass.

## Constitution alignment

- `Alice has veto power, not endorsement power` — output is `BLOCK` or
  nothing; no cooldown ≠ encouragement to chase.
- `ALLOW is not endorsement` — pass wording: "no chase-cooldown block
  detected", never "safe to enter".
- `Safety flow does not create edge`.

## Scope (pinned)

- Gates **new naked directional intents** on BTC only, same-direction as
  the spike: an **up-spike** cooldown vetoes new LONG-increasing intents;
  a **down-spike** cooldown vetoes new SHORT-increasing intents.
- The two sides are **separate sub-hypotheses**, judged independently —
  one side can validate alone (the regime-risk-gate precedent).
- Risk-reducing operations are exempt (pipeline pinned definition): a
  cooldown must never trap anyone in a position.
- NOT in scope: intraday spikes, other assets, volume/OI conditioning,
  ATR-relative thresholds — each would be a separate hypothesis.

## Data / venue / window

- **BTC spot daily, Binance `BTCUSDT`**, listing (2017-08-17) →
  `2026-06-01` — the same public, reproducible series as the regime
  studies, spanning multiple full cycles. No funding data needed.
- Signal timing: completed daily candles only; entries execute at the
  next daily open (house no-lookahead rule).
- Venue note: spot daily for a multi-day behavioral veto is the same
  consciously-accepted relaxation regime-trend-v0 recorded.

## Trigger and cooldown (pinned)

```text
spike at day T:   |close_T / close_{T−3} − 1| ≥ 20%       (N = 3, X = 20%)
direction:        sign of that move
cooldown:         days T+1 … T+5 are vetoed for the SAME direction (M = 5)
```

- **Overlap handling (pinned):** consecutive/overlapping same-direction
  triggers **merge into a single active cooldown** — a calendar day is
  vetoed iff it lies inside *any* active same-direction cooldown, and it
  is counted **once**. Exposure is **day-level**: for each side, every
  eligible calendar day is classified exactly once as vetoed or reference.
  No event-count inflation.
- **Sensitivity grid (pinned, reported only — the mainline is never
  swapped post hoc):** `X ∈ {15%, 20%, 25%}`, `M ∈ {3, 5, 10}`, `N` fixed
  at 3.

## Exposure frame and outcomes (pinned)

For each side, each classified day `D` hosts a hypothetical same-direction
entry at `open(D)` (decided on `close(D−1)` — the trigger at `close(T)`
precedes the first vetoed open at `T+1`, so classification is lookahead-free):

```text
long side:   ret_h = +ln( open(D + h) / open(D) )
short side:  ret_h = −ln( open(D + h) / open(D) )
h ∈ {1D, 5D, 20D}
```

- **Primary horizon 5D**, secondary 20D, diagnostic 1D (spike decay is a
  mid-speed phenomenon: faster than the 60D macro frame, slower than
  funding windows).
- Metrics per set: median, P5, CVaR5, max adverse excursion over the
  horizon (daily lows for the long side, daily highs for the short side).

## Overlap / inference (pinned)

- **Monthly block bootstrap** (B = 2000, fixed seed) for all CIs —
  forward windows overlap and vetoed days cluster by construction.
- **Episodes** = merged cooldown windows (the maximal-run rule) — the
  effective sample unit.
- LOQO + leave-one-month-out on every gated statistic.
- Minimum sample: vetoed bucket needs **≥ 180 classified days AND ≥ 30
  episodes** for full judgement (regime-risk-gate discipline); 20–29
  episodes weakly testable, < 20 INCONCLUSIVE. With ~8.5 years of data
  the reference bucket will be large; the binding constraint is vetoed
  episodes.

## Raw passing bar (per side; all must hold at 5D primary)

1. `CVaR5(vetoed) ≤ CVaR5(reference) − 1.5 pp`
2. `P5(vetoed) ≤ P5(reference) − 0.75 pp`
3. Monthly-block bootstrap **90% CI of the CVaR5 difference entirely
   below 0**.
4. LOQO + LOM: the separation sign never flips.
5. Sample tiers as above.

## Incremental value after existing gates (the onboarding gate)

- **SHORT side:** production already blocks every short in BULL
  (`SHORT in BULL → BLOCK`). **No-lookahead pinned: the zone attributed to
  day `D` (entry at `open(D)`) is computed from the completed
  `close(D−1)`** — exactly the information the deployed gate would hold at
  that open; using day `D`'s own close would peek and pollute the residual
  set. Report the overlap rate `|vetoed ∩ BULL| / |vetoed|`; build
  residual sets excluding BULL days (both vetoed′ and reference′);
  **re-run the full raw bar on the residual**. Overlap ≥ 90% → **`REDUNDANT / not worth onboarding`**;
  residual under the sample tiers → **`INCONCLUSIVE for onboarding / raw
  effect not independently actionable`** — never PASS. Onboarding-eligible
  only if raw AND residual both pass.
- **LONG side:** no deployed gate blocks longs (the long-side regime veto
  did **not** validate and is not wired), so residual = raw **by
  construction** — stated, not silently assumed. The overlap with BEAR
  days is still **reported** as information (a future long-side gate would
  live there). G1–G4 are size/rate gates orthogonal to timing; no
  exclusion applies.

## Over-filter check (reported, judged in the human review)

- Fraction of all days vetoed per side (raw and residual) — at
  X=20%/M=5 this should be small; if a sensitivity cell vetoes a large
  share of days it is a trading ban, not a filter, and is disqualified
  regardless of tails.
- **Forgone right tail:** median and P95 of vetoed-day same-direction
  returns — the continuation profits the cooldown costs. Given the
  momentum prior, this number is expected to be the story; it must be
  reported with the same prominence as the left tail.

## Macro-event sensitivity (diagnostic — never a gate, never a rescue)

Macro releases move price, and this study's features cannot see them —
their effect is IN the data but NOT in the labels. Identical machinery
to [funding-crowding-short-veto-v0.md](funding-crowding-short-veto-v0.md)'s
diagnostic, restated pinned:

- **Event set (frozen before the run):** US CPI (**BLS CPI release
  schedule**), US Employment Situation / NFP (**BLS Employment Situation
  release schedule**), FOMC **scheduled policy statement / rate decision
  release timestamps only** (no minutes, speeches, dot plots, press
  conferences; **unscheduled emergency decisions excluded in v0**;
  source: the **Federal Reserve FOMC calendar**). Calendar snapshot
  saved in artifacts.
- **Timezone rule:** release times convert to **UTC timestamps first**;
  day labels use the **UTC date** (`event_utc_date` = the UTC day
  containing the release instant). No ET-vs-UTC choice exists.
- **Exclusion set:** `event_utc_date` and `event_utc_date + 1` — the day
  before is NOT excluded (post-event risk diagnostic, not pre-event
  avoidance). The only label definition in this spec.

**Reported (all diagnostic, none gated):**

1. Share of vetoed and reference DAYS falling inside the exclusion set,
   per side.
2. **Trigger attribution (A2-specific):** the share of spike triggers
   whose `close_T` UTC day falls inside the exclusion set — the spike
   itself may be macro-born, and this directly illuminates the
   otherwise-unmeasured mechanism layer.
3. Whether each side's tail separation direction flips when recomputed
   with the exclusion set removed — recorded in the verdict's
   interpretation, never a change to PASS/FAIL.
4. **Post-exclusion sample count** — below this spec's tiers the
   diagnostic is **underpowered** and the direction question is left
   unanswered.

*This diagnostic can weaken a pass's interpretation or explain a fail's
mechanism; it can never rescue a fail or veto a pass.*

## Language discipline

```text
BLOCK: Post-spike chase cooldown active for this direction; trade blocked.
(pass): No chase-cooldown block detected. This is not an endorsement.
```

## Deliberately OUT of v0

- Intraday spike definitions; other assets; volume/OI/news conditioning;
  ATR-relative spike thresholds; SIZE-DOWN variants (pipeline verb does
  not exist yet); any runtime wiring.

## Research artifacts to save (when run)

Standalone, outside both repos, deterministic seed: study script,
`config.json`, `output.json`, per-side day-classification CSVs, merged
cooldown-episode inventory, per-side outcome distributions, bootstrap
distributions, LOQO/LOM CSVs, overlap/residual CSVs, over-filter and
forgone-right-tail tables, full sensitivity grid.

## Related

- [regime-risk-gate-v0.md](regime-risk-gate-v0.md) — the tail-separation
  frame, sample discipline, and the deployed short-side veto this study
  must beat incrementally.
- [funding-crowding-short-veto-v0.md](funding-crowding-short-veto-v0.md)
  — the sibling veto candidate in this batch.
- [session-orb-v0.md](session-orb-v0.md),
  [capitulation-mean-reversion-v0.md](capitulation-mean-reversion-v0.md)
  — prior REJECTs whose no-lookahead and random-control discipline this
  spec inherits.
- [../trade-proposal-principles.md](../trade-proposal-principles.md) —
  "don't over-filter": more conditions must improve risk-adjusted
  outcomes, not just shrink trade count.
