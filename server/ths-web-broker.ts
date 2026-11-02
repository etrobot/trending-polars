import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PaperOrder, PaperPosition } from '../src/types.js';
import { NOOP_AUDIT_LOGGER, type AuditLoggerLike } from './audit-log.js';
import { round } from './format.js';
import { fetchAdjustedKlines } from './historical-market.js';
import {
  ThsSimulatedBrokerError,
  type BrokerActionResult,
  type BrokerCallContext,
  type SimulatedAccountSnapshot,
  type SimulatedBroker,
} from './ths-simulated-broker.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_URL = 'https://mncg.10jqka.com.cn';
const MONI_BASE_URL = 'http://moni.10jqka.com.cn';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0';
const DEFAULT_COOKIE_FILE = path.resolve(MODULE_DIR, '..', '..', '.tools', 'ths-cookie-bound.txt');

const NOT_LOGGED_IN_CODE = -999999;
const CANCELABLE_STATUS = ['未报', '待报', '已报', '部成', '未成交'];
const CANCELLED_MARKERS = ['已撤', '全部撤单', '部撤'];
const STATUS_KEYWORDS = ['未报', '待报', '已报', '全部成交', '部分成交', '已成交', '未成交', '全部撤单', '部撤', '已撤', '部成', '已成', '废单', '拒绝'];

export interface ThsWebBrokerOptions {
  audit?: AuditLoggerLike;
  cookie?: string;
  cookieFile?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type JsonObject = Record<string, any>;

function mkcodeOf(stockCode: string): string {
  if (/^6/.test(stockCode)) return '2';
  if (/^[03]/.test(stockCode)) return '1';
  throw new ThsSimulatedBrokerError(`同花顺 Web 模拟盘暂不支持该股票：${stockCode}（仅支持沪深 A 股）`);
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function setCookiePairs(response: Response): string[] {
  const headers = response.headers as unknown as { getSetCookie?: () => string[]; get?: (name: string) => string | null };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get?.('set-cookie') ?? null;
  return single ? [single] : [];
}

export class ThsWebSimulatedBroker implements SimulatedBroker {
  private readonly audit: AuditLoggerLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly jar = new Map<string, string>();
  private readonly gdzhByMkcode = new Map<string, string>();
  private operationQueue: Promise<void> = Promise.resolve();
  private sessionChecked = false;

  constructor(options: ThsWebBrokerOptions = {}) {
    this.audit = options.audit ?? NOOP_AUDIT_LOGGER;
    this.baseUrl = (options.baseUrl ?? process.env.THS_WEB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const raw = options.cookie
      ?? process.env.THS_WEB_COOKIE
      ?? this.readCookieFile(options.cookieFile ?? process.env.THS_WEB_COOKIE_FILE ?? DEFAULT_COOKIE_FILE);
    if (!raw) {
      throw new ThsSimulatedBrokerError(
        `缺少同花顺 Web 模拟盘 Cookie：请设置 THS_WEB_COOKIE 或提供 Cookie 文件（默认 ${DEFAULT_COOKIE_FILE}）`,
      );
    }
    Object.entries(parseCookieHeader(raw.trim())).forEach(([key, value]) => this.jar.set(key, value));
  }

  private readCookieFile(cookieFile: string): string | null {
    if (!existsSync(cookieFile)) return null;
    return readFileSync(cookieFile, 'utf8');
  }

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  private absorbCookies(response: Response): void {
    for (const line of setCookiePairs(response)) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value && value !== 'deleted') this.jar.set(key, value);
      }
    }
  }

  private async rawFetch(url: string, init: RequestInit & { allowRedirect?: boolean } = {}): Promise<Response> {
    const response = await this.fetchImpl(url, {
      ...init,
      redirect: init.allowRedirect ? 'follow' : 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'User-Agent': USER_AGENT,
        Cookie: this.cookieHeader(),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    this.absorbCookies(response);
    return response;
  }

  // ---------- 会话与绑定链 ----------

  private async checkLogin(): Promise<boolean> {
    const response = await this.rawFetch(`${this.baseUrl}/cgiwt/index/index`, {
      headers: { Referer: `${this.baseUrl}/cgiwt/index/index` },
    });
    if (!response.ok) return false;
    const html = await response.text();
    const uname = html.match(/var\s+uname\s*=\s*'([^']*)'/)?.[1] ?? '';
    return uname.length > 0;
  }

  private async rebind(context: BrokerCallContext): Promise<void> {
    const started = Date.now();
    const cjdbs = await this.rawFetch(`${MONI_BASE_URL}/mncg/index/getcjdbs/`, {
      headers: { Referer: `${MONI_BASE_URL}/mncg/` },
    });
    const cjdbsJson = (await cjdbs.json().catch(() => null)) as JsonObject | null;
    const jyUrl = cjdbsJson?.result?.data?.[0]?.jyUrlOl as string | undefined;
    if (!jyUrl) {
      throw new ThsSimulatedBrokerError(
        `同花顺模拟盘绑定失败：getcjdbs 未返回交易入口（passport 会话可能已过期）：${JSON.stringify(cjdbsJson ?? {}).slice(0, 300)}`,
      );
    }
    let url = jyUrl;
    for (let hop = 0; hop <= 6; hop += 1) {
      const response = await this.rawFetch(url, { headers: { Referer: `${MONI_BASE_URL}/mncg/` } });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url).toString();
        continue;
      }
      break;
    }
    const loggedIn = await this.checkLogin();
    await this.audit.info('ths_web_broker', 'rebind_completed', {
      traceId: context.traceId,
      durationMs: Date.now() - started,
      data: { logged_in: loggedIn },
    });
    if (!loggedIn) throw new ThsSimulatedBrokerError('同花顺 Web 模拟盘重新绑定后仍未登录，请更新 Cookie');
    this.sessionChecked = true;
  }

  private async ensureSession(context: BrokerCallContext): Promise<void> {
    if (this.sessionChecked) return;
    if (await this.checkLogin()) {
      this.sessionChecked = true;
      return;
    }
    await this.rebind(context);
  }

  // ---------- cgiwt API ----------

  private async apiPost(endpoint: string, form: Record<string, string>, context: BrokerCallContext, allowRetry = true): Promise<JsonObject> {
    await this.ensureSession(context);
    const response = await this.rawFetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Referer: `${this.baseUrl}/cgiwt/index/index`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams(form).toString(),
    });
    const payload = (await response.json().catch(() => null)) as JsonObject | null;
    if (!payload) throw new ThsSimulatedBrokerError(`${endpoint} 返回非 JSON（HTTP ${response.status}）`);
    if (payload.errorcode === NOT_LOGGED_IN_CODE && allowRetry) {
      await this.audit.warn('ths_web_broker', 'session_expired_rebinding', { traceId: context.traceId, data: { endpoint } });
      this.sessionChecked = false;
      this.gdzhByMkcode.clear();
      await this.rebind(context);
      return this.apiPost(endpoint, form, context, false);
    }
    if (payload.errorcode !== 0) {
      const message = payload.errormsg ?? payload.result?.data?.ret_msg ?? `errorcode=${payload.errorcode}`;
      throw new ThsSimulatedBrokerError(`${endpoint} 失败：${String(message).trim()}`);
    }
    return payload;
  }

  private async loadGdzhList(context: BrokerCallContext): Promise<void> {
    const response = await this.rawFetch(`${this.baseUrl}/cgiwt/index/buydiv`, {
      headers: { Referer: `${this.baseUrl}/cgiwt/index/index` },
    });
    const html = await response.text();
    const select = html.match(/<select[^>]*name=["']gddm["'][\s\S]*?<\/select>/i)?.[0] ?? html;
    for (const match of select.matchAll(/<option[^>]*value=["'](\d+)["'][^>]*>([^<]*)<\/option>/gi)) {
      const tokens = match[2].trim().split(/[\s,，]+/).filter(Boolean);
      const gdzh = tokens.find((token) => /^[A-Z]?\d{6,}$/i.test(token));
      if (gdzh) this.gdzhByMkcode.set(match[1], gdzh);
    }
  }

  private async resolveGdzh(mkcode: string, stockCode: string, context: BrokerCallContext): Promise<string> {
    const cached = this.gdzhByMkcode.get(mkcode);
    if (cached) return cached;
    if (this.gdzhByMkcode.size === 0) await this.loadGdzhList(context);
    const listed = this.gdzhByMkcode.get(mkcode);
    if (listed) return listed;
    const info = await this.qrystock(stockCode, context);
    this.parseGdzhlb(info.extend ?? '');
    const resolved = this.gdzhByMkcode.get(mkcode);
    if (!resolved) throw new ThsSimulatedBrokerError(`未能确定 ${stockCode} 所属市场的股东账户（mkcode=${mkcode}）`);
    return resolved;
  }

  private parseGdzhlb(extend: string): void {
    const segment = extend.match(/gdzhlb\*([^|]+)/)?.[1];
    if (!segment) return;
    for (const entry of segment.split(';')) {
      const [mk, value] = entry.split(',');
      if (/^\d{1,2}$/.test(mk) && value && value !== 'gdzh') this.gdzhByMkcode.set(mk, value);
    }
  }

  private async qrystock(stockCode: string, context: BrokerCallContext): Promise<{
    st_price: number | null;
    st_name: string;
    st_up_limit: number | null;
    st_down_limit: number | null;
    extend: string;
  }> {
    const payload = await this.apiPost('/cgiwt/delegate/qrystock', { type: mkcodeOf(stockCode), stockcode: stockCode }, context);
    const data = payload.result?.data ?? {};
    this.parseGdzhlb(typeof data.extend === 'string' ? data.extend : '');
    return {
      st_price: num(data.st_price),
      st_name: String(data.st_name ?? ''),
      st_up_limit: num(data.st_up_limit),
      st_down_limit: num(data.st_down_limit),
      extend: typeof data.extend === 'string' ? data.extend : '',
    };
  }

  // ---------- 快照解析 ----------

  private parsePositions(list: JsonObject[]): PaperPosition[] {
    const positions: PaperPosition[] = [];
    for (const row of list) {
      const shares = num(row.d_2117) ?? 0;
      if (shares <= 0) continue;
      const code = String(row.d_2102 ?? '');
      if (!/^\d{6}$/.test(code)) continue;
      const cost = num(row.d_2122) ?? 0;
      const current = num(row.d_2124) ?? cost;
      const marketValue = num(row.d_2125) ?? current * shares;
      const pnlAmount = num(row.d_2147) ?? (current - cost) * shares;
      const pnlPct = num(row.d_3616) ?? (cost > 0 ? (current / cost - 1) * 100 : 0);
      if (row.d_2106 && row.d_2167) this.gdzhByMkcode.set(String(row.d_2167), String(row.d_2106));
      positions.push({
        stock_code: code,
        stock_name: String(row.d_2103 ?? ''),
        shares,
        available_shares: num(row.d_2121) ?? 0,
        cost_price: round(cost, 4),
        current_price: round(current, 4),
        market_value: round(marketValue, 2),
        pnl_amount: round(pnlAmount, 2),
        pnl_pct: round(pnlPct, 4),
      });
    }
    return positions;
  }

  private parseOrders(list: JsonObject[]): PaperOrder[] {
    const orders: PaperOrder[] = [];
    for (const [index, row] of list.entries()) {
      const code = String(row.d_2102 ?? '');
      if (!/^\d{6}$/.test(code)) continue;
      const quantity = num(row.d_2126) ?? 0;
      const filled = num(row.d_2128) ?? 0;
      const price = num(row.d_2127) ?? 0;
      const side: 'buy' | 'sell' = String(row.d_2109 ?? '').includes('卖') ? 'sell' : 'buy';
      const status = this.orderStatus(row);
      const htbh = String(row.d_2135 ?? `idx-${index}`);
      const cancelable = CANCELABLE_STATUS.some((marker) => status.includes(marker)) && quantity > filled;
      orders.push({
        id: `ths-web-${htbh}`,
        side,
        stock_code: code,
        stock_name: String(row.d_2103 ?? ''),
        quantity,
        price: round(price, 4),
        amount: round(price * quantity, 2),
        status,
        reason: status,
        window: '同花顺Web当日委托',
        cancelable,
      });
    }
    return orders;
  }

  private async qryPositions(context: BrokerCallContext): Promise<JsonObject[]> {
    const gdzh = this.gdzhByMkcode.get('1') ?? this.gdzhByMkcode.get('2') ?? '';
    const payload = await this.apiPost('/cgiwt/delegate/qryChicang', { gdzh, mkcode: '1' }, context);
    return payload.result?.list ?? [];
  }

  private async qryDelegated(mkcode: string, gdzh: string, context: BrokerCallContext): Promise<JsonObject[]> {
    const payload = await this.apiPost('/cgiwt/delegate/qryDelegated', { gdzh, mkcode }, context);
    return payload.result?.list ?? [];
  }

  private buildSnapshot(funds: JsonObject, marketValue: number | null, positions: PaperPosition[], orders: PaperOrder[]): SimulatedAccountSnapshot {
    const availableCash = num(funds.kyje);
    if (availableCash == null || availableCash < 0) throw new ThsSimulatedBrokerError('未能从同花顺 Web 读取可用资金');
    if ((marketValue ?? 0) > 0 && positions.length === 0) {
      throw new ThsSimulatedBrokerError(
        `同花顺 Web 显示持仓市值 ${round(marketValue ?? 0, 2)}，但未读取到持仓明细；已拒绝用空持仓覆盖上次快照`,
      );
    }
    const totalMarketValue = marketValue ?? positions.reduce((sum, position) => sum + position.market_value, 0);
    const totalAssets = num(funds.zzc) ?? availableCash + totalMarketValue;
    if (!Number.isFinite(totalAssets) || totalAssets <= 0) throw new ThsSimulatedBrokerError('未能从同花顺 Web 读取总资产');
    return {
      availableCash: round(availableCash, 2),
      totalAssets: round(totalAssets, 2),
      positions,
      orders,
    };
  }

  // ---------- SimulatedBroker 接口 ----------

  snapshot(context: BrokerCallContext = {}): Promise<SimulatedAccountSnapshot> {
    const operation = this.exclusive(async () => {
      const started = Date.now();
      const fundsPayload = await this.apiPost('/cgiwt/delegate/qryzijin', {}, context);
      const funds = fundsPayload.result?.data ?? {};
      const positionRows = await this.qryPositions(context);
      const positions = this.parsePositions(positionRows);
      if (this.gdzhByMkcode.size === 0) await this.loadGdzhList(context);
      // qryDelegated 一次返回全市场委托，任取一个股东账户查询并去重
      const orders: PaperOrder[] = [];
      const gdzh = this.gdzhByMkcode.values().next().value as string | undefined;
      if (gdzh) {
        const seenHtbh = new Set<string>();
        for (const order of this.parseOrders(await this.qryDelegated('1', gdzh, context))) {
          if (seenHtbh.has(order.id)) continue;
          seenHtbh.add(order.id);
          orders.push(order);
        }
      }
      const snapshot = this.buildSnapshot(funds, num(fundsPayload.result?.extend?.gpsz), positions, orders);
      await this.audit.info('ths_web_broker', 'snapshot_parsed', {
        traceId: context.traceId,
        durationMs: Date.now() - started,
        data: {
          stage: context.stage,
          source: context.source,
          mode: 'full',
          available_cash: snapshot.availableCash,
          total_assets: snapshot.totalAssets,
          positions: snapshot.positions,
          orders: snapshot.orders,
        },
      });
      return snapshot;
    });
    return this.reportOperationFailure(operation, 'snapshot_failed', context);
  }

  snapshotAccountOnly(context: BrokerCallContext = {}): Promise<SimulatedAccountSnapshot> {
    const operation = this.exclusive(async () => {
      const started = Date.now();
      const fundsPayload = await this.apiPost('/cgiwt/delegate/qryzijin', {}, context);
      const funds = fundsPayload.result?.data ?? {};
      const positions = this.parsePositions(await this.qryPositions(context));
      const snapshot = this.buildSnapshot(funds, num(fundsPayload.result?.extend?.gpsz), positions, []);
      await this.audit.info('ths_web_broker', 'snapshot_parsed', {
        traceId: context.traceId,
        durationMs: Date.now() - started,
        data: {
          stage: context.stage,
          source: context.source,
          mode: 'account_only',
          available_cash: snapshot.availableCash,
          total_assets: snapshot.totalAssets,
          positions: snapshot.positions,
        },
      });
      return snapshot;
    });
    return this.reportOperationFailure(operation, 'snapshot_account_only_failed', context);
  }

  quote(stockCode: string, context: BrokerCallContext = {}): Promise<number> {
    if (!/^\d{6}$/.test(stockCode)) {
      return this.reportOperationFailure(Promise.reject(new ThsSimulatedBrokerError('股票代码必须是6位数字')), 'quote_failed', context, { stock_code: stockCode });
    }
    const operation = this.exclusive(async () => {
      try {
        const info = await this.qrystock(stockCode, context);
        if (info.st_price != null && info.st_price > 0) {
          const quote = round(info.st_price, 4);
          await this.audit.info('ths_web_broker', 'quote_read', {
            traceId: context.traceId,
            data: { stage: context.stage, stock_code: stockCode, price: quote, source: 'cgiwt_qrystock' },
          });
          return quote;
        }
      } catch (error) {
        await this.audit.warn('ths_web_broker', 'quote_fallback_start', {
          traceId: context.traceId,
          data: { stock_code: stockCode, reason: 'qrystock_failed', error: String(error), stage: context.stage },
        });
      }
      const prefix = stockCode.startsWith('6') ? 'sh' : 'sz';
      const { klines, source } = await fetchAdjustedKlines(`${prefix}${stockCode}`, 5);
      if (klines.length === 0) {
        throw new ThsSimulatedBrokerError(`未能读取 ${stockCode} 的实时价格（cgiwt 行情和 K 线接口均失败）`);
      }
      const latestBar = klines.at(-1)!;
      const price = round(latestBar.close, 4);
      await this.audit.info('ths_web_broker', 'quote_read', {
        traceId: context.traceId,
        data: { stage: context.stage, stock_code: stockCode, price, source: `kline_${source}` },
      });
      return price;
    });
    return this.reportOperationFailure(operation, 'quote_failed', context, { stock_code: stockCode });
  }

  placeOrder(order: PaperOrder, context: BrokerCallContext = {}): Promise<BrokerActionResult> {
    const operation = this.exclusive(async () => {
      const started = Date.now();
      if (!/^\d{6}$/.test(order.stock_code)) throw new ThsSimulatedBrokerError(`无效股票代码：${order.stock_code}`);
      if (!Number.isInteger(order.quantity) || order.quantity <= 0) throw new ThsSimulatedBrokerError(`无效委托数量：${order.quantity}`);
      const mkcode = mkcodeOf(order.stock_code);
      const info = await this.qrystock(order.stock_code, context);
      const gdzh = await this.resolveGdzh(mkcode, order.stock_code, context);
      const price = order.price > 0 ? order.price : info.st_price;
      if (price == null || price <= 0) throw new ThsSimulatedBrokerError(`无法确定 ${order.stock_code} 的委托价格`);
      if (info.st_up_limit != null && price > info.st_up_limit) {
        throw new ThsSimulatedBrokerError(`委托价 ${price} 高于 ${order.stock_code} 涨停价 ${info.st_up_limit}`);
      }
      if (info.st_down_limit != null && price < info.st_down_limit) {
        throw new ThsSimulatedBrokerError(`委托价 ${price} 低于 ${order.stock_code} 跌停价 ${info.st_down_limit}`);
      }
      const type = order.side === 'buy' ? 'cmd_wt_mairu' : 'cmd_wt_maichu';
      const payload = await this.apiPost('/cgiwt/delegate/tradestock', {
        type,
        mkcode,
        gdzh,
        stockcode: order.stock_code,
        price: String(price),
        amount: String(order.quantity),
      }, context);
      const htbh = String(payload.result?.data?.htbh ?? '');
      const brokerOutput = JSON.stringify(payload.result?.data ?? payload).slice(0, 2_000);
      let verified = false;
      if (htbh) {
        const rows = await this.qryDelegated(mkcode, gdzh, context);
        verified = rows.some((row) => String(row.d_2135 ?? '') === htbh);
      }
      if (!verified) throw new ThsSimulatedBrokerError(`委托已提交但回查失败：${order.stock_code}（合同编号 ${htbh || '未知'}）`);
      const result: BrokerActionResult = {
        verified,
        brokerOutput,
        executionPrice: round(price, 4),
        executionQuantity: order.quantity,
      };
      await this.audit.info('ths_web_broker', 'order_verified', {
        traceId: context.traceId,
        durationMs: Date.now() - started,
        data: { stage: context.stage, requested_order: order, htbh, result },
      });
      return result;
    });
    return this.reportOperationFailure(operation, 'order_failed', context, { order });
  }

  cancelOrder(side: 'buy' | 'sell', stockCode: string, quantity: number, context: BrokerCallContext = {}): Promise<BrokerActionResult> {
    const operation = this.exclusive(async () => {
      const started = Date.now();
      const mkcode = mkcodeOf(stockCode);
      const gdzh = await this.resolveGdzh(mkcode, stockCode, context);
      let match: JsonObject | undefined;
      for (let attempt = 0; attempt < 3 && !match; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800));
        const rows = await this.qryDelegated(mkcode, gdzh, context);
        match = rows.find((row) => {
          if (String(row.d_2102 ?? '') !== stockCode) return false;
          const rowSide: 'buy' | 'sell' = String(row.d_2109 ?? '').includes('卖') ? 'sell' : 'buy';
          if (rowSide !== side) return false;
          if (quantity > 0 && (num(row.d_2126) ?? 0) !== quantity) return false;
          const status = this.orderStatus(row);
          return CANCELABLE_STATUS.some((marker) => status.includes(marker));
        });
      }
      if (!match) throw new ThsSimulatedBrokerError(`同花顺 Web 当日委托中未找到可撤委托：${side} ${stockCode} ${quantity}`);
      const htbh = String(match.d_2135 ?? '');
      const wtrq = String(match.d_2139 ?? '');
      if (!htbh || !wtrq) throw new ThsSimulatedBrokerError(`委托记录缺少合同编号/委托日期：${stockCode}`);
      const payload = await this.apiPost('/cgiwt/delegate/cancelDelegated', { htbh, wtrq }, context);
      let verified = false;
      for (let attempt = 0; attempt < 3 && !verified; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800));
        const after = await this.qryDelegated(mkcode, gdzh, context);
        const still = after.find((row) => String(row.d_2135 ?? '') === htbh);
        if (!still) verified = true;
        else {
          const status = this.orderStatus(still);
          if (CANCELLED_MARKERS.some((marker) => status.includes(marker))) verified = true;
        }
      }
      const brokerOutput = JSON.stringify(payload.result?.data ?? payload).slice(0, 2_000);
      if (!verified) throw new ThsSimulatedBrokerError(`撤单已提交但回查失败：${stockCode}（合同编号 ${htbh}）`);
      const result: BrokerActionResult = { verified, brokerOutput };
      await this.audit.info('ths_web_broker', 'cancel_verified', {
        traceId: context.traceId,
        durationMs: Date.now() - started,
        data: { stage: context.stage, side, stock_code: stockCode, quantity, htbh, result },
      });
      return result;
    });
    return this.reportOperationFailure(operation, 'cancel_failed', context, { side, stock_code: stockCode, quantity });
  }

  private orderStatus(row: JsonObject): string {
    const direct = String(row.d_2105 ?? '');
    if (direct) return direct;
    const found = Object.values(row).find((value) => typeof value === 'string' && STATUS_KEYWORDS.some((keyword) => value.includes(keyword)));
    if (typeof found === 'string') return found;
    const quantity = num(row.d_2126) ?? 0;
    const filled = num(row.d_2128) ?? 0;
    if (quantity > 0 && filled >= quantity) return '全部成交';
    return filled > 0 ? '部成' : '已报';
  }

  // ---------- 通用工具 ----------

  private async reportOperationFailure<T>(operation: Promise<T>, event: string, context: BrokerCallContext, data: Record<string, unknown> = {}): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      await this.audit.error('ths_web_broker', event, {
        traceId: context.traceId,
        data: { stage: context.stage, source: context.source, ...data },
        error,
      });
      throw error;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
