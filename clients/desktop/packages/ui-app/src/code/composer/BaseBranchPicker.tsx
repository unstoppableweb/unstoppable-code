import {
  encodeWorktreeBaseBranch,
  type WorktreeBaseBranchTarget,
} from '@canopy/protocol/portal';
import {
  BranchPickerOptionContent,
  DelayedLoadingPlaceholder,
  Divider,
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuState,
  PickerMenuTab,
  PickerMenuTabList,
  PickerTrigger,
  PickerTriggerChevron,
  PickListResults,
  pickListOptionId,
  resolvePickListActiveKey,
  RichHoverTooltip,
  SearchField,
  Skeleton,
  tabNavigationIndex,
  usePickListKeys,
  WorktreePickerOptionContent,
  branchPickerOptionTestId,
} from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';
import {
  BranchIcon,
  GitPullRequestIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  collapseBranchDuplicates,
  type BranchListEntry,
  type BranchOption,
} from '@canopy/ui-shared/lib/branch-options';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

/** What a new worktree starts from. */
export type BaseBranchTarget =
  | { kind: 'default' }
  | { kind: 'worktree'; worktreeId: string }
  | ({ kind: 'branch' } & WorktreeBaseBranchTarget)
  | {
      kind: 'pr';
      number: number;
      title: string;
      headRefName: string;
      url: string;
    };

export type BaseBranchPickerBranchState =
  | { kind: 'ready'; branches: readonly BranchListEntry[]; truncated?: boolean }
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

export interface BaseBranchPickerWorktree {
  id: string;
  branchName: string;
  /** Row text; defaults to the branch name. */
  label?: string;
  /** Secondary line, e.g. a label that tells duplicate branch names apart. */
  description?: string;
}

export interface BaseBranchPickerPullRequest {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  authorLogin: string;
}

export interface BaseBranchPickerPullRequests {
  state: 'idle' | 'loading' | 'ready' | 'error';
  items: readonly BaseBranchPickerPullRequest[];
  error: string | null;
  /** Called while the PRs tab is open and the state is `idle`. */
  onLoad: () => void;
}

export interface BaseBranchPickerProps {
  value: BaseBranchTarget;
  /** The selected ref was absent from a complete catalogue. */
  selectedBranchMissing?: boolean;
  onChange: (target: BaseBranchTarget) => void;
  worktrees: readonly BaseBranchPickerWorktree[];
  branches: BaseBranchPickerBranchState;
  /** Shown on the branch error state when present. */
  onRetryBranches?: () => void;
  /** Called each time the menu opens, so a host can refresh its data. */
  onOpen?: () => void;
  /** Adds the PRs tab. */
  pullRequests?: BaseBranchPickerPullRequests;
  /** A pinned row that selects the `default` target. */
  defaultOption?: { label: string };
  disabled?: boolean;
  testIdPrefix: string;
  triggerVariant: 'capsule' | 'field';
  /** Classes on the positioning wrapper. */
  className?: string;
  /** Trigger leading icon; defaults to the branch or PR glyph. */
  triggerIcon?: ReactNode;
  /** Hover tip on the trigger. */
  tooltip?: ReactNode;
  tooltipTestId?: string;
}

type BasePickerTab = 'worktrees' | 'prs' | 'branches';
type BranchChoice = BranchOption & { hasBothRefs: boolean };

const TAB_DEFINITIONS = [
  { id: 'worktrees', label: 'Worktrees', ariaLabel: 'Worktrees' },
  { id: 'prs', label: 'PRs', ariaLabel: 'Pull requests' },
  { id: 'branches', label: 'Branches', ariaLabel: 'Branches' },
] as const;

/** Announced while a tab's skeleton rows stand in for it. */
const TAB_LOADING_LABELS: Record<BasePickerTab, string> = {
  worktrees: 'Loading worktrees',
  prs: 'Loading pull requests',
  branches: 'Loading branches',
};

const TAB_SLOW_LOADING_LABELS: Record<BasePickerTab, string> = {
  worktrees: 'Still loading worktrees…',
  prs: 'Still loading pull requests…',
  branches: 'Still loading branches…',
};

function BaseBranchPickerLoadingRows({
  tab,
  testId,
}: {
  tab: BasePickerTab;
  testId: string;
}): JSX.Element {
  const samples =
    tab === 'prs'
      ? [
          '#42 Update the project',
          '#43 Review the changes',
          '#44 Improve setup',
        ]
      : ['main', 'feature/example', 'release/next'];
  return (
    <DelayedLoadingPlaceholder
      key={tab}
      slowNote={TAB_SLOW_LOADING_LABELS[tab]}
    >
      <Skeleton loading label={TAB_LOADING_LABELS[tab]} testId={testId}>
        {samples.map((label) => (
          <PickerMenuOption key={label} disabled>
            <PickerMenuOptionLeading>
              {tab === 'prs' ? <GitPullRequestIcon /> : <BranchIcon />}
            </PickerMenuOptionLeading>
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>{label}</PickerMenuOptionLabel>
              {tab === 'prs' ? (
                <PickerMenuOptionDescription>
                  Example author
                </PickerMenuOptionDescription>
              ) : null}
            </PickerMenuOptionContent>
          </PickerMenuOption>
        ))}
      </Skeleton>
    </DelayedLoadingPlaceholder>
  );
}

const SEARCH_PLACEHOLDERS: Record<BasePickerTab, string> = {
  worktrees: 'Search worktrees',
  prs: 'Search pull requests',
  branches: 'Search branches',
};

const DEFAULT_OPTION_KEY = 'default';

/** Branch names cannot contain `:`, so these keys never collide. */
export function baseBranchTargetKey(target: BaseBranchTarget): string {
  if (target.kind === 'default') return DEFAULT_OPTION_KEY;
  if (target.kind === 'worktree') return `worktree:${target.worktreeId}`;
  if (target.kind === 'pr') return `pr:${target.number}`;
  return `branch:${target.branchName}:${target.isRemote ? 'remote' : 'local'}`;
}

/** Exact branch identity for Portal creation and saved submissions (v2). */
export function baseBranchRef(
  target: Extract<BaseBranchTarget, { kind: 'branch' }>,
): string {
  return encodeWorktreeBaseBranch(target);
}

function tabForTarget(target: BaseBranchTarget): BasePickerTab | null {
  if (target.kind === 'worktree') return 'worktrees';
  if (target.kind === 'pr') return 'prs';
  if (target.kind === 'branch') return 'branches';
  return null;
}

/** Splits a branch with both refs into separate local and remote choices. */
function branchChoicesFor(branches: readonly BranchOption[]): BranchChoice[] {
  return branches.flatMap<BranchChoice>((branch) => {
    const hasBothRefs = branch.hasLocalRef && branch.hasRemoteRef;
    return hasBothRefs
      ? [
          { ...branch, isRemote: false, hasRemoteRef: false, hasBothRefs },
          { ...branch, isRemote: true, hasLocalRef: false, hasBothRefs },
        ]
      : [{ ...branch, hasBothRefs }];
  });
}

function branchChoiceLabel(branch: BranchChoice): string {
  return branch.isRemote ? `origin/${branch.name}` : branch.name;
}

/** One pickable row of the menu. */
type PickerRow =
  | { kind: 'default'; label: string }
  | { kind: 'worktree'; worktree: BaseBranchPickerWorktree }
  | { kind: 'pr'; pr: BaseBranchPickerPullRequest }
  | { kind: 'branch'; branch: BranchChoice };

function rowTarget(row: PickerRow): BaseBranchTarget {
  if (row.kind === 'default') return { kind: 'default' };
  if (row.kind === 'worktree') {
    return { kind: 'worktree', worktreeId: row.worktree.id };
  }
  if (row.kind === 'pr') {
    return {
      kind: 'pr',
      number: row.pr.number,
      title: row.pr.title,
      headRefName: row.pr.headRefName,
      url: row.pr.url,
    };
  }
  return {
    kind: 'branch',
    branchName: row.branch.name,
    isRemote: row.branch.isRemote,
  };
}

function rowKey(row: PickerRow): string {
  return baseBranchTargetKey(rowTarget(row));
}

function rowLabel(row: PickerRow): string {
  if (row.kind === 'default') return row.label;
  if (row.kind === 'worktree') {
    return row.worktree.label ?? row.worktree.branchName;
  }
  if (row.kind === 'pr') return `#${row.pr.number} ${row.pr.title}`;
  return branchChoiceLabel(row.branch);
}

function rowTestId(row: PickerRow, testIdPrefix: string): string {
  if (row.kind === 'default') return `${testIdPrefix}-default`;
  if (row.kind === 'worktree') {
    return `${testIdPrefix}-worktree-${row.worktree.id}`;
  }
  if (row.kind === 'pr') return `${testIdPrefix}-pr-${row.pr.number}`;
  return branchPickerOptionTestId(
    testIdPrefix,
    row.branch,
    row.branch.hasBothRefs,
  );
}

/** Memoized so moving the active row does not redraw every row's tooltip. */
const BaseBranchPickerRowContent = memo(function BaseBranchPickerRowContent({
  row,
  selected,
  testIdPrefix,
}: {
  row: PickerRow;
  selected: boolean;
  testIdPrefix: string;
}): JSX.Element {
  if (row.kind === 'branch') {
    return (
      <BranchPickerOptionContent
        branch={row.branch}
        selected={selected}
        testIdPrefix={testIdPrefix}
      />
    );
  }
  if (row.kind === 'worktree') {
    return (
      <WorktreePickerOptionContent
        label={rowLabel(row)}
        description={row.worktree.description}
        selected={selected}
      />
    );
  }
  return (
    <>
      <PickerMenuOptionLeading>
        {row.kind === 'pr' ? <GitPullRequestIcon /> : <BranchIcon />}
      </PickerMenuOptionLeading>
      <PickerMenuOptionContent>
        <PickerMenuOptionLabel>{rowLabel(row)}</PickerMenuOptionLabel>
        {row.kind === 'pr' ? (
          <PickerMenuOptionDescription>
            {/* Session replay blocks the author's login. */}
            <span className={REPLAY_BLOCK_CLASS}>{row.pr.authorLogin}</span>
          </PickerMenuOptionDescription>
        ) : null}
      </PickerMenuOptionContent>
      <PickerMenuOptionCheck selected={selected} />
    </>
  );
});

/** What the rendered tab says besides its rows. */
type TabStatus =
  | { kind: 'skeleton'; testIdSuffix: 'skeleton' | 'branches-loading' }
  | { kind: 'message'; text: string; testIdSuffix?: 'branches-truncated' }
  | { kind: 'branches-error'; message: string };

/** `sourceRowCount` leaves out the pinned default row. */
function resolveTabStatus(
  tab: BasePickerTab,
  rowsReady: boolean,
  sourceRowCount: number,
  branches: BaseBranchPickerBranchState,
  pullRequests: BaseBranchPickerPullRequests | undefined,
): TabStatus | null {
  if (!rowsReady) return { kind: 'skeleton', testIdSuffix: 'skeleton' };
  if (tab === 'worktrees') {
    return sourceRowCount === 0
      ? { kind: 'message', text: 'No matching worktrees' }
      : null;
  }
  if (tab === 'prs') {
    if (!pullRequests) return null;
    if (pullRequests.state === 'idle' || pullRequests.state === 'loading') {
      return { kind: 'skeleton', testIdSuffix: 'skeleton' };
    }
    if (pullRequests.state === 'error') {
      return {
        kind: 'message',
        text: pullRequests.error ?? 'Could not load pull requests',
      };
    }
    return sourceRowCount === 0
      ? { kind: 'message', text: 'No matching pull requests' }
      : null;
  }
  if (branches.kind === 'loading') {
    return { kind: 'skeleton', testIdSuffix: 'branches-loading' };
  }
  if (branches.kind === 'error') {
    return { kind: 'branches-error', message: branches.message };
  }
  if (branches.kind !== 'ready') return null;
  if (branches.truncated) {
    return {
      kind: 'message',
      text: 'Only some branches are shown.',
      testIdSuffix: 'branches-truncated',
    };
  }
  return sourceRowCount === 0
    ? { kind: 'message', text: 'No matching branches' }
    : null;
}

/** The content of a `PickerMenuState`, inside or below the list. */
function BaseBranchPickerTabState({
  status,
  tab,
  testIdPrefix,
  onRetryBranches,
  retryRef,
  onRetryKeyDown,
}: {
  status: TabStatus;
  tab: BasePickerTab;
  testIdPrefix: string;
  onRetryBranches: (() => void) | undefined;
  retryRef: Ref<HTMLButtonElement>;
  onRetryKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  if (status.kind === 'skeleton') {
    return (
      // Skeleton rows draw their own insets, so they cancel the state's.
      <div className="-m-2 min-w-0 flex-1">
        <BaseBranchPickerLoadingRows
          tab={tab}
          testId={`${testIdPrefix}-${status.testIdSuffix}`}
        />
      </div>
    );
  }
  if (status.kind === 'branches-error') {
    return (
      <span
        className="flex min-w-0 items-center gap-2"
        data-testid={`${testIdPrefix}-branches-error`}
      >
        <span>{status.message}</span>
        {onRetryBranches ? (
          <Button
            type="button"
            variant="ghost-accent"
            size="compact"
            ref={retryRef}
            onKeyDown={onRetryKeyDown}
            onClick={onRetryBranches}
            data-testid={`${testIdPrefix}-branches-retry`}
          >
            Try again
          </Button>
        ) : null}
      </span>
    );
  }
  return (
    <span
      data-testid={
        status.testIdSuffix
          ? `${testIdPrefix}-${status.testIdSuffix}`
          : undefined
      }
    >
      {status.text}
    </span>
  );
}

/**
 * A key pressed during an IME composition belongs to the input method. Stopping
 * it here also keeps Escape from the menu's document-level dismissal.
 */
function keepCompositionKeysInField(
  event: KeyboardEvent<HTMLInputElement>,
): void {
  // Safari reports a composition's keys with keyCode 229.
  if (event.nativeEvent.isComposing || event.keyCode === 229) {
    event.stopPropagation();
  }
}

/**
 * The base picker for a new worktree: an existing worktree, a pull request, or
 * a local or remote branch. Hosts supply data and callbacks; a source the host
 * cannot offer has no tab.
 */
export function BaseBranchPicker({
  value,
  selectedBranchMissing = false,
  onChange,
  worktrees,
  branches,
  onRetryBranches,
  onOpen,
  pullRequests,
  defaultOption,
  disabled = false,
  testIdPrefix,
  triggerVariant,
  className = 'relative',
  triggerIcon,
  tooltip,
  tooltipTestId,
}: BaseBranchPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<BasePickerTab>('branches');
  const [search, setSearch] = useState('');
  // The tab whose rows are on screen. Each branch row mounts its own tooltip,
  // so a large repository's list is slow to render; the picker opens on
  // skeleton rows and swaps the list in once the menu has painted.
  const [renderedTab, setRenderedTab] = useState<BasePickerTab | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const suppressNextTooltipFocusRef = useRef(false);
  const domIdPrefix = useId();
  const listId = `${domIdPrefix}-options`;
  const panelId = `${domIdPrefix}-panel`;
  const menuId = `${testIdPrefix}-menu`;
  const retryRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<BasePickerTab, HTMLButtonElement>());

  const visibleTabs = useMemo(
    () =>
      TAB_DEFINITIONS.filter(
        (tab) =>
          (tab.id !== 'prs' || pullRequests !== undefined) &&
          (tab.id !== 'branches' || branches.kind !== 'unsupported'),
      ),
    [branches.kind, pullRequests],
  );
  const fallbackTab: BasePickerTab = visibleTabs.some(
    (tab) => tab.id === 'branches',
  )
    ? 'branches'
    : 'worktrees';
  // A tab that disappears (for example, branch support is lost) falls back
  // to one that is still offered.
  const shownTab: BasePickerTab = visibleTabs.some(
    (tab) => tab.id === activeTab,
  )
    ? activeTab
    : fallbackTab;

  const filteredWorktrees = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? worktrees.filter(
          (worktree) =>
            worktree.branchName.toLowerCase().includes(needle) ||
            (worktree.label?.toLowerCase().includes(needle) ?? false),
        )
      : worktrees;
  }, [search, worktrees]);
  const allBranchChoices = useMemo(
    () =>
      branches.kind === 'ready'
        ? branchChoicesFor(collapseBranchDuplicates(branches.branches))
        : [],
    [branches],
  );
  const branchChoices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? allBranchChoices.filter((branch) =>
          branchChoiceLabel(branch).toLowerCase().includes(needle),
        )
      : allBranchChoices;
  }, [allBranchChoices, search]);
  const pullRequestItems = pullRequests?.items;
  const filteredPullRequests = useMemo(() => {
    const items = pullRequestItems ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (pr) =>
        String(pr.number).includes(needle) ||
        pr.title.toLowerCase().includes(needle) ||
        pr.authorLogin.toLowerCase().includes(needle),
    );
  }, [pullRequestItems, search]);

  const pullRequestState = pullRequests?.state;
  const loadPullRequests = pullRequests?.onLoad;
  useEffect(() => {
    if (!open || shownTab !== 'prs' || pullRequestState !== 'idle') return;
    loadPullRequests?.();
  }, [loadPullRequests, open, pullRequestState, shownTab]);

  useEffect((): (() => void) | undefined => {
    if (!open || renderedTab === shownTab) return undefined;
    let secondFrame = 0;
    // Two frames: the first runs before the skeleton paints, the second after.
    const firstFrame = requestAnimationFrame((): void => {
      secondFrame = requestAnimationFrame((): void => setRenderedTab(shownTab));
    });
    return (): void => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [shownTab, open, renderedTab]);
  const rowsReady = renderedTab === shownTab;

  const defaultLabel = defaultOption?.label;
  const rows = useMemo((): readonly PickerRow[] => {
    const pinned: PickerRow[] =
      defaultLabel === undefined
        ? []
        : [{ kind: 'default', label: defaultLabel }];
    if (!rowsReady) return pinned;
    if (shownTab === 'worktrees') {
      return [
        ...pinned,
        ...filteredWorktrees.map(
          (worktree): PickerRow => ({ kind: 'worktree', worktree }),
        ),
      ];
    }
    if (shownTab === 'prs') {
      if (pullRequestState !== 'ready') return pinned;
      return [
        ...pinned,
        ...filteredPullRequests.map((pr): PickerRow => ({ kind: 'pr', pr })),
      ];
    }
    if (branches.kind !== 'ready') return pinned;
    return [
      ...pinned,
      ...branchChoices.map((branch): PickerRow => ({ kind: 'branch', branch })),
    ];
  }, [
    branchChoices,
    branches.kind,
    defaultLabel,
    filteredPullRequests,
    filteredWorktrees,
    pullRequestState,
    rowsReady,
    shownTab,
  ]);
  const keys = useMemo(() => rows.map(rowKey), [rows]);
  const rowsByKey = useMemo(
    () => new Map(rows.map((row) => [rowKey(row), row])),
    [rows],
  );
  const selectedKey = baseBranchTargetKey(value);

  // A move belongs to its tab, query and visible rows. Forget removed rows so
  // a later refresh cannot revive a move the resolver has already discarded.
  const [moved, setMoved] = useState<{
    readonly key: string | null;
    readonly tab: BasePickerTab;
    readonly query: string;
  }>({ key: null, tab: shownTab, query: search });
  if (
    moved.tab !== shownTab ||
    moved.query !== search ||
    (moved.key !== null && !rowsByKey.has(moved.key))
  ) {
    setMoved({ key: null, tab: shownTab, query: search });
  }
  const movedKey =
    moved.tab === shownTab &&
    moved.query === search &&
    moved.key !== null &&
    rowsByKey.has(moved.key)
      ? moved.key
      : null;
  // Keep the pinned default reachable by navigation, but start on a match.
  const activeKey = search.trim()
    ? (movedKey ?? keys.find((key) => key !== DEFAULT_OPTION_KEY) ?? null)
    : resolvePickListActiveKey(keys, movedKey, selectedKey);
  const moveActive = (key: string): void =>
    setMoved({ key, tab: shownTab, query: search });

  const selectedLabel =
    value.kind === 'default'
      ? (defaultOption?.label ?? 'Default branch')
      : value.kind === 'worktree'
        ? ((): string => {
            const worktree = worktrees.find(
              (candidate) => candidate.id === value.worktreeId,
            );
            return worktree
              ? (worktree.label ?? worktree.branchName)
              : value.worktreeId;
          })()
        : value.kind === 'pr'
          ? `PR #${value.number}`
          : value.isRemote
            ? `origin/${value.branchName}`
            : value.branchName;
  const triggerLabel = selectedBranchMissing
    ? `${selectedLabel} (missing)`
    : selectedLabel;
  const selectedIconKind: 'branch' | 'pr' =
    value.kind === 'pr' ? 'pr' : 'branch';
  const placeholder = SEARCH_PLACEHOLDERS[shownTab];

  function restoreTriggerFocus(): void {
    suppressNextTooltipFocusRef.current = true;
    buttonRef.current?.focus();
  }

  function commit(target: BaseBranchTarget): void {
    onChange(target);
    setOpen(false);
    restoreTriggerFocus();
  }

  const handleKeys = usePickListKeys({
    keys,
    activeKey,
    onActiveKeyChange: moveActive,
    onPick: (key): void => {
      const row = rowsByKey.get(key);
      if (row) commit(rowTarget(row));
    },
    onEscape: (): void => {
      setOpen(false);
      restoreTriggerFocus();
    },
  });

  const status = resolveTabStatus(
    shownTab,
    rowsReady,
    defaultOption ? rows.length - 1 : rows.length,
    branches,
    pullRequests,
  );
  const statusContent = status ? (
    <BaseBranchPickerTabState
      status={status}
      tab={shownTab}
      testIdPrefix={testIdPrefix}
      onRetryBranches={
        onRetryBranches
          ? (): void => {
              if (retryRef.current?.matches(':focus'))
                searchRef.current?.focus();
              onRetryBranches();
            }
          : undefined
      }
      retryRef={retryRef}
      onRetryKeyDown={(event) => {
        if (event.key !== 'Tab' || !event.shiftKey) return;
        event.preventDefault();
        (tabRefs.current.get(shownTab) ?? searchRef.current)?.focus();
      }}
    />
  ) : null;

  const trigger = (
    <PickerTrigger
      ref={buttonRef}
      onFocus={(event) => {
        if (!suppressNextTooltipFocusRef.current) return;
        suppressNextTooltipFocusRef.current = false;
        event.stopPropagation();
      }}
      onClick={() => {
        const nextOpen = !open;
        setOpen(nextOpen);
        if (nextOpen) {
          setRenderedTab(null);
          setSearch('');
          const openingTab = tabForTarget(value) ?? fallbackTab;
          setActiveTab(openingTab);
          setMoved({ key: null, tab: openingTab, query: '' });
          onOpen?.();
        }
      }}
      disabled={disabled}
      data-testid={`${testIdPrefix}-button`}
      data-target-kind={value.kind}
      aria-label={`Select base branch, current selection ${triggerLabel}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      variant={triggerVariant}
      size={triggerVariant === 'field' ? 'composer' : 'default'}
      className={triggerVariant === 'field' ? 'max-w-64' : 'max-w-52'}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className="flex items-center justify-center fg-tertiary"
          aria-hidden="true"
          data-testid={`${testIdPrefix}-selected-icon-${value.kind}`}
          data-icon={selectedIconKind}
        >
          {triggerIcon ??
            (selectedIconKind === 'pr' ? (
              <GitPullRequestIcon size="md" />
            ) : (
              <BranchIcon size="md" />
            ))}
        </span>
        <span className="min-w-0 flex-1 truncate fg-primary">
          {triggerLabel}
        </span>
      </span>
      <PickerTriggerChevron open={open} />
    </PickerTrigger>
  );

  return (
    <div data-testid={testIdPrefix} className={className}>
      {tooltip ? (
        <RichHoverTooltip
          dataTestId={tooltipTestId ?? `${testIdPrefix}-tooltip`}
          tone="inverse"
          surfaceClassName="w-max max-w-48"
          content={tooltip}
        >
          {trigger}
        </RichHoverTooltip>
      ) : (
        trigger
      )}

      <FloatingPickerMenu
        id={menuId}
        open={open && !disabled}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        placement="bottom-left"
        minimumWidth="18.5rem"
        heightLimit={384}
        initialFocusRef={searchRef}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.key !== 'Tab') return;
          event.preventDefault();
          setOpen(false);
          restoreTriggerFocus();
        }}
        role="dialog"
        aria-modal="false"
        aria-label="Select base branch"
        data-testid={menuId}
      >
        {/* Pulled in so the 16px field inset meets the rows' 12px glyph rail. */}
        <SearchField
          ref={searchRef}
          size="lg"
          className="-ml-2 shrink-0"
          value={search}
          onValueChange={setSearch}
          clearOnEscape={false}
          onKeyDownCapture={(event) => {
            keepCompositionKeysInField(event);
            // FloatingMenu dismisses on unhandled Tab.
            const next = tabRefs.current.get(shownTab) ?? retryRef.current;
            if (
              !event.defaultPrevented &&
              event.key === 'Tab' &&
              !event.shiftKey &&
              next
            ) {
              event.preventDefault();
              next.focus();
            }
          }}
          onKeyDown={handleKeys}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-autocomplete="list"
          // The listbox stays mounted, even empty, for as long as this field.
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={
            activeKey === null ? undefined : pickListOptionId(listId, activeKey)
          }
          data-testid={`${testIdPrefix}-search`}
        />
        <Divider aria-hidden className="-mx-1" />
        {visibleTabs.length > 1 ? (
          <PickerMenuTabList aria-label="Base branch sources">
            {visibleTabs.map((tab, index) => (
              <PickerMenuTab
                key={tab.id}
                ref={(button) => {
                  if (button) tabRefs.current.set(tab.id, button);
                  else tabRefs.current.delete(tab.id);
                }}
                role="tab"
                id={`${panelId}-${tab.id}`}
                aria-selected={shownTab === tab.id}
                aria-label={tab.ariaLabel}
                aria-controls={shownTab === tab.id ? panelId : undefined}
                active={shownTab === tab.id}
                tabIndex={shownTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Tab') {
                    const next = event.shiftKey
                      ? searchRef.current
                      : retryRef.current;
                    if (next) {
                      event.preventDefault();
                      next.focus();
                    }
                    return;
                  }
                  const nextIndex = tabNavigationIndex(
                    event.key,
                    index,
                    visibleTabs.length,
                  );
                  const next =
                    nextIndex === undefined
                      ? undefined
                      : visibleTabs[nextIndex];
                  if (!next) return;
                  event.preventDefault();
                  setActiveTab(next.id);
                  tabRefs.current.get(next.id)?.focus();
                }}
                data-testid={`${testIdPrefix}-tab-${tab.id}`}
              >
                {tab.label}
              </PickerMenuTab>
            ))}
          </PickerMenuTabList>
        ) : null}
        <div
          id={panelId}
          role={visibleTabs.length > 1 ? 'tabpanel' : undefined}
          aria-labelledby={
            visibleTabs.length > 1 ? `${panelId}-${shownTab}` : undefined
          }
          className="flex min-h-0 flex-col"
          data-testid={`${testIdPrefix}-list`}
        >
          {/* Keep the controlled empty listbox mounted without reserving space
              for the primitive's empty-state padding. Status belongs below it. */}
          <div
            className={
              rows.length === 0
                ? 'h-0 shrink-0 overflow-hidden'
                : 'flex min-h-0 flex-col'
            }
          >
            <PickListResults
              items={rows}
              getKey={rowKey}
              getLabel={rowLabel}
              renderItem={(row, state): JSX.Element => (
                <BaseBranchPickerRowContent
                  row={row}
                  selected={state.selected}
                  testIdPrefix={testIdPrefix}
                />
              )}
              onPick={(row): void => commit(rowTarget(row))}
              listId={listId}
              listLabel="Base branch options"
              activeKey={activeKey}
              onActiveKeyChange={moveActive}
              emptyLabel={null}
              selectedKey={selectedKey}
              optionTestId={(row): string => rowTestId(row, testIdPrefix)}
              optionProps={(row) => ({ 'data-option-key': rowKey(row) })}
            />
          </div>
          {statusContent ? (
            <div className={`shrink-0 pb-1${rows.length === 0 ? ' pt-1' : ''}`}>
              <PickerMenuState role="status">{statusContent}</PickerMenuState>
            </div>
          ) : null}
        </div>
      </FloatingPickerMenu>
    </div>
  );
}
