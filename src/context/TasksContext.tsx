import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TaskSnapshot } from '../types';
import { api } from '../lib/api';

interface TasksContextValue {
  tasks: TaskSnapshot[];
  runningCount: number;
  connected: boolean;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  cancelTask: (id: string) => Promise<void>;
  refreshTasks: () => Promise<void>;
}

const TasksContext = createContext<TasksContextValue | null>(null);

function sorted(tasks: TaskSnapshot[]): TaskSnapshot[] {
  return [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const refreshTasks = useCallback(async () => {
    const result = await api<{ tasks: TaskSnapshot[] }>('/api/tasks');
    setTasks(sorted(result.tasks));
  }, []);

  useEffect(() => {
    void refreshTasks().catch(() => undefined);
  }, [refreshTasks]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let disposed = false;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/tasks`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as { type: string; tasks?: TaskSnapshot[]; task?: TaskSnapshot };
        if (message.type === 'snapshot' && message.tasks) {
          setTasks(sorted(message.tasks));
        } else if (message.type === 'update' && message.task) {
          setTasks((current) => sorted([message.task!, ...current.filter((task) => task.id !== message.task!.id)]).slice(0, 100));
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!disposed) timer = window.setTimeout(connect, 1800);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  const cancelTask = useCallback(async (id: string) => {
    await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
  }, []);

  const value = useMemo<TasksContextValue>(() => ({
    tasks,
    runningCount: tasks.filter((task) => ['pending', 'running'].includes(task.status)).length,
    connected,
    panelOpen,
    setPanelOpen,
    cancelTask,
    refreshTasks,
  }), [tasks, connected, panelOpen, cancelTask, refreshTasks]);

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}

export function useTasks() {
  const value = useContext(TasksContext);
  if (!value) throw new Error('useTasks must be used inside TasksProvider');
  return value;
}

export function useTaskResult(taskId: string | null, onComplete: (task: TaskSnapshot) => void) {
  const { tasks } = useTasks();
  useEffect(() => {
    if (!taskId) return;
    const task = tasks.find((item) => item.id === taskId);
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) onComplete(task);
  }, [taskId, tasks, onComplete]);
}
