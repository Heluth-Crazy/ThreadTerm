import { useEffect, useRef, useState } from 'react';
import { X, Info, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { useToastStore, type Toast, type ToastType } from '../../stores/toastStore';

const ICON_MAP: Record<ToastType, React.FC<{ className?: string }>> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: XCircle,
};

const COLOR_MAP: Record<ToastType, string> = {
  info: 'border-l-blue-500 text-blue-600 dark:text-blue-400',
  success: 'border-l-emerald-500 text-emerald-600 dark:text-emerald-400',
  warning: 'border-l-yellow-500 text-yellow-600 dark:text-yellow-400',
  error: 'border-l-red-500 text-red-600 dark:text-red-400',
};

const ICON_COLOR_MAP: Record<ToastType, string> = {
  info: 'text-blue-500',
  success: 'text-emerald-500',
  warning: 'text-yellow-500',
  error: 'text-red-500',
};

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Trigger slide-in on next frame
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    // Start exit animation before removal
    if (toast.duration > 0) {
      timerRef.current = setTimeout(() => {
        setVisible(false);
      }, Math.max(toast.duration - 300, 0));
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.duration]);

  const handleClose = () => {
    setVisible(false);
    setTimeout(() => onRemove(toast.id), 300);
  };

  const Icon = ICON_MAP[toast.type];

  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border border-border/60 border-l-4 bg-card px-3 py-2.5 shadow-lg ${COLOR_MAP[toast.type]}`}
      style={{
        transform: visible ? 'translateX(0)' : 'translateX(120%)',
        opacity: visible ? 1 : 0,
        transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 300ms ease-in-out',
        maxWidth: '360px',
        minWidth: '260px',
      }}
    >
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${ICON_COLOR_MAP[toast.type]}`} />
      <span className="flex-1 text-sm text-foreground leading-snug">{toast.message}</span>
      <button
        type="button"
        onClick={handleClose}
        className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-5 right-5 z-[9999] flex flex-col-reverse gap-2 pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} onRemove={removeToast} />
        </div>
      ))}
    </div>
  );
}
