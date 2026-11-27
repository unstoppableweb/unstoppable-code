import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { DesktopSessionSnapshotArgs } from '@canopy/desktop-shared/types';
import { subscribeChatSessionActivity } from '../agents/session-manager';
import { subscribePipelineLifecycleTransitions } from '../pipelines/pipeline-execution-event-broadcaster';
import { subscribeToActiveCountChange } from '../pipelines/pipeline-execution-registry';
import { buildDesktopSessionSnapshot } from '../services/desktop-session-snapshot-service';
import {
  requestDesktopSessionSnapshotInvalidation,
  subscribeDesktopSessionSnapshotInvalidation,
} from '../services/desktop-session-snapshot-invalidation';
import { registerIpcHandler } from './register';
import { sendToWindow } from '../lib/window-send';

let unsubscribeDesktopSessionSnapshotInvalidation: (() => void) | null = null;
let unsubscribeChatSessionActivity: (() => void) | null = null;
let unsubscribePipelineLifecycle: (() => void) | null = null;
let unsubscribePipelineActiveCount: (() => void) | null = null;

export function disposeDesktopSessionSnapshotHandlers(): void {
  unsubscribeDesktopSessionSnapshotInvalidation?.();
  unsubscribeDesktopSessionSnapshotInvalidation = null;
  unsubscribeChatSessionActivity?.();
  unsubscribeChatSessionActivity = null;
  unsubscribePipelineLifecycle?.();
  unsubscribePipelineLifecycle = null;
  unsubscribePipelineActiveCount?.();
  unsubscribePipelineActiveCount = null;
}

export function registerDesktopSessionSnapshotHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  registerIpcHandler(
    IPC_CHANNELS.desktopSessionSnapshot,
    (_event, args?: DesktopSessionSnapshotArgs) =>
      buildDesktopSessionSnapshot(args),
  );
  registerIpcHandler(
    IPC_CHANNELS.desktopSessionSnapshotInvalidate,
    (): void => {
      requestDesktopSessionSnapshotInvalidation('renderer.invalidate');
    },
  );
  unsubscribeDesktopSessionSnapshotInvalidation?.();
  unsubscribeDesktopSessionSnapshotInvalidation =
    subscribeDesktopSessionSnapshotInvalidation((): void => {
      // Remote sessions still need invalidations while the local window is closed.
      sendToWindow(getWindow(), IPC_CHANNELS.desktopSessionSnapshotStale);
    });
  // The snapshot projects each worktree's `isStreaming` from live chat
  // sessions, and the shared sidebar gates Archive and Delete on it. The
  // runtime-status service stales the snapshot on session activity only while
  // a portal session runs, so without one a snapshot rebuilt mid-turn by an
  // unrelated write kept the row working, and those actions disabled, after
  // the turn ended. Session lifecycle changes (register, turn start/end,
  // queue, unregister) are discrete and the invalidation is throttled.
  unsubscribeChatSessionActivity?.();
  unsubscribeChatSessionActivity = subscribeChatSessionActivity((): void => {
    requestDesktopSessionSnapshotInvalidation('chat.session-activity');
  });
  // Mark the snapshot stale when workflows start, pause, resume, or finish so
  // paired computers refresh each task's live pipelineStatus badge.
  unsubscribePipelineLifecycle?.();
  unsubscribePipelineLifecycle = subscribePipelineLifecycleTransitions(
    (): void => {
      requestDesktopSessionSnapshotInvalidation('pipeline.lifecycle');
    },
  );
  unsubscribePipelineActiveCount?.();
  unsubscribePipelineActiveCount = subscribeToActiveCountChange((): void => {
    requestDesktopSessionSnapshotInvalidation('pipeline.lifecycle');
  });
}
