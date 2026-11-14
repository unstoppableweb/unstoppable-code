import {
  useCallback,
  useEffect,
  type DragEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  AdhocMultiRepoJoinOption,
  GitHubRepoSummary,
  NavigationMode,
  OrgMemberFolderInspection,
  OrgRepositoryOwnerLookup,
  OrgRepositoryOwnerRequest,
  RepoSelection,
  SidebarItem,
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/desktop-shared/types';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { CHAT_LABEL } from '@canopy/protocol';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import {
  RepositoryCloneError,
  Stack,
  Surface,
} from '@canopy/ui-shared/components';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { DesktopReportThisAction } from '@/components/shared/DesktopReportThisAction';
import { rendererAppErrorDisplayPolicy } from '@/lib/renderer-app-error';
import { brandText } from '@/lib/brand';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  trackAddProjectDialogCancel,
  trackAddProjectDialogOpen,
  trackAddProjectMethodClick,
} from '../../lib/addProjectTelemetry';
import {
  normalizeRepositoryCloneUrl,
  repositoryCloneErrorMessage,
  REPOSITORY_CLONE_FAILURE_MESSAGE,
} from '@canopy/protocol/portal';
import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  navigateAfterRepositoryWorkspaceCreated,
  openCreatedMultiRepoWorkspaceSettings,
} from '@/lib/postWorkspaceCreateNavigation';
import { offerCursorRulesReview } from '@/lib/cursorRulesOffer';
import { formatUnresolvedCapabilitiesNotice } from '@/lib/unresolvedCapabilities';
import { waitForCloneHandoff } from '@/lib/cloneHandoff';
import { useGitHubPermissions } from '@/hooks/useGitHubPermissions';
import { useNavigationMode } from '@/stores/navigationModeStore';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useBlueprintCatalog } from '@/hooks/useBlueprintCatalog';
import { BlueprintPicker } from './BlueprintPicker';
import { DialogModal, GitHubRepoPicker } from '../shared';
import {
  GitHubIcon,
  MultiRepoIcon,
  TemporaryMultiRepoIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  BuildingIcon,
  CloudBackendIcon,
  CoworkWorkspaceIcon,
  FolderIcon,
  FolderPlusIcon,
  SingleRepoWorkspaceIcon,
} from '@canopy/ui-shared/icons';
import { WorkspaceMultiSelectPicker } from './WorkspaceMultiSelectPicker';
import { AddOrgProjectCatalog } from './AddOrgProjectCatalog';
import { AddCloudProjectSetup } from './AddCloudProjectSetup';
import { useCanopyProjectIdentityAvailable } from '@/hooks/useCanopyCloudConnected';
import { useOrgCatalogSession } from './orgCatalogSession';
import {
  OrgRepositoryOwnerNotice,
  orgRepositoryOwnerSwitchFailure,
} from '@canopy/ui-app';
import {
  orgProjectCatalogOption,
  useOrgProjectCatalogWithheld,
} from '@canopy/ui-app/org-project-catalog';
import {
  OrgFolderOutcome,
  OrgProjectCreateErrorNotice,
  OrgProjectOwnershipNotice,
  type AddOrgProjectCreateError,
} from './AddOrgProjectNotices';
import {
  orgCreateFolderRefusalText,
  orgFolderNeedsConfirmation,
  resolveOrgCreateFolderKind,
  resolveOrgFolderProjectKind,
  type OrgCreateFolderCheck,
  type OrgCreateProjectKind,
} from '@/lib/orgCreateProject';
import { FormSectionHeading } from './FormSectionHeading';
import { MEMBER_ORG_PROJECT_LIMIT } from '@canopy/protocol/org-projects';
import { recordAutomationCreatedProject } from '@/stores/automationInstallContinuationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  Button,
  DialogFormField,
  Notice,
  NoticeButton,
  PrivateMemoryInlineToggle,
  ProjectChoiceCard,
  SegmentedControl,
  TextInput,
} from '@canopy/ui-shared';
import { saveWorkspacePrivateMemory } from '@/lib/privateMemory';
import { useOrgProjectsStore, useOrgProjectsStoreApi } from '@canopy/app-state';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { openOrgProject } from '@/lib/openOrgProjectDeepLink';
import {
  resolveOrgFolderConflict,
  type OrgFolderConflict,
} from '@/lib/orgProjectFolderConflict';
import {
  OrgFolderConflictNotice,
  type OrgFolderConflictShown,
} from './OrgFolderConflictNotice';

/** `catalog` is the organization's own option; Personal never offers it. */
type AddWorkspaceMode = 'catalog' | 'cloud' | 'existing' | 'remote' | 'create';
type CreateWorkspaceType =
  | 'single-repo'
  | 'multi-repo'
  | 'temporary'
  | 'cowork';
type RemoteSource = 'github' | 'url';
type RepoFetchState = 'idle' | 'loading' | 'loaded' | 'error';
/** The option that makes a member's organization project. */
type OrgCreateSource = 'existing' | 'remote' | 'create';

/**
 * Where the organization folder being checked came from: a pick, or a clone
 * (or reused clone) of the Remote option's URL into its destination.
 */
type OrgFolderOrigin =
  | { readonly source: 'existing' }
  | {
      readonly source: 'remote';
      readonly remoteUrl: string;
      readonly destinationDir: string;
    };

/** Preserve controlled recovery outcomes without exposing arbitrary Git diagnostics. */
function remoteWorkspaceFailureMessage(error: unknown): string {
  const message: unknown = error instanceof Error ? error.message : error;
  if (typeof message !== 'string') return repositoryCloneErrorMessage(message);
  const prefix = [
    `Error invoking remote method '${IPC_CHANNELS.workspaceAddFromRemote}': Error: `,
    `Error invoking remote method '${IPC_CHANNELS.workspaceAddFromRemote}': W5CommitRefusedError: `,
  ].find((candidate) => message.startsWith(candidate));
  return repositoryCloneErrorMessage(
    prefix ? message.slice(prefix.length) : message,
  );
}

/** The sentence a failure leads with, for surfaces that show only text. */
function failureMessage(failure: InlineFailure): string {
  return typeof failure.error === 'string'
    ? failure.error
    : failure.error.copy.title;
}

/**
 * A Remote add's failure. The clone path already rethrows safe clone copy
 * (`remoteWorkspaceFailureMessage`), which leads as it is; anything else
 * leads with the action's own sentence.
 */
function remoteAddFailure(appError: AppError): InlineFailure {
  const message = appError.detail.message;
  if (
    appError.kind === 'defect' &&
    appError.recordedBy === undefined &&
    repositoryCloneErrorMessage(message) === message
  )
    return { error: message };
  return inlineFailure(appError, "Couldn't clone the repository.");
}

/** A folder's name from its path, on either platform's separators. */
function folderNameFromPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part): boolean => part !== '');
  return parts[parts.length - 1] ?? path;
}

function sharedTemplateSelectionId(externalId: string): string {
  return `shared:${externalId}`;
}

/** One request to create, resume or link a member's organization project. */
interface OrgCreateRequest {
  readonly source: OrgCreateSource;
  readonly kind: OrgCreateProjectKind;
  readonly name: string;
  readonly privateMemory?: boolean;
  /** Existing folder to bind in place; `null` makes a new one. */
  readonly folderPath: string | null;
  /** The folder is bound to a project the organization already had. */
  readonly linked: boolean;
  readonly blueprint: {
    readonly externalId: string;
    readonly contentHash: string;
  } | null;
  /** The project a failed setup already created; resuming never makes another. */
  readonly organizationProjectId: string | null;
  /** Multi-repo: the local project a failed setup already made. */
  readonly localWorkspaceId: string | null;
}

/** An organization that holds the repository the member is about to add. */
type OrgRepositoryOwner = Extract<
  OrgRepositoryOwnerLookup,
  { kind: 'organization' }
>;

/**
 * The create-time nudge (hybrid model): the add the member started, held
 * while the dialog suggests the organization that owns the repository.
 */
interface OrgOwnerNudge {
  readonly owner: OrgRepositoryOwner;
  readonly pending:
    | { readonly kind: 'existing'; readonly folder: RepoSelection }
    | {
        readonly kind: 'remote';
        readonly remoteUrl: string;
        readonly destinationDir: string;
      };
}

/** The add continued in the organization after "Add to <organization>". */
type AddWorkspaceHandoff =
  /** Check and add the same folder with the organization's Existing folder. */
  | { readonly kind: 'existing'; readonly folder: RepoSelection }
  /** Add the organization's project for the repository from its catalog. */
  | {
      readonly kind: 'remote';
      readonly projectId: string;
      readonly destinationDir: string;
    };

/**
 * The draft's identity: a context or account change remounts the draft
 * (`AddRepoModalContext`), so nothing typed for one scope lands in another.
 */
function addWorkspaceDraftIdentity(
  accountEpoch: number,
  context: WorkspaceContext | undefined,
): string {
  return `${accountEpoch}:${context === undefined ? 'personal' : serializeWorkspaceContext(context)}`;
}

/**
 * "Add to <organization>" switches the sidebar scope, which remounts the
 * draft. This one-shot seed carries the add across that remount and marks the
 * switch as the member's own, so the new draft continues it instead of saying
 * the context changed. It is keyed by the target draft's identity, so no
 * other scope or account ever consumes it, and the dialog drops it on close.
 * It lives at module scope because the draft that reads it is a new mount;
 * that is safe while each renderer has one Add project dialog
 * (`AddWorkspaceModalHost`), which a second dialog surface would have to
 * revisit.
 */
let pendingHandoff: {
  readonly identity: string;
  readonly handoff: AddWorkspaceHandoff;
} | null = null;

function hasAddWorkspaceHandoff(identity: string): boolean {
  return pendingHandoff?.identity === identity;
}

function takeAddWorkspaceHandoff(identity: string): AddWorkspaceHandoff | null {
  if (pendingHandoff?.identity !== identity) return null;
  const { handoff } = pendingHandoff;
  pendingHandoff = null;
  return handoff;
}

function dropAddWorkspaceHandoff(identity?: string): void {
  if (identity === undefined || pendingHandoff?.identity === identity)
    pendingHandoff = null;
}

/**
 * Personal → Existing folder picked an organization's checkout (CAN-3648).
 * `resolution` is `null` while the check runs.
 */
interface OrgFolderConflictState {
  readonly conflict: OrgFolderConflict;
  readonly resolution: OrgFolderConflictShown;
  /** A scope switch failed for an ordinary reason; the action stays. */
  readonly switchFailed: boolean;
}

/** How a project this dialog added is opened once it is ready. */
interface CompleteWorkspaceOptions {
  readonly cowork: boolean;
  readonly openSettings?: boolean;
  readonly worktreeId?: string;
}

/**
 * A project that was added while its Private memory choice could not be
 * saved. It stays closed until the save succeeds: Try again only ever targets
 * this project, and never creates another one.
 */
interface PendingPrivateProject {
  readonly workspaceId: string;
  readonly options: CompleteWorkspaceOptions;
  /** Runs once the project has been opened. */
  readonly onOpened?: () => void;
}

/**
 * A chosen folder as a quiet line with its Change action (CAN-3909): the
 * Existing folder pick, and Clone's destination. A path's tail identifies it,
 * so a long one truncates from the left like the catalog's clone folder.
 */
function ChosenFolderPath({
  path,
  testId,
  onChange,
  changeDisabled = false,
  label,
  changeTestId = 'add-workspace-choose-folder',
  changeLabel = 'Change folder',
}: {
  readonly path: string;
  readonly testId: string;
  /** Omitted where the folder can't be changed, such as a finished clone. */
  readonly onChange?: () => void;
  readonly changeDisabled?: boolean;
  /** Words before the path, such as `Downloads to`. */
  readonly label?: string;
  readonly changeTestId?: string;
  /** The Change button's accessible name; its visible text is only `Change`. */
  readonly changeLabel?: string;
}): JSX.Element {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-xs fg-secondary"
      title={path}
      data-testid={testId}
    >
      {label !== undefined && <span className="shrink-0">{label}</span>}
      {path ? (
        <span className="min-w-0 truncate font-mono" dir="rtl">
          <bdi dir="ltr">{path}</bdi>
        </span>
      ) : (
        <span className="min-w-0 truncate">No folder chosen</span>
      )}
      {onChange !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={changeLabel}
          data-testid={changeTestId}
          onClick={onChange}
          disabled={changeDisabled}
        >
          Change
        </Button>
      )}
    </div>
  );
}

const TEMPORARY_WORKSPACE_DISABLED_TOOLTIP =
  'Add another project to use Temporary.';

/** The non-catalog options in each navigation mode's order (CAN-5041). */
const CHOICE_ORDER: Record<
  NavigationMode,
  readonly Exclude<AddWorkspaceMode, 'catalog' | 'cloud'>[]
> = {
  work: ['existing', 'create', 'remote'],
  code: ['remote', 'existing', 'create'],
};

/** What each Create new type makes, under the type control (CAN-3909). */
const CREATE_TYPE_DESCRIPTIONS: Record<CreateWorkspaceType, string> = {
  'single-repo': 'Create a git repository with starter files.',
  cowork:
    "A new folder for your documents, research and other work that isn't code.",
  'multi-repo':
    'For changes that touch several repositories at once. Add them after you create it.',
  temporary:
    'Work across repositories from several projects. Automatically removed when its last worktree is deleted.',
};

interface AddRepoModalProps {
  isOpen: boolean;
  onClose: () => void;
  onWorkspaceCreated?: (
    workspaceId: string,
    opts?: { openSettings?: boolean },
  ) => void;
  /**
   * Optional repo URL to seed the Remote → URL clone flow with when the modal
   * opens (ECW-8121). Used by the Home branch picker's "Add {owner}/{repo} as a
   * workspace…" offer row so the existing local-reuse-or-clone machinery takes
   * over pre-filled. Seeded once on open; later user edits win.
   */
  initialRepoUrl?: string | null;
  initialProjectType?: 'cowork' | 'single-repo' | null;
}

function ensureWorkspaceAvailableInProjects(
  projects: SidebarItem[],
  workspace: SidebarItem,
): SidebarItem[] {
  let foundWorkspace = false;
  const nextProjects = projects.map((project) => {
    if (project.id !== workspace.id) {
      return project;
    }
    foundWorkspace = true;
    return {
      ...project,
      order: project.order,
      collapsed: false,
    };
  });

  if (foundWorkspace) {
    return nextProjects;
  }

  return [
    ...nextProjects,
    {
      ...workspace,
      order: nextProjects.length,
      collapsed: false,
    },
  ];
}

/**
 * The message for an organization create that did not finish. `linked` is a
 * folder bound to a project the organization already had: nothing was
 * created, so the setup failure must not say it was.
 */
function orgCreateFailure(
  code: 'unavailable' | 'create-failed' | 'limit-reached' | 'setup-failed',
  name: string,
  organizationName: string,
  linked: boolean,
): AddOrgProjectCreateError {
  switch (code) {
    case 'setup-failed':
      return {
        kind: 'setup-failed',
        message: linked
          ? `Couldn't set up ${name} on this computer. Try again.`
          : `${name} was created in ${organizationName}, but couldn't be set up on this computer. Try again.`,
      };
    case 'limit-reached':
      return {
        kind: 'limit-reached',
        message: `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} private projects in ${organizationName}. Delete one to make another.`,
      };
    case 'unavailable':
      return {
        kind: 'failed',
        message: `You can't create projects in ${organizationName} right now.`,
      };
    case 'create-failed':
      return {
        kind: 'failed',
        message: `Couldn't create ${name} in ${organizationName}. Try again.`,
      };
  }
}

/** What an organization's Existing folder or Remote option adds from a folder. */
function orgFolderRequest(
  folder: RepoSelection,
  kind: OrgCreateProjectKind,
  linkedProjectName: string | null,
  privateMemory: boolean,
  source: Exclude<OrgCreateSource, 'create'>,
): OrgCreateRequest {
  return {
    source,
    kind,
    // A folder linked to a project the organization already has takes that
    // project's name; any other folder names its project, as in Personal.
    name: linkedProjectName ?? folder.name,
    folderPath: folder.path,
    linked: linkedProjectName !== null,
    ...(linkedProjectName === null && privateMemory
      ? { privateMemory: true }
      : {}),
    blueprint: null,
    organizationProjectId: null,
    localWorkspaceId: null,
  };
}

export function AddRepoModal(props: AddRepoModalProps): JSX.Element | null {
  // A handoff never outlives the dialog that started it.
  useEffect((): void => {
    if (!props.isOpen) dropAddWorkspaceHandoff();
    else trackAddProjectDialogOpen();
  }, [props.isOpen]);
  return props.isOpen ? (
    <AddRepoModalContext {...props} />
  ) : (
    <AddRepoModalDraft {...props} context={undefined} />
  );
}

function AddRepoModalContext(props: AddRepoModalProps): JSX.Element {
  // This lifetime survives the intended context draft remount, but ends when
  // the parent closes or removes the dialog.
  const dialogAlive = useRef(true);
  useEffect((): (() => void) => {
    dialogAlive.current = true;
    return (): void => {
      dialogAlive.current = false;
    };
  }, []);
  const context = useSidebarScopingContext();
  const accountEpoch = useWorkspaceContextStore(
    (store): number => store.accountEpoch,
  );
  const identity = addWorkspaceDraftIdentity(accountEpoch, context);
  const [draftIdentity, setDraftIdentity] = useState({
    identity,
    changed: false,
    handedOff: false,
  });
  if (draftIdentity.identity !== identity) {
    // A switch the member chose ("Add to <organization>") continues their
    // add in the new scope instead of resetting it.
    const handedOff = hasAddWorkspaceHandoff(identity);
    setDraftIdentity({ identity, changed: !handedOff, handedOff });
  }
  const contextChanged = draftIdentity.changed;
  return (
    <AddRepoModalDraft
      {...props}
      key={identity}
      dialogAlive={dialogAlive}
      context={context}
      identity={identity}
      contextChanged={contextChanged}
      initialRepoUrl={
        contextChanged || draftIdentity.handedOff ? null : props.initialRepoUrl
      }
    />
  );
}

function AddRepoModalDraft({
  isOpen,
  onClose,
  onWorkspaceCreated,
  initialRepoUrl,
  initialProjectType,
  context,
  identity,
  contextChanged = false,
  dialogAlive,
}: AddRepoModalProps & {
  context: WorkspaceContext | undefined;
  /** The draft's identity; a handoff seeded for it is continued on mount. */
  identity?: string;
  contextChanged?: boolean;
  dialogAlive?: { readonly current: boolean };
}): JSX.Element | null {
  const alive = useRef(false);
  const submitting = useRef(false);
  const preAddPending = useRef(false);
  const catalogAddsInFlight = useRef(0);
  const projectCreated = useRef(false);
  useEffect((): (() => void) => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  type Submission = {
    accountEpoch: number;
    contextKey: string;
    revision: number;
  };
  const captureSubmission = (): Submission => {
    const current = useWorkspaceContextStore.getState();
    return {
      accountEpoch: current.accountEpoch,
      contextKey: serializeWorkspaceContext(current.state.context),
      revision: current.state.revision,
    };
  };
  const matchesSubmission = (submission: Submission): boolean => {
    const current = captureSubmission();
    return (
      current.accountEpoch === submission.accountEpoch &&
      current.contextKey === submission.contextKey &&
      current.revision === submission.revision
    );
  };
  const isCurrent = (submission: Submission): boolean =>
    alive.current && matchesSubmission(submission);
  const beginSubmission = (): Submission | null => {
    if (submitting.current || !alive.current) return null;
    submitting.current = true;
    setIsSubmitting(true);
    setError('');
    return captureSubmission();
  };
  const endSubmission = (): void => {
    preAddPending.current = false;
    if (!alive.current) return;
    submitting.current = false;
    setIsSubmitting(false);
  };
  const orgProjectsStore = useOrgProjectsStoreApi();
  // Personal → Existing folder's organization-owned checkout (CAN-3648). Every
  // new pick, option change, retry, or action bumps the request, so a late
  // answer for an older one never lands in the notice.
  const [orgConflict, setOrgConflict] = useState<OrgFolderConflictState | null>(
    null,
  );
  const conflictOrganization = useWorkspaceContextStore((store) =>
    store.state.organizations.find(
      (item) => item.id === orgConflict?.conflict.owner.organizationId,
    ),
  );
  const conflictCatalogKey = `org:${orgConflict?.conflict.owner.organizationId}`;
  const conflictCatalog = useOrgProjectsStore(
    (store) => store.snapshots[conflictCatalogKey],
  );
  const conflictCatalogError = useOrgProjectsStore(
    (store) => store.errors[conflictCatalogKey],
  );
  const conflictFeatureEnabled = useFeatureFlagsStore((store) =>
    store.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  // A settled notice is also a disclosure surface. Keep its names, action and
  // Advisor identity tied to current access while no submission is running.
  const conflictResolution = useMemo((): OrgFolderConflictShown => {
    const saved = orgConflict?.resolution ?? null;
    if (saved === null) return null;
    if (!conflictFeatureEnabled)
      return {
        status: 'denied',
        reason: 'feature-disabled',
        organizationName: null,
      };
    if (conflictOrganization === undefined)
      return { status: 'denied', reason: 'not-member', organizationName: null };
    if (saved.status === 'denied') {
      if (saved.reason !== 'unavailable') return { status: 'unknown' };
      return { ...saved, organizationName: conflictOrganization.name };
    }
    if (saved.status === 'unknown') return saved;
    if (conflictCatalog === undefined || conflictCatalogError !== undefined)
      return { status: 'unknown' };
    const project = conflictCatalog.projects.find(
      (item) =>
        item.id === saved.projectId &&
        item.organizationId === saved.organizationId,
    );
    if (
      project === undefined ||
      project.state !== 'ACTIVE' ||
      !project.capabilities.use
    )
      return {
        status: 'denied',
        reason: 'unavailable',
        organizationName: conflictOrganization.name,
      };
    return {
      ...saved,
      organizationName: conflictOrganization.name,
      projectName: project.name,
    };
  }, [
    orgConflict,
    conflictFeatureEnabled,
    conflictOrganization,
    conflictCatalog,
    conflictCatalogError,
  ]);
  useEffect((): void => {
    if (
      orgConflict !== null &&
      conflictResolution !== null &&
      orgConflict.resolution?.status !== conflictResolution.status
    )
      // Persist invalidation so restoring cached access cannot restore an old
      // action. Try again (or a new pick) must resolve the binding afresh.
      setOrgConflict({ ...orgConflict, resolution: conflictResolution });
  }, [orgConflict, conflictResolution]);
  const conflictRequest = useRef(0);
  // Set when the member dismisses this dialog; an action that already
  // switched scope then neither closes nor opens anything.
  const dismissed = useRef(false);
  // In an organization, Add project is the Personal dialog with the
  // organization's catalog as its first option (CAN-3453, CAN-3534). Existing
  // folder and Create new make a project the organization owns, never a
  // Personal one: members switch to Personal for that. Remote is offered only
  // where the catalog is withheld (CAN-3984), and its clone is added through
  // the same organization create as Existing folder.
  // `null` until the organization answers.
  const [orgCreateEligible, setOrgCreateEligible] = useState<boolean | null>(
    null,
  );
  // `null` keeps the create options hidden while the server capability is
  // unresolved; an explicit false (including a failed query) makes every
  // member project a Cowork one.
  const [orgCodeEligible, setOrgCodeEligible] = useState<boolean | null>(null);
  const [orgRequiresActivitySharing, setOrgRequiresActivitySharing] =
    useState(false);
  // The Existing folder option's pick, and its check: the folder decides the
  // kind (CAN-3534), so it is checked before anything is created.
  const [orgFolder, setOrgFolder] = useState<RepoSelection | null>(null);
  const [orgFolderOrigin, setOrgFolderOrigin] = useState<OrgFolderOrigin>({
    source: 'existing',
  });
  const [orgFolderCheck, setOrgFolderCheck] =
    useState<OrgCreateFolderCheck | null>(null);
  const [orgError, setOrgError] = useState<{
    readonly source: OrgCreateSource;
    readonly error: AddOrgProjectCreateError;
  } | null>(null);
  // Kept once the project exists in the organization, so Try again only sets
  // up that same project instead of creating a second one.
  const [orgResume, setOrgResume] = useState<OrgCreateRequest | null>(null);
  // The create-time nudge, while it waits for the member's choice.
  const [orgOwnerNudge, setOrgOwnerNudge] = useState<OrgOwnerNudge | null>(
    null,
  );
  // An add handed over from another scope: the catalog project to add, or
  // the folder to check once the organization's options are known.
  const [catalogHandoff, setCatalogHandoff] = useState<{
    readonly projectId: string;
    readonly destinationDir: string;
  } | null>(null);
  const existingHandoff = useRef<RepoSelection | null>(null);
  const handoffTaken = useRef(false);
  const continueExistingHandoff = useRef<
    ((organizationId: string, folder: RepoSelection) => Promise<void>) | null
  >(null);
  const organizationId =
    context?.kind === 'organization' ? context.organizationId : null;
  useEffect((): (() => void) | undefined => {
    if (organizationId === null || !isOpen) return undefined;
    let active = true;
    setOrgRequiresActivitySharing(false);
    setOrgCodeEligible(null);
    void window.api.chatProject
      .getOrgDefaultCoworkEligibility(organizationId)
      .then((eligibility): void => {
        if (active) setOrgCreateEligible(eligibility === 'eligible');
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
        if (active) setOrgCreateEligible(false);
      });
    void window.api.orgProjects
      .getMemberCodeEligibility(organizationId)
      .then((eligibility): void => {
        if (active) setOrgCodeEligible(eligibility === 'eligible');
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
        if (active) setOrgCodeEligible(false);
      });
    void window.api
      .loadCanopyCloudAccount()
      .then((account): void => {
        if (!active) return;
        const settings = account?.enforcedSettings?.find(
          (item): boolean => item.organizationId === organizationId,
        );
        const requiresTranscripts = settings?.policies.some(
          (policy): boolean =>
            policy.kind === 'telemetry-sync' &&
            policy.scopes.transcripts === true &&
            policy.prohibitedScopes?.transcripts !== true,
        );
        setOrgRequiresActivitySharing(requiresTranscripts === true);
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
        if (active) setOrgRequiresActivitySharing(false);
      });
    return (): void => {
      active = false;
    };
  }, [organizationId, isOpen]);
  // The sidebar scope decides what this dialog adds (CAN-3469): an
  // organization scope always opens on that organization's catalog, with no
  // path to Personal. Personal project callers must switch scope before open.
  const inOrganization = context?.kind === 'organization';
  const orgCreateAvailable =
    orgCreateEligible === true && orgCodeEligible !== null;
  // Code create is Cowork create plus a server capability, so it is never
  // offered where creating is not.
  const orgCodeAvailable =
    orgCreateEligible === true && orgCodeEligible === true;
  // Existing folder adds to Personal, or to an organization that takes
  // member projects.
  const existingAvailable = !inOrganization || orgCreateAvailable;
  const navigationMode = useNavigationMode();
  // Work mode leads with a folder and Cowork, Code with Clone and a
  // repository (CAN-5041). Seeds and organizations' catalog come first.
  const personalDefaultMode: AddWorkspaceMode =
    navigationMode === 'work' ? 'existing' : 'remote';
  const defaultCreateType: CreateWorkspaceType =
    navigationMode === 'work' ? 'cowork' : 'single-repo';
  const [selectedMode, setMode] = useState<AddWorkspaceMode>(
    initialProjectType
      ? 'create'
      : inOrganization
        ? 'catalog'
        : personalDefaultMode,
  );
  const organization = useWorkspaceContextStore(
    (store): WorkspaceContextOrganization | undefined =>
      store.state.organizations.find(
        (item): boolean =>
          context?.kind === 'organization' &&
          item.id === context.organizationId,
      ),
  );
  // The catalog is read for the whole open, shown or not (CAN-3984): a
  // member whose organization has nothing to add yet goes straight to an
  // option that can add something, and keeps it for this open even if the
  // catalog fills in meanwhile. Owners, admins, and an unresolved role keep
  // the catalog, as does a member with nothing else to choose.
  const orgCatalogSession = useOrgCatalogSession(
    context?.kind === 'organization' && isOpen ? context : null,
  );
  const catalogWithheld = useOrgProjectCatalogWithheld({
    sessionKey: inOrganization && isOpen ? (identity ?? null) : null,
    knownEmpty: orgCatalogSession.knownEmpty,
    role: organization?.role,
    otherOptionsAvailable: orgCreateAvailable,
  });
  // A clone is a repository, so Remote needs the Code capability.
  const orgRemoteAvailable = catalogWithheld && orgCodeAvailable;
  // CAN-5192: a Personal project from the user's other computers.
  const projectIdentityAvailable = useCanopyProjectIdentityAvailable();
  const cloudSetupAvailable =
    !inOrganization && projectIdentityAvailable === true;
  const choiceRow = useRef<HTMLDivElement>(null);
  const catalogFocused = useRef(false);
  useLayoutEffect((): void => {
    if (!catalogWithheld || !catalogFocused.current) return;
    catalogFocused.current = false;
    choiceRow.current
      ?.querySelector<HTMLButtonElement>(
        '[data-testid="add-workspace-mode-existing"]',
      )
      ?.focus();
  }, [catalogWithheld]);
  if (inOrganization && selectedMode === 'remote' && !orgRemoteAvailable)
    setMode(orgCreateAvailable ? 'existing' : 'catalog');
  const orgModeAvailable = (candidate: AddWorkspaceMode): boolean =>
    candidate === 'catalog'
      ? !catalogWithheld
      : candidate === 'remote'
        ? orgRemoteAvailable
        : orgCreateAvailable;
  // Leave a withheld catalog for Existing folder; a seeded or chosen option
  // stays. Offering the catalog again later then never takes the form away.
  if (inOrganization && catalogWithheld && selectedMode === 'catalog')
    setMode('existing');
  // An organization shows its catalog until the member can create there, and
  // the remote option only where the catalog is withheld, whatever a caller
  // seeded.
  const mode: AddWorkspaceMode = inOrganization
    ? orgModeAvailable(selectedMode)
      ? selectedMode
      : catalogWithheld
        ? 'existing'
        : 'catalog'
    : selectedMode === 'catalog' ||
        (selectedMode === 'cloud' && !cloudSetupAvailable)
      ? 'existing'
      : selectedMode;
  // Another option invalidates the folder conflict and any answer in flight.
  useEffect((): void => {
    if (mode === 'existing') return;
    conflictRequest.current += 1;
    setOrgConflict(null);
  }, [mode]);
  const [workspaceTypeChoice, setWorkspaceType] =
    useState<CreateWorkspaceType | null>(initialProjectType ?? null);
  // An organization takes a member's single-repo, multi-repo (CAN-3546) and
  // Cowork projects. Its default follows the navigation mode, and without the
  // Code capability every project is a Cowork one.
  const orgTypeChoice: CreateWorkspaceType =
    workspaceTypeChoice ?? defaultCreateType;
  const workspaceType: CreateWorkspaceType = inOrganization
    ? !orgCodeAvailable || orgTypeChoice === 'cowork'
      ? 'cowork'
      : orgTypeChoice === 'multi-repo'
        ? 'multi-repo'
        : 'single-repo'
    : (workspaceTypeChoice ?? defaultCreateType);
  const orgFolderInspection =
    orgFolderCheck?.status === 'checked' ? orgFolderCheck.inspection : null;
  // The organization project this folder's repository already belongs to.
  const orgLinkedProject =
    orgFolderInspection?.kind === 'code' && orgFolderInspection.target !== 'new'
      ? orgFolderInspection.target
      : null;
  // What the chosen folder becomes; `null` while unchecked or refused.
  const orgFolderKind =
    orgFolder === null
      ? null
      : resolveOrgFolderProjectKind({
          codeEligible: orgCodeAvailable,
          folderCheck: orgFolderCheck,
        });
  // A project that already exists in the organization locks its option's
  // fields: the only way forward is to finish setting that project up.
  const orgRetrying =
    inOrganization && orgResume !== null && orgResume.source === mode;
  const orgErrorShown =
    inOrganization && orgError !== null && orgError.source === mode
      ? orgError.error
      : null;
  const organizationName = organization?.name ?? 'your organization';
  const orgCatalogOption = orgProjectCatalogOption(organizationName);
  // Add project shows once the chosen folder's check allows it, and stays as
  // Try again for a project a failed setup already created.
  const orgFolderAddOffered =
    inOrganization &&
    orgFolder !== null &&
    (orgFolderKind !== null || orgRetrying);
  useCurrentUiStateReporter(
    'addWorkspace.modal',
    isOpen
      ? {
          mode: inOrganization
            ? mode === 'create'
              ? 'organization-create'
              : mode === 'existing'
                ? 'organization-existing'
                : 'organization'
            : 'personal',
          contextChanged,
          ...(orgOwnerNudge === null
            ? {}
            : {
                orgOwnerNudge: {
                  organizationId: orgOwnerNudge.owner.organizationId,
                },
              }),
          ...(!inOrganization && mode === 'existing' && orgConflict !== null
            ? {
                folderConflict:
                  conflictResolution?.status === 'ready' ||
                  conflictResolution?.status === 'unfinished'
                    ? {
                        status: conflictResolution.status,
                        organizationId: conflictResolution.organizationId,
                        projectId: conflictResolution.projectId,
                      }
                    : {
                        status: conflictResolution?.status ?? 'resolving',
                      },
              }
            : {}),
          ...(inOrganization && mode === 'create'
            ? { projectKind: workspaceType === 'cowork' ? 'cowork' : 'code' }
            : {}),
          ...(inOrganization && mode === 'existing'
            ? {
                ...(orgFolderKind === null
                  ? {}
                  : {
                      projectKind:
                        orgFolderKind === 'multi-repo' ? 'code' : orgFolderKind,
                    }),
                folderKind: resolveOrgCreateFolderKind({
                  codeEligible: orgCodeAvailable,
                  folderPath: orgFolder?.path ?? null,
                  folderCheck: orgFolderCheck,
                }),
              }
            : {}),
          ...(context?.kind === 'organization'
            ? {
                organizationId: context.organizationId,
                name: organization?.name ?? '',
              }
            : {}),
        }
      : null,
  );
  const browseForRepo = useProjectsStore((state) => state.browseForRepo);
  const addLocalRepo = useProjectsStore((state) => state.addLocalRepo);
  const addRemoteRepo = useProjectsStore((state) => state.addRemoteRepo);
  const initLocalRepo = useProjectsStore((state) => state.initLocalRepo);
  const createOrgMemberMultiRepoProject = useProjectsStore(
    (state) => state.createOrgMemberMultiRepoProject,
  );
  const createOrgMemberCodeProject = useProjectsStore(
    (state) => state.createOrgMemberCodeProject,
  );
  const createWorkspace = useProjectsStore((state) => state.createWorkspace);
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const projects = useProjectsStore((state) => state.projects);
  const registerCreatedWorkspaceWorktree = useProjectsStore(
    (state) => state.registerCreatedWorkspaceWorktree,
  );
  const createChatProject = useStandaloneChatStore(
    (state) => state.createChatProject,
  );
  const createChatProjectFromBlueprint = useStandaloneChatStore(
    (state) => state.createChatProjectFromBlueprint,
  );
  const createChatProjectFromSharedTemplate = useStandaloneChatStore(
    (state) => state.createChatProjectFromSharedTemplate,
  );
  const createOrgCoworkProject = useStandaloneChatStore(
    (state) => state.createOrgCoworkProject,
  );
  const activateCreatedCoworkWorkspace = useStandaloneChatStore(
    (state) => state.activateCreatedCoworkWorkspace,
  );
  const navigate = useNavigationStore((state) => state.navigate);
  const addToast = useGitHubStore((state) => state.addToast);

  // A folder dragged over Existing folder's drop area (CAN-3909).
  const [folderDragActive, setFolderDragActive] = useState(false);
  // Clone's destination picker is open (it locks the form like a submission).
  const [browsingCloneDir, setBrowsingCloneDir] = useState(false);
  // Existing folder's picker is open; a dropped folder never opens one.
  const [browsingExisting, setBrowsingExisting] = useState(false);
  // Which found-clone action is running, so only its button says so.
  const [reuseChoice, setReuseChoice] = useState<'new' | 'existing' | null>(
    null,
  );
  // Curated Blueprints (CAN-2964) seed a new cowork project's instructions and
  // starter prompts. Work mode only: Code mode's create panel is unchanged.
  // Two states (§9.2): `null` is nothing selected and NOTHING is pre-checked,
  // a string is a Blueprint. Not picking one IS the empty project, so there is
  // no separate "explicitly empty" state to keep apart from untouched.
  const blueprintPickerVisible =
    navigationMode === 'work' &&
    mode === 'create' &&
    workspaceType === 'cowork';
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string | null>(
    null,
  );
  const blueprintCatalog = useBlueprintCatalog(blueprintPickerVisible);
  const selectedBlueprint =
    selectedBlueprintId === null
      ? null
      : (blueprintCatalog.blueprints.find(
          (blueprint) => blueprint.externalId === selectedBlueprintId,
        ) ?? null);
  const selectedSharedTemplate =
    inOrganization || selectedBlueprintId === null
      ? null
      : (blueprintCatalog.sharedTemplates.find(
          (template) =>
            sharedTemplateSelectionId(template.externalId) ===
            selectedBlueprintId,
        ) ?? null);
  const [remoteSource, setRemoteSource] = useState<RemoteSource>('url');
  const [remoteSourceManuallySelected, setRemoteSourceManuallySelected] =
    useState(false);
  const [permissionsRefreshKey, setPermissionsRefreshKey] = useState(0);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [destinationDir, setDestinationDir] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [error, setErrorFailure] = useState<InlineFailure | null>(null);
  /** An authored sentence (validation, a known outcome); `''` clears it. */
  const setError = (message: string): void =>
    setErrorFailure(message ? { error: message } : null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
  const [repoFetchState, setRepoFetchState] = useState<RepoFetchState>('idle');
  const [reposError, setReposError] = useState('');
  const [repoSearch, setRepoSearch] = useState('');
  const [selectedRepoFullName, setSelectedRepoFullName] = useState<
    string | null
  >(null);
  const [selectedTemporaryWorkspaceIds, setSelectedTemporaryWorkspaceIds] =
    useState<string[]>([]);
  const [temporaryWorkspaceSearch, setTemporaryWorkspaceSearch] = useState('');
  const repoFetchRequestRef = useRef(0);
  // Guards the one-time `initialRepoUrl` seed so it fires once per open and
  // never fights the user's later edits to the URL/source inputs.
  const seededInitialRepoUrlRef = useRef(false);
  const [reuseClonePrompt, setReuseClonePrompt] = useState<{
    remoteUrl: string;
    destinationDir: string;
    reusablePath: string;
  } | null>(null);
  // Private memory (CAN-3562) is off for a Personal create until chosen. An
  // organization's projects inherit the organization's value, so its options
  // never offer a local choice, and a temporary project reuses existing ones.
  const [privateMemoryDraft, setPrivateMemoryDraft] = useState(false);
  const [privateMemoryPending, setPrivateMemoryPending] =
    useState<PendingPrivateProject | null>(null);
  const privateMemorySelected = !inOrganization && privateMemoryDraft;

  const permissions = useGitHubPermissions('any', permissionsRefreshKey);
  const canListRepos = permissions?.canListRepos === true;
  const usesRemoteRepoPicker = mode === 'remote';

  useEffect(() => {
    if (!isOpen) {
      repoFetchRequestRef.current += 1;
      setMode('remote');
      setFolderDragActive(false);
      setWorkspaceType(null);
      setRemoteSource('url');
      setRemoteSourceManuallySelected(false);
      setRemoteUrl('');
      setDestinationDir('');
      setWorkspaceName('');
      setError('');
      setIsSubmitting(false);
      setRepos(null);
      setRepoSearch('');
      setSelectedRepoFullName(null);
      setSelectedTemporaryWorkspaceIds([]);
      setTemporaryWorkspaceSearch('');
      setSelectedBlueprintId(null);
      setReposError('');
      setRepoFetchState('idle');
      setReuseClonePrompt(null);
      setOrgOwnerNudge(null);
      setPrivateMemoryDraft(false);
      setPrivateMemoryPending(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setPermissionsRefreshKey((key) => key + 1);
  }, [isOpen]);

  // Seed the Remote → URL clone flow from `initialRepoUrl` exactly once per
  // open (ECW-8121). Marking the source manually selected keeps the
  // auto-`github`-source effect from flipping it back, and seeding runs after
  // the `!isOpen` reset effect above (declaration order) so a stale reset never
  // clobbers the seeded value. Later user edits win because the ref blocks
  // re-seeding while the modal stays open.
  useEffect(() => {
    if (!isOpen) {
      seededInitialRepoUrlRef.current = false;
      return;
    }
    if (seededInitialRepoUrlRef.current) return;
    seededInitialRepoUrlRef.current = true;
    const seedUrl = initialRepoUrl?.trim();
    if (!seedUrl) return;
    setMode('remote');
    setRemoteSource('url');
    setRemoteSourceManuallySelected(true);
    setRemoteUrl(seedUrl);
  }, [isOpen, initialRepoUrl]);

  // Clear the reuse/clone prompt when the user changes inputs so they are
  // not acting on stale probe data.
  useEffect(() => {
    setReuseClonePrompt(null);
  }, [remoteUrl, destinationDir, selectedRepoFullName, remoteSource, mode]);
  // The nudge is about one pick: a new input withdraws it.
  useEffect((): void => {
    setOrgOwnerNudge(null);
  }, [remoteUrl, destinationDir, selectedRepoFullName, remoteSource, mode]);

  // Continue an add the member handed over from another scope (the
  // create-time nudge's "Add to <organization>"), once.
  useEffect((): void => {
    if (handoffTaken.current || identity === undefined) return;
    handoffTaken.current = true;
    const handoff = takeAddWorkspaceHandoff(identity);
    if (handoff === null) return;
    if (handoff.kind === 'remote') {
      setMode('catalog');
      setCatalogHandoff({
        projectId: handoff.projectId,
        destinationDir: handoff.destinationDir,
      });
      return;
    }
    setMode('existing');
    existingHandoff.current = handoff.folder;
  }, [identity]);
  // The folder is checked once the organization says what it can take.
  useEffect((): void => {
    const folder = existingHandoff.current;
    if (
      folder === null ||
      organizationId === null ||
      orgCreateEligible === null ||
      orgCodeEligible === null
    )
      return;
    existingHandoff.current = null;
    // Only a Code project can be the organization's repository; where the
    // member cannot create one the dialog goes back to the catalog, which
    // lists the organization's project for this repository.
    if (!orgCodeAvailable) {
      setMode('catalog');
      return;
    }
    void continueExistingHandoff.current?.(organizationId, folder);
  }, [organizationId, orgCreateEligible, orgCodeEligible, orgCodeAvailable]);

  const loadGitHubRepos = useCallback((): void => {
    const requestId = repoFetchRequestRef.current + 1;
    repoFetchRequestRef.current = requestId;
    setRepoFetchState('loading');
    setReposError('');

    void window.api
      .listUserGitHubRepos()
      .then((result) => {
        if (!alive.current || repoFetchRequestRef.current !== requestId) {
          return;
        }
        setRepos(result);
        setRepoFetchState('loaded');
      })
      .catch((cause: unknown) => {
        if (!alive.current || repoFetchRequestRef.current !== requestId) {
          return;
        }
        const appError = toAppError(resolveClientAppError(cause));
        if (appError)
          setReposError(
            failureMessage(
              inlineFailure(
                appError,
                "Couldn't load repositories from GitHub.",
              ),
            ),
          );
        setRepoFetchState('error');
      });
  }, []);

  const handleRemoteSourceSelect = useCallback((source: RemoteSource): void => {
    setRemoteSource(source);
    setRemoteSourceManuallySelected(true);
  }, []);

  useEffect(() => {
    if (!isOpen || !usesRemoteRepoPicker || permissions === null) {
      return;
    }
    if (canListRepos && !remoteSourceManuallySelected && !remoteUrl.trim()) {
      setRemoteSource('github');
    }
  }, [
    canListRepos,
    isOpen,
    permissions,
    remoteSourceManuallySelected,
    remoteUrl,
    usesRemoteRepoPicker,
  ]);

  useEffect(() => {
    if (
      !isOpen ||
      !usesRemoteRepoPicker ||
      remoteSource !== 'github' ||
      !canListRepos ||
      repoFetchState === 'loading' ||
      repoFetchState === 'loaded'
    ) {
      return;
    }

    loadGitHubRepos();
  }, [
    canListRepos,
    isOpen,
    loadGitHubRepos,
    remoteSource,
    repoFetchState,
    usesRemoteRepoPicker,
  ]);

  useEffect(() => {
    if (
      !isOpen ||
      (usesRemoteRepoPicker && remoteSource === 'github' && canListRepos)
    ) {
      return;
    }
    repoFetchRequestRef.current += 1;
    setReposError('');
    setRepoSearch('');
    setSelectedRepoFullName(null);
    if (repoFetchState !== 'loaded') {
      setRepoFetchState('idle');
    }
  }, [
    canListRepos,
    isOpen,
    remoteSource,
    repoFetchState,
    usesRemoteRepoPicker,
  ]);

  useEffect(() => {
    if (
      !isOpen ||
      permissions === null ||
      canListRepos ||
      remoteSource !== 'github'
    ) {
      return;
    }
    repoFetchRequestRef.current += 1;
    setRemoteSource('url');
    setRepos(null);
    setRepoSearch('');
    setSelectedRepoFullName(null);
    setReposError('');
    setRepoFetchState('idle');
  }, [canListRepos, isOpen, permissions, remoteSource]);

  const filteredRepos = useMemo((): GitHubRepoSummary[] => {
    if (!repos) return [];
    const query = repoSearch.trim().toLowerCase();
    if (!query) return repos;
    return repos.filter((repo) => {
      if (repo.fullName.toLowerCase().includes(query)) return true;
      if (repo.description?.toLowerCase().includes(query)) return true;
      return false;
    });
  }, [repos, repoSearch]);

  const selectedRepo = useMemo((): GitHubRepoSummary | null => {
    if (!repos || !selectedRepoFullName) return null;
    return repos.find((r) => r.fullName === selectedRepoFullName) ?? null;
  }, [repos, selectedRepoFullName]);

  const temporaryWorkspaceOptions = useMemo<AdhocMultiRepoJoinOption[]>(() => {
    return projects
      .filter((project) => {
        if (project.type === 'single-repo') {
          return true;
        }
        if (project.type === 'cowork') {
          return false;
        }
        return (
          project.repos.filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
            .length > 0
        );
      })
      .map((project) => ({
        id: project.id,
        name: project.name,
        color: project.color,
        isMultiRepo: project.type === 'multi-repo',
        repoCount:
          project.type === 'multi-repo'
            ? project.repos.filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
                .length
            : 1,
        temporary: project.type === 'multi-repo' && project.temporary === true,
        repoPath: project.type === 'single-repo' ? project.repoPath : undefined,
      }));
  }, [projects]);
  const temporaryWorkspaceTypeDisabled = temporaryWorkspaceOptions.length <= 1;

  const handleToggleTemporaryWorkspace = useCallback(
    (workspaceId: string): void => {
      setSelectedTemporaryWorkspaceIds((current) =>
        current.includes(workspaceId)
          ? current.filter((id) => id !== workspaceId)
          : [...current, workspaceId],
      );
    },
    [],
  );

  useEffect(() => {
    if (!isOpen || !usesRemoteRepoPicker || destinationDir.trim()) {
      return;
    }

    let canceled = false;
    const loadDefaultCloneDir = async (): Promise<void> => {
      try {
        const defaultCloneDir = await window.api.getDefaultCloneDirectory();
        if (!canceled) {
          setDestinationDir(defaultCloneDir);
        }
      } catch (cause) {
        const appError = toAppError(resolveClientAppError(cause));
        if (!canceled && appError) {
          setErrorFailure(
            inlineFailure(
              appError,
              "Couldn't find the default download folder.",
            ),
          );
        }
      }
    };

    void loadDefaultCloneDir();
    return (): void => {
      canceled = true;
    };
  }, [destinationDir, isOpen, usesRemoteRepoPicker]);

  useEffect(() => {
    if (workspaceType !== 'temporary' || !temporaryWorkspaceTypeDisabled) {
      return;
    }
    setWorkspaceType('single-repo');
    setSelectedTemporaryWorkspaceIds([]);
  }, [temporaryWorkspaceTypeDisabled, workspaceType]);

  if (!isOpen) {
    return null;
  }

  // Import owns creation; completion owns the context switch and selection.
  // After the intentional switch, only captured callbacks run. Draft state is
  // never updated across the context-key remount.
  const completeWorkspace = async (
    workspaceId: string | null,
    submission: Submission,
    options: CompleteWorkspaceOptions,
  ): Promise<boolean> => {
    if (!isCurrent(submission)) return false;
    if (!workspaceId) {
      onClose();
      return false;
    }
    const { cowork } = options;
    if (!cowork) onClose();
    if (cowork) {
      const opened = await activateCreatedCoworkWorkspace(workspaceId);
      if (!opened) return false;
      if (!matchesSubmission(submission)) return false;
      if (!alive.current) return false;
      recordAutomationCreatedProject(workspaceId);
      onClose();
      navigate('chat');
    } else {
      if (options?.worktreeId) {
        useChatStore.getState().selectWorktree(workspaceId, options.worktreeId);
        navigate('main');
      }
      if (options?.openSettings)
        onWorkspaceCreated?.(workspaceId, { openSettings: true });
      else onWorkspaceCreated?.(workspaceId);
    }
    return matchesSubmission(submission);
  };

  // A failed Private memory save after this dialog is gone has no notice to
  // land in, so it is reported where the user will still see it.
  const reportPrivateMemoryNotApplied = (): void => {
    addToast(
      "Couldn't turn on Private memory for the project you added. Turn it on in the project's settings before you start a chat.",
      'error',
      undefined,
      { forceInApp: true, title: 'Private memory is off' },
    );
  };

  // Opens a Personal project this dialog added. A selected Private memory is
  // saved first, against the project this submission created and no other, so
  // the project never opens (and its first chat never starts) without it. Off
  // writes nothing: a new project is already off, and a folder that was
  // already a project keeps the value it has. If the save fails the project
  // stays in the sidebar, unopened, and the dialog offers to try again.
  const finishWorkspace = async (
    workspaceId: string | null,
    submission: Submission,
    options: CompleteWorkspaceOptions,
    onOpened?: () => void,
  ): Promise<void> => {
    if (workspaceId !== null) projectCreated.current = true;
    if (workspaceId !== null && privateMemorySelected) {
      try {
        await saveWorkspacePrivateMemory(workspaceId, true);
      } catch (cause) {
        // The pending notice (or the toast below) tells the person; the
        // failure itself is recorded.
        reportClientAppError(cause);
        if (isCurrent(submission))
          setPrivateMemoryPending({
            workspaceId,
            options,
            ...(onOpened ? { onOpened } : {}),
          });
        else reportPrivateMemoryNotApplied();
        return;
      }
    }
    const completed = await completeWorkspace(workspaceId, submission, options);
    if (completed) onOpened?.();
  };

  const handleRetryPrivateMemory = async (): Promise<void> => {
    const pending = privateMemoryPending;
    if (pending === null) return;
    const submission = beginSubmission();
    if (!submission) return;
    try {
      const saved = await saveWorkspacePrivateMemory(
        pending.workspaceId,
        true,
      ).then(
        (): boolean => true,
        (): boolean => false,
      );
      // A failed save keeps the notice: the project is still waiting for it.
      if (!saved || !isCurrent(submission)) return;
      setPrivateMemoryPending(null);
      const completed = await completeWorkspace(
        pending.workspaceId,
        submission,
        pending.options,
      );
      if (completed) pending.onOpened?.();
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && isCurrent(submission))
        setErrorFailure(inlineFailure(appError, "Couldn't open the project."));
    } finally {
      endSubmission();
    }
  };

  // Creates, resumes or links a member's organization project, then opens it
  // like the Personal create of the same kind.
  const runOrgCreate = async (
    request: OrgCreateRequest,
    submission: Submission,
  ): Promise<void> => {
    if (context?.kind !== 'organization') return;
    const fail = (error: AddOrgProjectCreateError): void =>
      setOrgError({ source: request.source, error });
    let createdProjectId = request.organizationProjectId;
    const resumeWith = (organizationProjectId: string): void => {
      createdProjectId = organizationProjectId;
      setOrgResume({ ...request, organizationProjectId });
    };
    setOrgError(null);
    try {
      if (request.kind === 'multi-repo') {
        // Create new sends only the name: the project's settings then add
        // its repositories, as for a Personal multi-repo project.
        const result = await createOrgMemberMultiRepoProject({
          organizationId: context.organizationId,
          name: request.name,
          ...(request.privateMemory === true ? { privateMemory: true } : {}),
          ...(request.localWorkspaceId !== null
            ? { localWorkspaceId: request.localWorkspaceId }
            : request.folderPath !== null
              ? { folderPath: request.folderPath }
              : {}),
        });
        if (!isCurrent(submission)) return;
        if (result.ok) {
          setOrgResume(null);
          await completeWorkspace(result.localWorkspaceId, submission, {
            cowork: false,
            // A new project opens its settings to add repositories.
            ...(request.folderPath === null ? { openSettings: true } : {}),
          });
          return;
        }
        if (result.code === 'refused') {
          if (request.folderPath === null)
            fail({
              kind: 'failed',
              message: orgCreateFolderRefusalText(
                result.reason,
                organizationName,
                result.repositories,
              ),
            });
          else
            setOrgFolderCheck({
              status: 'checked',
              inspection: {
                kind: 'refused',
                reason: result.reason,
                ...(result.repositories
                  ? { repositories: result.repositories }
                  : {}),
              },
            });
          return;
        }
        if (result.code === 'setup-failed') {
          setOrgResume({
            ...request,
            localWorkspaceId: result.localWorkspaceId,
          });
          fail(
            orgCreateFailure(
              'setup-failed',
              request.name,
              organizationName,
              true,
            ),
          );
          return;
        }
        fail(
          orgCreateFailure(result.code, request.name, organizationName, false),
        );
        return;
      }
      if (request.kind === 'code') {
        const result = await createOrgMemberCodeProject({
          organizationId: context.organizationId,
          name: request.name,
          ...(request.privateMemory === true ? { privateMemory: true } : {}),
          ...(request.folderPath === null
            ? {}
            : { folderPath: request.folderPath }),
          ...(request.organizationProjectId === null
            ? {}
            : { organizationProjectId: request.organizationProjectId }),
        });
        if (!isCurrent(submission)) return;
        if (result.ok) {
          resumeWith(result.organizationProjectId);
          // A Code project lands like a Personal repository create: the
          // dialog closes and the caller opens the new project.
          await completeWorkspace(result.localWorkspaceId, submission, {
            cowork: false,
          });
          return;
        }
        if (result.code === 'refused') {
          // Main checks the folder again at create time. With a folder the
          // refusal replaces its outcome line, which also withdraws Add.
          if (request.folderPath === null)
            fail({
              kind: 'failed',
              message: orgCreateFolderRefusalText(
                result.reason,
                organizationName,
              ),
            });
          else
            setOrgFolderCheck({
              status: 'checked',
              inspection: { kind: 'refused', reason: result.reason },
            });
          return;
        }
        if (result.code === 'setup-failed')
          resumeWith(result.organizationProjectId);
        fail(
          orgCreateFailure(
            result.code,
            request.name,
            organizationName,
            request.linked,
          ),
        );
        return;
      }
      const result = await createOrgCoworkProject({
        organizationId: context.organizationId,
        name: request.name,
        ...(request.privateMemory === true ? { privateMemory: true } : {}),
        ...(request.folderPath === null
          ? {}
          : { folderPath: request.folderPath }),
        ...(request.blueprint === null ? {} : { blueprint: request.blueprint }),
        ...(request.organizationProjectId === null
          ? {}
          : { organizationProjectId: request.organizationProjectId }),
      });
      if (!isCurrent(submission)) return;
      if (result.ok) {
        resumeWith(result.organizationProjectId);
        // Creation already succeeded. A stale sidebar is recoverable and must
        // not turn the next click into a second create request.
        await loadProjects({ silent: true }).catch((error: unknown) => {
          reportClientAppError(error);
        });
        await completeWorkspace(result.localWorkspaceId, submission, {
          cowork: true,
        });
        return;
      }
      if (result.code === 'setup-failed')
        resumeWith(result.organizationProjectId);
      fail(
        orgCreateFailure(result.code, request.name, organizationName, false),
      );
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && isCurrent(submission))
        fail({
          kind: createdProjectId === null ? 'failed' : 'setup-failed',
          message: failureMessage(
            inlineFailure(
              appError,
              createdProjectId === null
                ? "Couldn't create the project."
                : "Couldn't set up the project.",
            ),
          ),
        });
    }
  };

  // An organization's folder pick. A routine outcome is added at once, as in
  // Personal; one that moves a Personal project or links to a project the
  // organization already has waits for the member to confirm it, and a
  // refused folder adds nothing.
  const addOrgFolder = async (
    organizationId: string,
    folder: RepoSelection,
    submission: Submission,
    origin: OrgFolderOrigin = { source: 'existing' },
  ): Promise<void> => {
    preAddPending.current = true;
    setOrgError(null);
    setOrgFolder(folder);
    setOrgFolderOrigin(origin);
    if (!orgCodeAvailable) {
      // Without the Code capability a folder is attached as Cowork without
      // being checked, as before CAN-3534.
      setOrgFolderCheck(null);
      preAddPending.current = false;
      await runOrgCreate(
        orgFolderRequest(
          folder,
          'cowork',
          null,
          privateMemoryDraft,
          origin.source,
        ),
        submission,
      );
      return;
    }
    setOrgFolderCheck({ status: 'checking' });
    const inspection = await window.api.orgProjects
      .inspectFolder({ organizationId, path: folder.path })
      // A check that cannot answer refuses the folder: guessing Cowork would
      // attach a repository without its git features.
      .catch((error: unknown): OrgMemberFolderInspection => {
        reportClientAppError(error);
        return { kind: 'refused', reason: 'unreadable' };
      });
    if (!isCurrent(submission)) return;
    setOrgFolderCheck({ status: 'checked', inspection });
    if (inspection.kind === 'refused' || orgFolderNeedsConfirmation(inspection))
      return;
    preAddPending.current = false;
    await runOrgCreate(
      orgFolderRequest(
        folder,
        inspection.kind,
        null,
        privateMemoryDraft,
        origin.source,
      ),
      submission,
    );
  };

  // The create-time nudge (hybrid model): the member's organization that
  // holds this repository, other than the scope being added to. Advisory:
  // the flag off (no scoping context), a failure or an ambiguous answer
  // adds exactly as before.
  const findRepositoryOwner = async (
    request: OrgRepositoryOwnerRequest,
  ): Promise<OrgRepositoryOwner | null> => {
    if (context === undefined) return null;
    try {
      const owner = await window.api.orgProjects.findRepositoryOwner(request);
      if (owner.kind !== 'organization') return null;
      if (
        context.kind === 'organization' &&
        owner.organizationId.toLowerCase() ===
          context.organizationId.toLowerCase()
      )
        return null;
      return owner;
    } catch (error) {
      // Advisory: the add goes ahead as if no other owner were found.
      reportClientAppError(error);
      return null;
    }
  };

  // Existing folder's add in this scope: Personal imports the folder; an
  // organization checks it first.
  const addExistingFolder = async (
    selected: RepoSelection,
    submission: Submission,
  ): Promise<void> => {
    if (context?.kind === 'organization') {
      await addOrgFolder(context.organizationId, selected, submission);
      return;
    }
    const workspace = await addLocalRepo(selected.path, {
      activate: false,
    });
    await finishWorkspace(workspace?.id ?? null, submission, {
      cowork: workspace?.type === 'cowork',
    });
  };

  const reportExistingFailure = (
    appError: AppError,
    submission: Submission,
  ): void => {
    if (!isCurrent(submission)) return;
    const failure = inlineFailure(appError, "Couldn't add this folder.");
    if (inOrganization)
      setOrgError({
        source: 'existing',
        error: { kind: 'failed', message: failureMessage(failure) },
      });
    else setErrorFailure(failure);
  };

  // Checks whether the organization project behind a conflicting folder can
  // be opened, and shows the answer unless a newer request replaced it.
  const resolveConflict = async (
    conflict: OrgFolderConflict,
    submission: Submission,
    refresh: boolean,
  ): Promise<void> => {
    conflictRequest.current += 1;
    const request = conflictRequest.current;
    const live = (): boolean =>
      isCurrent(submission) && request === conflictRequest.current;
    setOrgConflict({ conflict, resolution: null, switchFailed: false });
    const resolution = await resolveOrgFolderConflict(
      conflict,
      orgProjectsStore,
      { isCurrent: live, refresh },
    );
    if (resolution.status === 'superseded' || !live()) return;
    setOrgConflict({ conflict, resolution, switchFailed: false });
  };

  // A folder from the picker or dropped on the dialog (CAN-3909): both run
  // the same checks before anything is added.
  const handleExistingFolder = async (
    pick: () => Promise<RepoSelection | null>,
  ): Promise<void> => {
    const submission = beginSubmission();
    if (!submission) return;
    preAddPending.current = true;
    // A new pick, even a cancelled one, invalidates the previous notice.
    conflictRequest.current += 1;
    const request = conflictRequest.current;
    const live = (): boolean =>
      isCurrent(submission) && request === conflictRequest.current;
    setOrgConflict(null);
    setOrgOwnerNudge(null);
    try {
      const selected = await pick();
      if (!live() || !selected) return;
      if (context?.kind === 'organization') {
        const owner = await findRepositoryOwner({ path: selected.path });
        if (!live()) return;
        if (owner !== null) {
          setOrgFolder(null);
          setOrgFolderCheck(null);
          setOrgError(null);
          setOrgOwnerNudge({
            owner,
            pending: { kind: 'existing', folder: selected },
          });
          return;
        }
        await addOrgFolder(context.organizationId, selected, submission);
        return;
      }
      // An already tracked checkout gets its existing conflict flow. A failed
      // check remains advisory; the import is still the final authority.
      const check = await window.api
        .checkAddWorkspaceFromFolder({ repoPath: selected.path })
        .catch((error: unknown): null => {
          reportClientAppError(error);
          return null;
        });
      if (!live()) return;
      if (check?.status === 'already-tracked' && check.owner !== null) {
        await resolveConflict(
          { workspaceId: check.workspaceId, owner: check.owner },
          submission,
          false,
        );
        return;
      }
      const owner = await findRepositoryOwner({ path: selected.path });
      if (!live()) return;
      if (owner !== null) {
        setOrgFolder(null);
        setOrgFolderCheck(null);
        setOrgError(null);
        setOrgOwnerNudge({
          owner,
          pending: { kind: 'existing', folder: selected },
        });
        return;
      }
      preAddPending.current = false;
      await addExistingFolder(selected, submission);
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && live()) reportExistingFailure(appError, submission);
    } finally {
      endSubmission();
    }
  };

  const handleBrowseExisting = (): Promise<void> =>
    handleExistingFolder(async () => {
      setBrowsingExisting(true);
      try {
        return await browseForRepo();
      } finally {
        setBrowsingExisting(false);
      }
    });

  // A folder dropped anywhere on the dialog opens Existing folder (CAN-3909).
  // Other drags, such as text into the URL field, keep their default.
  const isFolderDrag = (event: DragEvent<HTMLElement>): boolean =>
    existingAvailable && event.dataTransfer.types.includes('Files');
  // A drop is a pick, so it waits whenever Choose folder would: while the
  // form is busy, or while an organization folder's setup awaits Try again.
  const folderDropLocked =
    isSubmitting ||
    privateMemoryPending !== null ||
    (inOrganization && orgResume?.source === 'existing');

  const handleFolderDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!isFolderDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = folderDropLocked ? 'none' : 'copy';
    if (!folderDropLocked && !folderDragActive) setFolderDragActive(true);
  };

  const handleFolderDragLeave = (event: DragEvent<HTMLElement>): void => {
    // Moving onto a child also fires dragleave; only leaving the dialog counts.
    // Chromium can leave relatedTarget null for file drags, so then the
    // pointer decides.
    const next = event.relatedTarget;
    const box = event.currentTarget.getBoundingClientRect();
    const inside =
      next instanceof Node
        ? event.currentTarget.contains(next)
        : event.clientX > box.left &&
          event.clientX < box.right &&
          event.clientY > box.top &&
          event.clientY < box.bottom;
    if (inside) return;
    setFolderDragActive(false);
  };

  const handleFolderDrop = (event: DragEvent<HTMLElement>): void => {
    if (!isFolderDrag(event)) return;
    event.preventDefault();
    setFolderDragActive(false);
    if (folderDropLocked) return;
    // The entry and the file come from the same item, the first file one.
    const item = Array.from(event.dataTransfer.items).find(
      (candidate): boolean => candidate.kind === 'file',
    );
    const file = item?.getAsFile();
    if (!item || !file) return;
    // Without an entry there is no proof it is a folder, so refuse it.
    if (item.webkitGetAsEntry()?.isDirectory !== true) {
      setError('Drop a folder, not a file.');
      return;
    }
    setMode('existing');
    const path = window.api.getPathForFile(file);
    if (!path) {
      setError("Couldn't read that folder. Use Choose folder instead.");
      return;
    }
    const name = folderNameFromPath(path);
    void handleExistingFolder(
      (): Promise<RepoSelection> => Promise.resolve({ name, path }),
    );
  };

  // The organization's Existing folder, continuing a folder handed over from
  // another scope: the same check and add as a pick here.
  continueExistingHandoff.current = async (
    targetOrganizationId: string,
    folder: RepoSelection,
  ): Promise<void> => {
    const submission = beginSubmission();
    if (!submission) return;
    try {
      await addOrgFolder(targetOrganizationId, folder, submission);
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError) reportExistingFailure(appError, submission);
    } finally {
      endSubmission();
    }
  };

  const handleOrgConflictRetry = async (): Promise<void> => {
    if (orgConflict === null) return;
    const submission = beginSubmission();
    if (!submission) return;
    // Refreshing the conflict only validates access; no project add has begun.
    preAddPending.current = true;
    try {
      await resolveConflict(orgConflict.conflict, submission, true);
    } finally {
      endSubmission();
    }
  };

  // Open (ready) or Show (unfinished). Readiness is checked again first: a
  // changed answer replaces the notice instead of acting on it. After the
  // scope switch this draft remounts, so only captured callbacks and the
  // independent account/context guards decide what happens next.
  const handleOrgConflictAction = async (): Promise<void> => {
    const shown = orgConflict;
    const expected = shown?.resolution?.status;
    if (shown === null || (expected !== 'ready' && expected !== 'unfinished'))
      return;
    const submission = beginSubmission();
    if (!submission) return;
    conflictRequest.current += 1;
    const request = conflictRequest.current;
    const live = (): boolean =>
      isCurrent(submission) && request === conflictRequest.current;
    const { conflict } = shown;
    try {
      const fresh = await resolveOrgFolderConflict(conflict, orgProjectsStore, {
        isCurrent: live,
        refresh: true,
      });
      if (fresh.status === 'superseded' || !live()) return;
      setOrgConflict({ conflict, resolution: fresh, switchFailed: false });
      if (fresh.status !== expected) return;
      if (fresh.status !== 'ready' && fresh.status !== 'unfinished') return;
      const wasDismissed = dismissed;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        onClose();
      };
      const accountEpoch = useWorkspaceContextStore.getState().accountEpoch;
      const catalogEpoch = orgProjectsStore.getState().accountEpoch;
      let switchSuperseded = false;
      // Observe the switch itself: returning to the intended organization after
      // an unrelated context change must not revive this old continuation.
      const stopSwitchGuard = useWorkspaceContextStore.subscribe(
        (current, previous): void => {
          if (current.accountEpoch !== accountEpoch) switchSuperseded = true;
          const key = serializeWorkspaceContext(current.state.context);
          if (key === serializeWorkspaceContext(previous.state.context)) return;
          if (key !== `org:${fresh.organizationId}`) switchSuperseded = true;
          // Main broadcasts the committed switch before it answers, and that
          // remounts this draft into the organization's cleared form. Close in
          // the same update so the form never paints while the reply is due.
          else if (
            !switchSuperseded &&
            !wasDismissed.current &&
            dialogAlive?.current !== false &&
            request === conflictRequest.current
          )
            close();
        },
      );
      try {
        const result = await useWorkspaceContextStore.getState().setContext({
          kind: 'organization',
          organizationId: fresh.organizationId,
        });
        if (
          useWorkspaceContextStore.getState().state.revision !== result.revision
        )
          return;
      } catch (cause) {
        // An account change or another switch supersedes this one silently;
        // an ordinary failure keeps the action so the member can retry.
        const appError = toAppError(resolveClientAppError(cause));
        if (appError && live())
          setOrgConflict({ conflict, resolution: fresh, switchFailed: true });
        return;
      } finally {
        stopSwitchGuard();
      }
      const switched = useWorkspaceContextStore.getState();
      if (
        switchSuperseded ||
        // Once this switch closed the dialog, its lifetime no longer applies.
        (!closed && (wasDismissed.current || dialogAlive?.current === false)) ||
        request !== conflictRequest.current ||
        switched.accountEpoch !== accountEpoch ||
        orgProjectsStore.getState().accountEpoch !== catalogEpoch ||
        switched.state.context.kind !== 'organization' ||
        switched.state.context.organizationId !== fresh.organizationId
      )
        return;
      close();
      // Show reveals the organization without selecting its unfinished row.
      if (fresh.status !== 'ready') return;
      const outcome = await openOrgProject(
        {
          organizationId: fresh.organizationId,
          projectId: fresh.projectId,
          workspaceId: conflict.workspaceId,
          expectedBinding: conflict.owner,
        },
        orgProjectsStore,
      );
      if (outcome === 'unavailable') addToast('Project not available', 'error');
    } finally {
      endSubmission();
    }
  };

  const selectMode = (next: AddWorkspaceMode): void => {
    if (next !== mode) trackAddProjectMethodClick(next);
    setMode(next);
  };

  const dismiss = (): void => {
    // Closing before an add begins is cancellation, including during validation.
    // A running add or an already created project is not abandoned.
    if (
      (!submitting.current || preAddPending.current) &&
      catalogAddsInFlight.current === 0 &&
      !projectCreated.current &&
      privateMemoryPending === null &&
      orgResume === null
    )
      trackAddProjectDialogCancel(mode);
    dismissed.current = true;
    onClose();
  };

  // Adds the chosen organization folder once the member confirms it, or sets
  // up again the project a failed attempt already created.
  const handleAddOrgFolder = async (): Promise<void> => {
    if (orgFolder === null) return;
    // A confirmed clone resumes with the folder already cloned; nothing is
    // cloned again.
    const { source } = orgFolderOrigin;
    const request =
      orgResume?.source === source
        ? orgResume
        : orgFolderKind === null
          ? null
          : orgFolderRequest(
              orgFolder,
              orgFolderKind,
              orgLinkedProject?.projectName ?? null,
              privateMemoryDraft,
              source,
            );
    if (request === null) return;
    const submission = beginSubmission();
    if (!submission) return;
    try {
      await runOrgCreate(request, submission);
    } finally {
      endSubmission();
    }
  };

  const handleCreateOrgProject = async (): Promise<void> => {
    const resume = orgResume?.source === 'create' ? orgResume : null;
    const name = workspaceName.trim();
    if (resume === null && !name) {
      setOrgError({
        source: 'create',
        error: { kind: 'failed', message: 'Project name is required' },
      });
      return;
    }
    const multiRepo = workspaceType === 'multi-repo';
    const submission = beginSubmission();
    if (!submission) return;
    try {
      const cowork = workspaceType === 'cowork';
      await runOrgCreate(
        resume ?? {
          source: 'create',
          kind: cowork ? 'cowork' : multiRepo ? 'multi-repo' : 'code',
          name,
          ...(privateMemoryDraft ? { privateMemory: true } : {}),
          folderPath: null,
          linked: false,
          // Starting points seed a Cowork project; a Code project has none.
          blueprint:
            cowork && selectedBlueprint !== null
              ? {
                  externalId: selectedBlueprint.externalId,
                  contentHash: selectedBlueprint.contentHash,
                }
              : null,
          organizationProjectId: null,
          localWorkspaceId: null,
        },
        submission,
      );
    } finally {
      endSubmission();
    }
  };

  const performCloneRemote = async (
    normalizedUrl: string,
    normalizedDestination: string,
    submission: Submission,
  ): Promise<void> => {
    if (context?.kind === 'organization') {
      // An organization's clone (CAN-3984) only clones; the organization's
      // own create then checks and registers the folder, as Existing folder
      // does. It is never a Personal project on the way, so it stays in this
      // dialog rather than moving to the sidebar's clone progress. A failed
      // registration leaves the clone where it is, to reuse or retry.
      const folder = await window.api
        .addRemoteRepo({
          remoteUrl: normalizedUrl,
          destinationDir: normalizedDestination,
        })
        .catch(() => {
          throw new Error(REPOSITORY_CLONE_FAILURE_MESSAGE);
        });
      if (!isCurrent(submission)) return;
      await addOrgFolder(context.organizationId, folder, submission, {
        source: 'remote',
        remoteUrl: normalizedUrl,
        destinationDir: normalizedDestination,
      });
      return;
    }
    const jobId = crypto.randomUUID();
    const clone = addRemoteRepo(normalizedUrl, normalizedDestination, {
      jobId,
    }).catch((error: unknown) => {
      throw new Error(remoteWorkspaceFailureMessage(error));
    });
    // A clone that outlives the hand-off delay moves to the sidebar's clone
    // progress pill so a large repository never holds this dialog hostage.
    // Its outcome is then announced by the clone progress dialog; this
    // dialog closes without selecting or navigating. The hand-off happens
    // even if the user already dismissed the dialog, so the clone stays
    // visible and cancellable.
    const settledFirst = await Promise.race([
      clone.then(
        () => true,
        () => true,
      ),
      waitForCloneHandoff().then(() => false),
    ]);
    if (!settledFirst) {
      const handedOff = await window.api
        .backgroundCloneJob(jobId)
        .catch((error: unknown): boolean => {
          // The clone stays in this dialog instead.
          reportClientAppError(error);
          return false;
        });
      if (handedOff) {
        // The clone outlives this dialog, so the choice made here is saved
        // when the project lands. Nothing opens it automatically.
        void clone.then(
          async (workspaceId): Promise<void> => {
            // A handed-off clone never reaches onWorkspaceCreated, so the
            // Cursor rules offer (CAN-2053) that AddWorkspaceModalHost makes
            // for every other new project is made here when it lands.
            if (workspaceId)
              void offerCursorRulesReview([{ workspaceId }], 'add-project');
            if (!workspaceId || !privateMemorySelected) return;
            await saveWorkspacePrivateMemory(workspaceId, true).catch(
              reportPrivateMemoryNotApplied,
            );
          },
          (): void => undefined,
        );
        if (isCurrent(submission)) onClose();
        return;
      }
    }
    const workspaceId = await clone;
    await finishWorkspace(workspaceId, submission, { cowork: false });
  };

  // Remote's add: reuse a matching clone at the destination, or clone.
  const probeAndClone = async (
    normalizedUrl: string,
    normalizedDestination: string,
    submission: Submission,
  ): Promise<void> => {
    const probe = await window.api.probeCloneDestination({
      remoteUrl: normalizedUrl,
      destinationDir: normalizedDestination,
    });
    if (!isCurrent(submission)) return;
    if (probe.reusablePath) {
      setReuseChoice(null);
      setReuseClonePrompt({
        remoteUrl: normalizedUrl,
        destinationDir: normalizedDestination,
        reusablePath: probe.reusablePath,
      });
      return;
    }
    preAddPending.current = false;
    await performCloneRemote(normalizedUrl, normalizedDestination, submission);
  };

  const handleCloneRemote = async (): Promise<void> => {
    if (submitting.current) return;
    setError('');
    let normalizedUrl = normalizeRepositoryCloneUrl(remoteUrl);
    if (remoteSource === 'github') {
      if (!selectedRepo) {
        setError('Choose a repository.');
        return;
      }
      normalizedUrl = normalizeRepositoryCloneUrl(selectedRepo.cloneUrl);
    }
    if (!normalizedUrl) {
      setError('Enter a repository URL.');
      return;
    }
    const normalizedDestination = destinationDir.trim();
    if (!normalizedDestination) {
      setError('Choose a folder to download to.');
      return;
    }
    const submission = beginSubmission();
    if (!submission) return;
    preAddPending.current = true;
    setOrgOwnerNudge(null);
    try {
      const owner = await findRepositoryOwner({ remoteUrl: normalizedUrl });
      if (!isCurrent(submission)) return;
      if (owner !== null) {
        // Nothing is probed or cloned until the member chooses where.
        setOrgOwnerNudge({
          owner,
          pending: {
            kind: 'remote',
            remoteUrl: normalizedUrl,
            destinationDir: normalizedDestination,
          },
        });
        return;
      }
      await probeAndClone(normalizedUrl, normalizedDestination, submission);
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && isCurrent(submission))
        setErrorFailure(remoteAddFailure(appError));
    } finally {
      endSubmission();
    }
  };

  // "Add to <current scope>": exactly the add the member started,
  // without asking again for this pick.
  const handleContinueHere = async (): Promise<void> => {
    const nudge = orgOwnerNudge;
    if (nudge === null) return;
    const submission = beginSubmission();
    if (!submission) return;
    setOrgOwnerNudge(null);
    if (nudge.pending.kind === 'remote') preAddPending.current = true;
    try {
      if (nudge.pending.kind === 'existing')
        await addExistingFolder(nudge.pending.folder, submission);
      else
        await probeAndClone(
          nudge.pending.remoteUrl,
          nudge.pending.destinationDir,
          submission,
        );
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (!appError) return;
      if (nudge.pending.kind === 'existing')
        reportExistingFailure(appError, submission);
      else if (isCurrent(submission))
        setErrorFailure(remoteAddFailure(appError));
    } finally {
      endSubmission();
    }
  };

  // "Add to <organization>": switch the sidebar scope and continue the same
  // add there. A refused switch keeps this draft and adds nothing.
  const handleAddToOrganization = async (): Promise<void> => {
    const nudge = orgOwnerNudge;
    if (nudge === null) return;
    const submission = beginSubmission();
    if (!submission) return;
    const target: WorkspaceContext = {
      kind: 'organization',
      organizationId: nudge.owner.organizationId,
    };
    const targetIdentity = addWorkspaceDraftIdentity(
      submission.accountEpoch,
      target,
    );
    pendingHandoff = {
      identity: targetIdentity,
      handoff:
        nudge.pending.kind === 'existing'
          ? { kind: 'existing', folder: nudge.pending.folder }
          : {
              kind: 'remote',
              projectId: nudge.owner.projectId,
              destinationDir: nudge.pending.destinationDir,
            },
    };
    try {
      await useWorkspaceContextStore.getState().setContext(target);
    } catch (cause) {
      dropAddWorkspaceHandoff(targetIdentity);
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && alive.current)
        setErrorFailure(
          inlineFailure(
            appError,
            orgRepositoryOwnerSwitchFailure(nudge.owner.organizationName),
          ),
        );
    } finally {
      endSubmission();
    }
  };

  const ownerNudgeNotice =
    orgOwnerNudge === null ? null : (
      <OrgRepositoryOwnerNotice
        // A folder is named as the member sees it; a clone's folder name is
        // only decided once it is cloned, so it keeps `owner/name`.
        repositoryName={
          orgOwnerNudge.pending.kind === 'existing'
            ? orgOwnerNudge.pending.folder.name
            : orgOwnerNudge.owner.repositoryName
        }
        organizationName={orgOwnerNudge.owner.organizationName}
        currentScopeName={inOrganization ? organizationName : 'Personal'}
        pending={isSubmitting}
        onAddToOrganization={(): void => {
          void handleAddToOrganization();
        }}
        onContinue={(): void => {
          void handleContinueHere();
        }}
      />
    );
  const existingNudgeFolder =
    orgOwnerNudge?.pending.kind === 'existing'
      ? orgOwnerNudge.pending.folder
      : null;

  const handleReuseExistingClone = async (): Promise<void> => {
    if (!reuseClonePrompt) return;
    const submission = beginSubmission();
    if (!submission) return;
    try {
      if (context?.kind === 'organization') {
        const reused = reuseClonePrompt;
        setReuseClonePrompt(null);
        await addOrgFolder(
          context.organizationId,
          {
            path: reused.reusablePath,
            name: folderNameFromPath(reused.reusablePath),
          },
          submission,
          {
            source: 'remote',
            remoteUrl: reused.remoteUrl,
            destinationDir: reused.destinationDir,
          },
        );
        return;
      }
      const workspace = await addLocalRepo(reuseClonePrompt.reusablePath, {
        activate: false,
      });
      await finishWorkspace(workspace?.id ?? null, submission, {
        cowork: workspace?.type === 'cowork',
      });
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && isCurrent(submission))
        setErrorFailure(inlineFailure(appError, "Couldn't add this copy."));
    } finally {
      endSubmission();
    }
  };

  const handleCloneNewCopy = async (): Promise<void> => {
    if (!reuseClonePrompt) return;
    const submission = beginSubmission();
    if (!submission) return;
    try {
      if (inOrganization) setReuseClonePrompt(null);
      await performCloneRemote(
        reuseClonePrompt.remoteUrl,
        reuseClonePrompt.destinationDir,
        submission,
      );
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && isCurrent(submission))
        setErrorFailure(remoteAddFailure(appError));
    } finally {
      endSubmission();
    }
  };

  const handleBrowseCloneDir = async (): Promise<void> => {
    const submission = beginSubmission();
    if (!submission) return;
    // The picker locks the form, but nothing is cloning yet.
    setBrowsingCloneDir(true);
    try {
      const result = await window.api.browseForCloneDirectory();
      if (isCurrent(submission) && !result.canceled && result.directoryPath)
        setDestinationDir(result.directoryPath);
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && isCurrent(submission))
        setErrorFailure(
          inlineFailure(appError, "Couldn't open the folder picker."),
        );
    } finally {
      if (alive.current) setBrowsingCloneDir(false);
      endSubmission();
    }
  };

  const handleCreateTemporaryWorkspace = async (): Promise<void> => {
    if (submitting.current) return;
    setError('');

    if (selectedTemporaryWorkspaceIds.length === 0) {
      setError('Choose at least one project');
      return;
    }

    const submission = beginSubmission();
    if (!submission) return;

    try {
      const response =
        await window.api.createTemporaryWorkspaceWorktreeFromWorkspaces({
          workspaceIds: selectedTemporaryWorkspaceIds,
        });
      if (!isCurrent(submission)) return;
      if ('needsRepair' in response.worktree && response.worktree.needsRepair) {
        await loadProjects();
        if (!isCurrent(submission)) return;
        setError(
          response.worktree.repairIssues
            .map((issue) => issue.message)
            .join('\n'),
        );
        return;
      }
      useProjectsStore.setState((state) => ({
        projects: ensureWorkspaceAvailableInProjects(
          state.projects,
          response.workspace,
        ),
      }));
      const finalized = await registerCreatedWorkspaceWorktree(
        response.workspace.id,
        {
          id: response.worktree.id,
          branchName: response.worktree.branchName,
          createdAt: response.worktree.createdAt,
          setupPhase: response.worktree.setupPhase ?? 'git-ready',
          ...('trackedBaseBranch' in response.worktree &&
          response.worktree.trackedBaseBranch != null
            ? {
                trackedBaseBranch: response.worktree.trackedBaseBranch,
              }
            : {}),
          ...('trackedRepoBaseBranches' in response.worktree &&
          response.worktree.trackedRepoBaseBranches
            ? {
                trackedRepoBaseBranches:
                  response.worktree.trackedRepoBaseBranches,
              }
            : {}),
        },
        {
          select: false,
        },
      );
      if (!isCurrent(submission)) return;
      if (!finalized) {
        await loadProjects();
        if (!isCurrent(submission)) return;
        setError("Couldn't create the temporary worktree.");
        return;
      }
      void loadProjects({ silent: true });
      await completeWorkspace(response.workspace.id, submission, {
        cowork: false,
        worktreeId: finalized.id,
      });
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && isCurrent(submission))
        setErrorFailure(
          inlineFailure(appError, "Couldn't create the temporary worktree."),
        );
    } finally {
      endSubmission();
    }
  };

  const handleCreateWorkspace = async (): Promise<void> => {
    if (submitting.current) return;
    setError('');

    if (inOrganization) {
      await handleCreateOrgProject();
      return;
    }

    if (workspaceType === 'temporary') {
      await handleCreateTemporaryWorkspace();
      return;
    }

    const name = workspaceName.trim();
    if (!name) {
      setError('Project name is required');
      return;
    }

    const submission = beginSubmission();
    if (!submission) return;

    try {
      if (workspaceType === 'multi-repo') {
        const createdWorkspaceId = await createWorkspace(name);
        await finishWorkspace(createdWorkspaceId, submission, {
          cowork: false,
          openSettings: true,
        });
      } else if (workspaceType === 'cowork') {
        // A curated seed is not an install: it stamps
        // `seededFromBlueprintExternalId` and never claims install lineage, so
        // the same Blueprint can start as many projects as the user likes.
        const seeded = selectedSharedTemplate
          ? await createChatProjectFromSharedTemplate(
              selectedSharedTemplate,
              name,
            )
          : selectedBlueprint
            ? await createChatProjectFromBlueprint(selectedBlueprint, name)
            : null;
        const project = seeded ? seeded.project : await createChatProject(name);
        projectCreated.current = true;
        if (!isCurrent(submission)) return;
        await loadProjects({ silent: true });
        const unresolvedRefCount = seeded ? seeded.unresolvedRefs.length : 0;
        await finishWorkspace(
          project.id,
          submission,
          { cowork: true },
          // A Blueprint's plugin and skill refs are applied on the way in, and
          // a ref this device cannot resolve is reported, never fatal: the
          // project already landed with everything that did resolve, so this
          // warns after the navigation rather than blocking the create.
          unresolvedRefCount > 0
            ? (): void => {
                // `forceInApp` is exactly the documented case for this meta
                // flag: the modal that started the create is already gone, so
                // without it the only report of a half-applied Blueprint could
                // be suppressed by the in-app master toggle and the user would
                // never learn anything was missing.
                addToast(
                  formatUnresolvedCapabilitiesNotice(unresolvedRefCount),
                  'warning',
                  undefined,
                  {
                    category: 'Chat',
                    forceInApp: true,
                    title: 'Project added',
                  },
                );
              }
            : undefined,
        );
      } else {
        const createdWorkspaceId = await initLocalRepo(name);
        await finishWorkspace(createdWorkspaceId, submission, {
          cowork: false,
        });
      }
    } catch (cause) {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError && isCurrent(submission))
        setErrorFailure(
          inlineFailure(appError, "Couldn't create the project."),
        );
    } finally {
      endSubmission();
    }
  };

  // The organization folder this option chose or cloned. A clone shows only
  // while the Remote inputs still name it: other inputs clone afresh.
  const remoteTargetUrl = normalizeRepositoryCloneUrl(
    remoteSource === 'github' ? (selectedRepo?.cloneUrl ?? '') : remoteUrl,
  );
  const orgFolderForMode =
    !inOrganization || orgFolder === null
      ? null
      : mode === 'existing' && orgFolderOrigin.source === 'existing'
        ? orgFolder
        : mode === 'remote' &&
            orgFolderOrigin.source === 'remote' &&
            orgFolderOrigin.remoteUrl === remoteTargetUrl &&
            orgFolderOrigin.destinationDir === destinationDir.trim()
          ? orgFolder
          : null;
  const orgFolderLinked =
    orgFolderForMode !== null && orgLinkedProject !== null;
  const orgFolderOutcome =
    orgFolderForMode === null ? null : (
      <Stack gap="inline">
        <ChosenFolderPath
          path={orgFolderForMode.path}
          testId="add-workspace-org-folder-path"
          {...(mode === 'existing'
            ? {
                onChange: (): void => void handleBrowseExisting(),
                changeDisabled: isSubmitting || orgRetrying,
              }
            : {})}
        />
        {orgFolderCheck !== null && (
          <OrgFolderOutcome
            organizationName={organizationName}
            folderCheck={orgFolderCheck}
            personalProjectName={
              (orgFolderInspection?.kind === 'code' ||
                orgFolderInspection?.kind === 'multi-repo') &&
              orgFolderInspection.personalWorkspaceId !== undefined
                ? (projects.find(
                    (project): boolean =>
                      project.id === orgFolderInspection.personalWorkspaceId,
                  )?.name ?? null)
                : null
            }
          />
        )}
      </Stack>
    );
  const orgFolderAddButton =
    orgFolderForMode !== null && orgFolderAddOffered ? (
      <Button
        variant="primary"
        size="sm"
        data-testid={
          orgRetrying
            ? 'add-workspace-org-retry'
            : 'add-workspace-org-folder-add'
        }
        onClick={() => void handleAddOrgFolder()}
        disabled={isSubmitting || orgErrorShown?.kind === 'limit-reached'}
      >
        {isSubmitting
          ? orgRetrying
            ? 'Setting up…'
            : 'Adding…'
          : orgRetrying
            ? 'Try again'
            : 'Add project'}
      </Button>
    ) : null;

  // New organization definitions use the same choice, which the server then
  // owns. A linked definition already has its authoritative value.
  const privateMemoryField =
    inOrganization && (mode === 'catalog' || orgFolderLinked) ? null : (
      <PrivateMemoryInlineToggle
        checked={privateMemoryDraft}
        onChange={setPrivateMemoryDraft}
        disabled={orgRetrying}
        dataTestId="add-workspace-private-memory"
      />
    );
  const scopeName = inOrganization ? organizationName : 'Personal';
  // The drop area waits for a folder; a chosen one shows its path instead.
  const existingFolderPending =
    orgFolderForMode !== null ||
    existingNudgeFolder !== null ||
    orgConflict !== null;

  return (
    <DialogModal
      onClose={dismiss}
      title={`Add project to ${scopeName}`}
      titleId="add-workspace-title"
      dataTestId="add-workspace-modal"
      maxWidth="xl"
      // Panels differ in height; a pinned top edge keeps the tiles in place
      // while the card grows down (CAN-3909).
      placement="top"
    >
      {privateMemoryPending !== null && (
        <div>
          <Notice
            intent="attention"
            data-testid="add-workspace-private-memory-failed"
            actions={
              <NoticeButton
                variant="primary"
                data-testid="add-workspace-private-memory-retry"
                disabled={isSubmitting}
                onClick={() => void handleRetryPrivateMemory()}
              >
                {isSubmitting ? 'Saving…' : 'Try again'}
              </NoticeButton>
            }
          >
            The project was added, but Private memory isn&apos;t on yet. Try
            again before you open it.
          </Notice>
        </div>
      )}
      <fieldset
        // A project waiting on its Private memory save locks the form, so the
        // only way forward is to finish that project rather than add another.
        disabled={isSubmitting || privateMemoryPending !== null}
        className="flex min-h-0 min-w-0 flex-col gap-4 text-s"
        data-testid="add-workspace-drop-target"
        onDragOver={handleFolderDragOver}
        onDragLeave={handleFolderDragLeave}
        onDrop={handleFolderDrop}
      >
        {contextChanged && (
          <Notice data-testid="add-workspace-context-changed">
            {`You're now in ${scopeName}, so this form was cleared.`}
          </Notice>
        )}
        <div
          ref={choiceRow}
          onFocusCapture={(event): void => {
            catalogFocused.current =
              event.target instanceof HTMLElement &&
              event.target.dataset.testid === 'add-workspace-mode-catalog';
          }}
          onBlurCapture={(event): void => {
            if (event.relatedTarget !== null) catalogFocused.current = false;
          }}
          // An organization keeps room for its catalog tile while create
          // eligibility resolves; a withheld catalog without Remote leaves two.
          className={`grid gap-2 ${
            (catalogWithheld && !orgRemoteAvailable) || cloudSetupAvailable
              ? 'sm:grid-cols-2'
              : 'sm:grid-cols-3'
          }`}
        >
          {cloudSetupAvailable && (
            <ProjectChoiceCard
              testId="add-workspace-mode-cloud"
              selected={mode === 'cloud'}
              onSelect={() => selectMode('cloud')}
              icon={<CloudBackendIcon className="shrink-0" />}
              title="From another computer"
              description="Set up a project you use elsewhere"
            />
          )}
          {inOrganization && !catalogWithheld && (
            <ProjectChoiceCard
              testId="add-workspace-mode-catalog"
              selected={mode === 'catalog'}
              onSelect={() => selectMode('catalog')}
              icon={<BuildingIcon size="sm" className="shrink-0" />}
              title={orgCatalogOption.label}
              description={orgCatalogOption.scopedSummary}
            />
          )}
          {CHOICE_ORDER[navigationMode].map((choice) => {
            switch (choice) {
              case 'remote':
                return (
                  (!inOrganization || orgRemoteAvailable) && (
                    <ProjectChoiceCard
                      key={choice}
                      testId="add-workspace-mode-remote"
                      selected={mode === 'remote'}
                      onSelect={() => selectMode('remote')}
                      icon={<GitHubIcon className="shrink-0" />}
                      title="Clone repository"
                      description="GitHub or a URL"
                    />
                  )
                );
              case 'existing':
                return (
                  existingAvailable && (
                    <ProjectChoiceCard
                      key={choice}
                      testId="add-workspace-mode-existing"
                      selected={mode === 'existing'}
                      onSelect={() => selectMode('existing')}
                      icon={<FolderIcon className="shrink-0" />}
                      title={
                        navigationMode === 'work'
                          ? 'Use a folder'
                          : 'Existing folder'
                      }
                      description={
                        navigationMode === 'work'
                          ? 'Work with files already on this computer'
                          : 'On this computer'
                      }
                    />
                  )
                );
              case 'create':
                return (
                  (!inOrganization || orgCreateAvailable) && (
                    <ProjectChoiceCard
                      key={choice}
                      testId="add-workspace-mode-create"
                      selected={mode === 'create'}
                      onSelect={() => selectMode('create')}
                      icon={<FolderPlusIcon className="shrink-0" />}
                      title="Create new"
                      description="Start fresh"
                    />
                  )
                );
            }
          })}
        </div>

        {context?.kind === 'organization' && mode === 'catalog' && (
          <AddOrgProjectCatalog
            context={context}
            organization={organization}
            session={orgCatalogSession}
            onClose={onClose}
            onAddActivityChange={(delta): void => {
              catalogAddsInFlight.current += delta;
            }}
            {...(catalogHandoff === null
              ? {}
              : {
                  initialAddProjectId: catalogHandoff.projectId,
                  initialDestination: catalogHandoff.destinationDir,
                })}
          />
        )}

        {!inOrganization && mode === 'cloud' && (
          <AddCloudProjectSetup
            onClose={onClose}
            onWorkspaceCreated={(workspaceId): void =>
              onWorkspaceCreated?.(workspaceId)
            }
          />
        )}

        {inOrganization && mode !== 'catalog' && (
          <OrgProjectOwnershipNotice
            organizationName={organizationName}
            requiresActivitySharing={orgRequiresActivitySharing}
          />
        )}
        {orgErrorShown !== null && (
          <OrgProjectCreateErrorNotice error={orgErrorShown} />
        )}

        {mode === 'existing' && (
          <Stack gap="item" data-testid="add-workspace-existing-panel">
            {inOrganization && !orgCodeAvailable && (
              <p
                className="text-xs fg-secondary"
                data-testid="add-workspace-existing-description"
              >
                {`The folder is added as a ${CHAT_LABEL} project, and its files stay where they are. If it's a git repository, branches, worktrees and other git features aren't available.`}
              </p>
            )}
            {!inOrganization && navigationMode === 'work' && (
              <p
                className="text-xs fg-secondary"
                data-testid="add-workspace-existing-description"
              >
                Your files stay where they are.
              </p>
            )}
            {!existingFolderPending && (
              <Surface
                variant="dashed"
                selected={folderDragActive}
                data-testid="add-workspace-folder-drop"
                data-drag-active={folderDragActive || undefined}
              >
                <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
                  <p className="text-s fg-secondary">
                    Drop a folder here, or choose one from this computer
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="add-workspace-choose-folder"
                    onClick={() => void handleBrowseExisting()}
                    disabled={isSubmitting || orgRetrying}
                  >
                    <FolderIcon className="shrink-0" />
                    {browsingExisting
                      ? 'Opening…'
                      : isSubmitting
                        ? 'Adding…'
                        : 'Choose folder'}
                  </Button>
                </div>
              </Surface>
            )}
            {!inOrganization && orgConflict !== null && (
              <OrgFolderConflictNotice
                resolution={conflictResolution}
                switchFailedOrganizationName={
                  orgConflict.switchFailed &&
                  (conflictResolution?.status === 'ready' ||
                    conflictResolution?.status === 'unfinished')
                    ? conflictResolution.organizationName
                    : null
                }
                busy={isSubmitting}
                onOpen={() => void handleOrgConflictAction()}
                onRetry={() => void handleOrgConflictRetry()}
                onChooseAnother={() => void handleBrowseExisting()}
              />
            )}
            {orgFolderOutcome}
            {existingNudgeFolder !== null && (
              <>
                <ChosenFolderPath
                  path={existingNudgeFolder.path}
                  testId="add-workspace-org-owner-folder-path"
                  onChange={() => void handleBrowseExisting()}
                  changeDisabled={isSubmitting}
                />
                {ownerNudgeNotice}
              </>
            )}
            {/* The conflict and the nudge carry their own choices. */}
            {orgConflict === null &&
              existingNudgeFolder === null &&
              (privateMemoryField !== null || orgFolderAddButton !== null) && (
                <div className="flex items-center justify-between gap-4">
                  {privateMemoryField ?? <span />}
                  {orgFolderAddButton}
                </div>
              )}
          </Stack>
        )}

        {mode === 'remote' && (
          <Stack data-testid="add-workspace-remote-panel" gap="item">
            {canListRepos && (
              <SegmentedControl
                label="Source"
                width="content"
                value={remoteSource}
                onChange={handleRemoteSourceSelect}
                dataTestId="add-workspace-remote-source"
                options={[
                  {
                    value: 'github',
                    label: 'GitHub',
                    dataTestId: 'add-workspace-remote-source-github',
                  },
                  {
                    value: 'url',
                    label: 'URL',
                    dataTestId: 'add-workspace-remote-source-url',
                  },
                ]}
              />
            )}

            {remoteSource === 'github' && canListRepos ? (
              <GitHubRepoPicker
                repos={filteredRepos}
                totalCount={repos?.length ?? 0}
                loading={repoFetchState === 'loading'}
                error={reposError}
                search={repoSearch}
                onSearchChange={setRepoSearch}
                selectedFullName={selectedRepoFullName}
                onSelect={setSelectedRepoFullName}
                onRetry={() => setRepoFetchState('idle')}
                testId="add-workspace-github-repo-list"
              />
            ) : (
              <DialogFormField
                label="Repository URL"
                htmlFor="add-workspace-remote-url-input"
              >
                <TextInput
                  id="add-workspace-remote-url-input"
                  data-testid="add-workspace-remote-url-input"
                  value={remoteUrl}
                  onChange={(event) => setRemoteUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                />
              </DialogFormField>
            )}

            <ChosenFolderPath
              label="Downloads to"
              path={destinationDir}
              testId="add-workspace-clone-destination"
              onChange={() => void handleBrowseCloneDir()}
              changeDisabled={isSubmitting}
              changeTestId="add-workspace-clone-destination-change"
              changeLabel="Change download folder"
            />

            {orgFolderOutcome}

            {reuseClonePrompt ? (
              <Notice
                intent="attention"
                data-testid="add-workspace-reuse-clone"
                title="This repository is already cloned here."
                actionsPlacement="below"
                actions={
                  <>
                    <NoticeButton
                      data-testid="add-workspace-reuse-clone-new"
                      disabled={isSubmitting}
                      onClick={() => {
                        setReuseChoice('new');
                        void handleCloneNewCopy();
                      }}
                    >
                      {isSubmitting &&
                      !browsingCloneDir &&
                      reuseChoice === 'new'
                        ? 'Cloning…'
                        : 'Create a new copy'}
                    </NoticeButton>
                    <NoticeButton
                      variant="primary"
                      data-testid="add-workspace-reuse-clone-existing"
                      disabled={isSubmitting}
                      onClick={() => {
                        setReuseChoice('existing');
                        void handleReuseExistingClone();
                      }}
                    >
                      {isSubmitting &&
                      !browsingCloneDir &&
                      reuseChoice === 'existing'
                        ? 'Adding…'
                        : 'Use this copy'}
                    </NoticeButton>
                  </>
                }
              >
                <span className="break-all font-mono text-xs">
                  {reuseClonePrompt.reusablePath}
                </span>
              </Notice>
            ) : orgOwnerNudge?.pending.kind === 'remote' ? (
              ownerNudgeNotice
            ) : (
              <div className="flex items-center justify-between gap-4">
                {privateMemoryField ?? <span />}
                {/* A cloned folder waiting on the member, or a set up to try
                    again: finish it rather than clone again. */}
                {orgFolderAddButton ?? (
                  <Button
                    variant="primary"
                    size="sm"
                    data-testid="add-workspace-clone-submit"
                    onClick={() => void handleCloneRemote()}
                    disabled={
                      isSubmitting ||
                      (remoteSource === 'github' && !selectedRepoFullName)
                    }
                  >
                    {isSubmitting && !browsingCloneDir
                      ? 'Cloning…'
                      : 'Clone and add'}
                  </Button>
                )}
              </div>
            )}
          </Stack>
        )}

        {mode === 'create' && (
          <Stack gap="item">
            {/* An organization takes a member's single-repo, multi-repo and
                Cowork projects. Without the Code capability Cowork is the only
                kind, so there is nothing to choose. */}
            <div className="flex flex-col gap-1.5">
              {(!inOrganization || orgCodeAvailable) && (
                <SegmentedControl
                  label="Project type"
                  width="content"
                  value={workspaceType}
                  onChange={setWorkspaceType}
                  disabled={orgRetrying}
                  dataTestId="add-workspace-type"
                  options={[
                    {
                      value: 'single-repo',
                      label: 'New repository',
                      dataTestId: 'add-workspace-type-single-repo',
                      leading: (
                        <SingleRepoWorkspaceIcon
                          size="sm"
                          className="shrink-0"
                        />
                      ),
                    },
                    {
                      value: 'cowork',
                      label: CHAT_LABEL,
                      dataTestId: 'add-workspace-type-cowork',
                      leading: (
                        <CoworkWorkspaceIcon size="sm" className="shrink-0" />
                      ),
                    },
                    {
                      value: 'multi-repo',
                      label: 'Multi-repo',
                      dataTestId: 'add-workspace-type-multi-repo',
                      leading: <MultiRepoIcon size="sm" className="shrink-0" />,
                    },
                    ...(inOrganization
                      ? []
                      : [
                          {
                            value: 'temporary' as const,
                            label: 'Temporary',
                            dataTestId: 'add-workspace-type-temporary',
                            unavailable: temporaryWorkspaceTypeDisabled,
                            ...(temporaryWorkspaceTypeDisabled
                              ? {
                                  tooltip: TEMPORARY_WORKSPACE_DISABLED_TOOLTIP,
                                }
                              : {}),
                            leading: (
                              <TemporaryMultiRepoIcon
                                size="sm"
                                className="shrink-0"
                              />
                            ),
                          },
                        ]),
                  ]}
                />
              )}
              <p
                className="text-xs fg-secondary"
                data-testid="add-workspace-type-description"
              >
                {CREATE_TYPE_DESCRIPTIONS[workspaceType]}
              </p>
            </div>

            {blueprintPickerVisible && (
              <BlueprintPicker
                blueprints={blueprintCatalog.blueprints}
                sharedTemplates={
                  inOrganization ? [] : blueprintCatalog.sharedTemplates
                }
                loading={blueprintCatalog.loading}
                unavailable={blueprintCatalog.unavailable}
                selectedExternalId={selectedBlueprintId}
                onSelect={setSelectedBlueprintId}
                onRetry={blueprintCatalog.refresh}
                disabled={isSubmitting || orgRetrying}
              />
            )}

            {workspaceType === 'temporary' ? (
              temporaryWorkspaceOptions.length === 0 ? (
                <p className="text-xs fg-secondary">
                  Add a project first, then combine it with others here.
                </p>
              ) : (
                <WorkspaceMultiSelectPicker
                  options={temporaryWorkspaceOptions}
                  selectedWorkspaceIds={selectedTemporaryWorkspaceIds}
                  onToggleWorkspace={handleToggleTemporaryWorkspace}
                  searchQuery={temporaryWorkspaceSearch}
                  onSearchQueryChange={setTemporaryWorkspaceSearch}
                  label="Projects"
                  emptyMessage="No matching projects"
                  testIdPrefix="add-temporary-workspace-picker"
                />
              )
            ) : (
              <Stack gap="inline">
                <FormSectionHeading
                  title="Project name"
                  id="add-workspace-name-heading"
                />
                <TextInput
                  id="add-workspace-name-input"
                  aria-labelledby="add-workspace-name-heading"
                  data-testid="add-workspace-name-input"
                  value={workspaceName}
                  disabled={orgRetrying}
                  // The organization project's server-side name limit.
                  maxLength={inOrganization ? 256 : undefined}
                  onChange={(event) => {
                    setWorkspaceName(event.target.value);
                    if (
                      orgError?.source === 'create' &&
                      orgError.error.kind === 'failed'
                    )
                      setOrgError(null);
                  }}
                  placeholder={
                    navigationMode === 'work' && workspaceType !== 'single-repo'
                      ? 'Thursday design review'
                      : 'my-project'
                  }
                />
              </Stack>
            )}
            <div className="flex items-center justify-between gap-4">
              {workspaceType !== 'temporary' && privateMemoryField !== null ? (
                privateMemoryField
              ) : (
                <span />
              )}
              <Button
                variant="primary"
                size="sm"
                data-testid={
                  orgRetrying
                    ? 'add-workspace-org-retry'
                    : 'add-workspace-create-submit'
                }
                onClick={() => void handleCreateWorkspace()}
                disabled={
                  isSubmitting ||
                  orgErrorShown?.kind === 'limit-reached' ||
                  (workspaceType === 'temporary' &&
                    selectedTemporaryWorkspaceIds.length === 0)
                }
              >
                {isSubmitting
                  ? orgRetrying
                    ? 'Setting up…'
                    : 'Creating…'
                  : orgRetrying
                    ? 'Try again'
                    : workspaceType === 'temporary'
                      ? 'Create worktree'
                      : workspaceType === 'cowork'
                        ? `Create ${CHAT_LABEL} project`
                        : 'Create project'}
              </Button>
            </div>
          </Stack>
        )}

        {/* A failure can name folders and quote git output. */}
        {error && mode === 'remote' ? (
          <RepositoryCloneError
            message={error.error}
            {...(error.details === undefined ? {} : { details: error.details })}
            displayPolicy={rendererAppErrorDisplayPolicy}
            reportAction={(defect): JSX.Element => (
              <DesktopReportThisAction
                error={defect}
                appName={brandText.appName}
              />
            )}
            testId="add-workspace-error"
          />
        ) : (
          <DesktopErrorBanner
            errorSource="add-workspace-error"
            className=""
            error={error?.error}
            details={error?.details}
            blockMessageFromReplay
            testId="add-workspace-error"
          />
        )}
      </fieldset>
    </DialogModal>
  );
}

/**
 * App-level host for the Add Workspace ({@link AddRepoModal}) flow.
 *
 * Previously the modal was rendered inside `WorktreeManager` (under
 * `MainPage`), so `openAddWorkspaceModal` had to force `activePage: 'main'` to
 * make it visible — which yanked the user off Home (or any other page) before
 * the modal even appeared. Hosting it here, alongside the other App-level
 * modal hosts (`ImportPlanModalHost`, `WatcherModalHost`, …), lets the modal
 * overlay whatever page is active while the underlying page stays put. The
 * `DialogModal` portals itself to `document.body`, so mounting point does not
 * affect stacking.
 *
 * The `onWorkspaceCreated` follow-through mirrors what `WorktreeManager` used
 * to do (multi-repo drafts open workspace settings on their Repositories tab;
 * a fresh empty single-repo workspace auto-creates its first worktree), and
 * additionally selects the new workspace in the Home composer picker so a
 * create-from-Home flow lands on it (Task H1 item 2 picker follow-up).
 */
export function AddWorkspaceModalHost(): JSX.Element {
  const isOpen = useNavigationStore((state) => state.addWorkspaceModalOpen);
  const initialRepoUrl = useNavigationStore(
    (state) => state.addWorkspaceInitialRepoUrl,
  );
  const initialProjectType = useNavigationStore(
    (state) => state.addWorkspaceInitialProjectType,
  );
  const closeAddWorkspaceModal = useNavigationStore(
    (state) => state.closeAddWorkspaceModal,
  );

  // Tracks whether a workspace was created during the current open session so
  // the close-transition effect below can distinguish a real creation (the
  // picker's resume effect will consume the `pendingCreateFromReference` stash)
  // from an abandoned modal (the stash must be cleared). Every creation path
  // calls `onClose()` before `onWorkspaceCreated()` synchronously, so this flag
  // is already set by the time the `[isOpen]` effect observes the close.
  const workspaceCreatedRef = useRef(false);
  const prevOpenRef = useRef(isOpen);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = isOpen;
    if (!wasOpen || isOpen) {
      return;
    }
    if (!workspaceCreatedRef.current) {
      // Modal closed without creating a workspace — drop any pending
      // create-from resume handoff so it can never reopen the picker later.
      useHomeComposerStore.getState().setPendingCreateFromReference(null);
    }
    workspaceCreatedRef.current = false;
  }, [isOpen]);

  const handleWorkspaceCreated = useCallback(
    (workspaceId: string, opts?: { openSettings?: boolean }): void => {
      workspaceCreatedRef.current = true;
      if (opts?.openSettings) {
        // Multi-repo draft: route to the workspace settings Repositories tab
        // (which lives under MainPage and legitimately navigates there). The
        // created flag above skips the closed-without-create cleanup of the
        // pending create-from stash that the helper drops.
        openCreatedMultiRepoWorkspaceSettings(workspaceId);
        return;
      }
      recordAutomationCreatedProject(workspaceId);

      // Preselect the new workspace in the Home composer picker regardless of
      // where the add flow was triggered from — harmless off Home, and the
      // required behavior when triggered from the Home picker's
      // "New project" row.
      navigateAfterRepositoryWorkspaceCreated(workspaceId);
      // A repository brought over from Cursor gets its rules review offered
      // right away instead of waiting in Settings (CAN-2053). Clones handed
      // off to the background make the same offer in AddRepoModal instead.
      void offerCursorRulesReview([{ workspaceId }], 'add-project');
    },
    [],
  );

  return (
    <AddRepoModal
      isOpen={isOpen}
      onClose={closeAddWorkspaceModal}
      onWorkspaceCreated={handleWorkspaceCreated}
      initialRepoUrl={initialRepoUrl}
      initialProjectType={initialProjectType}
    />
  );
}
