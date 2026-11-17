import type { SessionViewModel } from '@canopy/app-core';
import { create } from 'zustand';

/** Shares the sidebar's existing read without rerendering the entire app shell. */
export const useRecoveryShellSnapshotStore = create<{
  snapshot: SessionViewModel | null;
}>()(() => ({ snapshot: null }));

export function publishRecoveryShellSnapshot(snapshot: SessionViewModel): void {
  useRecoveryShellSnapshotStore.setState({ snapshot });
}
