import { resolveHookComposerContext } from '@/lib/configurationComposerTargets';
import { detailsFor, failureDetails, type FailureDetails } from '@/lib/errors';
import {
  offerLifecycleJournalQuarantine,
  offerProjectDeletionDiscard,
} from '@canopy/app-state';
import {
  Button,
  ConfirmDialog,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  FieldError,
  ListRow,
  PluginSelectionScopeHelp,
  SettingsSaveStatus,
  Skeleton,
  ToggleSwitch,
  type SettingsSaveState,
  EmptyStateRow,
} from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { normalizeScriptName } from '@canopy/desktop-shared/scripts';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type {
  ChatTabPluginSelections,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  buildShareablePluginDisplay,
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
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
import {
  canSubmitProjectSourceDraft,
  hasProjectSourceDraft,
  hasProjectSourceHookDraft,
  projectSettingsPageForTab,
  shouldResetProjectSettingsModalState,
  type ProjectSettingsPageId,
  type ProjectSettingsTab,
} from '@/lib/projectSettingsModalState';
import { applyHydratedSourceScripts } from '@/lib/sourceScriptsHydration';
import { applyHydratedSourceHooks } from '@/lib/sourceHooksHydration';
import {
  createEditableScripts,
  getEditableCustomScripts,
  getEditableScriptDevServerPatterns,
  getEditableScriptInteractive,
  getEditableScriptShell,
  getEditableScriptTimeoutSeconds,
  getEditableScriptValue,
  hasInvalidDevServerPatterns as draftHasInvalidDevServerPatterns,
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
import type { CommandShellDefinition } from '@canopy/desktop-shared/scripts';
import {
  createEditableHooks,
  toHookInputMap,
  serializeHooks,
  type EditableHookAction,
  type EditableHooks,
} from '@/lib/editableHooks';
import {
  compareTriggerNames,
  getHookTriggerDisplayName,
} from '@canopy/desktop-shared/hooks';
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
import { brandText } from '@/lib/brand';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { RepoRulesStatusCard } from '@canopy/ui-app/repo-rules';
import {
  openRepoRulesModal,
  useRepoRulesModalStore,
} from '@/stores/repoRulesModalStore';
import { HookActionEditor } from './HookActionEditor';
import { ScriptConfigEditor } from './ScriptConfigEditor';
import { ScriptActionsSettingsSection } from '../script-actions/ScriptActionsSettingsSection';
import { CopyButton, DialogModal } from '../shared';
import { PrivateMemoryCard } from '@canopy/ui-shared';
import { PluginSelector } from '../shared/PluginSelector';
import { ShareablePluginSelector } from '../shared/ShareablePluginSelector';
import { RecommendedPluginsSettingsPanel } from './RecommendedPluginsSettingsPanel';
import {
  AddToWorktreeActionControls,
  SettingsTeardownFailureDialog,
  SourceWorktreePicker,
  type SettingsScope,
} from './WorktreeSettingsControls';
import {
  serializeEditableScriptsForSettings,
  useDefaultScriptTimeoutSeconds,
  useWorkspaceSettingsData,
  type AddToWorktreeFeedback,
} from './worktree-settings-controls-state';
import {
  CodeBracketsIcon,
  GraphIcon,
  LayoutWindowIcon,
  PlanModeIcon,
  PlusIcon,
  PluginsIcon,
  SettingsIcon,
  TerminalBorderedIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { WorkspaceEnvironmentTab } from './WorkspaceEnvironmentTab';
import { WorkspacePlanDetectionSection } from './WorkspacePlanDetectionSection';
import { CodeGraphSummaryPanel } from './CodeGraphSummaryPanel';
import { useNavigationStore } from '@/stores/navigationStore';
import { useCodeGraphExperimentEnabled } from '@/hooks/useCodeGraphExperimentEnabled';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { WorkspaceReadinessRecommendations } from './WorkspaceReadinessRecommendations';
import { resolveWorkspaceReadinessWorktreeId } from '@/lib/workspaceReadinessLauncher';
import { useCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import { CodeStartPageSettings } from '../settings/start-page/CodeStartPageSettings';
import type { StartPageSettingsIntent } from '@/stores/navigationStore';
import { usePrivateMemoryDraft } from '@/hooks/usePrivateMemoryDraft';
import {
  AUTOSAVE_SAVED_HOLD_MS,
  combineSaveStates,
  useAutosave,
} from '@/hooks/useAutosave';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsTextField,
} from '../settings/SettingsLayout';
import {
  ProjectSettingsFrame,
  type ProjectSettingsNavItem,
} from './project-settings/ProjectSettingsFrame';
import { ProjectSettingsScopeGroup } from './project-settings/ProjectSettingsScope';
import { workspaceHealthIssueClassName } from './workspace-health-styles';

/** A page that opens from a row of its parent page, with a way back. */
type ProjectSettingsDrillIn =
  | { readonly kind: 'recommended-plugins' }
  | { readonly kind: 'chat-plugins' }
  /** One hook's actions, or the form that adds a hook (`null`). */
  | { readonly kind: 'hook'; readonly trigger: string | null };

/** One line about a hook's actions, for the row that opens it. */
/**
 * The draft a save for this computer sent, field by field. A field is
 * dropped once a refresh shows its value stored.
 */
interface SentLocalDraft {
  scripts?: string;
  hooks?: string;
  plugins?: string;
  alwaysShow?: boolean;
  retention?: string;
  autoArchiveEnabled?: boolean;
  autoArchiveDays?: number;
  autoArchiveDeleteBranch?: boolean;
}

/** A retention draft as the value it saves, so equal values compare equal. */
function retentionKey(draft: ArchiveRetentionDraft): string {
  return JSON.stringify(
    toArchiveRetentionDraft(
      'single-repo',
      toPersistedArchiveRetentionDays('single-repo', draft),
    ),
  );
}

const SENT_FIELDS = [
  'scripts',
  'hooks',
  'plugins',
  'alwaysShow',
  'retention',
  'autoArchiveEnabled',
  'autoArchiveDays',
  'autoArchiveDeleteBranch',
] as const satisfies readonly (keyof SentLocalDraft)[];

/** The stored value of each field a save for this computer can write. */
function storedLocalDraft(project: SingleRepoSidebarItem): SentLocalDraft {
  return {
    scripts: serializeScripts(createEditableScripts(project.scripts)),
    hooks: serializeHooks(createEditableHooks(project.hooks)),
    plugins: normalizeSelections(
      project.defaultPluginSelections ?? EMPTY_SELECTIONS,
    ),
    alwaysShow: project.alwaysShow !== false,
    retention: retentionKey(
      toArchiveRetentionDraft('single-repo', project.archiveRetentionDays),
    ),
    autoArchiveEnabled: project.autoArchiveDays != null,
    autoArchiveDays: project.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS,
    autoArchiveDeleteBranch: project.autoArchiveDeleteBranch === true,
  };
}

/** Sections that write through their own store and report their saves. */
type OwnSaveSection = 'environment' | 'plans' | 'start-page';
const OWN_SAVE_SECTIONS: readonly OwnSaveSection[] = [
  'environment',
  'plans',
  'start-page',
];

function isOwnSaveSection(page: string): page is OwnSaveSection {
  return OWN_SAVE_SECTIONS.some((section) => section === page);
}

function hookActionsSummary(actions: EditableHookAction[] | null): string {
  if (actions === null) return 'Off on this computer';
  const parts = actions.map((action) => {
    if (action.type === 'command') {
      return `Command · ${commandSummary(action.command)}`;
    }
    if (action.type === 'chat') {
      return `Chat · ${commandSummary(action.prompt) || 'No prompt yet'}`;
    }
    return `Workflow · ${action.id}`;
  });
  return parts.join(', ');
}

const PAGE_COPY: Record<
  ProjectSettingsPageId,
  { readonly label: string; readonly description: string }
> = {
  general: {
    label: 'General',
    description: 'Where this project lives and how it shows up in the sidebar.',
  },
  scripts: {
    label: 'Scripts and hooks',
    description:
      'Commands that set up, start and clean up each worktree, and hooks that react to pull requests.',
  },
  plans: {
    label: 'Plans',
    description:
      'Find plan documents in agent chats. Rules come from your settings, canopy.json and this page.',
  },
  plugins: {
    label: 'Plugins',
    description:
      'Plugins this project recommends, and the ones new chats start with.',
  },
  environment: {
    label: 'Environment',
    description:
      'Where this project’s scripts, agents and workflows run. Anything unassigned uses your defaults in Settings.',
  },
  'start-page': {
    label: 'Start page',
    description: 'What opens first in each new worktree.',
  },
  'code-graph': {
    label: 'Code Graph',
    description:
      'A map of files, symbols and calls that agents use to find their way around this project.',
  },
};

const PAGE_ICONS: Record<ProjectSettingsPageId, ReactNode> = {
  general: <SettingsIcon size="sm" />,
  scripts: <TerminalBorderedIcon size="sm" />,
  plans: <PlanModeIcon size="sm" />,
  plugins: <PluginsIcon size="sm" />,
  environment: <CodeBracketsIcon size="sm" />,
  'start-page': <LayoutWindowIcon size="sm" />,
  'code-graph': <GraphIcon size="sm" />,
};

const PAGE_ORDER: readonly ProjectSettingsPageId[] = [
  'general',
  'scripts',
  'plans',
  'plugins',
  'environment',
  'start-page',
  'code-graph',
];

interface ProjectSettingsModalProps {
  onOpenSharedDestination?: (workspaceId: string) => void;
  isOpen: boolean;
  onClose: () => void;
  project: SingleRepoSidebarItem;
  initialTab?: ProjectSettingsTab;
  driftWorktreeId?: string;
  startPageIntent?: StartPageSettingsIntent;
}

function serializeScripts(scripts: EditableScripts): string {
  return serializeEditableScriptsForSettings(toScriptInputMap(scripts));
}

function scheduleAfterClosePaint(callback: () => void): void {
  window.requestAnimationFrame(() => {
    window.setTimeout(callback, 0);
  });
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

function shareablePluginRefKeyOrNull(ref: ShareablePluginRef): string | null {
  try {
    return getShareablePluginRefKey(ref);
  } catch {
    return null;
  }
}

/** Plain recommendations the loading skeleton lays out as plugin rows. */
const SAMPLE_RECOMMENDED_PLUGINS = [
  { title: 'Code review', subtitle: 'Skill · github.com/acme/skills' },
  { title: 'Release notes', subtitle: 'Plugin · Acme marketplace' },
] as const;

const noop = (): void => undefined;

function RecommendedPluginRow({
  title,
  subtitle,
  onRemove,
}: {
  title: string;
  subtitle: string;
  onRemove: () => void;
}): JSX.Element {
  return (
    <SettingsRow
      label={title}
      description={subtitle}
      control={
        <Button
          size="compact"
          variant="ghost"
          iconOnly
          aria-label={`Stop recommending ${title}`}
          onClick={onRemove}
        >
          <TrashIcon aria-hidden={true} />
        </Button>
      }
    />
  );
}

function countPluginSelections(selections: ChatTabPluginSelections): number {
  const normalized = normalizePluginSelections(selections);
  return (
    normalized.collectionIds.length +
    normalized.skillRefs.length +
    normalized.pluginRefs.length +
    (normalized.mcpServerRefs?.length ?? 0)
  );
}

/** The first line of a command, for a row that summarizes it. */
function commandSummary(command: string): string {
  const firstLine = command
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  return firstLine ?? command.trim();
}

const SCRIPT_PHASES = [
  {
    key: 'setup',
    label: 'Setup script',
    description: 'Runs in each new worktree.',
    placeholder: '# Runs after worktree creation\nnpm install',
  },
  {
    key: 'launch',
    label: 'Launch script',
    description: 'Starts the project when you press Launch.',
    placeholder: '# Triggered manually\nnpm run dev',
  },
  {
    key: 'teardown',
    label: 'Teardown script',
    description: 'Runs before a worktree is archived or deleted.',
    placeholder: '# Runs before worktree archive\nnpm run clean',
  },
] as const;

export function ProjectSettingsModal({
  isOpen,
  onClose,
  project,
  initialTab,
  driftWorktreeId,
  startPageIntent,
}: ProjectSettingsModalProps): JSX.Element | null {
  const archiveWorktree = useProjectsStore((state) => state.archiveWorktree);
  const forceArchiveWorktree = useProjectsStore(
    (state) => state.forceArchiveWorktree,
  );
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const setAppliedProjectWorktreeScripts = useProjectsStore(
    (state) => state.setAppliedProjectWorktreeScripts,
  );
  const setAppliedProjectWorktreeHooks = useProjectsStore(
    (state) => state.setAppliedProjectWorktreeHooks,
  );

  const [activePage, setActivePage] = useState<ProjectSettingsPageId>(() =>
    projectSettingsPageForTab(initialTab),
  );
  const [drillIn, setDrillIn] = useState<ProjectSettingsDrillIn | null>(null);
  // Pages that write through their own store stay mounted once opened, so
  // a save they run or hold is not dropped when another page opens.
  const [openedOwnSavePages, setOpenedOwnSavePages] = useState<
    readonly OwnSaveSection[]
  >([]);
  useEffect(() => {
    if (!isOwnSaveSection(activePage)) return;
    setOpenedOwnSavePages((current) =>
      current.includes(activePage) ? current : [...current, activePage],
    );
  }, [activePage]);
  // An Environment choice that cannot be written now (it waits for Retry).
  const [environmentUnsaved, setEnvironmentUnsaved] = useState(false);
  // Reload the saved Cursor rules setting when the review closes.
  const repoRulesRefreshToken = useRepoRulesModalStore((state) =>
    state.target ? 0 : state.openCount,
  );
  useCurrentUiStateReporter(
    'workspaceSettings.modal',
    isOpen
      ? {
          open: true,
          workspaceId: project.id,
          workspaceType: 'single-repo',
          // App Advisor reads the settings tab names it already knows.
          activeTab: activePage === 'plans' ? 'plan-detection' : activePage,
        }
      : null,
  );
  const codeGraphExperimentEnabled = useCodeGraphExperimentEnabled();
  const startPageEnabled = useCanopyDesktopStartPageEnabled();
  const privateMemory = usePrivateMemoryDraft(project);
  const resetPrivateMemory = privateMemory.reset;

  const visiblePages = useMemo(
    (): ProjectSettingsNavItem<ProjectSettingsPageId>[] =>
      PAGE_ORDER.filter(
        (page) =>
          (page !== 'start-page' || startPageEnabled) &&
          (page !== 'code-graph' || codeGraphExperimentEnabled),
      ).map((page) => ({
        id: page,
        label: PAGE_COPY[page].label,
        icon: PAGE_ICONS[page],
      })),
    [codeGraphExperimentEnabled, startPageEnabled],
  );

  // A flag turned off at runtime moves the user off its page.
  useEffect(() => {
    if (!visiblePages.some((page) => page.id === activePage)) {
      setActivePage('general');
    }
  }, [activePage, visiblePages]);

  const [pendingPlugins, setPendingPlugins] = useState<ChatTabPluginSelections>(
    normalizePluginSelections(
      project.defaultPluginSelections ?? EMPTY_SELECTIONS,
    ),
  );
  const [pendingScripts, setPendingScripts] = useState<EditableScripts>(
    createEditableScripts(project.scripts),
  );
  // The script row whose editor is open, and the custom-script draft.
  const [editingScript, setEditingScript] = useState<string | null>(null);
  const [addingScript, setAddingScript] = useState(false);
  const [newScriptName, setNewScriptName] = useState('');
  const [newScriptCommand, setNewScriptCommand] = useState('');
  // Timeout for the new custom-script draft. `undefined` keeps the global
  // default; `null` disables the timeout entirely.
  const [newScriptTimeoutSeconds, setNewScriptTimeoutSeconds] = useState<
    number | null | undefined
  >(undefined);
  const [newScriptDevServerPatterns, setNewScriptDevServerPatterns] = useState<
    EditableDevServerPattern[] | undefined
  >(undefined);
  const [newScriptShell, setNewScriptShell] = useState<
    CommandShellDefinition | undefined
  >(undefined);
  const [newScriptInteractive, setNewScriptInteractive] = useState(false);
  // Map of "validity scope id" → array of offending row ids. The pattern
  // checks below (`localPatternsInvalid` and the others) read it by scope.
  const [devServerPatternsInvalidRows, setDevServerPatternsInvalidRows] =
    useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [errorFailure, setErrorFailure] = useState<FailureDetails | null>(null);
  // Why removing or converting failed, shown under the Manage rows.
  const [manageError, setManageError] = useState('');
  const [manageFailure, setManageFailure] = useState<FailureDetails | null>(
    null,
  );
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
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [isLoadingRemote, setIsLoadingRemote] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [teardownError, setTeardownError] =
    useState<TeardownFailedError | null>(null);
  const [isTeardownRetrying, setIsTeardownRetrying] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  // Set while the pending change is written before converting. Separate from
  // isConverting, which holds the autosave that this write needs.
  const [isPreparingConvert, setIsPreparingConvert] = useState(false);
  const [showConvertOptions, setShowConvertOptions] = useState(false);
  const [pendingAlwaysShow, setPendingAlwaysShow] = useState(
    project.alwaysShow !== false,
  );
  const [pendingRetention, setPendingRetention] =
    useState<ArchiveRetentionDraft>(() =>
      toArchiveRetentionDraft('single-repo', project.archiveRetentionDays),
    );
  const [pendingAutoArchiveEnabled, setPendingAutoArchiveEnabled] = useState(
    typeof project.autoArchiveDays === 'number' && project.autoArchiveDays > 0,
  );
  const [pendingAutoArchiveDays, setPendingAutoArchiveDays] = useState(
    typeof project.autoArchiveDays === 'number' && project.autoArchiveDays > 0
      ? project.autoArchiveDays
      : DEFAULT_AUTO_ARCHIVE_DAYS,
  );
  const [pendingAutoArchiveDeleteBranch, setPendingAutoArchiveDeleteBranch] =
    useState(project.autoArchiveDeleteBranch === true);
  const defaultScriptTimeoutSeconds = useDefaultScriptTimeoutSeconds(isOpen);

  // Worktree selector for source-controlled view
  const [hookComposerBlocked, setHookComposerBlocked] = useState(false);
  const [sourceInspectWorktreeId, setSourceInspectWorktreeId] = useState<
    string | undefined
  >(driftWorktreeId);

  // Resolve a cwd for project pipeline discovery in the hook editor.
  // When a worktree is being inspected we look up its path via getWorktreePath
  // so the pipeline picker reflects what is actually checked out; otherwise
  // we fall back to the project's source repo path.
  const [pipelineDiscoveryCwd, setPipelineDiscoveryCwd] = useState<
    string | undefined
  >(undefined);

  // One "Save changes to" choice for scripts and hooks: canopy.json changes
  // go into a worktree; changes on this computer save as they are made.
  const [scope, setScope] = useState<SettingsScope>(
    driftWorktreeId ? 'source' : 'local',
  );
  const [sourceScripts, setSourceScripts] = useState<EditableScripts>({});
  const [loadedSourceScripts, setLoadedSourceScripts] =
    useState<EditableScripts>({});
  const sourceScriptsRef = useRef<EditableScripts>({});
  const loadedSourceScriptsRef = useRef<EditableScripts>({});

  // Hook state (mirrors scripts)
  const [pendingHooks, setPendingHooks] = useState<EditableHooks>(
    createEditableHooks(project.hooks),
  );
  const [sourceHooks, setSourceHooks] = useState<EditableHooks>({});
  const [loadedSourceHooks, setLoadedSourceHooks] = useState<EditableHooks>({});
  const sourceHooksRef = useRef<EditableHooks>({});
  const loadedSourceHooksRef = useRef<EditableHooks>({});
  const [sourcePlugins, setSourcePlugins] = useState<ShareablePluginRef[]>([]);
  const wasOpenRef = useRef(false);
  const isOpenRef = useRef(isOpen);
  const activeProjectIdRef = useRef(project.id);
  const sourceInspectWorktreeIdRef = useRef(sourceInspectWorktreeId);
  const [isApplyingToWorktree, setIsApplyingToWorktree] = useState(false);
  const {
    healthData,
    setHealthData,
    hasLoadedWorkspaceSettingsData,
    workspaceSettingsLoadError,
  } = useWorkspaceSettingsData({
    isOpen,
    workspaceId: project.id,
    worktreeId: sourceInspectWorktreeId,
    fallbackErrorMessage: 'Failed to load source-controlled scripts.',
  });
  const [addToWorktreeFeedback, setAddToWorktreeFeedback] =
    useState<AddToWorktreeFeedback>({ phase: 'idle' });
  const [worktreeDropdownOpen, setWorktreeDropdownOpen] = useState(false);
  const [existingWorktreeDropdownOpen, setExistingWorktreeDropdownOpen] =
    useState(false);
  // Save lines of the sections that write through their own store. A
  // section's "Saved" rests after the same hold as the page's own saves.
  const [sectionSaveStates, setSectionSaveStates] = useState<
    Partial<Record<OwnSaveSection, SettingsSaveState>>
  >({});
  const sectionRestTimersRef = useRef<Partial<Record<OwnSaveSection, number>>>(
    {},
  );
  const reportSectionSave = useCallback(
    (section: OwnSaveSection, state: SettingsSaveState): void => {
      setSectionSaveStates((current) => ({ ...current, [section]: state }));
      const timer = sectionRestTimersRef.current[section];
      if (timer !== undefined) window.clearTimeout(timer);
      delete sectionRestTimersRef.current[section];
      if (state !== 'saved') return;
      sectionRestTimersRef.current[section] = window.setTimeout(() => {
        delete sectionRestTimersRef.current[section];
        setSectionSaveStates((current) =>
          current[section] === 'saved'
            ? { ...current, [section]: 'idle' }
            : current,
        );
      }, AUTOSAVE_SAVED_HOLD_MS);
    },
    [],
  );
  useEffect(
    () => (): void => {
      for (const timer of Object.values(sectionRestTimersRef.current)) {
        window.clearTimeout(timer);
      }
    },
    [],
  );
  const reportEnvironmentSave = useCallback(
    (state: SettingsSaveState): void => reportSectionSave('environment', state),
    [reportSectionSave],
  );
  const reportPlansSave = useCallback(
    (state: SettingsSaveState): void => reportSectionSave('plans', state),
    [reportSectionSave],
  );
  // Sections that write on their own give the page a way to wait for them
  // before it closes.
  const sectionFlushesRef = useRef<
    Partial<Record<OwnSaveSection, () => Promise<boolean>>>
  >({});
  const registerSectionFlush = useCallback(
    (section: OwnSaveSection, flush: (() => Promise<boolean>) | null): void => {
      if (flush) sectionFlushesRef.current[section] = flush;
      else delete sectionFlushesRef.current[section];
    },
    [],
  );
  const registerStartPageFlush = useCallback(
    (flush: (() => Promise<boolean>) | null): void =>
      registerSectionFlush('start-page', flush),
    [registerSectionFlush],
  );
  const registerEnvironmentFlush = useCallback(
    (flush: (() => Promise<boolean>) | null): void =>
      registerSectionFlush('environment', flush),
    [registerSectionFlush],
  );
  const reportStartPageSave = useCallback(
    (state: SettingsSaveState): void => reportSectionSave('start-page', state),
    [reportSectionSave],
  );

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    sourceInspectWorktreeIdRef.current = sourceInspectWorktreeId;
  }, [sourceInspectWorktreeId]);

  // Dirty-state calculations
  const localScriptsDirty =
    serializeScripts(pendingScripts) !==
    serializeScripts(createEditableScripts(project.scripts));
  const sourceScriptsDirty =
    serializeScripts(sourceScripts) !== serializeScripts(loadedSourceScripts);
  const localHooksDirty =
    serializeHooks(pendingHooks) !==
    serializeHooks(createEditableHooks(project.hooks));
  const sourceHooksDirty =
    serializeHooks(sourceHooks) !== serializeHooks(loadedSourceHooks);
  const pluginsDirty =
    normalizeSelections(pendingPlugins) !==
    normalizeSelections(project.defaultPluginSelections ?? EMPTY_SELECTIONS);
  const alwaysShowDirty = pendingAlwaysShow !== (project.alwaysShow !== false);
  const archiveRetentionDirty = isArchiveRetentionDraftDirty(
    'single-repo',
    project.archiveRetentionDays,
    pendingRetention,
  );
  const nextAutoArchiveDays = pendingAutoArchiveEnabled
    ? pendingAutoArchiveDays
    : null;
  const autoArchiveDirty =
    (project.autoArchiveDays ?? null) !== nextAutoArchiveDays ||
    (project.autoArchiveDeleteBranch === true) !==
      pendingAutoArchiveDeleteBranch;
  const sourcePluginsDirty =
    serializeShareablePluginRefs(sourcePlugins) !==
    serializeShareablePluginRefs(healthData?.manifest?.plugins ?? []);
  // Local override scripts and hooks wait for Save local; the rest of this
  // computer's settings save as they are made.
  const isLocalOverrideDirty = localScriptsDirty || localHooksDirty;
  const isLocalDirty =
    pluginsDirty ||
    alwaysShowDirty ||
    archiveRetentionDirty ||
    autoArchiveDirty ||
    privateMemory.dirty;
  const isSourceDirty =
    sourceScriptsDirty || sourceHooksDirty || sourcePluginsDirty;
  const hasSourceDraft =
    hasProjectSourceDraft(sourceScripts, healthData) ||
    hasProjectSourceHookDraft(sourceHooks, healthData);

  const setSourceScriptsWithRef = useCallback(
    (update: SetStateAction<EditableScripts>): void => {
      const next =
        typeof update === 'function'
          ? update(sourceScriptsRef.current)
          : update;
      sourceScriptsRef.current = next;
      setSourceScripts(next);
    },
    [],
  );

  // Scripts and hooks for the chosen scope.
  const activeScriptsForTab =
    scope === 'source' ? sourceScripts : pendingScripts;
  const setActiveScriptsForTab =
    scope === 'source' ? setSourceScriptsWithRef : setPendingScripts;
  const activeHooksForTab = scope === 'source' ? sourceHooks : pendingHooks;
  const setActiveHooksForTab =
    scope === 'source' ? setSourceHooks : setPendingHooks;

  useEffect(() => {
    loadedSourceScriptsRef.current = loadedSourceScripts;
  }, [loadedSourceScripts]);

  useEffect(() => {
    sourceHooksRef.current = sourceHooks;
  }, [sourceHooks]);

  useEffect(() => {
    loadedSourceHooksRef.current = loadedSourceHooks;
  }, [loadedSourceHooks]);

  const hasActiveWorktrees = useChatSidebarStore((state) =>
    project.worktrees.some((wt) => {
      const wc = state.worktrees[`${project.id}/${wt.id}`];
      return wc?.tabs.some((tab) => tab.status === 'streaming') ?? false;
    }),
  );
  const delegationByChat = useDelegationActivityStore((state) => state.byChat);
  const providerTasksByChat = useLiveBackgroundTaskStore(
    (state) => state.byChat,
  );
  const removalDisabledReason = removalBlockedReason(
    getWorkspaceRemovalBlocker(
      project.id,
      { byChat: delegationByChat },
      { byChat: providerTasksByChat },
    ),
  );

  // Reset state on open
  useEffect(() => {
    const shouldReset = shouldResetProjectSettingsModalState(
      isOpen,
      wasOpenRef.current,
      activeProjectIdRef.current,
      project.id,
    );

    if (shouldReset) {
      setActivePage(projectSettingsPageForTab(initialTab));
      setOpenedOwnSavePages([]);
      setDrillIn(null);
      setPendingPlugins(
        normalizePluginSelections(
          project.defaultPluginSelections ?? EMPTY_SELECTIONS,
        ),
      );
      setPendingScripts(createEditableScripts(project.scripts));
      setEditingScript(null);
      setAddingScript(false);
      setNewScriptName('');
      setNewScriptCommand('');
      setNewScriptTimeoutSeconds(undefined);
      setNewScriptDevServerPatterns(undefined);
      setDevServerPatternsInvalidRows({});
      setError('');
      setManageError('');
      setConfirmingDelete(false);
      setLinkUrl('');
      setLinkError('');
      setTeardownError(null);
      setHealthData(null);
      setIsConverting(false);
      setShowConvertOptions(false);
      setPendingAlwaysShow(project.alwaysShow !== false);
      resetPrivateMemory();
      setPendingRetention(
        toArchiveRetentionDraft('single-repo', project.archiveRetentionDays),
      );
      setPendingAutoArchiveEnabled(project.autoArchiveDays != null);
      setPendingAutoArchiveDays(
        project.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS,
      );
      setPendingAutoArchiveDeleteBranch(
        project.autoArchiveDeleteBranch === true,
      );
      setSourceInspectWorktreeId(driftWorktreeId);
      setScope(driftWorktreeId ? 'source' : 'local');
      sourceScriptsRef.current = {};
      loadedSourceScriptsRef.current = {};
      setSourceScripts({});
      setLoadedSourceScripts({});
      setPendingHooks(createEditableHooks(project.hooks));
      sourceHooksRef.current = {};
      loadedSourceHooksRef.current = {};
      setSourceHooks({});
      setLoadedSourceHooks({});
      setSourcePlugins([]);
      setIsApplyingToWorktree(false);
      setSectionSaveStates({});
      // hasLoadedWorkspaceSettingsData / workspaceSettingsLoadError are owned
      // by useWorkspaceSettingsData and reset automatically when the load
      // effect re-runs on isOpen / workspaceId / worktreeId changes.
      setAddToWorktreeFeedback({ phase: 'idle' });
      setWorktreeDropdownOpen(false);
      setExistingWorktreeDropdownOpen(false);
    }

    wasOpenRef.current = isOpen;
    activeProjectIdRef.current = project.id;
  }, [
    driftWorktreeId,
    initialTab,
    isOpen,
    project.id,
    project.alwaysShow,
    project.archiveRetentionDays,
    project.autoArchiveDays,
    project.autoArchiveDeleteBranch,
    project.defaultPluginSelections,
    project.hooks,
    project.scripts,
    resetPrivateMemory,
    setHealthData,
  ]);

  // The project can refresh while the page is open (a save here, or a
  // change made elsewhere). A draft the user has not touched follows the
  // refreshed value, so a refresh alone never looks like a change to save
  // and never writes old values back. A touched draft is kept. A draft that
  // equals the old value but differs from what the running save sent was set
  // back meanwhile: it is kept too, and saved next.
  const refreshBaseRef = useRef(project);
  const sentDraftRef = useRef<SentLocalDraft>({});
  useEffect(() => {
    const previous = refreshBaseRef.current;
    refreshBaseRef.current = project;
    if (!isOpen || previous === project || previous.id !== project.id) return;
    // A copy: the updaters below run later, after the handled fields are
    // dropped from the ref.
    const sent: SentLocalDraft = { ...sentDraftRef.current };
    const follows = <K extends keyof SentLocalDraft>(
      field: K,
      draft: SentLocalDraft[K],
      untouched: boolean,
    ): boolean =>
      untouched && (sent[field] === undefined || sent[field] === draft);
    // Fields whose sent value is now stored: that save is settled for them.
    const stored = storedLocalDraft(project);
    const remaining: SentLocalDraft = { ...sentDraftRef.current };
    for (const field of SENT_FIELDS) {
      if (remaining[field] === stored[field]) delete remaining[field];
    }
    if (
      remaining.autoArchiveEnabled === undefined &&
      !stored.autoArchiveEnabled
    ) {
      // Days are not stored while Auto delete is off.
      delete remaining.autoArchiveDays;
    }
    sentDraftRef.current = remaining;
    const previousScripts = serializeScripts(
      createEditableScripts(previous.scripts),
    );
    setPendingScripts((current) => {
      const draft = serializeScripts(current);
      return follows('scripts', draft, draft === previousScripts)
        ? createEditableScripts(project.scripts)
        : current;
    });
    const previousHooks = serializeHooks(createEditableHooks(previous.hooks));
    setPendingHooks((current) => {
      const draft = serializeHooks(current);
      return follows('hooks', draft, draft === previousHooks)
        ? createEditableHooks(project.hooks)
        : current;
    });
    const previousPlugins = normalizeSelections(
      previous.defaultPluginSelections ?? EMPTY_SELECTIONS,
    );
    setPendingPlugins((current) => {
      const draft = normalizeSelections(current);
      return follows('plugins', draft, draft === previousPlugins)
        ? normalizePluginSelections(
            project.defaultPluginSelections ?? EMPTY_SELECTIONS,
          )
        : current;
    });
    setPendingAlwaysShow((current) =>
      follows(
        'alwaysShow',
        current,
        current === (previous.alwaysShow !== false),
      )
        ? project.alwaysShow !== false
        : current,
    );
    setPendingRetention((current) =>
      follows(
        'retention',
        retentionKey(current),
        !isArchiveRetentionDraftDirty(
          'single-repo',
          previous.archiveRetentionDays,
          current,
        ),
      )
        ? toArchiveRetentionDraft('single-repo', project.archiveRetentionDays)
        : current,
    );
    setPendingAutoArchiveEnabled((current) =>
      follows(
        'autoArchiveEnabled',
        current,
        current === (previous.autoArchiveDays != null),
      )
        ? project.autoArchiveDays != null
        : current,
    );
    setPendingAutoArchiveDays((current) =>
      follows(
        'autoArchiveDays',
        current,
        current === (previous.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS),
      )
        ? (project.autoArchiveDays ?? DEFAULT_AUTO_ARCHIVE_DAYS)
        : current,
    );
    setPendingAutoArchiveDeleteBranch((current) =>
      follows(
        'autoArchiveDeleteBranch',
        current,
        current === (previous.autoArchiveDeleteBranch === true),
      )
        ? project.autoArchiveDeleteBranch === true
        : current,
    );
  }, [isOpen, project]);

  // Load remote URL
  useEffect(() => {
    if (!isOpen) return;

    let canceled = false;
    setIsLoadingRemote(true);

    const load = async (): Promise<void> => {
      try {
        const result = await window.api.getRemoteUrl({
          repoPath: project.repoPath,
        });
        if (!canceled) {
          setRemoteUrl(result.remoteUrl);
        }
      } catch {
        if (!canceled) {
          setRemoteUrl(null);
        }
      } finally {
        if (!canceled) {
          setIsLoadingRemote(false);
        }
      }
    };

    void load();

    return (): void => {
      canceled = true;
    };
  }, [isOpen, project.repoPath]);

  // Resolve pipeline discovery cwd whenever the inspected worktree changes
  // so the hook-editor pipeline picker can include project pipelines.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    const resolveCwd = async (): Promise<void> => {
      if (sourceInspectWorktreeId) {
        try {
          const cwd = await window.api.getWorktreePath({
            projectId: project.id,
            worktreeId: sourceInspectWorktreeId,
          });
          if (!cancelled) {
            setPipelineDiscoveryCwd(cwd);
          }
        } catch {
          if (!cancelled) {
            setPipelineDiscoveryCwd(project.repoPath);
          }
        }
      } else if (!cancelled) {
        setPipelineDiscoveryCwd(project.repoPath);
      }
    };
    void resolveCwd();
    return (): void => {
      cancelled = true;
    };
  }, [isOpen, project.id, project.repoPath, sourceInspectWorktreeId]);

  // Initialize source scripts from healthData manifest
  useEffect(() => {
    if (!isOpen || !healthData) return;
    const manifestScripts = healthData.manifest?.scripts ?? {};
    const editable = createEditableScripts(manifestScripts);
    const nextState = applyHydratedSourceScripts(
      sourceScriptsRef.current,
      loadedSourceScriptsRef.current,
      editable,
    );
    sourceScriptsRef.current = nextState.sourceScripts;
    loadedSourceScriptsRef.current = nextState.loadedSourceScripts;
    setSourceScripts(nextState.sourceScripts);
    setLoadedSourceScripts(nextState.loadedSourceScripts);
  }, [healthData, isOpen]);

  // Initialize source hooks from healthData manifest
  useEffect(() => {
    if (!isOpen || !healthData) return;
    const manifestHooks = healthData.manifest?.hooks ?? {};
    const editable = createEditableHooks(manifestHooks);
    const nextState = applyHydratedSourceHooks(
      sourceHooksRef.current,
      loadedSourceHooksRef.current,
      editable,
    );
    sourceHooksRef.current = nextState.sourceHooks;
    loadedSourceHooksRef.current = nextState.loadedSourceHooks;
    setSourceHooks(nextState.sourceHooks);
    setLoadedSourceHooks(nextState.loadedSourceHooks);
  }, [healthData, isOpen]);

  // Initialize source-controlled plugin recommendations from the manifest.
  // `Add to Worktree` re-fetches `healthData`, which clears the dirty flag
  // on the next render via `sourcePluginsDirty`.
  useEffect(() => {
    if (!isOpen || !healthData) return;
    setSourcePlugins(healthData.manifest?.plugins ?? []);
  }, [healthData, isOpen]);

  // Patterns that cannot be saved, per draft. Open editors report their
  // rows by validity scope (`local:`, `source:`, the new-script form); the
  // drafts are read too, so collapsing an editor never clears the block.
  // Each one holds only what it would be saved with: this computer's
  // autosave, Add to worktree, or Add script.
  const invalidPatternRowsIn = (prefix: string): boolean =>
    Object.entries(devServerPatternsInvalidRows).some(
      ([scopeId, rowIds]) => scopeId.startsWith(prefix) && rowIds.length > 0,
    );
  const localPatternsInvalid =
    invalidPatternRowsIn('local:') ||
    draftHasInvalidDevServerPatterns(pendingScripts);
  const sourcePatternsInvalid =
    invalidPatternRowsIn('source:') ||
    draftHasInvalidDevServerPatterns(sourceScripts);
  const newScriptPatternsInvalid = invalidPatternRowsIn(
    'project:new-script-draft',
  );

  /**
   * Writes this computer's changes other than local override scripts and
   * hooks. The page saves it a moment after each change.
   */
  const saveLocalDraft = async (): Promise<void> => {
    // Only fields this save changes: a marker on an unchanged field would
    // outlive later outside changes to it and hold the draft on an old value.
    const sending: SentLocalDraft = {
      plugins: normalizeSelections(pendingPlugins),
      alwaysShow: pendingAlwaysShow,
      retention: retentionKey(pendingRetention),
      autoArchiveEnabled: pendingAutoArchiveEnabled,
      autoArchiveDays: pendingAutoArchiveDays,
      autoArchiveDeleteBranch: pendingAutoArchiveDeleteBranch,
    };
    const storedNow = storedLocalDraft(project);
    const changed: SentLocalDraft = {};
    for (const field of SENT_FIELDS) {
      if (field === 'scripts' || field === 'hooks') continue;
      if (sending[field] !== storedNow[field]) {
        Object.assign(changed, { [field]: sending[field] });
      }
    }
    sentDraftRef.current = { ...sentDraftRef.current, ...changed };
    if (pluginsDirty || alwaysShowDirty) {
      await window.api.saveProjectDefaultPlugins({
        projectId: project.id,
        defaultPluginSelections: normalizePluginSelections(pendingPlugins),
        alwaysShow: pendingAlwaysShow,
      });
    }
    if (archiveRetentionDirty || autoArchiveDirty) {
      await window.api.setWorkspaceArchiveRetention({
        workspaceId: project.id,
        archiveRetentionDays: toPersistedArchiveRetentionDays(
          'single-repo',
          pendingRetention,
        ),
        autoArchiveDays: nextAutoArchiveDays,
        autoArchiveDeleteBranch: pendingAutoArchiveDeleteBranch,
      });
    }
    // Last: a refusal (the value became organization-managed) reloads the
    // value and shows why on its row, with everything else saved.
    const privateMemorySaved = await privateMemory.save();
    await loadProjects();
    if (!privateMemorySaved) {
      throw new Error('Couldn’t save Private memory.');
    }
  };

  const localDraftKey = isLocalDirty
    ? JSON.stringify([
        normalizeSelections(pendingPlugins),
        pendingAlwaysShow,
        pendingRetention.days,
        nextAutoArchiveDays,
        pendingAutoArchiveDeleteBranch,
        privateMemory.checked,
        // A choice made during a save becomes dirty again only once the
        // reloaded row arrives; this makes that a new draft to write.
        privateMemory.dirty,
      ])
    : null;
  const autosave = useAutosave({
    pending: isOpen ? localDraftKey : null,
    enabled: !isDeleting && !isConverting,
    save: saveLocalDraft,
  });
  const saveState: SettingsSaveState = combineSaveStates([
    autosave.state,
    ...Object.values(sectionSaveStates),
  ]);

  // Local override scripts and hooks are written by Save local, never on
  // their own; a pattern that cannot be saved or an unfinished hook action
  // holds that button.
  const [isSavingLocal, setIsSavingLocal] = useState(false);
  // A Start page choice for this computer that waits for its Save local.
  const [startPageUnsaved, setStartPageUnsaved] = useState(false);
  const startPageUnsavedRef = useRef(startPageUnsaved);
  startPageUnsavedRef.current = startPageUnsaved;
  const localOverrideDirtyRef = useRef(isLocalOverrideDirty);
  localOverrideDirtyRef.current = isLocalOverrideDirty;
  const saveLocalDisabled =
    !isLocalOverrideDirty ||
    isSavingLocal ||
    isApplyingToWorktree ||
    localPatternsInvalid ||
    hookComposerBlocked;
  const handleSaveLocal = async (): Promise<void> => {
    if (saveLocalDisabled) return;
    setIsSavingLocal(true);
    setError('');
    const stored = storedLocalDraft(project);
    const scripts = serializeScripts(pendingScripts);
    const hooks = serializeHooks(pendingHooks);
    sentDraftRef.current = {
      ...sentDraftRef.current,
      ...(scripts === stored.scripts ? {} : { scripts }),
      ...(hooks === stored.hooks ? {} : { hooks }),
    };
    try {
      if (localScriptsDirty) {
        await window.api.saveProjectScripts({
          projectId: project.id,
          scripts: toScriptInputMap(pendingScripts, project.scripts),
        });
      }
      if (localHooksDirty) {
        await window.api.saveProjectHooks({
          projectId: project.id,
          hooks: toHookInputMap(pendingHooks, project.hooks),
        });
      }
      await loadProjects();
    } catch (cause) {
      setError('Couldn’t save your changes. Try again.');
      setErrorFailure(
        failureDetails('Couldn’t save your changes. Try again.', cause),
      );
    } finally {
      setIsSavingLocal(false);
    }
  };

  // Why closing now would drop a change: an unsaved local override, an
  // Environment choice waiting for Retry, or the last save failed.
  const closeBlockReason =
    (autosave.state === 'error'
      ? (autosave.error ?? 'Couldn’t save your changes.')
      : null) ??
    (isLocalOverrideDirty
      ? 'Your local override isn’t saved. Press Save local to keep it.'
      : null) ??
    (sectionSaveStates['start-page'] === 'error'
      ? 'Your Start page choice couldn’t be saved. Try it again on the Start page.'
      : null) ??
    (startPageUnsaved
      ? 'Your Start page choice isn’t saved. Press Save local on the Start page to keep it.'
      : null) ??
    (environmentUnsaved
      ? 'Your Environment choice isn’t saved: open the Environment page and choose Try again.'
      : null);
  // Set when a close found such a change; the page then says why it stayed.
  const [closeHeld, setCloseHeld] = useState(false);
  useEffect(() => {
    if (closeBlockReason === null) setCloseHeld(false);
  }, [closeBlockReason]);

  // A pending change is written before the page closes. When that write
  // fails, or a change cannot be written now, the page stays open and says
  // why, so nothing is lost without a word. Closing again discards it.
  // Manage environments leaves on purpose to retry secure storage, so a
  // waiting Environment choice does not hold it.
  // Resolves whether the page closed, so a button that leaves for another
  // surface goes there only once it has.
  const closeAfterSaving = useCallback(
    async (holdForEnvironment: boolean): Promise<boolean> => {
      const close = (): boolean => {
        isOpenRef.current = false;
        onClose();
        return true;
      };
      // Writes everything that saves on its own: the page draft and the
      // sections with their own store.
      const flushAll = async (): Promise<boolean> => {
        let saved = await autosave.flush();
        for (const section of OWN_SAVE_SECTIONS) {
          const flush = sectionFlushesRef.current[section];
          // Manage environments leaves to fix the Environment save itself.
          if (section === 'environment' && !holdForEnvironment) continue;
          if (saved && flush) saved = await flush();
        }
        // The page stays editable while the sections finish: write anything
        // changed meanwhile too.
        if (saved) saved = await autosave.flush();
        return saved;
      };
      // Closing again discards only what could not be written: a local
      // override waiting for Save local, or a save that failed.
      if (closeHeld) {
        await flushAll();
        return close();
      }
      if (holdForEnvironment && environmentUnsaved) {
        setCloseHeld(true);
        return false;
      }
      const saved = await flushAll();
      // Read after the writes: a Start page choice made meanwhile counts.
      const overrideUnsaved =
        localOverrideDirtyRef.current || startPageUnsavedRef.current;
      if (saved && !overrideUnsaved) return close();
      setCloseHeld(true);
      return false;
    },
    [autosave, closeHeld, environmentUnsaved, onClose],
  );
  const handleClose = useCallback((): void => {
    void closeAfterSaving(true);
  }, [closeAfterSaving]);
  const closeThenOpenSettings = (
    destination: 'environment' | 'code-graph',
    holdForEnvironment: boolean,
  ): void => {
    void closeAfterSaving(holdForEnvironment).then((closed) => {
      if (closed) useNavigationStore.getState().openSettings(destination);
    });
  };

  const handleAddToWorktree = async (
    target: { mode: 'new' } | { mode: 'existing'; worktreeId: string },
  ): Promise<void> => {
    if (hookComposerBlocked) return;
    if (
      !canSubmitProjectSourceDraft(hasLoadedWorkspaceSettingsData, healthData)
    ) {
      setError(
        workspaceSettingsLoadError ??
          'Source-controlled scripts are still loading. Wait for the canonical manifest, then try again.',
      );
      return;
    }

    const clientRequestId =
      window.crypto.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let appliedEventHandled = false;
    const handleApplied = (): void => {
      if (appliedEventHandled) {
        return;
      }
      appliedEventHandled = true;

      // Marks the page closed only once it closes: a held close keeps it
      // open, and the refreshed canopy.json must still reach it.
      handleClose();
    };
    const unsubscribeApplied = window.api.onProjectSourceChangesApplied(
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
      const response = await window.api.applyProjectSourceChanges({
        clientRequestId,
        projectId: project.id,
        target:
          target.mode === 'existing'
            ? { mode: 'existing', worktreeId: target.worktreeId }
            : {
                mode: 'new',
                existingWorktreeIds: project.worktrees.map(
                  (worktree) => worktree.id,
                ),
              },
        scripts: toScriptInputMap(sourceScripts),
        hooks: toHookInputMap(sourceHooks, undefined, false),
        plugins: sourcePlugins,
      });

      const previousLoadedSourceScripts = loadedSourceScriptsRef.current;
      const appliedSourceScripts = { ...sourceScriptsRef.current };
      loadedSourceScriptsRef.current = appliedSourceScripts;
      setLoadedSourceScripts(appliedSourceScripts);
      setAppliedProjectWorktreeScripts(
        project.id,
        response.worktreeId,
        previousLoadedSourceScripts,
        appliedSourceScripts,
      );
      const previousLoadedSourceHooks = loadedSourceHooksRef.current;
      const appliedSourceHooks = { ...sourceHooksRef.current };
      loadedSourceHooksRef.current = appliedSourceHooks;
      setLoadedSourceHooks(appliedSourceHooks);
      setAppliedProjectWorktreeHooks(
        project.id,
        response.worktreeId,
        previousLoadedSourceHooks,
        appliedSourceHooks,
      );
      setSourceInspectWorktreeId(response.worktreeId);
      useChatStore.getState().selectWorktree(project.id, response.worktreeId);
      handleApplied();
      // Applied: if the close is held, the page stays open and the row must
      // not keep saying it is adding.
      setAddToWorktreeFeedback({ phase: 'idle' });

      scheduleAfterClosePaint(() => {
        void loadProjects({ silent: true })
          .then(() => {
            useChatStore
              .getState()
              .selectWorktree(project.id, response.worktreeId);
            void useProjectsStore.getState().refreshDiffStats();
            // Surface a non-blocking install prompt for any newly authored chat
            // hook plugins that aren't installed locally yet. Fire-and-forget —
            // the dialog is rendered globally from WorktreeManager via the
            // `pendingHookChatPluginInstallPrompt` store field.
            void useProjectsStore
              .getState()
              .inspectHookChatPluginDependencies(
                project.id,
                response.worktreeId,
              );
          })
          .catch(() => undefined);

        void window.api
          .getWorkspaceSettingsData({
            workspaceId: project.id,
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
      setError('Couldn’t add this to the worktree. Try again.');
      setErrorFailure(
        failureDetails('Couldn’t add this to the worktree. Try again.', cause),
      );
    } finally {
      unsubscribeApplied();
      setIsApplyingToWorktree(false);
    }
  };

  const handleLinkRemote = async (): Promise<void> => {
    setLinkError('');
    const url = linkUrl.trim();
    if (!url) {
      setLinkError('Remote URL is required');
      return;
    }

    setIsLinking(true);

    try {
      await window.api.linkRemote({
        repoPath: project.repoPath,
        remoteUrl: url,
      });
      setRemoteUrl(url);
      setLinkUrl('');
    } catch (cause) {
      setLinkError(
        cause instanceof Error ? cause.message : 'Failed to link remote',
      );
    } finally {
      setIsLinking(false);
    }
  };

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
      workspaceId: project.id,
      projectName: project.name,
      message,
      retry: () => {
        if (mountedRef.current) void handleDelete();
      },
      onOpen: () => setManageError(''),
      onDeleted: () => {
        void loadProjects();
        onClose();
      },
    });
  };

  const handleDelete = async (): Promise<void> => {
    setManageError('');
    setIsDeleting(true);

    try {
      // Read live worktree list from store to avoid re-archiving already-removed worktrees
      const liveProject = useProjectsStore
        .getState()
        .projects.find(
          (p): p is SingleRepoSidebarItem =>
            p.id === project.id && p.type === 'single-repo',
        );
      const worktrees = liveProject?.worktrees ?? [];
      const removalReason = await recheckWorkspaceRemovalBlockedReason(
        project.id,
        worktrees.map((worktree) => worktree.id),
        'single-repo',
      );
      if (removalReason !== undefined) {
        setManageError(removalReason);
        offerDeletionDiscard(removalReason);
        return;
      }

      for (const wt of worktrees) {
        try {
          await archiveWorktree(project.id, wt.id);
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

      await window.api.deleteProject({
        projectId: project.id,
      });
      await loadProjects();
      onClose();
    } catch (cause) {
      offerLifecycleJournalQuarantine(cause);
      const message =
        cause instanceof Error ? cause.message : 'Failed to delete project';
      setManageError('Couldn’t delete the project. Try again.');
      setManageFailure(
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

  const handleConvertToMultiRepo = async (
    claudeMdMode: 'replace' | 'update' | 'unchanged',
  ): Promise<void> => {
    setManageError('');
    // Local overrides wait for Save local; converting closes the page, so it
    // never drops them silently.
    if (isLocalOverrideDirty || startPageUnsaved) {
      setManageError(
        'Save or discard your local override first, then convert the project.',
      );
      setShowConvertOptions(false);
      return;
    }
    // Other changes for this computer are written first; converting closes the page.
    // The dialog stays busy meanwhile, so Cancel can't be pressed for a
    // convert that would still run once the write lands.
    setIsPreparingConvert(true);
    let saved = false;
    try {
      saved = await autosave.flush();
    } finally {
      setIsPreparingConvert(false);
    }
    if (!saved) {
      setManageError(
        'Couldn’t save your changes, so the project wasn’t converted.',
      );
      setShowConvertOptions(false);
      return;
    }
    setIsConverting(true);

    try {
      await window.api.convertWorkspaceType({
        workspaceId: project.id,
        targetType: 'multi-repo',
        claudeMdMode,
      });
      await loadProjects();
      onClose();
    } catch (cause) {
      setManageError('Couldn’t convert the project. Try again.');
      setManageFailure(
        failureDetails('Couldn’t convert the project. Try again.', cause),
      );
    } finally {
      setIsConverting(false);
      setShowConvertOptions(false);
    }
  };

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

  if (!isOpen) return null;

  const convertBusy = isConverting || isPreparingConvert;

  const customScripts = getEditableCustomScripts(activeScriptsForTab);
  const driftWorktree = driftWorktreeId
    ? project.worktrees.find((worktree) => worktree.id === driftWorktreeId)
    : undefined;

  const handleAddCustomScript = (): void => {
    const scriptName = normalizeScriptName(newScriptName);
    if (!scriptName || newScriptCommand.trim().length === 0) {
      return;
    }
    if (newScriptPatternsInvalid) {
      return;
    }
    setActiveScriptsForTab((current) => {
      const next: EditableScripts = { ...current };
      const entry: EditableScript = { command: newScriptCommand };
      if (newScriptTimeoutSeconds !== undefined) {
        entry.timeoutSeconds = newScriptTimeoutSeconds;
      }
      if (
        newScriptDevServerPatterns !== undefined &&
        newScriptDevServerPatterns.length > 0
      ) {
        entry.devServerPatterns = newScriptDevServerPatterns;
      }
      if (newScriptShell !== undefined) {
        entry.shell = newScriptShell;
      }
      if (newScriptInteractive) entry.interactive = true;
      next[scriptName] = entry;
      return next;
    });
    setNewScriptName('');
    setNewScriptCommand('');
    setNewScriptTimeoutSeconds(undefined);
    setNewScriptDevServerPatterns(undefined);
    setNewScriptShell(undefined);
    setNewScriptInteractive(false);
    setAddingScript(false);
  };

  const showAddToWorktreeAction =
    isSourceDirty || hasSourceDraft || addToWorktreeFeedback.phase !== 'idle';
  const canAddToWorktree = canSubmitProjectSourceDraft(
    hasLoadedWorkspaceSettingsData,
    healthData,
  );
  const addToWorktreeButtonLabel =
    addToWorktreeFeedback.phase === 'applying'
      ? `Adding to ${addToWorktreeFeedback.targetLabel}...`
      : workspaceSettingsLoadError
        ? 'Failed to load source scripts'
        : !canAddToWorktree
          ? 'Loading source scripts…'
          : !isSourceDirty && hasSourceDraft
            ? 'Apply to another worktree'
            : sourceInspectWorktreeId
              ? 'Add to worktree'
              : 'Add to new worktree';
  const addToWorktreeControls = (
    <AddToWorktreeActionControls
      show
      sourceInspectWorktreeId={sourceInspectWorktreeId}
      worktrees={project.worktrees}
      feedback={addToWorktreeFeedback}
      buttonLabel={addToWorktreeButtonLabel}
      disabled={
        hookComposerBlocked ||
        isApplyingToWorktree ||
        !canAddToWorktree ||
        sourcePatternsInvalid
      }
      existingDropdownOpen={existingWorktreeDropdownOpen}
      onExistingDropdownOpenChange={setExistingWorktreeDropdownOpen}
      onAddToWorktree={(target) => void handleAddToWorktree(target)}
    />
  );
  const addToWorktreeRow = showAddToWorktreeAction ? (
    <SettingsRow
      label="Add canopy.json changes to a worktree"
      description="canopy.json is part of the repository, so changes to it go into a worktree."
      dataTestId="project-settings-add-to-worktree"
      control={addToWorktreeControls}
    />
  ) : null;
  const sourceWorktreeRow = (
    <SettingsRow
      label="Read canopy.json from"
      description="The worktree whose canopy.json you see and change."
      control={
        <SourceWorktreePicker
          selectedWorktreeId={sourceInspectWorktreeId}
          onChange={setSourceInspectWorktreeId}
          worktrees={project.worktrees}
          open={worktreeDropdownOpen}
          onOpenChange={setWorktreeDropdownOpen}
          helpTooltipId="project-settings-help-tooltip"
        />
      }
    />
  );

  const renderScriptEditor = (
    key: string,
    label: string,
    placeholder?: string,
  ): JSX.Element => {
    const isCustom = !SCRIPT_PHASES.some((phase) => phase.key === key);
    const supportsInteractive = key !== 'teardown';
    return (
      <ScriptConfigEditor
        layout="settings"
        label={label}
        scriptName={key}
        command={getEditableScriptValue(activeScriptsForTab, key)}
        timeoutSeconds={getEditableScriptTimeoutSeconds(
          activeScriptsForTab,
          key,
        )}
        shell={getEditableScriptShell(activeScriptsForTab, key)}
        interactive={getEditableScriptInteractive(activeScriptsForTab, key)}
        onInteractiveChange={
          supportsInteractive || isCustom
            ? (next): void =>
                setActiveScriptsForTab((current) =>
                  setEditableScriptInteractive(current, key, next),
                )
            : undefined
        }
        onCommandChange={(nextValue) =>
          setActiveScriptsForTab((current) =>
            setEditableScriptValue(current, key, nextValue),
          )
        }
        onTimeoutSecondsChange={(nextTimeout) =>
          setActiveScriptsForTab((current) =>
            setEditableScriptTimeoutSeconds(current, key, nextTimeout),
          )
        }
        onShellChange={(nextShell) =>
          setActiveScriptsForTab((current) =>
            setEditableScriptShell(current, key, nextShell),
          )
        }
        placeholder={placeholder}
        rows={3}
        defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
        devServerPatterns={getEditableScriptDevServerPatterns(
          activeScriptsForTab,
          key,
        )}
        onDevServerPatternsChange={(next) =>
          setActiveScriptsForTab((current) =>
            setEditableScriptDevServerPatterns(current, key, next),
          )
        }
        devServerPatternsValidityScopeKey={`${scope}:${isCustom ? 'custom:' : ''}${key}`}
        onDevServerPatternsValidityChange={makeDevServerValidityHandler(
          `${scope}:${isCustom ? 'custom:' : ''}${key}`,
        )}
      />
    );
  };

  const scriptSummary = (key: string): ReactNode => {
    const command = getEditableScriptValue(activeScriptsForTab, key);
    if (command.trim().length === 0) return 'Not set';
    return (
      <span
        className={`block truncate font-mono ${POSTHOG_REPLAY_BLOCK_CLASS}`}
      >
        {commandSummary(command)}
      </span>
    );
  };

  const editScriptButton = (key: string, hasCommand: boolean): JSX.Element => (
    <Button
      size="compact"
      onClick={() => setEditingScript(editingScript === key ? null : key)}
      aria-expanded={editingScript === key}
      data-testid={`project-settings-script-edit-${key}`}
    >
      {editingScript === key ? 'Done' : hasCommand ? 'Edit' : 'Add'}
    </Button>
  );

  const removeProjectDescription = (
    <>
      Takes <span className={POSTHOG_REPLAY_MASK_CLASS}>{project.name}</span>{' '}
      and its worktrees out of the sidebar. A repository in{' '}
      {`${brandText.appName}’s`} own folder is deleted too.
    </>
  );

  const generalPage = (
    <>
      {healthData && healthData.driftIssues.length > 0 ? (
        <SettingsSection
          title="Project health"
          description={
            <>
              {brandText.appName} compares this project’s tracked state against
              the evaluated <code>canopy.json</code>.
              {driftWorktree ? (
                <span className="block">
                  Worktree {driftWorktree.id} · Branch{' '}
                  {driftWorktree.branchName}
                </span>
              ) : null}
              {healthData.driftTargetPath ? (
                <span className="block break-all font-mono">
                  {healthData.driftTargetPath}
                </span>
              ) : null}
            </>
          }
        >
          <SettingsGroup>
            {healthData.driftIssues.map((issue) => (
              <SettingsRow
                key={`${issue.code}-${issue.repoId ?? 'workspace'}`}
                label={
                  <span
                    className={`inline-flex rounded-full px-2 text-xs ${workspaceHealthIssueClassName(issue.blocking)}`}
                  >
                    {issue.blocking ? 'Blocking issue' : 'Warning'}
                  </span>
                }
                description={issue.message}
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Project">
        <SettingsGroup>
          <WorkspaceReadinessRecommendations
            surface="row"
            workspaceId={project.id}
            worktreeId={resolveWorkspaceReadinessWorktreeId(
              healthData?.driftWorktreeId,
              sourceInspectWorktreeId,
            )}
            onViewConversation={(): Promise<boolean> => closeAfterSaving(true)}
          />
          <SettingsRow
            label="Directory"
            description={
              <span
                className="block truncate font-mono"
                style={{ direction: 'rtl', textAlign: 'left' }}
                title={project.repoPath.replace(/\/+$/, '')}
              >
                {`‎${project.repoPath.replace(/\/+$/, '')}`}
              </span>
            }
            control={
              <CopyButton
                value={project.repoPath.replace(/\/+$/, '')}
                ariaLabel="Copy directory path"
                title="Copy directory path"
              />
            }
          />
          <SettingsRow
            label="Origin remote"
            dataTestId="project-settings-origin-remote"
            description={
              isLoadingRemote ? (
                'Checking remote…'
              ) : remoteUrl ? (
                <span className="block truncate font-mono" title={remoteUrl}>
                  {remoteUrl}
                </span>
              ) : (
                'No remote yet. Link one to push and pull.'
              )
            }
            control={
              remoteUrl ? (
                <CopyButton
                  value={remoteUrl}
                  ariaLabel="Copy origin remote URL"
                  title="Copy origin remote URL"
                />
              ) : undefined
            }
          >
            {!isLoadingRemote && !remoteUrl ? (
              <SettingsSubRow
                label="Remote URL"
                control={
                  <>
                    <SettingsTextField
                      mono
                      value={linkUrl}
                      aria-label="Remote URL"
                      aria-invalid={linkError ? true : undefined}
                      aria-describedby={
                        linkError
                          ? 'project-settings-link-remote-error'
                          : undefined
                      }
                      onChange={(event) => {
                        setLinkUrl(event.target.value);
                        setLinkError('');
                      }}
                      placeholder="git@github.com:org/repo.git"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          if (isLinking || !linkUrl.trim()) {
                            return;
                          }
                          void handleLinkRemote();
                        }
                      }}
                    />
                    <Button
                      size="compact"
                      onClick={() => void handleLinkRemote()}
                      disabled={isLinking || !linkUrl.trim()}
                    >
                      {isLinking ? 'Linking…' : 'Link'}
                    </Button>
                  </>
                }
              >
                {linkError && (
                  <FieldError id="project-settings-link-remote-error">
                    {linkError}
                  </FieldError>
                )}
              </SettingsSubRow>
            ) : null}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Behavior">
        <SettingsGroup>
          <SettingsRow
            label="Always show project"
            htmlFor="project-settings-always-show"
            description="Keep it in the sidebar when it has no active worktrees."
            control={
              <ToggleSwitch
                id="project-settings-always-show"
                checked={pendingAlwaysShow}
                label="Always show project"
                onChange={setPendingAlwaysShow}
                dataTestId="project-settings-always-show"
              />
            }
          />
          <PrivateMemoryCard
            surface="inline"
            checked={privateMemory.checked}
            onChange={privateMemory.setChecked}
            managed={privateMemory.managed}
            organizationName={privateMemory.organizationName}
            error={privateMemory.error}
            dataTestId="project-settings-private-memory"
          />
          <RepoRulesStatusCard
            surface="row"
            workspaceId={project.id}
            refreshToken={repoRulesRefreshToken}
            onReview={(): void =>
              openRepoRulesModal({
                source: 'project-settings',
                workspaceId: project.id,
              })
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Deletion retention">
        <SettingsGroup dataTestId="project-settings-retention">
          <SettingsRow
            label="Keep deleted worktrees for"
            htmlFor="project-settings-retention-days"
            dataTestId="project-settings-retention-card"
            description="Archived worktrees are kept until you delete them."
            control={
              <>
                <SettingsTextField
                  id="project-settings-retention-days"
                  type="number"
                  width="xs"
                  value={pendingRetention.days}
                  min={1}
                  max={MAX_ARCHIVE_RETENTION_DAYS}
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
                  data-testid="project-settings-retention-days"
                />
                <span className="text-s fg-secondary">
                  {pendingRetention.days === 1 ? 'day' : 'days'}
                </span>
              </>
            }
          />
          <SettingsRow
            label="Auto delete"
            htmlFor="project-settings-auto-archive"
            description="Delete fully idle worktrees after a period of inactivity."
            control={
              <ToggleSwitch
                id="project-settings-auto-archive"
                checked={pendingAutoArchiveEnabled}
                label="Auto delete"
                onChange={setPendingAutoArchiveEnabled}
                dataTestId="project-settings-auto-archive-toggle"
              />
            }
          >
            {pendingAutoArchiveEnabled ? (
              <>
                <SettingsSubRow
                  label="After"
                  htmlFor="project-settings-auto-archive-days"
                  control={
                    <>
                      <SettingsTextField
                        id="project-settings-auto-archive-days"
                        type="number"
                        width="xs"
                        value={pendingAutoArchiveDays}
                        min={1}
                        max={MAX_ARCHIVE_RETENTION_DAYS}
                        onChange={(event) =>
                          setPendingAutoArchiveDays(
                            Math.max(
                              1,
                              Math.min(
                                MAX_ARCHIVE_RETENTION_DAYS,
                                Number.parseInt(event.target.value, 10) ||
                                  DEFAULT_AUTO_ARCHIVE_DAYS,
                              ),
                            ),
                          )
                        }
                        data-testid="project-settings-auto-archive-days"
                      />
                      <span className="text-s fg-secondary">
                        days of inactivity
                      </span>
                    </>
                  }
                />
                <SettingsSubRow
                  label="Delete the branch locally with the worktree"
                  htmlFor="project-settings-auto-archive-delete-branch"
                  control={
                    <ToggleSwitch
                      id="project-settings-auto-archive-delete-branch"
                      checked={pendingAutoArchiveDeleteBranch}
                      label="Delete the branch locally with the worktree"
                      onChange={setPendingAutoArchiveDeleteBranch}
                      dataTestId="project-settings-auto-archive-delete-branch"
                    />
                  }
                />
              </>
            ) : null}
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Manage">
        <SettingsGroup>
          <SettingsRow
            label="Convert to multi-repo project"
            dataTestId="project-settings-convert"
            description={
              project.owner?.type === 'organization' ? (
                // An organization project stays single-repo (CAN-3546).
                <span data-testid="project-settings-convert-org-note">
                  To create a shared multi-repo project, use worktree ⋯ → Add
                  repository, then Create shared project instead.
                </span>
              ) : project.worktrees.length > 0 ? (
                `Track several repositories as one project. Remove the ${project.worktrees.length} ${project.worktrees.length === 1 ? 'worktree' : 'worktrees'} first.`
              ) : (
                'Track several repositories as one project.'
              )
            }
            control={
              project.owner?.type === 'organization' ? undefined : (
                <Button
                  size="compact"
                  onClick={() => setShowConvertOptions(true)}
                  disabled={project.worktrees.length > 0 || isConverting}
                >
                  Convert…
                </Button>
              )
            }
          />
          <SettingsRow
            label="Remove project"
            dataTestId="project-settings-danger"
            description={
              removalDisabledReason ??
              (hasActiveWorktrees
                ? 'Can’t remove while worktrees have active sessions.'
                : removeProjectDescription)
            }
            control={
              // A quiet danger text action, as in the shared project
              // settings dialog; the dialog below still asks first.
              <Button
                size="compact"
                variant="ghost-destructive"
                onClick={() => setConfirmingDelete(true)}
                disabled={
                  hasActiveWorktrees ||
                  removalDisabledReason !== undefined ||
                  isDeleting
                }
                data-testid="project-settings-remove"
              >
                Remove…
              </Button>
            }
          />
        </SettingsGroup>
        {manageError ? (
          <ErrorBanner
            errorSource="project-settings-manage-error"
            error={manageError}
            details={detailsFor(manageError, manageFailure)}
            className=""
            testId="project-settings-manage-error"
          />
        ) : null}
      </SettingsSection>
    </>
  );

  const hookTriggers = Object.entries(activeHooksForTab)
    .filter(([, actions]) =>
      actions === null ? scope === 'local' : actions.length > 0,
    )
    .map(([trigger]) => trigger)
    .sort(compareTriggerNames);

  const hookPage =
    drillIn?.kind === 'hook' ? (
      <HookActionEditor
        key={`${scope}:${drillIn.trigger ?? 'new'}`}
        layout="settings"
        visibleTrigger={drillIn.trigger}
        onActionAdded={(trigger) => setDrillIn({ kind: 'hook', trigger })}
        chatContext={resolveHookComposerContext({
          workspaceId: project.id,
          mode: scope,
          worktreeId: sourceInspectWorktreeId,
        })}
        onBlockedChange={setHookComposerBlocked}
        hooks={activeHooksForTab}
        onChange={(updater) => {
          setActiveHooksForTab((current) => updater(current));
        }}
        allowDisable={scope === 'local'}
        pluginSelectionMode={scope === 'source' ? 'portable' : 'full'}
        pipelineDiscoveryCwd={pipelineDiscoveryCwd}
      />
    ) : null;

  const scriptsPage = (
    <>
      <ProjectSettingsScopeGroup scope={scope} onScopeChange={setScope}>
        {scope === 'source' ? (
          <>
            {sourceWorktreeRow}
            {addToWorktreeRow}
          </>
        ) : (
          <SettingsRow
            label="Local override"
            description={
              isLocalOverrideDirty
                ? 'Unsaved changes. They override canopy.json on this computer once saved.'
                : 'Saved on this computer. Local overrides take priority over canopy.json.'
            }
            dataTestId="project-settings-local-override"
            control={
              <Button
                variant="primary"
                size="compact"
                disabled={saveLocalDisabled}
                onClick={() => void handleSaveLocal()}
                data-testid="project-settings-save-local"
              >
                {isSavingLocal ? 'Saving…' : 'Save local'}
              </Button>
            }
          />
        )}
      </ProjectSettingsScopeGroup>

      <SettingsSection title="Scripts">
        <SettingsGroup dataTestId="project-settings-scripts">
          {SCRIPT_PHASES.map((phase) => {
            const hasCommand =
              getEditableScriptValue(activeScriptsForTab, phase.key).trim()
                .length > 0;
            return (
              <SettingsRow
                key={phase.key}
                label={phase.label}
                dataTestId={`project-settings-script-${phase.key}`}
                description={
                  editingScript === phase.key
                    ? phase.description
                    : scriptSummary(phase.key)
                }
                control={editScriptButton(phase.key, hasCommand)}
              >
                {editingScript === phase.key
                  ? renderScriptEditor(
                      phase.key,
                      phase.label,
                      phase.placeholder,
                    )
                  : null}
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Custom scripts"
        description="Scripts you can run from the activity panel."
      >
        <SettingsGroup dataTestId="project-settings-custom-scripts">
          {customScripts.map((script) => (
            <SettingsRow
              key={script.name}
              label={<span className="font-mono">{script.name}</span>}
              description={
                editingScript === script.name
                  ? undefined
                  : scriptSummary(script.name)
              }
              control={
                <>
                  <Button
                    size="compact"
                    variant="ghost"
                    iconOnly
                    aria-label={`Remove ${script.name}`}
                    onClick={() => {
                      if (editingScript === script.name) setEditingScript(null);
                      setActiveScriptsForTab((current) =>
                        removeEditableScript(current, script.name),
                      );
                    }}
                  >
                    <TrashIcon aria-hidden={true} />
                  </Button>
                  {editScriptButton(script.name, true)}
                </>
              }
            >
              {editingScript === script.name
                ? renderScriptEditor(script.name, 'Command')
                : null}
            </SettingsRow>
          ))}
          {addingScript ? (
            <SettingsRow
              label="New script"
              control={
                <>
                  <Button
                    size="compact"
                    variant="ghost"
                    onClick={() => setAddingScript(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="compact"
                    onClick={handleAddCustomScript}
                    disabled={
                      !normalizeScriptName(newScriptName) ||
                      !newScriptCommand.trim() ||
                      newScriptPatternsInvalid
                    }
                  >
                    Add script
                  </Button>
                </>
              }
            >
              <SettingsSubRow
                label="Name"
                htmlFor="project-settings-new-script-name"
                control={
                  <SettingsTextField
                    id="project-settings-new-script-name"
                    mono
                    value={newScriptName}
                    onChange={(event) => setNewScriptName(event.target.value)}
                    placeholder="dev-server"
                  />
                }
              />
              <ScriptConfigEditor
                layout="settings"
                label="Command"
                scriptName={normalizeScriptName(newScriptName) ?? 'new-script'}
                command={newScriptCommand}
                timeoutSeconds={newScriptTimeoutSeconds}
                shell={newScriptShell}
                interactive={newScriptInteractive}
                onInteractiveChange={setNewScriptInteractive}
                onCommandChange={setNewScriptCommand}
                onTimeoutSecondsChange={setNewScriptTimeoutSeconds}
                onShellChange={setNewScriptShell}
                placeholder="npm run storybook"
                rows={3}
                defaultTimeoutSeconds={defaultScriptTimeoutSeconds}
                devServerPatterns={newScriptDevServerPatterns}
                onDevServerPatternsChange={setNewScriptDevServerPatterns}
                devServerPatternsValidityScopeKey="project:new-script-draft"
                onDevServerPatternsValidityChange={makeDevServerValidityHandler(
                  'project:new-script-draft',
                )}
              />
            </SettingsRow>
          ) : (
            <ListRow
              onClick={() => setAddingScript(true)}
              data-testid="project-settings-add-script"
              icon={<PlusIcon size={16} aria-hidden={true} />}
            >
              Add script
            </ListRow>
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Detected scripts">
        <ScriptActionsSettingsSection
          surface="plain"
          projectId={project.id}
          fallbackWorktreeId={sourceInspectWorktreeId}
        />
      </SettingsSection>

      <SettingsSection
        title="Hooks"
        description="Run a chat, command or workflow when something happens to a pull request or worktree."
        dataTestId="project-settings-hooks-section"
      >
        <SettingsGroup dataTestId="project-settings-hooks">
          {hookTriggers.map((trigger) => (
            <SettingsRow
              key={trigger}
              label={getHookTriggerDisplayName(trigger)}
              description={
                <span
                  className={`block truncate ${POSTHOG_REPLAY_BLOCK_CLASS}`}
                >
                  {hookActionsSummary(activeHooksForTab[trigger] ?? null)}
                </span>
              }
              dataTestId={`project-settings-hook-${trigger}`}
              control={
                <Button
                  size="compact"
                  onClick={() => setDrillIn({ kind: 'hook', trigger })}
                >
                  Edit
                </Button>
              }
            />
          ))}
          <ListRow
            onClick={() => setDrillIn({ kind: 'hook', trigger: null })}
            data-testid="project-settings-add-hook"
            icon={<PlusIcon size={16} aria-hidden={true} />}
          >
            Add hook
          </ListRow>
        </SettingsGroup>
      </SettingsSection>
    </>
  );

  const recommendedPlugins = sourcePlugins.flatMap((ref) => {
    const key = shareablePluginRefKeyOrNull(ref);
    return key === null ? [] : [{ key, ref }];
  });
  const chatPluginCount = countPluginSelections(pendingPlugins);

  const pluginsPage =
    drillIn?.kind === 'recommended-plugins' ? (
      !hasLoadedWorkspaceSettingsData && !workspaceSettingsLoadError ? (
        // The worktree row is already known; the plugin table below it
        // keeps its own loading state once the recommendations arrive.
        <DelayedLoadingPlaceholder slowNote="Still loading recommendations…">
          <Skeleton
            loading
            label="Loading recommendations"
            testId="project-settings-recommended-plugins-loading"
          >
            <SettingsGroup>{sourceWorktreeRow}</SettingsGroup>
          </Skeleton>
        </DelayedLoadingPlaceholder>
      ) : (
        <>
          <SettingsGroup>
            {sourceWorktreeRow}
            {addToWorktreeRow}
          </SettingsGroup>
          <ShareablePluginSelector
            selections={sourcePlugins}
            onChange={setSourcePlugins}
            helperText="These recommendations are saved to canopy.json and are offered when worktrees are created. They do not change local chat defaults until a user applies them."
          />
        </>
      )
    ) : drillIn?.kind === 'chat-plugins' ? (
      <div className="flex min-h-128 flex-col gap-3">
        <RecommendedPluginsSettingsPanel
          projectId={project.id}
          worktreeId={sourceInspectWorktreeId}
          onAppliedSelections={setPendingPlugins}
          variant="compact"
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <PluginSelector
            selections={pendingPlugins}
            onChange={setPendingPlugins}
            inset={false}
          />
        </div>
      </div>
    ) : (
      <>
        <SettingsSection
          title="Recommended for this project"
          description="Saved to canopy.json. Offered when someone creates a worktree; each person chooses whether to install them."
        >
          <SettingsGroup dataTestId="project-settings-recommended-plugins">
            {workspaceSettingsLoadError ? (
              <SettingsRow
                label="Recommendations are unavailable"
                description={workspaceSettingsLoadError}
              />
            ) : !hasLoadedWorkspaceSettingsData ? (
              <DelayedLoadingPlaceholder>
                <Skeleton
                  loading
                  label="Loading recommendations"
                  testId="project-settings-recommended-plugins-loading"
                >
                  {SAMPLE_RECOMMENDED_PLUGINS.map((sample) => (
                    <RecommendedPluginRow
                      key={sample.title}
                      title={sample.title}
                      subtitle={sample.subtitle}
                      onRemove={noop}
                    />
                  ))}
                </Skeleton>
              </DelayedLoadingPlaceholder>
            ) : recommendedPlugins.length === 0 ? (
              <EmptyStateRow title="No recommended plugins yet." />
            ) : (
              recommendedPlugins.map(({ key, ref }) => {
                const display = buildShareablePluginDisplay(ref);
                return (
                  <RecommendedPluginRow
                    key={key}
                    title={display.title}
                    subtitle={display.subtitle}
                    onRemove={() =>
                      setSourcePlugins((current) =>
                        current.filter(
                          (candidate) =>
                            shareablePluginRefKeyOrNull(candidate) !== key,
                        ),
                      )
                    }
                  />
                );
              })
            )}
            <SettingsRow
              label="Choose recommended plugins"
              description="Pick from the shareable plugins and skills you have."
              control={
                <Button
                  size="compact"
                  onClick={() => setDrillIn({ kind: 'recommended-plugins' })}
                  disabled={workspaceSettingsLoadError !== null}
                  data-testid="project-settings-choose-recommended"
                >
                  Choose…
                </Button>
              }
            />
            {sourcePluginsDirty ? addToWorktreeRow : null}
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection
          title="New chats"
          description={<PluginSelectionScopeHelp />}
        >
          <SettingsGroup>
            <SettingsRow
              label="Plugins for new chats"
              description={
                chatPluginCount === 0
                  ? 'None on this computer. A chat can still turn plugins on.'
                  : `${chatPluginCount} on for every new chat in this project, on this computer.`
              }
              control={
                <Button
                  size="compact"
                  onClick={() => setDrillIn({ kind: 'chat-plugins' })}
                  data-testid="project-settings-choose-chat-plugins"
                >
                  Choose…
                </Button>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      </>
    );

  const pageBody: Record<ProjectSettingsPageId, () => ReactNode> = {
    general: () => generalPage,
    scripts: () => hookPage ?? scriptsPage,
    plans: () => (
      <WorkspacePlanDetectionSection
        workspaceId={project.id}
        showIntro={false}
        onSaveStateChange={reportPlansSave}
      />
    ),
    plugins: () => pluginsPage,
    environment: () => (
      <WorkspaceEnvironmentTab
        layout="settings"
        workspaceId={project.id}
        workspaceName={project.name}
        onSaveStateChange={reportEnvironmentSave}
        onUnsavedChange={setEnvironmentUnsaved}
        onRegisterFlush={registerEnvironmentFlush}
        onManageEnvironments={() => closeThenOpenSettings('environment', false)}
      />
    ),
    'start-page': () =>
      startPageEnabled ? (
        <CodeStartPageSettings
          layout="settings"
          project={project}
          initialWorktreeId={driftWorktreeId}
          initialMode={startPageIntent?.mode}
          prefill={startPageIntent?.prefill}
          onSaveStateChange={reportStartPageSave}
          onRegisterFlush={registerStartPageFlush}
          onUnsavedChange={setStartPageUnsaved}
        />
      ) : null,
    'code-graph': () =>
      codeGraphExperimentEnabled ? (
        <CodeGraphSummaryPanel
          layout="rows"
          advisorContext={{
            scope: 'workspace-shadow',
            workspaceId: project.id,
          }}
          load={(): ReturnType<
            typeof window.api.codeGraphGetWorkspaceSummary
          > =>
            window.api.codeGraphGetWorkspaceSummary({
              workspaceId: project.id,
            })
          }
          build={(): ReturnType<typeof window.api.codeGraphBuildWorkspace> =>
            window.api.codeGraphBuildWorkspace({ workspaceId: project.id })
          }
          onOpenSettings={(): void => closeThenOpenSettings('code-graph', true)}
        />
      ) : null,
  };

  const drillInCopy: {
    readonly title: string;
    readonly description: string;
    readonly back: string;
  } | null =
    drillIn === null
      ? null
      : drillIn.kind === 'recommended-plugins'
        ? {
            title: 'Recommended plugins',
            description:
              'Saved to canopy.json for everyone who opens this project.',
            back: 'Plugins',
          }
        : drillIn.kind === 'chat-plugins'
          ? {
              title: 'Plugins for new chats',
              description:
                'On this computer. Every new chat in this project starts with these on.',
              back: 'Plugins',
            }
          : {
              title:
                drillIn.trigger === null
                  ? 'New hook'
                  : getHookTriggerDisplayName(drillIn.trigger),
              description:
                scope === 'source'
                  ? 'Saved to canopy.json, for everyone who opens this project.'
                  : 'Saved on this computer. It overrides canopy.json for you.',
              back: 'Scripts and hooks',
            };
  const pageError =
    error ||
    (closeHeld && closeBlockReason !== null
      ? `${closeBlockReason} Close again to discard the unsaved changes.`
      : autosave.error);

  return (
    <ProjectSettingsFrame
      projectName={project.name}
      projectColor={project.color}
      repoPath={project.repoPath}
      pages={visiblePages}
      activePage={activePage}
      onNavigate={(page) => {
        setActivePage(page);
        setDrillIn(null);
        setEditingScript(null);
      }}
      onClose={handleClose}
      scrollKey={`${activePage}:${drillIn === null ? '' : drillIn.kind === 'hook' ? `hook:${drillIn.trigger ?? 'new'}` : drillIn.kind}`}
    >
      <SettingsPage
        title={drillInCopy?.title ?? PAGE_COPY[activePage].label}
        description={
          drillInCopy?.description ?? PAGE_COPY[activePage].description
        }
        back={
          drillInCopy
            ? { label: drillInCopy.back, onClick: () => setDrillIn(null) }
            : undefined
        }
        headerTrailing={
          <SettingsSaveStatus
            state={saveState}
            idleLabel={
              activePage === 'scripts' || activePage === 'start-page'
                ? null
                : 'Changes save automatically'
            }
          />
        }
        dataTestId={`project-settings-page-${activePage}`}
      >
        {pageError ? (
          <ErrorBanner
            errorSource="project-settings-error"
            error={pageError}
            details={detailsFor(pageError, errorFailure)}
            className=""
            testId="project-settings-error"
          />
        ) : null}
        {isOwnSaveSection(activePage) ? null : pageBody[activePage]()}
        {OWN_SAVE_SECTIONS.map((section) =>
          section === activePage || openedOwnSavePages.includes(section) ? (
            <div
              key={section}
              className={
                section === activePage ? 'flex flex-col gap-10' : 'hidden'
              }
            >
              {pageBody[section]()}
            </div>
          ) : null,
        )}
      </SettingsPage>

      {confirmingDelete && (
        <ConfirmDialog
          title={
            <>
              Remove{' '}
              <span className={POSTHOG_REPLAY_MASK_CLASS}>{project.name}</span>?
            </>
          }
          message={
            <>
              <span className={POSTHOG_REPLAY_MASK_CLASS}>{project.name}</span>{' '}
              and its {project.worktrees.length}{' '}
              {project.worktrees.length === 1 ? 'worktree' : 'worktrees'} leave
              the sidebar. A repository in {brandText.appName}’s own folder is
              deleted from disk.
            </>
          }
          confirmLabel="Remove"
          busyLabel="Removing…"
          busy={isDeleting}
          destructive
          focusCancel
          dataTestId="project-settings-remove-dialog"
          confirmTestId="project-settings-remove-confirm"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void handleDelete()}
        />
      )}

      {showConvertOptions && (
        <DialogModal
          onClose={() => {
            if (!convertBusy) setShowConvertOptions(false);
          }}
          title="Convert to multi-repo project?"
          maxWidth="md"
          dataTestId="project-settings-convert-dialog"
        >
          <div className="flex flex-col gap-4">
            <p className="text-s text-pretty fg-secondary">
              This updates project tracking, keeps <code>repos/</code> out of
              git, and creates a multi-repo <code>canopy.json</code>. If agent
              instructions already exist, choose what happens to them.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                size="compact"
                variant="ghost"
                onClick={() => setShowConvertOptions(false)}
                disabled={convertBusy}
              >
                Cancel
              </Button>
              <Button
                size="compact"
                onClick={() => void handleConvertToMultiRepo('unchanged')}
                disabled={convertBusy}
              >
                Leave unchanged
              </Button>
              <Button
                size="compact"
                onClick={() => void handleConvertToMultiRepo('update')}
                disabled={convertBusy}
              >
                Update
              </Button>
              <Button
                size="compact"
                variant="primary"
                onClick={() => void handleConvertToMultiRepo('replace')}
                disabled={convertBusy}
              >
                Replace
              </Button>
            </div>
          </div>
        </DialogModal>
      )}

      <SettingsTeardownFailureDialog
        error={teardownError}
        isRetrying={isTeardownRetrying}
        archiveWorktree={archiveWorktree}
        forceArchiveWorktree={forceArchiveWorktree}
        onRetryDelete={handleDelete}
        onRetryingChange={setIsTeardownRetrying}
        onErrorChange={setTeardownError}
        onFailure={setManageError}
      />
    </ProjectSettingsFrame>
  );
}
