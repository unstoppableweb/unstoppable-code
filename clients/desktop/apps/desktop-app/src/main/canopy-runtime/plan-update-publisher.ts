import { AsyncLocalStorage } from 'node:async_hooks';
import {
  IPC_CHANNELS,
  type TrackedPlanData,
  type TrackedPlansUpdatedEvent,
} from '@canopy/desktop-shared/types';
import type { PlanScope } from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { sendToAllWindows } from '../lib/window-send';

/*
 * `tracked-plans:updated` for a `core.plan.*` write the dispatcher committed.
 * A write through the `tracked-plans:*` IPC projection announces nothing to
 * windows, as those handlers never did: the renderer that asked applies the
 * answer itself. A write from any other binding reaches every window.
 */

export type DispatchedPlanChange =
  | { kind: 'upserted'; scope: PlanScope; plan: TrackedPlanData }
  | { kind: 'removed'; scope: PlanScope; planId: string };

const ipcProjection = new AsyncLocalStorage<true>();

/** Runs an IPC projection's call, whose writes announce nothing to windows. */
export function withTrackedPlansIpcProjection<Result>(
  call: () => Promise<Result>,
): Promise<Result> {
  // Async, so a synchronous throw still rejects.
  return ipcProjection.run(true, async () => call());
}

/** Never throws: the write it announces is already durable. */
export function publishDispatchedPlanChange(
  change: DispatchedPlanChange,
): void {
  if (ipcProjection.getStore()) return;
  const event: TrackedPlansUpdatedEvent =
    change.kind === 'upserted'
      ? {
          projectId: change.scope.projectId,
          worktreeId: change.scope.worktreeId,
          plan: change.plan,
          change: 'upsert',
        }
      : {
          projectId: change.scope.projectId,
          worktreeId: change.scope.worktreeId,
          planId: change.planId,
          change: 'remove',
        };
  try {
    sendToAllWindows(IPC_CHANNELS.trackedPlansUpdated, event);
  } catch (error) {
    logMainProcessWarn('[tracked-plans] update was not published', error);
  }
}
