export type StrategyAction = 'accumulate' | 'trade' | 'reduce' | 'ignore';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MarketState {
  state_id: number;
  state_name: string;
  trend?: string;
  feature?: string;
  core_strategy?: string;
  play?: string;
  position?: string;
  risk_control?: string;
}

export interface IndexAnalysis {
  name: string;
  code: string;
  state: MarketState;
  price: number;
  date: string;
  indicators?: Record<string, unknown>;
  signal: string;
}

export interface LimitUpStock {
  code: string;
  name: string;
  continue_num?: number;
  change_rate?: number;
  latest?: number;
  reason_type?: string | null;
  reason_info?: string | null;
  high?: string;
  [key: string]: unknown;
}

/** 板块个股：板块关联的全部去重个股（来自 limit_up_record 累积）。 */
export interface SectorStock {
  code: string;
  name: string;
  latest_date: string;
  continue_num?: number;
  reason_type?: string | null;
  /** 涨停当时记录的收盘价（与「当下」价格不同）。 */
  latest?: number | null;
  change_rate?: number | null;
  /** stock_daily_price 中该个股的最新日期 (YYYY-MM-DD)。 */
  kline_date?: string | null;
  /** stock_daily_price 中该个股的最新收盘价（仅当 price_fresh 时反映当下）。 */
  kline_latest?: number | null;
  /** stock_daily_price 中该个股的最新涨跌幅%。 */
  kline_change_rate?: number | null;
  /** K 线最新日 ≥ 最新行情日 → 当前价/涨幅可显示；否则视为尚未刷新到当下。 */
  price_fresh: boolean;
}

export interface SectorStocksResponse {
  sector_code: string;
  sector_name: string;
  stock_count: number;
  /** limit_up_record 的全局最新日期（最新行情日基准）。 */
  latest_analysis_date: string;
  /** 已就绪（price_fresh=true）的个股数。 */
  fresh_count: number;
  stocks: SectorStock[];
}

export interface BlockAnalysis {
  name: string;
  code: string;
  block_info: {
    limit_up_num: number;
    change: number;
    max_continue: number;
    stock_list?: LimitUpStock[];
  };
  trend: MarketState & {
    near_high?: string;
    volume_trend?: string;
    latest?: number;
    ma5?: number | null;
    ma20?: number | null;
    adx?: number;
    plus_di?: number;
    minus_di?: number;
    /** 多周期交叉验证把日线分类改写得更保守。 */
    downgraded?: boolean;
    /** 是否被多周期交叉验证改写过（升级或降级）。 */
    adjusted?: boolean;
    adjust_direction?: 'up' | 'down';
    original_state_id?: number;
    original_state_name?: string;
    /** 周/月线是否参与判定；未参与时该状态仅由日线得出。 */
    confirmations?: { weekly: boolean; monthly: boolean };
  };
  strategy: {
    action: StrategyAction;
    label: string;
    position: string;
  };
  stock_list: LimitUpStock[];
}

export interface SentimentData {
  total_blocks: number;
  total_limit_up: number;
  sentiment: 'hot' | 'normal' | 'cold' | string;
  hot_sectors?: string[];
  top_3?: Array<Record<string, unknown>>;
  continuous_boards?: Array<Record<string, unknown>>;
}

export interface AnalysisData {
  timestamp: string;
  /** block_top / sector trend facts belong to this YYYYMMDD trading date. */
  source_date?: string;
  indices: IndexAnalysis[];
  blocks: BlockAnalysis[];
  sentiment: SentimentData;
  stats?: {
    bullish_indices: number;
    risk_indices: number;
    valid_blocks: number;
    average_block_change: number;
  };
  note?: string;
}

export interface RankingRow {
  rank: number;
  stock_code: string;
  stock_name: string;
  total_score: number;
  trend_score: number;
  momentum_score?: number;
  volume_score?: number;
  volume_price_score?: number;
  position_score?: number;
  volatility_trend_score?: number;
  volatility_class?: 'high' | 'medium' | 'low' | string;
  volatility_label?: string;
  /** 维度 5：相对强度得分（0-20）。 */
  relative_strength_score?: number;
  relative_strength_label?: string;
  /** 个股 N 日收益 − 基准 N 日收益（百分点）；基准缺失时为 null。 */
  relative_strength_pct?: number | null;
  limit_up_count_20d?: number;
  alignment: string;
  trend_strength?: number;
  volume_label?: string;
  volume_price_label?: string;
  position_label?: string;
  latest_price?: number | null;
  latest_change_rate?: number | null;
  /** 距60日低点涨幅(%) */
  distance_from_low_pct?: number;
  sector_code?: string;
  sector_name?: string;
  sector_trend_name?: string;
  sector_trend_state_id?: number;
  continue_num?: number;
  reason_type?: string;
  [key: string]: unknown;
}

export interface RankingSummary {
  average_score: number;
  median_score: number;
  top_score: number;
}

export interface RankingResponse {
  timestamp: string;
  date: string;
  total_stocks: number;
  total: number;
  page: number;
  page_size: number;
  rankings: RankingRow[];
  summary: RankingSummary;
  sectors: string[];
}

export interface TaskSnapshot {
  id: string;
  trace_id?: string;
  type: string;
  name: string;
  status: TaskStatus;
  progress: number;
  message: string;
  created_at: string;
  updated_at: string;
  result?: unknown;
  error?: string;
}

export interface BacktestTrade {
  date: string;
  stock_code: string;
  stock_name: string;
  action: '买入' | '卖出';
  price: number;
  shares: number;
  amount: number;
  position_pct: number;
  hold_days: number;
  pnl_pct: number;
  pnl_amount?: number;
  reason: string;
}

export interface EquityPoint {
  date: string;
  total: number;
  cash?: number;
  positions_value?: number;
}

export interface BacktestResult {
  run_id: string;
  timestamp: string;
  date_range: string;
  max_hold_days: number;
  engine_version?: string;
  data_source?: string;
  methodology?: string;
  bias_notes?: string[];
  summary: {
    initial_capital: number;
    final_capital: number;
    total_return: number;
    total_return_pct: number;
    total_trades: number;
    buy_count: number;
    sell_count: number;
    win_count: number;
    win_rate: number;
    expire_count: number;
    max_holdings: number;
    max_drawdown_pct?: number;
  };
  config: Record<string, number | string | null>;
  trades: BacktestTrade[];
  equity_curve?: EquityPoint[];
}

export interface BacktestListItem {
  run_id: string;
  timestamp: string;
  total_return_pct: number;
  total_trades: number;
  win_rate: number;
  max_holdings: number;
  date_range: string;
  mode?: string;
  combo_index?: number;
  strategy_count?: number;
  batch_run_id?: string;
  position_size_pct?: number;
  max_hold_days?: number;
  max_positions?: number;
}

export interface PaperPosition {
  stock_code: string;
  stock_name: string;
  shares: number;
  available_shares: number;
  cost_price: number;
  current_price: number;
  market_value: number;
  pnl_amount: number;
  pnl_pct: number;
  entry_date?: string;
  hold_days?: number;
  tracking_source?: 'strategy' | 'reconciled';
}

export interface PaperOrder {
  id: string;
  side: 'buy' | 'sell';
  stock_code: string;
  stock_name: string;
  quantity: number;
  price: number;
  amount: number;
  status: string;
  reason: string;
  window: string;
  execution_window?: PlanExecutionWindow;
  signal_date?: string;
  rank?: number;
  cancelable?: boolean;
}

export interface PaperPlanHistoryItem extends PaperOrder {
  signal_date: string;
  rank?: number;
  created_at: string;
  submitted_at?: string;
  completed_at?: string;
  broker_status?: string;
}

export interface PaperOverview {
  ok: boolean;
  connection: {
    status: 'live' | 'cached' | 'unavailable';
    source: 'tonghuashun-gui' | 'runtime-state';
    observed_at?: string;
  };
  account: {
    total_assets: number;
    available_cash: number;
    current_position_pct: number;
    positions: PaperPosition[];
    orders: PaperOrder[];
    pnl_summary: { amount: number; pct: number };
  };
  plan: {
    target_position_pct: number;
    position_size_pct: number;
    max_positions: number;
    max_entries_per_day: number;
    max_hold_days: number;
    stop_loss_pct: number;
    take_profit_pct: number;
    engine_version: string;
    methodology: string;
    sentiment: string;
    ranking_date: string;
    market_reason: string;
    orders: PaperOrder[];
    history: PaperPlanHistoryItem[];
    skipped: string[];
  };
}

export interface AutomationState {
  enabled: boolean;
  paused_today: boolean;
  next_window: string;
  last_run?: string;
  last_window?: TradingWindow;
  last_error?: string;
}

export interface TradingSession {
  shanghai_time: string;
  trading_date: string;
  is_trading_day: boolean;
  calendar_latest?: string;
  immediate_execute_allowed: boolean;
  immediate_execute_reason?: string;
}

export type PlanExecutionWindow = 'open' | 'near_close';
export type TradingWindow = PlanExecutionWindow | 'close' | 'post_close';
export type StrategyInstructionStatus = 'pending' | 'submitting' | 'submitted' | 'uncertain' | 'filled' | 'skipped' | 'failed' | 'cancelled';

export interface PaperStrategyInstruction {
  id: string;
  side: 'buy' | 'sell';
  stock_code: string;
  stock_name: string;
  signal_date: string;
  signal_price: number;
  quantity: number;
  rank?: number;
  /** 信号日总分（100 分制）；执行时按同一评分缩放仓位，避免计划与成交口径不一致。 */
  signal_score?: number;
  reason: string;
  execution_window?: PlanExecutionWindow;
  status: StrategyInstructionStatus;
  created_at: string;
  submitted_at?: string;
  completed_at?: string;
  broker_status?: string;
  execution_price?: number;
}

export interface PaperTrackedPosition {
  stock_code: string;
  stock_name: string;
  entry_date: string;
  entry_price: number;
  shares: number;
  source: 'strategy' | 'reconciled';
  signal_date?: string;
}

export interface PaperTradingEvent {
  id: string;
  timestamp: string;
  trading_date: string;
  window: TradingWindow | 'system';
  type: string;
  message: string;
  stock_code?: string;
}

export interface PaperAccountObservation {
  observed_at: string;
  available_cash: number;
  total_assets: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
}

export interface PaperStrategyConfigSnapshot {
  maxHoldDays: number;
  maxPositions: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxEntriesPerDay: number;
  positionSizePct: number;
  maxCandidates: number;
}

export interface PaperTradingRuntimeState {
  schema_version: 1;
  engine_version: string;
  automation: AutomationState;
  reference_capital: number | null;
  completed_windows: Record<string, TradingWindow[]>;
  instructions: PaperStrategyInstruction[];
  tracked_positions: PaperTrackedPosition[];
  last_account_observation?: PaperAccountObservation;
  events: PaperTradingEvent[];
  last_signal_date?: string;
  strategy_config?: PaperStrategyConfigSnapshot;
  applied_backtest_run_id?: string;
  updated_at: string;
}
