import pl from 'nodejs-polars';
import type {
  AnalysisData,
  RankingResponse,
  RankingRow,
  RankingSummary,
  StrategyAction,
} from '../src/types.js';
import { formatDateTime, round } from './format.js';

const SORTABLE_FIELDS = new Set([
  'rank',
  'stock_code',
  'stock_name',
  'sector_name',
  'continue_num',
  'latest_price',
  'latest_change_rate',
  'total_score',
  'trend_score',
  'momentum_score',
  'volume_score',
  'position_score',
  'volatility_trend_score',
  'strategy_label',
  'strategy_position',
]);

function strategyForScore(score: number): Pick<RankingRow, 'strategy_action' | 'strategy_label' | 'strategy_position'> {
  if (score >= 70) return { strategy_action: 'accumulate', strategy_label: '重点加仓', strategy_position: '7-9成' };
  if (score >= 55) return { strategy_action: 'accumulate', strategy_label: '趋势跟踪', strategy_position: '5-7成' };
  if (score >= 40) return { strategy_action: 'trade', strategy_label: '短线博弈', strategy_position: '3-5成' };
  if (score >= 25) return { strategy_action: 'trade', strategy_label: '轻仓试探', strategy_position: '1-3成' };
  if (score >= 10) return { strategy_action: 'reduce', strategy_label: '观望减仓', strategy_position: '0-1成' };
  return { strategy_action: 'ignore', strategy_label: '坚决回避', strategy_position: '0成' };
}

function rankingFrame(rows: RankingRow[]) {
  return pl.DataFrame(rows.map((row) => ({
    ...row,
    rank: Number(row.rank ?? 0),
    stock_code: String(row.stock_code ?? ''),
    stock_name: String(row.stock_name ?? ''),
    sector_name: String(row.sector_name ?? ''),
    strategy_action: String(row.strategy_action ?? 'ignore'),
    total_score: Number(row.total_score ?? 0),
    trend_score: Number(row.trend_score ?? 0),
    momentum_score: Number(row.momentum_score ?? 0),
    volume_score: Number(row.volume_score ?? row.volume_price_score ?? 0),
    position_score: Number(row.position_score ?? 0),
    volatility_trend_score: Number(row.volatility_trend_score ?? row.momentum_score ?? 0),
    continue_num: Number(row.continue_num ?? 0),
    latest_price: row.latest_price == null ? null : Number(row.latest_price),
    latest_change_rate: row.latest_change_rate == null ? null : Number(row.latest_change_rate),
  })));
}

export function queryRankings(
  source: { timestamp: string; date: string; total_stocks: number; rankings: RankingRow[] },
  options: {
    search?: string;
    action?: string;
    sector?: string;
    sort?: string;
    order?: string;
    page?: number;
    pageSize?: number;
  },
): RankingResponse {
  const pageSize = Math.min(200, Math.max(5, Number(options.pageSize ?? 50)));
  // An uncomputed board has no rows, so pl.DataFrame([]) yields a schema-less
  // frame whose sort('total_score', …) throws `"total_score" not found`. Return
  // an empty response before touching Polars.
  if (!source.rankings.length) {
    return {
      timestamp: source.timestamp,
      date: source.date,
      total_stocks: source.total_stocks,
      total: 0,
      page: 1,
      page_size: pageSize,
      rankings: [],
      summary: { average_score: 0, median_score: 0, top_score: 0, actions: {} },
      sectors: [],
    };
  }
  let frame = rankingFrame(source.rankings);
  const search = options.search?.trim();
  if (search) {
    frame = frame.filter(
      pl.col('stock_name').str.contains(search, true)
        .or(pl.col('stock_code').str.contains(search, true))
        .or(pl.col('sector_name').str.contains(search, true)),
    );
  }
  if (options.action && options.action !== 'all') {
    frame = frame.filter(pl.col('strategy_action').eq(pl.lit(options.action)));
  }
  if (options.sector && options.sector !== 'all') {
    frame = frame.filter(pl.col('sector_name').eq(pl.lit(options.sector)));
  }

  const total = frame.height;
  const summaryRecord = total
    ? frame.select(
        pl.col('total_score').mean().alias('average_score'),
        pl.col('total_score').quantile(0.5).alias('median_score'),
        pl.col('total_score').max().alias('top_score'),
      ).toRecords()[0] as Record<string, number>
    : { average_score: 0, median_score: 0, top_score: 0 };
  const actionRecords = total ? frame.groupBy('strategy_action').len().toRecords() : [];
  const actions = Object.fromEntries(actionRecords.map((item) => [String(item.strategy_action), Number(item.len)]));
  const summary: RankingSummary = {
    average_score: round(Number(summaryRecord.average_score ?? 0), 1),
    median_score: round(Number(summaryRecord.median_score ?? 0), 1),
    top_score: round(Number(summaryRecord.top_score ?? 0), 1),
    actions,
  };

  const sort = SORTABLE_FIELDS.has(options.sort ?? '') ? options.sort! : 'total_score';
  const descending = (options.order ?? 'desc') !== 'asc';
  frame = frame.sort(sort, descending, true);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number(options.page ?? 1)));
  const rankings = frame.slice((page - 1) * pageSize, pageSize).toRecords() as unknown as RankingRow[];
  const sectors = [...new Set(source.rankings.map((row) => row.sector_name).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'zh-CN'));

  return {
    timestamp: source.timestamp,
    date: source.date,
    total_stocks: source.total_stocks,
    total,
    page,
    page_size: pageSize,
    rankings,
    summary,
    sectors,
  };
}

export function recomputeRanking(source: { timestamp: string; date: string; total_stocks: number; rankings: RankingRow[] }) {
  const rescored = source.rankings.map((row) => {
    const trend = Number(row.trend_score ?? 0);
    const volumePrice = Number(row.volume_price_score ?? row.volume_score ?? 0);
    const position = Number(row.position_score ?? 0);
    const volatilityTrend = Number(row.volatility_trend_score ?? 0);
    const totalScore = round(trend + volumePrice + position + volatilityTrend, 1);
    return { ...row, ...strategyForScore(totalScore), total_score: totalScore };
  });
  const ranked = rankingFrame(rescored)
    .sort('total_score', true, true)
    .withRowIndex('__rank', 1)
    .toRecords()
    .map((record) => {
      const { __rank, ...row } = record as Record<string, unknown>;
      return { ...row, rank: Number(__rank) } as RankingRow;
    });
  return {
    timestamp: formatDateTime(),
    date: source.date,
    total_stocks: ranked.length,
    rankings: ranked,
  };
}

export function refreshAnalysis(source: AnalysisData): AnalysisData {
  const blocks = source.blocks ?? [];
  const indices = source.indices ?? [];
  const blockFrame = pl.DataFrame(blocks.map((block) => ({
    name: block.name,
    code: block.code,
    limit_up_num: Number(block.block_info?.limit_up_num ?? 0),
    change: Number(block.block_info?.change ?? 0),
    max_continue: Number(block.block_info?.max_continue ?? 0),
    state_id: Number(block.trend?.state_id ?? 0),
  })));
  const indexFrame = pl.DataFrame(indices.map((item) => ({ state_id: Number(item.state?.state_id ?? 0) })));
  const totalLimitUp = blockFrame.height ? Number(blockFrame.getColumn('limit_up_num').sum() ?? 0) : 0;
  const averageChange = blockFrame.height ? Number(blockFrame.getColumn('change').mean() ?? 0) : 0;
  const top3 = blockFrame.height ? blockFrame.sort('limit_up_num', true).head(3).toRecords() : [];
  const bullishIndices = indexFrame.height ? indexFrame.filter(pl.col('state_id').eq(pl.lit(1))).height : 0;
  const riskIndices = indexFrame.height ? indexFrame.filter(pl.col('state_id').isIn([6, 7])).height : 0;
  const sentiment = totalLimitUp >= 80 ? 'hot' : totalLimitUp >= 30 ? 'normal' : 'cold';
  return {
    ...source,
    timestamp: formatDateTime(),
    sentiment: {
      ...source.sentiment,
      total_blocks: blocks.length,
      total_limit_up: totalLimitUp,
      sentiment,
      top_3: top3,
    },
    stats: {
      bullish_indices: bullishIndices,
      risk_indices: riskIndices,
      valid_blocks: blockFrame.height ? blockFrame.filter(pl.col('state_id').isIn([1, 2, 3, 4, 5, 6, 7])).height : 0,
      average_block_change: round(averageChange, 2),
    },
  };
}

export function actionLabel(action: StrategyAction): string {
  return ({ accumulate: '加仓', trade: '博弈', reduce: '减仓', ignore: '回避' } as const)[action] ?? action;
}
