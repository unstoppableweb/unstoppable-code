'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { WORKTREE_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import {
  ArchiveIcon,
  ArrowUpRight,
  EyeIcon,
  EyeOffIcon,
  MoreHorizontalIcon,
  RefreshIcon,
  TrashIcon,
  TrashPermanentlyIcon,
} from '../icons/AppIcons';
import { ActionMenuRowStyle } from './ActionMenuItems';
import { Count } from './Badge';
import { Button } from './Button';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
} from './DropdownMenu';
import { FLOATING_MENU_GAP, FloatingMenu } from './FloatingMenu';
import { Heading } from './Heading';
import { PageColumn } from './PageColumn';
import { PageHeader } from './PageHeader';
import { PageSearchField, PageSearchRow } from './PageSearchRow';
import { SearchEmptyState } from './SearchField';
import { Skeleton } from './Skeleton';
import { Stack } from './Stack';
import { Surface } from './Surface';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { TabBar } from './TabBar';
import { Tooltip } from './Tooltip';

/**
 * The More page: one place for a project's put-away worktrees. Hidden ones
 * are still live; archived and deleted ones are kept copies (deleted ones
 * until their restore window ends). Pure display: each host builds the items
 * from its own data and wires every action, so desktop and web render the
 * same page.
 */

export type MoreWorktreeState = 'hidden' | 'archived' | 'deleted';

export type MoreWorktreeMenuIcon =
  | 'open'
  | 'unhide'
  | 'restore'
  | 'archive'
  | 'delete'
  | 'delete-permanently';

export interface MoreWorktreeMenuAction {
  readonly id: string;
  readonly label: string;
  readonly icon: MoreWorktreeMenuIcon;
  readonly tone?: 'destructive';
  readonly disabled?: boolean;
  /** Draws a divider above this action. */
  readonly separated?: boolean;
  readonly onSelect: () => void;
  readonly testId?: string;
}

export interface MoreWorktreePrimaryAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Why the action is unavailable, shown in a tooltip. */
  readonly unavailableReason?: string;
  readonly testId?: string;
}

export interface MoreWorktreeItem {
  readonly id: string;
  readonly state: MoreWorktreeState;
  readonly title: string;
  readonly branch?: string;
  readonly insertions?: number;
  readonly deletions?: number;
  /** Short date the item reached its state, such as `Nov 10`. */
  readonly date: string;
  /** Deleted items: how long they can still be restored, such as `26 days to restore`. */
  readonly restoreNote?: string;
  /** Extra line for the item, such as why nothing was saved. */
  readonly note?: string;
  /** An agent is still working in it: the branch line shimmers. */
  readonly running?: boolean;
  /** A change is in flight, such as `Archiving…`: no actions until it lands. */
  readonly progressLabel?: string;
  readonly primaryAction?: MoreWorktreePrimaryAction;
  readonly menuActions?: readonly MoreWorktreeMenuAction[];
  readonly testId?: string;
}

export type MoreWorktreesTab = 'all' | MoreWorktreeState;

export interface MoreWorktreesPageProps {
  /** The project's name: the title reads `More canopy worktrees`. */
  readonly projectName: string;
  /** What the project's rows are called, plural. Defaults to worktrees. */
  readonly unitLabelPlural?: string;
  /** Null while the items load. */
  readonly items: readonly MoreWorktreeItem[] | null;
  /** Page actions beside the title, such as Empty trash. */
  readonly actions?: ReactNode;
  /** Notices above the list, such as a failed load. */
  readonly notices?: ReactNode;
  /** Shown when the project has nothing put away. */
  readonly emptyMessage?: string;
  readonly initialTab?: MoreWorktreesTab;
  readonly testIdPrefix?: string;
}

const SECTIONS: readonly {
  readonly state: MoreWorktreeState;
  readonly title: string;
}[] = [
  { state: 'hidden', title: 'Hidden' },
  { state: 'archived', title: 'Archived' },
  { state: 'deleted', title: 'Deleted' },
];

const STATE_ICON = {
  hidden: EyeOffIcon,
  archived: ArchiveIcon,
  deleted: TrashIcon,
} as const;

/**
 * Container-query root for a card. Narrow cards move the date and restore
 * countdown under the title, so the title keeps room beside the actions.
 */
const CARD_CONTAINER_CLASS_NAME = '@container/more-card';

const MENU_ICON = {
  open: ArrowUpRight,
  unhide: EyeIcon,
  restore: RefreshIcon,
  archive: ArchiveIcon,
  delete: TrashIcon,
  'delete-permanently': TrashPermanentlyIcon,
} as const;

function matches(item: MoreWorktreeItem, needle: string): boolean {
  if (needle === '') return true;
  return (
    item.title.toLowerCase().includes(needle) ||
    (item.branch?.toLowerCase().includes(needle) ?? false)
  );
}

export function MoreWorktreesPage({
  projectName,
  unitLabelPlural = WORKTREE_UNIT_LABEL_PLURAL,
  items,
  actions,
  notices,
  emptyMessage,
  initialTab = 'all',
  testIdPrefix = 'more-worktrees',
}: MoreWorktreesPageProps): JSX.Element {
  const [tab, setTab] = useState<MoreWorktreesTab>(initialTab);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const counts = useMemo(() => {
    const next = { hidden: 0, archived: 0, deleted: 0 };
    for (const item of items ?? []) next[item.state] += 1;
    return next;
  }, [items]);
  const total = items?.length ?? 0;
  const visible = (items ?? []).filter(
    (item) => (tab === 'all' || item.state === tab) && matches(item, needle),
  );
  return (
    <Surface
      variant="panel"
      extent="parent"
      className="min-h-0 overflow-y-auto"
      data-testid={`${testIdPrefix}-page`}
    >
      <PageColumn width="content" as="main">
        <PageHeader
          title={
            <>
              More <span className={REPLAY_MASK_CLASS}>{projectName}</span>{' '}
              {unitLabelPlural.toLowerCase()}
            </>
          }
          description={`${unitLabelPlural} you hid, archived or deleted.`}
          {...(actions === undefined ? {} : { actions })}
          tabs={
            <TabBar<MoreWorktreesTab>
              label="Show"
              value={tab}
              onChange={setTab}
              items={[
                { id: 'all', label: 'All', count: total },
                { id: 'hidden', label: 'Hidden', count: counts.hidden },
                { id: 'archived', label: 'Archived', count: counts.archived },
                { id: 'deleted', label: 'Deleted', count: counts.deleted },
              ]}
            />
          }
        />
        <Stack gap="section">
          <PageSearchRow>
            <PageSearchField
              value={query}
              onValueChange={setQuery}
              placeholder="Search by name or branch"
              aria-label="Search by name or branch"
              data-testid={`${testIdPrefix}-search`}
            />
          </PageSearchRow>
          {notices}
          {items === null ? (
            <DelayedLoadingPlaceholder slowNote="Still loading…">
              <MoreWorktreesSkeleton testIdPrefix={testIdPrefix} />
            </DelayedLoadingPlaceholder>
          ) : total === 0 ? (
            <div
              className="py-6 text-center text-s fg-secondary"
              data-testid={`${testIdPrefix}-empty`}
            >
              {emptyMessage ??
                `${unitLabelPlural} you hide, archive or delete show up here.`}
            </div>
          ) : visible.length === 0 && needle !== '' ? (
            <SearchEmptyState
              title={
                <>
                  No {unitLabelPlural.toLowerCase()} match &ldquo;
                  {query.trim()}&rdquo;
                </>
              }
              actionLabel="Clear search"
              onAction={(): void => setQuery('')}
              testId={`${testIdPrefix}-no-matches`}
              actionTestId={`${testIdPrefix}-clear-search`}
            />
          ) : visible.length === 0 ? (
            <div
              className="py-6 text-center text-s fg-secondary"
              data-testid={`${testIdPrefix}-no-matches`}
            >
              Nothing here
            </div>
          ) : (
            SECTIONS.map(({ state, title: sectionTitle }) => {
              const sectionItems = visible.filter(
                (item) => item.state === state,
              );
              if (sectionItems.length === 0) return null;
              return (
                <Stack
                  key={state}
                  gap="item"
                  as="section"
                  data-testid={`${testIdPrefix}-section-${state}`}
                >
                  <span className="flex items-center gap-1.5">
                    <Heading level={2} variant="section">
                      {sectionTitle}
                    </Heading>
                    <Count value={sectionItems.length} />
                  </span>
                  <Stack gap="inline">
                    {sectionItems.map((item) => (
                      <MoreWorktreeCard
                        key={item.id}
                        item={item}
                        testIdPrefix={testIdPrefix}
                      />
                    ))}
                  </Stack>
                </Stack>
              );
            })
          )}
        </Stack>
      </PageColumn>
    </Surface>
  );
}

function MoreWorktreeCard({
  item,
  testIdPrefix,
}: {
  readonly item: MoreWorktreeItem;
  readonly testIdPrefix: string;
}): JSX.Element {
  const Icon = STATE_ICON[item.state];
  const insertions = item.insertions ?? 0;
  const deletions = item.deletions ?? 0;
  const hasChanges = insertions > 0 || deletions > 0;
  const busy = item.progressLabel !== undefined;
  const cardRef = useRef<HTMLElement>(null);
  // Whether focus was last inside the card, menu portal included (React
  // focus events bubble through portals).
  const focusInsideRef = useRef(false);
  useEffect(() => {
    // The actions unmount while busy; focus inside them would fall to the
    // page, so keep it on the card.
    const active = document.activeElement;
    if (
      busy &&
      focusInsideRef.current &&
      (active === null || active === document.body)
    ) {
      cardRef.current?.focus();
    }
  }, [busy]);
  return (
    <Surface
      ref={cardRef}
      variant="card"
      padding="compact"
      tabIndex={-1}
      focusRing
      onFocus={(): void => {
        focusInsideRef.current = true;
      }}
      onBlur={(event): void => {
        // Any blur that leaves the card clears it, a blur to nothing too.
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) {
          focusInsideRef.current = false;
        }
      }}
      data-testid={item.testId ?? `${testIdPrefix}-item-${item.id}`}
      data-state={item.state}
      aria-busy={busy ? true : undefined}
      className={CARD_CONTAINER_CLASS_NAME}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center">
          <Icon
            size="md"
            exactSize
            aria-hidden="true"
            className={
              item.state === 'deleted' ? 'fg-destructive' : 'fg-secondary'
            }
          />
        </span>
        <Stack gap="tight" className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center text-s fg-primary">
            {/* User-authored names stay out of session replay. */}
            <span
              className={`truncate ${REPLAY_MASK_CLASS}`}
              title={item.title}
            >
              {item.title}
            </span>
          </span>
          {(item.branch !== undefined || hasChanges || item.note) && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs fg-tertiary">
              {item.branch !== undefined && (
                <span
                  className={`truncate ${REPLAY_MASK_CLASS} ${item.running === true ? 'canopy-text-shimmer' : ''}`}
                  title={item.branch}
                >
                  {item.branch}
                </span>
              )}
              {hasChanges && (
                <span className="inline-flex shrink-0 gap-1.5 tabular-nums">
                  <span className="fg-success">+{insertions}</span>
                  <span className="fg-destructive">−{deletions}</span>
                </span>
              )}
              {item.note !== undefined && (
                <span className="truncate" title={item.note}>
                  {item.note}
                </span>
              )}
            </span>
          )}
          {/* Narrow cards: the date and restore countdown sit under the title. */}
          <span className="flex min-w-0 items-center gap-1.5 text-xs tabular-nums fg-tertiary @min-[30rem]/more-card:hidden">
            <span className="shrink-0">{item.date}</span>
            {item.restoreNote !== undefined && (
              <span className="truncate" title={item.restoreNote}>
                {item.restoreNote}
              </span>
            )}
          </span>
        </Stack>
        <span className="flex shrink-0 items-center gap-5">
          <span className="hidden flex-col items-end gap-0.5 text-xs tabular-nums fg-tertiary @min-[30rem]/more-card:flex">
            <span>{item.date}</span>
            {item.restoreNote !== undefined && <span>{item.restoreNote}</span>}
          </span>
          {/* Always mounted, so the label is announced when it appears. */}
          <span
            role="status"
            className={
              busy ? 'w-28 text-right text-xs fg-secondary' : 'sr-only'
            }
          >
            {item.progressLabel}
          </span>
          {busy ? null : (
            <MoreWorktreeActions item={item} testIdPrefix={testIdPrefix} />
          )}
        </span>
      </div>
    </Surface>
  );
}

function MoreWorktreeActions({
  item,
  testIdPrefix,
}: {
  readonly item: MoreWorktreeItem;
  readonly testIdPrefix: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  const menuActions = item.menuActions ?? [];
  return (
    <div className="flex items-center justify-end gap-2">
      {/* One width for Unhide and Restore, so every card's actions line up. */}
      <span className="flex w-18 shrink-0">
        {item.primaryAction !== undefined && (
          <PrimaryAction
            action={item.primaryAction}
            testId={
              item.primaryAction.testId ?? `${testIdPrefix}-primary-${item.id}`
            }
          />
        )}
      </span>
      {/* The label names a user-authored title: keep it out of session replay. */}
      <span className={`flex ${REPLAY_MASK_CLASS}`}>
        <Button
          ref={triggerRef}
          id={triggerId}
          variant="ghost"
          size="sm"
          iconOnly
          disabled={menuActions.length === 0}
          aria-label={`More actions for ${item.title}`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid={`${testIdPrefix}-actions-${item.id}`}
          onClick={(): void => setOpen((value) => !value)}
        >
          <MoreHorizontalIcon size="md" exactSize aria-hidden="true" />
        </Button>
      </span>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        aria-labelledby={triggerId}
        className="w-48"
      >
        <ActionMenuRowStyle>
          {menuActions.map((action) => {
            const ActionIcon = MENU_ICON[action.icon];
            return [
              action.separated === true ? (
                <DropdownMenuDivider key={`${action.id}-divider`} />
              ) : null,
              <DropdownMenuItem
                key={action.id}
                {...(action.tone === undefined ? {} : { tone: action.tone })}
                disabled={action.disabled}
                data-testid={action.testId}
                onClick={(): void => {
                  setOpen(false);
                  action.onSelect();
                }}
              >
                <DropdownMenuItemIcon>
                  <ActionIcon />
                </DropdownMenuItemIcon>
                {action.label}
              </DropdownMenuItem>,
            ];
          })}
        </ActionMenuRowStyle>
      </FloatingMenu>
    </div>
  );
}

function PrimaryAction({
  action,
  testId,
}: {
  readonly action: MoreWorktreePrimaryAction;
  readonly testId: string;
}): JSX.Element {
  const unavailable = action.unavailableReason !== undefined;
  // An unavailable action stays focusable (`aria-disabled`), so a keyboard
  // reaches the tooltip that says why.
  const button = (
    <Button
      variant="secondary"
      size="compact"
      className="flex-1"
      onClick={action.onClick}
      disabled={unavailable ? undefined : action.disabled}
      aria-disabled={unavailable ? true : undefined}
      data-testid={testId}
    >
      {action.label}
    </Button>
  );
  if (action.unavailableReason === undefined) return button;
  return <Tooltip label={action.unavailableReason}>{button}</Tooltip>;
}

/** Plain cards of the real shape, so the bars sit where the cards will. */
const SAMPLE_ITEMS: readonly MoreWorktreeItem[] = [
  {
    id: 'sample-1',
    state: 'hidden',
    title: 'Fix the checkout retry',
    branch: 'checkout-retry',
    date: 'Jan 4',
  },
  {
    id: 'sample-2',
    state: 'archived',
    title: 'Update the docs sidebar',
    branch: 'docs-sidebar',
    date: 'Jan 2',
  },
  {
    id: 'sample-3',
    state: 'deleted',
    title: 'Add release notes',
    branch: 'release-notes',
    date: 'Dec 30',
  },
];

function MoreWorktreesSkeleton({
  testIdPrefix,
}: {
  readonly testIdPrefix: string;
}): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading worktrees"
      testId={`${testIdPrefix}-loading`}
    >
      <Stack gap="inline">
        {SAMPLE_ITEMS.map((item) => (
          <MoreWorktreeCard
            key={item.id}
            item={item}
            testIdPrefix={`${testIdPrefix}-sample`}
          />
        ))}
      </Stack>
    </Skeleton>
  );
}
