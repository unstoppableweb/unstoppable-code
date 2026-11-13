import {
  Stack,
  Button,
  DelayedLoadingPlaceholder,
  Disclosure,
  Heading,
  SegmentedControl,
  type SegmentedControlOption,
  Skeleton,
  Surface,
} from '@canopy/ui-shared/components';
import { resolveHookComposerContext } from '@/lib/configurationComposerTargets';
import {
  offerLifecycleJournalQuarantine,
  offerProjectDeletionDiscard,
} from '@canopy/app-state';
import {
  ChoiceField,
  ErrorBanner,
  FormField,
  Notice,
  NoticeButton,
  PluginSelectionScopeHelp,
  Badge,
  EmptyStateRow,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  normalizeScriptName,
  type CommandShellDefinition,
  type WorkspaceRootLifecycleScriptName,
} from '@canopy/desktop-shared/scripts';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  createEditableHooks,
  toHookInputMap,
  serializeHooks,
  type EditableHooks,
} from '@/lib/editableHooks';
import type {
  ChatTabPluginSelections,
  GitHubRepoSummary,
  MultiRepoSidebarItem,
  RepoSelection,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import { getDefaultWorkspaceClaudeMd } from '@canopy/desktop-shared/constants/workspace-templates';
import { EMPTY_SELECTIONS, normalizeSelections } from '@/lib/pluginSelections';
import {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  isArchiveRetentionDraftDirty,
  toArchiveRetentionDraft,
  toPersistedArchiveRetentionDays,
  type ArchiveRetentionDraft,
} from '@/lib/archiveRetentionSettings';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import {
  extractIpcErrorMessage,
  detailsFor,
  failureDetails,
  type FailureDetails,
} from '@/lib/errors';
import {
  createEditableScripts,
  getEditableCustomScripts,
  getEditableScriptDevServerPatterns,
  getEditableScriptInteractive,
  getEditableScriptShell,
  getEditableScriptTimeoutSeconds,
  getEditableScriptValue,
  removeEditableScript,
  setEditableScriptDevServerPatterns,
  setEditableScriptInteractive,
  setEditableScriptShell,
  setEditableScriptTimeoutSeconds,
  setEditableScriptValue,
  toScriptInputMap,
  type EditableDevServerPattern,
  type EditableScript,
  type EditableScripts,
} from '@/lib/editableScripts';
import { useProjectsStore, TeardownFailedError } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import {
  getWorkspaceRemovalBlocker,
  removalBlockedReason,
  recheckWorkspaceRemovalBlockedReason,
} from '@/stores/chat/close-guard';
import { useDelegationActivityStore } from '@/stores/delegationActivityStore';
import { useLiveBackgroundTaskStore } from '@/stores/liveBackgroundTaskStore';
import { useGitHubStore } from '@/stores/githubStore';
import { HookActionEditor } from './HookActionEditor';
import { ScriptConfigEditor } from './ScriptConfigEditor';
import { ScriptActionsSettingsSection } from '../script-actions/ScriptActionsSettingsSection';
import { CopyButton, DialogModal, GitHubRepoPicker } from '../shared';
import {
  AutoArchiveSettingsControl,
  PrivateMemoryCard,
} from '@canopy/ui-shared';
import { usePrivateMemoryDraft } from '@/hooks/usePrivateMemoryDraft';
import { useGitHubPermissions } from '@/hooks/useGitHubPermissions';
import { PluginSelector } from '../shared/PluginSelector';
import { ShareablePluginSelector } from '../shared/ShareablePluginSelector';
import { RecommendedPluginsSettingsPanel } from './RecommendedPluginsSettingsPanel';
import { ClaudeLogo } from '../ClaudeLogo';
import {
  AddToWorktreeActionControls,
  AlwaysShowWorkspaceCard,
  HOOK_SETTINGS_ICON,
  SaveLocalButton,
  SCRIPT_SETTINGS_ICON,
  SettingsDangerConfirmBlock,
  SettingsDirectoryCard,
  SettingsTabBar,
  SettingsTeardownFailureDialog,
  SourceLocalToggle,
  SourceWorktreePicker,
  WorkspaceHealthIssuesBlock,
} from './WorktreeSettingsControls';
import {
  serializeEditableScriptsForSettings,
  useDefaultScriptTimeoutSeconds,
  useWorkspaceSettingsData,
  type AddToWorktreeFeedback,
} from './worktree-settings-controls-state';
import {
  PlanModeIcon,
  PluginsIcon,
  RepoIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { WorkspaceEnvironmentTab } from './WorkspaceEnvironmentTab';
import { ExistingRepoOption } from './ExistingRepoOption';
import {
  orgRepositoryRefusal,
  repositoryNameFromUrl,
  useOrgRepositoryEligibility,
  type OrgRepositoryCandidate,
} from './orgRepositoryEligibility';
import { WorkspacePlanDetectionSection } from './WorkspacePlanDetectionSection';
import { CodeGraphSummaryPanel } from './CodeGraphSummaryPanel';
import { GraphIcon } from '@canopy/ui-shared/icons';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCodeGraphExperimentEnabled } from '@/hooks/useCodeGraphExperimentEnabled';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { WorkspaceReadinessRecommendations } from './WorkspaceReadinessRecommendations';
import { resolveWorkspaceReadinessWorktreeId } from '@/lib/workspaceReadinessLauncher';
import { useCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import { CodeStartPageSettings } from '../settings/start-page/CodeStartPageSettings';
import type { StartPageSettingsIntent } from '@/stores/navigationStore';

type AddRepoStep = 'list' | 'add-repo';
type AddRepoMode = 'existing' | 'browse' | 'remote';
type RemoteSource = 'github' | 'url';

const REMOTE_SOURCE_OPTIONS: readonly SegmentedControlOption<RemoteSource>[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'url', label: 'URL' },
];
type RepoFetchState = 'idle' | 'loading' | 'loaded' | 'error';
type ClaudeMdLoadState = 'loading' | 'ready' | 'failed';
type WorkspaceTab =
  | 'details'
  | 'repositories'
  | 'scripts'
  | 'hooks'
  | 'plan-detection'
  | 'claude-md'
  | 'plugins'
  | 'environment'
  | 'code-graph'
  | 'start-page'
  | 'danger';

const tabs: {
  id: WorkspaceTab;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
}[] = [
  { id: 'details', label: 'General' },
  { id: 'repositories', label: 'Repositories', icon: <RepoIcon /> },
  { id: 'scripts', label: 'Scripts', icon: SCRIPT_SETTINGS_ICON },
  { id: 'hooks', label: 'Hooks', icon: HOOK_SETTINGS_ICON },
  {
    id: 'plan-detection',
    label: 'Plans',
    icon: <PlanModeIcon size="sm" />,
  },
  {
    id: 'claude-md',
    label: 'Instructions',
    icon: <ClaudeLogo width={14} height={14} />,
  },
  { id: 'plugins', label: 'Plugins', icon: <PluginsIcon /> },
  { id: 'environment', label: 'Environment' },
  { id: 'start-page', label: 'Start page' },
  { id: 'danger', label: 'Danger', danger: true },
];

interface WorkspaceSettingsModalProps {
  onOpenSharedDestination?: (workspaceId: string) => void;
  isOpen: boolean;
  onClose: () => void;
  workspace: MultiRepoSidebarItem;
  initialTab?: WorkspaceTab;
  driftWorktreeId?: string;
  startPageIntent?: StartPageSettingsIntent;
  onDelete?: (workspaceId: string) => void;
}

interface PendingWorkspaceAdd {
  name: string;
  repoPath: string;
  addToSourceControl: boolean;
  canAddToSourceControl: boolean;
  sourceControlNote?: string;
}

interface ExistingRepoSourceControlState {
  canAddToSourceControl: boolean;
  remoteUrl?: string;
  sourceControlNote?: string;
}

function scheduleAfterClosePaint(callback: () => void): void {
  window.requestAnimationFrame(() => {
    window.setTimeout(callback, 0);
  });
}

function serializeScripts(scripts: EditableScripts): string {
  return serializeEditableScriptsForSettings(toScriptInputMap(scripts));
}

/**
 * Stable serializer for `ShareablePluginRef[]` arrays. Sorts canonical keys
 * before joining so two arrays with the same refs (in any order) compare
 * equal — used to drive the source-controlled plugin dirty-flag.
 */
function serializeShareablePluginRefs(refs: ShareablePluginRef[]): string {
  const keys: string[] = [];
  for (const ref of refs) {
    try {
      keys.push(getShareablePluginRefKey(ref));
    } catch {
      // Malformed refs cannot round-trip; ignore them in the comparison.
    }
  }
  keys.sort();
  return keys.join('|');
}

const WORKSPACE_ROOT_SCRIPT_PLACEHOLDERS: Record<
  WorkspaceRootLifecycleScriptName,
  string
> = {
  'before-setup': '# Runs before repo setup scripts\nnpm install',
  'after-setup': '# Runs after repo setup scripts\nnpm run build',
  'before-launch': '# Runs before repo launch scripts\nnpm run prepare',
  'after-launch': '# Runs after repo launch scripts\nnpm run dev',
  'before-teardown': '# Runs before repo teardown scripts\nnpm run stop',
  'after-teardown': '# Runs after repo teardown scripts\nnpm run clean',
};

const WORKSPACE_ROOT_CUSTOM_SCRIPT_PLACEHOLDER =
  '# Triggered manually from the project root\nnpm run lint';

function getInitialWorkspaceTab(
  initialTab: WorkspaceSettingsModalProps['initialTab'],
): WorkspaceTab {
  return initialTab ?? 'repositories';
}

function getWorkspaceRootScriptPlaceholder(
  scriptName: WorkspaceRootLifecycleScriptName,
): string {
  return WORKSPACE_ROOT_SCRIPT_PLACEHOLDERS[scriptName];
}

const noop = (): void => undefined;

/** Sample setup scripts the loading skeleton lays out as the script editors. */
const SAMPLE_SOURCE_SCRIPTS = [
  {
    label: 'Before setup',
    scriptName: 'before-setup',
    command: 'pnpm install',
  },
  {
    label: 'After setup',
    scriptName: 'after-setup',
    command: 'pnpm run build',
  },
] as const;

/** Sample timeout the skeleton's script editors show. */
const SAMPLE_SCRIPT_TIMEOUT_SECONDS = 300;

/**
 * The source-controlled scripts while canopy.json loads: the "Project root"
 * box and its script editors, rendered from sample scripts.
 */
function SourceScriptsSkeleton(): JSX.Element {
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading scripts…">
      <Skeleton
        loading
        label="Loading scripts"
        testId="workspace-settings-scripts-loading"
      >
        <Surface variant="outline" padding="compact" gap="item">
          <Heading level={4} variant="title">
            Project root
          </Heading>
          {SAMPLE_SOURCE_SCRIPTS.map((sample) => (
            <ScriptConfigEditor
              key={sample.scriptName}
              label={sample.label}
              scriptName={sample.scriptName}
              command={sample.command}
              onCommandChange={noop}
              onTimeoutSecondsChange={noop}
              rows={3}
              defaultTimeoutSeconds={SAMPLE_SCRIPT_TIMEOUT_SECONDS}
            />
          ))}
        </Surface>
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

/**
 * The source-controlled hooks while canopy.json loads: the "Project root"
 * box and the add-action form the hook editor opens with, built from the
 * same field primitives (the editor itself needs live chat context).
 */
function SourceHooksSkeleton(): JSX.Element {
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading hooks…">
      <Skeleton
        loading
        label="Loading hooks"
        testId="workspace-settings-hooks-loading"
      >
        <Surface variant="outline" padding="compact" gap="item">
          <Heading level={4} variant="title">
            Project root
          </Heading>
          <Surface variant="dashed" padding="compact" gap="inline">
            <p className="text-s font-medium fg-primary">Add hook action</p>
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label="Trigger">
                {(control) => (
                  <TextInput
                    {...control}
                    density="settings"
                    value="Pull request opened"
                    onChange={noop}
                  />
                )}
              </FormField>
              <FormField label="Action type">
                {(control) => (
                  <TextInput
                    {...control}
                    density="settings"
                    value="Start a chat"
                    onChange={noop}
                  />
                )}
              </FormField>
            </div>
          </Surface>
        </Surface>
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

/**
 * The source-controlled plugin recommendations while canopy.json loads: the
 * selector's helper line. The plugin table below it keeps its own loading
 * state once the selector mounts.
 */
function SourcePluginsSkeleton({
  helperText,
}: {
  helperText: string;
}): JSX.Element {
  return (
    <DelayedLoadingPlaceholder slowNote="Still loading plugins…">
      <Skeleton
        loading
        label="Loading plugins"
        testId="workspace-settings-plugins-loading"
      >
        <p className="px-6 pt-3 text-xs fg-secondary">{helperText}</p>
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

const SOURCE_PLUGINS_HELPER_TEXT =
  'These recommendations are saved to canopy.json. They are offered when worktrees or scoped child-repo chats are created, but they do not change local chat defaults until a user applies them.';

export function WorkspaceSettingsModal({
  isOpen,
  onClose,
  workspace,
  initialTab,
  driftWorktreeId,
  startPageIntent,
  onDelete,
}: WorkspaceSettingsModalProps): JSX.Element | null {
  const addRepoToWorkspace = useProjectsStore(
    (state) => state.addRepoToWorkspace,
  );
  const removeRepoFromWorkspace = useProjectsStore(
    (state) => state.removeRepoFromWorkspace,
  );
  const projects = useProjectsStore((state) => state.projects);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const archiveWorktree = useProjectsStore((state) => state.archiveWorktree);
  const forceArchiveWorktree = useProjectsStore(
    (state) => state.forceArchiveWorktree,
  );
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const privateMemory = usePrivateMemoryDraft(workspace);
  const resetPrivateMemory = privateMemory.reset;
  const hasActiveWorktrees = useChatSidebarStore((state) =>
    workspace.worktrees.some((wt) => {
      const wc = state.worktrees[`${workspace.id}/${wt.id}`];
      return wc?.tabs.some((tab) => tab.status === 'streaming') ?? false;
    }),
  );
  const delegationByChat = useDelegationActivityStore((state) => state.byChat);
  const providerTasksByChat = useLiveBackgroundTaskStore(
    (state) => state.byChat,
  );
  const removalDisabledReason = removalBlockedReason(
    getWorkspaceRemovalBlocker(
      workspace.id,
      { byChat: delegationByChat },
      { byChat: providerTasksByChat },
    ),
  );

  const [activeTab, setActiveTab] = useState<WorkspaceTab>(() =>
    getInitialWorkspaceTab(initialTab),
  );
  useCurrentUiStateReporter(
    'workspaceSettings.modal',
    isOpen
      ? {
          open: true,
          workspaceId: workspace.id,
          workspaceType: 'multi-repo',
          activeTab,
        }
      : null,
  );
  const codeGraphExperimentEnabled = useCodeGraphExperimentEnabled();
  const startPageEnabled = useCanopyDesktopStartPageEnabled();

  // Insert the flag-gated Code Graph tab before Danger without mutating the
  // shared base tab list. The tab-list filter must not reset unrelated active
  // tabs when the flag snapshot updates — only a runtime flag-off while the
  // Code Graph tab itself is active moves the user back to General (below).
  const visibleTabs = useMemo(() => {
    const enabledTabs = startPageEnabled
      ? tabs
      : tabs.filter((tab) => tab.id !== 'start-page');
    if (!codeGraphExperimentEnabled) return enabledTabs;
    const codeGraphTab: (typeof tabs)[number] = {
      id: 'code-graph',
      label: 'Code Graph',
      icon: <GraphIcon size="sm" />,
    };
    const dangerIndex = enabledTabs.findIndex((tab) => tab.id === 'danger');
    if (dangerIndex === -1) {
      return [...enabledTabs, codeGraphTab];
    }
    return [
      ...enabledTabs.slice(0, dangerIndex),
      codeGraphTab,
      ...enabledTabs.slice(dangerIndex),
    ];
  }, [codeGraphExperimentEnabled, startPageEnabled]);

  useEffect(() => {
    if (!codeGraphExperimentEnabled && activeTab === 'code-graph') {
      setActiveTab('details');
    }
  }, [codeGraphExperimentEnabled, activeTab]);

  useEffect(() => {
    if (!startPageEnabled && activeTab === 'start-page')
      setActiveTab('details');
  }, [activeTab, startPageEnabled]);

  const [addStep, setAddStep] = useState<AddRepoStep>('list');
  const [addMode, setAddMode] = useState<AddRepoMode>('existing');
  const [remoteSource, setRemoteSource] = useState<RemoteSource>('url');
  const [remoteSourceManuallySelected, setRemoteSourceManuallySelected] =
    useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [destinationDir, setDestinationDir] = useState('');
  const [githubRepos, setGithubRepos] = useState<GitHubRepoSummary[] | null>(
    null,
  );
  const [githubRepoFetchState, setGithubRepoFetchState] =
    useState<RepoFetchState>('idle');
  const [githubReposError, setGithubReposError] = useState('');
  const [githubRepoSearch, setGithubRepoSearch] = useState('');
  const [selectedGithubRepoFullName, setSelectedGithubRepoFullName] = useState<
    string | null
  >(null);
  const githubRepoFetchRequestRef = useRef(0);
  const [defaultLocationRepos, setDefaultLocationRepos] = useState<
    RepoSelection[]
  >([]);
  const [reuseClonePrompt, setReuseClonePrompt] = useState<{
    remoteUrl: string;
    destinationDir: string;
    reusablePath: string;
  } | null>(null);
  // An organization's project refuses a chosen folder or URL here, beside
  // its tab, instead of staging it (CAN-3546).
  const [addRepoRefusal, setAddRepoRefusal] = useState('');
  const githubPermissions = useGitHubPermissions('any');
  const canListGithubRepos = githubPermissions?.canListRepos === true;
  const isTemporaryWorkspace = workspace.temporary === true;
  const [claudeMd, setClaudeMd] = useState('');
  const [loadedClaudeMd, setLoadedClaudeMd] = useState('');
  // CAN-1207: instructions must not become editable or saveable until their
  // initial read succeeds. A pending or failed read could otherwise overwrite
  // the real file with the blank draft.
  const [claudeMdLoadState, setClaudeMdLoadState] =
    useState<ClaudeMdLoadState>('loading');
  const [claudeMdRetrying, setClaudeMdRetrying] = useState(false);
  const [pendingPlugins, setPendingPlugins] = useState<ChatTabPluginSelections>(
    normalizePluginSelections(
      workspace.defaultPluginSelections ?? EMPTY_SELECTIONS,
    ),
  );
  const [error, setError] = useState('');
  const [errorFailure, setErrorFailure] = useState<FailureDetails | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // A discard confirmation outlives this modal; its retry runs only here.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const [pendingAdds, setPendingAdds] = useState<PendingWorkspaceAdd[]>([]);
  const [pendingRemoveIds, setPendingRemoveIds] = useState<string[]>([]);
  const [workspaceScripts, setWorkspaceScripts] = useState<EditableScripts>({});
  const [repoScripts, setRepoScripts] = useState<
    Record<string, EditableScripts>
  >({});
  const [newWorkspaceScript, setNewWorkspaceScript] = useState<{
    name: string;
    command: string;
    // Tri-state matching the `EditableScript.timeoutSeconds` contract.
    timeoutSeconds: number | null | undefined;
    devServerPatterns: EditableDevServerPattern[] | undefined;
    shell: CommandShellDefinition | undefined;
    interactive: boolean;
  }>({
    name: '',
    command: '',
    timeoutSeconds: undefined,
    devServerPatterns: undefined,
    shell: undefined,
    interactive: false,
  });
  const [newRepoScripts, setNewRepoScripts] = useState<
    Record<
      string,
      {
        name: string;
        command: string;
        timeoutSeconds: number | null | undefined;
        devServerPatterns: EditableDevServerPattern[] | undefined;
        shell: CommandShellDefinition | undefined;
        interactive: boolean;
      }
    >
  >({});
  // Map of "validity scope id" → array of offending row ids; aggregated to a
  // single `hasInvalidDevServerPatterns` boolean below.
  const [devServerPatternsInvalidRows, setDevServerPatternsInvalidRows] =
    useState<Record<string, string[]>>({});
  const [collapsedRepoScripts, setCollapsedRepoScripts] = useState<Set<string>>(
    new Set(),
  );
  const [sourceRemoteUrl, setSourceRemoteUrl] = useState('');
  const [attachRemoteUrl, setAttachRemoteUrl] = useState('');
  const [sourceActionPending, setSourceActionPending] = useState(false);
  const [teardownError, setTeardownError] =
    useState<TeardownFailedError | null>(null);
  const [isTeardownRetrying, setIsTeardownRetrying] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [confirmingConvertToSingle, setConfirmingConvertToSingle] =
    useState(false);
  const [pendingAlwaysShow, setPendingAlwaysShow] = useState(
    workspace.alwaysShow !== false,
  );
  const [pendingRetention, setPendingRetention] =
    useState<ArchiveRetentionDraft>(() =>
      toArchiveRetentionDraft('multi-repo', workspace.archiveRetentionDays),
    );
  const [pendingAutoArchiveEnabled, setPendingAutoArchiveEnabled] = useState(
    typeof workspace.autoArchiveDays === 'number' &&
      workspace.autoArchiveDays > 0,
  );
  const [pendingAutoArchiveDays, setPendingAutoArchiveDays] = useState(
    typeof workspace.autoArchiveDays === 'number' &&
      workspace.autoArchiveDays > 0
      ? workspace.autoArchiveDays
      : DEFAULT_AUTO_ARCHIVE_DAYS,
  );
  const [pendingAutoArchiveDeleteBranch, setPendingAutoArchiveDeleteBranch] =
    useState(workspace.autoArchiveDeleteBranch === true);
  const defaultScriptTimeoutSeconds = useDefaultScriptTimeoutSeconds(isOpen);
  // Worktree selector for source-controlled view
  const [blockedHookScopes, setBlockedHookScopes] = useState<
    Record<string, boolean>
  >({});
  const hookComposerBlocked = Object.values(blockedHookScopes).some(Boolean);
  const reportHookScopeBlocked = useCallback(
    (scope: string, blocked: boolean): void => {
      setBlockedHookScopes((previous) =>
        Boolean(previous[scope]) === blocked
          ? previous
          : { ...previous, [scope]: blocked },
      );
    },
    [],
  );
  const [sourceInspectWorktreeId, setSourceInspectWorktreeId] = useState<
    string | undefined
  >(driftWorktreeId);
  const [scriptEditMode, setScriptEditMode] = useState<'source' | 'local'>(
    driftWorktreeId ? 'source' : 'local',
  );
  const [sourceWorkspaceScripts, setSourceWorkspaceScripts] =
    useState<EditableScripts>({});
  const [sourceRepoScripts, setSourceRepoScripts] = useState<
    Record<string, EditableScripts>
  >({});
  const [workspaceHooks, setWorkspaceHooks] = useState<EditableHooks>({});
  const [repoHooks, setRepoHooks] = useState<Record<string, EditableHooks>>({});
  const [hookEditMode, setHookEditMode] = useState<'source' | 'local'>(
    driftWorktreeId ? 'source' : 'local',
  );
  const [sourceWorkspaceHooks, setSourceWorkspaceHooks] =
    useState<EditableHooks>({});
  const [sourceRepoHooks, setSourceRepoHooks] = useState<
    Record<string, EditableHooks>
  >({});
  const [pluginEditMode, setPluginEditMode] = useState<'source' | 'local'>(
    driftWorktreeId ? 'source' : 'local',
  );
  const [sourcePlugins, setSourcePlugins] = useState<ShareablePluginRef[]>([]);
  const [existingRepoSourceControlState, setExistingRepoSourceControlState] =
    useState<Record<string, ExistingRepoSourceControlState>>({});
  const [pendingSourceControlRepoIds, setPendingSourceControlRepoIds] =
    useState<string[]>([]);
  const [isApplyingToWorktree, setIsApplyingToWorktree] = useState(false);
  const {
    healthData,
    setHealthData,
    hasLoadedWorkspaceSettingsData,
    workspaceSettingsLoadError,
  } = useWorkspaceSettingsData({
    isOpen,
    workspaceId: workspace.id,
    worktreeId: sourceInspectWorktreeId,
    fallbackErrorMessage: 'Failed to load source-controlled settings.',
  });
  const [addToWorktreeFeedback, setAddToWorktreeFeedback] =
    useState<AddToWorktreeFeedback>({ phase: 'idle' });
  const [worktreeDropdownOpen, setWorktreeDropdownOpen] = useState(false);
  const [existingWorktreeDropdownOpen, setExistingWorktreeDropdownOpen] =
    useState(false);
  const isOpenRef = useRef(isOpen);
  const sourceInspectWorktreeIdRef = useRef(sourceInspectWorktreeId);

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    sourceInspectWorktreeIdRef.current = sourceInspectWorktreeId;
  }, [sourceInspectWorktreeId]);

  const claudeMdLoadFailed = claudeMdLoadState === 'failed';
  const claudeMdUnavailable = claudeMdLoadState !== 'ready';
  const claudeMdDirty = !claudeMdUnavailable && claudeMd !== loadedClaudeMd;
  const pluginsDirty =
    normalizeSelections(pendingPlugins) !==
    normalizeSelections(workspace.defaultPluginSelections ?? EMPTY_SELECTIONS);
  const workspaceScriptsDirty =
    serializeScripts(workspaceScripts) !==
    serializeScripts(createEditableScripts(workspace.scripts));
  const repoScriptsDirty = Object.entries(repoScripts).some(([repoId, s]) => {
    const repo = workspace.repos.find((r) => r.id === repoId);
    return (
      serializeScripts(s) !==
      serializeScripts(createEditableScripts(repo?.scripts))
    );
  });
  const workspaceHooksDirty =
    serializeHooks(workspaceHooks) !==
    serializeHooks(createEditableHooks(workspace.hooks));
  const repoHooksDirty = Object.entries(repoHooks).some(([repoId, h]) => {
    const repo = workspace.repos.find((r) => r.id === repoId);
    return (
      serializeHooks(h) !== serializeHooks(createEditableHooks(repo?.hooks))
    );
  });
  const alwaysShowDirty =
    pendingAlwaysShow !== (workspace.alwaysShow !== false);
  // Dirty compares effective always-on deletion retention. A never-set
  // workspace left at the 7-day default stays clean.
  const archiveRetentionDirty = isArchiveRetentionDraftDirty(
    'multi-repo',
    workspace.archiveRetentionDays,
    pendingRetention,
  );
  const nextAutoArchiveDays = pendingAutoArchiveEnabled
    ? pendingAutoArchiveDays
    : null;
  const autoArchiveDirty =
    (workspace.autoArchiveDays ?? null) !== nextAutoArchiveDays ||
    (workspace.autoArchiveDeleteBranch === true) !==
      pendingAutoArchiveDeleteBranch;
  const manifestRepoIds = new Set([
    ...(healthData?.manifest?.repos?.map((repo) => repo.id) ?? []),
    ...workspace.repos
      .filter((repo) => repo.source === 'manifest')
      .map((repo) => repo.id),
  ]);
  const manifestRepoIdsKey = Array.from(manifestRepoIds).sort().join('|');
  const sourceControlledPendingRemoveIds = isTemporaryWorkspace
    ? []
    : pendingRemoveIds.filter((repoId) => manifestRepoIds.has(repoId));
  const localOnlyPendingRemoveIds = pendingRemoveIds.filter(
    (repoId) => isTemporaryWorkspace || !manifestRepoIds.has(repoId),
  );

  const sourceScriptsDirty =
    workspace.sourceRepoPath && !isTemporaryWorkspace
      ? serializeScripts(sourceWorkspaceScripts) !==
          serializeScripts(
            createEditableScripts(healthData?.manifest?.scripts),
          ) ||
        Object.entries(sourceRepoScripts).some(([repoId, s]) => {
          if (!manifestRepoIds.has(repoId)) {
            return false;
          }
          const manifestRepo = healthData?.manifest?.repos?.find(
            (r) => r.id === repoId,
          );
          return (
            serializeScripts(s) !==
            serializeScripts(createEditableScripts(manifestRepo?.scripts))
          );
        })
      : false;

  const sourceHooksDirty =
    workspace.sourceRepoPath && !isTemporaryWorkspace
      ? serializeHooks(sourceWorkspaceHooks) !==
          serializeHooks(createEditableHooks(healthData?.manifest?.hooks)) ||
        Object.entries(sourceRepoHooks).some(([repoId, h]) => {
          if (!manifestRepoIds.has(repoId)) {
            return false;
          }
          const manifestRepo = healthData?.manifest?.repos?.find(
            (r) => r.id === repoId,
          );
          return (
            serializeHooks(h) !==
            serializeHooks(createEditableHooks(manifestRepo?.hooks))
          );
        })
      : false;

  const sourcePluginsDirty =
    workspace.sourceRepoPath && !isTemporaryWorkspace
      ? serializeShareablePluginRefs(sourcePlugins) !==
        serializeShareablePluginRefs(healthData?.manifest?.plugins ?? [])
      : false;

  const isSourceDirty =
    (workspace.sourceRepoPath && !isTemporaryWorkspace
      ? claudeMdDirty
      : false) ||
    sourceScriptsDirty ||
    sourceHooksDirty ||
    sourcePluginsDirty;
  const isLocalDirty =
    pluginsDirty ||
    alwaysShowDirty ||
    archiveRetentionDirty ||
    autoArchiveDirty ||
    privateMemory.dirty ||
    pendingAdds.some((a) => isTemporaryWorkspace || !a.addToSourceControl) ||
    localOnlyPendingRemoveIds.length > 0 ||
    workspaceScriptsDirty ||
    repoScriptsDirty ||
    workspaceHooksDirty ||
    repoHooksDirty ||
    (!workspace.sourceRepoPath || isTemporaryWorkspace ? claudeMdDirty : false);

  const hasSourceRepoAdds =
    !isTemporaryWorkspace && pendingAdds.some((a) => a.addToSourceControl);
  const isSourceRepoDirty =
    !isTemporaryWorkspace &&
    (isSourceDirty ||
      hasSourceRepoAdds ||
      sourceControlledPendingRemoveIds.length > 0 ||
      pendingSourceControlRepoIds.length > 0);

  const activeWorkspaceScriptsForTab =
    !workspace.sourceRepoPath ||
    isTemporaryWorkspace ||
    scriptEditMode === 'local'
      ? workspaceScripts
      : sourceWorkspaceScripts;
  const setActiveWorkspaceScriptsForTab =
    !workspace.sourceRepoPath ||
    isTemporaryWorkspace ||
    scriptEditMode === 'local'
      ? setWorkspaceScripts
      : setSourceWorkspaceScripts;
  const activeRepoScriptsForTab =
    !workspace.sourceRepoPath ||
    isTemporaryWorkspace ||
    scriptEditMode === 'local'
      ? repoScripts
      : sourceRepoScripts;
  const setActiveRepoScriptsForTab =
    !workspace.sourceRepoPath ||
    isTemporaryWorkspace ||
    scriptEditMode === 'local'
      ? setRepoScripts
      : setSourceRepoScripts;

  const activeWorkspaceHooksForTab =
    !workspace.sourceRepoPath ||
    isTemporaryWorkspace ||
    hookEditMode === 'local'
      ? workspaceHooks
      : sourceWorkspaceHooks;
  const setActiveWorkspaceHooksForTab =
    !workspace.sourceRepoPath ||
    isTemporaryWorkspace ||
    hookEditMode === 'local'
      ? setWorkspaceHooks
      : setSourceWorkspaceHooks;
  const activeRepoHooksForTab =
    !workspace.sourceRepoPath ||
    isTemporaryWorkspace ||
    hookEditMode === 'local'
      ? repoHooks
      : sourceRepoHooks;
  const setActiveRepoHooksForTab =
    !workspace.sourceRepoPath ||
    isTemporaryWorkspace ||
    hookEditMode === 'local'
      ? setRepoHooks
      : setSourceRepoHooks;

  const hasInvalidDevServerPatterns = useMemo(() => {
    return Object.values(devServerPatternsInvalidRows).some(
      (rowIds) => rowIds.length > 0,
    );
  }, [devServerPatternsInvalidRows]);

  const makeDevServerValidityHandler = useCallback(
    (scopeId: string) =>
      (rowIds: string[]): void => {
        setDevServerPatternsInvalidRows((prev) => {
          const previousRows = prev[scopeId];
          if (
            rowIds.length === 0 &&
            (previousRows === undefined || previousRows.length === 0)
          ) {
            if (previousRows === undefined) {
              return prev;
            }
            const next = { ...prev };
            delete next[scopeId];
            return next;
          }
          if (
            previousRows &&
            previousRows.length === rowIds.length &&
            previousRows.every((id, i) => id === rowIds[i])
          ) {
            return prev;
          }
          return { ...prev, [scopeId]: rowIds };
        });
      },
    [],
  );

  const driftWorktree = driftWorktreeId
    ? workspace.worktrees.find((worktree) => worktree.id === driftWorktreeId)
    : undefined;

  const loadInstructions = useCallback(async (): Promise<void> => {
    try {
      const content = await window.api.loadClaudeMd({
        workspaceId: workspace.id,
      });
      setClaudeMd(content);
      setLoadedClaudeMd(content);
      setClaudeMdLoadState('ready');
    } catch {
      // The main process returns '' only for a missing file and rejects on
      // every other read error. Keep the editor empty but mark it failed so
      // neither the local save nor the source-change apply can write it back.
      setClaudeMd('');
      setLoadedClaudeMd('');
      setClaudeMdLoadState('failed');
    }
  }, [workspace.id]);

  const handleRetryInstructionsLoad = useCallback((): void => {
    setClaudeMdRetrying(true);
    void loadInstructions().finally(() => {
      setClaudeMdRetrying(false);
    });
  }, [loadInstructions]);

  // Reset state when modal opens/closes
  useEffect(() => {
    resetPrivateMemory();
    if (!isOpen) {
      setAddStep('list');
      setRemoteSource('url');
      setRemoteSourceManuallySelected(false);
      setRemoteUrl('');
      setDestinationDir('');
      setGithubRepos(null);
      setGithubRepoFetchState('idle');
      setGithubReposError('');
      setGithubRepoSearch('');
      setSelectedGithubRepoFullName(null);
      setDefaultLocationRepos([]);
      setReuseClonePrompt(null);
      setAddRepoRefusal('');
      githubRepoFetchRequestRef.current += 1;
      setError('');
      setIsSubmitting(false);
      setConfirmingDelete(false);
      setIsDeleting(false);
      setPendingAdds([]);
      setPendingRemoveIds([]);
      setPendingSourceControlRepoIds([]);
      setAddToWorktreeFeedback({ phase: 'idle' });
      setExistingWorktreeDropdownOpen(false);
      setWorktreeDropdownOpen(false);
      setWorkspaceScripts({});
      setRepoScripts({});
      setNewWorkspaceScript({
        name: '',
        command: '',
        timeoutSeconds: undefined,
        devServerPatterns: undefined,
        shell: undefined,
        interactive: false,
      });
      setNewRepoScripts({});
      setDevServerPatternsInvalidRows({});
      setCollapsedRepoScripts(new Set());
      setWorkspaceHooks({});
      setRepoHooks({});
      setSourceInspectWorktreeId(driftWorktreeId);
      setScriptEditMode(driftWorktreeId ? 'source' : 'local');
      setHookEditMode(driftWorktreeId ? 'source' : 'local');
      setSourceWorkspaceHooks({});
      setSourceRepoHooks({});
      setPluginEditMode(driftWorktreeId ? 'source' : 'local');
      setSourcePlugins([]);
      setSourceRemoteUrl('');
      setAttachRemoteUrl('');
      setTeardownError(null);
      setClaudeMdLoadState('loading');
      // hasLoadedWorkspaceSettingsData / workspaceSettingsLoadError are owned
      // by useWorkspaceSettingsData and reset automatically when the load
      // effect re-runs on isOpen / workspaceId / worktreeId changes.
      setHealthData(null);
      setExistingRepoSourceControlState({});
      setIsConverting(false);
      setConfirmingConvertToSingle(false);
      setPendingAlwaysShow(workspace.alwaysShow !== false);
      setPendingRetention(
        toArchiveRetentionDraft('multi-repo', workspace.archiveRetentionDays),
      );
      setPendingAutoArchiveEnabled(workspace.autoArchiveDays != null);
      setPendingAutoArchiveDays(
        workspace.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS,
      );
      setPendingAutoArchiveDeleteBranch(
        workspace.autoArchiveDeleteBranch === true,
      );
      return;
    }

    setActiveTab(getInitialWorkspaceTab(initialTab));
    setClaudeMdLoadState('loading');
    setPendingPlugins(
      normalizePluginSelections(
        workspace.defaultPluginSelections ?? EMPTY_SELECTIONS,
      ),
    );
    setPendingAlwaysShow(workspace.alwaysShow !== false);
    setPendingRetention(
      toArchiveRetentionDraft('multi-repo', workspace.archiveRetentionDays),
    );
    setPendingAutoArchiveEnabled(workspace.autoArchiveDays != null);
    setPendingAutoArchiveDays(
      workspace.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS,
    );
    setPendingAutoArchiveDeleteBranch(
      workspace.autoArchiveDeleteBranch === true,
    );
    setWorkspaceScripts(createEditableScripts(workspace.scripts));

    // Initialize repo scripts from workspace config
    const scripts: Record<string, EditableScripts> = {};
    const collapsed = new Set<string>();
    for (const repo of workspace.repos) {
      const editable = createEditableScripts(repo.scripts);
      scripts[repo.id] = editable;
      const hasOverride = Object.values(editable).some(
        (entry) => entry.command.trim().length > 0,
      );
      if (!hasOverride) {
        collapsed.add(repo.id);
      }
    }
    setRepoScripts(scripts);
    setCollapsedRepoScripts(collapsed);
    setNewRepoScripts({});

    setWorkspaceHooks(createEditableHooks(workspace.hooks));
    const hooksByRepo: Record<string, EditableHooks> = {};
    for (const repo of workspace.repos) {
      hooksByRepo[repo.id] = createEditableHooks(repo.hooks);
    }
    setRepoHooks(hooksByRepo);
    setSourceInspectWorktreeId(driftWorktreeId);
    setScriptEditMode(
      !isTemporaryWorkspace && driftWorktreeId ? 'source' : 'local',
    );
    setHookEditMode(
      !isTemporaryWorkspace && driftWorktreeId ? 'source' : 'local',
    );
    setSourceWorkspaceHooks({});
    setSourceRepoHooks({});
    setPluginEditMode(
      !isTemporaryWorkspace && driftWorktreeId ? 'source' : 'local',
    );
    setSourcePlugins([]);

    const load = async (): Promise<void> => {
      try {
        if (workspace.sourceRepoPath && !isTemporaryWorkspace) {
          const remote = await window.api.getRemoteUrl({
            repoPath: workspace.sourceRepoPath,
          });
          setSourceRemoteUrl(remote.remoteUrl ?? '');
          setAttachRemoteUrl(remote.remoteUrl ?? '');
        } else {
          setSourceRemoteUrl('');
          setAttachRemoteUrl('');
        }
      } catch {
        setSourceRemoteUrl('');
      }
      await loadInstructions();
    };
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally only re-initialize drafts on modal open or workspace.id change, not on every prop update
  }, [initialTab, isOpen, workspace.id]);

  // Clear the reuse/clone prompt when the user changes inputs so they are
  // not acting on stale probe data.
  useEffect(() => {
    setReuseClonePrompt(null);
  }, [remoteUrl, destinationDir, selectedGithubRepoFullName, addMode]);

  // Load default clone directory when switching to remote mode
  useEffect(() => {
    if (
      !isOpen ||
      addStep !== 'add-repo' ||
      addMode !== 'remote' ||
      destinationDir.trim()
    ) {
      return;
    }

    let canceled = false;

    const loadDefaultCloneDir = async (): Promise<void> => {
      try {
        const defaultDir = await window.api.getDefaultCloneDirectory();
        if (!canceled) {
          setDestinationDir(defaultDir);
        }
      } catch {
        // Silently ignore — user can browse manually
      }
    };

    void loadDefaultCloneDir();

    return (): void => {
      canceled = true;
    };
  }, [isOpen, addStep, addMode, destinationDir]);

  // Load repos in the default location whenever the add-repo flow is opened
  // so they can be merged into the "Existing" list.
  useEffect(() => {
    if (!isOpen || addStep !== 'add-repo') {
      return;
    }

    let canceled = false;
    void window.api
      .listDefaultRepos()
      .then((repos) => {
        if (!canceled) {
          setDefaultLocationRepos(repos);
        }
      })
      .catch(() => {
        if (!canceled) {
          setDefaultLocationRepos([]);
        }
      });

    return (): void => {
      canceled = true;
    };
  }, [isOpen, addStep]);

  const loadGitHubReposForAddRepo = useCallback((): void => {
    const requestId = githubRepoFetchRequestRef.current + 1;
    githubRepoFetchRequestRef.current = requestId;
    setGithubRepoFetchState('loading');
    setGithubReposError('');

    void window.api
      .listUserGitHubRepos()
      .then((result) => {
        if (githubRepoFetchRequestRef.current !== requestId) {
          return;
        }
        setGithubRepos(result);
        setGithubRepoFetchState('loaded');
      })
      .catch((cause: unknown) => {
        if (githubRepoFetchRequestRef.current !== requestId) {
          return;
        }
        setGithubReposError(
          cause instanceof Error
            ? cause.message
            : 'Unable to load repositories from GitHub.',
        );
        setGithubRepoFetchState('error');
      });
  }, []);

  const handleRemoteSourceSelect = useCallback((source: RemoteSource): void => {
    setRemoteSource(source);
    setRemoteSourceManuallySelected(true);
  }, []);

  // Auto-select GitHub source when entering remote mode if permissions allow.
  useEffect(() => {
    if (
      !isOpen ||
      addStep !== 'add-repo' ||
      addMode !== 'remote' ||
      githubPermissions === null
    ) {
      return;
    }
    if (
      canListGithubRepos &&
      !remoteSourceManuallySelected &&
      !remoteUrl.trim()
    ) {
      setRemoteSource('github');
    }
  }, [
    addMode,
    addStep,
    canListGithubRepos,
    githubPermissions,
    isOpen,
    remoteSourceManuallySelected,
    remoteUrl,
  ]);

  // Fetch GitHub repos when remote+github is the active source.
  useEffect(() => {
    if (
      !isOpen ||
      addStep !== 'add-repo' ||
      addMode !== 'remote' ||
      remoteSource !== 'github' ||
      !canListGithubRepos ||
      githubRepoFetchState === 'loading' ||
      githubRepoFetchState === 'loaded'
    ) {
      return;
    }

    loadGitHubReposForAddRepo();
  }, [
    addMode,
    addStep,
    canListGithubRepos,
    githubRepoFetchState,
    isOpen,
    loadGitHubReposForAddRepo,
    remoteSource,
  ]);

  // Reset GitHub picker state when leaving remote+github.
  useEffect(() => {
    if (
      !isOpen ||
      (addStep === 'add-repo' &&
        addMode === 'remote' &&
        remoteSource === 'github' &&
        canListGithubRepos)
    ) {
      return;
    }
    githubRepoFetchRequestRef.current += 1;
    setGithubReposError('');
    setGithubRepoSearch('');
    setSelectedGithubRepoFullName(null);
    if (githubRepoFetchState !== 'loaded') {
      setGithubRepoFetchState('idle');
    }
  }, [
    addMode,
    addStep,
    canListGithubRepos,
    githubRepoFetchState,
    isOpen,
    remoteSource,
  ]);

  // If GitHub permissions become unavailable while github source is selected,
  // fall back to URL.
  useEffect(() => {
    if (
      !isOpen ||
      githubPermissions === null ||
      canListGithubRepos ||
      remoteSource !== 'github'
    ) {
      return;
    }
    githubRepoFetchRequestRef.current += 1;
    setRemoteSource('url');
    setGithubRepos(null);
    setGithubRepoSearch('');
    setSelectedGithubRepoFullName(null);
    setGithubReposError('');
    setGithubRepoFetchState('idle');
  }, [canListGithubRepos, githubPermissions, isOpen, remoteSource]);

  const filteredGithubRepos = useMemo((): GitHubRepoSummary[] => {
    if (!githubRepos) return [];
    const query = githubRepoSearch.trim().toLowerCase();
    if (!query) return githubRepos;
    return githubRepos.filter((repo) => {
      if (repo.fullName.toLowerCase().includes(query)) return true;
      if (repo.description?.toLowerCase().includes(query)) return true;
      return false;
    });
  }, [githubRepos, githubRepoSearch]);

  const selectedGithubRepo = useMemo((): GitHubRepoSummary | null => {
    if (!githubRepos || !selectedGithubRepoFullName) return null;
    return (
      githubRepos.find((r) => r.fullName === selectedGithubRepoFullName) ?? null
    );
  }, [githubRepos, selectedGithubRepoFullName]);

  // healthData / hasLoadedWorkspaceSettingsData / workspaceSettingsLoadError
  // are owned by useWorkspaceSettingsData above.

  useEffect(() => {
    if (!isOpen || !healthData?.manifest) return;
    setSourceWorkspaceScripts(
      createEditableScripts(healthData.manifest.scripts),
    );
    const sourceRepoMap: Record<string, EditableScripts> = {};
    for (const repo of healthData.manifest.repos ?? []) {
      sourceRepoMap[repo.id] = createEditableScripts(repo.scripts);
    }
    setSourceRepoScripts(sourceRepoMap);
  }, [isOpen, healthData?.manifest]);

  useEffect(() => {
    if (!isOpen || !healthData?.manifest) return;
    setSourceWorkspaceHooks(createEditableHooks(healthData.manifest.hooks));
    const sourceRepoHookMap: Record<string, EditableHooks> = {};
    for (const repo of healthData.manifest.repos ?? []) {
      sourceRepoHookMap[repo.id] = createEditableHooks(repo.hooks);
    }
    setSourceRepoHooks(sourceRepoHookMap);
  }, [isOpen, healthData?.manifest]);

  // Initialize source-controlled plugin recommendations from the manifest.
  // Mirrors the scripts/hooks hydration above so the dirty-flag round-trips
  // after `Add to Worktree` re-fetches `healthData`.
  useEffect(() => {
    if (!isOpen || !healthData) return;
    setSourcePlugins(healthData.manifest?.plugins ?? []);
  }, [isOpen, healthData]);

  useEffect(() => {
    if (!isOpen || !workspace.sourceRepoPath || isTemporaryWorkspace) {
      setExistingRepoSourceControlState({});
      return;
    }

    const manifestRepoIdsForState = new Set(
      manifestRepoIdsKey.length > 0 ? manifestRepoIdsKey.split('|') : [],
    );
    const localRepos = workspace.repos.filter(
      (repo) => !manifestRepoIdsForState.has(repo.id),
    );
    if (localRepos.length === 0) {
      setExistingRepoSourceControlState({});
      return;
    }

    let canceled = false;
    const loadRepoState = async (): Promise<void> => {
      const entries = await Promise.all(
        localRepos.map(
          async (repo): Promise<[string, ExistingRepoSourceControlState]> => {
            const remote = await window.api.getRemoteUrl({
              repoPath: repo.repoPath,
            });

            return [
              repo.id,
              {
                canAddToSourceControl: Boolean(remote.remoteUrl),
                remoteUrl: remote.remoteUrl ?? undefined,
                sourceControlNote: remote.remoteUrl
                  ? undefined
                  : 'No origin remote',
              },
            ];
          },
        ),
      );
      if (!canceled) {
        setExistingRepoSourceControlState(Object.fromEntries(entries));
      }
    };

    void loadRepoState().catch(() => {
      if (!canceled) {
        setExistingRepoSourceControlState({});
      }
    });

    return (): void => {
      canceled = true;
    };
  }, [
    isOpen,
    isTemporaryWorkspace,
    manifestRepoIdsKey,
    workspace.repos,
    workspace.sourceRepoPath,
  ]);

  const handleSaveLocal = async (): Promise<void> => {
    if (hookComposerBlocked) return;
    setIsSaving(true);
    setError('');
    try {
      // Only apply local repo adds (not source-controlled ones)
      for (const add of pendingAdds.filter(
        (a) => isTemporaryWorkspace || !a.addToSourceControl,
      )) {
        await addRepoToWorkspace(workspace.id, add.repoPath, false);
      }
      for (const removeId of localOnlyPendingRemoveIds) {
        await removeRepoFromWorkspace(workspace.id, removeId);
      }
      if (workspaceScriptsDirty) {
        await window.api.saveWorkspaceScripts({
          workspaceId: workspace.id,
          scripts: toScriptInputMap(workspaceScripts, workspace.scripts),
        });
      }
      if (repoScriptsDirty) {
        await window.api.saveWorkspaceRepoScripts({
          workspaceId: workspace.id,
          repos: Object.entries(repoScripts).map(([repoId, s]) => {
            const repo = workspace.repos.find((r) => r.id === repoId);
            return {
              repoId,
              scripts: toScriptInputMap(s, repo?.scripts),
            };
          }),
        });
      }
      if (workspaceHooksDirty) {
        await window.api.saveWorkspaceHooks({
          workspaceId: workspace.id,
          hooks: toHookInputMap(workspaceHooks, workspace.hooks),
        });
      }
      if (repoHooksDirty) {
        await window.api.saveWorkspaceRepoHooks({
          workspaceId: workspace.id,
          repos: Object.entries(repoHooks).map(([repoId, h]) => {
            const repo = workspace.repos.find((r) => r.id === repoId);
            return {
              repoId,
              hooks: toHookInputMap(h, repo?.hooks),
            };
          }),
        });
      }
      if (
        (!workspace.sourceRepoPath || isTemporaryWorkspace) &&
        claudeMdDirty
      ) {
        await window.api.saveClaudeMd({
          workspaceId: workspace.id,
          content: claudeMd,
        });
        setLoadedClaudeMd(claudeMd);
      }
      if (pluginsDirty || alwaysShowDirty) {
        await window.api.saveWorkspaceDefaultPlugins({
          projectId: workspace.id,
          defaultPluginSelections: normalizePluginSelections(pendingPlugins),
          alwaysShow: pendingAlwaysShow,
        });
      }
      if (archiveRetentionDirty || autoArchiveDirty) {
        await window.api.setWorkspaceArchiveRetention({
          workspaceId: workspace.id,
          archiveRetentionDays: toPersistedArchiveRetentionDays(
            'multi-repo',
            pendingRetention,
          ),
          autoArchiveDays: nextAutoArchiveDays,
          autoArchiveDeleteBranch: pendingAutoArchiveDeleteBranch,
        });
      }
      // Last, so a refusal (the value became organization-managed) keeps
      // the dialog open on the reloaded value with everything else saved.
      if (!(await privateMemory.save())) {
        await loadProjects();
        return;
      }
      await loadProjects();
      // The sidebar shows the added repository; Overview is a Labs page that
      // is off by default, so there is no page to open (CAN-3678).
      onClose();
    } catch (cause) {
      await loadProjects();
      // An organization's project may refuse a repository by name (CAN-3546).
      setError(
        cause instanceof Error
          ? extractIpcErrorMessage(cause)
          : 'Failed to save',
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddToWorktree = async (
    target: { mode: 'new' } | { mode: 'existing'; worktreeId: string },
  ): Promise<void> => {
    if (hookComposerBlocked) return;
    const clientRequestId =
      window.crypto.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let appliedEventHandled = false;
    const handleApplied = (): void => {
      if (appliedEventHandled) {
        return;
      }
      appliedEventHandled = true;

      isOpenRef.current = false;
      onClose();
    };
    const unsubscribeApplied = window.api.onWorkspaceSourceChangesApplied(
      (event) => {
        if (event.clientRequestId !== clientRequestId) {
          return;
        }
        handleApplied();
      },
    );

    setIsApplyingToWorktree(true);
    setError('');
    setExistingWorktreeDropdownOpen(false);
    setWorktreeDropdownOpen(false);
    setAddToWorktreeFeedback({
      phase: 'applying',
      targetLabel:
        target.mode === 'existing'
          ? `worktree ${target.worktreeId}`
          : 'new worktree',
    });
    try {
      const sourceControlledAdds = pendingAdds.filter(
        (add) => add.addToSourceControl,
      );
      const existingSourceControlledRepos = workspace.repos.filter((repo) =>
        pendingSourceControlRepoIds.includes(repo.id),
      );
      const pendingRepoAdds = await Promise.all(
        sourceControlledAdds.map(async (add) => {
          const remote = await window.api.getRemoteUrl({
            repoPath: add.repoPath,
          });
          if (!remote.remoteUrl) {
            throw new Error(`${add.name} has no origin remote`);
          }

          return {
            repoName: add.name,
            repoPath: add.repoPath,
            remoteUrl: remote.remoteUrl,
          };
        }),
      );
      const existingRepoAdds = existingSourceControlledRepos.map((repo) => {
        const sourceControlState = existingRepoSourceControlState[repo.id];
        const remoteUrl = sourceControlState?.remoteUrl;
        if (!remoteUrl) {
          throw new Error(`${repo.name} has no origin remote`);
        }

        return {
          repoId: repo.id,
          repoName: repo.name,
          repoPath: repo.repoPath,
          remoteUrl,
        };
      });
      const repoAdds = [...pendingRepoAdds, ...existingRepoAdds];

      const response = await window.api.applyWorkspaceSourceChanges({
        clientRequestId,
        workspaceId: workspace.id,
        target:
          target.mode === 'existing'
            ? {
                mode: 'existing',
                worktreeId: target.worktreeId,
              }
            : {
                mode: 'new',
                existingWorktreeIds: workspace.worktrees.map(
                  (worktree) => worktree.id,
                ),
              },
        // An undefined claudeMd leaves the source instruction file untouched;
        // never send a draft until the initial read succeeds (CAN-1207).
        claudeMd: claudeMdUnavailable ? undefined : claudeMd,
        workspaceScripts: toScriptInputMap(
          sourceWorkspaceScripts,
          healthData?.manifest?.scripts,
        ),
        repoScriptChanges: Object.entries(sourceRepoScripts)
          .filter(([repoId]) => manifestRepoIds.has(repoId))
          .map(([repoId, scripts]) => {
            const manifestRepo = healthData?.manifest?.repos?.find(
              (repo) => repo.id === repoId,
            );
            return {
              repoId,
              scripts: toScriptInputMap(scripts, manifestRepo?.scripts),
            };
          }),
        workspaceHooks: toHookInputMap(
          sourceWorkspaceHooks,
          healthData?.manifest?.hooks,
          false,
        ),
        repoHookChanges: Object.entries(sourceRepoHooks)
          .filter(([repoId]) => manifestRepoIds.has(repoId))
          .map(([repoId, hooks]) => {
            const manifestRepo = healthData?.manifest?.repos?.find(
              (repo) => repo.id === repoId,
            );
            return {
              repoId,
              hooks: toHookInputMap(hooks, manifestRepo?.hooks, false),
            };
          }),
        workspacePlugins: sourcePlugins,
        repoAdds,
        repoRemovals: sourceControlledPendingRemoveIds,
      });
      const appliedRepoPaths = new Set(
        sourceControlledAdds.map((add) => add.repoPath),
      );
      const appliedRemovalIds = new Set(sourceControlledPendingRemoveIds);
      const appliedSourceControlRepoIds = new Set(
        existingSourceControlledRepos.map((repo) => repo.id),
      );
      handleApplied();
      setPendingAdds((prev) =>
        prev.filter((add) => !appliedRepoPaths.has(add.repoPath)),
      );
      setPendingSourceControlRepoIds((prev) =>
        prev.filter((repoId) => !appliedSourceControlRepoIds.has(repoId)),
      );
      setPendingRemoveIds((prev) =>
        prev.filter((repoId) => !appliedRemovalIds.has(repoId)),
      );
      setSourceInspectWorktreeId(response.worktreeId);
      useChatStore.getState().selectWorktree(workspace.id, response.worktreeId);
      const addedSourceRepo = repoAdds.length > 0;
      if (addedSourceRepo) {
        onClose();
      }

      scheduleAfterClosePaint(() => {
        void useProjectsStore.getState().refreshDiffStats();
        void loadProjects({ silent: true })
          .then(() => {
            useChatStore
              .getState()
              .selectWorktree(workspace.id, response.worktreeId);
            void useProjectsStore.getState().refreshDiffStats();
            // Surface a non-blocking install prompt for any newly authored chat
            // hook plugins that aren't installed locally yet.
            void useProjectsStore
              .getState()
              .inspectHookChatPluginDependencies(
                workspace.id,
                response.worktreeId,
              );
          })
          .catch(() => undefined);

        void window.api
          .getWorkspaceSettingsData({
            workspaceId: workspace.id,
            worktreeId: response.worktreeId,
          })
          .then((freshHealthData) => {
            if (
              isOpenRef.current &&
              sourceInspectWorktreeIdRef.current === response.worktreeId
            ) {
              setHealthData(freshHealthData);
            }
          })
          .catch(() => undefined);
      });
    } catch (cause) {
      await loadProjects();
      setAddToWorktreeFeedback({ phase: 'idle' });
      setError(
        cause instanceof Error
          ? extractIpcErrorMessage(cause)
          : 'Failed to apply to worktree',
      );
    } finally {
      unsubscribeApplied();
      setIsApplyingToWorktree(false);
    }
  };

  const handleConvertToSingleRepo = async (): Promise<void> => {
    setError('');
    setIsConverting(true);

    try {
      await window.api.convertWorkspaceType({
        workspaceId: workspace.id,
        targetType: 'single-repo',
      });
      await loadProjects();
      onClose();
    } catch (cause) {
      setError('Couldn’t convert the project. Try again.');
      setErrorFailure(
        failureDetails('Couldn’t convert the project. Try again.', cause),
      );
    } finally {
      setIsConverting(false);
      setConfirmingConvertToSingle(false);
    }
  };

  const isOrganizationProject = workspace.owner?.type === 'organization';

  // A refusal is about the folder or URL just chosen; choosing again clears it.
  useEffect(() => {
    setAddRepoRefusal('');
  }, [addStep, addMode, remoteSource, remoteUrl, selectedGithubRepoFullName]);

  /** Says why the organization refuses a candidate; `true` when it may be staged. */
  const acceptsOrgRepository = async (
    candidate: OrgRepositoryCandidate,
  ): Promise<boolean> => {
    if (!isOrganizationProject) return true;
    const refusal = await orgRepositoryRefusal(workspace.id, candidate);
    setAddRepoRefusal(refusal ?? '');
    return refusal === null;
  };

  const handleBrowseAndAddRepo = async (): Promise<void> => {
    setError('');
    setAddRepoRefusal('');
    try {
      // Adding a repo to an existing multi-repo workspace requires an
      // actual git repository, so this intentionally omits `allowNonGit`
      // and rejects non-git folders at browse time instead of only
      // failing later when the pending add is confirmed.
      const selected = await window.api.browseForRepo();
      if (!selected) return;
      const name =
        selected.path.split(/[/\\]/).filter(Boolean).pop() ?? selected.path;
      if (
        !(await acceptsOrgRepository({
          kind: 'folder',
          repoPath: selected.path,
          name,
        }))
      )
        return;
      const pendingAdd = await buildPendingAdd(selected.path, name);
      setPendingAdds((prev) => [...prev, pendingAdd]);
      setAddStep('list');
    } catch (cause) {
      setError('Couldn’t open the folder picker. Try again.');
      setErrorFailure(
        failureDetails('Couldn’t open the folder picker. Try again.', cause),
      );
    }
  };

  const handleBrowseCloneDir = async (): Promise<void> => {
    const result = await window.api.browseForCloneDirectory();
    if (!result.canceled && result.directoryPath) {
      setDestinationDir(result.directoryPath);
    }
  };

  const performCloneAndAddRepo = async (
    normalizedUrl: string,
    normalizedDestination: string,
  ): Promise<void> => {
    const repo = await window.api.addRemoteRepo({
      remoteUrl: normalizedUrl,
      destinationDir: normalizedDestination,
    });
    const name = repo.path.split(/[/\\]/).filter(Boolean).pop() ?? repo.path;
    const pendingAdd = await buildPendingAdd(repo.path, name);
    setPendingAdds((prev) => [...prev, pendingAdd]);
    setRemoteUrl('');
    setDestinationDir('');
    setSelectedGithubRepoFullName(null);
    setReuseClonePrompt(null);
    setAddStep('list');
  };

  const handleCloneAndAddRepo = async (): Promise<void> => {
    setError('');
    setAddRepoRefusal('');

    let normalizedUrl = remoteUrl.trim();
    if (remoteSource === 'github') {
      if (!selectedGithubRepo) {
        setError('Choose a repository');
        return;
      }
      normalizedUrl = selectedGithubRepo.cloneUrl;
    }

    if (!normalizedUrl) {
      setError('Remote URL is required');
      return;
    }

    const normalizedDestination = destinationDir.trim();
    if (!normalizedDestination) {
      setError('Choose a destination directory');
      return;
    }

    setIsSubmitting(true);

    try {
      // Checked before cloning, so a refused repository is never cloned.
      if (
        !(await acceptsOrgRepository({
          kind: 'remote',
          remoteUrl: normalizedUrl,
          name:
            remoteSource === 'github' && selectedGithubRepo
              ? selectedGithubRepo.name
              : repositoryNameFromUrl(normalizedUrl),
        }))
      )
        return;
      const probe = await window.api.probeCloneDestination({
        remoteUrl: normalizedUrl,
        destinationDir: normalizedDestination,
      });
      if (probe.reusablePath) {
        setReuseClonePrompt({
          remoteUrl: normalizedUrl,
          destinationDir: normalizedDestination,
          reusablePath: probe.reusablePath,
        });
        return;
      }
      await performCloneAndAddRepo(normalizedUrl, normalizedDestination);
    } catch (cause) {
      setError(
        'Couldn’t clone the repository. Check the URL and your access, then try again.',
      );
      setErrorFailure(
        failureDetails(
          'Couldn’t clone the repository. Check the URL and your access, then try again.',
          cause,
        ),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReuseExistingClone = async (): Promise<void> => {
    if (!reuseClonePrompt) return;
    setError('');
    setIsSubmitting(true);
    try {
      const repo = await window.api.addLocalRepo(reuseClonePrompt.reusablePath);
      const pendingAdd = await buildPendingAdd(repo.path, repo.name);
      setPendingAdds((prev) => [...prev, pendingAdd]);
      setRemoteUrl('');
      setDestinationDir('');
      setSelectedGithubRepoFullName(null);
      setReuseClonePrompt(null);
      setAddStep('list');
    } catch (cause) {
      setError('Couldn’t add the existing repository. Try again.');
      setErrorFailure(
        failureDetails(
          'Couldn’t add the existing repository. Try again.',
          cause,
        ),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCloneNewCopy = async (): Promise<void> => {
    if (!reuseClonePrompt) return;
    setError('');
    setIsSubmitting(true);
    try {
      await performCloneAndAddRepo(
        reuseClonePrompt.remoteUrl,
        reuseClonePrompt.destinationDir,
      );
    } catch (cause) {
      setError(
        'Couldn’t clone the repository. Check the URL and your access, then try again.',
      );
      setErrorFailure(
        failureDetails(
          'Couldn’t clone the repository. Check the URL and your access, then try again.',
          cause,
        ),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const buildPendingAdd = async (
    repoPath: string,
    name: string,
  ): Promise<PendingWorkspaceAdd> => {
    if (!workspace.sourceRepoPath || isTemporaryWorkspace) {
      return {
        name,
        repoPath,
        addToSourceControl: false,
        canAddToSourceControl: false,
      };
    }

    const remote = await window.api.getRemoteUrl({ repoPath });
    const canAddToSourceControl = Boolean(remote.remoteUrl);
    return {
      name,
      repoPath,
      addToSourceControl: canAddToSourceControl,
      canAddToSourceControl,
      sourceControlNote: canAddToSourceControl ? undefined : 'No origin remote',
    };
  };

  const handleAddExistingRepo = async (
    repoPath: string,
    name: string,
  ): Promise<void> => {
    const pendingAdd = await buildPendingAdd(repoPath, name);
    setPendingAdds((prev) => [...prev, pendingAdd]);
    setAddStep('list');
  };

  const handleToggleRemoveRepo = (repoId: string): void => {
    setPendingRemoveIds((prev) => {
      const nextPendingRemoveIds = prev.includes(repoId)
        ? prev.filter((id) => id !== repoId)
        : [...prev, repoId];
      if (nextPendingRemoveIds.includes(repoId)) {
        setPendingSourceControlRepoIds((current) =>
          current.filter((id) => id !== repoId),
        );
      }
      return nextPendingRemoveIds;
    });
  };

  const handleUndoPendingAdd = (repoPath: string): void => {
    setPendingAdds((prev) => prev.filter((a) => a.repoPath !== repoPath));
  };

  const handleTogglePendingAddSourceControl = (repoPath: string): void => {
    setPendingAdds((prev) =>
      prev.map((add) => {
        if (add.repoPath !== repoPath || !add.canAddToSourceControl) {
          return add;
        }

        return {
          ...add,
          addToSourceControl: !add.addToSourceControl,
        };
      }),
    );
  };

  const handleToggleExistingRepoSourceControl = (repoId: string): void => {
    setPendingSourceControlRepoIds((prev) => {
      const nextPendingIds = prev.includes(repoId)
        ? prev.filter((id) => id !== repoId)
        : [...prev, repoId];
      if (nextPendingIds.includes(repoId)) {
        setPendingRemoveIds((current) => current.filter((id) => id !== repoId));
      }
      return nextPendingIds;
    });
  };

  const showAddToWorktreeFooter =
    activeTab !== 'danger' &&
    activeTab !== 'environment' &&
    activeTab !== 'code-graph';
  const showAddToWorktreeAction =
    !isTemporaryWorkspace &&
    workspace.sourceRepoPath &&
    (isSourceRepoDirty || addToWorktreeFeedback.phase !== 'idle');
  const addToWorktreeButtonLabel =
    addToWorktreeFeedback.phase === 'applying'
      ? `Adding to ${addToWorktreeFeedback.targetLabel}...`
      : sourceInspectWorktreeId
        ? 'Add to worktree'
        : 'Add to new worktree';

  // Resolve cwds for project pipeline discovery in the hook editors. The
  // workspace-root hook editor uses the selected worktree's root path (or
  // the source repo path), while each per-repo editor uses the inspected
  // worktree's repo path (or the repo's configured `repoPath`).
  const [workspaceRootPipelineCwd, setWorkspaceRootPipelineCwd] = useState<
    string | undefined
  >(undefined);
  const [repoPipelineCwds, setRepoPipelineCwds] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      const nextRepoCwds: Record<string, string> = {};
      let rootCwd: string | undefined = workspace.sourceRepoPath;

      if (sourceInspectWorktreeId) {
        try {
          rootCwd = await window.api.getWorktreePath({
            projectId: workspace.id,
            worktreeId: sourceInspectWorktreeId,
          });
        } catch {
          rootCwd = workspace.sourceRepoPath;
        }
      }

      for (const repo of workspace.repos) {
        if (sourceInspectWorktreeId) {
          try {
            const repoCwd = await window.api.getWorktreePath({
              projectId: workspace.id,
              worktreeId: sourceInspectWorktreeId,
              repoId: repo.id,
            });
            nextRepoCwds[repo.id] = repoCwd;
          } catch {
            nextRepoCwds[repo.id] = repo.repoPath;
          }
        } else {
          nextRepoCwds[repo.id] = repo.repoPath;
        }
      }

      if (!cancelled) {
        setWorkspaceRootPipelineCwd(rootCwd);
        setRepoPipelineCwds(nextRepoCwds);
      }
    };
    void resolve();
    return (): void => {
      cancelled = true;
    };
  }, [
    isOpen,
    workspace.id,
    workspace.sourceRepoPath,
    workspace.repos,
    sourceInspectWorktreeId,
  ]);

  /**
   * CAN-5337: a refused deletion offers its discards. The confirmation opens
   * only when discardable items are all that block it, and then replaces the
   * refusal shown here; it re-runs this deletion once they are discarded.
   * A refusal that settles after this modal closed offers nothing: its retry
   * could not run.
   */
  const offerDeletionDiscard = (message: string): void => {
    if (!mountedRef.current) return;
    offerProjectDeletionDiscard({
      workspaceId: workspace.id,
      projectName: workspace.name,
      message,
      retry: () => {
        if (mountedRef.current) void handleDeleteWorkspace();
      },
      onOpen: () => setError(''),
      onDeleted: () => {
        void removeProject(workspace.id);
        onClose();
        onDelete?.(workspace.id);
      },
    });
  };

  const handleDeleteWorkspace = async (): Promise<void> => {
    setError('');
    setIsDeleting(true);

    try {
      // Read live worktree list from store to avoid re-archiving already-removed worktrees
      const liveWorkspace = useProjectsStore
        .getState()
        .projects.find(
          (p): p is MultiRepoSidebarItem =>
            p.id === workspace.id && p.type === 'multi-repo',
        );
      const worktrees = liveWorkspace?.worktrees ?? [];
      const removalReason = await recheckWorkspaceRemovalBlockedReason(
        workspace.id,
        worktrees.map((worktree) => worktree.id),
        'multi-repo',
      );
      if (removalReason !== undefined) {
        setError(removalReason);
        offerDeletionDiscard(removalReason);
        return;
      }

      for (const wt of worktrees) {
        try {
          await archiveWorktree(workspace.id, wt.id);
        } catch (err) {
          if (err instanceof TeardownFailedError) {
            setTeardownError(err);
            setIsDeleting(false);
            setConfirmingDelete(false);
            return;
          }
          throw err;
        }
      }

      // Remove workspace persisted directory (config, CLAUDE.md, chats)
      await window.api.deleteWorkspace({ workspaceId: workspace.id });

      await removeProject(workspace.id);
      onClose();
      onDelete?.(workspace.id);
    } catch (cause) {
      offerLifecycleJournalQuarantine(cause);
      const message =
        cause instanceof Error ? cause.message : 'Failed to delete project';
      setError('Couldn’t delete the project. Try again.');
      setErrorFailure(
        failureDetails('Couldn’t delete the project. Try again.', cause),
      );
      // Any failure, the archive loop's included: CAN-5035 arrives as a plain
      // error. The description decides whether there is anything to discard.
      offerDeletionDiscard(message);
    } finally {
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  };

  // The Existing choices an organization's project is checked for.
  const existingChoicePaths = useMemo(
    (): string[] => [
      ...projects.flatMap((project): string[] =>
        project.type === 'single-repo' ? [project.repoPath] : [],
      ),
      ...defaultLocationRepos.map((repo) => repo.path),
    ],
    [projects, defaultLocationRepos],
  );
  const existingRepoEligibility = useOrgRepositoryEligibility(
    workspace.id,
    isOrganizationProject,
    existingChoicePaths,
    isOpen && addStep === 'add-repo' && addMode === 'existing',
  );

  if (!isOpen) return null;

  // Get existing single-repo projects that aren't already in this workspace,
  // then append any git repos in Canopy's default repos directory that aren't
  // already represented, deduped by repoPath.
  const projectRepos = projects
    .filter(
      (p): p is SingleRepoSidebarItem =>
        p.type === 'single-repo' &&
        !workspace.repos.some((r) => r.repoPath === p.repoPath) &&
        !pendingAdds.some((a) => a.repoPath === p.repoPath),
    )
    .map((p) => ({
      name: p.name,
      repoPath: p.repoPath,
    }));

  const existingRepoPaths = new Set<string>([
    ...projectRepos.map((repo) => repo.repoPath),
    ...workspace.repos.map((repo) => repo.repoPath),
    ...pendingAdds.map((add) => add.repoPath),
  ]);
  const defaultLocationReposToShow = defaultLocationRepos
    .filter((repo) => !existingRepoPaths.has(repo.path))
    .map((repo) => ({ name: repo.name, repoPath: repo.path }));

  const existingRepos = [...projectRepos, ...defaultLocationReposToShow];

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={workspace.name}
      titleId="workspace-settings-title"
      maxWidth="5xl"
      minHeight="28rem"
    >
      {/* Tab bar */}
      <SettingsTabBar
        tabs={visibleTabs}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Tab panels */}
      <div
        className={`flex min-h-0 flex-1 flex-col ${activeTab === 'plugins' ? '' : 'overflow-y-auto'} p-6`}
      >
        {activeTab === 'details' && (
          <Stack gap="group">
            <WorkspaceHealthIssuesBlock
              healthData={healthData}
              driftWorktree={driftWorktree}
            />

            <WorkspaceReadinessRecommendations
              workspaceId={workspace.id}
              worktreeId={resolveWorkspaceReadinessWorktreeId(
                healthData?.driftWorktreeId,
                sourceInspectWorktreeId,
              )}
              onViewConversation={(): Promise<boolean> => {
                onClose();
                return Promise.resolve(true);
              }}
            />

            {healthData?.referenceRepoStatus &&
              healthData.referenceRepoStatus.warnings.length > 0 && (
                <div className="flex flex-col gap-1 rounded-lg border border-line-attention bg-warning/5 p-4">
                  <Heading level={3} variant="title" tone="warning">
                    Reference repo status
                  </Heading>
                  {healthData.referenceRepoStatus.warnings.map((w) => (
                    <p key={w.code} className="text-xs fg-warning/80">
                      {w.message}
                    </p>
                  ))}
                </div>
              )}

            {!isTemporaryWorkspace &&
              (!workspace.sourceRepoPath ? (
                <Surface variant="outline" gap="tight" padding="default">
                  <Heading level={3} variant="title">
                    Source repo missing
                  </Heading>
                  <p className="text-xs fg-secondary">
                    Multi-repo projects now require a project root git repo.
                    This project is missing its tracked source repo path and
                    needs to be repaired through migration or local data repair.
                  </p>
                </Surface>
              ) : (
                <>
                  <SettingsDirectoryCard path={workspace.sourceRepoPath} />

                  <Surface variant="outline" gap="tight" padding="default">
                    <div className="flex items-center justify-between gap-2">
                      <Heading level={3} variant="title">
                        Origin remote
                      </Heading>
                      {sourceRemoteUrl && (
                        <CopyButton
                          value={sourceRemoteUrl}
                          ariaLabel="Copy origin remote URL"
                          title="Copy origin remote URL"
                        />
                      )}
                    </div>
                    {sourceRemoteUrl ? (
                      <p className="break-all font-mono text-xs fg-secondary">
                        {sourceRemoteUrl}
                      </p>
                    ) : (
                      <Stack gap="item">
                        <p className="text-xs fg-secondary">
                          This source repo does not have an origin remote yet.
                        </p>
                        <div>
                          <FormField label="Remote URL">
                            {(control) => (
                              <TextInput
                                {...control}
                                density="settings"
                                type="url"
                                value={attachRemoteUrl}
                                onChange={(event) =>
                                  setAttachRemoteUrl(event.target.value)
                                }
                                placeholder="https://github.com/org/workspace.git"
                              />
                            )}
                          </FormField>
                        </div>
                        <Button
                          size="compact"
                          onClick={() => {
                            setError('');
                            setSourceActionPending(true);
                            void window.api
                              .attachWorkspaceOrigin({
                                workspaceId: workspace.id,
                                remoteUrl: attachRemoteUrl,
                              })
                              .then(() => {
                                setSourceRemoteUrl(attachRemoteUrl);
                              })
                              .catch((cause: unknown) => {
                                setError(
                                  'Couldn’t link the remote. Try again.',
                                );
                                setErrorFailure(
                                  failureDetails(
                                    'Couldn’t link the remote. Try again.',
                                    cause,
                                  ),
                                );
                              })
                              .finally(() => setSourceActionPending(false));
                          }}
                          disabled={
                            sourceActionPending || !attachRemoteUrl.trim()
                          }
                          className="self-start"
                        >
                          {sourceActionPending ? 'Attaching…' : 'Attach origin'}
                        </Button>
                      </Stack>
                    )}
                  </Surface>
                </>
              ))}

            <AlwaysShowWorkspaceCard
              checked={pendingAlwaysShow}
              onChange={setPendingAlwaysShow}
            />

            <PrivateMemoryCard
              checked={privateMemory.checked}
              onChange={privateMemory.setChecked}
              disabled={isSaving}
              managed={privateMemory.managed}
              organizationName={privateMemory.organizationName}
              error={privateMemory.error}
              dataTestId="workspace-settings-private-memory"
            />

            <Surface
              variant="outline"
              padding="default"
              data-testid="workspace-settings-retention"
            >
              <Stack data-testid="workspace-settings-retention-card" gap="item">
                <Stack gap="tight">
                  <Heading level={3} variant="title">
                    Deletion retention
                  </Heading>
                  <p className="text-xs fg-secondary">
                    {`Deleted worktrees are kept for ${pendingRetention.days} ${pendingRetention.days === 1 ? 'day' : 'days'} before they're removed. Archived worktrees are kept until you delete them.`}
                  </p>
                </Stack>
                <div className="flex items-center gap-3">
                  <span
                    id="workspace-settings-retention-days-label"
                    className="text-s fg-primary"
                  >
                    Keep deleted worktrees for
                  </span>
                  <div className="w-28">
                    <TextInput
                      density="settings"
                      trailing="days"
                      aria-labelledby="workspace-settings-retention-days-label"
                      type="number"
                      value={pendingRetention.days}
                      onChange={(event) =>
                        setPendingRetention({
                          days: Math.max(
                            1,
                            Math.min(
                              MAX_ARCHIVE_RETENTION_DAYS,
                              parseInt(event.target.value) ||
                                DEFAULT_ARCHIVE_RETENTION_DAYS,
                            ),
                          ),
                        })
                      }
                      min={1}
                      max={MAX_ARCHIVE_RETENTION_DAYS}
                      data-testid="workspace-settings-retention-days"
                    />
                  </div>
                </div>
                <AutoArchiveSettingsControl
                  enabled={pendingAutoArchiveEnabled}
                  days={pendingAutoArchiveDays}
                  maxDays={MAX_ARCHIVE_RETENTION_DAYS}
                  fallbackDays={DEFAULT_AUTO_ARCHIVE_DAYS}
                  description="Delete fully idle worktrees after a period of inactivity."
                  toggleTestId="workspace-settings-auto-archive-toggle"
                  daysTestId="workspace-settings-auto-archive-days"
                  onEnabledChange={setPendingAutoArchiveEnabled}
                  onDaysChange={setPendingAutoArchiveDays}
                >
                  <ChoiceField
                    checked={pendingAutoArchiveDeleteBranch}
                    onChange={(event) =>
                      setPendingAutoArchiveDeleteBranch(event.target.checked)
                    }
                    data-testid="workspace-settings-auto-archive-delete-branch"
                    label="Delete local branches with the worktrees"
                  />
                </AutoArchiveSettingsControl>
              </Stack>
            </Surface>

            {workspace.temporary === true && (
              <TemporaryWorkspacePromotionCard
                workspaceId={workspace.id}
                defaultName={getWorkspaceDisplayName(workspace)}
                onPromoted={() => {
                  void loadProjects({ silent: true });
                }}
              />
            )}
          </Stack>
        )}

        {activeTab === 'repositories' && (
          <Stack gap="inline">
            <Stack gap="item">
              <div className="flex items-center justify-between">
                <Heading level={3} variant="title">
                  Repositories
                </Heading>
                {addStep === 'list' && (
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => {
                      setAddMode(
                        existingRepos.length > 0 ? 'existing' : 'browse',
                      );
                      setAddStep('add-repo');
                    }}
                  >
                    + Add repo
                  </Button>
                )}
              </div>

              {addStep === 'add-repo' && (
                <Surface variant="outline" padding="compact">
                  <div>
                    <SegmentedControl<AddRepoMode>
                      label="Repository source"
                      value={addMode}
                      width="content"
                      shape="capsule"
                      options={[
                        ...(existingRepos.length > 0
                          ? [{ value: 'existing' as const, label: 'Existing' }]
                          : []),
                        { value: 'browse', label: 'Local folder' },
                        { value: 'remote', label: 'Remote' },
                      ]}
                      onChange={setAddMode}
                    />
                  </div>

                  {addMode === 'existing' && (
                    <div className="flex flex-col max-h-40 overflow-y-auto gap-1 [&>*]:shrink-0">
                      {existingRepos.map((repo) => (
                        <ExistingRepoOption
                          key={repo.repoPath}
                          name={repo.name}
                          repoPath={repo.repoPath}
                          eligibility={existingRepoEligibility}
                          onAdd={(repoPath, name) =>
                            void handleAddExistingRepo(repoPath, name)
                          }
                        />
                      ))}
                      <Button
                        size="compact"
                        onClick={() => setAddStep('list')}
                        className="self-start"
                      >
                        Cancel
                      </Button>
                    </div>
                  )}

                  {addMode === 'browse' && (
                    <Stack gap="inline">
                      <div className="flex items-center gap-2">
                        <Button
                          size="compact"
                          onClick={() => void handleBrowseAndAddRepo()}
                        >
                          Browse for repo
                        </Button>
                        <Button
                          size="compact"
                          onClick={() => setAddStep('list')}
                        >
                          Cancel
                        </Button>
                      </div>
                      <ErrorBanner
                        className=""
                        error={addRepoRefusal}
                        testId="workspace-settings-add-repo-refusal"
                      />
                    </Stack>
                  )}

                  {addMode === 'remote' && (
                    <Stack gap="item">
                      {canListGithubRepos && (
                        <Stack gap="tight">
                          <span className="block text-xs fg-secondary">
                            Source
                          </span>
                          <SegmentedControl<RemoteSource>
                            label="Remote source"
                            value={remoteSource}
                            width="content"
                            shape="capsule"
                            options={REMOTE_SOURCE_OPTIONS}
                            onChange={handleRemoteSourceSelect}
                          />
                        </Stack>
                      )}

                      {remoteSource === 'github' && canListGithubRepos ? (
                        <GitHubRepoPicker
                          repos={filteredGithubRepos}
                          totalCount={githubRepos?.length ?? 0}
                          loading={githubRepoFetchState === 'loading'}
                          error={githubReposError}
                          search={githubRepoSearch}
                          onSearchChange={setGithubRepoSearch}
                          selectedFullName={selectedGithubRepoFullName}
                          onSelect={setSelectedGithubRepoFullName}
                          onRetry={() => setGithubRepoFetchState('idle')}
                          testId="workspace-settings-github-repo-list"
                        />
                      ) : (
                        <FormField label="Remote URL">
                          {(control) => (
                            <TextInput
                              {...control}
                              density="settings"
                              type="url"
                              value={remoteUrl}
                              onChange={(event) =>
                                setRemoteUrl(event.target.value)
                              }
                              placeholder="https://github.com/org/repo.git"
                            />
                          )}
                        </FormField>
                      )}

                      <ErrorBanner
                        className=""
                        error={addRepoRefusal}
                        testId="workspace-settings-add-repo-refusal"
                      />

                      <FormField label="Destination directory">
                        {(control) => (
                          <div className="flex gap-2">
                            <TextInput
                              {...control}
                              density="settings"
                              className="min-w-0 flex-1"
                              type="text"
                              value={destinationDir}
                              readOnly
                            />
                            <Button
                              size="compact"
                              onClick={() => void handleBrowseCloneDir()}
                            >
                              Browse
                            </Button>
                          </div>
                        )}
                      </FormField>

                      {reuseClonePrompt ? (
                        <div className="flex flex-col gap-2 rounded-md border border-line-attention bg-warning/5 p-2.5 text-xs">
                          <Stack gap="tight">
                            <p className="font-medium fg-warning">
                              Repo already exists at this destination
                            </p>
                            <p className="break-all font-mono text-2xs fg-warning/80">
                              {reuseClonePrompt.reusablePath}
                            </p>
                            <p className="fg-warning/80">
                              Its origin remote matches this URL. Reuse it, or
                              clone a separate copy alongside it?
                            </p>
                          </Stack>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="compact"
                              onClick={() => void handleReuseExistingClone()}
                              disabled={isSubmitting}
                            >
                              {isSubmitting ? 'Working…' : 'Reuse existing'}
                            </Button>
                            <Button
                              size="compact"
                              onClick={() => void handleCloneNewCopy()}
                              disabled={isSubmitting}
                            >
                              {isSubmitting ? 'Cloning…' : 'Clone new copy'}
                            </Button>
                            <Button
                              size="compact"
                              onClick={() => setReuseClonePrompt(null)}
                              disabled={isSubmitting}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Button
                            size="compact"
                            onClick={() => void handleCloneAndAddRepo()}
                            disabled={
                              isSubmitting ||
                              (remoteSource === 'github' &&
                                !selectedGithubRepoFullName)
                            }
                          >
                            {isSubmitting ? 'Cloning…' : 'Clone and add'}
                          </Button>
                          <Button
                            size="compact"
                            onClick={() => setAddStep('list')}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}
                    </Stack>
                  )}
                </Surface>
              )}
            </Stack>
            {workspace.repos.length === 0 && pendingAdds.length === 0 ? (
              <EmptyStateRow title="No repos added yet. Add repos to start creating worktrees." />
            ) : (
              <Stack gap="tight">
                {workspace.repos.map((repo) => {
                  const markedForRemoval = pendingRemoveIds.includes(repo.id);
                  const existingSourceControlState =
                    existingRepoSourceControlState[repo.id];
                  const pendingSourceControlAdd =
                    pendingSourceControlRepoIds.includes(repo.id);
                  return (
                    <div
                      key={repo.id}
                      className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-s hover:bg-secondary ${markedForRemoval ? 'opacity-60' : ''}`}
                    >
                      <span
                        className={`font-medium ${markedForRemoval ? 'fg-secondary line-through' : 'fg-primary'}`}
                      >
                        {repo.name}
                      </span>
                      <Badge>
                        {manifestRepoIds.has(repo.id)
                          ? 'Source controlled'
                          : 'Local'}
                      </Badge>
                      {markedForRemoval && <Badge tone="danger">Remove</Badge>}
                      {!markedForRemoval &&
                        workspace.sourceRepoPath &&
                        !isTemporaryWorkspace &&
                        !manifestRepoIds.has(repo.id) &&
                        pendingSourceControlAdd && (
                          <Badge tone="info">Will add in worktree</Badge>
                        )}
                      <span className="flex-1 truncate text-xs fg-secondary">
                        {repo.repoPath}
                      </span>
                      {workspace.sourceRepoPath &&
                        !isTemporaryWorkspace &&
                        !manifestRepoIds.has(repo.id) &&
                        existingSourceControlState?.canAddToSourceControl && (
                          <Button
                            variant="ghost"
                            size="compact"
                            onClick={() =>
                              handleToggleExistingRepoSourceControl(repo.id)
                            }
                            disabled={markedForRemoval}
                          >
                            {pendingSourceControlAdd
                              ? 'Keep local only'
                              : 'Add to source control'}
                          </Button>
                        )}
                      {workspace.sourceRepoPath &&
                        !isTemporaryWorkspace &&
                        !manifestRepoIds.has(repo.id) &&
                        !existingSourceControlState?.canAddToSourceControl &&
                        existingSourceControlState?.sourceControlNote && (
                          <span className="text-3xs fg-secondary">
                            {existingSourceControlState.sourceControlNote}
                          </span>
                        )}
                      <span
                        className={
                          markedForRemoval
                            ? undefined
                            : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
                        }
                      >
                        <Button
                          variant={
                            markedForRemoval ? 'ghost' : 'ghost-destructive'
                          }
                          size="compact"
                          onClick={() => handleToggleRemoveRepo(repo.id)}
                          disabled={hasActiveWorktrees}
                          aria-label={
                            markedForRemoval
                              ? `Undo remove ${repo.name}`
                              : `Remove ${repo.name}`
                          }
                        >
                          {markedForRemoval ? 'Undo' : 'Remove'}
                        </Button>
                      </span>
                    </div>
                  );
                })}
                {pendingAdds.map((add) => (
                  <div
                    key={add.repoPath}
                    className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-s hover:bg-secondary"
                  >
                    <span className="font-medium fg-primary">{add.name}</span>
                    <Badge tone="info">New</Badge>
                    {workspace.sourceRepoPath && !isTemporaryWorkspace && (
                      <Badge tone={add.addToSourceControl ? 'info' : 'neutral'}>
                        {add.addToSourceControl
                          ? 'Will add in worktree'
                          : add.canAddToSourceControl
                            ? 'Local'
                            : 'No origin remote'}
                      </Badge>
                    )}
                    <span className="flex-1 truncate text-xs fg-secondary">
                      {add.repoPath}
                    </span>
                    {workspace.sourceRepoPath &&
                      !isTemporaryWorkspace &&
                      add.canAddToSourceControl && (
                        <Button
                          variant="ghost"
                          size="compact"
                          onClick={() =>
                            handleTogglePendingAddSourceControl(add.repoPath)
                          }
                        >
                          {add.addToSourceControl
                            ? 'Keep local only'
                            : 'Include in worktree'}
                        </Button>
                      )}
                    {workspace.sourceRepoPath &&
                      !isTemporaryWorkspace &&
                      !add.canAddToSourceControl &&
                      add.sourceControlNote && (
                        <span className="text-3xs fg-secondary">
                          {add.sourceControlNote}
                        </span>
                      )}
                    <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost-destructive"
                        size="compact"
                        onClick={() => handleUndoPendingAdd(add.repoPath)}
                        aria-label={`Remove pending ${add.name}`}
                      >
                        Remove
                      </Button>
                    </span>
                  </div>
                ))}
              </Stack>
            )}
          </Stack>
        )}

        {activeTab === 'scripts' && (
          <Stack gap="group">
            {workspace.sourceRepoPath && !isTemporaryWorkspace && (
              <SourceLocalToggle
                mode={scriptEditMode}
                onChange={setScriptEditMode}
              />
            )}
            {workspace.sourceRepoPath &&
            !isTemporaryWorkspace &&
            scriptEditMode === 'source' &&
            !hasLoadedWorkspaceSettingsData &&
            !workspaceSettingsLoadError ? (
              <SourceScriptsSkeleton />
            ) : workspace.sourceRepoPath &&
              !isTemporaryWorkspace &&
              scriptEditMode === 'source' &&
              workspaceSettingsLoadError ? (
              <Surface variant="group" padding="default">
                <div className="flex flex-col gap-3 text-s">
                  <Stack gap="tight">
                    <p className="font-medium fg-primary">
                      Source-controlled scripts are unavailable.
                    </p>
                    <p className="fg-secondary">{workspaceSettingsLoadError}</p>
                  </Stack>
                  <div>
                    <Button
                      size="compact"
                      onClick={() => setScriptEditMode('local')}
                    >
                      Use local override
                    </Button>
                  </div>
                </div>
              </Surface>
            ) : (
              <>
                <Surface variant="outline" padding="compact">
                  <div className="flex flex-col gap-3">
                    <Heading level={4} variant="title">
                      Project root
                    </Heading>
                    <ScriptConfigEditor
                      label="Before setup"
                      scriptName="before-setup"
                      command={getEditableScriptValue(
                        activeWorkspaceScriptsForTab,
                        'before-setup',
                      )}
                      timeoutSeconds={getEditableScriptTimeoutSeconds(
                        activeWorkspaceScriptsForTab,
                        'before-setup',
                      )}
                      shell={getEditableScriptShell(
                        activeWorkspaceScriptsForTab,
                        'before-setup',
                      )}
                      interactive={getEditableScriptInteractive(
                        activeWorkspaceScriptsForTab,
                        'before-setup',
                      )}
                      onInteractiveChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptInteractive(
                            prev,
                            'before-setup',
                            next,
                          ),
                        )
                      }
                      onCommandChange={(nextValue) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptValue(
                            prev,
                            'before-setup',
                            nextValue,
                          ),
                        )
                      }
                      onTimeoutSecondsChange={(nextTimeout) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptTimeoutSeconds(
                            prev,
                            'before-setup',
                            nextTimeout,
                          ),
                        )
                      }
                      onShellChange={(nextShell) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptShell(
                            prev,
                            'before-setup',
                            nextShell,
                          ),
                        )
                      }
                      placeholder={getWorkspaceRootScriptPlaceholder(
                        'before-setup',
                      )}
                      rows={3}
                      defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                      devServerPatterns={getEditableScriptDevServerPatterns(
                        activeWorkspaceScriptsForTab,
                        'before-setup',
                      )}
                      onDevServerPatternsChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptDevServerPatterns(
                            prev,
                            'before-setup',
                            next,
                          ),
                        )
                      }
                      devServerPatternsValidityScopeKey={`${scriptEditMode}:workspace-root:before-setup`}
                      onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                        `${scriptEditMode}:workspace-root:before-setup`,
                      )}
                    />
                    <ScriptConfigEditor
                      label="After setup"
                      scriptName="after-setup"
                      command={getEditableScriptValue(
                        activeWorkspaceScriptsForTab,
                        'after-setup',
                      )}
                      timeoutSeconds={getEditableScriptTimeoutSeconds(
                        activeWorkspaceScriptsForTab,
                        'after-setup',
                      )}
                      shell={getEditableScriptShell(
                        activeWorkspaceScriptsForTab,
                        'after-setup',
                      )}
                      interactive={getEditableScriptInteractive(
                        activeWorkspaceScriptsForTab,
                        'after-setup',
                      )}
                      onInteractiveChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptInteractive(
                            prev,
                            'after-setup',
                            next,
                          ),
                        )
                      }
                      onCommandChange={(nextValue) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptValue(
                            prev,
                            'after-setup',
                            nextValue,
                          ),
                        )
                      }
                      onTimeoutSecondsChange={(nextTimeout) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptTimeoutSeconds(
                            prev,
                            'after-setup',
                            nextTimeout,
                          ),
                        )
                      }
                      onShellChange={(nextShell) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptShell(
                            prev,
                            'after-setup',
                            nextShell,
                          ),
                        )
                      }
                      placeholder={getWorkspaceRootScriptPlaceholder(
                        'after-setup',
                      )}
                      rows={3}
                      defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                      devServerPatterns={getEditableScriptDevServerPatterns(
                        activeWorkspaceScriptsForTab,
                        'after-setup',
                      )}
                      onDevServerPatternsChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptDevServerPatterns(
                            prev,
                            'after-setup',
                            next,
                          ),
                        )
                      }
                      devServerPatternsValidityScopeKey={`${scriptEditMode}:workspace-root:after-setup`}
                      onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                        `${scriptEditMode}:workspace-root:after-setup`,
                      )}
                    />
                    <ScriptConfigEditor
                      label="Before launch"
                      scriptName="before-launch"
                      command={getEditableScriptValue(
                        activeWorkspaceScriptsForTab,
                        'before-launch',
                      )}
                      timeoutSeconds={getEditableScriptTimeoutSeconds(
                        activeWorkspaceScriptsForTab,
                        'before-launch',
                      )}
                      shell={getEditableScriptShell(
                        activeWorkspaceScriptsForTab,
                        'before-launch',
                      )}
                      interactive={getEditableScriptInteractive(
                        activeWorkspaceScriptsForTab,
                        'before-launch',
                      )}
                      onInteractiveChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptInteractive(
                            prev,
                            'before-launch',
                            next,
                          ),
                        )
                      }
                      onCommandChange={(nextValue) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptValue(
                            prev,
                            'before-launch',
                            nextValue,
                          ),
                        )
                      }
                      onTimeoutSecondsChange={(nextTimeout) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptTimeoutSeconds(
                            prev,
                            'before-launch',
                            nextTimeout,
                          ),
                        )
                      }
                      onShellChange={(nextShell) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptShell(
                            prev,
                            'before-launch',
                            nextShell,
                          ),
                        )
                      }
                      placeholder={getWorkspaceRootScriptPlaceholder(
                        'before-launch',
                      )}
                      rows={3}
                      defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                      devServerPatterns={getEditableScriptDevServerPatterns(
                        activeWorkspaceScriptsForTab,
                        'before-launch',
                      )}
                      onDevServerPatternsChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptDevServerPatterns(
                            prev,
                            'before-launch',
                            next,
                          ),
                        )
                      }
                      devServerPatternsValidityScopeKey={`${scriptEditMode}:workspace-root:before-launch`}
                      onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                        `${scriptEditMode}:workspace-root:before-launch`,
                      )}
                    />
                    <ScriptConfigEditor
                      label="After launch"
                      scriptName="after-launch"
                      command={getEditableScriptValue(
                        activeWorkspaceScriptsForTab,
                        'after-launch',
                      )}
                      timeoutSeconds={getEditableScriptTimeoutSeconds(
                        activeWorkspaceScriptsForTab,
                        'after-launch',
                      )}
                      shell={getEditableScriptShell(
                        activeWorkspaceScriptsForTab,
                        'after-launch',
                      )}
                      interactive={getEditableScriptInteractive(
                        activeWorkspaceScriptsForTab,
                        'after-launch',
                      )}
                      onInteractiveChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptInteractive(
                            prev,
                            'after-launch',
                            next,
                          ),
                        )
                      }
                      onCommandChange={(nextValue) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptValue(
                            prev,
                            'after-launch',
                            nextValue,
                          ),
                        )
                      }
                      onTimeoutSecondsChange={(nextTimeout) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptTimeoutSeconds(
                            prev,
                            'after-launch',
                            nextTimeout,
                          ),
                        )
                      }
                      onShellChange={(nextShell) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptShell(
                            prev,
                            'after-launch',
                            nextShell,
                          ),
                        )
                      }
                      placeholder={getWorkspaceRootScriptPlaceholder(
                        'after-launch',
                      )}
                      rows={3}
                      defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                      devServerPatterns={getEditableScriptDevServerPatterns(
                        activeWorkspaceScriptsForTab,
                        'after-launch',
                      )}
                      onDevServerPatternsChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptDevServerPatterns(
                            prev,
                            'after-launch',
                            next,
                          ),
                        )
                      }
                      devServerPatternsValidityScopeKey={`${scriptEditMode}:workspace-root:after-launch`}
                      onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                        `${scriptEditMode}:workspace-root:after-launch`,
                      )}
                    />
                    <ScriptConfigEditor
                      label="Before teardown"
                      scriptName="before-teardown"
                      command={getEditableScriptValue(
                        activeWorkspaceScriptsForTab,
                        'before-teardown',
                      )}
                      timeoutSeconds={getEditableScriptTimeoutSeconds(
                        activeWorkspaceScriptsForTab,
                        'before-teardown',
                      )}
                      shell={getEditableScriptShell(
                        activeWorkspaceScriptsForTab,
                        'before-teardown',
                      )}
                      onCommandChange={(nextValue) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptValue(
                            prev,
                            'before-teardown',
                            nextValue,
                          ),
                        )
                      }
                      onTimeoutSecondsChange={(nextTimeout) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptTimeoutSeconds(
                            prev,
                            'before-teardown',
                            nextTimeout,
                          ),
                        )
                      }
                      onShellChange={(nextShell) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptShell(
                            prev,
                            'before-teardown',
                            nextShell,
                          ),
                        )
                      }
                      placeholder={getWorkspaceRootScriptPlaceholder(
                        'before-teardown',
                      )}
                      rows={3}
                      defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                      devServerPatterns={getEditableScriptDevServerPatterns(
                        activeWorkspaceScriptsForTab,
                        'before-teardown',
                      )}
                      onDevServerPatternsChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptDevServerPatterns(
                            prev,
                            'before-teardown',
                            next,
                          ),
                        )
                      }
                      devServerPatternsValidityScopeKey={`${scriptEditMode}:workspace-root:before-teardown`}
                      onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                        `${scriptEditMode}:workspace-root:before-teardown`,
                      )}
                    />
                    <ScriptConfigEditor
                      label="After teardown"
                      scriptName="after-teardown"
                      command={getEditableScriptValue(
                        activeWorkspaceScriptsForTab,
                        'after-teardown',
                      )}
                      timeoutSeconds={getEditableScriptTimeoutSeconds(
                        activeWorkspaceScriptsForTab,
                        'after-teardown',
                      )}
                      shell={getEditableScriptShell(
                        activeWorkspaceScriptsForTab,
                        'after-teardown',
                      )}
                      onCommandChange={(nextValue) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptValue(
                            prev,
                            'after-teardown',
                            nextValue,
                          ),
                        )
                      }
                      onTimeoutSecondsChange={(nextTimeout) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptTimeoutSeconds(
                            prev,
                            'after-teardown',
                            nextTimeout,
                          ),
                        )
                      }
                      onShellChange={(nextShell) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptShell(
                            prev,
                            'after-teardown',
                            nextShell,
                          ),
                        )
                      }
                      placeholder={getWorkspaceRootScriptPlaceholder(
                        'after-teardown',
                      )}
                      rows={3}
                      defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                      devServerPatterns={getEditableScriptDevServerPatterns(
                        activeWorkspaceScriptsForTab,
                        'after-teardown',
                      )}
                      onDevServerPatternsChange={(next) =>
                        setActiveWorkspaceScriptsForTab((prev) =>
                          setEditableScriptDevServerPatterns(
                            prev,
                            'after-teardown',
                            next,
                          ),
                        )
                      }
                      devServerPatternsValidityScopeKey={`${scriptEditMode}:workspace-root:after-teardown`}
                      onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                        `${scriptEditMode}:workspace-root:after-teardown`,
                      )}
                    />

                    <Surface variant="outline" padding="compact">
                      <div className="flex flex-col gap-3">
                        <Stack gap="tight">
                          <p className="text-xs font-medium fg-primary">
                            Custom project scripts
                          </p>
                          <p className="text-2xs fg-secondary">
                            Ad hoc scripts that run in the project root.
                          </p>
                        </Stack>
                        {getEditableCustomScripts(
                          activeWorkspaceScriptsForTab,
                        ).map((script) => (
                          <Surface
                            key={script.name}
                            variant="outline"
                            gap="inline"
                            padding="compact"
                          >
                            <div className=" flex items-center justify-between gap-3">
                              <span className="text-xs font-medium fg-primary">
                                {script.name}
                              </span>
                              <Button
                                variant="ghost-destructive"
                                size="compact"
                                onClick={() =>
                                  setActiveWorkspaceScriptsForTab((prev) =>
                                    removeEditableScript(prev, script.name),
                                  )
                                }
                              >
                                Remove
                              </Button>
                            </div>
                            <ScriptConfigEditor
                              label="Command"
                              scriptName={script.name}
                              command={script.command}
                              timeoutSeconds={script.timeoutSeconds}
                              shell={script.shell}
                              interactive={script.interactive === true}
                              onInteractiveChange={(next) =>
                                setActiveWorkspaceScriptsForTab((prev) =>
                                  setEditableScriptInteractive(
                                    prev,
                                    script.name,
                                    next,
                                  ),
                                )
                              }
                              onCommandChange={(nextValue) =>
                                setActiveWorkspaceScriptsForTab((prev) =>
                                  setEditableScriptValue(
                                    prev,
                                    script.name,
                                    nextValue,
                                  ),
                                )
                              }
                              onTimeoutSecondsChange={(nextTimeout) =>
                                setActiveWorkspaceScriptsForTab((prev) =>
                                  setEditableScriptTimeoutSeconds(
                                    prev,
                                    script.name,
                                    nextTimeout,
                                  ),
                                )
                              }
                              onShellChange={(nextShell) =>
                                setActiveWorkspaceScriptsForTab((prev) =>
                                  setEditableScriptShell(
                                    prev,
                                    script.name,
                                    nextShell,
                                  ),
                                )
                              }
                              placeholder={
                                WORKSPACE_ROOT_CUSTOM_SCRIPT_PLACEHOLDER
                              }
                              rows={3}
                              defaultTimeoutSeconds={
                                defaultScriptTimeoutSeconds
                              }
                              devServerPatterns={script.devServerPatterns}
                              onDevServerPatternsChange={(next) =>
                                setActiveWorkspaceScriptsForTab((prev) =>
                                  setEditableScriptDevServerPatterns(
                                    prev,
                                    script.name,
                                    next,
                                  ),
                                )
                              }
                              devServerPatternsValidityScopeKey={`${scriptEditMode}:workspace-root:custom:${script.name}`}
                              onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                                `${scriptEditMode}:workspace-root:custom:${script.name}`,
                              )}
                            />
                          </Surface>
                        ))}
                        <Surface variant="dashed" gap="item" padding="compact">
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                            <FormField label="Script name">
                              {(control) => (
                                <TextInput
                                  {...control}
                                  density="settings"
                                  value={newWorkspaceScript.name}
                                  onChange={(event) =>
                                    setNewWorkspaceScript((prev) => ({
                                      ...prev,
                                      name: event.target.value,
                                    }))
                                  }
                                  placeholder="workspace-check"
                                />
                              )}
                            </FormField>
                            <div className="flex items-end">
                              <Button
                                size="compact"
                                onClick={() => {
                                  const scriptName = normalizeScriptName(
                                    newWorkspaceScript.name,
                                  );
                                  if (
                                    !scriptName ||
                                    newWorkspaceScript.command.trim().length ===
                                      0
                                  ) {
                                    return;
                                  }
                                  if (hasInvalidDevServerPatterns) {
                                    return;
                                  }
                                  setActiveWorkspaceScriptsForTab((prev) => {
                                    const next: EditableScripts = { ...prev };
                                    const entry: EditableScript = {
                                      command: newWorkspaceScript.command,
                                    };
                                    if (
                                      newWorkspaceScript.timeoutSeconds !==
                                      undefined
                                    ) {
                                      entry.timeoutSeconds =
                                        newWorkspaceScript.timeoutSeconds;
                                    }
                                    if (
                                      newWorkspaceScript.devServerPatterns !==
                                        undefined &&
                                      newWorkspaceScript.devServerPatterns
                                        .length > 0
                                    ) {
                                      entry.devServerPatterns =
                                        newWorkspaceScript.devServerPatterns;
                                    }
                                    if (
                                      newWorkspaceScript.shell !== undefined
                                    ) {
                                      entry.shell = newWorkspaceScript.shell;
                                    }
                                    if (newWorkspaceScript.interactive) {
                                      entry.interactive = true;
                                    }
                                    next[scriptName] = entry;
                                    return next;
                                  });
                                  setNewWorkspaceScript({
                                    name: '',
                                    command: '',
                                    timeoutSeconds: undefined,
                                    devServerPatterns: undefined,
                                    shell: undefined,
                                    interactive: false,
                                  });
                                }}
                                disabled={
                                  !normalizeScriptName(
                                    newWorkspaceScript.name,
                                  ) ||
                                  !newWorkspaceScript.command.trim() ||
                                  hasInvalidDevServerPatterns
                                }
                              >
                                Add script
                              </Button>
                            </div>
                          </div>
                          <div>
                            <ScriptConfigEditor
                              label="Command"
                              scriptName={
                                normalizeScriptName(newWorkspaceScript.name) ??
                                'new-script'
                              }
                              command={newWorkspaceScript.command}
                              timeoutSeconds={newWorkspaceScript.timeoutSeconds}
                              shell={newWorkspaceScript.shell}
                              interactive={
                                newWorkspaceScript.interactive === true
                              }
                              onInteractiveChange={(interactive) =>
                                setNewWorkspaceScript((prev) => ({
                                  ...prev,
                                  interactive,
                                }))
                              }
                              onCommandChange={(nextValue) =>
                                setNewWorkspaceScript((prev) => ({
                                  ...prev,
                                  command: nextValue,
                                }))
                              }
                              onTimeoutSecondsChange={(nextTimeout) =>
                                setNewWorkspaceScript((prev) => ({
                                  ...prev,
                                  timeoutSeconds: nextTimeout,
                                }))
                              }
                              onShellChange={(nextShell) =>
                                setNewWorkspaceScript((prev) => ({
                                  ...prev,
                                  shell: nextShell,
                                }))
                              }
                              placeholder={
                                WORKSPACE_ROOT_CUSTOM_SCRIPT_PLACEHOLDER
                              }
                              rows={3}
                              defaultTimeoutSeconds={
                                defaultScriptTimeoutSeconds
                              }
                              devServerPatterns={
                                newWorkspaceScript.devServerPatterns
                              }
                              onDevServerPatternsChange={(next) =>
                                setNewWorkspaceScript((prev) => ({
                                  ...prev,
                                  devServerPatterns: next,
                                }))
                              }
                              devServerPatternsValidityScopeKey="workspace-root:new-script-draft"
                              onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                                'workspace-root:new-script-draft',
                              )}
                            />
                          </div>
                        </Surface>
                      </div>
                    </Surface>
                  </div>
                </Surface>

                {workspace.repos.map((repo) => {
                  const scripts = activeRepoScriptsForTab[repo.id] ?? {};
                  const customScripts = getEditableCustomScripts(scripts);
                  const draft = newRepoScripts[repo.id] ?? {
                    name: '',
                    command: '',
                    timeoutSeconds: undefined,
                    devServerPatterns: undefined,
                    shell: undefined,
                    interactive: false,
                  };
                  const isCollapsed = collapsedRepoScripts.has(repo.id);
                  return (
                    <Disclosure
                      key={repo.id}
                      variant="box"
                      label={repo.name}
                      open={!isCollapsed}
                      onOpenChange={(): void =>
                        setCollapsedRepoScripts((prev) => {
                          const next = new Set(prev);
                          if (next.has(repo.id)) {
                            next.delete(repo.id);
                          } else {
                            next.add(repo.id);
                          }
                          return next;
                        })
                      }
                      dataTestId={`workspace-settings-repo-scripts-${repo.id}`}
                    >
                      <Stack gap="item">
                        <ScriptConfigEditor
                          label="Setup script"
                          scriptName="setup"
                          command={getEditableScriptValue(scripts, 'setup')}
                          timeoutSeconds={getEditableScriptTimeoutSeconds(
                            scripts,
                            'setup',
                          )}
                          shell={getEditableScriptShell(scripts, 'setup')}
                          interactive={getEditableScriptInteractive(
                            scripts,
                            'setup',
                          )}
                          onInteractiveChange={(next) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptInteractive(
                                prev[repo.id] ?? {},
                                'setup',
                                next,
                              ),
                            }))
                          }
                          onCommandChange={(nextValue) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptValue(
                                prev[repo.id] ?? {},
                                'setup',
                                nextValue,
                              ),
                            }))
                          }
                          onTimeoutSecondsChange={(nextTimeout) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptTimeoutSeconds(
                                prev[repo.id] ?? {},
                                'setup',
                                nextTimeout,
                              ),
                            }))
                          }
                          onShellChange={(nextShell) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptShell(
                                prev[repo.id] ?? {},
                                'setup',
                                nextShell,
                              ),
                            }))
                          }
                          placeholder={
                            '# Runs after worktree creation\nnpm install'
                          }
                          rows={3}
                          defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                          devServerPatterns={getEditableScriptDevServerPatterns(
                            scripts,
                            'setup',
                          )}
                          onDevServerPatternsChange={(next) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptDevServerPatterns(
                                prev[repo.id] ?? {},
                                'setup',
                                next,
                              ),
                            }))
                          }
                          devServerPatternsValidityScopeKey={`${scriptEditMode}:repo:${repo.id}:setup`}
                          onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                            `${scriptEditMode}:repo:${repo.id}:setup`,
                          )}
                        />
                        <ScriptConfigEditor
                          label="Teardown script"
                          scriptName="teardown"
                          command={getEditableScriptValue(scripts, 'teardown')}
                          timeoutSeconds={getEditableScriptTimeoutSeconds(
                            scripts,
                            'teardown',
                          )}
                          shell={getEditableScriptShell(scripts, 'teardown')}
                          onCommandChange={(nextValue) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptValue(
                                prev[repo.id] ?? {},
                                'teardown',
                                nextValue,
                              ),
                            }))
                          }
                          onTimeoutSecondsChange={(nextTimeout) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptTimeoutSeconds(
                                prev[repo.id] ?? {},
                                'teardown',
                                nextTimeout,
                              ),
                            }))
                          }
                          onShellChange={(nextShell) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptShell(
                                prev[repo.id] ?? {},
                                'teardown',
                                nextShell,
                              ),
                            }))
                          }
                          placeholder={
                            '# Runs before worktree archive\nnpm run clean'
                          }
                          rows={3}
                          defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                          devServerPatterns={getEditableScriptDevServerPatterns(
                            scripts,
                            'teardown',
                          )}
                          onDevServerPatternsChange={(next) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptDevServerPatterns(
                                prev[repo.id] ?? {},
                                'teardown',
                                next,
                              ),
                            }))
                          }
                          devServerPatternsValidityScopeKey={`${scriptEditMode}:repo:${repo.id}:teardown`}
                          onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                            `${scriptEditMode}:repo:${repo.id}:teardown`,
                          )}
                        />
                        <ScriptConfigEditor
                          label="Launch script"
                          scriptName="launch"
                          command={getEditableScriptValue(scripts, 'launch')}
                          timeoutSeconds={getEditableScriptTimeoutSeconds(
                            scripts,
                            'launch',
                          )}
                          shell={getEditableScriptShell(scripts, 'launch')}
                          interactive={getEditableScriptInteractive(
                            scripts,
                            'launch',
                          )}
                          onInteractiveChange={(next) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptInteractive(
                                prev[repo.id] ?? {},
                                'launch',
                                next,
                              ),
                            }))
                          }
                          onCommandChange={(nextValue) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptValue(
                                prev[repo.id] ?? {},
                                'launch',
                                nextValue,
                              ),
                            }))
                          }
                          onTimeoutSecondsChange={(nextTimeout) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptTimeoutSeconds(
                                prev[repo.id] ?? {},
                                'launch',
                                nextTimeout,
                              ),
                            }))
                          }
                          onShellChange={(nextShell) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptShell(
                                prev[repo.id] ?? {},
                                'launch',
                                nextShell,
                              ),
                            }))
                          }
                          placeholder={'# Triggered manually\nnpm run dev'}
                          rows={3}
                          defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                          devServerPatterns={getEditableScriptDevServerPatterns(
                            scripts,
                            'launch',
                          )}
                          onDevServerPatternsChange={(next) =>
                            setActiveRepoScriptsForTab((prev) => ({
                              ...prev,
                              [repo.id]: setEditableScriptDevServerPatterns(
                                prev[repo.id] ?? {},
                                'launch',
                                next,
                              ),
                            }))
                          }
                          devServerPatternsValidityScopeKey={`${scriptEditMode}:repo:${repo.id}:launch`}
                          onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                            `${scriptEditMode}:repo:${repo.id}:launch`,
                          )}
                        />
                        <Surface variant="outline" padding="compact">
                          <div className="flex flex-col gap-3">
                            <Stack gap="tight">
                              <p className="text-xs font-medium fg-primary">
                                Custom scripts
                              </p>
                              <p className="text-2xs fg-secondary">
                                Repo-specific ad hoc scripts.
                              </p>
                            </Stack>
                            {customScripts.map((script) => (
                              <Surface
                                key={script.name}
                                variant="outline"
                                gap="inline"
                                padding="compact"
                              >
                                <div className=" flex items-center justify-between gap-3">
                                  <span className="text-xs font-medium fg-primary">
                                    {script.name}
                                  </span>
                                  <Button
                                    variant="ghost-destructive"
                                    size="compact"
                                    onClick={() =>
                                      setActiveRepoScriptsForTab((prev) => ({
                                        ...prev,
                                        [repo.id]: removeEditableScript(
                                          prev[repo.id] ?? {},
                                          script.name,
                                        ),
                                      }))
                                    }
                                  >
                                    Remove
                                  </Button>
                                </div>
                                <ScriptConfigEditor
                                  label="Command"
                                  scriptName={script.name}
                                  command={script.command}
                                  timeoutSeconds={script.timeoutSeconds}
                                  shell={script.shell}
                                  interactive={script.interactive === true}
                                  onInteractiveChange={(next) =>
                                    setActiveRepoScriptsForTab((prev) => ({
                                      ...prev,
                                      [repo.id]: setEditableScriptInteractive(
                                        prev[repo.id] ?? {},
                                        script.name,
                                        next,
                                      ),
                                    }))
                                  }
                                  onCommandChange={(nextValue) =>
                                    setActiveRepoScriptsForTab((prev) => ({
                                      ...prev,
                                      [repo.id]: setEditableScriptValue(
                                        prev[repo.id] ?? {},
                                        script.name,
                                        nextValue,
                                      ),
                                    }))
                                  }
                                  onTimeoutSecondsChange={(nextTimeout) =>
                                    setActiveRepoScriptsForTab((prev) => ({
                                      ...prev,
                                      [repo.id]:
                                        setEditableScriptTimeoutSeconds(
                                          prev[repo.id] ?? {},
                                          script.name,
                                          nextTimeout,
                                        ),
                                    }))
                                  }
                                  onShellChange={(nextShell) =>
                                    setActiveRepoScriptsForTab((prev) => ({
                                      ...prev,
                                      [repo.id]: setEditableScriptShell(
                                        prev[repo.id] ?? {},
                                        script.name,
                                        nextShell,
                                      ),
                                    }))
                                  }
                                  rows={3}
                                  defaultTimeoutSeconds={
                                    defaultScriptTimeoutSeconds
                                  }
                                  devServerPatterns={script.devServerPatterns}
                                  onDevServerPatternsChange={(next) =>
                                    setActiveRepoScriptsForTab((prev) => ({
                                      ...prev,
                                      [repo.id]:
                                        setEditableScriptDevServerPatterns(
                                          prev[repo.id] ?? {},
                                          script.name,
                                          next,
                                        ),
                                    }))
                                  }
                                  devServerPatternsValidityScopeKey={`${scriptEditMode}:repo:${repo.id}:custom:${script.name}`}
                                  onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                                    `${scriptEditMode}:repo:${repo.id}:custom:${script.name}`,
                                  )}
                                />
                              </Surface>
                            ))}
                            <Surface
                              variant="dashed"
                              gap="item"
                              padding="compact"
                            >
                              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                                <FormField label="Script name">
                                  {(control) => (
                                    <TextInput
                                      {...control}
                                      density="settings"
                                      value={draft.name}
                                      onChange={(event) =>
                                        setNewRepoScripts((prev) => ({
                                          ...prev,
                                          [repo.id]: {
                                            ...draft,
                                            name: event.target.value,
                                          },
                                        }))
                                      }
                                      placeholder="dev-server"
                                    />
                                  )}
                                </FormField>
                                <div className="flex items-end">
                                  <Button
                                    size="compact"
                                    onClick={() => {
                                      const scriptName = normalizeScriptName(
                                        draft.name,
                                      );
                                      if (
                                        !scriptName ||
                                        draft.command.trim().length === 0
                                      ) {
                                        return;
                                      }
                                      if (hasInvalidDevServerPatterns) {
                                        return;
                                      }
                                      setActiveRepoScriptsForTab((prev) => {
                                        const repoEditable =
                                          prev[repo.id] ?? {};
                                        const entry: EditableScript = {
                                          command: draft.command,
                                        };
                                        if (
                                          draft.timeoutSeconds !== undefined
                                        ) {
                                          entry.timeoutSeconds =
                                            draft.timeoutSeconds;
                                        }
                                        if (
                                          draft.devServerPatterns !==
                                            undefined &&
                                          draft.devServerPatterns.length > 0
                                        ) {
                                          entry.devServerPatterns =
                                            draft.devServerPatterns;
                                        }
                                        if (draft.shell !== undefined) {
                                          entry.shell = draft.shell;
                                        }
                                        if (draft.interactive) {
                                          entry.interactive = true;
                                        }
                                        return {
                                          ...prev,
                                          [repo.id]: {
                                            ...repoEditable,
                                            [scriptName]: entry,
                                          },
                                        };
                                      });
                                      setNewRepoScripts((prev) => ({
                                        ...prev,
                                        [repo.id]: {
                                          name: '',
                                          command: '',
                                          timeoutSeconds: undefined,
                                          devServerPatterns: undefined,
                                          shell: undefined,
                                          interactive: false,
                                        },
                                      }));
                                    }}
                                    disabled={
                                      !normalizeScriptName(draft.name) ||
                                      !draft.command.trim() ||
                                      hasInvalidDevServerPatterns
                                    }
                                  >
                                    Add script
                                  </Button>
                                </div>
                              </div>
                              <div>
                                <ScriptConfigEditor
                                  label="Command"
                                  scriptName={
                                    normalizeScriptName(draft.name) ??
                                    'new-script'
                                  }
                                  command={draft.command}
                                  timeoutSeconds={draft.timeoutSeconds}
                                  shell={draft.shell}
                                  interactive={draft.interactive}
                                  onInteractiveChange={(interactive) =>
                                    setNewRepoScripts((prev) => ({
                                      ...prev,
                                      [repo.id]: { ...draft, interactive },
                                    }))
                                  }
                                  onCommandChange={(nextValue) =>
                                    setNewRepoScripts((prev) => ({
                                      ...prev,
                                      [repo.id]: {
                                        ...draft,
                                        command: nextValue,
                                      },
                                    }))
                                  }
                                  onTimeoutSecondsChange={(nextTimeout) =>
                                    setNewRepoScripts((prev) => ({
                                      ...prev,
                                      [repo.id]: {
                                        ...draft,
                                        timeoutSeconds: nextTimeout,
                                      },
                                    }))
                                  }
                                  onShellChange={(nextShell) =>
                                    setNewRepoScripts((prev) => ({
                                      ...prev,
                                      [repo.id]: {
                                        ...draft,
                                        shell: nextShell,
                                      },
                                    }))
                                  }
                                  placeholder="npm run storybook"
                                  rows={3}
                                  defaultTimeoutSeconds={
                                    defaultScriptTimeoutSeconds
                                  }
                                  devServerPatterns={draft.devServerPatterns}
                                  onDevServerPatternsChange={(next) =>
                                    setNewRepoScripts((prev) => ({
                                      ...prev,
                                      [repo.id]: {
                                        ...draft,
                                        devServerPatterns: next,
                                      },
                                    }))
                                  }
                                  devServerPatternsValidityScopeKey={`${scriptEditMode}:repo:${repo.id}:new-script-draft`}
                                  onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                                    `${scriptEditMode}:repo:${repo.id}:new-script-draft`,
                                  )}
                                />
                              </div>
                            </Surface>
                          </div>
                        </Surface>
                      </Stack>
                    </Disclosure>
                  );
                })}
              </>
            )}
            <ScriptActionsSettingsSection
              projectId={workspace.id}
              fallbackWorktreeId={sourceInspectWorktreeId}
            />
          </Stack>
        )}

        {activeTab === 'hooks' && (
          <Stack gap="group">
            {workspace.sourceRepoPath && !isTemporaryWorkspace && (
              <SourceLocalToggle
                mode={hookEditMode}
                onChange={setHookEditMode}
              />
            )}

            {workspace.sourceRepoPath &&
            !isTemporaryWorkspace &&
            hookEditMode === 'source' &&
            !hasLoadedWorkspaceSettingsData &&
            !workspaceSettingsLoadError ? (
              <SourceHooksSkeleton />
            ) : workspace.sourceRepoPath &&
              !isTemporaryWorkspace &&
              hookEditMode === 'source' &&
              workspaceSettingsLoadError ? (
              <Surface variant="group" padding="default">
                <div className="flex flex-col gap-3 text-s">
                  <Stack gap="tight">
                    <p className="font-medium fg-primary">
                      Source-controlled hooks are unavailable.
                    </p>
                    <p className="fg-secondary">{workspaceSettingsLoadError}</p>
                  </Stack>
                  <div>
                    <Button
                      size="compact"
                      onClick={() => setHookEditMode('local')}
                    >
                      Use local override
                    </Button>
                  </div>
                </div>
              </Surface>
            ) : (
              <>
                {/* Workspace-level hooks */}
                <Surface variant="outline" padding="compact">
                  <div className="flex flex-col gap-3">
                    <Heading level={4} variant="title">
                      Project root
                    </Heading>
                    <HookActionEditor
                      key={hookEditMode}
                      chatContext={resolveHookComposerContext({
                        workspaceId: workspace.id,
                        mode: hookEditMode,
                        worktreeId: sourceInspectWorktreeId,
                      })}
                      onBlockedChange={(blocked) =>
                        reportHookScopeBlocked('root', blocked)
                      }
                      hooks={activeWorkspaceHooksForTab}
                      onChange={(updater) => {
                        setActiveWorkspaceHooksForTab((current) =>
                          updater(current),
                        );
                      }}
                      allowDisable={hookEditMode === 'local'}
                      pluginSelectionMode={
                        hookEditMode === 'source' ? 'portable' : 'full'
                      }
                      pipelineDiscoveryCwd={workspaceRootPipelineCwd}
                    />
                  </div>
                </Surface>

                {/* Per-repo hooks */}
                {workspace.repos.map((repo) => {
                  const hooks = activeRepoHooksForTab[repo.id] ?? {};
                  return (
                    <Surface variant="outline" padding="compact" key={repo.id}>
                      <div className="flex flex-col gap-3">
                        <Heading level={4} variant="title">
                          {repo.name}
                        </Heading>

                        <HookActionEditor
                          key={hookEditMode}
                          chatContext={resolveHookComposerContext({
                            workspaceId: workspace.id,
                            mode: hookEditMode,
                            worktreeId: sourceInspectWorktreeId,
                            repoId: repo.id,
                          })}
                          onBlockedChange={(blocked) =>
                            reportHookScopeBlocked(repo.id, blocked)
                          }
                          hooks={hooks}
                          onChange={(updater) => {
                            setActiveRepoHooksForTab((prev) => ({
                              ...prev,
                              [repo.id]: updater(prev[repo.id] ?? {}),
                            }));
                          }}
                          allowDisable={hookEditMode === 'local'}
                          pluginSelectionMode={
                            hookEditMode === 'source' ? 'portable' : 'full'
                          }
                          pipelineDiscoveryCwd={repoPipelineCwds[repo.id]}
                        />
                      </div>
                    </Surface>
                  );
                })}
              </>
            )}
          </Stack>
        )}

        {activeTab === 'plan-detection' && (
          <Stack gap="group">
            <WorkspacePlanDetectionSection workspaceId={workspace.id} />
          </Stack>
        )}

        {activeTab === 'claude-md' && (
          <Stack gap="inline" className="min-h-0 flex-1">
            <Stack gap="tight">
              <div className="flex items-center justify-between">
                <Heading level={3} variant="title">
                  Instructions
                </Heading>
                {!claudeMd.trim() && !claudeMdUnavailable && (
                  <Button
                    size="compact"
                    onClick={() => {
                      setClaudeMd(getDefaultWorkspaceClaudeMd(workspace.name));
                    }}
                  >
                    Initialize
                  </Button>
                )}
              </div>
              <p className="text-xs fg-secondary">
                {workspace.sourceRepoPath && !isTemporaryWorkspace
                  ? 'Stored in the attached project source repo.'
                  : 'Shared instructions for all worktrees in this project.'}
              </p>
            </Stack>
            {claudeMdLoadFailed && (
              <Notice
                className=""
                intent="destructive"
                title="Couldn't load instructions"
                data-testid="workspace-instructions-load-error"
                actions={
                  <NoticeButton
                    variant="primary"
                    onClick={handleRetryInstructionsLoad}
                    disabled={claudeMdRetrying}
                    data-testid="workspace-instructions-load-retry"
                  >
                    Try again
                  </NoticeButton>
                }
              >
                Editing is off so the saved file isn't overwritten.
              </Notice>
            )}
            <TextArea
              mono
              aria-label="Project instructions"
              value={claudeMd}
              onChange={(event) => setClaudeMd(event.target.value)}
              readOnly={claudeMdUnavailable}
              aria-readonly={claudeMdUnavailable}
              className="min-h-0 flex-1"
              data-testid="workspace-instructions-textarea"
              placeholder={
                claudeMdUnavailable
                  ? ''
                  : 'Add instructions for agents working in this project'
              }
            />
          </Stack>
        )}

        {activeTab === 'plugins' && (
          <Stack gap="group" className="flex-1 min-h-0">
            {workspace.sourceRepoPath && !isTemporaryWorkspace && (
              <SourceLocalToggle
                mode={pluginEditMode}
                onChange={setPluginEditMode}
                trailing={
                  pluginEditMode === 'local' ? (
                    <PluginSelectionScopeHelp />
                  ) : undefined
                }
              />
            )}
            {workspace.sourceRepoPath &&
            !isTemporaryWorkspace &&
            pluginEditMode === 'source' ? (
              !hasLoadedWorkspaceSettingsData && !workspaceSettingsLoadError ? (
                <SourcePluginsSkeleton
                  helperText={SOURCE_PLUGINS_HELPER_TEXT}
                />
              ) : workspaceSettingsLoadError ? (
                <Surface variant="group" padding="default">
                  <div className="flex flex-col gap-3 text-s">
                    <Stack gap="tight">
                      <p className="font-medium fg-primary">
                        Source-controlled plugins are unavailable.
                      </p>
                      <p className="fg-secondary">
                        {workspaceSettingsLoadError}
                      </p>
                    </Stack>
                    <div>
                      <Button
                        size="compact"
                        onClick={() => setPluginEditMode('local')}
                      >
                        Use local override
                      </Button>
                    </div>
                  </div>
                </Surface>
              ) : (
                <ShareablePluginSelector
                  selections={sourcePlugins}
                  onChange={setSourcePlugins}
                  helperText={SOURCE_PLUGINS_HELPER_TEXT}
                />
              )
            ) : (
              <Stack gap="item" className="flex-1 min-h-0">
                {(!workspace.sourceRepoPath || isTemporaryWorkspace) && (
                  <PluginSelectionScopeHelp />
                )}
                <RecommendedPluginsSettingsPanel
                  projectId={workspace.id}
                  worktreeId={sourceInspectWorktreeId}
                  onAppliedSelections={setPendingPlugins}
                  variant="compact"
                />
                <div className="flex flex-1 flex-col min-h-0">
                  <PluginSelector
                    selections={pendingPlugins}
                    onChange={setPendingPlugins}
                    inset={false}
                  />
                </div>
              </Stack>
            )}
          </Stack>
        )}

        {activeTab === 'environment' && (
          <WorkspaceEnvironmentTab
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            onManageEnvironments={() => {
              onClose();
              useNavigationStore.getState().openSettings('environment');
            }}
          />
        )}

        {activeTab === 'start-page' && startPageEnabled && (
          <CodeStartPageSettings
            project={workspace}
            initialWorktreeId={driftWorktreeId}
            initialMode={startPageIntent?.mode}
            prefill={startPageIntent?.prefill}
          />
        )}

        {activeTab === 'code-graph' && codeGraphExperimentEnabled && (
          <CodeGraphSummaryPanel
            advisorContext={{
              scope: 'workspace-shadow',
              workspaceId: workspace.id,
            }}
            load={(): ReturnType<
              typeof window.api.codeGraphGetWorkspaceSummary
            > =>
              window.api.codeGraphGetWorkspaceSummary({
                workspaceId: workspace.id,
              })
            }
            build={(): ReturnType<typeof window.api.codeGraphBuildWorkspace> =>
              window.api.codeGraphBuildWorkspace({ workspaceId: workspace.id })
            }
            onOpenSettings={(): void => {
              onClose();
              useNavigationStore.getState().openSettings('code-graph');
            }}
          />
        )}

        {activeTab === 'danger' && (
          <Stack gap="group">
            {!isTemporaryWorkspace && (
              <SettingsDangerConfirmBlock
                variant="warning"
                title="Convert to single-repo project"
                description={
                  <>
                    This removes the multi-repo manifest from{' '}
                    <code>canopy.json</code> and clears configured child repos
                    from local project tracking.
                  </>
                }
                warnings={[
                  workspace.worktrees.length > 0 && (
                    <p key="worktrees" className="text-xs fg-warning">
                      Remove all worktrees before converting this project.
                    </p>
                  ),
                  workspace.repos.length > 0 && (
                    <p key="repos" className="text-xs fg-warning">
                      Configured child repos will be removed from project
                      tracking.
                    </p>
                  ),
                  !workspace.sourceRepoPath && (
                    <p key="source" className="text-xs fg-warning">
                      This project is missing its required source repo path and
                      cannot be converted until that is repaired.
                    </p>
                  ),
                ]}
                triggerDisabled={
                  workspace.worktrees.length > 0 || !workspace.sourceRepoPath
                }
                triggerLabel="Convert to single-repo…"
                confirming={confirmingConvertToSingle}
                onConfirmStart={() => setConfirmingConvertToSingle(true)}
                onConfirmCancel={() => setConfirmingConvertToSingle(false)}
                onConfirm={() => void handleConvertToSingleRepo()}
                isWorking={isConverting}
                confirmLabel="Confirm convert"
                confirmInProgressLabel="Converting…"
              />
            )}

            <SettingsDangerConfirmBlock
              title="Delete project"
              description="This will remove the project and all its worktrees. Repository source code is not affected."
              warnings={[
                removalDisabledReason ? (
                  <p className="text-xs fg-destructive/80">
                    {removalDisabledReason}
                  </p>
                ) : hasActiveWorktrees ? (
                  <p className="text-xs fg-destructive/80">
                    Cannot delete while worktrees have active sessions.
                  </p>
                ) : undefined,
              ]}
              triggerDisabled={
                hasActiveWorktrees || removalDisabledReason !== undefined
              }
              triggerLabel="Delete project…"
              confirming={confirmingDelete}
              onConfirmStart={() => setConfirmingDelete(true)}
              onConfirmCancel={() => setConfirmingDelete(false)}
              onConfirm={() => void handleDeleteWorkspace()}
              isWorking={isDeleting}
              confirmLabel="Confirm delete"
              confirmInProgressLabel="Deleting…"
            />
          </Stack>
        )}
      </div>

      {/* Save footer */}
      {showAddToWorktreeFooter && (
        <div
          className={`flex items-center border-t px-6 py-3 ${
            isTemporaryWorkspace ? 'justify-end' : 'justify-between'
          }`}
        >
          {!isTemporaryWorkspace && (
            <SourceWorktreePicker
              selectedWorktreeId={sourceInspectWorktreeId}
              onChange={setSourceInspectWorktreeId}
              worktrees={workspace.worktrees}
              open={worktreeDropdownOpen}
              onOpenChange={setWorktreeDropdownOpen}
              helpTooltipId="workspace-settings-help-tooltip"
            />
          )}
          {/* Action buttons — right side */}
          <div className="flex items-center gap-2">
            {isLocalDirty && (
              <SaveLocalButton
                disabled={
                  hookComposerBlocked ||
                  isSaving ||
                  isApplyingToWorktree ||
                  hasInvalidDevServerPatterns
                }
                isSaving={isSaving}
                onClick={() => void handleSaveLocal()}
              />
            )}
            <AddToWorktreeActionControls
              show={showAddToWorktreeAction === true}
              sourceInspectWorktreeId={sourceInspectWorktreeId}
              worktrees={workspace.worktrees}
              feedback={addToWorktreeFeedback}
              buttonLabel={addToWorktreeButtonLabel}
              disabled={
                isSaving ||
                isApplyingToWorktree ||
                hookComposerBlocked ||
                hasInvalidDevServerPatterns
              }
              existingDropdownOpen={existingWorktreeDropdownOpen}
              onExistingDropdownOpenChange={setExistingWorktreeDropdownOpen}
              onAddToWorktree={(target) => void handleAddToWorktree(target)}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="border-t px-6 py-3">
          <ErrorBanner
            className=""
            error={error}
            details={detailsFor(error, errorFailure)}
          />
        </div>
      )}

      <SettingsTeardownFailureDialog
        error={teardownError}
        isRetrying={isTeardownRetrying}
        archiveWorktree={archiveWorktree}
        forceArchiveWorktree={forceArchiveWorktree}
        onRetryDelete={handleDeleteWorkspace}
        onRetryingChange={setIsTeardownRetrying}
        onErrorChange={setTeardownError}
        onFailure={setError}
      />
    </DialogModal>
  );
}

/**
 * Settings-block UI for converting a temporary adhoc multi-repo workspace
 * into a permanent, source-controllable one. Only mounted when the workspace
 * has `temporary === true`. Wraps `window.api.promoteTemporaryWorkspace` and
 * surfaces backend errors locally so they don't disrupt the rest of the
 * General tab.
 */
function TemporaryWorkspacePromotionCard({
  workspaceId,
  defaultName,
  onPromoted,
}: {
  workspaceId: string;
  defaultName: string;
  onPromoted: () => void;
}): JSX.Element {
  const [name, setName] = useState(defaultName);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorFailure, setErrorFailure] = useState<FailureDetails | null>(null);
  const addToast = useGitHubStore((state) => state.addToast);

  useEffect(() => {
    setName(defaultName);
  }, [defaultName]);

  const trimmed = name.trim();
  const disabled = isSaving || trimmed.length === 0;

  const handlePromote = useCallback(async (): Promise<void> => {
    if (disabled) return;
    setErrorMessage(null);
    setIsSaving(true);
    try {
      await window.api.promoteTemporaryWorkspace({
        workspaceId,
        name: trimmed,
      });
      onPromoted();
      addToast('Project made permanent', 'success');
    } catch (cause) {
      setErrorMessage('Couldn’t make the project permanent. Try again.');
      setErrorFailure(
        failureDetails(
          'Couldn’t make the project permanent. Try again.',
          cause,
        ),
      );
    } finally {
      setIsSaving(false);
    }
  }, [addToast, disabled, onPromoted, trimmed, workspaceId]);

  return (
    <Surface
      variant="outline"
      gap="item"
      padding="default"
      data-testid="temporary-workspace-promotion"
    >
      <Stack gap="tight">
        <Heading level={3} variant="title">
          Temporary project
        </Heading>
        <p className="text-xs fg-secondary">
          This project was created for an adhoc multi-repo worktree. Make it
          permanent to keep it after its worktrees are deleted.
        </p>
      </Stack>
      <div>
        <FormField label="Project name">
          {(control) => (
            <TextInput
              {...control}
              density="settings"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-multi-repo-project"
              data-testid="temporary-workspace-promotion-name"
            />
          )}
        </FormField>
      </div>
      <Stack gap="inline">
        <div className="flex items-center gap-2">
          <Button
            size="compact"
            onClick={() => void handlePromote()}
            disabled={disabled}
            data-testid="temporary-workspace-promotion-submit"
          >
            {isSaving ? 'Saving…' : 'Make permanent'}
          </Button>
        </div>
        <ErrorBanner
          className=""
          error={errorMessage}
          details={detailsFor(errorMessage, errorFailure)}
          testId="temporary-workspace-promotion-error"
        />
      </Stack>
    </Surface>
  );
}
