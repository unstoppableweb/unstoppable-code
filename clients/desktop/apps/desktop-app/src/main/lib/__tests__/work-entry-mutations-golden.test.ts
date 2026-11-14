import {
  APP_ADVISOR_PROJECT_ID,
  type CoworkWorkEntryMeta,
} from '@canopy/desktop-shared/types';
import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import { handlePortalStandaloneChatArchive } from '../../portal/adapters/standalone-chat-adapter';
import { destroyWorktreeSessions } from '../../agents/session-manager';
import { assertWorktreeCanBeRemoved } from '../../agents/background-work';
import {
  listWorkEntries,
  listWorkEntryChatSummaries,
  readWorkEntryRegistryRowState,
  workEntryRegistryExists,
  removeWorkEntryRow,
  updateWorkEntry,
} from '../../lib/cowork-work-entries';
import * as mainProcessLogging from '../../lib/main-process-logging';
import { cleanupPersistedWorktreeData } from '../../lib/worktree-data-cleanup';
import { captureWorkEntryArchivedContainer } from '../../lib/archived-container-capture';
import { resolveContainerRetentionDays } from '../../lib/archived-container-retention';
import { broadcastArchivedContainersChanged } from '../../lib/archived-containers';
import { notifyLedgerContainerArchived } from '../../ledger/lifecycle';
import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import {
  deleteWorkEntryMutation,
  updateWorkEntryMutation,
} from '../../lib/work-entry-mutations';

jest.mock('../../agents/session-manager', () => ({
  destroyWorktreeSessions: jest.fn(),
  getActiveChatIds: jest.fn(),
}));
jest.mock('../../agents/background-work', () => ({
  assertWorktreeCanBeRemoved: jest.fn(),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  listWorkEntries: jest.fn(),
  listWorkEntryChatSummaries: jest.fn(),
  readWorkEntryRegistryRowState: jest.fn(),
  workEntryRegistryExists: jest.fn(),
  removeWorkEntryRow: jest.fn(),
  updateWorkEntry: jest.fn(),
}));
jest.mock('../../services/telemetry-sync-service', () => {
  const telemetry = {
    refreshWorktreeMetadata: jest.fn(),
    drainWorktreeForDeletion: jest.fn(),
  };
  return {
    getTelemetrySyncService: (): typeof telemetry => telemetry,
    telemetry,
  };
});
jest.mock('../../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (projectId: string): string => projectId,
}));
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn(() => true),
}));
jest.mock('../../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof mainProcessLogging>(
    '../../lib/main-process-logging',
  ),
  logMainProcessError: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(),
}));
jest.mock('../../lib/archived-containers', () => ({
  broadcastArchivedContainersChanged: jest.fn(),
  isArchivedWorkspaceOperationLockHeld: jest.fn(() => false),
  withArchivedWorkspaceOperationLock: jest.fn(
    (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
jest.mock('../../lib/archived-container-retention', () => ({
  resolveContainerRetentionDays: jest.fn(),
}));
jest.mock('../../lib/archived-container-capture', () => ({
  captureWorkEntryArchivedContainer: jest.fn(),
}));
jest.mock('../../services/chat-state-service', () => {
  const state = {
    runWithScopeDeletionLifecycle: jest.fn(
      (_scope: unknown, operation: () => Promise<void>) => operation(),
    ),
    runWithScopeDeletion: jest.fn(
      (_scope: unknown, operation: () => Promise<void>) => operation(),
    ),
    ingestProviderEvent: jest.fn(),
  };
  return { getChatStateService: (): typeof state => state, state };
});
jest.mock('../../services/chat-queue-service', () => {
  const deletion = {
    commit: jest.fn(),
    rollback: jest.fn(),
  };
  const queue = {
    beginWorktreeDeletion: jest.fn((): typeof deletion => deletion),
  };
  return { getChatQueueService: (): typeof queue => queue, queue, deletion };
});
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../ledger/lifecycle', () => ({
  notifyLedgerContainerArchived: jest.fn(),
}));
jest.mock('../../ledger/lifecycle-containers', () => ({
  workEntryLedgerIncarnation: jest.fn(() => ({ ledgerId: 'ledger-a' })),
}));
jest.mock('../../app-advisor/local-fence-holder', () => ({
  runAsLocalFenceHolder: (operation: () => Promise<void>): Promise<void> =>
    operation(),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(
    (): Promise<string> => Promise.resolve('retirement-a'),
  ),
  commitTaskBrowserRetirement: jest.fn(
    (): Promise<boolean> => Promise.resolve(true),
  ),
  abortTaskBrowserRetirement: jest.fn(),
}));
jest.mock('../../app-advisor/watchers', () => {
  const service = {
    commitLocalScopeCancellation: jest.fn(),
    releaseLocalScopeFence: jest.fn(),
  };
  return {
    getAppAdvisorWatcherService: (): typeof service => service,
    service,
  };
});
jest.mock('../../services/standalone-chat-service', () => ({
  resolveStandaloneChatTarget: jest.fn(),
  emitStandaloneWorkEntrySummary: jest.fn(),
  emitStandaloneChatRemovals: jest.fn(),
}));
jest.mock('../../portal/adapters/chat-adapter', () => ({}));
jest.mock('../../portal/adapters/chat-plugin-selections', () => ({}));
jest.mock('../../portal/portal-chat-attachments', () => ({}));
jest.mock('../../agents/work-owner', () => ({}));
jest.mock('../../agents/delegation/activity', () => ({
  LiveDelegationsError: class extends Error {},
}));
jest.mock('../../lib/model-policy-state', () => ({}));
jest.mock('../../cursor/runtime-availability', () => ({}));
jest.mock('../../copilot/runtime-availability', () => ({}));
jest.mock('../../opencode/runtime-availability', () => ({}));

jest.mock('../../services/chat-service', () => ({
  projectAppAdvisorChatSummaries: jest.fn(),
}));

const entry: CoworkWorkEntryMeta = {
  id: 'entry-a',
  title: 'Entry A',
  createdAt: '2026-11-04T00:00:00.000Z',
  chatCount: 0,
};

const telemetry = jest.requireMock<{
  telemetry: {
    refreshWorktreeMetadata: jest.Mock;
    drainWorktreeForDeletion: jest.Mock;
  };
}>('../../services/telemetry-sync-service').telemetry;
const chatState = jest.requireMock<{
  state: {
    runWithScopeDeletionLifecycle: jest.Mock;
    runWithScopeDeletion: jest.Mock;
    ingestProviderEvent: jest.Mock;
  };
}>('../../services/chat-state-service').state;
const queue = jest.requireMock<{
  queue: { beginWorktreeDeletion: jest.Mock };
  deletion: { commit: jest.Mock; rollback: jest.Mock };
}>('../../services/chat-queue-service');
const browser = jest.requireMock<{
  prepareTaskBrowserRetirement: jest.Mock;
  commitTaskBrowserRetirement: jest.Mock;
  abortTaskBrowserRetirement: jest.Mock;
}>('../../browser/browser-profile-lifecycle');
const watcher = jest.requireMock<{
  service: {
    commitLocalScopeCancellation: jest.Mock;
    releaseLocalScopeFence: jest.Mock;
  };
}>('../../app-advisor/watchers').service;
const standalone = jest.requireMock<{
  emitStandaloneWorkEntrySummary: jest.Mock;
  emitStandaloneChatRemovals: jest.Mock;
  resolveStandaloneChatTarget: jest.Mock;
}>('../../services/standalone-chat-service');
const appAdvisor = jest.requireMock<{
  projectAppAdvisorChatSummaries: jest.Mock;
}>('../../services/chat-service');

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(listWorkEntries).mockResolvedValue([entry]);
  jest.mocked(listWorkEntryChatSummaries).mockResolvedValue([]);
  jest.mocked(resolveContainerRetentionDays).mockResolvedValue(7);
  jest.mocked(updateWorkEntry).mockResolvedValue(true);
  telemetry.refreshWorktreeMetadata.mockResolvedValue(undefined);
  telemetry.drainWorktreeForDeletion.mockResolvedValue(undefined);
});

describe('Work Entry mutation lifecycle', () => {
  it('reports reconciliation failure and runs a fresh Portal Retry through deletion preflight', async () => {
    const project = 'project-a';
    const chat = 'chat-a';
    const reconciliationError = new Error('sidebar reconciliation failed');
    jest.mocked(workEntryRegistryExists).mockResolvedValue(true);
    jest.mocked(readWorkEntryRegistryRowState).mockResolvedValue('absent');
    standalone.resolveStandaloneChatTarget.mockResolvedValue({
      workspaceId: project,
      entryId: entry.id,
      archivedInEntryId: null,
      isArchived: false,
    });
    jest.mocked(removeWorkEntryRow).mockImplementationOnce(() => {
      // The registry installs the removal before reconciliation rejects.
      jest.mocked(listWorkEntries).mockResolvedValue([]);
      standalone.resolveStandaloneChatTarget.mockResolvedValue({
        workspaceId: project,
        entryId: null,
        archivedInEntryId: entry.id,
        isArchived: true,
      });
      return Promise.reject(reconciliationError);
    });
    const command: PortalCommandEnvelope = {
      id: 'archive-a',
      sequence: 1,
      createdAt: entry.createdAt,
      expiresAt: null,
      type: 'portal.standalone_chat.archive',
      target: { standaloneChatLocalId: chat },
      payload: { chatId: chat, workEntryId: entry.id, projectLocalId: project },
    };
    const context = {
      complete: jest.fn(),
      fail: jest.fn(),
      enqueueEvent: jest.fn(),
      getWindow: (): null => null,
      canArchiveStandaloneChats: (): boolean => true,
      confirmArchivePairing: (): Promise<boolean> => Promise.resolve(true),
    };
    await handlePortalStandaloneChatArchive(command, context);
    expect(context.fail).toHaveBeenCalledWith(
      command,
      'execution_failed',
      "Couldn't archive the chat.",
      false,
    );
    expect(context.complete).not.toHaveBeenCalled();
    jest.mocked(listWorkEntries).mockClear();

    const retry = { ...command, id: 'archive-retry', sequence: 2 };
    await handlePortalStandaloneChatArchive(retry, context);
    expect(context.complete).not.toHaveBeenCalled();
    expect(context.fail).toHaveBeenCalledWith(
      retry,
      'execution_failed',
      "Couldn't archive the chat.",
      false,
    );
    expect(listWorkEntries).toHaveBeenCalledWith(project, { strictRead: true });
    expect(captureWorkEntryArchivedContainer).toHaveBeenCalledTimes(1);
    expect(removeWorkEntryRow).toHaveBeenCalledTimes(1);
  });

  it('keeps cowork and App Advisor update projections and telemetry', async () => {
    await updateWorkEntryMutation({
      projectId: 'project-a',
      entryId: 'entry-a',
      title: 'Renamed',
    });

    expect(updateWorkEntry).toHaveBeenCalledWith('project-a', 'entry-a', {
      title: 'Renamed',
    });
    expect(standalone.emitStandaloneWorkEntrySummary).toHaveBeenCalledWith(
      'project-a',
      'entry-a',
    );
    expect(telemetry.refreshWorktreeMetadata).toHaveBeenCalledWith(
      'project-a',
      'entry-a',
    );

    await updateWorkEntryMutation({
      projectId: APP_ADVISOR_PROJECT_ID,
      entryId: 'entry-a',
      title: null,
    });
    expect(updateWorkEntry).toHaveBeenLastCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-a',
      { title: null },
    );
    expect(appAdvisor.projectAppAdvisorChatSummaries).toHaveBeenCalledWith(
      'entry-a',
    );
    expect(standalone.emitStandaloneWorkEntrySummary).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'preserves the complete fenced deletion lifecycle when archive=%s',
    async (archive) => {
      const result = await deleteWorkEntryMutation({
        projectId: 'project-a',
        entryId: 'entry-a',
        ...(archive ? { lockAfterArchive: true } : {}),
      });

      expect(result).toEqual({ browserCleanupPending: true });
      expect(assertWorktreeCanBeRemoved).toHaveBeenCalledWith(
        'project-a',
        'entry-a',
      );
      expect(resolveContainerRetentionDays).toHaveBeenCalledWith('project-a');
      expect(queue.queue.beginWorktreeDeletion).toHaveBeenCalledWith(
        'project-a',
        'entry-a',
      );
      expect(browser.prepareTaskBrowserRetirement).toHaveBeenCalledWith(
        'project-a',
        'entry-a',
        entry.createdAt,
      );
      expect(chatState.runWithScopeDeletionLifecycle).toHaveBeenCalledWith(
        { projectId: 'project-a', worktreeId: 'entry-a' },
        expect.any(Function),
      );
      expect(destroyWorktreeSessions).toHaveBeenCalledWith(
        'project-a',
        'entry-a',
      );
      expect(listWorkEntryChatSummaries).toHaveBeenCalledWith('project-a');
      expect(chatState.runWithScopeDeletion).toHaveBeenCalledWith(
        { projectId: 'project-a', worktreeId: 'entry-a' },
        expect.any(Function),
      );
      expect(captureWorkEntryArchivedContainer).toHaveBeenCalledWith({
        workspaceId: 'project-a',
        entryId: 'entry-a',
        entryTitle: 'Entry A',
        entryCreatedAt: entry.createdAt,
        retentionDays: 7,
        ...(archive ? { lockAfterArchive: true } : {}),
      });
      expect(telemetry.drainWorktreeForDeletion).toHaveBeenCalledWith(
        'project-a',
        'entry-a',
      );
      expect(cleanupPersistedWorktreeData).toHaveBeenCalledWith(
        'project-a',
        'entry-a',
        {
          chatSearchDisposition: 'container-archived',
          deferLocalWatcherCancellationCommit: true,
        },
      );
      expect(removeWorkEntryRow).toHaveBeenCalledWith('project-a', 'entry-a');
      expect(notifyLedgerContainerArchived).toHaveBeenCalled();
      expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);
      expect(browser.commitTaskBrowserRetirement).toHaveBeenCalledWith(
        'project-a',
        'entry-a',
        'owner_removed',
        'retirement-a',
      );
      expect(watcher.commitLocalScopeCancellation).toHaveBeenCalledWith(
        'project-a',
        'entry-a',
      );
      expect(queue.deletion.commit).toHaveBeenCalledTimes(1);
      expect(queue.deletion.rollback).not.toHaveBeenCalled();
      expect(standalone.emitStandaloneChatRemovals).toHaveBeenCalledWith(
        'project-a',
        [],
      );
      expect(broadcastArchivedContainersChanged).toHaveBeenCalledWith(
        'project-a',
      );

      const captureOrder = jest.mocked(captureWorkEntryArchivedContainer).mock
        .invocationCallOrder[0];
      const sessionDestroyOrder = jest.mocked(destroyWorktreeSessions).mock
        .invocationCallOrder[0];
      const cleanupOrder = jest.mocked(cleanupPersistedWorktreeData).mock
        .invocationCallOrder[0];
      const removeOrder =
        jest.mocked(removeWorkEntryRow).mock.invocationCallOrder[0];
      const watcherCommitOrder =
        watcher.commitLocalScopeCancellation.mock.invocationCallOrder[0];
      const queueCommitOrder =
        queue.deletion.commit.mock.invocationCallOrder[0];
      expect(sessionDestroyOrder).toBeLessThan(captureOrder);
      expect(captureOrder).toBeLessThan(cleanupOrder);
      expect(cleanupOrder).toBeLessThan(removeOrder);
      expect(removeOrder).toBeLessThan(queueCommitOrder);
      expect(queueCommitOrder).toBeLessThan(watcherCommitOrder);
    },
  );

  it('settles a committed archive when browser and watcher cleanup fail', async () => {
    const browserError = new Error('browser retirement failed');
    const watcherError = new Error('watcher cancellation failed');
    browser.commitTaskBrowserRetirement.mockRejectedValueOnce(browserError);
    watcher.commitLocalScopeCancellation.mockRejectedValueOnce(watcherError);

    await expect(
      deleteWorkEntryMutation({
        projectId: 'project-a',
        entryId: 'entry-a',
        lockAfterArchive: true,
      }),
    ).resolves.toEqual({ browserCleanupPending: true });

    expect(queue.deletion.commit).toHaveBeenCalledTimes(1);
    expect(queue.deletion.rollback).not.toHaveBeenCalled();
    expect(watcher.commitLocalScopeCancellation).toHaveBeenCalledTimes(1);
    expect(mainProcessLogging.logMainProcessError).toHaveBeenCalledWith(
      expect.any(String),
      browserError,
    );
    expect(mainProcessLogging.logMainProcessError).toHaveBeenCalledWith(
      expect.any(String),
      watcherError,
    );
    expect(standalone.emitStandaloneChatRemovals).toHaveBeenCalledWith(
      'project-a',
      [],
    );
    expect(broadcastArchivedContainersChanged).toHaveBeenCalledWith(
      'project-a',
    );
  });

  it('retains the E2E late-provider checkpoint hook during deletion', async () => {
    const previousE2eDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      '__CANOPY_E2E__',
    );
    const previousDelay =
      process.env.CANOPY_E2E_WORK_ENTRY_DELETION_FENCE_DELAY_MS;
    const previousChatId =
      process.env.CANOPY_E2E_WORK_ENTRY_DELETION_LATE_PROVIDER_CHAT_ID;
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      value: true,
      configurable: true,
    });
    process.env.CANOPY_E2E_WORK_ENTRY_DELETION_FENCE_DELAY_MS = '1';
    process.env.CANOPY_E2E_WORK_ENTRY_DELETION_LATE_PROVIDER_CHAT_ID =
      'late-chat';
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    try {
      await deleteWorkEntryMutation({
        projectId: 'project-a',
        entryId: 'entry-a',
      });
      // The fence checkpoint waits the configured delay before the late event.
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1);
    } finally {
      if (previousE2eDescriptor) {
        Object.defineProperty(
          globalThis,
          '__CANOPY_E2E__',
          previousE2eDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
      }
      if (previousDelay === undefined) {
        delete process.env.CANOPY_E2E_WORK_ENTRY_DELETION_FENCE_DELAY_MS;
      } else {
        process.env.CANOPY_E2E_WORK_ENTRY_DELETION_FENCE_DELAY_MS =
          previousDelay;
      }
      if (previousChatId === undefined) {
        delete process.env.CANOPY_E2E_WORK_ENTRY_DELETION_LATE_PROVIDER_CHAT_ID;
      } else {
        process.env.CANOPY_E2E_WORK_ENTRY_DELETION_LATE_PROVIDER_CHAT_ID =
          previousChatId;
      }
      setTimeoutSpy.mockRestore();
    }

    expect(chatState.ingestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        worktreeId: 'entry-a',
        chatId: 'late-chat',
        mutationId: 'e2e-work-entry-delete-late-provider:entry-a:late-chat',
      }),
    );
  });
});
