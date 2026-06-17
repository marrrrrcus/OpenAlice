# Position-Aware Watchlist — 依持倉調整關注, 但不自動擴大範圍

Design notes for a future capability: letting the monitors pay attention to
the coins you actually hold, **without** silently turning every position
into a fully-monitored symbol. Written as a design record so the reasoning
isn't lost when the feature is eventually built.

> **Status (read first).** This is **not built**. Today the monitors use
> **fixed watchlists** (`market-report` and `microstructure-alert` watch
> BTC/ETH; `news-alert` matches a fixed keyword set). Only **account-report**
> is position-driven — it reads the live broker positions, which is why a
> new holding (e.g. `SPCX/USDT:USDT`) surfaces there as a 新倉 alert while
> the other monitors stay silent on it. This document is the design for
> closing that gap *deliberately*, not automatically.

## Core principle

> **Positions are auto-discovered into a candidate list; they are not
> auto-added to every watchlist.**

> 中文：**持倉幣自動進候選清單，但不自動進所有 watchlist。**

Expanding what Alice *monitors* is a scope/resource decision, so it goes
through a gate — the same human-in-the-loop philosophy as
[trade-proposal-principles.md](trade-proposal-principles.md), at a lower
risk class (monitoring scope is reversible and risks no money; trade
execution is neither).

## Discovery is deterministic and zero-AI

The "you hold X → X is a candidate" step is a pure read of current broker
positions. **No model call, no inference.** It is consistent with the
monitors' deterministic, zero-AI design — Alice doesn't *guess* what to
watch; it observes what you hold and *offers*.

## Per-monitor policy — the auto-expand rule differs by monitor

The whole point: a single "auto-add held coins" rule is wrong, because the
cost/benefit is wildly different per monitor.

| Monitor | Auto-track held positions? | Why |
|---|---|---|
| **account-report** | ✅ already does (all positions) | Position-level risk (drawdown, liquidation, NLV move) should cover everything you hold, including obscure coins. |
| **news-alert** | ✅ best fit — low threshold | Adding a held coin's name to keywords is **cheap** (RSS keyword match, no extra API, no rate limit, no order-book noise) and the **highest-value gap**: missing a hack/delisting/catalyst headline about a coin you *hold* is the most dangerous blind spot. |
| **market-report** (RSI/price) | ⚪ optional / case-by-case | One extra price+RSI fetch is cheap, but RSI on an illiquid small-cap is close to meaningless. Sensible for liquid majors, marginal for obscure tokens. |
| **microstructure-alert** | ❌ not full-auto | Highest cost: each symbol adds order-book/funding polling (rate limit), and **small-cap books are noisy, spoof-heavy, and produce junk alerts**. Order-book imbalance is already the weakest, most-gameable signal (see trade-proposal-principles.md). Only liquid symbols, and only with explicit opt-in. |

**The asymmetric insight:** if you auto-expand exactly one monitor, make it
**news** — cheapest, and it closes the gap that actually hurts ("I hold it
but hear no news about it"). Do **not** make it microstructure.

## Gate strength is matched to risk × irreversibility

Not every expansion needs the same confirmation. A blanket "always ask"
creates notification fatigue; tier the gate to the action's real cost.

| Action | Risk / reversibility | Gate strength |
|---|---|---|
| Add a news keyword | zero money risk, fully reversible | **lightest** — may auto-add + notify ("added SPCX to news while held; auto-removed on close; reply to undo"), opt-out rather than opt-in |
| Add to market-report | low | **medium** — suggest, confirm |
| Add a microstructure symbol | resource cost (rate limit / noise) | **opt-in** — explicit confirmation, plus a liquidity pre-filter so thin coins aren't even offered |
| Build a trade proposal | direction + money | must carry `directionSource` (see trade-proposal-principles.md) |
| Execute a trade | money, irreversible | **heaviest** — hash-bound approval (`pendingHash`) |

This does **not** contradict the trade-proposal constitution. That doc's
hard gate exists for *money risk* (direction / execution). Adding a news
keyword is a different risk class — reversible, no capital at stake — so a
lighter gate is correct. The rule is: **gate strength = the action's risk ×
its irreversibility.**

## Liquidity pre-filter

Don't dump every position into the confirmation queue. For
microstructure (and arguably market-report), only *offer* a symbol whose
volume/liquidity clears a threshold — so an illiquid token never gets
suggested for order-book tracking, while a held SOL/AVAX would. This makes
the suggestions smart and cuts the number of prompts the user has to act
on. The final add is still gated; the pre-filter just removes the obviously
bad candidates first.

## Lifecycle — every "add" must have a "remove"

The failure mode to design against from day one: a watchlist that only ever
**grows**. If opening SPCX adds a news keyword and closing it never removes
one, the watchlist slowly fills with keywords/symbols for coins you no
longer hold — noise rises, alert quality drops. (This repo has prior art on
exactly this class of bug: orphaned `__snapshot__` / `__heartbeat__` cron
jobs firing for weeks — see the Migrations note in CLAUDE.md.)

```
open position        → produce candidate / suggest add
holding              → keep tracking
close position       → suggest removal / auto-mark inactive
long time unheld     → clean up or demote
```

Manually-pinned entries (e.g. you always want BTC news) are never
auto-removed — which is why provenance matters.

## Provenance schema

Every watchlist entry should record *why* it's there, so position-derived
entries can be cleaned up while manual ones are preserved:

```jsonc
{
  "source": "held_position",          // vs "manual"
  "symbol": "SPCX/USDT:USDT",
  "monitorTypes": ["news"],           // which watchlists this entry feeds
  "addedAt": "2026-06-17T10:20:00+08:00",
  "lastHeldAt": "2026-06-17T14:05:00+08:00"
}
```

Without `source`, you can't tell "I pinned this" from "this was added only
because a position existed" — and the lifecycle cleanup becomes impossible
to do safely.

## Anti-goals

- Do **not** auto-add positions to **microstructure** — thin-book noise,
  spoofing, and rate-limit cost outweigh the value.
- Do **not** let the watchlist grow monotonically — every add needs a
  removal path.
- Do **not** make discovery AI-driven — it's a deterministic read of
  current positions.
- Do **not** assume every holding deserves full monitoring. **For an
  obscure, thin token, account-risk coverage alone may be the *correct*
  amount of monitoring, not a gap to fill** — microstructure would be pure
  noise and the RSS feeds may carry no news on it anyway.

## Summary

```
position discovered  → candidate (deterministic, zero-AI)
  → per-monitor policy (account: auto · news: low gate · market: optional · micro: opt-in)
  → gate strength matched to risk (news light · micro opt-in · trade hard)
  → add with provenance (source / monitorTypes / addedAt / lastHeldAt)
  → close → remove / mark inactive → cleanup
```

Alice discovers and suggests; expanding the monitoring scope still passes a
gate — matched to how much that particular expansion actually costs.

## Related

- [trade-proposal-principles.md](trade-proposal-principles.md) — the human-gate philosophy this extends
- [monitoring.md](monitoring.md) — the monitors whose watchlists this would feed
- [microstructure-alerts.md](microstructure-alerts.md) — why small-cap order-book signals are noisy
