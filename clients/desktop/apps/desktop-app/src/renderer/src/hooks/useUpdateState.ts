import { useCallback, useEffect, useRef, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  ACTIONABLE_PHASES,
  type DependencyVersions,
  type UpdateEvent,
  type UpdateState,
} from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';

const INITIAL_UPDATE_STATE: UpdateState = { phase: 'idle' };

function applyUpdateEvent(
  previousState: UpdateState,
  event: UpdateEvent,
): UpdateState {
  const checkedAt = new Date().toISOString();

  switch (event.type) {
    case 'checking':
      if (ACTIONABLE_PHASES.has(previousState.phase)) {
        return previousState;
      }
      return {
        phase: 'checking',
      };
    case 'available':
      return {
        phase: 'available',
        info: event.info,
        checkedAt,
      };
    case 'not-available':
      return {
        phase: 'not-available',
        checkedAt,
        message: `${brandText.appName} is up to date.`,
      };
    case 'download-progress':
      return {
        phase: 'downloading',
        info: previousState.info,
        progress: event.progress,
        checkedAt: previousState.checkedAt,
      };
    case 'downloaded':
      return {
        phase: 'downloaded',
        info: event.info,
        checkedAt,
        ...(event.info.installedByPackageManager &&
        ((previousState.phase === 'downloaded' &&
          previousState.info?.installedByPackageManager) ||
          (previousState.phase === 'idle' && !previousState.info))
          ? { installPending: previousState.installPending }
          : {}),
      };
    case 'install-pending':
      return {
        ...previousState,
        installPending: event.pending,
      };
    case 'install-refused':
      return event.state;
    case 'error':
      return {
        ...previousState,
        phase: 'error',
        message: event.message,
        installPending: false,
        checkedAt,
      };
  }
}

interface UseUpdateStateResult {
  appVersion: string | null;
  dependencyVersions: DependencyVersions | null;
  state: UpdateState;
  refresh: () => Promise<void>;
}

export function useUpdateState(): UseUpdateStateResult {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [dependencyVersions, setDependencyVersions] =
    useState<DependencyVersions | null>(null);
  const [state, setState] = useState<UpdateState>(INITIAL_UPDATE_STATE);
  const stateRef = useRef(state);
  const eventRevision = useRef(0);
  const snapshotRevision = useRef(0);
  const pendingEvent = useRef<{
    event: Extract<UpdateEvent, { type: 'install-pending' }>;
    revision: number;
  } | null>(null);
  const rollbackReadRevision = useRef<number | null>(null);
  const disposed = useRef(false);

  const rereadState = useCallback((revision: number): void => {
    if (disposed.current || rollbackReadRevision.current === revision) return;
    rollbackReadRevision.current = revision;
    void window.api.update
      .getState()
      .then((currentState) => {
        if (disposed.current || revision !== eventRevision.current) return;
        // A completed rollback read also supersedes any older hydration.
        snapshotRevision.current++;
        stateRef.current = currentState;
        setState(currentState);
      })
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const revision = eventRevision.current;
    const snapshot = snapshotRevision.current;
    const [nextVersion, nextDepVersions, nextState] = await Promise.all([
      window.api.update.getAppVersion(),
      window.api.update.getDependencyVersions(),
      window.api.update.getState(),
    ]);
    if (disposed.current) return;
    setAppVersion(nextVersion);
    setDependencyVersions(nextDepVersions);
    if (snapshot === snapshotRevision.current) {
      // Pending events carry no phase/info: layer the latest one over the
      // snapshot rather than discarding the only authoritative hydration.
      const pending = pendingEvent.current;
      const buffered = pending && pending.revision > revision ? pending : null;
      const hydratedState = buffered
        ? applyUpdateEvent(nextState, buffered.event)
        : nextState;
      stateRef.current = hydratedState;
      setState(hydratedState);
      if (
        buffered &&
        !buffered.event.pending &&
        nextState.info?.installedByPackageManager
      ) {
        rereadState(buffered.revision);
      }
    }
  }, [rereadState]);

  useEffect(() => {
    disposed.current = false;
    eventRevision.current++;
    snapshotRevision.current++;
    void refresh();

    const unsubscribe = window.api.update.onUpdateEvent((event) => {
      const previousState = stateRef.current;
      const revision = ++eventRevision.current;
      if (event.type === 'install-pending') {
        pendingEvent.current = { event, revision };
      } else {
        snapshotRevision.current++;
      }
      const nextState = applyUpdateEvent(previousState, event);
      stateRef.current = nextState;
      setState(nextState);
      // A package rollback cancels the relaunch through this existing event.
      // Read the authoritative idle state without pretending a feed check ran.
      if (
        event.type === 'install-pending' &&
        !event.pending &&
        previousState.info?.installedByPackageManager
      ) {
        rereadState(revision);
      }
    });

    return (): void => {
      disposed.current = true;
      unsubscribe();
    };
  }, [refresh, rereadState]);

  return {
    appVersion,
    dependencyVersions,
    state,
    refresh,
  };
}
