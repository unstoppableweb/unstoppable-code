import { buildProjectedModelCatalog } from '../remote-projection/model-catalog-projection';
import { resolveCatalogAgentDefaultModel } from '../agents/agent-default-model';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import { peekRemoteControlProviderAvailability } from '../auth/provider-auth-state';
import { projectSidebarItemGroups } from './sidebar-item-groups-service';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { getOrgProjectCatalogService } from './org-project-catalog-service';
import { appendOrgProjectPlaceholderRows } from './org-project-placeholder-rows';
import type { DesktopSessionSnapshotArgs } from '@canopy/desktop-shared/types';
import { recordStaleWork } from '@canopy/desktop-shared/node/work-counters';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { validateId } from '../lib/validation';
import { listWorktreeChatSummaryBatch } from './worktree-chat-summary-batch';
import {
  projectRemoteBackgroundService,
  projectRemoteW5Recovery,
  type RemoteControlSessionShellState,
  type RemoteControlTarget,
} from '@canopy/protocol/remote-control/shell';
import { peekDesktopW5RecoveryForRemote } from '../canopy-runtime/desktop-w5-recovery';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import { listWorkspaceRemoteControlEntities } from './workspace-remote-control-service';
import { readAllSidebarItemsSnapshot } from '../lib/sidebar-items';
import { runW5ReadView } from '../lib/w5-commit-log-file-store';
import { workspaceStorageUnavailable } from '../lib/workspace-storage-availability';
import {
  listStandaloneChats,
  projectStandaloneChatSnapshot,
  withStandalonePendingQuestions,
} from './standalone-chat-service';

/** Placeholders belong to the unscoped overview only; a scoped snapshot names real rows. */
function isOverviewTarget(target: RemoteControlTarget | undefined): boolean {
  return (
    target === undefined ||
    Object.values(target).every((value) => value === undefined)
  );
}

function isActivityId(value: string): boolean {
  try {
    validateId(value, 'activityId');
    return true;
  } catch {
    return false;
  }
}

/** One session snapshot build, counted with its wall time (CAN-6970). */
export async function buildDesktopSessionSnapshot(
  args?: DesktopSessionSnapshotArgs,
): Promise<RemoteControlSessionShellState> {
  const startedAt = performance.now();
  try {
    return await composeDesktopSessionSnapshot(args);
  } finally {
    recordStaleWork('snapshot.build');
    recordStaleWork(
      'snapshot.build.us',
      Math.round((performance.now() - startedAt) * 1000),
    );
  }
}

/** Remote Control shows the same notices as this computer (CAN-7061). */
function desktopNotices(): Pick<
  RemoteControlSessionShellState,
  'w5Recovery' | 'backgroundService'
> {
  const backgroundService = projectRemoteBackgroundService(
    getElectronDaemonHealth().getStatus(),
  );
  return {
    w5Recovery: projectRemoteW5Recovery(peekDesktopW5RecoveryForRemote()),
    ...(backgroundService && { backgroundService }),
  };
}

/**
 * The notices alone: no workspace read, so they still arrive while the
 * overview's discovery fails closed with the background service down.
 */
function desktopNoticesSnapshot(): RemoteControlSessionShellState {
  return {
    ...desktopNotices(),
    workspaces: [],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
  };
}

async function composeDesktopSessionSnapshot(
  args?: DesktopSessionSnapshotArgs,
): Promise<RemoteControlSessionShellState> {
  const { includeChatSummaries, standaloneChatLocalId, noticesOnly, ...scope } =
    args ?? {};
  if (noticesOnly === true) return desktopNoticesSnapshot();
  const target = args === undefined ? undefined : scope;
  const includeStandalone =
    standaloneChatLocalId !== undefined ||
    (!target?.workspaceLocalId &&
      !(includeChatSummaries === true && !isOverviewTarget(target)));
  const workspaces: RemoteControlSessionShellState['workspaces'] = [];
  const worktrees: RemoteControlSessionShellState['worktrees'] = [];
  // Share discovery, not composition: default-project provisioning and runtime
  // decoration must run after the write-refusing view has closed.
  const sidebarSnapshot = await runW5ReadView(
    { files: [], discoverWorkspaces: true },
    async (view) => {
      if (view.status === 'uncaptured' && view.error) throw view.error;
      const sidebarSnapshot = await readAllSidebarItemsSnapshot();
      if (sidebarSnapshot.indexAuthority === 'unreadable')
        throw workspaceStorageUnavailable(sidebarSnapshot.indexUnserved);
      return sidebarSnapshot;
    },
  );
  await listWorkspaceRemoteControlEntities(target, {
    sidebarSnapshot,
    statsSource: 'desktop-session-snapshot',
    onWorkspace: (workspace): void => {
      workspaces.push(workspace);
    },
    onWorktree: (worktree): void => {
      worktrees.push(worktree);
    },
  });
  const context = getWorkspaceContextService().getState().context;
  let snapshotWorkspaces = workspaces;
  if (
    isOverviewTarget(target) &&
    context.kind === 'organization' &&
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    )
  ) {
    // `peek` and not `list`: `list` refreshes a stale entry and clears an
    // unavailable one, and both broadcast — which invalidates this snapshot,
    // which rebuilds it, which reads the catalog again. Reading the cache
    // keeps the catalog's own refresh schedule the only thing that fetches,
    // and the broadcast still invalidates this snapshot once, when the rows
    // actually change.
    try {
      const catalog = getOrgProjectCatalogService().peek(context);
      if (catalog)
        snapshotWorkspaces = appendOrgProjectPlaceholderRows(
          workspaces,
          catalog,
          context,
        );
    } catch {
      // Catalog availability must never prevent local session discovery.
    }
  }
  const listedStandaloneChats = !includeStandalone
    ? []
    : await listStandaloneChats(
        includeChatSummaries === true
          ? {
              sidebarSnapshot,
              strict: true,
              projectIds: workspaces
                .filter(
                  (workspace) =>
                    !workspace.hidden &&
                    workspace.type === 'cowork' &&
                    isActivityId(workspace.localId),
                )
                .map((workspace) => workspace.localId),
            }
          : { sidebarSnapshot },
      );
  // Compact listings carry no turn end, so a chat whose session is gone would
  // read as never having ended. One chat's read takes them from its tabs
  // file, as the Portal `standalone_chat` snapshot does.
  let standaloneChats = (
    standaloneChatLocalId === undefined
      ? listedStandaloneChats
      : await Promise.all(
          listedStandaloneChats
            .filter((chat) => chat.chatId === standaloneChatLocalId)
            .map(withStandalonePendingQuestions),
        )
  ).map(projectStandaloneChatSnapshot);

  let chatSummaries: RemoteControlSessionShellState['chatSummaries'] = [];
  if (includeChatSummaries === true) {
    const visibleWorkspaces = new Map(
      workspaces
        .filter((workspace) => !workspace.hidden)
        .map((workspace) => [workspace.localId, workspace]),
    );
    const targets = worktrees
      .filter((worktree) => {
        const parent = visibleWorkspaces.get(worktree.workspaceLocalId);
        if (
          !parent ||
          worktree.hidden ||
          (parent.type !== 'single-repo' && parent.type !== 'multi-repo')
        )
          return false;
        if (
          target?.workspaceLocalId &&
          parent.localId !== target.workspaceLocalId
        )
          return false;
        if (
          target?.worktreeLocalId &&
          worktree.localId !== target.worktreeLocalId
        )
          return false;
        try {
          validateId(parent.localId, 'workspaceId');
          validateId(worktree.localId, 'worktreeId');
          return true;
        } catch {
          return false;
        }
      })
      .map((worktree) => ({
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
      }));
    chatSummaries = (await listWorktreeChatSummaryBatch(targets)).flatMap(
      ({ target: pair, summaries }) =>
        summaries.filter(
          (summary) =>
            summary.scope === 'worktree' &&
            isActivityId(summary.chatId) &&
            summary.workspaceLocalId === pair.workspaceLocalId &&
            summary.worktreeLocalId === pair.worktreeLocalId,
        ),
    );
    standaloneChats = standaloneChats.filter((chat) => {
      if (!isOverviewTarget(target)) return false;
      const parent = visibleWorkspaces.get(chat.projectLocalId);
      return (
        parent?.type === 'cowork' &&
        !chat.archived &&
        isActivityId(chat.localId) &&
        (chat.workEntryId === undefined || isActivityId(chat.workEntryId))
      );
    });
  }

  const destinationCatalog = async (
    projectId: string,
    worktreeId?: string,
    chatId?: string,
  ): Promise<
    NonNullable<RemoteControlSessionShellState['availableModels']>
  > => {
    const owner = await resolveAiCreditsScopeOwner({
      kind: 'work',
      projectId,
      worktreeId,
      chatId,
    });
    return buildProjectedModelCatalog(undefined, {
      cursor: true,
      antigravity: !isBotProjectId(projectId),
      copilot: true,
      opencode: true,
      owner,
      projectId,
      agentDefaultModel: await resolveCatalogAgentDefaultModel(projectId),
    });
  };
  if (standaloneChatLocalId !== undefined) {
    standaloneChats = await Promise.all(
      standaloneChats.map(async (chat) => ({
        ...chat,
        availableModels: await destinationCatalog(
          chat.projectLocalId,
          chat.workEntryId,
          chat.localId,
        ),
      })),
    );
  }
  const availableModels = target?.workspaceLocalId
    ? await destinationCatalog(target.workspaceLocalId, target.worktreeLocalId)
    : undefined;
  const appAdvisorItemGroups = await projectSidebarItemGroups({
    appAdvisor: true,
  });
  return {
    ...(isOverviewTarget(target) && desktopNotices()),
    ...(appAdvisorItemGroups === undefined ? {} : { appAdvisorItemGroups }),
    ...(availableModels === undefined
      ? {}
      : {
          availableModels,
          providerAvailability: peekRemoteControlProviderAvailability(),
        }),
    workspaces: snapshotWorkspaces,
    worktrees,
    chatProjects: [],
    standaloneChats,
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries,
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
  };
}
