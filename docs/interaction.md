# 交互层

> 同花顺交易执行、持仓监控、API 接口、WebSocket 推送与问题排查。

---

## 1. 同花顺客户端交易执行

### 1.1 AppleScript 桥接 —— `scripts/ths_order_dry_run.applescript`

**安全机制**：
- 只操作明确包含"模拟练习"的窗口
- 找不到即报错，不操作其他窗口
- 无法确认、字段不一致、委托回查失败立即停止

**可用命令**：

```bash
# 查询
osascript scripts/ths_order_dry_run.applescript snapshot funds     # 资金
osascript scripts/ths_order_dry_run.applescript snapshot positions # 持仓
osascript scripts/ths_order_dry_run.applescript snapshot orders    # 当日委托

# 行情
osascript scripts/ths_order_dry_run.applescript quote 600519       # 实时价格

# 交易
osascript scripts/ths_order_dry_run.applescript order buy 600519 AUTO 100   # 买入
osascript scripts/ths_order_dry_run.applescript order sell 600519 AUTO 100  # 卖出
osascript scripts/ths_order_dry_run.applescript cancel buy 600519 100       # 撤单
```

### 1.2 执行流程 —— `ThsSimulatedBroker`（`server/ths-simulated-broker.ts`）

```
ThsSimulatedBroker
  │
  ├─ snapshot()
  │     ├─ snapshot funds     → 解析资金（可用/总资产/市值）
  │     ├─ snapshot positions → 解析持仓（代码/数量/成本/现价）
  │     └─ snapshot orders    → 解析当日委托（方向/代码/数量/状态）
  │
  ├─ quote(stock_code)
  │     └─ 读取模拟交易界面中的实时价格
  │
  ├─ placeOrder(order)
  │     ├─ 提交委托（side + code + AUTO + quantity）
  │     └─ 回查确认委托成功（ORDER_VERIFIED|）
  │
  └─ cancelOrder(side, code, quantity)
        ├─ 提交撤单
        └─ 回查确认"已撤"状态（CANCEL_VERIFIED|）
```

**解析引擎**：支持表头别名匹配（中文列名如"证券代码""股票余额""成本价"）和无表头 Swift 布局两种同花顺持仓格式。

### 1.3 安全校验

```typescript
// 1. 模拟交易窗口确认
if (!output.includes("THS_SIMULATOR_V1") || !output.includes("SIMULATION|confirmed")) {
  throw new ThsSimulatedBrokerError("无法确认当前是同花顺模拟交易窗口");
}

// 2. 委托回查确认
if (!output.includes("ORDER_VERIFIED|") || !output.includes(stockCode)) {
  throw new ThsSimulatedBrokerError(`委托已提交但回查失败：${stockCode}`);
}

// 3. 撤单回查确认
if (!output.includes("CANCEL_VERIFIED|") || !output.includes(stockCode)) {
  throw new ThsSimulatedBrokerError(`撤单已操作但回查失败：${stockCode}`);
}
```

---

## 2. 持仓盈亏监控

### 2.1 实时监控 —— `PaperTradingService.monitorAccount()`

**每 60 秒**轮询同花顺持仓，计算：

- 单票盈亏额：`(current_price - cost_price) × quantity`
- 单票盈亏率：`(current_price - cost_price) / cost_price × 100%`
- 账户汇总盈亏：`sum(各票盈亏额) + 可用资金 - 总资产`

**变动识别**（`observeAccountChanges()`）：

| 事件 | 识别方式 | 处理 |
|------|---------|------|
| 行情波动 | 数量不变、成本不变 | 更新现价/盈亏，正常推送 |
| 委托成交 | 持仓数量变化 | 更新持仓，标记为策略成交 |
| 人工操作 | 新股票出现或数量变化 | 标记 `source=reconciled`，重建策略计划 |

### 2.2 WebSocket 推送 —— `server/index.ts`

**端点**：
- `/ws/tasks` — 异步任务进度推送（`TaskRegistry` 事件）
- `/ws/simulated-trading` — 模拟交易状态推送（`PaperTradingService` 事件）

**连接建立**：
```
taskSockets: 连接时发送全量快照，后续增量推送
paperSockets: 连接时发送 { type: "status", connected: true }，后续事件推送
```

**推送数据**（模拟交易）：

```json
{
  "type": "window_done",
  "window": "open",
  "results": [...],
  "message": "2026-07-23 开盘窗口完成，处理 2 笔策略指令"
}
```

```json
{
  "type": "automation",
  "automation": { "enabled": true, "paused_today": false, "next_window": "下一窗口：14:55 临收盘执行" },
  "schedule": [...]
}
```

---

## 3. 完整流程串联

### 3.1 每日流程时序

```
交易日 9:00
  │
  ├─ [15:05 收盘后] 采集涨停数据 → 板块 K 线 → 趋势分类 → 计算排行榜
  │    调用 POST /api/analysis/collect 触发完整流水线
  │    （fetchBlockTop → fetchBlockKlines → analyzeBlockTrend → refreshAnalysis）
  │
  ├─ [9:31 开盘窗口]
  │     ├─ 读取账户（资金/持仓/委托）
  │     ├─ 加载策略上下文（指数仓位 + 情绪 + 排行榜）
  │     ├─ 执行卖出信号（止损/止盈/到期）
  │     └─ 如果市场强 → 执行买入信号
  │
  ├─ [每 15 秒] 调度循环 & WebSocket 推送
  │
  ├─ [14:55 临收盘窗口]
  │     └─ 如果市场弱 → 执行买入信号
  │
  ├─ [15:05 收盘决策]
  │     ├─ 拉取实时排行数据（或调用 collectHistoricalMarketData 重排行）
  │     └─ 生成次日交易计划（卖出+买入信号）
  │
  ├─ [15:10 盘后核对]
  │     └─ 清理过期信号 + 核对持仓状态
  │
  └─ [每 60 秒，9:25-15:20] 账户监控
        └─ 读取同花顺持仓变化 → WebSocket 广播
```

### 3.2 数据流全景

```
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │                        同花顺客户端                                 │
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │                    模拟练习窗口                              │   │
                   │  │  资金/持仓/委托 ←─ AppleScript ── broker.snapshot()          │   │
                   │  │  提交委托    ←─ AppleScript ── broker.placeOrder()           │   │
                   │  └──────────────────────────────────────────────────────────────┘   │
                   └─────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ osascript
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │  server/paper-trading.ts                                    │   │
                   │  │  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐  │   │
                   │  │  │ 策略上下文     │  │ 交易计划生成   │  │ 执行引擎      │  │   │
                   │  │  │ loadPaperContext│→│ buildExit/    │→│ runWindow     │  │   │
                   │  │  │                │  │ EntrySignals   │  │ executePlanned│  │   │
                   │  │  └────────────────┘  └────────────────┘  └───────────────┘  │   │
                   │  │                                                                 │
                   │  │  ┌──────────────────────────────────────────────────────────┐   │
                   │  │  │ 调度循环 (15s) + 账户监控 (60s) + WebSocket 广播         │   │
                   │  │  │ tickScheduler()  monitorAccount()  broadcast()          │   │
                   │  │  └──────────────────────────────────────────────────────────┘   │
                   │  └─────────────────────────────────────────────────────────────────┘
                   │                                                                     │
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │  server/ths-simulated-broker.ts (AppleScript 桥接层)          │   │
                   │  │  parseThsFundsSnapshot  parseThsPositionsSnapshot             │   │
                   │  └──────────────────────────────────────────────────────────────┘   │
                   └─────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ 调用
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │                      业务逻辑层                                     │
                   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
                   │  │ scoring-    │  │ polars-      │  │ backtest-    │               │
                   │  │ engine.ts   │  │ engine.ts    │  │ engine.ts   │               │
                   │  │ 四维评分     │  │ 排行榜查询   │  │ 回测引擎     │               │
                   │  │ 七态分类     │  │ 排序/筛选    │  │ 历史评分     │               │
                   │  │ 板块趋势分析 │  │ 情绪聚合     │  │ (调scoring)  │               │
                   │  └──────────────┘  └──────────────┘  └──────────────┘               │
                   │  ┌──────────────┐  ┌──────────────┐                                 │
                   │  │ historical-  │  │ app.ts       │  ┌──────────────┐               │
                   │  │ market.ts    │  │ API 路由     │  │ trading-     │               │
                   │  │ 真实日线采集  │  │ 任务注册     │  │ strategy.ts  │               │
                   │  │ 多源K线+涨停  │  │ 涨停采集流水线│  │ 选股/仓位    │               │
                   │  │ 板块K线+涨停  │  │ 审计日志     │  │ 止盈止损     │               │
                   │  └──────────────┘  └──────────────┘  └──────────────┘               │
                   └─────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ 读写
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │                    数据持久层 (SQLite + JSON)                      │
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │  server/data/trending.db  (`node:sqlite`, WAL)               │   │
                   │  │  股票/板块/涨停/行情/趋势/排行榜因子                         │   │
                   │  │  ranking_factor 主表 + stock_ranking 兼容表                  │   │
                   │  └──────────────────────────────────────────────────────────────┘   │
                   │                                                                     │
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │  JSON 缓存与归档                                              │   │
                   │  │  analysis.json / runtime/ranking.json                        │   │
                   │  │  runtime/paper-trading-state.json                            │   │
                   │  │  backtests/*.json / runtime/backtests/*.json                 │   │
                   │  │  runtime/logs/*.jsonl / deleted-backtests.json               │   │
                   │  └──────────────────────────────────────────────────────────────┘   │
                   └─────────────────────────────────────────────────────────────────────┘
```

### 3.3 Web 界面映射

| 页面 | 路由 | 对应功能 | 组件 |
|------|------|---------|------|
| 首页 | `/` | 指数趋势 + 板块情绪一览 | `HomePage.tsx` |
| 详情页 | `/details` | 板块涨停个股明细 + K 线 | `DetailsPage.tsx` |
| 排行榜 | `/ranking` | 多因子评分排行（搜索/筛选/排序） | `RankingPage.tsx` |
| 回测 | `/backtest` | 策略回测与结果展示（净值曲线 + benchmark 叠加） | `BacktestPage.tsx` |
| 模拟交易 | `/simulated-trading` | 资金/持仓/计划/委托/执行 | `SimulatedTradingPage.tsx` |

---

## 4. CLI / API 操作速查

### 4.1 启动服务

```bash
npm run dev          # 开发模式（API + Vite 并行）
npm run start        # 生产模式启动（端口 8787）
npm run dev:api      # 仅 API 服务器（热重载）
npm run dev:web      # 仅前端开发服务器

npm test             # 运行测试
npm run test:watch   # 监听模式测试
```

要求 Node.js `>=22.13.0`。`server/data/` 整体在 `.gitignore` 中，仓库不再携带任何市场数据、账户状态或回测结果。首次创建 `DataStore` 时会自动建立 `server/data/trending.db`、启用 WAL/外键并幂等执行 v1.4 表结构；没有外部数据时 API 返回空快照，随后可通过采集接口填充。若用户自行放入旧版 `ranking.json` / `historical-market.json`，仍会兼容导入。

### 4.2 API 端点

```bash
# ==== 健康检查 ====
GET /api/health

# ==== 分析数据 ====
GET /api/analysis                    # 获取指数+板块分析
GET /api/analysis?refresh=1          # 异步采集 blocktop+板块/个股/指数并刷新分析
POST /api/analysis/collect           # 同上，保留主动采集语义

# ==== 板块数据 ====
GET /api/limit_up?date=20260723      # 板块涨停明细（扁平化）
GET /api/block_prices?block_code=881145&period=01&limit=120  # 板块K线

# ==== 个股行情 ====
GET /api/stock_prices?stock_code=000001&limit=60  # K线+MA5/10/20
GET /api/klines?symbol=sh000001&limit=120         # 原始K线数据
GET /api/index_prices?symbol=sh000001&limit=120   # 指数K线

# ==== 排行榜 ====
GET /api/ranking                     # 查询排行榜（搜索/筛选/排序/分页）
POST /api/ranking/compute            # 校验/补采需求日期行情后异步重算截面排行

# ==== 回测 ====
POST /api/backtest/collect?days=20   # 采集历史数据
POST /api/backtest/run?days=20       # 校验/补采所需区间后运行回测
GET /api/backtest/list               # 回测列表
GET /api/backtest/:runId             # 回测详情
DELETE /api/backtest/:runId          # 删除回测

# ==== 基准指数对照 ====
GET /api/benchmark?dates=20260701,20260702,20260703&initial_capital=100000  # 基准指数净值曲线（上证380）

# ==== 模拟交易 ====
GET /api/simulated-trading/health
GET /api/simulated-trading/bootstrap      # 快速初始化（无实时账户同步）
GET /api/simulated-trading/overview       # 完整账户+计划
GET /api/simulated-trading/automation     # 自动化状态
GET /api/simulated-trading/state          # 运行时状态
POST /api/simulated-trading/execute       # 执行计划（--confirm SIMULATED）
POST /api/simulated-trading/cancel        # 撤单
POST /api/simulated-trading/automation/toggle  # 启用/禁用自动化
POST /api/simulated-trading/automation/pause-today  # 暂停当天
POST /api/simulated-trading/automation/resume       # 恢复
POST /api/simulated-trading/automation/run-window   # 手动执行窗口（--confirm SIMULATED）
POST /api/simulated-trading/monitor/run   # 手动执行账户监控

# ==== 审计日志 ====
GET /api/audit/logs?level=error&component=paper_trading
GET /api/audit/files

# ==== 异步任务 ====
GET /api/tasks                    # 任务列表
GET /api/tasks/:taskId            # 任务详情
POST /api/tasks/:taskId/cancel    # 取消任务

# ==== WebSocket ====
ws://localhost:8787/ws/tasks              # 任务进度推送
ws://localhost:8787/ws/simulated-trading  # 模拟交易状态推送
```

---

## 5. 常见问题排查

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 分析数据为空 | 未导入 `analysis.json` | 将预生成文件放入 `server/data/`，或调用 `POST /api/analysis/collect` 采集 |
| 排行榜为空 | SQLite 尚无排行且未提供兼容种子 | 将 `ranking.json` 放入 `server/data/` 触发首次导入，或调用 `POST /api/ranking/compute` |
| SQLite 无法启动 | Node 版本过低 | 升级到 Node.js 22.13+；项目直接使用内置 `node:sqlite`，不需要安装原生依赖 |
| 行情接口网络失败 | 腾讯/新浪/东方财富暂时不可用 | 已落库的个股/指数 K 线会自动从 `stock_daily_price` / `index_daily_price` 回退 |
| 同花顺 AppleScript 失败 | 未打开模拟练习窗口 | 打开同花顺 → 模拟练习 |
| 委托回查失败 | 界面未更新 / 弹窗遮挡 | 检查同花顺界面状态 |
| 自动化调度不执行 | 未启用 | 前端调用 `POST /api/simulated-trading/automation/toggle` |
| 回测失败 | 历史数据不足 | 先调用 `POST /api/backtest/collect` |
| 涨停采集返回空 | 同花顺反爬拦截 | 检查网络，保留现有 `analysis.json` 快照 |
| 服务启动报错 | 端口被占用 | 检查 8787 端口，或设置 `PORT` 环境变量 |
