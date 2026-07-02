# Design spec — Human Decision Ledger v0 (Track D: audit the human like a strategy)

**Track D does not exist to find "Marcus's alpha". It exists so the human
directionSource receives the same audit treatment as every strategy** —
pre-registration, sample tiers, INCONCLUSIVE verdicts, no automatic
conclusions. It is the last mirror in the anti-self-deception system, and
it is deliberately **slow, blunt, and conclusion-averse**.

> **Status:** DESIGN DRAFT — pending Marcus red-pen. No code until locked
> (the risk-gate / shadow-track discipline). Implementation is a separate,
> reviewed change after the lock.

## Why this is MORE dangerous than strategy analytics — the Goodhart section

A strategy never reads its own scoreboard; the human does. The worst
failure mode here is not misreading the data — it is **reading it and then
changing behavior**, which silently invalidates the sample that produced
the reading, and can amplify what was noise ("your BULL-zone longs run 70%"
at n=17) into conviction and size. Every design choice below exists to
blunt that loop:

- **low cadence** (quarterly, human-pulled — never a live dashboard);
- **tier-gated language** (below tiers the system is *incapable* of
  emitting condition-level claims, by code, not by discipline);
- **fixed, pre-registered analysis axes** (no free search over the
  human's own record);
- **process metrics before outcome metrics** at small n.

## Constitution alignment

- `Strategy decides direction` — today the deciding strategy is the human.
  Track D measures that source; it never replaces, grades, or coaches it
  in real time.
- `ALLOW is not endorsement` / language discipline — the report renders
  evidence accumulation, never "your edge is X", never a per-trade grade.
- `Alice has veto power, not endorsement power` — the counterfactual
  ledger evaluates the *brakes*, not the driver's worth.

## Scope — exactly two ledgers, nothing else

### 1. Human decision ledger

**Granularity (pinned): parent push row + per-intent child rows.** A
push can carry multiple operations across symbols — reduce here, open
there, someday a pair intent — and a single push-level row would make
horizon outcomes unattributable. So:

- **Parent row** (one per executed real push): timestamp, accountId,
  commit hash / pendingHash, approval context, risk-gate verdict summary
  (from the already-emitted `trading.risk_gate.verdict` event),
  **override flag + reason if supplied** (see must-pin 3), optional
  one-line **thesis** (opt-in at approval time — mandatory journaling
  produces garbage data; absence is recorded honestly).
- **Child rows** (one per order-level intent in the push): aliceId/
  symbol, direction, order type, quantity/notional, the intent
  classification the pipeline already computed (risk-increasing /
  reducing), and the **horizon marks** (must-pin 1). All outcome
  attribution happens at child level; parents carry the shared context.
- Child-level decision context, captured per intent:
  - **regime zone at decision** (the recorded daily `trading.regime.zone`
    event — never recomputed after the fact);
  - **funding state at decision** (bucket definitions below; absent data
    = recorded as its own `unavailable` bucket, never reconstructed).

**Funding buckets (pinned, self-contained — implementation must not
drift):** computed from **settled funding rows only**, in row order, per
[backtests/funding-crowding-short-veto-v0.md](backtests/funding-crowding-short-veto-v0.md)'s
signal machinery: `funding_sum_24h` = current + previous two settled
rows; `z` = past-only trailing-365d standardization with ≥180d history.
Buckets: **`extreme-positive`** (`z ≥` trailing p90 of the positive
side), **`positive`** (`sum24h > 0`, not extreme), **`non-positive`**
(`sum24h ≤ 0`), **`unavailable`**.

**Context backfill rule (pinned):** *objective* context that is derivable
without lookahead from already-recorded events (e.g. the regime zone on a
past date) may be backfilled — but every backfilled field carries
**`contextSource: 'derived'`** (vs `'live'` for values captured at
decision time), and reports must render derived context as *analysis
context*, never as something Alice knew at the moment. *Subjective*
context (thesis, override reason) may **never** be backfilled — a
reconstructed reason is hindsight wearing a timestamp.

### 2. Counterfactual brake ledger

**Granularity (pinned — same shape as ledger #1): one parent row per
BLOCK / would-block verdict** (enforce blocks and observe
`*_WOULD_BLOCK` codes alike) **+ one child row per blocked or
would-blocked intent** inside that verdict — a verdict/push can carry
multiple operations, and verdict-level rows would make horizon outcomes
unattributable. **All counterfactual horizon marks are computed at the
child intent level**; the parent carries the shared verdict context.
Together they answer the single question:

> Were the trades Alice stopped (or would have stopped) actually worse?

Each blocked intent is marked forward at the fixed horizons below using
daily closes — the shadow track's mark discipline.

**Comparison baseline (pinned):** the primary comparison is **blocked
intent vs flat / no-trade** — "had the brake not fired, what would that
direction's signed return / MAE / MFE have been at 1D/3D/7D/30D?" A
negative signed outcome means the brake saved money; a positive one means
it cost opportunity. Both are reported. The human's executed decisions
are only a **secondary matched baseline** — matched on **same symbol +
same side + same horizon** — and that comparison is tier-gated like
everything else (below tier it is not reported at all). Comparing blocked
intents against the executed book at large would mix markets, sides, and
regimes into an unattributable soup — refused by design.

**This is the most overfit-resistant piece of Track D and its v0
centerpiece:** the conditions were fixed *ex ante* by the deployed gate
rules, so the **search freedom is low** — though not zero: interpretation
of the results can still overfit (cherry-picking horizons, narrating
single episodes), which is what the fixed horizons, tiers, and quarterly
cadence are for. It also starts producing evidence immediately (it
borrows the gates' clock, not the human's trade count).

## Must-pins

### Must-pin 1 — fixed outcome horizons (entry judgment ≠ exit skill)

Every decision row and every counterfactual row is marked at **1D / 3D /
7D / 30D** after the decision: signed return, MAE, MFE (daily
highs/lows). The **actual exit result is reported separately** and never
merged into the horizon metrics — fixed horizons measure the *entry
judgment*; realized PnL additionally contains *exit skill and luck*.
Conflating them teaches the wrong lessons in both directions.

### Must-pin 2 — below tiers, process only; never edge

Sample tiers per condition cell (a cell = one pre-registered axis value,
e.g. "LONG entries in BEAR"):

```text
n < 20   → "insufficient — accumulating" (NO condition-level statements;
            the report is code-bound to refuse, not politely reluctant)
20–29    → weak descriptive only, flagged as such
≥ 30     → eligible for aggregate statements — still evidence, never verdict
```

**Process metrics are reportable at ANY n** (they need no statistics):
share of pushes with a thesis recorded, size vs configured limits,
override count, gate-verdict distribution. At small n the report is a
process report, full stop.

### Must-pin 3 — overrides are the highest-value rows

Every time the human overrides a `BLOCK` / acts against a
`WOULD_BLOCK`, the ledger records the **override reason if supplied at
override time; a missing reason is recorded as missing and counts as a
process-metric failure — it is never backfilled.** (v0 adds no new UI/
HTTP surface, so capture-at-the-moment cannot be *guaranteed*; a future
minimal capture path in the approval flow may upgrade this metric, as its
own reviewed change.) Framing is pinned: override rows exist because
**the human-machine boundary is where the most is learned** — which
brakes were wrong, which warnings were rightly ignored — never for
blame. Override outcomes are reported descriptively (they will be few
for a long time; that is fine).

## Pre-registered analysis axes (locked at this spec — the ONLY three)

**`side` definition (pinned — verbatim contract for implementation):**
For **risk-increasing intents only**, `side` is the exposure-intent side
derived from the risk intent classifier plus the effective order
direction: BUY opens/adds LONG, SELL opens/adds SHORT. Risk-reducing /
close intents do not enter entry-side cells and are reported separately
as exit/de-risk decisions. (The classifier itself outputs only
risk-increasing/reducing — `side` is a *derivation* on top of it, not an
existing classifier field; `SELL to reduce a long` is NOT a SHORT.)

1. **Decision outcomes by `side × regime zone` at entry** — cells =
   {LONG, SHORT} × {BULL, GRAY, BEAR, UNKNOWN}. Long and short in the
   same regime are entirely different questions; splitting them makes
   every cell fill slower, and that is the anti-self-deception cost,
   paid deliberately.
2. **Decision outcomes by `side × funding state` at entry** — cells =
   {LONG, SHORT} × the pinned buckets above (`extreme-positive` /
   `positive` / `non-positive` / `unavailable`).
3. **Counterfactual value of the brakes** — per the pinned baseline in
   §2: blocked/would-blocked intents' forward outcomes **vs flat /
   no-trade** (primary); the human's executed decisions only as the
   matched secondary baseline (same symbol + same side + same horizon,
   tier-gated).

Any other slicing idea — time-of-day, symbol, size bucket, streaks —
is a **new pre-registration**, not a query. The report tool must not
accept ad-hoc condition parameters.

## Report (cadence + language, pinned)

- **Quarterly, human-pulled.** No daily dashboard, no push notifications,
  no real-time feedback during trading — the measurement must not sit in
  the loop it measures.
- Language discipline: `n` always visible; "evidence accumulating";
  "insufficient — accumulating" below tiers; **never** "your edge is X",
  never a recommendation, never a per-trade grade.

## Data sources & storage

- Sources already recorded: TradingGit commits, snapshots,
  `trading.risk_gate.verdict` events, daily `trading.regime.zone` events.
  Newly captured going forward: override reasons, opt-in thesis lines.
- Storage follows the research-ledger precedent: append-only JSONL under
  `data/research/decisions/`, single writer, structural row validation,
  ENOENT-only cold start, **cloud-synced (OneDrive) data roots refused**
  — the same authority rules as
  [strategy-shadow-track-v0.md](strategy-shadow-track-v0.md).

## Honest expectations

At the current live push cadence, condition cells will take **months to
quarters** to reach tiers — the first 6–12 months of ledger #1 are a
building period, not a reading period. Ledger #2 (counterfactuals) starts
accumulating immediately because it rides the gates' clock. This is a
slow instrument by design: install the meter now, read it next year.

## Non-goals (v0)

- No automatic coaching, scoring, or per-trade feedback.
- No real-time surfacing during trading sessions.
- No ML / clustering / discovered patterns over the human record.
- No backfilled subjective context; no reconstruction of pre-ledger
  history beyond objectively derivable fields.
- No new HTTP/UI surface (the quarterly report reuses the research tool
  pattern when implemented).

## Related

- [strategy-shadow-track-v0.md](strategy-shadow-track-v0.md) — the audit
  treatment this spec extends to the human; ledger authority rules
  inherited wholesale.
- [risk-gate-pipeline-v0.md](risk-gate-pipeline-v0.md) /
  [regime-veto-onboarding-v0.md](regime-veto-onboarding-v0.md) — the
  fixed rule set whose verdicts feed the counterfactual ledger.
- [alice-trading-constitution.md](alice-trading-constitution.md) —
  `Strategy decides direction`; measuring the deciding human never
  transfers the decision.

## Review record

- 2026-07-02 — draft written from the Track D discussion (two ledgers,
  three must-pins, three locked axes).
- 2026-07-02 — Marcus red-pen rounds 1 + 2 applied (the granularity and
  side semantics converged across both rounds): parent + per-intent child
  rows on BOTH ledgers (attribution must live at intent level, never
  push/verdict level); `side × regime` / `side × funding` cells with
  `side` pinned as the exposure-intent derivation for risk-increasing
  intents only (reduce/close reported separately as exit/de-risk);
  counterfactual primary baseline = blocked intent vs flat/no-trade,
  executed book only as matched secondary; override reason if-supplied
  with missing-as-process-failure; self-contained funding buckets;
  `contextSource: 'derived'|'live'` split; "low search freedom, not
  zero" wording. Spec ready to lock.
