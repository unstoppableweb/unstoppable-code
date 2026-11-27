'use client';

import { Dot } from '@canopy/ui-shared/primitives/Badge';
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  Button,
  ChoiceList,
  ChoiceField,
  CopyDetailsButton,
  DelayedLoadingPlaceholder,
  Picker,
  Notice,
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
  PickerSection,
  PickerSectionLabel,
  RailIconButton,
  SearchField,
  Skeleton,
  Badge,
} from '@canopy/ui-shared/components';
import { FilterIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  GITHUB_REPOSITORY_QUERY_MAX_LENGTH,
  type GitHubRepositoryPickerItem,
  type GitHubRepositoryPickerPage,
} from '@canopy/protocol/settings/organization-repositories';
import { useSettingsPrivacy } from '../host';
import {
  useSettingsErrorCopy,
  type KnownSettingsError,
  type SettingsFailure,
} from '../errors';

// ---------------------------------------------------------------------------
// A searchable, filterable multi-select over one GitHub App installation's
// repositories. Shared by the organization projects create dialog and the
// code review approvals section; each caller supplies the page loader, its
// error scope and how a failure renders.
// ---------------------------------------------------------------------------

export type GitHubRepositoryMultiPickerItem = GitHubRepositoryPickerItem;

export interface GitHubRepositoryPageRequest {
  query: string;
  cursor?: string;
}

/** Class tokens joined without stray whitespace when one is empty. */
function joinClasses(...classes: string[]): string {
  return classes.filter(Boolean).join(' ');
}

type VisibilityFilter = 'all' | 'public' | 'private';
type StatusFilter = 'all' | 'active' | 'archived';
interface RepositoryFilters {
  visibility: VisibilityFilter;
  status: StatusFilter;
}
const NO_FILTERS: RepositoryFilters = { visibility: 'all', status: 'all' };

function matchesFilters(
  repository: GitHubRepositoryPickerItem,
  filters: RepositoryFilters,
): boolean {
  if (filters.visibility === 'public' && repository.private) return false;
  if (filters.visibility === 'private' && !repository.private) return false;
  if (filters.status === 'active' && repository.archived) return false;
  if (filters.status === 'archived' && !repository.archived) return false;
  return true;
}

interface FilterOption<Value extends string> {
  value: Value;
  label: string;
  testId: string;
}
const VISIBILITY_OPTIONS: ReadonlyArray<FilterOption<VisibilityFilter>> = [
  { value: 'all', label: 'All', testId: 'any-visibility' },
  { value: 'public', label: 'Public', testId: 'public' },
  { value: 'private', label: 'Private', testId: 'private' },
];
const STATUS_OPTIONS: ReadonlyArray<FilterOption<StatusFilter>> = [
  { value: 'all', label: 'All', testId: 'any-status' },
  { value: 'active', label: 'Active', testId: 'active' },
  { value: 'archived', label: 'Archived', testId: 'archived' },
];

interface RepositoryFilterMenuProps {
  filters: RepositoryFilters;
  onChange: (filters: RepositoryFilters) => void;
  disabled: boolean;
  testIdPrefix: string;
}

/**
 * Private and Archived filters for the picker (CAN-3466), following the
 * shared filter-menu pattern: a filter icon with an active dot and a checked
 * menu that stays open while choosing.
 */
function RepositoryFilterMenu({
  filters,
  onChange,
  disabled,
  testIdPrefix,
}: RepositoryFilterMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const active =
    filters.visibility !== NO_FILTERS.visibility ||
    filters.status !== NO_FILTERS.status;
  const title = 'Filter repositories';
  const section = <Value extends string>(
    heading: string,
    options: ReadonlyArray<FilterOption<Value>>,
    current: Value,
    choose: (value: Value) => void,
  ): JSX.Element => (
    <div role="group" aria-label={heading}>
      <PickerSectionLabel>{heading}</PickerSectionLabel>
      {options.map((option) => {
        const checked = option.value === current;
        return (
          <PickerOption
            key={option.value}
            role="menuitemradio"
            aria-checked={checked}
            selected={checked}
            data-testid={`${testIdPrefix}-filter-${option.testId}`}
            onClick={(): void => choose(option.value)}
          >
            <PickerOptionCheck selected={checked} reserveSpace />
            <PickerOptionContent>
              <PickerOptionLabel>{option.label}</PickerOptionLabel>
            </PickerOptionContent>
          </PickerOption>
        );
      })}
    </div>
  );
  return (
    <div className="relative shrink-0">
      <RailIconButton
        ref={triggerRef}
        icon={FilterIcon}
        iconSize={16}
        size="row"
        hoverSurface
        disabled={disabled}
        aria-label={title}
        aria-haspopup="true"
        aria-expanded={open}
        title={title}
        data-testid={`${testIdPrefix}-filter-trigger`}
        data-active={active ? 'true' : 'false'}
        onClick={(): void => setOpen((current) => !current)}
      />
      {active && (
        <Dot
          tone="filter"
          className="pointer-events-none absolute right-0.5 top-0.5"
        />
      )}
      <Picker
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        interaction="menu"
        closeOnSelect={false}
        aria-label={title}
        data-testid={`${testIdPrefix}-filter-menu`}
      >
        {section(
          'Visibility',
          VISIBILITY_OPTIONS,
          filters.visibility,
          (visibility) => onChange({ ...filters, visibility }),
        )}
        <PickerSection>
          {section('Status', STATUS_OPTIONS, filters.status, (status) =>
            onChange({ ...filters, status }),
          )}
        </PickerSection>
      </Picker>
    </div>
  );
}

interface RepositoryChoiceProps {
  repository: GitHubRepositoryPickerItem;
  /** The host's session-replay block token; '' when the host has none. */
  blockClassName: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  testIdPrefix: string;
}

/** One repository in the picker: its name, default branch, and pills. */
function RepositoryChoice({
  repository,
  blockClassName,
  selected,
  disabled,
  onClick,
  testIdPrefix,
}: RepositoryChoiceProps): JSX.Element {
  return (
    <ChoiceField
      layout="row"
      data-testid={`${testIdPrefix}-${repository.id}`}
      checked={selected}
      disabled={disabled}
      onChange={onClick}
      end={
        repository.private || repository.archived ? (
          <span className="flex items-center gap-2">
            {repository.private && <Badge>Private</Badge>}
            {repository.archived && <Badge>Archived</Badge>}
          </span>
        ) : undefined
      }
      label={
        <span
          className={joinClasses('min-w-0 flex-1 break-words', blockClassName)}
        >
          {repository.fullName}
          <span className="block fg-secondary">
            Default branch: {repository.defaultBranch ?? 'Not set'}
          </span>
        </span>
      }
    />
  );
}

const noop = (): void => undefined;

/** Sample repositories for the loading state: plain, of the loaded shape. */
const SAMPLE_REPOSITORIES: readonly GitHubRepositoryPickerItem[] = [
  {
    id: 1,
    fullName: 'sample/repository',
    owner: 'sample',
    name: 'repository',
    defaultBranch: 'main',
    private: false,
    archived: false,
    htmlUrl: '',
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
  },
];

/**
 * The repository picker while it loads: the real choices with sample
 * repositories inside `Skeleton`, so skullet measures them into bars in place.
 */
function RepositoryChoicesSkeleton({
  testIdPrefix,
}: {
  testIdPrefix: string;
}): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading repositories"
      testId="settings-skeleton-list"
      className="w-full"
    >
      <ChoiceList aria-label="Repositories">
        {SAMPLE_REPOSITORIES.map((repository) => (
          <RepositoryChoice
            key={repository.id}
            repository={repository}
            blockClassName=""
            selected={false}
            disabled={false}
            onClick={noop}
            testIdPrefix={testIdPrefix}
          />
        ))}
      </ChoiceList>
    </Skeleton>
  );
}

/** The default failure notice: the chosen copy and its copyable details. */
function DefaultPickerError({
  failure,
}: {
  failure: SettingsFailure;
}): JSX.Element {
  return (
    <Notice
      intent="attention"
      actions={
        failure.details !== undefined ? (
          <CopyDetailsButton details={failure.details} />
        ) : undefined
      }
    >
      {failure.copy}
    </Notice>
  );
}

const EMPTY_PAGE: GitHubRepositoryPickerPage = {
  repositories: [],
  nextCursor: null,
  repositorySelection: null,
};

export interface GitHubRepositoryMultiPickerProps {
  /** Loads one page of the installation's repositories. */
  listRepositories: (
    request: GitHubRepositoryPageRequest,
  ) => Promise<GitHubRepositoryPickerPage>;
  selected: readonly GitHubRepositoryPickerItem[];
  onSelectionChange: (repositories: GitHubRepositoryPickerItem[]) => void;
  disabled: boolean;
  /** Most repositories the caller accepts at once. */
  maxSelected: number;
  /** Logs scope for the picker's load failures. */
  errorScope: string;
  /** Known server failures and their copy. */
  knownErrors?: readonly KnownSettingsError[];
  /** How a failure renders; a plain attention notice by default. */
  renderError?: (error: unknown, failure: SettingsFailure) => ReactNode;
  /**
   * Prefix of every test id: `<prefix>-picker` on the section,
   * `<prefix>-<repository id>` on a row, `<prefix>-filter-*` on the filter
   * menu and `<prefix>-load-more` on the paging button.
   */
  testIdPrefix: string;
}

interface PickerFailure {
  error: unknown;
  failure: SettingsFailure;
}

export function GitHubRepositoryMultiPicker({
  listRepositories,
  selected,
  onSelectionChange,
  disabled,
  maxSelected,
  errorScope,
  knownErrors,
  renderError,
  testIdPrefix,
}: GitHubRepositoryMultiPickerProps): JSX.Element {
  const errorCopy = useSettingsErrorCopy(errorScope);
  const { blockClassName } = useSettingsPrivacy();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<GitHubRepositoryPickerPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PickerFailure | null>(null);
  const [retry, setRetry] = useState(0);
  const [filters, setFilters] = useState<RepositoryFilters>(NO_FILTERS);
  const requestVersion = useRef(0);
  const pending = useRef(false);
  const searchEdited = useRef(false);
  // The loader is read through a ref so a caller's inline function does not
  // reload the first page on every render.
  const loader = useRef(listRepositories);
  loader.current = listRepositories;
  const known = useRef(knownErrors);
  known.current = knownErrors;

  useEffect(() => {
    const version = ++requestVersion.current;
    pending.current = true;
    const load = async (): Promise<void> => {
      try {
        const response = await loader.current({ query });
        if (requestVersion.current === version) setPage(response);
      } catch (err) {
        if (requestVersion.current === version)
          setError({
            error: err,
            failure: errorCopy.loadFailure(err, known.current),
          });
      } finally {
        if (requestVersion.current === version) {
          pending.current = false;
          setLoading(false);
        }
      }
    };
    // The first page opens immediately; edits to the query wait for typing to settle.
    const timer = searchEdited.current
      ? setTimeout((): void => {
          void load();
        }, 300)
      : undefined;
    if (!searchEdited.current) void load();
    return (): void => {
      clearTimeout(timer);
      requestVersion.current = version + 1;
    };
  }, [errorCopy, query, retry]);

  const resetSearch = (): void => {
    ++requestVersion.current;
    pending.current = true;
    setLoading(true);
    setError(null);
    setPage(EMPTY_PAGE);
  };

  const loadMore = async (): Promise<void> => {
    if (!page.nextCursor || pending.current || disabled) return;
    const version = requestVersion.current;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await loader.current({
        query,
        cursor: page.nextCursor,
      });
      if (version === requestVersion.current)
        setPage((current) => ({
          ...response,
          repositories: [
            ...current.repositories,
            ...response.repositories.filter(
              (repository) =>
                !current.repositories.some(
                  (existing) => existing.id === repository.id,
                ),
            ),
          ],
        }));
    } catch (err) {
      if (version === requestVersion.current)
        setError({
          error: err,
          failure: errorCopy.loadFailure(err, known.current),
        });
    } finally {
      if (version === requestVersion.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  };
  const capped = selected.length >= maxSelected;
  // Filters narrow what is shown, never the selection.
  const filtered = page.repositories.filter((repository) =>
    matchesFilters(repository, filters),
  );
  return (
    <section
      data-testid={`${testIdPrefix}-picker`}
      className="flex flex-col gap-4"
    >
      <div className="flex items-end gap-2">
        <SearchField
          aria-label="Search repositories"
          placeholder="Search repositories"
          maxLength={GITHUB_REPOSITORY_QUERY_MAX_LENGTH}
          value={query}
          disabled={disabled}
          className="min-w-0 flex-1"
          onValueChange={(value): void => {
            const nextQuery = value.slice(
              0,
              GITHUB_REPOSITORY_QUERY_MAX_LENGTH,
            );
            if (nextQuery !== query) {
              resetSearch();
              searchEdited.current = true;
              setQuery(nextQuery);
            }
          }}
        />
        <RepositoryFilterMenu
          filters={filters}
          onChange={setFilters}
          disabled={disabled}
          testIdPrefix={testIdPrefix}
        />
      </div>
      {page.repositorySelection === 'selected' && (
        <Notice>
          Only repositories the installation was granted show here. Manage
          access on GitHub to add more.
        </Notice>
      )}
      {error &&
        (renderError ? (
          renderError(error.error, error.failure)
        ) : (
          <DefaultPickerError failure={error.failure} />
        ))}
      {error && !page.nextCursor && (
        <Button
          variant="secondary"
          size="compact"
          className="self-start"
          disabled={loading || disabled}
          onClick={(): void => {
            resetSearch();
            setRetry((current) => current + 1);
          }}
        >
          Try again
        </Button>
      )}
      {loading && page.repositories.length === 0 && (
        <DelayedLoadingPlaceholder>
          <RepositoryChoicesSkeleton testIdPrefix={testIdPrefix} />
        </DelayedLoadingPlaceholder>
      )}
      {!loading && !error && page.repositories.length === 0 && (
        <Notice>
          No repositories found. Try another search or manage access on GitHub.
        </Notice>
      )}
      {page.repositories.length > 0 && filtered.length === 0 && (
        <p className="text-s fg-secondary">
          No repositories match these filters.
        </p>
      )}
      {filtered.length > 0 && (
        <ChoiceList aria-label="Repositories">
          {filtered.map((repository) => {
            const checked = selected.some(
              (entry) => entry.id === repository.id,
            );
            return (
              <RepositoryChoice
                key={repository.id}
                repository={repository}
                blockClassName={blockClassName}
                selected={checked}
                disabled={disabled || (!checked && capped)}
                testIdPrefix={testIdPrefix}
                onClick={(): void => {
                  if (checked)
                    onSelectionChange(
                      selected.filter((entry) => entry.id !== repository.id),
                    );
                  else if (!capped)
                    onSelectionChange([...selected, repository]);
                }}
              />
            );
          })}
        </ChoiceList>
      )}
      <p aria-live="polite">{selected.length} selected</p>
      {capped && <Notice>Select up to {maxSelected} repositories.</Notice>}
      {page.nextCursor && (
        <Button
          variant="secondary"
          size="compact"
          className="self-start"
          data-testid={`${testIdPrefix}-load-more`}
          loading={loading}
          disabled={disabled}
          onClick={(): void => {
            void loadMore();
          }}
        >
          Load more
        </Button>
      )}
    </section>
  );
}
