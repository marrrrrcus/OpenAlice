# Backtest spec - Regime Risk Gate v0 (dual veto, restrict-only)

A **pre-registered design spec for a risk-gate study**, not yet run.

This is not another attempt to create an automatic `directionSource`.
`regime-trend-v0` and `regime-trend-v1` showed that a slow regime signal has
real risk information, but does not clear the strict bar as an automatic
long/flat strategy. This v0 asks the correct, narrower question:

> Given a human-supplied trade intent (`LONG` or `SHORT`), can a slow macro
> regime gate veto or restrict trades whose forward tail risk is materially
> worse?

Alice still does **not** choose direction. It only reviews the direction the
human supplied.

> **Status:** RUN - PARTIAL VALIDATION (2026-06). The SHORT-side veto validated:
> `SHORT in BULL -> BLOCK` may be promoted as a restrict-only macro veto. The
> LONG-side veto did **not** validate, and the dual-side gate did **not**
> validate. This remains a risk gate, not a `directionSource`.

## Constitution alignment

This document implements:

- `Alice has veto power, not endorsement power`
- `ALLOW is not endorsement`
- `UNKNOWN is not SAFE`
- `Risk gates decide permission`
- `Safety flow does not create edge`

The output is a risk-gate verdict for an already-specified side. It is never a
reason to originate that side.

## Scope

v0 contains **regime veto only**:

- BTC spot daily price
- SMA200 with a +/-3% buffer
- side-specific outputs for human-supplied `LONG` / `SHORT` intents

v0 deliberately excludes:

- funding crowding
- order book / liquidity
- liquidation data
- news
- volatility or fast-crash circuit breakers
- position sizing beyond the coarse `SIZE-DOWN` label
- any automatic proposal generation

Those can be separate v1+ gates only after their own validation. They are not
allowed to sneak into this v0.

## Data / venue / window

- **Mainline asset:** BTC spot daily, Binance `BTCUSDT`.
- **Window:** listing -> `2026-06-01`, with SMA200 warmup.
- **Signal timing:** completed daily candles only. Regime is computed on T-day
  close and may affect proposals from T+1 open onward.
- **Venue note:** spot daily data is acceptable for this slow macro veto. It is
  not an execution-quality signal and cannot be used for order book or funding
  decisions.
- **Artifacts:** study script and data live outside the repo and outside Alice
  runtime.

## Regime zones (stateless, not a position strategy)

Unlike the stateful `regime-trend-v0` strategy, this risk gate uses a
**stateless current zone**. The gray zone is intentionally ambiguous rather than
"keep previous state."

```text
if close > SMA200 * 1.03:
    regime_zone = BULL
elif close < SMA200 * 0.97:
    regime_zone = BEAR
else:
    regime_zone = GRAY
```

Rationale: a permission gate should not silently inherit stale conviction from a
previous zone. If price is near the long-term boundary, the gate should admit
uncertainty.

## Output enum

The only allowed outputs are:

```text
ALLOW
SIZE-DOWN
ASK-HUMAN
BLOCK
```

`ALLOW` always means "no macro-regime block detected." It never means "this is a
good trade" or "Alice recommends entering."

## Mainline decision table (pinned)

### Human intent: LONG

| Regime zone | Output | Meaning |
|---|---|---|
| `BULL` | `ALLOW` | No macro-regime block detected. Not endorsement. |
| `GRAY` | `SIZE-DOWN` | Ambiguous macro regime; reduce risk if proceeding. |
| `BEAR` | `BLOCK` | Macro regime is adverse to new longs. |

### Human intent: SHORT

| Regime zone | Output | Meaning |
|---|---|---|
| `BULL` | `BLOCK` | Do not short into confirmed macro up-regime. |
| `GRAY` | `ASK-HUMAN` | No automatic permission; short requires explicit human judgement. |
| `BEAR` | `ASK-HUMAN` | No macro block detected, but short is still not endorsed. |

There is deliberately **no `ALLOW` for SHORT** in v0. Crypto's long-term upward
drift and squeeze risk make "not macro-blocked" too easy to misread as "safe."
SHORT can be blocked or escalated to human review; it is never auto-cleared by
this gate.

## Required language discipline

The gate's UI / Telegram copy must use honest wording.

Forbidden:

```text
Macro supports this long.
Macro supports this short.
Safe to enter.
Alice recommends entering.
```

Required examples:

```text
ALLOW: No macro-regime block detected. This is not an endorsement.
SIZE-DOWN: Macro regime is ambiguous; reduce size if you still choose to proceed.
ASK-HUMAN: No automatic macro permission. Explicit human judgement required.
BLOCK: Macro regime is adverse to this side; trade blocked.
```

For SHORT in `BEAR`, the wording is:

```text
No macro block detected, but short still requires human confirmation.
```

Never:

```text
Macro supports short.
```

## Validation frame - forward tail separation

This is not a trading-strategy backtest. It does not ask whether a rule beats
buy-and-hold. It asks whether a veto condition correctly identifies regimes
where the **proposed side's forward tail risk is materially worse**.

All returns are measured from the first executable open after the completed
signal candle:

```text
entry_price = open[T+1]
horizon price = open[T+1+h]
```

Primary horizon:

```text
h = 60 daily bars
```

Secondary horizon:

```text
h = 20 daily bars
```

Diagnostic horizon:

```text
h = 5 daily bars
```

Rationale: SMA200 is a slow macro-regime signal. The primary test must therefore
measure whether the vetoed side has worse downside outcomes over a macro-relevant
exposure window, not only over a short rebound window. The 20D horizon is still
reported to show near-term behavior, but it is not the main gate.

Interpretation note: this test measures worse downside **outcomes** for the
proposed side. It does not claim to isolate pure tail-thickening from lower
average drift. If a bear regime is bad for longs because the whole return
distribution shifts down, that is still valid evidence for a restrict-only veto,
but it is not a stronger claim that the regime uniquely predicts fat tails.

This is a deliberately simple trend-persistence check. A pass means the gate
correctly marks regimes where a human-proposed side faces worse forward risk. It
does not discover a new edge, and it must not be used to originate trades.

### LONG veto test

Compare hypothetical long exposure in:

- `BEAR` zone: the vetoed set (`LONG -> BLOCK`)
- `BULL` zone: the non-blocked reference set (`LONG -> ALLOW`)

Metrics:

- median forward return
- 5th percentile forward return
- CVaR5 forward return
- max adverse excursion over the horizon, using daily lows

The test is about the **left tail**. A valid long veto should show that long
exposure in `BEAR` has materially worse downside tail risk than long exposure in
`BULL`.

### SHORT veto test

For shorts, use signed short returns:

```text
short_return_h = -log(open[T+1+h] / open[T+1])
```

Compare hypothetical short exposure in:

- `BULL` zone: the vetoed set (`SHORT -> BLOCK`)
- `BEAR` zone: the least-adverse reference set (`SHORT -> ASK-HUMAN`)

Metrics:

- median signed short return
- 5th percentile signed short return
- CVaR5 signed short return
- max adverse excursion over the horizon, using daily highs

The test is again about the **left tail** of signed returns. A valid short veto
should show that short exposure in `BULL` has materially worse adverse tail risk
than short exposure in `BEAR`.

### GRAY zone

`GRAY` is reported separately. It is not the primary reference set for either
side. Its role is to justify `SIZE-DOWN` / `ASK-HUMAN`, not to prove a clean
directional distinction.

## Inference and overlap controls

Forward windows overlap. Raw daily sample counts are descriptive, not the only
evidence.

Required inference:

- monthly block bootstrap for primary 60D tail differences
- leave-one-quarter-out stability check
- report sample counts by zone and by month

Minimum sample requirement:

- each primary comparison bucket must have at least 180 daily observations
- and at least 12 distinct monthly blocks

If a side does not meet this, that side is **INCONCLUSIVE**, not rejected.

## Passing bars (side-specific)

LONG and SHORT are validated separately. One side cannot rescue the other.

### LONG-side veto passes only if all hold

1. `CVaR5_60D(BEAR long) <= CVaR5_60D(BULL long) - 2 percentage points`
2. `P5_60D(BEAR long) <= P5_60D(BULL long) - 1 percentage point`
3. Monthly block-bootstrap 90% CI for the CVaR5 difference is entirely in the
   correct direction (`BEAR` worse than `BULL`).
4. Leave-one-quarter-out keeps the CVaR5 difference in the correct direction.

If it passes, `LONG in BEAR -> BLOCK` is validated as a restrict-only veto.

### SHORT-side veto passes only if all hold

1. `CVaR5_60D(BULL short) <= CVaR5_60D(BEAR short) - 2 percentage points`
2. `P5_60D(BULL short) <= P5_60D(BEAR short) - 1 percentage point`
3. Monthly block-bootstrap 90% CI for the CVaR5 difference is entirely in the
   correct direction (`BULL` worse than `BEAR` for shorts).
4. Leave-one-quarter-out keeps the CVaR5 difference in the correct direction.

If it passes, `SHORT in BULL -> BLOCK` is validated as a restrict-only veto.

### GRAY-zone outputs

`LONG in GRAY -> SIZE-DOWN` and `SHORT in GRAY -> ASK-HUMAN` are accepted only
as conservative ambiguity handling. They are not evidence of edge and are not
claimed as validated directional calls.

## Decision rule

- If both LONG-side and SHORT-side veto tests pass: v0 validates as a dual-side
  regime risk gate.
- If only one side passes: only that side may be promoted; the other remains
  manual / unvalidated.
- If neither side passes: v0 is rejected.
- If a side lacks samples: that side is inconclusive.

Even if a side passes, it is **not** a `directionSource`. It is only a veto /
restriction layer for a direction supplied by the human.

## Expected production semantics if a side validates

These examples show the required language pattern. After the v0 run, only the
SHORT-side example is validated. The LONG-side example remains a template only;
`LONG in BEAR -> BLOCK` must not be promoted from this study.

Example LONG proposal template (not validated by this run):

```text
human intent: LONG BTC
regime-risk-gate-v0: BLOCK
reason: BTC is below SMA200 - 3%; this would require a validated long-side veto.
language: Macro regime is adverse to new longs; trade blocked.
```

Example SHORT proposal (validated side):

```text
human intent: SHORT BTC
regime-risk-gate-v0: BLOCK
reason: BTC is above SMA200 + 3%; short-side bull-regime veto is validated.
language: Macro regime is adverse to new shorts; trade blocked.
```

## Deliberately OUT of v0

- Using `BULL` as a reason to initiate longs.
- Using `BEAR` as a reason to initiate shorts.
- Funding crowding.
- Liquidity / order book / spread.
- News or macro calendars.
- Position sizing beyond the coarse `SIZE-DOWN` label.
- Automatic proposal generation.
- Any claim that `ALLOW` means a trade is good.

## Research artifacts to save

Standalone, outside both repos:

- study script
- `config.json` with spec commit
- daily regime-zone table
- forward-return table by side / zone / horizon
- max adverse excursion table
- tail metrics JSON / CSV
- monthly block bootstrap distributions
- leave-one-quarter-out table
- final side-specific verdict JSON

No console-only verdicts.

## Research verdict

Run completed against the pre-registered spec commit `029a2a6`.

Artifacts are stored outside the repo:

```text
C:\Users\Marcus\OneDrive\Desktop\regime_risk_gate_v0_backtest\
```

Primary window:

- BTCUSDT Binance spot daily, `2017-08-17` -> `2026-06-02`
- first primary signal: `2018-03-04`
- last primary signal: `2026-04-02`
- primary horizon: 60 daily bars
- primary rows: 2,952
- zone counts: `BULL=1,521`, `BEAR=1,251`, `GRAY=180`
- bootstrap: monthly block bootstrap, `B=2000`, `seed=42`

### Verdict summary

| Side | Tested veto | Result | Production meaning |
|---|---|---|---|
| LONG | `LONG in BEAR -> BLOCK` | **Not validated** | Do not promote this side from v0. |
| SHORT | `SHORT in BULL -> BLOCK` | **Validated** | May promote as a restrict-only macro veto. |
| Dual-side gate | both sides | **Not validated** | v0 is not a full dual-side gate. |

### LONG-side result - not validated

The point estimates favor the intended veto direction, but the overlap-aware
monthly bootstrap does not fully exclude zero. The strict pre-registered gate
therefore fails.

| Metric | BEAR long (veto set) | BULL long (reference) | Difference |
|---|---:|---:|---:|
| Observations | 1,251 | 1,521 | - |
| Monthly blocks | 55 | 64 | - |
| CVaR5 60D | -60.58% | -45.46% | -15.12pp |
| P5 60D | -50.55% | -37.74% | -12.81pp |
| Median 60D | +1.77% | +4.04% | -2.28pp |

Gate checks:

| Gate | Result |
|---|---|
| sample sufficiency | pass |
| CVaR5 margin | pass |
| P5 margin | pass |
| monthly block-bootstrap CI | **fail**: 90% CI = `[-26.06pp, +0.57pp]` |
| leave-one-quarter-out direction | pass |

Interpretation: `BEAR` looks worse for longs by point estimate, but the primary
60D bootstrap interval still crosses zero. This side is not validated. This is
the correct conservative outcome: a visually plausible veto is not enough to
promote production behavior.

### SHORT-side result - validated

The SHORT-side veto passes all pre-registered gates. In a confirmed macro
up-regime, hypothetical short exposure has materially worse 60D left-tail
outcomes than short exposure in a bear regime.

| Metric | BULL short (veto set) | BEAR short (reference) | Difference |
|---|---:|---:|---:|
| Observations | 1,521 | 1,251 | - |
| Monthly blocks | 64 | 55 | - |
| CVaR5 60D | -75.30% | -54.09% | -21.21pp |
| P5 60D | -61.11% | -40.83% | -20.28pp |
| Median 60D | -4.04% | -1.77% | -2.28pp |

Gate checks:

| Gate | Result |
|---|---|
| sample sufficiency | pass |
| CVaR5 margin | pass |
| P5 margin | pass |
| monthly block-bootstrap CI | pass: 90% CI = `[-38.94pp, -1.19pp]` |
| leave-one-quarter-out direction | pass |

Interpretation: `SHORT in BULL -> BLOCK` is validated as a restrict-only macro
veto.

### Important limits

This is the first validated result in the research arc, so the limits matter as
much as the pass:

- The SHORT-side pass is valid but not overwhelming. The bootstrap CI upper
  bound is only `-1.19pp`; direction is confirmed, but magnitude is imprecise.
- `SHORT in BULL -> BLOCK` does **not** mean `SHORT in BEAR` is safe. The
  BEAR-short 60D CVaR5 is still `-54.09%`, which is severe. This is why
  `SHORT in BEAR` remains `ASK-HUMAN`, never `ALLOW`.
- This is trend-persistence evidence, not a newly discovered edge. It validates
  a veto against a high-risk human intent; it does not originate shorts, longs,
  proposals, or trades.
- The LONG-side veto remains unvalidated. Do not use this run to block
  `LONG in BEAR` automatically.

### Final decision

Promote only:

```text
Human intent: SHORT
Regime zone: BULL
Gate output: BLOCK
Reason: short-side bull-regime veto validated by regime-risk-gate-v0.
```

Do not promote:

```text
LONG in BEAR -> BLOCK
SHORT in BEAR -> ALLOW
any automatic directionSource
any claim that BULL supports longs or BEAR supports shorts
```

## Related

- [alice-trading-constitution.md](../alice-trading-constitution.md) - `Alice has
  veto power, not endorsement power`; `ALLOW is not endorsement`.
- [trade-proposal-principles.md](../trade-proposal-principles.md) - risk gates
  decide permission, never direction.
- [regime-trend-v0.md](regime-trend-v0.md) and
  [regime-trend-v1.md](regime-trend-v1.md) - failed as automatic
  `directionSource` candidates; this document reframes the usable information as
  a restrict-only gate.
