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
│   ├── app.ts           # API 路由
│   ├── index.ts         # HTTP + WebSocket 入口
│   ├── scoring-engine.ts    # 四维评分 + 七态分类
│   ├── polars-engine.ts     # 排行榜查询
│   ├── backtest-engine.ts   # 回测引擎（日内循环）
│   ├── backtest-scoring.ts  # 向量化评分预计算（Polars 单次遍历）
│   ├── benchmark.ts         # 基准指数对照曲线（搜狐数据源）
│   ├── paper-trading.ts     # 模拟交易
│   ├── trading-strategy.ts  # 交易策略
│   ├── historical-market.ts # 行情采集
│   ├── ths-simulated-broker.ts  # 同花顺桥接
│   └── data/            # 运行时数据（gitignore）
├── src/                  # React 前端
│   ├── pages/           # 页面组件
│   └── components/      # 通用组件
├── scripts/              # 脚本
│   └── ths_order_dry_run.applescript
├── tests/                # 测试
└── docs/                 # 详细文档
```
