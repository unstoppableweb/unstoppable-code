import { useCallback, useEffect, useRef, useState } from 'react';
import type { SharedArtifactsClient } from '@canopy/app-core';
import type {
  SharedArtifact,
  SharedArtifactListParams,
} from '@canopy/protocol/canopy-core';
import {
  toSharedArtifactFailure,
  type SharedArtifactFailure,
} from './useSharedArtifact';

export type SharedArtifactListQuery = Pick<
  SharedArtifactListParams,
  'view' | 'organizationId'
>;

export interface SharedArtifactListState {
  readonly status: 'unavailable' | 'loading' | 'ready' | 'failed';
  readonly artifacts: readonly SharedArtifact[];
  readonly nextCursor: string | null;
  /** A first-page failure; the list shows the error state. */
  readonly failure: SharedArtifactFailure | null;
  readonly loadingMore: boolean;
  /** A failed "Load more"; the rows already shown stay. */
  readonly loadMoreFailure: SharedArtifactFailure | null;
}

export interface UseSharedArtifactListResult {
  readonly state: SharedArtifactListState;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

const UNAVAILABLE: SharedArtifactListState = {
  status: 'unavailable',
  artifacts: [],
  nextCursor: null,
  failure: null,
  loadingMore: false,
  loadMoreFailure: null,
};

const LOADING: SharedArtifactListState = {
  ...UNAVAILABLE,
  status: 'loading',
};

/**
 * Cursor paging over `core.sharedArtifact.list` (CAN-8017). Changing the
 * view or organization starts over and drops a page still in flight for the
 * previous query.
 */
export function useSharedArtifactList(
  client: SharedArtifactsClient | null,
  query: SharedArtifactListQuery,
): UseSharedArtifactListResult {
  const { view, organizationId } = query;
  const [state, setState] = useState<SharedArtifactListState>(
    client === null ? UNAVAILABLE : LOADING,
  );
  const [attempt, setAttempt] = useState(0);
  const generationRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const params = useCallback(
    (cursor?: string): SharedArtifactListParams => ({
      view,
      ...(organizationId === undefined ? {} : { organizationId }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    [organizationId, view],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (client === null) {
      setState(UNAVAILABLE);
      return undefined;
    }
    setState(LOADING);
    client.list(params()).then(
      (result) => {
        if (generation !== generationRef.current) return;
        setState({
          ...LOADING,
          status: 'ready',
          artifacts: result.artifacts,
          nextCursor: result.nextCursor,
        });
      },
      (error: unknown) => {
        if (generation !== generationRef.current) return;
        setState({
          ...LOADING,
          status: 'failed',
          failure: toSharedArtifactFailure(error),
        });
      },
    );
    return (): void => {
      generationRef.current += 1;
    };
  }, [attempt, client, params]);

  const loadMore = useCallback((): void => {
    const current = stateRef.current;
    if (
      client === null ||
      current.status !== 'ready' ||
      current.nextCursor === null ||
      current.loadingMore
    )
      return;
    const generation = generationRef.current;
    // Set the ref now, so a second call before the next render sees the
    // page in flight and doesn't fetch the same cursor again.
    const pending: SharedArtifactListState = {
      ...current,
      loadingMore: true,
      loadMoreFailure: null,
    };
    stateRef.current = pending;
    setState(pending);
    client.list(params(current.nextCursor)).then(
      (result) => {
        if (generation !== generationRef.current) return;
        setState((latest) => ({
          ...latest,
          artifacts: [...latest.artifacts, ...result.artifacts],
          nextCursor: result.nextCursor,
          loadingMore: false,
        }));
      },
      (error: unknown) => {
        if (generation !== generationRef.current) return;
        setState((latest) => ({
          ...latest,
          loadingMore: false,
          loadMoreFailure: toSharedArtifactFailure(error),
        }));
      },
    );
  }, [client, params]);

  const retry = useCallback((): void => setAttempt((value) => value + 1), []);

  return { state, loadMore, retry };
}
