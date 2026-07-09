# Alice Microstructure Alert System

This document captures the microstructure monitor built after live
`getOrderBook` and `getFundingRate` were exposed to Alice.

## Status

Implemented today:

- Alice can resolve exchange contracts through `searchContracts`.
- Alice can read live order book depth through `getOrderBook`.
- Alice can read current funding-rate data through `getFundingRate`.
- These calls are read-only and use public exchange market-data endpoints
  through the connected CCXT accounts.
- `src/task/microstructure-alert/` implements scheduled, deterministic
  order book + funding risk alerts.
- The task ships **off by default** (`data/config/microstructure-alert.json`
  has `enabled:false`) so baselines and noise can be reviewed before use.

Not implemented yet:

- Open-interest ingestion.
- `wall_detected` / `wall_removed`.
- Crowded long / crowded short.
- Liquidity vacuum.
- Whale / on-chain adapters.
- Market regime classification.

## v1 Build Decisions (locked)

These are the load-bearing decisions for the first build. They affect the
state-file shape, the rule evaluator, config, and tests — so they are
fixed before coding, not discovered during it.

1. **Copy-first, do not abstract early.** Clone the existing monitor
   pattern (`src/task/account-report/`, `src/task/news-alert/`) into a new
   `src/task/microstructure-alert/`. Do **not** factor out a shared
   "alert lifecycle" framework yet. Order book's frequency, data volume,
   and noise profile differ enough from account/news that a premature
   abstraction would fit the wrong shape. Run v1 standalone, let it prove
   out, *then* extract anything shared (rule of three).

2. **v1 is intentionally narrow — exactly five alerts:**
   - `spread_widening`
   - `depth_thinning`
   - `orderbook_imbalance`
   - `funding_extreme`
   - `funding_change`

3. **Explicitly deferred from v1** (do not build until v1 is calibrated):
   `wall_detected` / `wall_removed` (high false-positive — spoofing and
   fast-cancel make walls noisy), open interest, crowded long/short,
   liquidity vacuum, regime classification, whale / on-chain.

4. **Per-symbol adaptive baselines, not fixed thresholds.** Every relative
   metric (widening / thinning / extreme / change) is measured against
   *that symbol's own normal*, stored in state — never a single global
   threshold. A fixed spread threshold would fire constantly on illiquid
   alts and never on BTC. (See **Baselines** and **State** below.)

5. **Tiered polling — different cadences per data type.** Order book is
   high-frequency and jittery; funding moves on an 8h cycle. Do not poll
   everything at 1m. (See **Polling cadence** below.)

6. **Build sequence:** lock this doc → build v1 (five alerts only) →
   run for a while and watch Telegram noise → only then design crowded /
   liquidity-vacuum on top of calibrated baselines.

## Product Principle

Alice does not predict where price will go.
Alice identifies where risk is asymmetric.

Every alert must explain risk rather than call direction.

## Alert Format

Alerts are built in **Traditional Chinese**. Each signal uses a three-part
shape — 數據 (data) / 研判 (interpretation) / 人工檢查 (human review item) — and
the whole alert closes with a single execution-environment footer. The wording
must not become an order instruction.

```text
🟠 BTC/USDT:USDT 微結構警報 — 高

· 買賣價差變大
數據：買賣價差拉開到平常的 7.0 倍（目前 0.0009%）。
研判：市場現在比較稀薄，用市價單成交容易吃到比較差的價格（滑價）。
人工檢查：把目前標記為高摩擦執行環境，重新核對名目、槓桿與可接受滑價。

· 掛單一邊倒
數據：盤口附近，買方掛單比另一邊多 6.4 倍。
研判：買單明顯比較多；價格往上衝阻力小，但要往下時下面接的單很少。
人工檢查：掛單少的一側代表被掃風險較高；這是風險標記，不是方向訊號。

─────────────
🟡 執行環境：流動性偏弱；人工 review 時需保守處理成本假設
· 掛單一邊倒 → 薄的一側被掃風險較高
（方向請看你的策略，盤口不喊多空；這不是交易指令）
```

**Execution environment footer.** The 🟢/🟡/🔴 line answers *"how frictional is
the execution environment right now"*, never direction and never a command.
It is driven by the execution-cost signals only — `spread_widening` +
`depth_thinning`: critical → 🔴「成本/深度風險過高；人工 review 時標記為
high-friction」; medium/high → 🟡「流動性偏弱；人工 review 時需保守處理成本假設」;
none → 🟢「價差與深度正常；僅代表成本環境未異常」. `funding_extreme` /
`orderbook_imbalance` / `funding_change` ride as advisory notes and **never set
the footer level**. The footer always closes with
「方向請看你的策略，盤口不喊多空；這不是交易指令」.

This keeps Alice in a risk-management role and prevents "price prediction" or
trade-call framing — consistent with
[trade-proposal-principles.md](trade-proposal-principles.md) (the order book
never calls long/short). See `buildMicroAlertMessage` / `executionVerdict` in
[rules.ts](../src/task/microstructure-alert/rules.ts).

## v1 Architecture

Build `microstructure-alert` by **copying the existing monitor pattern**
(a `core/pump.ts` Pump + a per-symbol JSON state file + deterministic rule
functions + `ConnectorCenter.notify` with `NotificationPriority`), the same
shape `account-report` and `news-alert` already run in production. Do not
build a new shared framework first (see Decision 1).

The internal flow, in order:

```text
1. Watchlist          (config: symbols + per-type cadence)
2. Metric snapshot    (getOrderBook / getFundingRate per symbol)
3. Baseline update    (roll the per-symbol references forward)
4. State store        (load/save per-(symbol,alert_type) state)
5. Rule evaluation    (current metric vs that symbol's baseline)
6. Alert lifecycle    (enter active / escalate / resolve)
7. Notification routing (dedup + cooldown + severity -> notify or not)
8. Message template   (Data / Interpretation / Action)
```

### Watchlist

Do not scan the whole market in v1. Start with a small list:

```json
{
  "source": "ccxt-custom-7e373296",
  "symbols": ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT"],
  "orderbookEvery": "2m",
  "fundingEvery": "30m"
}
```

**Symbol resolution:** each `symbols` entry is the **CCXT unified native
symbol** (e.g. `BTC/USDT:USDT`), used directly as the `accountId|symbol`
aliceId. We do **not** go through `searchContracts` — its aggregated index
does not reliably return per-account CCXT perps (OKX returned 0 hits in
testing), whereas a directly-constructed aliceId resolves through the
broker's native-key decoder and works on both OKX and Binance. So write
the full unified symbol, not `BTCUSDT`. `source` must be a CCXT crypto UTA
id (the only brokers that implement getOrderBook / getFundingRate).

### Polling cadence (tiered)

Different data types move at different speeds — a single interval is wrong.

```text
order book (spread / depth / imbalance): 1m–2m   (high-frequency, jittery)
funding (extreme / change):              15m–30m (funding is an 8h cycle)
risk summary (later milestone):          15m–30m
```

This is two Pumps (or one Pump that only fetches the order book every tick
and funding every N ticks). Polling order book every minute × watchlist
size also has a rate-limit budget — keep the watchlist small in v1.

### Baselines (per-symbol, adaptive — not fixed thresholds)

This is the heart of low-noise. Every relative metric is compared against
**that symbol's own rolling reference**, held in state. A global threshold
would either spam illiquid alts or stay silent on BTC.

```text
spread:         rolling median or EWMA of the spread
depth (bucket): rolling median of depth per price bucket
funding:        recent distribution -> percentile of current funding
funding_change: delta vs previous confirmed funding
```

Severity is then expressed *relative to the baseline*, e.g.:

```text
spread_widening:  medium ≥2x / high ≥3x / critical ≥5x    (vs rolling baseline)
depth_thinning:   medium ≤70% / high ≤50% / critical ≤30% (vs rolling baseline)
funding_extreme:  tail = (pct-50)*2 if funding>0 else (50-pct)*2;
                  medium ≥60 / high ≥80 / critical ≥94, AND |funding| ≥ minAbs
funding_change:   medium ≥ |delta| 0.00001 / high ≥ 0.00003  (raw funding units)
```

Use a fixed threshold only as a cold-start bootstrap before enough history
has accumulated to form a baseline.

**Funding is direction-consistent + floored** (de-noise pass — see
`evalFundingExtreme` / `evalFundingChange`). A *positive* funding only counts
as it climbs the HIGH tail (crowded longs → positive p80/p90/p97); a *negative*
funding only on the LOW tail (crowded shorts → p20/p10/p3). A positive funding
sitting at a low percentile is "relatively cheap", not crowded, so it stays
silent — the old `|pct-50|*2` mislabelled it. An absolute floor `minAbs`
(default `0.00001` raw) drops near-zero values regardless of percentile.
`funding_change` is **magnitude-gated only**: a sign flip near zero no longer
earns a free alert (the flip is just a label on moves that already cleared the
bar).

## State, Dedup, And Cooldown

Microstructure data is noisy. A rule that fires every tick is not an alert;
it is noise. The state file (`data/microstructure-alert-state.json`) holds
two layers per symbol.

The state file is not auto-reset on corruption. If it contains unreadable JSON
or malformed top-level fields, the monitor emits no Telegram notification and
does not overwrite the file. Fix the file or intentionally remove it before
restarting first-run baseline behavior.

**Layer A — per-symbol baselines** (the adaptive references, rolled forward
each tick; this is what makes thresholds symbol-relative):

```json
{
  "BTCUSDT": {
    "spread_baseline": 0.00012,
    "depth_bucket_baseline": { "0.1%": 1200000, "0.25%": 3100000, "0.5%": 6400000 },
    "funding_history": [0.0001, 0.00012, 0.00009],
    "funding_percentile_ref": { "p80": 0.00015, "p90": 0.00021, "p97": 0.00033 },
    "last_funding": 0.00012
  }
}
```

**Layer B — per-`(symbol, alert_type)` alert lifecycle** (dedup + cooldown):

```json
{
  "symbol": "BTCUSDT",
  "alert_type": "spread_widening",
  "state": "active",
  "first_triggered_at": "2026-06-13T10:12:00+08:00",
  "last_triggered_at": "2026-06-13T10:18:00+08:00",
  "last_notified_at": "2026-06-13T10:12:00+08:00",
  "cooldown_until": "2026-06-13T10:27:00+08:00",
  "severity": "high",
  "fingerprint": "BTCUSDT:spread_widening:high"
}
```

Recommended notification logic:

```text
first entry into active  -> notify
severity escalation      -> notify, bypass cooldown
active but unchanged     -> do not notify
inside cooldown          -> do not notify
resolved                 -> optional notify
```

Implementation note: `cooldown` does not need to be a separate alert state.
It can be a notification gate (`cooldown_until`) while the underlying alert
remains `active`.

## Severity

Start with four levels:

```text
info
medium
high
critical
```

Avoid a 0-100 score in v1. It suggests precision that the system does not
yet have and makes debugging thresholds harder.

Telegram routing:

```text
info      -> log/dashboard only
medium    -> normal alert
high      -> immediate alert
critical  -> immediate alert, louder formatting
```

## Roadmap

Milestones 1 + 2 together = **v1**. Per Decision 1 (copy-first), Milestone 1
is not "build a framework" — it is "clone the account-report / news-alert
pattern and wire it for order book + funding."

### Milestone 1: Alert plumbing (copied from existing monitors)

- symbol watchlist + tiered polling (order book vs funding)
- metric snapshot (`getOrderBook` / `getFundingRate`)
- per-symbol baseline store (Layer A) + per-alert lifecycle store (Layer B)
- rule evaluation (metric vs baseline)
- dedup + cooldown + severity
- Telegram force-push priority
- three-part Data / Interpretation / Action message template

### Milestone 2: The five v1 alerts (locked)

- `spread_widening`
- `orderbook_imbalance`
- `depth_thinning`
- `funding_extreme`
- `funding_change`

Every alert must provide Data / Interpretation / Action.

**Deferred (NOT in v1):** `wall_detected` / `wall_removed`. Resting walls
are a high false-positive signal — spoofing and fast-cancel mean a "wall"
often vanishes seconds after it appears. Revisit only after the five core
alerts are calibrated and the dedup/cooldown machinery is proven.

### Milestone 3: Crowded Trade Detector

Before open interest is available, use:

- price change
- funding level / funding change
- order book depth
- spread

Initial contexts:

- crowded long risk
- crowded short risk

**Wording boundary (load-bearing).** Crowded-trade is the highest-value and
highest-risk module because it is inferential — it must never drift into a
price call. Forbidden framing: "likely to drop", "可能要跌". Required
framing: positioning is one-sided, so the move *against* that side is
asymmetric.

```text
WRONG:  Crowded long — price likely to reverse down.
RIGHT:  Long-side positioning appears crowded; downside squeeze / long-wick
        risk is elevated. Avoid adding leverage on the crowded side here.
```

### Milestone 4: Liquidity Vacuum Detector

Track bucketed depth around the mark/mid price:

```text
0.1%
0.25%
0.5%
1.0%
2.0%
```

Compare current depth to a rolling median and surface:

- thin downside liquidity
- thin upside liquidity

### Milestone 5: Open Interest Integration

After exchange support is confirmed, add:

- open interest snapshot
- open interest change
- price + OI interpretation

Then upgrade crowded long/short detection.

### Milestone 6: Risk Summary

Do not jump straight to a full "Risk Radar" or regime classifier. Start with
a summary layer:

```text
BTCUSDT current risk summary:
- Spread risk: High
- Downside liquidity: Thin
- Funding risk: Elevated
- Crowded long risk: High
```

Regime classification and whale/on-chain adapters can come after the
single-metric and combined-risk alerts are stable.

## News Source Decision

TradingView news is not part of this alert system today. TradingView does
not provide a stable public news API for this use case, and third-party
TradingView scrapers add cost and reliability/licensing risk.

For now, news alerts remain RSS-based through `data/config/news.json`
(CoinDesk, CoinTelegraph, The Block, CNBC Finance) plus the deterministic
`news-alert` keyword layer.

## One-Line Goal

Build a low-noise, explainable alert pipeline for order book and funding
risks, with stateful deduplication, cooldown, severity, and action-oriented
Telegram messages.
