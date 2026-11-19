'use client';

import { useSyncExternalStore, type JSX } from 'react';
import type { W5RecoveryStatus } from '@canopy/protocol/remote-control/shell';
import {
  W5RecoveryNotice,
  type W5RecoveryNoticeProps,
} from '@canopy/ui-shared/components';
import type { WorkspaceRecoveryDismissalStore } from './recovery-dismissal-store';

function recoveryKeys(status: W5RecoveryStatus | undefined): string[] {
  if (!status || status.state === 'hidden') return [];
  if (status.entries.length === 0) {
    // Without record IDs, a different outcome/reason is a new diagnosis.
    return [JSON.stringify(['diagnosis', status.state, status.reason ?? null])];
  }
  // Portal redacts details; rechecking the same records must stay dismissed.
  return status.entries.map(({ id }) => JSON.stringify(['entry', id]));
}

const EMPTY_ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set();
const serverSnapshot = (): ReadonlySet<string> => EMPTY_ACKNOWLEDGEMENTS;

/** Session-only UI memory, never a recovery decision or a backend write. */
export function WorkspaceRecoveryNotice({
  dismissalStore: store,
  ...props
}: Omit<W5RecoveryNoticeProps, 'dismissed' | 'onDismiss'> & {
  readonly dismissalStore: WorkspaceRecoveryDismissalStore;
}): JSX.Element {
  const dismissed = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    serverSnapshot,
  );
  const keys = recoveryKeys(props.status);
  return (
    <W5RecoveryNotice
      {...props}
      dismissed={keys.length > 0 && keys.every((key) => dismissed.has(key))}
      onDismiss={() => {
        store.dismiss(keys);
      }}
    />
  );
}
