import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import type { LedgerStatus } from '@canopy/protocol/canopy-core';
import { ledgerStatusTone, type LedgerStatusTone } from '../lib/ledger-display';
import { statusBadgeClassName, type StatusBadgeTone } from '../lib/row-chips';
import type { ButtonSize } from './Button';
import type { RailIconButtonSize } from '../components/RailIconButton';
import type {
  TitlebarIconButtonSurface,
  TitlebarIconButtonForeground,
} from '../components/TitlebarIconButton';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../lib/row-chips';
import {
  SECONDARY_SURFACE_HOVER_CLASS,
  SECONDARY_SURFACE_OPEN_CLASS,
} from '../lib/row-chips';
import type { FieldButtonNest } from './field-button-nest';
import {
  SIDEBAR_ITEM_IDLE_CLASSNAME,
  SIDEBAR_ITEM_SELECTED_CLASSNAME,
  SIDEBAR_ROW_GRID_CLASSNAME,
  SIDEBAR_ROW_TEXT_INSET_CLASSNAME,
  sidebarNavIconItemClassName,
} from './sidebar-item-classes';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

/**
 * An answer: a list row that acts on click (nothing is selected first), so
 * it lights up only under the pointer or keyboard focus. Its 4px padding is
 * even on every side and its ends fully round, so a highlighted circle sits
 * concentric in it.
 */
export const COMPOSER_PROMPT_ROW_CLASS =
  'flex w-full items-center gap-3 rounded-full p-1 text-left text-s fg-primary outline-none hover:bg-subtle focus-visible:bg-subtle disabled:opacity-60 disabled:hover:bg-transparent';

/**
 * How large the control's hit area is. `compact` is the 32px pointer control;
 * `touch` keeps a 44px tap target below `lg` and returns to 32px from `lg`
 * up. A host picks this from its own input model, not from the viewport.
 */
export type ComposerSendButtonTapTarget = 'compact' | 'touch';

/**
 * The pill's own tone: the `HeaderActionButton` intents plus `merged`, the
 * Merge PR button's status ink. The ✕ replaces the pill's leading glyph, so
 * it wears the same ink as the text beside it instead of a generic grey, and
 * its direct-hover wash is the same hue: it stacks on the pill's group-hover
 * tint, so even the same opacity reads one step deeper — which is exactly the
 * direct-hover cue.
 */
export type CancelActionButtonTone =
  | 'accent'
  | 'warning'
  | 'destructive'
  | 'merged';

/**
 * Ink and hover surface. `default` rests in the secondary ink with a subtle
 * hover; `strong` rests in the primary ink, for a control that sits beside
 * the composer's primary-ink + (the microphone). `warning` and `destructive`
 * carry an intent; a destructive control
 * rests at 70% and comes to full strength under the pointer. `pending` is a
 * control mid-transition (a microphone starting): the secondary ink with no
 * hover feedback, since the click will interrupt rather than act.
 */
export type ComposerIconButtonTone =
  | 'default'
  | 'strong'
  | 'pending'
  | 'warning'
  | 'destructive';

export type ChatComposerToolbarChipActiveTone =
  | 'default'
  | 'warning'
  | 'accent'
  | 'status-active';

export const CAPSULE_TOUCH_FLOOR_CLASS =
  'pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center';

export const CUSTOMIZE_CRUMB_CLASS =
  'focus-ring inline-flex h-7 items-center whitespace-nowrap rounded-md px-1.5 text-s font-normal fg-secondary transition-colors hover:bg-subtle hover:fg-primary';

const TONE_CLASS_NAMES: Record<CancelActionButtonTone, string> = {
  accent: 'fg-accent hover:bg-accent-subtle hover:fg-accent-strong',
  warning: 'fg-warning hover:bg-warning-subtle',
  destructive: 'fg-destructive hover:bg-destructive-subtle',
  merged: 'fg-special-strong hover:bg-special-subtle',
};

const ROUND_SIZE: Record<ComposerSendButtonTapTarget, string> = {
  compact: 'h-8 w-8',
  touch: 'h-11 w-11 lg:h-8 lg:w-8',
};

const CAPSULE_SIZE: Record<ComposerSendButtonTapTarget, string> = {
  compact: 'h-8 gap-1.5 px-3',
  touch: 'h-11 gap-1.5 px-3 lg:h-8',
};

const BASE =
  'focus-ring inline-flex items-center justify-center rounded-full fg-emphasis transition-transform enabled:active:scale-97 disabled:cursor-not-allowed';

const MUTED_DISABLED =
  'disabled:bg-muted disabled:fg-tertiary disabled:opacity-100';

export const FIELD_EDGE_CLASS = 'shadow-field transition-shadow';

export const FIELD_INVALID_CLASS =
  'aria-invalid:shadow-field-invalid aria-invalid:focus-visible:shadow-field-invalid-focus';

const SELECT_OPEN_EDGE_CLASS =
  'aria-expanded:shadow-field-focus aria-invalid:aria-expanded:shadow-field-invalid-focus';

export const BUTTON_PRESS_CLASS = 'duration-150 active:scale-97';

export const DROPDOWN_TRIGGER_INTERACTION_CLASS = `${BUTTON_PRESS_CLASS} ${SECONDARY_SURFACE_HOVER_CLASS} ${SECONDARY_SURFACE_OPEN_CLASS}`;

/**
 * A 44px-tall hit area on coarse pointers, centred on a control of any
 * height, without changing its layout. It extends only vertically, so
 * controls side by side on one line never share a hit area. The control
 * must not clip its overflow.
 */
export const COARSE_HIT_AREA_CLASS =
  "relative pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-1/2 pointer-coarse:before:h-11 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']";

export const CHIP_SHAPE_CLASS =
  'inline-block max-w-full rounded-sm canopy-inline-chip-geometry no-underline';

export const INLINE_CHIP_CLASS = `${CHIP_SHAPE_CLASS} focus-ring cursor-pointer bg-accent-subtle fg-accent-strong transition-colors hover:bg-accent-subtle/80`;

export const STORE_BADGE_CONTROL_CLASS =
  'inline-flex shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-accent';

/**
 * A button nested in a field's end: 24px in the 28px and 32px fields, 28px in
 * the 36px field and in the palette header. Coarse pointers make every field
 * 44px; the 10px-cornered fields then hold a 32px button 6px in (10 - 6 =
 * the 4px corner below), and the 12px-cornered one its 28px button 8px in.
 */
const BUTTON_SIZE_CLASS: Record<FieldButtonNest, string> = {
  field: 'h-6 min-w-6 pointer-coarse:h-8 pointer-coarse:min-w-8',
  'field-md': 'h-6 min-w-6 pointer-coarse:h-8 pointer-coarse:min-w-8',
  'field-lg': 'h-7 min-w-7',
  header: 'h-7 min-w-7',
};

/**
 * Its corner is the field's corner less the button's inset, so the two arcs
 * share a centre (docs/design/forms.md); the header has no edge of its own,
 * so its buttons stay round. Coarse pointers get a taller field around the
 * same button, so the inset grows and the corner tightens to the 4px floor.
 */
const BUTTON_CORNER_CLASS: Record<FieldButtonNest, string> = {
  field: 'rounded-field-button pointer-coarse:rounded-sm',
  'field-md': 'rounded-field-button-md pointer-coarse:rounded-sm',
  'field-lg': 'rounded-field-button-lg pointer-coarse:rounded-sm',
  header: 'rounded-full',
};

const BUTTON_TONE_CLASS = {
  active: 'bg-fg-primary [color:var(--bg-base)]',
  muted:
    'bg-muted fg-secondary hover:bg-subtle hover:fg-primary aria-expanded:bg-subtle aria-expanded:fg-primary',
  ghost: 'bg-transparent fg-tertiary hover:bg-subtle hover:fg-primary',
} as const;

const BUTTON_BASE_CLASS =
  "canopy-small-icon-stroke focus-ring relative inline-flex shrink-0 select-none items-center justify-center px-0 transition-colors before:absolute before:-inset-0.5 before:content-[''] pointer-coarse:before:-inset-2.5 disabled:pointer-events-none disabled:opacity-50";

const TRIGGER_BASE =
  'electron-no-drag focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-normal transition-colors';

const TONE_CLASS: Record<
  'pending' | 'merging',
  { idle: string; open: string }
> = {
  pending: {
    idle: 'fg-warning hover:bg-warning-subtle',
    open: 'bg-warning-subtle',
  },
  merging: {
    idle: `${OPERATIONAL_STATUS_COLORS.merged.foreground} hover:bg-special-subtle`,
    open: 'bg-special-subtle',
  },
};

export const FIELD_SURFACE_CLASS = `w-full bg-transparent text-s pointer-coarse:text-m fg-primary text-wrap placeholder:text-pretty placeholder:fg-tertiary outline-none ${FIELD_EDGE_CLASS} focus-visible:shadow-field-focus ${FIELD_INVALID_CLASS} disabled:cursor-not-allowed disabled:bg-disabled disabled:fg-disabled`;

export const FIELD_CLASS = `min-h-9 rounded-lg px-3 py-2 pointer-coarse:min-h-11 ${FIELD_SURFACE_CLASS}`;

const PICKER_FIELD_CLASS = `${FIELD_CLASS.replace('transition-shadow', 'transition-[box-shadow,transform,scale]')} ${DROPDOWN_TRIGGER_INTERACTION_CLASS} ${SELECT_OPEN_EDGE_CLASS} flex cursor-pointer items-center pr-9 text-left disabled:pointer-events-none disabled:cursor-not-allowed`;

// A 28px icon control grows to 44px on a coarse pointer.
const COARSE_ICON_HIT_CLASS =
  "pointer-coarse:before:absolute pointer-coarse:before:-inset-2 pointer-coarse:before:content-['']";

const COMPOSER_TOOLBAR_ACTIVE_TONES: Record<
  ChatComposerToolbarChipActiveTone,
  string
> = {
  default: 'hover:bg-subtle',
  warning: 'bg-warning-subtle fg-warning hover:bg-warning-subtle',
  accent: 'bg-accent-subtle fg-accent-strong hover:bg-accent-subtle',
  // Something running on the chat's behalf (its watchers).
  'status-active': 'bg-info-subtle fg-info hover:bg-info-subtle',
};

const COMPOSER_ICON_REST_TONES: Record<ComposerIconButtonTone, string> = {
  default:
    'fg-secondary hover:bg-subtle hover:fg-primary disabled:hover:bg-transparent disabled:hover:fg-secondary',
  strong: 'fg-primary hover:bg-subtle disabled:hover:bg-transparent',
  pending: 'fg-secondary',
  warning: 'fg-warning hover:bg-warning-subtle disabled:hover:bg-transparent',
  destructive:
    'fg-destructive/70 hover:bg-destructive-subtle hover:fg-destructive disabled:hover:bg-transparent disabled:hover:fg-destructive/70',
};

const COMPOSER_ICON_ACTIVE_TONES: Record<ComposerIconButtonTone, string> = {
  default: 'bg-subtle fg-primary',
  strong: 'bg-subtle fg-primary',
  pending: 'fg-secondary',
  warning: 'bg-warning-subtle fg-warning hover:bg-warning-subtle',
  destructive:
    'bg-destructive-subtle fg-destructive hover:bg-destructive-subtle/80 disabled:hover:bg-destructive-subtle',
};

const FOREGROUND_CLASS_NAMES: Record<TitlebarIconButtonForeground, string> = {
  'top-bar': 'fg-secondary enabled:hover:fg-primary',
  titlebar: 'titlebar-control-fg',
};

const SURFACE_CLASS_NAMES: Record<TitlebarIconButtonSurface, string> = {
  titlebar: '',
  panelChrome: 'canopy-panel-chrome-button',
  panelTabStrip: 'canopy-panel-add-tab',
};

export const USAGE_TOUCH_FLOOR_CLASS =
  'pointer-coarse:min-h-11 pointer-coarse:min-w-11';

const USAGE_QUIET_ACTION_CLASS =
  'text-xs fg-secondary transition-colors hover:fg-primary';

export const AGENT_SENT_TITLE_CLASS =
  'pb-1 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium fg-secondary';

export const AGENT_SENT_INLINE_TITLE_CLASS =
  'flex min-w-0 items-center gap-1.5 whitespace-nowrap fg-tertiary';

/** A message's 64px tile, with the corner 6px inside the bubble's. */
const MESSAGE_TILE_CLASS =
  'relative size-16 shrink-0 overflow-hidden rounded-md bg-secondary';

/** The media viewer's 48px strip tile, on the message tile's corner. */
const VIEWER_THUMBNAIL_CLASS =
  'relative block size-12 shrink-0 overflow-hidden rounded-md bg-secondary transition-opacity';

/**
 * The box of every attachment tile, whether it is pressable or a named
 * picture: a message's row (`more`, `file`, `image`) and the media viewer's
 * strip, whose item on screen carries a ring 2px outside its edge while the
 * others dim until hovered.
 */
export const TILE_PRESENTATION_CLASS = {
  more: `${MESSAGE_TILE_CLASS} flex items-center justify-center text-xs fg-secondary hover:fg-primary`,
  file: `${MESSAGE_TILE_CLASS} flex flex-col justify-between p-1.5 text-left`,
  image: `${MESSAGE_TILE_CLASS} block`,
  thumbnail: `${VIEWER_THUMBNAIL_CLASS} opacity-60 hover:opacity-100`,
  'thumbnail-current': `${VIEWER_THUMBNAIL_CLASS} ring-2 ring-fg-primary ring-offset-2 ring-offset-transparent`,
};

const TILE_PRESS_CLASS = `transition-[scale] ${BUTTON_PRESS_CLASS}`;

export const ARCHIVED_ROW_ACTIONS_RESERVE_WIDE =
  '@min-[36rem]/archived-list:pr-8';

const OVERVIEW_ROW_BODY_BASE_CLASS_NAME =
  'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors pointer-coarse:self-stretch';

export function archivedOverviewRowClassName(
  actionsReserve: 'reveal' | 'inline',
): string {
  return actionsReserve === 'reveal'
    ? `${OVERVIEW_ROW_BODY_BASE_CLASS_NAME} group-hover:pr-8 group-focus-within:pr-8 pointer-coarse:pr-12 ${ARCHIVED_ROW_ACTIONS_RESERVE_WIDE}`
    : `${OVERVIEW_ROW_BODY_BASE_CLASS_NAME} pr-24`;
}

export const CAPABILITY_TILE_CELL_CLASS =
  'h-full w-full supports-[grid-template-rows:subgrid]:row-span-2 supports-[grid-template-rows:subgrid]:grid supports-[grid-template-rows:subgrid]:grid-rows-subgrid';

export const TRIGGER_CLASS = `flex flex-col rounded-lg border bg-card px-4 pt-3.25 pb-4 text-left no-underline supports-[grid-template-rows:subgrid]:grid-cols-1 supports-[grid-template-rows:subgrid]:gap-y-0 ${CAPABILITY_TILE_CELL_CLASS}`;

export const INTERACTIVE_CLASS = `focus-ring ${TRIGGER_CLASS} transition-colors hover:bg-subtle`;

export const ROW_TRIGGER_CLASS =
  'focus-ring flex min-w-0 flex-1 rounded-sm text-left no-underline pointer-coarse:min-h-11';

export function ledgerStatusPillClassName(status: LedgerStatus): string {
  return `shrink-0 ${statusBadgeClassName(PILL_TONES[ledgerStatusTone(status)])}`;
}

const PILL_TONES: Readonly<Record<LedgerStatusTone, StatusBadgeTone>> = {
  quiet: 'neutral',
  active: 'active',
  success: 'success',
  failed: 'failed',
  paused: 'paused',
  attention: 'warning',
};

export function costRowClasses(
  density: 'card' | 'panel',
  selected: boolean,
  interactive: boolean,
): string {
  const interaction = interactive
    ? 'focus-ring transition-colors hover:bg-subtle pointer-coarse:min-h-11'
    : '';
  const selection = selected ? 'bg-subtle' : '';
  const spacing =
    density === 'card' ? 'gap-1 px-2 py-1.5' : 'gap-1.5 px-2 py-2';
  return `flex w-full flex-col rounded-md text-left ${interaction} ${selection} ${spacing}`;
}

export function nestedIconButtonRadiusClassName(size: ButtonSize): string {
  return size === 'md' || size === 'lg'
    ? 'rounded-row'
    : 'rounded-[max(0px,calc(var(--radius-row)-2px))]';
}

const NATIVE_SIZE_CLASS_NAMES: Record<RailIconButtonSize, string> = {
  compact: `h-7 w-7 ${nestedIconButtonRadiusClassName('sm')}`,
  row: `h-8 w-8 ${nestedIconButtonRadiusClassName('md')}`,
};

const NATIVE_TONE_CLASS_NAMES: Record<NativeTone, string> = {
  section: 'fg-quaternary hover:bg-subtle hover:fg-primary',
  destructive: 'fg-tertiary hover:bg-destructive-subtle hover:fg-destructive',
};

const QUIET_NATIVE_TONE_CLASS_NAMES: Record<NativeTone, string> = {
  section: 'fg-quaternary hover:fg-primary',
  destructive: 'fg-tertiary hover:fg-primary',
};

type NativeTone = 'section' | 'destructive';

const HEALTH_WARNING_COARSE_HIT_AREA =
  "relative before:absolute before:inset-0 before:content-[''] pointer-coarse:before:-inset-x-1.5 pointer-coarse:before:-inset-y-1";

const DEFERRED_ACTION_PADDING: readonly string[] = [
  '',
  'pointer-fine:group-hover/sidebar-item:pr-8 pointer-fine:group-focus-within/sidebar-item:pr-8 pointer-fine:workspace-header-actions-focused:pr-8',
  'pointer-fine:group-hover/sidebar-item:pr-15 pointer-fine:group-focus-within/sidebar-item:pr-15 pointer-fine:workspace-header-actions-focused:pr-15',
  'pointer-fine:group-hover/sidebar-item:pr-22 pointer-fine:group-focus-within/sidebar-item:pr-22 pointer-fine:workspace-header-actions-focused:pr-22',
  'pointer-fine:group-hover/sidebar-item:pr-29 pointer-fine:group-focus-within/sidebar-item:pr-29 pointer-fine:workspace-header-actions-focused:pr-29',
  'pointer-fine:group-hover/sidebar-item:pr-36 pointer-fine:group-focus-within/sidebar-item:pr-36 pointer-fine:workspace-header-actions-focused:pr-36',
];

export const STEP_ROW_TEXT_CLASS = 'text-s fg-secondary';

const STRETCHED_TOGGLE_CLASS =
  "focus-ring-stretched focus-ring-inset before:absolute before:inset-0 before:rounded-sm before:content-['']";

export const RAIL_VISIBILITY_CLASSES = {
  all: '',
  'fine-pointer': 'pointer-coarse:hidden',
  'coarse-pointer': 'pointer-fine:hidden',
} as const;

export const RAIL_INSET_CLASSES = {
  none: '',
  'tight-end': '-my-1 -mr-1',
  'roomy-inline': 'mx-2',
} as const;

/** Presentations for specialized shared widget controls. */
export const SHARED_CONTROL_RECIPES = {
  'disclosure-inline':
    // On touch the ::before grows the 22px line to a 46px target without moving it.
    "focus-ring relative inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pr-1 text-left text-xs font-medium fg-secondary hover:fg-primary pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-3 pointer-coarse:before:content-['']",
  // A section heading that folds its section: it keeps the heading's own type
  // and takes a quiet fill on hover, chevron and title together. The fill
  // reaches 12px left of the chevron through -ml-3, so the heading measures
  // 12px less than the button and the cap allows those 12px back. A -mr-3 or
  // max-w-full would squeeze the title to "Ins…" (CAN-7494).
  'section-heading-toggle':
    "focus-ring relative -ml-3 inline-flex min-w-0 max-w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-3 text-left hover:bg-subtle pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2 pointer-coarse:before:content-['']",
  'disclosure-box':
    'focus-ring flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left text-s font-medium fg-primary hover:bg-subtle',
  'archived-chat-row':
    'flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md py-2 pl-2 text-left focus:outline-none',
  'clickable-name':
    'focus-ring group rounded-sm text-left pointer-coarse:min-h-11',
  // An attachment row's open target: its icon, name and metadata, on the
  // row's 8px corner. Touch rows wrap the actions under it at full width.
  'attachment-row-open':
    'focus-ring block w-full rounded-md px-2 py-1.5 text-left pointer-coarse:px-0 pointer-coarse:py-0',
  // A job on the pipeline strip: the button is the 4px dot (or the 12px
  // running comet) itself. Dots sit 6px apart, so the hit area reaches 3px
  // into each gap and neighbours' areas meet without overlapping; it reaches
  // 6px above and below, so a dot's target is 16px tall. Hover zooms the
  // mark inside, never the button, so the hit areas stay put.
  'dag-job-dot':
    "focus-ring relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full *:transition-transform hover:*:scale-125 before:absolute before:-inset-x-0.75 before:-inset-y-1.5 before:content-['']",
  'floating-chat-menu':
    'focus-ring -ml-1.5 flex h-7 min-w-0 items-center gap-1 rounded-md pl-2 pr-1.5 fg-tertiary transition-colors hover:bg-subtle hover:fg-primary aria-expanded:bg-subtle aria-expanded:fg-primary',
  'markdown-copy':
    'markdown-code-copy-button focus-ring rounded-md bg-popover/80 p-1.5 fg-secondary transition-colors hover:bg-popover hover:fg-primary',
  'model-picker-experimental':
    'flex h-5 w-5 items-center justify-center rounded fg-secondary hover:fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1',
  'panel-keyboard-drag':
    'sr-only focus:not-sr-only focus:absolute focus:left-0 focus:top-0 focus:z-20 focus:rounded-sm focus:bg-quaternary focus:px-2 focus:py-1 focus:text-2xs focus:font-normal focus:fg-primary focus:shadow-sm',
  'sidebar-group-rail':
    'group/group-rail flex h-full w-2 items-stretch justify-center py-1 pointer-coarse:pointer-events-none',
  'skill-file-close':
    "focus-ring relative rounded p-0.5 fg-secondary opacity-60 transition-opacity hover:fg-primary hover:bg-base group-hover:opacity-100 pointer-coarse:opacity-100 pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1 pointer-coarse:before:-inset-y-3.5 pointer-coarse:before:content-['']",
  'toast-keyboard-open': 'sr-only pointer-events-none',
  'workspace-layout-option': 'option text-xs',
  'agent-block-output':
    'focus-ring focus-ring-inset w-full border-t px-2.5 py-1 text-left text-3xs font-medium fg-secondary hover:fg-secondary pointer-coarse:min-h-11',
  'collapsed-turn-disclosure':
    "focus-ring focus-ring-stretched flex flex-shrink-0 items-center gap-3 text-left before:absolute before:inset-0 before:content-['']",
  // The press of an activatable project catalog row: its `::before` covers
  // the row, so the row presses while its actions stay separate controls.
  'project-catalog-row-press':
    "focus-ring focus-ring-stretched focus-ring-inset flex min-w-0 max-w-full cursor-pointer text-left before:absolute before:inset-0 before:rounded-sm before:content-[''] aria-disabled:cursor-not-allowed",
  'attachment-open':
    'focus-ring inline-flex min-w-0 items-center gap-1 rounded-sm hover:fg-primary',
  'attachment-download':
    "focus-ring relative ml-0.5 inline-flex shrink-0 items-center rounded-sm hover:fg-primary before:absolute before:inset-0 before:content-[''] pointer-coarse:before:-inset-y-3.5",
  'file-deliverable-open':
    'focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-3 text-left hover:bg-secondary',
  'approval-path':
    'flex min-w-0 max-w-full items-center gap-1 rounded bg-fg-primary/[0.06] px-1.5 py-0.5 text-left font-mono text-2xs fg-primary/80 transition-colors hover:bg-fg-primary/[0.1]',
  'approval-allow-menu':
    'rounded-r border-l border-line-accent/20 bg-accent-subtle px-1.5 py-1.5 fg-accent-strong transition-colors hover:bg-accent-subtle/80 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
  'approval-deny-menu':
    'rounded-r px-1.5 py-1.5 fg-secondary transition-colors hover:bg-fg-primary/[0.06] hover:fg-primary/80 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
  'subagent-lineage': 'min-w-0 truncate hover:fg-primary hover:underline',
  'subagent-chat-row':
    'min-w-0 flex-1 truncate text-left fg-primary focus-ring',
  'subagent-workflow-row':
    'min-w-0 flex-1 truncate text-left font-medium fg-primary focus-ring',
  'ledger-file': `focus-ring inline-flex max-w-full items-center gap-1 rounded-md bg-fg-primary/[0.06] px-2 py-1 font-mono text-2xs fg-secondary transition-colors hover:bg-fg-primary/[0.1] hover:fg-primary relative pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-[3px] pointer-coarse:before:content-['']`,
  'panel-collapsed-tab': 'canopy-panel-collapsed-tab',
  'panel-tab-close': 'canopy-panel-tab-close',
  'panel-tab-edge-count': 'canopy-panel-tab-edge-count',
  'panel-tab-list-close': 'canopy-panel-tab-list-close',
  'settings-select-row':
    'focus-ring -mx-2 -my-3 box-content flex min-h-10 min-w-0 flex-1 items-center justify-between gap-6 rounded-md px-2 py-3 text-left transition-colors hover:bg-subtle focus-visible:bg-subtle disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
  'activity-action-card': ({ attached }: { attached: boolean }) =>
    `electron-no-drag focus-ring flex min-h-11 select-none w-full touch-manipulation items-center gap-3 bg-tertiary p-3 text-left fg-primary ${attached ? 'rounded-t-lg rounded-b-none' : 'rounded-lg shadow-sm'} transition-[transform,scale] duration-150 enabled:hover:bg-[var(--bg-activity-card-hover)] active:scale-99`,
  'table-filter-toggle': ({
    disabled,
    toggleMode,
  }: {
    disabled: boolean;
    toggleMode: 'unsupported' | 'supported';
  }) =>
    `focus-ring focus-ring-inset flex w-full min-w-0 items-center gap-2 rounded-sm text-left ${disabled ? 'cursor-not-allowed' : ''} ${toggleMode === 'unsupported' ? 'opacity-70' : ''}`,
  'panel-section-disclosure':
    'flex min-w-0 items-center gap-3 text-left focus-ring w-full rounded-sm',
  'ledger-composer-prompt': ({
    disabled,
    page,
  }: {
    disabled: boolean;
    page: boolean;
  }) =>
    // It truncates, which would clip a hit area drawn outside it, so on
    // coarse pointers it grows to 44px instead.
    `focus-ring min-w-0 flex-1 truncate rounded-full bg-subtle px-4 py-2 pointer-coarse:min-h-11 text-left fg-tertiary transition-colors ${disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-secondary'} ${page ? 'text-s' : 'text-xs'}`,
  'ledger-in-place': ({
    extent,
  }: {
    extent: 'content' | 'container' | 'flush-owner';
  }) => {
    const extentClass = {
      content: '',
      container: 'max-w-full',
      'flush-owner': 'min-w-0 max-w-[calc(100%+0.5rem)]',
    }[extent];
    return `focus-ring -mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent ${COARSE_HIT_AREA_CLASS} ${extentClass}`;
  },
  'dag-scroll': ({ isLeft }: { isLeft: boolean }) =>
    `focus-ring absolute inset-y-0 ${isLeft ? 'left-0' : 'right-0'} z-10 flex w-5 pointer-coarse:w-8 items-center ${isLeft ? 'justify-start bg-gradient-to-r' : 'justify-end bg-gradient-to-l'} from-base to-transparent`,
  'approval-allow': ({ ruleScopes }: { ruleScopes: boolean }) =>
    `${ruleScopes ? 'rounded-l' : 'rounded'} bg-accent-subtle px-3 py-1.5 text-xs font-medium fg-accent-strong transition-colors hover:bg-accent-subtle/80 pointer-coarse:min-h-11`,
  'approval-deny': ({ split }: { split: boolean }) =>
    `${split ? 'rounded-l' : 'rounded'} px-3 py-1.5 text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.06] hover:fg-primary/80 pointer-coarse:min-h-11`,
  'agent-frame-activate': ({ needsClick }: { needsClick: boolean }) =>
    `focus-ring focus-ring-inset absolute inset-0 bg-transparent ${
      needsClick ? 'cursor-pointer' : 'cursor-default'
    }`,
  'project-choice': ({ selected }: { selected: boolean }) =>
    `focus-ring flex min-w-0 flex-col justify-start gap-1 rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
      selected
        ? 'border-line-accent bg-accent-subtle fg-primary'
        : 'bg-secondary/10 fg-secondary hover:bg-secondary/20'
    }`,
  // A workflow designer step card (CAN-4224): the card is the button.
  'workflow-stack-card': ({ selected }: { selected: boolean }) =>
    `focus-ring flex w-full min-w-0 items-start gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-[border-color,box-shadow] ${
      selected
        ? 'border-line-accent ring-1 ring-line-accent'
        : 'hover:border-line-secondary'
    }`,
  'turn-file-chip': ({
    presentation,
  }: {
    presentation: 'summary' | 'detail';
  }) =>
    `focus-ring focus-ring-stretched inline-flex min-h-8 min-w-0 max-w-3/5 shrink items-center rounded-sm text-left before:absolute ${presentation === 'summary' ? 'before:inset-1 before:rounded-lg' : 'focus-ring-inset before:inset-0 before:rounded-[calc(var(--radius-xl)-5px)]'} aria-disabled:cursor-default pointer-coarse:min-h-11`,
  'sidebar-more-row': ({ touchTarget }: { touchTarget: boolean }) =>
    `focus-ring group/sidebar-item relative flex ${
      touchTarget ? 'min-h-11' : 'h-8'
    } w-full items-center gap-1.5 rounded-row px-1.5 py-0 text-left text-s font-normal fg-secondary hover:bg-subtle`,
  'composer-plus': ({
    tapTarget,
    active,
  }: {
    tapTarget: 'touch' | 'desktop';
    active: boolean;
  }) =>
    `focus-ring inline-flex ${tapTarget === 'touch' ? 'h-11 w-11 lg:h-8 lg:w-8' : 'h-8 w-8'} shrink-0 items-center justify-center rounded-full transition-transform enabled:active:scale-97 disabled:cursor-not-allowed disabled:fg-tertiary disabled:opacity-100 ${
      active
        ? 'bg-warning-subtle fg-warning enabled:hover:bg-warning-subtle'
        : // A one-device-pixel inset rim in the quiet line role
          // keeps the + defined against the composer's surface.
          'bg-subtle fg-primary ring-[length:var(--border-hairline)] ring-inset ring-line-tertiary enabled:hover:bg-muted'
    }`,
  'terminal-composer-trigger': ({
    tapTarget,
    failed,
  }: {
    tapTarget: 'touch' | 'desktop';
    failed: boolean;
  }) =>
    `focus-ring inline-flex ${tapTarget === 'touch' ? 'h-11 w-11 lg:h-8 lg:w-8' : 'h-8 w-8'} items-center justify-center rounded-full fg-emphasis transition-transform enabled:active:scale-97 disabled:cursor-not-allowed disabled:bg-muted disabled:fg-tertiary disabled:opacity-100 ${
      failed
        ? 'bg-destructive enabled:hover:bg-destructive-hover'
        : 'bg-warning enabled:hover:bg-warning/90'
    }`,
  'share-scope-option': ({ selected }: { selected: boolean }) =>
    `focus-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
      selected
        ? 'bg-accent-subtle ring-1 ring-line-accent/40'
        : 'hover:bg-fg-primary/[0.06]'
    }`,
  'composer-overflow-trigger':
    'focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-lg fg-secondary transition-colors hover:bg-fg-primary/[0.08] hover:fg-primary lg:h-7 lg:w-7',
  'customize-breadcrumb': ({ shrink }: { shrink: boolean }) =>
    `${CUSTOMIZE_CRUMB_CLASS} ${shrink ? 'max-w-full' : ''}`,
  'customize-related-item': ({ list }: { list: boolean }) =>
    list
      ? 'focus-ring -ml-4 flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-colors hover:bg-subtle pointer-coarse:min-h-11'
      : 'w-full flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-subtle text-left',
  'sidebar-more-compact': sidebarNavIconItemClassName(false),
  'thinking-level-cycle': ({
    capsule,
    isActive,
  }: {
    capsule: boolean;
    isActive: boolean;
  }) =>
    `flex shrink-0 items-center transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
      capsule
        ? `h-8 gap-1.5 rounded-full px-2.5 text-xs ${CAPSULE_TOUCH_FLOOR_CLASS}`
        : 'gap-1 rounded-md px-1.5 py-0.5 text-2xs'
    } ${isActive ? 'fg-primary' : 'fg-secondary hover:fg-primary'}`,
  'skill-file-tab': ({ closable }: { closable: boolean }) =>
    `focus-ring max-w-48 truncate rounded-md py-1 pointer-coarse:py-3 font-medium ${closable ? 'pl-2.5 pr-1' : 'px-2.5'}`,
  'skill-file-tree': ({
    presentation,
    open,
  }: {
    presentation: 'toolbar' | 'detail';
    open: boolean;
  }) =>
    presentation === 'detail'
      ? `focus-ring relative mr-1 shrink-0 rounded-md border p-1.5 fg-secondary ${COARSE_ICON_HIT_CLASS}`
      : `focus-ring relative shrink-0 rounded-md border p-1.5 transition-colors ${COARSE_ICON_HIT_CLASS} ${open ? 'bg-secondary fg-primary' : 'border-transparent fg-secondary hover:fg-primary hover:bg-muted'}`,
  'github-repository-option': ({ unavailable }: { unavailable: boolean }) =>
    `focus-ring flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors ${unavailable ? 'fg-tertiary cursor-not-allowed' : 'hover:bg-secondary/30 fg-primary'}`,
  'plan-approval-start': COMPOSER_PROMPT_ROW_CLASS,
  'turn-outcome-step':
    'focus-ring text-left transition-colors hover:bg-subtle flex w-full items-start gap-1.5 rounded-sm px-1 py-0.5',
  'collapsed-turn-outcomes':
    'focus-ring rounded-sm whitespace-nowrap transition-colors hover:fg-secondary',
  'ask-user-choice': `group/option flex min-h-9 w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 pointer-coarse:py-3 text-left text-s fg-primary outline-none hover:bg-subtle focus-visible:bg-subtle has-[:focus-visible]:bg-subtle disabled:cursor-not-allowed disabled:fg-disabled has-[:disabled]:cursor-not-allowed has-[:disabled]:fg-disabled pointer-coarse:min-h-11`,
  'diff-file-choice': ({ selected }: { selected: boolean }) =>
    `focus-ring focus-ring-inset flex w-full items-center gap-1.5 rounded-md px-2 py-1 pointer-coarse:min-h-11 text-xs transition-colors ${selected ? 'border-l-2 border-line-accent bg-accent/[0.08] fg-primary pl-1.5' : 'fg-primary/80 hover:bg-fg-primary/[0.06]'}`,
  'archived-container-item': ({
    rowSized,
    size,
    selected,
  }: {
    rowSized: boolean;
    size: 'item' | 'compact' | 'row';
    selected: boolean;
  }) =>
    `focus-ring flex pr-1.5 ${rowSized ? 'h-8 rounded-row' : 'h-7 rounded-md'} pointer-coarse:min-h-11 w-full items-center ${SIDEBAR_ROW_GRID_CLASSNAME} text-left ${size === 'item' ? 'text-s leading-snug' : 'text-xs'} transition-colors ${
      selected ? SIDEBAR_ITEM_SELECTED_CLASSNAME : SIDEBAR_ITEM_IDLE_CLASSNAME
    }`,
  'cancel-action': ({ tone }: { tone: CancelActionButtonTone }) =>
    `electron-no-drag focus-ring flex h-6 w-8 items-center justify-center rounded-full transition-colors ${TONE_CLASS_NAMES[tone]}`,
  'composer-send': ({
    tapTarget,
  }: {
    tapTarget: ComposerSendButtonTapTarget;
  }) =>
    `${BASE} ${ROUND_SIZE[tapTarget]} bg-accent enabled:hover:bg-accent/90 ${MUTED_DISABLED}`,
  'composer-stop': ({
    tapTarget,
    showArmed,
  }: {
    tapTarget: ComposerSendButtonTapTarget;
    showArmed: boolean;
  }) =>
    `${BASE} ${
      showArmed ? CAPSULE_SIZE[tapTarget] : ROUND_SIZE[tapTarget]
    } bg-accent enabled:hover:bg-accent/90 disabled:opacity-40`,
  'creatable-picker-field': PICKER_FIELD_CLASS,
  'picker-field': PICKER_FIELD_CLASS,
  'inline-mention': INLINE_CHIP_CLASS,
  'merge-queue-trigger': ({
    tone,
    open,
  }: {
    tone: 'pending' | 'merging';
    open: boolean;
  }) =>
    `${TRIGGER_BASE} ${TONE_CLASS[tone].idle} ${open ? TONE_CLASS[tone].open : ''}`,
  'project-list-page': ({
    firstInRow,
    touchTargets,
  }: {
    firstInRow: boolean;
    touchTargets: boolean;
  }) =>
    `focus-ring flex ${
      touchTargets ? 'min-h-11' : 'h-7 pointer-coarse:min-h-11'
    } min-w-0 items-center gap-1.5 rounded-row ${
      firstInRow ? `${SIDEBAR_ROW_TEXT_INSET_CLASSNAME} pr-1.5` : 'px-1.5'
    } text-left text-s font-normal fg-tertiary hover:bg-subtle hover:fg-primary`,
  'search-field-endcap': ({
    nest,
    tone,
  }: {
    nest: FieldButtonNest;
    tone: keyof typeof BUTTON_TONE_CLASS;
  }) =>
    `${BUTTON_BASE_CLASS} ${BUTTON_SIZE_CLASS[nest]} ${BUTTON_CORNER_CLASS[nest]} ${BUTTON_TONE_CLASS[tone]}`,
  'vendor-store-badge': STORE_BADGE_CONTROL_CLASS,
  'composer-toolbar-chip': ({
    variant,
    foldable,
    labelled,
    active,
    activeTone,
  }: {
    variant: 'capsule' | 'chip';
    foldable: boolean;
    labelled: boolean;
    active: boolean;
    activeTone: ChatComposerToolbarChipActiveTone;
  }) => {
    const shapeClassName =
      variant === 'capsule'
        ? `focus-ring h-8 rounded-full text-xs ${foldable ? 'px-2 duration-200 ease-out' : labelled ? 'gap-1.5 px-2.5' : 'w-8 justify-center gap-1.5'} ${CAPSULE_TOUCH_FLOOR_CLASS}`
        : `gap-1 rounded-md px-1.5 py-0.5 text-2xs ${CAPSULE_TOUCH_FLOOR_CLASS} pointer-coarse:px-2`;
    return `flex shrink-0 items-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${shapeClassName} ${
      active
        ? COMPOSER_TOOLBAR_ACTIVE_TONES[activeTone]
        : 'fg-secondary hover:bg-subtle hover:fg-primary'
    }`;
  },
  'composer-action-option': ({
    highlight,
  }: {
    highlight: 'selected' | 'quiet' | 'hover';
  }) =>
    `focus-ring flex min-h-8 w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-xs fg-primary disabled:opacity-50 ${highlight === 'selected' ? 'bg-subtle' : highlight === 'hover' ? 'hover:bg-subtle' : ''}`,
  'composer-action-all': ({
    highlight,
  }: {
    highlight: 'selected' | 'quiet' | 'hover';
  }) =>
    `focus-ring flex min-h-8 w-full items-center rounded-xl px-2 py-1 text-left text-xs fg-secondary ${highlight === 'selected' ? 'bg-subtle' : highlight === 'hover' ? 'hover:bg-subtle' : ''}`,
  'customize-installed-primary':
    'block min-w-0 text-left outline-none after:absolute after:inset-0',
  'mcp-card-title': ({ compact }: { compact: boolean }) =>
    `focus-ring rounded text-left hover:underline min-w-0 break-words ${compact ? 'fg-primary' : 'text-s font-medium fg-primary'}`,
  'model-harness-tab': ({
    pickerChrome,
    active,
    connected,
    favorite,
  }: {
    pickerChrome: boolean;
    active: boolean;
    connected: boolean;
    favorite: boolean;
  }) =>
    `focus-ring flex items-center justify-center transition-colors ${
      pickerChrome
        ? `size-9 shrink-0 rounded-md [&>span]:!size-4.5 ${
            active
              ? `${SECONDARY_SURFACE_SHELL_CLASS} ${
                  connected ? 'fg-primary' : 'fg-quaternary'
                }`
              : connected
                ? `${favorite ? 'fg-tertiary' : 'fg-secondary'} hover:bg-subtle hover:fg-primary`
                : 'fg-quaternary hover:bg-subtle'
          }`
        : `relative h-10 w-full shrink-0 rounded-none hover:bg-subtle ${
            active
              ? connected
                ? 'bg-subtle fg-primary'
                : 'bg-subtle fg-quaternary'
              : connected
                ? 'fg-secondary hover:fg-primary'
                : 'fg-quaternary'
          }`
    }`,
  'model-picker-trigger': ({
    unavailable,
    variant,
    compact,
    hideChevron,
  }: {
    unavailable: boolean;
    variant: 'capsule' | 'compact';
    compact: boolean;
    hideChevron: boolean;
  }) =>
    `flex min-w-0 max-w-full items-center whitespace-nowrap ${
      unavailable ? 'fg-warning-strong' : 'fg-primary'
    } transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
      variant === 'capsule'
        ? compact
          ? // 32px is desktop's capsule contract; a coarse pointer (phone,
            // tablet, touch laptop) still gets the 44px floor (DESIGN.md).
            `h-8 gap-1 rounded-full px-1 text-xs ${CAPSULE_TOUCH_FLOOR_CLASS}`
          : `h-8 gap-1 rounded-full px-2.5 text-xs${hideChevron ? ' pr-3' : ''} ${CAPSULE_TOUCH_FLOOR_CLASS}`
        : 'gap-1 rounded-md px-1.5 py-0.5 text-2xs'
    }`,
  'suggestion-row': ({
    tone,
    trailingControl,
    replayMask,
  }: {
    tone: 'default' | 'muted';
    trailingControl: boolean | 'wide';
    replayMask: boolean;
  }) =>
    `focus-ring flex w-full items-center gap-2 rounded-full px-2 py-2 text-left text-s ${
      tone === 'muted' ? 'fg-tertiary' : 'fg-secondary'
    } transition-colors disabled:pointer-events-none disabled:fg-disabled ${
      trailingControl === false
        ? 'hover:bg-subtle hover:fg-primary'
        : `${trailingControl === 'wide' ? 'pr-28' : 'pr-12'} group-hover:bg-subtle group-hover:fg-primary`
    } ${replayMask ? REPLAY_MASK_CLASS : ''}`,
  'titlebar-icon': ({
    coarsePointerTarget,
    foreground,
    surface,
    holdHoverWhenExpanded,
  }: {
    coarsePointerTarget: boolean;
    foreground: TitlebarIconButtonForeground;
    surface: TitlebarIconButtonSurface;
    holdHoverWhenExpanded: boolean;
  }) =>
    `electron-no-drag focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors enabled:hover:bg-subtle disabled:opacity-35 ${coarsePointerTarget ? 'pointer-coarse:min-h-11 pointer-coarse:min-w-11' : ''} ${FOREGROUND_CLASS_NAMES[foreground]}${surface === 'titlebar' ? '' : ` ${SURFACE_CLASS_NAMES[surface]}`}${holdHoverWhenExpanded ? ' aria-expanded:bg-subtle aria-expanded:fg-primary' : ''}`,
  'usage-indicator-trigger': ({
    weeklyRing,
    capsule,
    wideTrigger,
  }: {
    weeklyRing: boolean;
    capsule: boolean;
    wideTrigger: boolean;
  }) =>
    `focus-ring flex items-center text-2xs fg-secondary transition-colors hover:fg-primary ${
      // The weekly fill is the hover state; the round hover fill would
      // sit under it.
      weeklyRing
        ? 'group/weekly h-8 w-8 justify-center rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11'
        : capsule
          ? wideTrigger
            ? 'h-8 min-w-8 max-w-full justify-center gap-1 rounded-full px-2.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11'
            : 'h-8 w-8 justify-center rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11'
          : 'gap-1 rounded-md px-1.5 py-0.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11'
    }${weeklyRing ? '' : ' hover:bg-subtle'}`,
  'usage-indicator-action': ({ band }: { band: boolean }) =>
    `flex w-full items-center justify-between gap-2 text-left ${USAGE_QUIET_ACTION_CLASS} ${USAGE_TOUCH_FLOOR_CLASS} ${
      band
        ? 'bg-quaternary px-3 py-3 outline-none focus-visible:bg-subtle focus-visible:fg-primary'
        : 'focus-ring rounded-sm'
    }`,
  'usage-indicator-text-action': `focus-ring relative shrink-0 rounded-sm ${USAGE_QUIET_ACTION_CLASS} ${USAGE_TOUCH_FLOOR_CLASS}`,
  'agent-sent-title': ({ inline }: { inline: boolean }) =>
    `${inline ? AGENT_SENT_INLINE_TITLE_CLASS : AGENT_SENT_TITLE_CLASS} w-fit max-w-full cursor-pointer rounded-sm text-left hover:fg-primary hover:underline focus-ring`,
  'composer-icon': ({
    tone,
    active,
    capsule,
    wide,
    autoWidth,
    constrainLabel,
  }: {
    tone: ComposerIconButtonTone;
    active: boolean;
    capsule: boolean;
    wide: boolean;
    autoWidth: boolean;
    constrainLabel: boolean;
  }) => {
    const toneClassName = active
      ? COMPOSER_ICON_ACTIVE_TONES[tone]
      : COMPOSER_ICON_REST_TONES[tone];
    const geometryClassName = capsule
      ? `h-8 rounded-full ${
          autoWidth
            ? 'min-w-10 gap-1 px-2 text-xs'
            : wide
              ? 'w-10 gap-0.5'
              : 'w-8'
        }`
      : `h-7 rounded-lg ${wide ? 'w-9 gap-0.5' : 'w-7'}`;
    return `focus-ring flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ${toneClassName} ${geometryClassName} ${CAPSULE_TOUCH_FLOOR_CLASS} ${constrainLabel ? 'max-w-48' : ''}`;
  },
  'message-attachment-tile': ({
    kind,
  }: {
    kind: keyof typeof TILE_PRESENTATION_CLASS;
  }) => `focus-ring ${TILE_PRESS_CLASS} ${TILE_PRESENTATION_CLASS[kind]}`,
  'subagent-ancestor': ({ workflowPhase }: { workflowPhase: boolean }) =>
    workflowPhase
      ? 'shrink-0 hover:fg-primary hover:underline'
      : 'min-w-0 truncate hover:fg-primary hover:underline',
  'archived-overview-row': ({
    actionsReserve,
  }: {
    actionsReserve: 'reveal' | 'inline';
  }) => `focus-ring ${archivedOverviewRowClassName(actionsReserve)}`,
  'capability-trigger': ({ row }: { row: boolean }) =>
    row ? ROW_TRIGGER_CLASS : INTERACTIVE_CLASS,
  'rail-icon': ({
    size,
    tone,
    hoverSurface,
    coarsePointerTarget,
    touchTarget,
    visibility,
    inset,
  }: {
    size: RailIconButtonSize;
    tone: NativeTone;
    hoverSurface: boolean;
    coarsePointerTarget: boolean;
    touchTarget: boolean;
    visibility: keyof typeof RAIL_VISIBILITY_CLASSES;
    inset: keyof typeof RAIL_INSET_CLASSES;
  }) => {
    const floorClassName = `${coarsePointerTarget ? 'pointer-coarse:min-h-11 pointer-coarse:min-w-11' : ''} ${touchTarget ? 'min-h-11' : ''}`;
    return `focus-ring inline-flex shrink-0 items-center justify-center border-0 bg-transparent transition-[color,background-color,opacity] disabled:cursor-not-allowed disabled:opacity-30 ${NATIVE_SIZE_CLASS_NAMES[size]} ${
      hoverSurface
        ? NATIVE_TONE_CLASS_NAMES[tone]
        : QUIET_NATIVE_TONE_CLASS_NAMES[tone]
    } ${floorClassName} ${RAIL_VISIBILITY_CLASSES[visibility]} ${RAIL_INSET_CLASSES[inset]}`;
  },
  'workspace-header-badge': ({ clickable }: { clickable: boolean }) =>
    `focus-ring relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${clickable ? 'cursor-pointer' : 'cursor-default'}`,
  'workspace-header-primary': ({
    primaryButtonIsDragActivator,
    defersPointerHoverActions,
    deferredControlCount,
    touchTarget,
  }: {
    primaryButtonIsDragActivator: boolean;
    defersPointerHoverActions: boolean;
    deferredControlCount: number;
    touchTarget: boolean;
  }) => {
    const deferredActionPadding =
      DEFERRED_ACTION_PADDING[
        Math.min(deferredControlCount, DEFERRED_ACTION_PADDING.length - 1)
      ];
    return `focus-ring flex min-w-0 flex-1 items-center gap-2 text-left ${primaryButtonIsDragActivator ? 'cursor-default ' : ''}disabled:cursor-default${
      defersPointerHoverActions ? ` ${deferredActionPadding}` : ''
    }${touchTarget ? ' min-h-11 self-stretch' : ''}`;
  },
  'workspace-header-repo': ({
    textScale,
  }: {
    textScale: 'default' | 'sidebar';
  }) =>
    `focus-ring rounded-sm border-0 bg-transparent p-0 ${textScale === 'sidebar' ? 'text-s' : 'text-xs'} fg-secondary/60 underline-offset-2 hover:underline focus:underline`,
  'worktree-health-badge': `focus-ring inline-flex h-4 w-4 shrink-0 items-center justify-center rounded fg-warning ${HEALTH_WARNING_COARSE_HIT_AREA}`,
  'worktree-health-warning': `focus-ring -m-0.5 p-0.5 shrink-0 rounded transition-colors fg-warning hover:bg-subtle hover:fg-primary ${HEALTH_WARNING_COARSE_HIT_AREA}`,
  'step-row-toggle': ({
    hasIcon,
    stretched,
    extent,
  }: {
    hasIcon: boolean;
    stretched: boolean;
    extent: 'content' | 'fill' | 'remaining';
  }) =>
    `focus-ring rounded-sm transition-colors hover:fg-primary group ${STEP_ROW_TEXT_CLASS} flex min-w-0 max-w-full items-center gap-2 py-1${hasIcon ? ' min-h-8' : ''} pointer-coarse:min-h-11 text-left${stretched ? ` ${STRETCHED_TOGGLE_CLASS}` : ''} ${{ content: '', fill: 'w-full', remaining: 'flex-1' }[extent]}`,
  'cost-row-open': ({
    density,
    selected,
  }: {
    density: 'card' | 'panel';
    selected: boolean;
  }) => costRowClasses(density, selected, true),
  'ledger-status-trigger': ({ status }: { status: LedgerStatus }) =>
    `focus-ring ${ledgerStatusPillClassName(status)} ${COARSE_HIT_AREA_CLASS} aria-disabled:cursor-not-allowed aria-disabled:opacity-40 disabled:cursor-not-allowed disabled:opacity-40`,
  // A toggle for a panel or menu header (`aria-pressed`): its icon, optionally
  // with its label. Off, no surface (one on hover); on, the accent on the
  // subtle accent surface. Fast mode in the effort panel, Auto in the model
  // picker, the workflow editor's settings and the automations worktree
  // filter. Auto keeps the accent ink while off (`offTone: 'accent'`);
  // `panel-corner` pulls the button 4px up and right, so it sits 8px from the
  // top and right edges of a panel padded 12px. Button's touch area: 44px tall
  // on a coarse pointer, and 44px wide too when icon-only.
  'icon-toggle': ({
    pressed,
    labelled = false,
    offTone = 'secondary',
    activeTone = 'accent',
    placement,
  }: {
    pressed: boolean;
    labelled?: boolean;
    offTone?: 'secondary' | 'accent';
    activeTone?: 'accent' | 'special';
    placement?: 'panel-corner';
  }) =>
    `focus-ring relative ${placement === 'panel-corner' ? '-my-1 -mr-1 ' : ''}flex h-7 ${labelled ? 'gap-1 px-2 text-xs' : 'w-7 justify-center pointer-coarse:before:-inset-x-2'} shrink-0 items-center rounded-md transition-[color,background-color,scale] duration-150 active:scale-97 before:absolute before:inset-0 before:content-[''] pointer-coarse:before:-inset-y-2 disabled:scale-100 disabled:cursor-not-allowed disabled:opacity-40 ${
      pressed
        ? activeTone === 'special'
          ? 'bg-special-subtle fg-special'
          : 'bg-accent-subtle fg-accent-strong'
        : offTone === 'accent'
          ? 'fg-accent enabled:hover:bg-subtle'
          : 'fg-secondary enabled:hover:bg-subtle enabled:hover:fg-primary'
    }`,
} as const;
