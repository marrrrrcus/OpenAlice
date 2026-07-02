# Design spec — Risk Gate Pipeline v0 (hard limits, fail-closed)

A **design spec for a runtime safety layer**, not yet implemented. Phase 1 of
the safety roadmap: pure-engineering hard limits that require **no backtest and
no market hypothesis** — position caps, loss circuit breaker, rate limits.
They exist so that a single human mis-click (or a stale approval, or an AI
prompt-injection that somehow reaches the approval surface) cannot produce an
outsized order.

> **Status:** DESIGN DRAFT. Not implemented, not wired, no behavior change until
> reviewed, implemented, and explicitly enabled per account.

## Constitution alignment

- `Risk gates decide permission` — output is permission only (`PASS/BLOCK` in
  v0), never direction.
- `Alice has veto power, not endorsement power` — this pipeline can only stop
  what a human already decided; it never originates.
- `UNKNOWN is not SAFE` — every guard is **fail-closed**: if it cannot compute
  (missing price, config unparseable, internal error), it **BLOCKS with a
  reason**; it never silently passes.
- `ALLOW is not endorsement` — a pipeline pass means "no hard limit tripped",
  never "this trade is good".

## Position in the architecture (the hook point)

```text
human intent → stagePlaceOrder → commit → [HUMAN APPROVAL] → push ─┬─► broker
                                                                   │
                                              RISK GATE PIPELINE ──┘
                                              (server-side, inside the UTA
                                               wallet/push handler, right
                                               next to the pendingHash guard,
                                               BEFORE broker execution)
```

- **Enforcement point (pinned, verified in code):** the UTA server's push
  handler at `services/uta/src/http/routes-trading.ts:437`
  (`POST /uta/:id/wallet/push`) — the single choke point every approval surface
  (Web UI PushApprovalPanel, Telegram `/trading`, SDK `UTAAccountSDK.push()` at
  `src/services/uta-client/UTAAccountSDK.ts:223`) must pass through. The
  pipeline runs **immediately after the existing pendingHash guard** (same file,
  line ~443) and before broker execution — same fail-closed philosophy, HTTP 4xx
  + no execution on failure.
- **Why after human approval:** the pipeline is the **second gate**. Human
  approval remains the first and primary gate (`tradingPush` in
  `src/tool/trading.ts` already refuses AI-initiated pushes). The pipeline
  protects against the residual failure modes: mis-click, stale context at
  approval time, fat-fingered size at stage time.
- **Surfacing point (pre-approval):** guard verdicts are ALSO computed and shown
  in `tradingStatus` / PushApprovalPanel / TG approval message, so the human
  sees "G2 would block this: projected exposure 142% > 100%" **before**
  deciding — not only at push time. Display is advisory; enforcement is only at
  push.

## Guard enumeration (v0 — exactly four, all dumb, all fail-closed)

No market opinion anywhere below. Thresholds are config, not code.

### G1 — Max order notional
Single order's notional value (`|qty| × reference price`, quote currency
normalized to USD) must not exceed the **effective cap**:

```text
effective_cap = min(maxOrderNotionalAbsUsd,
                    maxOrderNotionalEquityPct × account_equity)
```

- Reference price: order's limit price; for market orders the latest mark/last
  price from the broker snapshot. **No price available → BLOCK** (fail-closed),
  message states "cannot price order".
- **Equity unavailable → BLOCK** (fail-closed; same snapshot rule as G2) — the
  pct leg cannot be computed, and falling back to the absolute cap alone
  would silently loosen the limit for small accounts.

### G2 — Max total exposure (projected, post-trade)
Projected exposure **after** this push must not exceed `maxTotalExposurePct` of
account equity. The formula is **pinned** (v0 uses the most conservative
reading — gross, not net):

```text
projected_gross_exposure =
    Σ |existing position notional|
  + Σ |open risk-increasing order notional|      # already-resting orders count
  + |this push's risk-increasing order notional|

exposure_ratio = projected_gross_exposure / account_equity
BLOCK if exposure_ratio > maxTotalExposurePct
```

- **Gross, not net** — a long and a short do not cancel for this limit.
- **Scope: per-account** in v0 (the push route is per-account); cross-account
  aggregation is a v1 concern, noted, not silently assumed.
- **Risk-reducing orders (see pinned definition below) add zero** to projected
  exposure and are never blocked by G2.
- Uses the same account snapshot the approval panel shows. **Snapshot stale
  beyond `snapshotMaxAgeSec` or unavailable → BLOCK.**

### G3 — Daily loss circuit breaker (transfer-adjusted, NOT raw NLV)
If today's loss exceeds `dailyLossLimitPct` of start-of-day equity, **all new
risk-increasing pushes are blocked** for the rest of the UTC day.

**The loss measure is pinned as transfer-adjusted equity change** — raw NLV
delta is NOT PnL (deposits, withdrawals, and inter-account transfers pollute
it):

```text
daily_loss = (current_equity − net_transfers_today) − start_of_day_equity
trip if daily_loss < −dailyLossLimitPct × start_of_day_equity
```

- **Hard precondition:** if transfer-adjusted equity is not implementable for a
  broker yet, **G3 stays `observe`-only on that account** — it must not enforce
  on raw NLV. A breaker that trips on a deposit is worse than no breaker.
- Risk-REDUCING orders (pinned definition below) are **exempt** — a circuit
  breaker must never trap you in a position.
- PnL/equity unavailable → BLOCK new risk-increasing pushes (fail-closed),
  exempt reducing ones.

### G4 — Rate limit + duplicate detection (canonical intent key)
- At most `maxPushesPerHour` executed pushes per account (rolling window).
- Duplicate detection compares a **pinned canonical intent key** against orders
  executed within `duplicateWindowSec`:

```text
canonical_key = (account, symbol, side, orderType, reduceOnly,
                 quantity, limitPrice / triggerPrice)

normalization (pinned — key fields compare canonically, not as raw strings):
  account / symbol           -> exchange-canonical casing
  quantity / prices          -> normalized to broker precision ("1" == "1.0")
  market orders              -> price fields are explicit nulls, not omitted
```

  Match → BLOCK with "possible duplicate — executed <t>s ago". Without the
  normalization, precision or casing differences would make duplicates slip
  through (missed) or distinct orders collide (false-block).

- **`pendingHash` is deliberately EXCLUDED from the key.** The dangerous
  duplicate is the broker-timeout case: the push executed at the broker but the
  response was lost, the human re-stages the same order — which gets a **new**
  pendingHash. The pendingHash guard cannot catch that; the intent key can.
  (Same-commit double-submits — UI double-click, TG retry — are already caught
  by the pendingHash guard itself: the pending commit is consumed on first
  execution.)
- **Deliberate laddered / batch orders are not false-blocked** because they
  differ in price or quantity, which changes the key. Two truly identical
  orders within the window is exactly the case that deserves a stop-and-look.
- Both trips → human can still act next window (or adjust price/qty); nothing
  is queued or retried automatically.

## Risk-reducing vs risk-increasing (pinned definition)

Several guards exempt "risk-reducing" orders. The definition is **strict and
mechanical** — an order counts as risk-reducing **only if it cannot increase
exposure under exchange semantics**:

```text
risk_reducing =
     reduceOnly == true          (exchange-enforced)
  or closePosition == true       (exchange-enforced)
  or projected exposure strictly decreases (provable from snapshot)

everything else — including any order merely NAMED "stop" — is risk-increasing.
```

- A stop-LOSS placed as exchange-enforced reduce-only ⇒ exempt (protective).
- A stop-ENTRY (breakout buy-stop) ⇒ **risk-increasing**, fully gated. Order
  *type* names grant no exemption; only exchange-enforced flags or provable
  exposure decrease do.

## Output semantics

- Per guard: `PASS` or `BLOCK { code, reason, observed, limit }`.
- Pipeline: **any BLOCK ⇒ push rejected** (HTTP 409-style, mirrors pendingHash),
  nothing sent to the broker, the pending commit stays intact (can be rejected
  or re-approved after config change — never auto-retried).
- v0 is deliberately **binary**. `SIZE-DOWN` (auto-shrinking an order) is out of
  scope: silently changing a human's order size is a footgun; the human resizes
  and re-stages.

### Language discipline (same rules as regime-risk-gate-v0)
- BLOCK messages state **observed vs limit facts** only:
  `"G2 BLOCK: projected exposure 142% > limit 100%"`.
- A full-pass renders as `"No hard-limit block detected"` — **never** "safe",
  "OK to trade", or "Alice approves".

## Config (Zod-validated, per-account overridable)

`data/config/risk-gates.json` — global defaults + per-account overrides, loaded
through `core/config.ts` like other config. Sketch:

```jsonc
{
  "defaults": {
    "mode": "observe",                    // "off" | "observe" | "enforce"
    // G1 — effective cap = min(absolute cap, equity-scaled)
    "maxOrderNotionalAbsUsd": 1000,
    "maxOrderNotionalEquityPct": 25,      // min($1000, 25% × equity)
    // G2 — gross projected exposure vs equity
    "maxTotalExposurePct": 100,
    // G3 — transfer-adjusted daily loss
    "dailyLossLimitPct": 5,
    // G4
    "maxPushesPerHour": 10,
    "duplicateWindowSec": 120,
    // G2 staleness bound
    "snapshotMaxAgeSec": 300
  },
  "accounts": {
    "mock": { "mode": "enforce" }         // mock enforces from day one
  }
}
```

- **All thresholds are account-scoped config and equity-relative where
  meaningful** (a fixed USD number goes stale as equity changes; G1 therefore
  takes `min(absolute cap, pct-of-equity)`). The numbers above are starting
  values; **defaults stay observe-only until calibrated per account** against
  real equity and real push patterns. The spec pins the *mechanism*, not the
  numbers.
- Config missing → defaults apply. Config **unparseable → fail-closed with a
  reduce-only emergency path** — a broken safety config must be loud, but the
  gate must never lock a human *into* risk:

```text
invalid risk-gate config:
  risk-increasing orders                          -> BLOCK ("config invalid")
  exchange-enforced reduceOnly / closePosition    -> PASS with code
                                                     CONFIG_INVALID_REDUCE_ONLY_PATH,
                                                     annotated loudly
  anything not provably risk-reducing             -> BLOCK
```

(Stays within the binary `PASS/BLOCK` enum — the emergency path is a `PASS`
carrying a loud code, not a third verdict.)

  This is not a relaxation: the reduce-only path is exactly the set of orders
  that cannot increase exposure under exchange semantics (pinned definition
  above). Without it, a corrupted config would turn the safety layer itself
  into a source of risk.
- **Override path in v0: edit config + restart/reload. No one-click override
  button.** Friction is intentional; every change is a file diff.

## Modes and rollout (observe-first, same discipline as everything else)

1. **Implement + unit tests** (each guard: pass case, block case, and the
   fail-closed case where its input is missing).
2. **`observe` mode on live accounts:** pipeline computes and **logs/annotates
   only** — verdicts appear in event-log, approval panel, TG message; nothing is
   blocked. `enforce` on `mock` from day one.
3. **Exit criterion for observe (pinned so it cannot dangle forever, and
   explicit AND so it cannot exit early):**

   ```text
   observe mode exits only after ALL of:
     >= 14 calendar days in observe
     AND >= 10 observed push attempts
     AND a human review of every would-have-blocked / should-have-blocked case
   ```

   14 quiet days with 1 push is not enough data; 10 pushes in one wild day is
   not enough time. Both, plus the review, then flip to `enforce` per account.
4. Every verdict (PASS and BLOCK, observe and enforce) is appended to the
   event-log for audit.

## Failure-mode table (the actual point of this doc)

| Failure | Without pipeline | With v0 |
|---|---|---|
| Human mis-click approves fat-fingered qty | broker executes | G1/G2 BLOCK |
| Approval on stale context (price moved, exposure grew) | executes | G2 recomputes at push time |
| Cascade of pushes in a bad hour | all execute | G3/G4 stop the bleeding |
| Duplicate push (UI double-submit, TG retry) | duplicate order | G4 BLOCK |
| Price/snapshot feed down | order goes through unpriced | G1/G2 BLOCK (fail-closed) |
| Risk-gate config corrupted | n/a | risk-increasing blocked loudly; exchange-enforced reduce-only path stays open |

## Deliberately OUT of v0

- Regime veto (`SHORT in BULL → BLOCK`) — Phase 2, separate onboarding spec,
  builds on this pipeline's guard interface.
- Microstructure / spread / depth gates — Phase 3, needs its own validation.
- Funding, news, any market opinion.
- `SIZE-DOWN` auto-resizing.
- Any `directionSource` semantics — this layer never knows *why* the human is
  trading.

## Testing plan

- Unit: per guard × {pass, block, fail-closed-input-missing}.
- Config: invalid JSON ⇒ risk-increasing blocked + exchange-enforced
  reduce-only passes with loud annotation; missing file ⇒ defaults.
- e2e: staged order → approve → G2 block at push → commit intact → config
  raise → re-approve → executes. Duplicate-push e2e for G4.
- `tsc --noEmit` + `pnpm test` green before any commit (house rule).

## Review record (2026-06 — red-pen decisions, resolved)

1. **Thresholds:** account-scoped, equity-relative (`min(abs, pct-of-equity)`
   for G1); defaults observe-only until calibrated. No fixed-USD-forever caps.
2. **Observe exit:** explicit AND — ≥14 days AND ≥10 push attempts AND human
   review of would/should-have-blocked cases.
3. **Protective-order exemption:** granted ONLY to orders that cannot increase
   exposure under exchange semantics (`reduceOnly` / `closePosition` /
   provable exposure decrease). Order-type names ("stop") grant nothing;
   stop-entries are fully gated.
4. **G2 formula pinned:** gross (not net), per-account, includes resting
   risk-increasing orders, excludes risk-reducing orders.
5. **G3 measure pinned:** transfer-adjusted equity change, never raw NLV; if
   transfer adjustment is not implementable for a broker, G3 stays
   observe-only there.
6. **Invalid config:** fail-closed for risk-increasing, with a reduce-only
   emergency path (`PASS` + `CONFIG_INVALID_REDUCE_ONLY_PATH` code — stays
   within the binary enum) so the gate can never lock a human into risk.
7. **G4 canonical intent key pinned**, deliberately excluding `pendingHash`
   (re-staged broker-timeout duplicates carry new hashes — the exact case G4
   exists for; same-commit double-submits are already covered by the
   pendingHash guard).

(Also resolved during drafting: the UTA server lives in this repo at
`services/uta/`; the pipeline lands in
`services/uta/src/http/routes-trading.ts` next to the pendingHash guard.)

**Implementation is deliberately NOT started.** This document is the runtime
safety spec; wiring it into `routes-trading.ts` changes live order behavior and
proceeds only on explicit go, guard by guard, observe-first.

## Related

- [alice-trading-constitution.md](alice-trading-constitution.md) — §B risk
  gates, §C veto asymmetry, `UNKNOWN is not SAFE`.
- [trade-proposal-principles.md](trade-proposal-principles.md) — gate tiering.
- [backtests/regime-risk-gate-v0.md](backtests/regime-risk-gate-v0.md) — the
  validated `SHORT in BULL → BLOCK` veto that Phase 2 will wire onto this
  pipeline's guard interface.
