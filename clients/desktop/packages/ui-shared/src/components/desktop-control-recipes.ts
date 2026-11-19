import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import {
  SECONDARY_SURFACE_CLASS,
  SECONDARY_SURFACE_HOVER_CLASS,
  SECONDARY_SURFACE_OPEN_CLASS,
} from '../lib/row-chips';
import {
  SIDEBAR_STATUS_HOVER_WASH_CLASSNAME,
  SIDEBAR_STATUS_SURFACE_CLASSNAME,
} from '../lib/sidebar-status-surface';
import { BUBBLE_BADGE_CHROME } from './bubble-badge';
import {
  SIDEBAR_LIST_ITEM_CLASSNAME,
  SIDEBAR_ROW_GRID_CLASSNAME,
} from './sidebar-item-classes';
import { TURN_FILE_ROW_CLASS_NAME } from './chat/turn-file-styles';

const SELECTED_ROW_CLASS = 'bg-fg-primary/[0.04] font-semibold';
const UNSELECTED_ROW_CLASS = 'hover:bg-fg-primary/[0.04]';
const CAPSULE_TOUCH_FLOOR_CLASS =
  'pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center';
const TRANSCRIPT_LINK_CLASS =
  'fg-accent underline decoration-accent/30 decoration-1 underline-offset-4 transition-[text-decoration-color] hover:decoration-current focus-visible:decoration-current';
const INLINE_CHIP_CLASS =
  'inline-block max-w-full rounded-sm canopy-inline-chip-geometry no-underline focus-ring cursor-pointer bg-accent-subtle fg-accent-strong transition-colors hover:bg-accent-subtle/80';
const OPTION_CARD_SELECTED_CLASS_NAME =
  'bg-accent-subtle ring-1 ring-line-accent';
const OPTION_CARD_RESTING_CLASS_NAME =
  'bg-secondary ring-[length:var(--border-hairline)] ring-line-base hover:ring-line-secondary';
const APP_STATUS_PILL_CLASSNAME = `focus-ring group inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full pl-2 pr-2.5 text-2xs font-medium fg-secondary transition-colors hover:fg-primary ${SECONDARY_SURFACE_CLASS}`;

const AUTOMATION_STATUS_APPEARANCE = {
  working: 'border-fg-info/40 bg-info-subtle fg-primary',
  attention: 'border-line-attention/40 bg-warning-subtle fg-warning',
  danger: 'border-line-destructive/40 bg-destructive-subtle fg-destructive',
  success: 'border-line-positive/40 bg-success-subtle fg-primary',
  filter: 'bg-fg-primary/[0.04] fg-secondary',
} as const;

const WORKFLOW_TRIGGER_APPEARANCE = {
  dispatch: 'bg-accent-subtle fg-accent-strong',
  plan_ready: 'bg-warning-subtle fg-warning',
  task_ready: 'bg-info-subtle fg-info',
  workflow: 'bg-success-subtle fg-success',
} as const;

const SIDEBAR_BANNER_APPEARANCE = {
  status: `${SIDEBAR_STATUS_SURFACE_CLASSNAME} ${SIDEBAR_STATUS_HOVER_WASH_CLASSNAME}`,
  development: 'bg-warning-subtle fg-primary shadow-md',
  plain: '',
} as const;

const RESOURCE_DIAGNOSTICS_APPEARANCE = {
  titlebar:
    'focus-ring group flex h-7 min-w-0 items-center justify-start gap-1.5 whitespace-nowrap rounded-md text-left text-2xs font-normal max-w-full',
  'titlebar-compact':
    'electron-no-drag focus-ring inline-flex h-7 shrink-0 items-center justify-center rounded-md px-1.5 titlebar-control-fg transition-colors hover:bg-subtle relative gap-1.5 whitespace-nowrap text-2xs font-normal',
  sidebar: `${SIDEBAR_LIST_ITEM_CLASSNAME} fg-secondary`,
} as const;

const RESOURCE_DIAGNOSTICS_TONE = {
  ok: `${OPERATIONAL_STATUS_COLORS.success.foreground} hover:bg-subtle`,
  warning: 'fg-warning hover:bg-subtle',
  critical: `${OPERATIONAL_STATUS_COLORS.failed.foreground} hover:bg-subtle`,
  error: `${OPERATIONAL_STATUS_COLORS.failed.foreground} hover:bg-subtle`,
  loading: 'fg-quaternary hover:bg-subtle',
} as const;

const CALENDAR_EVENT_LAYOUT = {
  month:
    'flex w-full items-center gap-1 overflow-hidden rounded border px-1 py-0.5 text-left text-3xs leading-none transition-colors',
  timeline:
    'flex h-full w-full items-center gap-1 overflow-hidden rounded border px-1 text-left text-3xs leading-tight transition-colors',
  'timeline-tall':
    'flex h-full w-full flex-col gap-1 overflow-hidden rounded border px-1 py-0.5 text-left text-3xs leading-tight transition-colors',
} as const;

const CALENDAR_EVENT_APPEARANCE = {
  success: 'border-fg-success-strong/50 bg-success-subtle fg-success-strong',
  failure: 'border-line-destructive bg-destructive-subtle fg-destructive',
  running: 'border-fg-info/50 bg-info-subtle fg-info',
  missed: 'bg-warning-subtle fg-warning',
  neutral: 'bg-fg-primary/[0.06] fg-secondary',
  scheduled: 'border-fg-info/40 bg-info-subtle fg-info',
  paused: 'border-fg-info/40 bg-info-subtle fg-info border-dashed opacity-50',
} as const;

/** Paint and geometry for host-specific compound controls. */
export const DESKTOP_CONTROL_RECIPES = {
  'diff-folder':
    'flex w-max min-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.04]',
  'diff-file': ({
    fullPath,
    selected,
  }: {
    fullPath: boolean;
    selected: boolean;
  }) =>
    `flex ${fullPath ? 'w-full min-w-0' : 'w-max min-w-full'} items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
      selected
        ? 'bg-accent/[0.08] fg-primary'
        : 'fg-primary/80 hover:bg-fg-primary/[0.06]'
    }`,
  'plan-card': 'pointer-events-none focus-ring absolute inset-0 rounded-lg',
  'workflow-detail-nav': (selected: boolean) =>
    `focus-ring focus-ring-inset relative flex items-center gap-2 py-2 pl-4 pr-3.5 text-left transition-colors ${
      selected ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
    }`,
  'workflow-detail-job': (matrix: boolean) =>
    `focus-ring focus-ring-inset flex min-w-0 flex-1 items-center gap-2 py-2 pr-2.5 text-left ${
      matrix ? 'pl-1.5' : 'pl-4'
    }`,
  'workflow-detail-child': (selected: boolean) =>
    `focus-ring focus-ring-inset relative flex w-full items-center gap-2 py-1.5 pl-3.5 pr-2.5 text-left transition-colors ${
      selected ? SELECTED_ROW_CLASS : UNSELECTED_ROW_CLASS
    }`,
  'workflow-inline-step': (selected: boolean) =>
    `focus-ring flex w-full items-start justify-between gap-3 rounded-md border px-2.5 py-2 text-left transition-colors ${
      selected
        ? 'border-fg-info/50 bg-info-subtle'
        : 'bg-fg-primary/[0.02] hover:bg-fg-primary/[0.04]'
    }`,
  'workflow-step-detail':
    'focus-ring flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-fg-primary/[0.04]',
  'workflow-advisor-toggle':
    'focus-ring -mx-1 flex flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left',
  'archive-execution':
    'focus-ring flex w-full flex-col gap-2 rounded-lg border bg-fg-primary/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-fg-primary/[0.05]',
  'calendar-event': ({
    layout,
    tone,
    selected,
    interactive,
  }: {
    layout: keyof typeof CALENDAR_EVENT_LAYOUT;
    tone: keyof typeof CALENDAR_EVENT_APPEARANCE;
    selected: boolean;
    interactive: boolean;
  }) =>
    `${CALENDAR_EVENT_LAYOUT[layout]} ${CALENDAR_EVENT_APPEARANCE[tone]} ${selected ? 'ring-2 ring-line-selected ring-offset-1 ring-offset-base' : ''} ${interactive ? (tone === 'paused' ? 'cursor-pointer hover:opacity-40' : 'cursor-pointer hover:opacity-90') : 'cursor-default'}`,
  'archive-chats-trigger': (unread: boolean) =>
    `electron-no-drag focus-ring relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors enabled:hover:bg-subtle enabled:hover:fg-primary ${
      unread ? 'fg-warning' : 'fg-secondary'
    }`,
  'attachment-remove': `${BUBBLE_BADGE_CHROME} absolute -right-1.5 -top-1.5 z-10 h-5 w-5 opacity-0 transition-opacity hover:fg-primary focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100`,
  'transcript-file-link': `focus-ring cursor-pointer ${TRANSCRIPT_LINK_CLASS}`,
  'directory-compact-picker': (disabled: boolean) =>
    disabled
      ? 'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs fg-secondary/70 cursor-not-allowed'
      : 'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs fg-secondary transition-colors hover:bg-subtle hover:fg-primary',
  'breadcrumb-folder':
    'flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs fg-primary transition-colors hover:bg-fg-primary/[0.06]',
  'breadcrumb-file': (highlighted: boolean) =>
    `flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors hover:bg-fg-primary/[0.06] ${
      highlighted ? 'bg-accent-subtle fg-primary' : 'fg-primary'
    }`,
  'transcript-command-token':
    'focus-ring rounded bg-fg-primary/[0.08] px-1 py-0.5 font-mono text-2xs hover:bg-fg-primary/[0.14]',
  'prose-mention': INLINE_CHIP_CLASS,
  'model-billing-option': (disabled: boolean) =>
    `outline-none flex h-8 w-full items-center justify-between rounded-md px-2 text-s fg-primary/80 transition-colors ${
      disabled
        ? 'cursor-not-allowed opacity-50'
        : 'group hover:bg-subtle focus-visible:bg-subtle'
    }`,
  'editor-selection-confirmation':
    'flex items-center gap-1.5 rounded-md bg-card px-2 py-1 text-2xs font-medium fg-success shadow-md transition-colors hover:bg-accent-subtle',
  'scheduled-send-edit': `focus-ring flex h-8 items-center gap-1.5 rounded-full pl-2.5 pr-1 whitespace-nowrap disabled:cursor-default ${CAPSULE_TOUCH_FLOOR_CLASS}`,
  'scheduled-send-clear':
    'focus-ring flex h-8 items-center rounded-full pl-1 pr-2.5',
  'attachment-preview': 'focus-ring block rounded-xl',
  'turn-file-title':
    'focus-ring min-w-0 truncate rounded-sm text-left fg-primary',
  'turn-file-row': `focus-ring text-left ${TURN_FILE_ROW_CLASS_NAME}`,
  'reverted-turn-toggle':
    'focus-ring flex w-full items-center gap-2 rounded-md border bg-fg-primary/[0.02] px-3 py-1.5 text-left text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.04]',
  'workflow-chat-toggle':
    'focus-ring flex w-full items-center gap-2 px-3 py-2 text-left',
  'gallery-image-zoom': 'focus-ring absolute inset-0 cursor-zoom-in',
  'gallery-image-thumbnail': (selected: boolean) =>
    `focus-ring h-11 w-16 shrink-0 overflow-hidden rounded-md bg-tertiary ring-[length:var(--border-hairline)] transition-colors ${
      selected
        ? 'ring-2 ring-line-secondary opacity-100'
        : 'ring-line-base opacity-60 hover:opacity-100'
    }`,
  'gallery-image-preview':
    'focus-ring group flex w-full flex-col gap-1.5 rounded-md text-left',
  'branch-picker': (locked: boolean) =>
    `electron-no-drag focus-ring relative flex h-7 min-w-0 items-center rounded-md pl-2 ${
      locked ? 'pr-1' : 'pr-2'
    }`,
  'branch-copy':
    'electron-no-drag focus-ring flex h-6 w-6 items-center justify-center rounded-[calc(var(--radius-md)-2px)] fg-secondary transition-colors hover:bg-subtle hover:fg-primary',
  'base-branch-picker':
    'electron-no-drag focus-ring inline-flex h-7 w-full min-w-0 items-center gap-0.5 rounded-md px-2 fg-secondary transition-colors hover:bg-subtle',
  'automation-status-picker': (
    tone: keyof typeof AUTOMATION_STATUS_APPEARANCE,
  ) =>
    `focus-ring inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-3xs font-medium transition-colors ${AUTOMATION_STATUS_APPEARANCE[tone]}`,
  'project-settings-titlebar':
    'electron-no-drag focus-ring flex h-7 min-w-0 items-center gap-2.25 rounded-md pl-1 pr-2 text-s font-normal fg-primary transition-colors hover:bg-subtle',
  'automation-section-toggle':
    'focus-ring flex w-full shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-medium fg-secondary transition-colors hover:fg-primary',
  'workflow-create':
    'rounded-l-full pl-3 pr-2.5 text-xs font-medium transition-colors hover:opacity-90 focus-ring disabled:cursor-default disabled:opacity-70',
  'workflow-create-menu':
    'flex items-center rounded-r-full pl-1.5 pr-2 transition-colors hover:opacity-90 focus-ring disabled:cursor-default disabled:opacity-70',
  'workflow-scope-info': 'focus-ring inline-flex rounded-sm',
  'workflow-trigger-info': (
    trigger: keyof typeof WORKFLOW_TRIGGER_APPEARANCE,
  ) =>
    `focus-ring shrink-0 inline-flex items-center justify-center w-5 h-5 rounded ${WORKFLOW_TRIGGER_APPEARANCE[trigger]}`,
  'diagram-job':
    'nodrag flex shrink-0 items-center gap-2 px-3 text-left transition-colors hover:bg-fg-primary/[0.04]',
  'diagram-step': (selected: boolean) =>
    `nodrag flex shrink-0 items-center gap-2 rounded border px-2 text-left transition-colors ${selected ? 'border-line-accent bg-accent-subtle' : 'bg-fg-primary/[0.03] hover:bg-fg-primary/[0.07]'}`,
  'workflow-setting-toggle':
    'flex min-w-0 flex-1 items-start gap-2 px-3 py-2.5 text-left hover:bg-fg-primary/[0.04]',
  'workflow-job-handle':
    'shrink-0 cursor-grab active:cursor-grabbing p-0.5 fg-secondary hover:fg-primary touch-none',
  'workflow-step-handle':
    'focus-ring flex size-7 items-center justify-center rounded-full cursor-grab active:cursor-grabbing fg-secondary hover:fg-primary touch-none',
  'resource-diagnostics-trigger': ({
    placement,
    tone,
  }: {
    placement: keyof typeof RESOURCE_DIAGNOSTICS_APPEARANCE;
    tone: keyof typeof RESOURCE_DIAGNOSTICS_TONE;
  }) =>
    `${RESOURCE_DIAGNOSTICS_APPEARANCE[placement]} group ${placement === 'sidebar' ? RESOURCE_DIAGNOSTICS_TONE[tone] : ''}`,
  'settings-option-card': ({
    preview,
    fullWidth,
    selected,
  }: {
    preview: boolean;
    fullWidth: boolean;
    selected: boolean;
  }) =>
    `focus-ring flex flex-col rounded-lg p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
      preview ? 'items-center gap-2 text-center' : ''
    } ${fullWidth ? 'col-span-full' : ''} ${
      selected
        ? OPTION_CARD_SELECTED_CLASS_NAME
        : OPTION_CARD_RESTING_CLASS_NAME
    }`,
  'sidebar-invitation': `focus-ring flex w-full min-w-0 items-center ${SIDEBAR_ROW_GRID_CLASSNAME} rounded-row py-1 pr-1 text-left text-s fg-secondary hover:bg-subtle`,
  'searchable-select-trigger':
    'focus-ring flex w-full items-center justify-between gap-2 rounded-md border bg-base px-2.5 py-1.5 text-left text-s fg-primary transition-colors hover:bg-fg-primary/[0.04] disabled:cursor-not-allowed disabled:opacity-50',
  'sidebar-projects-return':
    'flex shrink-0 items-center gap-1 px-4 py-1.5 text-left text-s font-normal fg-quaternary transition-colors hover:fg-secondary',
  'workspace-drag-handle':
    'focus-ring relative inline-flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded-full',
  'workspace-label-toggle':
    'focus-ring flex min-w-0 flex-1 items-center gap-1 text-left group-hover/sidebar-item:pr-19 group-focus-within/sidebar-item:pr-19',
  'sidebar-banner-primary':
    'focus-ring flex h-full w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-row text-left',
  'sidebar-banner-action': ({
    tall,
    surface,
  }: {
    tall: boolean;
    surface: keyof typeof SIDEBAR_BANNER_APPEARANCE;
  }) =>
    `${tall ? 'h-8' : 'h-7'} flex w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-row py-0 pl-1 pr-2 text-xs font-normal focus-ring text-left ${SIDEBAR_BANNER_APPEARANCE[surface]}`,
  'wake-lock-control': (statusBar: boolean) =>
    statusBar
      ? APP_STATUS_PILL_CLASSNAME
      : `${SIDEBAR_LIST_ITEM_CLASSNAME} fg-primary hover:bg-subtle`,
  'terminal-group-row':
    'flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-2xs',
  'terminal-pane-row':
    'flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-3xs',
  'workflow-rename': `focus-ring min-w-0 max-w-full truncate rounded-sm align-top text-left transition-colors hover:fg-accent ${REPLAY_MASK_CLASS}`,
  'worktree-open-app': `focus-ring flex w-7 items-center justify-center gap-1.5 text-xs font-medium fg-primary transition-colors ${SECONDARY_SURFACE_HOVER_CLASS} @[560px]/prbar:w-auto @[560px]/prbar:justify-start @[560px]/prbar:px-2.5`,
  // A Customize row's split action (CAN-6813): the state segment and its
  // caret, each lighting up alone on the Add button's secondary surface.
  'customize-row-action': `focus-ring flex min-w-0 flex-1 items-center gap-1.5 pl-2.5 pr-2 text-xs font-medium fg-primary transition-colors ${SECONDARY_SURFACE_HOVER_CLASS} ${SECONDARY_SURFACE_OPEN_CLASS} aria-disabled:cursor-default disabled:cursor-default disabled:opacity-70`,
  // New Customize's status-line "Sign in" and "Try again": plain text; only the
  // triangle beside it carries the warning color (Sergii's QA).
  'customize-row-sign-in':
    'focus-ring rounded font-medium fg-primary hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60',
  'customize-row-action-menu': `focus-ring flex w-7 shrink-0 items-center justify-center fg-secondary transition-colors hover:fg-primary ${SECONDARY_SURFACE_HOVER_CLASS} ${SECONDARY_SURFACE_OPEN_CLASS} aria-expanded:fg-primary`,
  'worktree-open-menu': (split: boolean) =>
    `focus-ring flex items-center transition-colors ${SECONDARY_SURFACE_HOVER_CLASS} ${
      split
        ? 'w-7 justify-center'
        : 'gap-1 px-2.5 text-xs font-medium fg-primary'
    }`,
  'project-header-drag-handle':
    'focus-ring inline-flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded-full',
  'worktree-stop-launch': (stopping: boolean) =>
    `group/stop focus-ring flex h-3 w-3 items-center justify-center rounded transition-colors ${
      stopping
        ? 'cursor-not-allowed fg-destructive'
        : 'fg-info hover:bg-destructive-subtle hover:fg-destructive'
    }`,
  'worktree-stop-launch-label': (stopping: boolean) =>
    `focus-ring -mx-1 inline-flex h-4 items-center rounded px-1 align-bottom leading-4 transition-colors ${
      stopping
        ? 'cursor-not-allowed fg-destructive'
        : 'hover:bg-destructive-subtle hover:fg-destructive'
    }`,
  'worktree-apply': (standalone: boolean) =>
    `focus-ring inline-flex items-center gap-2 ${standalone ? 'rounded-md' : 'rounded-l-md'} bg-info px-3 py-1.5 text-xs font-medium fg-emphasis disabled:opacity-60`,
  'worktree-apply-menu':
    'focus-ring rounded-r-md border-l border-fg-emphasis/20 bg-info px-2 py-1.5 fg-emphasis disabled:opacity-60',
} as const;
