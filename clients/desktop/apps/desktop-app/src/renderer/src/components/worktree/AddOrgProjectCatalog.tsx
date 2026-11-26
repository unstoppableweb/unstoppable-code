import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  useOrgProjectsStore,
  useOrgProjectsStoreApi,
  type OrgProjectsStoreState,
} from '@canopy/app-state';
import {
  isOrgProjectAdded,
  OrgProjectCatalogList,
  type OrgProjectCatalogGithubConnection,
  type OrgProjectCatalogManagement,
} from '@canopy/ui-app/org-project-catalog';
import { Button } from '@canopy/ui-shared';
import {
  canManageOrganizationProjects,
  deriveOrgProjectPlaceholderState,
  organizationIntegrationsPath,
  organizationProjectsPath,
  type OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import type {
  WorkspaceContext,
  WorkspaceContextOrganizationRole,
} from '@canopy/protocol/workspace-context';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { OrgProjectLocalStatus } from '@canopy/ui-app/settings/organization/organization-settings-slots';
import { openSettingsPathOrWebReported } from '@/lib/navigation/settings-destinations';
import {
  inlineFailureText,
  inlineFailureWithMainSentence,
} from '@/lib/inline-app-error';
import { useProjectsStore } from '@/stores/projectsStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import {
  addOrgProjectToComputer,
  isOrgProjectAddableState,
  orgProjectAddDestination,
} from '@/lib/orgProjectCatalogAdd';
import {
  deriveOrgProjectLocalStatuses,
  ORG_PROJECT_SETTING_UP_MESSAGE,
} from '@/lib/orgProjectLocalState';
import {
  deriveOrgCatalogReadState,
  type OrgCatalogSession,
} from './orgCatalogSession';

// The desktop host of the shared organization catalog (CAN-3537): the list
// itself is `OrgProjectCatalogList` from `@canopy/ui-app`, the same component
// the web portal renders. This adapter supplies the catalog the dialog reads
// from the org projects store, what is on this computer, setup progress, the
// remembered clone folder, what Add does here (set the project up on this
// computer), and an owner's or admin's setup pages (CAN-3984).

type OrganizationContext = Extract<WorkspaceContext, { kind: 'organization' }>;

const SETUP_FAILED = "Couldn't set up the project.";

/**
 * The catalog's one-line error for a refused setup start: main's own
 * sentence when it wrote one, otherwise ours; raw text never leads.
 */
function setupFailureText(cause: unknown): string {
  const appError = toAppError(resolveClientAppError(cause));
  if (!appError) return SETUP_FAILED;
  return (
    inlineFailureText(inlineFailureWithMainSentence(appError, SETUP_FAILED)) ??
    SETUP_FAILED
  );
}

interface AddOrgProjectCatalogProps {
  context: OrganizationContext;
  organization:
    | { name: string; role: WorkspaceContextOrganizationRole }
    | undefined;
  /** The dialog's read of this catalog; the list loads nothing itself. */
  session: OrgCatalogSession;
  onClose: () => void;
  onAddActivityChange: (delta: 1 | -1) => void;
  /**
   * A project to add once, as its Add would, as soon as the catalog lists it
   * and Add is available: the create-time nudge's "Add to <organization>"
   * continuing a clone the member started in Personal.
   */
  initialAddProjectId?: string;
  /** Where that add clones; the remembered folder when absent. */
  initialDestination?: string;
}

export function AddOrgProjectCatalog({
  context,
  organization,
  session,
  onClose,
  onAddActivityChange,
  initialAddProjectId,
  initialDestination,
}: AddOrgProjectCatalogProps): JSX.Element {
  const { snapshot, loadError } = session;
  const localProjects = useProjectsStore(
    (store): SidebarItem[] => store.projects,
  );
  const orgProjectsStore = useOrgProjectsStoreApi();
  const linkedProjectIds = useLinkedPersonalWorkspacesStore(
    (store): readonly string[] => store.projectIds,
  );
  // Links arrive asynchronously. Until they are answered for this
  // organization, a project that is linked looks like one that is not, so
  // Add stays unavailable rather than risk a second checkout (CAN-3469).
  const linksResolved = useLinkedPersonalWorkspacesStore(
    (store): boolean => store.resolvedOrganizationId === context.organizationId,
  );
  const progress = useOrgProjectsStore(
    (store): OrgProjectsStoreState['setupProgress'] => store.setupProgress,
  );
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  // An Add that settles after this dialog closed must not close the next one,
  // which shares the same close callback.
  const mounted = useRef(true);
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  // The folder the member chose for an earlier setup (the setup dialog saves
  // it on Start). Empty until loaded, and when none was ever chosen.
  const [destination, setDestination] = useState('');
  // Projects found linked by the fresh check after listing, until the sidebar
  // publishes the same answer.
  const [linkedAfterListing, setLinkedAfterListing] = useState<
    readonly string[]
  >([]);
  // One derivation with the organization Projects page, so "Added" here and
  // "Ready" there cannot disagree.
  const localStatuses = useMemo(
    (): ReadonlyMap<string, OrgProjectLocalStatus> =>
      deriveOrgProjectLocalStatuses({
        organizationId: context.organizationId,
        localProjects,
        linkedProjectIds,
        linkedAfterListing,
        setupProgress: progress,
      }),
    [
      context.organizationId,
      localProjects,
      linkedProjectIds,
      linkedAfterListing,
      progress,
    ],
  );
  const localProjectIds = useMemo(
    (): ReadonlySet<string> =>
      new Set(
        Array.from(localStatuses).flatMap(([projectId, status]): string[] =>
          status.state === 'ready' ? [projectId] : [],
        ),
      ),
    [localStatuses],
  );
  useEffect((): (() => void) => {
    let active = true;
    void window.api
      .loadPreferences()
      .then((preferences): void => {
        if (active && preferences.__error === undefined)
          setDestination(preferences.orgProjectDefaultDestinationRoot ?? '');
      })
      // Without a remembered folder Add opens the setup dialog, which reports
      // a preference load failure itself.
      .catch((): void => {});
    return (): void => {
      active = false;
    };
  }, []);
  // The open's GitHub re-read failed or ran long: the list is the cached one
  // and may miss repositories created since (CAN-3489).
  const { stale, unauthorized, githubRefreshFailed, githubNotConnected } =
    deriveOrgCatalogReadState(snapshot, loadError);
  // An owner or admin is offered setup on an empty catalog (CAN-3984). Only
  // a confirmed missing connection offers Connect GitHub; a failed or
  // unsupported check offers Choose projects, whose page handles setup too.
  const connection: OrgProjectCatalogGithubConnection = !session.settled
    ? 'checking'
    : githubNotConnected
      ? 'not-connected'
      : 'unavailable';
  // Organization Settings → Integrations or Projects, inside Settings when
  // hosted settings are openable here, otherwise on the web.
  const openOrganizationPage = async (path: string): Promise<void> => {
    setError('');
    const opened = await openSettingsPathOrWebReported(path);
    if (opened !== 'failed') onClose();
    else setError("Couldn't open the page in your browser.");
  };
  const management: OrgProjectCatalogManagement | undefined =
    organization !== undefined &&
    canManageOrganizationProjects(organization.role)
      ? {
          connection,
          onConnectGithub: (): void => {
            void openOrganizationPage(
              organizationIntegrationsPath(context.organizationId),
            );
          },
          onChooseProjects: (): void => {
            void openOrganizationPage(
              organizationProjectsPath(context.organizationId),
            );
          },
        }
      : undefined;
  // Add sets up this one project on demand (CAN-3386, CAN-3469) through the
  // routine App Advisor's add shares (CAN-3592).
  const addProject = async (
    project: OrgProjectSummary,
    requestedDestination: string | null,
  ): Promise<void> => {
    setError('');
    onAddActivityChange(1);
    const outcome = await addOrgProjectToComputer(orgProjectsStore, {
      context,
      project,
      destination: requestedDestination,
      onPending: (busy): void => setPending(busy ? project.id : null),
      offerGitHubConnect: true,
    }).finally((): void => onAddActivityChange(-1));
    if (!mounted.current) return;
    if (outcome.kind === 'listing-failed')
      setError("Couldn't add the project.");
    // Found linked by the fresh check: its row re-renders without Add.
    else if (outcome.kind === 'linked')
      setLinkedAfterListing((previous): readonly string[] => [
        ...previous,
        project.id,
      ]);
    // Setup has a failure to show here, so the dialog stays open for it;
    // once setup is handed over (its own dialog, or started), it closes.
    else if (outcome.kind === 'setup-failed')
      setError(setupFailureText(outcome.cause));
    else if (
      outcome.kind === 'setup-requested' ||
      outcome.kind === 'setup-started'
    )
      onClose();
  };
  // Add the handed-over project once, through the same Add as its row, when
  // the row would offer it. Already on this computer, or not addable: nothing.
  const initialAddDone = useRef(false);
  const initialProject =
    initialAddProjectId === undefined
      ? undefined
      : snapshot?.projects.find(
          (candidate): boolean => candidate.id === initialAddProjectId,
        );
  useEffect((): void => {
    if (
      initialAddDone.current ||
      initialProject === undefined ||
      !linksResolved ||
      pending !== null ||
      stale ||
      unauthorized
    )
      return;
    initialAddDone.current = true;
    if (isOrgProjectAdded(initialProject, localProjectIds)) return;
    const state = deriveOrgProjectPlaceholderState({
      project: initialProject,
      snapshotError: null,
    });
    if (!isOrgProjectAddableState(state)) return;
    const folder =
      initialDestination !== undefined && initialDestination !== ''
        ? initialDestination
        : destination;
    void addProject(
      initialProject,
      orgProjectAddDestination(initialProject, state, folder),
    );
  });
  // The one place to pick another folder for one-click Add; the setup dialog
  // saves and reads the same preference.
  const chooseDestination = async (): Promise<void> => {
    try {
      const result = await window.api.browseForCloneDirectory();
      if (result.canceled || !result.directoryPath) return;
      await window.api.savePreferences({
        orgProjectDefaultDestinationRoot: result.directoryPath,
      });
      setDestination(result.directoryPath);
    } catch {
      setError('Failed to change the folder');
    }
  };
  // The folder line is desktop-only: the shared list renders it under its
  // search as a host slot.
  const destinationLine =
    destination === '' ? undefined : (
      <div
        data-testid="add-workspace-org-catalog-destination"
        title={destination}
        className="flex min-w-0 items-center gap-1.5 text-xs fg-secondary"
      >
        <span className="shrink-0">Clones into</span>
        {/* A path's tail identifies it, so it truncates from the left
            like the setup dialog's destination. */}
        <span className="min-w-0 truncate font-mono" dir="rtl">
          <bdi dir="ltr">{destination}</bdi>
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="add-workspace-org-catalog-change-destination"
          onClick={(): void => {
            void chooseDestination();
          }}
        >
          Change
        </Button>
      </div>
    );
  return (
    <OrgProjectCatalogList
      organizationId={context.organizationId}
      organizationName={organization?.name}
      projects={snapshot?.projects}
      stale={stale}
      unauthorized={unauthorized}
      githubRefreshFailed={githubRefreshFailed}
      error={error}
      addedProjectIds={localProjectIds}
      addAvailable={linksResolved && pending === null}
      setupMessage={(projectId): string | null => {
        const status = localStatuses.get(projectId);
        return status?.state === 'setting-up'
          ? (status.message ?? ORG_PROJECT_SETTING_UP_MESSAGE)
          : null;
      }}
      destination={destinationLine}
      {...(management === undefined ? {} : { management })}
      onAdd={(project, state): void => {
        void addProject(
          project,
          orgProjectAddDestination(project, state, destination),
        );
      }}
    />
  );
}
