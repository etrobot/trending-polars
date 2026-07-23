import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCK_KLINE_URL,
  fetchAdjustedKlines,
  fetchBlockKlines,
  parseBlockKlines,
  parseEastmoneyAdjustedKlines,
  parseSinaKlines,
  parseTencentKlines,
} from '../server/historical-market.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('market kline sources', () => {
  it('parses Tencent qfq volume as shares without pretending it is turnover', () => {
    expect(parseTencentKlines([
      ['2026-07-22', '10.00', '10.20', '10.30', '9.90', '1234'],
    ])).toEqual([{
      date: '2026-07-22',
      open: 10,
      close: 10.2,
      high: 10.3,
      low: 9.9,
      volume: 123_400,
      amount: 0,
    }]);
  });

  it('adjusts only Sina prices and keeps the original volume', () => {
    const factors = new Map([['2025-01-01', 2]]);
    expect(parseSinaKlines([{
      day: '2025-01-02',
      open: '20',
      close: '22',
      high: '24',
      low: '18',
      volume: '5000',
    }], factors, 10)).toEqual([{
      date: '2025-01-02',
      open: 10,
      close: 11,
      high: 12,
      low: 9,
      volume: 5000,
      amount: 0,
    }]);
  });

  it('keeps EastMoney volume and turnover in their own fields', () => {
    expect(parseEastmoneyAdjustedKlines([
      '2026-07-22,10.00,10.20,10.30,9.90,1234,567890.12,4.00,2.00,0.20,1.00',
    ])).toEqual([{
      date: '2026-07-22',
      open: 10,
      close: 10.2,
      high: 10.3,
      low: 9.9,
      volume: 1234,
      amount: 567890.12,
      changeRate: 2,
    }]);
  });

  it('parses Tonghuashun block-index OHLC in open-high-low-close order', () => {
    const payload = 'quotebridge_v4_line_bk_885531_01_last({"name":"光伏概念","data":"20260721,100,110,90,105,1000,2000,,,,0;20260722,106,112,101,108,1200,2400,,,,0"})';
    expect(parseBlockKlines(payload, 10)).toEqual([
      {
        date: '2026-07-21',
        open: 100,
        close: 105,
        high: 110,
        low: 90,
        volume: 1000,
        amount: 2000,
        changeRate: 0,
      },
      {
        date: '2026-07-22',
        open: 106,
        close: 108,
        high: 112,
        low: 101,
        volume: 1200,
        amount: 2400,
        changeRate: 2.86,
      },
    ]);
  });

  it('uses Tencent first and does not call later fallbacks after success', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return new Response('kline_dayqfq={"code":0,"data":{"sh000300":{"qfqday":[["2026-07-22","4000","4050","4060","3990","100"]]}}}', { status: 200 });
    }));

    const result = await fetchAdjustedKlines('sh000300', 5);
    expect(result.source).toBe('tencent');
    expect(result.klines[0]).toMatchObject({ close: 4050, volume: 10_000 });
    expect(calls).toHaveLength(1);
  });

  it('falls back in Tencent -> Sina -> EastMoney order', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('web.ifzq.gtimg.cn')) return new Response('invalid', { status: 200 });
      if (url.includes('CN_MarketData.getKLineData')) return new Response('null', { status: 200 });
      if (url.includes('/qfq.js')) return new Response('var sh000300qfq={"total":0,"data":[]};', { status: 200 });
      if (url.includes('push2his.eastmoney.com')) {
        return Response.json({
          data: {
            klines: ['2026-07-22,4000,4050,4060,3990,100,200000,1.75,1.25,50,2'],
          },
        });
      }
      return new Response('', { status: 404 });
    }));

    const result = await fetchAdjustedKlines('sh000300', 5);
    expect(result.source).toBe('eastmoney');
    expect(result.klines[0]).toMatchObject({ close: 4050, volume: 100, amount: 200000 });
    expect(calls[0]).toContain('web.ifzq.gtimg.cn');
    expect(calls.findIndex((url) => url.includes('push2his.eastmoney.com')))
      .toBeGreaterThan(calls.findIndex((url) => url.includes('CN_MarketData.getKLineData')));
  });

  it('uses the dedicated Tonghuashun block URL instead of a stock/index source', async () => {
    let requested = '';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      requested = String(input);
      return new Response('callback({"name":"光伏概念","data":"20260722,100,110,90,105,1000,2000,,,,0"})', { status: 200 });
    }));

    const result = await fetchBlockKlines('bk_885531', '01', 5);
    expect(BLOCK_KLINE_URL).toBe('https://d.10jqka.com.cn/v4/line/bk_{code}/{period}/last.js');
    expect(requested).toBe('https://d.10jqka.com.cn/v4/line/bk_885531/01/last.js');
    expect(result).toMatchObject({ source: 'ths-block', name: '光伏概念' });
  });
});
