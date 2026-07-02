import { describe, it, expect } from 'vitest'
import { CcxtBroker } from './CcxtBroker.js'
import { BrokerError } from '../types.js'

/** Call the public method with a stubbed `this` — the exchange surface is
 *  the only dependency fetchDailyOhlcv touches (plus ensureInit). */
function callWith(exchange: Record<string, unknown>, nativeKey = 'BTC/USDT:USDT') {
  const fake = { ensureInit() { /* initialized */ }, exchange }
  return CcxtBroker.prototype.fetchDailyOhlcv.call(fake as never, nativeKey)
}

describe('CcxtBroker.fetchDailyOhlcv', () => {
  it('maps ccxt OHLCV rows to DailyCandle with string prices and UTC dates', async () => {
    const rows = await callWith({
      id: 'binanceusdm',
      has: { fetchOHLCV: true },
      fetchOHLCV: async (symbol: string, timeframe: string) => {
        expect(symbol).toBe('BTC/USDT:USDT')
        expect(timeframe).toBe('1d')
        return [
          [Date.parse('2026-07-01T00:00:00Z'), 100, 110.5, 90, 105.25, 5],
          [Date.parse('2026-07-02T00:00:00Z'), 105.25, 120, 100, 118, 6],
        ]
      },
    })
    expect(rows).toEqual([
      { dateUtc: '2026-07-01', open: '100', high: '110.5', low: '90', close: '105.25' },
      { dateUtc: '2026-07-02', open: '105.25', high: '120', low: '100', close: '118' },
    ])
  })

  it('exchange without fetchOHLCV → BrokerError UNSUPPORTED (structural, not transient)', async () => {
    const err = await callWith({ id: 'weird', has: {}, }).catch(e => e as BrokerError)
    expect(err).toBeInstanceOf(BrokerError)
    expect((err as BrokerError).code).toBe('UNSUPPORTED')
  })

  it('exchange throw → wrapped BrokerError (transient path)', async () => {
    const err = await callWith({
      id: 'binanceusdm', has: { fetchOHLCV: true },
      fetchOHLCV: async () => { throw new Error('rate limited') },
    }).catch(e => e as BrokerError)
    expect(err).toBeInstanceOf(BrokerError)
    expect((err as BrokerError).message).toContain('rate limited')
  })
})
