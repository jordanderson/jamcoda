import { memo, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, X } from 'lucide-react';
import type { Toast } from '@/hooks/useToasts';

/**
 * Toasts clear themselves so an action result never becomes permanent page
 * furniture. Errors linger longer than successes: they carry a reason worth
 * reading, and the user cannot infer them from the state of the page the way
 * a success is confirmed by the list it just changed.
 */
const AUTO_DISMISS_MS: Record<Toast['type'], number> = {
  success: 5000,
  error: 9000
};

interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

/**
 * Bottom-right stack of transient messages.
 *
 * Memoised, and it must stay that way: the detail page re-renders every
 * animation frame during playback, and `toasts`/`onDismiss` from `useToasts`
 * are referentially stable so this subtree is skipped on those frames.
 */
export const ToastStack = memo(function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  // Hovering or focusing anywhere in the stack holds every timer, so a long
  // message cannot expire out from under someone reading it or reaching for
  // its action.
  const [isPaused, setIsPaused] = useState(false);

  return (
    // Always mounted, empty or not: a live region added to the DOM at the same
    // moment as its content is announced unreliably. `pointer-events-none`
    // keeps the empty container from swallowing clicks on the page beneath.
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} isPaused={isPaused} onDismiss={onDismiss} />
      ))}
    </div>
  );
});

interface ToastItemProps {
  toast: Toast;
  isPaused: boolean;
  onDismiss: (id: number) => void;
}

function ToastItem({ toast, isPaused, onDismiss }: ToastItemProps) {
  const { id, type, message, action } = toast;
  const isSuccess = type === 'success';

  useEffect(() => {
    if (isPaused) return;
    // Leaving the stack restarts the full duration rather than resuming the
    // remainder. Simpler, and it errs toward giving the message more time.
    const timer = setTimeout(() => onDismiss(id), AUTO_DISMISS_MS[type]);
    return () => clearTimeout(timer);
  }, [id, type, isPaused, onDismiss]);

  const Icon = isSuccess ? CheckCircle : AlertCircle;

  return (
    <div
      data-testid="toast"
      className={`animate-toast-in pointer-events-auto flex items-start gap-2 rounded-lg border p-3 shadow-lg ${
        isSuccess
          ? 'border-green-200 bg-green-50 text-green-800'
          : 'border-red-200 bg-red-50 text-red-800'
      }`}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">{message}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-1 text-sm font-medium underline"
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => onDismiss(id)}
        className="flex-shrink-0 opacity-60 transition-opacity hover:opacity-100"
        title="Dismiss"
        aria-label="Dismiss notification"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
