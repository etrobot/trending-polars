import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ open, onClose, title, description, children, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className={`animate-enter max-h-[90vh] w-full overflow-auto border border-line bg-canvas-soft p-4 shadow-[0_4px_8px_rgba(0,0,0,0.35)] ${width}`} style={{ borderRadius: 3 }} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-line pb-3">
          <div>
            <h3 className="font-display text-xl font-semibold text-ink">{title}</h3>
            {description && <p className="mt-1 text-[11px] leading-4 text-muted">{description}</p>}
          </div>
          <button className="focus-ring border border-transparent p-1.5 text-muted transition hover:border-line hover:bg-surface-elevated hover:text-ink" onClick={onClose} aria-label="关闭"><X className="h-3.5 w-3.5" /></button>
        </div>
        <div className="pt-4">{children}</div>
      </div>
    </div>
  );
}
