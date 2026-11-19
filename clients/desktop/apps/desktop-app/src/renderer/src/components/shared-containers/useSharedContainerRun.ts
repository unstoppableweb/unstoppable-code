/**
 * Recipient-side run state for one mounted shared container (CAN-2831).
 *
 * Deliberately a hook rather than a slice on `sharedContainerReplicasStore`:
 * run state is scoped to the single container the viewer has open, it is
 * re-read from main on every consent or environment change rather than cached
 * across containers, and keeping it out of the replicas store means a share
 * the recipient only reads never allocates any of it.
 *
 * Everything here fails closed. `runStatus` rejects in main whenever the run
 * flag is off, the platform is not macOS, or this device has not accepted the
 * share, so a rejection is read as "no run affordance" and never surfaced as
 * an error the recipient is asked to act on. Only actions the recipient
 * explicitly took — granting, revoking, saving values, refreshing, running a
 * command — report their failures.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ScriptRunResponse,
  SharedContainerRunStatus,
  UserEnvironmentEntryView,
} from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';

/**
 * `'unsupported'` is the flag-off / non-macOS / not-accepted answer and must
 * render as no affordance at all, not as an error. `'unpublished'` is a
 * readable share whose publisher did not opt into run sharing — also silent,
 * because the recipient cannot do anything about it.
 */
export type SharedContainerRunAvailability =
  | 'loading'
  | 'unsupported'
  | 'unpublished'
  | 'available';

export interface SharedContainerRunState {
  availability: SharedContainerRunAvailability;
  status: SharedContainerRunStatus | null;
  /** True while a consent, environment, or refresh request is in flight. */
  pending: boolean;
  /** True while a published command is still running. */
  commandPending: boolean;
  /** Last failure from an action the recipient explicitly took. */
  error: string | null;
  lastRun: { scriptName: string; response: ScriptRunResponse } | null;
  clearError: () => void;
  reload: () => Promise<void>;
  allowRun: (publisherUserId: string) => Promise<boolean>;
  revokeRun: () => Promise<boolean>;
  saveEnvironment: (values: UserEnvironmentEntryView[]) => Promise<boolean>;
  /**
   * Writes an empty value for every declared name that has none, so the
   * recipient edits a pre-labelled list instead of retyping names that are
   * already known. Empty values are preserved by the environment normalizer,
   * so a placeholder round-trips and stays visibly unset.
   */
  addPlaceholders: () => Promise<boolean>;
  refreshRunCopy: (options?: { stopRunning?: boolean }) => Promise<boolean>;
  /** Runs one published command. Resolves false when the run did not start. */
  runCommand: (scriptName: string) => Promise<boolean>;
}

export interface UseSharedContainerRunOptions {
  containerId: string | null;
  /** Null until the replica is readable; run state is meaningless before then. */
  revisionId: string | null;
  /** Renderer-side flag + platform gate. Main re-checks both independently. */
  featureEnabled: boolean;
}

interface ResolvedSharedContainerRunState {
  key: string;
  availability: Exclude<SharedContainerRunAvailability, 'loading'>;
  status: SharedContainerRunStatus | null;
}

export function useSharedContainerRun({
  containerId,
  revisionId,
  featureEnabled,
}: UseSharedContainerRunOptions): SharedContainerRunState {
  const stateKey =
    featureEnabled && containerId !== null && revisionId !== null
      ? `${containerId}\u0000${revisionId}`
      : null;
  const [resolved, setResolved] =
    useState<ResolvedSharedContainerRunState | null>(null);
  // State setters run after render, so clearing stale state in the load effect
  // is too late: the surface effect from that same render could already close
  // the incoming container's terminal layout. Key the resolution instead and
  // synchronously expose loading/null whenever it belongs to another target.
  const status = resolved?.key === stateKey ? resolved.status : null;
  const availability: SharedContainerRunAvailability =
    stateKey === null
      ? 'unsupported'
      : resolved?.key === stateKey
        ? resolved.availability
        : 'loading';
  const [pending, setPending] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{
    scriptName: string;
    response: ScriptRunResponse;
  } | null>(null);
  const addToast = useGitHubStore((state) => state.addToast);
  // Monotonic token, so a status read issued for one container/revision can
  // never apply after the viewer moved on to another.
  const requestRef = useRef(0);
  const pendingRef = useRef(false);
  const commandPendingRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    if (containerId === null || revisionId === null || stateKey === null)
      return;
    try {
      const next = await window.api.sharedContainers.runStatus({
        containerId,
        revisionId,
      });
      if (requestRef.current !== requestId) return;
      setResolved({
        key: stateKey,
        status: next,
        availability: next.run ? 'available' : 'unpublished',
      });
    } catch {
      // Main fails closed for a disabled flag, a non-macOS host, and an
      // unaccepted share alike. None of those are actionable, so they all
      // resolve to no affordance rather than an error banner.
      if (requestRef.current !== requestId) return;
      setResolved({ key: stateKey, status: null, availability: 'unsupported' });
    }
  }, [containerId, revisionId, stateKey]);

  useEffect(() => {
    setLastRun(null);
    void load();
  }, [load]);

  /**
   * One re-entrancy guard for every mutating action. A second click while the
   * first request is running resolves `false` without issuing a duplicate: two
   * concurrent consent writes or two concurrent run-copy refreshes are exactly
   * the races the main-process mutex refuses anyway.
   */
  const runAction = useCallback(
    async (
      action: () => Promise<void>,
      failureMessage: string,
    ): Promise<boolean> => {
      if (pendingRef.current) return false;
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        await action();
        await load();
        return true;
      } catch (error) {
        setError(failureMessage);
        addToast(failureMessage, 'error', undefined, { caught: error });
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [addToast, load],
  );

  const allowRun = useCallback(
    (publisherUserId: string): Promise<boolean> =>
      runAction(
        () =>
          containerId === null
            ? Promise.reject(new Error('No container is open.'))
            : window.api.sharedContainers.allowRun({
                containerId,
                publisherUserId,
              }),
        'Could not allow this share to run.',
      ),
    [containerId, runAction],
  );

  const revokeRun = useCallback(
    (): Promise<boolean> =>
      runAction(
        () =>
          containerId === null
            ? Promise.reject(new Error('No container is open.'))
            : window.api.sharedContainers.revokeRun({ containerId }),
        'Could not turn off running for this share.',
      ),
    [containerId, runAction],
  );

  const saveEnvironment = useCallback(
    (values: UserEnvironmentEntryView[]): Promise<boolean> =>
      runAction(async () => {
        if (containerId === null) throw new Error('No container is open.');
        await window.api.sharedContainers.saveRunEnvironment({
          containerId,
          values,
        });
      }, 'Could not save these values.'),
    [containerId, runAction],
  );

  const addPlaceholders = useCallback((): Promise<boolean> => {
    const current = status;
    if (!current) return Promise.resolve(false);
    const existing = new Set(current.values.map((entry) => entry.key));
    const seeded: UserEnvironmentEntryView[] = [
      ...current.values,
      ...(current.run?.requiredEnv ?? [])
        .filter((name) => !existing.has(name))
        .map((name) => ({ key: name, value: '' })),
    ];
    return saveEnvironment(seeded);
  }, [saveEnvironment, status]);

  const refreshRunCopy = useCallback(
    (options?: { stopRunning?: boolean }): Promise<boolean> =>
      runAction(
        () =>
          containerId === null || revisionId === null
            ? Promise.reject(new Error('No revision is available.'))
            : window.api.sharedContainers.refreshRunCopy({
                containerId,
                revisionId,
                ...(options?.stopRunning === true ? { stopRunning: true } : {}),
              }),
        'Could not update the run copy. Stop anything still running, then try again.',
      ),
    [containerId, revisionId, runAction],
  );

  const runCommand = useCallback(
    async (scriptName: string): Promise<boolean> => {
      if (pendingRef.current || commandPendingRef.current) return false;
      commandPendingRef.current = true;
      setCommandPending(true);
      setError(null);
      setLastRun(null);
      try {
        if (containerId === null) throw new Error('No container is open.');
        // The wire arm carries no projectId/worktreeId: main derives the
        // viewer sentinel itself, so this cannot address another workspace.
        const response = await window.api.runScript({
          target: 'shared-container',
          scriptName,
          containerId,
        });
        setLastRun({ scriptName, response });
        await load();
        return true;
      } catch (error) {
        const message = 'Could not start this command.';
        setError(message);
        addToast(message, 'error', undefined, { caught: error });
        return false;
      } finally {
        commandPendingRef.current = false;
        setCommandPending(false);
      }
    },
    [addToast, containerId, load],
  );

  const clearError = useCallback((): void => setError(null), []);

  return {
    availability,
    status,
    pending,
    commandPending,
    error,
    lastRun,
    clearError,
    reload: load,
    allowRun,
    revokeRun,
    saveEnvironment,
    addPlaceholders,
    refreshRunCopy,
    runCommand,
  };
}
