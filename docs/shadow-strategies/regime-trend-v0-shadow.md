# Shadow strategy registration — regime-trend-v0-shadow

Registered under [strategy-shadow-track-v0.md](../strategy-shadow-track-v0.md).
Research evidence only — never a signal, never a proposal.

## Pinned rule (verbatim from the REJECTED backtest)

The mainline of [backtests/regime-trend-v0.md](../backtests/regime-trend-v0.md)
— **REJECTED 2026-06** (beat buy-and-hold on every aggregate metric, failed
the pre-registered per-cycle gate on the 2019–2020 fast crash):

```text
SMA200 = 200-day simple mean of completed daily closes (incl. newest)
close > SMA200 × 1.03  → long   (BULL)
close < SMA200 × 0.97  → flat   (BEAR — long/flat rule, never short)
otherwise              → carry the previous stance (GRAY hysteresis)
symbol = BTCUSDT (Binance spot daily closes)
```

Implemented by folding the validated `computeZone` (the regime veto's
replay-parity-tested math) day by day.

### Hysteresis state source (per the track spec)

- **Chained (normal):** `prevStance` comes from the ledger's previous day
  row — live ticks and backfill both chain day-by-day.
- **Cold start / broken chain:** state = the most recent band exit within
  the provided kline window (walk back from yesterday, recomputing the zone
  on each shortened history); a window containing no band exit at all →
  `unknown` ("hysteresis state indeterminate").
- **Honesty note:** the backtest's initial state was "FLAT until the first
  BULL after warmup", defined over *full* history. A bounded window cannot
  always reproduce that, so `unknown` is the honest cold-start answer when
  the window is uninformative. In practice a 500-day window (`minDays`)
  virtually always contains a band exit. **Cold-start reconstruction is a
  forward-operational approximation, not a replay of the rejected
  backtest's initial state** — shadow days must never be read as a re-run
  of `regime-trend-v0`.

## Role

**Out-of-sample harness control — NOT a promotion candidate.** A rule with
a completed, adverse backtest verdict runs forward so the scoring track
itself can be checked: if the shadow's realized behavior contradicts the
backtest's known character (long most of the time in bulls, whipsaw costs
in the band, exits after confirmed breakdowns), **suspect the harness
first**.

## Non-resurrection clause

Even a good forward record does **not** overturn `regime-trend-v0`'s
REJECTED verdict. Ninety days of pleasant numbers is not "v0 was right all
along" — the rejection was about per-cycle crash protection, which a short
forward window cannot re-litigate. A strong forward track can produce only:

1. a **human-written** comparison verdict (this doc's exit criteria), or
2. a **separately pre-registered vNext hypothesis** with its own study.

Nothing automatic, in either direction.

## Pre-registered track parameters

- Activation: first ledger row after B2 deployment to the runtime clone
  (`data/research/shadow/regime-trend-v0-shadow.jsonl`).
- `dataNeeds`: klines, `minDays: 500` (200-day SMA warmup + ~300 days of
  zone history for cold-start exit hunting).
- Exit criteria (evidence bar, per the track spec's pinned denominators):
  **≥ 90 known-forward days** AND unknown/eligible ≤ 10% AND
  backfilled/eligible ≤ 20% → a **human-written** comparison against
  (a) the backtest's character and (b) the `buy-and-hold-v0` baseline
  track. No automatic verdict of any kind.

## Status

- 2026-07-02 — registered (B2). Not yet deployed; activation is set by the
  first ledger row on the runtime clone.
