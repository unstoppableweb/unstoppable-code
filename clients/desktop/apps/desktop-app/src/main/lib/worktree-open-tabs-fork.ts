import { prepareOpenCodeVisibleFork } from '@canopy/desktop-shared/lib/opencode-fork-context';
import type { ModelHarness } from '@canopy/execution-engine/model-harnesses';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  getExecutionHarnessForModel,
  type ChatTabsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  forkPanelLayoutForTabs,
  type ForkedPanelTabBinding,
} from '@canopy/desktop-shared/panels/fork-layout';
import { forkCodexThreadByIdViaOneShot } from '../codex/fork-thread';
import { settlePersistedForkMessages } from './persisted-chat-settle';
import { withWorktreeRelocationInstruction } from '@canopy/desktop-shared/lib/pending-system-instructions';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import { readChatTabsFile } from './chat-tabs-reader';
import { getChatStateService } from '../services/chat-state-service';
import { resolveWorktreeCwd } from './resolve-worktree';
import { getCurrentBranch } from './git';
import { resolvePersistedApprovalMode } from './approval-mode-resolution';
import {
  clampToLiveApprovalMode,
  getPendingApprovalMode,
  isApprovalModeDowngrade,
} from '../approvals/live-approval-modes';

export interface ForkOpenWorktreeTabsRequest {
  projectId: string;
  sourceWorktreeId: string;
  destinationWorktreeId: string;
  /**
   * Fork the persisted panel layout alongside the tabs (Portal path). The
   * desktop renderer passes false and forks its own live layout, which can be
   * ahead of the persisted one.
   */
  forkPanelLayout?: boolean;
  selectedTab?: {
    sourceTabId: string;
    destinationTab: PersistedChatTab;
    throughMessageId?: string;
  };
}

interface ForkOpenWorktreeTabsDependencies {
  readTabs: typeof readChatTabsFile;
  writeTabs: (
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    beforePublish?: () => void,
    preparePublish?: () => Promise<void>,
  ) => Promise<void>;
  copyTabs: (
    request: ForkOpenWorktreeTabsRequest,
    data: ChatTabsFile,
    sourceChatIds: Readonly<Record<string, string>>,
    throughMessageIds?: Readonly<Record<string, string>>,
    beforePublish?: () => void,
    preparePublish?: () => Promise<void>,
  ) => Promise<void>;
  resolveCwd: typeof resolveWorktreeCwd;
  getCurrentBranch: typeof getCurrentBranch;
  forkCodexThread: typeof forkCodexThreadByIdViaOneShot;
  nextId: () => string;
  now: () => Date;
  loadPanelLayout: typeof panelLayoutPersistenceStore.loadWorktreeLayout;
  savePanelLayout: typeof panelLayoutPersistenceStore.saveWorktreeLayout;
  nextAuxWindowId: () => string;
}

const DEFAULT_DEPENDENCIES: ForkOpenWorktreeTabsDependencies = {
  readTabs: readChatTabsFile,
  writeTabs: async (
    projectId,
    worktreeId,
    data,
    beforePublish,
    preparePublish,
  ) => {
    await getChatStateService().replaceCompatibilityTabs(
      { projectId, worktreeId },
      data,
      { authoritative: true, beforePublish, preparePublish },
    );
  },
  copyTabs: async (
    request,
    data,
    sourceChatIds,
    throughMessageIds,
    beforePublish,
    preparePublish,
  ) =>
    getChatStateService().copyStorageChats(
      { projectId: request.projectId, worktreeId: request.sourceWorktreeId },
      {
        projectId: request.projectId,
        worktreeId: request.destinationWorktreeId,
      },
      data,
      { version: 1, archived: [] },
      sourceChatIds,
      undefined,
      throughMessageIds,
      beforePublish,
      preparePublish,
    ),
  resolveCwd: resolveWorktreeCwd,
  getCurrentBranch,
  forkCodexThread: forkCodexThreadByIdViaOneShot,
  nextId: () => `chat-${randomUUID()}`,
  now: () => new Date(),
  loadPanelLayout: (projectId, worktreeId) =>
    panelLayoutPersistenceStore.loadWorktreeLayout(projectId, worktreeId),
  savePanelLayout: (projectId, worktreeId, layout) =>
    panelLayoutPersistenceStore.saveWorktreeLayout(
      projectId,
      worktreeId,
      layout,
    ),
  nextAuxWindowId: () => `aux-${randomUUID()}`,
};

function rewriteFilePath(
  filePath: string,
  sourceRoot: string,
  destinationRoot: string,
): string | null {
  const relativePath = relative(sourceRoot, filePath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath === ''
    ? destinationRoot
    : join(destinationRoot, relativePath);
}

function stripForkLifecycleState(
  tab: PersistedChatTab,
  options: { stripApprovalState?: boolean } = {},
): void {
  if (resolvePersistedTabHarness(tab) === 'opencode') {
    prepareOpenCodeVisibleFork(tab);
    delete tab.pendingSystemInstructions;
  }
  // A fork inherits transcript/configuration but none of the source tab's
  // delivery, sharing, archive, attention, or error-banner lifecycle.
  delete tab.customTitle;
  delete tab.automaticTitleState;
  delete tab.mcpActivation;
  delete tab.newChatStartedWatcherFiredAt;
  delete tab.adhocMigrationSource;
  delete tab.sharedRun;
  delete tab.pendingRevertAttachmentPath;
  delete tab.scheduledSendDraft;
  delete tab.readOnly;
  delete tab.staleSessionDetected;
  delete tab.llmProviderUsageLimitBanner;
  delete tab.dismissedLlmProviderUsageLimitBannerKey;
  delete tab.attentionDismissedAt;
  delete tab.autoArchive;
  delete tab.unread;
  delete tab.unreadMarkedManually;
  delete tab.codexReconstructionSeedId;
  delete tab.claudeTerminal;
  // The source chat's parked provider sessions stay its own (CAN-6445).
  delete tab.providerSessions;
  if (options.stripApprovalState) {
    delete tab.approvalMode;
    delete tab.sessionApprovalRules;
  }
}

export function clonePersistedWorktreeTab(
  source: PersistedChatTab,
  request: ForkOpenWorktreeTabsRequest,
  sourceRoot: string,
  destinationRoot: string,
  id: string,
  createdAt: string,
): PersistedChatTab | null {
  if (source.kind === 'file') {
    if (!source.filePath) return null;
    const filePath =
      rewriteFilePath(source.filePath, sourceRoot, destinationRoot) ??
      source.filePath;
    return {
      ...structuredClone(source),
      id,
      filePath,
      description: filePath,
      createdAt,
      messages: [],
    };
  }

  const cloned: PersistedChatTab = {
    ...structuredClone(source),
    id,
    createdAt,
    // Settle a snapshot cloned out of a still-streaming source so the fork is
    // an idle, independently editable record while the original turn runs on.
    messages: source.transcript
      ? []
      : settlePersistedForkMessages(
          structuredClone(source.messages),
          Date.now(),
        ),
    newChatStartedWatcherPending: true,
    forkedFrom: {
      projectId: request.projectId,
      worktreeId: request.sourceWorktreeId,
      chatId: source.id,
      ...((source.transcript?.messageCount ?? source.messages.length) > 0
        ? {
            atMessageId: source.transcript
              ? source.transcript.lastMessageId
              : source.messages[source.messages.length - 1]?.id,
          }
        : {}),
    },
  };

  stripForkLifecycleState(cloned);

  const sourceHarness = resolvePersistedTabHarness(source);
  if (sourceHarness === 'claude' && source.sdkSessionId) {
    cloned.sdkSessionId = source.sdkSessionId;
    cloned.claudeForkSessionOnNextSend = true;
    if (cloned.forkedFrom) {
      cloned.forkedFrom.resumePointRequired = true;
    }
  } else {
    delete cloned.sdkSessionId;
    delete cloned.claudeForkSessionOnNextSend;
    if (
      sourceHarness === 'claude' &&
      source.forkedFrom?.modelContext === 'fresh' &&
      cloned.forkedFrom
    ) {
      cloned.forkedFrom.modelContext = 'fresh';
    }
  }
  return cloned;
}

function resolvePersistedTabHarness(source: PersistedChatTab): ModelHarness {
  return (
    source.executionHarness ??
    (source.model ? getExecutionHarnessForModel(source.model) : undefined) ??
    (source.providerType === 'opencode'
      ? 'opencode'
      : source.providerType === 'copilot'
        ? 'copilot'
        : source.providerType === 'cursor'
          ? 'cursor'
          : source.providerType === 'codex'
            ? 'codex'
            : 'claude')
  );
}

/**
 * Persist live tabs from a source worktree as independent forks in a newly
 * created sibling worktree, then copy its panel layout with the new tab ids.
 * Chat archives are stored separately and are never read by this helper, so
 * they remain attached only to the source worktree.
 */
export async function forkOpenWorktreeTabs(
  request: ForkOpenWorktreeTabsRequest,
  dependencies: Partial<ForkOpenWorktreeTabsDependencies> = {},
): Promise<ReadonlyMap<string, ForkedPanelTabBinding>> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  return forkOpenWorktreeTabsLocked(request, deps);
}

export class SourceApprovalChangedDuringBranchError extends Error {
  public constructor() {
    super('Source approval mode became more restrictive while branching');
    this.name = 'SourceApprovalChangedDuringBranchError';
  }
}

async function forkOpenWorktreeTabsLocked(
  request: ForkOpenWorktreeTabsRequest,
  deps: ForkOpenWorktreeTabsDependencies,
): Promise<ReadonlyMap<string, ForkedPanelTabBinding>> {
  const source = await deps.readTabs(
    request.projectId,
    request.sourceWorktreeId,
  );
  const sourceTabs = request.selectedTab
    ? source.tabs.filter((tab) => tab.id === request.selectedTab?.sourceTabId)
    : source.tabs;
  if (sourceTabs.length === 0) return new Map();

  const sourceRoot = deps.resolveCwd(
    request.projectId,
    request.sourceWorktreeId,
  );
  const destinationRoot = deps.resolveCwd(
    request.projectId,
    request.destinationWorktreeId,
  );
  const createdAt = deps.now().toISOString();
  const idMap = new Map<string, string>();
  const tabBindings = new Map<string, ForkedPanelTabBinding>();
  const clonedTabs: PersistedChatTab[] = [];
  let selectedCopiedApprovalMode: PersistedChatTab['approvalMode'];
  let selectedDefaultApprovalMode: PersistedChatTab['approvalMode'];
  let selectedApprovalWasDefaultDerived = false;
  // Resolve each source repository once even when many open chats share it.
  const sourceBranches = new Map<string, Promise<string | undefined>>();

  for (const sourceTab of sourceTabs) {
    const selected = request.selectedTab;
    const id = selected?.destinationTab.id ?? deps.nextId();
    const base = clonePersistedWorktreeTab(
      sourceTab,
      request,
      sourceRoot,
      destinationRoot,
      id,
      createdAt,
    );
    if (!base) continue;
    const cloned =
      selected && sourceTab.kind !== 'file'
        ? {
            ...base,
            ...structuredClone(selected.destinationTab),
            id,
            messages: [],
          }
        : base;
    if (selected && sourceTab.kind !== 'file') {
      if (resolvePersistedTabHarness(sourceTab) === 'opencode') {
        // Native IDs belong to the source profile; ordinary branches seed text.
        delete cloned.sdkSessionId;
        delete cloned.claudeForkSessionOnNextSend;
        cloned.forkedFrom = {
          projectId: request.projectId,
          worktreeId: request.sourceWorktreeId,
          chatId: sourceTab.id,
          atMessageId:
            selected.throughMessageId ?? base.forkedFrom?.atMessageId,
        };
      }
      // Optional session fields are omitted from renderer persistence when the
      // selected branch must start fresh. A spread cannot clear the base
      // clone's carried source session, so honor that omission explicitly.
      if (!selected.destinationTab.sdkSessionId) {
        delete cloned.sdkSessionId;
        delete cloned.claudeForkSessionOnNextSend;
      }
      // The selected branch metadata crosses the renderer-to-main trust
      // boundary. Strip host-owned approval state and re-apply the same
      // lifecycle reset after the renderer metadata merge so it cannot
      // restore fields removed from the source snapshot above.
      stripForkLifecycleState(cloned, { stripApprovalState: true });
      // Put the trusted mode in the same destination commit as the transcript.
      // A publish-boundary guard below rejects the commit if the source becomes
      // more restrictive while the potentially long payload copy is prepared.
      cloned.approvalMode =
        clampToLiveApprovalMode(
          request.projectId,
          request.sourceWorktreeId,
          sourceTab.id,
          await resolvePersistedApprovalMode(
            request.projectId,
            request.sourceWorktreeId,
            sourceTab.approvalMode,
          ),
        ) ?? 'ask';
      selectedCopiedApprovalMode = cloned.approvalMode;
      selectedDefaultApprovalMode = cloned.approvalMode;
      selectedApprovalWasDefaultDerived = sourceTab.approvalMode === undefined;
      cloned.newChatStartedWatcherPending = true;
    }
    if (
      sourceTab.kind !== 'file' &&
      (!selected || resolvePersistedTabHarness(sourceTab) === 'opencode')
    ) {
      const sourceCwd = deps.resolveCwd(
        request.projectId,
        request.sourceWorktreeId,
        sourceTab.selectedRepoId,
      );
      let sourceBranch = sourceBranches.get(sourceCwd);
      if (!sourceBranch) {
        sourceBranch = deps.getCurrentBranch(sourceCwd).catch(() => undefined);
        sourceBranches.set(sourceCwd, sourceBranch);
      }
      cloned.pendingSystemInstructions = withWorktreeRelocationInstruction(
        resolvePersistedTabHarness(sourceTab) !== 'opencode' &&
          sourceTab.pendingSystemInstructions
          ? structuredClone(sourceTab.pendingSystemInstructions)
          : undefined,
        sourceCwd,
        deps.resolveCwd(
          request.projectId,
          request.destinationWorktreeId,
          sourceTab.selectedRepoId,
        ),
        { sourceBranch: await sourceBranch },
      );
    }
    idMap.set(sourceTab.id, id);
    tabBindings.set(sourceTab.id, {
      destinationTabId: id,
      ...(cloned.kind === 'file' && cloned.filePath
        ? { destinationFilePath: cloned.filePath }
        : {}),
    });

    if (
      sourceTab.kind !== 'file' &&
      !selected &&
      resolvePersistedTabHarness(sourceTab) === 'codex' &&
      sourceTab.sdkSessionId
    ) {
      try {
        cloned.sdkSessionId = await deps.forkCodexThread({
          cwd: deps.resolveCwd(
            request.projectId,
            request.destinationWorktreeId,
            sourceTab.selectedRepoId,
          ),
          projectId: request.projectId,
          worktreeId: request.destinationWorktreeId,
          chatId: id,
          sourceThreadId: sourceTab.sdkSessionId,
          sourceProjectId: request.projectId,
          sourceWorktreeId: request.sourceWorktreeId,
          sourceChatId: sourceTab.id,
          ...(sourceTab.pluginSelections
            ? { pluginSelections: sourceTab.pluginSelections }
            : {}),
          ...(sourceTab.modelConfig
            ? { modelConfig: sourceTab.modelConfig }
            : {}),
        });
      } catch {
        // Match the renderer fork behavior: the transcript still transfers,
        // and the destination starts a fresh Codex thread on its next turn.
        delete cloned.sdkSessionId;
      }
    }
    clonedTabs.push(cloned);
  }

  if (clonedTabs.length === 0) return tabBindings;
  const lastActiveEditableChatId = source.lastActiveEditableChatId
    ? idMap.get(source.lastActiveEditableChatId)
    : undefined;
  const destination: ChatTabsFile = {
    version: 1,
    tabs: clonedTabs,
    activeTabId: idMap.get(source.activeTabId) ?? clonedTabs[0]?.id ?? '',
    ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
    ...(source.lastActiveChatProvider
      ? { lastActiveChatProvider: source.lastActiveChatProvider }
      : {}),
  };
  const assertSelectedApprovalModeStillAllowed = (): void => {
    const selected = request.selectedTab;
    const copiedMode = selectedCopiedApprovalMode;
    if (!selected || !copiedMode) return;
    // This guard runs while the storage transaction already owns both scope
    // leases. It must remain an in-memory check: re-reading canonical state or
    // entering the approval queue here would invert those locks. Restrictive
    // setters synchronously update the live registry before awaiting either.
    const liveClampedMode =
      clampToLiveApprovalMode(
        request.projectId,
        request.sourceWorktreeId,
        selected.sourceTabId,
        copiedMode,
      ) ?? 'ask';
    const pendingMode = getPendingApprovalMode(
      request.projectId,
      request.sourceWorktreeId,
      selected.sourceTabId,
    );
    const pendingClampedMode =
      pendingMode !== undefined &&
      isApprovalModeDowngrade(liveClampedMode, pendingMode)
        ? pendingMode
        : liveClampedMode;
    const latestMode =
      selectedApprovalWasDefaultDerived &&
      selectedDefaultApprovalMode !== undefined &&
      isApprovalModeDowngrade(pendingClampedMode, selectedDefaultApprovalMode)
        ? selectedDefaultApprovalMode
        : pendingClampedMode;
    if (isApprovalModeDowngrade(copiedMode, latestMode)) {
      throw new SourceApprovalChangedDuringBranchError();
    }
  };
  const refreshSelectedDefaultApprovalMode = async (): Promise<void> => {
    const selected = request.selectedTab;
    if (!selected || !selectedApprovalWasDefaultDerived) return;
    selectedDefaultApprovalMode = await resolvePersistedApprovalMode(
      request.projectId,
      request.sourceWorktreeId,
    );
  };
  if (sourceTabs.some((tab) => tab.transcript)) {
    const throughMessageIds =
      request.selectedTab?.throughMessageId === undefined
        ? undefined
        : {
            [request.selectedTab.destinationTab.id]:
              request.selectedTab.throughMessageId,
          };
    await deps.copyTabs(
      request,
      destination,
      Object.fromEntries(
        Array.from(idMap.entries()).map(([from, to]) => [to, from]),
      ),
      throughMessageIds,
      assertSelectedApprovalModeStillAllowed,
      refreshSelectedDefaultApprovalMode,
    );
  } else {
    await deps.writeTabs(
      request.projectId,
      request.destinationWorktreeId,
      destination,
      assertSelectedApprovalModeStillAllowed,
      refreshSelectedDefaultApprovalMode,
    );
  }

  if (request.forkPanelLayout !== false) {
    const panelLayout = forkPanelLayoutForTabs(
      deps.loadPanelLayout(request.projectId, request.sourceWorktreeId),
      tabBindings,
      { nextAuxWindowId: deps.nextAuxWindowId },
    );
    if (panelLayout !== null) {
      deps.savePanelLayout(
        request.projectId,
        request.destinationWorktreeId,
        panelLayout,
      );
    }
  }
  return tabBindings;
}
