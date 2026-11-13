import type {
  AppAdvisorJson,
  AppAdvisorMemorySyncSettingsState,
  AppAdvisorUiStateSnapshot,
  MemorySyncScopeState,
} from '@canopy/desktop-shared/types';
import type {
  MemorySyncPanelUiState,
  MemorySyncSettingsUiState,
} from '@canopy/ui-app/local-memory';

/*
 * Memory sync's App Advisor context (CAN-5188): the Settings › Memory Sync
 * section and the sync view open in a Memory panel, as the reporters in
 * `MemoryTab` and `MemorySection` publish them. Only known values pass;
 * memory names and contents and the computer's name never do.
 */

export const MEMORY_SYNC_SETTINGS_UI_STATE_KEY = 'settings.memorySync';
export const MEMORY_SYNC_VIEW_UI_STATE_KEYS = {
  settings: 'memory.syncView.settings',
  'project-panel': 'memory.syncView.project',
} as const;

type Fields = Record<string, AppAdvisorJson>;

const SCOPE_STATES: readonly MemorySyncScopeState[] = [
  'syncing',
  'paused',
  'device_only',
  'repair_needed',
  'deleted_in_cloud',
  'needs_first_enable',
  'merging',
  'not_started',
];
const REVIEW_PHASES = ['loading', 'ready', 'applying', 'failed'] as const;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function fields(value: AppAdvisorJson | undefined): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function flag(value: AppAdvisorJson | undefined): boolean {
  return value === true;
}

function count(value: AppAdvisorJson | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function oneOf<Value extends string>(
  value: AppAdvisorJson | undefined,
  allowed: readonly Value[],
): Value | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

function failureCode(value: AppAdvisorJson | undefined): string | null {
  return typeof value === 'string' && FAILURE_CODE.test(value) ? value : null;
}

function review(
  value: AppAdvisorJson | undefined,
): AppAdvisorMemorySyncSettingsState['review'] {
  const slice = fields(value);
  if (slice === null) return null;
  return {
    phase: oneOf(slice.phase, REVIEW_PHASES) ?? 'loading',
    kind: oneOf(slice.kind, ['upload', 'merge', 'keep']),
    reloadedAfterChange: flag(slice.reloadedAfterChange),
    failure: failureCode(slice.failure),
    documentsAfter: count(slice.documentsAfter),
    notesSent: count(slice.notesSent),
    notesKeptOnDevice: count(slice.notesKeptOnDevice),
    memoriesSkipped: count(slice.memoriesSkipped),
  };
}

/** The Sync section's slice, or undefined when it is not mounted. */
export function readMemorySyncSettingsState(
  value: AppAdvisorJson | undefined,
): AppAdvisorMemorySyncSettingsState | undefined {
  const slice = fields(value);
  if (slice === null) return undefined;
  return {
    available: flag(slice.available),
    signedIn: flag(slice.signedIn),
    enabled: flag(slice.enabled),
    userScope: oneOf(slice.userScope, ['sync', 'device_only']),
    cloudConsolidation: oneOf(slice.cloudConsolidation, [
      'allowed',
      'disallowed',
    ]),
    scopeState: oneOf(slice.scopeState, SCOPE_STATES),
    needsReview: flag(slice.needsReview),
    conflicts: count(slice.conflicts),
    waitingToSend: count(slice.waitingToSend),
    keptOnDevice: count(slice.keptOnDevice),
    restoreBeforeMergeAvailable: flag(slice.restoreBeforeMergeAvailable),
    saving: flag(slice.saving),
    failure: failureCode(slice.failure),
    review: review(slice.review),
    confirming: oneOf(slice.confirming, ['delete', 'restore']),
  };
}

/** The sync view open in a Memory panel, Settings › Memory's first. */
export function readMemorySyncViewState(
  slices: Readonly<Record<string, AppAdvisorJson | undefined>>,
): AppAdvisorUiStateSnapshot['memorySyncView'] {
  for (const surface of ['settings', 'project-panel'] as const) {
    const slice = fields(slices[MEMORY_SYNC_VIEW_UI_STATE_KEYS[surface]]);
    const view = oneOf(slice?.view, ['conflicts', 'history']);
    if (slice !== null && view !== null) {
      return { surface, view, conflicts: count(slice.conflicts) };
    }
  }
  return undefined;
}

/** What `MemorySyncSettings` reports, as its reporter publishes it. */
export function memorySyncSettingsSlice(
  state: MemorySyncSettingsUiState | null,
): AppAdvisorJson | null {
  if (state === null) return null;
  const { review: reviewState } = state;
  return {
    available: state.available,
    signedIn: state.signedIn,
    enabled: state.enabled,
    userScope: state.userScope,
    cloudConsolidation: state.cloudConsolidation,
    scopeState: state.scopeState,
    needsReview: state.needsReview,
    conflicts: state.conflicts,
    waitingToSend: state.waitingToSend,
    keptOnDevice: state.keptOnDevice,
    restoreBeforeMergeAvailable: state.restoreBeforeMergeAvailable,
    saving: state.saving,
    failure: state.failure,
    review:
      reviewState === null
        ? null
        : {
            phase: reviewState.phase,
            kind: reviewState.kind,
            reloadedAfterChange: reviewState.reloadedAfterChange,
            failure: reviewState.failure,
            documentsAfter: reviewState.documentsAfter,
            notesSent: reviewState.notesSent,
            notesKeptOnDevice: reviewState.notesKeptOnDevice,
            memoriesSkipped: reviewState.memoriesSkipped,
          },
    confirming: state.confirming,
  };
}

/** What a `MemoryPanel` reports about its sync view. */
export function memorySyncViewSlice(
  view: MemorySyncPanelUiState | null,
): AppAdvisorJson | null {
  return view === null ? null : { view: view.view, conflicts: view.conflicts };
}
