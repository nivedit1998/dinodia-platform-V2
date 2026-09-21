// Architecture: Reusable web UI component src/components/ui/Toast.tsx; renders part of the platform surface and receives state/actions from its parent flow.
'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

type ToastKind = 'success' | 'warning' | 'neutral';

type ToastItem = {
  id: string;
  title: string;
  message?: string;
  kind: ToastKind;
};

type ToastInput = {
  title: string;
  message?: string;
  kind?: ToastKind;
};

type ToastContextValue = {
  pushToast: (input: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const kindClass: Record<ToastKind, string> = {
  success: 'border-[color:var(--success)]/35 bg-[color:var(--success)]/12',
  warning: 'border-[color:var(--warning)]/35 bg-[color:var(--warning)]/12',
  neutral: 'border-border bg-surface',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback((input: ToastInput) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next: ToastItem = {
      id,
      title: input.title,
      message: input.message,
      kind: input.kind ?? 'neutral',
    };
    setToasts((current) => [...current, next]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3500);
  }, []);

  const value = useMemo(() => ({ pushToast }), [pushToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] mx-auto flex max-w-2xl flex-col gap-2 px-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={[
              'pointer-events-auto rounded-[14px] border p-3 shadow-md backdrop-blur luxury-enter',
              kindClass[toast.kind],
            ].join(' ')}
            role="status"
            aria-live="polite"
          >
            <p className="text-sm font-semibold text-foreground">{toast.title}</p>
            {toast.message ? (
              <p className="mt-0.5 text-xs text-muted">{toast.message}</p>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
