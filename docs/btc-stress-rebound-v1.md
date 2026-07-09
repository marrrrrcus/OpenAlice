# BTC Stress Rebound v1

> Status: IMPLEMENTED AS ALERT-ONLY MONITOR.
> This is a human-facing awareness monitor, not a strategy, not a
> directionSource, not a risk gate, and not a strategy-shadow track.

## Purpose

BTC Stress Rebound v1 tracks a daily-close state machine:

```text
event peak -> stress_watch -> rebound_confirmed -> structure_repair -> long_term_repair / normal
```

Its job is to notify Marcus when the market moves between these objective
states. It does not create orders, proposals, verdicts, or paper-performance
claims. If Marcus chooses to trade after an alert, the trade must still go
through Alice stage -> commit -> Trading as Git verdict.

## Data

- Source: Binance spot `BTCUSDT` daily candles.
- Completed UTC daily candles only.
- Default history depth: 1000 completed candles.
- Minimum allowed history depth: 500 completed candles. This is deliberate:
  SMA240 needs a warm-up window, and event-local peaks need enough post-warmup
  context to avoid a silently blind stress trigger.
- State transitions use daily close only.
- Intraday lows are diagnostic only and never trigger failure.
- Missing or failed data is UNKNOWN: the monitor does not evaluate, does not
  change state, and retries on the next tick.
- Completed daily candles must be calendar-contiguous UTC days. A missing,
  duplicate, or malformed daily date is UNKNOWN: the monitor emits no Telegram
  notification, does not write `lastEvaluatedDayUtc`, and retries when the next
  tick has clean data.
- The persisted monitor state file is not auto-reset on corruption. If
  `statePath` contains unreadable JSON or malformed fields, the monitor emits no
  Telegram notification and does not overwrite the file; fix the state file or
  intentionally remove it before restarting first-run behavior.

## Pinned Parameters

```text
drawdownPct      = 20
reboundMultiple  = 1.15
timeoutDays      = 60
SMA set          = 60 / 120 / 200 / 240
```

## Event-Local Peak

`event_peak_close` is the highest completed daily close since the previous
stress/rebound episode ended. It is not an all-time high and not a fixed
rolling-window peak.

When a stress episode starts, the event peak is frozen for that episode.
When long-term repair occurs, the episode ends and the next event peak starts
from that daily close.

## State Machine

| State | Daily-close condition | Notification |
|---|---|---|
| `normal` | No active stress episode | Initial / long-term repair only |
| `stress_watch` | Close has drawn down at least 20% from `event_peak_close`, and close is below SMA200 or SMA240 | Enter stress notification |
| `rebound_confirmed` | Close >= `trough_close * 1.15` | State-change notification |
| `structure_repair` | Close >= SMA60 and close >= SMA120 | State-change notification |
| `normal` via `long_term_repair` | Close >= SMA200 and close >= SMA240 | Stress regime cleared notification |
| `failure` event | After confirmation or repair, close < `trough_close` | Failure notification; returns to `stress_watch` |
| `timeout` event | 60 days after `rebound_confirmed` without `structure_repair` | Timeout notification; returns to `stress_watch` |

If one daily close crosses multiple thresholds, the monitor emits one highest
transition only. For example, a direct jump from `stress_watch` to a close
above SMA200 and SMA240 emits `long_term_repair`, not a burst of lower-level
notifications.

## Notification Discipline

Telegram notifications are sent only on state transitions, plus one initial
activation smoke notification after first deployment.

Message content may include:

- state
- date
- close
- event peak
- trough close
- rebound line
- trigger
- reason details, including close vs relevant SMA/threshold levels
- next objective condition

Message content must be in Chinese and must not imply endorsement. The fixed
reminder is:

```text
提醒:這不是交易訊號。如果你選擇交易,請走 Alice stage -> commit -> Trading as Git verdict。
```

## Query Tool

`market_state_report` returns the current state and thresholds on demand.
It is a report tool only. It does not write research ledgers and does not
qualify a strategy for promotion.

## Explicit Non-Goals

- No TradingGit changes.
- No risk-gate changes.
- No Track D changes.
- No strategy-shadow registration.
- No volume, funding, or open-interest filters.
- No automatic entries, exits, or sizing.
- No authenticated trading surface in this monitor: no API keys, no signatures,
  no order endpoints, no leverage or margin mutation calls.

If this idea later needs paper-performance evidence, it must receive a new
pre-registered spec and a new strategy id such as `stress-rebound-shadow-v0`.
