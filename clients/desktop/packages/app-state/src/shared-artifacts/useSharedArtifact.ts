import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isSharedArtifactsClientError,
  type SharedArtifactErrorCode,
  type SharedArtifactsClient,
} from '@canopy/app-core';
import type {
  CanopyErrorKind,
  SharedArtifact,
  SharedArtifactGetResult,
} from '@canopy/protocol/canopy-core';

/** A failed read, reduced to what the viewer branches on. */
export interface SharedArtifactFailure {
  /** `unknown` for anything that isn't a typed client error. */
  readonly kind: CanopyErrorKind | 'unknown';
  readonly code?: SharedArtifactErrorCode;
}

export function toSharedArtifactFailure(error: unknown): SharedArtifactFailure {
  if (isSharedArtifactsClientError(error)) {
    return error.code === undefined
      ? { kind: error.kind }
      : { kind: error.kind, code: error.code };
  }
  return { kind: 'unknown' };
}

/**
 * What a host that read on the server hands the viewer, so the first client
 * read is skipped: a result, or the typed failure it got.
 */
export type SharedArtifactInitialState =
  | { readonly status: 'ready'; readonly result: SharedArtifactGetResult }
  | { readonly status: 'failed'; readonly failure: SharedArtifactFailure };

export type SharedArtifactLoad =
  /** No client, so nothing is read. */
  | { readonly status: 'unavailable' }
  /** The viewer unshared it in this session. Terminal: nothing is read. */
  | { readonly status: 'unshared' }
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly failure: SharedArtifactFailure }
  | {
      readonly status: 'ready';
      readonly result: SharedArtifactGetResult;
      /** A reload is in flight; the loaded DTO stays shown. */
      readonly refreshing: boolean;
    };

export interface UseSharedArtifactResult {
  readonly load: SharedArtifactLoad;
  /** Re-reads the DTO. Resolves with the result it applied, or null. */
  readonly reload: () => Promise<SharedArtifactGetResult | null>;
  /** Applies a mutation's returned artifact without a refetch. */
  readonly applyArtifact: (artifact: SharedArtifact) => void;
  /** Applies a full result read elsewhere (the content hash check). */
  readonly applyResult: (result: SharedArtifactGetResult) => void;
  /** Enters the terminal unshared state. */
  readonly markUnshared: () => void;
}

function initialLoad(
  client: SharedArtifactsClient | null,
  initial: SharedArtifactInitialState | undefined,
): SharedArtifactLoad {
  if (client === null) return { status: 'unavailable' };
  if (initial?.status === 'ready')
    return { status: 'ready', result: initial.result, refreshing: false };
  if (initial?.status === 'failed')
    return { status: 'failed', failure: initial.failure };
  return { status: 'loading' };
}

/**
 * Loads one shared artifact (CAN-8017). Responses apply in request order: a
 * read that returns after a newer read or mutation result is dropped. An
 * `initial` state skips the first read. The hook takes the client as an
 * argument because the public share page has no `CanopyClientProvider`.
 */
export function useSharedArtifact(
  client: SharedArtifactsClient | null,
  artifactId: string,
  initial?: SharedArtifactInitialState,
): UseSharedArtifactResult {
  const [load, setLoad] = useState<SharedArtifactLoad>(() =>
    initialLoad(client, initial),
  );
  // Every read and every applied result takes the next sequence number; a
  // read applies only while it still holds the latest one.
  const sequenceRef = useRef(0);
  const unsharedRef = useRef(false);
  const mountedRef = useRef(true);
  // The id the host's initial state answers. The read for it is skipped,
  // also when a strict-mode remount runs the effect twice.
  const initialIdRef = useRef<string | null>(
    initial === undefined ? null : artifactId,
  );

  const reload =
    useCallback(async (): Promise<SharedArtifactGetResult | null> => {
      if (client === null || unsharedRef.current) return null;
      sequenceRef.current += 1;
      const sequence = sequenceRef.current;
      // Another id's artifact is never kept on screen: its controls would
      // act on the old id until this read lands.
      setLoad((current) =>
        current.status === 'ready' && current.result.artifact.id === artifactId
          ? { ...current, refreshing: true }
          : { status: 'loading' },
      );
      try {
        const result = await client.get(artifactId);
        if (!mountedRef.current || sequence !== sequenceRef.current)
          return null;
        if (unsharedRef.current) return null;
        setLoad({ status: 'ready', result, refreshing: false });
        return result;
      } catch (error) {
        if (!mountedRef.current || sequence !== sequenceRef.current)
          return null;
        if (unsharedRef.current) return null;
        setLoad({ status: 'failed', failure: toSharedArtifactFailure(error) });
        return null;
      }
    }, [artifactId, client]);

  useEffect(() => {
    mountedRef.current = true;
    if (initialIdRef.current === artifactId && client !== null) {
      // Already answered by the host's initial state.
    } else if (client === null) {
      setLoad({ status: 'unavailable' });
    } else {
      initialIdRef.current = null;
      unsharedRef.current = false;
      void reload();
    }
    return (): void => {
      mountedRef.current = false;
      // Drops any read still in flight for the previous id or client.
      sequenceRef.current += 1;
    };
  }, [artifactId, client, reload]);

  const applyResult = useCallback((result: SharedArtifactGetResult): void => {
    if (unsharedRef.current) return;
    sequenceRef.current += 1;
    setLoad({ status: 'ready', result, refreshing: false });
  }, []);

  const applyArtifact = useCallback((artifact: SharedArtifact): void => {
    if (unsharedRef.current) return;
    sequenceRef.current += 1;
    setLoad((current) =>
      current.status === 'ready'
        ? {
            status: 'ready',
            result: { ...current.result, artifact },
            refreshing: false,
          }
        : { status: 'ready', result: { artifact }, refreshing: false },
    );
  }, []);

  const markUnshared = useCallback((): void => {
    unsharedRef.current = true;
    sequenceRef.current += 1;
    setLoad({ status: 'unshared' });
  }, []);

  return { load, reload, applyArtifact, applyResult, markUnshared };
}
