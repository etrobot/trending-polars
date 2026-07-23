import type { HistoricalBar, HistoricalMarketData } from '../server/historical-market.js';

function compact(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function businessDates(endDate: string, count: number): string[] {
  const cursor = new Date(
    Number(endDate.slice(0, 4)),
    Number(endDate.slice(4, 6)) - 1,
    Number(endDate.slice(6, 8)),
    12,
  );
  const dates: string[] = [];
  while (dates.length < count) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) dates.unshift(compact(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return dates;
}

function stockBars(
  dates: string[],
  initialPrice: number,
  dailyReturn: (index: number) => number,
  volumeScale: number,
): HistoricalBar[] {
  const bars: HistoricalBar[] = [];
  let previousClose = initialPrice;
  for (let index = 0; index < dates.length; index += 1) {
    const change = dailyReturn(index);
    const open = previousClose * (1 + change * 0.15);
    const close = previousClose * (1 + change);
    const high = Math.max(open, close) * 1.008;
    const low = Math.min(open, close) * 0.992;
    const volume = Math.round(volumeScale * (1 + (index % 7) * 0.025));
    bars.push([
      dates[index],
      Number(open.toFixed(3)),
      Number(close.toFixed(3)),
      Number(high.toFixed(3)),
      Number(low.toFixed(3)),
      volume,
      Number((volume * close).toFixed(2)),
      Number((change * 100).toFixed(2)),
    ]);
    previousClose = close;
  }
  return bars;
}

export function historicalFixture(endDate = '20260722'): HistoricalMarketData {
  const dates = businessDates(endDate, 90);
  return {
    schema_version: 1,
    source: 'eastmoney-unadjusted',
    generated_at: '2026-07-22 16:00:00',
    as_of_date: endDate,
    universe_as_of_date: endDate,
    requested_days: 60,
    warmup_days: 70,
    calendar: dates,
    failed_stocks: 0,
    stocks: [
      {
        stock_code: '600001',
        stock_name: '历史样本甲',
        bars: stockBars(dates, 10, (index) => 0.004 + (index % 5 === 0 ? 0.001 : 0), 12_000_000),
      },
      {
        stock_code: '000002',
        stock_name: '历史样本乙',
        bars: stockBars(dates, 16, (index) => 0.0035 + (index % 6 === 0 ? 0.001 : 0), 10_000_000),
      },
      {
        stock_code: '300003',
        stock_name: '历史样本丙',
        bars: stockBars(dates, 25, (index) => index % 4 === 0 ? -0.004 : 0.001, 8_000_000),
      },
      {
        stock_code: '600004',
        stock_name: '历史样本丁',
        bars: stockBars(dates, 20, () => -0.002, 9_000_000),
      },
    ],
  };
}

