/**
 * microstructure-alert — pure rule core (no I/O, fully testable).
 *
 * Computes order-book / funding metrics, maintains per-symbol *adaptive
 * baselines* (so "widening / thinning / extreme" are measured against each
 * symbol's own normal, never a global threshold), and evaluates the five
 * locked v1 alerts. The Pump module (microstructure-alert.ts) wires these
 * to live getOrderBook / getFundingRate data + state + cooldown.
 *
 * Design contracts (see docs/microstructure-alerts.md):
 *   - Relative metrics compare to a per-symbol baseline held in state.
 *   - Alerts explain *risk*, never call price direction.
 *   - v1 = exactly five alerts; wall / OI / crowded / vacuum are deferred.
 */

// ==================== Types ====================

export type MicroAlertType =
  | 'spread_widening'
  | 'depth_thinning'
  | 'orderbook_imbalance'
  | 'funding_extreme'
  | 'funding_change'

export type MicroSeverity = 'medium' | 'high' | 'critical'

/** One [price, amount] level, as the broker returns. */
export type Level = [price: number, amount: number]

export interface OrderBookSnapshot {
  bids: Level[]
  asks: Level[]
}

/** Reference band (fraction of mid) used for near-touch depth + imbalance. */
export const DEPTH_REF_BUCKET = 0.005 // 0.5%

export interface OrderBookMetrics {
  bestBid: number
  bestAsk: number
  mid: number
  /** Relative spread in %, cross-symbol comparable. */
  spreadPct: number
  /** Summed bid/ask amount within DEPTH_REF_BUCKET of mid. */
  bidDepth: number
  askDepth: number
  /** Total near-touch depth (bid + ask). */
  nearDepth: number
  /** bidDepth / (bidDepth + askDepth) in [0,1]; 0.5 = balanced. */
  imbalance: number
}

// ==================== Order-book metrics (pure) ====================

/** Sum amounts on one side within `band` fraction of `mid`. */
function depthWithin(levels: Level[], mid: number, band: number, side: 'bid' | 'ask'): number {
  const lo = mid * (1 - band)
  const hi = mid * (1 + band)
  let sum = 0
  for (const [price, amount] of levels) {
    if (side === 'bid' && price >= lo && price <= mid) sum += amount
    if (side === 'ask' && price <= hi && price >= mid) sum += amount
  }
  return sum
}

/**
 * Compute order-book metrics. Returns null when the book is unusable
 * (empty side or non-positive prices) — the caller skips evaluation
 * rather than feed garbage into a baseline.
 */
export function computeOrderBookMetrics(ob: OrderBookSnapshot): OrderBookMetrics | null {
  if (!ob.bids.length || !ob.asks.length) return null
  const bestBid = ob.bids[0][0]
  const bestAsk = ob.asks[0][0]
  if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk < bestBid) return null

  const mid = (bestBid + bestAsk) / 2
  const spreadPct = ((bestAsk - bestBid) / mid) * 100
  const bidDepth = depthWithin(ob.bids, mid, DEPTH_REF_BUCKET, 'bid')
  const askDepth = depthWithin(ob.asks, mid, DEPTH_REF_BUCKET, 'ask')
  const nearDepth = bidDepth + askDepth
  const imbalance = nearDepth > 0 ? bidDepth / nearDepth : 0.5

  return { bestBid, bestAsk, mid, spreadPct, bidDepth, askDepth, nearDepth, imbalance }
}

// ==================== Per-symbol baseline (pure) ====================

export interface SymbolBaseline {
  /** EWMA of spreadPct; null until first sample. */
  spreadPctEwma: number | null
  /** EWMA of nearDepth; null until first sample. */
  nearDepthEwma: number | null
  /** Recent funding values (signed), newest last, capped. */
  fundingHistory: number[]
  /** Last observed funding, for the change rule. */
  lastFunding: number | null
  /** Samples folded into the order-book EWMAs (warm-up gate). */
  obSamples: number
}

export function emptyBaseline(): SymbolBaseline {
  return { spreadPctEwma: null, nearDepthEwma: null, fundingHistory: [], lastFunding: null, obSamples: 0 }
}

function ewma(prev: number | null, x: number, alpha: number): number {
  return prev === null ? x : alpha * x + (1 - alpha) * prev
}

/** Fold an order-book observation into the baseline (returns a new object). */
export function updateOrderBookBaseline(b: SymbolBaseline, m: OrderBookMetrics, alpha: number): SymbolBaseline {
  return {
    ...b,
    spreadPctEwma: ewma(b.spreadPctEwma, m.spreadPct, alpha),
    nearDepthEwma: ewma(b.nearDepthEwma, m.nearDepth, alpha),
    obSamples: b.obSamples + 1,
  }
}

/** Fold a funding observation into the baseline (returns a new object). */
export function updateFundingBaseline(b: SymbolBaseline, funding: number, historyCap: number): SymbolBaseline {
  const hist = [...b.fundingHistory, funding]
  if (hist.length > historyCap) hist.splice(0, hist.length - historyCap)
  return { ...b, fundingHistory: hist, lastFunding: funding }
}

/** Percentile rank (0..100) of `value` within `sample` (inclusive ≤). */
export function percentileRank(value: number, sample: number[]): number {
  if (sample.length === 0) return 50
  const below = sample.filter((s) => s <= value).length
  return (below / sample.length) * 100
}

// ==================== Rule config + result ====================

export interface MicroRuleConfig {
  /** Min order-book samples before spread/depth rules may fire (warm-up). */
  obWarmup: number
  /** Min funding history length before funding rules may fire. */
  fundingWarmup: number
  spread: { medium: number; high: number; critical: number } // ratio vs baseline
  depth: { medium: number; high: number; critical: number }  // ratio vs baseline (<)
  imbalance: { medium: number; high: number; critical: number } // bid:ask ratio
  fundingExtreme: { medium: number; high: number; critical: number } // |percentile-50|*2 i.e. tail %
  fundingChange: { medium: number; high: number } // |delta| absolute (funding units)
}

export interface MicroSignal {
  type: MicroAlertType
  severity: MicroSeverity
  /** Machine detail for the message builder (numbers already computed). */
  data: string
  interpretation: string
  action: string
}

function sevByThresholds(value: number, t: { medium: number; high: number; critical: number }, dir: 'gte' | 'lte'): MicroSeverity | null {
  const ok = (lim: number) => (dir === 'gte' ? value >= lim : value <= lim)
  if (ok(t.critical)) return 'critical'
  if (ok(t.high)) return 'high'
  if (ok(t.medium)) return 'medium'
  return null
}

// ==================== The five v1 rules (pure) ====================

export function evalSpreadWidening(m: OrderBookMetrics, b: SymbolBaseline, cfg: MicroRuleConfig): MicroSignal | null {
  if (b.obSamples < cfg.obWarmup || b.spreadPctEwma === null || b.spreadPctEwma <= 0) return null
  const ratio = m.spreadPct / b.spreadPctEwma
  const sev = sevByThresholds(ratio, cfg.spread, 'gte')
  if (!sev) return null
  return {
    type: 'spread_widening', severity: sev,
    data: `Spread widened to ${ratio.toFixed(1)}x its rolling baseline (now ${m.spreadPct.toFixed(4)}%).`,
    interpretation: 'Short-term liquidity is deteriorating; market orders may face higher slippage.',
    action: 'Avoid large market orders and avoid opening high-leverage positions during this period.',
  }
}

export function evalDepthThinning(m: OrderBookMetrics, b: SymbolBaseline, cfg: MicroRuleConfig): MicroSignal | null {
  if (b.obSamples < cfg.obWarmup || b.nearDepthEwma === null || b.nearDepthEwma <= 0) return null
  const ratio = m.nearDepth / b.nearDepthEwma
  const sev = sevByThresholds(ratio, cfg.depth, 'lte')
  if (!sev) return null
  return {
    type: 'depth_thinning', severity: sev,
    data: `Near-touch depth fell to ${(ratio * 100).toFixed(0)}% of its rolling baseline.`,
    interpretation: 'Resting liquidity around the mid has thinned; the book can move faster on small flow.',
    action: 'Reduce order size and avoid resting large passive orders into a thin book.',
  }
}

export function evalOrderbookImbalance(m: OrderBookMetrics, cfg: MicroRuleConfig): MicroSignal | null {
  if (m.bidDepth <= 0 || m.askDepth <= 0) return null
  const ratio = m.bidDepth / m.askDepth
  const skew = Math.max(ratio, 1 / ratio)
  const sev = sevByThresholds(skew, cfg.imbalance, 'gte')
  if (!sev) return null
  const heavy = ratio > 1 ? 'bid' : 'ask'
  return {
    type: 'orderbook_imbalance', severity: sev,
    data: `Near-touch depth is ${skew.toFixed(1)}x heavier on the ${heavy} side.`,
    interpretation: heavy === 'bid'
      ? 'Buy-side liquidity dominates; an upside sweep would face little resistance while downside is thinly supported.'
      : 'Sell-side liquidity dominates; a downside sweep would face little resistance while upside is thinly supported.',
    action: 'Treat the thin side as the asymmetric-risk direction; avoid market orders into it.',
  }
}

export function evalFundingExtreme(funding: number, b: SymbolBaseline, cfg: MicroRuleConfig): MicroSignal | null {
  if (b.fundingHistory.length < cfg.fundingWarmup) return null
  const pct = percentileRank(funding, b.fundingHistory)
  const tail = Math.abs(pct - 50) * 2 // 0 at median, 100 at the extremes
  const sev = sevByThresholds(tail, cfg.fundingExtreme, 'gte')
  if (!sev) return null
  const side = funding >= 0 ? 'longs paying shorts' : 'shorts paying longs'
  return {
    type: 'funding_extreme', severity: sev,
    data: `Funding ${(funding * 100).toFixed(4)}% sits in the ${pct.toFixed(0)}th percentile of recent history (${side}).`,
    interpretation: 'Crowded one-sided carry; positioning into the funding-paying side is increasingly expensive and squeeze-prone.',
    action: 'Avoid adding to the funding-paying side here; the asymmetric risk is a squeeze against it.',
  }
}

export function evalFundingChange(current: number, b: SymbolBaseline, cfg: MicroRuleConfig): MicroSignal | null {
  if (b.lastFunding === null) return null
  const delta = current - b.lastFunding
  const flipped = Math.sign(current) !== Math.sign(b.lastFunding) && current !== 0 && b.lastFunding !== 0
  const ad = Math.abs(delta)
  let sev: MicroSeverity | null = null
  if (ad >= cfg.fundingChange.high) sev = 'high'
  else if (ad >= cfg.fundingChange.medium || flipped) sev = 'medium'
  if (!sev) return null
  return {
    type: 'funding_change', severity: sev,
    data: `Funding moved ${(b.lastFunding * 100).toFixed(4)}% → ${(current * 100).toFixed(4)}%${flipped ? ' (sign flip)' : ''}.`,
    interpretation: 'A fast funding shift signals positioning rotating; the prior carry trade is unwinding.',
    action: 'Re-check your exposure relative to the new funding regime before adding size.',
  }
}

// ==================== Message builder (pure) ====================

const SEV_ICON: Record<MicroSeverity, string> = { medium: '🟡', high: '🟠', critical: '🔴' }

/** Three-part Data / Interpretation / Action message for one symbol's signals. */
export function buildMicroAlertMessage(symbol: string, signals: MicroSignal[]): string {
  const top = signals.reduce<MicroSeverity>((acc, s) => sevRank(s.severity) > sevRank(acc) ? s.severity : acc, 'medium')
  const lines = [`${SEV_ICON[top]} ${symbol} microstructure — ${top.toUpperCase()}`]
  for (const s of signals) {
    lines.push('', `· ${s.type}`, `Data: ${s.data}`, `Interpretation: ${s.interpretation}`, `Action: ${s.action}`)
  }
  return lines.join('\n')
}

function sevRank(s: MicroSeverity): number {
  return s === 'critical' ? 3 : s === 'high' ? 2 : 1
}
