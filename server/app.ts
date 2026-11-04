import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AuditLogger, type AuditLoggerLike } from './audit-log.js';
import { DataStore } from './data-store.js';
import { ThsSimulatedBroker, ThsSimulatedBrokerError, type SimulatedBroker } from './ths-simulated-broker.js';
import { ThsWebSimulatedBroker } from './ths-web-broker.js';
import { ThsLifecycle } from './ths-lifecycle.js';
import { PaperTradingService } from './paper-trading.js';
import { refreshTradingCalendar } from './index-bootstrap.js';
import { TaskRegistry } from './tasks.js';
import { MarketService } from './app/market-service.js';
import { registerRoutes } from './app/routes.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface AppServices {
  store: DataStore;
  tasks: TaskRegistry;
  paper: PaperTradingService;
  audit: AuditLogger;
}

/** 模拟交易通道：默认使用同花顺 Web 模拟盘（cgiwt），THS_BROKER_MODE=applescript 时回退 macOS AppleScript 桥接。 */
function createBroker(audit: AuditLoggerLike): SimulatedBroker {
  if (process.env.THS_BROKER_MODE === 'applescript') return new ThsSimulatedBroker({ audit });
  return new ThsWebSimulatedBroker({ audit });
}

export function createApp(services: Partial<AppServices> = {}) {
  const store = services.store ?? new DataStore();
  const audit = services.audit ?? new AuditLogger(path.join(store.runtime, 'logs'));
  const tasks = services.tasks ?? new TaskRegistry(audit);
  const broker = createBroker(audit);
  const paper = services.paper ?? new PaperTradingService(broker, {
    stateStore: {
      load: () => store.getPaperTradingState(),
      save: (state) => store.savePaperTradingState(state),
    },
    marketDataProvider: (window, traceId) => marketService.loadPaperContext(window === 'close', traceId),
    calendarRefresher: async () => {
      const refreshed = await refreshTradingCalendar(store);
      return refreshed.calendar;
    },
    // AppleScript 生命周期拉起仅对 macOS GUI 通道有意义；Web 通道靠浏览器交互登录。
    thsReadiness: broker instanceof ThsSimulatedBroker ? new ThsLifecycle({ audit }) : undefined,
    audit,
  });

  const marketService = new MarketService(store, audit);
  const app = express();

  // Register all routes
  registerRoutes(app, { store, tasks, paper, audit }, marketService, MODULE_DIR);

  // Static files (SPA)
  const distDir = path.resolve(MODULE_DIR, '..', 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((request, response, next) => {
      if (request.path.startsWith('/api/') || request.path.startsWith('/ws/')) {
        next();
        return;
      }
      response.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Error handler
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = error instanceof ThsSimulatedBrokerError ? 409 : 500;
    response.status(statusCode).json({ error: message });
  });

  return { app, services: { store, tasks, paper, audit } };
}