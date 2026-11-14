'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  Button,
  DelayedLoadingPlaceholder,
  DialogModal,
  EmptyState,
  ErrorBanner,
  FLOATING_MENU_GAP,
  FloatingMenu,
  LoadingButton,
  Notice,
  PrivateMemoryCard,
  PageSearchField,
  PageSearchRow,
  SegmentedControl,
  Skeleton,
  StatusPill,
  FormField,
  TextArea,
  TextInput,
  type ActionMenuItem,
  Heading,
} from '@canopy/ui-shared/components';
import { TeamPageHeaderActions } from './team-page-header-slot';
import {
  SETTINGS_GROUP_SURFACE_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  ArchiveIcon,
  EyeIcon,
  EyeOffIcon,
  Github,
  MoreHorizontalIcon,
  PencilIcon,
  Plus,
  ShieldAccessIcon,
  TrashIcon,
  UnarchiveIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  buildOrgProjectDeepLink,
  deriveOrgProjectPlaceholderState,
  isOrgProjectCatalogSetupSupported,
  ORG_PROJECT_LIMITS,
  type OrgProjectDetail,
  type OrgProjectGrant,
  type OrgProjectSummary,
  type OrgProjectPreference,
  type OrgProjectLifecycleAction,
  type OrgProjectRepositoryVerification,
} from '@canopy/protocol/org-projects';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { canManageProjects } from '@canopy/protocol/settings/organization-permissions';
import {
  SettingsConfirmDialog,
  useSettingsBrand,
  useSettingsClient,
  useSettingsPrivacy,
} from '../host';
import {
  useSettingsErrorCopy,
  useSettingsLoadFailure,
  type SettingsFailure,
} from '../errors';
import { GITHUB_PICKER_KNOWN_ERRORS } from '../github/github-organization-error-copy';
import {
  TeamProjectsGrantsEditor,
  principalKey,
} from './team-projects-grants-editor';
import {
  TeamProjectsCreateDialog,
  PROJECTS_ERROR_SCOPE,
  RequestNotice,
  requestFailure,
  type RequestFailure,
} from './team-projects-create-dialog';
import {
  refreshSummary,
  TeamProjectsRepositories,
} from './team-projects-repositories';
import { matchesProjectSearch } from './team-projects-display';
import { openDesktopDeepLink } from './desktop-handoff';
import { ProjectsSetupChecklist } from './team-projects-setup-checklist';
import {
  ORG_PROJECT_ROW_COLUMNS_CLASS,
  OrgProjectRow,
} from '../../org-projects/OrgProjectRow';
import { isOrgProjectAddAllowed } from '../../org-projects/OrgProjectCatalogList';
import {
  useOrganizationSettingsSlots,
  useOrgProjectLocalStatuses,
  type OrgProjectLocalStatus,
} from './organization-settings-slots';
import {
  applyOrganizationProjectLifecycle,
  getOrganizationProject,
  listOrganizationProjects,
  refreshOrganizationProjectsFromGitHub,
  replaceOrganizationProjectGrants,
  setOrganizationProjectPreference,
  TeamApiError,
  updateOrganizationProject,
} from './team-api';

interface TeamProjectsSectionProps {
  detail: OrganizationDetail;
  onDetailChange: (detail: OrganizationDetail) => void;
  orgLapsed?: boolean;
  projectsEnabled: boolean;
  /** The Add projects dialog; the page header opens it. */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  /** The Repositories dialog; the page header opens it. */
  repositoriesOpen: boolean;
  onRepositoriesOpenChange: (open: boolean) => void;
  /** Whether the header's Add projects applies: the list, not the checklist, leads. */
  onAddAvailableChange: (available: boolean) => void;
}

const STALE_MESSAGE =
  'This project changed in another tab. Reload and try again.';

/** The stale notice followed by why the re-read failed, keeping its details. */
function staleFailure(failure: SettingsFailure): SettingsFailure {
  return { ...failure, copy: `${STALE_MESSAGE} ${failure.copy}` };
}
const VERIFICATION_LABELS: Record<OrgProjectRepositoryVerification, string> = {
  VERIFIED: 'Verified',
  STALE: 'Stale',
  UNVERIFIED: 'Unverified',
};

/** Class tokens joined without stray whitespace when one is empty. */
function joinClasses(...classes: string[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * User content for a text-only slot (a dialog title). Blocked from session
 * replay in a span when the host has a block class; plain text otherwise.
 */
function privateText(text: string, blockClassName: string): ReactNode {
  return blockClassName === '' ? (
    text
  ) : (
    <span className={blockClassName}>{text}</span>
  );
}

type ProjectMutation = (
  project: OrgProjectSummary,
) => Promise<OrgProjectDetail>;
type ProjectSection = 'definition' | 'grants';

interface ManagedProjectOptions {
  growthDisabled: boolean;
  /** Holds mutations while the host list is changing underneath them. */
  blocked?: boolean;
  /** Mirrors a fresh definition into the host list. */
  onChanged: (fresh: OrgProjectDetail) => void;
}

interface ManagedProject {
  selected: OrgProjectDetail | null;
  initialSection: ProjectSection;
  deleting: OrgProjectSummary | null;
  busy: boolean;
  stale: boolean;
  error: SettingsFailure | null;
  setError: (error: SettingsFailure | null) => void;
  /** Applies a fresh definition to the host list and the open editor. */
  replace: (fresh: OrgProjectDetail) => void;
  open: (project: OrgProjectDetail, section: ProjectSection) => void;
  close: () => void;
  mutate: (
    project: OrgProjectSummary,
    operation: ProjectMutation,
  ) => Promise<void>;
  reload: () => Promise<OrgProjectDetail | null>;
  lifecycle: (
    project: OrgProjectSummary,
    action: OrgProjectLifecycleAction,
  ) => void;
  requestDelete: (project: OrgProjectSummary) => void;
  cancelDelete: () => void;
}

/**
 * The editor, lifecycle and delete-confirmation state for one organization
 * project at a time: every row's editor and ⋯ menu mutate, reload and
 * recover from conflicts the same way.
 */
function useManagedProject(
  detail: OrganizationDetail,
  { growthDisabled, blocked = false, onChanged }: ManagedProjectOptions,
): ManagedProject {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(PROJECTS_ERROR_SCOPE);
  const [selected, setSelected] = useState<OrgProjectDetail | null>(null);
  const [initialSection, setInitialSection] =
    useState<ProjectSection>('definition');
  const [deleting, setDeleting] = useState<OrgProjectSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);

  const replaceProject = (fresh: OrgProjectDetail): void => {
    onChanged(fresh);
    setSelected((current) =>
      current?.id === fresh.id
        ? fresh.state === 'DELETED'
          ? null
          : fresh
        : current,
    );
  };

  const mutate = async (
    project: OrgProjectSummary,
    operation: ProjectMutation,
  ): Promise<void> => {
    if (busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await operation(project);
      if (!alive.current) return;
      replaceProject(fresh);
      setDeleting(null);
    } catch (err) {
      if (!alive.current) return;
      setDeleting(null);
      if (err instanceof TeamApiError && err.status === 409) {
        setError({ copy: STALE_MESSAGE });
        setStale(true);
        try {
          const fresh = await getOrganizationProject(
            client,
            detail.id,
            project.id,
          );
          if (alive.current) replaceProject(fresh);
        } catch (refreshError) {
          if (alive.current)
            setError(
              staleFailure(
                errorCopy.actionFailure(refreshError, {
                  action: 'reload this project',
                }),
              ),
            );
        }
      } else {
        setError(
          errorCopy.actionFailure(err, { action: 'update this project' }),
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const reload = async (): Promise<OrgProjectDetail | null> => {
    if (!selected) return null;
    setBusy(true);
    try {
      const fresh = await getOrganizationProject(
        client,
        detail.id,
        selected.id,
      );
      if (!alive.current) return null;
      replaceProject(fresh);
      setStale(false);
      setError(null);
      return fresh;
    } catch (err) {
      if (alive.current)
        setError(
          errorCopy.actionFailure(err, { action: 'reload this project' }),
        );
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return {
    selected,
    initialSection,
    deleting,
    busy,
    stale,
    error,
    setError,
    replace: replaceProject,
    open: (project, section): void => {
      setError(null);
      setStale(false);
      setInitialSection(section);
      setSelected(project);
    },
    close: (): void => {
      if (!busy) {
        setSelected(null);
        setError(null);
      }
    },
    mutate,
    reload,
    lifecycle: (project, action): void => {
      if (action === 'restore' && growthDisabled) return;
      void mutate(project, (current) =>
        applyOrganizationProjectLifecycle(client, detail.id, current.id, {
          revision: current.revision,
          action,
        }),
      );
    },
    requestDelete: (project): void => {
      setError(null);
      setDeleting(project);
    },
    cancelDelete: (): void => setDeleting(null),
  };
}

interface ManagedProjectDialogsProps {
  managed: ManagedProject;
  detail: OrganizationDetail;
  growthDisabled: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/** The project editor and delete confirmation driven by {@link useManagedProject}. */
function ManagedProjectDialogs({
  managed,
  detail,
  growthDisabled,
  restoreFocusRef,
}: ManagedProjectDialogsProps): JSX.Element {
  const { selected, deleting } = managed;
  return (
    <>
      {selected && (
        <ProjectEditor
          key={selected.id}
          project={selected}
          detail={detail}
          initialSection={managed.initialSection}
          growthDisabled={growthDisabled}
          busy={managed.busy}
          stale={managed.stale}
          error={managed.error}
          onReload={managed.reload}
          onSave={(operation): Promise<void> =>
            managed.mutate(selected, operation)
          }
          onClose={managed.close}
        />
      )}
      {deleting && (
        <SettingsConfirmDialog
          title="Delete this project?"
          message="Members lose access to it and its setup state is removed from every desktop. This cannot be undone."
          confirmLabel="Delete project"
          busyLabel="Deleting…"
          busy={managed.busy}
          destructive
          restoreFocusRef={restoreFocusRef}
          onCancel={managed.cancelDelete}
          onConfirm={(): void => managed.lifecycle(deleting, 'delete')}
        />
      )}
    </>
  );
}

/**
 * The Projects page header's actions. The page shell owns the dialogs' open
 * state; the section reports whether Add projects applies right now.
 */
export function teamProjectsRepositoriesAvailable(
  detail: OrganizationDetail,
  projectsEnabled: boolean,
  orgLapsed = false,
): boolean {
  return (
    canManageProjects(detail.viewerRole) &&
    projectsEnabled &&
    !orgLapsed &&
    detail.githubConnection.connected
  );
}

interface TeamProjectsHeaderActionsProps {
  repositoriesAvailable: boolean;
  addAvailable: boolean;
  onAdd: () => void;
  onRepositories: () => void;
}

export function TeamProjectsHeaderActions({
  repositoriesAvailable,
  addAvailable,
  onAdd,
  onRepositories,
}: TeamProjectsHeaderActionsProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {repositoriesAvailable && (
        <Button
          size="compact"
          variant="secondary"
          data-testid="team-projects-repositories-open"
          onClick={onRepositories}
        >
          <Github size={14} />
          GitHub repositories
        </Button>
      )}
      {addAvailable && (
        <Button
          size="compact"
          variant="secondary"
          data-testid="team-projects-create"
          onClick={onAdd}
        >
          <Plus size={14} />
          Add projects
        </Button>
      )}
    </div>
  );
}

export function TeamProjectsSection(
  props: TeamProjectsSectionProps,
): JSX.Element {
  const managesProjects = canManageProjects(props.detail.viewerRole);
  return (
    <section
      data-testid="team-projects-section"
      className="flex flex-col gap-6"
    >
      {managesProjects || props.projectsEnabled ? (
        <ProjectList key={props.detail.id} {...props} />
      ) : null}
    </section>
  );
}

/** One project on the page: what every viewer sees, plus an admin's definition. */
interface ProjectRow {
  readonly summary: OrgProjectSummary;
  /** The management definition; null for a row only the member scope lists. */
  readonly detail: OrgProjectDetail | null;
}
type ProjectRows = ReadonlyMap<string, ProjectRow>;

const NO_ROWS: ProjectRows = new Map();
const MEMBER_PAGE_SIZE = 50;
/** One request per page of the management list; the server's upper bound. */
const MANAGEMENT_PAGE_SIZE = ORG_PROJECT_LIMITS.catalogPageSize;

function isCreatorPrivateProject(project: OrgProjectSummary): boolean {
  return (
    project.visibility === 'private' &&
    project.memberOwned &&
    project.capabilities.administer
  );
}

/** The viewer's own list preference, which only the member scope knows. */
function withPreference<T extends OrgProjectSummary>(
  project: T,
  from: Pick<OrgProjectSummary, 'preference' | 'listed'>,
): T {
  return { ...project, preference: from.preference, listed: from.listed };
}

/** Applies fresh definitions, keeping each row's list preference. */
function withDetails(
  rows: ProjectRows,
  details: readonly OrgProjectDetail[],
): ProjectRows {
  const next = new Map(rows);
  for (const fresh of details) {
    if (fresh.state === 'DELETED') {
      next.delete(fresh.id);
      continue;
    }
    const current = next.get(fresh.id);
    next.set(fresh.id, {
      summary: current ? withPreference(fresh, current.summary) : fresh,
      detail: fresh,
    });
  }
  return next;
}

/**
 * Merges member-scope rows. An admin's management rows take the member row's
 * preference; beyond those an admin sees only the private projects they
 * created, which the management scope leaves out.
 */
function withMemberRows(
  rows: ProjectRows,
  members: readonly OrgProjectSummary[],
  managesProjects: boolean,
): ProjectRows {
  const next = new Map(rows);
  for (const member of members) {
    const current = next.get(member.id);
    if (current?.detail)
      next.set(member.id, {
        summary: withPreference(current.summary, member),
        detail: withPreference(current.detail, member),
      });
    else if (!managesProjects || isCreatorPrivateProject(member))
      next.set(member.id, { summary: member, detail: null });
  }
  return next;
}

function withSummary(rows: ProjectRows, fresh: OrgProjectSummary): ProjectRows {
  const current = rows.get(fresh.id);
  if (!current) return rows;
  const next = new Map(rows);
  next.set(fresh.id, {
    summary: fresh,
    detail: current.detail ? withPreference(current.detail, fresh) : null,
  });
  return next;
}

function withoutRow(rows: ProjectRows, projectId: string): ProjectRows {
  const next = new Map(rows);
  next.delete(projectId);
  return next;
}

/** Active before archived, then by the name the row shows. */
function sortedRows(rows: ProjectRows): ProjectRow[] {
  return [...rows.values()].sort((a, b): number => {
    const archived =
      Number(a.summary.state !== 'ACTIVE') -
      Number(b.summary.state !== 'ACTIVE');
    return archived !== 0
      ? archived
      : a.summary.name.localeCompare(b.summary.name);
  });
}

type ProjectFilter = 'all' | 'private' | 'hidden' | 'archived';
const PROJECT_FILTERS: readonly {
  value: Exclude<ProjectFilter, 'all'>;
  label: string;
  matches: (project: OrgProjectSummary) => boolean;
}[] = [
  {
    value: 'private',
    label: 'Only you',
    matches: (project): boolean => project.visibility === 'private',
  },
  {
    value: 'hidden',
    label: 'Hidden',
    matches: (project): boolean => project.preference === 'DISMISSED',
  },
  {
    value: 'archived',
    label: 'Archived',
    matches: (project): boolean => project.state === 'ARCHIVED',
  },
];

/** Who can use an org-visible project, from its grants. */
function accessSummary(
  grants: readonly OrgProjectGrant[],
  organizationName: string,
): string {
  if (grants.some((grant): boolean => grant.principal.type === 'organization'))
    return `Everyone in ${organizationName}`;
  const teams = grants.filter(
    (grant): boolean => grant.principal.type === 'team',
  ).length;
  const people = grants.filter(
    (grant): boolean => grant.principal.type === 'user',
  ).length;
  const parts = [
    teams > 0 ? `${teams} ${teams === 1 ? 'team' : 'teams'}` : '',
    people > 0 ? `${people} ${people === 1 ? 'person' : 'people'}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No access yet';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function ProjectList({
  detail,
  orgLapsed = false,
  projectsEnabled,
  creating,
  onCreatingChange,
  repositoriesOpen,
  onRepositoriesOpenChange,
  onAddAvailableChange,
}: TeamProjectsSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(PROJECTS_ERROR_SCOPE);
  const loadErrorCopy = useSettingsLoadFailure(PROJECTS_ERROR_SCOPE);
  const brand = useSettingsBrand();
  const { blockClassName } = useSettingsPrivacy();
  const localSetup = useOrganizationSettingsSlots().orgProjectLocalSetup;
  const localStatuses = useOrgProjectLocalStatuses(detail.id);
  const managesProjects = canManageProjects(detail.viewerRole);
  const [rows, setRows] = useState<ProjectRows>(NO_ROWS);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Whether a full list has loaded, so only a failed first load offers Retry.
  const [loaded, setLoaded] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [opening, setOpening] = useState<string | null>(null);
  const [preferencePending, setPreferencePending] = useState<
    ReadonlySet<string>
  >(new Set());
  const [localPending, setLocalPending] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [localErrors, setLocalErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<RequestFailure | null>(null);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);
  // After "Refresh from GitHub" the Repositories dialog bypasses cached GitHub
  // pages, so a repository the refresh just seeded shows its project.
  const [repositoriesFresh, setRepositoriesFresh] = useState(false);
  const alive = useRef(true);
  const listVersion = useRef(0);
  const preferenceInFlight = useRef(new Set<string>());
  const localControllers = useRef(new Map<string, AbortController>());
  // Deleting a project removes the row that opened the dialog, so focus
  // returns to the section, which survives the mutation.
  const containerRef = useRef<HTMLDivElement>(null);
  const growthDisabled = orgLapsed || !projectsEnabled;
  const repositoriesAvailable = teamProjectsRepositoriesAvailable(
    detail,
    projectsEnabled,
    orgLapsed,
  );
  const managed = useManagedProject(detail, {
    growthDisabled,
    blocked: paging,
    onChanged: (fresh): void =>
      setRows((current): ProjectRows => withDetails(current, [fresh])),
  });

  /** Every management page, so the count and search cover all projects. */
  const loadManagement = useCallback(async (): Promise<OrgProjectDetail[]> => {
    const loaded: OrgProjectDetail[] = [];
    let cursor: string | undefined;
    do {
      const page = await listOrganizationProjects(
        client,
        detail.id,
        'management',
        { ...(cursor ? { cursor } : {}), limit: MANAGEMENT_PAGE_SIZE },
      );
      loaded.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return loaded;
  }, [client, detail.id]);

  /**
   * Both scopes in parallel, shown together: a failure in either shows one
   * error rather than half a list.
   */
  const loadAll = useCallback(async (): Promise<void> => {
    const version = ++listVersion.current;
    try {
      const [management, members] = await Promise.all([
        managesProjects ? loadManagement() : Promise.resolve([]),
        projectsEnabled
          ? listOrganizationProjects(client, detail.id, 'member', {
              limit: MEMBER_PAGE_SIZE,
            })
          : Promise.resolve(null),
      ]);
      if (!alive.current || version !== listVersion.current) return;
      setRows(
        withMemberRows(
          withDetails(NO_ROWS, management),
          members?.data ?? [],
          managesProjects,
        ),
      );
      setMemberCursor(members?.nextCursor ?? null);
      setLoaded(true);
      setError(null);
    } catch (err) {
      if (alive.current && version === listVersion.current)
        setError(loadErrorCopy(err));
    } finally {
      if (alive.current && version === listVersion.current) setLoading(false);
    }
  }, [
    client,
    detail.id,
    loadErrorCopy,
    loadManagement,
    managesProjects,
    projectsEnabled,
  ]);

  useEffect(() => {
    alive.current = true;
    const controllers = localControllers.current;
    void loadAll();
    return (): void => {
      alive.current = false;
      listVersion.current += 1;
      for (const controller of controllers.values()) controller.abort();
    };
  }, [loadAll]);

  /** Retry after the first load failed; the skeleton shows again meanwhile. */
  const retryLoad = (): void => {
    setError(null);
    setLoading(true);
    void loadAll();
  };

  const loadMore = async (): Promise<void> => {
    if (
      !memberCursor ||
      paging ||
      managed.busy ||
      preferenceInFlight.current.size > 0
    )
      return;
    const version = listVersion.current;
    setPaging(true);
    setError(null);
    try {
      const page = await listOrganizationProjects(client, detail.id, 'member', {
        cursor: memberCursor,
        limit: MEMBER_PAGE_SIZE,
      });
      if (!alive.current || version !== listVersion.current) return;
      setRows(
        (current): ProjectRows =>
          withMemberRows(current, page.data, managesProjects),
      );
      setMemberCursor(page.nextCursor);
    } catch (err) {
      if (alive.current && version === listVersion.current)
        setError(errorCopy.loadFailure(err));
    } finally {
      if (alive.current) setPaging(false);
    }
  };

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    setRefreshResult(null);
    try {
      const result = await refreshOrganizationProjectsFromGitHub(
        client,
        detail.id,
      );
      if (!alive.current) return;
      setRefreshResult(refreshSummary(result));
      setRepositoriesFresh(true);
      // Start the list over so the projects the refresh added show up.
      await loadAll();
    } catch (err) {
      if (alive.current)
        setRefreshError(
          requestFailure(
            err,
            errorCopy.actionFailure(err, {
              action: 'refresh from GitHub',
              known: GITHUB_PICKER_KNOWN_ERRORS,
            }),
          ),
        );
    } finally {
      if (alive.current) setRefreshing(false);
    }
  };

  const removeRow = (projectId: string): void => {
    setRows((current): ProjectRows => withoutRow(current, projectId));
    setAccessLost(true);
  };

  /** Resolves whether the preference saved. */
  const setPreference = async (
    project: OrgProjectSummary,
    preference: OrgProjectPreference,
  ): Promise<boolean> => {
    if (
      preferenceInFlight.current.has(project.id) ||
      paging ||
      project.state !== 'ACTIVE'
    )
      return false;
    preferenceInFlight.current.add(project.id);
    setPreferencePending(new Set(preferenceInFlight.current));
    setError(null);
    setRows(
      (current): ProjectRows =>
        withSummary(current, {
          ...project,
          preference,
          listed: preference === 'ADDED',
        }),
    );
    try {
      const fresh = await setOrganizationProjectPreference(
        client,
        detail.id,
        project.id,
        preference,
      );
      if (alive.current)
        setRows((current): ProjectRows => withSummary(current, fresh));
      return true;
    } catch (err) {
      if (!alive.current) return false;
      if (err instanceof TeamApiError && err.status === 404) {
        removeRow(project.id);
      } else {
        setRows((current): ProjectRows => withSummary(current, project));
        setError(
          errorCopy.actionFailure(err, { action: 'update this project' }),
        );
      }
      return false;
    } finally {
      preferenceInFlight.current.delete(project.id);
      if (alive.current)
        setPreferencePending(new Set(preferenceInFlight.current));
    }
  };

  /** Opens the editor, loading the definition a member-scope row lacks. */
  const edit = async (
    row: ProjectRow,
    section: ProjectSection,
  ): Promise<void> => {
    if (opening !== null || managed.busy || paging) return;
    if (row.detail) {
      managed.open(row.detail, section);
      return;
    }
    setOpening(row.summary.id);
    setError(null);
    managed.setError(null);
    try {
      const fresh = await getOrganizationProject(
        client,
        detail.id,
        row.summary.id,
      );
      if (!alive.current) return;
      managed.replace(fresh);
      managed.open(fresh, section);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof TeamApiError && err.status === 404)
        removeRow(row.summary.id);
      else setError(errorCopy.loadFailure(err));
    } finally {
      if (alive.current) setOpening(null);
    }
  };

  /**
   * Set up or Open on this device through the host. A failure stays on the
   * row until the next attempt; settings may close (and this page unmount)
   * before the promise settles.
   */
  const runLocal = async (
    project: OrgProjectSummary,
    kind: 'setUp' | 'open',
  ): Promise<void> => {
    if (!localSetup || localControllers.current.has(project.id)) return;
    const controller = new AbortController();
    localControllers.current.set(project.id, controller);
    setLocalPending(new Set(localControllers.current.keys()));
    setLocalErrors((current): Record<string, string> => {
      const next = { ...current };
      delete next[project.id];
      return next;
    });
    const settled = (): boolean => alive.current && !controller.signal.aborted;
    try {
      await localSetup[kind](detail.id, project, controller.signal);
      if (kind === 'setUp' && settled()) {
        try {
          const fresh = await getOrganizationProject(
            client,
            detail.id,
            project.id,
          );
          if (settled())
            setRows((current): ProjectRows => withDetails(current, [fresh]));
        } catch {
          // The row already shows the local state; the re-read is a bonus.
        }
      }
    } catch (err) {
      if (!settled() || isAbortError(err)) return;
      setLocalErrors(
        (current): Record<string, string> => ({
          ...current,
          // A row line: our sentence only, like the row's other statuses.
          [project.id]: errorCopy.actionFailure(err, {
            action:
              kind === 'setUp' ? 'set up this project' : 'open this project',
          }).copy,
        }),
      );
    } finally {
      localControllers.current.delete(project.id);
      if (alive.current)
        setLocalPending(new Set(localControllers.current.keys()));
    }
  };

  /**
   * The desktop sets up only listed projects, so list a hidden or unlisted
   * one first, as the Portal's Add does.
   */
  const openOnDesktop = async (project: OrgProjectSummary): Promise<void> => {
    if (project.listed === false && !(await setPreference(project, 'ADDED')))
      return;
    openDesktopDeepLink(
      buildOrgProjectDeepLink(brand.internalName, project.id, detail.id),
    );
  };

  const allRows = sortedRows(rows);
  const total = allRows.length;
  const filters = PROJECT_FILTERS.map((entry) => ({
    ...entry,
    count: allRows.filter((row): boolean => entry.matches(row.summary)).length,
  })).filter((entry): boolean => entry.count > 0 && entry.count < total);
  if (
    filter !== 'all' &&
    !filters.some((entry): boolean => entry.value === filter)
  )
    setFilter('all');
  const activeFilter = PROJECT_FILTERS.find(
    (entry): boolean => entry.value === filter,
  );
  const visibleRows = allRows.filter(
    (row): boolean =>
      (activeFilter === undefined || activeFilter.matches(row.summary)) &&
      matchesProjectSearch(query, [
        row.summary.name,
        row.summary.repository?.name,
      ]),
  );
  const orgVisibleCount = allRows.filter(
    (row): boolean => row.summary.visibility !== 'private',
  ).length;
  const listBusy = managed.busy || paging || opening !== null;
  const connected = detail.githubConnection.connected;
  const showChecklist =
    managesProjects &&
    projectsEnabled &&
    !orgLapsed &&
    !loading &&
    error === null &&
    orgVisibleCount === 0;
  const addAvailable =
    managesProjects &&
    connected &&
    projectsEnabled &&
    !orgLapsed &&
    !loading &&
    (orgVisibleCount > 0 || error !== null);

  useEffect(() => {
    onAddAvailableChange(addAvailable);
  }, [addAvailable, onAddAvailableChange]);
  useEffect(
    () => (): void => {
      onAddAvailableChange(false);
    },
    [onAddAvailableChange],
  );

  const rowActions = (row: ProjectRow): ReactNode => {
    const project = row.summary;
    const usable = project.state === 'ACTIVE' && project.capabilities.use;
    const rowBusy = listBusy || preferencePending.has(project.id);
    const administer = project.capabilities.administer;
    const personal = !project.memberOwned && project.state === 'ACTIVE';
    return (
      <>
        {usable || localSetup ? (
          <LocalProjectControls
            project={project}
            usable={usable}
            setUpAllowed={
              isOrgProjectAddAllowed(project, false) &&
              isOrgProjectCatalogSetupSupported(project)
            }
            runsOnDevice={
              deriveOrgProjectPlaceholderState({
                project,
                snapshotError: null,
              }) !== 'not-local'
            }
            localSetup={localSetup !== undefined}
            status={localStatuses.get(project.id)}
            error={localErrors[project.id] ?? null}
            pending={
              localPending.has(project.id) || preferencePending.has(project.id)
            }
            busy={rowBusy}
            productName={brand.displayName}
            onSetUp={(): void => {
              void runLocal(project, 'setUp');
            }}
            onOpen={(): void => {
              void runLocal(project, 'open');
            }}
            onOpenOnDesktop={(): void => {
              void openOnDesktop(project);
            }}
          />
        ) : null}
        <ProjectActions
          project={project}
          busy={rowBusy}
          growthDisabled={growthDisabled}
          admin={
            administer
              ? {
                  onEdit: (): void => {
                    void edit(row, 'definition');
                  },
                  onAccess: (): void => {
                    void edit(row, 'grants');
                  },
                  onLifecycle: (action): void =>
                    managed.lifecycle(project, action),
                  onDelete: (): void => managed.requestDelete(project),
                }
              : null
          }
          personal={
            personal
              ? {
                  hidden: project.preference === 'DISMISSED',
                  onToggle: (): void => {
                    void setPreference(
                      project,
                      project.preference === 'DISMISSED'
                        ? 'ADDED'
                        : 'DISMISSED',
                    );
                  },
                }
              : null
          }
        />
      </>
    );
  };

  return (
    <div ref={containerRef} tabIndex={-1} className="flex flex-col gap-6">
      <ErrorBanner
        errorSource="project-list"
        error={(error ?? (managed.selected ? null : managed.error))?.copy}
        details={(error ?? (managed.selected ? null : managed.error))?.details}
        // Only a failed first load offers Retry; "Load more" retries a later
        // page, and actions are not retried.
        onRetry={!loaded && error !== null ? retryLoad : undefined}
      />
      {accessLost && (
        <Notice>You no longer have access to this project.</Notice>
      )}
      {refreshError && (
        <RequestNotice failure={refreshError} orgId={detail.id} />
      )}
      {refreshResult && (
        <p
          role="status"
          data-testid="team-projects-refresh-result"
          className="text-s fg-primary"
        >
          {refreshResult}
        </p>
      )}
      {loading && (
        <DelayedLoadingPlaceholder>
          <ProjectListSkeleton />
        </DelayedLoadingPlaceholder>
      )}
      {showChecklist && (
        <SettingsCard
          title="Get your organization's projects set up"
          subtitle="Add your team's repositories once and manage sharing. Everyone you share with finds them here and can set them up in one click, already connected to the organization."
          testId="team-projects-setup"
        >
          <ProjectsSetupChecklist
            detail={detail}
            replayBlock={blockClassName}
            localStatuses={
              localSetup
                ? allRows.flatMap((row): OrgProjectLocalStatus[] => {
                    // Like the other steps, count only the organization's
                    // projects, not someone's private ones.
                    if (row.summary.visibility === 'private') return [];
                    const status = localStatuses.get(row.summary.id);
                    return status ? [status] : [];
                  })
                : null
            }
            onAdd={(): void => onCreatingChange(true)}
          />
        </SettingsCard>
      )}
      {!managesProjects && !loading && error === null && total === 0 && (
        <EmptyState
          testId="team-projects-empty"
          title="Nothing shared with you yet"
          subtitle={`Ask an admin of ${detail.name} to add projects.`}
        />
      )}
      {total > 0 && (
        <div className="flex flex-col gap-3">
          {/* The checklist shows only while every row is private, so a
              heading sets them apart from the organization's projects. */}
          {showChecklist && (
            <div data-testid="team-projects-private-heading">
              <Heading level={2} variant="title">
                Only visible to you
              </Heading>
              <p className="text-s fg-secondary">
                Projects you've added for yourself.
              </p>
            </div>
          )}
          {/* Refresh from GitHub is a page action: the header holds it. */}
          <TeamPageHeaderActions>
            {repositoriesAvailable && (
              <LoadingButton
                size="compact"
                variant="secondary"
                data-testid="team-projects-refresh"
                loading={refreshing}
                disabled={listBusy}
                onClick={(): void => {
                  void refresh();
                }}
              >
                Refresh from GitHub
              </LoadingButton>
            )}
          </TeamPageHeaderActions>
          <PageSearchRow>
            <PageSearchField
              aria-label="Search projects"
              placeholder="Search projects"
              data-testid="team-projects-search"
              maxLength={ORG_PROJECT_LIMITS.nameLength}
              value={query}
              onValueChange={setQuery}
            />
            {filters.length > 0 && (
              <SegmentedControl
                label="Show projects"
                semantics="toggle"
                width="content"
                dataTestId="team-projects-filter"
                value={filter}
                onChange={setFilter}
                options={[
                  {
                    value: 'all',
                    label: 'All',
                    trailing: <FilterCount count={total} />,
                    dataTestId: 'team-projects-filter-all',
                  },
                  ...filters.map((entry) => ({
                    value: entry.value,
                    label: entry.label,
                    trailing: <FilterCount count={entry.count} />,
                    dataTestId: `team-projects-filter-${entry.value}`,
                  })),
                ]}
              />
            )}
          </PageSearchRow>
          <p className="text-s fg-secondary">
            <span
              data-testid="team-projects-count"
              className="tabular-nums fg-primary"
            >
              {memberCursor ? `${total}+` : total}
            </span>{' '}
            {total === 1 && !memberCursor ? 'project' : 'projects'}
          </p>
          {visibleRows.length === 0 ? (
            <p
              data-testid="team-projects-no-results"
              className="text-s fg-secondary"
            >
              No projects match your search.
            </p>
          ) : (
            <div
              className={`${ORG_PROJECT_ROW_COLUMNS_CLASS} divide-y ${SETTINGS_GROUP_SURFACE_CLASS}`}
            >
              {visibleRows.map((row): JSX.Element => {
                const project = row.summary;
                const repository = project.repository;
                return (
                  <OrgProjectRow
                    key={project.id}
                    project={project}
                    testIdPrefix="team-projects"
                    columns
                    hidePrivatePill={showChecklist}
                    // Admins rename projects here, so the row shows the
                    // project's name; owner/repo sits on the line below.
                    name={project.name}
                    replayBlock={blockClassName}
                    busy={preferencePending.has(project.id)}
                    disabled={listBusy}
                    description={
                      repository
                        ? `${repository.owner}/${repository.name}`
                        : project.description
                    }
                    pills={
                      <>
                        {project.state === 'ARCHIVED' && (
                          <StatusPill
                            data-testid={`team-projects-archived-${project.id}`}
                          >
                            Archived
                          </StatusPill>
                        )}
                        {project.preference === 'DISMISSED' && (
                          <StatusPill
                            data-testid={`team-projects-hidden-${project.id}`}
                          >
                            Hidden
                          </StatusPill>
                        )}
                        {repository &&
                          repository.verification !== 'VERIFIED' && (
                            <StatusPill tone="warning">
                              {VERIFICATION_LABELS[repository.verification]}
                            </StatusPill>
                          )}
                      </>
                    }
                    middle={
                      row.detail &&
                      project.capabilities.administer &&
                      project.visibility !== 'private' ? (
                        <span
                          data-testid={`team-projects-access-${project.id}`}
                        >
                          {accessSummary(row.detail.grants, detail.name)}
                        </span>
                      ) : null
                    }
                    actions={rowActions(row)}
                    onActivate={
                      project.capabilities.administer
                        ? (): void => {
                            void edit(row, 'definition');
                          }
                        : undefined
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
      {memberCursor && !loading && (
        <LoadingButton
          size="compact"
          data-testid="team-projects-load-more"
          loading={paging}
          disabled={managed.busy || preferencePending.size > 0}
          onClick={(): void => {
            void loadMore();
          }}
        >
          Load more
        </LoadingButton>
      )}
      {creating && managesProjects && (
        <TeamProjectsCreateDialog
          detail={detail}
          growthDisabled={growthDisabled}
          onClose={(): void => onCreatingChange(false)}
          onCreated={(created): void =>
            setRows((current): ProjectRows => withDetails(current, created))
          }
        />
      )}
      {repositoriesOpen && repositoriesAvailable && (
        <TeamProjectsRepositories
          orgId={detail.id}
          disabled={listBusy}
          fresh={repositoriesFresh}
          onProjectChanged={managed.replace}
          onClose={(): void => onRepositoriesOpenChange(false)}
        />
      )}
      <ManagedProjectDialogs
        managed={managed}
        detail={detail}
        growthDisabled={growthDisabled}
        restoreFocusRef={containerRef}
      />
    </div>
  );
}

/** A filter segment's count, set apart from its label. */
function FilterCount({ count }: { count: number }): JSX.Element {
  return <span className="ml-1.5 tabular-nums fg-tertiary">{count}</span>;
}

interface LocalProjectControlsProps {
  project: OrgProjectSummary;
  /** Active and usable by the viewer: the row offers an action. */
  usable: boolean;
  /** Set up has something to start here, by the Add project dialog's rule. */
  setUpAllowed: boolean;
  /** False for projects that never run on a device, such as cloud ones. */
  runsOnDevice: boolean;
  localSetup: boolean;
  status: OrgProjectLocalStatus | undefined;
  /** The last rejected Set up or Open for this row. */
  error: string | null;
  /** This row's own Set up, Open or listing is running. */
  pending: boolean;
  /** The list or this row is busy, so no action may start. */
  busy: boolean;
  productName: string;
  onSetUp: () => void;
  onOpen: () => void;
  onOpenOnDesktop: () => void;
}

/**
 * Where the project stands on this device and the row's one action: Set up
 * or Open with a local setup host, the desktop handoff without one.
 */
function LocalProjectControls({
  project,
  usable,
  setUpAllowed,
  runsOnDevice,
  localSetup,
  status,
  error,
  pending,
  busy,
  productName,
  onSetUp,
  onOpen,
  onOpenOnDesktop,
}: LocalProjectControlsProps): JSX.Element | null {
  if (!localSetup)
    return runsOnDevice ? (
      <LoadingButton
        size="compact"
        variant="secondary"
        data-testid={`team-projects-open-${project.id}`}
        loading={pending}
        disabled={busy}
        onClick={onOpenOnDesktop}
      >
        Open in {productName}
      </LoadingButton>
    ) : null;
  const failure =
    error ?? (status?.state === 'failed' ? (status.message ?? null) : null);
  const settingUp = status?.state === 'setting-up';
  // A set-up project shows no label: its Open button already says so.
  const label =
    failure ?? (settingUp ? (status.message ?? 'Setting up…') : null);
  return (
    <>
      {label !== null && (
        <span
          data-testid={`team-projects-local-${project.id}`}
          className={
            failure === null
              ? 'text-xs fg-secondary'
              : 'text-xs fg-destructive-strong'
          }
        >
          {label}
        </span>
      )}
      {usable &&
        !settingUp &&
        (status?.state === 'ready' ? (
          <LoadingButton
            size="compact"
            variant="secondary"
            data-testid={`team-projects-open-${project.id}`}
            loading={pending}
            disabled={busy}
            onClick={onOpen}
          >
            Open
          </LoadingButton>
        ) : setUpAllowed ? (
          <LoadingButton
            size="compact"
            variant="secondary"
            data-testid={`team-projects-set-up-${project.id}`}
            loading={pending}
            disabled={busy}
            onClick={onSetUp}
          >
            Set up
          </LoadingButton>
        ) : null)}
    </>
  );
}

interface ProjectActionsProps {
  project: Pick<OrgProjectSummary, 'id' | 'name' | 'state'>;
  busy: boolean;
  growthDisabled: boolean;
  /** Edit, Access, Archive or Restore, and Delete, for a project's admins. */
  admin: {
    onEdit: () => void;
    onAccess: () => void;
    onLifecycle: (action: OrgProjectLifecycleAction) => void;
    onDelete: () => void;
  } | null;
  /** Hide from or show in the viewer's own list. */
  personal: { hidden: boolean; onToggle: () => void } | null;
}
function ProjectActions({
  project,
  busy,
  growthDisabled,
  admin,
  personal,
}: ProjectActionsProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  if (!admin && !personal) return null;
  // Edit and Access, then the viewer's own list, then the lifecycle rows
  // (Archive or Restore, and Delete) in their own last group.
  const items: ActionMenuItem[] = [];
  if (admin) {
    items.push(
      {
        key: 'edit',
        label: 'Edit',
        icon: <PencilIcon />,
        disabled: busy,
        onSelect: admin.onEdit,
      },
      {
        key: 'access',
        label: 'Access',
        icon: <ShieldAccessIcon />,
        disabled: busy,
        onSelect: admin.onAccess,
      },
    );
  }
  if (personal) {
    items.push({
      key: 'personal',
      label: personal.hidden ? 'Show in my list' : 'Hide from my list',
      icon: personal.hidden ? <EyeIcon /> : <EyeOffIcon />,
      disabled: busy,
      separatorBefore: items.length > 0,
      testId: `team-projects-${personal.hidden ? 'show' : 'hide'}-${project.id}`,
      onSelect: personal.onToggle,
    });
  }
  if (admin) {
    items.push(
      project.state === 'ACTIVE'
        ? {
            key: 'archive',
            label: 'Archive',
            icon: <ArchiveIcon />,
            disabled: busy,
            separatorBefore: true,
            onSelect: (): void => admin.onLifecycle('archive'),
          }
        : {
            key: 'restore',
            label: 'Restore',
            icon: <UnarchiveIcon />,
            disabled: busy || growthDisabled,
            separatorBefore: true,
            onSelect: (): void => admin.onLifecycle('restore'),
          },
      {
        key: 'delete',
        label: 'Delete',
        icon: <TrashIcon />,
        tone: 'destructive',
        disabled: busy,
        onSelect: admin.onDelete,
      },
    );
  }
  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="compact"
        iconOnly
        aria-label={`Actions for ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`team-projects-actions-${project.id}`}
        disabled={busy}
        onClick={(): void => setOpen(!open)}
      >
        <MoreHorizontalIcon size={16} aria-hidden="true" />
      </Button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        aria-label={`Actions for ${project.name}`}
        className="w-44"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={items}
            onSelect={(item): void => {
              setOpen(false);
              // Hand focus back to the trigger, as a FloatingMenu pick does.
              anchorRef.current?.focus({ preventScroll: true });
              item.onSelect?.();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
}

/**
 * Whether saving `grants` would share a private project with anyone other
 * than its creator. The server refuses that without an explicit confirmation.
 */
function sharesPrivateProject(
  project: OrgProjectDetail,
  grants: OrgProjectGrant[],
): boolean {
  return (
    project.visibility === 'private' &&
    grants.some(
      (grant) =>
        grant.principal.type !== 'user' ||
        grant.principal.userId !== project.createdBy.id,
    )
  );
}

interface ProjectEditorProps {
  project: OrgProjectDetail;
  detail: OrganizationDetail;
  initialSection: 'definition' | 'grants';
  growthDisabled: boolean;
  busy: boolean;
  stale: boolean;
  error: SettingsFailure | null;
  onReload: () => Promise<OrgProjectDetail | null>;
  onSave: (operation: ProjectMutation) => Promise<void>;
  onClose: () => void;
}
function ProjectEditor({
  project,
  detail,
  initialSection,
  growthDisabled,
  busy,
  stale,
  error,
  onReload,
  onSave,
  onClose,
}: ProjectEditorProps): JSX.Element {
  const client = useSettingsClient();
  const { blockClassName } = useSettingsPrivacy();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [privateMemory, setPrivateMemory] = useState(
    project.privateMemory === true,
  );
  const [grants, setGrants] = useState(project.grants);
  // Each draft carries the concurrency token it was started from. A save of
  // the OTHER draft (or any refresh of `project`) must not move this token:
  // a definition typed against revision 7 is submitted with revision 7 even
  // after a grants save surfaced revision 9, so the server can reject it
  // instead of the stale draft silently overwriting the other edit. Tokens
  // advance only when their own draft is saved or explicitly reloaded.
  const [metadataRevision, setMetadataRevision] = useState(project.revision);
  const [grantsAuthorizationVersion, setGrantsAuthorizationVersion] = useState(
    project.authorizationVersion,
  );
  const [confirmingShare, setConfirmingShare] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const grantsRef = useRef<HTMLHeadingElement>(null);
  const hasExpansion = grants.some(
    (grant) =>
      !project.grants.some(
        (saved) =>
          principalKey(saved.principal) === principalKey(grant.principal),
      ),
  );
  const saveGrants = (confirmShare: boolean): Promise<void> =>
    onSave(async (current) => {
      try {
        const saved = await replaceOrganizationProjectGrants(
          client,
          detail.id,
          current.id,
          {
            authorizationVersion: grantsAuthorizationVersion,
            grants,
            ...(confirmShare ? { confirmShare: true } : {}),
          },
        );
        setGrantsAuthorizationVersion(saved.authorizationVersion);
        return saved;
      } catch (err) {
        // The server saw a private project this editor did not: ask, and
        // leave the project and the draft as they are.
        if (
          !confirmShare &&
          err instanceof TeamApiError &&
          err.code === 'share_confirmation_required'
        ) {
          setConfirmingShare(true);
          return project;
        }
        throw err;
      }
    });
  return (
    <>
      <DialogModal
        title={privateText(project.name, blockClassName)}
        onClose={onClose}
        dataTestId="team-projects-detail"
        maxWidth="2xl"
        trapFocus
        initialFocusRef={initialSection === 'grants' ? grantsRef : nameRef}
      >
        <div className="flex flex-col gap-6">
          <ErrorBanner
            errorSource="project-editor"
            error={error?.copy}
            details={error?.details}
          />
          {stale && (
            <LoadingButton
              variant="secondary"
              size="compact"
              className="self-start"
              loading={busy}
              onClick={(): void => {
                void (async (): Promise<void> => {
                  const fresh = await onReload();
                  if (fresh) {
                    setMetadataRevision(fresh.revision);
                    setGrantsAuthorizationVersion(fresh.authorizationVersion);
                    setName(fresh.name);
                    setDescription(fresh.description ?? '');
                    setPrivateMemory(fresh.privateMemory === true);
                    setGrants(fresh.grants);
                  }
                })();
              }}
            >
              Reload project
            </LoadingButton>
          )}
          <form
            className="flex flex-col gap-3"
            onSubmit={(event): void => {
              event.preventDefault();
              if (busy || stale || !name.trim()) return;
              void onSave(async (current) => {
                const saved = await updateOrganizationProject(
                  client,
                  detail.id,
                  current.id,
                  {
                    revision: metadataRevision,
                    name: name.trim(),
                    description,
                    // Sent only when changed, so an untouched draft never
                    // writes a value the admin did not choose.
                    ...(privateMemory !== (current.privateMemory === true)
                      ? { privateMemory }
                      : {}),
                  },
                );
                setMetadataRevision(saved.revision);
                return saved;
              });
            }}
          >
            <Heading level={3} variant="title">
              Definition
            </Heading>
            <FormField label="Name">
              {(control) => (
                <TextInput
                  {...control}
                  ref={nameRef}
                  aria-label="Name"
                  density="settings"
                  value={name}
                  maxLength={ORG_PROJECT_LIMITS.nameLength}
                  required
                  disabled={busy}
                  onChange={(event): void => setName(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="Description">
              {(control) => (
                <TextArea
                  {...control}
                  aria-label="Description"
                  value={description}
                  maxLength={ORG_PROJECT_LIMITS.descriptionLength}
                  disabled={busy}
                  onChange={(event): void => setDescription(event.target.value)}
                />
              )}
            </FormField>
            <PrivateMemoryCard
              checked={privateMemory}
              onChange={setPrivateMemory}
              disabled={busy || stale}
              dataTestId="team-projects-private-memory"
            />
            <LoadingButton
              type="submit"
              variant="secondary"
              size="compact"
              className="self-start"
              loading={busy}
              disabled={stale || !name.trim()}
            >
              Save changes
            </LoadingButton>
          </form>
          <section className="flex flex-col gap-2 text-s">
            <Heading level={3} variant="title">
              Repository
            </Heading>
            {project.repository ? (
              <>
                <a
                  className={joinClasses('fg-accent underline', blockClassName)}
                  href={`https://github.com/${encodeURIComponent(project.repository.owner)}/${encodeURIComponent(project.repository.name)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {project.repository.owner}/{project.repository.name}
                </a>
                <p>
                  Default branch:{' '}
                  {project.repository.defaultBranch ?? 'Not set'}
                </p>
                <p>
                  Verification:{' '}
                  {VERIFICATION_LABELS[project.repository.verification]}
                </p>
              </>
            ) : (
              <p>No repository</p>
            )}
          </section>
          <section className="flex flex-col gap-3 text-s">
            <Heading level={3} variant="title" ref={grantsRef} tabIndex={-1}>
              Who can use it
            </Heading>
            <TeamProjectsGrantsEditor
              detail={detail}
              grants={grants}
              setGrants={setGrants}
              originalGrants={project.grants}
              disabled={busy || stale}
              growthDisabled={growthDisabled}
            />
            <LoadingButton
              variant="secondary"
              size="compact"
              className="self-start"
              loading={busy}
              disabled={stale || (growthDisabled && hasExpansion)}
              onClick={(): void => {
                if (busy) return;
                if (sharesPrivateProject(project, grants))
                  setConfirmingShare(true);
                else void saveGrants(false);
              }}
            >
              Save access
            </LoadingButton>
          </section>
        </div>
      </DialogModal>
      {confirmingShare && (
        <SettingsConfirmDialog
          title={
            blockClassName === '' ? (
              `Share ${project.name}?`
            ) : (
              <>
                Share <span className={blockClassName}>{project.name}</span>?
              </>
            )
          }
          message={`People you add, and ${detail.name}'s admins, will be able to see it.`}
          confirmLabel="Share"
          busyLabel="Sharing…"
          busy={busy}
          dataTestId="team-projects-share-confirm"
          restoreFocusRef={grantsRef}
          onCancel={(): void => setConfirmingShare(false)}
          onConfirm={(): void => {
            void (async (): Promise<void> => {
              await saveGrants(true);
              setConfirmingShare(false);
            })();
          }}
        />
      )}
    </>
  );
}

/** One sample project for the loading state: plain, of the loaded shape. */
function sampleProject(id: string, name: string): OrgProjectSummary {
  return {
    id,
    organizationId: null,
    name,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'sample',
      name,
      providerRepoId: null,
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
}

const SAMPLE_PROJECTS: readonly OrgProjectSummary[] = [
  sampleProject('sample-project-1', 'project'),
  sampleProject('sample-project-2', 'another'),
];

/**
 * The project list while it loads: the real rows with sample projects inside
 * `Skeleton`, so skullet measures them into bars in place.
 */
function ProjectListSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading projects"
      testId="settings-skeleton-list"
      className="w-full"
    >
      <div
        className={`${ORG_PROJECT_ROW_COLUMNS_CLASS} divide-y ${SETTINGS_GROUP_SURFACE_CLASS}`}
      >
        {SAMPLE_PROJECTS.map(
          (project): JSX.Element => (
            <OrgProjectRow
              key={project.id}
              project={project}
              testIdPrefix="team-projects"
              columns
              description={`sample/${project.name}`}
            />
          ),
        )}
      </div>
    </Skeleton>
  );
}
