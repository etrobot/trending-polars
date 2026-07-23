import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const HeaderActionsTargetContext = createContext<HTMLElement | null>(null);

export function HeaderActionsProvider({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return <HeaderActionsTargetContext.Provider value={target}>{children}</HeaderActionsTargetContext.Provider>;
}

export function PageHeaderActions({ children }: { children: ReactNode }) {
  const target = useContext(HeaderActionsTargetContext);
  return target ? createPortal(children, target) : null;
}
