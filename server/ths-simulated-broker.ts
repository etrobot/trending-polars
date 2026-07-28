import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PaperOrder, PaperPosition } from '../src/types.js';
import { NOOP_AUDIT_LOGGER, type AuditLoggerLike } from './audit-log.js';
import { round } from './format.js';
import { fetchAdjustedKlines } from './historical-market.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_THS_SCRIPT = path.resolve(MODULE_DIR, '..', 'scripts', 'ths_order_dry_run.applescript');

const SIMULATOR_MARKER = 'THS_SIMULATOR_V1';
const SIMULATION_CONFIRMED = 'SIMULATION|confirmed';
const NUMBER_RE = /[-+]?\d[\d,]*(?:\.\d+)?/;
const CODE_RE = /^(?:sh|sz)?(\d{6})$/i;

type HeaderAliases = Record<string, readonly string[]>;

const POSITION_HEADER_ALIASES: HeaderAliases = {
  code: ['证券代码', '股票代码', '代码'],
  name: ['证券名称', '股票名称', '名称'],
  total: ['股票余额', '证券数量', '持仓数量', '股份余额', '总数量'],
  available: ['可用余额', '可卖数量', '可用股份', '可用数量'],
  cost: ['成本价', '成本价格'],
  current: ['当前价', '最新价', '市价', '现价'],
  market_value: ['股票市值', '证券市值', '持仓市值', '市值'],
  pnl_pct: ['盈亏比例', '盈亏率', '收益率'],
  pnl_amount: ['总盈亏', '浮动盈亏', '参考盈亏', '盈亏金额'],
};

const ORDER_HEADER_ALIASES: HeaderAliases = {
  code: ['证券代码', '股票代码', '代码'],
  name: ['证券名称', '股票名称', '名称'],
  side: ['买卖标志', '委托类别', '买卖方向', '方向', '操作'],
  quantity: ['委托数量', '申报数量', '数量'],
  price: ['委托价格', '申报价格', '价格'],
  status: ['委托状态', '状态', '备注'],
};

export class ThsSimulatedBrokerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ThsSimulatedBrokerError';
  }
}

export interface ThsFundsSnapshot {
  availableCash: number | null;
  totalAssets: number | null;
  marketValue: number | null;
  withdrawableCash: number | null;
}

export interface SimulatedAccountSnapshot {
  availableCash: number;
  totalAssets: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
}

export interface BrokerActionResult {
  verified: boolean;
  brokerOutput: string;
  executionPrice?: number;
  executionQuantity?: number;
}

export interface BrokerCallContext {
  traceId?: string;
  stage?: string;
  source?: string;
  hintStockCodes?: string[];
}

export interface SimulatedBroker {
  snapshot(context?: BrokerCallContext): Promise<SimulatedAccountSnapshot>;
  snapshotAccountOnly(context?: BrokerCallContext): Promise<SimulatedAccountSnapshot>;
  quote(stockCode: string, context?: BrokerCallContext): Promise<number>;
  placeOrder(order: PaperOrder, context?: BrokerCallContext): Promise<BrokerActionResult>;
  cancelOrder(side: 'buy' | 'sell', stockCode: string, quantity: number, context?: BrokerCallContext): Promise<BrokerActionResult>;
}

export type ThsCommandRunner = (args: string[]) => Promise<string>;

function requireSimulationMarker(output: string) {
  if (!output.includes(SIMULATOR_MARKER) || !output.includes(SIMULATION_CONFIRMED)) {
    throw new ThsSimulatedBrokerError('无法确认当前是同花顺模拟交易窗口');
  }
}

function snapshotRows(output: string): string[][] {
  return output.split(/\r?\n/)
    .filter((line) => line.startsWith('ROW|'))
    .map((line) => line.split('|').slice(1).map((cell) => cell.trim()).filter(Boolean));
}

function snapshotTokens(output: string): string[] {
  return output.split(/\r?\n/)
    .filter((line) => line.startsWith('TEXT|') || line.startsWith('ROW|'))
    .flatMap((line) => line.split('|').slice(1).map((token) => token.trim()).filter(Boolean));
}

function toNumber(value: string): number | null {
  const match = value.replace('％', '%').match(NUMBER_RE);
  if (!match) return null;
  const number = Number(match[0].replaceAll(',', ''));
  return Number.isFinite(number) ? number : null;
}

function toInteger(value: string): number | null {
  const number = toNumber(value);
  return number != null && number >= 0 && Number.isInteger(number) ? number : null;
}

function labelledNumber(tokens: string[], labels: readonly string[]): number | null {
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const compact = tokens[tokenIndex].replace(/\s+/g, '');
    for (const label of labels) {
      const labelIndex = compact.indexOf(label);
      if (labelIndex < 0) continue;
      const suffix = compact.slice(labelIndex + label.length).replace(/^[:：]+/, '');
      const inlineValue = toNumber(suffix);
      if (inlineValue != null) return inlineValue;
      for (const following of tokens.slice(tokenIndex + 1, tokenIndex + 4)) {
        const followingValue = toNumber(following);
        if (followingValue != null) return followingValue;
      }
    }
  }
  return null;
}

function headerIndexes(rows: string[][], aliases: HeaderAliases): Record<string, number> {
  for (const row of rows) {
    const joined = row.join('|');
    if (!aliases.code.some((label) => joined.includes(label))) continue;
    const indexes: Record<string, number> = {};
    row.forEach((cell, index) => {
      const compact = cell.replace(/\s+/g, '');
      for (const [key, names] of Object.entries(aliases)) {
        if (names.some((name) => compact.includes(name))) {
          indexes[key] = index;
          break;
        }
      }
    });
    if (indexes.code != null) return indexes;
  }
  return {};
}

function cell(row: string[], indexes: Record<string, number>, key: string): string {
  const index = indexes[key];
  return index == null || index >= row.length ? '' : row[index];
}

function fullStockCode(value: string): string | null {
  return value.match(CODE_RE)?.[1] ?? null;
}

function stockCodeInRow(row: string[]): string | null {
  for (const value of row) {
    const code = fullStockCode(value);
    if (code) return code;
  }
  return null;
}

function normalizePosition(values: {
  code: string;
  name: string;
  total: number | null;
  available: number | null;
  cost: number | null;
  current: number | null;
  marketValue: number | null;
  pnlPct: number | null;
  pnlAmount: number | null;
}): PaperPosition | null {
  if (values.total == null) {
    throw new ThsSimulatedBrokerError(`同花顺持仓 ${values.code} 缺少可识别的持仓数量`);
  }
  if (values.total <= 0) return null;
  const cost = values.cost ?? 0;
  const current = values.current ?? cost;
  const marketValue = values.marketValue ?? current * values.total;
  const pnlAmount = values.pnlAmount ?? (current - cost) * values.total;
  const pnlPct = values.pnlPct ?? (cost > 0 ? (current / cost - 1) * 100 : 0);
  return {
    stock_code: values.code,
    stock_name: values.name,
    shares: values.total,
    available_shares: values.available ?? 0,
    cost_price: round(cost, 4),
    current_price: round(current, 4),
    market_value: round(marketValue, 2),
    pnl_amount: round(pnlAmount, 2),
    pnl_pct: round(pnlPct, 4),
  };
}

export function parseThsFundsSnapshot(output: string): ThsFundsSnapshot {
  requireSimulationMarker(output);
  const tokens = snapshotTokens(output);
  return {
    availableCash: labelledNumber(tokens, ['可用资金', '资金可用', '可用金额']),
    totalAssets: labelledNumber(tokens, ['总资产', '资产总值']),
    marketValue: labelledNumber(tokens, ['股票市值', '证券市值', '持仓市值', '总市值']),
    withdrawableCash: labelledNumber(tokens, ['可取资金', '资金可取', '可取金额']),
  };
}

export function parseThsPositionsSnapshot(output: string): PaperPosition[] {
  requireSimulationMarker(output);
  const rows = snapshotRows(output);
  const indexes = headerIndexes(rows, POSITION_HEADER_ALIASES);
  const positions: PaperPosition[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const code = stockCodeInRow(row);
    if (!code || seen.has(code)) continue;
    let position: PaperPosition | null;
    if (Object.keys(indexes).length > 0) {
      position = normalizePosition({
        code,
        name: cell(row, indexes, 'name'),
        total: toInteger(cell(row, indexes, 'total')),
        available: toInteger(cell(row, indexes, 'available')),
        cost: toNumber(cell(row, indexes, 'cost')),
        current: toNumber(cell(row, indexes, 'current')),
        marketValue: toNumber(cell(row, indexes, 'market_value')),
        pnlPct: toNumber(cell(row, indexes, 'pnl_pct')),
        pnlAmount: toNumber(cell(row, indexes, 'pnl_amount')),
      });
    } else {
      const codeIndex = row.findIndex((value) => fullStockCode(value) === code);
      const swiftCells = row.slice(codeIndex);
      if (swiftCells.length < 13 || !fullStockCode(swiftCells[0])) {
        throw new ThsSimulatedBrokerError(`无法识别同花顺持仓行结构：${code}`);
      }
      position = normalizePosition({
        code,
        name: swiftCells[1] ?? '',
        current: toNumber(swiftCells[2] ?? ''),
        pnlAmount: toNumber(swiftCells[3] ?? ''),
        pnlPct: toNumber(swiftCells[5] ?? ''),
        total: toInteger(swiftCells[6] ?? ''),
        available: toInteger(swiftCells[8] ?? ''),
        cost: toNumber(swiftCells[10] ?? ''),
        marketValue: toNumber(swiftCells[11] ?? ''),
      });
    }
    seen.add(code);
    if (position) positions.push(position);
  }
  return positions;
}

function isCancelableStatus(status: string): boolean {
  return !['已撤', '全部成交', '已成', '废单', '拒绝', '已取消'].some((marker) => status.includes(marker));
}

export function parseThsOrdersSnapshot(output: string): PaperOrder[] {
  requireSimulationMarker(output);
  const rows = snapshotRows(output);
  const indexes = headerIndexes(rows, ORDER_HEADER_ALIASES);
  const orders: PaperOrder[] = [];

  for (const [rowIndex, row] of rows.entries()) {
    const code = stockCodeInRow(row);
    if (!code) continue;
    const joined = row.join(' ');
    const sideText = Object.keys(indexes).length > 0 ? cell(row, indexes, 'side') : joined;
    const side = sideText.includes('买') ? 'buy' : sideText.includes('卖') ? 'sell' : null;
    if (!side) continue;
    const quantity = Object.keys(indexes).length > 0 ? toInteger(cell(row, indexes, 'quantity')) ?? 0 : 0;
    const price = Object.keys(indexes).length > 0 ? toNumber(cell(row, indexes, 'price')) ?? 0 : 0;
    const status = Object.keys(indexes).length > 0
      ? cell(row, indexes, 'status')
      : ['未报', '已报', '部成', '已撤', '全部成交', '废单', '拒绝'].find((marker) => joined.includes(marker)) ?? '';
    orders.push({
      id: `ths-${side}-${code}-${quantity}-${rowIndex}`,
      side,
      stock_code: code,
      stock_name: Object.keys(indexes).length > 0 ? cell(row, indexes, 'name') : '',
      quantity,
      price: round(price, 4),
      amount: round(price * quantity, 2),
      status,
      reason: status,
      window: '同花顺当日委托',
      cancelable: quantity > 0 && isCancelableStatus(status),
    });
  }
  return orders;
}

function defaultRunner(scriptPath: string, timeoutMs: number): ThsCommandRunner {
  return (args) => new Promise((resolve, reject) => {
    execFile('osascript', [scriptPath, ...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const processError = error as Error & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number | null };
        const timedOut = processError.killed || processError.signal === 'SIGTERM' || processError.code === 'ETIMEDOUT';
        const message = timedOut
          ? `同花顺 AppleScript 读取超时（${Math.round(timeoutMs / 1000)} 秒）：${args.join(' ')}。请确认同花顺模拟交易窗口位于当前桌面、未最小化且屏幕未锁定`
          : String(stderr || stdout || error.message).trim();
        reject(new ThsSimulatedBrokerError(message || '同花顺 AppleScript 执行失败', { cause: error }));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

export class ThsSimulatedBroker implements SimulatedBroker {
  private readonly runCommand: ThsCommandRunner;
  private readonly audit: AuditLoggerLike;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: { scriptPath?: string; timeoutMs?: number; runner?: ThsCommandRunner; audit?: AuditLoggerLike } = {}) {
    const scriptPath = options.scriptPath ?? DEFAULT_THS_SCRIPT;
    if (!options.runner && !existsSync(scriptPath)) {
      throw new ThsSimulatedBrokerError(`同花顺 AppleScript 不存在：${scriptPath}`);
    }
    this.runCommand = options.runner ?? defaultRunner(scriptPath, options.timeoutMs ?? 30_000);
    this.audit = options.audit ?? NOOP_AUDIT_LOGGER;
  }

  snapshot(context: BrokerCallContext = {}): Promise<SimulatedAccountSnapshot> {
    const operation = this.exclusive(async () => {
      const started = Date.now();
      const accountArgs = ['snapshot', 'account'];
      const hints = (context.hintStockCodes ?? []).filter((code) => /^\d{6}$/.test(code));
      if (hints.length > 0) accountArgs.push(hints.join(','));
      const accountOutput = await this.loggedCommand(accountArgs, context);
      const ordersOutput = await this.loggedCommand(['snapshot', 'orders'], context);
      const snapshot = this.parseAccountSnapshotParts(
        parseThsFundsSnapshot(accountOutput),
        parseThsPositionsSnapshot(accountOutput),
        parseThsOrdersSnapshot(ordersOutput),
      );
      await this.audit.info('ths_broker', 'snapshot_parsed', {
        traceId: context.traceId,
        durationMs: Date.now() - started,
        data: {
          stage: context.stage,
          source: context.source,
          mode: 'full',
          hint_stock_codes: hints,
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
      const args = ['snapshot', 'account'];
      const hints = (context.hintStockCodes ?? []).filter((code) => /^\d{6}$/.test(code));
      if (hints.length > 0) args.push(hints.join(','));
      const output = await this.loggedCommand(args, context);
      const snapshot = this.parseAccountSnapshot(output);
      await this.audit.info('ths_broker', 'snapshot_parsed', {
        traceId: context.traceId,
        durationMs: Date.now() - started,
        data: {
          stage: context.stage,
          source: context.source,
          mode: 'account_only',
          hint_stock_codes: hints,
          available_cash: snapshot.availableCash,
          total_assets: snapshot.totalAssets,
          positions: snapshot.positions,
          orders: snapshot.orders,
        },
      });
      return snapshot;
    });
    return this.reportOperationFailure(operation, 'snapshot_account_only_failed', context);
  }

  parseAccountSnapshot(output: string): SimulatedAccountSnapshot {
    return this.parseAccountSnapshotParts(
      parseThsFundsSnapshot(output),
      parseThsPositionsSnapshot(output),
      [],
    );
  }

  private parseAccountSnapshotParts(
    funds: ThsFundsSnapshot,
    positions: PaperPosition[],
    orders: PaperOrder[],
  ): SimulatedAccountSnapshot {
    if ((funds.marketValue ?? 0) > 0 && positions.length === 0) {
      throw new ThsSimulatedBrokerError(
        `同花顺显示持仓市值 ${round(funds.marketValue ?? 0, 2)}，但未读取到持仓明细；已拒绝用空持仓覆盖上次快照`,
      );
    }
    const marketValue = funds.marketValue ?? positions.reduce((sum, position) => sum + position.market_value, 0);
    if (funds.availableCash == null || funds.availableCash < 0) {
      throw new ThsSimulatedBrokerError('未能从同花顺读取可用资金');
    }
    const totalAssets = funds.totalAssets ?? funds.availableCash + marketValue;
    if (!Number.isFinite(totalAssets) || totalAssets <= 0) {
      throw new ThsSimulatedBrokerError('未能从同花顺读取总资产');
    }
    return {
      availableCash: round(funds.availableCash, 2),
      totalAssets: round(totalAssets, 2),
      positions,
      orders,
    };
  }

  quote(stockCode: string, context: BrokerCallContext = {}): Promise<number> {
    if (!/^\d{6}$/.test(stockCode)) {
      return this.reportOperationFailure(Promise.reject(new ThsSimulatedBrokerError('股票代码必须是6位数字')), 'quote_failed', context, { stock_code: stockCode });
    }
    const operation = this.exclusive(async () => {
      // 先尝试同花顺模拟交易 UI 实时报价
      try {
        const output = await this.loggedCommand(['quote', stockCode], context);
        requireSimulationMarker(output);
        const match = output.match(new RegExp(`^QUOTE\\|${stockCode}\\|([^\\r\\n]+)$`, 'm'));
        const price = match ? toNumber(match[1]) : null;
        if (price != null && price > 0) {
          const quote = round(price, 4);
          await this.audit.info('ths_broker', 'quote_read', {
            traceId: context.traceId,
            data: { stage: context.stage, stock_code: stockCode, price: quote, source: 'ths_applescript' },
          });
          return quote;
        }
        await this.audit.warn('ths_broker', 'quote_fallback_start', {
          traceId: context.traceId,
          data: { stock_code: stockCode, reason: 'ths_price_unavailable', stage: context.stage },
        });
      } catch (thError) {
        await this.audit.warn('ths_broker', 'quote_fallback_start', {
          traceId: context.traceId,
          data: { stock_code: stockCode, reason: 'ths_applescript_failed', error: String(thError), stage: context.stage },
        });
      }
      // 回退到 K 线接口获取最新收盘价
      const prefix = stockCode.startsWith('6') ? 'sh' : 'sz';
      const { klines, source } = await fetchAdjustedKlines(`${prefix}${stockCode}`, 5);
      if (klines.length === 0) {
        throw new ThsSimulatedBrokerError(`未能读取 ${stockCode} 的实时价格（同花顺模拟交易和 K 线接口均失败）`);
      }
      const latestBar = klines.at(-1)!;
      const price = round(latestBar.close, 4);
      await this.audit.info('ths_broker', 'quote_read', {
        traceId: context.traceId,
        data: { stage: context.stage, stock_code: stockCode, price, source: `kline_${source}`, kline_date: latestBar.date },
      });
      return price;
    });
    return this.reportOperationFailure(operation, 'quote_failed', context, { stock_code: stockCode });
  }

  placeOrder(order: PaperOrder, context: BrokerCallContext = {}): Promise<BrokerActionResult> {
    const operation = this.exclusive(async () => {
      const output = await this.loggedCommand(['order', order.side, order.stock_code, 'AUTO', String(order.quantity)], context);
      const verified = output.includes('ORDER_VERIFIED|') && output.includes(order.stock_code);
      if (!verified) throw new ThsSimulatedBrokerError(`委托已提交但回查失败：${order.stock_code}`);
      const submitted = output.match(new RegExp(`^ORDER_SUBMITTED\\|${order.side}\\|${order.stock_code}\\|([^|\\r\\n]+)\\|([^\\r\\n]+)$`, 'm'));
      const result = {
        verified,
        brokerOutput: output,
        executionPrice: submitted ? toNumber(submitted[1]) ?? undefined : undefined,
        executionQuantity: submitted ? toInteger(submitted[2]) ?? undefined : undefined,
      };
      await this.audit.info('ths_broker', 'order_verified', {
        traceId: context.traceId,
        data: { stage: context.stage, requested_order: order, result },
      });
      return result;
    });
    return this.reportOperationFailure(operation, 'order_failed', context, { order });
  }

  cancelOrder(side: 'buy' | 'sell', stockCode: string, quantity: number, context: BrokerCallContext = {}): Promise<BrokerActionResult> {
    const operation = this.exclusive(async () => {
      const output = await this.loggedCommand(['cancel', side, stockCode, String(quantity)], context);
      const verified = output.includes('CANCEL_VERIFIED|') && output.includes(stockCode);
      if (!verified) throw new ThsSimulatedBrokerError(`撤单已操作但回查失败：${stockCode}`);
      const result = { verified, brokerOutput: output };
      await this.audit.info('ths_broker', 'cancel_verified', {
        traceId: context.traceId,
        data: { stage: context.stage, side, stock_code: stockCode, quantity, result },
      });
      return result;
    });
    return this.reportOperationFailure(operation, 'cancel_failed', context, { side, stock_code: stockCode, quantity });
  }

  private async reportOperationFailure<T>(
    operation: Promise<T>,
    event: string,
    context: BrokerCallContext,
    data: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      await this.audit.error('ths_broker', event, {
        traceId: context.traceId,
        data: { stage: context.stage, source: context.source, ...data },
        error,
      });
      throw error;
    }
  }

  private async loggedCommand(args: string[], context: BrokerCallContext): Promise<string> {
    const started = Date.now();
    await this.audit.info('ths_applescript', 'command_started', {
      traceId: context.traceId,
      data: { stage: context.stage, source: context.source, args },
    });
    try {
      const output = await this.runCommand(args);
      const maxOutput = 200_000;
      await this.audit.info('ths_applescript', 'command_completed', {
        traceId: context.traceId,
        durationMs: Date.now() - started,
        data: {
          stage: context.stage,
          source: context.source,
          args,
          output: output.slice(0, maxOutput),
          output_length: output.length,
          output_truncated: output.length > maxOutput,
        },
      });
      return output;
    } catch (error) {
      await this.audit.error('ths_applescript', 'command_failed', {
        traceId: context.traceId,
        durationMs: Date.now() - started,
        data: { stage: context.stage, source: context.source, args },
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
