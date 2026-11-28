import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import {
  sidebarNavIconItemClassName,
  sidebarNavItemClassName,
} from './sidebar-item-classes';

/**
 * The compact item row: no border or fill, the shared list-row hover, and
 * the card's 28px minimum height and small text style. Callers add the
 * display (`flex` or `grid`).
 */
export const COMPACT_ACTIVITY_ITEM_CLASS_NAME =
  'min-h-7 w-full items-center gap-2 rounded-md px-2 py-0.5 text-left text-xs hover:bg-subtle';

/** Existing compound app controls whose geometry belongs to a specific widget. */
export const APP_CONTROL_RECIPES = {
  'activity-group-disclosure':
    'focus-ring flex w-full items-center gap-1.5 rounded-lg border bg-fg-primary/[0.03] px-2.5 py-2 text-left text-xs font-medium fg-primary/80 transition-colors hover:bg-fg-primary/[0.05] pointer-coarse:min-h-11',
  'attachment-image-open': 'focus-ring rounded-md',
  'card-open':
    'absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-accent/60',
  'compare-side-select':
    'focus-ring flex items-center gap-3 self-start rounded text-left text-s font-medium fg-primary disabled:cursor-not-allowed disabled:opacity-60',
  'cost-preview-open':
    'focus-ring group flex w-full flex-col gap-3 rounded-xl border bg-base p-4 text-left transition-colors hover:bg-subtle',
  'cost-source-disclosure':
    'focus-ring flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs transition-colors hover:bg-subtle pointer-coarse:min-h-11',
  'directory-entry-open': 'focus-ring min-w-0 flex-1 rounded text-left',
  'drawer-completed-open':
    'focus-ring focus-ring-inset flex h-9 w-full min-w-0 items-center gap-2.5 rounded-drawer-row pl-2.75 pr-1 text-left text-s fg-secondary hover:bg-subtle',
  'drawer-header-disclosure':
    'focus-ring flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-xl pl-1 pr-2 text-left hover:bg-fg-primary/[0.04]',
  'memory-entry-open':
    'focus-ring flex min-w-0 flex-1 items-start gap-2.5 rounded-lg py-2 pl-2.5 text-left',
  'memory-fact-open': 'block w-full text-left',
  'organization-logo-add':
    'flex items-center justify-center rounded-md border-2 border-dashed fg-secondary transition-colors hover:border-line-accent hover:fg-primary disabled:cursor-not-allowed disabled:opacity-50',
  'organization-logo-replace':
    'group relative rounded-md disabled:cursor-not-allowed',
  'participation-tooltip-trigger': 'text-left text-xs fg-secondary',
  'profile-photo-edit':
    'group relative rounded-full disabled:cursor-not-allowed',
  'proxy-toggle-card-off':
    "focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors before:absolute before:-inset-2 before:content-[''] disabled:opacity-60 fg-tertiary opacity-0 hover:bg-subtle hover:fg-primary focus-visible:opacity-100 group-hover/mcp-row:opacity-100 group-focus-within/mcp-row:opacity-100 pointer-coarse:opacity-100",
  'proxy-toggle-card-on':
    "focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors before:absolute before:-inset-2 before:content-[''] disabled:opacity-60 bg-accent-subtle fg-accent-strong",
  'proxy-toggle-panel-off':
    "focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors before:absolute before:-inset-2 before:content-[''] disabled:opacity-60 border fg-secondary hover:bg-subtle hover:fg-primary",
  'proxy-toggle-panel-on':
    "focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors before:absolute before:-inset-2 before:content-[''] disabled:opacity-60 border border-line-accent bg-accent-subtle fg-accent-strong",
  'repository-disclosure':
    'focus-ring flex min-w-0 flex-1 items-center gap-1 text-xs font-medium fg-primary/80 transition-colors hover:fg-primary pointer-coarse:min-h-11',
  'section-keyboard-reorder':
    'sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-20 focus:rounded-sm focus:bg-quaternary focus:px-2 focus:py-1 focus:text-2xs focus:font-normal focus:fg-primary focus:shadow-sm',
  'settings-agent-row':
    'focus-ring -my-3 flex w-full min-w-0 items-center gap-3 rounded-md py-3 text-left',
  'settings-scope-picker':
    'focus-ring flex w-full min-w-0 items-center gap-2.5 rounded-row px-2 py-2 text-left hover:bg-subtle aria-expanded:bg-subtle pointer-coarse:min-h-11',
  'sidebar-account-picker':
    'focus-ring flex h-full min-w-0 flex-1 items-center gap-2 rounded-row text-left',
  'sidebar-archived-entry':
    'focus-ring flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-row py-1 pl-8 pr-1.5 text-left group-hover:pr-8 group-focus-within:pr-8',
  'sidebar-context-picker-row':
    'focus-ring flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-row px-2 text-left text-s font-normal fg-primary hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11',
  'sidebar-context-picker-top':
    'focus-ring flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-row py-0 pl-1 pr-2 text-left text-m font-bold fg-primary hover:bg-subtle focus-visible:bg-subtle aria-expanded:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11',
  'sidebar-project-reorder':
    'focus-ring relative inline-flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded-md',
  'sidebar-section-disclosure':
    'focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-row text-left',
  'sidebar-worktree-reorder':
    'focus-ring h-4 w-4 cursor-grab rounded active:cursor-grabbing',
  'summary-preview-open':
    'focus-ring flex w-full cursor-pointer flex-col gap-2 text-left',
  'team-open':
    'flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition-colors hover:bg-secondary',
  'transcript-file-open':
    'focus-ring inline cursor-pointer break-all rounded-sm disabled:cursor-progress fg-accent underline decoration-accent/30 decoration-1 underline-offset-4 transition-[text-decoration-color] hover:decoration-current focus-visible:decoration-current',
  'work-row-drawer-header':
    'focus-visible:outline focus-visible:outline-1 focus-visible:outline-fg-quaternary focus-visible:-outline-offset-1 outline-none group/header flex h-9 min-w-0 flex-1 items-center gap-2.5 text-left rounded-drawer-row pl-2.75',
  'work-row-modal-header':
    'focus-visible:outline focus-visible:outline-1 focus-visible:outline-fg-quaternary focus-visible:-outline-offset-1 outline-none group/header flex h-9 min-w-0 flex-1 items-center gap-2.5 text-left rounded-lg pl-3',
  'work-row-open-overlay':
    'focus-visible:outline focus-visible:outline-1 focus-visible:outline-fg-quaternary focus-visible:-outline-offset-1 outline-none absolute inset-0 rounded-drawer-row',
  'workflow-run-open': 'absolute inset-0 cursor-pointer rounded-lg',
  'workflow-step-open': 'focus-ring flex min-w-0 flex-1 rounded-sm',
  'activity-group-disclosure-compact': `focus-ring flex ${COMPACT_ACTIVITY_ITEM_CLASS_NAME} fg-primary pointer-coarse:min-h-11`,
  'profile-photo-edit-private': `group relative rounded-full disabled:cursor-not-allowed ${REPLAY_BLOCK_CLASS}`,
  'sidebar-icon-idle': sidebarNavIconItemClassName(false),
  'sidebar-icon-selected': sidebarNavIconItemClassName(true),
  'sidebar-nav-idle': sidebarNavItemClassName(false),
  'sidebar-nav-selected': sidebarNavItemClassName(true),
  'sidebar-nav-touch-idle': sidebarNavItemClassName(false, true),
  'sidebar-nav-touch-selected': sidebarNavItemClassName(true, true),
} as const;
