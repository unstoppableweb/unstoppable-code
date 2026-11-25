import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import type {
  ScriptActionsContext,
  ScriptActionsReviewRequest,
  ScriptActionsSnapshot,
} from '@canopy/protocol/script-actions';
import { useCanopyClient } from '../CanopyClientProvider';

export interface UseScriptActionsOptions {
  readonly projectId: string | null | undefined;
  readonly worktreeId: string | null | undefined;
  /** Review lists dismissed rows; composer and pins do not. */
  readonly includeDismissed?: boolean;
  /** Mount-time gate in addition to the capability. Defaults to true. */
  readonly enabled?: boolean;
}

export type ScriptActionsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseScriptActionsResult {
  /** `CanopyCapabilities.scriptActions` and a complete target. */
  readonly supported: boolean;
  readonly snapshot: ScriptActionsSnapshot | null;
  readonly status: ScriptActionsLoadStatus;
  /** Last failed load; prior data is retained. */
  readonly error: string | null;
  /**
   * The structured form of {@link error}, for error recording only: never
   * rendered. Null without an error, for a cancellation, or when it cannot be
   * built.
   */
  readonly appError: AppError | null;
  readonly refresh: () => Promise<ScriptActionsSnapshot | null>;
  readonly rescan: () => Promise<ScriptActionsSnapshot | null>;
  readonly review: (
    entries: ScriptActionsReviewRequest['entries'],
    decision: ScriptActionsReviewRequest['decision'],
  ) => Promise<ScriptActionsSnapshot>;
  readonly setShortcut: (
    id: string,
    accelerator: string | null,
  ) => Promise<ScriptActionsSnapshot>;
  readonly setPinned: (
    id: string,
    pinned: boolean,
  ) => Promise<ScriptActionsSnapshot>;
  readonly enableShellAliasScan: () => Promise<ScriptActionsSnapshot>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Couldn't load scripts";
}

/** Recording is best effort: a host without Web Crypto must not hide the failure. */
function caughtAppError(error: unknown): AppError | null {
  try {
    return toAppError(error) ?? null;
  } catch {
    return null;
  }
}

function contextKey(context: ScriptActionsContext | null): string | null {
  return context === null
    ? null
    : JSON.stringify([context.projectId, context.worktreeId]);
}

function visible(
  snapshot: ScriptActionsSnapshot,
  includeDismissed: boolean,
): ScriptActionsSnapshot {
  return includeDismissed
    ? snapshot
    : {
        ...snapshot,
        actions: snapshot.actions.filter(
          (action) => action.status !== 'dismissed',
        ),
      };
}

interface ScriptActionsState {
  readonly key: string | null;
  readonly snapshot: ScriptActionsSnapshot | null;
  readonly status: ScriptActionsLoadStatus;
  readonly error: string | null;
  readonly appError: AppError | null;
}

/** One idle state, so resetting an idle hook does not render its host again. */
const IDLE_STATE: ScriptActionsState = {
  key: null,
  snapshot: null,
  status: 'idle',
  error: null,
  appError: null,
};

/**
 * Script-action snapshot for one project/worktree. Loads on mount, refreshes on
 * `scriptActions.changed`, window focus and after every write, and drops
 * responses that arrive after the target changes or the consumer unmounts.
 */
export function useScriptActions(
  options: UseScriptActionsOptions,
): UseScriptActionsResult {
  const client = useCanopyClient();
  return useScriptActionsWithClient(client, options);
}

/** {@link useScriptActions} with an explicit client, for hosts outside the provider. */
export function useScriptActionsWithClient(
  client: CanopyClient,
  {
    projectId,
    worktreeId,
    includeDismissed = false,
    enabled = true,
  }: UseScriptActionsOptions,
): UseScriptActionsResult {
  const supported =
    enabled &&
    client.capabilities.scriptActions === true &&
    typeof projectId === 'string' &&
    projectId !== '' &&
    typeof worktreeId === 'string' &&
    worktreeId !== '';
  const context: ScriptActionsContext | null =
    supported && projectId && worktreeId ? { projectId, worktreeId } : null;
  const key = contextKey(context);
  const [state, setState] = useState<ScriptActionsState>(IDLE_STATE);
  // Each target/mount gets a generation; late responses for an older one are dropped.
  const generationRef = useRef(0);
  // Rendering order is independent from submission authority: focus/list events
  // may supersede the displayed result without invalidating a fresh query.
  const authorityRef = useRef(0);
  const keyRef = useRef<string | null>(key);
  const contextRef = useRef<ScriptActionsContext | null>(context);
  contextRef.current = context;
  const includeDismissedRef = useRef(includeDismissed);
  includeDismissedRef.current = includeDismissed;

  const apply = useCallback(
    (generation: number, snapshot: ScriptActionsSnapshot): void => {
      if (generation !== generationRef.current) return;
      setState({
        key: keyRef.current,
        snapshot: visible(snapshot, includeDismissedRef.current),
        status: 'ready',
        error: null,
        appError: null,
      });
    },
    [],
  );

  const fail = useCallback((generation: number, error: unknown): void => {
    if (generation !== generationRef.current) return;
    setState((previous) => ({
      key: keyRef.current,
      snapshot: previous.key === keyRef.current ? previous.snapshot : null,
      status: 'error',
      error: errorMessage(error),
      appError: caughtAppError(error),
    }));
  }, []);

  const load = useCallback(
    async (
      operation: 'list' | 'rescan',
    ): Promise<ScriptActionsSnapshot | null> => {
      const current = contextRef.current;
      if (current === null) return null;
      const generation = ++generationRef.current;
      const authority = authorityRef.current;
      setState((previous) =>
        previous.key === keyRef.current
          ? { ...previous, status: 'loading' }
          : {
              key: keyRef.current,
              snapshot: null,
              status: 'loading',
              error: null,
              appError: null,
            },
      );
      try {
        const snapshot =
          operation === 'rescan'
            ? await client.command('scriptActions.rescan', current)
            : await client.query('scriptActions.list', {
                ...current,
                includeDismissed: includeDismissedRef.current,
              });
        apply(generation, snapshot);
        return authority === authorityRef.current ? snapshot : null;
      } catch (error) {
        if (operation === 'rescan' && generation === generationRef.current) {
          // Review can open while the first list is still pending. Recover the
          // retained inventory on scan failure, without losing the scan error.
          try {
            const retained = await client.query('scriptActions.list', {
              ...current,
              includeDismissed: includeDismissedRef.current,
            });
            apply(generation, retained);
          } catch {
            // The scan error remains the actionable failure.
          }
        }
        fail(generation, error);
        return null;
      }
    },
    [apply, client, fail],
  );

  useEffect(() => {
    generationRef.current += 1;
    authorityRef.current += 1;
    keyRef.current = key;
    if (key === null) {
      setState(IDLE_STATE);
      return undefined;
    }
    void load('list');
    const current = contextRef.current;
    const unsubscribe =
      current === null
        ? undefined
        : client.subscribe(
            'scriptActions.changed',
            (event) => {
              if (
                event.projectId === current.projectId &&
                event.worktreeId === current.worktreeId
              )
                void load('list');
            },
            current,
          );
    const onFocus = (): void => {
      void load('list');
    };
    const target = typeof window === 'undefined' ? null : window;
    target?.addEventListener('focus', onFocus);
    return (): void => {
      generationRef.current += 1;
      authorityRef.current += 1;
      unsubscribe?.();
      target?.removeEventListener('focus', onFocus);
    };
  }, [client, includeDismissed, key, load]);

  const write = useCallback(
    async (
      run: (current: ScriptActionsContext) => Promise<ScriptActionsSnapshot>,
    ): Promise<ScriptActionsSnapshot> => {
      const current = contextRef.current;
      if (current === null)
        throw new Error('Script actions are unavailable here.');
      const generation = ++generationRef.current;
      authorityRef.current += 1;
      const snapshot = await run(current);
      apply(generation, snapshot);
      return snapshot;
    },
    [apply],
  );

  const review = useCallback<UseScriptActionsResult['review']>(
    (entries, decision) =>
      write((current) =>
        client.command('scriptActions.review', {
          ...current,
          entries,
          decision,
        }),
      ),
    [client, write],
  );
  const setShortcut = useCallback<UseScriptActionsResult['setShortcut']>(
    (id, accelerator) =>
      write((current) =>
        client.command('scriptActions.setShortcut', {
          ...current,
          id,
          accelerator,
        }),
      ),
    [client, write],
  );
  const setPinned = useCallback<UseScriptActionsResult['setPinned']>(
    (id, pinned) =>
      write((current) =>
        client.command('scriptActions.setPinned', { ...current, id, pinned }),
      ),
    [client, write],
  );
  const enableShellAliasScan = useCallback<
    UseScriptActionsResult['enableShellAliasScan']
  >(
    () =>
      write((current) =>
        client.command('scriptActions.enableShellAliasScan', current),
      ),
    [client, write],
  );
  const refresh = useCallback(() => load('list'), [load]);
  const rescan = useCallback(() => load('rescan'), [load]);

  const current = state.key === key ? state : null;
  return {
    supported,
    snapshot: current?.snapshot ?? null,
    status: current?.status ?? (supported ? 'loading' : 'idle'),
    error: current?.error ?? null,
    appError: current?.appError ?? null,
    refresh,
    rescan,
    review,
    setShortcut,
    setPinned,
    enableShellAliasScan,
  };
}
