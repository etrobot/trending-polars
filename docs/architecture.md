# 架构设计

> **说明**：本文档基于 `trending-polars` 项目当前代码编写，反映 TypeScript 实现的实际状态。标记为「🚧 未实现」的功能是设计目标，待后续开发。

---

## 1. 流程总览

```
同花顺板块行情                    腾讯财经指数行情
      │                                  │
      ▼                                  ▼
  涨停数据采集 ──► 情绪分析 ──► 指数趋势分析        ← 本地 scoring-engine 聚合
      │                                  │
      ▼                                  ▼
  板块 K 线分析 ──► 板块趋势分类 ──► 市场状态分类    ← 本地归类（scoring-engine）
      │                                  │
      ▼                                  ▼
  个股行情采集 ◄──────── 排行榜选股 ◄───────────────┘
      │
      ▼
  多因子评分（趋势40+价量25+位置20+波动15）
      │
      ▼
  策略建议生成 ──► 回测验证 ──► 交易计划生成
                                    │
                                    ▼
                            同花顺模拟交易执行
                                    │
                                    ▼
                            持仓监控 & 盈亏计算
                                    │
                                    ▼
                            止盈止损 & 计划刷新
```

**策略挖掘闭环（P1–P5）**：

```
统一绩效指标(P1) + 买入子策略注册表(P2)
        │
        ▼
walk-forward 滚动参数搜索 + 稳定性分析(P3)
        │
        ▼
挖掘流水线「补数→搜索→验证→报告」落库(P4)
        │  一键下发（runId + 排名，显式确认）
        ▼
独立模拟交易实例执行(P5，仅模拟通道)
        │  成交/撤单回写 → 滑点/未成交率/撤单率
        ▼
摩擦校准数据回馈下一轮挖掘（P3/P4 读取）
```

**核心逻辑**：指数定仓位 → 情绪定买卖 → 个股定标的 → 回测定参数 → 计划定执行

**技术栈**：TypeScript + Node.js 22.13+ · Express 5 · React 19 · Tailwind CSS 4 · nodejs-polars · `node:sqlite` · WebSocket (ws) · AppleScript 桥接

**数据库版本**：`SCHEMA_VERSION=20`（`block_daily_price`、`paper_instruction` 表，`limit_up_record` 去冗余列，`sector_trend_daily.state_id` 允许 0/state_id=8「筑底成功」合法）。策略挖掘产物（P4/P5）以文件形式落 `server/data/mining/`，SQLite 未新增表。

---

## 2. 服务器模块一览

| 模块 | 文件 | 职责 |
|------|------|------|
| 服务装配 | `server/app.ts` | 装载 `Store/Audit/Tasks/Paper/MarketService`、注册路由、错误处理 |
| 市场服务 | `server/app/market-service.ts` | 指数/板块/涨停采集、行情覆盖验证、PaperTrading 上下文、排行计算（含 RankingRuntimeConfig） |
| API 路由 | `server/app/routes.ts` | 所有 `/api/*` 路由注册；任务、回测、模拟交易、审计 |
| 服务入口 | `server/index.ts` | HTTP + WebSocket 服务器启动；加载交易日历 |
| 节假日日历 | `server/holiday-calendar.ts` | 2023–2026 年 A 股节假日数据，`buildTradingCalendar()` 反推生成交易日序列 |
| 启动引导 | `server/index-bootstrap.ts` | 交易日历解析、`resolveLatestTradingDate()`、上证指数历史补全 |
| 混合数据存储 | `server/data-store.ts` | SQLite 门面、旧 JSON 种子迁移、缓存/状态/回测归档/排行配置 |
| SQLite 仓储 | `server/sqlite-store.ts` | `node:sqlite` 批量 upsert、结构化查询；PRAGMA 与状态查询 |
| SQLite schema | `server/sqlite/schema.ts` | 建表、迁移 `migrateV15/V16/V18/V19`，`SCHEMA_VERSION=20` |
| SQLite 工具 | `server/sqlite/helpers.ts` | 类型定义、值转换（`LimitUpRecord`、`STATE_NAMES`、类型工具） |
| 行情采集 | `server/historical-market.ts` | 多源 K 线、板块 K 线、涨停排行采集 |
| 评分引擎 | `server/scoring-engine.ts` | 五维多因子评分 + 八态市场分类 + 板块趋势分析；导出可配置 `ScoreStockConfig` |
| 排行榜查询 | `server/polars-engine.ts` | 排行榜查询/排序/筛选、情绪聚合、重算 |
| 排行配置 | `server/ranking-config.ts` | `RankingRuntimeConfig`（因子权重 + 评分配置 + 回测来源）；从回测结果提取配置、默认配置生成 |
| 向量化回测评分 | `server/backtest-scoring.ts` | 单次 Polars 遍历计算全量股票×日期评分矩阵，替代逐日逐股 `scoreStock` 循环 |
| 基准指数对照 | `server/benchmark.ts` | 从搜狐获取指数日线，归一化生成与回测叠加的 benchmark 净值曲线 |
| 交易策略 | `server/trading-strategy.ts` | 参数配置、选股过滤、仓位计算、止盈止损；`rankEntryCandidates()` 经 P2 子策略注册表聚合候选；不负责涨停判定 |
| 统一绩效指标 | `server/metrics/performance.ts` | P1 `computeMetrics()`/`splitSample()`；回测/参数优化/模拟交易共用同一口径；年化系数 252、`minTradeCount=20` 统计门槛 |
| 指标适配层 | `server/metrics/adapters.ts` | P1 把回测成交、模拟指令统一转成 `PerformanceTrade`；含 FIFO 成本还原卖出已实现盈亏 |
| 子策略注册表 | `server/strategies/registry.ts` | P2 `registerStrategy()/listStrategies()`；内置 `ma-trend`、`breakout-20d`；候选合并（max/weighted）与板块轮动加权 |
| 入场规则 | `server/strategies/entry-rules.ts` | P2 子策略评估实现（多头排列 / 20 日新高突破） |
| Walk-forward | `server/optimize/walkforward.ts` | P3 滚动窗口参数搜索 + 邻域稳定性得分；窗口 250 / 步长 60 / 训练段 70% |
| Walk-forward 执行器 | `server/optimize/walkforward-runner.ts` | P3 在真实回测上下文上执行；默认网格 maxHoldDays × 止盈 × 止损 |
| 挖掘流水线 | `server/pipeline/mine.ts` | P4 「质量检查→walk-forward→报告→落库」一键编排；CLI `tsx server/pipeline/mine.ts [days]` |
| 挖掘落库 | `server/pipeline/store.ts` | P4 `server/data/mining/` 下 runs/results/reports/calibration 文件存储 |
| 数据质量 | `server/pipeline/quality.ts` | P4 开跑前校验：行情连续性 ≥80%、涨停覆盖 ≥60%、必须前复权 |
| 候选下发 | `server/pipeline/deploy.ts` + `instance.ts` | P5 `runId + rank` → 独立模拟交易实例（显式确认、仅模拟通道、状态/审计/队列隔离） |
| 摩擦校准 | `server/pipeline/friction.ts` | P5 实测滑点/未成交率/撤单率统计，回写为下一轮挖掘的校准输入 |
| 验证报告 | `server/pipeline/validation.ts` + `report.ts` + `replay.ts` | P5 样本外预测 vs 模拟实盘对比（偏差 >30% 标记）；P4 HTML/JSON 报告；按 runId 复现 |
| 回测引擎 | `server/backtest-engine.ts` | `runPolarsBacktest`/`runRandomizedBacktest`；导出 `prepareBacktestContext` / `quickSimulateBacktest` 供参数优化复用 |
| 参数优化 | `server/backtest-param-optimizer.ts` | 两阶段优化：先校准 `scoreStock` 评分参数，再网格搜索回测交易参数，目标为完整回测收益 |
| 模拟交易 | `server/paper-trading.ts` | 交易计划、执行、调度、监控；`applyBacktestStrategy()` 从回测结果应用策略参数 |
| 模拟交易辅助 | `server/paper-trading/helpers.ts` | 时钟、市场强弱、执行窗口、内存状态机等纯函数 |
| 同花顺桥接 | `server/ths-simulated-broker.ts` | AppleScript 调用、持仓解析；`quote()` 在 UI 失败时回退到 `fetchAdjustedKlines` |
| AppleScript 桥接 | `scripts/ths_order_dry_run.applescript` | 提交前 `refreshSimulationConnection()`、窗口校验、委托/撤单回查；报价失败回退到 K 线 |
| 审计日志 | `server/audit-log.ts` | JSONL 日志、查询、轮转 |
| 任务注册 | `server/tasks.ts` | 异步任务管理、进度跟踪、WebSocket 广播 |
| 格式化 | `server/format.ts` | 日期、数字工具函数 |
| 开发脚本 | `scripts/dev.mjs` | 并行启动 API + Vite 开发服务器 |

---

## 3. 关键设计原则

### 3.1 无未来函数

所有回测和策略计算严格按日期过滤：

```typescript
// 回测中按日期截断，不窥视未来数据
const barIndex = series.indexByDate.get(date);
if (barIndex == null || barIndex < 19) return null;
// 只使用截至该日期的 K 线计算指标
const closes = bars.slice(0, barIndex + 1).map((bar) => bar.close);
```

### 3.2 安全优先

```
模拟交易安全链：
1. 默认只读（自动化默认关闭，enabled=false）
2. 显式确认词（--confirm SIMULATED / CANCEL）
3. 窗口时间校验（仅允许在交易时段执行）
4. AppleScript 窗口校验（只操作模拟练习窗口）
5. 委托回查（提交后确认是否成功）
6. 撤单回查（操作后确认状态）
7. 服务重启 → 提交中指令标记为 uncertain
```

### 3.3 缓存分层

| 层级 | 数据 | 有效期 |
|------|------|--------|
| SQLite | 股票/板块/涨停/日行情/板块指数日线/板块趋势/排行因子/指令 | 结构化持久化，数据库为准 |
| 基础目录 | `analysis.json` / `ranking.json` | 首次启动兼容导入种子 |
| 运行时缓存 | `analysis.json` / `ranking.json` | 最新计算结果缓存，可重建 |
| 排行配置 | `ranking-config.json` | 因子权重 + 评分配置 + 回测来源，可从优化结果回填 |
| 优化结果 | `optimize-result.json` | 最近一次参数优化完整结果 |
| 状态文件 | 自动化状态、交易日志 | 持久化，跨重启 |
| 挖掘产物 | `server/data/mining/`：runs / results / reports / calibration / instances | 文件落库，不进交易链路，凭 runId 可复现 |
| 内存字典 | 回测预加载 | 回测期间 |

### 3.4 限流保护

| 接口 | 限流方式 | 并发限制 |
|------|---------|---------|
| 同花顺板块 K 线 | 并发采集 | 6 |
| 腾讯财经个股行情 | 单请求 | 1 |
| 历史数据采集（日线） | Semaphore | 24 |
| 回测历史涨停采集 | 串行逐日 | 1 |
| 回测板块 K 线采集 | 并发 | 6 |
| WebSocket 广播 | 事件驱动 | 无限制 |
| AppleScript 调用 | 操作队列串行 | 1 |

