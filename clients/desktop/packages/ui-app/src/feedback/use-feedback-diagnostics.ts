'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FeedbackDiagnosticsExpiredError,
  type FeedbackDiagnosticsSnapshot,
  type FeedbackReportClient,
  type FeedbackReportContext,
  type FeedbackReportError,
} from '@canopy/protocol/feedback-report';

export type FeedbackDiagnosticsState =
  | { status: 'idle' }
  | { status: 'preparing' }
  | { status: 'ready'; snapshot: FeedbackDiagnosticsSnapshot }
  | { status: 'failed' }
  | { status: 'expired' };

export interface FeedbackDiagnostics {
  readonly state: FeedbackDiagnosticsState;
  /** The current snapshot, preparing one when none exists. */
  readonly ensure: (scope: {
    context: FeedbackReportContext;
    error?: FeedbackReportError;
  }) => Promise<FeedbackDiagnosticsSnapshot>;
  /** Unchecking diagnostics: forgets and releases the snapshot. */
  readonly discard: () => void;
  /** A host call said this snapshot is gone. A replacement is never expired. */
  readonly markExpired: (snapshotId: string) => void;
}

/** setTimeout overflows past this; a snapshot lives far less. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * One prepared archive per dialog opening, so inspection, Save a copy and
 * submission all use the same bytes. Expiry never prepares a replacement on
 * its own: the person has to ask, because they may have inspected the old one.
 */
export function useFeedbackDiagnostics(
  client: FeedbackReportClient,
): FeedbackDiagnostics {
  const [state, setState] = useState<FeedbackDiagnosticsState>({
    status: 'idle',
  });
  const current = useRef<FeedbackDiagnosticsSnapshot | null>(null);
  const inFlight = useRef<Promise<FeedbackDiagnosticsSnapshot> | null>(null);
  // Bumped whenever an in-flight result stops being wanted.
  const generation = useRef(0);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearExpiryTimer = useCallback((): void => {
    if (expiryTimer.current !== null) clearTimeout(expiryTimer.current);
    expiryTimer.current = null;
  }, []);

  const release = useCallback(
    (snapshot: FeedbackDiagnosticsSnapshot): void => {
      void client.releaseDiagnostics?.(snapshot.id).catch(() => undefined);
    },
    [client],
  );

  const markExpired = useCallback(
    (snapshotId: string): void => {
      const expired = current.current;
      if (expired?.id !== snapshotId) return;
      current.current = null;
      clearExpiryTimer();
      release(expired);
      setState({ status: 'expired' });
    },
    [clearExpiryTimer, release],
  );

  const ensure = useCallback<FeedbackDiagnostics['ensure']>(
    (scope) => {
      if (current.current) return Promise.resolve(current.current);
      if (inFlight.current) return inFlight.current;
      if (!client.prepareDiagnostics)
        return Promise.reject(new Error('Diagnostics are unavailable.'));
      const requested = generation.current;
      setState({ status: 'preparing' });
      const preparing = client
        .prepareDiagnostics(scope)
        .then(
          (snapshot) => {
            if (requested !== generation.current) {
              release(snapshot);
              throw new FeedbackDiagnosticsExpiredError();
            }
            current.current = snapshot;
            setState({ status: 'ready', snapshot });
            const remaining = Date.parse(snapshot.expiresAt) - Date.now();
            expiryTimer.current = setTimeout(
              () => markExpired(snapshot.id),
              Math.min(Math.max(remaining, 0), MAX_TIMER_MS),
            );
            return snapshot;
          },
          (error: unknown) => {
            if (requested === generation.current)
              setState({ status: 'failed' });
            throw error;
          },
        )
        .finally(() => {
          if (requested === generation.current) inFlight.current = null;
        });
      inFlight.current = preparing;
      return preparing;
    },
    [client, markExpired, release],
  );

  const discard = useCallback((): void => {
    generation.current += 1;
    inFlight.current = null;
    clearExpiryTimer();
    const snapshot = current.current;
    current.current = null;
    if (snapshot) release(snapshot);
    setState({ status: 'idle' });
  }, [clearExpiryTimer, release]);

  useEffect(
    () => (): void => {
      generation.current += 1;
      inFlight.current = null;
      clearExpiryTimer();
      const snapshot = current.current;
      current.current = null;
      if (snapshot) release(snapshot);
    },
    [clearExpiryTimer, release],
  );

  return { state, ensure, discard, markExpired };
}
