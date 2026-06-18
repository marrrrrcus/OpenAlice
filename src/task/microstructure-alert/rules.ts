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
  /** Percentile cutoffs, direction-consistent: a positive funding fires on a
   *  HIGH percentile (crowded longs), a negative funding on a LOW (mirrored)
   *  percentile (crowded shorts). `minAbs` is an absolute funding floor (raw
   *  units) below which nothing counts as extreme, whatever its percentile. */
  fundingExtreme: { medium: number; high: number; critical: number; minAbs: number }
  /** |delta| absolute (raw funding units). A sign flip alone no longer fires. */
  fundingChange: { medium: number; high: number }
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
    data: `買賣價差拉開到平常的 ${ratio.toFixed(1)} 倍（目前 ${m.spreadPct.toFixed(4)}%）。`,
    interpretation: '市場現在比較稀薄，用市價單成交容易吃到比較差的價格（滑價）。',
    action: '這段時間別下大額市價單，也先別開高槓桿。',
  }
}

export function evalDepthThinning(m: OrderBookMetrics, b: SymbolBaseline, cfg: MicroRuleConfig): MicroSignal | null {
  if (b.obSamples < cfg.obWarmup || b.nearDepthEwma === null || b.nearDepthEwma <= 0) return null
  const ratio = m.nearDepth / b.nearDepthEwma
  const sev = sevByThresholds(ratio, cfg.depth, 'lte')
  if (!sev) return null
  return {
    type: 'depth_thinning', severity: sev,
    data: `盤口附近的掛單量只剩平常的 ${(ratio * 100).toFixed(0)}%。`,
    interpretation: '掛單變少了，一點點成交量就可能把價格推得很快。',
    action: '把下單量改小，也別在這種稀薄的盤口掛大單等成交。',
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
    data: `盤口附近，${heavy === 'bid' ? '買方' : '賣方'}掛單比另一邊多 ${skew.toFixed(1)} 倍。`,
    interpretation: heavy === 'bid'
      ? '買單明顯比較多；價格往上衝阻力小，但要往下時下面接的單很少。'
      : '賣單明顯比較多；價格往下殺阻力小，但要往上時上面接的單很少。',
    action: '把掛單少的那一邊當成比較危險的方向，別往那邊下市價單。',
  }
}

export function evalFundingExtreme(funding: number, b: SymbolBaseline, cfg: MicroRuleConfig): MicroSignal | null {
  if (b.fundingHistory.length < cfg.fundingWarmup) return null
  // Absolute floor first: a near-zero funding is never "extreme", whatever its
  // percentile rank in a near-zero history (this is what got 0.0008% values
  // flagged before).
  const t = cfg.fundingExtreme
  if (Math.abs(funding) < t.minAbs) return null
  const pct = percentileRank(funding, b.fundingHistory)
  // Direction-consistent *tail strength*: a positive funding only counts as it
  // climbs ABOVE the median (crowded longs), a negative funding only as it
  // sinks BELOW it (crowded shorts). The wrong side gives tail <= 0 → silent.
  // This keeps the original 60/80/94 thresholds (= positive p80/p90/p97,
  // negative p20/p10/p3) rather than widening them to raw percentiles, while
  // fixing the old |pct-50|*2 that mislabelled the cheap side as crowded.
  const tail = funding > 0 ? (pct - 50) * 2 : (50 - pct) * 2
  if (tail <= 0) return null
  const sev = sevByThresholds(tail, t, 'gte')
  if (!sev) return null
  const side = funding >= 0 ? '現在是做多的人付錢給做空的人' : '現在是做空的人付錢給做多的人'
  return {
    type: 'funding_extreme', severity: sev,
    data: `資金費 ${(funding * 100).toFixed(4)}%，目前處在近期少見的極端區（第 ${pct.toFixed(0)} 百分位，${side}）。`,
    interpretation: '太多人壓同一邊；抱這個方向要一直付資金費、成本越來越高，人擠人時也容易被反向甩出去。',
    action: '現在別再往「要付資金費的那一邊」加碼；一旦反轉，這邊的單容易被一起掃掉。',
  }
}

export function evalFundingChange(current: number, b: SymbolBaseline, cfg: MicroRuleConfig): MicroSignal | null {
  if (b.lastFunding === null) return null
  const delta = current - b.lastFunding
  const ad = Math.abs(delta)
  // Magnitude-gated only. A sign flip no longer earns a free alert, so funding
  // oscillating near zero (e.g. 0.0005% → -0.0003%) stays silent; the flip is
  // now just a label on moves that already cleared the magnitude bar.
  let sev: MicroSeverity | null = null
  if (ad >= cfg.fundingChange.high) sev = 'high'
  else if (ad >= cfg.fundingChange.medium) sev = 'medium'
  if (!sev) return null
  const flipped = Math.sign(current) !== Math.sign(b.lastFunding) && current !== 0 && b.lastFunding !== 0
  return {
    type: 'funding_change', severity: sev,
    data: `資金費從 ${(b.lastFunding * 100).toFixed(4)}% 變成 ${(current * 100).toFixed(4)}%${flipped ? '（多空翻面）' : ''}。`,
    interpretation: '資金費突然大幅變動，代表大家的多空部位正在換邊，之前那批單在出場。',
    action: '加碼前先重新看一下自己的部位，現在的資金費環境跟剛剛不一樣了。',
  }
}

// ==================== Message builder (pure) ====================

const SEV_ICON: Record<MicroSeverity, string> = { medium: '🟡', high: '🟠', critical: '🔴' }

/** Traditional-Chinese severity + alert-type labels for the pushed message. */
const SEV_LABEL: Record<MicroSeverity, string> = { medium: '中等', high: '高', critical: '嚴重' }
const TYPE_LABEL: Record<MicroAlertType, string> = {
  spread_widening: '買賣價差變大',
  depth_thinning: '掛單變少',
  orderbook_imbalance: '掛單一邊倒',
  funding_extreme: '資金費極端',
  funding_change: '資金費大變動',
}

/** Three-part 數據 / 研判 / 建議 message for one symbol's signals. */
export function buildMicroAlertMessage(symbol: string, signals: MicroSignal[]): string {
  const top = signals.reduce<MicroSeverity>((acc, s) => sevRank(s.severity) > sevRank(acc) ? s.severity : acc, 'medium')
  const lines = [`${SEV_ICON[top]} ${symbol} 微結構警報 — ${SEV_LABEL[top]}`]
  for (const s of signals) {
    lines.push('', `· ${TYPE_LABEL[s.type]}`, `數據：${s.data}`, `研判：${s.interpretation}`, `建議：${s.action}`)
  }
  return lines.join('\n')
}

function sevRank(s: MicroSeverity): number {
  return s === 'critical' ? 3 : s === 'high' ? 2 : 1
}
