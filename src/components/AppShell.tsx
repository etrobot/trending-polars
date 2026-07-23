import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  BellRing,
  FlaskConical,
  LayoutDashboard,
  Radio,
  SquareTerminal,
  X,
} from 'lucide-react';
import { HeaderActionsProvider } from './HeaderActions';
import { useTasks } from '../context/TasksContext';
import type { TaskSnapshot } from '../types';

const navItems = [
  { to: '/', label: '市场总览', shortLabel: '市场', code: '01', icon: LayoutDashboard, end: true },
  { to: '/ranking', label: '量化排行', shortLabel: '截面', code: '02', icon: BarChart3 },
  { to: '/backtest', label: '策略回测', shortLabel: '策略', code: '03', icon: FlaskConical },
  { to: '/simulated-trading', label: '模拟交易', shortLabel: '交易', code: '04', icon: SquareTerminal },
];

const statusLabel: Record<TaskSnapshot['status'], string> = {
  pending: '排队',
  running: '运行',
  completed: '完成',
  failed: '失败',
  cancelled: '停止',
};

const statusStyle: Record<TaskSnapshot['status'], string> = {
  pending: 'bg-surface-elevated text-muted',
  running: 'bg-primary/10 text-primary-active',
  completed: 'bg-accent-green-soft text-green',
  failed: 'bg-accent-red-soft text-red-cn',
  cancelled: 'bg-surface-elevated text-muted',
};

function TaskCenter() {
  const { tasks, runningCount, connected, panelOpen, setPanelOpen, cancelTask } = useTasks();
  return (
    <div className="relative">
      <button
        className="focus-ring relative flex h-7 w-8 items-center justify-center border border-line bg-surface text-body transition hover:border-coral hover:text-ink"
        onClick={() => setPanelOpen(!panelOpen)}
        style={{ borderRadius: 2 }}
        title="后台任务"
        aria-label={`后台任务，${runningCount} 个运行中`}
      >
        <BellRing className="h-3.5 w-3.5" />
        {runningCount > 0 && <span className="absolute -right-1.5 -top-1.5 h-4 min-w-4 bg-coral px-0.5 font-mono text-[11px] leading-4 text-white" style={{ borderRadius: 2 }}>{runningCount}</span>}
      </button>
      {panelOpen && (
        <>
          <button className="fixed inset-0 z-30 cursor-default" onClick={() => setPanelOpen(false)} aria-label="关闭任务面板" />
          <div className="animate-enter fixed inset-x-3 top-14 z-40 max-h-[78vh] overflow-hidden border border-line bg-surface shadow-[0_4px_12px_rgba(0,0,0,0.12)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+7px)] sm:w-[400px]" style={{ borderRadius: 3 }}>
            <div className="module-header">
              <div className="flex items-center gap-2">
                <div className="font-display text-base text-ink">后台任务</div>
                <span className={`h-1.5 w-1.5 ${connected ? 'bg-green' : 'bg-muted'}`} title={connected ? '实时连接正常' : '正在重连'} />
              </div>
              <button className="focus-ring border border-transparent p-1.5 text-muted hover:border-line hover:bg-surface-elevated hover:text-ink" onClick={() => setPanelOpen(false)}><X className="h-3.5 w-3.5" /></button>
            </div>
            <div className="max-h-[64vh] overflow-y-auto">
              {tasks.length === 0 ? (
                <div className="px-5 py-10 text-center text-[11px] text-muted">暂无任务</div>
              ) : tasks.map((task) => (
                <div key={task.id} className="border-b border-line-soft px-3 py-2.5 last:border-b-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[11px] text-ink">{task.name}</div>
                      <div className="mt-1 truncate text-[11px] text-muted">{task.message}</div>
                    </div>
                    <span className={`shrink-0 px-1.5 py-0.5 font-mono text-[11px] ${statusStyle[task.status]}`} style={{ borderRadius: 1 }}>{statusLabel[task.status]}</span>
                  </div>
                  <div className="mt-2 h-1 overflow-hidden bg-line-soft">
                    <div className={`h-full transition-[width] duration-300 ${task.status === 'failed' ? 'bg-red-cn' : task.status === 'completed' ? 'bg-green' : 'bg-coral'}`} style={{ width: `${task.progress}%` }} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
                    <span>{task.updated_at}</span>
                    {['pending', 'running'].includes(task.status) && <button className="text-red-text hover:underline" onClick={() => void cancelTask(task.id)}>停止</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Sidebar() {
  const { connected } = useTasks();
  return (
    <aside className="hidden h-screen w-[52px] flex-col items-center border-r border-line bg-canvas text-ink lg:sticky lg:top-0 lg:flex">
      <div className="flex h-12 w-full items-center justify-center text-primary-active" aria-hidden="true">
        <Activity className="h-4.5 w-4.5" />
      </div>

      <nav className="flex w-full flex-col items-center gap-1 py-2" aria-label="主导航">
        {navItems.map(({ to, label, shortLabel, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            aria-label={label}
            title={label}
            className={({ isActive }) => `focus-ring flex h-11 w-11 flex-col items-center justify-center gap-1 border font-mono text-[11px] leading-none transition ${isActive ? 'border-primary bg-primary text-on-primary' : 'border-transparent text-muted hover:border-line hover:bg-surface-elevated hover:text-ink'}`}
            style={{ borderRadius: 2 }}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{shortLabel}</span>
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex h-11 w-full items-center justify-center border-t border-line" title={connected ? '数据连接正常' : '数据连接中断'}>
        <span className={`h-1.5 w-1.5 ${connected ? 'bg-green' : 'bg-muted'}`} />
      </div>
    </aside>
  );
}

function Header({ setActionsTarget }: { setActionsTarget: (node: HTMLDivElement | null) => void }) {
  const location = useLocation();
  const { connected } = useTasks();
  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeRoute = useMemo(() => {
    if (location.pathname.startsWith('/details')) return { label: '板块详情', code: '01A' };
    return navItems.find((item) => item.to === location.pathname) ?? { label: '页面不存在', code: 'ERR' };
  }, [location.pathname]);
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(clock);
  const date = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(clock);

  return (
    <>
      <header className="sticky top-0 z-20 flex h-10 items-center gap-2 border-b border-line bg-canvas px-3 sm:px-4 lg:px-4">
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <NavLink to="/" className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center bg-canvas text-ink lg:hidden border border-line" style={{ borderRadius: 2 }}><Activity className="h-3.5 w-3.5" /></NavLink>
          <span className="font-mono text-[11px] text-accent-text">{activeRoute.code}</span>
          <div className="truncate text-[11px] text-ink">{activeRoute.label}</div>
        </div>

        <div ref={setActionsTarget} className="header-actions flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-x-auto" role="toolbar" aria-label="页面操作" />

        <div className="flex shrink-0 items-center gap-2.5">
          <div className="hidden items-center gap-1.5 border-r border-line pr-3 font-mono text-[11px] text-muted lg:flex">
            <Radio className={`h-3 w-3 ${connected ? 'text-green' : 'text-muted'}`} />
            {connected ? '在线' : '重连中'}
          </div>
          <div className="hidden font-mono text-[11px] text-ink xl:block">{date} {time}</div>
          <TaskCenter />
        </div>
      </header>

      <nav className="flex gap-px overflow-x-auto border-b border-line bg-canvas lg:hidden" aria-label="移动端导航">
        {navItems.map(({ to, label, code, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `focus-ring flex h-9 min-w-max flex-1 items-center justify-center gap-1.5 bg-canvas px-3 font-mono text-[11px] transition ${isActive ? 'border-b-2 border-coral text-ink' : 'text-muted hover:text-ink'}`}
          >
            <Icon className="h-3 w-3" />
            <span>{code} {label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}

export function AppShell() {
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);

  return (
    <HeaderActionsProvider target={actionsTarget}>
      <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-[52px_minmax(0,1fr)]">
        <Sidebar />
        <div className="flex min-h-screen min-w-0 flex-col bg-canvas">
          <Header setActionsTarget={setActionsTarget} />
          <main className="mx-auto w-full max-w-[1920px] flex-1 px-3 py-3 sm:px-4 lg:px-4">
            <Outlet />
          </main>
        </div>
      </div>
    </HeaderActionsProvider>
  );
}
