import { useCallback, useEffect, useRef, useState } from 'react';
import { toAppError } from '@canopy/protocol/app-errors';
import type { DictationModelStatus } from '@canopy/protocol/canopy-core';

/** How often the status is read again while a download runs. */
const POLL_MS = 500;
/**
 * And otherwise, so a download the app started on its own (after an update
 * changed the model) shows up while it's watched.
 */
const IDLE_POLL_MS = 5_000;

/** Bytes as settings show sizes: decimal megabytes, as the plan quotes them. */
export function formatModelSize(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return megabytes >= 10
    ? `${Math.round(megabytes)} MB`
    : `${megabytes.toFixed(1)} MB`;
}

export function percentOf(status: DictationModelStatus): number {
  const total = status.progress?.totalBytes ?? 0;
  if (total <= 0) return 0;
  return Math.floor(((status.progress?.receivedBytes ?? 0) / total) * 100);
}

/** One read or action that settled while its epoch was still current. */
export type SpeechModelResult =
  | { readonly kind: 'read' | 'action'; readonly status: DictationModelStatus }
  | { readonly kind: 'read' | 'action'; readonly error: string };

export interface UseSpeechModelStatusInput {
  /** Read the status once on mount (Settings). */
  readonly fetchOnMount: boolean;
  /** Read it again on the poll cadence while true. */
  readonly poll: boolean;
  /** Every result applied, including failures and equal statuses. */
  readonly onResult?: (result: SpeechModelResult) => void;
}

export interface UseSpeechModelStatusResult {
  readonly status: DictationModelStatus | null;
  /** The last read's failure, until a read or action succeeds. */
  readonly readError: string | null;
  readonly busy: boolean;
  /** The last action's failure, until a read or action succeeds. */
  readonly actionError: string | null;
  readonly refresh: () => Promise<void>;
  readonly act: (action: () => Promise<DictationModelStatus>) => Promise<void>;
  /** Forget the status, errors and busy, and ignore everything in flight. */
  readonly reset: () => void;
}

type LastError = { readonly kind: 'read' | 'action'; readonly message: string };

/**
 * The Linux speech model's status (CAN-7231), shared by Settings → Dictation
 * and the composer's download prompt (CAN-7341). Results that settle after a
 * `reset()` are dropped, and within one epoch an older revision never
 * replaces a newer one.
 */
export function useSpeechModelStatus({
  fetchOnMount,
  poll,
  onResult,
}: UseSpeechModelStatusInput): UseSpeechModelStatusResult {
  const [status, setStatus] = useState<DictationModelStatus | null>(null);
  const [lastError, setLastError] = useState<LastError | null>(null);
  const [pendingActionId, setPendingActionId] = useState<number | null>(null);
  const readEpochRef = useRef(0);
  const pendingActionIdRef = useRef<number | null>(null);
  const nextActionIdRef = useRef(0);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  // Keeps the newest status: a poll that started before an action can
  // answer after it, and `revision` says which is newer.
  const accept = useCallback((next: DictationModelStatus): void => {
    setStatus((previous) =>
      previous && next.revision < previous.revision ? previous : next,
    );
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const epoch = readEpochRef.current;
    let result: SpeechModelResult;
    try {
      const next = await window.api.voice.speechModel.status();
      if (epoch !== readEpochRef.current) return;
      accept(next);
      setLastError(null);
      result = { kind: 'read', status: next };
    } catch (error) {
      if (epoch !== readEpochRef.current) return;
      // Keep the last status; the next poll or action tries again.
      const message =
        toAppError(error)?.detail.message.trim() ||
        'Couldn’t read the speech model’s status.';
      setLastError({ kind: 'read', message });
      result = { kind: 'read', error: message };
    }
    onResultRef.current?.(result);
  }, [accept]);

  const act = useCallback(
    async (action: () => Promise<DictationModelStatus>): Promise<void> => {
      const epoch = readEpochRef.current;
      nextActionIdRef.current += 1;
      const actionId = nextActionIdRef.current;
      pendingActionIdRef.current = actionId;
      setPendingActionId(actionId);
      setLastError(null);
      let result: SpeechModelResult | null = null;
      try {
        const next = await action();
        if (epoch === readEpochRef.current) {
          accept(next);
          result = { kind: 'action', status: next };
        }
      } catch (error) {
        if (epoch === readEpochRef.current) {
          const message =
            toAppError(error)?.detail.message.trim() ||
            'Something went wrong. Try again.';
          setLastError({ kind: 'action', message });
          result = { kind: 'action', error: message };
        }
      } finally {
        if (
          epoch === readEpochRef.current &&
          pendingActionIdRef.current === actionId
        ) {
          pendingActionIdRef.current = null;
          setPendingActionId(null);
        }
      }
      if (result) onResultRef.current?.(result);
    },
    [accept],
  );

  const reset = useCallback((): void => {
    readEpochRef.current += 1;
    pendingActionIdRef.current = null;
    setPendingActionId(null);
    setStatus(null);
    setLastError(null);
  }, []);

  useEffect(() => {
    if (fetchOnMount) void refresh();
  }, [fetchOnMount, refresh]);

  const running =
    status?.state === 'downloading' || status?.state === 'verifying';
  useEffect(() => {
    if (!poll) return undefined;
    const timer = window.setInterval(
      () => void refresh(),
      running ? POLL_MS : IDLE_POLL_MS,
    );
    return (): void => window.clearInterval(timer);
  }, [poll, running, refresh]);

  return {
    status,
    readError: lastError?.kind === 'read' ? lastError.message : null,
    busy: pendingActionId !== null,
    actionError: lastError?.kind === 'action' ? lastError.message : null,
    refresh,
    act,
    reset,
  };
}
