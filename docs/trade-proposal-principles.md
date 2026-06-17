# Trade Proposal Principles — Alice審核交易, 不預測價格

This is the **design constitution** for any future "trade proposal" layer
in OpenAlice — the path where the system proposes an order, surfaces it for
approval, and executes only after a human approves. It is written **before**
that layer is built, on purpose: it exists to stop the proposal layer from
slowly drifting into a price-prediction / auto-signal machine as engineering
accretes.

> **Status (read first).** The proposal layer described here is **not yet
> built**. Today the autonomous paths are deliberately inert: the
> auto-trading scheduler is **notify-only**, and the AI `placeOrder` /
> `tradingPush` tools are **stage-only / hollowed out** — nothing
> auto-executes. The one piece that *is* built is the final safety gate:
> hash-bound push/reject approval (`pendingHash`, see
> [the guard below](#final-safety-gates-already-built)). This document is
> the blueprint the proposal layer must conform to when it is built.

## The core invariant

> **Strategy decides direction.**
> **Risk gates decide permission.**
> **Microstructure decides execution.**
> **Alice explains, constrains, and requires approval.**

> 中文：**策略決定方向；風控決定能不能做；微結構決定怎麼做；Alice 負責解釋、約束、送審。**

Everything below is a consequence of these four lines. If a future change
violates one of them, the change is wrong — not the principle.

## Why: monitors are risk/execution signals, not directional signals

OpenAlice's monitors (order book spread/depth/imbalance, funding, RSI,
news, account state — see [monitoring.md](monitoring.md) and
[microstructure-alerts.md](microstructure-alerts.md)) are **public,
widely-watched data**. They are good at answering *"is it safe / cheap /
bearable to execute this trade right now?"* They are **not** reliable
answers to *"should I be long or short?"*

The distinction is structural, not stylistic:

| | **Gate / Signal (what monitors are)** | **Direction (what they are not)** |
|---|---|---|
| Output | `ALLOW` / `SIZE-DOWN` / `BLOCK` | `LONG` / `SHORT` |
| Judges | "normal vs this symbol's own baseline" | "where price goes next" |
| Overfit risk | near-zero (few/no fitted params) | high (fitted thresholds + a direction claim) |
| Allowed source | account state, microstructure, news, RSI | **strategy only** (see `directionSource`) |

A book that is bid-heavy does **not** mean "go long" — it could be
spoofing. Funding at a positive extreme does **not** mean "go short" — it
means longs are crowded and expensive to hold. These belong on a
**pre-trade checklist**, never as a standalone entry trigger.

## The three structural guarantees

These turn "Alice must not invent direction" from a *discipline you have to
remember* into a *shape the system cannot express* — the same technique as
the fail-closed `pendingHash` guard and the gate's `ALLOW`/`BLOCK`-only
output.

### 1. `directionSource` is a required, typed field — with no "Alice-inferred" value

Every proposal MUST carry a `directionSource`. Its allowed values are
exactly:

- `user` — the human explicitly asked for this direction
- `external_strategy` — an external/independent strategy produced it
- `backtested_rule:<id>` — a validated, backtested rule produced it

There is **deliberately no `alice_inferred` value.** Because the enum
cannot express "Alice decided the direction because several gates were
green," that failure mode is **unrepresentable**, not merely forbidden. A
green checklist is *permission to execute a direction that already exists* —
never the *reason* a direction exists.

### 2. No `directionSource` → no proposal

If no strategy supplies a direction, the proposal layer produces
**nothing**. Silence is the safe default. The system must never fill the
vacuum by picking a side itself.

### 3. The execution layer is reduce-only

Microstructure / funding / account-state signals decide *how big* and *how*
to execute. They may **only**:

- shrink the strategy's requested size,
- force `limit`-only / forbid market orders,
- forbid adds,
- `BLOCK` the trade entirely.

They may **never**:

- enlarge a position beyond what the strategy requested,
- turn a "no" into a "yes,"
- originate a direction.

"Order book looks great → size up" is exactly how an execution signal
sneaks back in as a conviction/direction signal. Reduce-only forbids it.

## Hard veto / soft size-down / allow — tier the gates

Do **not** make every condition a binary AND-veto; that over-filters and
silently cuts winning trades along with the bad ones (a checklist with many
required conditions must itself be validated — see "what to verify"). Tier
them:

| Condition | Tier |
|---|---|
| Account near liquidation | **hard veto** |
| Account drawdown too large | **hard veto** or heavy size-down |
| Spread wider than baseline | **soft** — size-down / limit-only |
| Near-touch depth thin | **soft** — size-down |
| Funding extreme / flip | **soft** — forbid adds / size-down |
| Order-book imbalance | **advisory only** — never a veto (spoofable) |

Weight by durability: account-risk and execution-quality (spread/depth) are
the most reliable; funding-crowding is moderate; RSI and order-book
imbalance are the weakest and most gameable. A flimsy imbalance read must
not carry the same veto power as "near liquidation."

## The proposal pipeline

```
Strategy (direction + directionSource)        ← the ONLY place direction is allowed
  → Risk veto-chain: account → microstructure → background (news/market)
        each can ALLOW / SIZE-DOWN / BLOCK; none can force or originate
  → Proposal (must carry directionSource + the gate verdicts + final size/exec)
  → Human approval — TG button / Web UI, hash-bound (pendingHash)
  → Re-run the execution gates at execution time (defend against staleness)
  → push
```

The veto-chain is an **AND of vetoes**: any gate can block, no gate can
force. Order only affects short-circuit efficiency + log readability
(cheapest / most-likely-to-block first), not correctness.

### Example proposal shape

```
方向來源 (directionSource): user — 使用者指定做多 BTC
Alice 審核 (gate verdicts):
  · account     : ALLOW (回撤正常, 未接近強平)
  · funding     : SIZE-DOWN (多單擁擠, 第 95 百分位)
  · order book  : ALLOW (spread 正常, depth 足)
  · news        : ALLOW (無重大反向催化劑)
建議 (verdict): 允許, 但倉位砍半, limit-only, 不追市價, 不加碼
```

Alice **explains** (why allowed / sized-down / blocked), **constrains**
(reduce-only execution), and **requires approval** — it does not decide the
direction.

## Final safety gates (already built)

Two of the gates at the bottom of the pipeline already exist and any
proposal layer must route through them:

1. **Hash-bound approval (`pendingHash`).** Approving or rejecting a pending
   order (Telegram button / Web UI panel) must echo back the `pendingHash`
   the approver was shown; the UTA backend returns `409` **without
   executing** if it is missing or no longer matches the current pending
   commit. Fail-closed: the worst case is blocking a legitimate approval
   (refresh + re-approve), never executing a commit the user didn't see.
   See `services/uta/src/http/routes-trading.ts` and the README
   "Trading-as-Git" entry.

2. **Re-run risk gates at execution time.** `pendingHash` defends against
   the *commit* changing between display and approval; this defends against
   the *world* changing. A proposal generated when spread was normal must
   re-check the execution gates at push time — spread/account can blow out
   in the minutes before a human taps Approve. (Not yet built; required
   when the proposal layer is.)

## What this prevents (anti-goals)

- Alice must **never** become a price-prediction / auto-signal system.
- A green checklist is **never** an entry reason on its own.
- The system must **never** originate a direction to fill a vacuum.
- Execution signals must **never** leak back in as conviction (no
  enlarging, no creating trades).

If, during implementation, Alice starts "looking like it calls the market,"
the logic has quietly inverted from a risk-审核 system into a prediction
system — stop and re-read the core invariant.

## What to verify before trusting any of this with capital

This document is a *design* constitution, not evidence that the gates make
money. Before a gate or the checklist is trusted:

- **Base rate / control.** Compare post-event windows to random windows. A
  filter that fires before whipsaw means nothing if whipsaw happens just as
  often without it.
- **Sample size.** Dozens of events across weeks, not a handful in one day.
- **Right metric.** A de-risk gate is "useful" only if it cuts drawdown
  *more* than it cuts return (improves risk-adjusted return / Calmar /
  Sharpe). Scaling everything down proportionally is not an edge.
- **Don't over-filter.** Requiring more conditions removes trades — confirm
  the extra condition improves risk-adjusted return rather than just
  shrinking trade count.

## Related

- [monitoring.md](monitoring.md) — the deterministic monitors that feed the gates
- [microstructure-alerts.md](microstructure-alerts.md) — order book / funding gate design
- README "Trading-as-Git" — stage → commit → hash-bound approval → push
