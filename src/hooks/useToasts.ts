import { useCallback, useRef, useState } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  type: 'success' | 'error';
  message: string;
  /** Optional follow-up, rendered as a link under the message. */
  action?: ToastAction;
}

/**
 * Older toasts are dropped rather than stacking off the top of the screen.
 * Three is enough to see a burst of related results (split, then trim, then
 * save) without the stack becoming its own wall of text.
 */
const MAX_VISIBLE_TOASTS = 3;

/**
 * Transient action results for one view.
 *
 * State lives with the view that raises it, so navigating away drops the
 * queue with the rest of that view's state -- there is no app-level provider
 * to keep in sync.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);

  const showToast = useCallback((toast: Omit<Toast, 'id'>) => {
    setToasts((current) => {
      const next = [...current, { ...toast, id: nextIdRef.current++ }];
      return next.slice(-MAX_VISIBLE_TOASTS);
    });
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  return { toasts, showToast, dismissToast, clearToasts };
}
