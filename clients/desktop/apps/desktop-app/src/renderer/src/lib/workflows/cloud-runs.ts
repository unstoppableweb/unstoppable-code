import { useEffect } from 'react';
import { useStore } from 'zustand';
import {
  createCloudPipelineRunSession,
  createCloudPipelineRunsStore,
  type CloudPipelineRunSession,
  type CloudPipelineRunsState,
  type CloudPipelineRunsStore,
  type CloudRunControlKeys,
} from '@canopy/app-state/cloud-pipeline-runs';
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  canopyCloudAccountIdentity,
  isConclusiveAccountRead,
} from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';

/**
 * This computer's view of the signed-in account's cloud workflow runs
 * (CAN-6326): the shared cloud runs store over the renderer relay's web core
 * authority. Shown only while the CAN-6085 axis says cloud runs are
 * available (`usePipelineCloudRuns`); the web core serves them to the run's
 * owner only.
 */

let invoker: CoreCoworkInvoker | null = null;
let store: CloudPipelineRunsStore | null = null;
/**
 * Every cloud run session's control keys, so a control sent again from a
 * row or the run's detail after a lost answer replays instead of acting
 * twice. Emptied with the list when the account changes.
 */
export const cloudRunControlKeys: CloudRunControlKeys = new Map();

/*
 * The runs belong to whoever is signed in. When the account's identity
 * changes, the list is emptied (reads started before it are dropped) and
 * every open run closes, so nothing from the previous account stays shown.
 */
const accountListeners = new Set<() => void>();
let accountWatched = false;
// `undefined` until the first conclusive read.
let accountIdentity: string | null | undefined;
let accountReads = 0;

function readAccount(changed: boolean): void {
  const read = ++accountReads;
  void window.api
    .loadCanopyCloudAccount()
    .then((account) => {
      if (read !== accountReads || !isConclusiveAccountRead(account)) return;
      const next = canopyCloudAccountIdentity(account);
      // A change before the first read finished is a change too.
      const differs =
        accountIdentity === undefined ? changed : next !== accountIdentity;
      accountIdentity = next;
      if (!differs) return;
      store?.reset();
      cloudRunControlKeys.clear();
      for (const listener of accountListeners) listener();
    })
    .catch(reportClientAppError);
}

function watchAccount(): void {
  if (accountWatched || typeof window === 'undefined') return;
  accountWatched = true;
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, () =>
    readAccount(true),
  );
  readAccount(false);
}

/** Calls `listener` after the signed-in account changes; returns the unsubscribe. */
export function onCloudRunsAccountChange(listener: () => void): () => void {
  watchAccount();
  accountListeners.add(listener);
  return (): void => {
    accountListeners.delete(listener);
  };
}

/** The web core carrier, or null in a window without the relay. */
export function cloudRunsInvoker(): CoreCoworkInvoker | null {
  if (invoker === null && typeof window !== 'undefined' && window.canopyCore)
    invoker = createRelayCoreCoworkInvoker(window.canopyCore);
  return invoker;
}

/** The one cloud runs list the Runs feed and the run detail share. */
export function cloudPipelineRunsStore(): CloudPipelineRunsStore | null {
  const carrier = cloudRunsInvoker();
  if (store === null && carrier !== null) {
    store = createCloudPipelineRunsStore({ invoker: carrier });
    watchAccount();
  }
  return store;
}

const EMPTY: CloudPipelineRunsState = {
  runs: [],
  nextCursor: null,
  loaded: true,
  loading: false,
  loadingMore: false,
  error: null,
};

const unavailableStore = createCloudPipelineRunsStore({
  invoker: {
    request: () =>
      Promise.resolve({
        ok: false,
        error: {
          kind: 'capability_unavailable',
          message: 'Cloud runs are not available here.',
          retry: { kind: 'never' },
        },
      }),
    openStream: () => Promise.reject(new Error('Not available.')),
  },
});

/**
 * The cloud runs while `enabled`, kept current while the caller is mounted;
 * none otherwise.
 */
export function useCloudPipelineRuns(enabled: boolean): {
  readonly state: CloudPipelineRunsState;
  readonly store: CloudPipelineRunsStore | null;
} {
  const shared = enabled ? cloudPipelineRunsStore() : null;
  useEffect(() => (shared === null ? undefined : shared.retain()), [shared]);
  const state = useStore(shared ?? unavailableStore);
  return { state: shared === null ? EMPTY : state, store: shared };
}

/**
 * A session for one control from a row, without following the run: the
 * answer still updates the list.
 */
export function cloudRunControlSession(
  executionId: string,
): CloudPipelineRunSession | null {
  const carrier = cloudRunsInvoker();
  const list = cloudPipelineRunsStore();
  if (carrier === null || list === null) return null;
  return createCloudPipelineRunSession({
    invoker: carrier,
    executionId,
    onView: (view) => list.upsert(view),
    controlKeys: cloudRunControlKeys,
  });
}
