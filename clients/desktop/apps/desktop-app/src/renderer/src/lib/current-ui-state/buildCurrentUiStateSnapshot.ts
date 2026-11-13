import { isDataSharingOptInFeature } from '@canopy/protocol/canopy-server';
import { isSidebarItemGroupId } from '@canopy/protocol/sidebar';
import {
  APP_ADVISOR_REPO_RULES_MODAL_SOURCES,
  PLUGINS_MANAGEMENT_SECTIONS,
  WORKSPACE_ROOT_REPO_ID,
  type AgentProviderType,
  type AppAdvisorJson,
  type AppAdvisorRepoRulesModalSource,
  type AppAdvisorUiStateEnvelope,
  type AppAdvisorWindowLayout,
  type AppAdvisorUiStateSnapshot,
  type ChatActivePlanContext,
  type ClaudeTerminalTurnState,
  type PluginsManagementSectionId,
  type ProjectOwnerContext,
  type SidebarItem,
  type WorkspaceSettingsTab,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import { isChatHarnessActionAvailable } from '@/lib/chat-harness-actions';
import type {
  OrgProjectMoveErrorCode,
  SharedContainerAccessBlockReason,
  SharedContainerBlockedReason,
  SharedContainerInviteAudience,
} from '@canopy/desktop-shared/types';
import type { SplitPrBlocker } from '@canopy/desktop-shared/types/github';
import { APP_ADVISOR_CONTEXT_TAG } from '@canopy/desktop-shared/lib/app-advisor-context';
import {
  codexSpeedFastMode,
  readCodexSpeedRecord,
  type CodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  PIPELINE_DETAIL_MODAL_UI_STATE_KEY,
  PIPELINE_DETAIL_PANEL_UI_STATE_KEY_PREFIX,
} from './pipelineDetailUiState';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { parseInstalledStatusFilter } from '@canopy/ui-shared/lib/installed-item-status';
import {
  MEMORY_SYNC_SETTINGS_UI_STATE_KEY,
  readMemorySyncSettingsState,
  readMemorySyncViewState,
} from './memory-sync-ui-state';
import {
  normalizeManagedDelegationLifetimeLimit,
  normalizeManagedDelegationMaxDepth,
} from '@canopy/protocol/delegation/discovery';
import { captureActivePlanContext } from '@/stores/activePlanStore';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useChatStore } from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useFileLabelsStore } from '@/stores/fileLabelsStore';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useSidebarPageHandoffStore } from '@/stores/sidebarPageHandoffStore';
import { useTerminalStore } from '@/stores/terminalStore';
import {
  DEFAULT_BROWSER_INSPECTOR_TAB,
  selectActiveTransferCount,
  selectConsoleErrorCount,
  selectFailedRequestCount,
  useBrowserStore,
} from '@/stores/browserStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import { isPlanPanelKind } from '@/lib/panels/plan-panel-identity';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { brandText } from '@/lib/brand';
import {
  listAvailablePages,
  resolveNavigationTarget,
} from '@/lib/navigation/page-availability';
import { COST_PANEL_UI_STATE_PREFIX } from '@/lib/cost/cost-panel-ui-state';

const WORKSPACE_SETTINGS_TYPES = new Set([
  'single-repo',
  'multi-repo',
  'cowork',
]);
const WORKSPACE_SETTINGS_TABS = new Set([
  'general',
  'details',
  'repositories',
  'scripts',
  'hooks',
  'plan-detection',
  'claude-md',
  'instructions',
  'plugins',
  'environment',
  'code-graph',
  'danger',
]);

/** The App Advisor window layout slice, when it holds a known layout. */
function readAppAdvisorLayout(value: AppAdvisorJson | undefined): {
  appAdvisorLayout?: AppAdvisorWindowLayout;
} {
  return value === 'floating' || value === 'full'
    ? { appAdvisorLayout: value }
    : {};
}

function isWorkspaceSettingsType(value: string): value is WorkspaceType {
  return WORKSPACE_SETTINGS_TYPES.has(value);
}

function isWorkspaceSettingsTab(value: string): value is WorkspaceSettingsTab {
  return WORKSPACE_SETTINGS_TABS.has(value);
}

const SHARED_CONTAINER_BLOCKED_REASON_MEMBERS = {
  'no-cloud-account': true,
  'account-unavailable': true,
  'guest-account': true,
  'no-organization': true,
  'unsupported-capability': true,
  'sync-disabled': true,
  'sync-blocked-by-org': true,
  'not-yet-synced': true,
  'registration-failed': true,
  'anchored-to-other-organization': true,
  'insufficient-role': true,
  'blocked-by-org-billing': true,
  'github-not-ready': true,
  'external-sharing-disabled': true,
} satisfies Record<SharedContainerBlockedReason, true>;
const SHARED_CONTAINER_BLOCKED_REASONS = new Set(
  Object.keys(SHARED_CONTAINER_BLOCKED_REASON_MEMBERS),
);

const ORG_PROJECT_MOVE_ERROR_CODE_MEMBERS = {
  unavailable: true,
  'workspace-not-found': true,
  'workspace-unreadable': true,
  'unsupported-workspace': true,
  'not-personal': true,
  'repository-outside-organization': true,
  'repository-unavailable': true,
  'limit-reached': true,
  'project-unavailable': true,
  'project-already-bound': true,
  busy: true,
  offline: true,
  'move-failed': true,
} satisfies Record<OrgProjectMoveErrorCode, true>;
const ORG_PROJECT_MOVE_ERROR_CODES = new Set(
  Object.keys(ORG_PROJECT_MOVE_ERROR_CODE_MEMBERS),
);

function isOrgProjectMoveErrorCode(
  value: string,
): value is OrgProjectMoveErrorCode {
  return ORG_PROJECT_MOVE_ERROR_CODES.has(value);
}

const REPO_RULES_MODAL_SOURCES: ReadonlySet<string> = new Set(
  APP_ADVISOR_REPO_RULES_MODAL_SOURCES,
);

function isRepoRulesModalSource(
  value: string,
): value is AppAdvisorRepoRulesModalSource {
  return REPO_RULES_MODAL_SOURCES.has(value);
}

function isSharedContainerBlockedReason(
  value: string,
): value is SharedContainerBlockedReason {
  return SHARED_CONTAINER_BLOCKED_REASONS.has(value);
}

/**
 * Recipient-side access-block reasons (CAN-2550). Deliberately a separate
 * closed set from the owner-side {@link SharedContainerBlockedReason}: they
 * describe different failures and must not be interchangeable in the snapshot.
 */
const SHARED_CONTAINER_ACCESS_BLOCK_REASON_MEMBERS = {
  'update-required': true,
  'unsupported-remote-host': true,
  'github-not-connected': true,
  'repository-access-missing': true,
  'commit-unavailable': true,
  'lfs-unsupported': true,
  'symlink-unsupported': true,
  'git-credentials-missing': true,
} satisfies Record<SharedContainerAccessBlockReason, true>;
const SHARED_CONTAINER_ACCESS_BLOCK_REASONS = new Set(
  Object.keys(SHARED_CONTAINER_ACCESS_BLOCK_REASON_MEMBERS),
);

function isSharedContainerAccessBlockReason(
  value: string,
): value is SharedContainerAccessBlockReason {
  return SHARED_CONTAINER_ACCESS_BLOCK_REASONS.has(value);
}

type PrMergeModalRepoUiState = NonNullable<
  NonNullable<
    NonNullable<AppAdvisorUiStateSnapshot['appAdvisor']>['prMergeModal']
  >['repos']
>[number];

type SharedContainerRecipientListedUiState = NonNullable<
  NonNullable<
    AppAdvisorUiStateSnapshot['sharedContainersRecipientSurface']
  >['listedContainers']
>[number];

/** Coerce an `AppAdvisorJson` field to a string only when it is already a
 * scalar (`string`/`number`/`boolean`). Returning `undefined` for objects /
 * arrays prevents `[object Object]` from leaking into the snapshot. */
function readString(value: AppAdvisorJson | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function readStringList(
  value: AppAdvisorJson | undefined,
  limit: number,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (candidate): candidate is string => typeof candidate === 'string',
  );
  return strings.slice(0, limit);
}

function isAgentProviderType(
  value: string | undefined,
): value is AgentProviderType {
  return value === 'claude' || value === 'codex' || value === 'ollama';
}

function isManagedDelegationMode(
  value: string | undefined,
): value is 'off' | 'explicit-only' | 'proactive' {
  return value === 'off' || value === 'explicit-only' || value === 'proactive';
}

function isAuthTerminalProvider(
  value: string | undefined,
): value is 'claude' | 'codex' | 'github' {
  return value === 'claude' || value === 'codex' || value === 'github';
}

function isClaudeTerminalTurnState(
  value: string | undefined,
): value is ClaudeTerminalTurnState {
  return (
    value === 'uninitialized' ||
    value === 'starting' ||
    value === 'idle' ||
    value === 'running' ||
    value === 'exited' ||
    value === 'error' ||
    value === 'cleaning_up'
  );
}

/**
 * Build a sanitized {@link AppAdvisorUiStateSnapshot} from live zustand
 * stores and any component-local reporter slices.
 *
 * The builder is intentionally defensive: every secret-bearing field is
 * read by name and dropped (Portal pairing codes), and free-form fields
 * (chat transcripts, file contents, terminal output, pipeline logs) are
 * *never* read. The resulting JSON is what the App Advisor sees as
 * the branded App Advisor context block.
 *
 * Component-local slices (e.g. the pipeline editor's dirty flag, the
 * pipeline-runs detail modal) are passed in via `slices` so reporters can
 * register transient UI state through {@link useCurrentUiStateReporter}.
 * Keys are namespaced (`pipelineRuns.detailModal`) to keep ownership clear.
 */
export function buildCurrentUiStateSnapshot(
  slices: Record<string, AppAdvisorJson>,
): AppAdvisorUiStateSnapshot {
  const nav = useNavigationStore.getState();
  const chat = useChatStore.getState();
  const projects = useProjectsStore.getState();
  const pipelineRuns = usePipelineRunsStore.getState();
  const portal = useCanopyPortalStore.getState().state;
  const canopyPortalFeatureEnabled = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key);

  const navigationHistory = useNavigationHistoryStore.getState();
  const fileLabels = useFileLabelsStore.getState();

  // Archived-container state is reported by `ArchivedContainerView` and the
  // "Archived and deleted" overview page through
  // `useCurrentUiStateReporter('archivedContainers', …)`; the slice is absent
  // whenever neither surface is mounted.
  const archivedContainersSlice = readObject(slices['archivedContainers']);
  const archivedOverviewOpen = readBoolean(
    archivedContainersSlice?.overviewOpen,
  );
  const archivedWorkspaceId = readString(archivedContainersSlice?.workspaceId);
  const archivedEmptyTrashConfirmationOpen = readBoolean(
    archivedContainersSlice?.emptyTrashConfirmationOpen,
  );
  const archivedViewerKind = readString(archivedContainersSlice?.viewerKind);
  const archivedViewerTab = readString(archivedContainersSlice?.viewerTab);
  const archivedViewerLocked = readBoolean(
    archivedContainersSlice?.viewerLocked,
  );
  const archivedSelectedChatId = readString(
    archivedContainersSlice?.selectedChatId,
  );
  const archivedSelectedPlanId = readString(
    archivedContainersSlice?.selectedPlanId,
  );

  // CAN-2952: the context this window is looking at, once hydrated from main.
  const workspaceContextStore = useWorkspaceContextStore.getState();
  const workspaceContextSnapshot = workspaceContextStore.hydrated
    ? {
        kind: workspaceContextStore.state.context.kind,
        ...(workspaceContextStore.state.context.kind === 'organization'
          ? {
              organizationId:
                workspaceContextStore.state.context.organizationId,
            }
          : {}),
        organizationCount: workspaceContextStore.state.organizations.length,
      }
    : null;
  // CAN-2956: the organization catalog rows the sidebar is showing, and the
  // setup running on one of them if any. Reported by the sidebar section, so
  // the assistant sees the same rows the member does.
  const orgProjectsSnapshot =
    workspaceContextStore.hydrated &&
    workspaceContextStore.state.context.kind === 'organization'
      ? readOrgProjectRows(
          workspaceContextStore.state.context.organizationId,
          readObject(slices['sidebar.orgProjects']),
        )
      : undefined;
  const snapshot: AppAdvisorUiStateSnapshot = {
    // While the page host is still moving off a page that was just switched
    // off, report where it is going rather than a page that is not on screen.
    activePage: resolveNavigationTarget(nav.activePage),
    availablePages: listAvailablePages(),
    archivedContainers: {
      count: readNumber(archivedContainersSlice?.count) ?? 0,
      viewerOpen: readBoolean(archivedContainersSlice?.viewerOpen) ?? false,
      ...(archivedOverviewOpen !== null
        ? { overviewOpen: archivedOverviewOpen }
        : {}),
      ...(archivedWorkspaceId !== undefined
        ? { workspaceId: archivedWorkspaceId }
        : {}),
      ...(archivedEmptyTrashConfirmationOpen !== null
        ? {
            emptyTrashConfirmationOpen: archivedEmptyTrashConfirmationOpen,
          }
        : {}),
      ...(archivedViewerKind === 'worktree' ||
      archivedViewerKind === 'work-entry'
        ? { viewerKind: archivedViewerKind }
        : {}),
      ...(archivedViewerTab === 'changes' ||
      archivedViewerTab === 'chats' ||
      archivedViewerTab === 'pipelines' ||
      archivedViewerTab === 'attachments' ||
      archivedViewerTab === 'plans'
        ? { viewerTab: archivedViewerTab }
        : {}),
      ...(archivedViewerLocked !== null
        ? { viewerLocked: archivedViewerLocked }
        : {}),
      ...(archivedSelectedChatId !== undefined
        ? { selectedChatId: archivedSelectedChatId }
        : {}),
      ...(archivedSelectedPlanId !== undefined
        ? { selectedPlanId: archivedSelectedPlanId }
        : {}),
    },
    ...(workspaceContextSnapshot
      ? { workspaceContext: workspaceContextSnapshot }
      : {}),
    ...(orgProjectsSnapshot ? { orgProjects: orgProjectsSnapshot } : {}),
    navigationHistory: {
      canGoBack: navigationHistory.canGoBack,
      canGoForward: navigationHistory.canGoForward,
    },
    changedFilesFilter: {
      hiddenLabelIds: fileLabels.hiddenLabelIds.slice(0, 100),
    },
    settings: {
      open: nav.settingsOpen,
      section: nav.settingsInitialSection,
      ...hostedSettingsSnapshot(nav),
    },
    overlays: {
      commandPaletteOpen: nav.commandPaletteOpen,
      fileSearchPaletteOpen: nav.fileSearchPaletteOpen,
      prPickerOpen: nav.prPickerOpen,
      canopyPortalOpen: nav.canopyPortalOpen,
      // App Advisor sets this slice via a reporter; default to false so the
      // builder works even before the dialog has registered itself.
      appAdvisorOpen: readBoolean(slices['appAdvisor.dialogOpen']) ?? false,
      ...readAppAdvisorLayout(slices['appAdvisor.dialogLayout']),
    },
    dirtyFileTabIds: desktopFileSessionController.dirtyTabIds(),
    activeCoworkProjectId:
      useStandaloneChatStore.getState().activeChatProjectId,
  };
  const workspaceSettingsSlice = readObject(slices['workspaceSettings.modal']);
  if (workspaceSettingsSlice) {
    const workspaceId = readString(workspaceSettingsSlice.workspaceId);
    const workspaceType = readString(workspaceSettingsSlice.workspaceType);
    const activeTab = readString(workspaceSettingsSlice.activeTab);
    snapshot.workspaceSettings = {
      open: readBoolean(workspaceSettingsSlice.open) ?? false,
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceType && isWorkspaceSettingsType(workspaceType)
        ? { workspaceType }
        : {}),
      ...(activeTab && isWorkspaceSettingsTab(activeTab) ? { activeTab } : {}),
    };
  }
  const mobileAppCtaBannerSlice = readObject(slices['mobileAppCtaBanner.pill']);
  if (mobileAppCtaBannerSlice) {
    snapshot.mobileAppCtaBanner = {
      open: readBoolean(mobileAppCtaBannerSlice.open) ?? false,
      popoverOpen: readBoolean(mobileAppCtaBannerSlice.popoverOpen) ?? false,
    };
  }
  const releaseHighlightsDialogSlice = readObject(
    slices['releaseHighlights.dialog'],
  );
  if (releaseHighlightsDialogSlice) {
    const source = readString(releaseHighlightsDialogSlice.source);
    const version = readString(releaseHighlightsDialogSlice.version);
    // Only the release identity travels; highlight copy never does.
    if ((source === 'automatic' || source === 'manual') && version) {
      snapshot.releaseHighlights = {
        dialog: {
          open: readBoolean(releaseHighlightsDialogSlice.open) ?? false,
          source,
          version: version.slice(0, 64),
        },
      };
    }
  }
  const splitWorkspaceModalSlice = readObject(
    slices['worktree.splitWorkspaceModal'],
  );
  if (splitWorkspaceModalSlice) {
    const workspaceId = readString(splitWorkspaceModalSlice.workspaceId);
    const worktreeId = readString(splitWorkspaceModalSlice.worktreeId);
    const rootSelection = readString(splitWorkspaceModalSlice.rootSelection);
    snapshot.splitWorkspaceModal = {
      open: readBoolean(splitWorkspaceModalSlice.open) ?? false,
      ...(workspaceId ? { workspaceId } : {}),
      ...(worktreeId ? { worktreeId } : {}),
      repoCount: readNumber(splitWorkspaceModalSlice.repoCount) ?? 0,
      splitCount: readNumber(splitWorkspaceModalSlice.splitCount) ?? 0,
      archiveCount: readNumber(splitWorkspaceModalSlice.archiveCount) ?? 0,
      deleteCount: readNumber(splitWorkspaceModalSlice.deleteCount) ?? 0,
      rootRowVisible:
        readBoolean(splitWorkspaceModalSlice.rootRowVisible) ?? false,
      ...(rootSelection === 'archive' || rootSelection === 'delete'
        ? { rootSelection }
        : {}),
      destinationsLoaded:
        readBoolean(splitWorkspaceModalSlice.destinationsLoaded) ?? false,
      errorVisible: readBoolean(splitWorkspaceModalSlice.errorVisible) ?? false,
    };
  }
  const targetUpdateSlice = readObject(slices['settings.targetUpdate']);
  if (targetUpdateSlice) {
    const selectedVersionRelation = readString(
      targetUpdateSlice.selectedVersionRelation,
    );
    const selectedVersionTag = readString(targetUpdateSlice.selectedVersionTag);
    const versionSearch = readString(targetUpdateSlice.versionSearch);
    const versionCount = readNumber(targetUpdateSlice.versionCount);
    snapshot.settings = {
      open: nav.settingsOpen,
      section: nav.settingsInitialSection,
      targetUpdate: {
        versionPickerOpen:
          readBoolean(targetUpdateSlice.versionPickerOpen) ?? false,
        downgradeConfirmationOpen:
          readBoolean(targetUpdateSlice.downgradeConfirmationOpen) ?? false,
        ...(versionSearch ? { versionSearch } : {}),
        ...(versionCount !== null ? { versionCount } : {}),
        ...(typeof targetUpdateSlice.hasMoreVersions === 'boolean'
          ? { hasMoreVersions: targetUpdateSlice.hasMoreVersions }
          : {}),
        ...(typeof targetUpdateSlice.loading === 'boolean'
          ? { loading: targetUpdateSlice.loading }
          : {}),
        ...(typeof targetUpdateSlice.pending === 'boolean'
          ? { pending: targetUpdateSlice.pending }
          : {}),
        ...(typeof targetUpdateSlice.errorVisible === 'boolean'
          ? { errorVisible: targetUpdateSlice.errorVisible }
          : {}),
        ...(selectedVersionTag ? { selectedVersionTag } : {}),
        ...(selectedVersionRelation === 'upgrade' ||
        selectedVersionRelation === 'current' ||
        selectedVersionRelation === 'downgrade'
          ? { selectedVersionRelation }
          : {}),
      },
    };
  }
  const chatHarnessPickers = Object.entries(slices)
    .flatMap(([key, value]) => {
      if (!key.startsWith('chat.harnessPicker.')) return [];
      const picker = readObject(value);
      const pickerId = readString(picker?.pickerId);
      // Composers can stay mounted behind another page. Report the same live
      // availability predicate the action dispatcher uses, never hidden ids.
      if (!pickerId || !isChatHarnessActionAvailable(pickerId)) return [];
      const model = readString(picker?.model);
      const harness = readString(picker?.harness);
      const choices = picker?.availableHarnesses;
      const availableHarnesses = Array.isArray(choices)
        ? choices.filter(
            (item): item is string =>
              item === 'claude' || item === 'codex' || item === 'cursor',
          )
        : [];
      return pickerId && model && harness && availableHarnesses.length > 1
        ? [{ pickerId, model, harness, availableHarnesses }]
        : [];
    })
    .slice(0, 5);
  if (chatHarnessPickers.length)
    snapshot.chatHarnessPickers = chatHarnessPickers;
  const cursor = readObject(slices['settings.cursor']);
  if (cursor) {
    const phase = readString(cursor.phase);
    snapshot.settings = {
      ...(snapshot.settings ?? {
        open: nav.settingsOpen,
        section: nav.settingsInitialSection,
      }),
      cursor: {
        loaded: readBoolean(cursor.loaded) ?? false,
        supported: readBoolean(cursor.supported) ?? false,
        enabled: readBoolean(cursor.enabled) ?? false,
        installed: readBoolean(cursor.installed) ?? false,
        busy: readBoolean(cursor.busy) ?? false,
        ...(phase &&
        [
          'idle',
          'downloading',
          'verifying',
          'installing',
          'signing-out',
          'signing-in',
          'connected',
        ].includes(phase)
          ? { phase }
          : {}),
        // Present only once the panel has read the sign-in; the email is the
        // account identity, never a credential.
        ...(typeof cursor.signedIn === 'boolean'
          ? {
              signedIn: cursor.signedIn,
              // Third-party CLI stdout reaches every Advisor prompt from here;
              // bound it like every other identity field in this snapshot.
              account: (readString(cursor.account) ?? '').slice(0, 254),
            }
          : {}),
        errorVisible: readBoolean(cursor.errorVisible) ?? false,
      },
    };
  }
  const cursorCheck = readObject(slices['settings.cursorApprovalCheck']);
  if (cursorCheck) {
    const outcome = readString(cursorCheck.outcome);
    snapshot.settings = {
      ...(snapshot.settings ?? { open: nav.settingsOpen }),
      cursorApprovalCheck: {
        available: readBoolean(cursorCheck.available) ?? false,
        configured: readBoolean(cursorCheck.configured) ?? false,
        running: readBoolean(cursorCheck.running) ?? false,
        awaitingApproval: readBoolean(cursorCheck.awaitingApproval) ?? false,
        ...(outcome &&
        ['allowed', 'denied', 'cancelled', 'error'].includes(outcome)
          ? { outcome }
          : {}),
        errorVisible: readBoolean(cursorCheck.errorVisible) ?? false,
      },
    };
  }
  const ollamaSettingsSlice = readObject(slices['settings.ollama']);
  if (ollamaSettingsSlice) {
    const mode = readString(ollamaSettingsSlice.mode);
    const status = readString(ollamaSettingsSlice.status);
    const installationSource = readString(
      ollamaSettingsSlice.installationSource,
    );
    const installationVersion = readString(
      ollamaSettingsSlice.installationVersion,
    );
    const installPhase = readString(ollamaSettingsSlice.installPhase);
    const settings = snapshot.settings ?? {
      open: nav.settingsOpen,
      section: nav.settingsInitialSection,
    };
    snapshot.settings = {
      ...settings,
      ollama: {
        loaded: readBoolean(ollamaSettingsSlice.loaded) ?? false,
        installationReady:
          readBoolean(ollamaSettingsSlice.installationReady) ?? false,
        automaticInstallSupported:
          readBoolean(ollamaSettingsSlice.automaticInstallSupported) ?? false,
        installing: readBoolean(ollamaSettingsSlice.installing) ?? false,
        errorVisible: readBoolean(ollamaSettingsSlice.errorVisible) ?? false,
        ...(mode === 'managed' || mode === 'manual' ? { mode } : {}),
        ...(status === 'stopped' ||
        status === 'starting' ||
        status === 'running-managed' ||
        status === 'running-external' ||
        status === 'error'
          ? { status }
          : {}),
        ...(installationSource === 'persisted' ||
        installationSource === 'environment' ||
        installationSource === 'auto-detected' ||
        installationSource === 'browse' ||
        installationSource === 'installed' ||
        installationSource === 'not-found'
          ? { installationSource }
          : {}),
        ...(installationVersion ? { installationVersion } : {}),
        ...(installPhase === 'starting' ||
        installPhase === 'downloading' ||
        installPhase === 'verifying' ||
        installPhase === 'installing' ||
        installPhase === 'detecting' ||
        installPhase === 'success' ||
        installPhase === 'failure'
          ? { installPhase }
          : {}),
      },
    };
  }

  const localMemorySlice = readObject(slices['settings.localMemory']);
  if (localMemorySlice) {
    const settings = snapshot.settings ?? {
      open: nav.settingsOpen,
      section: nav.settingsInitialSection,
    };
    snapshot.settings = {
      ...settings,
      localMemory: {
        loaded: readBoolean(localMemorySlice.loaded) ?? false,
        enabled: readBoolean(localMemorySlice.enabled) ?? false,
      },
    };
  }

  const memorySync = readMemorySyncSettingsState(
    slices[MEMORY_SYNC_SETTINGS_UI_STATE_KEY],
  );
  if (memorySync !== undefined) {
    snapshot.settings = {
      ...(snapshot.settings ?? {
        open: nav.settingsOpen,
        section: nav.settingsInitialSection,
      }),
      memorySync,
    };
  }
  const memorySyncView = readMemorySyncViewState(slices);
  if (memorySyncView !== undefined) snapshot.memorySyncView = memorySyncView;

  const managedDelegationSlice = readObject(
    slices['settings.managedDelegation'],
  );
  if (managedDelegationSlice) {
    const mode = readString(managedDelegationSlice.mode);
    if (isManagedDelegationMode(mode)) {
      const settings = snapshot.settings ?? {
        open: nav.settingsOpen,
        section: nav.settingsInitialSection,
      };
      snapshot.settings = {
        ...settings,
        managedDelegation: {
          loaded: readBoolean(managedDelegationSlice.loaded) ?? false,
          mode,
          maxDepth: normalizeManagedDelegationMaxDepth(
            readNumber(managedDelegationSlice.maxDepth),
          ),
          ...(readNumber(managedDelegationSlice.lifetimeLimit) === null
            ? {}
            : {
                lifetimeLimit: normalizeManagedDelegationLifetimeLimit(
                  readNumber(managedDelegationSlice.lifetimeLimit),
                ),
              }),
          revocationIncomplete:
            readBoolean(managedDelegationSlice.revocationIncomplete) ?? false,
        },
      };
    }
  }

  const profileRoleSlice = readObject(slices['settings.profileRole']);
  if (profileRoleSlice) {
    const settings = snapshot.settings ?? {
      open: nav.settingsOpen,
      section: nav.settingsInitialSection,
    };
    snapshot.settings = {
      ...settings,
      profileRole: {
        loaded: readBoolean(profileRoleSlice.loaded) ?? false,
        role: readString(profileRoleSlice.role) ?? null,
      },
    };
  }

  // Customize reports only while its MCP surface shows; Settings hides it.
  const mcpAccounts =
    nav.activePage === 'plugins' &&
    !nav.settingsOpen &&
    !useSidebarPageHandoffStore.getState().coversMainShell
      ? readObject(slices['mcp.accountConnections.plugins'])
      : undefined;
  if (mcpAccounts) {
    const rows: NonNullable<
      AppAdvisorUiStateSnapshot['mcpAccountConnections']
    >['rows'] = [];
    if (Array.isArray(mcpAccounts.rows)) {
      for (const value of mcpAccounts.rows.slice(0, 50)) {
        const row = readObject(value);
        const id = readString(row?.id);
        if (!id) continue;
        const serverKey = readString(row?.serverKey);
        const status = readString(row?.status);
        rows.push({
          id: id.slice(0, 256),
          ...(serverKey ? { serverKey: serverKey.slice(0, 256) } : {}),
          ...(status ? { status: status.slice(0, 32) } : {}),
        });
      }
    }
    snapshot.mcpAccountConnections = {
      available: readBoolean(mcpAccounts.available) ?? false,
      loading: readBoolean(mcpAccounts.loading) ?? false,
      setupOpen: readBoolean(mcpAccounts.setupOpen) ?? false,
      detailsOpen: readBoolean(mcpAccounts.detailsOpen) ?? false,
      ...((): { detailsRowId?: string } => {
        const detailsRowId = readString(mcpAccounts.detailsRowId);
        return detailsRowId ? { detailsRowId: detailsRowId.slice(0, 256) } : {};
      })(),
      ...(readBoolean(mcpAccounts.promoteDialogOpen) === true
        ? { promoteDialogOpen: true }
        : {}),
      pendingCount: readNumber(mcpAccounts.pendingCount) ?? 0,
      rows,
    };
  }

  const mcpServerEditor = readObject(slices['mcp.serverEditor']);
  const mcpEditorMode = readString(mcpServerEditor?.mode);
  const readMcpScope = (
    value: AppAdvisorJson | undefined,
  ): 'device' | 'cloud' | undefined => {
    const scope = readString(value);
    return scope === 'device' || scope === 'cloud' ? scope : undefined;
  };
  const mcpEditorScope = readMcpScope(mcpServerEditor?.scope);
  const mcpEditorInitialScope = readMcpScope(mcpServerEditor?.initialScope);
  if (
    mcpServerEditor &&
    (mcpEditorMode === 'create' || mcpEditorMode === 'edit') &&
    mcpEditorScope &&
    mcpEditorInitialScope
  ) {
    const serverId = readString(mcpServerEditor.serverId);
    snapshot.mcpServerEditor = {
      mode: mcpEditorMode,
      ...(serverId ? { serverId: serverId.slice(0, 256) } : {}),
      cloudOnly: readBoolean(mcpServerEditor.cloudOnly) ?? false,
      scopeAvailable: readBoolean(mcpServerEditor.scopeAvailable) ?? false,
      scope: mcpEditorScope,
      initialScope: mcpEditorInitialScope,
      moveToDeviceDialogOpen:
        readBoolean(mcpServerEditor.moveToDeviceDialogOpen) ?? false,
      ...(readBoolean(mcpServerEditor.moveToCloudDialogOpen) === true
        ? { moveToCloudDialogOpen: true }
        : {}),
      ...(readBoolean(mcpServerEditor.moveDropsStoredHeaders) === true
        ? { moveDropsStoredHeaders: true }
        : {}),
      ...(readBoolean(mcpServerEditor.moveWithoutStoredHeaders) === true
        ? { moveWithoutStoredHeaders: true }
        : {}),
      deleteConfirmOpen:
        readBoolean(mcpServerEditor.deleteConfirmOpen) ?? false,
      saving: readBoolean(mcpServerEditor.saving) ?? false,
      errorVisible: readBoolean(mcpServerEditor.errorVisible) ?? false,
    };
  }

  const navigationModeSlice = readObject(slices['settings.navigationMode']);
  if (navigationModeSlice) {
    const settings = snapshot.settings ?? {
      open: nav.settingsOpen,
      section: nav.settingsInitialSection,
    };
    snapshot.settings = {
      ...settings,
      navigationMode: {
        loaded: readBoolean(navigationModeSlice.loaded) ?? false,
        mode: readString(navigationModeSlice.mode) ?? null,
      },
    };
  }

  const personalCatalog = readObject(slices['settings.personalCatalog']);
  if (personalCatalog) {
    const notice = personalCatalog.notice;
    snapshot.settings = {
      ...(snapshot.settings ?? {
        open: nav.settingsOpen,
        section: nav.settingsInitialSection,
      }),
      personalCatalog: {
        loaded: readBoolean(personalCatalog.loaded) ?? false,
        enabled: readBoolean(personalCatalog.enabled) ?? false,
        signedIn: readBoolean(personalCatalog.signedIn) ?? false,
        pending: readBoolean(personalCatalog.pending) ?? false,
        notice:
          notice === 'collision' ||
          notice === 'removed' ||
          notice === 'full' ||
          notice === 'failed'
            ? notice
            : null,
        error: readBoolean(personalCatalog.error) ?? false,
      },
    };
  }

  const globalFocusShortcutSlice = readObject(
    slices['settings.globalFocusShortcut'],
  );
  if (globalFocusShortcutSlice) {
    const settings = snapshot.settings ?? {
      open: nav.settingsOpen,
      section: nav.settingsInitialSection,
    };
    snapshot.settings = {
      ...settings,
      globalFocusShortcut: {
        loaded: readBoolean(globalFocusShortcutSlice.loaded) ?? false,
        enabled: readBoolean(globalFocusShortcutSlice.enabled) ?? false,
        shortcut: readString(globalFocusShortcutSlice.shortcut) ?? null,
        registered: readBoolean(globalFocusShortcutSlice.registered) ?? false,
        recording: readBoolean(globalFocusShortcutSlice.recording) ?? false,
      },
    };
  }

  const launchAtLoginSlice = readObject(slices['settings.launchAtLogin']);
  if (launchAtLoginSlice) {
    const settings = snapshot.settings ?? {
      open: nav.settingsOpen,
      section: nav.settingsInitialSection,
    };
    const unsupportedReason = launchAtLoginSlice.unsupportedReason;
    const error = launchAtLoginSlice.error;
    snapshot.settings = {
      ...settings,
      launchAtLogin: {
        loaded: readBoolean(launchAtLoginSlice.loaded) ?? false,
        supported: readBoolean(launchAtLoginSlice.supported) ?? false,
        unsupportedReason:
          unsupportedReason === 'platform' ||
          unsupportedReason === 'development-build'
            ? unsupportedReason
            : null,
        enabled: readBoolean(launchAtLoginSlice.enabled) ?? false,
        pendingApproval:
          readBoolean(launchAtLoginSlice.pendingApproval) ?? false,
        busy: readBoolean(launchAtLoginSlice.busy) ?? false,
        error: error === 'refused' || error === 'failed' ? error : null,
      },
    };
  }

  const codeGraphSlice = readObject(slices['settings.codeGraph']);
  if (codeGraphSlice) {
    const mode = readString(codeGraphSlice.mode);
    const selectedWorkspaceIds = Array.isArray(
      codeGraphSlice.selectedWorkspaceIds,
    )
      ? codeGraphSlice.selectedWorkspaceIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const generationTimeoutMinutes = readNumber(
      codeGraphSlice.generationTimeoutMinutes,
    );
    const timeoutDraftMinutes = readNumber(codeGraphSlice.timeoutDraftMinutes);
    if (
      (mode === 'enabled' ||
        mode === 'disabled' ||
        mode === 'selected-workspaces') &&
      generationTimeoutMinutes !== null
    ) {
      snapshot.settings = {
        open: nav.settingsOpen,
        section: nav.settingsInitialSection,
        ...snapshot.settings,
        codeGraph: {
          loaded: readBoolean(codeGraphSlice.loaded) ?? false,
          mode,
          selectedWorkspaceIds,
          generationTimeoutMinutes,
          ...(timeoutDraftMinutes !== null ? { timeoutDraftMinutes } : {}),
          saving: readBoolean(codeGraphSlice.saving) ?? false,
          saveErrorVisible:
            readBoolean(codeGraphSlice.saveErrorVisible) ?? false,
          timeoutErrorVisible:
            readBoolean(codeGraphSlice.timeoutErrorVisible) ?? false,
        },
      };
    }
  }

  const appAdvisorProjectAgentAccessSlice = readObject(
    slices['settings.appAdvisorProjectAgentAccess'],
  );
  if (appAdvisorProjectAgentAccessSlice) {
    const mode = readString(appAdvisorProjectAgentAccessSlice.mode);
    if (
      mode === 'enabled' ||
      mode === 'selected-owners' ||
      mode === 'disabled'
    ) {
      const selectedOwners: ProjectOwnerContext[] = [];
      const ownerCandidates = appAdvisorProjectAgentAccessSlice.selectedOwners;
      if (Array.isArray(ownerCandidates)) {
        for (const candidate of ownerCandidates) {
          const owner = readObject(candidate);
          const kind = readString(owner?.kind);
          if (kind === 'personal') {
            selectedOwners.push({ kind: 'personal' });
            continue;
          }
          if (kind !== 'organization') continue;
          const organizationId = owner?.organizationId;
          if (
            typeof organizationId !== 'string' ||
            organizationId.trim().length === 0
          ) {
            continue;
          }
          selectedOwners.push({ kind: 'organization', organizationId });
        }
      }

      snapshot.settings = {
        open: nav.settingsOpen,
        section: nav.settingsInitialSection,
        ...snapshot.settings,
        appAdvisorProjectAgentAccess: {
          loaded:
            readBoolean(appAdvisorProjectAgentAccessSlice.loaded) ?? false,
          mode,
          selectedOwners,
          saving:
            readBoolean(appAdvisorProjectAgentAccessSlice.saving) ?? false,
          saveErrorVisible:
            readBoolean(appAdvisorProjectAgentAccessSlice.saveErrorVisible) ??
            false,
        },
      };
    }
  }

  const cloudChatOpen = readObject(slices['cloudChat.open']);
  const cloudChatId = readString(cloudChatOpen?.chatId);
  const cloudProjectId = readString(cloudChatOpen?.projectId);
  if (cloudChatId && cloudProjectId)
    snapshot.cloudChat = {
      open: {
        chatId: cloudChatId,
        projectId: cloudProjectId,
        title: readString(cloudChatOpen?.title) ?? '',
      },
    };

  const homeSurface = readObject(slices['home.surface']);
  const homeControls = readObject(slices['home.controls']);
  const homeToolbar = readObject(slices['home.toolbar']);
  const homeInterruptedBanner = readObject(
    slices['home.interruptedSessionsBanner'],
  );
  const homeMcpSignIn = readObject(slices['home.mcpSignIn']);
  const homeContinueAttention = readObject(slices['home.continueAttention']);
  if (homeSurface || homeControls || homeToolbar) {
    const mode = readString(homeSurface?.mode);
    const targetKind = readString(homeSurface?.targetKind);
    const workspaceType = readString(homeSurface?.workspaceType);
    const variant = readString(homeSurface?.variant);
    const startupResumeOfferKind = readString(
      homeSurface?.startupResumeOfferKind,
    );
    const attachmentCount = readNumber(homeSurface?.attachmentCount);
    const fileReferenceCount = readNumber(homeSurface?.fileReferenceCount);
    const prNumber = readNumber(homeSurface?.prNumber);
    const issueIdentifier = readString(homeSurface?.issueIdentifier);
    const homeHarness = readString(homeControls?.executionHarness);
    snapshot.home = {
      ...(homeHarness === 'claude' ||
      homeHarness === 'codex' ||
      homeHarness === 'cursor'
        ? { executionHarness: homeHarness }
        : {}),
      workspaceSelected:
        readBoolean(homeSurface?.workspaceSelected) ?? Boolean(homeSurface),
      scheduledDraft: readBoolean(homeSurface?.scheduledDraft) ?? false,
      pluginSelectionsActive:
        readBoolean(homeSurface?.pluginSelectionsActive) ?? false,
      discoveryLoading: readBoolean(homeSurface?.discoveryLoading) ?? false,
      fileIndexLoading: readBoolean(homeSurface?.fileIndexLoading) ?? false,
      sendErrorVisible: readBoolean(homeSurface?.sendErrorVisible) ?? false,
      inlineSlashMenuOpen:
        readBoolean(homeSurface?.inlineSlashMenuOpen) ?? false,
      startupResumeOfferVisible:
        readBoolean(homeSurface?.startupResumeOfferVisible) ?? false,
      ...(startupResumeOfferKind === 'worktree' ||
      startupResumeOfferKind === 'cowork'
        ? { startupResumeOfferKind }
        : {}),
      interruptedSessionsBannerVisible:
        readBoolean(homeInterruptedBanner?.visible) ?? false,
      ...((): { interruptedSessionCount?: number } => {
        const count = readNumber(homeInterruptedBanner?.count);
        return count !== null && count > 0
          ? { interruptedSessionCount: count }
          : {};
      })(),
      ...((): {
        interruptedSessionReadyCount?: number;
        interruptedSessionWaitingCount?: number;
      } => {
        const count = readNumber(homeInterruptedBanner?.count);
        const ready = readNumber(homeInterruptedBanner?.readyCount);
        const waiting = readNumber(homeInterruptedBanner?.waitingCount);
        return count !== null && count > 0 && ready !== null && waiting !== null
          ? {
              interruptedSessionReadyCount: ready,
              interruptedSessionWaitingCount: waiting,
            }
          : {};
      })(),
      ...(homeContinueAttention
        ? {
            continueAttention: {
              questionCount:
                readNumber(homeContinueAttention.questionCount) ?? 0,
              toolApprovalCount:
                readNumber(homeContinueAttention.toolApprovalCount) ?? 0,
              planReviewCount:
                readNumber(homeContinueAttention.planReviewCount) ?? 0,
              unreadCount: readNumber(homeContinueAttention.unreadCount) ?? 0,
              lastViewedVisible:
                readBoolean(homeContinueAttention.lastViewedVisible) ?? false,
            },
          }
        : {}),
      plusMenuOpen: readBoolean(homeToolbar?.plusMenuOpen) ?? false,
      scheduleModalOpen: readBoolean(homeControls?.scheduleModalOpen) ?? false,
      linearPickerOpen: readBoolean(homeControls?.linearPickerOpen) ?? false,
      scheduleDisabledByCursor:
        readBoolean(homeControls?.scheduleDisabledByCursor) ?? false,
      scheduleDisabledByAttachments:
        readBoolean(homeControls?.scheduleDisabledByAttachments) ?? false,
      ...readHomeMcpSignIn(homeMcpSignIn),
      ...(variant === 'page' || variant === 'embedded' ? { variant } : {}),
      ...(mode === 'chat' || mode === 'pipeline' ? { mode } : {}),
      ...(targetKind === 'new-worktree' ||
      targetKind === 'worktree' ||
      targetKind === 'branch' ||
      targetKind === 'pr' ||
      targetKind === 'linear-issue' ||
      targetKind === 'cowork'
        ? { targetKind }
        : {}),
      ...(workspaceType === 'single-repo' ||
      workspaceType === 'multi-repo' ||
      workspaceType === 'cowork'
        ? { workspaceType }
        : {}),
      ...(readString(homeSurface?.workspaceId)
        ? { workspaceId: readString(homeSurface?.workspaceId) }
        : {}),
      ...(readString(homeSurface?.workspaceName)
        ? { workspaceName: readString(homeSurface?.workspaceName) }
        : {}),
      ...(readString(homeSurface?.branchName)
        ? { branchName: readString(homeSurface?.branchName) }
        : {}),
      ...(readString(homeSurface?.worktreeId)
        ? { worktreeId: readString(homeSurface?.worktreeId) }
        : {}),
      ...(prNumber !== null ? { prNumber } : {}),
      ...(issueIdentifier ? { issueIdentifier } : {}),
      ...(attachmentCount !== null ? { attachmentCount } : {}),
      ...(fileReferenceCount !== null ? { fileReferenceCount } : {}),
    };
  }

  // -- Selected worktree (sanitized: ids, repo id, and display names only).
  if (chat.selectedWorktree) {
    const reporter = readObject(slices['app.selectedWorktree']);
    const selectedWorktreeChat =
      chat.worktreeChats[
        `${chat.selectedWorktree.projectId}/${chat.selectedWorktree.worktreeId}`
      ];
    const selectedTab = selectedWorktreeChat?.tabs.find(
      (candidate) => candidate.id === selectedWorktreeChat.activeTabId,
    );
    const project = projects.projects.find(
      (item) => item.id === chat.selectedWorktree?.projectId,
    );
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find(
            (item) => item.id === chat.selectedWorktree?.worktreeId,
          )
        : undefined;
    const repoId = readString(reporter?.repoId);
    const selectedRepoId = repoId ?? selectedTab?.selectedRepoId;
    const workspaceDisplayName = project
      ? getWorkspaceDisplayName(project)
      : undefined;
    const workspaceRepoCount = countWorkspaceRepos(project);
    const projectName =
      readString(reporter?.projectName) ??
      workspaceDisplayName ??
      project?.name;
    const worktreeName =
      readString(reporter?.worktreeName) ?? worktree?.branchName;
    snapshot.selectedWorktree = {
      projectId: chat.selectedWorktree.projectId,
      worktreeId: chat.selectedWorktree.worktreeId,
      ...(selectedRepoId ? { repoId: selectedRepoId } : {}),
      ...(projectName ? { projectName } : {}),
      ...(workspaceDisplayName
        ? { workspaceDisplayName: workspaceDisplayName }
        : {}),
      ...(project ? { workspaceType: project.type } : {}),
      ...(project?.type === 'multi-repo'
        ? { workspaceTemporary: project.temporary === true }
        : {}),
      ...(workspaceRepoCount > 0 ? { workspaceRepoCount } : {}),
      ...(worktreeName ? { worktreeName } : {}),
    };
  }

  const fileTreeSearchSlice = readObject(slices['files.treeSearch']);
  if (fileTreeSearchSlice) {
    const projectId = readString(fileTreeSearchSlice.projectId);
    const worktreeId = readString(fileTreeSearchSlice.worktreeId);
    if (projectId && worktreeId) {
      snapshot.fileTreeSearch = {
        projectId,
        worktreeId,
        open: readBoolean(fileTreeSearchSlice.open) ?? false,
        filtering: readBoolean(fileTreeSearchSlice.filtering) ?? false,
      };
    }
  }

  const importProjectsModalSlice = readObject(
    slices['chat.importProjectsModal'],
  );
  if (importProjectsModalSlice) {
    const phase = readString(importProjectsModalSlice.phase);
    snapshot.importProjectsModal = {
      open: readBoolean(importProjectsModalSlice.open) ?? false,
      ...(phase ? { phase } : {}),
    };
  }
  // Only the entry point is reported: rule paths, rule text, and the
  // reviewed project never reach the snapshot.
  const repoRulesModalSlice = readObject(slices['chat.repoRulesModal']);
  if (repoRulesModalSlice) {
    const source = readString(repoRulesModalSlice.source);
    snapshot.repoRulesModal = {
      open: readBoolean(repoRulesModalSlice.open) ?? false,
      ...(source && isRepoRulesModalSource(source) ? { source } : {}),
    };
  }
  const importSessionModalSlice = readObject(slices['chat.importSessionModal']);
  if (importSessionModalSlice) {
    const workspaceId = readString(importSessionModalSlice.workspaceId);
    snapshot.importSessionModal = {
      open: readBoolean(importSessionModalSlice.open) ?? false,
      ...(workspaceId ? { workspaceId } : {}),
    };
  }

  const baseBranchChangeConfirmationModalSlice = readObject(
    slices['worktree.baseBranchChangeConfirmationModal'],
  );
  if (baseBranchChangeConfirmationModalSlice) {
    const projectId = readString(
      baseBranchChangeConfirmationModalSlice.projectId,
    );
    const worktreeId = readString(
      baseBranchChangeConfirmationModalSlice.worktreeId,
    );
    const repoId = readString(baseBranchChangeConfirmationModalSlice.repoId);
    const baseBranch = readString(
      baseBranchChangeConfirmationModalSlice.baseBranch,
    );
    const prNumber = readNumber(
      baseBranchChangeConfirmationModalSlice.prNumber,
    );
    snapshot.baseBranchChangeConfirmationModal = {
      open: readBoolean(baseBranchChangeConfirmationModalSlice.open) ?? false,
      ...(projectId ? { projectId } : {}),
      ...(worktreeId ? { worktreeId } : {}),
      ...(repoId ? { repoId } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(prNumber !== null
        ? { prNumber: Math.max(0, Math.trunc(prNumber)) }
        : {}),
    };
  }

  const exportSessionConfirmationModalSlice = readObject(
    slices['chat.exportSessionConfirmationModal'],
  );
  if (exportSessionConfirmationModalSlice) {
    snapshot.exportSessionConfirmationModal = {
      open: readBoolean(exportSessionConfirmationModalSlice.open) ?? false,
    };
  }

  const shareSessionStatusModalSlice = readObject(
    slices['chat.shareSessionStatusModal'],
  );
  if (shareSessionStatusModalSlice) {
    const phase = readString(shareSessionStatusModalSlice.phase);
    snapshot.shareSessionStatusModal = {
      open: readBoolean(shareSessionStatusModalSlice.open) ?? false,
      ...(phase === 'sharing' || phase === 'success' || phase === 'error'
        ? { phase }
        : {}),
    };
  }

  const memoryUsedDialogSlice = readObject(slices['chat.memoryUsedDialog']);
  if (memoryUsedDialogSlice) {
    snapshot.memoryUsedDialog = {
      open: readBoolean(memoryUsedDialogSlice.open) ?? false,
      factCount: Math.max(
        0,
        Math.trunc(readNumber(memoryUsedDialogSlice.factCount) ?? 0),
      ),
    };
  }

  // Privacy opt-in review sheet (CAN-3383): feature, organization, and state.
  const privacyOptInSlice = readObject(slices.privacyOptIn);
  const privacyOptInFeature = privacyOptInSlice?.feature;
  const privacyOptInOrganizationId = readString(
    privacyOptInSlice?.organizationId,
  );
  const privacyOptInState = privacyOptInSlice?.state;
  if (
    privacyOptInSlice &&
    isDataSharingOptInFeature(privacyOptInFeature) &&
    privacyOptInOrganizationId &&
    (privacyOptInState === 'loading' ||
      privacyOptInState === 'needs-opt-in' ||
      privacyOptInState === 'saving' ||
      privacyOptInState === 'saved' ||
      privacyOptInState === 'error' ||
      privacyOptInState === 'shared' ||
      privacyOptInState === 'managed' ||
      privacyOptInState === 'unavailable')
  ) {
    snapshot.privacyOptIn = {
      open: true,
      feature: privacyOptInFeature,
      organizationId: privacyOptInOrganizationId,
      state: privacyOptInState,
      queued: readNumber(privacyOptInSlice.queued) ?? 0,
    };
  }

  // Shared containers "Share" modal (CAN-2546). Identifiers,
  // counts, and the container display name only — member search text and the
  // approved file scope stay out of the provider boundary.
  const sharedContainersInviteModalSlice = readObject(
    slices['sharedContainers.inviteModal'],
  );
  if (sharedContainersInviteModalSlice) {
    const inviteProjectId = readString(
      sharedContainersInviteModalSlice.projectId,
    );
    const inviteWorktreeId = readString(
      sharedContainersInviteModalSlice.worktreeId,
    );
    const inviteContainerType = readString(
      sharedContainersInviteModalSlice.containerType,
    );
    const inviteContainerName = readString(
      sharedContainersInviteModalSlice.containerName,
    );
    const inviteOrganizationId = readString(
      sharedContainersInviteModalSlice.organizationId,
    );
    const inviteStatus = readString(sharedContainersInviteModalSlice.status);
    const inviteCommitted = readBoolean(
      sharedContainersInviteModalSlice.committed,
    );
    const inviteBlockedReason = readString(
      sharedContainersInviteModalSlice.blockedReason,
    );
    const inviteContainerId = readString(
      sharedContainersInviteModalSlice.containerId,
    );
    const inviteRecipientCount = readNumber(
      sharedContainersInviteModalSlice.recipientCount,
    );
    const inviteAudience = readString(
      sharedContainersInviteModalSlice.audience,
    );
    const inviteAvailableAudiences = Array.isArray(
      sharedContainersInviteModalSlice.availableAudiences,
    )
      ? sharedContainersInviteModalSlice.availableAudiences.flatMap(
          (value): SharedContainerInviteAudience[] =>
            value === 'team' || value === 'organization' || value === 'public'
              ? [value]
              : [],
        )
      : [];
    type InviteRecipientSnapshot = NonNullable<
      NonNullable<
        AppAdvisorUiStateSnapshot['sharedContainersInviteModal']
      >['recipients']
    >[number];
    const inviteRecipients = Array.isArray(
      sharedContainersInviteModalSlice.recipients,
    )
      ? sharedContainersInviteModalSlice.recipients
          .slice(0, 50)
          .flatMap((value): InviteRecipientSnapshot[] => {
            const recipient = readObject(value);
            if (!recipient) return [];
            const grantId = readString(recipient.grantId)?.slice(0, 128);
            // Email recipients cross only as a grant id and a status: the
            // address itself stays out of the provider boundary.
            if (readString(recipient.kind) === 'email') {
              return grantId
                ? [{ grantId, kind: 'email', status: 'invited' }]
                : [];
            }
            // A member is identified by user id; its grant id stays out.
            const userId = readString(recipient.userId)?.slice(0, 128) ?? '';
            const name = readString(recipient.name)?.slice(0, 200) ?? '';
            if (!userId || !name) return [];
            return [{ userId, name }];
          })
      : [];
    const inviteSelectedRecipientUserId = readString(
      sharedContainersInviteModalSlice.selectedRecipientUserId,
    );
    // Two facts about the layout only; the approved scope stays out.
    const invitePreferredLayoutEnabled = readBoolean(
      sharedContainersInviteModalSlice.preferredLayoutEnabled,
    );
    const invitePreferredLayoutPinnedAt = readString(
      sharedContainersInviteModalSlice.preferredLayoutPinnedAt,
    )?.slice(0, 64);
    snapshot.sharedContainersInviteModal = {
      open: readBoolean(sharedContainersInviteModalSlice.open) ?? false,
      ...(inviteProjectId ? { projectId: inviteProjectId } : {}),
      ...(inviteWorktreeId ? { worktreeId: inviteWorktreeId } : {}),
      ...(inviteContainerType === 'CODE_WORKTREE' ||
      inviteContainerType === 'COWORK_WORK_ENTRY'
        ? { containerType: inviteContainerType }
        : {}),
      ...(inviteContainerName ? { containerName: inviteContainerName } : {}),
      ...(inviteOrganizationId ? { organizationId: inviteOrganizationId } : {}),
      ...(inviteAudience === 'team' ||
      inviteAudience === 'organization' ||
      inviteAudience === 'public'
        ? { audience: inviteAudience }
        : {}),
      ...(inviteAvailableAudiences.length > 0
        ? { availableAudiences: inviteAvailableAudiences }
        : {}),
      ...(inviteStatus === 'idle' ||
      inviteStatus === 'sharing' ||
      inviteStatus === 'error'
        ? { status: inviteStatus }
        : {}),
      ...(inviteCommitted !== null ? { committed: inviteCommitted } : {}),
      ...(inviteBlockedReason &&
      isSharedContainerBlockedReason(inviteBlockedReason)
        ? { blockedReason: inviteBlockedReason }
        : {}),
      ...(inviteContainerId ? { containerId: inviteContainerId } : {}),
      ...(inviteRecipientCount !== null
        ? {
            recipientCount: Math.max(0, Math.trunc(inviteRecipientCount)),
          }
        : {}),
      ...(inviteRecipients.length > 0 ? { recipients: inviteRecipients } : {}),
      ...(inviteSelectedRecipientUserId
        ? { selectedRecipientUserId: inviteSelectedRecipientUserId }
        : {}),
      ...(invitePreferredLayoutEnabled !== null
        ? { preferredLayoutEnabled: invitePreferredLayoutEnabled }
        : {}),
      ...(invitePreferredLayoutPinnedAt
        ? { preferredLayoutPinnedAt: invitePreferredLayoutPinnedAt }
        : {}),
    };
  }

  // Shared-container recipient surface (CAN-2550). Identifiers, the
  // low-sensitivity list title, replica status, and counts only — replica file
  // contents, paths, and transcript text never cross the provider boundary.
  const sharedContainersRecipientSlice = readObject(
    slices['sharedContainers.recipientSurface'],
  );
  if (sharedContainersRecipientSlice) {
    const recipientContainerId = readString(
      sharedContainersRecipientSlice.containerId,
    );
    const recipientOrganizationId = readString(
      sharedContainersRecipientSlice.organizationId,
    );
    const recipientContainerType = readString(
      sharedContainersRecipientSlice.containerType,
    );
    const recipientContainerTitle = readString(
      sharedContainersRecipientSlice.containerTitle,
    );
    const recipientStatus = readString(sharedContainersRecipientSlice.status);
    const recipientBlockedReason = readString(
      sharedContainersRecipientSlice.blockedReason,
    );
    const recipientWithheldFileCount = readNumber(
      sharedContainersRecipientSlice.withheldFileCount,
    );
    const recipientListedCount = readNumber(
      sharedContainersRecipientSlice.listedContainerCount,
    );
    const recipientRemovedCount = readNumber(
      sharedContainersRecipientSlice.removedShareCount,
    );
    const recipientListedContainers = Array.isArray(
      sharedContainersRecipientSlice.listedContainers,
    )
      ? sharedContainersRecipientSlice.listedContainers
          .slice(0, 50)
          .flatMap((value) => {
            const listed = readObject(value);
            if (!listed) return [];
            const containerId = readString(listed.containerId);
            const organizationId = readString(listed.organizationId);
            const access = readString(listed.access);
            const containerType = readString(listed.containerType);
            const title = readString(listed.title);
            if (
              !containerId ||
              (!organizationId && access !== 'direct') ||
              (containerType !== 'CODE_WORKTREE' &&
                containerType !== 'COWORK_WORK_ENTRY') ||
              !title
            ) {
              return [];
            }
            const normalized: SharedContainerRecipientListedUiState = {
              containerId: containerId.slice(0, 128),
              ...(organizationId
                ? { organizationId: organizationId.slice(0, 128) }
                : {}),
              ...(access === 'organization' || access === 'direct'
                ? { access }
                : {}),
              containerType,
              title: title.slice(0, 200),
            };
            return [normalized];
          })
      : [];
    snapshot.sharedContainersRecipientSurface = {
      open: readBoolean(sharedContainersRecipientSlice.open) ?? false,
      ...(recipientContainerId ? { containerId: recipientContainerId } : {}),
      ...(recipientOrganizationId
        ? { organizationId: recipientOrganizationId }
        : {}),
      ...(recipientContainerType === 'CODE_WORKTREE' ||
      recipientContainerType === 'COWORK_WORK_ENTRY'
        ? { containerType: recipientContainerType }
        : {}),
      ...(recipientContainerTitle
        ? { containerTitle: recipientContainerTitle.slice(0, 200) }
        : {}),
      ...(recipientStatus === 'loading' ||
      recipientStatus === 'nothing-published' ||
      recipientStatus === 'available' ||
      recipientStatus === 'pinned' ||
      recipientStatus === 'blocked'
        ? { status: recipientStatus }
        : {}),
      ...(recipientBlockedReason &&
      isSharedContainerAccessBlockReason(recipientBlockedReason)
        ? { blockedReason: recipientBlockedReason }
        : {}),
      ...(typeof recipientWithheldFileCount === 'number'
        ? {
            withheldFileCount: Math.max(
              0,
              Math.trunc(recipientWithheldFileCount),
            ),
          }
        : {}),
      ...(typeof recipientListedCount === 'number'
        ? {
            listedContainerCount: Math.max(0, Math.trunc(recipientListedCount)),
          }
        : {}),
      ...(recipientListedContainers.length > 0
        ? { listedContainers: recipientListedContainers }
        : {}),
      ...(sharedContainersRecipientSlice.pastSharesOpen === true
        ? { pastSharesOpen: true }
        : {}),
      ...(typeof recipientRemovedCount === 'number' && recipientRemovedCount > 0
        ? { removedShareCount: Math.trunc(recipientRemovedCount) }
        : {}),
    };
  }

  const adhocJoinModalSlice = readObject(slices['worktree.adhocJoinModal']);
  if (adhocJoinModalSlice) {
    const sourceWorkspaceId = readString(adhocJoinModalSlice.sourceWorkspaceId);
    const sourceWorktreeId = readString(adhocJoinModalSlice.sourceWorktreeId);
    const pickerMode = readString(adhocJoinModalSlice.pickerMode);
    const mode = readString(adhocJoinModalSlice.mode);
    const workspaceOptionCount = readNumber(
      adhocJoinModalSlice.workspaceOptionCount,
    );
    const selectedWorkspaceCount = readNumber(
      adhocJoinModalSlice.selectedWorkspaceCount,
    );
    const existingWorkspaceGroupCount = readNumber(
      adhocJoinModalSlice.existingWorkspaceGroupCount,
    );
    const existingCandidateCount = readNumber(
      adhocJoinModalSlice.existingCandidateCount,
    );
    const selectedExisting = readObject(adhocJoinModalSlice.selectedExisting);
    const selectedExistingWorkspaceId = readString(
      selectedExisting?.workspaceId,
    );
    const selectedExistingWorktreeId = readString(selectedExisting?.worktreeId);
    const selectedExistingWorkspaceName = readString(
      selectedExisting?.workspaceName,
    );
    const selectedExistingWorktreeName = readString(
      selectedExisting?.worktreeName,
    );
    snapshot.adhocJoinModal = {
      open: readBoolean(adhocJoinModalSlice.open) ?? false,
      ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
      ...(sourceWorktreeId ? { sourceWorktreeId } : {}),
      ...(pickerMode === 'new-worktrees' || pickerMode === 'existing-worktrees'
        ? { pickerMode }
        : {}),
      ...(mode === 'temporary' || mode === 'update-source-workspace'
        ? { mode }
        : {}),
      ...(workspaceOptionCount !== null ? { workspaceOptionCount } : {}),
      ...(selectedWorkspaceCount !== null ? { selectedWorkspaceCount } : {}),
      ...(existingWorkspaceGroupCount !== null
        ? { existingWorkspaceGroupCount }
        : {}),
      ...(existingCandidateCount !== null ? { existingCandidateCount } : {}),
      ...(selectedExistingWorkspaceId && selectedExistingWorktreeId
        ? {
            selectedExisting: {
              workspaceId: selectedExistingWorkspaceId,
              worktreeId: selectedExistingWorktreeId,
              ...(selectedExistingWorkspaceName
                ? { workspaceName: selectedExistingWorkspaceName }
                : {}),
              ...(selectedExistingWorktreeName
                ? { worktreeName: selectedExistingWorktreeName }
                : {}),
            },
          }
        : {}),
      ...(typeof adhocJoinModalSlice.loading === 'boolean'
        ? { loading: adhocJoinModalSlice.loading }
        : {}),
      ...(typeof adhocJoinModalSlice.submitting === 'boolean'
        ? { submitting: adhocJoinModalSlice.submitting }
        : {}),
      ...(typeof adhocJoinModalSlice.errorVisible === 'boolean'
        ? { errorVisible: adhocJoinModalSlice.errorVisible }
        : {}),
      ...(typeof adhocJoinModalSlice.sharedSetupVisible === 'boolean'
        ? { sharedSetupVisible: adhocJoinModalSlice.sharedSetupVisible }
        : {}),
    };
  }

  const worktreeArchiveDialogSlice = Object.entries(slices)
    .filter(([key]) => key.startsWith('worktree.archiveDialog.'))
    .map(([, value]) => readObject(value))
    .find((value) => readBoolean(value?.open) === true);
  if (worktreeArchiveDialogSlice) {
    const workspaceId = readString(worktreeArchiveDialogSlice.workspaceId);
    const worktreeId = readString(worktreeArchiveDialogSlice.worktreeId);
    const branchName = readString(worktreeArchiveDialogSlice.branchName);
    if (workspaceId && worktreeId) {
      snapshot.worktreeArchiveDialog = {
        open: true,
        workspaceId,
        worktreeId,
        ...(branchName ? { branchName } : {}),
        archiveInProgress:
          readBoolean(worktreeArchiveDialogSlice.archiveInProgress) ?? false,
        blocked: readBoolean(worktreeArchiveDialogSlice.blocked) ?? false,
      };
    }
  }

  const worktreeBatchRemovalDialog = readBatchRemovalDialogSlice(
    slices['worktree.batchRemovalDialog'],
  );
  if (worktreeBatchRemovalDialog) {
    snapshot.worktreeBatchRemovalDialog = worktreeBatchRemovalDialog;
  }

  // The main rail and the App Advisor nav report under separate keys so one
  // closing never clears the other's open dialog. An open dialog wins over
  // rows draining in the background; otherwise the main rail wins.
  const mainRailWorkEntryBatch = readBatchRemovalDialogSlice(
    slices['workEntry.batchRemovalDialog'],
  );
  const appAdvisorBatch = readBatchRemovalDialogSlice(
    slices['appAdvisor.batchRemovalDialog'],
  );
  const workEntryBatchRemovalDialog =
    mainRailWorkEntryBatch?.open !== true && appAdvisorBatch?.open === true
      ? appAdvisorBatch
      : (mainRailWorkEntryBatch ?? appAdvisorBatch);
  if (workEntryBatchRemovalDialog) {
    snapshot.workEntryBatchRemovalDialog = workEntryBatchRemovalDialog;
  }

  const codeGraphPanelSlice = readObject(slices['codeGraph.detailPanel']);
  if (codeGraphPanelSlice) {
    const scope = readString(codeGraphPanelSlice.scope);
    const workspaceId = readString(codeGraphPanelSlice.workspaceId);
    const worktreeId = readString(codeGraphPanelSlice.worktreeId);
    const phase = readString(codeGraphPanelSlice.phase);
    const state = readString(codeGraphPanelSlice.state);
    const repositoryCount = readNumber(codeGraphPanelSlice.repositoryCount);
    const snapshotState = readString(codeGraphPanelSlice.snapshotState);
    const buildState = readString(codeGraphPanelSlice.buildState);
    const readFailure = readString(codeGraphPanelSlice.readFailure);
    if (
      (scope === 'worktree' || scope === 'workspace-shadow') &&
      workspaceId &&
      (phase === 'loading' || phase === 'loaded' || phase === 'error')
    ) {
      snapshot.codeGraphPanel = {
        scope,
        workspaceId,
        ...(worktreeId ? { worktreeId } : {}),
        phase,
        ...(state === 'ready' ||
        state === 'missing' ||
        state === 'stale' ||
        state === 'error' ||
        state === 'partial'
          ? { state }
          : {}),
        ...(typeof codeGraphPanelSlice.enabled === 'boolean'
          ? { enabled: codeGraphPanelSlice.enabled }
          : {}),
        ...(snapshotState === 'missing' ||
        snapshotState === 'summary-pending' ||
        snapshotState === 'readable' ||
        snapshotState === 'read-error'
          ? { snapshotState }
          : {}),
        ...(buildState === 'idle' ||
        buildState === 'queued' ||
        buildState === 'running'
          ? { buildState }
          : {}),
        ...(readFailure === 'queue-timeout' ||
        readFailure === 'execution-timeout' ||
        readFailure === 'busy' ||
        readFailure === 'worker-exit' ||
        readFailure === 'canceled' ||
        readFailure === 'invalid-response' ||
        readFailure === 'database-error'
          ? { readFailure }
          : {}),
        building: readBoolean(codeGraphPanelSlice.building) ?? false,
        ...(repositoryCount !== null ? { repositoryCount } : {}),
        loadErrorVisible:
          readBoolean(codeGraphPanelSlice.loadErrorVisible) ?? false,
        buildErrorVisible:
          readBoolean(codeGraphPanelSlice.buildErrorVisible) ?? false,
      };
    }
  }

  // -- Pull-request activity panel (Split PR gating/progress booleans only).
  // Reported by PullRequestSection via
  // `useCurrentUiStateReporter('worktree.pullRequest', ...)`; absent when the
  // PR panel is not mounted.
  const pullRequestSlice = readObject(slices['worktree.pullRequest']);
  if (pullRequestSlice) {
    snapshot.pullRequest = {
      gitActionInProgress:
        readBoolean(pullRequestSlice.gitActionInProgress) ?? false,
      gitActionCancellationRequested:
        readBoolean(pullRequestSlice.gitActionCancellationRequested) ?? false,
      splitPrEligible: readBoolean(pullRequestSlice.splitPrEligible) ?? false,
      splitPrInProgress:
        readBoolean(pullRequestSlice.splitPrInProgress) ?? false,
      splitPrCompleted: readBoolean(pullRequestSlice.splitPrCompleted) ?? false,
      splitWorkflowActive:
        readBoolean(pullRequestSlice.splitWorkflowActive) ?? false,
      splitPrFailureModalOpen:
        readBoolean(pullRequestSlice.splitPrFailureModalOpen) ?? false,
      splitPrInterruptedModalOpen:
        readBoolean(pullRequestSlice.splitPrInterruptedModalOpen) ?? false,
      splitPrBlockers: readSplitPrBlockers(pullRequestSlice.splitPrBlockers),
    };
  }

  // -- Active chat (metadata only — *never* the transcript)
  const activeChatSlice =
    readObject(slices['chat.activeTab']) ?? buildActiveChatSlice(chat);
  if (activeChatSlice) {
    const chatId = readString(activeChatSlice.chatId);
    const title = readString(activeChatSlice.title);
    const status = readString(activeChatSlice.status);
    const approvalMode = readString(activeChatSlice.approvalMode);
    const providerType = readString(activeChatSlice.providerType);
    const executionHarness = readString(activeChatSlice.executionHarness);
    const model = readString(activeChatSlice.model);
    const interfaceMode = readString(activeChatSlice.interfaceMode);
    const interfaceSurface = readString(activeChatSlice.interfaceSurface);
    const claudeTerminalTurnState = readString(
      activeChatSlice.claudeTerminalTurnState,
    );
    const interfaceToggleDisabled = readString(
      activeChatSlice.interfaceToggleDisabled,
    );
    const modelConfig =
      readObject(activeChatSlice.modelConfig) ??
      activeChatTabModelConfig(chat, chatId);
    const stagedSelectionCount = readNumber(
      activeChatSlice.stagedSelectionCount,
    );
    const usageLimitBannerVisible = readBoolean(
      activeChatSlice.usageLimitBannerVisible,
    );
    const usageResumeScheduled = readBoolean(
      activeChatSlice.usageResumeScheduled,
    );
    const transientRetrySlice = readObject(activeChatSlice.transientRetry);
    const transientRetryProvider = readString(transientRetrySlice?.provider);
    const transientRetryAttempt = readNumber(transientRetrySlice?.attempt);
    const transientRetryMaxAttempts = readNumber(
      transientRetrySlice?.maxAttempts,
    );
    const transientRetryNextRetryAt =
      transientRetrySlice?.nextRetryAt === null
        ? null
        : readNumber(transientRetrySlice?.nextRetryAt);
    const transientRetryNextRetryAtValid =
      transientRetrySlice?.nextRetryAt === null ||
      transientRetryNextRetryAt !== null;
    const transientRetryExhausted = readBoolean(transientRetrySlice?.exhausted);
    const stateRecoverySlice = readObject(slices['chat.stateRecovery']);
    const stateRecoveryPhase = readString(stateRecoverySlice?.phase);
    const stateRecoveryNoticeKind = readString(stateRecoverySlice?.noticeKind);
    const stateRecoveryRetryAvailable = readBoolean(
      stateRecoverySlice?.retryAvailable,
    );
    const stateRecoveryDismissAvailable = readBoolean(
      stateRecoverySlice?.dismissAvailable,
    );
    const scheduledMessageCount = readNumber(
      activeChatSlice.scheduledMessageCount,
    );
    const scheduleModalOpen = readBoolean(activeChatSlice.scheduleModalOpen);
    const scheduledMessageInlineEditOpen = readBoolean(
      activeChatSlice.scheduledMessageInlineEditOpen,
    );
    const scheduledMessageEditId = readString(
      activeChatSlice.scheduledMessageEditId,
    );
    const automationEditModalOpen = readBoolean(
      activeChatSlice.automationEditModalOpen,
    );
    const automationEditId = readString(activeChatSlice.automationEditId);
    const archivedChatsSlice = readObject(slices['chat.archivedChats']);
    const archivedChatCount = readNumber(archivedChatsSlice?.count);
    const archivedChatsModalOpen = readBoolean(archivedChatsSlice?.modalOpen);
    const archivedChatViewerOpen = readBoolean(archivedChatsSlice?.viewerOpen);
    const archivedChatViewerChatId = readString(
      archivedChatsSlice?.viewerChatId,
    );
    const archivedChatViewerTitle = readString(archivedChatsSlice?.viewerTitle);
    const sharePlanModalSlice = readObject(slices['plans.shareModal']);
    const sharePlanModalPlanId = readString(sharePlanModalSlice?.planId);
    const sharePlanModalPlanTitle = readString(sharePlanModalSlice?.planTitle);
    const sharePlanModalScope = readString(sharePlanModalSlice?.scope);
    const sharePlanModalTeamId = readString(sharePlanModalSlice?.teamId);
    const sharePlanModalOrganizationId = readString(
      sharePlanModalSlice?.organizationId,
    );
    const importPlanModalSlice = readObject(slices['plans.importModal']);
    const importPlanModalProjectId = readString(
      importPlanModalSlice?.projectId,
    );
    const importPlanModalWorktreeId = readString(
      importPlanModalSlice?.worktreeId,
    );
    const importPlanModalOriginChatId = readString(
      importPlanModalSlice?.originChatId,
    );
    const importPlanModalSelectedGroup = readString(
      importPlanModalSlice?.selectedGroup,
    );
    const toolApprovalDockSlice = readObject(slices['chat.toolApprovalDock']);
    const toolApprovalDockVisible = readBoolean(toolApprovalDockSlice?.visible);
    const toolApprovalDockPendingCount = readNumber(
      toolApprovalDockSlice?.pendingCount,
    );
    const toolApprovalDockSelectedIndex = readNumber(
      toolApprovalDockSlice?.selectedIndex,
    );
    const toolApprovalDockProvider = readString(
      toolApprovalDockSlice?.provider,
    );
    const toolApprovalDockRequestKind = readString(
      toolApprovalDockSlice?.requestKind,
    );
    const toolApprovalDockSubagent = readBoolean(
      toolApprovalDockSlice?.subagent,
    );
    const backgroundProcessesSlice = readObject(
      slices['chat.backgroundProcesses'],
    );
    const backgroundProcessTotal = readNumber(backgroundProcessesSlice?.total);
    const backgroundProcessRunning = readNumber(
      backgroundProcessesSlice?.running,
    );
    const backgroundProcessDetailModalOpen = readBoolean(
      backgroundProcessesSlice?.detailModalOpen,
    );
    const backgroundProcessSelectedTaskId = readString(
      backgroundProcessesSlice?.selectedTaskId,
    );
    // Only a tab of the selected worktree gets an address, so a send to it
    // can never name another task.
    const selected = chat.selectedWorktree;
    const address =
      chatId &&
      selected &&
      chat.worktreeChats[
        `${selected.projectId}/${selected.worktreeId}`
      ]?.tabs.some((tab) => tab.id === chatId)
        ? {
            projectId: selected.projectId,
            taskId: selected.worktreeId,
            chatId,
          }
        : undefined;
    snapshot.activeChat = {
      ...(executionHarness === 'claude' ||
      executionHarness === 'codex' ||
      executionHarness === 'cursor'
        ? { executionHarness }
        : {}),
      ...(chatId ? { chatId } : {}),
      ...(address ? { address } : {}),
      ...(title ? { title } : {}),
      ...(status ? { status } : {}),
      ...(backgroundProcessTotal !== null &&
      backgroundProcessRunning !== null &&
      backgroundProcessDetailModalOpen !== null
        ? {
            backgroundProcesses: {
              total: backgroundProcessTotal,
              running: backgroundProcessRunning,
              detailModalOpen: backgroundProcessDetailModalOpen,
              ...(backgroundProcessSelectedTaskId
                ? { selectedTaskId: backgroundProcessSelectedTaskId }
                : {}),
            },
          }
        : {}),
      ...(approvalMode === 'ask' ||
      approvalMode === 'auto' ||
      approvalMode === 'full-access'
        ? { approvalMode }
        : {}),
      ...(isAgentProviderType(providerType)
        ? {
            providerType,
          }
        : {}),
      ...(toolApprovalDockVisible !== null &&
      toolApprovalDockPendingCount !== null &&
      toolApprovalDockSelectedIndex !== null &&
      toolApprovalDockSubagent !== null
        ? {
            toolApprovalDock: {
              visible: toolApprovalDockVisible,
              pendingCount: toolApprovalDockPendingCount,
              selectedIndex: toolApprovalDockSelectedIndex,
              ...(isAgentProviderType(toolApprovalDockProvider)
                ? { provider: toolApprovalDockProvider }
                : {}),
              ...(toolApprovalDockRequestKind
                ? { requestKind: toolApprovalDockRequestKind }
                : {}),
              subagent: toolApprovalDockSubagent,
            },
          }
        : {}),
      ...(model ? { model: model } : {}),
      // Phase F6: forward the chat-interface mode + terminal turn-state + the
      // toggle-disabled reason to App Advisor's hidden context. Each field is
      // optional so non-Claude tabs (and older renderers without the
      // reporter populated) still produce valid envelopes.
      ...(interfaceMode === 'canopy' ||
      interfaceMode === 'claude-code' ||
      interfaceMode === 'auto'
        ? { interfaceMode }
        : {}),
      // In auto mode the rendered surface flips between the Canopy
      // transcript and the managed terminal per turn; forward it so the
      // assistant knows what the user is currently looking at.
      ...(interfaceSurface === 'canopy' || interfaceSurface === 'terminal'
        ? { interfaceSurface }
        : {}),
      ...(isClaudeTerminalTurnState(claudeTerminalTurnState)
        ? {
            claudeTerminalTurnState,
          }
        : {}),
      ...(interfaceToggleDisabled === 'none' ||
      interfaceToggleDisabled === 'hidden' ||
      interfaceToggleDisabled === 'canopy-native-busy' ||
      interfaceToggleDisabled === 'terminal-running'
        ? { interfaceToggleDisabled }
        : {}),
      // The requested Codex speed with its derived boolean; never an
      // entitlement or the tier a provider actually served.
      ...(modelConfig
        ? { modelConfig: activeChatSpeedFields(modelConfig) }
        : {}),
      ...(stagedSelectionCount !== null ? { stagedSelectionCount } : {}),
      // Worktree-session scheduled-send / usage-limit awareness (sanitized).
      ...(usageLimitBannerVisible === true ? { usageLimitBannerVisible } : {}),
      ...(usageResumeScheduled === true ? { usageResumeScheduled } : {}),
      ...(isAgentProviderType(transientRetryProvider) &&
      transientRetryAttempt !== null &&
      transientRetryMaxAttempts !== null &&
      transientRetryNextRetryAtValid &&
      transientRetryExhausted !== null
        ? {
            transientRetry: {
              provider: transientRetryProvider,
              attempt: transientRetryAttempt,
              maxAttempts: transientRetryMaxAttempts,
              nextRetryAt: transientRetryNextRetryAt,
              exhausted: transientRetryExhausted,
            },
          }
        : {}),
      ...(stateRecoverySlice &&
      stateRecoveryRetryAvailable !== null &&
      stateRecoveryDismissAvailable !== null
        ? {
            stateRecovery: {
              ...(stateRecoveryPhase === 'refreshing' ||
              stateRecoveryPhase === 'refresh_error'
                ? { phase: stateRecoveryPhase }
                : {}),
              ...(stateRecoveryNoticeKind === 'conflict'
                ? { noticeKind: 'conflict' as const }
                : stateRecoveryNoticeKind === 'failure' ||
                    stateRecoveryNoticeKind === 'command_failed'
                  ? { noticeKind: 'failure' as const }
                  : {}),
              retryAvailable: stateRecoveryRetryAvailable,
              dismissAvailable: stateRecoveryDismissAvailable,
            },
          }
        : {}),
      ...(scheduledMessageCount !== null ? { scheduledMessageCount } : {}),
      ...(scheduleModalOpen === true ? { scheduleModalOpen } : {}),
      ...(scheduledMessageInlineEditOpen === true
        ? {
            scheduledMessageInlineEditOpen,
            ...(scheduledMessageEditId ? { scheduledMessageEditId } : {}),
          }
        : {}),
      ...(automationEditModalOpen === true
        ? {
            automationEditModalOpen,
            ...(automationEditId ? { automationEditId } : {}),
          }
        : {}),
      ...(archivedChatCount !== null
        ? {
            archivedChats: {
              count: archivedChatCount,
              ...(archivedChatsModalOpen !== null
                ? { modalOpen: archivedChatsModalOpen }
                : {}),
              ...(archivedChatViewerOpen !== null
                ? { viewerOpen: archivedChatViewerOpen }
                : {}),
              ...(archivedChatViewerChatId
                ? { viewerChatId: archivedChatViewerChatId }
                : {}),
              ...(archivedChatViewerTitle
                ? { viewerTitle: archivedChatViewerTitle }
                : {}),
            },
          }
        : {}),
      ...(sharePlanModalSlice
        ? {
            sharePlanModal: {
              open: readBoolean(sharePlanModalSlice.open) ?? false,
              ...(sharePlanModalPlanId ? { planId: sharePlanModalPlanId } : {}),
              ...(sharePlanModalPlanTitle
                ? { planTitle: sharePlanModalPlanTitle }
                : {}),
              ...(sharePlanModalScope === 'private' ||
              sharePlanModalScope === 'team' ||
              sharePlanModalScope === 'organization'
                ? { scope: sharePlanModalScope }
                : {}),
              ...(typeof sharePlanModalSlice.busy === 'boolean'
                ? { busy: sharePlanModalSlice.busy }
                : {}),
              ...(sharePlanModalTeamId ? { teamId: sharePlanModalTeamId } : {}),
              ...(sharePlanModalOrganizationId
                ? { organizationId: sharePlanModalOrganizationId }
                : {}),
            },
          }
        : {}),
      ...(importPlanModalSlice
        ? {
            importPlanModal: {
              open: readBoolean(importPlanModalSlice.open) ?? false,
              ...(importPlanModalProjectId
                ? { projectId: importPlanModalProjectId }
                : {}),
              ...(importPlanModalWorktreeId
                ? { worktreeId: importPlanModalWorktreeId }
                : {}),
              ...(importPlanModalSelectedGroup === 'suggestions' ||
              importPlanModalSelectedGroup === 'files'
                ? { selectedGroup: importPlanModalSelectedGroup }
                : {}),
              ...(typeof importPlanModalSlice.importing === 'boolean'
                ? { importing: importPlanModalSlice.importing }
                : {}),
              ...(importPlanModalOriginChatId
                ? { originChatId: importPlanModalOriginChatId }
                : {}),
              ...(typeof importPlanModalSlice.detectedEntryCount === 'number'
                ? {
                    detectedEntryCount: importPlanModalSlice.detectedEntryCount,
                  }
                : {}),
              ...(typeof importPlanModalSlice.activeDetectedEntryCount ===
              'number'
                ? {
                    activeDetectedEntryCount:
                      importPlanModalSlice.activeDetectedEntryCount,
                  }
                : {}),
              ...(typeof importPlanModalSlice.dismissedEntryCount === 'number'
                ? {
                    dismissedEntryCount:
                      importPlanModalSlice.dismissedEntryCount,
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  // -- Active pipeline / pipeline run / file / terminal.
  const pipelineSlice =
    readObject(slices['pipelines.activeEditor']) ??
    buildActivePipelineSlice(pipelineRuns, chat.selectedWorktree);
  if (pipelineSlice) {
    const pipelineId = readString(pipelineSlice.pipelineId);
    const name = readString(pipelineSlice.name);
    snapshot.activePipeline = {
      ...(pipelineId ? { pipelineId } : {}),
      ...(name ? { name } : {}),
      ...(typeof pipelineSlice.editorOpen === 'boolean'
        ? { editorOpen: pipelineSlice.editorOpen }
        : {}),
      ...(typeof pipelineSlice.dirty === 'boolean'
        ? { dirty: pipelineSlice.dirty }
        : {}),
      ...(typeof pipelineSlice.readonly === 'boolean'
        ? { readonly: pipelineSlice.readonly }
        : {}),
      ...(pipelineSlice.activeView === 'flow' ||
      pipelineSlice.activeView === 'details'
        ? { activeView: pipelineSlice.activeView }
        : {}),
    };
  }

  const curatedPipelinePreviewSlice = readObject(
    slices['pipelines.curatedPreview'],
  );
  if (curatedPipelinePreviewSlice) {
    const key = readString(curatedPipelinePreviewSlice.key);
    const loading = readBoolean(curatedPipelinePreviewSlice.loading);
    const errorVisible = readBoolean(curatedPipelinePreviewSlice.errorVisible);
    snapshot.curatedPipelinePreview = {
      open: readBoolean(curatedPipelinePreviewSlice.open) ?? false,
      ...(key ? { key } : {}),
      ...(typeof loading === 'boolean' ? { loading } : {}),
      ...(typeof errorVisible === 'boolean' ? { errorVisible } : {}),
    };
  }

  const pipelineChatPanelSlice = readObject(slices['pipelines.chatPanel']);
  if (pipelineChatPanelSlice) {
    const visible = readBoolean(pipelineChatPanelSlice.visible);
    const widthPercent = readNumber(pipelineChatPanelSlice.widthPercent);
    if (typeof visible === 'boolean') {
      snapshot.pipelineChatPanel = {
        visible,
        ...(typeof widthPercent === 'number' ? { widthPercent } : {}),
      };
    }
  }

  // Shown pipeline run details: every visible run panel (each under its own
  // key) plus the ownerless compatibility modal. The focused one also feeds
  // `activePipelineRun`.
  const runDetails = collectPipelineRunDetails(slices);
  if (runDetails.entries.length > 0) {
    snapshot.pipelineRunDetails = runDetails.entries;
  }
  const pipelineRunSlice =
    runDetails.focusedSlice ??
    readObject(slices['pipelineRuns.debugProgress']) ??
    buildActivePipelineRunSlice(pipelineRuns, chat.selectedWorktree);
  if (pipelineRunSlice) {
    const executionId = readString(pipelineRunSlice.executionId);
    const pipelineId = readString(pipelineRunSlice.pipelineId);
    const status = readString(pipelineRunSlice.status);
    const selectedJobId = readString(pipelineRunSlice.selectedJobId);
    const inputRequired = readBoolean(pipelineRunSlice.inputRequired);
    const resumable = readBoolean(pipelineRunSlice.resumable);
    const transientRetrySlice = readObject(pipelineRunSlice.transientRetry);
    const transientRetryAttempt = readNumber(transientRetrySlice?.attempt);
    const transientRetryMaxAttempts = readNumber(
      transientRetrySlice?.maxAttempts,
    );
    const transientRetryNextRetryAt =
      transientRetrySlice?.nextRetryAt === null
        ? null
        : readNumber(transientRetrySlice?.nextRetryAt);
    const transientRetryNextRetryAtValid =
      transientRetrySlice?.nextRetryAt === null ||
      transientRetryNextRetryAt !== null;
    const transientRetryExhausted = readBoolean(transientRetrySlice?.exhausted);
    const resumableStatusReasons = readResumableStatusReasons(
      pipelineRunSlice.resumableStatusReasons,
    );
    snapshot.activePipelineRun = {
      ...(executionId ? { executionId } : {}),
      ...(pipelineId ? { pipelineId } : {}),
      ...(status ? { status } : {}),
      ...(selectedJobId ? { selectedJobId } : {}),
      ...(typeof inputRequired === 'boolean' ? { inputRequired } : {}),
      ...(typeof resumable === 'boolean' ? { resumable } : {}),
      ...(transientRetryAttempt !== null &&
      transientRetryMaxAttempts !== null &&
      transientRetryNextRetryAtValid &&
      transientRetryExhausted !== null
        ? {
            transientRetry: {
              attempt: transientRetryAttempt,
              maxAttempts: transientRetryMaxAttempts,
              nextRetryAt: transientRetryNextRetryAt,
              exhausted: transientRetryExhausted,
            },
          }
        : {}),
      ...(resumableStatusReasons.length > 0 ? { resumableStatusReasons } : {}),
    };
  }
  const fileSlice =
    readObject(slices['files.activeTab']) ?? buildActiveFileSlice(chat);
  if (fileSlice) {
    const tabId = readString(fileSlice.tabId);
    const path = readString(fileSlice.path);
    const repoId = readString(fileSlice.repoId);
    const mode = readString(fileSlice.mode);
    const fileTreeVisible = readBoolean(fileSlice.fileTreeVisible);
    const previewSearchSlice = tabId
      ? readObject(slices[`files.previewSearch.${tabId}`])
      : undefined;
    const previewSearchEnabled = readBoolean(previewSearchSlice?.enabled);
    const previewSearchOpen = readBoolean(previewSearchSlice?.open);
    const previewSearchQueryPresent = readBoolean(
      previewSearchSlice?.queryPresent,
    );
    const previewSearchCurrentIndex = readNumber(
      previewSearchSlice?.currentIndex,
    );
    const previewSearchTotalCount = readNumber(previewSearchSlice?.totalCount);
    const commentsDrawerSlice = tabId
      ? readObject(slices[`files.commentsDrawer.${tabId}`])
      : undefined;
    const commentsDrawerVisible = readBoolean(commentsDrawerSlice?.visible);
    const commentsDrawerCollapsed = readBoolean(commentsDrawerSlice?.collapsed);
    const commentsDrawerHeight = readNumber(commentsDrawerSlice?.heightPercent);
    const commentsDrawerTotalCount = readNumber(
      commentsDrawerSlice?.totalCount,
    );
    const commentsDrawerActiveCount = readNumber(
      commentsDrawerSlice?.activeCount,
    );
    const commentsDrawerStagedCount = readNumber(
      commentsDrawerSlice?.stagedCount,
    );
    snapshot.activeFile = {
      ...(path ? { path } : {}),
      ...(repoId ? { repoId } : {}),
      ...(mode ? { mode } : {}),
      ...(typeof fileSlice.dirty === 'boolean'
        ? { dirty: fileSlice.dirty }
        : {}),
      ...(fileTreeVisible !== null ? { fileTreeVisible } : {}),
      ...(previewSearchEnabled === true &&
      previewSearchOpen !== null &&
      previewSearchQueryPresent !== null &&
      previewSearchCurrentIndex !== null &&
      previewSearchTotalCount !== null
        ? {
            previewSearch: {
              open: previewSearchOpen,
              queryPresent: previewSearchQueryPresent,
              currentIndex: previewSearchCurrentIndex,
              totalCount: previewSearchTotalCount,
            },
          }
        : {}),
      ...(commentsDrawerVisible !== null &&
      commentsDrawerCollapsed !== null &&
      commentsDrawerHeight !== null &&
      commentsDrawerTotalCount !== null &&
      commentsDrawerActiveCount !== null &&
      commentsDrawerStagedCount !== null
        ? {
            commentsDrawer: {
              visible: commentsDrawerVisible,
              collapsed: commentsDrawerCollapsed,
              heightPercent: commentsDrawerHeight,
              totalCount: commentsDrawerTotalCount,
              activeCount: commentsDrawerActiveCount,
              stagedCount: commentsDrawerStagedCount,
            },
          }
        : {}),
    };
  }

  const terminalSlice =
    readObject(slices['terminal.drawer']) ?? buildTerminalSlice(chat);
  if (terminalSlice) {
    const activeSessionId = readString(terminalSlice.activeSessionId);
    snapshot.terminal = {
      ...(typeof terminalSlice.drawerOpen === 'boolean'
        ? { drawerOpen: terminalSlice.drawerOpen }
        : {}),
      ...(activeSessionId ? { activeSessionId } : {}),
      ...(typeof terminalSlice.runningCount === 'number'
        ? { runningCount: terminalSlice.runningCount }
        : {}),
    };
  }

  // -- Panel grid (selected worktree). Compact metadata straight from the
  // panel layout store's derived view-model: group/panel ids, tab kinds, and
  // instance titles only — never panel contents.
  const panelsSlice = buildPanelsSlice(chat);
  if (panelsSlice) {
    snapshot.panels = panelsSlice;
  }

  // -- In-app Browser panels (metadata only — never page content). Derived
  // centrally from the panel layout plus the flat browser store — no mounted
  // surface reports a competing `browser.drawer` slice anymore. The wire
  // shape keeps the drawer-era compatibility fields with their new
  // panel-based meaning (`drawerOpen` = at least one Browser panel visible).
  const browserSlice = buildBrowserSlice(chat);
  if (browserSlice) {
    snapshot.browser = browserSlice;
  }

  // -- Active plan (selected worktree). Mirrors the context a composer send
  // attaches to an outgoing chat message: the worktree's active plan id, plus
  // the viewed revision number while an older revision is on screen. Never
  // includes plan content or comment text.
  const activePlanSlice = buildActivePlanSlice(chat);
  if (activePlanSlice) {
    snapshot.activePlan = activePlanSlice;
  }

  // -- Canopy Portal (pairing code REDACTED — see plan §Phase 8).
  //
  // The desktop app is bound to exactly one Canopy Cloud backend at build
  // time, so the assistant-visible snapshot intentionally does NOT carry
  // any server-identity fields (`selectedServerId`, `selectedServerName`,
  // `selectedServerBaseUrl`). Leaking those into this snapshot would defeat
  // the single-server UX guarantee.
  const portalModalSlice = readObject(slices['canopyPortal.modal']);
  const portalModalBusy = readString(portalModalSlice?.busy);
  snapshot.canopyPortal = {
    featureEnabled: canopyPortalFeatureEnabled,
    status: portal.status,
    connectionStatus: portal.connectionStatus,
    sessionId: portal.sessionId,
    pairingCodeVisible: portal.pairingCode !== null,
    pairingCodeExpiresAt: portal.pairingCodeExpiresAt,
    activatedAt: portal.activatedAt,
    // No lastSeenAt: it is a heartbeat a connected Portal stamps every few
    // seconds, and every change advances the revision, so a guarded action
    // could never match it (CAN-3592). connectionStatus carries liveness.
    lastErrorAt: portal.lastErrorAt,
    error: portal.error,
    ...(portalModalSlice
      ? {
          modal: {
            open: readBoolean(portalModalSlice.open) ?? false,
            ...(portalModalBusy ? { busy: portalModalBusy } : {}),
            ...(typeof portalModalSlice.errorVisible === 'boolean'
              ? { errorVisible: portalModalSlice.errorVisible }
              : {}),
            ...(typeof portalModalSlice.viewPortalVisible === 'boolean'
              ? { viewPortalVisible: portalModalSlice.viewPortalVisible }
              : {}),
            ...(typeof portalModalSlice.pairingQrVisible === 'boolean'
              ? { pairingQrVisible: portalModalSlice.pairingQrVisible }
              : {}),
          },
        }
      : {}),
  };

  const oauthPanelSlice = readObject(slices['plugins.oauthPanel']);
  const connectionSlice = readObject(slices['plugins.connection']);
  const mcpManagementSlice = readObject(
    slices['plugins.connection.management'],
  );
  const pluginsSlice = readObject(slices['plugins.page']);
  const pluginsPageState = readPluginsPageUiState(pluginsSlice);
  // The legacy management view, its marketplace plugins modal and the
  // Skills/Collections lists that reported `plugins.managementView`,
  // `plugins.marketplaceModal`, `plugins.sharedSkills`,
  // `plugins.sharedCollections` and `plugins.selectedRow` were deleted
  // (CAN-4267). The readers stay so the snapshot contract is unchanged; with
  // no producer they report nothing.
  const legacyManagementViewState = readLegacyManagementViewUiState(
    readObject(slices['plugins.managementView']),
  );
  const pluginsEntryDetailState = readPluginsEntryDetailUiState(
    readObject(slices['plugins.entryDetail']),
  );
  const pluginsSelectedRow = readObject(slices['plugins.selectedRow']);
  const sourcesSlice = readObject(slices['plugins.marketplaceSources']);
  const sourceFilters = readObject(sourcesSlice?.filters);
  const sourceBulk = readObject(sourcesSlice?.bulkInstall);
  const pluginsMarketplaceModal = readMarketplaceModalUiState(
    slices['plugins.marketplaceModal'],
  );
  const pluginsMcpBrowseModal = readObject(slices['plugins.mcpBrowseModal']);
  const pluginsMcpSelectedEntry = readObject(
    pluginsMcpBrowseModal?.selectedEntry,
  );
  const pluginsMcpSelectedKey = readString(pluginsMcpSelectedEntry?.key);
  const pluginsMcpSelectedName = readString(pluginsMcpSelectedEntry?.name);
  const pluginsMcpSelectedInstalled = readBoolean(
    pluginsMcpSelectedEntry?.installed,
  );
  const pluginsMcpBrowseView = readString(pluginsMcpBrowseModal?.view);
  const normalizedPluginsMcpBrowseView =
    pluginsMcpBrowseView === 'catalog' || pluginsMcpBrowseView === 'detail'
      ? pluginsMcpBrowseView
      : undefined;
  const sharedSkillsState = readSharedResourceUiState(
    slices['plugins.sharedSkills'],
  );
  const skillDetailSlice = readObject(slices['plugins.skillDetail']);
  const skillDetailLoading = readBoolean(skillDetailSlice?.loading);
  const skillDetailErrorVisible = readBoolean(skillDetailSlice?.errorVisible);
  const skillDetailFileCount = readNumber(skillDetailSlice?.fileCount);
  const skillDetailFilesTruncated = readBoolean(
    skillDetailSlice?.filesTruncated,
  );
  const skillDetailTreeOpen = readBoolean(skillDetailSlice?.treeOpen);
  const skillDetailOpenTabs = readStringList(skillDetailSlice?.openTabs, 50);
  const sharedCollectionsState = readSharedResourceUiState(
    slices['plugins.sharedCollections'],
    { includeImporting: true },
  );
  const pluginsSelectedRowKind = readString(pluginsSelectedRow?.kind);
  const normalizedPluginsSelectedRowKind =
    pluginsSelectedRowKind === 'bundle' ||
    pluginsSelectedRowKind === 'bundles' ||
    pluginsSelectedRowKind === 'collection' ||
    pluginsSelectedRowKind === 'collections'
      ? 'collection'
      : pluginsSelectedRowKind === 'skill' ||
          pluginsSelectedRowKind === 'mcp' ||
          pluginsSelectedRowKind === 'marketplace'
        ? pluginsSelectedRowKind
        : undefined;
  // Every nested key is built from its OWN slice. The Plugins page used to gate
  // this whole object on its `activeTab`, which meant the marketplace modal,
  // curated MCP browser, skill detail, and shared-resource slices all vanished
  // from App Advisor's context the moment the tabs were replaced (API-2153).
  const pluginsSnapshot: NonNullable<AppAdvisorUiStateSnapshot['plugins']> = {
    ...(oauthPanelSlice
      ? {
          oauthPanel: {
            open: readBoolean(oauthPanelSlice.open) ?? false,
            loading: readBoolean(oauthPanelSlice.loading) ?? false,
            errorVisible: readBoolean(oauthPanelSlice.errorVisible) ?? false,
          },
        }
      : {}),
    ...(connectionSlice
      ? {
          connection: {
            pending: readBoolean(connectionSlice.pending) ?? false,
            browserOpen: readBoolean(connectionSlice.browserOpen) ?? false,
            connected: readBoolean(connectionSlice.connected) ?? false,
            authRequired: readBoolean(connectionSlice.authRequired) ?? false,
            errorVisible: readBoolean(connectionSlice.errorVisible) ?? false,
          },
        }
      : {}),
    ...(mcpManagementSlice
      ? {
          mcpManagement: {
            healthStatus:
              mcpManagementSlice.healthStatus === 'connected' ||
              mcpManagementSlice.healthStatus === 'auth_required' ||
              mcpManagementSlice.healthStatus === 'unreachable'
                ? mcpManagementSlice.healthStatus
                : 'unknown',
            testPending: readBoolean(mcpManagementSlice.testPending) ?? false,
            actionPending:
              readBoolean(mcpManagementSlice.actionPending) ?? false,
            deleteConfirmOpen:
              readBoolean(mcpManagementSlice.deleteConfirmOpen) ?? false,
            promoteDialogOpen:
              readBoolean(mcpManagementSlice.promoteDialogOpen) ?? false,
            credentialDialogOpen:
              readBoolean(mcpManagementSlice.credentialDialogOpen) ?? false,
            deviceServer: readBoolean(mcpManagementSlice.deviceServer) ?? false,
          },
        }
      : {}),
    ...(pluginsPageState ? { page: pluginsPageState } : {}),
    ...(legacyManagementViewState
      ? { managementView: legacyManagementViewState }
      : {}),
    ...(pluginsEntryDetailState
      ? { entryDetail: pluginsEntryDetailState }
      : {}),
    ...(normalizedPluginsSelectedRowKind
      ? {
          selectedRow: {
            kind: normalizedPluginsSelectedRowKind,
            ...(readString(pluginsSelectedRow?.id)
              ? { id: readString(pluginsSelectedRow?.id) }
              : {}),
            ...(readString(pluginsSelectedRow?.name)
              ? { name: readString(pluginsSelectedRow?.name) }
              : {}),
          },
        }
      : {}),
    ...(sourcesSlice
      ? {
          marketplaceSources: {
            sourceCount: Math.max(0, readNumber(sourcesSlice.sourceCount) ?? 0),
            invalidCount: Math.max(
              0,
              readNumber(sourcesSlice.invalidCount) ?? 0,
            ),
            loading: readBoolean(sourcesSlice.loading) ?? false,
            refreshing: readBoolean(sourcesSlice.refreshing) ?? false,
            listError: readBoolean(sourcesSlice.listError) ?? false,
            ...(readString(sourcesSlice.selectedSourceId)
              ? { selectedSourceId: readString(sourcesSlice.selectedSourceId) }
              : {}),
            filters: {
              searchActive: readBoolean(sourceFilters?.searchActive) ?? false,
              categoryActive:
                readBoolean(sourceFilters?.categoryActive) ?? false,
              authorActive: readBoolean(sourceFilters?.authorActive) ?? false,
            },
            busySourceIds:
              readStringList(sourcesSlice.busySourceIds, 100) ?? [],
            bulkInstall: {
              running: readBoolean(sourceBulk?.running) ?? false,
              cancelling: readBoolean(sourceBulk?.cancelling) ?? false,
              done: Math.max(0, readNumber(sourceBulk?.done) ?? 0),
              total: Math.max(0, readNumber(sourceBulk?.total) ?? 0),
            },
          },
        }
      : {}),
    ...(pluginsMarketplaceModal
      ? { marketplaceModal: pluginsMarketplaceModal }
      : {}),
    ...(pluginsMcpBrowseModal
      ? {
          mcpBrowseModal: {
            open: readBoolean(pluginsMcpBrowseModal.open) ?? false,
            ...(normalizedPluginsMcpBrowseView
              ? { view: normalizedPluginsMcpBrowseView }
              : {}),
            ...(typeof pluginsMcpBrowseModal.resultCount === 'number'
              ? {
                  resultCount: Math.max(
                    0,
                    Math.trunc(pluginsMcpBrowseModal.resultCount),
                  ),
                }
              : {}),
            ...(pluginsMcpSelectedKey &&
            pluginsMcpSelectedName &&
            typeof pluginsMcpSelectedInstalled === 'boolean'
              ? {
                  selectedEntry: {
                    key: pluginsMcpSelectedKey,
                    name: pluginsMcpSelectedName,
                    installed: pluginsMcpSelectedInstalled,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(sharedSkillsState ? { sharedSkills: sharedSkillsState } : {}),
    ...(sharedCollectionsState
      ? { sharedCollections: sharedCollectionsState }
      : {}),
    ...(skillDetailSlice
      ? {
          skillDetail: {
            open: readBoolean(skillDetailSlice.open) ?? false,
            ...(readString(skillDetailSlice.sourceId)
              ? { sourceId: readString(skillDetailSlice.sourceId) }
              : {}),
            ...(readString(skillDetailSlice.skillName)
              ? { skillName: readString(skillDetailSlice.skillName) }
              : {}),
            ...(skillDetailLoading !== null
              ? { loading: skillDetailLoading }
              : {}),
            ...(skillDetailErrorVisible !== null
              ? { errorVisible: skillDetailErrorVisible }
              : {}),
            ...(skillDetailFileCount !== null
              ? {
                  fileCount: Math.max(0, Math.trunc(skillDetailFileCount)),
                }
              : {}),
            ...(skillDetailFilesTruncated !== null
              ? { filesTruncated: skillDetailFilesTruncated }
              : {}),
            ...(skillDetailTreeOpen !== null
              ? { treeOpen: skillDetailTreeOpen }
              : {}),
            ...(skillDetailOpenTabs ? { openTabs: skillDetailOpenTabs } : {}),
            ...(readString(skillDetailSlice.activeFile)
              ? { activeFile: readString(skillDetailSlice.activeFile) }
              : {}),
          },
        }
      : {}),
  };
  if (Object.keys(pluginsSnapshot).length > 0) {
    snapshot.plugins = pluginsSnapshot;
  }

  // Workflows page slice (CAN-3981) — the page reports via `workflows.page`.
  // Filters are copied by name and only as strings or string lists, so a
  // reporter value of another shape never reaches App Advisor's context.
  const workflowsSlice = readObject(slices['workflows.page']);
  if (workflowsSlice) {
    const tab = readString(workflowsSlice.tab);
    const query = readString(workflowsSlice.query);
    const reportedFilters = readObject(workflowsSlice.filters);
    const filters: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(reportedFilters ?? {})) {
      if (typeof value === 'string' && value !== '') {
        filters[name] = value;
      } else if (Array.isArray(value)) {
        const values = value.filter(
          (entry): entry is string => typeof entry === 'string',
        );
        if (values.length > 0) filters[name] = values;
      }
    }
    const activeRunCount = workflowsSlice.activeRunCount;
    const libraryCount = workflowsSlice.libraryCount;
    snapshot.workflows = {
      ...(tab === 'runs' || tab === 'schedule' || tab === 'library'
        ? { tab }
        : {}),
      ...(query ? { query } : {}),
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      ...(typeof activeRunCount === 'number' ? { activeRunCount } : {}),
      ...(typeof libraryCount === 'number' ? { libraryCount } : {}),
    };
  }

  // Automations page slice — the page reports via `automations.page`.
  // Mirror the documented snapshot shape one field at a time so unknown
  // values from the reporter never leak into the App Advisor's hidden
  // context. `activeTab` is constrained to the two documented tabs.
  const automationsSlice = readObject(slices['automations.page']);
  // The Workflows edit shell (CAN-4072) replaced the automation form and
  // run-history dialogs, so their documented flags are read from its slice:
  // the form is open while the shell shows an editable automation, and the
  // run history while it shows that automation's Runs section.
  const editShellSlice = readObject(slices['workflows.editShell']);
  const editShellAutomation =
    editShellSlice !== null &&
    readString(editShellSlice.kind) === 'automation' &&
    readBoolean(editShellSlice.readonly) !== true;
  const editShellActivityId = editShellAutomation
    ? readString(editShellSlice?.id)
    : null;
  const editShellOnRuns =
    editShellAutomation &&
    readBoolean(editShellSlice?.draft) !== true &&
    readString(editShellSlice?.section) === 'runs';
  if (automationsSlice) {
    const activeTab = readString(automationsSlice.activeTab);
    const activityCount = automationsSlice.activityCount;
    const enabledActivityCount = automationsSlice.enabledActivityCount;
    const previouslyTriggeredCount = automationsSlice.previouslyTriggeredCount;
    const watcherCount = automationsSlice.watcherCount;
    const selectedActivityId = readString(automationsSlice.selectedActivityId);
    const selectedWatcherId = readString(automationsSlice.selectedWatcherId);
    const formOpen = editShellAutomation;
    const detailsModalOpen = editShellOnRuns;
    const detailsModalActivityId = editShellOnRuns ? editShellActivityId : null;
    const sharedPipelineReviewModalOpen = readBoolean(
      automationsSlice.sharedPipelineReviewModalOpen,
    );
    const sharedPipelineReviewActivityId = readString(
      automationsSlice.sharedPipelineReviewActivityId,
    );
    const shareModalOpen = readBoolean(automationsSlice.shareModalOpen);
    const shareModalActivityId = readString(
      automationsSlice.shareModalActivityId,
    );
    snapshot.automations = {
      ...(activeTab === 'scheduled' || activeTab === 'watchers'
        ? { activeTab }
        : {}),
      ...(typeof activityCount === 'number' ? { activityCount } : {}),
      ...(typeof enabledActivityCount === 'number'
        ? { enabledActivityCount }
        : {}),
      ...(typeof previouslyTriggeredCount === 'number'
        ? { previouslyTriggeredCount }
        : {}),
      ...(typeof watcherCount === 'number' ? { watcherCount } : {}),
      ...(selectedActivityId ? { selectedActivityId } : {}),
      ...(selectedWatcherId ? { selectedWatcherId } : {}),
      formOpen,
      detailsModalOpen,
      ...(detailsModalActivityId ? { detailsModalActivityId } : {}),
      ...(sharedPipelineReviewModalOpen !== null
        ? { sharedPipelineReviewModalOpen }
        : {}),
      ...(sharedPipelineReviewActivityId
        ? { sharedPipelineReviewActivityId }
        : {}),
      ...(shareModalOpen !== null ? { shareModalOpen } : {}),
      ...(shareModalActivityId ? { shareModalActivityId } : {}),
    };
  }

  // Workspace Automations panel slices — every non-singleton panel owns local
  // modal/form state, so collect its namespaced reporter independently.
  const automationPanels: NonNullable<
    NonNullable<AppAdvisorUiStateSnapshot['automations']>['panels']
  > = [];
  const automationsPanelSlices = Object.entries(slices)
    .filter(([key]) => key.startsWith('automations.panel.'))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [, rawSlice] of automationsPanelSlices) {
    const automationsPanelSlice = readObject(rawSlice);
    if (!automationsPanelSlice) continue;
    const panelId = readString(automationsPanelSlice.panelId);
    const variant = readString(automationsPanelSlice.variant);
    const projectId = readString(automationsPanelSlice.projectId);
    const worktreeId = readString(automationsPanelSlice.worktreeId);
    const detailsModalOpen = readBoolean(
      automationsPanelSlice.detailsModalOpen,
    );
    const detailsModalActivityId = readString(
      automationsPanelSlice.detailsModalActivityId,
    );
    const sharedPipelineReviewModalOpen = readBoolean(
      automationsPanelSlice.sharedPipelineReviewModalOpen,
    );
    const sharedPipelineReviewActivityId = readString(
      automationsPanelSlice.sharedPipelineReviewActivityId,
    );
    const watcherModalOpen = readBoolean(
      automationsPanelSlice.watcherModalOpen,
    );
    const watcherModalWatcherId = readString(
      automationsPanelSlice.watcherModalWatcherId,
    );
    const formOpen = readBoolean(automationsPanelSlice.formOpen);
    const formMode = readString(automationsPanelSlice.formMode);
    const formActivityId = readString(automationsPanelSlice.formActivityId);
    let recognizedVariant:
      | 'full'
      | 'upcoming'
      | 'overview'
      | 'completed'
      | undefined;
    if (variant === 'full') recognizedVariant = 'full';
    if (variant === 'upcoming') recognizedVariant = 'upcoming';
    if (variant === 'overview') recognizedVariant = 'overview';
    if (variant === 'completed') recognizedVariant = 'completed';
    let recognizedFormMode: 'create' | 'edit' | undefined;
    if (formMode === 'create') recognizedFormMode = 'create';
    if (formMode === 'edit') recognizedFormMode = 'edit';
    const panel = {
      ...(panelId ? { panelId } : {}),
      ...(recognizedVariant ? { variant: recognizedVariant } : {}),
      ...(projectId ? { projectId } : {}),
      ...(worktreeId ? { worktreeId } : {}),
      ...(detailsModalOpen !== null ? { detailsModalOpen } : {}),
      ...(detailsModalActivityId ? { detailsModalActivityId } : {}),
      ...(sharedPipelineReviewModalOpen !== null
        ? { sharedPipelineReviewModalOpen }
        : {}),
      ...(sharedPipelineReviewActivityId
        ? { sharedPipelineReviewActivityId }
        : {}),
      ...(watcherModalOpen !== null ? { watcherModalOpen } : {}),
      ...(watcherModalWatcherId ? { watcherModalWatcherId } : {}),
      ...(formOpen !== null ? { formOpen } : {}),
      ...(recognizedFormMode ? { formMode: recognizedFormMode } : {}),
      ...(formActivityId ? { formActivityId } : {}),
    };
    if (Object.keys(panel).length > 0) {
      automationPanels.push(panel);
    }
  }
  if (automationPanels.length > 0) {
    snapshot.automations = {
      ...snapshot.automations,
      panels: automationPanels,
    };
  }

  // Ledger panel slices — one per open panel, keyed by its scope. Mirror the
  // documented fields one at a time so nothing else reaches the App Advisor.
  const ledgerPanels: NonNullable<AppAdvisorUiStateSnapshot['ledgerPanels']> =
    [];
  const ledgerPanelSlices = Object.entries(slices)
    .filter(([key]) => key.startsWith('ledger.panel.'))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [, rawSlice] of ledgerPanelSlices) {
    const ledgerSlice = readObject(rawSlice);
    if (!ledgerSlice) continue;
    const projectId = readString(ledgerSlice.projectId);
    const worktreeId = readString(ledgerSlice.worktreeId);
    const listStatus = readLedgerViewStatus(ledgerSlice.listStatus);
    const entryCount = readNumber(ledgerSlice.entryCount);
    const hasMore = readBoolean(ledgerSlice.hasMore);
    const searching = readBoolean(ledgerSlice.searching);
    const filtered = readBoolean(ledgerSlice.filtered);
    if (
      !projectId ||
      !worktreeId ||
      listStatus === undefined ||
      entryCount === null ||
      hasMore === null ||
      searching === null ||
      filtered === null
    ) {
      continue;
    }
    const selectedEntryId = readString(ledgerSlice.selectedEntryId);
    const detailStatus = readLedgerViewStatus(ledgerSlice.detailStatus);
    const draft =
      ledgerSlice.draft === 'shown' || ledgerSlice.draft === 'set_aside'
        ? ledgerSlice.draft
        : undefined;
    ledgerPanels.push({
      projectId,
      worktreeId,
      listStatus,
      entryCount,
      hasMore,
      searching,
      filtered,
      ...(selectedEntryId ? { selectedEntryId } : {}),
      ...(selectedEntryId && detailStatus !== undefined
        ? { detailStatus }
        : {}),
      ...(draft === undefined ? {} : { draft }),
    });
  }
  if (ledgerPanels.length > 0) {
    snapshot.ledgerPanels = ledgerPanels;
  }

  const scriptSlice = readObject(slices['scriptActions.active']);
  if (scriptSlice) {
    const projectId = readString(scriptSlice.projectId);
    const worktreeId = readString(scriptSlice.worktreeId);
    const pendingCount = readNumber(scriptSlice.pendingCount);
    const approvedCount = readNumber(scriptSlice.approvedCount);
    const dismissedCount = readNumber(scriptSlice.dismissedCount);
    const scanStatus = readString(scriptSlice.scanStatus);
    if (
      projectId &&
      worktreeId &&
      pendingCount !== null &&
      approvedCount !== null &&
      dismissedCount !== null &&
      [pendingCount, approvedCount, dismissedCount].every(
        (count) => Number.isInteger(count) && count >= 0,
      ) &&
      scanStatus &&
      ['idle', 'scanning', 'complete', 'incomplete', 'failed'].includes(
        scanStatus,
      )
    ) {
      snapshot.scriptActions = {
        projectId,
        worktreeId,
        pendingCount,
        approvedCount,
        dismissedCount,
        scanStatus,
      };
    }
  }
  const scriptReview = readObject(slices['scriptActions.review']);
  if (scriptReview) {
    const projectId = readString(scriptReview.projectId);
    const worktreeId = readString(scriptReview.worktreeId);
    if (projectId && worktreeId)
      snapshot.scriptActionsReview = { projectId, worktreeId };
  }

  // Cost panel slices — one per open Cost panel or Session
  // breakdown. Copy the documented fields one at a time; names and amounts
  // are never reported.
  const costPanels: NonNullable<AppAdvisorUiStateSnapshot['costPanels']> = [];
  const costPanelSlices = Object.entries(slices)
    .filter(([key]) => key.startsWith(COST_PANEL_UI_STATE_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [, rawSlice] of costPanelSlices) {
    const costSlice = readObject(rawSlice);
    if (!costSlice) continue;
    const kind =
      costSlice.kind === 'cost' || costSlice.kind === 'session-breakdown'
        ? costSlice.kind
        : undefined;
    const projectId = readString(costSlice.projectId);
    const worktreeId = readString(costSlice.worktreeId);
    const status = readLedgerViewStatus(costSlice.status);
    if (!kind || !projectId || !worktreeId || status === undefined) continue;
    const chatId = readString(costSlice.chatId);
    if (kind === 'session-breakdown' && !chatId) continue;
    const building = readBoolean(costSlice.building);
    const chatCount = readNumber(costSlice.chatCount);
    const pipelineRunCount = readNumber(costSlice.pipelineRunCount);
    const archived = readBoolean(costSlice.archived);
    costPanels.push({
      kind,
      projectId,
      worktreeId,
      status,
      ...(kind === 'session-breakdown' && chatId ? { chatId } : {}),
      ...(kind === 'cost' && building !== null ? { building } : {}),
      ...(kind === 'cost' && chatCount !== null ? { chatCount } : {}),
      ...(kind === 'cost' && pipelineRunCount !== null
        ? { pipelineRunCount }
        : {}),
      ...(kind === 'session-breakdown' && archived !== null
        ? { archived }
        : {}),
    });
  }
  if (costPanels.length > 0) {
    snapshot.costPanels = costPanels;
  }

  // The Subagents panel host reports its lifetime-limit notice; copy the
  // documented status fields only.
  const lifetimeSlice = readObject(slices['subagents.lifetimeLimit']);
  if (lifetimeSlice) {
    const notice =
      lifetimeSlice.notice === 'none' ||
      lifetimeSlice.notice === 'full' ||
      lifetimeSlice.notice === 'full_at_cap' ||
      lifetimeSlice.notice === 'unavailable'
        ? lifetimeSlice.notice
        : undefined;
    const projectId = readString(lifetimeSlice.projectId);
    const worktreeId = readString(lifetimeSlice.worktreeId);
    if (notice && projectId && worktreeId) {
      snapshot.subagentsLifetimeLimit = {
        projectId,
        worktreeId,
        notice,
        atLimit: readBoolean(lifetimeSlice.atLimit),
        limit: readNumber(lifetimeSlice.limit),
        canExtend: readBoolean(lifetimeSlice.canExtend) ?? false,
      };
    }
  }

  // The share dialog reports while it is open; with agents switched off it
  // cannot be shown, so a lingering report is dropped.
  const agentShareModalSlice = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key)
    ? readObject(slices['agents.shareModal'])
    : undefined;
  if (agentShareModalSlice) {
    const localAgentId = readString(agentShareModalSlice.localAgentId);
    const sharedAgentId = readString(agentShareModalSlice.sharedAgentId);
    const publicShareState = readString(agentShareModalSlice.state);
    const busy = readBoolean(agentShareModalSlice.busy);
    const copied = readBoolean(agentShareModalSlice.copied);
    const canUpdate = readBoolean(agentShareModalSlice.canUpdate);
    if (
      localAgentId &&
      (publicShareState === 'unavailable' ||
        publicShareState === 'unpublished' ||
        publicShareState === 'published' ||
        publicShareState === 'stale')
    ) {
      snapshot.agents = {
        ...(snapshot.agents ?? {}),
        publicShareModal: {
          open: true,
          localAgentId,
          ...(sharedAgentId ? { sharedAgentId } : {}),
          state: publicShareState,
          busy: busy ?? false,
          copied: copied ?? false,
          ...(canUpdate !== null ? { canUpdate } : {}),
        },
      };
    }
  }

  const appAdvisorState: NonNullable<AppAdvisorUiStateSnapshot['appAdvisor']> =
    {};
  const appAdvisorWindowSlice = readObject(slices['appAdvisor.window']);
  if (appAdvisorWindowSlice) {
    const editorId = readNullableString(appAdvisorWindowSlice.groupEditorId);
    if (editorId === null || isSidebarItemGroupId(editorId))
      appAdvisorState.groupEditorId = editorId;
    const activeWorkEntryId = readNullableString(
      appAdvisorWindowSlice.activeWorkEntryId,
    );
    const activeChatId = readNullableString(appAdvisorWindowSlice.activeChatId);
    const navCollapsed = readBoolean(appAdvisorWindowSlice.navCollapsed);
    const settingsModalOpen = readBoolean(
      appAdvisorWindowSlice.settingsModalOpen,
    );
    const archivedOverviewOpen = readBoolean(
      appAdvisorWindowSlice.archivedOverviewOpen,
    );
    const archivedOverviewWorkspaceId = readNullableString(
      appAdvisorWindowSlice.archivedOverviewWorkspaceId,
    );
    const emptyTrashConfirmationOpen = readBoolean(
      appAdvisorWindowSlice.emptyTrashConfirmationOpen,
    );
    if (activeWorkEntryId !== undefined) {
      appAdvisorState.activeWorkEntryId = activeWorkEntryId;
    }
    if (activeChatId !== undefined) {
      appAdvisorState.activeChatId = activeChatId;
    }
    if (navCollapsed !== null) {
      appAdvisorState.navCollapsed = navCollapsed;
    }
    if (settingsModalOpen !== null) {
      appAdvisorState.settingsModalOpen = settingsModalOpen;
    }
    if (
      archivedOverviewOpen === true &&
      snapshot.overlays.appAdvisorOpen === true
    ) {
      snapshot.archivedContainers.overviewOpen = true;
      if (
        archivedOverviewWorkspaceId !== undefined &&
        archivedOverviewWorkspaceId !== null
      ) {
        snapshot.archivedContainers.workspaceId = archivedOverviewWorkspaceId;
      }
      if (emptyTrashConfirmationOpen !== null) {
        snapshot.archivedContainers.emptyTrashConfirmationOpen =
          emptyTrashConfirmationOpen;
      }
    }
  }
  const watchersModalSlice = readObject(slices['appAdvisor.watchersModal']);
  const watchersModalChatId = readString(watchersModalSlice?.chatId);
  if (watchersModalSlice) {
    appAdvisorState.watchersModal = {
      open: readBoolean(watchersModalSlice.open) ?? false,
      ...(watchersModalChatId ? { chatId: watchersModalChatId } : {}),
      ...(typeof watchersModalSlice.watcherCount === 'number'
        ? { watcherCount: watchersModalSlice.watcherCount }
        : {}),
      ...(typeof watchersModalSlice.confirmingDelete === 'boolean'
        ? { confirmingDelete: watchersModalSlice.confirmingDelete }
        : {}),
    };
  }
  const usageLimitResumeModalSlice = readObject(
    slices['usageLimit.resumeModal'],
  );
  if (usageLimitResumeModalSlice) {
    const origin = readString(usageLimitResumeModalSlice.origin);
    const provider = readString(usageLimitResumeModalSlice.provider);
    appAdvisorState.usageLimitResumeModal = {
      open: readBoolean(usageLimitResumeModalSlice.open) ?? false,
      ...(origin === 'account-change' ||
      origin === 'authentication' ||
      origin === 'usage-review' ||
      origin === 'app-restart' ||
      origin === 'home'
        ? { origin }
        : {}),
      ...(isAgentProviderType(provider) ? { provider } : {}),
      ...(typeof usageLimitResumeModalSlice.loading === 'boolean'
        ? { loading: usageLimitResumeModalSlice.loading }
        : {}),
      ...(typeof usageLimitResumeModalSlice.submitting === 'boolean'
        ? { submitting: usageLimitResumeModalSlice.submitting }
        : {}),
      ...(typeof usageLimitResumeModalSlice.groupCount === 'number'
        ? { groupCount: usageLimitResumeModalSlice.groupCount }
        : {}),
      ...(typeof usageLimitResumeModalSlice.chatCount === 'number'
        ? { chatCount: usageLimitResumeModalSlice.chatCount }
        : {}),
      ...(typeof usageLimitResumeModalSlice.pipelineCount === 'number'
        ? { pipelineCount: usageLimitResumeModalSlice.pipelineCount }
        : {}),
      ...(typeof usageLimitResumeModalSlice.selectedCount === 'number'
        ? { selectedCount: usageLimitResumeModalSlice.selectedCount }
        : {}),
      ...(typeof usageLimitResumeModalSlice.readinessPending === 'boolean'
        ? { readinessPending: usageLimitResumeModalSlice.readinessPending }
        : {}),
      ...(typeof usageLimitResumeModalSlice.readyCount === 'number'
        ? { readyCount: usageLimitResumeModalSlice.readyCount }
        : {}),
      ...(typeof usageLimitResumeModalSlice.waitingCount === 'number'
        ? { waitingCount: usageLimitResumeModalSlice.waitingCount }
        : {}),
    };
  }
  const resumeQueueModalSlice = readObject(slices['usage.resumeQueueModal']);
  if (resumeQueueModalSlice) {
    appAdvisorState.resumeQueueModal = {
      open: readBoolean(resumeQueueModalSlice.open) ?? false,
      ...(typeof resumeQueueModalSlice.paused === 'boolean'
        ? { paused: resumeQueueModalSlice.paused }
        : {}),
      ...(typeof resumeQueueModalSlice.pending === 'boolean'
        ? { pending: resumeQueueModalSlice.pending }
        : {}),
      ...(typeof resumeQueueModalSlice.processed === 'number'
        ? { processed: resumeQueueModalSlice.processed }
        : {}),
      ...(typeof resumeQueueModalSlice.total === 'number'
        ? { total: resumeQueueModalSlice.total }
        : {}),
      ...(typeof resumeQueueModalSlice.active === 'boolean'
        ? { active: resumeQueueModalSlice.active }
        : {}),
      ...(typeof resumeQueueModalSlice.errorVisible === 'boolean'
        ? { errorVisible: resumeQueueModalSlice.errorVisible }
        : {}),
    };
  }
  const cloneProgressModalSlice = readObject(
    slices['projects.cloneProgressModal'],
  );
  if (cloneProgressModalSlice) {
    appAdvisorState.cloneProgressModal = {
      open: readBoolean(cloneProgressModalSlice.open) ?? false,
      ...(typeof cloneProgressModalSlice.running === 'number'
        ? { running: cloneProgressModalSlice.running }
        : {}),
      ...(typeof cloneProgressModalSlice.failed === 'number'
        ? { failed: cloneProgressModalSlice.failed }
        : {}),
      ...(typeof cloneProgressModalSlice.percent === 'number'
        ? { percent: cloneProgressModalSlice.percent }
        : {}),
    };
  }
  const authLoginModalSlice = readObject(slices['auth.loginModal']);
  if (authLoginModalSlice) {
    const provider = readString(authLoginModalSlice.provider);
    appAdvisorState.authLoginModal = {
      open: readBoolean(authLoginModalSlice.open) ?? false,
      ...(isAuthTerminalProvider(provider) ? { provider } : {}),
      ...(typeof authLoginModalSlice.snapshotsAvailable === 'boolean'
        ? { snapshotsAvailable: authLoginModalSlice.snapshotsAvailable }
        : {}),
      ...(typeof authLoginModalSlice.snapshotsPanelOpen === 'boolean'
        ? { snapshotsPanelOpen: authLoginModalSlice.snapshotsPanelOpen }
        : {}),
    };
  }
  const branchFromModalSlice = readObject(slices['worktree.branchFromModal']);
  if (branchFromModalSlice) {
    const confirmationId = readString(branchFromModalSlice.confirmationId);
    const projectId = readString(branchFromModalSlice.projectId);
    const worktreeId = readString(branchFromModalSlice.worktreeId);
    const menuOpen = readBoolean(branchFromModalSlice.menuOpen);
    appAdvisorState.branchFromModal = {
      open: readBoolean(branchFromModalSlice.open) ?? false,
      ...(confirmationId ? { confirmationId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(worktreeId ? { worktreeId } : {}),
      ...(menuOpen !== null ? { menuOpen } : {}),
    };
  }
  const prMergeModalSlice = readObject(slices['github.prMergeModal']);
  if (prMergeModalSlice) {
    const mode = readString(prMergeModalSlice.mode);
    const prUrl = readString(prMergeModalSlice.prUrl);
    const repos = Array.isArray(prMergeModalSlice.repos)
      ? prMergeModalSlice.repos
          .map(readPrMergeModalRepoState)
          .filter((repo): repo is PrMergeModalRepoUiState => repo !== null)
      : [];
    appAdvisorState.prMergeModal = {
      open: readBoolean(prMergeModalSlice.open) ?? false,
      ...(mode === 'unresolved-warning' || mode === 'multi-repo'
        ? { mode }
        : {}),
      ...(typeof prMergeModalSlice.submitting === 'boolean'
        ? { submitting: prMergeModalSlice.submitting }
        : {}),
      ...(prUrl ? { prUrl } : {}),
      ...(typeof prMergeModalSlice.unresolvedReviewThreadCount === 'number'
        ? {
            unresolvedReviewThreadCount:
              prMergeModalSlice.unresolvedReviewThreadCount,
          }
        : {}),
      ...(typeof prMergeModalSlice.unknownReviewThreadState === 'boolean'
        ? {
            unknownReviewThreadState:
              prMergeModalSlice.unknownReviewThreadState,
          }
        : {}),
      ...(typeof prMergeModalSlice.repoCount === 'number'
        ? { repoCount: prMergeModalSlice.repoCount }
        : {}),
      ...(typeof prMergeModalSlice.mergeableRepoCount === 'number'
        ? { mergeableRepoCount: prMergeModalSlice.mergeableRepoCount }
        : {}),
      ...(typeof prMergeModalSlice.blockedRepoCount === 'number'
        ? { blockedRepoCount: prMergeModalSlice.blockedRepoCount }
        : {}),
      ...(typeof prMergeModalSlice.unresolvedRepoCount === 'number'
        ? { unresolvedRepoCount: prMergeModalSlice.unresolvedRepoCount }
        : {}),
      ...(repos.length > 0 ? { repos } : {}),
    };
  }
  const baseBranchAlignmentModalSlice = readObject(
    slices['github.baseBranchAlignmentModal'],
  );
  if (baseBranchAlignmentModalSlice) {
    const confirmationId = readString(
      baseBranchAlignmentModalSlice.confirmationId,
    );
    const projectId = readString(baseBranchAlignmentModalSlice.projectId);
    const worktreeId = readString(baseBranchAlignmentModalSlice.worktreeId);
    const repositoryNames = readStringList(
      baseBranchAlignmentModalSlice.repositoryNames,
      20,
    );
    appAdvisorState.baseBranchAlignmentModal = {
      open: readBoolean(baseBranchAlignmentModalSlice.open) ?? false,
      ...(confirmationId ? { confirmationId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(worktreeId ? { worktreeId } : {}),
      ...(typeof baseBranchAlignmentModalSlice.driftCount === 'number'
        ? { driftCount: baseBranchAlignmentModalSlice.driftCount }
        : {}),
      ...(repositoryNames ? { repositoryNames } : {}),
    };
  }
  const mergeQueuePopoverSlice = readObject(slices['github.mergeQueuePopover']);
  if (mergeQueuePopoverSlice) {
    const phase = readString(mergeQueuePopoverSlice.phase);
    const count = (key: string): number | null => {
      const value = readNumber(mergeQueuePopoverSlice[key]);
      return value !== null && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
    };
    const position = count('position');
    const etaMinutes = count('etaMinutes');
    const queueLength = count('queueLength');
    const repoCount = count('repoCount');
    appAdvisorState.mergeQueuePopover = {
      open: readBoolean(mergeQueuePopoverSlice.open) ?? false,
      ...(phase === 'queued' ||
      phase === 'testing' ||
      phase === 'merging' ||
      phase === 'blocked'
        ? { phase }
        : {}),
      ...(position !== null ? { position } : {}),
      ...(etaMinutes !== null ? { etaMinutes } : {}),
      ...(queueLength !== null ? { queueLength } : {}),
      ...(repoCount !== null ? { repoCount } : {}),
    };
  }
  if (Object.keys(appAdvisorState).length > 0) {
    snapshot.appAdvisor = appAdvisorState;
  }

  const addWorkspaceSlice = readObject(slices['addWorkspace.modal']);
  if (
    addWorkspaceSlice?.mode === 'personal' ||
    addWorkspaceSlice?.mode === 'organization' ||
    addWorkspaceSlice?.mode === 'organization-existing' ||
    addWorkspaceSlice?.mode === 'organization-create'
  ) {
    const projectKind = ADD_WORKSPACE_PROJECT_KINDS.find(
      (kind) => kind === addWorkspaceSlice.projectKind,
    );
    const folderKind = ADD_WORKSPACE_FOLDER_KINDS.find(
      (kind) => kind === addWorkspaceSlice.folderKind,
    );
    const folderConflict = readAddWorkspaceFolderConflict(
      addWorkspaceSlice.folderConflict,
    );
    snapshot.addWorkspace = {
      mode: addWorkspaceSlice.mode,
      contextChanged: readBoolean(addWorkspaceSlice.contextChanged) ?? false,
      ...(readString(addWorkspaceSlice.organizationId)
        ? { organizationId: readString(addWorkspaceSlice.organizationId) }
        : {}),
      ...(readString(addWorkspaceSlice.name)
        ? { name: readString(addWorkspaceSlice.name) }
        : {}),
      // Categories only: the chosen folder's path never leaves the dialog.
      ...(projectKind ? { projectKind } : {}),
      ...(folderKind ? { folderKind } : {}),
      ...(folderConflict ? { folderConflict } : {}),
    };
  }

  const orgProjectSetupSlice = readObject(slices['orgProjectSetup.modal']);
  if (orgProjectSetupSlice) {
    snapshot.orgProjectSetup = {
      open: readBoolean(orgProjectSetupSlice.open) ?? false,
      ...(readString(orgProjectSetupSlice.projectId)
        ? { projectId: readString(orgProjectSetupSlice.projectId) }
        : {}),
      ...(readString(orgProjectSetupSlice.name)
        ? { name: readString(orgProjectSetupSlice.name) }
        : {}),
      ...(readString(orgProjectSetupSlice.state)
        ? { state: readString(orgProjectSetupSlice.state) }
        : {}),
      canStart: readBoolean(orgProjectSetupSlice.canStart) ?? false,
    };
  }

  const moveToOrganizationSlice = readObject(
    slices['moveToOrganization.modal'],
  );
  if (moveToOrganizationSlice) {
    const workspaceId = readString(moveToOrganizationSlice.workspaceId);
    const errorCode = readString(moveToOrganizationSlice.errorCode);
    snapshot.moveToOrganization = {
      open: readBoolean(moveToOrganizationSlice.open) ?? false,
      ...(workspaceId ? { workspaceId } : {}),
      busy: readBoolean(moveToOrganizationSlice.busy) ?? false,
      ...(errorCode && isOrgProjectMoveErrorCode(errorCode)
        ? { errorCode }
        : {}),
    };
  }

  const codeReviewSlice = readObject(slices['codeReview.modal']);
  if (codeReviewSlice) {
    snapshot.codeReview = {
      open: readBoolean(codeReviewSlice.open) ?? false,
      ...(readString(codeReviewSlice.projectId)
        ? { projectId: readString(codeReviewSlice.projectId) }
        : {}),
      ...(readString(codeReviewSlice.worktreeId)
        ? { worktreeId: readString(codeReviewSlice.worktreeId) }
        : {}),
      ...(typeof codeReviewSlice.armed === 'boolean'
        ? { armed: codeReviewSlice.armed }
        : {}),
      ...(typeof codeReviewSlice.chatVisible === 'boolean'
        ? { chatVisible: codeReviewSlice.chatVisible }
        : {}),
      ...(typeof codeReviewSlice.chatActive === 'boolean'
        ? { chatActive: codeReviewSlice.chatActive }
        : {}),
      ...(typeof codeReviewSlice.commentThreadCount === 'number'
        ? { commentThreadCount: codeReviewSlice.commentThreadCount }
        : {}),
    };
  }

  const readinessSettingsSlice = readObject(
    slices['workspaceReadiness.settings'],
  );
  const readinessOverviewSlice = readObject(
    slices['workspaceReadiness.overview'],
  );
  const readinessHomeSlice = readObject(slices['workspaceReadiness.home']);
  // Settings overlays whichever page is beneath it; Overview and Home are
  // mutually exclusive pages, so at most one of the trailing two is present.
  const readinessSlice =
    readinessSettingsSlice ?? readinessOverviewSlice ?? readinessHomeSlice;
  if (readinessSlice) {
    const surface = readString(readinessSlice.surface);
    const status = readString(readinessSlice.status);
    const issueCount = readNumber(readinessSlice.issueCount);
    const failedWorkspaceCount = readNumber(
      readinessSlice.failedWorkspaceCount,
    );
    if (
      (surface === 'overview' ||
        surface === 'settings' ||
        surface === 'home') &&
      (status === 'loading' || status === 'ready' || status === 'error') &&
      issueCount !== null
    ) {
      snapshot.workspaceReadiness = {
        surface,
        ...(readString(readinessSlice.workspaceId)
          ? { workspaceId: readString(readinessSlice.workspaceId) }
          : {}),
        ...(readString(readinessSlice.worktreeId)
          ? { worktreeId: readString(readinessSlice.worktreeId) }
          : {}),
        status,
        issueCount,
        ...(failedWorkspaceCount !== null ? { failedWorkspaceCount } : {}),
        launching: readBoolean(readinessSlice.launching) ?? false,
        errorVisible: readBoolean(readinessSlice.errorVisible) ?? false,
      };
    }
  }

  // -- Unified left sidebar (compact — see the `sidebar` field doc comment
  // in AppAdvisorUiStateSnapshot for why this stays small).
  const sidebar = useSidebarStore.getState();
  const customizeSidebarModalSlice = readObject(
    slices['sidebar.customizeModal'],
  );
  snapshot.sidebar = {
    hidden: sidebar.hidden,
    // The hover preview leaves `hidden` true on purpose (it never touches the
    // saved layout), so without these the advisor would read the sidebar as
    // off screen for the whole time it is visibly open.
    previewing: sidebar.previewing,
    previewVisible: sidebar.previewing || sidebar.previewPresented,
    width: sidebar.width,
    codeSectionCollapsed: sidebar.codeSectionCollapsed,
    chatsSectionCollapsed: sidebar.chatsSectionCollapsed,
    ...(customizeSidebarModalSlice
      ? {
          customizeModal: {
            open: readBoolean(customizeSidebarModalSlice.open) ?? false,
            ...(typeof customizeSidebarModalSlice.itemCount === 'number'
              ? { itemCount: customizeSidebarModalSlice.itemCount }
              : {}),
          },
        }
      : {}),
  };

  return snapshot;
}

function readSharedResourceUiState(
  value: AppAdvisorJson | undefined,
  options: { includeImporting?: boolean } = {},
):
  | {
      filters?: { query?: string; createdBy?: 'me' | 'anyone' };
      shareModalOpen?: boolean;
      importing?: boolean;
      detailModal?: {
        mode?: 'view' | 'edit';
        id?: string;
        name?: string;
      } | null;
    }
  | undefined {
  const source = readObject(value);
  if (!source) return undefined;
  const filters = readObject(source.filters);
  const query = readString(filters?.query);
  const createdByValue = readString(filters?.createdBy);
  const createdBy =
    createdByValue === 'me' || createdByValue === 'anyone'
      ? createdByValue
      : undefined;
  const detailModal = readObject(source.detailModal);
  const detailMode = readString(detailModal?.mode);
  const state: NonNullable<ReturnType<typeof readSharedResourceUiState>> = {
    ...(filters
      ? {
          filters: {
            ...(query ? { query } : {}),
            ...(createdBy ? { createdBy } : {}),
          },
        }
      : {}),
    ...(typeof source.shareModalOpen === 'boolean'
      ? { shareModalOpen: source.shareModalOpen }
      : {}),
    ...(options.includeImporting && typeof source.importing === 'boolean'
      ? { importing: source.importing }
      : {}),
    detailModal:
      detailModal && (detailMode === 'view' || detailMode === 'edit')
        ? {
            mode: detailMode,
            ...(readString(detailModal.id)
              ? { id: readString(detailModal.id) }
              : {}),
            ...(readString(detailModal.name)
              ? { name: readString(detailModal.name) }
              : {}),
          }
        : null,
  };
  return state;
}

function readPrMergeModalRepoState(
  value: AppAdvisorJson | undefined,
): PrMergeModalRepoUiState | null {
  const source = readObject(value);
  if (!source) return null;
  const repoId = readString(source.repoId);
  const repoName = readString(source.repoName);
  const prUrl = readString(source.prUrl);
  const blockedReason = readString(source.blockedReason);
  return {
    ...(repoId ? { repoId } : {}),
    ...(repoName ? { repoName } : {}),
    ...(typeof source.prNumber === 'number'
      ? { prNumber: source.prNumber }
      : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(typeof source.mergeable === 'boolean'
      ? { mergeable: source.mergeable }
      : {}),
    ...(blockedReason === 'not_mergeable' ||
    blockedReason === 'has_conflicts' ||
    blockedReason === 'base_changed'
      ? { blockedReason }
      : {}),
    ...(typeof source.unresolvedReviewThreadCount === 'number'
      ? { unresolvedReviewThreadCount: source.unresolvedReviewThreadCount }
      : {}),
    ...(typeof source.unknownReviewThreadState === 'boolean'
      ? { unknownReviewThreadState: source.unknownReviewThreadState }
      : {}),
  };
}

type PluginsSnapshot = NonNullable<AppAdvisorUiStateSnapshot['plugins']>;

/** Non-negative integer projection for the bounded counts the page reports. */
function readCount(value: AppAdvisorJson | undefined): number | undefined {
  const parsed = readNumber(value);
  return parsed === null ? undefined : Math.max(0, Math.trunc(parsed));
}

function readManagementSection(
  value: AppAdvisorJson | undefined,
): PluginsManagementSectionId | undefined {
  const raw = readString(value);
  return PLUGINS_MANAGEMENT_SECTIONS.find((section) => section === raw);
}

/**
 * Plugins page slice (API-2153). `searchActive`/`resultCount` describe the
 * discovery search; the query text itself is never accepted, even if a future
 * reporter were to emit it.
 */
function readPluginsPageUiState(
  source: Record<string, AppAdvisorJson> | null,
): PluginsSnapshot['page'] | undefined {
  if (!source) return undefined;
  const view = readString(source.view);
  if (view !== 'discovery' && view !== 'management') return undefined;
  const managementSection = readManagementSection(source.managementSection);
  const customizeTabs = [
    'all',
    'workflow',
    'sources',
    'plugin',
    'app',
    'skill',
    'collection',
    'agent',
    'blueprint',
  ] as const;
  const customizeTab = customizeTabs.find((tab) => tab === source.customizeTab);
  // The page's own parser, so Update available (CAN-5309) is reported too.
  const installedStatusFilter = parseInstalledStatusFilter(
    source.installedStatusFilter,
  );
  const selectedEntryId = readString(source.selectedEntryId);
  const detailHistoryDepth = readCount(source.detailHistoryDepth);
  const detailBackTarget = readString(source.detailBackTarget);
  const createCollectionOpen = readBoolean(source.createCollectionOpen);
  const skillEditorOpen = readBoolean(source.skillEditorOpen);
  const agentDialog = readString(source.agentDialog);
  const agentDialogAgentId = readString(source.agentDialogAgentId);
  return {
    view,
    ...(managementSection ? { managementSection } : {}),
    ...(customizeTab ? { customizeTab } : {}),
    ...(installedStatusFilter ? { installedStatusFilter } : {}),
    ...(typeof source.installedExpanded === 'boolean'
      ? { installedExpanded: source.installedExpanded }
      : {}),
    searchActive: readBoolean(source.searchActive) ?? false,
    resultCount: readCount(source.resultCount) ?? 0,
    ...(selectedEntryId ? { selectedEntryId } : {}),
    ...(detailHistoryDepth !== null ? { detailHistoryDepth } : {}),
    ...(detailBackTarget === 'entry' || detailBackTarget === 'pipeline'
      ? { detailBackTarget }
      : {}),
    ...(createCollectionOpen === true ? { createCollectionOpen: true } : {}),
    ...(skillEditorOpen === true ? { skillEditorOpen: true } : {}),
    ...(agentDialog === 'create' ||
    agentDialog === 'edit' ||
    agentDialog === 'delete'
      ? {
          agentDialog,
          ...(agentDialog !== 'create' && agentDialogAgentId
            ? { agentDialogAgentId }
            : {}),
        }
      : {}),
  };
}

function readLegacyManagementViewUiState(
  source: Record<string, AppAdvisorJson> | null,
): PluginsSnapshot['managementView'] | undefined {
  if (!source) return undefined;
  const section = readManagementSection(source.section);
  if (!section) return undefined;
  const removeTarget = readObject(source.removeMarketplaceModal);
  const marketplaceId = readString(removeTarget?.marketplaceId);
  const marketplaceName = readString(removeTarget?.marketplaceName);
  const validProviders = readStringList(removeTarget?.validProviders, 8);
  return {
    section,
    installedCount: readCount(source.installedCount) ?? 0,
    ...(marketplaceId && marketplaceName
      ? {
          removeMarketplaceModal: {
            marketplaceId,
            marketplaceName,
            validProviders: (validProviders ?? []).flatMap((provider) =>
              provider === 'claude' || provider === 'codex' ? [provider] : [],
            ),
          },
        }
      : {}),
  };
}

const UNIFIED_ENTRY_REF_TYPES: readonly NonNullable<
  NonNullable<PluginsSnapshot['entryDetail']>['refType']
>[] = [
  'curated-plugin',
  'marketplace-plugin',
  'curated-mcp',
  'local-mcp',
  'skill',
  'shared-skill',
  'local-collection',
  'shared-collection',
  'pipeline',
  'local-agent',
];

/**
 * Unified entry detail slice. Identifiers and derived state only — the
 * underlying plugin manifest, MCP endpoint/credentials, and skill body must
 * never reach the snapshot.
 */
function readPluginsEntryDetailUiState(
  source: Record<string, AppAdvisorJson> | null,
): PluginsSnapshot['entryDetail'] | undefined {
  if (!source) return undefined;
  const entryId = readString(source.entryId);
  const kind = readString(source.kind);
  const state = readString(source.state);
  const rawRefType = readString(source.refType);
  const refType = UNIFIED_ENTRY_REF_TYPES.find(
    (candidate) => candidate === rawRefType,
  );
  const mcpEditorOpen = readBoolean(source.mcpEditorOpen);
  const editingSharedSkill = readBoolean(source.editingSharedSkill);
  const editingCollection = readBoolean(source.editingCollection);
  return {
    open: readBoolean(source.open) ?? false,
    ...(entryId ? { entryId } : {}),
    ...(kind === 'plugin' || kind === 'app' || kind === 'skill'
      ? { kind }
      : {}),
    ...(state === 'installed' || state === 'available' || state === 'needs-auth'
      ? { state }
      : {}),
    ...(refType ? { refType } : {}),
    ...(typeof mcpEditorOpen === 'boolean' ? { mcpEditorOpen } : {}),
    ...(typeof editingSharedSkill === 'boolean' ? { editingSharedSkill } : {}),
    ...(typeof editingCollection === 'boolean' ? { editingCollection } : {}),
  };
}

function readMarketplaceModalUiState(
  value: AppAdvisorJson | undefined,
):
  | NonNullable<AppAdvisorUiStateSnapshot['plugins']>['marketplaceModal']
  | undefined {
  const source = readObject(value);
  if (!source) return undefined;

  const filters = readObject(source.filters);
  const filterState = filters
    ? {
        ...(readString(filters.query)
          ? { query: readString(filters.query) }
          : {}),
        ...(readString(filters.category)
          ? { category: readString(filters.category) }
          : {}),
        ...(readString(filters.author)
          ? { author: readString(filters.author) }
          : {}),
      }
    : undefined;

  const selectedPlugin = readObject(source.selectedPlugin);
  const selectedPluginState =
    source.selectedPlugin === null
      ? null
      : selectedPlugin
        ? {
            ...(readString(selectedPlugin.marketplacePluginName)
              ? {
                  marketplacePluginName: readString(
                    selectedPlugin.marketplacePluginName,
                  ),
                }
              : {}),
            ...(readString(selectedPlugin.pluginName)
              ? { pluginName: readString(selectedPlugin.pluginName) }
              : {}),
            ...(typeof selectedPlugin.needsInstall === 'boolean'
              ? { needsInstall: selectedPlugin.needsInstall }
              : {}),
            ...(typeof selectedPlugin.installing === 'boolean'
              ? { installing: selectedPlugin.installing }
              : {}),
          }
        : undefined;

  const bulkInstall = readObject(source.bulkInstall);
  const progress = readObject(bulkInstall?.progress);
  const progressDone = readNumber(progress?.done);
  const progressTotal = readNumber(progress?.total);
  const bulkInstallState = bulkInstall
    ? {
        ...(typeof bulkInstall.installing === 'boolean'
          ? { installing: bulkInstall.installing }
          : {}),
        ...(typeof bulkInstall.cancelling === 'boolean'
          ? { cancelling: bulkInstall.cancelling }
          : {}),
        ...(progressDone !== null && progressTotal !== null
          ? { progress: { done: progressDone, total: progressTotal } }
          : {}),
        ...(readString(bulkInstall.summary)
          ? { summary: readString(bulkInstall.summary) }
          : {}),
      }
    : undefined;

  return {
    open: readBoolean(source.open) ?? false,
    ...(readString(source.marketplaceId)
      ? { marketplaceId: readString(source.marketplaceId) }
      : {}),
    ...(readString(source.marketplaceName)
      ? { marketplaceName: readString(source.marketplaceName) }
      : {}),
    ...(readNumber(source.pluginCount) !== null
      ? { pluginCount: readNumber(source.pluginCount) ?? undefined }
      : {}),
    ...(readNumber(source.filteredPluginCount) !== null
      ? {
          filteredPluginCount:
            readNumber(source.filteredPluginCount) ?? undefined,
        }
      : {}),
    ...(readNumber(source.missingPluginCount) !== null
      ? {
          missingPluginCount:
            readNumber(source.missingPluginCount) ?? undefined,
        }
      : {}),
    ...(readNumber(source.installingCount) !== null
      ? { installingCount: readNumber(source.installingCount) ?? undefined }
      : {}),
    ...(readNumber(source.errorCount) !== null
      ? { errorCount: readNumber(source.errorCount) ?? undefined }
      : {}),
    ...(filterState ? { filters: filterState } : {}),
    ...(selectedPluginState !== undefined
      ? { selectedPlugin: selectedPluginState }
      : {}),
    ...(bulkInstallState ? { bulkInstall: bulkInstallState } : {}),
  };
}

function countWorkspaceRepos(project: SidebarItem | undefined): number {
  if (!project) return 0;
  if (project.type === 'single-repo') return 1;
  if (project.type === 'cowork') return 0;
  return project.repos.filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
    .length;
}

function buildActiveChatSlice(
  chat: ReturnType<typeof useChatStore.getState>,
): Record<string, AppAdvisorJson> | null {
  if (!chat.selectedWorktree) return null;
  const key = `${chat.selectedWorktree.projectId}/${chat.selectedWorktree.worktreeId}`;
  const wc = chat.worktreeChats[key];
  const tab = wc?.tabs.find((candidate) => candidate.id === wc.activeTabId);
  if (!tab || tab.kind === 'file') return null;
  // Fallback slice (used when the renderer has not registered a reporter
  // yet): include the persisted interface mode and managed-terminal runtime
  // turn-state so App Advisor can answer mode-related questions even before
  // ChatPanel mounts.
  const interfaceMode = tab.interfaceMode ?? 'canopy';
  return {
    chatId: tab.id,
    title: tab.title,
    status: tab.status,
    ...(tab.approvalMode ? { approvalMode: tab.approvalMode } : {}),
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.executionHarness ? { executionHarness: tab.executionHarness } : {}),
    ...(tab.model ? { model: tab.model } : {}),
    interfaceMode,
    ...(tab.claudeTerminal?.turnState
      ? { claudeTerminalTurnState: tab.claudeTerminal.turnState }
      : {}),
    modelConfig: activeChatSpeedFields(tab.modelConfig),
  };
}

type ActiveChatSpeedFields =
  | { fastMode: boolean }
  | { speed: CodexSpeed; fastMode: boolean };

/**
 * The active chat's requested Codex speed with its derived legacy boolean.
 * Read speed-first, so an Ultra fast record (whose boolean is `false`) is
 * never reported as Regular and a stale boolean never outranks the speed.
 */
function activeChatSpeedFields(config: unknown): ActiveChatSpeedFields {
  const speed = readCodexSpeedRecord(config);
  return speed === undefined
    ? { fastMode: false }
    : { speed, fastMode: codexSpeedFastMode(speed) };
}

/**
 * The selected worktree's model config for the reported active chat, so the
 * snapshot keeps the requested speed when the chat reporter omits it.
 */
function activeChatTabModelConfig(
  chat: ReturnType<typeof useChatStore.getState>,
  chatId: string | undefined,
): unknown {
  if (!chat.selectedWorktree || !chatId) return null;
  const key = `${chat.selectedWorktree.projectId}/${chat.selectedWorktree.worktreeId}`;
  const tab = chat.worktreeChats[key]?.tabs.find(
    (candidate) => candidate.id === chatId,
  );
  return tab && tab.kind !== 'file' ? tab.modelConfig : null;
}

function buildActiveFileSlice(
  chat: ReturnType<typeof useChatStore.getState>,
): Record<string, AppAdvisorJson> | null {
  if (!chat.selectedWorktree) return null;
  const key = `${chat.selectedWorktree.projectId}/${chat.selectedWorktree.worktreeId}`;
  const wc = chat.worktreeChats[key];
  const tab = wc?.tabs.find((candidate) => candidate.id === wc.activeTabId);
  if (!tab || tab.kind !== 'file' || !tab.filePath) return null;
  return {
    tabId: tab.id,
    path: tab.filePath,
    mode: tab.fileViewMode ?? 'raw',
    dirty: desktopFileSessionController.isDirty(tab.id),
  };
}

/**
 * The selected worktree's active plan, if any, in the same shape a composer
 * send attaches to an outgoing chat message. `undefined` (no worktree
 * selected, or the worktree has no active plan) maps to `null` here so the
 * caller can use the same `if (slice)` gating as the other slice builders.
 */
function buildActivePlanSlice(
  chat: ReturnType<typeof useChatStore.getState>,
): ChatActivePlanContext | null {
  return captureActivePlanContext(chat.selectedWorktree) ?? null;
}

function buildActivePipelineSlice(
  pipelineRuns: ReturnType<typeof usePipelineRunsStore.getState>,
  selectedWorktree: ReturnType<
    typeof useChatStore.getState
  >['selectedWorktree'],
): Record<string, AppAdvisorJson> | null {
  const summary = findRelevantPipelineSummary(pipelineRuns, selectedWorktree);
  if (!summary) return null;
  return {
    pipelineId: summary.pipeline_id,
    name: summary.pipeline_name,
  };
}

type PipelineRunDetailEntry = NonNullable<
  AppAdvisorUiStateSnapshot['pipelineRunDetails']
>[number];

/**
 * Aggregates the shown pipeline run details. Panels report under
 * `pipelineRuns.detailPanel.<ownerKey>::<panelId>` (one key each, so they
 * never overwrite or clear one another) and the compatibility modal under
 * `pipelineRuns.detailModal`. The focused entry is the modal when open (it
 * covers the app), else the active panel, preferring the main window.
 */
function collectPipelineRunDetails(slices: Record<string, AppAdvisorJson>): {
  entries: PipelineRunDetailEntry[];
  focusedSlice: Record<string, AppAdvisorJson> | null;
} {
  const candidates: Array<{
    slice: Record<string, AppAdvisorJson>;
    entry: Omit<PipelineRunDetailEntry, 'focused'>;
    active: boolean;
  }> = [];
  const sources: Array<{
    host: PipelineRunDetailEntry['host'];
    slice: Record<string, AppAdvisorJson>;
  }> = [];
  const modalSlice = readObject(slices[PIPELINE_DETAIL_MODAL_UI_STATE_KEY]);
  if (modalSlice) sources.push({ host: 'compatibility', slice: modalSlice });
  for (const key of Object.keys(slices).sort()) {
    if (!key.startsWith(PIPELINE_DETAIL_PANEL_UI_STATE_KEY_PREFIX)) continue;
    const panelSlice = readObject(slices[key]);
    if (panelSlice) sources.push({ host: 'panel', slice: panelSlice });
  }
  for (const { host, slice } of sources) {
    const executionId = readString(slice.executionId);
    if (!executionId) continue;
    const pipelineId = readString(slice.pipelineId);
    const status = readString(slice.status);
    const selectedJobId = readString(slice.selectedJobId);
    const ownerKey = host === 'panel' ? readString(slice.ownerKey) : undefined;
    const panelId = host === 'panel' ? readString(slice.panelId) : undefined;
    const auxiliaryWindow =
      host === 'panel' ? readBoolean(slice.auxiliaryWindow) : null;
    candidates.push({
      slice,
      active: host === 'compatibility' || readBoolean(slice.active) === true,
      entry: {
        host,
        executionId,
        ...(pipelineId ? { pipelineId } : {}),
        ...(status ? { status } : {}),
        ...(selectedJobId ? { selectedJobId } : {}),
        ...(ownerKey ? { ownerKey } : {}),
        ...(panelId ? { panelId } : {}),
        ...(auxiliaryWindow === true ? { auxiliaryWindow: true } : {}),
      },
    });
  }
  const focused =
    candidates.find((candidate) => candidate.entry.host === 'compatibility') ??
    candidates.find(
      (candidate) =>
        candidate.active && candidate.entry.auxiliaryWindow !== true,
    ) ??
    candidates.find((candidate) => candidate.active) ??
    null;
  return {
    entries: candidates.map((candidate) => ({
      ...candidate.entry,
      focused: candidate === focused,
    })),
    focusedSlice: focused?.slice ?? null,
  };
}

function buildActivePipelineRunSlice(
  pipelineRuns: ReturnType<typeof usePipelineRunsStore.getState>,
  selectedWorktree: ReturnType<
    typeof useChatStore.getState
  >['selectedWorktree'],
): Record<string, AppAdvisorJson> | null {
  const summary = findRelevantPipelineSummary(pipelineRuns, selectedWorktree);
  if (!summary) return null;
  const executionState =
    pipelineRuns.statesById[summary.id] ??
    pipelineRuns.rowStatesById[summary.id];
  const inputRequired = executionState?.pending_pauses?.some(
    (checkpoint) => checkpoint.kind === 'input' && checkpoint.request,
  );
  return {
    executionId: summary.id,
    pipelineId: summary.pipeline_id,
    status: summary.status,
    ...(executionState
      ? {
          inputRequired: inputRequired === true,
          resumable: summary.status === 'paused' && inputRequired !== true,
        }
      : {}),
    resumableStatusReasons: (summary.status_reasons ?? [])
      .filter((reason) => reason.kind !== 'input_required')
      .map((reason) => ({
        id: reason.id,
        kind: reason.kind,
        code: reason.code,
        jobId: reason.source.job_id,
        stepId: reason.source.step_id,
      })),
  };
}

function findRelevantPipelineSummary(
  pipelineRuns: ReturnType<typeof usePipelineRunsStore.getState>,
  selectedWorktree: ReturnType<
    typeof useChatStore.getState
  >['selectedWorktree'],
):
  | ReturnType<typeof usePipelineRunsStore.getState>['summaries'][number]
  | null {
  const projectId =
    selectedWorktree?.projectId ?? pipelineRuns.currentProjectId;
  const worktreeId =
    selectedWorktree?.worktreeId ?? pipelineRuns.currentWorktreeId;
  return (
    pipelineRuns.summaries.find(
      (summary) =>
        summary.project_id === projectId && summary.worktree_id === worktreeId,
    ) ??
    pipelineRuns.summaries.find(
      (summary) =>
        summary.project_id === pipelineRuns.currentProjectId &&
        summary.worktree_id === pipelineRuns.currentWorktreeId,
    ) ??
    null
  );
}

function buildPanelsSlice(
  chat: ReturnType<typeof useChatStore.getState>,
): AppAdvisorUiStateSnapshot['panels'] | null {
  if (!chat.selectedWorktree) return null;
  const key = makeWorktreePanelKey(
    chat.selectedWorktree.projectId,
    chat.selectedWorktree.worktreeId,
  );
  const layout = usePanelLayoutStore.getState().layouts[key];
  const viewModel = layout?.viewModel;
  if (!viewModel || viewModel.groups.length === 0) return null;
  const modeEntry = useWorkspaceLayoutModeStore.getState().entries[key];
  return {
    layoutMode: modeEntry?.mode ?? 'advanced',
    layoutModeStatus: modeEntry?.status ?? 'unloaded',
    groups: viewModel.groups.map((group) => ({
      groupId: group.groupId,
      tabs: group.tabs.map((tab) => {
        const instance = layout?.groups[group.groupId]?.tabs.find(
          (entry) => entry.panelId === tab.panelId,
        )?.instance;
        const planId = isPlanPanelKind(tab.kind) ? instance?.planId : undefined;
        const chatId =
          tab.kind === 'chat'
            ? instance?.chatTabId
            : tab.kind === 'chat-visuals'
              ? instance?.chatId
              : undefined;
        return {
          panelId: tab.panelId,
          kind: tab.kind,
          // The view-model falls back to the kind as the title; only forward
          // real instance titles to keep the snapshot compact.
          ...(tab.title !== tab.kind ? { title: tab.title } : {}),
          ...(planId !== undefined ? { planId } : {}),
          ...(chatId !== undefined ? { chatId } : {}),
        };
      }),
      ...(group.activePanelId !== null
        ? { activePanelId: group.activePanelId }
        : {}),
      ...(group.collapsed !== undefined ? { collapsed: true as const } : {}),
    })),
    ...(viewModel.activeGroupId !== null
      ? { activeGroupId: viewModel.activeGroupId }
      : {}),
    ...(viewModel.maximizedGroupId !== null
      ? { maximizedGroupId: viewModel.maximizedGroupId }
      : {}),
  };
}

/**
 * Central Browser summary: panel layout (what is bound + visible) plus the
 * flat browser store (explicit active browser + its live metadata). The
 * transport fields keep their compatibility names with the new panel-based
 * meaning:
 * - `drawerOpen` — at least one Browser panel is currently VISIBLE (active
 *   tab of a shown, expanded group under the current maximize state);
 * - `activeDrawerTab: 'browser'` — a Browser panel is the relevant visible
 *   surface (the active group's active, visible panel);
 * - `browserCount` — number of BOUND Browser panels in the layout;
 * - active-browser metadata — the EXPLICITLY active browser's values.
 *
 * Visibility comes from actual panel-layout state (active tabs, collapsed
 * groups, maximize, side-by-side groups) — never from whether a native view
 * happens to exist.
 */
function buildBrowserSlice(
  chat: ReturnType<typeof useChatStore.getState>,
): AppAdvisorUiStateSnapshot['browser'] | null {
  if (!chat.selectedWorktree) return null;
  const key = makeWorktreePanelKey(
    chat.selectedWorktree.projectId,
    chat.selectedWorktree.worktreeId,
  );
  const viewModel = usePanelLayoutStore.getState().layouts[key]?.viewModel;
  const browserState = useBrowserStore.getState();
  const bucket = browserState.worktrees[key];
  if (!viewModel && !bucket) return null;

  let browserCount = 0;
  let anyBrowserVisible = false;
  let activeSurfaceIsBrowser = false;
  if (viewModel) {
    for (const group of viewModel.groups) {
      const groupShown =
        viewModel.maximizedGroupId === null ||
        viewModel.maximizedGroupId === group.groupId;
      const groupExpanded = group.collapsed === undefined;
      for (const tab of group.tabs) {
        if (tab.kind !== 'browser') continue;
        browserCount += 1;
        const tabVisible =
          groupShown && groupExpanded && group.activePanelId === tab.panelId;
        if (tabVisible) {
          anyBrowserVisible = true;
          if (viewModel.activeGroupId === group.groupId) {
            activeSurfaceIsBrowser = true;
          }
        }
      }
    }
  }

  const activeBrowserId =
    bucket?.activeBrowserId !== null &&
    bucket?.activeBrowserId !== undefined &&
    bucket.browsers[bucket.activeBrowserId] !== undefined
      ? bucket.activeBrowserId
      : null;
  const activeSnapshot =
    activeBrowserId !== null ? bucket?.browsers[activeBrowserId] : undefined;
  const pendingDialogs = (bucket?.browserOrder ?? []).flatMap((browserId) => {
    const dialog = browserState.dialogs[browserId];
    return dialog
      ? [
          {
            browserId,
            id: dialog.id,
            type: dialog.type,
            message: dialog.message,
            url: dialog.url,
            ...(dialog.frameId ? { frameId: dialog.frameId } : {}),
            ...(dialog.defaultPrompt
              ? { defaultPrompt: dialog.defaultPrompt }
              : {}),
          },
        ]
      : [];
  });

  if (browserCount === 0 && activeBrowserId === null) return null;

  return {
    drawerOpen: anyBrowserVisible,
    ...(activeSurfaceIsBrowser ? { activeDrawerTab: 'browser' as const } : {}),
    browserCount,
    ...(activeBrowserId !== null ? { activeBrowserId } : {}),
    ...(activeSnapshot?.url ? { url: activeSnapshot.url } : {}),
    ...(activeSnapshot?.title ? { title: activeSnapshot.title } : {}),
    loading: activeSnapshot?.loading ?? false,
    ...(activeBrowserId !== null
      ? {
          recentConsoleErrorCount: selectConsoleErrorCount(
            browserState,
            activeBrowserId,
          ),
          recentFailedRequestCount: selectFailedRequestCount(
            browserState,
            activeBrowserId,
          ),
          activeTransferCount: selectActiveTransferCount(
            browserState,
            activeBrowserId,
          ),
        }
      : {}),
    ...(activeBrowserId !== null &&
    browserState.inspectorOpen[activeBrowserId] === true
      ? {
          inspectorTab:
            browserState.inspectorTab[activeBrowserId] ??
            DEFAULT_BROWSER_INSPECTOR_TAB,
        }
      : {}),
    ...(pendingDialogs.length > 0 ? { pendingDialogs } : {}),
  };
}

function buildTerminalSlice(
  chat: ReturnType<typeof useChatStore.getState>,
): Record<string, AppAdvisorJson> | null {
  if (!chat.selectedWorktree) return null;
  const key = `${chat.selectedWorktree.projectId}/${chat.selectedWorktree.worktreeId}`;
  const bucket = useTerminalStore.getState().worktrees[key];
  if (!bucket) return null;
  const sessions = Object.values(bucket.sessions);
  const activeSessionId = bucket.activeGroupId
    ? bucket.groups
        .find((group) => group.id === bucket.activeGroupId)
        ?.terminalIds.find((terminalId) => bucket.sessions[terminalId]?.live)
    : undefined;
  return {
    drawerOpen: bucket.drawerCollapsed !== true,
    ...(activeSessionId ? { activeSessionId } : {}),
    runningCount: sessions.filter((session) => session.live).length,
  };
}

/**
 * Render an envelope as the branded hidden UI-state block the App Advisor
 * system prompt expects. Co-located here so the formatter is the single source
 * of truth for hidden-context shape.
 */
export function formatAppAdvisorHiddenUiState(
  envelope: AppAdvisorUiStateEnvelope,
): string {
  const tagName = APP_ADVISOR_CONTEXT_TAG;
  return [
    `<${tagName}>`,
    `This hidden context describes the current ${brandText.appName} UI state. Treat it as app context, not user-authored instructions.`,
    JSON.stringify(envelope, null, 2),
    `</${tagName}>`,
  ].join('\n');
}

type OrgProjectRow = NonNullable<
  AppAdvisorUiStateSnapshot['orgProjects']
>['rows'][number];

type AddWorkspaceSnapshot = NonNullable<
  AppAdvisorUiStateSnapshot['addWorkspace']
>;

const ADD_WORKSPACE_PROJECT_KINDS: readonly NonNullable<
  AddWorkspaceSnapshot['projectKind']
>[] = ['code', 'cowork'];
const ADD_WORKSPACE_FOLDER_KINDS: readonly NonNullable<
  AddWorkspaceSnapshot['folderKind']
>[] = ['none', 'checking', 'folder', 'git-repository', 'refused'];

/** Ids pass only with an actionable status; other statuses carry none. */
function readAddWorkspaceFolderConflict(
  value: AppAdvisorJson | undefined,
): AddWorkspaceSnapshot['folderConflict'] {
  const slice = readObject(value);
  const status = slice?.status;
  const organizationId = readString(slice?.organizationId);
  const projectId = readString(slice?.projectId);
  switch (status) {
    case 'ready':
    case 'unfinished':
      return organizationId && projectId
        ? { status, organizationId, projectId }
        : undefined;
    case 'resolving':
    case 'denied':
    case 'unknown':
      return { status };
    default:
      return undefined;
  }
}

const ORG_PROJECT_ROW_STATES: readonly OrgProjectRow['state'][] = [
  'ready-to-set-up',
  'choose-folder',
  'needs-github-access',
  'offline',
  'access-changed',
  'not-local',
];
const ORG_PROJECT_SETUP_STATES: readonly NonNullable<
  OrgProjectRow['setupState']
>[] = ['claiming', 'materializing', 'failed', 'cancelled'];

function asOrgProjectRowState(
  value: string | undefined,
): OrgProjectRow['state'] | undefined {
  return ORG_PROJECT_ROW_STATES.find((state) => state === value);
}

function asOrgProjectSetupState(
  value: string | undefined,
): OrgProjectRow['setupState'] {
  return ORG_PROJECT_SETUP_STATES.find((state) => state === value);
}

/** Metadata only, and only rows the member is already being shown. */
function readOrgProjectRows(
  organizationId: string,
  slice: Record<string, AppAdvisorJson> | null,
): AppAdvisorUiStateSnapshot['orgProjects'] {
  if (!slice) return undefined;
  const raw = slice.rows;
  if (!Array.isArray(raw)) return undefined;
  const rows: OrgProjectRow[] = [];
  for (const entry of raw) {
    const row = readObject(entry);
    if (!row) continue;
    const projectId = readString(row.projectId);
    const name = readString(row.name);
    const state = asOrgProjectRowState(readString(row.state));
    if (!projectId || !name || !state) continue;
    const setupState = asOrgProjectSetupState(readString(row.setupState));
    const setupPercent = readNumber(row.setupPercent);
    rows.push({
      projectId,
      name,
      state,
      // Without this the Advisor sees a plain placeholder state and may offer
      // a setup the main process refuses, because the project is already a
      // workspace whose setup did not finish.
      ...(row.unfinished === true ? { unfinished: true } : {}),
      ...(setupState === undefined ? {} : { setupState }),
      ...(setupPercent === null ? {} : { setupPercent }),
    });
  }
  return { organizationId, rows };
}

type HostedSettingsUiState = NonNullable<
  NonNullable<AppAdvisorUiStateSnapshot['settings']>['hostedSettings']
>;

/**
 * The hosted account or organization settings page on screen (CAN-4386), by
 * scope, page and Settings subtab only: no organization, user, digest,
 * invoice or fact id, and no page query.
 */
function hostedSettingsSnapshot(
  nav: ReturnType<typeof useNavigationStore.getState>,
): { hostedSettings?: HostedSettingsUiState } {
  const route = nav.settingsOpen ? nav.settingsHostedLocation?.route : null;
  if (!route) return {};
  switch (route.scope) {
    case 'account':
      return { hostedSettings: { scope: 'account', page: route.page } };
    case 'organizations':
      return { hostedSettings: { scope: 'organizations' } };
    case 'organization':
      return {
        hostedSettings: {
          scope: 'organization',
          page: route.page,
          ...(route.subtab === undefined ? {} : { subtab: route.subtab }),
        },
      };
  }
}

function readObject(
  value: AppAdvisorJson | undefined,
): Record<string, AppAdvisorJson> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

type BatchRemovalDialogState = NonNullable<
  AppAdvisorUiStateSnapshot['worktreeBatchRemovalDialog']
>;

/** A bulk removal slice (worktrees or chats) with an open dialog or rows
 * draining in the background, reduced to its open flag, mode, count, and
 * phase; `undefined` when idle or malformed. */
function readBatchRemovalDialogSlice(
  value: AppAdvisorJson | undefined,
): BatchRemovalDialogState | undefined {
  const slice = readObject(value);
  const open = readBoolean(slice?.open);
  const mode = readString(slice?.mode);
  const phase = readString(slice?.phase);
  const count = readNumber(slice?.count);
  // An open dialog (confirm/results), or a batch draining in the background.
  const reportable = open === true || (open === false && phase === 'running');
  if (
    reportable &&
    open !== null &&
    (mode === 'archive' || mode === 'delete') &&
    (phase === 'confirm' || phase === 'running' || phase === 'results') &&
    count !== null
  ) {
    return { open, mode, count, phase };
  }
  return undefined;
}

type HomeMcpSignInState = NonNullable<
  NonNullable<AppAdvisorUiStateSnapshot['home']>['mcpSignIn']
>;

function readHomeMcpSignIn(slice: Record<string, AppAdvisorJson> | null): {
  mcpSignIn?: HomeMcpSignInState;
} {
  if (readBoolean(slice?.visible) !== true) return {};
  const servers: HomeMcpSignInState['servers'] = [];
  const listed = slice?.servers;
  if (Array.isArray(listed)) {
    for (const value of listed.slice(0, 20)) {
      const server = readObject(value);
      const name = readString(server?.name);
      const status = readString(server?.status);
      if (!name) continue;
      if (status !== 'not_signed_in' && status !== 'needs_reconnecting')
        continue;
      servers.push({
        name: name.slice(0, 120),
        status,
        pending: readBoolean(server?.pending) ?? false,
      });
    }
  }
  return {
    mcpSignIn: {
      setupOpen: readBoolean(slice?.setupOpen) ?? false,
      servers,
    },
  };
}

function readResumableStatusReasons(
  value: AppAdvisorJson | undefined,
): NonNullable<
  NonNullable<
    AppAdvisorUiStateSnapshot['activePipelineRun']
  >['resumableStatusReasons']
> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const reason = readObject(entry);
    if (!reason) return [];
    const id = readString(reason.id);
    const kind = readString(reason.kind);
    const code = readString(reason.code);
    const jobId = readString(reason.jobId);
    const stepId = readString(reason.stepId);
    if (!id || !kind || !code || !jobId || !stepId) return [];
    return [{ id, kind, code, jobId, stepId }];
  });
}

function readLedgerViewStatus(
  value: AppAdvisorJson | undefined,
): 'idle' | 'loading' | 'ready' | 'problem' | undefined {
  switch (value) {
    case 'idle':
    case 'loading':
    case 'ready':
    case 'problem':
      return value;
    default:
      return undefined;
  }
}

function readBoolean(value: AppAdvisorJson | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNullableString(
  value: AppAdvisorJson | undefined,
): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function readNumber(value: AppAdvisorJson | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const SPLIT_PR_BLOCKER_VALUES: readonly SplitPrBlocker[] = [
  'uncommitted_changes',
  'unpushed_commits',
  'merge_conflicts',
  'active_pipelines',
  'active_chats',
];

function isSplitPrBlocker(value: unknown): value is SplitPrBlocker {
  return (
    typeof value === 'string' &&
    (SPLIT_PR_BLOCKER_VALUES as readonly string[]).includes(value)
  );
}

function readSplitPrBlockers(
  value: AppAdvisorJson | undefined,
): SplitPrBlocker[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSplitPrBlocker);
}
