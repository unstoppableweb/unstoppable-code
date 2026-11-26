import { useCallback, useEffect, useRef, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  defaultCoworkWorkspaceIdForContext,
} from '@canopy/protocol/ui-labels';
import { isRegisteredCoworkWorkspaceId } from '@/lib/cowork-registry';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { getHomeScope, isHomeCloudTarget } from './homeScope';

/**
 * CAN-7038: Home's catch-all send target, Personal's Chats workspace
 * (`cowork-default`), is created by the main process the first time chat
 * projects are listed. Nothing guaranteed that listing ran after first-run
 * Skip, so Home could sit on "Choose project" with Send disabled. This module
 * runs that existing listing on demand and verifies its result instead of
 * trusting the promise: the loader may resolve without the default (a
 * degraded index), and only a default the projects store lists as cowork is
 * dispatched as a chat rather than as a code project.
 */

/** How long a settled failure waits before each automatic retry. */
export const HOME_DEFAULT_CHATS_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 3_000,
];
/** How long Home shows setting up before it offers Try again instead. */
export const HOME_DEFAULT_CHATS_PENDING_DEADLINE_MS = 10_000;
/** How long first-run completion waits for the default before moving on. */
export const FIRST_RUN_DEFAULT_CHATS_WAIT_MS = 3_000;

export type PersonalDefaultChatsOutcome =
  | { readonly status: 'ready' }
  /** A scoped window lists no chat projects; it never provisions one. */
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed'; readonly reason: 'error' | 'missing' };

export type PersonalDefaultChatsWaitOutcome =
  | PersonalDefaultChatsOutcome
  /** Still outstanding after the caller's wait; it may still complete. */
  | { readonly status: 'timeout' };

/**
 * Personal's Chats is listed by the projects store and registered as a cowork
 * target, so a send there dispatches as a chat. Store-only: no IPC.
 */
export function isPersonalDefaultChatsRegistered(
  projects = useProjectsStore.getState().projects,
): boolean {
  return (
    isRegisteredCoworkWorkspaceId(DEFAULT_COWORK_WORKSPACE_ID) &&
    projects.some(
      (project) =>
        project.id === DEFAULT_COWORK_WORKSPACE_ID && project.type === 'cowork',
    )
  );
}

function isScopedWindow(): boolean {
  return useStandaloneChatStore.getState().scopedWorkspaceId !== null;
}

/**
 * The outstanding attempt, shared by first-run completion and every mounted
 * Home. Cleared when it settles, so a settled failure never answers a later
 * request and the next one starts afresh.
 */
const inFlight = new Map<string, Promise<PersonalDefaultChatsOutcome>>();

/** Identity for asynchronous work; a context change invalidates its consumer. */
export function homeSendTargetSessionKey(): string {
  return JSON.stringify([
    useWorkspaceContextStore.getState().accountEpoch,
    useStandaloneChatStore.getState().scopedWorkspaceId,
    getSidebarScopingContext(),
  ]);
}

async function provisionPersonalDefaultChats(
  session: string,
): Promise<PersonalDefaultChatsOutcome> {
  try {
    // Listing chat projects creates Personal's Chats when it is missing; the
    // projects reload then registers it as a cowork target.
    await useStandaloneChatStore.getState().loadChatProjects();
    if (homeSendTargetSessionKey() !== session)
      return { status: 'unsupported' };
    await useProjectsStore
      .getState()
      .loadProjects({ silent: true, requireSuccess: true });
  } catch (error) {
    reportClientAppError(error);
    return { status: 'failed', reason: 'error' };
  }
  if (homeSendTargetSessionKey() !== session) return { status: 'unsupported' };
  if (isPersonalDefaultChatsRegistered()) return { status: 'ready' };
  reportClientAppError(
    new Error(
      'Chats workspace was not listed after chat projects loaded (CAN-7038)',
    ),
  );
  return { status: 'failed', reason: 'missing' };
}

/**
 * Makes Personal's Chats a registered send target. Returns at once, without
 * IPC, when it already is. Concurrent callers share one attempt, so several
 * Home mounts or a retry while a request is still queued never stack
 * duplicate listings behind it.
 */
export function ensurePersonalDefaultChats(): Promise<PersonalDefaultChatsOutcome> {
  const scopedWorkspaceId = useStandaloneChatStore.getState().scopedWorkspaceId;
  if (
    scopedWorkspaceId !== null &&
    scopedWorkspaceId !== DEFAULT_COWORK_WORKSPACE_ID
  )
    return Promise.resolve({ status: 'unsupported' });
  if (isPersonalDefaultChatsRegistered()) {
    return Promise.resolve({ status: 'ready' });
  }
  if (isScopedWindow()) return Promise.resolve({ status: 'unsupported' });
  const session = homeSendTargetSessionKey();
  const outstanding = inFlight.get(session);
  if (outstanding) return outstanding;
  const attempt = provisionPersonalDefaultChats(session).finally(() => {
    if (inFlight.get(session) === attempt) inFlight.delete(session);
  });
  inFlight.set(session, attempt);
  return attempt;
}

/**
 * `ensurePersonalDefaultChats`, waiting at most `timeoutMs`. A timeout only
 * stops this caller waiting: the request keeps running, and a late success
 * still registers the default for Home to pick up.
 */
export function waitForPersonalDefaultChats(
  timeoutMs: number,
): Promise<PersonalDefaultChatsWaitOutcome> {
  return waitForChatsAttempt(ensurePersonalDefaultChats(), timeoutMs);
}

function waitForChatsAttempt(
  attempt: Promise<PersonalDefaultChatsOutcome>,
  timeoutMs: number,
): Promise<PersonalDefaultChatsWaitOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ status: 'timeout' });
    }, timeoutMs);
    void attempt.then((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}

/** The picker uses the current context's authorized provisioning boundary. */
export function waitForHomeDefaultChats(
  workspaceId: string,
): Promise<PersonalDefaultChatsWaitOutcome> {
  if (workspaceId === DEFAULT_COWORK_WORKSPACE_ID) {
    return waitForPersonalDefaultChats(FIRST_RUN_DEFAULT_CHATS_WAIT_MS);
  }
  const context = getSidebarScopingContext();
  if (
    isScopedWindow() ||
    context?.kind !== 'organization' ||
    defaultCoworkWorkspaceIdForContext(context) !== workspaceId
  ) {
    return Promise.resolve({ status: 'unsupported' });
  }
  const session = homeSendTargetSessionKey();
  const key = JSON.stringify([session, workspaceId]);
  let attempt = inFlight.get(key);
  if (!attempt) {
    const organizationId = context.organizationId;
    attempt = (async (): Promise<PersonalDefaultChatsOutcome> => {
      try {
        await window.api.chatProject.ensureOrgDefaultCoworkWorkspace(
          organizationId,
        );
        if (homeSendTargetSessionKey() !== session)
          return { status: 'unsupported' };
        await useProjectsStore
          .getState()
          .loadProjects({ silent: true, requireSuccess: true });
        if (homeSendTargetSessionKey() !== session)
          return { status: 'unsupported' };
        if (
          isRegisteredCoworkWorkspaceId(workspaceId) &&
          useProjectsStore
            .getState()
            .projects.some(
              (project) =>
                project.id === workspaceId && project.type === 'cowork',
            )
        ) {
          return { status: 'ready' };
        }
        reportClientAppError(
          new Error(
            'Organization Chats was not registered after provisioning (CAN-7038)',
          ),
        );
        return { status: 'failed', reason: 'missing' };
      } catch (error) {
        reportClientAppError(error);
        return { status: 'failed', reason: 'error' };
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
  }
  return waitForChatsAttempt(attempt, FIRST_RUN_DEFAULT_CHATS_WAIT_MS);
}

/**
 * Personal's Chats as Home sees it:
 * - `not-applicable`: Home does not need it (a scoped window, or an
 *   organization context, whose own Chats is provisioned on send).
 * - `pending`: being set up, within its deadline.
 * - `ready`: registered as a cowork target.
 * - `unavailable`: setup failed or ran past its deadline; `retry` tries again.
 */
export type HomeDefaultChatsState =
  | 'not-applicable'
  | 'pending'
  | 'ready'
  | 'unavailable';

export interface HomeDefaultChatsTarget {
  readonly state: HomeDefaultChatsState;
  readonly retry: () => void;
}

interface HomeRecoveryRun {
  readonly result: Promise<PersonalDefaultChatsOutcome>;
  consumers: number;
  readonly cancel: () => void;
}

// Home can be mounted twice. Share the retry schedule as well as each IPC;
// otherwise a fast failure can settle between the two consumers' timers.
const recoveryRuns = new Map<string, HomeRecoveryRun>();

function acquireHomeRecovery(): HomeRecoveryRun {
  const session = homeSendTargetSessionKey();
  const existing = recoveryRuns.get(session);
  if (existing) {
    existing.consumers += 1;
    return existing;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let settle: (outcome: PersonalDefaultChatsOutcome) => void = () => {};
  const deadline = Date.now() + HOME_DEFAULT_CHATS_PENDING_DEADLINE_MS;
  const result = new Promise<PersonalDefaultChatsOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (outcome: PersonalDefaultChatsOutcome): void => {
    if (recoveryRuns.get(session) === run) recoveryRuns.delete(session);
    settle(outcome);
  };
  const run: HomeRecoveryRun = {
    result,
    consumers: 1,
    cancel: (): void => {
      cancelled = true;
      clearTimeout(timer);
      finish({ status: 'unsupported' });
    },
  };
  recoveryRuns.set(session, run);
  let retriesUsed = 0;
  const attempt = (): void => {
    if (cancelled) return;
    if (Date.now() >= deadline) {
      finish({ status: 'failed', reason: 'missing' });
      return;
    }
    void ensurePersonalDefaultChats().then((outcome) => {
      if (cancelled) return;
      const delay = HOME_DEFAULT_CHATS_RETRY_DELAYS_MS[retriesUsed];
      if (
        outcome.status === 'failed' &&
        delay !== undefined &&
        Date.now() < deadline
      ) {
        retriesUsed += 1;
        timer = setTimeout(attempt, delay);
      } else {
        finish(outcome);
      }
    });
  };
  attempt();
  return run;
}

/**
 * Sets up Personal's Chats while Home needs it and it is missing. Waits for
 * the projects store's first load, so a Chats that already exists costs no
 * IPC. Settled failures retry on a fixed schedule; exhausting it, or passing
 * the overall deadline, reports `unavailable` until `retry` resets the
 * budget. Timers are cleared on unmount and when Home stops needing it.
 */
export function useHomeDefaultChatsTarget(
  needed: boolean,
): HomeDefaultChatsTarget {
  const registered = useProjectsStore((state) =>
    isPersonalDefaultChatsRegistered(state.projects),
  );
  const hydrated = useProjectsStore((state) => state.hasHydratedProjects);
  const scoped = useStandaloneChatStore(
    (state) => state.scopedWorkspaceId !== null,
  );
  const accountEpoch = useWorkspaceContextStore((state) => state.accountEpoch);
  const context = useWorkspaceContextStore((state) => state.state.context);
  const applicable = needed && !scoped;
  // Bumped by retry, so the attempt effect restarts with a fresh budget.
  const [attemptRun, setAttemptRun] = useState(0);
  // The attempt run that gave up; a retry starts a run that has not.
  const [failedRun, setFailedRun] = useState<number | null>(null);
  const runRef = useRef(0);

  useEffect(() => {
    if (!applicable || registered) return undefined;
    const run = ++runRef.current;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const schedule = (callback: () => void, delayMs: number): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delayMs);
      timers.add(timer);
    };
    let recovery: HomeRecoveryRun | undefined;
    let expired = false;
    setFailedRun(null);
    const attempt = (): void => {
      recovery = acquireHomeRecovery();
      void recovery.result.then((outcome) => {
        if (runRef.current !== run || expired || outcome.status === 'ready')
          return;
        setFailedRun(attemptRun);
      });
    };
    // A store that has not loaded yet may already list the default; give the
    // first load the chance to say so before listing chat projects.
    // A retry lists at once: the person asked, and the first load may never
    // have finished.
    if (hydrated || attemptRun > 0) attempt();
    schedule(() => {
      expired = true;
      if (runRef.current === run) setFailedRun(attemptRun);
    }, HOME_DEFAULT_CHATS_PENDING_DEADLINE_MS);
    return (): void => {
      // A newer run, or unmount, makes this run's late outcomes stale.
      if (runRef.current === run) runRef.current += 1;
      timers.forEach((timer) => clearTimeout(timer));
      if (recovery) {
        recovery.consumers -= 1;
        if (recovery.consumers === 0) recovery.cancel();
      }
    };
  }, [applicable, registered, hydrated, attemptRun, accountEpoch, context]);

  const retry = useCallback((): void => {
    setAttemptRun((current) => current + 1);
  }, []);

  if (!applicable) return { state: 'not-applicable', retry };
  if (registered) return { state: 'ready', retry };
  return {
    state: failedRun === attemptRun ? 'unavailable' : 'pending',
    retry,
  };
}

/**
 * Whether Home's selection can be sent to, shared by its controls and its
 * send dispatch:
 * - `ready`: a selected target that dispatches; Personal's Chats only once
 *   registered as cowork (a bare id would route as a code project).
 * - `pending`: the target, Personal's Chats, is still being set up.
 * - `unavailable`: no target could be supplied.
 * Provider, permission, draft and send-in-progress gates stay separate.
 */
export type HomeTargetReadiness = 'ready' | 'pending' | 'unavailable';

export function resolveHomeTargetReadiness(input: {
  readonly workspaceId: string | null;
  readonly fallbackWorkspaceId: string | null;
  readonly personalDefaultRegistered: boolean;
  readonly defaultChats: HomeDefaultChatsState;
  readonly targetUsable: boolean;
  readonly hydrated?: boolean;
  readonly contextReady?: boolean;
}): HomeTargetReadiness {
  if (input.hydrated === false || input.contextReady === false)
    return 'pending';
  const awaitsDefault = (id: string): boolean =>
    id === DEFAULT_COWORK_WORKSPACE_ID && !input.personalDefaultRegistered;
  const defaultChatsReadiness = (): HomeTargetReadiness =>
    input.defaultChats === 'unavailable' ||
    input.defaultChats === 'not-applicable'
      ? 'unavailable'
      : 'pending';
  if (input.workspaceId !== null) {
    if (awaitsDefault(input.workspaceId)) return defaultChatsReadiness();
    return input.targetUsable ? 'ready' : 'unavailable';
  }
  if (
    input.fallbackWorkspaceId !== null &&
    !awaitsDefault(input.fallbackWorkspaceId)
  ) {
    return 'pending';
  }
  return defaultChatsReadiness();
}

/**
 * The inputs whose change should let Home retry seeding an empty selection:
 * the context, what the scope would seed, whether that target is usable yet,
 * and the project count. A context that hydrates without changing the count,
 * or a default registered later, now retries the seed too.
 */
export function homeSeedKey(input: {
  readonly contextKey: string;
  readonly fallbackWorkspaceId: string | null;
  readonly fallbackUsable: boolean;
  readonly projectCount: number;
  readonly projectIds: readonly string[];
  readonly hydrated: boolean;
}): string {
  return JSON.stringify([
    input.contextKey,
    input.fallbackWorkspaceId,
    input.fallbackUsable,
    input.projectCount,
    input.projectIds,
    input.hydrated,
  ]);
}

/** Bounds hydration and selection too, even when no provisioning is needed. */
export function useHomePendingDeadline(
  pending: boolean,
  session: string,
): {
  readonly expired: boolean;
  readonly retry: () => void;
  readonly generation: number;
} {
  const [generation, setGeneration] = useState(0);
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  const key = JSON.stringify([session, generation]);
  useEffect(() => {
    if (!pending) {
      setExpiredKey(null);
      return undefined;
    }
    const timer = setTimeout(
      () => setExpiredKey(key),
      HOME_DEFAULT_CHATS_PENDING_DEADLINE_MS,
    );
    return (): void => clearTimeout(timer);
  }, [pending, key]);
  const retry = useCallback(
    (): void => setGeneration((value) => value + 1),
    [],
  );
  return { expired: expiredKey === key, retry, generation };
}

/** Validate actual membership and cowork dispatch, including scoped windows. */
export function isHomeSendTargetUsable(
  workspaceId: string | null,
  failedWorkspaceIds = useProjectsStore.getState().failedWorkspaceIds,
): boolean {
  if (workspaceId === null) return false;
  const scoped = useStandaloneChatStore.getState().scopedWorkspaceId;
  if (scoped !== null && scoped !== workspaceId) return false;
  const scope = getHomeScope();
  if (!scope.isInScope(workspaceId)) return false;
  if (isHomeCloudTarget(workspaceId)) {
    // Keep a selected offline or removed cloud project with its draft. The
    // cloud send path reports why it cannot send; local target provisioning
    // must not hide that refusal or redirect the draft to another project.
    return true;
  }
  const state = useProjectsStore.getState();
  const project = state.projects.find((item) => item.id === workspaceId);
  return (
    project !== undefined &&
    !failedWorkspaceIds.has(workspaceId) &&
    (project.type !== 'cowork' || isRegisteredCoworkWorkspaceId(workspaceId))
  );
}
