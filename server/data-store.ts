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
import type { HistoricalMarketData } from './historical-market.js';

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

async function writeJson(filePath: string, value: unknown, pretty = true): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, pretty ? 2 : 0), 'utf8');
  await rename(tempPath, filePath);
}

export class DataStore {
  readonly root: string;
  readonly runtime: string;

  constructor(root = DEFAULT_DATA_DIR) {
    this.root = root;
    this.runtime = path.join(root, 'runtime');
  }

  private async runtimeFirst<T>(name: string): Promise<T> {
    const runtimePath = path.join(this.runtime, name);
    if (await exists(runtimePath)) return readJson<T>(runtimePath);
    return readJson<T>(path.join(this.root, name));
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

  getAnalysis(): Promise<AnalysisData> {
    return this.runtimeFirst<AnalysisData>('analysis.json');
  }

  saveAnalysis(data: AnalysisData): Promise<void> {
    return writeJson(path.join(this.runtime, 'analysis.json'), data);
  }

  async getRanking(): Promise<{ timestamp: string; date: string; total_stocks: number; rankings: RankingRow[] }> {
    return this.runtimeFirst('ranking.json');
  }

  saveRanking(data: Pick<RankingResponse, 'timestamp' | 'date' | 'total_stocks' | 'rankings'>): Promise<void> {
    return writeJson(path.join(this.runtime, 'ranking.json'), data);
  }

  async getHistoricalMarket(): Promise<HistoricalMarketData | null> {
    const runtimePath = path.join(this.runtime, 'historical-market.json');
    const basePath = path.join(this.root, 'historical-market.json');
    if (await exists(runtimePath)) return readJson<HistoricalMarketData>(runtimePath);
    if (await exists(basePath)) return readJson<HistoricalMarketData>(basePath);
    return null;
  }

  saveHistoricalMarket(data: HistoricalMarketData): Promise<void> {
    return writeJson(path.join(this.runtime, 'historical-market.json'), data, false);
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
