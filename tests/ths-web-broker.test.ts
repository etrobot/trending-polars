import { describe, expect, it, vi } from 'vitest';
import type { PaperOrder } from '../src/types.js';
import { ThsWebSimulatedBroker } from '../server/ths-web-broker.js';

const COOKIE = 'user=abc; ticket=t1; PHPSESSID=s1';

const INDEX_HTML = "<html><script>var uname='mx_351333791';var zjzh='42706005';</script></html>";
const INDEX_HTML_LOGGED_OUT = "<html><script>var uname='';</script></html>";
const BUYDIV_HTML = '<select name="gddm"><option value="1">深圳A股 0093561056</option><option value="2">上海A股 A469281179</option></select>';

const ZIJIN = {
  errorcode: 0,
  result: {
    data: { kyje: '111806.04', zjye: '111806.04', djje: '0.00', kqje: '0.00', zzc: '162300.04', zjzh: '42706005' },
    extend: { gpsz: '50494.000' },
  },
};

const CHICANG = {
  errorcode: 0,
  result: {
    list: [
      { d_3001: '0', d_2102: '000011', d_2103: '深物业A', d_2117: '1700', d_2121: '1700', d_2118: '0', d_2122: '8.133', d_2124: '9.710', d_2125: '16507.000', d_2147: '2681.570', d_3616: '19.400', d_2167: '1', d_2106: '0093561056' },
      { d_3001: '1', d_2102: '600737', d_2103: '中粮糖业', d_2117: '300', d_2121: '300', d_2118: '0', d_2122: '15.265', d_2124: '11.790', d_2125: '3537.000', d_2147: '-1042.460', d_3616: '-22.760', d_2167: '2', d_2106: 'A469281179' },
    ],
  },
};

function delegatedRow(overrides: Record<string, string> = {}) {
  return {
    d_2135: '00001234',
    d_2139: '20261102',
    d_2140: '14:30:00',
    d_2102: '000011',
    d_2103: '深物业A',
    d_2109: '买入',
    d_2126: '100',
    d_2128: '0',
    d_2127: '9.700',
    d_2129: '0.000',
    d_2105: '已报',
    ...overrides,
  };
}

const QRYSTOCK = {
  errorcode: 0,
  result: {
    data: {
      st_price: '9.71',
      st_name: '深物业A',
      st_up_limit: '10.68',
      st_down_limit: '8.74',
      extend: 'wtfs*web|gdzhlb*9,gdzh;8,gdzh;2,A469281179;1,0093561056;',
    },
  },
};

const TRADE_OK = { errorcode: 0, result: { data: { htbh: '00001234', ret_msg: '委托成功' } } };
const CANCEL_OK = { errorcode: 0, result: { data: { ret_msg: '撤单成功' } } };
const NOT_LOGGED_IN = { errorcode: -999999, errormsg: '未登录', result: {} };
const CJDBS = { errorcode: 0, result: { data: [{ jyUrlOl: 'http://moni.10jqka.com.cn/trade.php?usrid=42706005&token=xyz' }] } };

interface ScriptedMock {
  fetchImpl: typeof fetch;
  calls: { url: string; body: string | null }[];
  set(urlPattern: RegExp, responses: unknown[]): void;
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: new Headers({ 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) }),
  });
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, { ...init, headers: new Headers({ 'content-type': 'text/html', ...(init.headers as Record<string, string> | undefined) }) });
}

function scriptedMock(): ScriptedMock {
  const routes: { pattern: RegExp; responses: unknown[] }[] = [];
  const calls: { url: string; body: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body });
    for (const route of routes) {
      if (!route.pattern.test(url)) continue;
      const next = route.responses.length > 1 ? route.responses.shift() : route.responses[0];
      if (next instanceof Response) return next;
      if (typeof next === 'function') return (next as (u: string, b: string | null) => Response)(url, body);
      return jsonResponse(next);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    set(pattern, responses) {
      const existing = routes.find((route) => route.pattern.source === pattern.source);
      if (existing) existing.responses = responses;
      else routes.push({ pattern, responses });
    },
  };
}

function baseMock(): ScriptedMock {
  const mock = scriptedMock();
  mock.set(/cgiwt\/index\/index/, [htmlResponse(INDEX_HTML)]);
  mock.set(/cgiwt\/index\/buydiv/, [htmlResponse(BUYDIV_HTML)]);
  mock.set(/qryzijin/, [ZIJIN]);
  mock.set(/qryChicang/, [CHICANG]);
  mock.set(/qryDelegated/, [{ errorcode: 0, result: { list: [delegatedRow()] } }]);
  mock.set(/qrystock/, [QRYSTOCK]);
  mock.set(/tradestock/, [TRADE_OK]);
  mock.set(/cancelDelegated/, [CANCEL_OK]);
  return mock;
}

function makeOrder(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: 'o1',
    side: 'buy',
    stock_code: '000011',
    stock_name: '深物业A',
    quantity: 100,
    price: 9.7,
    amount: 970,
    status: '待提交',
    reason: '',
    window: 'morning',
    ...overrides,
  };
}

function createBroker(mock: ScriptedMock) {
  return new ThsWebSimulatedBroker({ cookie: COOKIE, fetchImpl: mock.fetchImpl, interactiveLogin: false });
}

describe('ThsWebSimulatedBroker', () => {
  it('缺少 cookie 时构造不报错，登录态检测为未登录', async () => {
    const saved = process.env.THS_WEB_COOKIE;
    delete process.env.THS_WEB_COOKIE;
    try {
      const mock = baseMock();
      mock.set(/cgiwt\/index\/index/, [htmlResponse(INDEX_HTML_LOGGED_OUT)]);
      mock.set(/getcjdbs/, [{ errorcode: 0, result: { data: [] } }]);
      const broker = new ThsWebSimulatedBroker({
        cookieFile: 'X:\\不存在\\cookie.txt',
        fetchImpl: mock.fetchImpl,
        interactiveLogin: false,
      });
      expect(await broker.checkLoginStatus()).toBe(false);
      // 交互登录被禁用时不启动浏览器，回报禁用原因
      const request = broker.requestInteractiveLogin({ stage: 'login', source: 'test' });
      expect(request.started).toBe(false);
      expect(request.reason).toContain('THS_WEB_INTERACTIVE_LOGIN');
    } finally {
      if (saved !== undefined) process.env.THS_WEB_COOKIE = saved;
    }
  });

  it('checkLoginStatus 已登录时返回 true', async () => {
    const mock = baseMock();
    const broker = createBroker(mock);
    expect(await broker.checkLoginStatus()).toBe(true);
    expect(broker.getLoginState()).toEqual({ in_progress: false, error: null });
  });

  it('checkLoginStatus 会话失效但绑定链可恢复时静默重登', async () => {
    const mock = baseMock();
    mock.set(/cgiwt\/index\/index/, [htmlResponse(INDEX_HTML_LOGGED_OUT), htmlResponse(INDEX_HTML)]);
    mock.set(/getcjdbs/, [CJDBS]);
    mock.set(/trade\.php/, [new Response(null, { status: 302, headers: { location: '/cgiwt/index/doths?type=auto' } })]);
    mock.set(/doths/, [new Response(null, { status: 302, headers: { location: 'https://mncg.10jqka.com.cn/cgiwt/index/index' } })]);
    const broker = createBroker(mock);
    expect(await broker.checkLoginStatus()).toBe(true);
    expect(mock.calls.some((call) => call.url.includes('getcjdbs'))).toBe(true);
  });

  it('snapshot 解析资金/持仓/委托', async () => {
    const mock = baseMock();
    const broker = createBroker(mock);
    const snapshot = await broker.snapshot();
    expect(snapshot.availableCash).toBe(111806.04);
    expect(snapshot.totalAssets).toBe(162300.04);
    expect(snapshot.positions).toHaveLength(2);
    expect(snapshot.positions[0]).toMatchObject({
      stock_code: '000011',
      stock_name: '深物业A',
      shares: 1700,
      available_shares: 1700,
      cost_price: 8.133,
      current_price: 9.71,
      market_value: 16507,
      pnl_amount: 2681.57,
      pnl_pct: 19.4,
    });
    expect(snapshot.orders).toHaveLength(1); // qryDelegated 全市场一次返回，已去重
    expect(snapshot.orders[0]).toMatchObject({
      id: 'ths-web-00001234',
      side: 'buy',
      stock_code: '000011',
      quantity: 100,
      price: 9.7,
      status: '已报',
      cancelable: true,
    });
  });

  it('持仓市值>0 但明细为空时拒绝空快照', async () => {
    const mock = baseMock();
    mock.set(/qryChicang/, [{ errorcode: 0, result: { list: [] } }]);
    const broker = createBroker(mock);
    await expect(broker.snapshot()).rejects.toThrow(/未读取到持仓明细/);
  });

  it('quote 使用 qrystock 实时价', async () => {
    const mock = baseMock();
    const broker = createBroker(mock);
    expect(await broker.quote('000011')).toBe(9.71);
    const qrystockCall = mock.calls.find((call) => call.url.includes('qrystock'));
    expect(qrystockCall?.body).toContain('type=1');
    expect(qrystockCall?.body).toContain('stockcode=000011');
  });

  it('沪市代码 mkcode=2', async () => {
    const mock = baseMock();
    const broker = createBroker(mock);
    await broker.quote('600737');
    expect(mock.calls.find((call) => call.url.includes('qrystock'))?.body).toContain('type=2');
  });

  it('placeOrder 买入：提交 tradestock 并回查合同编号', async () => {
    const mock = baseMock();
    const broker = createBroker(mock);
    const result = await broker.placeOrder(makeOrder());
    expect(result.verified).toBe(true);
    expect(result.executionPrice).toBe(9.7);
    expect(result.executionQuantity).toBe(100);
    const tradeCall = mock.calls.find((call) => call.url.includes('tradestock'));
    expect(tradeCall?.body).toContain('type=cmd_wt_mairu');
    expect(tradeCall?.body).toContain('mkcode=1');
    expect(tradeCall?.body).toContain('gdzh=0093561056');
    expect(tradeCall?.body).toContain('stockcode=000011');
    expect(tradeCall?.body).toContain('price=9.7');
    expect(tradeCall?.body).toContain('amount=100');
  });

  it('placeOrder 卖出使用 cmd_wt_maichu', async () => {
    const mock = baseMock();
    const broker = createBroker(mock);
    await broker.placeOrder(makeOrder({ side: 'sell' }));
    expect(mock.calls.find((call) => call.url.includes('tradestock'))?.body).toContain('type=cmd_wt_maichu');
  });

  it('placeOrder 超过涨停价被拒绝', async () => {
    const mock = baseMock();
    const broker = createBroker(mock);
    await expect(broker.placeOrder(makeOrder({ price: 10.69 }))).rejects.toThrow(/涨停价/);
    expect(mock.calls.some((call) => call.url.includes('tradestock'))).toBe(false);
  });

  it('placeOrder 回查不到合同编号时报错', async () => {
    const mock = baseMock();
    mock.set(/qryDelegated/, [{ errorcode: 0, result: { list: [] } }]);
    const broker = createBroker(mock);
    await expect(broker.placeOrder(makeOrder())).rejects.toThrow(/回查失败/);
  });

  it('cancelOrder 匹配可撤委托并回查确认', async () => {
    const mock = baseMock();
    // 第一次 qryDelegated 返回可撤委托，撤单后的回查返回空列表
    let delegatedCount = 0;
    mock.set(/qryDelegated/, [
      () => {
        delegatedCount += 1;
        return jsonResponse({ errorcode: 0, result: { list: delegatedCount <= 1 ? [delegatedRow()] : [] } });
      },
    ]);
    const broker = createBroker(mock);
    const result = await broker.cancelOrder('buy', '000011', 100);
    expect(result.verified).toBe(true);
    const cancelCall = mock.calls.find((call) => call.url.includes('cancelDelegated'));
    expect(cancelCall?.body).toContain('htbh=00001234');
    expect(cancelCall?.body).toContain('wtrq=20261102');
  });

  it('cancelOrder 找不到可撤委托时报错', async () => {
    const mock = baseMock();
    mock.set(/qryDelegated/, [{ errorcode: 0, result: { list: [delegatedRow({ d_2105: '全部撤单' })] } }]);
    const broker = createBroker(mock);
    await expect(broker.cancelOrder('buy', '000011', 100)).rejects.toThrow(/未找到可撤委托/);
  });

  it('会话过期(-999999)自动重放绑定链并重试', async () => {
    const mock = baseMock();
    mock.set(/qryzijin/, [NOT_LOGGED_IN, ZIJIN]);
    mock.set(/cgiwt\/index\/index/, [htmlResponse(INDEX_HTML), htmlResponse(INDEX_HTML)]);
    mock.set(/getcjdbs/, [CJDBS]);
    mock.set(/trade\.php/, [new Response(null, { status: 302, headers: { location: '/cgiwt/index/doths?type=auto' } })]);
    mock.set(/doths/, [new Response(null, { status: 302, headers: { location: 'https://mncg.10jqka.com.cn/cgiwt/index/index' } })]);
    const broker = createBroker(mock);
    const snapshot = await broker.snapshotAccountOnly();
    expect(snapshot.availableCash).toBe(111806.04);
    expect(mock.calls.some((call) => call.url.includes('getcjdbs'))).toBe(true);
    expect(mock.calls.some((call) => call.url.includes('trade.php'))).toBe(true);
  });

  it('未登录时首次调用自动走绑定链', async () => {
    const mock = baseMock();
    mock.set(/cgiwt\/index\/index/, [htmlResponse(INDEX_HTML_LOGGED_OUT), htmlResponse(INDEX_HTML)]);
    mock.set(/getcjdbs/, [CJDBS]);
    mock.set(/trade\.php/, [new Response(null, { status: 302, headers: { location: '/cgiwt/index/doths?type=auto' } })]);
    mock.set(/doths/, [new Response(null, { status: 302, headers: { location: 'https://mncg.10jqka.com.cn/cgiwt/index/index' } })]);
    const broker = createBroker(mock);
    const price = await broker.quote('000011');
    expect(price).toBe(9.71);
    expect(mock.calls.some((call) => call.url.includes('getcjdbs'))).toBe(true);
  });

  it('绑定链后仍未登录时报错', async () => {
    const mock = baseMock();
    mock.set(/cgiwt\/index\/index/, [() => htmlResponse(INDEX_HTML_LOGGED_OUT)]);
    mock.set(/getcjdbs/, [CJDBS]);
    mock.set(/trade\.php/, [new Response(null, { status: 302, headers: { location: '/cgiwt/index/doths?type=auto' } })]);
    mock.set(/doths/, [new Response(null, { status: 302, headers: { location: 'https://mncg.10jqka.com.cn/cgiwt/index/index' } })]);
    const broker = createBroker(mock);
    await expect(broker.snapshotAccountOnly()).rejects.toThrow(/仍未登录/);
  });

  it('支持从 gdzhlb extend 解析股东账户（buydiv 缺失时回退）', async () => {
    const mock = baseMock();
    mock.set(/buydiv/, [htmlResponse('<html>no select here</html>')]);
    const broker = createBroker(mock);
    const result = await broker.placeOrder(makeOrder({ side: 'sell' }));
    expect(result.verified).toBe(true);
    expect(mock.calls.find((call) => call.url.includes('tradestock'))?.body).toContain('gdzh=0093561056');
  });
});
