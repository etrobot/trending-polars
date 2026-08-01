import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AuditLogger } from './audit-log.js';
import { DataStore } from './data-store.js';
import { ThsSimulatedBroker, ThsSimulatedBrokerError } from './ths-simulated-broker.js';
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

export function createApp(services: Partial<AppServices> = {}) {
  const store = services.store ?? new DataStore();
  const audit = services.audit ?? new AuditLogger(path.join(store.runtime, 'logs'));
  const tasks = services.tasks ?? new TaskRegistry(audit);
  const paper = services.paper ?? new PaperTradingService(new ThsSimulatedBroker({ audit }), {
    stateStore: {
      load: () => store.getPaperTradingState(),
      save: (state) => store.savePaperTradingState(state),
    },
    marketDataProvider: (window, traceId) => marketService.loadPaperContext(window === 'close', traceId),
    calendarRefresher: async () => {
      const refreshed = await refreshTradingCalendar(store);
      return refreshed.calendar;
    },
    thsReadiness: new ThsLifecycle({ audit }),
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