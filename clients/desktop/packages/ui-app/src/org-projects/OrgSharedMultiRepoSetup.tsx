'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useStore } from 'zustand';
import {
  useOptionalCanopyClient,
  useSharedMultiRepoSession,
} from '@canopy/app-state';
import type {
  CanopyClient,
  SharedMultiRepoClient,
} from '@canopy/app-core/client';
import type {
  OrgProjectRepository,
  PrepareSharedMultiRepoParams,
  SharedMultiRepoCreationStatus,
  SharedMultiRepoEntryPoint,
  SharedMultiRepoSelection,
} from '@canopy/protocol/org-projects';
import {
  Button,
  LoadingSpinner,
  Notice,
  Stack,
} from '@canopy/ui-shared/components';
import { MultiRepoProjectSetupFields } from '@canopy/ui-shared/components/MultiRepoProjectSetupFields';

export interface OrgSharedMultiRepoSetupProps {
  /** A host outside the active provider subtree can pin the same shared feature to its selected client. */
  readonly hostClient?: CanopyClient;
  readonly mode: SharedMultiRepoEntryPoint;
  readonly sources: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: 'workspace' | 'project';
  }[];
  readonly organizationName?: string;
  readonly onSubmitted?: () => void;
  readonly onClose?: () => void;
  readonly onReady?: (status: SharedMultiRepoCreationStatus) => Promise<void>;
}

export function OrgSharedMultiRepoSetup(
  props: OrgSharedMultiRepoSetupProps,
): JSX.Element {
  const providerClient = useOptionalCanopyClient();
  const client = props.hostClient ?? providerClient;
  if (
    client?.capabilities.sharedMultiRepo !== true ||
    !client.sharedMultiRepo
  ) {
    return (
      <Notice intent="neutral">
        Reconnect to a desktop that supports shared multi-repo projects, then
        try again.
      </Notice>
    );
  }
  return (
    <ConnectedSetup
      key={props.sources.map((source) => source.id).join(':')}
      {...props}
      client={client.sharedMultiRepo}
      openExternalUrl={
        client.openExternalUrl
          ? (url): void => client.openExternalUrl?.(url)
          : undefined
      }
    />
  );
}

function ConnectedSetup({
  client,
  openExternalUrl,
  mode,
  sources,
  organizationName,
  onReady,
  onSubmitted,
  onClose,
}: OrgSharedMultiRepoSetupProps & {
  readonly client: SharedMultiRepoClient;
  readonly openExternalUrl: CanopyClient['openExternalUrl'];
}): JSX.Element {
  const store = useSharedMultiRepoSession(
    client,
    `${mode}:${sources.map((source) => `${source.kind}:${source.id}`).join(':')}`,
  );
  const state = useStore(store);
  const [additions, setAdditions] = useState<
    readonly {
      id: string;
      name: string;
      repository: OrgProjectRepository | null;
    }[]
  >([]);
  const [selected, setSelected] = useState<readonly string[]>(() =>
    (state.submitted?.selections ?? state.selection?.selections ?? [])
      .filter(
        (selection) =>
          selection.kind === 'project' &&
          !sources.some(
            (source) => source.kind === 'project' && source.id === selection.id,
          ),
      )
      .map((selection) => selection.id),
  );
  const [includedRepositories, setIncludedRepositories] = useState<
    readonly OrgProjectRepository[]
  >([]);
  // Keep the source-only expansion while previews of added projects are loading.
  // Selected additions must remain removable, even though they enter the preview.
  useEffect(() => {
    if (
      !state.preview ||
      selected.length > 0 ||
      state.selection?.selections.some(
        (selection) =>
          !sources.some(
            (source) =>
              source.kind === selection.kind && source.id === selection.id,
          ),
      )
    )
      return;
    setIncludedRepositories(state.preview.repositories);
    if (
      state.name === state.preview.suggestedName &&
      state.preview.repositories.length > 1
    ) {
      const parts = sources.flatMap((source) => source.name.split(' + '));
      const distinct = parts.filter(
        (part, index) =>
          parts.findIndex(
            (value) => value.toLowerCase() === part.toLowerCase(),
          ) === index,
      );
      state.setName(distinct.join(' + '));
    }
  }, [state, selected.length, sources]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogSettled, setCatalogSettled] = useState(false);
  const [navigationError, setNavigationError] = useState(false);
  const [opening, setOpening] = useState(false);
  const selectionKey = sources
    .map((source) => `${source.kind}:${source.id}`)
    .join(':');
  const params: PrepareSharedMultiRepoParams = useMemo(
    () => ({
      mode,
      selections: [
        ...sources.map(
          ({ kind, id }): SharedMultiRepoSelection => ({ kind, id }),
        ),
        ...selected.map(
          (id): SharedMultiRepoSelection => ({ kind: 'project', id }),
        ),
      ],
    }),
    // Source identities, rather than their presentation names, own preparation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, selectionKey, selected],
  );
  useEffect(() => {
    // Add repositories requires an addition; resolve the source first with convert.
    void store
      .getState()
      .prepare(
        mode === 'add-repositories' && selected.length === 0
          ? { ...params, mode: 'convert' }
          : params,
      );
  }, [store, params, mode, selected.length]);
  useEffect(() => {
    void store.getState().discover();
  }, [store]);
  const organizationId =
    state.preview?.organizationId ?? state.status?.organizationId;
  const submitted = state.submitted !== null || state.status !== null;
  useEffect(() => {
    if (!organizationId) return;
    let current = true;
    void client
      .catalog(organizationId)
      .then((catalog) => {
        if (!current) return;
        if (catalog.stale || catalog.error)
          throw new Error(
            'Refresh the organization’s projects before choosing repositories.',
          );
        setAdditions(
          catalog.projects
            .filter(
              (project) =>
                project.state === 'ACTIVE' &&
                project.kind === 'CODE' &&
                project.location === 'LOCAL' &&
                project.topology === 'single-repo' &&
                project.visibility === 'organization' &&
                project.capabilities.use &&
                project.repository !== null,
            )
            .map((project) => ({
              id: project.id,
              name: project.name,
              repository: project.repository,
            })),
        );
        setCatalogError(null);
      })
      .catch((error: unknown) => {
        if (current)
          setCatalogError(
            error instanceof Error
              ? error.message
              : 'Couldn’t load organization projects.',
          );
      })
      .finally(() => {
        if (current) setCatalogSettled(true);
      });
    return (): void => {
      current = false;
      // Reset from the cleanup so the next read reports its own loading.
      setCatalogSettled(false);
    };
  }, [client, organizationId]);
  // Separate from the store's `busy`, which also covers submitting. The form
  // is loading from its first render, before the first prepare has started.
  const preparing = state.selection === null && !submitted;
  const catalogLoading = organizationId !== undefined && !catalogSettled;
  const preparationFailed =
    !submitted &&
    state.selection !== null &&
    state.preview === null &&
    !state.busy;
  const errorMessage = preparationFailed
    ? 'Couldn’t load repositories. Check your sign-in, then use Refresh repositories.'
    : state.error === 'Enter a project name.' ||
        state.error === 'Use at most 256 characters for the project name.'
      ? state.error
      : state.error || state.recoveryError || catalogError
        ? submitted
          ? 'Couldn’t update project setup. Try again.'
          : 'Couldn’t load repositories or saved progress. Check your sign-in, then use Refresh repositories.'
        : null;
  const attemptKey =
    state.submitted?.request.creationKey ?? state.status?.creationKey;
  const terminal =
    state.status !== null &&
    ['ready', 'retired', 'rejected'].includes(state.status.state);
  useEffect(() => {
    if (!attemptKey || terminal) return;
    void store.getState().refresh();
    const timer = setInterval(() => {
      void store.getState().refresh();
    }, 2000);
    return (): void => clearInterval(timer);
  }, [store, attemptKey, terminal]);
  useEffect(() => {
    if (submitted && state.status?.state !== 'ready') onSubmitted?.();
  }, [submitted, state.status?.state, onSubmitted]);
  const ready = state.status?.state === 'ready';
  const retryable =
    (state.submitted !== null ||
      (state.status !== null && client.resume !== undefined)) &&
    (!state.status ||
      [
        'create-unconfirmed',
        'setup-failed',
        'setup-cancelled',
        'completion-pending',
        'access-blocked',
      ].includes(state.status.state));
  const additionalRequired =
    (mode === 'add-repositories' ||
      (mode === 'combine' && sources.length === 1)) &&
    selected.length === 0;
  const previewSourceIds =
    state.preview?.sourceProjects.map((source) => source.projectId) ?? [];
  const options = [
    ...includedRepositories
      .filter(
        (repository, index, repositories) =>
          repositories.findIndex((candidate) =>
            sameRepository(candidate, repository),
          ) === index,
      )
      .map((repository) => ({
        id: `repository:${repository.host}/${repository.owner}/${repository.name}`,
        name: `${repository.owner}/${repository.name}`,
        description: sources.map((source) => source.name).join(' + '),
        repositoryUrl: `https://${repository.host}/${repository.owner}/${repository.name}`,
        selected: true,
        locked: true,
      })),
    ...additions
      .filter(
        (project, index, projects) =>
          projects.findIndex((candidate) => {
            const repository = project.repository;
            return (
              repository !== null &&
              candidate.repository !== null &&
              sameRepository(candidate.repository, repository)
            );
          }) === index,
      )
      .filter(
        (project) =>
          !includedRepositories.some(
            (repository) =>
              project.repository &&
              sameRepository(repository, project.repository),
          ) &&
          !sources.some(
            (source) => source.kind === 'project' && source.id === project.id,
          ) &&
          (!previewSourceIds.includes(project.id) ||
            selected.includes(project.id)),
      )
      .map((project) => ({
        ...project,
        name: `${project.repository?.owner}/${project.repository?.name}`,
        description: project.name,
        repositoryUrl: project.repository
          ? `https://${project.repository.host}/${project.repository.owner}/${project.repository.name}`
          : undefined,
        selected: selected.includes(project.id),
      })),
  ];
  // Completed attempts survive dialog dismissal; reopening their source is
  // observation, not another request to navigate away from that source.
  const openedCreation = useRef<string | null>(
    ready ? (attemptKey ?? null) : null,
  );
  const open = useCallback(async (): Promise<void> => {
    if (!state.status || !ready || !onReady || opening) return;
    setOpening(true);
    try {
      await onReady(state.status);
      setNavigationError(false);
    } catch {
      setNavigationError(true);
    } finally {
      setOpening(false);
    }
  }, [state.status, ready, onReady, opening]);
  useEffect(() => {
    if (
      !ready ||
      !attemptKey ||
      !onReady ||
      openedCreation.current === attemptKey
    )
      return;
    openedCreation.current = attemptKey;
    void Promise.resolve().then(open);
  }, [attemptKey, ready, onReady, open]);
  const recentAttempts = state.recent.filter(
    (attempt) => !organizationId || attempt.organizationId === organizationId,
  );
  return (
    <Stack
      as="section"
      gap="group"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      data-testid="org-shared-multi-repo-setup"
    >
      <p className="text-s fg-secondary">
        Create a new project in {organizationName ?? 'the source organization'}.
        Your original projects and their work stay unchanged.
      </p>
      <p className="text-xs fg-secondary">Visibility: Organization</p>
      <div className="flex min-h-52 min-w-0 flex-1 flex-col">
        <MultiRepoProjectSetupFields
          name={state.name}
          onNameChange={(name) => state.setName(name)}
          options={options}
          optionsLabel="Repositories"
          onOpenRepository={openExternalUrl}
          onToggle={(id) => {
            if (submitted || state.busy) return;
            const next = selected.includes(id)
              ? selected.filter((value) => value !== id)
              : [...selected, id];
            setSelected(next);
            void state.prepare({
              mode:
                mode === 'add-repositories' && next.length === 0
                  ? 'convert'
                  : mode,
              selections: [
                ...sources.map(({ kind, id }) => ({ kind, id })),
                ...next.map(
                  (id): SharedMultiRepoSelection => ({ kind: 'project', id }),
                ),
              ],
            });
          }}
          disabled={submitted || state.busy}
          loading={state.busy || preparing || catalogLoading}
        />
      </div>
      {errorMessage && (
        <Notice errorSource="connected-setup" intent="destructive">
          {errorMessage}
        </Notice>
      )}
      {options.length > 0 && (
        <div className="flex flex-col gap-1 text-s fg-secondary">
          <p>
            {options.filter((option) => option.selected).length}{' '}
            {options.filter((option) => option.selected).length === 1
              ? 'repository'
              : 'repositories'}{' '}
            in the new project
          </p>
        </div>
      )}
      {!submitted && state.preview && !state.preview.canCreate && (
        <p role="status" className="text-s fg-secondary">
          An organization owner or admin can create shared projects when this
          feature is available. Ask an admin to check your access.
        </p>
      )}
      {!submitted && additionalRequired && (
        <p className="text-s fg-secondary">
          Select at least one additional repository.
        </p>
      )}
      {submitted && (
        <p role="status" className="flex items-start gap-2 text-s fg-secondary">
          {(state.status?.state === 'creating' ||
            state.status?.state === 'created' ||
            state.status?.state === 'setting-up') && (
            <LoadingSpinner decorative className="mt-0.5 shrink-0" />
          )}
          <span>
            {state.status?.state === 'rejected'
              ? refusalText(state.status.errorCode)
              : statusText(state.status?.state)}
            {(state.status?.state === 'created' ||
              state.status?.state === 'setting-up') &&
              ' You can close this view while setup continues.'}
          </span>
        </p>
      )}
      {navigationError && (
        // Opening the new project failed: a failure interrupts, so it keeps
        // an assertive announcement even in the neutral look.
        <Notice role="alert">
          Your project is ready. Open it from Projects.
        </Notice>
      )}
      <div className="flex shrink-0 flex-wrap gap-2">
        {onClose && (
          <Button size="compact" variant="secondary" onClick={onClose}>
            {submitted ? 'Close' : 'Cancel'}
          </Button>
        )}
        {state.status?.state === 'rejected' &&
          (state.submitted || state.selection) && (
            <Button size="compact" onClick={() => void state.revise()}>
              Review selection
            </Button>
          )}
        {!submitted && (
          <Button
            size="compact"
            disabled={
              state.busy ||
              !state.recoveryChecked ||
              !state.preview?.canCreate ||
              additionalRequired ||
              Boolean(catalogError)
            }
            onClick={() => void state.submit()}
          >
            Create shared project
          </Button>
        )}
        {!submitted && (
          <Button
            size="compact"
            variant="secondary"
            disabled={state.busy}
            onClick={() => {
              void Promise.all([state.prepare(params), state.discover()]);
            }}
          >
            Refresh repositories
          </Button>
        )}
        {retryable && (
          <Button
            size="compact"
            disabled={state.busy}
            onClick={() => void state.submit()}
          >
            Try the same project again
          </Button>
        )}
        {ready && onReady && (
          <Button size="compact" disabled={opening} onClick={() => void open()}>
            {mode === 'combine'
              ? 'New task in this project'
              : 'Open project repositories'}
          </Button>
        )}
        {state.status?.state === 'setting-up' && (
          <Button
            size="compact"
            variant="secondary"
            disabled={state.busy}
            onClick={() => void state.cancelSetup()}
          >
            Cancel setup
          </Button>
        )}
      </div>
      {!submitted && recentAttempts.length > 0 && (
        <div className="max-h-32 min-h-0 shrink-0 overflow-y-auto">
          <Stack gap="group">
            {recentAttempts.map((attempt) => (
              <div
                key={attempt.creationKey}
                className="flex flex-col gap-1 text-s fg-secondary"
              >
                <p>
                  Recent shared project (
                  {new Date(attempt.updatedAt).toLocaleString()}):{' '}
                  {statusText(attempt.state)}
                </p>
                <Button
                  className="self-start"
                  size="compact"
                  variant="secondary"
                  disabled={state.busy}
                  onClick={() => state.observe(attempt)}
                >
                  Check saved progress
                </Button>
              </div>
            ))}
          </Stack>
        </div>
      )}
    </Stack>
  );
}

function sameRepository(
  left: OrgProjectRepository,
  right: OrgProjectRepository,
): boolean {
  return (
    left.provider === right.provider &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    ((left.providerRepoId !== null &&
      left.providerRepoId === right.providerRepoId) ||
      (left.owner.toLowerCase() === right.owner.toLowerCase() &&
        left.name.toLowerCase() === right.name.toLowerCase()))
  );
}

function refusalText(code: string | undefined): string {
  switch (code) {
    case 'stale_selection':
      return 'The selected projects changed. Refresh the repositories and try again.';
    case 'name_conflict':
      return 'A project with this name already exists. Review the selection and choose another name.';
    case 'repository_mismatch':
      return 'A selected repository can’t be used in this organization. Review the repositories or ask an admin to check access.';
    case 'cross_organization':
      return 'Choose projects from the same organization, then try again.';
    case 'forbidden':
      return 'An organization owner or admin must create this shared project. Ask an admin to check your access.';
    default:
      return 'Creation was refused. Check your permissions and the selected projects.';
  }
}

function statusText(
  state: SharedMultiRepoCreationStatus['state'] | undefined,
): string {
  switch (state) {
    case 'ready':
      return 'Your shared project is ready.';
    case 'created':
    case 'setting-up':
      return 'Your project was created. Setting up every repository on the selected desktop…';
    case 'setup-failed':
    case 'setup-cancelled':
      return 'Your project was created, but setup didn’t finish. Your original projects are unchanged.';
    case 'completion-pending':
      return 'Setup is waiting for confirmation. New work will be available when completion is confirmed.';
    case 'retired':
      return 'This project was archived or deleted. It cannot be recreated with this request.';
    case 'access-blocked':
      return 'Project access is unavailable. Ask an organization admin to check your access.';
    case 'rejected':
      return 'Creation was refused. Check your permissions and the selected projects.';
    case 'creating':
      return 'Creating your shared project… You can close this view while setup continues.';
    default:
      return 'Creation hasn’t been confirmed. Try again to check the same project.';
  }
}
