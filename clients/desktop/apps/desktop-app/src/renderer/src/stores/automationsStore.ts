import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { readCoworkFolderMissing } from '@canopy/protocol/canopy-core';
import { useFeatureFlagsStore } from './featureFlagsStore';
import { useWorkspaceContextStore } from './workspaceContextStore';
// Renderer-side mirror of the persisted automations (triggered activities)
// list. The main-process automations service is the source of truth: this
// store hydrates from `window.api.automations.list()` and stays in sync via
// the `automations:changed` broadcast, never deriving the visible set
// locally.
//
// Mutation actions proxy directly to `window.api.automations.*` so the
// renderer doesn't need to maintain optimistic state — the broadcast picks
// up the new snapshot on success. Mutation failures are surfaced through
// `mutationError` so consumer UIs can render them inline.

import { create } from 'zustand';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type {
  ApproveAutomationSharedPipelineReviewRequest,
  ApproveAutomationSharedPipelineReviewResponse,
  AutomationCancelRunRequest,
  AutomationCreateRequest,
  AutomationDeleteRequest,
  AutomationMutationResponse,
  AutomationRunNowRequest,
  AutomationScheduleMoveRequest,
  AutomationScheduleMoveResponse,
  AutomationUpdateRequest,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';

export interface AutomationsStore {
  activities: ScheduledActivity[];
  recentRuns: ScheduledActivityRun[];
  loading: boolean;
  hydrated: boolean;
  /** Snapshot/hydration error message (network/IPC). */
  error: string | null;
  /**
   * Most recent mutation error, cleared every time a new mutation succeeds.
   * Consumers render this inline near the action that triggered it.
   */
  mutationError: string | null;
  /**
   * Lazily mount the `automations:changed` subscription. Returns an
   * unsubscribe handle so `useEffect` cleanup can detach the underlying IPC
   * listener on unmount. Safe to call from multiple components — each call
   * mounts its own listener so unmounts stay symmetric.
   */
  subscribeBridge: () => () => void;
  /**
   * Snapshot the persisted list. Reveal navigation may join the latest load
   * for the current context instead of requesting another snapshot. Ordinary
   * refreshes still fetch anew so later broadcasts are never discarded.
   */
  hydrate: (options?: { joinInFlight?: boolean }) => Promise<void>;
  /** Forward a create request to the main process. */
  createActivity: (
    request: AutomationCreateRequest,
  ) => Promise<AutomationMutationResponse>;
  /** Forward an update request to the main process. */
  updateActivity: (
    request: AutomationUpdateRequest,
  ) => Promise<AutomationMutationResponse>;
  /**
   * Move a workflow schedule to the cloud or back (CAN-6917). The answer
   * may ask for a cloud place or models; the caller shows that, not the
   * page-level `mutationError`.
   */
  moveSchedule: (
    request: AutomationScheduleMoveRequest,
  ) => Promise<AutomationScheduleMoveResponse>;
  /**
   * Forward a delete request to the main process. `keepPipeline` keeps a
   * workflow page whose last schedule this is; `workflow` deletes the whole
   * workflow page this record schedules (CAN-5782).
   */
  deleteActivity: (
    id: string,
    options?: Omit<AutomationDeleteRequest, 'id'>,
  ) => Promise<AutomationMutationResponse>;
  /** Forward a run-now request to the main process. */
  runNow: (id: string) => Promise<AutomationMutationResponse>;
  /** Cancel a run that has not dispatched its action yet. */
  cancelRun: (runId: string) => Promise<AutomationMutationResponse>;
  /**
   * Approve the previewed version of a changed shared pipeline. Errors are
   * returned to the caller (the review modal shows them inline) rather than
   * surfaced through the page-level `mutationError`.
   */
  approveSharedPipelineReview: (
    request: ApproveAutomationSharedPipelineReviewRequest,
  ) => Promise<ApproveAutomationSharedPipelineReviewResponse>;
  /**
   * Clear any pending mutationError. Mutation calls also clear this on entry,
   * but the action lets a closing form/modal drop the inline error without
   * triggering another IPC roundtrip.
   */
  clearMutationError: () => void;
}

function getApi(): typeof window.api.automations | undefined {
  return typeof window !== 'undefined' ? window.api?.automations : undefined;
}

function resourceContextGeneration(): number | undefined {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
    ? useWorkspaceContextStore.getState().appliedGeneration
    : undefined;
}

// Renderer-only completion signals, partitioned by context generation. A
// caller in a new context must not await an old context's discarded snapshot.
const pendingHydrations = new Map<number | undefined, Promise<void>>();
// A newer load or bridge snapshot supersedes older responses, even within
// the same context. Late refreshes must not erase a just-installed row or
// roll back its live enabled state.
let snapshotRevision = 0;

export const useAutomationsStore = create<AutomationsStore>((set, get) => ({
  activities: [],
  recentRuns: [],
  loading: false,
  hydrated: false,
  error: null,
  mutationError: null,
  subscribeBridge: (): (() => void) => {
    const api = getApi();
    if (!api?.onChanged) {
      return (): void => undefined;
    }
    const unsubscribeContext = useWorkspaceContextStore.subscribe(
      (state, previous) => {
        if (
          resourceContextGeneration() === undefined ||
          state.appliedGeneration === previous.appliedGeneration
        )
          return;
        set({
          activities: [],
          recentRuns: [],
          hydrated: false,
        });
        void get().hydrate();
      },
    );
    const unsubscribeBridge = api.onChanged((snapshot) => {
      if (resourceContextGeneration() !== undefined) {
        void get().hydrate();
        return;
      }
      snapshotRevision += 1;
      set({
        activities: snapshot.activities,
        recentRuns: snapshot.recentRuns,
        hydrated: true,
        loading: false,
        error: null,
      });
    });
    return (): void => {
      unsubscribeBridge();
      unsubscribeContext();
    };
  },
  hydrate: async (options): Promise<void> => {
    const api = getApi();
    if (!api?.list) {
      // Renderer is mounted without the preload bridge (e.g. unit tests). Mark
      // the store hydrated so consumers stop waiting on the spinner.
      set({ hydrated: true, loading: false, error: null });
      return;
    }
    const generation = resourceContextGeneration();
    const pending = pendingHydrations.get(generation);
    const request =
      options?.joinInFlight && pending
        ? pending
        : (async (): Promise<void> => {
            const revision = ++snapshotRevision;
            set({ loading: true, error: null });
            try {
              const snapshot = await api.list();
              if (
                generation !== resourceContextGeneration() ||
                revision !== snapshotRevision
              )
                return;
              set({
                activities: snapshot.activities,
                recentRuns: snapshot.recentRuns,
                loading: false,
                hydrated: true,
                error: null,
              });
            } catch (error: unknown) {
              if (
                generation !== resourceContextGeneration() ||
                revision !== snapshotRevision
              )
                return;
              const message =
                error instanceof Error
                  ? error.message
                  : 'Failed to load automations.';
              set({ loading: false, error: message });
            }
          })();
    pendingHydrations.set(generation, request);
    try {
      await request;
      // A discarded response is not completion for a reveal. Follow the
      // replacement load already in flight, without starting another request
      // or waiting on snapshots from a different context.
      if (options?.joinInFlight) {
        let completed = request;
        let replacement = pendingHydrations.get(generation);
        while (
          generation === resourceContextGeneration() &&
          replacement &&
          replacement !== completed
        ) {
          await replacement;
          completed = replacement;
          replacement = pendingHydrations.get(generation);
        }
      }
    } finally {
      if (pendingHydrations.get(generation) === request) {
        pendingHydrations.delete(generation);
      }
    }
  },
  createActivity: async (request): Promise<AutomationMutationResponse> => {
    return await runMutation(set, (api) => api.create(request));
  },
  updateActivity: async (request): Promise<AutomationMutationResponse> => {
    return await runMutation(set, (api) => api.update(request));
  },
  deleteActivity: async (id, options): Promise<AutomationMutationResponse> => {
    const payload: AutomationDeleteRequest = {
      id,
      ...(options?.keepPipeline ? { keepPipeline: true } : {}),
      ...(options?.workflow ? { workflow: true } : {}),
      ...(options?.pendingUsageLimitResumeOnly
        ? { pendingUsageLimitResumeOnly: true }
        : {}),
    };
    return await runMutation(set, (api) => api.delete(payload));
  },
  moveSchedule: async (request): Promise<AutomationScheduleMoveResponse> => {
    const api = getApi();
    if (!api) return { ok: false, error: 'Automations IPC unavailable.' };
    try {
      return await api.moveSchedule(request);
    } catch (error: unknown) {
      // Main answers its refusals; a throw is the IPC failing.
      reportClientAppError(error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  runNow: async (id): Promise<AutomationMutationResponse> => {
    const payload: AutomationRunNowRequest = { id };
    return await runMutation(set, (api) => api.runNow(payload));
  },
  cancelRun: async (runId): Promise<AutomationMutationResponse> => {
    const payload: AutomationCancelRunRequest = { runId };
    return await runMutation(set, (api) => api.cancelRun(payload));
  },
  approveSharedPipelineReview: async (
    request,
  ): Promise<ApproveAutomationSharedPipelineReviewResponse> => {
    const api = getApi();
    if (!api) return { ok: false, error: 'Automations IPC unavailable.' };
    set({ mutationError: null });
    try {
      return await api.approveSharedPipelineReview(request);
    } catch (error: unknown) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to approve the workflow.',
      };
    }
  },
  clearMutationError: (): void => {
    set({ mutationError: null });
  },
}));

type SetState = (
  partial:
    | Partial<AutomationsStore>
    | ((state: AutomationsStore) => Partial<AutomationsStore>),
) => void;

async function runMutation(
  set: SetState,
  call: (
    api: NonNullable<ReturnType<typeof getApi>>,
  ) => Promise<AutomationMutationResponse>,
): Promise<AutomationMutationResponse> {
  const api = getApi();
  if (!api) {
    const result: AutomationMutationResponse = {
      ok: false,
      error: 'Automations IPC unavailable.',
    };
    set({ mutationError: result.error });
    return result;
  }
  set({ mutationError: null });
  try {
    const result = await call(api);
    if (!result.ok) {
      set({ mutationError: result.error });
    }
    return result;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to update automations.';
    const coworkFolderMissing = readCoworkFolderMissing(error);
    const result: AutomationMutationResponse = {
      ok: false,
      error: message,
      ...(coworkFolderMissing ? { coworkFolderMissing } : {}),
    };
    set({ mutationError: message });
    return result;
  }
}
