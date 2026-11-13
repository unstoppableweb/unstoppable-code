import type { CSSProperties, JSX, ReactNode, Ref } from 'react';
import {
  ChatComposerOverflowMenu,
  type ChatComposerOverflowMenuProps,
} from './ChatComposerOverflowMenu';
import { FoldReveal } from './FoldReveal';
import { Tooltip } from './Tooltip';

export type ChatComposerToolbarChipActiveTone =
  | 'default'
  | 'warning'
  | 'accent'
  | 'status-active';

const ACTIVE_TONE_CLASS_NAMES: Record<
  ChatComposerToolbarChipActiveTone,
  string
> = {
  default: 'hover:bg-subtle',
  warning: 'bg-warning-subtle fg-warning hover:bg-warning-subtle',
  accent: 'bg-accent-subtle fg-accent-strong hover:bg-accent-subtle',
  // Something running on the chat's behalf (its watchers).
  'status-active': 'bg-info-subtle fg-info hover:bg-info-subtle',
};

/**
 * Controlled-component contract for a single composer chip (plugins, model,
 * plan, fast, thinking). The chip is purely presentational: the host owns the
 * state and passes the resolved `active` value plus an `onClick`. Desktop-only
 * rich controls (the model dropdown, the thinking cycler, the usage popover)
 * are handed to the toolbar as {@link ChatComposerToolbarProps} slots instead,
 * so ui-shared never learns about their store-driven internals.
 */
export interface ChatComposerToolbarChipConfig {
  /** Ref to the underlying button for anchored popup ownership. */
  buttonRef?: Ref<HTMLButtonElement>;
  /** Visual geometry. `capsule` matches the roomier 32px desktop composer. */
  variant?: 'chip' | 'capsule';
  /** Leading glyph. Sized by the caller so each surface keeps its own icon. */
  icon: ReactNode;
  /**
   * Optional trailing label. Omit it (rather than passing `''`) to render the
   * icon-only chip the desktop composer uses in its compact rail and the portal
   * uses for an idle plan/thinking chip.
   */
  label?: string;
  /** Ref to the label span, for hosts that measure whether it is clipped. */
  labelRef?: Ref<HTMLSpanElement>;
  /** Optional trailing adornment (caret, thinking dots). */
  trailing?: ReactNode;
  /** Active/selected treatment — swaps the idle muted text for active colors. */
  active?: boolean;
  /**
   * Ink and surface while `active`. `default` keeps the surrounding ink and
   * only the hover surface; `warning` is the plan and effort chips' amber
   * fill; `accent` is the onboarding highlight on the Home plan chip.
   */
  activeTone?: ChatComposerToolbarChipActiveTone;
  /** Inline style applied only while `active` (brand-specific chip gradients). */
  activeStyle?: CSSProperties;
  disabled?: boolean;
  onClick?: () => void;
  /**
   * Hover/focus help, rendered through the rich {@link Tooltip} rather than a
   * native `title` attribute — native tooltips lag noticeably on macOS
   * (CAN-2799). Omit it for chips whose label already explains them.
   */
  title?: string;
  /** Hover delay for {@link title}; `long` waits a second like the other status-row selectors. */
  tooltipDelay?: 'none' | 'long';
  ariaLabel: string;
  /**
   * `aria-pressed` for toggle chips (fast-mode today). Omit for non-toggle
   * chips (plugins, model) so their rendered markup is unchanged.
   */
  ariaPressed?: boolean;
  /**
   * `aria-haspopup` for chips that open a popup surface (the portal directory
   * picker's listbox trigger). Omit for plain chips so their markup is
   * unchanged.
   */
  ariaHasPopup?: boolean | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog';
  /** `aria-expanded` for popup-trigger chips; paired with {@link ariaHasPopup}. */
  ariaExpanded?: boolean;
  /** `aria-controls` relationship for the controlled popup while it is open. */
  ariaControls?: string;
  /**
   * Extra classes for the label `<span>`. Omit it (rather than passing `''`) so
   * plain chips render unchanged; the portal uses it to truncate the model chip
   * label on the narrow mobile toolbar (CAN-1229).
   */
  labelClassName?: string;
  /**
   * Capsule only. Keeps the label mounted and folds it away when `true`, so a
   * toggle can grow its label in and fold it out in one motion (width and
   * fade together) instead of popping. Folded, the capsule is a 32px circle.
   */
  labelCollapsed?: boolean;
  /**
   * Description relationship injected by tooltip-style wrappers.
   * Kept explicit so the primitive stays closed over the attributes it renders.
   */
  'aria-describedby'?: string;
  dataTestId?: string;
}

export interface ChatComposerToolbarProps {
  /** Exposes fixed controls for hosts measuring a staged editor at inline width. */
  measureInline?: boolean;
  /**
   * Uses the roomier capsule-composer spacing: a padded row, a zero-gap
   * clipped left rail with 4px between effort and context usage, and an 8px
   * trailing cluster. Compact capsule layouts omit context instead of
   * scrolling. The desktop main chat uses this to match the New Task composer;
   * portal callers retain the chip layout.
   */
  capsuleLayout?: boolean;
  /**
   * Compact rail: tightens the outer row and left-rail gaps. Desktop drives
   * this from its measured width; the portal leaves it off.
   */
  compact?: boolean;
  /**
   * Mobile single-row compaction (CAN-1229). When set, the plan/fast/thinking
   * controls collapse into a `⋯` overflow menu rendered in the left rail (after
   * the model control) and the outer row becomes `flex-nowrap` with a tighter
   * right-cluster gap, so the whole toolbar stays on one row at phone widths.
   * The portal enables it below `lg`; desktop never passes it, so the desktop
   * render path is byte-identical. When set, the caller stops passing the
   * inline `planMode`/`fastMode`/`thinking` chip configs.
   */
  overflowMenu?: ChatComposerOverflowMenuProps;
  /**
   * One-line composer: the row box steps aside (`display: contents`) so the
   * leading action, the rail and the trailing cluster become items of the
   * host's own flex row, around the editor the host orders between them
   * (leading 1, rail 2, editor 3, trailing 4). The host owns that row.
   */
  inline?: boolean;
  /** Forwarded as `data-testid` on the outer control row (E2E layout gates). */
  dataTestId?: string;
  /** Forwarded to the outer control-row element (desktop overflow measuring). */
  rowRef?: Ref<HTMLDivElement>;
  /**
   * When set, the left rail renders inside desktop's overflow-scroller wrapper
   * (`relative` positioning host for the gradient scroll buttons) and forwards
   * this ref to the scrollable inner rail. Omit it (portal) to render the bare
   * scroll container with no wrapper.
   */
  leftRailRef?: Ref<HTMLDivElement>;
  /** Desktop left-edge gradient scroll button (rendered inside the wrapper). */
  overflowLeftSlot?: ReactNode;
  /** Desktop right-edge gradient scroll button (rendered inside the wrapper). */
  overflowRightSlot?: ReactNode;

  /**
   * Fixed leading action outside the overflow rail. The capsule composer puts
   * its raised `+` here so the scroller cannot clip the trigger's shadow.
   */
  leadingSlot?: ReactNode;

  // ── Left rail (rendered in this order) ──────────────────────────────────
  /** Desktop multi-repo directory picker (already wrapped by the caller). */
  directorySlot?: ReactNode;
  /** Plugins chip. Ignored when {@link pluginsSlot} is provided. */
  plugins?: ChatComposerToolbarChipConfig;
  /**
   * Rich plugins selector (portal), overriding the {@link plugins} chip — a
   * self-contained trigger chip + selector surface. Mirrors {@link modelSlot}.
   */
  pluginsSlot?: ReactNode;
  /** Model chip (portal). Ignored when {@link modelSlot} is provided. */
  model?: ChatComposerToolbarChipConfig;
  /** Desktop model dropdown, overriding the {@link model} chip. */
  modelSlot?: ReactNode;
  /** Desktop per-chat tool-approval-mode dropdown (`ApprovalModePicker`), rendered as a sibling of {@link planMode}. */
  approvalModeSlot?: ReactNode;
  /** Plan-mode toggle chip. */
  planMode?: ChatComposerToolbarChipConfig;
  /** Desktop scheduled-send chip, after the Plan chip beside the leading +. */
  scheduledSendSlot?: ReactNode;
  /** Desktop chat watchers chip, after the scheduled send. */
  watchersSlot?: ReactNode;
  /** Fast-mode toggle chip. */
  fastMode?: ChatComposerToolbarChipConfig;
  /** Thinking-level chip (portal). Ignored when {@link thinkingSlot} is set. */
  thinking?: ChatComposerToolbarChipConfig;
  /** Desktop thinking-level cycler, overriding the {@link thinking} chip. */
  thinkingSlot?: ReactNode;
  /** Desktop usage indicator (already wrapped by the caller). */
  usageSlot?: ReactNode;

  // ── Right rail (rendered in this order) ─────────────────────────────────
  /** Desktop "Terminal Mode" label. */
  terminalLabelSlot?: ReactNode;
  /** Attach-files control. */
  attachSlot?: ReactNode;
  /** Voice-dictation control (desktop). */
  voiceSlot?: ReactNode;
  /** Commands/Skills button + popup (each surface owns its exact wiring). */
  commandsSlot?: ReactNode;
  /** Share-session control (desktop). */
  shareSlot?: ReactNode;
  /** Schedule-message control (desktop). */
  scheduleSlot?: ReactNode;
  /** Chat-interface mode toggle (desktop). */
  interfaceToggleSlot?: ReactNode;
  /** Trailing send / stop / terminal-send control. */
  trailingSlot?: ReactNode;
}

/**
 * Presentational composer control row shared by the desktop renderer and the
 * web portal (CAN-1215). It owns the row/rail container structure, the compact
 * gap logic, the overflow-scroller wrapper, control ordering, and the shared
 * chip primitive — so the composer's visual identity is locked structurally in
 * one place. Everything else (the model dropdown, thinking cycler, usage
 * popover, voice/share/schedule/interface controls, the Commands popup, and the
 * trailing send/stop button) is passed in as a slot, keeping the toolbar free
 * of stores, `window.*`, Electron, and Next imports.
 */
export function ChatComposerToolbar({
  measureInline = false,
  capsuleLayout = false,
  compact = false,
  inline = false,
  overflowMenu,
  dataTestId,
  rowRef,
  leftRailRef,
  overflowLeftSlot,
  overflowRightSlot,
  leadingSlot,
  directorySlot,
  plugins,
  pluginsSlot,
  model,
  modelSlot,
  approvalModeSlot,
  planMode,
  scheduledSendSlot,
  watchersSlot,
  fastMode,
  thinking,
  thinkingSlot,
  usageSlot,
  terminalLabelSlot,
  attachSlot,
  voiceSlot,
  commandsSlot,
  shareSlot,
  scheduleSlot,
  interfaceToggleSlot,
  trailingSlot,
}: ChatComposerToolbarProps): JSX.Element {
  const railContents = (
    <>
      {directorySlot}
      {/* Slot wins over the chip config when provided (see `modelSlot` note). */}
      {pluginsSlot !== undefined ? (
        pluginsSlot
      ) : plugins ? (
        <ChatComposerToolbarChip {...plugins} />
      ) : null}
      {/* Slot wins over the chip config when provided. Use an explicit
          `!== undefined` check (not `??`) so a caller can pass an explicit
          `modelSlot={null}` to suppress the control entirely even when a chip
          config is also present — `null` is a valid "render nothing" node. */}
      {modelSlot !== undefined ? (
        modelSlot
      ) : model ? (
        <ChatComposerToolbarChip {...model} />
      ) : null}
      {approvalModeSlot}
      {planMode ? <ChatComposerToolbarChip {...planMode} /> : null}
      {scheduledSendSlot}
      {watchersSlot}
      {fastMode ? <ChatComposerToolbarChip {...fastMode} /> : null}
      {thinkingSlot !== undefined ? (
        thinkingSlot
      ) : thinking ? (
        <ChatComposerToolbarChip {...thinking} />
      ) : null}
      {capsuleLayout && !compact && usageSlot ? (
        <div className="ml-1 shrink-0">{usageSlot}</div>
      ) : !capsuleLayout ? (
        usageSlot
      ) : null}
    </>
  );

  // Capsule chips beside + (Plan, a scheduled send, watchers) sit the row's
  // 8px apart.
  const innerRailClassName = inline
    ? 'scrollbar-hide order-2 flex shrink-0 items-center gap-2 empty:hidden'
    : capsuleLayout
      ? // In the two-row box the chips wrap rather than clip when a narrow
        // box cannot hold them all on one line.
        'scrollbar-hide flex min-w-0 flex-1 flex-wrap items-center overflow-hidden gap-2'
      : `scrollbar-hide flex min-w-0 flex-1 items-center overflow-x-auto ${
          compact ? 'basis-full gap-1 sm:basis-0' : 'gap-3'
        }`;

  // Desktop forwards `leftRailRef` (and optionally the gradient scroll
  // buttons), so wrap the scroll container in the `relative` overflow host.
  // The portal forwards neither and renders the bare scroll container.
  const leftRail =
    leftRailRef || overflowLeftSlot || overflowRightSlot ? (
      <div className="relative flex min-w-0 flex-1 items-center">
        {overflowLeftSlot}
        <div
          ref={leftRailRef}
          data-composer-toolbar-rail
          data-composer-inline-rail={measureInline || undefined}
          className={innerRailClassName}
        >
          {railContents}
        </div>
        {overflowRightSlot}
      </div>
    ) : (
      <div
        data-composer-toolbar-rail
        data-composer-inline-rail={measureInline || undefined}
        className={innerRailClassName}
      >
        {railContents}
      </div>
    );

  // The overflow-menu variant (mobile, CAN-1229) and desktop capsule both keep
  // every toolbar control on one row. Desktop callers progressively suppress
  // optional left-rail controls when the capsule cannot fit; portal's regular
  // chip layout retains its existing compact wrapping behavior.
  const outerRowClassName = inline
    ? 'contents'
    : overflowMenu
      ? 'flex items-center justify-between pb-2.5 flex-nowrap gap-1 px-2'
      : capsuleLayout
        ? // Bottom-aligned, so + and send stay on the last line of chips.
          'flex items-end justify-between gap-2 p-2 flex-nowrap'
        : `flex items-center justify-between pb-2.5 ${
            compact ? 'flex-wrap gap-1 px-2' : 'gap-2 px-3'
          }`;
  const rightClusterClassName = inline
    ? 'order-4 flex shrink-0 items-center gap-2'
    : overflowMenu
      ? 'flex shrink-0 items-center gap-1 ml-auto'
      : capsuleLayout
        ? 'flex shrink-0 items-center gap-2'
        : `flex shrink-0 items-center gap-1.5 ${compact ? 'ml-auto' : ''}`;

  return (
    <div ref={rowRef} data-testid={dataTestId} className={outerRowClassName}>
      {leadingSlot}
      {leftRail}
      {/* Mobile: plan/fast/thinking collapse into the `⋯` overflow menu. It is
          rendered OUTSIDE the scrollable left rail (whose `overflow-x-auto`
          computes `overflow-y: auto` and would clip the upward dropdown) so the
          menu paints over the transcript. Desktop never sets `overflowMenu`, so
          this renders nothing and the desktop DOM is unchanged. */}
      {overflowMenu ? <ChatComposerOverflowMenu {...overflowMenu} /> : null}
      <div
        data-composer-inline-fixed={measureInline || undefined}
        className={rightClusterClassName}
      >
        {terminalLabelSlot}
        {attachSlot}
        {voiceSlot}
        {commandsSlot}
        {shareSlot}
        {scheduleSlot}
        {interfaceToggleSlot}
        {trailingSlot}
      </div>
    </div>
  );
}

/**
 * The bottom-row composer chip. The default variant uses the compact
 * `rounded-md px-1.5 py-0.5 text-2xs` shape; the `capsule` variant uses the
 * 32px rounded control shared by the desktop and Home Plan actions. Both keep
 * the same active/idle color contract across composer surfaces.
 *
 * THE TOUCH FLOOR. The compact `chip` shape has no height of its own — it is
 * `py-0.5` around `text-2xs` — so a labelled chip measures around 17px tall. The
 * icon-only composer buttons beside it already clear 44x44 via
 * `h-11 w-11 lg:h-7 lg:w-7`, which is why the gap only ever showed up on the
 * labelled chips: the mobile Playwright run measured `Plugins` at 25x17 and the
 * model picker at 113x17. BOTH axes need the floor, not just height — with only
 * `min-h-11` the same run measured `Plugins` at 29x44, because a chip whose label
 * collapses at narrow widths is an icon in a 29px box. `min-w-11` plus
 * `justify-center` is the pairing `MobileTopBarButton` already uses.
 *
 * KEYED ON POINTER TYPE, NOT ON WIDTH, and that is deliberate. A tablet is a
 * touch device with the same thumb as a phone, so a width-gated floor would fix
 * a 390px viewport and leave a 768px one with a 17px target. `pointer-coarse:` is
 * also the idiom this package already uses for exactly this
 * (`MobileTopBarButton` carries `pointer-coarse:min-h-11 pointer-coarse:min-w-11`,
 * and `ChatTab`'s close button uses the same variant to escape a hover reveal), so
 * this is adopting an established rule rather than inventing a second one. A
 * mouse-driven desktop is untouched, at any window width.
 *
 * The `capsule` variant keeps its 32px height on fine pointers, a deliberate
 * shared geometry with the desktop and Home Plan actions, and takes the same
 * 44px floor on coarse ones: 32px is below the touch minimum. The floor is
 * host-agnostic, so a desktop window on touch hardware gets it too.
 */
/**
 * The coarse-pointer tap floor every composer chip shares: 44px on touch
 * hardware (DESIGN.md), untouched on a mouse. One string so the model picker,
 * the thinking control and the toolbar chip cannot drift apart.
 */
export const CAPSULE_TOUCH_FLOOR_CLASS =
  'pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center';

export function ChatComposerToolbarChip({
  buttonRef,
  variant = 'chip',
  icon,
  label,
  labelRef,
  trailing,
  active = false,
  activeTone = 'default',
  activeStyle,
  disabled = false,
  onClick,
  title,
  tooltipDelay,
  ariaLabel,
  ariaPressed,
  ariaHasPopup,
  ariaExpanded,
  ariaControls,
  labelClassName,
  labelCollapsed,
  'aria-describedby': ariaDescribedBy,
  dataTestId,
}: ChatComposerToolbarChipConfig): JSX.Element {
  // The capsule keeps desktop's 32px contract on fine pointers; on a coarse
  // pointer (the web composer on a phone) it grows to the 44px tap floor like
  // the compact chip, since a 32px control is below the touch minimum.
  const foldable = variant === 'capsule' && labelCollapsed !== undefined;
  const shapeClassName =
    variant === 'capsule'
      ? // An icon-only capsule is a 32px circle, not a padded oval. A
        // foldable capsule keeps 8px sides so it folds to that same circle;
        // its label carries the gap and the extra 2px of end padding.
        `focus-ring h-8 rounded-full text-xs ${
          foldable
            ? 'px-2 duration-200 ease-out'
            : label || trailing
              ? 'gap-1.5 px-2.5'
              : 'w-8 justify-center gap-1.5'
        } ${CAPSULE_TOUCH_FLOOR_CLASS}`
      : `gap-1 rounded-md px-1.5 py-0.5 text-2xs ${CAPSULE_TOUCH_FLOOR_CLASS} pointer-coarse:px-2`;

  const button = (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-describedby={ariaDescribedBy}
      data-testid={dataTestId}
      style={active ? activeStyle : undefined}
      className={`flex shrink-0 items-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${shapeClassName} ${
        active
          ? ACTIVE_TONE_CLASS_NAMES[activeTone]
          : 'fg-secondary hover:bg-subtle hover:fg-primary'
      }`}
    >
      {icon}
      {label && foldable ? (
        <FoldReveal open={!labelCollapsed}>
          <span
            ref={labelRef}
            className={`block pl-1.5 pr-0.5 ${labelClassName ?? ''}`}
          >
            {label}
          </span>
        </FoldReveal>
      ) : (
        label && (
          <span ref={labelRef} className={labelClassName}>
            {label}
          </span>
        )
      )}
      {trailing}
    </button>
  );

  if (!title) {
    return button;
  }
  // The wrapper is `inline-flex shrink-0`, so the chip stays a single-row
  // participant of the capsule rail exactly like the bare button.
  return (
    <Tooltip label={title} delay={tooltipDelay}>
      {button}
    </Tooltip>
  );
}
