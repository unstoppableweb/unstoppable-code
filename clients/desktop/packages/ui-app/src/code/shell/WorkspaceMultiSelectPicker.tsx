'use client';

import { useMemo, type JSX, type ReactNode } from 'react';
import {
  ChoiceList,
  ChoiceField,
  ProjectAvatarBadge,
  SearchEmptyState,
  SearchField,
  Skeleton,
  SlowLoadNote,
} from '@canopy/ui-shared/components';
import { SLOW_LOAD_NOTE_DELAY_MS, useDelayedFlag } from '@canopy/ui-shared/lib';

/**
 * Neutral, display-only project option for {@link WorkspaceMultiSelectPicker}.
 * Every caller maps its own data into this shape.
 */
export interface WorkspacePickerOption {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly isMultiRepo: boolean;
  readonly repoCount: number;
  readonly temporary: boolean;
  /** GitHub owner avatar for a single-repo project, when the host has it. */
  readonly avatarUrl?: string;
}

/**
 * Subtitle for a project entry in the worktree-join pickers. Multi-repo
 * projects show "N repos" (with "• Temporary" appended for temporary ones);
 * single-repo projects have no subtitle.
 */
export function describeWorkspaceSubtitle({
  isMultiRepo,
  repoCount,
  temporary,
}: {
  readonly isMultiRepo: boolean;
  readonly repoCount: number;
  readonly temporary: boolean;
}): string | null {
  if (!isMultiRepo) {
    return null;
  }
  const baseLabel = `${repoCount} ${repoCount === 1 ? 'repo' : 'repos'}`;
  return temporary ? `${baseLabel} • Temporary` : baseLabel;
}

export interface WorkspaceMultiSelectPickerProps<
  TOption extends WorkspacePickerOption,
> {
  readonly options: readonly TOption[];
  readonly selectedWorkspaceIds: readonly string[];
  readonly onToggleWorkspace: (workspaceId: string) => void;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (value: string) => void;
  readonly label?: string;
  readonly emptyMessage?: string;
  readonly testIdPrefix?: string;
  /** The list's height cap; the list scrolls inside it. */
  readonly listHeight?: WorkspacePickerListHeight;
  /** The row's project icon; defaults to the shared project avatar badge. */
  readonly renderOptionIcon?: (option: TOption) => ReactNode;
  /** The options are on their way: the search waits over placeholder rows. */
  readonly loading?: boolean;
  /** Says what is still loading once a load runs long. */
  readonly loadingSlowNote?: ReactNode;
}

export type WorkspacePickerListHeight = 'compact' | 'medium' | 'viewport';

const LOADING_ROW_SAMPLES = [
  'Project name',
  'Another project name',
  'Project',
  'Longer project name',
];

const LIST_HEIGHT_CLASS: Readonly<Record<WorkspacePickerListHeight, string>> = {
  compact: 'max-h-48',
  medium: 'max-h-72',
  viewport: 'max-h-[40vh]',
};

function getWorkspaceOptionDisplayName(option: WorkspacePickerOption): string {
  return typeof option.name === 'string' && option.name.trim().length > 0
    ? option.name
    : 'Repository';
}

/**
 * Searchable multi-select list of projects: the shared search field over the
 * shared choice list, one row per project with its checkbox mark, icon and
 * subtitle; clicking a row toggles its selection. Presentation only: the
 * caller owns the selection and the options.
 */
export function WorkspaceMultiSelectPicker<
  TOption extends WorkspacePickerOption,
>({
  options,
  selectedWorkspaceIds,
  onToggleWorkspace,
  searchQuery,
  onSearchQueryChange,
  label = 'Project',
  emptyMessage = 'No projects match your search.',
  testIdPrefix = 'workspace-picker',
  listHeight = 'compact',
  renderOptionIcon,
  loading = false,
  loadingSlowNote,
}: WorkspaceMultiSelectPickerProps<TOption>): JSX.Element {
  const slowLoad = useDelayedFlag(
    loading && loadingSlowNote !== undefined,
    SLOW_LOAD_NOTE_DELAY_MS,
  );
  const selectedWorkspaceIdSet = useMemo(
    () => new Set(selectedWorkspaceIds),
    [selectedWorkspaceIds],
  );
  const filteredOptions = useMemo<readonly TOption[]>(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      getWorkspaceOptionDisplayName(option).toLowerCase().includes(normalized),
    );
  }, [options, searchQuery]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="block text-xs fg-secondary">{label}</span>
      <SearchField
        size="sm"
        value={searchQuery}
        onValueChange={onSearchQueryChange}
        placeholder="Search projects"
        aria-label="Search projects"
        data-testid={`${testIdPrefix}-search`}
        disabled={loading}
      />
      {loading ? (
        // No placeholder delay: these rows hold the list's shape from the first
        // frame, and only the slow-load note waits.
        <div className="flex flex-col gap-3">
          <Skeleton
            loading
            label="Loading projects"
            testId={`${testIdPrefix}-loading`}
          >
            <ChoiceList aria-label={label}>
              {LOADING_ROW_SAMPLES.map((sample) => (
                <ChoiceField
                  key={sample}
                  layout="row"
                  checked={false}
                  disabled
                  label={sample}
                />
              ))}
            </ChoiceList>
          </Skeleton>
          {loadingSlowNote === undefined ? null : (
            <SlowLoadNote show={slowLoad}>{loadingSlowNote}</SlowLoadNote>
          )}
        </div>
      ) : filteredOptions.length === 0 ? (
        <SearchEmptyState
          testId={`${testIdPrefix}-no-matches`}
          title={emptyMessage}
          {...(searchQuery.trim() === ''
            ? {}
            : {
                actionLabel: 'Clear search',
                onAction: () => onSearchQueryChange(''),
                actionTestId: `${testIdPrefix}-clear-search`,
              })}
        />
      ) : (
        <div
          className={`flex min-w-0 flex-col ${LIST_HEIGHT_CLASS[listHeight]}`}
        >
          <ChoiceList
            aria-label={label}
            className="min-h-0 overflow-x-hidden"
            data-testid={`${testIdPrefix}-list`}
          >
            {filteredOptions.map((option) => {
              const subtitle = describeWorkspaceSubtitle(option);
              const optionName = getWorkspaceOptionDisplayName(option);
              return (
                <ChoiceField
                  key={option.id}
                  layout="row"
                  checked={selectedWorkspaceIdSet.has(option.id)}
                  onChange={() => onToggleWorkspace(option.id)}
                  data-testid={`${testIdPrefix}-option-${option.id}`}
                  end={subtitle || undefined}
                  label={
                    // The project's glyph leads the name, between the mark
                    // and the text.
                    <span className="flex min-w-0 items-center gap-3">
                      {renderOptionIcon ? (
                        renderOptionIcon(option)
                      ) : (
                        <ProjectAvatarBadge
                          kind={
                            option.isMultiRepo ? 'multi-repo' : 'single-repo'
                          }
                          temporary={option.temporary}
                          color={option.color}
                          avatarUrl={option.avatarUrl}
                        />
                      )}
                      <span
                        className="block min-w-0 flex-1 truncate font-medium"
                        title={optionName}
                      >
                        {optionName}
                      </span>
                    </span>
                  }
                />
              );
            })}
          </ChoiceList>
        </div>
      )}
    </div>
  );
}
