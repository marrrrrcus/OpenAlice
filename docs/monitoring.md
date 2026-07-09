# Proactive Monitoring — market / account / news / microstructure alerts

OpenAlice runs **deterministic, Pump-driven monitors** that push alerts to
the user (primarily Telegram) without being asked. They exist to replace
prompt-driven "check X every N minutes" cron jobs, whose every tick spent
AI tokens fetching data via tool calls and produced a report even when
nothing changed.

Three legacy monitors are active by default — **market-report**,
**account-report**, **news-alert**. Two alert-only guard layers can sit beside
them:

- **microstructure-alert** (order book + funding risk), wired but shipped
  `enabled: false`; enable it per
  [microstructure-alerts.md](microstructure-alerts.md) once you've picked a
  CCXT `source` account and let its baselines warm up.
- **live-readiness-alert**, a self-monitor for the alert-only live stack. It
  checks that auto-trading remains disabled, Telegram delivery is configured,
  BTC stress-state alerts are fresh, and microstructure alerts are fresh.

**Read this before touching `src/task/market-report/`,
`src/task/account-report/`, or `src/task/news-alert/`** — they share a
design and a set of non-obvious rules (hysteresis, cold-start
suppression, force-push priority) that are easy to half-implement.

## The shared shape

Each monitor is a [Pump](../src/core/pump.ts) (interval-scheduled
callback, same primitive heartbeat uses) wired in [main.ts](../src/main.ts)
and toggled by its own config section. On each tick:

```
1. Data   — read live state (snapshot file, broker, news store). No AI.
2. Rules  — pure functions with hysteresis decide what (if anything)
            changed enough to surface. No AI.
3. Deliver— program-built message via ConnectorCenter.notify(), OR (only
            market-report) an AI-written summary via agent.work.requested.
```

State persists to a `data/*-state.json` file so hysteresis survives
restarts. Each monitor skips work cleanly when its source is
empty/unreachable.

| Monitor | Interval | AI? | State file | Config |
|---|---|---|---|---|
| market-report | 30m | **events only** (RSI/price summaries) | `data/market-report-state.json` | `market-report.json` |
| account-report | 5m | no — fully deterministic | `data/account-report-state.json` | `account-report.json` |
| news-alert | 10m | no — fully deterministic | `data/news-alert-state.json` | `news-alert.json` |
| microstructure-alert | 2m order book / 30m funding | no — fully deterministic | `data/microstructure-alert-state.json` | `microstructure-alert.json` (`enabled:false` by default) |
| live-readiness-alert | 15m when enabled | no — fully deterministic | `data/live-readiness-alert-state.json` | `live-readiness-alert.json` |

Order book and funding-rate reads are exposed to Alice as live tools
(`getOrderBook`, `getFundingRate`). The optional scheduled alert layer is
implemented but ships off by default; see
[microstructure-alerts.md](microstructure-alerts.md).

### Token cost

account-report and microstructure-alert never call the AI — zero tokens,
always. news-alert is zero-AI on idle ticks too, and calls the AI **only when
an alert fires**, to translate the delivered headlines to zh-Hant (degrades to
original-only on failure — never per calm tick).
market-report spends tokens **only when an event fires** (see below), and
even then it's a single small generation with the numbers pre-baked into
the prompt (no tool calls). Calm ticks cost nothing.
live-readiness-alert is also zero-AI: it reads local state/config and emits
program-built operational messages only.

### Force-push priority

Risk alerts must reach the user when they're *not* watching. notify()
takes a `priority`; `'high'` makes Telegram surface the push regardless of
the last-interacted channel (see
[shouldSurfaceToTelegram](../src/connectors/telegram/helpers.ts)). `'normal'`
keeps the old "inline only when Telegram is active" behaviour. Use `'high'`
for genuine alerts, `'normal'` for quiet/informational summaries.

---

## live-readiness-alert

[src/task/live-readiness-alert/](../src/task/live-readiness-alert/) monitors
whether the alert-only live stack itself is healthy. It is not a market signal,
does not create proposals, and does not make the system trade.

The underlying report is available two ways:

```
npm run live:readiness
```

and through the deterministic research tool `live_readiness_report`.

Exit code semantics:

- `0` means status `ok`.
- `1` means status `attention` or the report could not be built.

The report checks:

- `autoTrading` is disabled.
- `live-readiness-alert` is enabled when expected.
- Telegram notification delivery is configured, with token/chat values
  redacted.
- `market-state-alert` is enabled and its scheduled state matches the latest
  completed UTC daily BTC candle.
- The current BTC market-state report can be computed.
- `microstructure-alert` has a configured source, readable baseline/lifecycle
  state, and a recent funding tick (fresh within `2 * fundingEvery`).

The scheduled task sends:

- a high-priority alert when status becomes `attention`;
- no duplicate alert for the same attention fingerprint;
- a new high-priority alert if the attention set changes;
- a normal recovery message when status returns to `ok`.

Corrupt readiness state fails closed: the task does not notify and does not
overwrite the file. Fix the state deliberately instead of letting a broken
dedup ledger self-heal silently.

Operational runbook:

1. Run `npm run live:readiness` before trusting the alert-only live stack.
2. If it exits `1`, fix the listed checks before relying on TG alerts.
3. Confirm `data/live-readiness-alert-state.json` exists after runtime start;
   a healthy idle state looks like `{"schemaVersion":1,"lastStatus":"ok"}`.
4. Treat any readiness alert as an operations issue, not as a trading view.

Boundary: this monitor only says whether the alert system is trustworthy. It
does not validate alpha, does not bless BTC stress/rebound as a strategy, and
does not bypass the human Alice stage -> commit -> Trading as Git verdict path.

---

## market-report

[src/task/market-report/](../src/task/market-report/) — monitors BTC/ETH
(configurable) price + RSI(14).

- **Data**: live price from `data/market-snapshot.json` (written by the
  repo-local `services/okx_snapshot_writer.py`, 5-min cadence) when fresh;
  daily candles from the crypto market-data client for the RSI series. RSI
  is computed in-process via [domain/analysis](../src/domain/analysis/).
  On Marcus's Windows workstation the writer is started by
  `START_ALICE.bat` through `scripts/start-okx-snapshot-writer.ps1` and
  `scripts/run-okx-snapshot-writer.bat`; do not run the old
  `20250926-binance_trader_v8` writer in parallel.
- **Rules** ([`detectSymbolEvents`](../src/task/market-report/market-report.ts)):
  RSI zone state machine with hysteresis — fires on entering oversold
  (<30) / overbought (>70), and on *exiting* the zone past a buffer
  (>35 / <65). Plus a price move ≥ `priceMovePct` vs the **last reported**
  price (not the last tick — so a slow drift still trips).
- **Snapshot health**: if `updated_at` is stale (>15 min, the
  `MARKET_SNAPSHOT_MAX_AGE_MS` bound), a `priority:'high'` "writer may be
  down" alert fires once (latched); recovery fires a `'high'` "restored".
- **Delivery**: an event emits `agent.work.requested` →
  [agent-work pipeline](../src/core/agent-work-listener.ts) → the AI writes
  a ≤150-char summary → notify (`notifyPriority:'high'`). The data is
  pre-baked into the prompt; the AI must **not** call tools. Quiet periods
  emit a program-built one-liner at most every `summaryEvery` (4h, normal
  priority) — no AI.

This is the **only** monitor with an AI layer, and only on the event path.

---

## account-report

[src/task/account-report/](../src/task/account-report/) — monitors every
connected UTA (OKX, Binance, …). **Fully deterministic** — alert text is
factual and built by the program, so there's no token cost or
hallucination surface.

- **Data**: `UTAManagerSDK.resolve()` → per account `getAccount()` +
  `getPositions()`.
- **Rules** ([`detectAccountEvents`](../src/task/account-report/account-report.ts)):
  - **Drawdown layers** — per-position loss ≥ 10/18/25% of account NLV,
    hysteresis (re-arms below layer1 − buffer), escalates across layers.
  - **Near-liquidation** — mark-to-liquidation distance ≤ `safetyPct`
    (5%), latched. Uses `Position.liquidationPrice` (see below).
  - **NLV move** — ≥ `nlvMovePct` (5%) vs last reported value.
  - **Position open / close** — diff of the live position set.
- **Cold-start suppression**: the first time an account is seen
  (`lastReportedNlv === null`), the open/close diff is **skipped** — else
  every pre-existing position reports as "newly opened" and re-spams on
  every restart. Drawdown / near-liquidation still fire on cold start
  (they reflect *current* risk).
- **Dust filter**: accounts below `minNlvUsd` (10) are skipped entirely —
  a % drawdown on a $0.73 leftover balance is meaningless noise.
- **Framing**: a batch with a real risk event (drawdown / near-liq) →
  `🚨 帳戶警示`; a purely informational batch (NLV move, open/close) →
  `📊 帳戶動態`. NLV moves carry a 📈/📉 arrow. Don't alarm the user with
  good news — it erodes the 🚨 signal.

**Deferred — stop-loss-missing detection.** Detecting "this position has
no protective stop on the exchange" needs a `listOpenOrders()` broker
capability the `IBroker` interface doesn't expose (`getOrders` takes
explicit ids; the empty-ids path returns only Alice-tracked staged
orders, not stops set manually on the exchange). A cross-cutting addition
across every broker — file in Linear before attempting.

### liquidationPrice plumbing

Near-liquidation needs the broker's liquidation price, which wasn't in the
unified `Position` type. It's now an optional `liquidationPrice?: string`
on [Position](../packages/uta-protocol/src/types/broker.ts), populated by
`CcxtBroker.getPositions()` (only when CCXT reports a real positive value —
0/null means "not applicable" → `undefined`). Additive and backward
compatible; flows through the UTA→Alice JSON wire automatically. Spot
holdings and non-leveraged brokers leave it undefined — treat absence as
"N/A", never "safe".

---

## news-alert

[src/task/news-alert/](../src/task/news-alert/) — pushes breaking-news
headlines from the RSS archive. **Fully deterministic** keyword matching.

- **Data**: `NewsCollectorStore.getNewsV2({ endTime, startTime })`. **Pass
  an explicit `startTime`** computed via `parseDuration(config.lookback)` —
  do *not* pass a `lookback` string. The store's own `parseLookback` only
  accepts `h`/`d`, so a `'30m'` string silently parses to null → no lower
  bound → the query scans the **entire archive** and replays week-old
  headlines as if they were breaking. (This bit us in production.)
- **Rules** ([`classifyNewsItem`](../src/task/news-alert/news-alert.ts)):
  tiered, whole-word boundary matching (so `SEC` doesn't hit "section",
  `ETH` doesn't hit "method"):
  - **High-priority phrases** push alone: hack, exploit, liquidation, SEC,
    ETF approval/rejection, Binance halt, OKX outage.
  - **Coin tickers** (BTC/ETH/…) fire **only** alongside a risk word —
    bare coin tickers match almost every crypto headline.
- **Dedup**: by item link/guid/title, persisted and bounded
  (`maxDedupKeys`). Only **delivered** items are deduped — an over-`maxPerAlert`
  overflow stays un-marked and rides the next tick (nothing dropped); the
  alert appends "…另有 N 條，下輪補送".
- **Calibration**: ~12% of 24h headlines match (~7/day) against real
  feeds; bare `SEC` / `exploit` over-match (regulatory opinion, scam
  warnings). Keyword lists are config-tunable.
- **Headline translation (zh-Hant)**: when an alert fires, the delivered
  (capped) headlines are translated to Traditional Chinese via the active AI
  provider and rendered as a `↳ 中譯：` sub-line under the original — the source
  headline stays authoritative. Invoked **only on fire**, on the delivered
  titles, never per idle tick; any failure degrades to original-only and never
  blocks the alert. The translator is an injected dependency (`createNewsAlert`
  `translateTitles`) wired at the composition root, so this module stays pure
  and testable.

**Deferred — AI-digest fallback.** Batch the *non*-keyword-matching
remainder through a cheap model to catch a "big thing that matched no
keyword", emitting at most one digest line. Keyword hits stay zero-token;
AI is the fallback, not the default. File in Linear.

---

## Common pitfalls

- **Treating readiness as alpha evidence.** `live-readiness-alert` only proves
  the alert stack is operational (TG configured, scheduled states fresh,
  auto-trading disabled). It is not a signal, not a paper-trade verdict, and
  not permission to place orders.
- **Forgetting cold-start / first-observation handling.** Any "diff vs
  last state" rule (position open/close, NLV move) must anchor silently on
  the first observation, or it dumps the entire current state as "new" and
  re-spams on every restart. market-report's NLV-style anchor and
  account-report's `lastReportedNlv === null` check are the pattern.
- **Deduping work you didn't deliver.** If you cap output, dedup only what
  you actually sent; the overflow must remain eligible next tick.
- **Trusting a duration string a parser silently rejects.** The news
  lookback bug shipped green unit tests because the fake source ignored
  its options. When a window/threshold comes from config, assert the
  bound is actually applied (news-alert's regression test passes a fake
  that honours `startTime`).
- **Alarming on good news.** Reserve 🚨 for genuine downside; informational
  events get a neutral header. A 🚨 that fires on a 5% gain trains the user
  to ignore it.
- **`% of NLV` on a dust account.** A percentage threshold on a near-zero
  balance fires on trivial absolute amounts — gate with a minimum.
