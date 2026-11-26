'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isPromiseLike } from '../lib/promise-like';

/** The one label of every retry control: a failed place, notice, or toast. */
export const TRY_AGAIN_LABEL = 'Try again';

/** A retry control's label while its work runs, beside its spinner. */
export const TRYING_AGAIN_LABEL = 'Trying again…';

export interface RetryState {
  /** The latest retry this hook started has not settled yet. */
  readonly retrying: boolean;
  /**
   * Starts a retry. The capsule is disabled while one runs; a retry started
   * anyway (the host's own state moved on) takes over the spinner, and an
   * older run settling later no longer ends it.
   */
  readonly retry: () => void;
}

/**
 * Runs a failed load again and reports whether it is still running, so the
 * failed state can stay on screen with its Try again capsule spinning instead
 * of blanking to a loading state. The host keeps rendering its failure while
 * `retrying` is true and its own read is still loading, and replaces it once
 * that read settles: with the loaded content, or with the failure again.
 *
 * `run` owns its own failure: a rejection only ends the spinner, so the host's
 * error state is what reports it.
 */
export function useRetry(run: () => unknown): RetryState {
  const [retrying, setRetrying] = useState(false);
  const latest = useRef(0);
  const mounted = useRef(true);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const retry = useCallback((): void => {
    const id = ++latest.current;
    let result: unknown;
    try {
      result = runRef.current();
    } catch {
      if (mounted.current) setRetrying(false);
      return;
    }
    if (!isPromiseLike(result)) {
      if (mounted.current) setRetrying(false);
      return;
    }
    setRetrying(true);
    const settle = (): void => {
      if (mounted.current && latest.current === id) setRetrying(false);
    };
    Promise.resolve(result).then(settle, settle);
  }, []);

  return { retrying, retry };
}
