import { publishForeignPipelineActivity } from '../services/foreign-activity-sources';
import { withPipelineTransientRetryState } from './transient-error-retry-scheduler';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import type { ExecutionEvent } from '@canopy/execution-engine/types/pipeline';
import { sendToAllWindows } from '../lib/window-send';
import { syncPipelineAttention } from './pipeline-attention';
import { latchNativeQuotaFromPipelineReasons } from './pipeline-quota-latch';

export const PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS = 100;

interface PendingExecutionUpdate {
  event: ExecutionEvent;
  timer: NodeJS.Timeout;
}

type ExecutionEventSender = (event: ExecutionEvent) => void;

function executionHasStatusReasons(state: {
  status_reasons?: readonly unknown[];
}): boolean {
  return (state.status_reasons?.length ?? 0) > 0;
}

function shouldCoalesceExecutionEvent(event: ExecutionEvent): boolean {
  return (
    event.type === 'execution.updated' &&
    (event.state.status === 'pending' || event.state.status === 'running') &&
    event.state.pending_input === undefined &&
    (event.state.pending_pauses?.length ?? 0) === 0 &&
    !executionHasStatusReasons(event.state)
  );
}

/**
 * Bounds full execution-state IPC broadcasts while keeping durable executor
 * persistence and main-process observers synchronous. Each execution gets at
 * most one trailing renderer update per interval, and lifecycle boundaries
 * supersede any queued update so stale state can never arrive after them.
 */
export class PipelineExecutionEventBroadcaster {
  private readonly pendingUpdates = new Map<string, PendingExecutionUpdate>();

  constructor(
    private readonly send: ExecutionEventSender,
    private readonly intervalMs = PIPELINE_EXECUTION_UPDATE_BROADCAST_INTERVAL_MS,
  ) {}

  publish(event: ExecutionEvent): void {
    if (!shouldCoalesceExecutionEvent(event)) {
      this.discardPending(event.executionId);
      this.send(event);
      return;
    }

    const pending = this.pendingUpdates.get(event.executionId);
    if (pending) {
      pending.event = event;
      return;
    }

    const timer = setTimeout(() => {
      this.flush(event.executionId);
    }, this.intervalMs);
    timer.unref();
    this.pendingUpdates.set(event.executionId, { event, timer });
  }

  flush(executionId: string): void {
    const pending = this.pendingUpdates.get(executionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingUpdates.delete(executionId);
    this.send(pending.event);
  }

  dispose(): void {
    this.pendingUpdates.forEach((pending: PendingExecutionUpdate) => {
      clearTimeout(pending.timer);
    });
    this.pendingUpdates.clear();
  }

  private discardPending(executionId: string): void {
    const pending = this.pendingUpdates.get(executionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingUpdates.delete(executionId);
  }
}

const rendererEventBroadcaster = new PipelineExecutionEventBroadcaster(
  (event) => {
    // Read the live deadline after coalescing, once per actual broadcast.
    const state = withPipelineTransientRetryState(event.state);
    sendToAllWindows(
      PIPELINE_CHANNELS.EXECUTION_EVENT,
      state === event.state ? event : { ...event, state },
    );
  },
);

export function broadcastPipelineExecutionEvent(event: ExecutionEvent): void {
  // Main-process seam shared by interactive runs, retries, and replayed events.
  // The attention tracker owns the 15-second self-suppression timer. A native
  // usage-limit status reason sets the account-wide quota latch, so on-quota
  // AI Credits routing applies when the paused step resumes (CAN-7256).
  publishForeignPipelineActivity(event);
  syncPipelineAttention(event);
  latchNativeQuotaFromPipelineReasons(event.state.status_reasons);
  rendererEventBroadcaster.publish(event);
}

export function resetPipelineExecutionEventBroadcasterForTests(): void {
  rendererEventBroadcaster.dispose();
}
