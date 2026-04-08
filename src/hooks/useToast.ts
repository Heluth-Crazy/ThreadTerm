import { useToastStore, type ToastType } from '../stores/toastStore';

export function useToast() {
  const addToast = useToastStore((s) => s.addToast);

  return {
    toast: (msg: string, type?: ToastType, duration?: number) => addToast(msg, type, duration),
    success: (msg: string) => addToast(msg, 'success'),
    error: (msg: string) => addToast(msg, 'error'),
    warn: (msg: string) => addToast(msg, 'warning'),
    info: (msg: string) => addToast(msg, 'info'),
  };
}
