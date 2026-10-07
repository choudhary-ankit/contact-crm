import { reactive } from 'vue';

export interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
  action?: { label: string; run: () => void };
}

// module-level so a toast survives route changes (e.g. "Moved to trash" after leaving the detail page)
const toasts = reactive<Toast[]>([]);
let seq = 0;

export function useToasts() {
  function dismiss(id: number) {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }
  function push(toast: Omit<Toast, 'id'>, ms = 7000) {
    const id = ++seq;
    toasts.push({ ...toast, id });
    if (ms > 0) setTimeout(() => dismiss(id), ms);
    return id;
  }
  return { toasts, push, dismiss };
}
