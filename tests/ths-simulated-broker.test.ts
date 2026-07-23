import { describe, expect, it } from 'vitest';
import {
  ThsSimulatedBroker,
  ThsSimulatedBrokerError,
  parseThsFundsSnapshot,
  parseThsOrdersSnapshot,
  parseThsPositionsSnapshot,
} from '../server/ths-simulated-broker.js';

function snapshot(kind: string, ...lines: string[]) {
  return ['THS_SIMULATOR_V1', `MODE|${kind}`, 'SIMULATION|confirmed', ...lines].join('\n');
}

describe('Tonghuashun simulated broker', () => {
  it('parses funds, positions and orders from labelled UI tables', () => {
    const funds = parseThsFundsSnapshot(snapshot(
      'funds',
      'TEXT|总资产',
      'TEXT|100,000.00',
      'TEXT|可用资金：60,000.00',
      'TEXT|股票市值',
      'TEXT|40,000.00',
    ));
    const positions = parseThsPositionsSnapshot(snapshot(
      'positions',
      'ROW|证券代码|证券名称|股票余额|可用余额|成本价|当前价|股票市值|总盈亏|盈亏比例',
      'ROW|600519|贵州茅台|200|100|1400.00|1500.00|300000.00|20000.00|7.14%',
    ));
    const orders = parseThsOrdersSnapshot(snapshot(
      'orders',
      'ROW|证券代码|证券名称|买卖方向|委托价格|委托数量|委托状态',
      'ROW|000001|平安银行|买入|10.20|100|已报',
      'ROW|600000|浦发银行|卖出|12.30|200|已撤',
    ));

    expect(funds).toMatchObject({ availableCash: 60_000, totalAssets: 100_000, marketValue: 40_000 });
    expect(positions).toEqual([expect.objectContaining({
      stock_code: '600519',
      stock_name: '贵州茅台',
      shares: 200,
      available_shares: 100,
      current_price: 1500,
      pnl_amount: 20_000,
      pnl_pct: 7.14,
    })]);
    expect(orders[0]).toMatchObject({ stock_code: '000001', side: 'buy', quantity: 100, cancelable: true });
    expect(orders[1]).toMatchObject({ stock_code: '600000', side: 'sell', quantity: 200, cancelable: false });
  });

  it('uses the known macOS Swift accessibility row layout without confusing price and quantity', () => {
    const positions = parseThsPositionsSnapshot(snapshot(
      'positions',
      'ROW|600519|贵州茅台|1331.100|429.560|472.000|0.322|100|0|0|100|1326.804|133110.000|82.963|上海Ａ股|A469281179',
    ));

    expect(positions[0]).toMatchObject({
      shares: 100,
      available_shares: 0,
      current_price: 1331.1,
      cost_price: 1326.804,
      market_value: 133_110,
      pnl_amount: 429.56,
      pnl_pct: 0.322,
    });
  });

  it('rejects snapshots that cannot prove the window is Tonghuashun simulation', () => {
    expect(() => parseThsFundsSnapshot('MODE|funds\nTEXT|可用资金：10000'))
      .toThrow(ThsSimulatedBrokerError);
  });

  it('serially builds an account snapshot from the three read-only commands', async () => {
    const commands: string[][] = [];
    const broker = new ThsSimulatedBroker({
      runner: async (args) => {
        commands.push(args);
        if (args[1] === 'funds') return snapshot('funds', 'TEXT|可用资金：90000', 'TEXT|总资产：100000');
        if (args[1] === 'positions') return snapshot(
          'positions',
          'ROW|证券代码|证券名称|股票余额|可用余额|成本价|当前价|股票市值|总盈亏|盈亏比例',
          'ROW|000001|平安银行|1000|1000|10|10|10000|0|0%',
        );
        return snapshot('orders');
      },
    });

    const account = await broker.snapshot();

    expect(commands).toEqual([
      ['snapshot', 'funds'],
      ['snapshot', 'positions'],
      ['snapshot', 'orders'],
    ]);
    expect(account.availableCash).toBe(90_000);
    expect(account.positions[0].stock_code).toBe('000001');
  });

  it('returns the AppleScript-confirmed execution price to the Node trading core', async () => {
    const broker = new ThsSimulatedBroker({
      runner: async () => [
        'ORDER_SUBMITTED|buy|600519|1331.10|100',
        'ORDER_VERIFIED|buy|600519|1331.10|100',
      ].join('\n'),
    });

    const result = await broker.placeOrder({
      id: 'plan-600519',
      side: 'buy',
      stock_code: '600519',
      stock_name: '贵州茅台',
      quantity: 100,
      price: 1331,
      amount: 133_100,
      status: '计划',
      reason: '测试',
      window: '开盘',
    });

    expect(result).toMatchObject({ verified: true, executionPrice: 1331.1, executionQuantity: 100 });
  });
});
