'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { SettingsFailure } from '../../errors';

export interface PagedListPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type PagedListState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: SettingsFailure }
  | {
      readonly status: 'ready';
      readonly items: readonly T[];
      readonly nextCursor: string | null;
      readonly loadingMore: boolean;
      /** A failed next page; the loaded rows stay. */
      readonly moreFailure: SettingsFailure | null;
    };

export interface PagedList<T> {
  readonly state: PagedListState<T>;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

/**
 * A cursor-paged list that restarts whenever `key` changes. Later pages
 * append, de-duplicated by `idOf`, and a response for an older key or
 * attempt is dropped.
 */
export function usePagedList<T>(
  key: string,
  load: (cursor: string | null) => Promise<PagedListPage<T>>,
  idOf: (item: T) => string,
  toFailure: (error: unknown) => SettingsFailure,
): PagedList<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PagedListState<T>>({ status: 'loading' });
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const toFailureRef = useRef(toFailure);
  toFailureRef.current = toFailure;
  const idOfRef = useRef(idOf);
  idOfRef.current = idOf;
  const stateRef = useRef(state);
  stateRef.current = state;
  const inFlight = useRef(false);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    const current = generation.current;
    setState({ status: 'loading' });
    loadRef.current(null).then(
      (page) => {
        if (generation.current !== current) return;
        setState({
          status: 'ready',
          items: page.items,
          nextCursor: page.nextCursor,
          loadingMore: false,
          moreFailure: null,
        });
      },
      (error: unknown) => {
        if (generation.current !== current) return;
        setState({ status: 'error', failure: toFailureRef.current(error) });
      },
    );
  }, [key, attempt]);

  const loadMore = useCallback((): void => {
    const previous = stateRef.current;
    if (
      previous.status !== 'ready' ||
      previous.nextCursor === null ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    const current = generation.current;
    setState({ ...previous, loadingMore: true, moreFailure: null });
    loadRef.current(previous.nextCursor).then(
      (page) => {
        if (generation.current !== current) return;
        inFlight.current = false;
        setState((latest) => {
          if (latest.status !== 'ready') return latest;
          const seen = new Set(latest.items.map(idOfRef.current));
          return {
            status: 'ready',
            items: [
              ...latest.items,
              ...page.items.filter((item) => !seen.has(idOfRef.current(item))),
            ],
            nextCursor: page.nextCursor,
            loadingMore: false,
            moreFailure: null,
          };
        });
      },
      (error: unknown) => {
        if (generation.current !== current) return;
        inFlight.current = false;
        const failure = toFailureRef.current(error);
        setState((latest) =>
          latest.status === 'ready'
            ? { ...latest, loadingMore: false, moreFailure: failure }
            : latest,
        );
      },
    );
  }, []);

  const retry = useCallback((): void => {
    const previous = stateRef.current;
    // A failed next page retries in place; a failed first page reloads.
    if (previous.status === 'ready' && previous.moreFailure !== null)
      loadMore();
    else setAttempt((value) => value + 1);
  }, [loadMore]);

  return { state, loadMore, retry };
}

/**
 * Calls `onVisible` when the returned element scrolls into view, so a list
 * loads its next page as the reader reaches its end, with no extra control.
 */
export function useLoadMoreSentinel(
  enabled: boolean,
  onVisible: () => void,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element === null) return undefined;
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          onVisibleRef.current();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [enabled]);
  return ref;
}
