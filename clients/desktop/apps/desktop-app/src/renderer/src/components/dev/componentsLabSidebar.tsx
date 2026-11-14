import { useState, type JSX } from 'react';
import {
  Button,
  SettingsSaveStatus,
  SidebarBatchCleanupFailureNotice,
  SidebarBatchRemovalDialog,
  SidebarBatchRemovalNotice,
  SidebarDragPreview,
  SidebarDropLine,
  SidebarNestingRail,
  SidebarNavMarker,
  SidebarNavRow,
  SidebarStylePicker,
  WORKTREE_BATCH_UNIT,
  WorktreeActionsMenu,
  sidebarItemGroupBulkMenu,
  sidebarItemGroupRowMenu,
  type SettingsSaveState,
  type SidebarBatchRemovalDialogProps,
  type WorktreeMenuItem,
  type SidebarStyle,
} from '@canopy/ui-shared/components';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import { ChatIcon, SettingsIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const SAVE_STATES: readonly SettingsSaveState[] = [
  'idle',
  'saving',
  'saved',
  'error',
];

function SettingsSaveStatusSection(): JSX.Element {
  return (
    <SpecimenPanel title="SettingsSaveStatus">
      <SpecimenGrid min={200}>
        {SAVE_STATES.map((state) => (
          <SpecimenCell key={state} label={state}>
            <SettingsSaveStatus state={state} dataTestId={`save-${state}`} />
          </SpecimenCell>
        ))}
        <SpecimenCell label="idle, quiet (a page with a Save action)">
          <div className="flex h-6 items-center fg-tertiary text-xs">
            <SettingsSaveStatus state="idle" idleLabel={null} />
            (renders nothing)
          </div>
        </SpecimenCell>
        <SpecimenCell label="custom idle and error copy">
          <SettingsSaveStatus state="idle" idleLabel="Saved to this computer" />
          <SettingsSaveStatus
            state="error"
            errorLabel="Couldn’t reach the server"
          />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SidebarNavMarkerSection(): JSX.Element {
  return (
    <SpecimenPanel title="SidebarNavMarker, trailing a SidebarNavRow">
      <SpecimenGrid min={260}>
        <SpecimenCell label="dev (hover for the tooltip)">
          <div className="flex w-64">
            <SidebarNavRow icon={<SettingsIcon />} onClick={noop}>
              <span className="min-w-0 flex-1 truncate">Components</span>
              <SidebarNavMarker kind="dev" />
            </SidebarNavRow>
          </div>
        </SpecimenCell>
        <SpecimenCell label="labs">
          <div className="flex w-64">
            <SidebarNavRow icon={<ChatIcon />} onClick={noop}>
              <span className="min-w-0 flex-1 truncate">Kanban</span>
              <SidebarNavMarker kind="labs" />
            </SidebarNavRow>
          </div>
        </SpecimenCell>
        <SpecimenCell label="selected row">
          <div className="flex w-64">
            <SidebarNavRow icon={<ChatIcon />} selected onClick={noop}>
              <span className="min-w-0 flex-1 truncate">Kanban</span>
              <SidebarNavMarker kind="labs" />
            </SidebarNavRow>
          </div>
        </SpecimenCell>
        <SpecimenCell label="long label keeps the marker visible">
          <div className="flex w-48">
            <SidebarNavRow icon={<ChatIcon />} onClick={noop}>
              <span className="min-w-0 flex-1 truncate">
                A very long experimental page name
              </span>
              <SidebarNavMarker kind="labs" />
            </SidebarNavRow>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SidebarStylePickerSection(): JSX.Element {
  const [value, setValue] = useState<SidebarStyle>('advanced');
  return (
    <SpecimenPanel title="SidebarStylePicker">
      <SpecimenGrid min={220}>
        <SpecimenCell label="live: pick a style">
          <SidebarStylePicker value={value} onChange={setValue} />
        </SpecimenCell>
        <SpecimenCell label="compact selected">
          <SidebarStylePicker value="compact" onChange={noop} />
        </SpecimenCell>
        <SpecimenCell label="disabled">
          <SidebarStylePicker value="advanced" disabled onChange={noop} />
        </SpecimenCell>
        <SpecimenCell label="busy (saving the choice)">
          <SidebarStylePicker value="advanced" busy onChange={noop} />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

type NoticeProps = Parameters<typeof SidebarBatchRemovalNotice>[0];

const NOTICE_BASE: NoticeProps = {
  verb: 'archive',
  unitLabel: WORKTREE_BATCH_UNIT,
  running: false,
  stopRequested: false,
  total: 6,
  done: 0,
  failed: 0,
  skipped: 0,
  notStarted: 0,
  onStop: noop,
  onShowDetails: noop,
  onDismiss: noop,
};

const NOTICE_CASES: readonly { label: string; props: Partial<NoticeProps> }[] =
  [
    { label: 'running, archive', props: { running: true, done: 2 } },
    {
      label: 'running, Stop pressed (in-flight removal still finishes)',
      props: { running: true, done: 3, stopRequested: true },
    },
    {
      label: 'running, delete',
      props: { verb: 'delete', running: true, done: 1 },
    },
    {
      label: 'running, mixed archive and delete',
      props: { verb: 'remove', running: true, done: 4 },
    },
    { label: 'done with failures', props: { done: 4, failed: 2 } },
    {
      label: 'failed, skipped and dropped by Stop',
      props: { done: 1, failed: 1, skipped: 2, notStarted: 2 },
    },
    {
      label: 'one worktree left, singular',
      props: { total: 1, done: 0, failed: 1 },
    },
    {
      label: 'chats, deleted',
      props: {
        verb: 'delete',
        unitLabel: { singular: 'chat', plural: 'chats' },
        total: 9,
        done: 7,
        failed: 2,
      },
    },
    {
      label: 'failed, background cleanup still running',
      props: { done: 4, failed: 2, cleanupRunning: 2, lateFailed: 1 },
    },
    {
      label: 'failed, background cleanup finished',
      props: { done: 4, failed: 2, lateFailed: 1 },
    },
  ];

type CleanupNoticeProps = Parameters<
  typeof SidebarBatchCleanupFailureNotice
>[0];

const CLEANUP_NOTICE_CASES: readonly {
  label: string;
  props: Pick<CleanupNoticeProps, 'verb' | 'failedLabels' | 'cleanupRunning'>;
}[] = [
  {
    label: 'one failed, cleanup still running',
    props: {
      verb: 'archive',
      failedLabels: ['fix-login-redirect'],
      cleanupRunning: 2,
    },
  },
  {
    label: 'several failed, cleanup finished',
    props: {
      verb: 'delete',
      failedLabels: ['fix-login-redirect', 'docs-refresh'],
      cleanupRunning: 0,
    },
  },
  {
    label: 'long name',
    props: {
      verb: 'archive',
      failedLabels: [
        'feature/very-long-branch-name-that-keeps-going-and-going-to-wrap',
      ],
      cleanupRunning: 1,
    },
  },
];

function SidebarBatchCleanupFailureNoticeSection(): JSX.Element {
  return (
    <SpecimenPanel title="SidebarBatchCleanupFailureNotice (a closed batch whose background cleanup failed)">
      <SpecimenGrid min={320}>
        {CLEANUP_NOTICE_CASES.map(({ label, props }) => (
          <SpecimenCell key={label} label={label}>
            <div className="w-80">
              <SidebarBatchCleanupFailureNotice
                {...props}
                unitLabel={WORKTREE_BATCH_UNIT}
                onShowDetails={noop}
                onDismiss={noop}
                testId={`batch-cleanup-notice-${label}`}
              />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SidebarBatchRemovalNoticeSection(): JSX.Element {
  return (
    <SpecimenPanel title="SidebarBatchRemovalNotice (renders nothing when every row succeeded)">
      <SpecimenGrid min={320}>
        {NOTICE_CASES.map(({ label, props }) => (
          <SpecimenCell key={label} label={label}>
            <div className="w-80">
              <SidebarBatchRemovalNotice
                {...NOTICE_BASE}
                {...props}
                testId={`batch-notice-${label}`}
              />
            </div>
          </SpecimenCell>
        ))}
        <SpecimenCell label="all done: nothing rendered">
          <div className="w-80 text-2xs fg-tertiary">
            <SidebarBatchRemovalNotice {...NOTICE_BASE} done={6} />
            (empty)
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

type DialogCase =
  | 'archive'
  | 'delete-choice'
  | 'excluded'
  | 'results'
  | 'nothing'
  | 'long';

const DIALOG_BASE: SidebarBatchRemovalDialogProps = {
  mode: 'archive',
  phase: 'confirm',
  rows: [],
  excluded: [],
  retentionSummary: 'Kept until you delete the archive.',
  retentionDetail: 'Archived worktrees keep their branch and saved changes.',
  branchChoice: false,
  unitLabel: WORKTREE_BATCH_UNIT,
  onCancel: noop,
  onConfirm: noop,
  onDone: noop,
};

const DIALOG_ROWS: SidebarBatchRemovalDialogProps['rows'] = [
  {
    key: 'w/clean',
    projectName: 'storefront',
    label: 'clean-up',
    branchName: 'clean-up',
  },
  {
    key: 'w/dirty',
    projectName: 'storefront',
    label: 'checkout-redesign',
    branchName: 'feature/checkout-redesign',
    localWork: { insertions: 128, deletions: 14 },
  },
  {
    key: 'w/unpushed',
    projectName: 'api',
    label: 'rate-limits',
    localWork: { unpushed: true },
  },
  {
    key: 'w/uncommitted',
    projectName: 'api',
    label: 'schema-sync',
    localWork: { uncommitted: true },
  },
];

function dialogProps(
  which: DialogCase,
  close: () => void,
): SidebarBatchRemovalDialogProps {
  const handlers = { onCancel: close, onConfirm: close, onDone: close };
  switch (which) {
    case 'archive':
      return { ...DIALOG_BASE, ...handlers, rows: DIALOG_ROWS };
    case 'delete-choice':
      return {
        ...DIALOG_BASE,
        ...handlers,
        mode: 'delete',
        rows: DIALOG_ROWS,
        branchChoice: true,
        warning: 'Uncommitted changes in 3 worktrees are lost.',
        retentionSummary: 'Deleted worktrees can’t be restored.',
      };
    case 'excluded':
      return {
        ...DIALOG_BASE,
        ...handlers,
        rows: DIALOG_ROWS.slice(0, 2),
        excluded: [
          {
            key: 'w/running',
            projectName: 'api',
            label: 'migration',
            branchName: 'migration',
            reason: 'A chat is still running in it.',
          },
        ],
      };
    case 'results':
      return {
        ...DIALOG_BASE,
        ...handlers,
        phase: 'results',
        rows: [
          { ...DIALOG_ROWS[0], status: 'done' },
          { ...DIALOG_ROWS[1], status: 'running' },
          {
            ...DIALOG_ROWS[2],
            status: 'failed',
            reason: 'The branch has unpushed commits.',
          },
          {
            ...DIALOG_ROWS[3],
            status: 'skipped',
            reason: 'Stopped before it started.',
          },
          {
            key: 'w/queued',
            projectName: 'api',
            label: 'later',
            status: 'pending',
          },
        ],
      };
    case 'nothing':
      return { ...DIALOG_BASE, ...handlers, rows: [] };
    case 'long':
      return {
        ...DIALOG_BASE,
        ...handlers,
        rows: [
          {
            key: 'w/long',
            projectName: 'a-monorepo-with-a-remarkably-long-project-name',
            label: 'a-worktree-label-that-goes-on-and-on-and-on-for-a-while',
            branchName:
              'feature/a-branch-name-that-is-much-too-long-to-fit-in-the-dialog',
            localWork: { insertions: 12345, deletions: 6789 },
          },
        ],
      };
  }
}

const DIALOG_BUTTONS: readonly { id: DialogCase; label: string }[] = [
  { id: 'archive', label: 'Archive, local work first' },
  { id: 'delete-choice', label: 'Delete with branch choice and warning' },
  { id: 'excluded', label: 'Not included' },
  { id: 'results', label: 'Results: done, running, failed, skipped, pending' },
  { id: 'nothing', label: 'Nothing removable' },
  { id: 'long', label: 'Long names and counts' },
];

function SidebarBatchRemovalDialogSection(): JSX.Element {
  const [open, setOpen] = useState<DialogCase | null>(null);
  const close = (): void => setOpen(null);
  return (
    <SpecimenPanel title="SidebarBatchRemovalDialog">
      <SpecimenCell label="Live: each opens the real dialog" wide>
        {DIALOG_BUTTONS.map(({ id, label }) => (
          <Button
            key={id}
            size="compact"
            onClick={(): void => setOpen(id)}
            data-testid={`batch-dialog-open-${id}`}
          >
            {label}
          </Button>
        ))}
      </SpecimenCell>
      {open === null ? null : (
        <SidebarBatchRemovalDialog {...dialogProps(open, close)} />
      )}
    </SpecimenPanel>
  );
}

const MENU_GROUPS: readonly SidebarItemGroup[] = [
  {
    id: 'frontend',
    name: 'Frontend',
    color: 'categorical-1',
    collapsed: false,
    memberIds: ['a'],
  },
  {
    id: 'docs',
    name: 'Docs',
    color: 'categorical-3',
    collapsed: true,
    memberIds: ['b'],
  },
];

const MENU_UNIT = { singular: 'task', plural: 'tasks' } as const;

/**
 * The menu entries the group builders (`sidebar-item-group-menu`) produce,
 * drawn by the real worktree actions menu. Open each and pick an entry: the
 * readout names the callback it ran.
 */
function SidebarGroupMenuSection(): JSX.Element {
  const [last, setLast] = useState('nothing picked yet');
  const say = (action: string) => (): void => setLast(action);
  const row = (
    groups: readonly SidebarItemGroup[],
    currentGroupId?: string,
    eligible = true,
  ): WorktreeMenuItem[] =>
    sidebarItemGroupRowMenu({
      groups,
      currentGroupId,
      unitLabel: MENU_UNIT,
      eligible,
      onNewGroup: say('new group'),
      onMove: (id) => setLast(`move to ${id}`),
      onEdit: (id) => setLast(`edit ${id}`),
      onToggle: (id) => setLast(`toggle ${id}`),
      onRemove: say('remove from group'),
    });
  const bulk = (
    groups: readonly SidebarItemGroup[],
    currentGroupIds: readonly (string | undefined)[],
  ): WorktreeMenuItem[] =>
    sidebarItemGroupBulkMenu({
      groups,
      currentGroupIds,
      onNewGroup: say('new group (selection)'),
      onMove: (id) => setLast(`move selection to ${id}`),
      onRemove: say('remove selection from group'),
    });
  const cases: readonly {
    label: string;
    items: WorktreeMenuItem[];
  }[] = [
    { label: 'row, no groups yet: one Add to new group', items: row([]) },
    { label: 'row, ungrouped, groups exist', items: row(MENU_GROUPS) },
    { label: 'row in an expanded group', items: row(MENU_GROUPS, 'frontend') },
    {
      label: 'row in a collapsed group (Expand)',
      items: row(MENU_GROUPS, 'docs'),
    },
    {
      label: 'row that cannot be grouped (pinned, hidden, child): no entry',
      items: row(MENU_GROUPS, undefined, false),
    },
    {
      label: 'selection, no groups, nothing grouped',
      items: bulk([], [undefined, undefined]),
    },
    {
      label: 'selection split between a group and none',
      items: bulk(MENU_GROUPS, ['frontend', undefined]),
    },
    {
      label: 'selection already sharing a group (it is not a destination)',
      items: bulk(MENU_GROUPS, ['frontend', 'frontend']),
    },
    {
      label: 'selection with no movable row: no entry',
      items: bulk(MENU_GROUPS, []),
    },
  ];
  return (
    <SpecimenPanel title="<sidebar-item-group-menu> entries: Add to group and Move to group">
      <SpecimenGrid min={280}>
        {cases.map(({ label, items }) => (
          <SpecimenCell key={label} label={label}>
            {items.length === 0 ? (
              <span className="text-xs fg-tertiary">(no entry)</span>
            ) : (
              <WorktreeActionsMenu
                items={items}
                accessibleLabel={label}
                alwaysVisible
              />
            )}
          </SpecimenCell>
        ))}
        <SpecimenCell label="last entry picked" wide>
          <span
            className="text-xs fg-secondary"
            data-testid="group-menu-readout"
          >
            {last}
          </span>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

function SidebarDragSurfacesSection(): JSX.Element {
  return (
    <SpecimenPanel title="Sidebar drag surfaces">
      <SpecimenGrid min={220}>
        <SpecimenCell label="Row preview">
          <SidebarDragPreview>
            <div className="px-3 py-2">Worktree</div>
          </SidebarDragPreview>
        </SpecimenCell>
        <SpecimenCell label="Group preview">
          <SidebarDragPreview variant="group">
            <div className="px-3 py-2">Related worktrees</div>
          </SidebarDragPreview>
        </SpecimenCell>
        <SpecimenCell label="Workspace preview">
          <SidebarDragPreview variant="workspace">
            <div className="px-3 py-2">Workspace</div>
          </SidebarDragPreview>
        </SpecimenCell>
        <SpecimenCell label="Worktree insertion before">
          <div className="relative px-3 py-2">
            <SidebarDropLine variant="worktree" position="before" />
            Worktree
          </div>
        </SpecimenCell>
        <SpecimenCell label="Workspace insertion after">
          <div className="relative px-3 py-2">
            Workspace
            <SidebarDropLine variant="workspace" position="after" />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Group insertion before">
          <div className="relative px-3 py-2">
            <SidebarDropLine variant="group" position="before" />
            Related worktrees
          </div>
        </SpecimenCell>
        <SpecimenCell label="Nested worktree rail">
          <div className="flex flex-col gap-px">
            <div className="relative py-2 pl-10">
              <SidebarNestingRail first last={false} />
              First worktree
            </div>
            <div className="relative py-2 pl-10">
              <SidebarNestingRail first={false} last bridgeGap />
              Last worktree
            </div>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

export function SidebarPartsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SidebarNavMarkerSection />
      <SidebarStylePickerSection />
      <SidebarBatchRemovalNoticeSection />
      <SidebarBatchCleanupFailureNoticeSection />
      <SidebarBatchRemovalDialogSection />
      <SettingsSaveStatusSection />
      <SidebarGroupMenuSection />
      <SidebarDragSurfacesSection />
    </div>
  );
}
