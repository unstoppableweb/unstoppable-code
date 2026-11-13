'use client';

import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { ModelPickerTriggerControl } from './ModelPickerTriggerControl';

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type {
  ModelCatalog,
  ModelCatalogOption,
  ModelCatalogProvider,
  ModelLibraryAccess,
} from '@canopy/protocol/models';
import {
  resolveModelCatalogHarnessChoice,
  formatModelContextWindow,
  getModelCatalogProviderLabel,
  getModelVendorLabel,
} from '@canopy/protocol/models';
import { getWindow } from '../panels';
import { measureTextWidth } from '../lib/measure-text-width';
import {
  AllModelsIcon,
  AllModelsFilledIcon,
  ArrowUpRightIcon,
  AutoModelIcon,
  CloseMediumIcon,
  DotIcon,
  Lock,
  MoreHorizontalIcon,
  ExperimentIcon,
  PeopleIdCardIcon,
  CheckIcon as AppCatalogCheckIcon,
  StarIcon as AppCatalogStarIcon,
  type IconSize,
} from '../icons/AppIcons';
import {
  DropdownMenuItem,
  type DropdownMenuSurfaceShell,
} from './DropdownMenu';
import {
  COMPOSER_ROW_MENU_GAP,
  FLOATING_PICKER_GAP,
  FloatingMenu,
} from './FloatingMenu';
import { ModelGroupHeader } from './ModelGroupHeader';
import { NestedMenuFlyout } from './NestedMenuFlyout';
import { OverlayScrollArea } from './OverlayScrollArea';
import {
  PickerMenuList,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuSearchInput,
  PickerMenuSampleOption,
  type PickerMenuOptionTrailingSlots,
  type PickerMenuSampleLabelWidth,
} from './PickerMenu';
import { Button } from './Button';
import { Fact, FactList } from './FactList';
import { RichHoverCard, RichHoverTooltip } from './RichHoverTooltip';
import { SearchField } from './SearchField';
import { Skeleton } from './Skeleton';
import { Stack } from './Stack';
import { AI_CREDITS_LABEL } from './aiCreditsLabel';
import { EmptyState } from './StatusBlocks';
import { IconToggleButton } from './IconToggleButton';
import { Tooltip } from './Tooltip';
import { CompactToggleIndicator } from './ToggleSwitch';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../lib/row-chips';
import { ModelProviderIcon } from '../icons/ModelProviderIcon';

const PICKER_CHROME_SLOT_PX = 36;
const PICKER_CHROME_GAP_PX = 1;
/**
 * Picker glyph boxes, Lucide and provider marks alike, so each area reads at
 * one weight: rail tabs 18px; the Auto toggle and row glyphs (stars, provider
 * marks, row actions) 14px. They opt out of the Lucide 14px / 20px tiers (the
 * DESIGN.md iconography exception).
 */
const PICKER_RAIL_GLYPH_SIZE = 18;
const PICKER_ROW_GLYPH_SIZE = 14;
/**
 * The longest row recovery label the default picker width fits, as the
 * former 15-character credits tag did (`Sign in and buy` still fits).
 */
const DEFAULT_WIDTH_ROW_LABEL_MAX_LENGTH = 15;

/** `py-1` on the harness rail — picker chrome zeroes the menu surface pad-y. */
const PICKER_CHROME_NAV_PAD_PX = 8;
/** The favorites divider's fixed slot, whatever its hairline's width. */
const PICKER_CHROME_DIVIDER_PX = 7;

/**
 * Compact picker shell height: nav padding, every rail slot at 36px with a 1px
 * gap and the favorites divider, so the last tab sits as far from the bottom
 * edge as every tab sits from the left one.
 */
export function pickerChromeMenuHeightPx({
  railTabCount,
}: {
  readonly railTabCount: number;
}): number {
  const dividerSlots = railTabCount > 1 ? 1 : 0;
  const flexChildCount = railTabCount + dividerSlots;
  const gaps = Math.max(0, flexChildCount - 1);
  return (
    PICKER_CHROME_NAV_PAD_PX +
    railTabCount * PICKER_CHROME_SLOT_PX +
    dividerSlots * PICKER_CHROME_DIVIDER_PX +
    gaps * PICKER_CHROME_GAP_PX
  );
}

/**
 * `capsule` is the composer chip both hosts render; `compact` is desktop's
 * dense trigger. The former `toolbar` variant lost its last caller when web
 * moved to the capsule and was removed so a caller that omits `variant` gets
 * the shared geometry and accessible name rather than a dead branch.
 */
export type ModelPickerTriggerVariant = 'capsule' | 'compact';

export interface ModelPickerOptionState {
  readonly disabled: boolean;
  readonly unavailableReason?: string;
  /**
   * A library lock the user can clear (sign in, or purchase AI Credits). The
   * row stays reachable and activating it runs `onUnlock` instead of selecting
   * the model. Ignored when `disabled`: a policy or provider restriction that
   * unlocking cannot fix must keep its own reason.
   */
  readonly locked?: {
    readonly hint: string;
    /**
     * Short remedy shown beside the lock, in place of the credits tag. The
     * host derives it from access; the full `hint` stays the description.
     */
    readonly label?: string;
    readonly onUnlock: () => void;
    /**
     * Keep the row where it was instead of sinking it below usable rows. A
     * lock that describes recovery the row always had (CAN-5213: turning on
     * free daily credits) must not reorder the section it annotates.
     */
    readonly keepsOrder?: boolean;
  };
  /**
   * CAN-5213 — settled evidence says this row runs a new turn now, so a
   * library-locked viewer sees no credits tag; a usable row needs no label.
   * Selection is unchanged. Ignored when `disabled` or `locked`.
   */
  readonly available?: boolean;
}

/** The lock a row shows, or none when another restriction disables it. */
function activeLock(
  state: ModelPickerOptionState,
): ModelPickerOptionState['locked'] {
  return state.disabled ? undefined : state.locked;
}

export type ModelPickerSelectionDisposition = 'close' | 'dismiss';

/** Shared Auto copy so desktop, Remote Control, and cloud read identically. */
export const MODEL_PICKER_AUTO_LABEL = 'Auto';
export const MODEL_PICKER_AUTO_DESCRIPTION = 'Picks the best model for you';
export const MODEL_PICKER_AUTO_DETAIL =
  'Model routing picks the best model for each message.';

/** Canonical disabled reasons (plan Phase 3 §2). */
export const MODEL_PICKER_AUTO_REASONS = {
  creditsLoading: 'Checking AI Credits…',
  noCredits: 'Add AI Credits to use this',
  tooFewCandidates: 'Needs two or more models',
  organizationBlocked: 'Turned off by your organization',
  unsupportedHarness: 'Auto model selection is not available for this harness.',
} as const;

/**
 * First-class Auto row. Auto is a selection MODE, not a catalog entry, so it is
 * never inserted into `catalog` — a fake execution model would leak into every
 * consumer that reads the catalog for dispatch.
 */
export interface ModelPickerAutoOption {
  /** Whether the chat is currently in Auto mode. */
  readonly selected: boolean;
  readonly onSelect: () => void;
  /** Set to render Auto disabled with this reason. */
  readonly unavailableReason?: string;
  /**
   * Makes an unavailable row actionable: clicking it runs this (for example,
   * opening the page where the user can fix the reason) instead of selecting
   * Auto. Only pass it when the reason is something the user can resolve.
   */
  readonly unavailableAction?: () => void;
  /**
   * Compact and quick pickers show only a selectable Auto row; full pickers
   * may show the disabled row and its reason.
   */
  readonly hideWhenUnavailable?: boolean;
}

/**
 * A group after a `data-picker-gap` sibling takes that gap. The rule ends on
 * the group's own class: a sibling rule ending in a bare `div` matches every div
 * in the document and made each transcript insertion recalculate styles for
 * all of them.
 */
const PICKER_GROUP_SPACING_CLASS = '[[data-picker-gap="3"]+&]:mt-3';

/** Group of connect rows for harnesses that are not connected yet. */
const CONNECT_SECTION_LABEL = 'Bring your subscription';

/** Rows the search field enters with ArrowDown and ArrowUp. */
const SEARCH_ENTRY_ROW_SELECTOR =
  '[data-model-id]:not([hidden]):not([aria-disabled="true"]), [data-connect-harness]:not([hidden]):not([aria-disabled="true"])';

/** Label bar widths for the three hosted-model placeholder rows. */
const GATEWAY_PLACEHOLDER_WIDTHS = [
  28, 22, 34,
] as const satisfies readonly PickerMenuSampleLabelWidth[];

/** Ink of the single list's `$` marker for AI Credits-only rows. */
const EXTRA_CHARGE_TEXT_CLASS = 'fg-destructive';

/** Internal id of the Auto row the harness layout renders for `autoOption`. */
const AUTO_ROW_ID = 'auto';

/** Both local and paired pickers use the host's explicit managed-route facts. */
export function managedOpenCodeAutoUnavailableReason(
  current: ModelCatalogOption | undefined,
  candidates: readonly ModelCatalogOption[],
): string | undefined {
  const managed = (option: ModelCatalogOption): boolean =>
    option.harnessChoices?.some(
      (choice) =>
        choice.harness === 'opencode' && choice.funding === 'ai-credits',
    ) === true;
  if (!current || !managed(current))
    return MODEL_PICKER_AUTO_REASONS.unsupportedHarness;
  return candidates.filter(
    (option) =>
      option.kind !== 'agent' &&
      option.available &&
      !!option.description?.trim() &&
      managed(option),
  ).length < 2
    ? MODEL_PICKER_AUTO_REASONS.tooFewCandidates
    : undefined;
}

export interface ModelPickerMenuControls {
  /** Close the menu and hand focus back to the host control. */
  readonly closeMenu: () => void;
  /** Close the menu without restoring focus, for a modal hand-off. */
  readonly dismissMenu: () => void;
}

/** What a pick means beyond the model id. */
export interface ModelPickerSelectionContext {
  /**
   * Harness the row was picked for, including a saved favorite whose route
   * is no longer offered.
   */
  readonly harness?: string;
  /** The user picked this row from a named harness tab. */
  readonly harnessExplicitlyChosen?: boolean;
}

export interface ModelBillingPreference {
  readonly payment: 'subscription' | 'credits';
  readonly fallback: boolean;
}

export interface ModelPickerMenuProps {
  readonly catalog: ModelCatalog;
  readonly currentModel?: string;
  readonly currentModelLabel?: string;
  /** Prefer a host-composed trigger label over the selected catalog row. */
  readonly preferCurrentModelLabel?: boolean;
  readonly providerType?: string;
  /** Explicit trigger glyph override for hosts with a captured execution lane. */
  readonly triggerProvider?: string;
  readonly providerAvailability?: Readonly<
    Partial<Record<ModelCatalogProvider, boolean>>
  >;
  readonly onSelect: (
    modelId: string,
    selection?: ModelPickerSelectionContext,
  ) => ModelPickerSelectionDisposition | void;
  /** With `selection`, the state of picking the row for that harness. */
  readonly getOptionState?: (
    option: ModelCatalogOption,
    selection?: ModelPickerSelectionContext,
  ) => ModelPickerOptionState;
  /**
   * The work owner's model-library access. Ignored: credit-billed rows
   * always tag themselves `AI Credits` (CAN-4769). Kept until hosts stop
   * passing it.
   */
  readonly libraryAccess?: ModelLibraryAccess;
  /** Route-specific billing and details; the menu retains the row's identity. */
  readonly getOptionPresentation?: (
    option: ModelCatalogOption,
    selection?: ModelPickerSelectionContext,
  ) => ModelCatalogOption;
  /**
   * Overrides for vendor group headings the host owns the branding for — the
   * portal's gateway rows, which carry no vendor of their own and belong under
   * the brand's own name rather than a raw `ai-gateway` id. Keeps the brand
   * runtime in the host and out of this display-only package.
   *
   * Keys are whatever `sectionKeyFor` produces: the trimmed, lowercased vendor
   * id, `provider:<account>` for a fallback account section, or
   * `vendor:unclaimed`. A key in the host's own casing silently no-ops.
   */
  readonly vendorLabels?: Readonly<Record<string, string>>;
  /** The host controls Cursor rollout; omitted preserves experimental presentation. */
  readonly cursorExperimental?: boolean;
  /**
   * What this control governs, shown as the trigger's tooltip (CAN-2701).
   * Hosts that configure something other than the current chat — an
   * automation, a hook action, an Agent's base model — must say so. `null`
   * drops the description where the surroundings already make it plain (the
   * chat composer): the tooltip then only appears to name a model whose
   * label is hidden or clipped.
   */
  readonly triggerTooltip?: string | null;
  readonly variant?: ModelPickerTriggerVariant;
  readonly hideLabel?: boolean;
  readonly disabled?: boolean;
  readonly openSignal?: number;
  /** Replaces the inline trigger with a host overflow anchor; open via openSignal. */
  readonly externalTriggerRef?: RefObject<HTMLElement | null>;
  readonly onRestoreFocus?: () => void;
  /** Lets hosts lazily load model metadata when the menu is opened. */
  readonly onOpenChange?: (open: boolean) => void;
  readonly allowWorkspaceDefault?: boolean;
  readonly workspaceDefaultLabel?: string;
  readonly onSelectWorkspaceDefault?: () => void;
  readonly placeholderLabel?: string;
  readonly agentsPosition?: 'first' | 'last';
  /** Host-owned pinned footer. Receives normal and modal close hand-offs. */
  readonly footer?: (controls: ModelPickerMenuControls) => ReactNode;
  /** Owns 4px before a margin-free footer. Omitted keeps legacy markup. */
  readonly footerGap?: 'tight';
  readonly menuId?: string;
  readonly testIdPrefix?: string;
  readonly uniformTestIds?: boolean;
  /** Caps the picker shell while keeping its scrolling inside the menu. */
  readonly menuMaxHeightPx?: number;
  /** Reserves room for host-owned footers below the model list. */
  readonly menuMinHeightPx?: number;
  readonly triggerLabelClassName?: string;
  /** Lets a host opt into flex shrinking without changing toolbar callers. */
  readonly allowTriggerShrink?: boolean;
  /** Tightens capsule padding after the host enters its compact layout. */
  readonly compactTrigger?: boolean;
  /**
   * Capsule only. Folds the trigger's provider icon away (animated) once the
   * model name would show fewer than three characters before its ellipsis,
   * so a tight row spends the icon's width on the name. Mark the host row
   * `data-fit-container` so the icon can return when the row has room.
   */
  readonly foldTriggerIconWhenTight?: boolean;
  /**
   * With `foldTriggerIconWhenTight`, folds the icon as soon as the name
   * starts to truncate instead of once fewer than three characters remain.
   */
  readonly foldTriggerIconOnTruncate?: boolean;
  /**
   * Capsule only. Leaves the trigger's chevron off, so it ends on the name
   * with the 12px trailing inset the row's other chevronless selectors use.
   */
  readonly hideTriggerChevron?: boolean;
  /**
   * Horizontal shift of the menu against its trigger, in pixels (negative is
   * left): the composer's picker lines the menu's model names up with the
   * name on the trigger.
   */
  readonly menuAlignOffset?: number;
  /**
   * Opens the menu over the trigger with its right edge on this element's
   * (the composer box), so a wide menu stays inside the host's panel like
   * the row's effort and usage menus. Takes precedence over
   * `menuAlignOffset`.
   */
  readonly menuAlignRef?: RefObject<HTMLElement | null>;
  /**
   * Which edge of `menuAlignRef` the menu lines up with: `right` (the
   * default) for a trigger on the row's right, `left` for one on its left.
   */
  readonly menuAlignEdge?: 'left' | 'right';
  /** Optional host-owned automatic selection mode. */
  readonly autoModeOption?: ModelCatalogOption;
  /** Per-turn Auto routing row, rendered first when supplied. */
  readonly autoOption?: ModelPickerAutoOption;
  readonly legacyLabelIndent?: boolean;
  readonly highlightSelection?: boolean;
  /** Desktop's model browser: favorites, hosted billing and native providers. */
  readonly harnessTabs?: {
    /** Include an overview of all connected harnesses. */
    readonly allModelsTab?: boolean;
    /** Replace model provider glyphs with leading favorite controls. */
    readonly leadingFavorites?: boolean;
    /** Host-confirmed models that support both native and credit billing. */
    readonly billing?: {
      readonly modelIds: ReadonlySet<string>;
      /** Give host Auto routing the same billing menu. */
      readonly includeAuto?: boolean;
      /** Offer the limits fallback toggle. Defaults to true. */
      readonly fallback?: boolean;
      readonly getPreference: (
        modelId: string,
        harness: string,
      ) => ModelBillingPreference;
      readonly onChange: (
        modelId: string,
        harness: string,
        preference: ModelBillingPreference,
      ) => void;
    };
    readonly brandIcon: ReactNode;
    readonly brandLabel: string;
    readonly favoritesStorageKey?: string;
    /** Account model IDs mapped to their host-confirmed shared identities. */
    readonly favoriteModelAliases?: ReadonlyMap<string, string>;
    /** Remember the harness a model runs on, chosen from All. */
    readonly onModelHarnessChange?: (modelId: string, harness: string) => void;
    /**
     * Favorites for a first-run user, as stored keys (`harness::modelId` in
     * the harnesses layout). Ignored once favorites were saved, even empty.
     */
    readonly defaultFavorites?: readonly string[];
    /**
     * The rail tab to show each time the picker opens, such as the harness a
     * chat is locked to. Without it the picker restores the last clicked tab,
     * persisted alongside favorites under the same storage-key namespace.
     */
    readonly initialTab?: string;
    /**
     * Native models that will run on AI Credits for this chat, such as when
     * their harness is not signed in but credits can pay. Their rows carry the
     * AI credits label like hosted-only models.
     */
    readonly creditsRoutedModelIds?: ReadonlySet<string>;
    /**
     * The host's hosted-model list is still downloading, or failed to. The All
     * tab then ends with placeholder rows or a retry line where those models
     * will appear. Omit it once the list has loaded.
     */
    readonly gatewayCatalog?: {
      readonly status: 'loading' | 'failed';
      readonly onRetry?: () => void;
    };
    /**
     * What to say when no model in the catalog can be picked, such as when an
     * organization turned every model off. It replaces the list, including a
     * chat's own disabled model. Without it the list shows as is.
     */
    readonly emptyCatalog?: {
      readonly title: string;
      readonly subtitle?: string;
      /**
       * A way out for someone who can change what emptied the list, such as
       * an organization admin managing its model policy. The picker closes
       * before it runs.
       */
      readonly action?: {
        readonly label: string;
        readonly onClick: () => void;
        readonly testId?: string;
      };
    };
    /** Models also offered through the host's credits billing route. */
    readonly credits?: {
      readonly modelIds: ReadonlySet<string>;
      /** Route native model picks through AI Credits while that billing mode is active. */
      readonly active?: boolean;
      readonly onSelect: ModelPickerMenuProps['onSelect'];
      readonly getOptionState: NonNullable<
        ModelPickerMenuProps['getOptionState']
      >;
    };
    /**
     * Execution harnesses that can run models. A disconnected harness stays
     * in the rail and opens a prompt to connect it.
     */
    readonly runnableHarnesses?: readonly {
      readonly id:
        | 'claude'
        | 'codex'
        | 'cursor'
        | 'opencode'
        | 'copilot'
        | 'ollama';
      readonly connected: boolean;
      /**
       * What the connect button does: `sign-in` opens the host's sign-in
       * flow, `settings` (the default) sends the user to Settings.
       */
      readonly connectVia?: 'sign-in' | 'settings';
    }[];
    /**
     * Host action for the connect empty-state CTA (Settings, managed
     * Cursor setup, Ollama install, and so on).
     */
    readonly onConnectHarness?: (
      harnessId:
        | 'claude'
        | 'codex'
        | 'cursor'
        | 'opencode'
        | 'copilot'
        | 'ollama',
    ) => void;
    /**
     * One rail tab per execution harness; hosted models are listed on every
     * harness that can run them. The only layout, so it may be omitted.
     */
    readonly gatewayLayout?: 'harnesses';
    /** Host-resolved additional model compatibility for each execution harness. */
    readonly supportedModelIds?: Readonly<Record<string, readonly string[]>>;
    /**
     * A harness's status line, such as its models still loading. Shown under
     * that harness's own section in All, search, and its tab, or atop its tab
     * while it has no section yet.
     */
    readonly harnessStatus?: Readonly<Partial<Record<string, ReactNode>>>;
    /**
     * `picker` matches the compact catalog menus: shared search chrome, a
     * checkmark instead of a filled selection, inverse row details, and a
     * max height that shrinks with the list.
     */
    readonly chrome?: 'picker';
  };
}

type ModelHarnessTab =
  | 'favorites'
  | 'unstoppable'
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'copilot'
  | 'ollama'
  | 'other';

function modelReasoningLabel(option: ModelCatalogOption): string {
  const levels = option.supportedThinkingLevels ?? option.thinkingLevels;
  if (!levels || levels.length === 0) return 'No reasoning';
  return levels.some((level) => level !== 'off')
    ? 'Allows reasoning'
    : 'No reasoning';
}

function runnableHarnessLabel(harness: string): string | undefined {
  switch (harness) {
    case 'claude':
    case 'codex':
    case 'cursor':
    case 'opencode':
    case 'copilot':
    case 'ollama':
      return getModelCatalogProviderLabel(harness);
    default:
      return undefined;
  }
}

function ModelRowDetail({
  option,
  usesAiCredits = false,
  harness,
  showsHarness = false,
  lockHint,
}: {
  /** How to unlock a library-locked row; leads the details. */
  readonly lockHint?: string;
  readonly option: ModelCatalogOption;
  readonly usesAiCredits?: boolean;
  /** Execution harness for this row. */
  readonly harness?: string;
  /** The row shows its harness icon, so the tooltip must name it too. */
  readonly showsHarness?: boolean;
}): JSX.Element {
  const vendor = option.vendor?.trim();
  const familyLabel = option.familyLabel?.trim();
  const provider = vendor
    ? getModelVendorLabel(vendor)
    : familyLabel
      ? familyLabel
      : getModelCatalogProviderLabel(option.provider);
  const context = formatModelContextWindow(option.contextWindow);
  const glyphProvider = vendor && vendor.length > 0 ? vendor : option.provider;
  const rows: { label: string; value: string; glyph?: string }[] = [
    { label: 'Provider', value: provider, glyph: glyphProvider },
  ];
  // A gateway model borrows a harness, and any row that shows a harness icon
  // names it here. A model on its own harness needs no line: its provider
  // already says where it runs.
  const harnessLabel =
    (option.source === 'ai-gateway' || showsHarness) &&
    harness &&
    harness !== option.source
      ? runnableHarnessLabel(harness)
      : undefined;
  if (harness && harnessLabel) {
    rows.push({ label: 'Harness', value: harnessLabel, glyph: harness });
  }
  if (option.funding)
    rows.push({
      label: 'Billing',
      value: option.funding === 'org-gateway' ? 'AI gateway' : 'AI Credits',
    });
  else if (usesAiCredits)
    // CAN-5213: a credits route says so even when the row's tag gives way to
    // an availability cue.
    rows.push({ label: 'Billing', value: 'AI Credits' });
  rows.push({
    label: 'Reasoning',
    value: modelReasoningLabel(option),
  });
  if (context) {
    rows.push({ label: 'Context', value: context });
  }
  return (
    <div className="flex min-w-40 flex-col gap-1.5">
      <div>
        <p className="text-xs font-medium">{option.label}</p>
        {lockHint ? (
          <p className="mt-0.5 w-0 min-w-full text-2xs leading-snug">
            {lockHint}
          </p>
        ) : null}
      </div>
      <div role="separator" className="h-px bg-current/10" />
      <FactList
        layout="spread"
        size="2xs"
        rowGap="0.5"
        labelTone="inherit"
        valueTone="inherit"
      >
        {rows.map((row) => (
          <Fact key={row.label} label={row.label} fit="row">
            {row.glyph ? (
              <span
                aria-hidden="true"
                className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
              >
                <ModelProviderIcon provider={row.glyph} size="xs" />
              </span>
            ) : null}
            {row.value}
          </Fact>
        ))}
      </FactList>
      {!usesAiCredits &&
      option.extraChargeOnly &&
      (option.source === 'claude' ||
        (!option.source && option.provider === 'claude')) ? (
        <>
          <div role="separator" className="h-px bg-current/10" />
          <p className="w-0 min-w-full text-2xs leading-snug opacity-70">
            Depending on your Claude plan, this model may require extra usage
            credits.
          </p>
        </>
      ) : null}
    </div>
  );
}

function modelHarnessTab(
  option: ModelCatalogOption,
): Exclude<ModelHarnessTab, 'favorites'> {
  // Catalog source stays stable even when a native model runs in another harness.
  if (option.source === 'ai-gateway') return 'unstoppable';
  if (option.source) return option.source;
  // Unrecognized and local providers must never imply hosted credits billing.
  return option.provider === 'unknown' ? 'other' : option.provider;
}

/** Small, forgiving fuzzy score: contiguous matches win, then subsequences. */
function fuzzyModelScore(option: ModelCatalogOption, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 0;
  const haystack =
    `${option.label} ${option.id} ${option.vendor ?? ''}`.toLowerCase();
  const contiguous = haystack.indexOf(query);
  if (contiguous >= 0) return contiguous;
  let cursor = 0;
  let gapScore = 0;
  for (const character of query) {
    const match = haystack.indexOf(character, cursor);
    if (match < 0) return Number.POSITIVE_INFINITY;
    gapScore += match - cursor;
    cursor = match + 1;
  }
  return 100 + gapScore;
}

interface CatalogSection {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly options: readonly ModelCatalogOption[];
  readonly sortOrder: number;
}

/** A harness that runs models and has its own icon, if `value` names one. */
function harnessIconId(value: string | undefined): string | undefined {
  return value === 'claude' ||
    value === 'codex' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode'
    ? value
    : undefined;
}

/** The harness every row of a section runs on, when they share one. */
function sharedSectionHarness(section: CatalogSection): string | undefined {
  const harnesses = new Set(
    section.options.map((option) => option.source ?? option.provider),
  );
  return harnesses.size === 1 ? Array.from(harnesses)[0] : undefined;
}

/**
 * Section key for one catalog row.
 *
 * A declared vendor keys on itself. A row that declares NO vendor cannot be
 * keyed on `provider`: that is the execution harness, not the maker, so a
 * DeepSeek model routed over the Claude harness would file under "Anthropic".
 *
 * Every unclaimed row therefore shares ONE key. Keying them per-harness instead
 * produced two adjacent sections both headed "Other models" — indistinguishable
 * to the reader, and the same "one thing, two headings" defect this ticket
 * removes, just with a different label.
 *
 * Ollama is the exception: there the harness IS the vendor, so it keeps its own
 * section and its own name. Cursor's default and its own Composer models
 * share a Cursor section; third-party models keep their maker's section.
 */
const UNCLAIMED_VENDOR_KEY = 'vendor:unclaimed';

/**
 * The row's vendor, normalized exactly as `getModelVendorLabel` normalizes for
 * display. Every one of the three section resolvers below reads THIS, so a
 * host's casing cannot make them disagree: keying on the raw string would let
 * `OpenAI` and `openai` render two sections under one heading, and reading it
 * raw in the icon resolver would fold `Anthropic` into the `anthropic` section
 * while rendering the generic letter badge instead of the Claude mark.
 */
function normalizedVendor(option: ModelCatalogOption): string | undefined {
  const vendor = option.vendor?.trim().toLowerCase();
  return vendor ? vendor : undefined;
}

/** Selected-row identity colors; monochrome marks follow the active theme. */
export function selectedModelIconColor(option: ModelCatalogOption): string {
  const vendor = normalizedVendor(option) ?? option.provider;
  switch (vendor) {
    case 'anthropic':
    case 'claude':
      return '#D97757';
    case 'deepseek':
      return '#5786FE';
    case 'moonshot':
    case 'kimi':
      return '#007CFF';
    case 'minimax':
      return '#FF6452';
    default:
      return 'var(--fg-primary)';
  }
}

function normalizedFamily(option: ModelCatalogOption): string | undefined {
  const family = option.family?.trim().toLowerCase();
  return family ? family : undefined;
}

function sectionProvider(
  option: ModelCatalogOption,
): ModelCatalogProvider | undefined {
  const vendor = normalizedVendor(option);
  if (vendor === 'cursor') return 'cursor';
  if (vendor) return undefined;
  // Older desktops omit maker metadata. Keep their account sections until
  // they supply a maker, without guessing one from a model label.
  if (option.id === 'cursor-default') return 'cursor';
  if (
    option.provider === 'cursor' ||
    option.provider === 'copilot' ||
    option.provider === 'opencode' ||
    option.provider === 'ollama'
  )
    return option.provider;
  return undefined;
}

function sectionKeyFor(option: ModelCatalogOption): string {
  const provider = sectionProvider(option);
  if (provider) return `provider:${provider}`;
  const vendor = normalizedVendor(option);
  if (vendor) return vendor;
  return UNCLAIMED_VENDOR_KEY;
}

/**
 * Glyph for one catalog section. Mirrors {@link sectionKeyFor} exactly, so an
 * unclaimed row gets the neutral mark rather than its harness's brand logo —
 * otherwise the Anthropic logo would sit above a section headed "Other models",
 * making in the icon the very guess the heading refuses to make.
 */
function sectionIconProvider(option: ModelCatalogOption): string {
  const provider = sectionProvider(option);
  if (provider) return provider;
  const vendor = normalizedVendor(option);
  if (vendor) return vendor;
  return 'other';
}

/** The capsule trigger's icon plus its inset: 16px glyph and 6px gap. */
const TRIGGER_ICON_SLOT_PX = 22;

/** Room left in a flex row after its items and gaps (never negative). */
function fitContainerSpareWidth(container: HTMLElement): number {
  const items = Array.from(container.children);
  const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
  const used =
    items.reduce(
      (total, item) => total + item.getBoundingClientRect().width,
      0,
    ) +
    gap * Math.max(0, items.length - 1);
  return Math.max(0, container.clientWidth - used);
}

/** Heading for one catalog section; see {@link sectionKeyFor}. */
function sectionHeadingLabel(option: ModelCatalogOption): string {
  const provider = sectionProvider(option);
  if (provider) return getModelCatalogProviderLabel(provider);
  const vendor = normalizedVendor(option);
  if (vendor) return getModelVendorLabel(vendor);
  return 'Other models';
}

function coerceProvider(
  provider: string | undefined,
): ModelCatalogProvider | undefined {
  if (
    provider === 'claude' ||
    provider === 'codex' ||
    provider === 'ollama' ||
    provider === 'cursor' ||
    provider === 'copilot' ||
    provider === 'opencode'
  ) {
    return provider;
  }
  return undefined;
}

export function ModelPickerMenu({
  catalog,
  currentModel,
  currentModelLabel,
  preferCurrentModelLabel = false,
  providerType,
  triggerProvider,
  providerAvailability,
  onSelect,
  getOptionState,
  getOptionPresentation,
  vendorLabels,
  cursorExperimental = true,
  triggerTooltip = 'Model for this chat',
  variant = 'capsule',
  hideLabel = false,
  disabled = false,
  openSignal,
  externalTriggerRef,
  onRestoreFocus,
  onOpenChange,
  allowWorkspaceDefault = false,
  workspaceDefaultLabel = 'Project default',
  onSelectWorkspaceDefault,
  placeholderLabel,
  agentsPosition = 'first',
  footer,
  footerGap,
  menuId,
  testIdPrefix = 'model',
  uniformTestIds = false,
  menuMaxHeightPx,
  menuMinHeightPx,
  autoModeOption: autoModeOptionProp,
  autoOption,
  legacyLabelIndent = false,
  highlightSelection = false,
  triggerLabelClassName,
  allowTriggerShrink = false,
  compactTrigger = false,
  harnessTabs,
  foldTriggerIconWhenTight = false,
  foldTriggerIconOnTruncate = false,
  hideTriggerChevron = false,
  menuAlignOffset,
  menuAlignRef,
  menuAlignEdge = 'right',
}: ModelPickerMenuProps): JSX.Element {
  const generatedMenuId = useId();
  const resolvedMenuId = menuId ?? generatedMenuId;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  /*
   * Exactly one row may show its detail at a time. Rows open on both hover and
   * focus, and a menu keeps focus on the selected row while the pointer moves
   * elsewhere — with per-row state that renders two detail popovers at once.
   *
   * Hover and focus are tracked SEPARATELY, with hover taking precedence and
   * focus acting as the floor. A single id could not express that: releasing
   * hover cleared it outright, so after open (first row focused) → hover
   * another row → leave the menu, the still-focused row was left with no
   * detail and no event that would bring it back.
   */
  const [hoveredOptionId, setHoveredOptionId] = useState<string | null>(null);
  const [focusedOptionId, setFocusedOptionId] = useState<string | null>(null);
  const [selectedHarnessTab, setActiveHarnessTab] = useState(
    harnessTabs?.initialTab ?? (harnessTabs?.allModelsTab ? 'all' : 'claude'),
  );
  const initialHarnessTab = harnessTabs?.initialTab;
  const harnessTabStorageKey = harnessTabs
    ? `${harnessTabs.favoritesStorageKey ?? 'canopy:model-picker-favorites'}:last-tab`
    : undefined;
  // The tab the current model was picked on, so the picker reopens there.
  const selectionTabStorageKey = harnessTabs
    ? `${harnessTabs.favoritesStorageKey ?? 'canopy:model-picker-favorites'}:selection-tab`
    : undefined;
  const rememberSelectionTab = (modelId: string, tab: string): void => {
    if (!selectionTabStorageKey) return;
    try {
      window.localStorage.setItem(
        selectionTabStorageKey,
        JSON.stringify({ modelId, tab }),
      );
    } catch {
      // The picker falls back to the last tab when storage is blocked.
    }
  };
  // Before paint, so a locked chat never flashes the previous tab on open.
  useLayoutEffect(() => {
    if (!open) return;
    if (initialHarnessTab) {
      setActiveHarnessTab(initialHarnessTab);
      return;
    }
    if (!harnessTabStorageKey) return;
    try {
      const selection: unknown = JSON.parse(
        (selectionTabStorageKey &&
          window.localStorage.getItem(selectionTabStorageKey)) ||
          'null',
      );
      if (
        typeof selection === 'object' &&
        selection !== null &&
        'modelId' in selection &&
        'tab' in selection &&
        selection.modelId === currentModel &&
        typeof selection.tab === 'string'
      ) {
        setActiveHarnessTab(selection.tab);
        return;
      }
      const savedTab = window.localStorage.getItem(harnessTabStorageKey);
      if (savedTab) setActiveHarnessTab(savedTab);
    } catch {
      // Keep the in-memory selection when browser storage is unavailable.
    }
  }, [
    open,
    initialHarnessTab,
    harnessTabStorageKey,
    selectionTabStorageKey,
    currentModel,
  ]);
  const autoSelected = autoOption?.selected === true;
  /*
   * An unavailable Auto row is hidden outright in compact/quick pickers and
   * shown with its reason in full ones. A chat already IN Auto keeps its row
   * visible either way, so the durable-loss transition has somewhere to read.
   */
  const autoRowVisible =
    autoOption !== undefined &&
    (autoOption.unavailableReason === undefined ||
      autoSelected ||
      autoOption.hideWhenUnavailable !== true);
  const autoUnavailable =
    autoOption?.unavailableReason !== undefined && !autoSelected;
  const autoActionable =
    autoUnavailable && autoOption?.unavailableAction !== undefined;
  const hasHarnessTabs = harnessTabs !== undefined;
  // The harness layout draws host Auto routing through its own Auto row.
  const autoModeOption = useMemo<ModelCatalogOption | undefined>(
    () =>
      autoModeOptionProp ??
      (autoOption && autoRowVisible && hasHarnessTabs
        ? {
            id: AUTO_ROW_ID,
            label: MODEL_PICKER_AUTO_LABEL,
            provider: 'claude',
            kind: 'model',
            available: true,
          }
        : undefined),
    [autoModeOptionProp, autoOption, autoRowVisible, hasHarnessTabs],
  );
  const [allHarnessChoices, setAllHarnessChoices] = useState<
    Record<string, string>
  >({});
  const [modelSearch, setModelSearch] = useState('');
  const [billingMenuKey, setBillingMenuKey] = useState<string | null>(null);
  const [suppressRowHover, setSuppressRowHover] = useState(false);
  /** The list offset at the pointer's last real move. */
  const pointerScrollTopRef = useRef<number | null>(null);
  const [favoriteModelIds, setFavoriteModelIds] = useState<readonly string[]>(
    [],
  );
  const detailOptionId = hoveredOptionId ?? focusedOptionId;
  // The focused slot is claimed only by keyboard navigation. Hover may
  // temporarily own the card, then release it back to that highlight.
  const detailInput = hoveredOptionId === null ? 'keyboard' : 'hover';

  const [triggerLabelClipped, setTriggerLabelClipped] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** The harness browser opens 8px left of its trigger. */
  const pickerChromeAnchorRef = useRef<HTMLSpanElement>(null);
  const triggerLabelRef = useRef<HTMLSpanElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const clearModelSearch = (): void => {
    setModelSearch('');
    searchRef.current?.focus();
  };
  // The tooltip wrapper can remount the trigger (it swaps shape as the label
  // starts or stops clipping), so the watcher below follows the live label
  // element instead of the one that existed when it first attached.
  const [triggerLabelElement, setTriggerLabelElement] =
    useState<HTMLSpanElement | null>(null);
  const attachTriggerLabel = useCallback(
    (node: HTMLSpanElement | null): void => {
      triggerLabelRef.current = node;
      setTriggerLabelElement(node);
    },
    [],
  );
  const foldIconWhenTight =
    foldTriggerIconWhenTight && variant === 'capsule' && !hideLabel;
  const chevronless = hideTriggerChevron && variant === 'capsule';
  const [triggerIconFolded, setTriggerIconFolded] = useState(false);
  const restoreScheduledRef = useRef(false);
  const lastOpenSignalRef = useRef(openSignal);

  useEffect((): void => {
    if (openSignal === undefined || openSignal === lastOpenSignalRef.current) {
      return;
    }
    lastOpenSignalRef.current = openSignal;
    if (!disabled) setOpen(true);
  }, [disabled, openSignal]);

  useEffect((): void => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect((): void => {
    if (open) return;
    setHoveredOptionId(null);
    setFocusedOptionId(null);
    setModelSearch('');
  }, [open]);

  // Keyed on the values it reads, not the host's inline harnessTabs object,
  // so a host render does not re-read storage and reset session favorites.
  const favoritesStorageKey = harnessTabs?.favoritesStorageKey;
  const defaultFavorites = harnessTabs?.defaultFavorites;
  useEffect((): void => {
    if (!hasHarnessTabs) return;
    const storageKey = favoritesStorageKey ?? 'canopy:model-picker-favorites';
    try {
      const stored = getWindow(triggerRef.current).localStorage.getItem(
        storageKey,
      );
      if (stored === null) {
        if (defaultFavorites) setFavoriteModelIds(defaultFavorites);
        return;
      }
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setFavoriteModelIds(
          parsed
            .filter((value): value is string => typeof value === 'string')
            .map((value) => {
              if (value.includes('::')) return value;
              const model = catalog.find((option) => option.id === value);
              return `${model?.harness ?? (model?.provider === 'codex' ? 'codex' : 'claude')}::${value}`;
            }),
        );
      }
    } catch {
      // Storage may be unavailable in an embedded or privacy-restricted host.
    }
  }, [catalog, defaultFavorites, favoritesStorageKey, hasHarnessTabs]);

  /*
   * Whether the last input came from the keyboard. A "More" flyout opened by
   * the pointer auto-focuses its first row, and that programmatic focus must
   * not pop the row's detail as if the "More" trigger itself had a tooltip;
   * focus that keyboard navigation moves still does.
   */
  const keyboardIntentRef = useRef(false);

  const setOptionDetail = useCallback(
    (optionId: string, source: 'hover' | 'focus', next: boolean): void => {
      const apply = (previous: string | null): string | null => {
        if (next) return optionId;
        // Only the row that owns the slot may release it: a stale `mouseleave`
        // from a row the pointer already left must not clear the current one.
        return previous === optionId ? null : previous;
      };
      if (source === 'hover') {
        setHoveredOptionId(apply);
        return;
      }
      // Menu opening and pointer-driven flyouts move focus themselves. Only
      // keyboard navigation should claim the detail slot through focus.
      if (next && !keyboardIntentRef.current) return;
      setFocusedOptionId(apply);
      /*
       * A row RECEIVING focus releases the pointer's claim, so the keyboard is
       * never out-ranked by a mouse resting elsewhere.
       *
       * Keyed on focus actually moving rather than on a list of keys that move
       * it: `FloatingMenu` also moves focus by typeahead (any printable
       * character), and an earlier attempt to enumerate its keys missed that —
       * twice. A modifier press moves no focus, so it fires nothing here and
       * the resting row keeps its detail.
       */
      if (next) setHoveredOptionId(null);
    },
    [],
  );

  const closeMenu = useCallback((): void => {
    setOpen(false);
    if (restoreScheduledRef.current) return;
    restoreScheduledRef.current = true;
    queueMicrotask((): void => {
      restoreScheduledRef.current = false;
      if (onRestoreFocus) {
        onRestoreFocus();
        return;
      }
      const trigger = externalTriggerRef?.current ?? triggerRef.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }, [externalTriggerRef, onRestoreFocus]);

  const dismissMenu = useCallback((): void => {
    setOpen(false);
  }, []);

  const catalogFamilyLabels = useMemo<ReadonlyMap<string, string>>(() => {
    const labels = new Map<string, string>();
    for (const option of catalog) {
      const vendor = normalizedVendor(option);
      const family = normalizedFamily(option);
      const label = option.familyLabel?.trim();
      if (!vendor || family !== vendor || !label || labels.has(family)) {
        continue;
      }
      labels.set(family, label);
    }
    return labels;
  }, [catalog]);

  /*
   * CAN-2701: sections are keyed on the VENDOR, not the model family.
   *
   * Family keying (`anthropic:opus`, `anthropic:sonnet`, …) gave every Claude
   * model a heading of its own, so the menu read as an alternating stack of
   * headings and single rows with no level to anchor on — and each heading only
   * restated the row beneath it ("Opus" over "Opus 5"). Vendor keying collapses
   * those into the two or three headings a user actually navigates by.
   */
  const sections = useMemo<readonly CatalogSection[]>(() => {
    const vendorSections = new Map<string, CatalogSection>();
    for (const option of catalog) {
      if (option.kind !== 'model') continue;
      /*
       * A row's `provider` is its execution HARNESS, not its vendor — a
       * DeepSeek model routed over the Claude harness carries
       * `provider: 'claude'`. Defaulting the vendor to it would file that row
       * under "Anthropic" and, worse, split one real vendor across two
       * identically-titled headings. See `sectionKeyFor` for how a row that
       * claims no vendor is grouped instead.
       */
      const key = sectionKeyFor(option);
      const existing = vendorSections.get(key);
      const sortOrder = option.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (existing) {
        vendorSections.set(key, {
          ...existing,
          options: [...existing.options, option],
          sortOrder: Math.min(existing.sortOrder, sortOrder),
        });
      } else {
        vendorSections.set(key, {
          key,
          // Own-property check, for the same reason `getModelVendorLabel` uses
          // one: this is a host-supplied object literal keyed by a
          // catalog-derived vendor id, so a row declaring `vendor:
          // 'constructor'` would make the label a function and throw in the
          // section sort's `localeCompare`.
          label:
            (vendorLabels &&
            Object.prototype.hasOwnProperty.call(vendorLabels, key)
              ? vendorLabels[key]
              : undefined) ??
            catalogFamilyLabels.get(key) ??
            sectionHeadingLabel(option),
          icon: (
            <ModelProviderIcon
              provider={sectionIconProvider(option)}
              width={10}
              height={10}
            />
          ),
          options: [option],
          sortOrder,
        });
      }
    }
    // Order rows by the host's declared catalog order INSIDE a section too.
    // Merging families into one vendor section interleaves registries that were
    // previously appended whole (native rows, then gateway-only rows), and
    // `sortOrder` is the host's stated intent for that combined order.
    // Library-locked rows sink below the usable ones in their section. With no
    // lock anywhere the comparator contributes nothing and order is unchanged.
    const lockRank = (option: ModelCatalogOption): number => {
      const lock = getOptionState
        ? activeLock(getOptionState(option))
        : undefined;
      return lock && lock.keepsOrder !== true ? 1 : 0;
    };
    const models = [...vendorSections.values()]
      .map((section) => ({
        ...section,
        options: [...section.options].sort(
          (first, second) =>
            lockRank(first) - lockRank(second) ||
            (first.sortOrder ?? Number.MAX_SAFE_INTEGER) -
              (second.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
            first.label.localeCompare(second.label),
        ),
      }))
      .sort(
        (first, second) =>
          first.sortOrder - second.sortOrder ||
          first.label.localeCompare(second.label),
      );
    const agents: CatalogSection = {
      key: 'agents',
      label: 'Agents',
      icon: <PeopleIdCardIcon size="sm" />,
      options: catalog.filter((option) => option.kind === 'agent'),
      sortOrder: -1,
    };
    if (agents.options.length === 0) return models;
    return agentsPosition === 'first'
      ? [agents, ...models]
      : [...models, agents];
  }, [
    agentsPosition,
    catalog,
    catalogFamilyLabels,
    getOptionState,
    vendorLabels,
  ]);

  const rows = useMemo<readonly ModelCatalogOption[]>(
    () => sections.flatMap((section) => section.options),
    [sections],
  );
  const extraHarnessTabs = useMemo(
    () =>
      (['cursor', 'copilot', 'opencode', 'ollama', 'other'] as const).filter(
        (harness) =>
          rows.some((option) => modelHarnessTab(option) === harness) ||
          Boolean(harnessTabs?.supportedModelIds?.[harness]?.length),
      ),
    [harnessTabs?.supportedModelIds, rows],
  );
  const railTabIds = new Set<string>([
    'favorites',
    ...(harnessTabs?.allModelsTab ? ['all'] : []),
    'claude',
    'codex',
    ...extraHarnessTabs,
    ...(harnessTabs?.runnableHarnesses ?? []).map((harness) => harness.id),
  ]);
  const activeHarnessTab = railTabIds.has(selectedHarnessTab)
    ? selectedHarnessTab
    : 'favorites';
  useEffect(() => {
    setBillingMenuKey(null);
  }, [activeHarnessTab, modelSearch, open]);
  const activeRunnableHarness = harnessTabs?.runnableHarnesses?.find(
    (harness) => harness.id === activeHarnessTab,
  );
  const showConnectPrompt = activeRunnableHarness?.connected === false;
  // Harnesses that are not connected, in rail order, reachable from the end
  // of All and from search when the host can connect them.
  const connectableHarnesses = harnessTabs?.onConnectHarness
    ? (harnessTabs.runnableHarnesses ?? []).filter(
        (harness) => !harness.connected,
      )
    : [];
  const connectQuery = modelSearch.trim().toLowerCase();
  const searchConnectableHarnesses = connectQuery
    ? connectableHarnesses.filter(
        (harness) =>
          harness.id.includes(connectQuery) ||
          getModelCatalogProviderLabel(harness.id)
            .toLowerCase()
            .includes(connectQuery),
      )
    : [];
  // The harness list opens on the Auto row in the All tab, a leading
  // Favorites tab, and a provider tab of a picker with no All tab.
  const harnessLeadsWithAuto =
    !modelSearch &&
    autoModeOption !== undefined &&
    (activeHarnessTab === 'all' ||
      (harnessTabs?.leadingFavorites === true &&
        activeHarnessTab === 'favorites') ||
      (harnessTabs?.allModelsTab !== true && activeHarnessTab !== 'favorites'));
  const connectHarnessLabel = activeRunnableHarness
    ? getModelCatalogProviderLabel(activeRunnableHarness.id)
    : '';
  const optionBelongsToHarness = useCallback(
    (option: ModelCatalogOption, harness: string): boolean =>
      (option.source ?? option.provider) === harness ||
      // Rows from an unknown provider live on the Other tab.
      modelHarnessTab(option) === harness ||
      harnessTabs?.supportedModelIds?.[
        harness === 'unknown' ? 'other' : harness
      ]?.includes(option.id) === true,
    [harnessTabs?.supportedModelIds],
  );
  const harnessPanelIds: readonly string[] = harnessTabs?.runnableHarnesses
    ? [
        ...harnessTabs.runnableHarnesses.map((harness) => harness.id),
        // Harnesses the host does not run itself (Ollama, unknown) still get
        // a panel, so their rail tab is never blank.
        ...extraHarnessTabs.filter(
          (id) =>
            !harnessTabs.runnableHarnesses?.some(
              (harness) => harness.id === id,
            ),
        ),
      ]
    : ['claude', 'codex', ...extraHarnessTabs];
  const sectionsForHarness = (harness: string): CatalogSection[] => {
    const filtered = sections
      .map((section) => ({
        ...section,
        options: section.options.filter((option) =>
          optionBelongsToHarness(option, harness),
        ),
      }))
      .filter((section) => section.options.length > 0);
    if (harnessTabs?.leadingFavorites) {
      // Group like All (by vendor), with the tab's own vendors leading.
      const ownsNative = (section: CatalogSection): boolean =>
        section.options.some(
          (option) => (option.source ?? option.provider) === harness,
        );
      return [
        ...filtered.filter(ownsNative),
        ...filtered.filter((section) => !ownsNative(section)),
      ].map((section) =>
        section.key === 'openai' ? { ...section, label: 'OpenAI' } : section,
      );
    }
    const native = filtered
      .map((section) => ({
        ...section,
        options: section.options.filter(
          (option) => (option.source ?? option.provider) === harness,
        ),
      }))
      .filter((section) => section.options.length > 0);
    const other = filtered
      .flatMap((section) => section.options)
      .filter((option) => (option.source ?? option.provider) !== harness);
    return other.length
      ? [
          ...native,
          {
            key: 'supported-models',
            label: 'Other supported models',
            icon: null,
            options: other,
            sortOrder: 999,
          },
        ]
      : native;
  };
  const selectableRows = useMemo(
    () => (autoModeOption ? [autoModeOption, ...rows] : rows),
    [autoModeOption, rows],
  );
  const favoriteModelAliases = harnessTabs?.favoriteModelAliases;
  const resolveFavoriteKey = useCallback(
    (key: string): string => {
      const split = key.indexOf('::');
      if (split < 0) return key;
      const harness = key.slice(0, split);
      const modelId = key.slice(split + 2);
      const canonical = favoriteModelAliases?.get(modelId);
      if (canonical && selectableRows.some((row) => row.id === canonical)) {
        return `${harness}::${canonical}`;
      }
      if (selectableRows.some((row) => row.id === modelId)) return key;
      // A catalog refresh can remove the shared row without removing this
      // account's offering. Recover only one exact route on the saved account;
      // another account or an ambiguous identity must never become a fallback.
      const routes = selectableRows.filter(
        (row) =>
          favoriteModelAliases?.get(row.id) === modelId &&
          (row.source ?? row.provider) === harness,
      );
      return routes.length === 1 ? `${harness}::${routes[0].id}` : key;
    },
    [favoriteModelAliases, selectableRows],
  );
  // Keep the first saved position and the account, even when old and new IDs
  // were both starred. Reading the catalog never rewrites stored preferences.
  const resolvedFavoriteModelIds = useMemo(
    () => [...new Set(favoriteModelIds.map(resolveFavoriteKey))],
    [favoriteModelIds, resolveFavoriteKey],
  );
  /*
   * Each favorite row remembers its resolved key, so the star in Favorites
   * removes it and its old aliases. Rebuilding it from the row would lose a
   * harness the option cannot carry (an Ollama or Other tab favorite).
   */
  const { favoriteModels, favoriteKeyByRow } = useMemo(() => {
    const keys = new WeakMap<ModelCatalogOption, string>();
    const models = resolvedFavoriteModelIds.flatMap<ModelCatalogOption>(
      (key) => {
        const split = key.indexOf('::');
        const harness = split >= 0 ? key.slice(0, split) : undefined;
        const modelId = harness ? key.slice(split + 2) : key;
        const option = selectableRows.find(
          (candidate) => candidate.id === modelId,
        );
        if (!option) return [];
        const row: ModelCatalogOption =
          harness === 'claude' ||
          harness === 'codex' ||
          harness === 'cursor' ||
          harness === 'copilot' ||
          harness === 'opencode'
            ? { ...option, harness }
            : { ...option };
        keys.set(row, key);
        return [row];
      },
    );
    return { favoriteModels: models, favoriteKeyByRow: keys };
  }, [resolvedFavoriteModelIds, selectableRows]);
  const searchedModels = useMemo(
    () =>
      selectableRows
        .filter((option) => option.id !== autoModeOption?.id)
        .map((option) => ({
          option,
          score: fuzzyModelScore(option, modelSearch),
        }))
        .filter(({ score }) => Number.isFinite(score))
        .sort(
          (left, right) =>
            left.score - right.score ||
            left.option.label.localeCompare(right.option.label),
        )
        .map(({ option }) => option),
    [modelSearch, selectableRows, autoModeOption?.id],
  );
  const searchHarnessGroups = [
    ...(
      harnessTabs?.runnableHarnesses ?? [
        { id: 'claude', connected: true },
        { id: 'codex', connected: true },
      ]
    ).filter((harness) => harness.connected),
    // Extra tabs have nothing to connect, so they are always searchable.
    ...extraHarnessTabs
      .filter(
        (id) =>
          !harnessTabs?.runnableHarnesses?.some((harness) => harness.id === id),
      )
      // The rail's `other` tab holds `unknown`-provider rows.
      .map((id) => ({
        id: id === 'other' ? ('unknown' as const) : id,
        connected: true,
      })),
  ]
    .map((harness) => ({
      ...harness,
      models: searchedModels
        .filter((option) => optionBelongsToHarness(option, harness.id))
        .sort((left, right) =>
          modelSearch
            ? 0
            : Number((right.source ?? right.provider) === harness.id) -
              Number((left.source ?? left.provider) === harness.id),
        ),
    }))
    .filter((harness) => harness.models.length > 0);
  // On open, bring the selected row (or the Legacy models entry holding it)
  // into view on the tab the picker opened to.
  const harnessListRef = useRef<HTMLDivElement | null>(null);
  const scrollToSelectionRef = useRef(false);
  useLayoutEffect(() => {
    if (open) scrollToSelectionRef.current = true;
  }, [open]);
  // A pointer offset only describes the list it was recorded over.
  useLayoutEffect(() => {
    pointerScrollTopRef.current = null;
  }, [open, activeHarnessTab, modelSearch]);
  useEffect(() => {
    const list = harnessListRef.current;
    if (!open || !list || !scrollToSelectionRef.current) return undefined;
    const view = list.ownerDocument.defaultView ?? window;
    // After the tab chosen on open has rendered.
    const frame = view.requestAnimationFrame(() => {
      scrollToSelectionRef.current = false;
      const row = Array.from(
        list.querySelectorAll<HTMLElement>(
          '[data-model-id][aria-checked="true"], [data-contains-selection="true"]',
        ),
      ).find((node) => node.closest('[hidden]') === null);
      if (!row) return;
      const listRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom)
        return;
      list.scrollTop +=
        rowRect.top - listRect.top - (list.clientHeight - rowRect.height) / 2;
    });
    return (): void => view.cancelAnimationFrame(frame);
  }, [open, activeHarnessTab]);
  const harnessStatusFor = (harness: string | undefined): ReactNode =>
    harness === undefined
      ? null
      : (harnessTabs?.harnessStatus?.[harness] ?? null);
  const sectionStatusFor = (section: CatalogSection): ReactNode => {
    const harness = sharedSectionHarness(section);
    return sections.find(
      (candidate) => sharedSectionHarness(candidate) === harness,
    ) === section
      ? harnessStatusFor(harness)
      : null;
  };
  const selectedOption = useMemo(
    () =>
      selectableRows.find((option) => option.id === currentModel) ??
      (!allowWorkspaceDefault && currentModel === undefined
        ? selectableRows.find((option) => option.isDefault === true)
        : undefined),
    [allowWorkspaceDefault, currentModel, selectableRows],
  );
  /**
   * Whether a group's Legacy models flyout holds the selected model. While
   * Auto is on, Auto is the selection even though the chat keeps its model.
   */
  const legacyHoldsSelection = (
    options: readonly ModelCatalogOption[],
  ): boolean =>
    !autoSelected &&
    options.some(
      (option) =>
        option.showMoreOnly === true && option.id === selectedOption?.id,
    );
  const hintProvider = coerceProvider(providerType);
  const explicitTriggerProvider = coerceProvider(triggerProvider);
  const resolvedTriggerProvider =
    explicitTriggerProvider ?? selectedOption?.provider ?? hintProvider;
  /*
   * Auto owns the trigger while selected and names only the mode. The model
   * Auto picked for each turn is shown on that turn, not in the chip.
   */
  const triggerLabel = autoSelected
    ? MODEL_PICKER_AUTO_LABEL
    : ((preferCurrentModelLabel ? currentModelLabel : selectedOption?.label) ??
      (preferCurrentModelLabel ? selectedOption?.label : currentModelLabel) ??
      placeholderLabel ??
      (allowWorkspaceDefault
        ? workspaceDefaultLabel
        : hintProvider
          ? getModelCatalogProviderLabel(hintProvider)
          : 'Model'));

  const resolveOptionState = useCallback(
    (
      option: ModelCatalogOption,
      selection?: ModelPickerSelectionContext,
      credits = false,
    ): ModelPickerOptionState => {
      if (option.id === AUTO_ROW_ID) {
        return autoUnavailable && !autoActionable
          ? { disabled: true, unavailableReason: autoOption?.unavailableReason }
          : { disabled: false };
      }
      const harness = selection?.harness;
      if (
        (harness === 'cursor' ||
          harness === 'copilot' ||
          harness === 'opencode') &&
        !optionBelongsToHarness(option, harness)
      ) {
        return {
          disabled: true,
          unavailableReason: `This model is unavailable through ${getModelCatalogProviderLabel(harness)}. Choose another account or model.`,
        };
      }
      const routeState = credits
        ? (harnessTabs?.credits?.getOptionState ?? getOptionState)
        : getOptionState;
      if (routeState) return routeState(option, selection);
      const providerDisabled =
        providerAvailability?.[option.provider] === false;
      const agentDisabled = option.kind === 'agent' && !option.available;
      if (agentDisabled) {
        return {
          disabled: true,
          unavailableReason:
            'This agent is unavailable — its base model is not registered on the desktop app.',
        };
      }
      if (providerDisabled) {
        return {
          disabled: true,
          unavailableReason: `${getModelCatalogProviderLabel(option.provider)} is not signed in on the desktop app.`,
        };
      }
      return { disabled: false };
    },
    [
      autoActionable,
      autoOption,
      autoUnavailable,
      getOptionState,
      harnessTabs?.credits,
      optionBelongsToHarness,
      providerAvailability,
    ],
  );

  const selectOption = useCallback(
    (
      option: ModelCatalogOption,
      credits = false,
      selection?: ModelPickerSelectionContext,
    ): ModelPickerSelectionDisposition | void => {
      if (autoOption && option.id === AUTO_ROW_ID) {
        if (autoActionable) {
          autoOption.unavailableAction?.();
          closeMenu();
          return;
        }
        if (autoUnavailable) return;
        autoOption.onSelect();
        closeMenu();
        return;
      }
      const route = credits ? harnessTabs?.credits : undefined;
      const optionState = resolveOptionState(option, selection, credits);
      if (optionState.disabled) return;
      const lock = activeLock(optionState);
      if (lock) {
        // Recovery opens a dialog or leaves the app, so focus is not handed
        // back to the trigger.
        lock.onUnlock();
        dismissMenu();
        return 'dismiss';
      }
      const select = route?.onSelect ?? onSelect;
      const disposition = selection
        ? select(option.id, selection)
        : select(option.id);
      if (disposition === 'dismiss') {
        dismissMenu();
        return disposition;
      }
      closeMenu();
      return disposition;
    },
    [
      autoActionable,
      autoOption,
      autoUnavailable,
      closeMenu,
      dismissMenu,
      onSelect,
      resolveOptionState,
      harnessTabs,
    ],
  );

  const updateFavorites = useCallback(
    (update: (previous: readonly string[]) => readonly string[]): void => {
      setFavoriteModelIds((previous) => {
        const next = update([...new Set(previous.map(resolveFavoriteKey))]);
        if (harnessTabs) {
          const storageKey =
            harnessTabs.favoritesStorageKey ?? 'canopy:model-picker-favorites';
          try {
            getWindow(triggerRef.current).localStorage.setItem(
              storageKey,
              JSON.stringify(next),
            );
          } catch {
            // Favorites remain usable for this session when storage is blocked.
          }
        }
        return next;
      });
    },
    [harnessTabs, resolveFavoriteKey],
  );
  const toggleFavorite = useCallback(
    (modelId: string): void =>
      updateFavorites((previous) =>
        previous.includes(modelId)
          ? previous.filter((candidate) => candidate !== modelId)
          : [...previous, modelId],
      ),
    [updateFavorites],
  );
  /** Re-points a model+harness favorite at another harness, keeping its place. */
  const moveFavorite = useCallback(
    (from: string, to: string): void =>
      updateFavorites((previous) =>
        previous.includes(to)
          ? previous.filter((candidate) => candidate !== from)
          : previous.map((candidate) => (candidate === from ? to : candidate)),
      ),
    [updateFavorites],
  );

  /*
   * Watch the label element itself rather than the window: the composer toolbar
   * squeezes this chip as sibling controls appear, so the label can start
   * clipping without any window resize at all.
   */
  useLayoutEffect((): (() => void) | void => {
    const label = triggerLabelElement;
    if (!label) {
      setTriggerLabelClipped(false);
      return;
    }
    const measure = (): void => {
      setTriggerLabelClipped(label.scrollWidth > label.clientWidth + 1);
      if (!foldIconWhenTight) return;
      // Fold once fewer than three characters fit before the ellipsis. Unfold
      // once the icon can come back with three still showing, counting the
      // free space in the host's fit container (`data-fit-container`): a
      // name at full width may still have room to spare beside it.
      // On truncate, the whole name is the minimum: any ellipsis folds.
      const minimum = foldTriggerIconOnTruncate
        ? label.scrollWidth
        : Math.min(
            label.scrollWidth,
            measureTextWidth(label, `${triggerLabel.slice(0, 3)}\u2026`),
          );
      const width = label.clientWidth;
      const container = label.closest<HTMLElement>('[data-fit-container]');
      const spare = container ? fitContainerSpareWidth(container) : 0;
      setTriggerIconFolded((folded) =>
        folded
          ? Math.min(label.scrollWidth, width + spare - TRIGGER_ICON_SLOT_PX) <
            minimum
          : width + 0.5 < minimum,
      );
    };
    const view = getWindow(label);
    if (!('ResizeObserver' in view)) {
      measure();
      return;
    }
    // The initial observer notification runs after layout, avoiding a forced
    // document layout while React is still committing the surrounding toolbar.
    // Keep triggerLabel in the dependencies: observing anew measures changed
    // text even when the label element retains the same width.
    const observer = new view.ResizeObserver(measure);
    observer.observe(label);
    // A wider row leaves the name untouched, so watch the row as well.
    const container = foldIconWhenTight
      ? label.closest<HTMLElement>('[data-fit-container]')
      : null;
    if (container) observer.observe(container);
    return (): void => observer.disconnect();
  }, [
    foldIconWhenTight,
    foldTriggerIconOnTruncate,
    hideLabel,
    triggerLabelElement,
    triggerLabel,
    triggerLabelClassName,
    variant,
  ]);

  /*
   * CAN-2701: the trigger says WHAT IT GOVERNS, not what it already shows.
   * `title="Model"` restated the control's own name and explained nothing, and
   * the capsule/compact tooltip only ever echoed the visible label back.
   *
   * The model name is prepended only when the chip is not already showing it:
   * either the label is hidden outright, or it is MEASURABLY clipped. Hosts
   * that merely allow truncation (the desktop composer, which shrinks with its
   * toolbar) usually render the label in full, and repeating it there would be
   * exactly the redundancy this change removes.
   */
  const triggerLabelObscured = hideLabel || triggerLabelClipped;
  const triggerTooltipLabel = triggerLabelObscured ? (
    triggerTooltip === null ? (
      triggerLabel
    ) : (
      <span className="flex flex-col gap-0.5 text-left">
        <span className="fg-primary">{triggerLabel}</span>
        {/* Assistive tech joins descendant text without inserting a boundary,
            so without this the description reads as one run-on token. */}
        <span className="sr-only">: </span>
        <span className="fg-secondary">{triggerTooltip}</span>
      </span>
    )
  ) : (
    triggerTooltip
  );

  const foldTriggerIcon = foldIconWhenTight;
  const triggerIcon = autoSelected ? (
    <AutoModelIcon
      size="sm"
      className={
        foldTriggerIcon
          ? 'shrink-0 fg-secondary'
          : variant === 'capsule'
            ? 'mr-0.5 shrink-0 fg-secondary'
            : 'shrink-0 fg-secondary'
      }
      data-testid={`${testIdPrefix}-picker-provider-icon`}
      data-selection-mode="auto"
    />
  ) : resolvedTriggerProvider ? (
    <ModelProviderIcon
      provider={resolvedTriggerProvider}
      central={variant === 'capsule'}
      width={variant === 'capsule' ? 16 : 13}
      height={variant === 'capsule' ? 16 : 13}
      className={
        foldTriggerIcon
          ? 'shrink-0 fg-secondary'
          : variant === 'capsule'
            ? 'mr-0.5 shrink-0 fg-secondary'
            : 'shrink-0 fg-secondary'
      }
      data-testid={`${testIdPrefix}-picker-provider-icon`}
      data-provider={resolvedTriggerProvider}
    />
  ) : (
    <DotIcon
      size="sm"
      className={
        foldTriggerIcon
          ? 'shrink-0 fg-secondary'
          : variant === 'capsule'
            ? 'mr-0.5 shrink-0 fg-secondary'
            : 'shrink-0 fg-secondary'
      }
      data-testid={`${testIdPrefix}-picker-provider-icon`}
    />
  );

  const triggerControl = (
    <ModelPickerTriggerControl
      ref={triggerRef}
      type="button"
      data-testid={`${testIdPrefix}-picker`}
      data-icon-folded={foldTriggerIcon ? triggerIconFolded : undefined}
      disabled={disabled}
      onClick={(): void => setOpen((previous) => !previous)}
      onKeyDown={(event): void => {
        // The harness browser anchors on a spacer beside this trigger, so the
        // menu's own ArrowDown/ArrowUp-to-open listener never sees the key.
        if (
          harnessTabs?.chrome !== 'picker' ||
          open ||
          (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')
        ) {
          return;
        }
        event.preventDefault();
        setOpen(true);
      }}
      aria-label={`Select model, current model ${triggerLabel}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? resolvedMenuId : undefined}
      icon={triggerIcon}
      label={triggerLabel}
      labelRef={attachTriggerLabel}
      // eslint-disable-next-line shadcn/require-static-classes -- Preserve the caller-supplied label width when forwarding to the extracted trigger.
      labelClassName={triggerLabelClassName}
      variant={variant}
      compact={compactTrigger}
      hideLabel={hideLabel}
      hideChevron={chevronless}
      foldIcon={foldTriggerIcon}
      iconFolded={triggerIconFolded}
    />
  );

  const trigger = (
    // Suppressed while the menu is open: the tooltip explains the closed
    // control, and leaving it mounted over an open menu only occludes it.
    // Disabled when there is nothing to say (no description, label in view).
    <Tooltip
      label={triggerTooltipLabel}
      delay="long"
      disabled={triggerTooltipLabel === null}
      suppressed={open}
      allowShrink={allowTriggerShrink}
      className={allowTriggerShrink ? 'max-w-full' : undefined}
    >
      {triggerControl}
    </Tooltip>
  );

  const autoRow =
    autoOption && autoRowVisible ? (
      <div role="group" className="pb-0.5">
        {/* Full-width and shrinkable so the row stays inside the menu
            and long copy truncates instead of running past the edge. */}
        <Tooltip
          className="w-full"
          allowShrink
          label={
            <span className="block w-64 whitespace-normal text-left">
              {autoOption.unavailableReason ?? MODEL_PICKER_AUTO_DETAIL}
            </span>
          }
        >
          <PickerMenuOption
            // An actionable reason is a command, not a radio choice: clicking
            // it goes to the fix rather than selecting Auto.
            role={autoActionable ? 'menuitem' : 'menuitemradio'}
            {...(autoActionable ? {} : { 'aria-checked': autoSelected })}
            selected={autoSelected}
            disabled={autoUnavailable && !autoActionable}
            data-testid={`${testIdPrefix}-option-auto`}
            onMouseDown={(event): void => event.preventDefault()}
            onClick={(): void => {
              if (autoActionable) {
                autoOption.unavailableAction?.();
                closeMenu();
                return;
              }
              if (autoUnavailable) return;
              autoOption.onSelect();
              closeMenu();
            }}
          >
            {/* Selected reads as the tinted leading icon, the same language
                the harness rows use, rather than a check mark. */}
            <PickerMenuOptionLeading
              tone={autoSelected ? 'accent' : 'tertiary'}
            >
              <AutoModelIcon
                size="sm"
                data-testid={`${testIdPrefix}-option-auto-icon`}
              />
            </PickerMenuOptionLeading>
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>
                {MODEL_PICKER_AUTO_LABEL}
              </PickerMenuOptionLabel>
              <PickerMenuOptionDescription>
                {autoOption.unavailableReason ?? MODEL_PICKER_AUTO_DESCRIPTION}
              </PickerMenuOptionDescription>
            </PickerMenuOptionContent>
            {autoActionable ? (
              // The hint sits on the label's baseline, 1px under the row's
              // center; the 2px top margin moves the arrow's center there.
              <ArrowUpRightIcon
                size="sm"
                className="mt-0.5 shrink-0 fg-tertiary"
                data-testid={`${testIdPrefix}-option-auto-action-icon`}
              />
            ) : null}
          </PickerMenuOption>
        </Tooltip>
      </div>
    ) : null;

  const workspaceDefaultOption =
    allowWorkspaceDefault && onSelectWorkspaceDefault ? (
      <div role="group" className="pb-0.5">
        <PickerMenuOption
          role="menuitemradio"
          aria-checked={currentModel === undefined}
          selected={currentModel === undefined}
          onMouseDown={(event): void => event.preventDefault()}
          onClick={(): void => {
            onSelectWorkspaceDefault();
            closeMenu();
          }}
        >
          <PickerMenuOptionLeading>
            {currentModel === undefined ? (
              <CheckMark className="fg-accent" />
            ) : null}
          </PickerMenuOptionLeading>
          <PickerMenuOptionContent>
            <PickerMenuOptionLabel>
              {workspaceDefaultLabel}
            </PickerMenuOptionLabel>
          </PickerMenuOptionContent>
        </PickerMenuOption>
      </div>
    ) : null;

  /**
   * One row per harness that is not connected, after the model groups in All
   * and in search. `divided` draws the hairline when groups precede it.
   */
  const renderConnectSection = (
    harnesses: typeof connectableHarnesses,
    divided: boolean,
  ): JSX.Element => (
    <div
      role="group"
      aria-label={CONNECT_SECTION_LABEL}
      data-picker-gap="3"
      data-testid={`${testIdPrefix}-connect-section`}
      className={
        divided
          ? // Bleeds to the search bar's edge, like its bottom border.
            `mt-2 border-t pt-2 ${modelSearch ? '-mx-1 px-1' : '-mr-1 pr-1'}`
          : PICKER_GROUP_SPACING_CLASS
      }
    >
      <ModelGroupHeader label={CONNECT_SECTION_LABEL} variant="picker" />
      {harnesses.map((harness) => {
        const label = getModelCatalogProviderLabel(harness.id);
        const signIn = harness.connectVia === 'sign-in';
        return (
          <PickerMenuOption
            key={harness.id}
            role="menuitem"
            tone="secondary"
            aria-label={signIn ? `Sign in to ${label}` : `Connect ${label}`}
            data-testid={`${testIdPrefix}-connect-row-${harness.id}`}
            data-connect-harness={harness.id}
            onMouseDown={(event): void => event.preventDefault()}
            onClick={(event): void => {
              event.preventDefault();
              // Same hand-off as the tab's connect prompt.
              dismissMenu();
              harnessTabs?.onConnectHarness?.(harness.id);
            }}
          >
            <PickerMenuOptionLeading tone="secondary">
              <ModelProviderIcon provider={harness.id} central size="md" />
            </PickerMenuOptionLeading>
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>{label}</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
            <span className="shrink-0 text-xs fg-accent">
              {signIn ? 'Sign in' : 'Connect'}
            </span>
          </PickerMenuOption>
        );
      })}
    </div>
  );

  /** Where hosted models will appear while their list loads or failed to. */
  const renderGatewayCatalogStatus = (catalogStatus: {
    readonly status: 'loading' | 'failed';
    readonly onRetry?: () => void;
  }): JSX.Element => (
    <div
      role="group"
      aria-label="More models"
      className={PICKER_GROUP_SPACING_CLASS}
      data-testid={`${testIdPrefix}-gateway-catalog-${catalogStatus.status}`}
    >
      <ModelGroupHeader label="More models" variant="picker" />
      {catalogStatus.status === 'loading' ? (
        <Skeleton loading label="Loading more models">
          {GATEWAY_PLACEHOLDER_WIDTHS.map((width) => (
            <PickerMenuSampleOption key={width} labelWidth={width} />
          ))}
        </Skeleton>
      ) : (
        <div className="flex h-8 items-center justify-between gap-2 pl-2">
          <span className="min-w-0 truncate text-s fg-tertiary">
            Couldn’t load
          </span>
          {catalogStatus.onRetry ? (
            <Button
              type="button"
              role="menuitem"
              size="sm"
              variant="ghost"
              data-testid={`${testIdPrefix}-gateway-catalog-retry`}
              onClick={(event): void => {
                // Keep the menu open so the placeholders show the new attempt.
                event.preventDefault();
                catalogStatus.onRetry?.();
              }}
            >
              Try again
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );

  const renderSectionHeader = (
    section: CatalogSection,
    hidden = false,
    pickerChrome = false,
  ): JSX.Element => (
    <ModelGroupHeader
      label={section.label}
      variant={pickerChrome ? 'picker' : 'default'}
      trailing={
        section.key === 'provider:cursor' && cursorExperimental ? (
          <Tooltip
            openDelay={100}
            label={
              <span className="block w-64 whitespace-normal">
                Experimental Cursor integration for Code chats, Cowork,{' '}
                {ORCHESTRATOR_LABEL}, and workflows. Chats support plugin MCP
                servers, skills, and commands. Enable managed subagents for Code
                worktree chats in desktop Settings &gt; Labs.
              </span>
            }
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              hidden={hidden}
              aria-label="Cursor experimental features"
              onClick={(event): void => event.preventDefault()}
              onMouseEnter={(): void =>
                setOptionDetail('cursor-experimental', 'hover', true)
              }
              onMouseLeave={(): void =>
                setOptionDetail('cursor-experimental', 'hover', false)
              }
              onFocus={(): void =>
                setOptionDetail('cursor-experimental', 'focus', true)
              }
              onBlur={(): void =>
                setOptionDetail('cursor-experimental', 'focus', false)
              }
              data-testid={`${testIdPrefix}-experimental-cursor`}
              className="flex h-5 w-5 items-center justify-center rounded fg-secondary hover:fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
            >
              <ExperimentIcon size="sm" aria-hidden="true" />
            </button>
          </Tooltip>
        ) : undefined
      }
      icon={
        pickerChrome ? (
          harnessTabs?.leadingFavorites &&
          section.icon &&
          section.options[0] ? (
            <ModelProviderIcon
              provider={sectionIconProvider(section.options[0])}
              central
              size="xs"
              exactSize
            />
          ) : undefined
        ) : (
          section.icon
        )
      }
      containerTestId={uniformTestIds ? `${testIdPrefix}-provider` : undefined}
      iconTestId={
        uniformTestIds ? undefined : `${testIdPrefix}-group-icon-${section.key}`
      }
      labelTestId={
        uniformTestIds
          ? `${testIdPrefix}-provider-label`
          : `${testIdPrefix}-group-label-${section.key}`
      }
    />
  );

  const harnessIconFor = (option: ModelCatalogOption): ReactNode => {
    const central = harnessTabs?.chrome === 'picker';
    const harness = modelHarnessTab(option);
    if (harness === 'other')
      return <DotIcon size="sm" exactSize aria-hidden="true" />;
    return harness === 'unstoppable' ? (
      harnessTabs?.brandIcon
    ) : (
      <ModelProviderIcon
        provider={harness}
        central={central}
        size="sm"
        exactSize
        aria-hidden="true"
      />
    );
  };
  /**
   * The harness browser owns its keyboard (the menu runs `manual`), so the
   * list moves focus between its own visible, enabled rows and section
   * controls; a row's favorite star is not a stop. Above the first item is the
   * search field the list is entered from.
   */
  const moveListFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (
      event.defaultPrevented ||
      (event.key !== 'ArrowDown' &&
        event.key !== 'ArrowUp' &&
        event.key !== 'Home' &&
        event.key !== 'End')
    ) {
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]',
      ),
    ).filter(
      (item) =>
        item.closest('[hidden], [aria-hidden="true"]') === null &&
        item.getAttribute('aria-disabled') !== 'true' &&
        !item.matches(':disabled'),
    );
    const index = items.findIndex(
      (item) => item === item.ownerDocument.activeElement,
    );
    if (index === -1) return;
    const target =
      event.key === 'Home'
        ? items[0]
        : event.key === 'End'
          ? items[items.length - 1]
          : event.key === 'ArrowDown'
            ? items[Math.min(index + 1, items.length - 1)]
            : index === 0
              ? searchRef.current
              : items[index - 1];
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView?.({ block: 'nearest' });
  };

  const renderHarnessOption = (
    option: ModelCatalogOption,
    hidden = false,
    credits = false,
    inFlyout = false,
    resultHarness?: string,
  ): JSX.Element => {
    const inAll =
      harnessTabs?.allModelsTab && activeHarnessTab === 'all' && !modelSearch;
    const chosenHarness = inAll ? allHarnessChoices[option.id] : undefined;
    const availableHarnesses =
      option.id !== autoModeOption?.id
        ? (
            harnessTabs?.runnableHarnesses ??
            (
              [
                'claude',
                'codex',
                'cursor',
                'copilot',
                'opencode',
                'ollama',
              ] as const
            )
              .filter((id) => harnessPanelIds.includes(id))
              .map((id) => ({ id, connected: true }))
          )
            .filter(
              (harness) =>
                harness.connected && optionBelongsToHarness(option, harness.id),
            )
            .map((harness) => harness.id)
        : [];
    resultHarness = chosenHarness ?? resultHarness;
    // A harness tab in the leading-stars layout marks every row with its own
    // icon, its own models included; the tab already fixes the harness.
    const inHarnessTab =
      harnessTabs?.leadingFavorites === true &&
      !modelSearch &&
      !hidden &&
      option.id !== autoModeOption?.id &&
      harnessPanelIds.includes(activeHarnessTab);
    const inFavorites =
      activeHarnessTab === 'favorites' && !modelSearch && !hidden;
    const viewHarness =
      resultHarness ??
      (activeHarnessTab === 'favorites' ? option.harness : activeHarnessTab);
    // All lists a native Claude or Codex model under its own harness only;
    // other harnesses that run it pick it from their tabs or a favorite.
    const ownHarness =
      inAll && (option.source === 'claude' || option.source === 'codex')
        ? option.source
        : undefined;
    const ownHarnessOnly = ownHarness !== undefined;
    // A model more than one harness runs is starred per harness, so the star
    // follows the harness it was starred on. Any other model is keyed by its
    // own tab, so All, its tab, and search agree on whether it is starred.
    // A disconnected native account does not remove the managed route's
    // identity. Selection and favorites still need the chosen harness.
    const runsOnSeveralHarnesses =
      Boolean(option.harnessChoices?.length) ||
      option.source === 'ai-gateway' ||
      harnessPanelIds.some(
        (harness) =>
          harness !== modelHarnessTab(option) &&
          optionBelongsToHarness(option, harness),
      );
    const favoriteHarness =
      runsOnSeveralHarnesses && !ownHarnessOnly
        ? viewHarness === 'unknown'
          ? 'other'
          : viewHarness
        : modelHarnessTab(option);
    const favoriteKey =
      (activeHarnessTab === 'favorites'
        ? favoriteKeyByRow.get(option)
        : undefined) ?? `${favoriteHarness}::${option.id}`;
    // All runs a native model on its own harness, whatever its saved default.
    const billingHarness =
      ownHarness ??
      resultHarness ??
      (inAll && option.harnessChoices?.length
        ? (option.harness ?? modelHarnessTab(option))
        : undefined) ??
      (activeHarnessTab === 'favorites' ? option.harness : activeHarnessTab) ??
      modelHarnessTab(option);
    // A favorite retains its saved account even if that account stops offering
    // the row. Availability then disables it instead of choosing a native route.
    const selectionHarness =
      inFavorites &&
      option.harness &&
      option.harness !== modelHarnessTab(option)
        ? option.harness
        : runsOnSeveralHarnesses &&
            (harnessTabs?.runnableHarnesses?.some(
              (harness) => harness.id === billingHarness,
            ) ??
              harnessPanelIds.includes(billingHarness))
          ? billingHarness
          : undefined;
    const billing = (
      option.id === AUTO_ROW_ID
        ? harnessTabs?.billing?.includeAuto === true
        : option.id !== autoModeOption?.id &&
          billingHarness !== 'opencode' &&
          harnessTabs?.billing?.modelIds.has(option.id) === true
    )
      ? harnessTabs?.billing
      : undefined;
    const selectedChoice = option.harnessChoices?.find(
      (choice) => choice.harness === billingHarness,
    );
    const displayOption = resolveModelCatalogHarnessChoice(
      option,
      billingHarness,
    );
    const preference = billing?.getPreference(option.id, billingHarness);
    // The chosen runtime's funding, else the row's: an own-gateway row is
    // never AI Credits, whatever its source.
    const funding = selectedChoice?.funding ?? option.funding;
    credits =
      funding === 'org-gateway'
        ? false
        : credits ||
          preference?.payment === 'credits' ||
          selectedChoice?.funding === 'ai-credits';
    const stateSelection: ModelPickerSelectionContext | undefined =
      selectionHarness
        ? {
            harness: selectionHarness,
            ...(inHarnessTab || (modelSearch && resultHarness)
              ? { harnessExplicitlyChosen: true }
              : {}),
          }
        : undefined;
    const state = resolveOptionState(option, stateSelection, credits);
    const presentation =
      getOptionPresentation?.(option, stateSelection) ?? displayOption;
    const managedAccount =
      presentation.source === 'cursor' ||
      presentation.source === 'copilot' ||
      presentation.source === 'opencode';
    const vendor = normalizedVendor(option);
    // Hosted rows on the brand tab are credits, which used to repeat the brand
    // mark on every model. In the compact picker, a known vendor keeps its own
    // glyph so DeepSeek, Moonshot, and the other makers stay distinguishable.
    const leadingIcon =
      harnessTabs?.chrome === 'picker' && vendor ? (
        <ModelProviderIcon
          provider={vendor}
          central
          size="md"
          aria-hidden="true"
        />
      ) : credits ? (
        harnessTabs?.brandIcon
      ) : (
        harnessIconFor(option)
      );
    return (
      <ModelPickerOption
        key={`${option.id}:${resultHarness ?? option.harness ?? modelHarnessTab(option)}`}
        option={
          presentation === option
            ? option
            : { ...presentation, id: option.id, label: option.label }
        }
        selected={
          option.id === AUTO_ROW_ID
            ? autoSelected
            : !autoSelected && option.id === selectedOption?.id
        }
        state={state}
        leadingFavorite={
          harnessTabs?.leadingFavorites && option.id !== autoModeOption?.id
        }
        usesAiCredits={
          funding !== 'org-gateway' &&
          !managedAccount &&
          (credits ||
            presentation.source === 'ai-gateway' ||
            harnessTabs?.creditsRoutedModelIds?.has(option.id) === true)
        }
        settingsHarnesses={
          // Harness tabs and search groups already fix where the model runs.
          // All switches a hosted model for the pick; Favorites moves the
          // saved pair.
          ((inAll && option.source === 'ai-gateway') || inFavorites) &&
          availableHarnesses.length > 1
            ? availableHarnesses
            : undefined
        }
        showHarnessControl={
          inAll &&
          option.source === 'ai-gateway' &&
          availableHarnesses.length > 1
        }
        currentHarness={billingHarness}
        onSettingsHarness={(harness): void => {
          if (inFavorites) {
            moveFavorite(favoriteKey, `${harness}::${option.id}`);
            setBillingMenuKey(null);
            return;
          }
          setAllHarnessChoices((current) => ({
            ...current,
            [option.id]: harness,
          }));
          if (!inAll) {
            setActiveHarnessTab(harness);
            setModelSearch('');
          }
          rememberSelectionTab(option.id, inAll ? 'all' : harness);
          harnessTabs?.onModelHarnessChange?.(option.id, harness);
          setBillingMenuKey(null);
          selectOption(
            option,
            credits,
            option.source === 'ai-gateway' ? { harness } : undefined,
          );
        }}
        onSelect={(selected): ModelPickerSelectionDisposition | void => {
          if (inAll && resultHarness) {
            setAllHarnessChoices((current) => ({
              ...current,
              [option.id]: resultHarness,
            }));
          }
          if (resultHarness && !inAll) {
            setActiveHarnessTab(resultHarness);
            setModelSearch('');
          }
          rememberSelectionTab(
            option.id,
            resultHarness && !inAll
              ? resultHarness === 'unknown'
                ? 'other'
                : resultHarness
              : activeHarnessTab,
          );
          return selectOption(selected, credits, stateSelection);
        }}
        detailOpen={detailOptionId === option.id ? detailInput : false}
        onDetailChange={setOptionDetail}
        inFlyout={inFlyout}
        testIdPrefix={testIdPrefix}
        uniformTestIds={uniformTestIds}
        hidden={hidden}
        isAutoMode={option.id === autoModeOption?.id}
        autoState={
          option.id === AUTO_ROW_ID && autoOption
            ? {
                reason: autoUnavailable
                  ? autoOption.unavailableReason
                  : undefined,
                actionable: autoActionable,
              }
            : undefined
        }
        suppressPointerHover={suppressRowHover}
        leadingIcon={
          option.id === autoModeOption?.id ? (
            <AutoModelIcon
              size={PICKER_ROW_GLYPH_SIZE}
              exactSize
              data-testid={`${testIdPrefix}-option-auto-icon`}
            />
          ) : (
            leadingIcon
          )
        }
        favorite={resolvedFavoriteModelIds.includes(favoriteKey)}
        onToggleFavorite={
          option.id === autoModeOption?.id
            ? undefined
            : (): void => toggleFavorite(favoriteKey)
        }
        billingHarnessLabel={
          billingHarness === 'claude'
            ? 'Claude'
            : billingHarness === 'codex'
              ? 'Codex'
              : getModelCatalogProviderLabel(option.provider)
        }
        trailingHarness={
          // Every row names its harness. All shows a row's own harness, and a
          // hosted row with a harness menu shows its choice there instead.
          inFavorites
            ? option.harness
            : inAll
              ? option.source === 'ai-gateway'
                ? availableHarnesses.length > 1
                  ? undefined
                  : (option.harness ?? option.provider)
                : (harnessIconId(option.source) ?? option.harness)
              : inHarnessTab
                ? activeHarnessTab
                : modelSearch
                  ? (harnessIconId(resultHarness) ?? option.harness)
                  : option.harness
        }
        billingPreference={preference}
        billingFallback={billing?.fallback !== false}
        onBillingChange={
          billing
            ? (next): void => billing.onChange(option.id, billingHarness, next)
            : undefined
        }
        billingOpen={billingMenuKey === favoriteKey}
        onBillingOpenChange={(next): void =>
          setBillingMenuKey(next ? favoriteKey : null)
        }
        billingMenuActive={billingMenuKey !== null}
        highlightSelection={highlightSelection}
        pickerChrome={harnessTabs?.chrome === 'picker'}
      />
    );
  };

  const renderAutoModeBlock = (option: ModelCatalogOption): JSX.Element => (
    <Stack gap="tight" className="mb-2">
      {renderHarnessOption(option)}
      {/* Full width, edge to edge like the search row's line above it:
          `-mx-1` cancels the list's inset. */}
      <div
        className="-mx-1 border-b"
        data-testid={`${testIdPrefix}-auto-divider`}
      />
    </Stack>
  );

  const pickerChrome = harnessTabs?.chrome === 'picker';
  // The compact picker carries Auto as a toggle in its search row instead of
  // a row leading the list, as the effort panel carries fast mode.
  const autoInList = harnessLeadsWithAuto && !pickerChrome;
  const autoPressed =
    autoModeOption?.id === AUTO_ROW_ID
      ? autoSelected
      : !autoSelected && autoModeOption?.id === selectedOption?.id;
  // A typed search is about models, so Auto steps aside until it clears.
  const autoToggle =
    pickerChrome && autoModeOption && !modelSearch ? (
      <IconToggleButton
        pressed={autoPressed}
        label={MODEL_PICKER_AUTO_LABEL}
        showLabel
        offTone="accent"
        tooltip={`${MODEL_PICKER_AUTO_LABEL}: ${
          autoUnavailable && autoOption?.unavailableReason
            ? autoOption.unavailableReason
            : MODEL_PICKER_AUTO_DESCRIPTION.toLowerCase()
        }`}
        disabled={autoUnavailable && !autoActionable}
        onClick={(): void => {
          // Already on: nothing changes, so the picker stays open.
          if (autoPressed) return;
          selectOption(autoModeOption);
        }}
        icon={
          <AutoModelIcon
            size={PICKER_ROW_GLYPH_SIZE}
            exactSize
            data-testid={`${testIdPrefix}-option-auto-icon`}
          />
        }
        testId={`${testIdPrefix}-option-${autoModeOption.id}`}
      />
    ) : null;
  const railIconSize = PICKER_RAIL_GLYPH_SIZE;
  const railTabsInOrder: {
    id: string;
    label: string;
    icon: ReactNode;
    connected: boolean;
  }[] = harnessTabs
    ? [
        {
          id: 'favorites',
          label: 'Favorites',
          icon: (
            <FavoriteStar filled={activeHarnessTab === 'favorites'} size="lg" />
          ),
          connected: true,
        },
        ...(harnessTabs.allModelsTab
          ? [
              {
                id: 'all',
                label: 'All models',
                icon:
                  activeHarnessTab === 'all' ? (
                    <AllModelsFilledIcon size={railIconSize} exactSize />
                  ) : (
                    <AllModelsIcon size={railIconSize} exactSize />
                  ),
                connected: true,
              },
            ]
          : []),
        ...(
          harnessTabs.runnableHarnesses ?? [
            { id: 'claude' as const, connected: true },
            { id: 'codex' as const, connected: true },
          ]
        ).map((harness) => ({
          id: harness.id,
          label: getModelCatalogProviderLabel(harness.id),
          icon: (
            <ModelProviderIcon
              provider={harness.id}
              central={pickerChrome}
              size="lg"
              exactSize
            />
          ),
          connected: harness.connected,
        })),
        ...extraHarnessTabs
          .filter(
            (id) =>
              id === 'other' ||
              harnessTabs.runnableHarnesses?.some(
                (harness) => harness.id === id,
              ) !== true,
          )
          .map((id) => ({
            id,
            label:
              id === 'other'
                ? 'Other models'
                : getModelCatalogProviderLabel(id),
            icon:
              id === 'other' ? (
                <DotIcon size="lg" exactSize />
              ) : (
                <ModelProviderIcon
                  provider={id}
                  central={pickerChrome}
                  size="lg"
                  exactSize
                />
              ),
            connected: true,
          })),
      ]
    : [];
  // Connected harnesses lead the rail; ones still to set up follow.
  const railTabs = [
    ...railTabsInOrder.filter((tab) => tab.connected),
    ...railTabsInOrder.filter((tab) => !tab.connected),
  ];
  // Compact picker chrome is one fixed shell sized to the rail: every tab, a
  // 1px gap — no reserved slot or `mt-auto` leftover.
  const pickerChromeHeightPx = pickerChrome
    ? pickerChromeMenuHeightPx({
        railTabCount: railTabs.length,
      })
    : undefined;
  const menuSurfaceShell: DropdownMenuSurfaceShell = harnessTabs
    ? pickerChrome
      ? highlightSelection
        ? 'model-picker-highlight'
        : 'model-picker'
      : 'model-browser'
    : 'menu';
  // Recovery text shares a row with the model's identity. The compact shell
  // predates these labels and leaves a model name almost entirely ellipsized
  // beside a lock label. Use the same roomier shell on every host; the
  // existing picker surface still caps it to the available viewport.
  const hasRowCueLabel = useMemo(
    () =>
      catalog.some((option) => {
        const state = getOptionState?.(option);
        return (
          state !== undefined &&
          !state.disabled &&
          // A short label fits the default width; only longer recovery
          // text widens it.
          (activeLock(state)?.label?.trim().length ?? 0) >
            DEFAULT_WIDTH_ROW_LABEL_MAX_LENGTH
        );
      }),
    [catalog, getOptionState],
  );
  const rowCueWidth = hasRowCueLabel ? '28rem' : '19rem';
  const menuSurfaceStyle:
    | (CSSProperties & {
        '--canopy-picker-minimum-width': string;
        '--canopy-picker-maximum-width': string;
        height?: number;
      })
    | undefined =
    pickerChrome || (harnessTabs !== undefined && hasRowCueLabel)
      ? {
          // Keep ordinary rows compact; labelled rows also reserve room for
          // their recovery or readiness text beside the model name.
          '--canopy-picker-minimum-width': rowCueWidth,
          '--canopy-picker-maximum-width': rowCueWidth,
          ...(pickerChromeHeightPx === undefined
            ? {}
            : {
                height: Math.max(
                  menuMinHeightPx ?? 0,
                  menuMaxHeightPx === undefined
                    ? pickerChromeHeightPx
                    : Math.min(pickerChromeHeightPx, menuMaxHeightPx),
                ),
              }),
        }
      : undefined;
  const renderMenuSurface = (children: ReactNode): JSX.Element => {
    return (
      <FloatingMenu
        id={resolvedMenuId}
        open={open}
        onOpenChange={(next): void => {
          if (next) setOpen(true);
          // Selection restores focus through closeMenu. A Tab or outside
          // dismissal leaves focus navigation to the floating layer/host.
          else if (onRestoreFocus) closeMenu();
          else dismissMenu();
        }}
        returnFocusRef={externalTriggerRef ?? triggerRef}
        anchorRef={
          externalTriggerRef ??
          (harnessTabs?.chrome === 'picker'
            ? pickerChromeAnchorRef
            : triggerRef)
        }
        {...(menuAlignRef
          ? { alignRef: menuAlignRef }
          : menuAlignOffset !== undefined
            ? { alignOffset: menuAlignOffset }
            : {})}
        placement={
          menuAlignRef && menuAlignEdge === 'right' ? 'top-right' : 'top-left'
        }
        initialFocusRef={harnessTabs ? searchRef : undefined}
        // Harness browser owns its own list scroll (and a flex-filled connect
        // empty state). The default menu scroll viewport would nest another
        // scroller and prevent flex-1 from resolving against the fixed height.
        interaction={harnessTabs ? 'manual' : undefined}
        gap={menuAlignRef ? COMPOSER_ROW_MENU_GAP : FLOATING_PICKER_GAP}
        data-canopy-browser-native-overlay="true"
        data-testid={`${testIdPrefix}-menu`}
        aria-label="Model options"
        /*
         * CAN-2701: one width for every host, sized to the content rather than
         * to the trigger. At w-48/w-56 the longest shipping label
         * ("GPT 5.3-Codex-Spark") truncated against the selection rail and the
         * trailing controls; w-64 clears it with room for a 150% UI scale,
         * where the rem-based width and rem-based type scale together.
         */
        // 19rem matches the compact harness browser: tall enough for the
        // search row and a short model list, and still inside a short viewport.
        shell={menuSurfaceShell}
        className={
          harnessTabs
            ? 'overscroll-contain'
            : hasRowCueLabel
              ? 'w-112 max-w-[calc(100vw-16px)] overscroll-contain'
              : 'w-64 overscroll-contain'
        }
        style={menuSurfaceStyle}
      >
        {children}
      </FloatingMenu>
    );
  };

  return (
    <div
      className={`relative ${allowTriggerShrink ? 'min-w-0' : 'shrink-0'}`}
      onKeyDownCapture={(): void => {
        keyboardIntentRef.current = true;
      }}
      onPointerDownCapture={(): void => {
        keyboardIntentRef.current = false;
      }}
      onPointerMoveCapture={(): void => {
        keyboardIntentRef.current = false;
      }}
    >
      {!externalTriggerRef && trigger}
      {!externalTriggerRef && harnessTabs?.chrome === 'picker' ? (
        <span
          ref={pickerChromeAnchorRef}
          aria-hidden="true"
          data-testid={`${testIdPrefix}-menu-anchor`}
          className="pointer-events-none absolute inset-y-0 -left-2 w-0"
        />
      ) : null}
      {renderMenuSurface(
        harnessTabs ? (
          <div
            className={`flex min-h-0 w-full ${pickerChrome ? 'flex-1' : 'h-full'}`}
          >
            <nav
              aria-label="Model harnesses"
              hidden={pickerChrome ? Boolean(modelSearch) : undefined}
              className={`flex min-h-0 shrink-0 flex-col border-r overflow-hidden transition-opacity duration-150 ${pickerChrome ? '-ml-1 w-[calc(2.75rem+0.5px)] self-stretch bg-card [.dark_&]:bg-secondary' : 'h-full w-12'} ${modelSearch ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
            >
              <OverlayScrollArea
                className="min-h-0 flex-1"
                railClassName="hidden"
                contentClassName={`flex flex-col py-1 ${pickerChrome ? 'gap-px' : ''}`}
                edgeFadeSize={8}
              >
                {railTabs.map((tab, index): JSX.Element => {
                  const active = activeHarnessTab === tab.id;
                  const indicator =
                    active && !pickerChrome ? (
                      <span className="pointer-events-none absolute right-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-l bg-accent" />
                    ) : null;
                  const tabButton = (
                    <button
                      key={pickerChrome ? undefined : tab.id}
                      type="button"
                      role="menuitemradio"
                      aria-label={
                        tab.connected
                          ? tab.label
                          : `${tab.label}. Connect to use its models.`
                      }
                      aria-checked={active}
                      hidden={pickerChrome ? undefined : Boolean(modelSearch)}
                      data-testid={`${testIdPrefix}-harness-tab-${tab.id}`}
                      onMouseDown={(event): void => event.preventDefault()}
                      onClick={(event): void => {
                        event.preventDefault();
                        setActiveHarnessTab(tab.id);
                        if (harnessTabStorageKey && !initialHarnessTab) {
                          try {
                            window.localStorage.setItem(
                              harnessTabStorageKey,
                              tab.id,
                            );
                          } catch {
                            // The current picker remains usable without storage.
                          }
                        }
                      }}
                      className={`focus-ring flex items-center justify-center transition-colors ${
                        pickerChrome
                          ? `mx-1 size-9 shrink-0 rounded-md [&>span]:!size-4.5 ${
                              active
                                ? `${SECONDARY_SURFACE_SHELL_CLASS} ${
                                    tab.connected
                                      ? 'fg-primary'
                                      : 'fg-quaternary'
                                  }`
                                : tab.connected
                                  ? `${tab.id === 'favorites' ? 'fg-tertiary' : 'fg-secondary'} hover:bg-subtle hover:fg-primary`
                                  : 'fg-quaternary hover:bg-subtle'
                            }`
                          : `relative h-10 w-full shrink-0 rounded-none hover:bg-subtle ${
                              active
                                ? tab.connected
                                  ? 'bg-subtle fg-primary'
                                  : 'bg-subtle fg-quaternary'
                                : tab.connected
                                  ? 'fg-secondary hover:fg-primary'
                                  : 'fg-quaternary'
                            }`
                      }`}
                    >
                      {tab.icon}
                      {pickerChrome ? null : indicator}
                    </button>
                  );
                  if (!pickerChrome) return tabButton;
                  return (
                    <Fragment key={tab.id}>
                      <div
                        hidden={Boolean(modelSearch)}
                        className="relative flex h-9 shrink-0"
                      >
                        {tabButton}
                        {indicator}
                      </div>
                      {index === 0 ? (
                        <div
                          hidden={Boolean(modelSearch)}
                          data-testid={`${testIdPrefix}-favorites-divider`}
                          className="mx-3 flex h-1.75 shrink-0 items-center"
                        >
                          <div className="w-full border-b" />
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
              </OverlayScrollArea>
            </nav>
            <div
              className={`flex min-h-0 min-w-0 flex-1 flex-col ${pickerChrome ? 'pt-1' : ''}`}
            >
              {pickerChrome ? (
                <div
                  className={`${modelSearch ? '-mx-1' : '-mr-1'} flex shrink-0 flex-col border-b pb-1`}
                >
                  <div
                    // Clear search owns the right edge while typing, unless
                    // Auto sits there; then both follow the field in turn.
                    className={`relative flex h-9 shrink-0 items-center ${autoToggle ? 'gap-1 pr-2' : modelSearch ? 'pr-8' : ''} pl-1`}
                  >
                    <PickerMenuSearchInput
                      ref={searchRef}
                      type="search"
                      value={modelSearch}
                      onChange={(event): void =>
                        setModelSearch(event.target.value)
                      }
                      onKeyDown={(event): void => {
                        if (
                          event.key === 'ArrowDown' ||
                          event.key === 'ArrowUp'
                        ) {
                          const options = event.currentTarget
                            .closest('[role="menu"]')
                            ?.querySelectorAll<HTMLButtonElement>(
                              SEARCH_ENTRY_ROW_SELECTOR,
                            );
                          const row =
                            event.key === 'ArrowDown'
                              ? options?.[0]
                              : options?.[options.length - 1];
                          event.preventDefault();
                          event.stopPropagation();
                          row?.focus();
                          row?.scrollIntoView({ block: 'nearest' });
                        } else if (
                          event.key !== 'Escape' &&
                          event.key !== 'Tab'
                        ) {
                          event.stopPropagation();
                        }
                      }}
                      placeholder="Search models"
                      aria-label="Search models"
                      data-testid={`${testIdPrefix}-search`}
                    />
                    {modelSearch ? (
                      <Button
                        variant="ghost-quiet"
                        size="sm"
                        iconOnly
                        aria-label="Clear search"
                        data-testid={`${testIdPrefix}-clear-search`}
                        onMouseDown={(event): void => event.preventDefault()}
                        onClick={(event): void => {
                          event.preventDefault();
                          clearModelSearch();
                        }}
                        className={
                          autoToggle
                            ? undefined
                            : 'absolute right-1.5 top-1/2 -translate-y-1/2'
                        }
                      >
                        <CloseMediumIcon size="sm" />
                      </Button>
                    ) : null}
                    {autoToggle}
                  </div>
                </div>
              ) : (
                <div className="mx-3 shrink-0 border-b">
                  <SearchField
                    ref={searchRef}
                    size="lg"
                    // The 44px header's own inset, less this row's margin,
                    // keeps the glyph where the picker's rows start.
                    className="-ml-3"
                    aria-label="Search models"
                    value={modelSearch}
                    onValueChange={setModelSearch}
                    // Escape closes the picker, as it does from its rows.
                    clearOnEscape={false}
                    onKeyDown={(event): void => {
                      if (
                        event.key === 'ArrowDown' ||
                        event.key === 'ArrowUp'
                      ) {
                        const options = event.currentTarget
                          .closest('[role="menu"]')
                          ?.querySelectorAll<HTMLButtonElement>(
                            SEARCH_ENTRY_ROW_SELECTOR,
                          );
                        const row =
                          event.key === 'ArrowDown'
                            ? options?.[0]
                            : options?.[options.length - 1];
                        event.preventDefault();
                        event.stopPropagation();
                        row?.focus();
                        row?.scrollIntoView({ block: 'nearest' });
                      } else if (
                        event.key !== 'Escape' &&
                        event.key !== 'Tab'
                      ) {
                        event.stopPropagation();
                      }
                    }}
                    placeholder="Search models"
                    data-testid={`${testIdPrefix}-search`}
                  />
                </div>
              )}
              {harnessTabs.emptyCatalog &&
              catalog.every((option) => resolveOptionState(option).disabled) &&
              !modelSearch ? (
                <div
                  className="flex min-h-0 w-full flex-1 flex-col items-center justify-center px-6 pb-5 text-balance"
                  data-testid={`${testIdPrefix}-catalog-empty`}
                >
                  <EmptyState
                    spacing="relaxed"
                    inset="none"
                    titleWeight="normal"
                    title={harnessTabs.emptyCatalog.title}
                    subtitle={harnessTabs.emptyCatalog.subtitle}
                    action={
                      harnessTabs.emptyCatalog.action ? (
                        <Button
                          type="button"
                          size="sm"
                          data-testid={
                            harnessTabs.emptyCatalog.action.testId ??
                            `${testIdPrefix}-catalog-empty-action`
                          }
                          onMouseDown={(event): void => event.preventDefault()}
                          onClick={(event): void => {
                            event.preventDefault();
                            const action = harnessTabs.emptyCatalog?.action;
                            dismissMenu();
                            action?.onClick();
                          }}
                        >
                          {harnessTabs.emptyCatalog.action.label}
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : showConnectPrompt &&
                activeRunnableHarness &&
                !modelSearch &&
                activeHarnessTab !== 'favorites' ? (
                <div
                  className="flex min-h-0 w-full flex-1 flex-col items-center justify-center px-1 pb-5"
                  data-testid={`${testIdPrefix}-connect-prompt`}
                >
                  <EmptyState
                    spacing="relaxed"
                    inset="none"
                    titleWeight="normal"
                    icon={
                      <ModelProviderIcon
                        provider={activeRunnableHarness.id}
                        central={pickerChrome}
                        size="2xl"
                      />
                    }
                    title={
                      activeRunnableHarness.connectVia === 'sign-in'
                        ? `Sign in to ${connectHarnessLabel}`
                        : `Connect ${connectHarnessLabel} in Settings`
                    }
                    action={
                      harnessTabs?.onConnectHarness ? (
                        <Button
                          type="button"
                          size="sm"
                          data-testid={`${testIdPrefix}-connect-harness`}
                          onMouseDown={(event): void => event.preventDefault()}
                          onClick={(event): void => {
                            event.preventDefault();
                            // Sign-in and Settings both take over the screen
                            // and own focus, so the picker just closes.
                            dismissMenu();
                            harnessTabs.onConnectHarness?.(
                              activeRunnableHarness.id,
                            );
                          }}
                        >
                          {activeRunnableHarness.connectVia === 'sign-in'
                            ? 'Sign in'
                            : 'Open settings'}
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : activeHarnessTab === 'favorites' &&
                !modelSearch &&
                favoriteModels.length === 0 ? (
                <>
                  {harnessTabs.leadingFavorites && autoModeOption ? (
                    // Same inset as the list content, so Auto does not move
                    // when the last favorite is removed.
                    <div className="-mr-1 shrink-0 px-1 pt-1">
                      {renderAutoModeBlock(autoModeOption)}
                    </div>
                  ) : null}
                  <div
                    className="flex min-h-0 w-full flex-1 flex-col items-center justify-center px-1 pb-3"
                    data-testid={`${testIdPrefix}-favorites-empty`}
                  >
                    {/* Same ink as the search's No models match. */}
                    <p className="text-s fg-tertiary">
                      Star models for quick access
                    </p>
                  </div>
                </>
              ) : modelSearch &&
                searchHarnessGroups.length === 0 &&
                searchConnectableHarnesses.length === 0 ? (
                <div
                  className="flex min-h-0 w-full flex-1 flex-col items-center justify-center px-1 pb-3"
                  data-testid={`${testIdPrefix}-search-empty`}
                >
                  <p className="text-s fg-tertiary">No models match</p>
                </div>
              ) : (
                <PickerMenuList
                  ref={harnessListRef}
                  edgeFadeSize={8}
                  role="presentation"
                  edges={pickerChrome && !modelSearch ? 'right' : 'both'}
                  gutter={pickerChrome ? 'none' : 'scrollbar'}
                  onScrollCapture={(event): void => {
                    // Chromium reports a scroll a frame after it happens. A
                    // pointer that already moved at this offset entered the
                    // rows it is over now, so its hover stands.
                    if (
                      event.target === event.currentTarget &&
                      event.currentTarget.scrollTop ===
                        pointerScrollTopRef.current
                    )
                      return;
                    setSuppressRowHover(true);
                  }}
                  onPointerMoveCapture={(event): void => {
                    if (event.movementX !== 0 || event.movementY !== 0) {
                      pointerScrollTopRef.current =
                        event.currentTarget.scrollTop;
                      setSuppressRowHover(false);
                    }
                  }}
                  onKeyDown={moveListFocus}
                >
                  {workspaceDefaultOption}
                  {workspaceDefaultOption === null &&
                  (modelSearch ||
                    (!autoInList &&
                      !showConnectPrompt &&
                      activeHarnessTab !== 'favorites')) ? (
                    // The list opens on a provider label (search results, or
                    // a provider tab with no Auto row): 4px more room puts it
                    // 14px under the line above, as under the Auto divider.
                    <div
                      aria-hidden="true"
                      className="h-1 shrink-0"
                      data-testid={`${testIdPrefix}-leading-label-space`}
                    />
                  ) : null}
                  {autoInList && autoModeOption
                    ? renderAutoModeBlock(autoModeOption)
                    : null}
                  {!modelSearch &&
                  harnessTabs.allModelsTab &&
                  activeHarnessTab === 'all'
                    ? sections.map((section) => {
                        const label =
                          section.key === 'openai' ? 'OpenAI' : section.label;
                        return (
                          <div
                            key={section.key}
                            role="group"
                            aria-label={label}
                            data-picker-gap="3"
                            className={PICKER_GROUP_SPACING_CLASS}
                          >
                            {renderSectionHeader(
                              { ...section, label },
                              false,
                              pickerChrome,
                            )}
                            {sectionStatusFor(section)}
                            {section.options
                              .filter((option) => option.showMoreOnly !== true)
                              .map((option) =>
                                renderHarnessOption(
                                  option,
                                  false,
                                  option.source === 'ai-gateway',
                                  false,
                                  option.harness ?? option.provider,
                                ),
                              )}
                            {section.options.some(
                              (option) => option.showMoreOnly === true,
                            ) ? (
                              <NestedMenuFlyout
                                label="Legacy models"
                                appearance="disclosure"
                                keepLeadingSlot={legacyLabelIndent}
                                triggerTestId={`${testIdPrefix}-more-${section.key}`}
                                menuTestId={`${testIdPrefix}-more-group-${section.key}`}
                                containsSelection={
                                  highlightSelection &&
                                  legacyHoldsSelection(section.options)
                                }
                                leading={
                                  !highlightSelection &&
                                  legacyHoldsSelection(section.options) ? (
                                    <CheckMark />
                                  ) : null
                                }
                                leadingTone="accent"
                                menuWidth="parent"
                              >
                                {section.options
                                  .filter(
                                    (option) => option.showMoreOnly === true,
                                  )
                                  .map((option) =>
                                    renderHarnessOption(
                                      option,
                                      false,
                                      option.source === 'ai-gateway',
                                      true,
                                      option.harness ?? option.provider,
                                    ),
                                  )}
                              </NestedMenuFlyout>
                            ) : null}
                          </div>
                        );
                      })
                    : null}
                  {!modelSearch &&
                  harnessTabs.allModelsTab &&
                  activeHarnessTab === 'all' &&
                  harnessTabs.gatewayCatalog
                    ? renderGatewayCatalogStatus(harnessTabs.gatewayCatalog)
                    : null}
                  {!modelSearch &&
                  harnessTabs.allModelsTab &&
                  activeHarnessTab === 'all' &&
                  connectableHarnesses.length > 0
                    ? renderConnectSection(
                        connectableHarnesses,
                        sections.length > 0 ||
                          Boolean(harnessTabs.gatewayCatalog),
                      )
                    : null}
                  {modelSearch
                    ? searchHarnessGroups.map((harness) => (
                        <div
                          key={harness.id}
                          role="group"
                          aria-label={getModelCatalogProviderLabel(harness.id)}
                          data-picker-gap="3"
                          className={PICKER_GROUP_SPACING_CLASS}
                        >
                          <ModelGroupHeader
                            label={getModelCatalogProviderLabel(harness.id)}
                            variant="picker"
                            icon={
                              <ModelProviderIcon
                                provider={harness.id}
                                central
                                size="xs"
                              />
                            }
                            iconTestId={`${testIdPrefix}-search-group-icon-${harness.id}`}
                          />
                          {harnessStatusFor(harness.id)}
                          {harness.models.map((option) =>
                            renderHarnessOption(
                              option,
                              false,
                              option.source === 'ai-gateway' ||
                                (harnessTabs.credits?.active === true &&
                                  harnessTabs.credits.modelIds.has(option.id) &&
                                  (option.source ?? option.provider) ===
                                    harness.id),
                              false,
                              harness.id,
                            ),
                          )}
                        </div>
                      ))
                    : activeHarnessTab === 'favorites'
                      ? favoriteModels.map((option) =>
                          renderHarnessOption(option),
                        )
                      : null}
                  {modelSearch && searchConnectableHarnesses.length > 0
                    ? renderConnectSection(
                        searchConnectableHarnesses,
                        searchHarnessGroups.length > 0,
                      )
                    : null}
                  {!modelSearch &&
                  !showConnectPrompt &&
                  !(harnessTabs.allModelsTab && activeHarnessTab === 'all')
                    ? harnessPanelIds.map((harness) => (
                        <div
                          key={harness}
                          className={PICKER_GROUP_SPACING_CLASS}
                          hidden={activeHarnessTab !== harness}
                          aria-hidden={activeHarnessTab !== harness}
                        >
                          {harnessStatusFor(harness)}
                          {sectionsForHarness(harness).map((section, index) => (
                            <div
                              key={section.key}
                              role="group"
                              aria-label={section.label}
                              data-picker-gap={
                                harnessTabs.leadingFavorites ? '3' : undefined
                              }
                              className={
                                harnessTabs.leadingFavorites
                                  ? PICKER_GROUP_SPACING_CLASS
                                  : section.key === 'supported-models'
                                    ? 'mt-2 border-t pt-2'
                                    : index === 0
                                      ? undefined
                                      : pickerChrome
                                        ? 'mt-4'
                                        : 'mt-1'
                              }
                            >
                              {renderSectionHeader(
                                section,
                                activeHarnessTab !== harness,
                                pickerChrome,
                              )}
                              {section.options
                                .filter(
                                  (option) => option.showMoreOnly !== true,
                                )
                                .map((option) =>
                                  renderHarnessOption(
                                    option,
                                    activeHarnessTab !== harness,
                                    // Credits pay for a model on its own
                                    // harness only.
                                    harnessTabs.credits?.active === true &&
                                      harnessTabs.credits.modelIds.has(
                                        option.id,
                                      ) &&
                                      (option.source ?? option.provider) ===
                                        harness,
                                  ),
                                )}
                              {section.options.some(
                                (option) => option.showMoreOnly === true,
                              ) ? (
                                <NestedMenuFlyout
                                  label="Legacy models"
                                  appearance="disclosure"
                                  keepLeadingSlot={legacyLabelIndent}
                                  triggerTestId={`${testIdPrefix}-more-${section.key}`}
                                  menuTestId={`${testIdPrefix}-more-group-${section.key}`}
                                  containsSelection={
                                    highlightSelection &&
                                    legacyHoldsSelection(section.options)
                                  }
                                  leading={
                                    !highlightSelection &&
                                    legacyHoldsSelection(section.options) ? (
                                      <CheckMark />
                                    ) : null
                                  }
                                  leadingTone="accent"
                                  menuWidth="parent"
                                >
                                  {section.options
                                    .filter(
                                      (option) => option.showMoreOnly === true,
                                    )
                                    .map((option) =>
                                      renderHarnessOption(
                                        option,
                                        activeHarnessTab !== harness,
                                        harnessTabs.credits?.active === true &&
                                          harnessTabs.credits.modelIds.has(
                                            option.id,
                                          ) &&
                                          (option.source ?? option.provider) ===
                                            harness,
                                        true,
                                      ),
                                    )}
                                </NestedMenuFlyout>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ))
                    : null}
                </PickerMenuList>
              )}
              <ModelPickerFooter gap={footerGap}>
                {footer?.({ closeMenu, dismissMenu })}
              </ModelPickerFooter>
            </div>
          </div>
        ) : (
          <>
            {autoRow ? (
              <div className="mb-1 border-b pb-0.5">{autoRow}</div>
            ) : null}
            {workspaceDefaultOption}
            {sections.map((section, index) => (
              <div
                key={section.key}
                role="group"
                aria-label={section.label}
                /*
                 * A hairline between vendors so the heading reads as the start of a
                 * section rather than as another row. Suppressed on the first
                 * section, which needs no rule against the menu's own edge.
                 */
                className={index === 0 ? undefined : 'mt-1 border-t pt-1'}
              >
                {/* Shared group heading (CAN-2540 §3): identical presentation to
                the Harnesses settings page, with the menu's historical test
                id contract preserved in both uniform and per-key modes. */}
                {renderSectionHeader(section)}
                <div>
                  {section.options
                    .filter((option) => option.showMoreOnly !== true)
                    .map((option) => {
                      const state = resolveOptionState(option);
                      return (
                        <ModelPickerOption
                          extraChargeMarker
                          key={option.id}
                          option={option}
                          selected={
                            !autoSelected && option.id === selectedOption?.id
                          }
                          state={state}
                          onSelect={selectOption}
                          detailOpen={
                            detailOptionId === option.id ? detailInput : false
                          }
                          onDetailChange={setOptionDetail}
                          testIdPrefix={testIdPrefix}
                          uniformTestIds={uniformTestIds}
                        />
                      );
                    })}
                  {section.options.some(
                    (option) => option.showMoreOnly === true,
                  ) ? (
                    <NestedMenuFlyout
                      label="Legacy models"
                      appearance="disclosure"
                      keepLeadingSlot={legacyLabelIndent}
                      triggerTestId={`${testIdPrefix}-more-${section.key}`}
                      menuTestId={`${testIdPrefix}-more-group-${section.key}`}
                      containsSelection={
                        highlightSelection &&
                        legacyHoldsSelection(section.options)
                      }
                      leading={
                        !highlightSelection &&
                        legacyHoldsSelection(section.options) ? (
                          <CheckMark />
                        ) : null
                      }
                      leadingTone="accent"
                      // Same CAN-2701 width as the parent menu, so a legacy
                      // label is no more truncated here than in the main list.
                      menuWidth="parent"
                    >
                      {section.options
                        .filter((option) => option.showMoreOnly === true)
                        .map((option) => {
                          const state = resolveOptionState(option);
                          return (
                            <ModelPickerOption
                              extraChargeMarker
                              key={option.id}
                              option={option}
                              selected={
                                !autoSelected &&
                                option.id === selectedOption?.id
                              }
                              state={state}
                              onSelect={selectOption}
                              detailOpen={
                                detailOptionId === option.id
                                  ? detailInput
                                  : false
                              }
                              onDetailChange={setOptionDetail}
                              inFlyout
                              testIdPrefix={testIdPrefix}
                              uniformTestIds={uniformTestIds}
                            />
                          );
                        })}
                    </NestedMenuFlyout>
                  ) : null}
                </div>
              </div>
            ))}
            <ModelPickerFooter gap={footerGap}>
              {footer?.({ closeMenu, dismissMenu })}
            </ModelPickerFooter>
          </>
        ),
      )}
    </div>
  );
}

function ModelPickerFooter({
  gap,
  children,
}: {
  readonly gap?: 'tight';
  readonly children?: ReactNode;
}): JSX.Element | null {
  if (children == null || typeof children === 'boolean') return null;
  return gap === 'tight' ? (
    <div className="pt-1 empty:pt-0">{children}</div>
  ) : (
    <>{children}</>
  );
}

function CheckMark({
  className,
}: {
  readonly className?: string;
}): JSX.Element {
  return (
    <AppCatalogCheckIcon size="sm" className={className} aria-hidden="true" />
  );
}

function FavoriteStar({
  filled = false,
  size = 'sm',
}: {
  readonly filled?: boolean;
  readonly size?: IconSize;
}): JSX.Element {
  return (
    <AppCatalogStarIcon
      size={size}
      exactSize
      fill={filled ? 'currentColor' : 'none'}
      aria-hidden="true"
    />
  );
}

function ModelPickerOption({
  option,
  selected,
  state,
  onSelect,
  detailOpen,
  onDetailChange,
  inFlyout = false,
  testIdPrefix,
  uniformTestIds,
  leadingIcon,
  favorite,
  onToggleFavorite,
  hidden = false,
  isAutoMode = false,
  autoState,
  suppressPointerHover = false,
  pickerChrome = false,
  highlightSelection = false,
  leadingFavorite = false,
  usesAiCredits = option.source === 'ai-gateway' &&
    option.funding !== 'org-gateway',
  extraChargeMarker = false,
  billingPreference,
  billingFallback = true,
  billingHarnessLabel,
  trailingHarness,
  onBillingChange,
  billingOpen = false,
  onBillingOpenChange,
  billingMenuActive = false,
  settingsHarnesses,
  showHarnessControl = false,
  currentHarness,
  onSettingsHarness,
}: {
  readonly showHarnessControl?: boolean;
  readonly settingsHarnesses?: readonly ModelCatalogProvider[];
  readonly currentHarness?: string;
  readonly onSettingsHarness?: (harness: string) => void;
  readonly leadingFavorite?: boolean;
  readonly billingHarnessLabel?: string;
  /** Fixed harness shown as the row's trailing icon (favorites). */
  readonly trailingHarness?: string;
  readonly billingPreference?: ModelBillingPreference;
  /** Show the limits fallback toggle under subscription billing. */
  readonly billingFallback?: boolean;
  readonly onBillingChange?: (next: ModelBillingPreference) => void;
  readonly billingOpen?: boolean;
  readonly onBillingOpenChange?: (open: boolean) => void;
  readonly billingMenuActive?: boolean;
  readonly usesAiCredits?: boolean;
  /** Single-list rows mark AI Credits-only models with `$`, not a label. */
  readonly extraChargeMarker?: boolean;
  readonly option: ModelCatalogOption;
  readonly selected: boolean;
  readonly state: ModelPickerOptionState;
  readonly onSelect: (
    option: ModelCatalogOption,
  ) => ModelPickerSelectionDisposition | void;
  readonly detailOpen: false | 'hover' | 'keyboard';
  readonly onDetailChange: (
    optionId: string,
    source: 'hover' | 'focus',
    next: boolean,
    inFlyout?: boolean,
  ) => void;
  readonly inFlyout?: boolean;
  readonly testIdPrefix: string;
  readonly uniformTestIds: boolean;
  readonly leadingIcon?: ReactNode;
  readonly favorite?: boolean;
  readonly onToggleFavorite?: () => void;
  readonly hidden?: boolean;
  readonly pickerChrome?: boolean;
  readonly isAutoMode?: boolean;
  /** Host Auto routing: why it is unavailable, and whether that has a fix. */
  readonly autoState?: {
    readonly reason?: string;
    readonly actionable: boolean;
  };
  readonly suppressPointerHover?: boolean;
  readonly highlightSelection?: boolean;
}): JSX.Element {
  const hasSettings = Boolean(onBillingChange || settingsHarnesses?.length);
  // The trailing harness icon doubles as the settings trigger when the row
  // has settings; otherwise it is a plain marker.
  const harnessTrigger =
    showHarnessControl ||
    Boolean(trailingHarness && hasSettings && !state.disabled);
  const staticHarness = harnessTrigger ? undefined : trailingHarness;
  // A fixed harness (a native row in All) wins over the tab-derived one.
  const shownHarness = trailingHarness ?? currentHarness;
  const offersBilling = Boolean(billingPreference && onBillingChange);
  const trailingHarnessSlot = harnessTrigger || Boolean(staticHarness);
  const billingTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [focusBillingOnOpen, setFocusBillingOnOpen] = useState(false);
  const tooltipId = useId();
  const reasonId = `${tooltipId}-reason`;
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const [reasonRevealed, setReasonRevealed] = useState(false);
  const lock = activeLock(state);
  const lockLabel = lock?.label?.trim() || undefined;
  const available =
    state.available === true && !state.disabled && !lock && !isAutoMode;
  const visibleDetail = hidden ? false : detailOpen;
  const handleDetailOpenChange = useCallback(
    (next: boolean): void => {
      // A controlled keyboard card still honors the shared tooltip's
      // dismissal (for example, another control claiming the tooltip slot).
      if (!next && visibleDetail === 'keyboard')
        onDetailChange(option.id, 'focus', false, inFlyout);
    },
    [visibleDetail, inFlyout, onDetailChange, option.id],
  );
  // A sign-in label replaces the credits tag: the row cannot run on credits
  // until the user signs in. An available row drops it too; the detail names billing.
  const showsCreditsTag =
    usesAiCredits &&
    !isAutoMode &&
    !extraChargeMarker &&
    !lockLabel &&
    !available;
  const [creditsHovered, setCreditsHovered] = useState(false);
  const [creditsFocused, setCreditsFocused] = useState(false);
  const creditsTooltipActive =
    showsCreditsTag && (creditsHovered || creditsFocused);
  const hasExtraCharge = option.extraChargeOnly === true;
  const hasDescription = Boolean(option.description);
  const lockHintId = `${tooltipId}-unlock`;
  const showReasonInTooltip =
    state.unavailableReason !== undefined && !reasonRevealed;
  /*
   * CAN-2701: the detail layer also carries the context window — real
   * information for some users, but not the model's identity, so it belongs
   * neither in the trigger nor in the row.
   */
  const contextWindowLabel = formatModelContextWindow(option.contextWindow);
  const hasTooltipContent =
    hasExtraCharge ||
    hasDescription ||
    showReasonInTooltip ||
    lock !== undefined ||
    contextWindowLabel !== undefined;
  const tooltipVisible =
    hasTooltipContent &&
    visibleDetail &&
    !creditsTooltipActive &&
    !billingMenuActive;

  useEffect((): void => {
    setReasonRevealed(false);
  }, [state.disabled, state.unavailableReason]);

  const trailingSlots: PickerMenuOptionTrailingSlots = leadingFavorite
    ? trailingHarnessSlot
      ? 'one'
      : hasSettings && !state.disabled
        ? billingOpen || selected
          ? 'one'
          : 'one-on-row-hover'
        : 'none'
    : trailingHarnessSlot
      ? 'two'
      : hasSettings && !state.disabled
        ? billingOpen || selected
          ? 'two'
          : 'two-on-row-hover'
        : onToggleFavorite
          ? 'one'
          : 'none';
  const describedBy = state.disabled
    ? tooltipVisible
      ? `${reasonId} ${tooltipId}`
      : reasonId
    : [lock ? lockHintId : undefined, tooltipVisible ? tooltipId : undefined]
        .filter(Boolean)
        .join(' ') || undefined;
  const lockGlyph = (
    <Lock
      width={PICKER_ROW_GLYPH_SIZE}
      height={PICKER_ROW_GLYPH_SIZE}
      aria-hidden="true"
      className="shrink-0 fg-secondary"
      data-testid={
        uniformTestIds
          ? `${testIdPrefix}-option-unlock`
          : `${testIdPrefix}-option-unlock-${option.id}`
      }
    />
  );

  return (
    <>
      <RichHoverTooltip
        id={tooltipId}
        open={
          visibleDetail === 'keyboard'
            ? true
            : visibleDetail
              ? undefined
              : false
        }
        onOpenChange={handleDetailOpenChange}
        openDelay={200}
        suppressed={billingMenuActive}
        suppressPointerHover={suppressPointerHover}
        content={
          creditsTooltipActive || isAutoMode ? (
            <span className="block w-40 text-xs font-normal">
              {creditsTooltipActive
                ? 'This model uses your AI credit balance.'
                : (autoState?.reason ??
                  'Auto picks the best model for each message')}
            </span>
          ) : (
            <ModelRowDetail
              option={option}
              usesAiCredits={usesAiCredits}
              harness={staticHarness ?? currentHarness}
              showsHarness={trailingHarnessSlot}
              lockHint={lock?.hint}
            />
          )
        }
        dataTestId={
          creditsTooltipActive
            ? `${testIdPrefix}-credits-detail-${option.id}`
            : uniformTestIds
              ? `${testIdPrefix}-option-detail`
              : `${testIdPrefix}-option-detail-${option.id}`
        }
        tone="inverse"
        preferRightPlacement
        disabled={!pickerChrome || state.disabled || hidden === true}
        triggerWrapperClassName={highlightSelection ? 'mb-px w-full' : 'w-full'}
        surfaceClassName="w-max min-w-44 max-w-56"
        surfacePadding="relaxed"
      >
        <div
          className={`group/model-row relative w-full rounded-md ${highlightSelection && selected ? 'bg-subtle' : ''}`}
        >
          <PickerMenuOption
            ref={rowRef}
            hidden={hidden}
            // An Auto row whose reason has a fix is a command, not a choice.
            // So is a locked row: activating it starts recovery.
            role={autoState?.actionable || lock ? 'menuitem' : 'menuitemradio'}
            aria-checked={autoState?.actionable || lock ? undefined : selected}
            data-locked={lock ? 'true' : undefined}
            data-available={available ? 'true' : undefined}
            aria-disabled={
              state.disabled ? true : uniformTestIds ? false : undefined
            }
            aria-describedby={describedBy}
            selected={selected}
            data-testid={
              uniformTestIds
                ? // Auto keeps the flat layout's hook; it has no model id.
                  isAutoMode
                  ? `${testIdPrefix}-option-auto`
                  : `${testIdPrefix}-option`
                : `${testIdPrefix}-option-${option.id}`
            }
            // Host Auto is a selection mode, not a model.
            data-model-id={option.id === AUTO_ROW_ID ? undefined : option.id}
            onMouseEnter={(): void => onDetailChange(option.id, 'hover', true)}
            onMouseMove={
              detailOpen
                ? undefined
                : (): void => onDetailChange(option.id, 'hover', true)
            }
            onMouseLeave={(): void => onDetailChange(option.id, 'hover', false)}
            onFocus={(): void =>
              onDetailChange(option.id, 'focus', true, inFlyout)
            }
            onBlur={(): void =>
              onDetailChange(option.id, 'focus', false, inFlyout)
            }
            onMouseDown={(event): void => event.preventDefault()}
            onClick={(event): void => {
              if (state.disabled) {
                event.preventDefault();
                setReasonRevealed(true);
                return;
              }
              const disposition = onSelect(option);
              if (disposition === 'dismiss') event.preventDefault();
            }}
            unavailable={state.disabled}
            trailingSlots={trailingSlots}
            rowHoverSurface={Boolean(onToggleFavorite) && !state.disabled}
          >
            {leadingFavorite ? (
              <span aria-hidden="true" className="size-4 shrink-0" />
            ) : selected && pickerChrome && !highlightSelection ? (
              <PickerMenuOptionLeading tone="accent">
                <PickerMenuOptionCheck selected />
              </PickerMenuOptionLeading>
            ) : (
              <PickerMenuOptionLeading
                tone={selected && !pickerChrome ? 'accent' : 'tertiary'}
                style={
                  highlightSelection && selected && pickerChrome
                    ? {
                        color: isAutoMode
                          ? 'var(--fg-accent)'
                          : selectedModelIconColor(option),
                      }
                    : undefined
                }
              >
                {leadingIcon ??
                  (selected && !highlightSelection ? <CheckMark /> : null)}
              </PickerMenuOptionLeading>
            )}
            <PickerMenuOptionContent
              className={reasonRevealed ? '!overflow-visible' : ''}
            >
              <PickerMenuOptionLabel
                data-testid={
                  uniformTestIds
                    ? `${testIdPrefix}-option-label`
                    : `${testIdPrefix}-option-label-${option.id}`
                }
                tone={!state.disabled && !pickerChrome ? 'quiet' : 'inherit'}
              >
                {isAutoMode ? (
                  <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
                    <span className="shrink-0">{option.label}</span>{' '}
                    <span
                      className="min-w-0 truncate text-right text-2xs fg-tertiary"
                      data-testid="model-picker-auto-subtitle"
                    >
                      {autoState?.reason ?? MODEL_PICKER_AUTO_DESCRIPTION}
                    </span>
                  </span>
                ) : option.provider === 'cursor' &&
                  option.id === 'cursor-default' ? (
                  'Default'
                ) : (
                  option.label
                )}
              </PickerMenuOptionLabel>
              {state.disabled ? (
                <span
                  id={reasonId}
                  data-testid={
                    uniformTestIds
                      ? undefined
                      : `${testIdPrefix}-option-locked-${option.provider}`
                  }
                  className={
                    reasonRevealed
                      ? 'mt-0.5 block whitespace-normal text-3xs leading-snug fg-secondary'
                      : 'sr-only'
                  }
                >
                  {state.unavailableReason ?? 'unavailable'}
                </span>
              ) : null}
            </PickerMenuOptionContent>
            {autoState?.actionable ? (
              // The hint sits on the label's baseline, 1px under the row's
              // center; the 2px top margin moves the arrow's center there.
              <ArrowUpRightIcon
                size="sm"
                className="mt-0.5 shrink-0 fg-tertiary"
                data-testid={`${testIdPrefix}-option-auto-action-icon`}
              />
            ) : null}
            {showsCreditsTag ? (
              <span
                className="-mx-2 -my-2 inline-flex shrink-0 items-center self-stretch px-2 py-2"
                data-testid={`${testIdPrefix}-credits-area-${option.id}`}
                onMouseEnter={(): void => setCreditsHovered(true)}
                onMouseLeave={(): void => setCreditsHovered(false)}
                onFocusCapture={(): void => setCreditsFocused(true)}
                onBlurCapture={(): void => setCreditsFocused(false)}
              >
                <span
                  className="shrink-0 text-2xs fg-secondary"
                  data-testid={`${testIdPrefix}-row-credits-${option.id}`}
                >
                  {AI_CREDITS_LABEL}
                </span>
              </span>
            ) : null}
            {lock && lockLabel ? (
              // Same slot, type and padding as the credits tag it replaces.
              // The lock's hint already names the remedy for assistive
              // technology, so the visible label is not read twice.
              <span
                aria-hidden="true"
                className="-mx-2 -my-2 inline-flex shrink-0 items-center self-stretch px-2 py-2"
              >
                <span
                  className="shrink-0 text-2xs fg-secondary"
                  data-testid={
                    uniformTestIds
                      ? `${testIdPrefix}-option-lock-label`
                      : `${testIdPrefix}-option-lock-label-${option.id}`
                  }
                >
                  {lockLabel}
                </span>
              </span>
            ) : null}
            {extraChargeMarker && hasExtraCharge ? (
              <span
                data-testid={
                  uniformTestIds
                    ? `${testIdPrefix}-option-extra-charge`
                    : `${testIdPrefix}-option-extra-charge-${option.id}`
                }
                className={`${EXTRA_CHARGE_TEXT_CLASS} shrink-0 font-mono text-2xs font-semibold leading-none`}
                aria-label="AI Credits only"
              >
                $
              </span>
            ) : null}
            {/* CAN-5213: the state cue renders last, its icon after its
                label, so locks and checks line up in one column beside the
                harness icon. */}
            {lock ? (
              <>
                <span id={lockHintId} className="sr-only">
                  {lock.hint}
                </span>
                {/* A labelled lock shows only its label, in the credits tag's
                    slot above; a bare lock keeps the glyph. */}
                {lockLabel ? null : lockGlyph}
              </>
            ) : null}
          </PickerMenuOption>
          {state.disabled ? (
            <span aria-live="polite" className="sr-only">
              {reasonRevealed ? (state.unavailableReason ?? 'unavailable') : ''}
            </span>
          ) : null}
          {staticHarness ? (
            <span
              role="img"
              hidden={hidden}
              aria-label={`Runs on ${runnableHarnessLabel(staticHarness) ?? staticHarness}`}
              data-testid={`${testIdPrefix}-harness-icon-${option.id}`}
              data-harness={staticHarness}
              className={`absolute ${leadingFavorite ? 'right-0.5' : 'right-7.5'} top-1/2 flex size-7 -translate-y-1/2 items-center justify-center fg-tertiary`}
            >
              <ModelProviderIcon
                provider={staticHarness}
                central
                size="sm"
                exactSize
              />
            </span>
          ) : null}
          {harnessTrigger ? (
            <Button
              ref={billingTriggerRef}
              variant="ghost-quiet"
              size="sm"
              iconOnly
              touchArea="contained"
              hidden={hidden}
              aria-label={
                settingsHarnesses?.length
                  ? `Harness for ${option.label}: ${shownHarness}`
                  : `Billing for ${option.label}`
              }
              aria-haspopup="menu"
              aria-expanded={billingOpen}
              data-testid={`${testIdPrefix}-harness-control-${option.id}`}
              data-harness={shownHarness}
              data-billing-menu={offersBilling ? 'true' : undefined}
              onMouseDown={(event): void => event.preventDefault()}
              onClick={(event): void => {
                event.stopPropagation();
                setFocusBillingOnOpen(event.detail === 0);
                onBillingOpenChange?.(!billingOpen);
              }}
              className={`absolute z-1 ${leadingFavorite ? 'right-0.5' : 'right-7.5'} top-1/2 -translate-y-1/2`}
            >
              <span
                className={
                  billingOpen
                    ? 'hidden'
                    : 'group-hover/model-row:hidden group-focus-within/model-row:hidden [@media(hover:none)]:hidden'
                }
              >
                <ModelProviderIcon
                  provider={shownHarness ?? option.provider}
                  central
                  size="sm"
                  exactSize
                />
              </span>
              <span
                className={
                  billingOpen
                    ? 'inline-flex'
                    : 'hidden group-hover/model-row:inline-flex group-focus-within/model-row:inline-flex [@media(hover:none)]:inline-flex'
                }
              >
                <MoreHorizontalIcon size="sm" exactSize />
              </span>
            </Button>
          ) : null}
          {hasSettings && !harnessTrigger && !state.disabled ? (
            // The wrapper places the trigger and reveals it with the row's
            // hover or focus; the Button keeps its own paint.
            <span
              className={`absolute z-1 ${leadingFavorite && !harnessTrigger ? 'right-0.5' : 'right-7.5'} top-1/2 flex -translate-y-1/2 group-hover/model-row:opacity-100 group-focus-within/model-row:opacity-100 [@media(hover:none)]:opacity-100 ${billingOpen || selected ? 'opacity-100' : 'opacity-0'}`}
            >
              <Button
                ref={billingTriggerRef}
                variant="ghost-quiet"
                size="sm"
                iconOnly
                touchArea="contained"
                aria-label={`${settingsHarnesses?.length ? 'Settings' : 'Billing'} for ${option.label}`}
                aria-haspopup="menu"
                aria-expanded={billingOpen}
                hidden={hidden}
                data-testid={`${testIdPrefix}-billing-${option.id}`}
                data-billing-menu={offersBilling ? 'true' : undefined}
                onMouseDown={(event): void => event.preventDefault()}
                onClick={(event): void => {
                  event.preventDefault();
                  event.stopPropagation();
                  setFocusBillingOnOpen(event.detail === 0);
                  onBillingOpenChange?.(!billingOpen);
                }}
              >
                <MoreHorizontalIcon size="sm" exactSize />
              </Button>
            </span>
          ) : null}
          {/* The star sits against the row's triggers, its label and the rows
              above and below, so its touch hit area stays its own box. */}
          {onToggleFavorite ? (
            <Button
              variant="ghost-quiet"
              size="sm"
              iconOnly
              touchArea="contained"
              aria-label={`${favorite ? 'Remove' : 'Add'} ${option.label} ${favorite ? 'from' : 'to'} favorites`}
              hidden={hidden}
              role="menuitemcheckbox"
              aria-checked={favorite === true}
              data-testid={`${testIdPrefix}-favorite-${option.id}`}
              onMouseDown={(event): void => event.preventDefault()}
              onClick={(event): void => {
                event.preventDefault();
                event.stopPropagation();
                onToggleFavorite();
              }}
              className={`absolute ${leadingFavorite ? 'left-0.5' : 'right-0.5'} top-1/2 -translate-y-1/2`}
            >
              <FavoriteStar filled={favorite === true} />
            </Button>
          ) : null}
        </div>
      </RichHoverTooltip>
      {/* Other tabs keep hidden copies of a row under the same menu key; only
          the visible copy may open its menu. */}
      {billingOpen && hasSettings && !hidden ? (
        <FloatingMenu
          open
          nested
          anchorRef={billingTriggerRef}
          focusOnOpen={focusBillingOnOpen}
          placement="bottom-right"
          onOpenChange={(next): void => onBillingOpenChange?.(next)}
          closeOnSelect={false}
          aria-label={`${settingsHarnesses?.length ? 'Settings' : 'Billing'} for ${option.label}`}
          data-testid={`${testIdPrefix}-billing-menu-${option.id}`}
          // 11.5rem is the narrowest width that fits "Claude subscription",
          // "Cursor subscription" or "Codex subscription" with its check, and
          // the Harness menu shares it. Only the fallback toggle's two-line
          // label needs the wider surface.
          className={
            billingPreference && onBillingChange && billingFallback
              ? 'w-56'
              : 'w-46'
          }
        >
          {settingsHarnesses?.length ? (
            <>
              <p className="px-2 py-1 text-xs fg-tertiary">Harness</p>
              {settingsHarnesses.map((harness) => (
                <DropdownMenuItem
                  key={harness}
                  role="menuitemradio"
                  aria-checked={currentHarness === harness}
                  data-testid={`${testIdPrefix}-settings-harness-${harness}-${option.id}`}
                  onClick={(): void => onSettingsHarness?.(harness)}
                  className="flex items-center justify-between"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-4 shrink-0 items-center justify-center fg-tertiary"
                  >
                    <ModelProviderIcon provider={harness} central size="md" />
                  </span>
                  <span className="min-w-0 flex-1">
                    {harness === 'claude'
                      ? 'Claude'
                      : getModelCatalogProviderLabel(harness)}
                  </span>
                  {currentHarness === harness ? (
                    <PickerMenuOptionCheck selected />
                  ) : null}
                </DropdownMenuItem>
              ))}
              {billingPreference && onBillingChange ? (
                <div role="separator" className="mx-2 my-1 h-px bg-line-base" />
              ) : null}
            </>
          ) : null}
          {billingPreference && onBillingChange ? (
            <>
              <p className="px-2 py-1 text-xs fg-tertiary">Usage billing</p>
              {(['subscription', 'credits'] as const).map((payment) => (
                <DropdownMenuItem
                  key={payment}
                  role="menuitemradio"
                  aria-checked={billingPreference.payment === payment}
                  data-testid={`${testIdPrefix}-billing-${payment}-${option.id}`}
                  onClick={(): void =>
                    onBillingChange({ ...billingPreference, payment })
                  }
                  className="flex items-center justify-between"
                >
                  {payment === 'subscription'
                    ? isAutoMode
                      ? 'Subscription'
                      : `${billingHarnessLabel ?? getModelCatalogProviderLabel(option.provider)} subscription`
                    : 'AI Credits'}
                  {billingPreference.payment === payment ? (
                    <PickerMenuOptionCheck selected />
                  ) : null}
                </DropdownMenuItem>
              ))}
              {billingFallback &&
              billingPreference.payment === 'subscription' ? (
                <>
                  <div
                    role="separator"
                    className="mx-2 my-1 h-px bg-line-base"
                  />
                  <DropdownMenuItem
                    role="menuitemcheckbox"
                    aria-checked={billingPreference.fallback}
                    data-testid={`${testIdPrefix}-billing-fallback-${option.id}`}
                    onClick={(): void =>
                      onBillingChange({
                        ...billingPreference,
                        fallback: !billingPreference.fallback,
                      })
                    }
                    multiline
                    className="group"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-6 whitespace-normal">
                      <span className="min-w-0 flex-1 text-pretty text-xs leading-snug">
                        Use AI Credits when limits are reached
                      </span>
                      <CompactToggleIndicator
                        checked={billingPreference.fallback}
                      />
                    </span>
                  </DropdownMenuItem>
                </>
              ) : null}
            </>
          ) : null}
        </FloatingMenu>
      ) : null}
      {tooltipVisible && !pickerChrome && rowRef.current ? (
        <RichHoverCard
          anchorRef={rowRef}
          placement="beside-menu"
          id={tooltipId}
          role="tooltip"
          dataTestId={`${testIdPrefix}-option-detail`}
          tone="inverse"
          surfacePadding="relaxed"
          surfaceClassName="w-64 whitespace-normal"
        >
          {/* Quieter lines dim the inverse ink, as ModelRowDetail does:
              fg-secondary is too faint on the inverse surface. */}
          {/* The row already describes itself with this hint. */}
          {lock || hasExtraCharge || hasDescription ? (
            <Stack gap="tight">
              {lock ? (
                <div aria-hidden="true" className="text-xs leading-snug">
                  {lock.hint}
                </div>
              ) : null}
              {hasExtraCharge ? (
                <div className="text-xs leading-snug">
                  <div>Extra charge only</div>
                  {option.extraChargeMessage ? (
                    <div className="mt-0.5 opacity-70">
                      {option.extraChargeMessage}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {hasDescription ? (
                <div
                  data-testid={
                    uniformTestIds
                      ? `${testIdPrefix}-option-tooltip-description`
                      : `${testIdPrefix}-option-tooltip-description-${option.id}`
                  }
                  className={`text-xs leading-snug${hasExtraCharge || lock ? ' opacity-70' : ''}`}
                >
                  {option.description}
                </div>
              ) : null}
            </Stack>
          ) : null}
          {contextWindowLabel ? (
            <div
              className="text-xs leading-snug mt-1 opacity-70"
              data-testid={`${testIdPrefix}-option-context-window`}
            >
              {contextWindowLabel} context
            </div>
          ) : null}
          {showReasonInTooltip ? (
            <div
              className="text-xs leading-snug mt-1 opacity-70"
              data-testid={
                uniformTestIds
                  ? undefined
                  : `${testIdPrefix}-unavailable-tooltip`
              }
            >
              {state.unavailableReason}
            </div>
          ) : null}
        </RichHoverCard>
      ) : null}
    </>
  );
}
