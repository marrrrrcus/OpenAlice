# Shadow strategy registration — buy-and-hold-v0

Registered under [strategy-shadow-track-v0.md](../strategy-shadow-track-v0.md).
Research evidence only — never a signal, never a proposal.

## Pinned rule

```text
stance = long, every day, once ≥ 2 completed daily candles exist
symbol = BTCUSDT (Binance spot daily closes)
```

No parameters, no state, no band. The entry cost (1 leg, 10 bps at the
pinned cost model) is paid once on the first marked day, per the track's
flat-baseline fairness rule.

## Role

**Baseline + pipeline verification — not promotable by definition.** This
strategy makes no entry claim; there is nothing to validate. Its jobs:

1. Exercise every part of the scoring track (ledger chaining, mark math,
   costs, catch-up, unknown handling) with the simplest possible rule.
2. Provide the comparison denominator every other track is read against:
   a candidate that cannot beat always-long-after-costs on risk-adjusted
   terms has no claim to an edge.

## Pre-registered track parameters

- Activation: the first ledger row after B1 deployment to the runtime clone
  (`data/research/shadow/buy-and-hold-v0.jsonl`).
- Evaluation window: open-ended (a baseline has no exit criteria).
- INCONCLUSIVE guards (track health, not verdict): unknown/eligible > 10%
  or backfilled/eligible > 20% — per the track spec's pinned denominators.

## Status

- 2026-07-02 — registered (B1 seed). Not yet deployed; the activation date
  is set by the first ledger row on the runtime clone.
