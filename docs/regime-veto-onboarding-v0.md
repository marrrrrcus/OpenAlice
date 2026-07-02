# Design spec — Regime Veto Onboarding v0 (Phase 2: wiring the validated short-side veto)

An **onboarding spec for one validated rule**, not a new hypothesis and not an
implementation. It wires exactly one thing into the Phase 1 risk-gate pipeline:

> **`SHORT in BULL → BLOCK`** — validated at the backtest layer by
> [backtests/regime-risk-gate-v0.md](backtests/regime-risk-gate-v0.md)
> (commit `70eb587`): hypothetical short exposure opened in a confirmed BTC
> up-regime has materially worse 60D left-tail outcomes than in a bear regime
> (CVaR5 −75.3% vs −54.1%, block-bootstrap CI excludes 0, LOQO-stable).

Nothing else from that study is wired. The LONG-side veto was **not** validated
and gets **zero** runtime behavior here.

> **Status:** ONBOARDING DESIGN DRAFT. Not implemented. Depends on the Phase 1
> pipeline ([risk-gate-pipeline-v0.md](risk-gate-pipeline-v0.md)) existing
> first. Implementation order stays Phase 1 → Phase 2, **separate PRs** — this
> spec is written *before* Phase 1 implementation precisely so the guard
> interface is designed against both consumers at once.

## Constitution alignment

- `Risk gates decide permission` / `Alice has veto power, not endorsement
  power` — this guard can only block a human-supplied short intent; it never
  originates, sizes, or times anything.
- `UNKNOWN is not SAFE` — if the regime cannot be computed, the gate's one
  validated job cannot be done; short-increasing orders are **BLOCKED**, not
  waved through. A data outage must not silently unbuckle the seatbelt.
- `ALLOW is not endorsement` — a pass here renders as "no macro-regime block
  detected", never "macro supports this".
- `BEAR` never encourages shorts; `BULL` never encourages longs. The zone is
  input to a veto, never a signal.

## What this spec demands of the Phase 1 guard interface (the feedback)

This is the concrete reason Phase 2's spec precedes Phase 1's implementation.
The four hard guards need only `(order, account snapshot, config)`. This guard
additionally needs:

1. **A market-data slot in the guard context** — provider-supplied, with
   **freshness metadata** (`computedFrom`, `staleAfter`), so a guard can
   distinguish "fresh regime" from "stale/unavailable" without reaching into
   network code itself.
2. **A shared intent-classification helper** — the pinned risk-reducing
   definition from Phase 1 must be a reusable function (G2, G3, and this guard
   all consume it), not logic copy-pasted per guard.
3. **Annotation codes on `PASS`** — the binary `PASS/BLOCK` enum stays, but a
   `PASS` must be able to carry a loud code + message (already introduced by
   `CONFIG_INVALID_REDUCE_ONLY_PATH`; this guard adds more).
4. **Per-guard symbol scoping** — a guard must be able to declare "I only
   evaluate these instruments" and render *not-applicable* (distinct from PASS)
   for everything else.

Phase 1 implementation must leave these four extension points open.

## Intent classification (pinned — what counts as "opening/increasing a short")

Reuses the Phase 1 pinned risk-reducing definition verbatim. On top of it:

```text
short_increasing(order) =
      order.side == SELL on a derivatives / margin instrument
  and NOT risk_reducing(order)                # Phase 1 pinned definition
  and projected net position after fill < current net position floor at 0
      (i.e. the order creates or increases net short exposure)
```

- **Reduce/close of an existing long is NOT a short intent** — exchange-enforced
  `reduceOnly` / `closePosition`, or a sell provably ≤ current long size, is
  exempt from this veto entirely (the user's pinned exception).
- **Flip orders** (sell larger than the current long, net result short) **are
  short-increasing** — the excess portion opens a short; v0 treats the whole
  order as gated (conservative; no auto-splitting, the human can split).
- **Spot sells of owned BTC can never be short-increasing** (no negative spot
  position) — spot sells are structurally exempt.

## Live regime computation (pinned — must match the backtest bit-for-bit)

Identical to the validated study, no "improvements":

```text
source   : Binance SPOT BTCUSDT daily klines (public), completed candles only
sma      : SMA200 of daily close
band     : ±3%
zones    : close > SMA200×1.03 → BULL
           close < SMA200×0.97 → BEAR
           otherwise           → GRAY          (stateless, no hysteresis carry)
schedule : recomputed once per UTC day after the daily close;
           the zone is valid for the following UTC day
staleness: if the newest completed daily candle is older than
           `regimeStaleAfterHours` (default 30h) at evaluation time,
           or the fetch fails, or SMA warmup is unsatisfied
           → regime = UNKNOWN
```

- The **same stateless zone rule** as the validated study — the trend-v0
  hysteresis state machine is NOT used here (permission gates must not inherit
  stale conviction; this was pinned in the research spec and stays).
- Venue note: spot daily data gating perp execution is the same **explicit,
  bounded relaxation** recorded in the research spec — acceptable only because
  this is a slow macro veto, never an execution-price signal.

## Decision table (pinned — the entire runtime behavior)

Evaluated per order, inside the Phase 1 pipeline, same hook point
(`services/uta/src/http/routes-trading.ts`, after pendingHash, before broker):

```text
if NOT short_increasing(order):          -> guard NOT_APPLICABLE (silent —
                                            no verdict, no annotation noise)
if instrument not in gatedInstruments:   -> guard NOT_APPLICABLE
                                            + code REGIME_GATE_NOT_VALIDATED
                                            ("no validated regime gate for X")
if regime == BULL:                       -> BLOCK  (the validated veto)
if regime == UNKNOWN (stale/missing):    -> BLOCK  (UNKNOWN is not SAFE)
if regime == GRAY:                       -> PASS + code REGIME_GRAY_NO_AUTO_VETO
if regime == BEAR:                       -> PASS + code REGIME_NO_MACRO_BLOCK
```

- **"Not validated" is never phrased as a pass on the merits.** For un-gated
  instruments the *pipeline-level* result is `PASS` (the binary enum is
  preserved), but the *guard-level* record is `NOT_APPLICABLE` — the guard
  declined jurisdiction; it did not evaluate and approve.
- **`UNKNOWN → BLOCK` applies ONLY to short-increasing orders on
  `gatedInstruments`.** A BTC regime outage — known or unknown — never gates
  any other instrument (an ETH short is untouched by a BTC data failure);
  anything else would smuggle BTC-only validation onto unvalidated symbols.

- **GRAY passes but UNKNOWN blocks — deliberately asymmetric:** GRAY is a
  *known* state the validation did not cover (no evidence to block on);
  UNKNOWN is *absence of information*, where the gate cannot do its one
  validated job. Known-but-unproven ≠ unknown.
- **LONG intents are never evaluated by this guard** (LONG-side veto not
  validated — wiring it would claim evidence we do not have).
- ASK-HUMAN from the research spec maps to **PASS + annotation** here: human
  approval is already mandatory for every push, so the pipeline's job is only
  to (a) hard-block the validated case and (b) keep the wording honest.

## Language discipline (verbatim strings, pinned)

```text
BLOCK (BULL):    "BTC is above SMA200+3% (BULL regime). Short-side bull-regime
                  veto — validated by regime-risk-gate-v0. This blocks the
                  trade; it does not endorse longs."
BLOCK (UNKNOWN): "Regime UNKNOWN — market data stale or unavailable, the
                  validated veto cannot be evaluated. Short-increasing order
                  blocked (UNKNOWN is not SAFE)."
PASS  (BEAR):    "No macro-regime block detected. This is not an endorsement;
                  the short still requires your confirmation."
PASS  (GRAY):    "Regime ambiguous (within ±3% of SMA200). No automatic veto;
                  judgement is yours."
```

Forbidden anywhere: "macro supports this short", "safe to short", "bear market
— good time to short".

## Config (extends `data/config/risk-gates.json`)

```jsonc
{
  "defaults": {
    "regimeVeto": {
      "mode": "observe",                      // "off" | "observe" | "enforce"
      // execution instruments this veto gates (broker/ccxt notation, explicit)
      "gatedInstruments": ["BTC/USDT:USDT"],
      // where the regime is computed FROM — pinned by the validation
      "regimeSource": { "venue": "binance_spot", "symbol": "BTCUSDT" },
      "regimeStaleAfterHours": 30,
      "spec": "regime-risk-gate-v0@70eb587"   // provenance, shown in UI
    }
  }
}
```

- **Execution instruments and the regime source are deliberately separate
  keys.** The veto gates *derivatives/margin instruments* in broker notation
  (e.g. ccxt `BTC/USDT:USDT`), while the regime is computed from *Binance spot
  `BTCUSDT`* — fixed by the validation, not a per-account preference. Conflating
  the two is a classic symbol-mapping implementation bug; the config shape
  makes it impossible.
- `gatedInstruments` is an **explicit list** — v0 does no base-asset inference.
  ETH/alt shorts are *not* gated and render the `REGIME_GATE_NOT_VALIDATED`
  annotation (one quiet line, honest, no noise).
- Same config fail-closed semantics as Phase 1 (invalid config → Phase 1's
  emergency path governs; this guard inherits it).

## Observe mode (designed for a rare trigger — verify the signal, not wait for trades)

Real `SHORT+BULL` pushes may be months apart; observe cannot hinge on trigger
counts. Two parallel tracks, both required:

1. **Historical replay parity (one-shot, before observe starts):** run the live
   regime computation over the study window and diff against the research
   artifact `regime_risk_gate_v0_backtest/daily_regime_zones.csv`. **Required:
   zero zone mismatches.** Any mismatch = implementation bug; fix before
   observing.
2. **Live shadow (continuous):** compute the zone daily, log
   `(date, close, sma200, zone, data_age)` to the event log; alert on any day
   the computation fails or goes stale.

```text
observe exits only after ALL of:
  historical replay parity == exact match
  AND >= 30 computed live days within a 45-calendar-day window
      (each gap/stale day individually explained in the review —
       an occasional upstream hiccup must not restart observe forever)
  AND every real short-intent evaluation in the window reviewed (may be zero)
  AND a human review signs off
```

Then flip to `enforce` per account. In observe mode the guard annotates **both
approval surfaces — Web UI and Telegram approval messages — from day one** with
what it *would* have done, but blocks nothing. Surfacing is the point of
observe: a log nobody sees teaches nobody how the gate behaves.

## Failure-mode table

| Failure | Without this guard | With v0 |
|---|---|---|
| Human shorts BTC into a confirmed up-regime at 2am | approval is the only gate | BLOCK with the validated reason |
| Market-data outage during a short attempt | n/a | BLOCK (UNKNOWN ≠ SAFE), loudly |
| Sell that merely closes a long | — | exempt — never misread as a short |
| Flip order (long → net short) | — | gated as short-increasing (conservative) |
| Short on ETH (unvalidated instrument) | — | guard NOT_APPLICABLE; honest "no validated gate" annotation |
| Wording drift toward endorsement | — | pinned verbatim strings |

## Deliberately OUT of v0

- **Any LONG-side gating** (not validated — this is the whole discipline).
- ETH / alt regime gates; base-asset inference.
- SIZE-DOWN, auto-splitting flip orders.
- Regime as a `directionSource`, proposal input, or sizing input.
- Hysteresis / trend-state machines (stateless zones only).
- Funding, microstructure, news — other phases, other validations.

## Testing plan

- Unit: intent classification (reduceOnly / closePosition / partial-close /
  flip / spot-sell / plain short), zone computation (band edges exact:
  `×1.03`, `×0.97`), staleness boundary, each decision-table row.
- Replay parity test against `daily_regime_zones.csv` wired as a fixture.
- e2e: staged BTC short → approve → BLOCK in BULL fixture; UNKNOWN fixture →
  BLOCK; BEAR fixture → PASS + annotation; ETH short → not-applicable path.
- `tsc --noEmit` + `pnpm test` green before any commit.

## Review record (2026-06 — red-pen decisions, resolved)

1. **`regimeStaleAfterHours = 30`** — kept (one daily close + 6h grace).
2. **Live shadow: `≥ 30 computed days within a 45-calendar-day window`** — not
   "consecutive"; an occasional upstream hiccup must not restart observe
   forever. Every gap/stale day is individually explained in review. (Replay
   parity carries the correctness burden; the shadow proves operational
   stability.)
3. **Flip orders: whole-order gating** — conservative; the human splits into
   close + open if needed. No auto-splitting.
4. **Observe annotations in Web UI AND Telegram from day one** — surfacing is
   the point of observe.
5. **Un-gated instruments are guard-level `NOT_APPLICABLE`** (pipeline-level
   `PASS` to preserve the binary enum) — "we did not validate this symbol" is
   never phrased as a pass on the merits.
6. **`UNKNOWN → BLOCK` scoped strictly to `gatedInstruments`** — a BTC data
   outage never gates ETH; BTC-only validation is never smuggled onto
   unvalidated symbols.
7. **`gatedInstruments` (execution, broker notation) and `regimeSource`
   (Binance spot BTCUSDT, pinned by validation) are separate config keys** —
   symbol-mapping conflation is an implementation killer, so the config shape
   forbids it.

## Related

- [risk-gate-pipeline-v0.md](risk-gate-pipeline-v0.md) — Phase 1 pipeline this
  guard plugs into; the four interface extension points above are requirements
  on its implementation.
- [backtests/regime-risk-gate-v0.md](backtests/regime-risk-gate-v0.md) — the
  validation this onboarding is strictly limited to (`SHORT in BULL → BLOCK`,
  commit `70eb587`).
- [alice-trading-constitution.md](alice-trading-constitution.md) — veto
  asymmetry, `UNKNOWN is not SAFE`, language discipline.
- [trade-proposal-principles.md](trade-proposal-principles.md) — gates decide
  permission, never direction.
