import Decimal from 'decimal.js'

export type StressReboundState = 'normal' | 'stress_watch' | 'rebound_confirmed' | 'structure_repair'

export type StressTransitionType =
  | 'enter_stress_watch'
  | 'rebound_confirmed'
  | 'structure_repair'
  | 'long_term_repair'
  | 'failure'
  | 'timeout'

export interface StressDailyCandle {
  /** UTC date of the completed daily candle, YYYY-MM-DD. */
  dateUtc: string
  close: string
  /** Intraday low is diagnostic only; state transitions use close. */
  low?: string
}

export interface StressReboundParams {
  sma60: number
  sma120: number
  sma200: number
  sma240: number
  drawdownPct: string
  reboundMultiple: string
  timeoutDays: number
}

export const DEFAULT_STRESS_REBOUND_PARAMS: StressReboundParams = {
  sma60: 60,
  sma120: 120,
  sma200: 200,
  sma240: 240,
  drawdownPct: '20',
  reboundMultiple: '1.15',
  timeoutDays: 60,
}

export interface StressDay {
  dateUtc: string
  state: StressReboundState
  close: string
  eventPeakClose: string
  eventPeakDateUtc: string
  troughClose?: string
  troughDateUtc?: string
  reboundLine?: string
  confirmedDateUtc?: string
  sma60?: string
  sma120?: string
  sma200?: string
  sma240?: string
  nextTrigger: string
  reasonLines: string[]
}

export interface StressTransition {
  dateUtc: string
  from: StressReboundState
  to: StressReboundState
  type: StressTransitionType
  close: string
  eventPeakClose: string
  troughClose?: string
  reboundLine?: string
  trigger: string
  reasonLines: string[]
}

export interface StressReboundResult {
  ok: boolean
  error?: string
  series: StressDay[]
  transitions: StressTransition[]
  latest?: StressDay
}

interface MachineRuntime {
  state: StressReboundState
  eventPeakClose: Decimal
  eventPeakDateUtc: string
  troughClose?: Decimal
  troughDateUtc?: string
  confirmedDateUtc?: string
}

const DAY_MS = 86_400_000

function toDecimal(v: string, label: string): Decimal {
  try {
    return new Decimal(v)
  } catch {
    throw new Error(`unreadable ${label}: ${v}`)
  }
}

function sma(candles: readonly StressDailyCandle[], endInclusive: number, window: number): Decimal | undefined {
  if (endInclusive + 1 < window) return undefined
  let sum = new Decimal(0)
  for (let i = endInclusive - window + 1; i <= endInclusive; i++) {
    sum = sum.plus(toDecimal(candles[i].close, `close at ${candles[i].dateUtc}`))
  }
  return sum.div(window)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
}

function nextTriggerFor(
  state: StressReboundState,
  close: Decimal,
  r: MachineRuntime,
  smas: { sma60?: Decimal; sma120?: Decimal; sma200?: Decimal; sma240?: Decimal },
  params: StressReboundParams,
): string {
  if (state === 'normal') {
    const drawdownLine = r.eventPeakClose.mul(new Decimal(1).minus(new Decimal(params.drawdownPct).div(100)))
    return `壓力觀察(stress_watch): 日線收盤 <= ${fmtPrice(drawdownLine)}, 且低於 SMA200 或 SMA240`
  }
  const reboundLine = r.troughClose?.mul(params.reboundMultiple)
  if (state === 'stress_watch') {
    return reboundLine ? `反彈確認(rebound_confirmed): 日線收盤 >= ${fmtPrice(reboundLine)}` : '等待壓力低點形成'
  }
  if (state === 'rebound_confirmed') {
    const target = smas.sma60 && smas.sma120 ? fmtPrice(Decimal.max(smas.sma60, smas.sma120)) : 'SMA60/SMA120'
    return `結構修復(structure_repair): 日線收盤 >= ${target}; 失敗(failure): 日線收盤 < ${r.troughClose ? fmtPrice(r.troughClose) : 'trough_close'}`
  }
  const target = smas.sma200 && smas.sma240 ? fmtPrice(Decimal.max(smas.sma200, smas.sma240)) : 'SMA200/SMA240'
  return `長期壓力解除(long_term_repair): 日線收盤 >= ${target}; 失敗(failure): 日線收盤 < ${r.troughClose ? fmtPrice(r.troughClose) : 'trough_close'}`
}

/** Display-only price formatter: rounds to at most 2 decimals for readable
 *  Telegram/report output. Internal state comparisons keep full Decimal
 *  precision — this never feeds a transition decision. */
function fmtPrice(v: Decimal): string {
  return v.toDecimalPlaces(2).toFixed()
}

function signedPct(v: Decimal): string {
  return `${v.gte(0) ? '+' : ''}${v.toFixed(2)}%`
}

function pctVs(close: Decimal, level: Decimal): string {
  return signedPct(close.minus(level).div(level).mul(100))
}

function closeVs(label: string, close: Decimal, level: Decimal): string {
  const relation = close.gte(level) ? '高於或等於' : '低於'
  return `${label}: 日線收盤 ${fmtPrice(close)} ${relation} ${fmtPrice(level)} (${pctVs(close, level)})`
}

function drawdownLine(close: Decimal, peak: Decimal, params: StressReboundParams): string {
  const dd = close.div(peak).minus(1).mul(100)
  return `自這波高點回撤: ${signedPct(dd)} (壓力門檻 -${params.drawdownPct}%)`
}

function reasonLinesForState(
  state: StressReboundState,
  close: Decimal,
  r: MachineRuntime,
  smas: { sma60?: Decimal; sma120?: Decimal; sma200?: Decimal; sma240?: Decimal },
  params: StressReboundParams,
): string[] {
  const lines: string[] = []
  if (state === 'normal') {
    if (smas.sma200) lines.push(closeVs('SMA200', close, smas.sma200))
    if (smas.sma240) lines.push(closeVs('SMA240', close, smas.sma240))
    return lines
  }

  lines.push(drawdownLine(close, r.eventPeakClose, params))
  if (smas.sma200) lines.push(closeVs('SMA200', close, smas.sma200))
  if (smas.sma240) lines.push(closeVs('SMA240', close, smas.sma240))

  const reboundLine = r.troughClose?.mul(params.reboundMultiple)
  if (state === 'stress_watch') {
    if (reboundLine) lines.push(closeVs('rebound_line', close, reboundLine))
    return lines
  }

  if (reboundLine) lines.push(closeVs('rebound_line', close, reboundLine))
  if (state === 'rebound_confirmed') {
    if (smas.sma60) lines.push(closeVs('SMA60', close, smas.sma60))
    if (smas.sma120) lines.push(closeVs('SMA120', close, smas.sma120))
  } else {
    if (smas.sma60) lines.push(closeVs('SMA60', close, smas.sma60))
    if (smas.sma120) lines.push(closeVs('SMA120', close, smas.sma120))
    if (smas.sma200) lines.push(closeVs('SMA200', close, smas.sma200))
    if (smas.sma240) lines.push(closeVs('SMA240', close, smas.sma240))
  }
  if (r.troughClose) lines.push(`失敗線: 日線收盤 < 這波低點 ${fmtPrice(r.troughClose)}`)
  return lines
}

function reasonLinesForTransition(
  type: StressTransitionType,
  close: Decimal,
  r: MachineRuntime,
  smas: { sma60?: Decimal; sma120?: Decimal; sma200?: Decimal; sma240?: Decimal },
  params: StressReboundParams,
): string[] {
  const lines: string[] = []
  if (type === 'enter_stress_watch') {
    lines.push(drawdownLine(close, r.eventPeakClose, params))
    if (smas.sma200) lines.push(closeVs('SMA200', close, smas.sma200))
    if (smas.sma240) lines.push(closeVs('SMA240', close, smas.sma240))
    return lines
  }

  const reboundLine = r.troughClose?.mul(params.reboundMultiple)
  if (type === 'rebound_confirmed') {
    if (reboundLine) lines.push(closeVs('rebound_line', close, reboundLine))
    return lines
  }
  if (type === 'structure_repair') {
    if (reboundLine) lines.push(closeVs('rebound_line', close, reboundLine))
    if (smas.sma60) lines.push(closeVs('SMA60', close, smas.sma60))
    if (smas.sma120) lines.push(closeVs('SMA120', close, smas.sma120))
    return lines
  }
  if (type === 'long_term_repair') {
    if (reboundLine) lines.push(closeVs('rebound_line', close, reboundLine))
    if (smas.sma200) lines.push(closeVs('SMA200', close, smas.sma200))
    if (smas.sma240) lines.push(closeVs('SMA240', close, smas.sma240))
    return lines
  }
  if (type === 'failure') {
    if (r.troughClose) lines.push(closeVs('trough_close', close, r.troughClose))
    return lines
  }
  lines.push(`逾時: 反彈確認後 ${params.timeoutDays} 天內仍未完成結構修復`)
  return lines
}

function dayRow(
  candle: StressDailyCandle,
  state: StressReboundState,
  close: Decimal,
  r: MachineRuntime,
  smas: { sma60?: Decimal; sma120?: Decimal; sma200?: Decimal; sma240?: Decimal },
  params: StressReboundParams,
): StressDay {
  const reboundLine = r.troughClose?.mul(params.reboundMultiple)
  return {
    dateUtc: candle.dateUtc,
    state,
    close: fmtPrice(close),
    eventPeakClose: fmtPrice(r.eventPeakClose),
    eventPeakDateUtc: r.eventPeakDateUtc,
    ...(r.troughClose ? { troughClose: fmtPrice(r.troughClose) } : {}),
    ...(r.troughDateUtc ? { troughDateUtc: r.troughDateUtc } : {}),
    ...(reboundLine ? { reboundLine: fmtPrice(reboundLine) } : {}),
    ...(r.confirmedDateUtc ? { confirmedDateUtc: r.confirmedDateUtc } : {}),
    ...(smas.sma60 ? { sma60: fmtPrice(smas.sma60) } : {}),
    ...(smas.sma120 ? { sma120: fmtPrice(smas.sma120) } : {}),
    ...(smas.sma200 ? { sma200: fmtPrice(smas.sma200) } : {}),
    ...(smas.sma240 ? { sma240: fmtPrice(smas.sma240) } : {}),
    nextTrigger: nextTriggerFor(state, close, r, smas, params),
    reasonLines: reasonLinesForState(state, close, r, smas, params),
  }
}

function transition(
  candle: StressDailyCandle,
  from: StressReboundState,
  to: StressReboundState,
  type: StressTransitionType,
  close: Decimal,
  r: MachineRuntime,
  smas: { sma60?: Decimal; sma120?: Decimal; sma200?: Decimal; sma240?: Decimal },
  trigger: string,
  params: StressReboundParams,
): StressTransition {
  const reboundLine = r.troughClose?.mul(params.reboundMultiple)
  return {
    dateUtc: candle.dateUtc,
    from,
    to,
    type,
    close: fmtPrice(close),
    eventPeakClose: fmtPrice(r.eventPeakClose),
    ...(r.troughClose ? { troughClose: fmtPrice(r.troughClose) } : {}),
    ...(reboundLine ? { reboundLine: fmtPrice(reboundLine) } : {}),
    trigger,
    reasonLines: reasonLinesForTransition(type, close, r, smas, params),
  }
}

export function transitionKey(t: StressTransition): string {
  return `${t.dateUtc}:${t.from}:${t.to}:${t.type}`
}

export function computeStressRebound(
  input: readonly StressDailyCandle[],
  params: StressReboundParams = DEFAULT_STRESS_REBOUND_PARAMS,
): StressReboundResult {
  const candles = [...input].sort((a, b) => a.dateUtc.localeCompare(b.dateUtc))
  const warmup = Math.max(params.sma60, params.sma120, params.sma200, params.sma240)
  if (candles.length < warmup) {
    return { ok: false, error: `need >=${warmup} completed daily candles, got ${candles.length}`, series: [], transitions: [] }
  }

  const series: StressDay[] = []
  const transitions: StressTransition[] = []

  try {
    const first = candles[warmup - 1]
    const firstClose = toDecimal(first.close, `close at ${first.dateUtc}`)
    const r: MachineRuntime = {
      state: 'normal',
      eventPeakClose: firstClose,
      eventPeakDateUtc: first.dateUtc,
    }

    for (let i = warmup - 1; i < candles.length; i++) {
      const c = candles[i]
      const close = toDecimal(c.close, `close at ${c.dateUtc}`)
      const smas = {
        sma60: sma(candles, i, params.sma60),
        sma120: sma(candles, i, params.sma120),
        sma200: sma(candles, i, params.sma200),
        sma240: sma(candles, i, params.sma240),
      }
      if (!smas.sma200 || !smas.sma240) continue

      const from = r.state
      let type: StressTransitionType | undefined
      let transitionSnapshot: MachineRuntime | undefined
      let trigger = ''

      const longTermRepaired = close.gte(smas.sma200) && close.gte(smas.sma240)
      const structureRepaired = smas.sma60 !== undefined && smas.sma120 !== undefined && close.gte(smas.sma60) && close.gte(smas.sma120)

      if (r.state === 'normal') {
        if (close.gt(r.eventPeakClose)) {
          r.eventPeakClose = close
          r.eventPeakDateUtc = c.dateUtc
        }
        const drawdown = close.div(r.eventPeakClose).minus(1).mul(100)
        if (drawdown.lte(new Decimal(params.drawdownPct).neg()) && (close.lt(smas.sma200) || close.lt(smas.sma240))) {
          r.state = 'stress_watch'
          r.troughClose = close
          r.troughDateUtc = c.dateUtc
          r.confirmedDateUtc = undefined
          type = 'enter_stress_watch'
          trigger = `自這波高點回撤 ${drawdown.toFixed(2)}%, 且日線收盤低於 SMA200 或 SMA240`
        }
      } else if (r.state === 'stress_watch') {
        if (!r.troughClose || close.lt(r.troughClose)) {
          r.troughClose = close
          r.troughDateUtc = c.dateUtc
        }
        const reboundLine = r.troughClose.mul(params.reboundMultiple)
        if (close.gte(reboundLine)) {
          if (longTermRepaired) {
            transitionSnapshot = { ...r }
            r.state = 'normal'
            r.eventPeakClose = close
            r.eventPeakDateUtc = c.dateUtc
            r.troughClose = undefined
            r.troughDateUtc = undefined
            r.confirmedDateUtc = undefined
            type = 'long_term_repair'
            trigger = `日線收盤同時站上反彈確認線與 SMA200/SMA240`
          } else if (structureRepaired) {
            r.state = 'structure_repair'
            r.confirmedDateUtc = c.dateUtc
            type = 'structure_repair'
            trigger = `日線收盤同時站上反彈確認線與 SMA60/SMA120`
          } else {
            r.state = 'rebound_confirmed'
            r.confirmedDateUtc = c.dateUtc
            type = 'rebound_confirmed'
            trigger = `日線收盤 >= 這波低點 * ${params.reboundMultiple}`
          }
        }
      } else if (r.state === 'rebound_confirmed') {
        if (r.troughClose && close.lt(r.troughClose)) {
          r.state = 'stress_watch'
          r.troughClose = close
          r.troughDateUtc = c.dateUtc
          r.confirmedDateUtc = undefined
          type = 'failure'
          trigger = '日線收盤跌破這波低點'
        } else if (longTermRepaired) {
          transitionSnapshot = { ...r }
          r.state = 'normal'
          r.eventPeakClose = close
          r.eventPeakDateUtc = c.dateUtc
          r.troughClose = undefined
          r.troughDateUtc = undefined
          r.confirmedDateUtc = undefined
          type = 'long_term_repair'
          trigger = '日線收盤站回 SMA200/SMA240'
        } else if (structureRepaired) {
          r.state = 'structure_repair'
          type = 'structure_repair'
          trigger = '日線收盤站回 SMA60/SMA120'
        } else if (r.confirmedDateUtc && daysBetween(r.confirmedDateUtc, c.dateUtc) >= params.timeoutDays) {
          r.state = 'stress_watch'
          r.confirmedDateUtc = undefined
          type = 'timeout'
          trigger = `反彈確認後 ${params.timeoutDays} 天內仍未完成結構修復`
        }
      } else if (r.state === 'structure_repair') {
        if (r.troughClose && close.lt(r.troughClose)) {
          r.state = 'stress_watch'
          r.troughClose = close
          r.troughDateUtc = c.dateUtc
          r.confirmedDateUtc = undefined
          type = 'failure'
          trigger = '日線收盤跌破這波低點'
        } else if (longTermRepaired) {
          transitionSnapshot = { ...r }
          r.state = 'normal'
          r.eventPeakClose = close
          r.eventPeakDateUtc = c.dateUtc
          r.troughClose = undefined
          r.troughDateUtc = undefined
          r.confirmedDateUtc = undefined
          type = 'long_term_repair'
          trigger = '日線收盤站回 SMA200/SMA240'
        }
      }

      if (type) {
        transitions.push(transition(c, from, r.state, type, close, transitionSnapshot ?? r, smas, trigger, params))
      }
      series.push(dayRow(c, r.state, close, r, smas, params))
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), series, transitions }
  }

  return { ok: true, series, transitions, latest: series[series.length - 1] }
}
