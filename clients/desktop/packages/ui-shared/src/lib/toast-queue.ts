import type { AppError } from '@canopy/protocol/app-errors';
import type { FeedbackReportTelemetry } from '@canopy/protocol/feedback-report';
import type { NoticeIntent } from '../components/Notice';
import { toastStackLifetimeMs } from './toast-lifetime';

export type ToastType = 'error' | 'info' | 'success' | 'warning';

/** The shared notice intent that carries each toast type's glyph and ink. */
export const TOAST_INTENT: Record<ToastType, NoticeIntent> = {
  error: 'destructive',
  warning: 'attention',
  success: 'positive',
  info: 'neutral',
};

/** Where a background failure happened, and how to get there. */
export interface ToastOrigin {
  /** Names the destination on its button (`Open terminal`). */
  readonly label: string;
  /**
   * Returns `false` when the destination is gone or can't open, so the toast
   * stays up instead of being lost.
   */
  readonly open: () => boolean | void;
}

/** What makes an error toast a background failure rather than a message. */
export interface ToastFailure {
  /** Classification, reference and report eligibility; the card shows `message`. */
  readonly error: AppError;
  readonly origin: ToastOrigin;
  /** Session links read when the error happened. */
  readonly telemetry?: FeedbackReportTelemetry;
}

export interface QueuedToast {
  readonly id: string;
  readonly type: ToastType;
  readonly message: string;
  /** Adding a toast with a visible toast's key replaces that toast. */
  readonly key?: string;
  readonly failure?: ToastFailure;
}

export type QueuedToastInput = Omit<QueuedToast, 'id'>;

export interface ToastQueueOptions<T extends QueuedToastInput> {
  /** A newer toast evicts the oldest beyond this. Uncapped when omitted. */
  readonly maxVisible?: number;
  /**
   * What makes two toasts the same toast. A newer unkeyed toast replaces a
   * visible unkeyed one with the same identity, so a repeated event shows
   * once, with a fresh clock. Defaults to the type and message ({@link defaultToastIdentity});
   * hosts whose toasts carry more visible text (a title, a project) add it.
   */
  readonly identity?: (toast: T) => string;
  /** Runs once per added toast, after subscribers saw it. */
  readonly onAdd?: (toast: T & { readonly id: string }) => void;
}

export interface ToastQueue<T extends QueuedToastInput> {
  /** Oldest first. Stable between changes, for `useSyncExternalStore`. */
  readonly getSnapshot: () => readonly (T & { readonly id: string })[];
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Adds a toast and returns its id. A generated id is never reused, even
   * across a reset, so a stale timer cannot dismiss a later toast. A supplied
   * id that is still visible leaves the queue as it was.
   */
  readonly add: (toast: T & { readonly id?: string }) => string;
  /** No-op for an unknown or already dismissed id. */
  readonly dismiss: (id: string) => void;
  /** Removes the visible toast with this key, as its condition clears. */
  readonly dismissKey: (key: string) => void;
  /** Removes every toast. */
  readonly reset: () => void;
}

const GENERATED_ID = /^toast-(\d+)$/;

/** Two toasts with the same type and message read as one. */
export function defaultToastIdentity(toast: QueuedToastInput): string {
  return `${toast.type}\u0000${toast.message}`;
}

/**
 * A small, framework-free list of live toasts, one per host. The queue decides
 * which toasts exist; the shared `ToastStack` decides how long each stays up
 * and reports expiry back through `dismiss`. Removing a toast from the queue
 * never runs a host's dismiss callback: that belongs to the person's dismissal.
 */
export function createToastQueue<T extends QueuedToastInput>({
  maxVisible,
  identity = defaultToastIdentity,
  onAdd,
}: ToastQueueOptions<T> = {}): ToastQueue<T> {
  let toasts: readonly (T & { readonly id: string })[] = [];
  const listeners = new Set<() => void>();
  let lastGeneratedId = 0;

  const publish = (next: readonly (T & { readonly id: string })[]): void => {
    toasts = next;
    for (const listener of Array.from(listeners)) listener();
  };

  return {
    getSnapshot: () => toasts,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    add: (input): string => {
      const supplied = input.id;
      if (supplied !== undefined) {
        if (toasts.some((toast) => toast.id === supplied)) return supplied;
        const generated = GENERATED_ID.exec(supplied);
        if (generated !== null)
          lastGeneratedId = Math.max(lastGeneratedId, Number(generated[1]));
      }
      const id = supplied ?? `toast-${String(++lastGeneratedId)}`;
      const toast = { ...input, id };
      // A newer toast replaces the visible one it repeats: the same key (a
      // condition's newer state), or the same visible content between toasts
      // with the same key identity. An unkeyed repeat never removes a keyed
      // toast: producers leave the key off stale events so they can't
      // replace a newer state.
      const same = identity(input);
      const retained = toasts.filter(
        (entry) =>
          entry.key !== input.key ||
          (input.key === undefined && identity(entry) !== same),
      );
      const next = [...retained, toast];
      publish(maxVisible === undefined ? next : next.slice(-maxVisible));
      onAdd?.(toast);
      return id;
    },
    dismiss: (id): void => {
      if (!toasts.some((toast) => toast.id === id)) return;
      publish(toasts.filter((toast) => toast.id !== id));
    },
    dismissKey: (key): void => {
      if (!toasts.some((toast) => toast.key === key)) return;
      publish(toasts.filter((toast) => toast.key !== key));
    },
    reset: (): void => {
      if (toasts.length === 0) return;
      publish([]);
    },
  };
}

/**
 * A toast's lifetime by type. A failure stays until it is closed whatever
 * `holdMs` a host passes; see {@link toastStackLifetimeMs}.
 */
export function toastQueueLifetimeMs(
  type: ToastType,
  defaultMs: number,
  holdMs?: number,
): number {
  return toastStackLifetimeMs(TOAST_INTENT[type], defaultMs, holdMs);
}
