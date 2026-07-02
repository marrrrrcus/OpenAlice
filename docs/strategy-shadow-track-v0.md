# Design spec — Strategy Shadow Track v0 (forward paper-evidence infrastructure)

A **research-evidence harness**, not a strategy and not a signal source. It
exists because the honest lesson of `docs/backtests/` (8 studies: 6 REJECT,
1 INCONCLUSIVE, 1 well-powered NO on the follow-up, 1 restrict-only survivor)
is that backtests overfit and forward out-of-sample records do not. From v0
on, the promotion path for ANY candidate entry idea is fixed:

> **pre-registered backtest → N months of forward shadow survival →
> a human-written verdict → only then is `directionSource` eligibility even
> discussable.**

The shadow track is the middle step. It computes each registered strategy's
daily stance on paper, marks it to market with costs, and accumulates a
forward, out-of-sample ledger. It produces **no signal, no proposal, no
order, no `directionSource`** — the same framing as
[backtests/funding-pulse-v1.md](backtests/funding-pulse-v1.md): evidence
about a hypothesis, nothing more.

> **Status:** DESIGN DRAFT — pending Marcus review. No code exists yet and
> none will be written until this spec is red-penned and locked (same
> discipline as [risk-gate-pipeline-v0.md](risk-gate-pipeline-v0.md) and
> [regime-veto-onboarding-v0.md](regime-veto-onboarding-v0.md)).

## Constitution alignment

- `Strategy decides direction` — a shadow strategy decides nothing in the
  live system. Its stance is written to a research ledger that no execution
  path reads. The tool/report layer must render stances as *recorded paper
  positions*, never as recommendations.
- `Alice does not predict price` — the shadow track is how a prediction
  claim earns the right to be *tested*, not a channel for Alice to hold one.
- `Safety flow does not create edge` — symmetrically: **evidence flow does
  not create edge either.** A surviving track is evidence that a rule's edge
  claim held up forward; it is not the edge itself and not an endorsement.
- `ALLOW is not endorsement` / language discipline — every surface renders
  accumulation language ("N known forward days, bar is M"), never confidence
  language ("working", "profitable strategy", "buy").

## Scope: B1 / B2 hard boundary

- **B1 (core scoring track)** — ledger + mark math + runner + config +
  events + ONE seed strategy (`buy-and-hold-v0`). **B1 must be
  independently mergeable and deployable.** B1 acceptance requires
  `buy-and-hold-v0` ledger rows with correct stance/mark/equity chaining.
  Event schema/append behavior is covered by tests, but runtime event
  absence is cosmetic; **the ledger is the only acceptance authority.**
- **B2 (independent follow-up)** — `research_shadow_report` tool (Alice
  side), second seed `regime-trend-v0-shadow` (harness control), strategy
  registration docs. **If B2 is unfinished, B1 commits and deploys without
  it.** The two must not be bundled into one acceptance.

## Architecture

- Runs in the **UTA process**, new sibling domain
  `services/uta/src/domain/research/shadow/`. Boundary rule (stated in every
  module header, enforced by review): **nothing under `domain/trading/`
  imports from `domain/research/`**; research imports from trading are
  limited to the kline types + `fetchBinanceSpotKlines` (one-word `export`
  added in `regime/provider.ts`) and the validated `computeZone`.
- The shadow never places orders, never touches risk gates, TradingGit, or
  any broker. Every tick is wrapped: no failure path may throw into the
  host; one strategy failing must not stop the others.
- Lifecycle mirrors the regime shadow: hourly `setInterval` (unref'd),
  `{stop(), tick()}` handle, started/stopped in `services/uta/src/main.ts`.
  Startup is the reload path — timer-level config changes apply on UTA
  restart (`data/control/restart-uta.flag`).

## The ledger is the authority; events are mirrors

Authoritative record: **`data/research/shadow/{strategyId}.jsonl`** — one
file per strategy, single writer (UTA), append-only, ~1 line per day.

- **Acceptance and all evaluation read the ledger.** A missing/duplicated
  event is cosmetic; **a missing ledger row is a shadow failure.**
- Events (`research.shadow.stance`, `research.shadow.mark`) are emitted
  best-effort AFTER the ledger append, in try/catch — visibility only.
  Rationale: the event log is linear-scan-only and both processes append to
  it with independent in-memory seq counters; nothing correctness-critical
  may depend on it.
- **Reader rule: for a given `dateUtc`, the LAST row wins.** A later good
  day row supersedes an earlier `unknown` row for the same day (append-only
  self-healing). Malformed lines are skipped (same tolerance as the event
  log's recovery).

### Row contract (pinned)

Day row — written when the daily candle for UTC day `D` is complete; carries
BOTH day `D`'s mark (return of the stance held during `D`) and day `D`'s new
stance (held during `D+1`), because both become computable at the same
moment:

```json
{ "kind": "day", "dateUtc": "2026-07-02", "at": "2026-07-03T00:07:11.302Z",
  "backfilled": false,
  "close": "60024", "stance": "long", "meta": null,
  "mark": { "stanceHeld": "long", "prevClose": "60517",
            "grossRet": "-0.0081464...", "legs": 0,
            "costPerLegBps": "10", "netRet": "-0.0081464..." },
  "equity": "0.9918536..." }
```

- All financial values are decimal.js strings. Returns are **decimal
  fractions** (−0.0081 = −0.81%), never percent numbers — the field names
  deliberately avoid `Pct`.
- `mark` is **absent** on anchor rows (the first row of a track, and the
  first row after an unknown gap — see unknown semantics).
- `equity` is the post-`netRet` value (or carried unchanged on anchor rows).
- `costPerLegBps` records the value actually applied that day, so mid-track
  config changes leave a per-row trace.

Unknown row — an operational fail-safe record, never silent. It **stores
`equity`** (the frozen carry-forward value — state, not performance) and
never has a `mark`, so `lastState`/report readers need no cross-row
derivation and an unknown row can never be mistaken for a marked day:

```json
{ "kind": "unknown", "dateUtc": "2026-07-05",
  "at": "2026-07-06T01:00:02.114Z", "reason": "kline fetch failed: ...",
  "equity": "0.9918536..." }
```

## Daily semantics (pinned — matches the backtest cost family)

The daily candle for UTC day `D` closes at 00:00 UTC of `D+1`.

```text
stance_D  = f(completed closes … through day D)     # held during day D+1
grossRet_D = sign(stance_{D-1}) × (close_D / close_{D-1} − 1)
             where sign(long)=+1, sign(short)=−1, sign(flat)=0
legs_D    = | num(stance_{D-1}) − num(stance_{D-2}) |
             where num(long)=1, num(flat)=0, num(short)=−1
             (long→short = 2 legs; the change decided at close of D−1
              executes at the open of day D, so its cost lands in day D)
netRet_D  = grossRet_D − legs_D × (feeBpsPerLeg + slippageBpsPerLeg)/10000
equity_D  = equity_{D-1} × (1 + netRet_D)
```

- Cost constants: **7 bps fee + 3 bps slippage = 10 bps per executed leg** —
  the pinned constants of
  [backtests/regime-trend-v0.md](backtests/regime-trend-v0.md), so shadow
  numbers are comparable with the backtest family.
- Baseline stance before a track's first row is `flat`: buy-and-hold pays
  its entry cost once on its first marked day — the same fairness rule the
  backtests used.
- The first row of a track is an **anchor row**: stance only, no mark,
  `equity: "1"`.
- Only **completed** candles ever enter `f` (in-progress candle discarded,
  same discipline as the regime provider — anything else is lookahead).

## Strategy interface (pinned)

```text
Stance = 'long' | 'short' | 'flat'
StrategyContext = {
  klines: readonly KlineRow[]   # completed candles, oldest→newest
  prevStance?: Stance           # from the ledger chain — see below
}
DailyStrategy = {
  id: string                    # VERSIONED: 'buy-and-hold-v0'
  symbol: string                # e.g. 'BTCUSDT'
  venue: 'binance_spot'
  registrationDoc: string       # 'docs/shadow-strategies/<id>.md'
  dataNeeds: { kinds: readonly ('klines' /* future: 'funding' */)[]
               minDays: number }
  compute(ctx): { stance: Stance; meta?: object }
              | { stance: 'unknown'; reason: string }
}
```

- **Rule change ⇒ new `id` ⇒ new ledger file ⇒ new registration doc.**
  Editing a strategy in place would silently rewrite its history — the
  classic overfit backdoor. `strategies/index.ts` (the static, code-reviewed
  registry) is the enforcement point; this is what "pre-registration
  integrity" means mechanically.
- An unmet `dataNeeds` kind produces an explicit `unknown` row, never a
  crash. A future carry strategy extends `StrategyContext` with a funding
  slot; v0 builds **no** funding plumbing.
- **Hysteresis state source** (for strategies whose rule carries state
  through a band, e.g. SMA200 ±3%):
  - (a) **Chained (normal):** if the immediately preceding calendar day has
    a known day row, `prevStance` = that row's stance. This covers live
    ticks AND backfill (backfill reconstructs oldest→newest, chaining
    day-by-day — bit-identical to what live ticks would have produced).
  - (b) **Cold start / broken chain:** first row ever, or the previous
    calendar day is unknown/missing → `prevStance` is absent, and the
    strategy falls back to a reconstructible rule: *stance = side implied by
    the most recent band exit within the provided window; no band exit in
    the window → `unknown` ("hysteresis state indeterminate")*.
  - A running track therefore never flips to `unknown` merely because a
    finite window happens to contain no band crossing.

## Unknown semantics (pinned — the P0 correction)

`unknown` is an **operational fail-safe, not a performance day.** It is NOT
claimed to be conservative: if the true stance was losing, flattening it
would overstate performance. Therefore:

- An unknown day gets **no mark**; `equity` is frozen (carried unchanged)
  and the frozen value is stored on the unknown row itself (carry-forward
  state, not performance — see the row contract).
- **Resume = re-anchor.** The first good day `R` after an unknown gap writes
  a stance-only anchor row (no mark — the stance held during `R` is not
  attributable to any live decision). Day `R+1`'s mark charges legs **from
  `flat`** (`legs = |num(stance_R) − 0|`): continuity of a position through
  an unobserved span may not be claimed.
- Causes that all produce unknown rows, uniformly: kline fetch failure;
  newest candle absent past `staleGraceHours`; insufficient history;
  strategy-level `unknown` (e.g. indeterminate hysteresis on a broken
  chain); backfill cap exceeded; unmet `dataNeeds`.
- Transient failures self-heal within the day: the unknown row is retried
  every tick and superseded by a good day row (last-row-wins), in which case
  the day counts as known and the chain is intact.

### Evaluation denominators (pinned — no post-hoc ambiguity)

```text
activation day      = dateUtc of the strategy's first ledger row
warmup days         = activation day … the day BEFORE the first mark-bearing row
eligible days       = calendar days from the first mark-bearing row's dateUtc
                      through the newest COMPLETED UTC day, inclusive
                      (NOT "through the newest row" — a dead shadow keeps
                      accumulating eligible days and rots visibly)
unknown days        = eligible days with no known day row
                      (outage, cap-exceeded, strategy-unknown, operator
                      disable, process down — all count; evidence gaps do
                      not get excuses)
known-forward days  = eligible days − unknown days
backfilled days     = known day rows with backfilled: true
                      (reported separately; NOT counted as unknown)
```

**INCONCLUSIVE — either alone suffices:**

```text
unknown days   / eligible days > 10%   → INCONCLUSIVE
backfilled days / eligible days > 20%  → INCONCLUSIVE
```

A strategy's pre-registered bar (its registration doc) is expressed in
**known-forward days** (e.g. "≥ 90 known-forward days"), never calendar
days. Passing the bar triggers a **human-written** verdict comparison — the
track computes numbers; it never declares success.

## Catch-up / backfill (pinned)

Persisted state = the ledger itself (no separate state file to desync).
Hourly tick, per strategy:

1. Expected day = UTC-yesterday (from injected `now()`). If the ledger tail
   already covers it → **no-op without fetching** (restart-durable dedup).
2. One kline fetch per symbol per tick, shared across strategies on that
   symbol; `limit` sized to `dataNeeds.minDays` + gap + slack (≤ 1000).
3. Pending days `(lastLedgerDay, newestCompletedDay]` are processed oldest →
   newest, chaining `prevStance` row-by-row — a backfilled day is computed
   bit-identically to a live one.
4. Any pending day older than **`maxBackfillDays` (default 14)** is written
   as `unknown` ("outage exceeded backfill cap"). Reconstructing further
   back would be a backtest wearing a forward badge — refused.
5. Every row not for the expected day, processed on this tick, carries
   `backfilled: true`. Backfill share is surfaced in the report — a heavily
   backfilled track is visibly weaker evidence.
6. If the expected day's candle is absent and `now` is more than
   `staleGraceHours` (default 6) past its close time → unknown row (retried
   each tick, superseded on arrival).

## Events (pinned — naming + semantic lock)

Two internal event types, registered per the 5-step recipe in
[event-system.md](event-system.md):

- `research.shadow.stance` — `{ strategy, symbol, dateUtc, stance:
  'long'|'short'|'flat'|'unknown', close?, backfilled?, reason?,
  shadowOnly: true }`
- `research.shadow.mark` — `{ strategy, symbol, dateUtc, stanceHeld,
  grossRet, legs, costPerLegBps, netRet, equity, backfilled?,
  shadowOnly: true }`

- The words **"signal"** / **"strategy.signal"** are deliberately absent
  from event names and payload fields — a name is the first misuse vector
  (UI, TG, or a human reading the Flow tab must not be able to mistake a
  shadow stance for a tradable signal). Descriptions may mention "signal"
  **only in the negated phrase** below.
- `shadowOnly: true` is a **TypeBox literal**, enforced at the schema level,
  not a comment. Event descriptions state verbatim: *"research evidence
  only — never a signal, never a proposal."*
- Emitted by UTA via direct `eventLog.append` (the `trading.regime.zone`
  precedent).

## Config (pinned)

`data/config/research-shadow.json`, using the risk-gates loader pattern
wholesale (Zod schema, mtime-cached loader that never throws, seed-if-absent
at UTA startup; invalid file → the shadow idles loudly — for research the
safe failure is *stop scoring*, never *guess*):

```json
{
  "enabled": true,
  "costModel": { "feeBpsPerLeg": 7, "slippageBpsPerLeg": 3 },
  "maxBackfillDays": 14,
  "staleGraceHours": 6,
  "strategies": {
    "buy-and-hold-v0": { "enabled": true }
  }
}
```

- Cost model is read per tick (mtime cache) and the applied value is
  recorded on every mark row.
- Disabling a strategy stops its rows; those days count as **unknown** in
  its denominators (operator suspension is an evidence gap like any other).
  Re-enabling re-anchors (unknown-gap resume semantics).

## Report surface (B2, semantics pinned now)

`research_shadow_report` — an Alice-side ToolCenter tool
(`src/tool/research.ts`) reading the ledger files directly (shared data
root; `src/` cannot import `services/uta` types, so the tool re-validates
rows with its own Zod schema at the read boundary). Per strategy it reports:

- known / unknown / backfilled day counts **separately**, eligible-day
  denominator, and the two INCONCLUSIVE ratios vs their 10% / 20% bounds;
- current stance, equity multiple, cumulative net return, max drawdown,
  total cost paid (bps), daily Sharpe **computed over known days only**;
- the registration doc path + its pre-registered known-forward-day bar, and
  the distance to it ("42 of ≥90 known-forward days").

Language discipline: the report renders **evidence accumulation**, never
signals or endorsements. A track past its bar renders "bar reached — human
verdict pending", never "validated" (validation is a written document, not
a computed threshold).

## Deployment & acceptance (pinned — the runtime-gap lesson)

Development happens on the **OneDrive main tree, `dev` branch**. The
running Alice is the **`C:\Users\Marcus\Desktop\Open Alice`** clone. After
the B1 commit:

1. Pull into the runtime clone; Marcus restarts Alice/UTA (his action).
2. **The shadow clock starts at this restart** — "in the repo" is not
   "running"; no forward day may be claimed before deployment.
3. Acceptance is **ledger-primary**: `data/research/shadow/
   buy-and-hold-v0.jsonl` shows the anchor row and, from the next UTC day,
   correctly chained day rows → the track is live. Secondary signals:
   startup log line, seeded `research-shadow.json`, mirror events. A missing
   event is cosmetic; a missing ledger row is a failure.

## Seed strategies

- **`buy-and-hold-v0`** (B1) — always `long` BTCUSDT once `minDays: 2` is
  met. Role: baseline + full-pipeline verification. Not promotable by
  definition (it has no entry claim to validate).
- **`regime-trend-v0-shadow`** (B2) — the REJECTED
  [backtests/regime-trend-v0.md](backtests/regime-trend-v0.md) rule (long
  above SMA200 +3%, flat below −3%, hysteresis in the band), run forward as
  an **out-of-sample harness control**: if the shadow's realized behavior
  contradicts the backtest's character, suspect the harness first. Its
  registration doc pins the rule verbatim, the cold-start window rule, and
  exit criteria (≥ 90 known-forward days, unknown ≤ 10%, backfilled ≤ 20%
  → human-written comparison, no automatic verdict).

## Non-goals (v0)

- No orders; no contact with risk gates, TradingGit, brokers, or any
  execution path.
- No funding-rate plumbing (interface slot only); no intraday timeframes;
  no multi-symbol/cross-sectional strategies; no short-side seed strategy.
- No HTTP route, no UI page (the tool is the only surface).
- **No automatic promotion.** A track that passes its bar produces
  eligibility for a *human-written* verdict document — nothing else. The
  constitution's `directionSource` gate is untouched by this entire spec.

## Related

- [alice-trading-constitution.md](alice-trading-constitution.md) — the
  axioms this harness serves; a shadow track is evidence, never direction.
- [trade-proposal-principles.md](trade-proposal-principles.md) — where a
  surviving, human-validated rule would eventually plug in
  (`backtested_rule:<id>` + forward record), far outside v0's scope.
- [risk-gate-pipeline-v0.md](risk-gate-pipeline-v0.md) /
  [regime-veto-onboarding-v0.md](regime-veto-onboarding-v0.md) — the
  spec-first, red-pen-then-implement discipline this doc follows.
- [backtests/regime-trend-v0.md](backtests/regime-trend-v0.md) — cost
  constants source + the B2 control strategy.
- [backtests/funding-pulse-v1.md](backtests/funding-pulse-v1.md) — the
  "evidence about a hypothesis, nothing more" framing.

## Review record

- 2026-07-02 — draft written (per plan v6, sequencing step 1).
- 2026-07-02 — Marcus red-pen round 1: no blockers; 3 fixes applied —
  **[P1]** B1 acceptance no longer lists mirror events as a requirement
  (ledger is the only acceptance authority; event behavior is test-covered,
  runtime absence cosmetic); **[P2]** "signal" ban narrowed to event names +
  payload fields, descriptions may use it only in the negated phrase;
  **[P2]** unknown rows store frozen carry-forward `equity` (state, not
  performance) and never a `mark`. Spec ready to lock.
