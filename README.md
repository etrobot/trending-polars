# trending-polars

> 全流程量化交易系统：从数据采集到交易执行（Node.js / TypeScript 版）

**核心逻辑**：指数定仓位 → 情绪定买卖 → 个股定标的 → 回测定参数 → 计划定执行

**技术栈**：TypeScript + Node.js 22.13+ · Express 5 · React 19 · Tailwind CSS 4 · nodejs-polars · `node:sqlite` · WebSocket (ws) · AppleScript 桥接

---

## 文档导航

| 文档 | 内容 |
|------|------|
| [架构设计](docs/architecture.md) | 流程总览、模块一览、设计原则 |
| [数据层](docs/data.md) | 数据采集、因子存储、SQLite 运维、审计日志 |
| [业务逻辑](docs/logic.md) | 趋势分析、多因子评分、策略回测、交易计划、自动化调度 |
| [交互层](docs/interaction.md) | 同花顺执行、持仓监控、API 速查、WebSocket、问题排查 |
| [数据表结构](ref-data-structure.md) | SQLite 表设计、关系、迁移、缓存策略 |

---

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（API + Vite 并行）
npm run dev

# 生产模式
npm run start

# 运行测试
npm test
```

要求 Node.js `>=22.13.0`。

---

## 项目结构

```
trending-polars/
├── server/               # 后端服务
│   ├── app.ts           # 入口：装载服务、注册路由、错误处理
│   ├── app/             # 应用拆分后的子模块
│   │   ├── market-service.ts   # 市场采集 / 行情覆盖 / PaperTrading 上下文 / 排行计算
│   │   └── routes.ts           # 所有 /api/* 路由注册
│   ├── index.ts         # HTTP + WebSocket 启动入口；启动时补全上证指数历史
│   ├── index-bootstrap.ts      # 上证指数历史补全 / 交易日历解析 / resolveLatestTradingDate
│   ├── scoring-engine.ts        # 四维评分 + 0/1–8 状态分类 + 板块策略矩阵
│   ├── polars-engine.ts         # 排行榜查询 / 排序 / 情绪聚合
│   ├── ranking-config.ts        # RankingRuntimeConfig：因子权重 + 评分配置 + 回测来源
│   ├── backtest-engine.ts       # 回测引擎（日内循环）+ prepareBacktestContext / quickSimulateBacktest
│   ├── backtest-scoring.ts      # 向量化评分预计算（Polars 单次遍历）
│   ├── backtest-param-optimizer.ts  # 两阶段参数优化（评分 + 交易参数）
│   ├── benchmark.ts             # 基准指数对照曲线（搜狐数据源）
│   ├── paper-trading.ts         # 模拟交易：计划 / 执行 / 调度 / 监控 / applyBacktestStrategy
│   ├── paper-trading/helpers.ts # 时钟、判断、状态机纯函数
│   ├── trading-strategy.ts      # 选股 / 仓位 / 止盈止损
│   ├── historical-market.ts     # 行情采集
│   ├── ths-simulated-broker.ts  # 同花顺 AppleScript 桥接（含 K 线报价回退）
│   ├── audit-log.ts             # JSONL 审计日志
│   ├── tasks.ts                 # 异步任务管理 / WebSocket 广播
│   ├── format.ts                # 日期 / 数字工具函数
│   ├── data-store.ts            # 数据门面：SQLite + 旧 JSON 种子导入 + 排行配置
│   ├── sqlite-store.ts          # node:sqlite 仓储层
│   ├── sqlite/                  # SQLite schema / 类型 / 工具拆分
│   │   ├── schema.ts            # 建表迁移（v15/v16 → SCHEMA_VERSION=18）
│   │   └── helpers.ts           # 类型与共用工具函数
│   └── data/                    # 运行时数据（gitignore，含 trending.db、runtime/）
├── src/                  # React 前端
│   ├── pages/           # 页面组件
│   ├── components/      # 通用组件（AppShell / Modal / Charts / Pills / Ui / HeaderActions）
│   ├── context/         # React 上下文（TasksContext：任务进度订阅）
│   └── lib/             # 工具库（api.ts：后端 API 封装）
├── scripts/              # 脚本
│   └── ths_order_dry_run.applescript
├── tests/                # 测试
└── docs/                 # 详细文档
```
