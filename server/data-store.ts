import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AnalysisData,
  BacktestListItem,
  BacktestResult,
  PaperTradingRuntimeState,
  RankingResponse,
  RankingRow,
} from '../src/types.js';
import type { HistoricalMarketData, KLineData } from './historical-market.js';
import { formatDateTime } from './format.js';
import {
  SqliteStore,
  type DailyPriceCoverage,
  type LimitUpRecord,
  type RankingFactorRecord,
  type SectorTrendRecord,
  type StoredDailyPrice,
} from './sqlite-store.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = path.join(MODULE_DIR, 'data');

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function emptyAnalysis(): AnalysisData {
  return {
    timestamp: formatDateTime(),
    indices: [],
    blocks: [],
    sentiment: { total_blocks: 0, total_limit_up: 0, sentiment: 'cold' },
  };
}

function emptyRanking(): { timestamp: string; date: string; total_stocks: number; rankings: RankingRow[] } {
  const timestamp = formatDateTime();
  return {
    timestamp,
    date: timestamp.slice(0, 10).replaceAll('-', ''),
    total_stocks: 0,
    rankings: [],
  };
}

/**
 * Promote a limit-up cohort into an unscored ranking universe. The cross-section
 * engine only needs stock_code/stock_name to collect history; the remaining
 * fields carry sector context forward and default to a "待计算" placeholder until
 * the factors are computed.
 */
function universeFromLimitUp(records: LimitUpRecord[]): RankingRow[] {
  const byCode = new Map<string, RankingRow>();
  for (const record of records) {
    const code = String(record.stock_code ?? '').trim();
    if (!/^\d{6}$/.test(code) || byCode.has(code)) continue;
    byCode.set(code, {
      rank: byCode.size + 1,
      stock_code: code,
      stock_name: record.stock_name || code,
      total_score: 0,
      trend_score: 0,
      alignment: '',
      strategy_action: 'ignore',
      strategy_label: '待计算',
      strategy_position: '—',
      sector_code: record.sector_code || undefined,
      sector_name: record.sector_name || undefined,
      continue_num: record.continue_num,
      reason_type: record.reason_type || undefined,
      latest_price: record.latest,
      latest_change_rate: record.change_rate,
    });
  }
  return [...byCode.values()];
}

async function writeJson(filePath: string, value: unknown, pretty = true): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, pretty ? 2 : 0), 'utf8');
    await rename(tempPath, filePath);
  } finally {
    await unlinkIfExists(tempPath);
  }
}

export class DataStore {
  readonly root: string;
  readonly runtime: string;
  readonly databasePath: string;
  private readonly sqlite: SqliteStore;

  constructor(root = DEFAULT_DATA_DIR) {
    this.root = root;
    this.runtime = path.join(root, 'runtime');
    this.sqlite = new SqliteStore(root);
    this.databasePath = this.sqlite.databasePath;
  }

  private async runtimeFirstOrNull<T>(name: string): Promise<T | null> {
    for (const filePath of [path.join(this.runtime, name), path.join(this.root, name)]) {
      if (!(await exists(filePath))) continue;
      try {
        return await readJson<T>(filePath);
      } catch {
        // Cache corruption must not make canonical SQLite data unavailable.
      }
    }
    return null;
  }

  private async renormalizeStoredRanking(): Promise<void> {
    const ranking = this.sqlite.loadRanking();
    if (!ranking) return;
    const normalized = this.sqlite.saveRanking(ranking);
    await writeJson(path.join(this.runtime, 'ranking.json'), normalized);
  }

  private async deletedBacktests(): Promise<Set<string>> {
    const tombstone = path.join(this.runtime, 'deleted-backtests.json');
    if (!(await exists(tombstone))) return new Set();
    try {
      const ids = await readJson<string[]>(tombstone);
      return new Set(ids);
    } catch {
      return new Set();
    }
  }

  private async saveDeletedBacktests(ids: Set<string>): Promise<void> {
    await writeJson(path.join(this.runtime, 'deleted-backtests.json'), [...ids].sort());
  }

  async getAnalysis(): Promise<AnalysisData> {
    const cached = await this.runtimeFirstOrNull<AnalysisData>('analysis.json');
    let stored = this.sqlite.loadAnalysis();
    if (!stored && cached?.blocks?.length) {
      this.sqlite.saveAnalysis(cached);
      await this.renormalizeStoredRanking();
      stored = this.sqlite.loadAnalysis();
    }
    if (!stored) return cached ?? emptyAnalysis();
    if (!cached) return stored;

    // Structured block/limit-up facts are canonical in SQLite. JSON only fills
    // cache-only fields (notably index analysis and aggregate stats).
    const timestamp = [stored.timestamp, cached.timestamp]
      .filter(Boolean)
      .sort()
      .at(-1) ?? stored.timestamp;
    return {
      ...cached,
      ...stored,
      timestamp,
      indices: cached.indices ?? [],
      blocks: stored.blocks,
      sentiment: stored.sentiment,
    };
  }

  async saveAnalysis(data: AnalysisData, date?: string): Promise<void> {
    this.sqlite.saveAnalysis(data, date);
    await this.renormalizeStoredRanking();
    const sourceDate = String(date || data.source_date || data.timestamp).replace(/\D/g, '').slice(0, 8);
    await writeJson(path.join(this.runtime, 'analysis.json'), {
      ...data,
      ...(sourceDate ? { source_date: sourceDate } : {}),
    });
  }

  /** Refresh cache-only analysis fields without creating block_top facts. */
  async saveAnalysisCache(data: AnalysisData): Promise<void> {
    const sourceDate = data.source_date ?? this.sqlite.getLatestAnalysisDate() ?? undefined;
    await writeJson(path.join(this.runtime, 'analysis.json'), {
      ...data,
      ...(sourceDate ? { source_date: sourceDate } : {}),
    });
  }

  async getRanking(): Promise<{ timestamp: string; date: string; total_stocks: number; rankings: RankingRow[] }> {
    const stored = this.sqlite.loadRanking();
    if (stored) return stored;
    await this.getAnalysis();
    const seed = await this.runtimeFirstOrNull<{ timestamp: string; date: string; total_stocks: number; rankings: RankingRow[] }>('ranking.json');
    if (!seed) return emptyRanking();
    const normalized = this.sqlite.saveRanking(seed);
    await writeJson(path.join(this.runtime, 'ranking.json'), normalized);
    return normalized;
  }

  /**
   * The stock pool for cross-section scoring. Returns the computed ranking when
   * one exists, otherwise derives an unscored universe from the latest limit-up
   * cohort so ranking/backtest/paper-trading can bootstrap on a database that
   * only holds analysis facts. getRanking() stays scored-only so the board view
   * and clearRankingData() semantics are unchanged.
   */
  async getRankingUniverse(): Promise<{ timestamp: string; date: string; total_stocks: number; rankings: RankingRow[] }> {
    const ranking = await this.getRanking();
    if (ranking.rankings.length) return ranking;
    const date = this.sqlite.getLatestAnalysisDate();
    if (!date) return ranking;
    const rankings = universeFromLimitUp(this.sqlite.getLimitUpByDate(date));
    if (!rankings.length) return ranking;
    return { timestamp: formatDateTime(), date, total_stocks: rankings.length, rankings };
  }

  async saveRanking(data: Pick<RankingResponse, 'timestamp' | 'date' | 'total_stocks' | 'rankings'>): Promise<void> {
    const normalized = this.sqlite.saveRanking(data);
    await writeJson(path.join(this.runtime, 'ranking.json'), normalized);
  }

  async getHistoricalMarket(): Promise<HistoricalMarketData | null> {
    const stored = this.sqlite.loadHistoricalMarket();
    if (stored) return stored;
    const legacy = await this.runtimeFirstOrNull<HistoricalMarketData>('historical-market.json');
    if (!legacy) return null;
    this.sqlite.saveHistoricalMarket(legacy);
    return this.sqlite.loadHistoricalMarket();
  }

  async saveHistoricalMarket(data: HistoricalMarketData): Promise<void> {
    this.sqlite.saveHistoricalMarket(data);
  }

  async getLimitUpByDate(date: string): Promise<LimitUpRecord[]> {
    return this.sqlite.getLimitUpByDate(date);
  }

  async getLatestAnalysisDate(): Promise<string | null> {
    return this.sqlite.getLatestAnalysisDate();
  }

  async getSectorStats(date: string) {
    return this.sqlite.getSectorStats(date);
  }

  async loadAllLimitUpCodes() {
    return this.sqlite.loadAllLimitUpCodes();
  }

  async getSectorTrendsForDate(date: string): Promise<SectorTrendRecord[]> {
    return this.sqlite.getSectorTrendsForDate(date);
  }

  async getRankingFactorsForDate(date: string): Promise<RankingFactorRecord[]> {
    return this.sqlite.getRankingFactorsForDate(date);
  }

  async clearRankingData(): Promise<void> {
    this.sqlite.clearRankingData();
    await Promise.all([
      unlinkIfExists(path.join(this.runtime, 'ranking.json')),
      unlinkIfExists(path.join(this.root, 'ranking.json')),
    ]);
  }

  async upsertStockPrices(stockCode: string, stockName: string, klines: KLineData[]): Promise<number> {
    return this.sqlite.upsertStockPrices(stockCode, stockName, klines);
  }

  async getStockPrices(stockCode: string, limit = 120): Promise<KLineData[]> {
    return this.sqlite.getStockPrices(stockCode, limit);
  }

  async getStockName(stockCode: string): Promise<string | null> {
    return this.sqlite.getStockName(stockCode);
  }

  async upsertIndexPrices(symbol: string, indexName: string, klines: KLineData[]): Promise<number> {
    return this.sqlite.upsertIndexPrices(symbol, indexName, klines);
  }

  async getIndexPrices(symbol: string, limit = 120): Promise<KLineData[]> {
    return this.sqlite.getIndexPrices(symbol, limit);
  }

  async getIndexTradingDays(symbol: string): Promise<string[]> {
    return this.sqlite.getIndexTradingDays(symbol);
  }

  async getAllStockPriceCoverage(dateFrom: string, dateTo: string): Promise<DailyPriceCoverage[]> {
    return this.sqlite.getAllStockPriceCoverage(dateFrom, dateTo);
  }

  async loadAllDailyPrices(): Promise<StoredDailyPrice[]> {
    return this.sqlite.loadAllDailyPrices();
  }

  getStorageStatus() {
    return this.sqlite.storageStatus();
  }

  close(): void {
    this.sqlite.close();
  }

  async getPaperTradingState(): Promise<PaperTradingRuntimeState | null> {
    const runtimePath = path.join(this.runtime, 'paper-trading-state.json');
    if (!(await exists(runtimePath))) return null;
    return readJson<PaperTradingRuntimeState>(runtimePath);
  }

  savePaperTradingState(state: PaperTradingRuntimeState): Promise<void> {
    return writeJson(path.join(this.runtime, 'paper-trading-state.json'), state);
  }

  private async backtestFiles(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir))
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  async listBacktests(): Promise<BacktestListItem[]> {
    const baseFiles = await this.backtestFiles(path.join(this.root, 'backtests'));
    const runtimeFiles = await this.backtestFiles(path.join(this.runtime, 'backtests'));
    const byId = new Map<string, BacktestResult>();
    const deleted = await this.deletedBacktests();
    for (const filePath of [...baseFiles, ...runtimeFiles]) {
      const result = await readJson<BacktestResult>(filePath);
      if (deleted.has(result.run_id)) continue;
      byId.set(result.run_id, result);
    }
    return [...byId.values()]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((result) => ({
        run_id: result.run_id,
        timestamp: result.timestamp,
        total_return_pct: result.summary?.total_return_pct ?? 0,
        total_trades: result.summary?.total_trades ?? result.trades?.length ?? 0,
        win_rate: result.summary?.win_rate ?? 0,
        max_holdings: result.summary?.max_holdings ?? 0,
        date_range: result.date_range ?? '',
      }));
  }

  async getBacktest(runId: string): Promise<BacktestResult | null> {
    if ((await this.deletedBacktests()).has(runId)) return null;
    const runtimePath = path.join(this.runtime, 'backtests', `${runId}.json`);
    const basePath = path.join(this.root, 'backtests', `${runId}.json`);
    if (await exists(runtimePath)) return readJson<BacktestResult>(runtimePath);
    if (await exists(basePath)) return readJson<BacktestResult>(basePath);
    return null;
  }

  saveBacktest(result: BacktestResult): Promise<void> {
    return (async () => {
      const deleted = await this.deletedBacktests();
      deleted.delete(result.run_id);
      await this.saveDeletedBacktests(deleted);
      await writeJson(path.join(this.runtime, 'backtests', `${result.run_id}.json`), result);
    })();
  }

  async deleteBacktest(runId: string): Promise<boolean> {
    let deleted = false;
    const runtimePath = path.join(this.runtime, 'backtests', `${runId}.json`);
    const basePath = path.join(this.root, 'backtests', `${runId}.json`);
    try {
      await unlink(runtimePath);
      deleted = true;
    } catch {
      // The runtime overlay may not exist yet.
    }
    if (await exists(basePath)) {
      const tombstones = await this.deletedBacktests();
      tombstones.add(runId);
      await this.saveDeletedBacktests(tombstones);
      deleted = true;
    }
    return deleted;
  }
}
