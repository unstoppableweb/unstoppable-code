import { IPC_PRIVATE_CHANNELS } from './channel-policy';
import { toIpcRejection } from './app-error-rejection';
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import {
  recordIpcInvoke,
  runWithW5Caller,
} from '@canopy/desktop-shared/node/work-counters';
import { trackSlowAction } from '../lib/slow-action-tracker';
import { runRendererDeliveryBarriers } from '../lib/web-contents-send';
import { refusePairedComputerIds } from './paired-computer-id-guard';

const SLOW_ACTION_LABELS: Record<string, string> = {
  [IPC_CHANNELS.cursorConnectionConnect]: 'Connecting Cursor',
  [IPC_CHANNELS.cursorConnectionCancel]: 'Stopping Cursor setup',
  [IPC_CHANNELS.cursorConnectionDisconnect]: 'Disconnecting Cursor',
  [IPC_CHANNELS.cursorApprovalCheckRun]: 'Checking Cursor approvals',
  [IPC_CHANNELS.cursorApprovalCheckCancel]: 'Stopping Cursor approval check',
  [IPC_CHANNELS.chatSendMessage]: 'Sending chat message',
  [IPC_CHANNELS.chatLoadTabs]: 'Loading chat',
  [IPC_CHANNELS.chatActiveSessions]: 'Loading active chat sessions',
  [IPC_CHANNELS.worktreeCreate]: 'Creating worktree',
  [IPC_CHANNELS.workspaceCreateWorktree]: 'Creating project worktree',
  [IPC_CHANNELS.worktreeArchive]: 'Archiving worktree',
  [IPC_CHANNELS.worktreeDiscard]: 'Discarding worktree',
  [IPC_CHANNELS.workspaceArchiveWorktree]: 'Archiving project worktree',
  [IPC_CHANNELS.worktreeDiffStats]: 'Loading worktree diff stats',
  [IPC_CHANNELS.worktreeDiffStatsBatch]: 'Loading worktree diff stats',
  [PIPELINE_CHANNELS.LIST_EXECUTIONS]: 'Loading pipeline executions',
  [PIPELINE_CHANNELS.EXECUTE]: 'Running pipeline',
  [PIPELINE_CHANNELS.GET_EXECUTION]: 'Loading pipeline execution',
  [PIPELINE_CHANNELS.CANCEL_EXECUTION]: 'Cancelling pipeline execution',
  [IPC_CHANNELS.terminalAttach]: 'Attaching terminal',
  [IPC_CHANNELS.terminalSpawn]: 'Starting terminal',
  [IPC_CHANNELS.observabilityLoadHistory]: 'Loading audit history',
  [IPC_CHANNELS.observabilityLoadUsageMetrics]: 'Loading usage metrics',
  [IPC_CHANNELS.automationsListRuns]: 'Loading automation run history',
  [IPC_CHANNELS.resourceMonitorGetSnapshot]: 'Loading resource diagnostics',
  [IPC_CHANNELS.memoryDiagnosticsCreateReport]: 'Creating a memory report',
  [IPC_CHANNELS.listUsageLimitedIdleChats]: 'Listing usage-limited chats',
  [IPC_CHANNELS.resumeUsageLimitedChats]: 'Resuming usage-limited chats',
  [IPC_CHANNELS.listUsageLimitedIdleSessions]: 'Listing usage-limited sessions',
  [IPC_CHANNELS.resumeUsageLimitedSessions]: 'Resuming usage-limited sessions',
  [IPC_CHANNELS.workspaceContextSet]: 'Switching workspace context',
  [IPC_CHANNELS.ledgerSearchEntries]: 'Loading the Feed',
  [IPC_CHANNELS.ledgerGetEntry]: 'Loading a Feed entry',
  [IPC_CHANNELS.ledgerAddEntry]: 'Saving a Feed entry',
  [IPC_CHANNELS.ledgerUpdateEntry]: 'Updating a Feed entry',
  [IPC_CHANNELS.ledgerListOwners]: 'Loading Feed owners',
  [IPC_CHANNELS.costGetScope]: 'Loading observed cost',
  [IPC_CHANNELS.costGetChat]: 'Loading chat cost',
  [IPC_CHANNELS.costGetPipelineRun]: 'Loading pipeline cost',
  [IPC_CHANNELS.costRefresh]: 'Refreshing observed cost',
  [IPC_CHANNELS.aiGatewayModelCatalogRetry]: 'Loading models',
};

function labelForIpcChannel(channel: string): string {
  return SLOW_ACTION_LABELS[channel] ?? `Running ${channel}`;
}

export function registerIpcHandler<Args extends unknown[], Result>(
  channel: string,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: Args
  ) => Result | Promise<Result>,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (event, ...args: Args): Promise<Result> => {
    // Work counter only: an increment that never throws or reorders the call.
    recordIpcInvoke(channel);
    let settled: Promise<Result>;
    try {
      refusePairedComputerIds(channel, args);
      settled = Promise.resolve(
        runWithW5Caller(channel, () => handler(event, ...args)),
      );
    } catch (error) {
      settled = Promise.reject(toIpcRejection(channel, error, true));
    }
    // Messages held back for this renderer (coalesced chat state) are sent
    // before the reply, so a reply's continuation never runs ahead of a
    // commit published before the handler settled.
    const sender = event.sender;
    const result = settled
      .catch((error: unknown): never => {
        throw toIpcRejection(channel, error);
      })
      .finally(() => {
        runRendererDeliveryBarriers(sender, channel);
      });
    if (IPC_PRIVATE_CHANNELS.has(channel)) {
      return result;
    }
    return trackSlowAction(result, {
      kind: 'ipc',
      label: labelForIpcChannel(channel),
      context: { channel },
    });
  });
}

/**
 * Listens for a one-way message from a renderer. A message whose arguments
 * address a paired computer is dropped, as `registerIpcHandler` refuses such
 * a call (CAN-8065): nothing awaits a message, so there is no one to tell.
 * Returns a function that stops listening.
 */
export function onIpcMessage<Args extends unknown[]>(
  channel: string,
  listener: (event: IpcMainEvent, ...args: Args) => void,
): () => void {
  const guarded = (event: IpcMainEvent, ...args: Args): void => {
    try {
      refusePairedComputerIds(channel, args);
    } catch {
      return;
    }
    listener(event, ...args);
  };
  ipcMain.on(channel, guarded);
  return (): void => {
    ipcMain.removeListener(channel, guarded);
  };
}
