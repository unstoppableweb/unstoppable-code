import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { resolveCoworkFolderMissing } from '@/lib/ipc-cowork-folder';
import { create } from 'zustand';
import type { SidebarItemGroupCreationOptions } from '@canopy/protocol/sidebar';
import { useSidebarItemGroupsStore } from './sidebarItemGroupsStore';
import {
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_COWORK_WORKSPACE_ID,
  ORG_DEFAULT_COWORK_WORKSPACE_ID_PREFIX,
  defaultCoworkWorkspaceIdForContext,
  isDefaultCoworkWorkspaceId,
  isOrgDefaultCoworkWorkspaceId,
  type ApprovalMode,
  type AttachmentMeta,
  type AgentModelConfig,
  type AgentProviderType,
  type ChatAttachmentPromptContext,
  type ChatInterfaceMode,
  type ChatModel,
  type ChatProjectData,
  type DesktopBlueprintCatalogEntry,
  type ChatSendMessageRequest,
  type ChatTabPluginSelections,
  type CodexSpeed,
  type CoworkWorkEntryMeta,
  type CreateChatProjectFromTemplateResponse,
  type CreateOrgCoworkProjectRequest,
  type CreateOrgCoworkProjectResult,
  type FileReference,
  type PluginSelectionTombstones,
  type PreferencesData,
  type StandaloneArchiveReadResponse,
  type StandaloneChatMeta,
  type ThinkingLevel,
  type UpdateChatProjectRequest,
} from '@canopy/desktop-shared/types';
import { EMPTY_SELECTIONS, normalizeSelections } from '@/lib/pluginSelections';
import {
  chatSurfaceUsesGlobalPluginDefaults,
  hasAnyTombstones,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { emptyPluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { applyNewChatPluginSelections } from '@/lib/chatPluginEditing';
import {
  attachmentMetasFromPaths,
  buildAttachmentPromptContexts,
} from './chat/attachments';
import { hydratePersistedChatTab } from '@/lib/chatTabPersistence';
import {
  useChatStore,
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
  type ChatTab,
} from './chatStore';
import { usePanelLayoutStore } from './panelLayoutStore';
import { releasePipelinePanelUiForOwner } from './pipelinePanelUiStore';
import { useProjectsStore } from './projectsStore';
import {
  awaitPendingRemovalHoldForE2e,
  useArchivedContainersStore,
} from './archivedContainersStore';
import { setStandaloneChatArchiveOverlayOpen } from './standaloneChatVisibility';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { markStartPageSuppressed } from '@/lib/panels/start-page-suppression';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol';
import { isWebCoreScope } from '@/lib/chat-authority';
import { webCoreCoworkProject } from '@/lib/cowork-directory';
import { webCoreUnavailable } from './chat/web-core/web-core-chat-backend';

/**
 * A web core project's tasks as work entries, from the cloud cowork store; a
 * web core id never reaches main's registry (CAN-6175 D1).
 */
function webCoreWorkEntries(projectId: string): {
  entries: CoworkWorkEntryMeta[];
} {
  const project = webCoreCoworkProject(projectId);
  if (project === null) throw new Error('Cloud chats are offline.');
  return { entries: [...project.entries] };
}

/**
 * Refuses a work-entry or project change the web core doesn't serve through
 * this store, before any request. Cloud tasks are renamed, archived and
 * reordered from their own sidebar rows.
 */
function refuseWebCoreProject(projectId: string, member: string): void {
  if (isWebCoreScope(projectId)) throw webCoreUnavailable(member);
}

/**
 * Whether a selection may be written to main's startup preferences. A web
 * core project is never restored at startup, before the cloud connects.
 */
function persistsCoworkSelection(
  scopedWorkspaceId: string | null,
  projectId: string,
): boolean {
  return scopedWorkspaceId === null && !isWebCoreScope(projectId);
}

/** Sentinel value indicating summary is still being generated. */
export const SUMMARY_LOADING = '__loading__';

function workEntryKey(workspaceId: string, entryId: string): string {
  return `${workspaceId}/${entryId}`;
}

/**
 * The catch-all Cowork workspace for the current scoping context: the
 * organization's own Chats workspace in org scope, Personal's otherwise.
 * Uses the sidebar's flag and hydration gate, so it answers Personal until
 * organization scoping is enabled and the context is known.
 */
export function currentDefaultCoworkWorkspaceId(): string {
  return defaultCoworkWorkspaceIdForContext(getSidebarScopingContext());
}

/**
 * A project-less chat was started in an organization whose Chats workspace
 * is not on this device yet. The chat is refused rather than filed under
 * Personal, which would run it with the wrong resources and policy.
 */
export class OrgDefaultChatsUnavailableError extends Error {
  readonly workspaceId: string;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;

  constructor(workspaceId: string, options?: { cause?: unknown }) {
    super('This organization’s chats aren’t ready yet. Try again.');
    this.name = 'OrgDefaultChatsUnavailableError';
    this.workspaceId = workspaceId;
    this.cause = options?.cause;
  }
}

function organizationIdFromDefaultWorkspaceId(
  workspaceId: string,
): string | null {
  return isOrgDefaultCoworkWorkspaceId(workspaceId)
    ? workspaceId.slice(ORG_DEFAULT_COWORK_WORKSPACE_ID_PREFIX.length)
    : null;
}

export async function requireOrgDefaultChatsEligibility(
  workspaceId: string,
): Promise<string | null> {
  const organizationId = organizationIdFromDefaultWorkspaceId(workspaceId);
  if (!organizationId) return null;
  const chatProjectApi = window.api.chatProject;
  if (typeof chatProjectApi.getOrgDefaultCoworkEligibility !== 'function') {
    throw new OrgDefaultChatsUnavailableError(workspaceId);
  }
  try {
    if (
      (await chatProjectApi.getOrgDefaultCoworkEligibility(organizationId)) !==
      'eligible'
    ) {
      throw new OrgDefaultChatsUnavailableError(workspaceId);
    }
  } catch (error) {
    if (error instanceof OrgDefaultChatsUnavailableError) throw error;
    throw new OrgDefaultChatsUnavailableError(workspaceId, { cause: error });
  }
  return organizationId;
}

/** Apply an optional start-page patch; null removes the stored value. */
function withStartPagePatch(
  project: ChatProjectData,
  startPage: UpdateChatProjectRequest['startPage'],
): ChatProjectData {
  if (startPage === undefined) return project;
  if (startPage !== null) return { ...project, startPage };
  const { startPage: _removed, ...rest } = project;
  void _removed;
  return rest;
}

function sortChatProjects(projects: ChatProjectData[]): ChatProjectData[] {
  return projects.slice().sort((a, b) => {
    const aDefault = isDefaultCoworkWorkspaceId(a.id);
    const bDefault = isDefaultCoworkWorkspaceId(b.id);
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    // Personal's catch-all ahead of any organization's.
    if (aDefault && bDefault) {
      if (a.id === DEFAULT_COWORK_WORKSPACE_ID) return -1;
      if (b.id === DEFAULT_COWORK_WORKSPACE_ID) return 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function syncCoworkWorkEntryCount(
  workspaceId: string,
  workEntryCount: number,
): void {
  // Scoped/popout test harnesses replace the projects store with a minimal
  // facade because those surfaces do not own the main sidebar.
  if (typeof useProjectsStore.setState !== 'function') return;
  useProjectsStore.setState((state) => {
    let changed = false;
    const projects = state.projects.map((project) => {
      if (
        project.id !== workspaceId ||
        project.type !== 'cowork' ||
        project.workEntryCount === workEntryCount
      ) {
        return project;
      }
      changed = true;
      return { ...project, workEntryCount };
    });
    return changed ? { projects } : state;
  });
}

function sharedRunEqual(
  left: CoworkWorkEntryMeta['sharedRun'],
  right: CoworkWorkEntryMeta['sharedRun'],
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.externalId === right.externalId &&
    left.teamId === right.teamId &&
    left.teamName === right.teamName &&
    left.organizationId === right.organizationId &&
    left.organizationName === right.organizationName &&
    left.shareScope === right.shareScope &&
    left.sharedAt === right.sharedAt
  );
}

function unreadChatsEqual(
  left: CoworkWorkEntryMeta['unreadChats'],
  right: CoworkWorkEntryMeta['unreadChats'],
): boolean {
  const leftRefs = left ?? [];
  const rightRefs = right ?? [];
  if (leftRefs.length !== rightRefs.length) return false;
  return leftRefs.every((ref, index) => {
    const other = rightRefs[index];
    return (
      other !== undefined &&
      ref.chatId === other.chatId &&
      ref.title === other.title &&
      ref.providerType === other.providerType &&
      ref.preview === other.preview &&
      ref.markedUnread === other.markedUnread
    );
  });
}

function workEntryMetaEqual(
  left: CoworkWorkEntryMeta,
  right: CoworkWorkEntryMeta,
): boolean {
  return (
    left.id === right.id &&
    left.pinned === right.pinned &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.status === right.status &&
    left.hasUserChanges === right.hasUserChanges &&
    left.lastMessageAt === right.lastMessageAt &&
    left.providerType === right.providerType &&
    left.chatCount === right.chatCount &&
    left.hasActiveChat === right.hasActiveChat &&
    left.lastTouchedAt === right.lastTouchedAt &&
    unreadChatsEqual(left.unreadChats, right.unreadChats) &&
    sharedRunEqual(left.sharedRun, right.sharedRun)
  );
}

/**
 * Structural equality for the derived work-entry meta list so event-driven
 * refreshes only write state (and re-render subscribers) when something
 * actually changed. Mirrors the old `standaloneChatMetaListEqual` discipline.
 */
function workEntryMetaListEqual(
  left: CoworkWorkEntryMeta[],
  right: CoworkWorkEntryMeta[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => workEntryMetaEqual(entry, right[index]))
  );
}

interface ActiveArchiveData {
  transcriptScope?: StandaloneArchiveReadResponse['transcriptScope'];
  summary: string;
  legacySummaryOnly: boolean;
  tab: ChatTab | null;
}

function buildActiveArchiveData(
  response: StandaloneArchiveReadResponse,
): ActiveArchiveData {
  return {
    transcriptScope: response.transcriptScope,
    summary: response.summary,
    legacySummaryOnly: response.legacySummaryOnly,
    tab: response.snapshot
      ? hydratePersistedChatTab(response.snapshot.tab)
      : null,
  };
}

interface PreferredWorkEntry {
  projectId: string;
  entryId: string;
  attentionLanding?: boolean;
}

interface StandaloneChatRecovery {
  userMessageId: string;
  onCreated: (target: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }) => void;
  onSubmitted: () => void;
}

interface StandaloneChatState {
  /** Work Entries of the active cowork workspace in persisted sidebar order. */
  workEntries: CoworkWorkEntryMeta[];
  chatProjects: ChatProjectData[];
  /** The Work Entry whose panel grid is currently rendered, when selected. */
  activeWorkEntryId: string | null;
  activeChatProjectId: string;
  /**
   * Non-null when this store instance is pinned to a single workspace (the
   * App Advisor popout renderer scopes to `APP_ADVISOR_PROJECT_ID`). While
   * scoped:
   * - `chatProject.list` is never called (the single workspace config is
   *   synthesized);
   * - `projectsStore.loadProjects` is never triggered from this store;
   * - `lastActiveContext` MRU preferences are NEVER written — scoped mode
   *   must not corrupt main-window startup routing;
   * - `switchChatProject` is forbidden (dev-guarded).
   */
  scopedWorkspaceId: string | null;
  initialized: boolean;
  chatProjectsLoaded: boolean;
  /**
   * Legacy archived-chat overlay: the chat-history chat currently shown
   * above the panel grid, or null when the overlay is closed.
   */
  archiveOverlayChatId: string | null;
  /** null = no archived chat selected, SUMMARY_LOADING = generating, string = ready */
  activeSummary: string | null;
  activeArchiveData: ActiveArchiveData | null;
  /**
   * Whether the Cowork cold-start empty state has been dismissed this session.
   * Lives in the store (not component-local state) so it survives
   * `StandaloneChatPage` unmount/remount when the user switches tabs before
   * sending any message. See `StandaloneChatPage` cold-start gate.
   */
  coldStartDismissed: boolean;
  /** First-use organization Chats provisioning failure shown in the chat page. */
  orgDefaultChatsError: { projectId: string; message: string } | null;

  /* ── Sidebar multi-project fields ── */
  /**
   * Per-project Work Entry lists for the unified sidebar's cowork rows.
   * Populated lazily via {@link StandaloneChatState.loadSidebarProjectEntries}
   * from the same `workEntries.list` IPC the active-project path uses. The
   * active project is derived from the live
   * {@link StandaloneChatState.workEntries} array while active; when switching
   * projects, the outgoing active project's list is snapshotted here for
   * inactive sidebar rendering.
   */
  sidebarEntriesByProject: Record<string, CoworkWorkEntryMeta[]>;
  /**
   * Lazily loaded per-project LEGACY archived chats (`chat-history/` +
   * pre-entry archives, served by `standaloneChat.list` which now returns
   * only archived metas). Backs the sidebar's read-only "Archived" subgroup.
   */
  legacyArchivedByProject: Record<string, StandaloneChatMeta[]>;
  /**
   * Cold-start initialization. Single-flight: concurrent callers share one
   * run. `preferred` names the entry an explicit sidebar click is heading to.
   */
  initialize: (preferred?: PreferredWorkEntry) => Promise<void>;
  /**
   * Scoped initialization for single-workspace renderers (the App Advisor
   * popout). Pins `activeChatProjectId` to `workspaceId`, synthesizes the
   * workspace configuration (no `chatProject.list`), lists Work Entries
   * (lazily creating/reusing the first empty entry), and selects the most
   * recent entry through the standard chatStore worktree selection.
   */
  initializeScoped: (workspaceId: string) => Promise<void>;
  /** Refresh scoped App Advisor defaults after a preference broadcast. */
  applyScopedPreferences: (preferences: PreferencesData) => void;
  loadChatProjects: () => Promise<void>;
  applyWorkEntriesSnapshot: (
    projectId: string,
    entries: CoworkWorkEntryMeta[],
  ) => void;
  refreshWorkEntries: (
    projectId?: string,
    commitIf?: () => boolean,
  ) => Promise<void>;
  markWorkEntryCustomized: (projectId: string, entryId: string) => void;
  switchChatProject: (
    projectId: string,
    preferredEntryId?: string,
    options?: { attentionLanding?: boolean },
  ) => Promise<boolean>;
  createChatProject: (name: string) => Promise<ChatProjectData>;
  /**
   * Seeds a new cowork project from a curated Blueprint (CAN-2964). Curated
   * seeds are deliberately NOT installs: they carry no lineage claim, so the
   * same Blueprint can be used as many times as the user likes.
   *
   * Returns the whole create response, not just the project: a curated seed
   * now applies the Blueprint's plugin and custom-skill refs, so the refs this
   * device could not resolve come back with it and the caller reports them.
   */
  createChatProjectFromBlueprint: (
    blueprint: DesktopBlueprintCatalogEntry,
    name: string,
  ) => Promise<CreateChatProjectFromTemplateResponse>;
  /** Installs a member-visible Team or Organization template after main re-verifies its pin. */
  createChatProjectFromSharedTemplate: (
    template: WorkspaceTemplateShareSummary,
    name: string,
  ) => Promise<CreateChatProjectFromTemplateResponse>;
  /**
   * Creates (or, with `organizationProjectId`, resumes) a member-owned
   * organization Cowork project (CAN-3453). Main binds and publishes the
   * workspace; on success the project list is reloaded. Callers handle
   * navigation and never switch the organization context.
   */
  createOrgCoworkProject: (
    request: CreateOrgCoworkProjectRequest,
  ) => Promise<CreateOrgCoworkProjectResult>;
  updateChatProject: (req: UpdateChatProjectRequest) => Promise<void>;
  deleteChatProject: (projectId: string) => Promise<void>;
  /**
   * Selects a Work Entry: syncs chatStore worktree selection + tabs, closes
   * the archive overlay, and persists the cowork MRU context. Idempotent and
   * cheap when the entry is already selected. Returns false when a newer
   * destination supersedes the selection before it commits.
   */
  selectWorkEntry: (
    entryId: string,
    destinationRequestId?: number,
    options?: { attentionLanding?: boolean },
  ) => Promise<boolean>;
  /**
   * Creates a new Work Entry in the active workspace (the main-process create
   * reuses an existing EMPTY entry instead of piling up duplicates) and
   * selects it. This is the sidebar "+" semantics: a new multi-chat work area.
   */
  createWorkEntry: (options?: SidebarItemGroupCreationOptions) => Promise<void>;
  /** Rename override for an entry (null clears). Defaults to the active workspace. */
  renameWorkEntry: (
    entryId: string,
    title: string | null,
    projectId?: string,
  ) => Promise<void>;
  /**
   * User-driven completion flag for an entry, mirroring the code-worktree done
   * state. Cowork has no PR-merge signal, so this is the only "finished" marker
   * an entry carries. Defaults to the active workspace.
   */
  setWorkEntryStatus: (
    entryId: string,
    status: 'active' | 'done',
    projectId?: string,
  ) => Promise<void>;
  /**
   * Pins or unpins an entry within its workspace's sidebar section (CAN-1074).
   * Pinned entries float above the recency-ordered tail. Defaults to the
   * active workspace.
   */
  setWorkEntryPinned: (
    entryId: string,
    pinned: boolean,
    projectId?: string,
  ) => Promise<void>;
  /** Persists manual sidebar order for every active entry in a workspace. */
  reorderWorkEntries: (
    projectId: string,
    activeEntryId: string,
    overEntryId: string,
  ) => Promise<void>;
  /**
   * Deletes a Work Entry (sessions + per-entry data + registry row are all
   * destroyed main-side) and cleans up renderer state. When the active entry
   * is deleted, the next most-recent entry is selected (one is created when
   * none remain). Defaults to the active workspace.
   */
  /**
   * Remove a Work Entry into the workspace's retained containers. Deletion
   * retention is always on: by default the entry becomes a "Deleted" item
   * the sweep removes after the retention window; `lockAfterArchive` keeps
   * it as an "Archived" item until the user deletes it.
   */
  deleteWorkEntry: (
    entryId: string,
    projectId?: string,
    options?: { lockAfterArchive?: boolean },
  ) => Promise<void>;
  reconcileArchivedWorkEntry: (
    projectId: string,
    entryId: string,
  ) => Promise<void>;
  /** Leave a work entry that is being removed if it is the active one. */
  leaveRemovedWorkEntry: (projectId: string, entryId: string) => Promise<void>;
  /**
   * New chat tab within the ACTIVE Work Entry. Reuses the entry's empty
   * active tab instead of creating a duplicate. CoworkTopBar's New-chat
   * button routes here.
   */
  startNewChat: () => Promise<void>;
  dismissColdStart: () => void;
  createStandaloneChatWithMessage: (params: {
    /** Retain a partially created chat so the caller can recover the exact target. */
    recovery?: StandaloneChatRecovery;
    chatProjectId?: string;
    /** Blank text creates an empty work entry without starting a turn. */
    message: string;
    /**
     * Caller-minted chat tab id, reused across retries of one launch so a
     * recovering caller can find the chat it already created. Defaults to a
     * fresh id.
     */
    chatId?: string;
    /** Durable initial turn identity for recoverable Try it sends. */
    initialMessageId?: string;
    /**
     * Fires once the entry is allocated and before `message` is sent, so a caller can
     * persist where the chat lives before the turn is in flight.
     */
    onChatCreated?: (location: {
      projectId: string;
      worktreeId: string;
      chatId: string;
    }) => void;
    /**
     * Optional draft config applied to the newly created chat tab before the
     * message is sent. Used by the Home surface's send orchestrator
     * (`dispatchHomeSend`) to carry over the composer draft's model,
     * thinking level, plugin selections, and staged attachments. Applied
     * before `sendMessage`. Blank text retains attachments in the tab's
     * pending draft instead of starting a turn.
     */
    config?: {
      model?: ChatModel;
      planMode?: boolean;
      /** See {@link CreateTabTarget.modelExplicitlyChosen}. */
      modelExplicitlyChosen?: boolean;
      modelSelectionMode?: 'auto';
      thinkingLevel?: ThinkingLevel;
      /**
       * Exact Codex speed for the created chat, applied through the chat
       * store's `setSpeed`. Takes precedence over the legacy `fastMode`.
       */
      speed?: CodexSpeed;
      /** @deprecated Use `speed`. Legacy boolean: true → Fast, false → Regular. */
      fastMode?: boolean;
      attachments?: AttachmentMeta[];
      scheduledSendDraft?: { runAt: string };
      pluginSelections?: ChatTabPluginSelections;
      /**
       * Inherited defaults (the cowork project's and global) the created chat
       * turns off, applied before the first turn. See
       * `homeDraftChatPluginSelections`.
       */
      disabledGlobalPluginSelections?: PluginSelectionTombstones;
      /**
       * `file-reference` pills serialized alongside `message` (Task F3). The
       * cowork root is always the real target cwd (never a repo-shadow
       * checkout), so these are forwarded to `sendMessage` verbatim — no
       * rewrite needed.
       */
      fileReferences?: FileReference[];
      attachmentPaths?: string[];
      attachmentPromptContexts?: ChatAttachmentPromptContext[];
      /**
       * Tool-approval mode override for the created chat tab (Home
       * composer carry-forward). `undefined` leaves the tab unset so the
       * normal resolution chain applies (tabMode -> hookMode ->
       * workspaceDefault -> canopyJsonDefault -> surface default ->
       * `PRODUCT_DEFAULT_APPROVAL_MODE`).
       */
      approvalMode?: ApprovalMode;
    };
  }) => Promise<string>;
  /**
   * Creates a chat tab in the supplied or newly created Work Entry,
   * preserving a caller-assigned chat id, then sends `message`.
   * Used by App Advisor quick prompts, where the main process pre-assigns
   * the chat id before the popout renderer exists.
   * Returns the chat id actually used.
   */
  createWorkEntryChatWithMessage: (params: {
    /** Pre-assigned chat id to preserve (e.g. from a quick-prompt command). */
    chatId?: string;
    /** Existing Work Entry pre-created for this command. */
    entryId?: string;
    /** Remove the pre-created entry if dispatch fails. */
    removeEntryOnFailure?: boolean;
    /** Replace a starter empty tab only when the Work Entry was just created. */
    replaceActiveEmpty?: boolean;
    message: string;
    title?: string;
    config?: {
      model?: ChatModel;
      planMode?: boolean;
      thinkingLevel?: ThinkingLevel;
      modelConfig?: AgentModelConfig;
      providerType?: AgentProviderType;
      pluginSelections?: ChatTabPluginSelections;
      approvalMode?: ApprovalMode;
      interfaceMode?: ChatInterfaceMode;
      fileReferences?: FileReference[];
      attachmentPaths?: string[];
      attachmentPromptContexts?: ChatAttachmentPromptContext[];
    };
    sendOptions?: {
      initiationSource?: ChatSendMessageRequest['initiationSource'];
      automationName?: string;
      userMessageId?: string;
      planMode?: boolean;
      packageOverlay?: ChatSendMessageRequest['packageOverlay'];
    };
  }) => Promise<string>;
  /**
   * LEGACY COMPAT: select a chat by chatId. Resolves which Work Entry owns
   * the chat via `workEntries.resolveChat`, selects that entry, and switches
   * to the tab. When the chat only exists in an entry's unified archive, the
   * entry is selected without opening the archive UI. No-op when the chat
   * cannot be resolved. Callers: AuditTrailPage, WorkersPage, ForkedFromLink,
   * and the App Advisor dispatcher (until Work Entries Phase 3).
   */
  /** Returns false when a newer destination wins or the chat is unavailable. */
  selectChat: (chatId: string) => Promise<boolean>;
  selectArchivedChat: (chatId: string) => Promise<void>;
  selectArchive: (chatId: string) => Promise<void>;
  /** Closes the legacy archived-chat overlay, revealing the panel grid. */
  closeArchiveOverlay: () => void;
  /** Resume a LEGACY archived chat into a fresh Work Entry. */
  resumeArchivedChat: (chatId: string) => Promise<void>;

  /* ── Sidebar multi-project actions ── */
  /** Loads (or refreshes) a project's entry list into `sidebarEntriesByProject`. */
  loadSidebarProjectEntries: (projectId: string) => Promise<void>;
  /** Loads a project's legacy archived chats into `legacyArchivedByProject`. */
  loadLegacyArchivedChats: (projectId: string) => Promise<void>;
  /** Clears the active Work Entry without touching the chat store selection (CAN-2954 context switch). */
  clearActiveWorkEntry: () => void;
  /** Invalidates every in-flight Work Entry navigation (open, project switch, select) so a pending request cannot install its destination after a context switch (CAN-2954). */
  cancelPendingWorkEntryNavigation: () => void;
  /**
   * Opens a Work Entry from the sidebar. Ensures the standalone chat state is
   * initialized and the target project is active before selecting the entry.
   * Callers handle navigation.
   */
  openWorkEntryFromSidebar: (
    projectId: string,
    entryId: string,
  ) => Promise<void>;
  /**
   * Opens a LEGACY archived chat from the sidebar in the archive overlay.
   * Callers handle navigation.
   */
  openArchivedChatFromSidebar: (
    projectId: string,
    chatId: string,
  ) => Promise<void>;
  /**
   * Creates a Work Entry in the given project from the sidebar, switching to
   * it first if it isn't the active project. The main-side create reuses an
   * existing empty entry, so repeated clicks never pile up duplicates.
   * Callers handle navigation.
   */
  createWorkEntryInProject: (
    projectId: string,
    options?: SidebarItemGroupCreationOptions,
  ) => Promise<void>;
  /**
   * Activates a just-created Cowork workspace, expands its sidebar row, and
   * ensures an active Work Entry is visible immediately.
   */
  activateCreatedCoworkWorkspace: (projectId: string) => Promise<boolean>;
}

/**
 * Returns the Work Entry list a sidebar project row should render. The active
 * project derives from the live `workEntries` array; other projects read the
 * lazily loaded `sidebarEntriesByProject` map. Non-reactive read helper for
 * use inside store methods and memoized selectors.
 */
export function getSidebarProjectEntries(
  state: Pick<
    StandaloneChatState,
    'workEntries' | 'activeChatProjectId' | 'sidebarEntriesByProject'
  >,
  projectId: string,
): CoworkWorkEntryMeta[] {
  if (projectId === state.activeChatProjectId) {
    return state.workEntries;
  }
  return state.sidebarEntriesByProject[projectId] ?? [];
}

let switchChatProjectRequestId = 0;
let coworkDestinationRequestId = 0;

/** Increments on every cowork destination request, so a caller can detect a newer selection. */
export function currentCoworkDestinationRequestId(): number {
  return coworkDestinationRequestId;
}
let coworkTransientSelectionRequestId: number | null = null;

/** In-flight cold-start run shared by concurrent `initialize()` callers. */
let initializeInFlight: Promise<void> | null = null;
/** Latest explicit sidebar target supplied by any caller joining that run. */
let initializePreferredWorkEntry: PreferredWorkEntry | undefined;
/** Changes whenever a joining caller supplies a different explicit target. */
let initializePreferredWorkEntryVersion = 0;
interface WorkEntryRefreshCoordinator {
  requestedGeneration: number;
  completedGeneration: number;
  commitIfByGeneration: Map<number, (() => boolean) | undefined>;
  waiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
  drain: Promise<void>;
}

/** Event bursts share one sequential coordinator per workspace. */
const workEntryRefreshCoordinators = new Map<
  string,
  WorkEntryRefreshCoordinator
>();
/** A placement reconciliation supersedes ordinary reads already in flight. */
const workEntrySnapshotRevisions = new Map<string, number>();
export function getWorkEntrySnapshotRevision(projectId: string): number {
  return workEntrySnapshotRevisions.get(projectId) ?? 0;
}

export const useStandaloneChatStore = create<StandaloneChatState>(
  (set, get) => ({
    workEntries: [],
    chatProjects: [],
    activeWorkEntryId: null,
    activeChatProjectId: currentDefaultCoworkWorkspaceId(),
    scopedWorkspaceId: null,
    initialized: false,
    chatProjectsLoaded: false,
    archiveOverlayChatId: null,
    activeSummary: null,
    activeArchiveData: null,
    coldStartDismissed: false,
    orgDefaultChatsError: null,
    sidebarEntriesByProject: {},
    legacyArchivedByProject: {},

    initializeScoped: async (workspaceId: string): Promise<void> => {
      if (get().initialized && get().scopedWorkspaceId === workspaceId) {
        return;
      }

      // 1. Pin the scope + active workspace before any await so every other
      // action observes scoped mode from the first microtask.
      set({
        scopedWorkspaceId: workspaceId,
        activeChatProjectId: workspaceId,
      });

      const chatStore = useChatStore.getState();
      await chatStore.ensureModelDefaultsLoaded();

      // 2./3. Skip `chatProject.list`: synthesize the single workspace
      // configuration from the App Advisor settings file plus the global
      // appAdvisor* preferences.
      let synthesized: ChatProjectData = {
        id: workspaceId,
        name: ORCHESTRATOR_LABEL,
        createdAt: new Date(0).toISOString(),
      };
      if (workspaceId === APP_ADVISOR_PROJECT_ID) {
        const [settings, prefs] = await Promise.all([
          window.api.appAdvisor.settingsLoad().catch(() => null),
          window.api.loadPreferences().catch(() => null),
        ]);
        synthesized = {
          ...synthesized,
          ...(settings?.description !== undefined
            ? { description: settings.description }
            : {}),
          ...(settings?.archiveRetentionDays !== undefined
            ? { archiveRetentionDays: settings.archiveRetentionDays }
            : {}),
          ...(prefs?.appAdvisorModel !== undefined
            ? { defaultModel: prefs.appAdvisorModel }
            : {}),
          ...(prefs?.appAdvisorPluginSelections !== undefined
            ? { defaultPluginSelections: prefs.appAdvisorPluginSelections }
            : {}),
        };
      }
      if (get().scopedWorkspaceId !== workspaceId) return;
      set({ chatProjects: [synthesized], chatProjectsLoaded: true });

      // 4. List Work Entries, lazily creating/reusing the first empty entry.
      const listResponse = await window.api.workEntries.list({
        projectId: workspaceId,
      });
      if (get().scopedWorkspaceId !== workspaceId) return;
      let entries = listResponse.entries;
      let entryId = entries[0]?.id ?? null;
      if (entryId === null) {
        const created = await window.api.workEntries.create({
          projectId: workspaceId,
        });
        if (get().scopedWorkspaceId !== workspaceId) return;
        entries = [created.entry];
        entryId = created.entry.id;
      }

      // 5. Select the entry through the standard chat-store path and sync
      // its active empty tab to the synthesized defaults.
      chatStore.setWorktreeDefaultPlugins(
        workspaceId,
        entryId,
        synthesized.defaultPluginSelections,
      );
      chatStore.selectWorktree(workspaceId, entryId);
      await chatStore.loadTabs();
      await chatStore.syncActiveEmptyTabToDefaults();
      if (get().scopedWorkspaceId !== workspaceId) return;

      set({
        workEntries: entries,
        activeWorkEntryId: entryId,
        archiveOverlayChatId: null,
        activeSummary: null,
        activeArchiveData: null,
        initialized: true,
      });
    },

    applyScopedPreferences: (preferences): void => {
      if (get().scopedWorkspaceId !== APP_ADVISOR_PROJECT_ID) return;
      const defaultPluginSelections = preferences.appAdvisorPluginSelections;
      set((state) => ({
        chatProjects: state.chatProjects.map((project) =>
          project.id === APP_ADVISOR_PROJECT_ID
            ? {
                ...project,
                defaultModel: preferences.appAdvisorModel,
                defaultPluginSelections,
              }
            : project,
        ),
      }));
      const chatStore = useChatStore.getState();
      for (const entry of get().workEntries) {
        chatStore.setWorktreeDefaultPlugins(
          APP_ADVISOR_PROJECT_ID,
          entry.id,
          defaultPluginSelections,
        );
      }
    },

    initialize: async (preferred): Promise<void> => {
      if (get().initialized) return;
      if (get().scopedWorkspaceId !== null) {
        // Scoped renderers initialize exclusively through initializeScoped.
        return;
      }
      if (
        preferred &&
        (initializePreferredWorkEntry?.projectId !== preferred.projectId ||
          initializePreferredWorkEntry.entryId !== preferred.entryId)
      ) {
        initializePreferredWorkEntry = preferred;
        initializePreferredWorkEntryVersion += 1;
      }
      // Single-flight: the page mount effect and a sidebar entry click can
      // both land here before `initialized` flips (it is only set at the
      // end). A duplicated run would apply the default most-recent
      // selection twice and clobber the explicit entry selection that
      // completed between them.
      if (initializeInFlight) {
        return initializeInFlight;
      }

      const run = (async (): Promise<void> => {
        await get().loadChatProjects();
        const chatStore = useChatStore.getState();
        await chatStore.ensureModelDefaultsLoaded();

        while (true) {
          const preferredWorkEntry = initializePreferredWorkEntry;
          const preferredWorkEntryVersion = initializePreferredWorkEntryVersion;
          const preferredProject = preferredWorkEntry
            ? get().chatProjects.find(
                (project) => project.id === preferredWorkEntry.projectId,
              )
            : undefined;
          const activeProjectId =
            preferredProject?.id ?? get().activeChatProjectId;
          const activeProject =
            preferredProject ??
            get().chatProjects.find(
              (project) => project.id === activeProjectId,
            );
          const hasNewerPreferredWorkEntry = (): boolean =>
            preferredWorkEntryVersion !== initializePreferredWorkEntryVersion;

          await window.api.standaloneChat.init(activeProjectId);
          if (hasNewerPreferredWorkEntry()) continue;

          const listResponse = await window.api.workEntries.list({
            projectId: activeProjectId,
          });
          if (hasNewerPreferredWorkEntry()) continue;

          let entries = listResponse.entries;
          const preferredEntryId =
            preferredWorkEntry?.projectId === activeProjectId
              ? entries.find((entry) => entry.id === preferredWorkEntry.entryId)
                  ?.id
              : undefined;
          let entryId = preferredEntryId ?? entries[0]?.id ?? null;
          if (entryId === null) {
            const created = await window.api.workEntries.create({
              projectId: activeProjectId,
            });
            if (hasNewerPreferredWorkEntry()) continue;
            entries = [created.entry];
            entryId = created.entry.id;
          }

          syncCoworkWorkEntryCount(activeProjectId, entries.length);

          if (get().activeChatProjectId !== activeProjectId) {
            set({ activeChatProjectId: activeProjectId });
          }

          // Default plugins are keyed per (workspace, worktree) and the entry
          // occupies the worktree slot, so they must be (re-)set for the entry
          // being selected before its tabs hydrate.
          chatStore.setWorktreeDefaultPlugins(
            activeProjectId,
            entryId,
            activeProject?.defaultPluginSelections,
          );
          if (preferredWorkEntry?.attentionLanding === true) {
            chatStore.selectWorktree(activeProjectId, entryId, {
              attentionLanding: true,
            });
          } else {
            chatStore.selectWorktree(activeProjectId, entryId);
          }
          await chatStore.loadTabs();
          if (hasNewerPreferredWorkEntry()) continue;
          await chatStore.syncActiveEmptyTabToDefaults();
          if (hasNewerPreferredWorkEntry()) continue;

          set({
            workEntries: entries,
            activeWorkEntryId: entryId,
            archiveOverlayChatId: null,
            activeSummary: null,
            activeArchiveData: null,
            initialized: true,
          });
          return;
        }
      })();

      initializeInFlight = run.finally(() => {
        initializeInFlight = null;
        initializePreferredWorkEntry = undefined;
      });
      return initializeInFlight;
    },

    loadChatProjects: async (): Promise<void> => {
      if (get().scopedWorkspaceId !== null) {
        // Scoped mode synthesizes its single workspace configuration and
        // must never call the sentinel-guarded chatProject API.
        return;
      }
      const response = await window.api.chatProject.list();
      const chatProjects = sortChatProjects(response.projects);
      const currentActiveId = get().activeChatProjectId;
      // Fall back to the context's catch-all when it is listed. An
      // organization's not yet provisioned here keeps Personal's as the
      // displayed workspace only; project-less sends fail closed instead.
      const contextDefaultId = currentDefaultCoworkWorkspaceId();
      const fallbackId = contextDefaultId;
      const activeChatProjectId = chatProjects.some(
        (project) => project.id === currentActiveId,
      )
        ? currentActiveId
        : fallbackId;

      set({
        chatProjects,
        activeChatProjectId,
        chatProjectsLoaded: true,
      });
    },

    markWorkEntryCustomized: (projectId, entryId): void => {
      const mark = (entries: CoworkWorkEntryMeta[]): CoworkWorkEntryMeta[] => {
        const index = entries.findIndex(
          (entry) => entry.id === entryId && entry.hasUserChanges !== true,
        );
        if (index === -1) return entries;
        const next = [...entries];
        next[index] = { ...next[index], hasUserChanges: true };
        return next;
      };
      set((state) => {
        const sidebarEntries = state.sidebarEntriesByProject[projectId];
        const workEntries =
          state.activeChatProjectId === projectId
            ? mark(state.workEntries)
            : state.workEntries;
        const nextSidebarEntries =
          sidebarEntries === undefined ? undefined : mark(sidebarEntries);
        if (
          workEntries === state.workEntries &&
          nextSidebarEntries === sidebarEntries
        ) {
          return state;
        }
        return {
          ...(workEntries === state.workEntries ? {} : { workEntries }),
          ...(nextSidebarEntries === undefined ||
          nextSidebarEntries === sidebarEntries
            ? {}
            : {
                sidebarEntriesByProject: {
                  ...state.sidebarEntriesByProject,
                  [projectId]: nextSidebarEntries,
                },
              }),
        };
      });
    },

    applyWorkEntriesSnapshot: (projectId, entries): void => {
      workEntrySnapshotRevisions.set(
        projectId,
        (workEntrySnapshotRevisions.get(projectId) ?? 0) + 1,
      );
      syncCoworkWorkEntryCount(projectId, entries.length);
      set((state) => {
        if (state.activeChatProjectId === projectId) {
          return workEntryMetaListEqual(state.workEntries, entries)
            ? state
            : { workEntries: entries };
        }
        const previous = state.sidebarEntriesByProject[projectId];
        return previous && workEntryMetaListEqual(previous, entries)
          ? state
          : {
              sidebarEntriesByProject: {
                ...state.sidebarEntriesByProject,
                [projectId]: entries,
              },
            };
      });
    },
    refreshWorkEntries: async (
      projectId?: string,
      commitIf?: () => boolean,
    ): Promise<void> => {
      const resolvedProjectId = projectId ?? get().activeChatProjectId;
      const performRefresh = async (
        generationCommitIf?: () => boolean,
        generationIsCurrent?: () => boolean,
      ): Promise<boolean> => {
        const revision = workEntrySnapshotRevisions.get(resolvedProjectId) ?? 0;
        const response = isWebCoreScope(resolvedProjectId)
          ? webCoreWorkEntries(resolvedProjectId)
          : await window.api.workEntries.list({
              projectId: resolvedProjectId,
            });
        if (generationIsCurrent !== undefined && !generationIsCurrent()) {
          return false;
        }
        if (
          revision !== (workEntrySnapshotRevisions.get(resolvedProjectId) ?? 0)
        )
          return false;
        syncCoworkWorkEntryCount(resolvedProjectId, response.entries.length);

        if (generationCommitIf !== undefined && !generationCommitIf()) {
          return true;
        }

        get().applyWorkEntriesSnapshot(resolvedProjectId, response.entries);
        return true;
      };
      const existing = workEntryRefreshCoordinators.get(resolvedProjectId);
      if (existing) {
        existing.requestedGeneration += 1;
        const generation = existing.requestedGeneration;
        existing.commitIfByGeneration.set(generation, commitIf);
        await new Promise<void>((resolve, reject) => {
          existing.waiters.push({ generation, resolve, reject });
        });
        return;
      }

      const coordinator: WorkEntryRefreshCoordinator = {
        requestedGeneration: 1,
        completedGeneration: 0,
        commitIfByGeneration: new Map([[1, commitIf]]),
        waiters: [],
        drain: Promise.resolve(),
      };
      const firstRefresh = new Promise<void>((resolve, reject) => {
        coordinator.waiters.push({ generation: 1, resolve, reject });
      });
      workEntryRefreshCoordinators.set(resolvedProjectId, coordinator);
      coordinator.drain = (async (): Promise<void> => {
        for (;;) {
          const targetGeneration = coordinator.requestedGeneration;
          const settledCommitPredicates = Array.from(
            coordinator.commitIfByGeneration.entries(),
          )
            .filter(([generation]) => generation <= targetGeneration)
            .map(([, predicate]) => predicate);
          const generationCommitIf = (): boolean =>
            settledCommitPredicates.some(
              (predicate) => predicate === undefined || predicate(),
            );
          let refreshError: unknown;
          let generationSettled = true;
          try {
            generationSettled = await performRefresh(
              generationCommitIf,
              () => targetGeneration === coordinator.requestedGeneration,
            );
          } catch (error) {
            refreshError = error;
          }
          if (targetGeneration < coordinator.requestedGeneration) {
            continue;
          }
          if (!generationSettled) {
            continue;
          }
          coordinator.completedGeneration = targetGeneration;
          const completedPredicateGenerations: number[] = Array.from(
            coordinator.commitIfByGeneration.keys(),
          );
          for (const generation of completedPredicateGenerations) {
            if (generation <= targetGeneration) {
              coordinator.commitIfByGeneration.delete(generation);
            }
          }
          const completedWaiters = coordinator.waiters.filter(
            (waiter) => waiter.generation <= targetGeneration,
          );
          coordinator.waiters = coordinator.waiters.filter(
            (waiter) => waiter.generation > targetGeneration,
          );
          completedWaiters.forEach((waiter) => {
            if (refreshError === undefined) {
              waiter.resolve();
            } else {
              waiter.reject(refreshError);
            }
          });
          if (
            coordinator.completedGeneration === coordinator.requestedGeneration
          ) {
            if (
              workEntryRefreshCoordinators.get(resolvedProjectId) ===
              coordinator
            ) {
              workEntryRefreshCoordinators.delete(resolvedProjectId);
            }
            return;
          }
        }
      })();
      await firstRefresh;
    },

    switchChatProject: async (
      projectId: string,
      preferredEntryId?: string,
      options?: { attentionLanding?: boolean },
    ): Promise<boolean> => {
      if (get().scopedWorkspaceId !== null) {
        // Scoped renderers own exactly one workspace; switching would tear
        // down the pinned scope. Fail loudly in development so accidental
        // call paths are caught by tests, and refuse quietly in production.
        if (process.env.NODE_ENV !== 'production') {
          throw new Error(
            `switchChatProject('${projectId}') is forbidden while scoped to '${get().scopedWorkspaceId}'`,
          );
        }
        return false;
      }
      // Capture the outgoing workspace *before* the self-heal listing below.
      // `loadChatProjects` rewrites `activeChatProjectId` to
      // `DEFAULT_COWORK_WORKSPACE_ID` when the current active workspace is
      // absent from the fresh list, but it leaves `workEntries` untouched.
      // Capturing after the listing would therefore pair the default
      // workspace's id with the *old* workspace's entries and stash them under
      // `sidebarEntriesByProject[DEFAULT_COWORK_WORKSPACE_ID]`, which
      // `getSidebarEntriesForProject` then renders on the wrong sidebar row.
      //
      // Accepted trade-off: `previousActiveEntries` is now read across an
      // await, so a `refreshWorkEntries` that lands during the listing is
      // discarded in favor of this snapshot. That is cosmetic and self-healing
      // (`loadSidebarProjectEntries` repairs the collapsed row), whereas
      // re-reading after the listing reintroduces the wrong-row bug above. Do
      // not "fix" it by moving the read back down.
      const previousActiveProjectId = get().activeChatProjectId;
      const previousActiveEntries = get().workEntries;

      // Main can create a Cowork workspace without the renderer's knowledge — a
      // shared-container fork (`forkSharedCoworkContainer`) calls
      // `createCoworkWorkspace` directly, unlike `createChatProject`, which
      // appends to `chatProjects` optimistically. A stale list is not proof a
      // workspace is absent, so list once before refusing.
      //
      // Placement is load-bearing: this must stay above the request-id bump
      // below (there is no `stillOwnsSwitch()` check before the first `set`, so
      // an await after the bump would let a competing switch win the id while
      // this call still clobbers state) and above the already-active fast path
      // (which would otherwise return `true` for a workspace missing from a
      // stale list, leaving `CoworkTopBar`'s `chatProjects.find(...)` null).
      //
      // Because it awaits *before* the bump, it owns its own supersession
      // check. Without one, a switch that starts and finishes while this
      // listing is in flight is silently undone: this call would go on to bump
      // the request id higher and overwrite `activeChatProjectId` back to its
      // own target, while the newer switch's `stillOwnsSwitch()` merely returns
      // `false` and never repairs the clobber. `false` is the established
      // "superseded, abort" return every caller already handles, and unlike a
      // throw it does not fire the caller's failure toast.
      //
      // It dedupes against a *completed* competing switch, not a concurrent
      // in-flight one: two switches that both start here before either bumps
      // the id each issue their own listing. That costs a duplicate round trip
      // with equivalent server data, not correctness, so it is left alone.
      //
      // Scope: only the *new-workspace* fork destination manufactures a
      // workspace the renderer never listed. Forking into an *existing*
      // workspace was never defective, and this block does not subsume the
      // entry-refresh guard in `openWorkEntryFromSidebar` — that one covers an
      // already-active workspace whose new entry no project switch reloaded.
      // Do not "simplify" it away on the strength of this listing.
      //
      // A web core project is never in that list: the cloud cowork store
      // holds it, and an offline cloud means it is absent.
      const webCoreProject = isWebCoreScope(projectId)
        ? webCoreCoworkProject(projectId)
        : undefined;
      if (webCoreProject === null) throw new Error('Chat project not found');
      if (
        webCoreProject === undefined &&
        !get().chatProjects.some((p) => p.id === projectId)
      ) {
        const requestIdBeforeListing = switchChatProjectRequestId;
        await get().loadChatProjects();
        if (requestIdBeforeListing !== switchChatProjectRequestId) {
          return false;
        }
      }
      if (
        get().activeChatProjectId === projectId &&
        get().initialized &&
        (preferredEntryId === undefined ||
          get().activeWorkEntryId === preferredEntryId)
      ) {
        return true;
      }
      const requestId = ++switchChatProjectRequestId;
      const stillOwnsSwitch = (): boolean =>
        requestId === switchChatProjectRequestId &&
        get().activeChatProjectId === projectId;

      const project =
        webCoreProject ?? get().chatProjects.find((p) => p.id === projectId);
      if (!project) {
        // The list above is fresh, so this is a genuinely absent workspace
        // rather than a stale renderer. Throwing keeps it distinct from the
        // `false` returns below, which callers read as "superseded, abort".
        throw new Error('Chat project not found');
      }
      const defaultPluginSelections =
        'defaultPluginSelections' in project
          ? project.defaultPluginSelections
          : undefined;

      if (
        previousActiveProjectId !== projectId &&
        previousActiveEntries.length
      ) {
        set((state) => ({
          sidebarEntriesByProject: {
            ...state.sidebarEntriesByProject,
            [previousActiveProjectId]: previousActiveEntries,
          },
        }));
      }

      set({
        activeChatProjectId: projectId,
        workEntries: [],
        activeWorkEntryId: null,
        archiveOverlayChatId: null,
        activeSummary: null,
        activeArchiveData: null,
      });

      if (webCoreProject === undefined) {
        await window.api.standaloneChat.init(projectId);
        if (!stillOwnsSwitch()) {
          return false;
        }
      }

      const listResponse =
        webCoreProject === undefined
          ? await window.api.workEntries.list({ projectId })
          : webCoreWorkEntries(projectId);
      // Guard against a competing switch that started while the IPCs above
      // were in flight — the newer switch owns the state.
      if (!stillOwnsSwitch()) {
        return false;
      }
      let entries = listResponse.entries;
      let entryId =
        entries.find((entry) => entry.id === preferredEntryId)?.id ??
        // A cloud task opened as it is created can precede its listing.
        (webCoreProject === undefined ? undefined : preferredEntryId) ??
        entries[0]?.id ??
        null;
      if (entryId === null) {
        // A cloud task is created from its project's sidebar row, never as a
        // side effect of opening the project.
        refuseWebCoreProject(projectId, 'Opening an empty project');
        const created = await window.api.workEntries.create({ projectId });
        if (!stillOwnsSwitch()) {
          return false;
        }
        entries = [created.entry];
        entryId = created.entry.id;
      }
      syncCoworkWorkEntryCount(projectId, entries.length);

      const chatStore = useChatStore.getState();
      chatStore.setWorktreeDefaultPlugins(
        projectId,
        entryId,
        defaultPluginSelections,
      );
      if (options?.attentionLanding === true) {
        chatStore.selectWorktree(projectId, entryId, {
          attentionLanding: true,
        });
      } else {
        chatStore.selectWorktree(projectId, entryId);
      }
      await chatStore.loadTabs();
      await chatStore.syncActiveEmptyTabToDefaults();
      if (!stillOwnsSwitch()) {
        return false;
      }

      set({
        workEntries: entries,
        activeWorkEntryId: entryId,
        archiveOverlayChatId: null,
        activeSummary: null,
        activeArchiveData: null,
        initialized: true,
      });
      // Persist the unified MRU context so startup routing can restore this
      // cowork workspace + entry. `chatStore.selectWorktree` above already
      // writes the same context when it can navigate to the sidebar entry,
      // but that call can no-op for a workspace that isn't in the sidebar
      // list yet (e.g. immediately after creation), so write it explicitly
      // here.
      if (persistsCoworkSelection(get().scopedWorkspaceId, projectId)) {
        void window.api.savePreferences({
          lastActiveContext: {
            kind: 'cowork',
            workspaceId: projectId,
            workEntryId: entryId,
          },
        });
      }
      return true;
    },

    createChatProject: async (name: string): Promise<ChatProjectData> => {
      const response = await window.api.chatProject.create({ name });
      set((state) => ({
        chatProjects: sortChatProjects([
          ...state.chatProjects,
          response.project,
        ]),
        chatProjectsLoaded: true,
      }));
      return response.project;
    },

    createChatProjectFromBlueprint: async (
      blueprint: DesktopBlueprintCatalogEntry,
      name: string,
    ): Promise<CreateChatProjectFromTemplateResponse> => {
      const response = await window.api.chatProject.createFromTemplate({
        template: blueprint.document,
        sourceTemplate: {
          externalId: blueprint.externalId,
          contentHash: blueprint.contentHash,
        },
        curated: true,
        name,
      });
      set((state) => ({
        chatProjects: sortChatProjects([
          ...state.chatProjects,
          response.project,
        ]),
        chatProjectsLoaded: true,
      }));
      return response;
    },

    createChatProjectFromSharedTemplate: async (
      template,
      name,
    ): Promise<CreateChatProjectFromTemplateResponse> => {
      const response = await window.api.chatProject.createFromTemplate({
        seed: 'shared',
        sourceTemplate: {
          externalId: template.externalId,
          contentHash: template.pinnedContentHash,
        },
        name,
      });
      set((state) => ({
        chatProjects: sortChatProjects([
          ...state.chatProjects,
          response.project,
        ]),
        chatProjectsLoaded: true,
      }));
      return response;
    },

    createOrgCoworkProject: async (
      request: CreateOrgCoworkProjectRequest,
    ): Promise<CreateOrgCoworkProjectResult> => {
      const result = await window.api.chatProject.createOrgCowork(request);
      if (result.ok) {
        await get()
          .loadChatProjects()
          .catch((): undefined => undefined);
      }
      return result;
    },

    updateChatProject: async (req: UpdateChatProjectRequest): Promise<void> => {
      const previousProject = get().chatProjects.find(
        (project) => project.id === req.projectId,
      );
      if (!previousProject) {
        throw new Error('Chat project not found');
      }

      await window.api.chatProject.update(req);
      if (get().scopedWorkspaceId === null) {
        await useProjectsStore.getState().loadProjects({ silent: true });
      }

      const nextProjects = sortChatProjects(
        get().chatProjects.map((project) =>
          project.id === req.projectId
            ? {
                ...withStartPagePatch(project, req.startPage),
                ...(req.name !== undefined ? { name: req.name.trim() } : {}),
                ...(req.defaultPluginSelections !== undefined
                  ? { defaultPluginSelections: req.defaultPluginSelections }
                  : {}),
                ...(req.color !== undefined ? { color: req.color } : {}),
                ...(req.description !== undefined
                  ? { description: req.description }
                  : {}),
                ...(req.defaultModel !== undefined
                  ? { defaultModel: req.defaultModel }
                  : {}),
                ...(req.defaultPresetId !== undefined
                  ? { defaultPresetId: req.defaultPresetId }
                  : {}),
                ...(req.presets !== undefined ? { presets: req.presets } : {}),
                ...(req.archiveRetentionDays !== undefined
                  ? { archiveRetentionDays: req.archiveRetentionDays }
                  : {}),
                ...(req.autoArchiveDays !== undefined
                  ? { autoArchiveDays: req.autoArchiveDays }
                  : {}),
                ...(req.alwaysShow !== undefined
                  ? { alwaysShow: req.alwaysShow }
                  : {}),
              }
            : project,
        ),
      );

      set({ chatProjects: nextProjects });

      if (get().activeChatProjectId !== req.projectId) return;

      const activeEntryId = get().activeWorkEntryId;
      if (activeEntryId === null) return;

      const nextProject = nextProjects.find(
        (project) => project.id === req.projectId,
      );
      const chatStore = useChatStore.getState();
      chatStore.setWorktreeDefaultPlugins(
        req.projectId,
        activeEntryId,
        nextProject?.defaultPluginSelections,
      );

      if (req.defaultPluginSelections === undefined) return;

      // Cowork chats inherit the project defaults set above live; only
      // their discovery has to catch up.
      if (chatSurfaceUsesGlobalPluginDefaults(req.projectId)) {
        chatStore.queueWorktreeTabDiscoveryRefresh(
          req.projectId,
          activeEntryId,
        );
        return;
      }

      const selected = chatStore.selectedWorktree;
      if (
        selected?.projectId !== req.projectId ||
        selected.worktreeId !== activeEntryId
      ) {
        return;
      }

      const wc =
        chatStore.worktreeChats[workEntryKey(req.projectId, activeEntryId)];
      if (!wc) return;

      const activeTab = wc.tabs.find((tab) => tab.id === wc.activeTabId);
      if (!activeTab || activeTab.messages.length > 0) return;

      const previousSelections =
        previousProject.defaultPluginSelections ?? EMPTY_SELECTIONS;
      const activeSelections = activeTab.pluginSelections ?? EMPTY_SELECTIONS;
      if (
        normalizeSelections(activeSelections) ===
        normalizeSelections(previousSelections)
      ) {
        chatStore.setPluginSelections(req.defaultPluginSelections);
      }
    },

    deleteChatProject: async (projectId: string): Promise<void> => {
      refuseWebCoreProject(projectId, 'Deleting a project here');
      const chatStore = useChatStore.getState();

      // Best-effort per-entry cleanup across every entry known to the
      // renderer (live list when active, sidebar snapshot otherwise). The
      // main-side delete removes workspaces/{id}/ (including all entry
      // data) regardless.
      const entries = getSidebarProjectEntries(get(), projectId);
      for (const entry of entries) {
        await chatStore.flushWorktreeTabs(projectId, entry.id);
      }

      await window.api.chatProject.delete({
        projectId,
        chatDisposition: 'delete',
      });
      if (get().scopedWorkspaceId === null) {
        await useProjectsStore.getState().loadProjects({ silent: true });
      }

      for (const entry of entries) {
        chatStore.cleanupWorktree(projectId, entry.id);
        // Drop the in-memory panel-grid layout for the deleted entry so a
        // future workspace reusing the key never resurrects a stale grid
        // (the persisted panel-layout.json is removed with workspaces/{id}/
        // by the main-side delete).
        usePanelLayoutStore
          .getState()
          .disposeLayout(workEntryKey(projectId, entry.id));
        releasePipelinePanelUiForOwner(workEntryKey(projectId, entry.id));
      }

      set((state) => {
        const nextSidebarEntries = { ...state.sidebarEntriesByProject };
        delete nextSidebarEntries[projectId];
        const nextLegacyArchived = { ...state.legacyArchivedByProject };
        delete nextLegacyArchived[projectId];
        return {
          chatProjects: state.chatProjects.filter(
            (project) => project.id !== projectId,
          ),
          sidebarEntriesByProject: nextSidebarEntries,
          legacyArchivedByProject: nextLegacyArchived,
        };
      });

      if (get().activeChatProjectId === projectId) {
        const contextDefaultId = currentDefaultCoworkWorkspaceId();
        const organizationId =
          organizationIdFromDefaultWorkspaceId(contextDefaultId);
        if (organizationId) {
          await window.api.chatProject.ensureOrgDefaultCoworkWorkspace(
            organizationId,
          );
        }
        await get().switchChatProject(contextDefaultId);
      }
    },

    selectWorkEntry: async (
      entryId: string,
      requestedDestinationId?: number,
      options?: { attentionLanding?: boolean },
    ): Promise<boolean> => {
      const destinationRequestId =
        requestedDestinationId ?? ++coworkDestinationRequestId;
      const workspaceId = get().activeChatProjectId;
      const chatStore = useChatStore.getState();
      const selected = chatStore.selectedWorktree;
      const previousActiveEntryId = get().activeWorkEntryId;
      const stableSelection =
        previousActiveEntryId === null
          ? null
          : { projectId: workspaceId, worktreeId: previousActiveEntryId };

      const restoreSupersededSelection = (): void => {
        if (coworkTransientSelectionRequestId !== destinationRequestId) {
          return;
        }
        coworkTransientSelectionRequestId = null;
        if (get().activeWorkEntryId === entryId) {
          return;
        }
        const currentSelection = useChatStore.getState().selectedWorktree;
        if (
          currentSelection?.projectId !== workspaceId ||
          currentSelection.worktreeId !== entryId
        ) {
          return;
        }

        useChatStore.setState({ selectedWorktree: stableSelection });
        if (persistsCoworkSelection(get().scopedWorkspaceId, workspaceId)) {
          void window.api.savePreferences({
            lastSelectedWorktreeProjectId: stableSelection?.projectId ?? '',
            lastSelectedWorktreeId: stableSelection?.worktreeId ?? '',
            lastActiveContext:
              stableSelection?.projectId === workspaceId
                ? {
                    kind: 'cowork',
                    workspaceId,
                    workEntryId: stableSelection.worktreeId,
                  }
                : null,
          });
        }
      };

      if (
        get().activeWorkEntryId === entryId &&
        selected?.projectId === workspaceId &&
        selected.worktreeId === entryId
      ) {
        // Already selected — just make sure the overlay is closed.
        if (get().archiveOverlayChatId !== null) {
          set({
            archiveOverlayChatId: null,
            activeSummary: null,
            activeArchiveData: null,
          });
        }
        return true;
      }

      const project = get().chatProjects.find((p) => p.id === workspaceId);
      chatStore.setWorktreeDefaultPlugins(
        workspaceId,
        entryId,
        project?.defaultPluginSelections,
      );
      coworkTransientSelectionRequestId = destinationRequestId;
      chatStore.selectWorktree(workspaceId, entryId, {
        deferTabLoad: true,
        ...(options?.attentionLanding === true
          ? { attentionLanding: true }
          : {}),
      });
      await chatStore.loadTabs();
      const selectionAfterLoad = useChatStore.getState().selectedWorktree;
      if (
        coworkDestinationRequestId !== destinationRequestId ||
        get().activeChatProjectId !== workspaceId ||
        selectionAfterLoad?.projectId !== workspaceId ||
        selectionAfterLoad.worktreeId !== entryId
      ) {
        restoreSupersededSelection();
        return false;
      }
      await chatStore.syncActiveEmptyTabToDefaults();

      const selectionAfterDefaults = useChatStore.getState().selectedWorktree;
      if (
        coworkDestinationRequestId !== destinationRequestId ||
        get().activeChatProjectId !== workspaceId ||
        selectionAfterDefaults?.projectId !== workspaceId ||
        selectionAfterDefaults.worktreeId !== entryId
      ) {
        restoreSupersededSelection();
        return false;
      }

      set({
        activeWorkEntryId: entryId,
        archiveOverlayChatId: null,
        activeSummary: null,
        activeArchiveData: null,
      });
      if (coworkTransientSelectionRequestId === destinationRequestId) {
        coworkTransientSelectionRequestId = null;
      }
      // `selectWorktree` above persists the same MRU context, but can no-op
      // for workspaces missing from the sidebar list (see switchChatProject),
      // so persist explicitly. NEVER in scoped mode: the App Advisor popout
      // must not overwrite the main window's MRU startup target.
      if (persistsCoworkSelection(get().scopedWorkspaceId, workspaceId)) {
        void window.api.savePreferences({
          lastActiveContext: {
            kind: 'cowork',
            workspaceId,
            workEntryId: entryId,
          },
        });
      }
      return true;
    },

    createWorkEntry: async (options = {}): Promise<void> => {
      const workspaceId = get().activeChatProjectId;
      refuseWebCoreProject(workspaceId, 'Creating a task here');
      // Own a destination generation for the whole create, on the counter
      // every other Cowork destination uses, and snapshot the chat selection
      // too: Code worktree clicks go through chatStore and never touch that
      // counter. If the user chose anything else while the IPC was in flight,
      // that choice wins and this create stops short of selecting — it only
      // ever drops a stale result, never overwrites a newer one.
      const destinationRequestId = ++coworkDestinationRequestId;
      const selectionAtRequest = useChatStore.getState().selectedWorktree;
      // Only a move to a different project counts as a newer choice on the
      // chat selection: that is a Code worktree click. navigate('chat')
      // remounting StandaloneChatPage puts this workspace's retained entry
      // back into the selection, and that is setup, not the user choosing.
      // Cowork entry clicks and project switches are caught by the counter
      // and the project check below.
      const movedToAnotherProject = (): boolean => {
        const selection = useChatStore.getState().selectedWorktree;
        const unchanged =
          selection?.projectId === selectionAtRequest?.projectId &&
          selection?.worktreeId === selectionAtRequest?.worktreeId;
        return (
          !unchanged &&
          selection !== null &&
          selection.projectId !== workspaceId
        );
      };
      const stillOwnsDestination = (): boolean =>
        coworkDestinationRequestId === destinationRequestId &&
        get().activeChatProjectId === workspaceId &&
        !movedToAnotherProject();
      const { flushPanelLayoutSavesForProject } =
        await import('@/lib/panels/persistence-bridge');
      await flushPanelLayoutSavesForProject(workspaceId);
      const response = await window.api.workEntries.create({
        projectId: workspaceId,
        ...options,
      });
      useSidebarItemGroupsStore
        .getState()
        .confirmCreatedItem(
          { workspaceLocalId: workspaceId },
          options.sidebarItemGroupId ?? null,
          response.entry.id,
        );
      await get().refreshWorkEntries(workspaceId);
      if (!stillOwnsDestination()) return;
      await get().selectWorkEntry(response.entry.id, destinationRequestId);
    },

    renameWorkEntry: async (
      entryId: string,
      title: string | null,
      projectId?: string,
    ): Promise<void> => {
      const resolvedProjectId = projectId ?? get().activeChatProjectId;
      refuseWebCoreProject(resolvedProjectId, 'Renaming a task here');
      await window.api.workEntries.update({
        projectId: resolvedProjectId,
        entryId,
        title,
      });
      if (resolvedProjectId === get().activeChatProjectId) {
        await get().refreshWorkEntries(resolvedProjectId);
      } else {
        await get().loadSidebarProjectEntries(resolvedProjectId);
      }
    },

    setWorkEntryStatus: async (
      entryId: string,
      status: 'active' | 'done',
      projectId?: string,
    ): Promise<void> => {
      const resolvedProjectId = projectId ?? get().activeChatProjectId;
      refuseWebCoreProject(resolvedProjectId, 'Marking a task done here');
      await window.api.workEntries.update({
        projectId: resolvedProjectId,
        entryId,
        status,
      });
      if (resolvedProjectId === get().activeChatProjectId) {
        await get().refreshWorkEntries(resolvedProjectId);
      } else {
        await get().loadSidebarProjectEntries(resolvedProjectId);
      }
    },

    setWorkEntryPinned: async (
      entryId: string,
      pinned: boolean,
      projectId?: string,
    ): Promise<void> => {
      const resolvedProjectId = projectId ?? get().activeChatProjectId;
      refuseWebCoreProject(resolvedProjectId, 'Pinning a task');
      await window.api.workEntries.update({
        projectId: resolvedProjectId,
        entryId,
        pinned,
      });
      if (resolvedProjectId === get().activeChatProjectId) {
        await get().refreshWorkEntries(resolvedProjectId);
      } else {
        await get().loadSidebarProjectEntries(resolvedProjectId);
      }
    },

    reorderWorkEntries: async (
      projectId: string,
      activeEntryId: string,
      overEntryId: string,
    ): Promise<void> => {
      refuseWebCoreProject(projectId, 'Reordering tasks here');
      const previous = getSidebarProjectEntries(get(), projectId);
      const fromIndex = previous.findIndex(
        (entry) => entry.id === activeEntryId,
      );
      const toIndex = previous.findIndex((entry) => entry.id === overEntryId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

      const next = [...previous];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      const isActiveProject = projectId === get().activeChatProjectId;
      set((state) =>
        isActiveProject
          ? { workEntries: next }
          : {
              sidebarEntriesByProject: {
                ...state.sidebarEntriesByProject,
                [projectId]: next,
              },
            },
      );

      try {
        await window.api.workEntries.reorder({
          projectId,
          entryIds: next.map((entry) => entry.id),
        });
      } catch (error) {
        set((state) =>
          isActiveProject
            ? { workEntries: previous }
            : {
                sidebarEntriesByProject: {
                  ...state.sidebarEntriesByProject,
                  [projectId]: previous,
                },
              },
        );
        throw error;
      }
    },

    deleteWorkEntry: async (
      entryId: string,
      projectId?: string,
      options?: { lockAfterArchive?: boolean },
    ): Promise<void> => {
      const resolvedProjectId = projectId ?? get().activeChatProjectId;
      refuseWebCoreProject(resolvedProjectId, 'Deleting a task here');
      const chatStore = useChatStore.getState();

      // Announce the removal to the "Archived and deleted" surfaces right
      // away: capturing the retained container can take a while, and the
      // entry leaves the sidebar long before main commits it.
      const archivedContainersStore = useArchivedContainersStore.getState();
      archivedContainersStore.registerPendingContainer({
        workspaceId: resolvedProjectId,
        containerId: entryId,
        kind: 'work-entry',
        name:
          getSidebarProjectEntries(get(), resolvedProjectId).find(
            (entry) => entry.id === entryId,
          )?.title ?? entryId,
        state: options?.lockAfterArchive === true ? 'archived' : 'deleted',
      });
      let persistenceSuppressed = false;
      try {
        await awaitPendingRemovalHoldForE2e();
        await chatStore.flushWorktreeTabs(resolvedProjectId, entryId);
        chatStore.suppressWorktreePersistence(resolvedProjectId, entryId);
        persistenceSuppressed = true;
        const deletion = await window.api.workEntries.delete({
          projectId: resolvedProjectId,
          entryId,
          ...(options?.lockAfterArchive === true
            ? { lockAfterArchive: true }
            : {}),
        });
        if (deletion?.browserCleanupPending) {
          await import('@/stores/githubStore')
            .then(({ useGitHubStore }) => {
              useGitHubStore
                .getState()
                .addToast(
                  'Browser profile retired; physical storage cleanup is pending.',
                  'info',
                  undefined,
                  {
                    category: 'Account',
                    title: 'Browser cleanup',
                    projectId: resolvedProjectId,
                    worktreeId: entryId,
                    forceInApp: true,
                    persistent: true,
                  },
                );
            })
            .catch(() => undefined);
        }
      } catch (error) {
        if (persistenceSuppressed) {
          chatStore.resumeWorktreePersistence(resolvedProjectId, entryId);
        }
        archivedContainersStore.clearPendingContainer(
          resolvedProjectId,
          entryId,
        );
        throw error;
      }
      await archivedContainersStore.loadForWorkspace(resolvedProjectId, {
        trailing: true,
      });
      await get().reconcileArchivedWorkEntry(resolvedProjectId, entryId);
    },

    reconcileArchivedWorkEntry: async (
      resolvedProjectId,
      entryId,
    ): Promise<void> => {
      const chatStore = useChatStore.getState();
      chatStore.suppressWorktreePersistence(resolvedProjectId, entryId);
      chatStore.cleanupWorktree(resolvedProjectId, entryId);
      usePanelLayoutStore
        .getState()
        .disposeLayout(workEntryKey(resolvedProjectId, entryId));
      releasePipelinePanelUiForOwner(workEntryKey(resolvedProjectId, entryId));

      if (resolvedProjectId !== get().activeChatProjectId) {
        await get().loadSidebarProjectEntries(resolvedProjectId);
        set((state) => ({
          sidebarEntriesByProject: {
            ...state.sidebarEntriesByProject,
            [resolvedProjectId]: (
              state.sidebarEntriesByProject[resolvedProjectId] ?? []
            ).filter((entry) => entry.id !== entryId),
          },
        }));
        return;
      }

      set((state) => ({
        workEntries: state.workEntries.filter((entry) => entry.id !== entryId),
      }));
      await get().refreshWorkEntries(resolvedProjectId);
      // Treat the successful completion event as authoritative if a cached
      // refresh briefly returns the pre-delete entry list.
      set((state) => ({
        workEntries: state.workEntries.filter((entry) => entry.id !== entryId),
      }));
      await get().leaveRemovedWorkEntry(resolvedProjectId, entryId);
    },

    leaveRemovedWorkEntry: async (projectId, entryId): Promise<void> => {
      if (
        projectId !== get().activeChatProjectId ||
        get().activeWorkEntryId !== entryId
      )
        return;
      set({ activeWorkEntryId: null });
      const chatStore = useChatStore.getState();
      const selected = chatStore.selectedWorktree;
      if (selected?.projectId === projectId && selected.worktreeId === entryId)
        chatStore.deselectWorktree();
      // The entry may still be listed while its removal runs.
      const next = get().workEntries.find((entry) => entry.id !== entryId);
      if (next) {
        await get().selectWorkEntry(next.id);
      } else {
        await get().createWorkEntry();
      }
    },

    startNewChat: async (): Promise<void> => {
      const activeProjectId = get().activeChatProjectId;
      const chatStore = useChatStore.getState();

      await chatStore.ensureModelDefaultsLoaded();

      const entryId = get().activeWorkEntryId;
      if (entryId === null) {
        // No entry selected yet — creating one yields a fresh empty tab,
        // which IS the new chat.
        await get().createWorkEntry();
        return;
      }

      chatStore.selectWorktree(activeProjectId, entryId);

      const wc =
        useChatStore.getState().worktreeChats[
          workEntryKey(activeProjectId, entryId)
        ];
      const activeTab = wc?.tabs.find((tab) => tab.id === wc.activeTabId);
      if (
        activeTab &&
        activeTab.kind !== 'file' &&
        activeTab.messages.length === 0
      ) {
        // Reuse the entry's empty active tab instead of piling up blanks.
        await chatStore.syncActiveEmptyTabToDefaults();
        set({
          archiveOverlayChatId: null,
          activeSummary: null,
          activeArchiveData: null,
        });
        return;
      }

      const id = crypto.randomUUID();
      chatStore.createTabWithId(id);
      set({
        archiveOverlayChatId: null,
        activeSummary: null,
        activeArchiveData: null,
      });
    },

    dismissColdStart: (): void => {
      if (get().coldStartDismissed) return;
      set({ coldStartDismissed: true });
    },

    createStandaloneChatWithMessage: async ({
      recovery,
      chatProjectId,
      message,
      chatId: requestedChatId,
      initialMessageId,
      onChatCreated,
      config,
    }: {
      chatProjectId?: string;
      message: string;
      chatId?: string;
      initialMessageId?: string;
      onChatCreated?: (location: {
        projectId: string;
        worktreeId: string;
        chatId: string;
      }) => void;
      config?: {
        model?: ChatModel;
        planMode?: boolean;
        modelExplicitlyChosen?: boolean;
        modelSelectionMode?: 'auto';
        thinkingLevel?: ThinkingLevel;
        speed?: CodexSpeed;
        fastMode?: boolean;
        attachments?: AttachmentMeta[];
        scheduledSendDraft?: { runAt: string };
        pluginSelections?: ChatTabPluginSelections;
        disabledGlobalPluginSelections?: PluginSelectionTombstones;
        fileReferences?: FileReference[];
        attachmentPaths?: string[];
        attachmentPromptContexts?: ChatAttachmentPromptContext[];
        approvalMode?: ApprovalMode;
      };
      recovery?: StandaloneChatRecovery;
    }): Promise<string> => {
      const resolvedChatProjectId =
        chatProjectId ?? currentDefaultCoworkWorkspaceId();
      await get().initialize();

      // Fail closed: a project-less chat in an organization scope belongs to
      // that organization's Chats workspace and never falls back to Personal.
      if (isOrgDefaultCoworkWorkspaceId(resolvedChatProjectId)) {
        const organizationId = await requireOrgDefaultChatsEligibility(
          resolvedChatProjectId,
        );
        if (
          !get().chatProjects.some(
            (project) => project.id === resolvedChatProjectId,
          )
        ) {
          if (
            organizationId &&
            typeof window.api.chatProject.ensureOrgDefaultCoworkWorkspace ===
              'function'
          ) {
            try {
              await window.api.chatProject.ensureOrgDefaultCoworkWorkspace(
                organizationId,
              );
            } catch (error) {
              throw new OrgDefaultChatsUnavailableError(resolvedChatProjectId, {
                cause: error,
              });
            }
          }
          await get().loadChatProjects();
        }
        if (
          !get().chatProjects.some(
            (project) => project.id === resolvedChatProjectId,
          )
        ) {
          throw new OrgDefaultChatsUnavailableError(resolvedChatProjectId);
        }
      }

      if (get().activeChatProjectId !== resolvedChatProjectId) {
        const switched = await get().switchChatProject(resolvedChatProjectId);
        if (!switched) {
          throw new Error('Cowork project switch was superseded');
        }
      }

      const previousEntryId = get().activeWorkEntryId;

      // A Home send to cowork opens a fresh work area (reusing an existing
      // empty entry is fine — the main-side create dedupes empties).
      const createResponse = await window.api.workEntries.create({
        projectId: resolvedChatProjectId,
      });
      const entryId = createResponse.entry.id;
      markStartPageSuppressed(`${resolvedChatProjectId}/${entryId}`);
      await get().refreshWorkEntries(resolvedChatProjectId);
      await get().selectWorkEntry(entryId);

      const chatStore = useChatStore.getState();
      const chatId = requestedChatId ?? crypto.randomUUID();
      // Journal the entry before canonical tab creation can reach main.
      onChatCreated?.({
        projectId: resolvedChatProjectId,
        worktreeId: entryId,
        chatId,
      });
      chatStore.createTab({
        projectId: resolvedChatProjectId,
        worktreeId: entryId,
        id: chatId,
        // Entry reuse and tab replacement are separate decisions: a reused
        // empty entry still holds its starter tab. The chat store replaces it
        // only when pristine, so a saved draft or staged context stays.
        replaceActiveEmpty: true,
        model: config?.model,
        planMode: config?.planMode,
        modelExplicitlyChosen: config?.modelExplicitlyChosen === true,
        thinkingLevel: config?.thinkingLevel,
        pluginSelections: config?.pluginSelections,
      });

      const target = {
        projectId: resolvedChatProjectId,
        worktreeId: entryId,
        chatId,
      };

      const firstUserMessageId = initialMessageId ?? crypto.randomUUID();
      recovery?.onCreated(target);
      try {
        // Join canonical creation before settings target the optimistic tab id.
        await chatStore.ensureWorktreeHasChatTab({
          projectId: resolvedChatProjectId,
          worktreeId: entryId,
        });
        if (config?.modelSelectionMode === 'auto') {
          await useChatStore.getState().setModelSelectionMode('auto', target);
        }
        // An exact staged speed wins; a legacy boolean still routes through
        // the boolean adapter (true → Fast, false → Regular).
        if (config?.speed !== undefined) {
          await useChatStore.getState().setSpeed(config.speed, target);
        } else if (config?.fastMode !== undefined) {
          await useChatStore.getState().setFastMode(config.fastMode, target);
        }

        if (config?.approvalMode) {
          // Explicit-only pinning, mirroring the worktree routes: an untouched
          // draft leaves the tab unset so the normal resolution chain applies.
          await chatStore.setTabApprovalMode(target, config.approvalMode);
        }

        const disabledDefaults = config?.disabledGlobalPluginSelections;
        if (disabledDefaults && hasAnyTombstones(disabledDefaults)) {
          await applyNewChatPluginSelections(useChatStore.getState, target, {
            pluginSelections:
              config?.pluginSelections ?? emptyPluginSelections(),
            disabledGlobalPluginSelections: disabledDefaults,
          });
        }

        // Home already imported these files into this cowork project's shared
        // attachment directory. Re-importing would duplicate and rename them.
        const attachments =
          config?.attachments ??
          attachmentMetasFromPaths(
            config?.attachmentPaths,
            config?.attachmentPromptContexts,
          ) ??
          [];
        if (message.trim().length > 0) {
          let initialTurnAccepted = false;
          await useChatStore
            .getState()
            .sendMessage(message, config?.fileReferences, target, undefined, {
              // Home must hear an authoritative refusal after its preflight;
              // otherwise it consumes the draft as if this send succeeded.
              throwOnDispatchFailure: true,
              userMessageId: recovery?.userMessageId ?? firstUserMessageId,
              ...(initialMessageId || recovery
                ? {
                    userMessageId: initialMessageId ?? recovery?.userMessageId,
                    throwOnDispatchFailure: true,
                    onDispatchAccepted: (): void => {
                      initialTurnAccepted = true;
                      recovery?.onSubmitted();
                    },
                  }
                : {}),
              attachmentPaths:
                attachments.length > 0
                  ? attachments.map((attachment) => attachment.absolutePath)
                  : undefined,
              attachmentPromptContexts:
                buildAttachmentPromptContexts(attachments),
            });
          if (recovery && !initialTurnAccepted)
            throw new Error('The repair message was not accepted.');
          if (initialMessageId && !initialTurnAccepted)
            throw new Error('The initial message has not been acknowledged');
        } else {
          useChatStore.getState().addPendingAttachments(attachments, target);
          if (config?.scheduledSendDraft) {
            await useChatStore
              .getState()
              .setScheduledSendDraft(config.scheduledSendDraft, target);
          }
          await useChatStore
            .getState()
            .flushWorktreeTabs(resolvedChatProjectId, entryId);
        }
      } catch (error: unknown) {
        if (initialMessageId || recovery) throw error;
        const missingFolder = resolveCoworkFolderMissing(
          error,
          resolvedChatProjectId,
        );
        if (missingFolder) {
          try {
            await window.api.chatProject.rollbackUnstartedSend({
              workspaceId: resolvedChatProjectId,
              worktreeId: entryId,
              chatId,
              userMessageId: firstUserMessageId,
              ...(!createResponse.reusedExistingEmpty
                ? { entryCreatedAt: createResponse.entry.createdAt }
                : {}),
            });
            // The canonical removal delta updates the tab projection. Refresh
            // entry membership without invoking deletion (which archives every
            // sibling and can create a replacement empty entry).
            await get().refreshWorkEntries(resolvedChatProjectId);
          } catch (cleanupError) {
            const failure = Object.assign(
              new Error(
                `${missingFolder.message} Couldn't remove the empty chat.`,
              ),
              {
                code: missingFolder.code,
                workspaceId: missingFolder.workspaceId,
                folderName: missingFolder.folderName,
              },
            );
            Object.defineProperty(failure, 'cause', { value: cleanupError });
            throw failure;
          }
          throw error;
        }
        // Roll back the created chat tab (and the entry, when it was freshly
        // created for this send) so a failed send does not leave a stale
        // empty work area behind.
        useChatStore.getState().closeTab(chatId, {
          projectId: resolvedChatProjectId,
          worktreeId: entryId,
          force: true,
        });
        if (!createResponse.reusedExistingEmpty) {
          try {
            await get().deleteWorkEntry(entryId, resolvedChatProjectId);
          } catch {
            // Best-effort rollback; the empty entry is reusable either way.
          }
        }
        if (
          previousEntryId !== null &&
          get().activeChatProjectId === resolvedChatProjectId &&
          get().workEntries.some((entry) => entry.id === previousEntryId)
        ) {
          await get().selectWorkEntry(previousEntryId);
        }
        throw error;
      }

      // An explicitly created empty entry should open its chat even on a
      // first-use workspace, where no message activity dismisses the CTA.
      get().dismissColdStart();
      await get().refreshWorkEntries(resolvedChatProjectId);
      return chatId;
    },

    createWorkEntryChatWithMessage: async ({
      chatId,
      entryId: precreatedEntryId,
      removeEntryOnFailure,
      replaceActiveEmpty: requestedReplaceActiveEmpty,
      message,
      title,
      config,
      sendOptions,
    }): Promise<string> => {
      const projectId = get().activeChatProjectId;
      const previousEntryId = get().activeWorkEntryId;

      let entryId: string;
      let shouldRemoveEntryOnFailure = removeEntryOnFailure === true;
      let replaceActiveEmpty = requestedReplaceActiveEmpty === true;
      if (precreatedEntryId !== undefined) {
        entryId = precreatedEntryId;
      } else {
        const createResponse = await window.api.workEntries.create({
          projectId,
        });
        entryId = createResponse.entry.id;
        shouldRemoveEntryOnFailure = !createResponse.reusedExistingEmpty;
        // Reuse governs entry ownership, not the starter tab; the chat store
        // keeps that tab when it holds a draft or staged context.
        replaceActiveEmpty = true;
      }
      markStartPageSuppressed(`${projectId}/${entryId}`);
      await get().refreshWorkEntries(projectId);
      if (!get().workEntries.some((entry) => entry.id === entryId)) {
        throw new Error(`Unknown pre-created work entry ${entryId}`);
      }
      await get().selectWorkEntry(entryId);

      const chatStore = useChatStore.getState();
      const resolvedChatId = chatId ?? crypto.randomUUID();
      chatStore.createTab({
        projectId,
        worktreeId: entryId,
        // Preserve the caller-assigned chat id (quick-prompt commands assign
        // it main-side before this renderer ever sees the prompt).
        id: resolvedChatId,
        ...(title !== undefined ? { title } : {}),
        // Self-created entries take over a pristine starter tab; targeted
        // entries follow the caller's request.
        replaceActiveEmpty,
        model: config?.model,
        planMode: config?.planMode,
        // A quick-prompt config only carries a model when the command named
        // one, so its presence really is a deliberate choice here.
        modelExplicitlyChosen: config?.model !== undefined,
        thinkingLevel: config?.thinkingLevel,
        modelConfig: config?.modelConfig,
        pluginSelections: config?.pluginSelections,
        ...(config?.approvalMode ? { approvalMode: config.approvalMode } : {}),
        ...(config?.interfaceMode
          ? { interfaceMode: config.interfaceMode }
          : {}),
      });

      const target = {
        projectId,
        worktreeId: entryId,
        chatId: resolvedChatId,
      };

      try {
        await useChatStore
          .getState()
          .sendMessage(message, config?.fileReferences, target, undefined, {
            attachmentPaths: config?.attachmentPaths,
            attachmentPromptContexts: config?.attachmentPromptContexts,
            ...(sendOptions?.initiationSource
              ? { initiationSource: sendOptions.initiationSource }
              : {}),
            ...(sendOptions?.automationName
              ? { automationName: sendOptions.automationName }
              : {}),
            ...(sendOptions?.userMessageId
              ? { userMessageId: sendOptions.userMessageId }
              : {}),
            ...(sendOptions?.planMode !== undefined
              ? { planMode: sendOptions.planMode }
              : {}),
            ...(sendOptions?.packageOverlay
              ? { packageOverlay: sendOptions.packageOverlay }
              : {}),
            throwOnDispatchFailure: true,
          });
      } catch (error: unknown) {
        // Roll back the created chat tab (and the entry, when it was freshly
        // created for this send) so a failed send leaves no stale work area.
        useChatStore.getState().closeTab(resolvedChatId, {
          projectId,
          worktreeId: entryId,
          force: true,
        });
        if (shouldRemoveEntryOnFailure) {
          try {
            await get().deleteWorkEntry(entryId, projectId);
          } catch {
            // Best-effort rollback; the empty entry is reusable either way.
          }
        }
        if (
          previousEntryId !== null &&
          get().activeChatProjectId === projectId &&
          get().workEntries.some((entry) => entry.id === previousEntryId)
        ) {
          await get().selectWorkEntry(previousEntryId);
        }
        throw error;
      }

      await get().refreshWorkEntries(projectId);
      return resolvedChatId;
    },

    selectChat: async (chatId: string): Promise<boolean> => {
      const activeProjectId = get().activeChatProjectId;
      // main resolves only its own chats; a cloud chat opens from its task row.
      if (isWebCoreScope(activeProjectId)) return false;
      const destinationRequestId = ++coworkDestinationRequestId;
      const resolved = await window.api.workEntries.resolveChat({
        projectId: activeProjectId,
        chatId,
      });
      if (
        coworkDestinationRequestId !== destinationRequestId ||
        get().activeChatProjectId !== activeProjectId
      ) {
        return false;
      }
      if (resolved.entryId !== null) {
        const selected = await get().selectWorkEntry(
          resolved.entryId,
          destinationRequestId,
        );
        if (!selected) {
          return false;
        }
        useChatStore.getState().switchTab(chatId);
        const selectedChat =
          useChatStore.getState().worktreeChats[
            workEntryKey(activeProjectId, resolved.entryId)
          ];
        return (
          selectedChat?.activeTabId === chatId &&
          selectedChat.tabs.some((tab) => tab.id === chatId)
        );
      }
      if (resolved.archivedInEntryId !== null) {
        const selected = await get().selectWorkEntry(
          resolved.archivedInEntryId,
          destinationRequestId,
        );
        if (!selected) {
          return false;
        }
        const detail = {
          projectId: activeProjectId,
          worktreeId: resolved.archivedInEntryId,
          chatId,
        };
        requestAnimationFrame(() => {
          window.dispatchEvent(
            new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, {
              detail,
            }),
          );
        });
        return true;
      }

      // Pre-entry archives are not part of the Work Entry registry. Fall back
      // to the legacy workspace-level archive overlay for those chats.
      await get().selectArchivedChat(chatId);
      return (
        get().archiveOverlayChatId === chatId &&
        get().activeArchiveData !== null
      );
    },

    selectArchivedChat: async (chatId: string): Promise<void> => {
      refuseWebCoreProject(get().activeChatProjectId, 'Legacy archives');
      ++coworkDestinationRequestId;
      const activeProjectId = get().activeChatProjectId;

      set({
        archiveOverlayChatId: chatId,
        activeSummary: SUMMARY_LOADING,
        activeArchiveData: null,
      });
      try {
        const response = await window.api.standaloneChat.readArchive({
          chatId,
          projectId: activeProjectId,
        });
        if (get().archiveOverlayChatId === chatId) {
          set({
            activeSummary: response.summary,
            activeArchiveData: buildActiveArchiveData(response),
          });
        }
      } catch {
        if (get().archiveOverlayChatId === chatId) {
          set({
            archiveOverlayChatId: null,
            activeSummary: null,
            activeArchiveData: null,
          });
        }
      }
    },

    selectArchive: async (chatId: string): Promise<void> => {
      await get().selectArchivedChat(chatId);
    },

    closeArchiveOverlay: (): void => {
      if (get().archiveOverlayChatId === null) return;
      set({
        archiveOverlayChatId: null,
        activeSummary: null,
        activeArchiveData: null,
      });
    },

    resumeArchivedChat: async (chatId: string): Promise<void> => {
      const projectId = get().activeChatProjectId;
      refuseWebCoreProject(projectId, 'Resuming an archived chat');

      // Resume into a NEW work entry (reuse-empty is fine) so the recovered
      // conversation gets its own work area. Create it first: main installs
      // the resumed tab into that entry's canonical scope durably; the
      // renderer only mirrors the response for immediate display.
      const created = await window.api.workEntries.create({ projectId });
      const entryId = created.entry.id;
      const response = await window.api.standaloneChat.resumeArchive({
        projectId,
        chatId,
        mode: 'resume',
        destinationEntryId: entryId,
      });
      const resumedTab = hydratePersistedChatTab(response.tab);

      await get().selectWorkEntry(entryId);
      await useChatStore
        .getState()
        .insertClonedStandaloneTab(projectId, entryId, resumedTab, true, true);
      await get().refreshWorkEntries(projectId);

      set({
        archiveOverlayChatId: null,
        activeSummary: null,
        activeArchiveData: null,
      });
    },

    /* ── Sidebar multi-project implementations ── */

    loadSidebarProjectEntries: async (projectId: string): Promise<void> => {
      // The active project's list is derived from `workEntries`; never shadow
      // it with a stale sidebar copy.
      if (projectId === get().activeChatProjectId) {
        return;
      }
      // Cloud projects list their tasks in their own sidebar rows.
      if (isWebCoreScope(projectId)) return;
      const revision = workEntrySnapshotRevisions.get(projectId) ?? 0;
      const response = await window.api.workEntries.list({ projectId });
      if (revision !== (workEntrySnapshotRevisions.get(projectId) ?? 0)) {
        await get().refreshWorkEntries(
          projectId,
          () => get().activeChatProjectId !== projectId,
        );
        return;
      }
      // Guard against a project switch that happened while the IPC was in
      // flight: if this project became active, drop the result and let the
      // derived path own it.
      if (get().activeChatProjectId === projectId) {
        syncCoworkWorkEntryCount(projectId, response.entries.length);
        return;
      }
      get().applyWorkEntriesSnapshot(projectId, response.entries);
    },

    loadLegacyArchivedChats: async (projectId: string): Promise<void> => {
      // `standaloneChat.list` serves ONLY legacy archived chats now (the
      // live-chat mirror is gone); filter defensively anyway. A cloud project
      // has no legacy archive.
      const response = isWebCoreScope(projectId)
        ? { chats: [] }
        : await window.api.standaloneChat.list(projectId);
      const archived = response.chats.filter((chat) => chat.archived === true);
      set((state) => ({
        legacyArchivedByProject: {
          ...state.legacyArchivedByProject,
          [projectId]: archived,
        },
      }));
    },

    cancelPendingWorkEntryNavigation: (): void => {
      ++coworkDestinationRequestId;
      ++switchChatProjectRequestId;
    },

    clearActiveWorkEntry: (): void => {
      set({
        activeWorkEntryId: null,
        archiveOverlayChatId: null,
        activeSummary: null,
        activeArchiveData: null,
      });
    },

    openWorkEntryFromSidebar: async (
      projectId: string,
      entryId: string,
    ): Promise<void> => {
      const navigationRequestId = ++coworkDestinationRequestId;
      if (!get().initialized) {
        // Name the target so a cold init (racing the page mount's own
        // initialize call) selects this entry directly instead of the most
        // recent one.
        await get().initialize({ projectId, entryId, attentionLanding: true });
        // Cold initialization commits its own target before the request-id guards.
        // Release that target if cancellation or newer navigation superseded this open.
        if (coworkDestinationRequestId !== navigationRequestId) {
          if (
            get().activeChatProjectId === projectId &&
            get().activeWorkEntryId === entryId
          ) {
            get().clearActiveWorkEntry();
          }
          const selectedWorktree = useChatStore.getState().selectedWorktree;
          if (
            selectedWorktree?.projectId === projectId &&
            selectedWorktree.worktreeId === entryId
          ) {
            useChatStore.getState().deselectWorktree();
          }
          return;
        }
      }
      if (get().activeChatProjectId !== projectId) {
        const switched = await get().switchChatProject(projectId, entryId, {
          attentionLanding: true,
        });
        if (!switched) return;
      }
      const switchRequestId = switchChatProjectRequestId;
      // Archive restore creates the destination entry in the main process
      // before routing here. When the restored workspace is already active,
      // no project switch reloads its entries, so refresh a missing target
      // before selecting it. Otherwise the chat can open while the sidebar
      // still renders the stale empty list until a later filesystem event.
      if (!get().workEntries.some((entry) => entry.id === entryId)) {
        await get().refreshWorkEntries(
          projectId,
          () =>
            get().activeChatProjectId === projectId &&
            switchChatProjectRequestId === switchRequestId &&
            coworkDestinationRequestId === navigationRequestId,
        );
      }
      if (
        get().activeChatProjectId !== projectId ||
        switchChatProjectRequestId !== switchRequestId ||
        coworkDestinationRequestId !== navigationRequestId
      ) {
        return;
      }
      await get().selectWorkEntry(entryId, undefined, {
        attentionLanding: true,
      });
    },

    openArchivedChatFromSidebar: async (
      projectId: string,
      chatId: string,
    ): Promise<void> => {
      if (!get().initialized) {
        await get().initialize();
      }
      if (get().activeChatProjectId !== projectId) {
        const switched = await get().switchChatProject(projectId);
        if (!switched) return;
      }
      await get().selectArchive(chatId);
    },

    createWorkEntryInProject: async (
      projectId: string,
      options = {},
    ): Promise<void> => {
      const organizationId = organizationIdFromDefaultWorkspaceId(projectId);
      const missingOrgDefault =
        organizationId !== null &&
        !get().chatProjects.some((project) => project.id === projectId);
      if (missingOrgDefault && organizationId) {
        // Commit the deterministic destination before waiting so navigation
        // never renders Personal while the organization binding is pending.
        set({
          activeChatProjectId: projectId,
          activeWorkEntryId: null,
          workEntries: [],
          archiveOverlayChatId: null,
          activeSummary: null,
          activeArchiveData: null,
          orgDefaultChatsError: null,
        });
      }
      if (organizationId) {
        try {
          await requireOrgDefaultChatsEligibility(projectId);
          if (!missingOrgDefault) {
            // A published org default completed its cloud binding previously.
            // Eligibility is local and remains available offline.
            set({ orgDefaultChatsError: null });
          }
        } catch (error) {
          const unavailable =
            error instanceof OrgDefaultChatsUnavailableError
              ? error
              : new OrgDefaultChatsUnavailableError(projectId, {
                  cause: error,
                });
          set({
            orgDefaultChatsError: {
              projectId,
              message: unavailable.message,
            },
          });
          throw unavailable;
        }
      }
      if (missingOrgDefault && organizationId) {
        try {
          if (
            typeof window.api.chatProject.ensureOrgDefaultCoworkWorkspace !==
            'function'
          ) {
            throw new Error('Organization Chats provisioning is unavailable');
          }
          await window.api.chatProject.ensureOrgDefaultCoworkWorkspace(
            organizationId,
          );
          await get().loadChatProjects();
        } catch (error) {
          const unavailable = new OrgDefaultChatsUnavailableError(projectId, {
            cause: error,
          });
          set({
            orgDefaultChatsError: {
              projectId,
              message: unavailable.message,
            },
          });
          throw unavailable;
        }
      }
      if (!get().initialized) {
        await get().initialize();
      }
      if (get().activeChatProjectId !== projectId) {
        const switched = await get().switchChatProject(projectId);
        if (!switched) return;
      }
      await get().createWorkEntry(options);
      set({ orgDefaultChatsError: null });
    },

    activateCreatedCoworkWorkspace: async (
      projectId: string,
    ): Promise<boolean> => {
      if (!get().initialized) {
        await get().initialize();
      }

      if (get().activeChatProjectId !== projectId) {
        // `switchChatProject` re-lists `chatProjects` itself when the target is
        // missing, so no "refresh first" guard belongs here.
        const switched = await get().switchChatProject(projectId);
        if (!switched) return false;
      }
      // switchChatProject already persists lastActiveContext when it runs,
      // but it's skipped above when this workspace was already active, so
      // write it unconditionally to guarantee the newly created workspace
      // becomes the MRU startup target.
      const activeEntryId = get().activeWorkEntryId;
      if (get().scopedWorkspaceId === null) {
        void window.api.savePreferences({
          lastActiveContext: {
            kind: 'cowork',
            workspaceId: projectId,
            ...(activeEntryId !== null ? { workEntryId: activeEntryId } : {}),
          },
        });
      }

      await get().createWorkEntry();
      return true;
    },
  }),
);

useStandaloneChatStore.subscribe((state, previousState) => {
  if (state.archiveOverlayChatId !== previousState.archiveOverlayChatId) {
    setStandaloneChatArchiveOverlayOpen(state.archiveOverlayChatId !== null);
  }
});
