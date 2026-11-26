'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  DialogModal,
  Notice,
  SearchField,
  Skeleton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import type { OrgProjectDetail } from '@canopy/protocol/org-projects';
import type {
  OrganizationRepositoriesRefreshResult,
  OrganizationRepository,
} from '@canopy/protocol/settings/organization-repositories';
import { useSettingsClient, useSettingsPrivacy } from '../host';
import { useSettingsErrorCopy } from '../errors';
import { GITHUB_PICKER_KNOWN_ERRORS } from '../github/github-organization-error-copy';
import {
  listOrganizationRepositories,
  setOrganizationRepositoryHidden,
} from './team-api';
import {
  PROJECTS_ERROR_SCOPE,
  RequestNotice,
  requestFailure,
  type RequestFailure,
} from './team-projects-create-dialog';
import { matchesProjectSearch, RepositoryLabel } from './team-projects-display';

interface TeamProjectsRepositoriesProps {
  orgId: string;
  /** The surrounding project list is saving or paging. */
  disabled: boolean;
  /**
   * Bypass cached GitHub pages: a "Refresh from GitHub" ran since the page
   * loaded, so a repository it just seeded must show its project.
   */
  fresh: boolean;
  /** A hide or unhide archived or restored this project. */
  onProjectChanged: (project: OrgProjectDetail) => void;
  onClose: () => void;
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/** Refresh outcome copy (docs/ux-writing.md, CAN-3414). */
export function refreshSummary(
  result: OrganizationRepositoriesRefreshResult,
): string {
  const summary = `${count(result.added, 'project', 'projects')} added, ${count(
    result.skippedHidden,
    'hidden repository',
    'hidden repositories',
  )} skipped`;
  return result.failed > 0
    ? `${summary}, ${result.failed} couldn't be added. Refresh again to retry.`
    : summary;
}

function projectLine(repository: OrganizationRepository): string | null {
  if (repository.project) {
    return repository.project.state === 'ARCHIVED'
      ? `Project: ${repository.project.name} (archived)`
      : `Project: ${repository.project.name}`;
  }
  if (repository.hidden) return 'Skipped by refresh';
  // Seeding never adds archived GitHub repositories (read-only there).
  return repository.archived
    ? 'Skipped by refresh: archived on GitHub'
    : 'Refresh to add a project';
}

/**
 * Admin Repositories dialog on the organization Projects tab (CAN-3414,
 * CAN-3466): every repository the GitHub App can access, searchable by name,
 * with a checkbox per repository to hide it from seeding. "Refresh from
 * GitHub" lives in the Projects header. Rendered only for owners and admins
 * with the org-projects flag on; the server enforces both.
 */
export function TeamProjectsRepositories({
  orgId,
  disabled,
  fresh,
  onProjectChanged,
  onClose,
}: TeamProjectsRepositoriesProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(PROJECTS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  const [repositories, setRepositories] = useState<OrganizationRepository[]>(
    [],
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<RequestFailure | null>(null);
  const [query, setQuery] = useState('');
  // Requested hidden state per repository while its request runs.
  const [pending, setPending] = useState<Map<number, boolean>>(new Map());
  const [hideError, setHideError] = useState<RequestFailure | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(new Map<number, boolean>());
  const listVersion = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const [reload, setReload] = useState(0);

  useEffect(() => {
    alive.current = true;
    const version = ++listVersion.current;
    const load = async (): Promise<void> => {
      try {
        const page = await listOrganizationRepositories(
          client,
          orgId,
          fresh ? { fresh: true } : {},
        );
        if (!alive.current || version !== listVersion.current) return;
        setRepositories(page.repositories);
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (alive.current && version === listVersion.current)
          setListError(
            requestFailure(
              error,
              errorCopy.loadFailure(error, GITHUB_PICKER_KNOWN_ERRORS),
            ),
          );
      } finally {
        if (alive.current && version === listVersion.current) setLoading(false);
      }
    };
    void load();
    return (): void => {
      alive.current = false;
      listVersion.current += 1;
    };
  }, [client, errorCopy, orgId, fresh, reload]);

  /** Start the list over from the first page. */
  const loadFirstPage = (): void => {
    setLoading(true);
    setListError(null);
    setReload((current) => current + 1);
  };

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loading) return;
    const version = listVersion.current;
    setLoading(true);
    setListError(null);
    try {
      const page = await listOrganizationRepositories(client, orgId, {
        cursor: nextCursor,
        ...(fresh ? { fresh: true } : {}),
      });
      if (!alive.current || version !== listVersion.current) return;
      setRepositories((current) => [
        ...current,
        ...page.repositories.filter(
          (repository) =>
            !current.some((existing) => existing.id === repository.id),
        ),
      ]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (alive.current && version === listVersion.current)
        setListError(
          requestFailure(
            error,
            errorCopy.loadFailure(error, GITHUB_PICKER_KNOWN_ERRORS),
          ),
        );
    } finally {
      if (alive.current && version === listVersion.current) setLoading(false);
    }
  };

  const setHidden = async (
    repository: OrganizationRepository,
    hidden: boolean,
  ): Promise<void> => {
    if (inFlight.current.has(repository.id)) return;
    inFlight.current.set(repository.id, hidden);
    setPending(new Map(inFlight.current));
    setHideError(null);
    try {
      const result = await setOrganizationRepositoryHidden(
        client,
        orgId,
        String(repository.id),
        hidden
          ? { hidden, owner: repository.owner, name: repository.name }
          : { hidden },
      );
      if (!alive.current) return;
      const changedProject = result.project;
      setRepositories((current) =>
        current.map((row) =>
          row.id !== repository.id
            ? row
            : {
                ...row,
                hidden: result.hidden,
                project:
                  changedProject && row.project
                    ? {
                        ...row.project,
                        name: changedProject.name,
                        state:
                          changedProject.state === 'ACTIVE'
                            ? 'ACTIVE'
                            : 'ARCHIVED',
                      }
                    : row.project,
              },
        ),
      );
      if (changedProject) onProjectChanged(changedProject);
    } catch (error) {
      if (alive.current)
        setHideError(
          requestFailure(
            error,
            errorCopy.actionFailure(error, {
              action: 'update this repository',
              known: GITHUB_PICKER_KNOWN_ERRORS,
            }),
          ),
        );
    } finally {
      inFlight.current.delete(repository.id);
      if (alive.current) setPending(new Map(inFlight.current));
    }
  };

  const visible = repositories.filter((repository) =>
    matchesProjectSearch(query, [repository.name, repository.project?.name]),
  );

  return (
    <DialogModal
      title="GitHub repositories"
      dataTestId="team-projects-repositories"
      maxWidth="2xl"
      trapFocus
      initialFocusRef={searchRef}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="max-w-2xl text-s fg-secondary">
          Refresh adds a project for each repository that doesn&apos;t have one.
          Hiding a repository skips it and archives the project added for it.
          Projects you created stay as they are.
        </p>
        <SearchField
          ref={searchRef}
          aria-label="Search repositories"
          placeholder="Search repositories"
          data-testid="team-projects-repositories-search"
          value={query}
          onValueChange={setQuery}
          className="w-full max-w-sm"
        />
        {hideError && <RequestNotice failure={hideError} orgId={orgId} />}
        {listError && <RequestNotice failure={listError} orgId={orgId} />}
        {listError && repositories.length === 0 && (
          <Button
            size="compact"
            variant="secondary"
            disabled={loading}
            onClick={(): void => loadFirstPage()}
          >
            Try again
          </Button>
        )}
        {loading && repositories.length === 0 && (
          <DelayedLoadingPlaceholder>
            <RepositoryListSkeleton />
          </DelayedLoadingPlaceholder>
        )}
        {!loading && !listError && repositories.length === 0 && (
          <Notice>
            Give the GitHub App access to repositories to list them here.
          </Notice>
        )}
        {repositories.length > 0 && visible.length === 0 && (
          <p
            data-testid="team-projects-repositories-no-results"
            className="text-s fg-secondary"
          >
            No repositories match your search.
          </p>
        )}
        {visible.length > 0 && (
          <ul className="flex flex-col divide-y">
            {visible.map((repository) => (
              <RepositoryRow
                key={repository.id}
                repository={repository}
                blockClassName={blockClassName}
                busy={pending.has(repository.id)}
                checked={pending.get(repository.id) ?? repository.hidden}
                disabled={disabled || pending.has(repository.id)}
                onChange={(): void => {
                  void setHidden(repository, !repository.hidden);
                }}
              />
            ))}
          </ul>
        )}
        {nextCursor && (
          <Button
            variant="secondary"
            size="compact"
            className="self-start"
            data-testid="team-projects-repositories-load-more"
            loading={loading}
            disabled={disabled}
            onClick={(): void => {
              void loadMore();
            }}
          >
            Load more
          </Button>
        )}
      </div>
    </DialogModal>
  );
}

interface RepositoryRowProps {
  repository: OrganizationRepository;
  /** The host's session-replay block token; '' when the host has none. */
  blockClassName: string;
  busy: boolean;
  /** Whether the repository reads as hidden, including a pending change. */
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}

/** One repository: its name, its project line, and its Hide switch. */
function RepositoryRow({
  repository,
  blockClassName,
  busy,
  checked,
  disabled,
  onChange,
}: RepositoryRowProps): JSX.Element {
  const line = projectLine(repository);
  return (
    <li
      data-testid={`team-projects-repository-${repository.id}`}
      aria-busy={busy}
      className="flex items-center gap-4 py-3 text-s"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <RepositoryLabel
          owner={repository.owner}
          name={repository.name}
          data-testid={`team-projects-repository-label-repo-${repository.id}`}
        />
        {line && (
          <span
            className={
              blockClassName === ''
                ? 'break-words fg-secondary'
                : `break-words fg-secondary ${blockClassName}`
            }
          >
            {line}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2 fg-secondary">
        <span aria-hidden="true">Hide</span>
        <ToggleSwitch
          dataTestId={`team-projects-repository-hide-${repository.id}`}
          label={`Hide ${repository.fullName}`}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
        />
      </span>
    </li>
  );
}

const noop = (): void => undefined;

/** Sample repositories for the loading state: plain, of the loaded shape. */
const SAMPLE_REPOSITORIES: readonly OrganizationRepository[] = [
  {
    id: 1,
    fullName: 'sample/repository',
    owner: 'sample',
    name: 'repository',
    defaultBranch: 'main',
    private: false,
    archived: false,
    htmlUrl: '',
    hidden: false,
    project: null,
  },
  {
    id: 2,
    fullName: 'sample/another',
    owner: 'sample',
    name: 'another',
    defaultBranch: 'main',
    private: false,
    archived: false,
    htmlUrl: '',
    hidden: false,
    project: null,
  },
];

/**
 * The repository list while it loads: the real rows with sample repositories
 * inside `Skeleton`, so skullet measures them into bars in place.
 */
function RepositoryListSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading repositories"
      testId="settings-skeleton-list"
      className="w-full"
    >
      <ul className="flex flex-col divide-y">
        {SAMPLE_REPOSITORIES.map((repository) => (
          <RepositoryRow
            key={repository.id}
            repository={repository}
            blockClassName=""
            busy={false}
            checked={false}
            disabled={false}
            onChange={noop}
          />
        ))}
      </ul>
    </Skeleton>
  );
}
