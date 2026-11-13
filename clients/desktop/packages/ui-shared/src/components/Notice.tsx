'use client';

import {
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import {
  CircleCheckIcon,
  CloseMediumIcon,
  InfoIcon,
  WarningIcon,
} from '../icons/AppIcons';
import { Button, buttonClassName, isAriaDisabled } from './Button';
import { ReservedLabel } from './LoadingButton';
import { LoadingSpinner } from './LoadingSpinner';
import {
  useNoticeErrorRecording,
  type NoticeErrorChokePoint,
} from './notice-error-recording';

/**
 * The two tiers of action a notice can offer. `primary` is the single
 * recommended next step (accent fill); `secondary` is every alternative, on
 * the house secondary control surface.
 */
export type NoticeButtonVariant = 'primary' | 'secondary';

/**
 * The capsule size of a notice's actions: `sm` (28px) on banners, matching
 * the composer's own capsules; `md` (32px) in a toast, where the buttons have
 * their own row and a larger target; `compact` (28px with the 13px label) on
 * a settings page, matching the page's own buttons.
 */
export type NoticeButtonSize = 'sm' | 'md' | 'compact';

const NoticeButtonSizeContext = createContext<NoticeButtonSize>('sm');

/**
 * Class string for a notice action rendered by something that is not a
 * `<button>` of ours (a shared CTA that takes a class, an anchor): the shared
 * `Button` capsule at its 28px size, so a banner's actions match the
 * composer's own capsules (queued-message Cancel and Save).
 */
export function noticeButtonClassName(
  variant: NoticeButtonVariant = 'secondary',
  className = '',
  size: NoticeButtonSize = 'sm',
): string {
  // The same placement `NoticeButton` gives its `Button`: never wider than
  // its row, the label on one line (a narrow notice moves its buttons under
  // the copy instead). The capsule's own height and inset apply unchanged.
  return buttonClassName({
    variant,
    size,
    className: `max-w-full whitespace-nowrap ${className}`,
  });
}

export interface NoticeButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: NoticeButtonVariant;
  /**
   * Optional leading glyph, spaced from the label by the button itself so
   * peer actions that carry icons (a toast's Copy link and Open) line up.
   */
  icon?: ReactNode;
  /**
   * The work this button started is still running. Only the loader is
   * visible; the capsule keeps the width of its resting label and glyph.
   * No extra room is reserved for the loader or the busy label.
   * The button keeps an accessible name, announces `aria-busy` and stops
   * taking presses until the work finishes.
   */
  busy?: boolean;
  /** Screen-reader label while busy. Defaults to the resting label. */
  busyLabel?: ReactNode;
}

/**
 * The action control inside a `Notice`: the shared `Button` capsule, 28px on
 * a banner and 32px in a toast (the `Notice` sets the size for its actions).
 * Order the alternatives first and the single `primary` last.
 */
export const NoticeButton = forwardRef<HTMLButtonElement, NoticeButtonProps>(
  function NoticeButton(
    {
      variant = 'secondary',
      type = 'button',
      className = '',
      icon,
      busy,
      busyLabel,
      disabled,
      children,
      ...props
    },
    ref,
  ): JSX.Element {
    const size = useContext(NoticeButtonSizeContext);
    const isBusy =
      busy === true ||
      props['aria-busy'] === true ||
      props['aria-busy'] === 'true';
    // Retain the last idle content even when a caller clears an error or
    // changes its label/glyph in the render that starts the request. Sync
    // during idle renders so there is no effect frame with stale sizing.
    const [restingContent, setRestingContent] = useState({
      label: children,
      icon,
    });
    if (
      !isBusy &&
      (restingContent.label !== children || restingContent.icon !== icon)
    ) {
      setRestingContent({ label: children, icon });
    }
    const sizingIcon = isBusy ? restingContent.icon : icon;
    const hasIcon = sizingIcon !== undefined && sizingIcon !== null;
    const glyph = hasIcon ? (
      <span aria-hidden="true" className="inline-flex shrink-0">
        {sizingIcon}
      </span>
    ) : undefined;
    return (
      <Button
        ref={ref}
        type={type}
        variant={variant}
        size={size}
        className={`max-w-full whitespace-nowrap ${className}`}
        {...props}
        disabled={
          (isBusy && !isAriaDisabled(props['aria-disabled'])) || disabled
        }
        aria-busy={isBusy ? true : props['aria-busy']}
        busyAppearance="preserved"
      >
        <span className="relative inline-flex min-w-0 max-w-full">
          <span
            aria-hidden={isBusy ? true : undefined}
            className={`inline-flex min-w-0 max-w-full items-center justify-center gap-1.5 ${isBusy ? 'invisible' : ''}`}
          >
            {glyph}
            {isBusy ? <ReservedLabel label={restingContent.label} /> : children}
          </span>
          {isBusy ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <LoadingSpinner decorative />
              <span className="sr-only">
                {busyLabel ?? restingContent.label}
              </span>
            </span>
          ) : null}
        </span>
      </Button>
    );
  },
);

NoticeButton.displayName = 'NoticeButton';

/**
 * What the notice is telling the user. The intent picks the default glyph
 * and its ink; it never tints the surface or the copy, so every notice reads
 * as one quiet family and the icon carries the meaning.
 */
export type NoticeIntent = 'neutral' | 'attention' | 'destructive' | 'positive';

/**
 * Where the actions sit. `trailing` keeps one or two buttons on the message
 * row, right-aligned, so every notice in a stack puts its buttons in the same
 * place. `below` puts a longer set on its own row, left-aligned with the
 * title and message, so three or more buttons never crowd the copy.
 */
export type NoticeActionsPlacement = 'trailing' | 'below';

/**
 * In a narrow notice (`@container/notice` under 384px) a row of actions
 * under the copy also runs under the dismiss column, which is empty below
 * the close button: 28px plus the 8px gap. A long label such as
 * `Open organizations` then keeps its padding in a 260px sidebar while the
 * row stays lined up with the copy. A negative margin alone frees the space
 * without widening the row, so the row also grows into it and drops the
 * trailing row's `max-w-full` cap.
 */
const NARROW_UNDER_DISMISS =
  '@max-sm/notice:-mr-9 @max-sm/notice:grow @max-sm/notice:max-w-none';

export interface NoticeProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'title' | 'children'
> {
  readonly ref?: Ref<HTMLDivElement>;
  intent?: NoticeIntent;
  /**
   * Leading glyph. Omit for the intent's default app icon, pass `null`
   * to render no icon column at all (status lines that need no emphasis).
   */
  icon?: ReactNode;
  /**
   * The state in a few words (`Codex usage limit reached`, `Sending paused`).
   * Rendered in `fg-primary` at the start of the line; the message continues
   * after it in `fg-tertiary`. Every composer notice sets one.
   */
  title?: ReactNode;
  /**
   * The explanation or the choice, as one sentence that follows the title on
   * the same line. Without a title it is the whole notice, in `fg-primary`.
   */
  children: ReactNode;
  /**
   * Supporting line under the message, reserved for post-action feedback
   * that changes nothing (`Couldn't schedule the resume.`). What happens
   * next belongs in the message itself. Rendered quieter than the message.
   */
  detail?: ReactNode;
  /** Total copy-to-detail gap for margin-free supporting content. */
  detailGap?: 'inline';
  /**
   * Announce `detail` when it appears (`role="alert"`), for a static notice
   * (`role="none"`) whose action can fail: the standing copy stays silent and
   * only the failure is read out.
   */
  announceDetail?: boolean;
  /**
   * Trailing content on the message row. Usually recovery actions: use
   * `NoticeButton` and order them so the single recommended action
   * (`variant="primary"`) comes last and therefore sits at the far right,
   * with `secondary` alternatives before it. A plain value or status chip
   * (a live credit balance, a "Broken" tag) may ride here too.
   */
  actions?: ReactNode;
  /** Defaults to `trailing`. Pass `below` when there are three or more actions. */
  actionsPlacement?: NoticeActionsPlacement;
  onDismiss?: () => void;
  /** Accessible name for the dismiss control. Defaults to `Dismiss`. */
  dismissLabel?: string;
  dismissTestId?: string;
  /**
   * Live-region role. Defaults to `alert` for `destructive` (a failure the
   * user must know about now) and `status` for everything else. Pass `none`
   * for static prose that is part of the page (a privacy note in a modal, a
   * read-only banner, a transcript block): it then renders no live region and
   * is read in document order instead of being announced on mount.
   */
  role?: 'status' | 'alert' | 'none';
  /** Announce only the copy when action updates should stay outside the region. */
  liveRegionScope?: 'notice' | 'content';
  /**
   * `composer` matches the composer box: 20px corners, with the controls 12px
   * from the edges so their 8px corners still nest (20 = 8 + 12). Defaults to
   * the surrounding `NoticeShapeProvider`, else `default`. `settings` matches
   * a settings card: 12px corners and a 16px inset, with the controls on that
   * edge like a settings row's control.
   */
  shape?: NoticeShape;
  /**
   * `tray` (default) draws the notice's own quiet surface. `none` draws only
   * the content and controls, for a host primitive that owns the surface
   * around it: a toast card supplies its own floating surface and corners.
   */
  surface?: NoticeSurface;
  /**
   * `inline` (default) runs the title into the message on one line, closed
   * with a full stop. `stacked` puts the title on its own line with the
   * message under it, for a toast, which is read in one glance away from the
   * work it reports.
   */
  titleLayout?: NoticeTitleLayout;
  /**
   * Internal to `ErrorBanner`, which is a destructive notice that reports as
   * its own surface, so one banner stays one record.
   */
  errorRecordingChokePoint?: NoticeErrorChokePoint;
  /**
   * Internal. A boundary's own fallback, whose caught error is already
   * reported, sets this so the crash does not count twice.
   */
  errorRecordingDisabled?: boolean;
  /**
   * The tray's hairline edge. `neutral` everywhere except `ErrorBanner`, the
   * one surface allowed a destructive edge (docs/design/feedback.md#notice).
   * @internal Not for direct callers; use `ErrorBanner`.
   */
  edge?: NoticeEdge;
}

/** Whether a notice's title leads the message's line or sits above it. */
export type NoticeTitleLayout = 'inline' | 'stacked';

/** Who draws the surface behind a notice: the notice itself or its host. */
export type NoticeSurface = 'tray' | 'none';

/**
 * The title is a sentence of its own and ends with a full stop, so the
 * message that follows it on the same line reads as a second sentence rather
 * than a run-on. A title that already ends in punctuation (`Couldn't load
 * skills.` from `ErrorBanner`) keeps its own.
 */
function titleNeedsStop(title: ReactNode): boolean {
  const text = nodeText(title);
  if (text === null) return true;
  return !/[.:!?…]$/.test(text.trimEnd());
}

/**
 * The visible text of a title, flattened through strings, numbers, arrays,
 * fragments, and elements (`<span data-testid>Text</span>`,
 * `<>Can't delete {name} yet.</>`), so the punctuation rule sees what the
 * user sees. `null` when the node holds no text at all.
 */
function nodeText(node: ReactNode): string | null {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const parts = node.map(nodeText);
    return parts.some((part) => part === null) ? null : parts.join('');
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return null;
}

const INTENT_ICON_CLASS: Record<NoticeIntent, string> = {
  neutral: 'fg-secondary',
  attention: 'fg-warning',
  destructive: 'fg-destructive',
  positive: 'fg-success',
};

function defaultIcon(intent: NoticeIntent): JSX.Element {
  switch (intent) {
    case 'attention':
    case 'destructive':
      return <WarningIcon size={16} aria-hidden="true" />;
    case 'positive':
      return <CircleCheckIcon size={16} aria-hidden="true" />;
    default:
      return <InfoIcon size={16} aria-hidden="true" />;
  }
}

/**
 * A notice's geometry. `default` is the 16px panel notice; `composer` is the
 * banner stacked on the composer, cornered like the composer box; `toast` is
 * a toast card's roomier content: 16px to the copy on every side and the
 * dismiss control 12px from the corner, under the card's 20px corners;
 * `settings` sits among settings cards and shares their corners and inset, so
 * its glyph and buttons line up with the rows' labels and controls.
 */
export type NoticeShape = 'default' | 'composer' | 'toast' | 'settings';

const NoticeShapeContext = createContext<NoticeShape>('default');

/**
 * A notice's action size: a toast's buttons are the 32px pill, a settings
 * notice takes the settings page's compact capsule, and every other notice
 * keeps the 28px pill.
 */
const ACTION_SIZE_BY_SHAPE: Record<NoticeShape, NoticeButtonSize> = {
  default: 'sm',
  composer: 'sm',
  toast: 'md',
  settings: 'compact',
};

/** The tray's corners: the composer box, a toast card, a settings card. */
const TRAY_RADIUS_BY_SHAPE: Record<NoticeShape, string> = {
  default: 'rounded-xl',
  composer: 'rounded-2xl',
  toast: 'rounded-2xl',
  settings: 'rounded-lg',
};

/**
 * Sets the shape of every `Notice` inside it that does not pick its own: the
 * composer wraps its banner stack in one, so each banner matches the box.
 */
export function NoticeShapeProvider({
  shape,
  children,
}: {
  shape: NoticeShape;
  children: ReactNode;
}): JSX.Element {
  return (
    <NoticeShapeContext.Provider value={shape}>
      {children}
    </NoticeShapeContext.Provider>
  );
}

/**
 * The banners above a composer: one stack owns their spacing (DESIGN.md: one
 * spacing owner per group), every notice takes the composer's corners, and
 * it collapses entirely (`empty:hidden`) when none render, so nothing reserves
 * space above the box. Hosts place it inside their composer gutter; the
 * stack owns the same 16px side inset as ComposerDrawer. Both use the host's
 * composer shell gutter; never add a banner-only horizontal inset.
 */
export function ComposerNoticeStack({
  children,
  'data-testid': testId,
}: {
  children: ReactNode;
  'data-testid'?: string;
}): JSX.Element {
  return (
    <NoticeShapeProvider shape="composer">
      <div
        data-testid={testId}
        className="mb-2 flex flex-col gap-2 px-4 empty:hidden"
      >
        {children}
      </div>
    </NoticeShapeProvider>
  );
}

/**
 * The shared inline notice: the one surface for "something you should know
 * about this work" that sits inside the page flow, above a composer or at the
 * top of a panel, as opposed to a toast (notification stack) or a dialog.
 *
 * Design contract (DESIGN.md "Surfaces, lines, and elevation" and "Color
 * system"):
 *
 * - One surface for every intent, and a quieter one than the work surface it
 *   sits next to: the page's own `bg-base` with the `bg-subtle` wash
 *   composited on top, so the tray is a fixed color wherever it renders
 *   rather than tinting whatever ground is behind it, with a
 *   one-physical-pixel `line-secondary` hairline and no elevation.
 *   The composer keeps its raised tertiary card; the notice reads as
 *   supporting state beneath it, not as a second card competing with it.
 *   Intent is carried by the leading app glyph's ink alone, never by a
 *   tinted fill, a tinted border, or tinted copy.
 * - Two inks, one line. The `title` is the state in a few words, in
 *   `fg-primary` and closed with a full stop; the message follows it on the
 *   same line in `fg-tertiary`
 *   and carries the explanation or the choice. Both sit at the shared
 *   `text-xs` size, and a supporting `detail` line below is `fg-tertiary`
 *   too. A notice with no `title` renders its message in `fg-primary`. No
 *   smaller muted text to fit density.
 * - Rows share a 28px rhythm: the icon column, a single line of copy with
 *   its inset, the `NoticeButton`s, and the dismiss control are all 28px tall,
 *   so a one-line notice with actions is one straight row; on a wrapped
 *   message the glyph stays on the first line (centred on the whole message
 *   in the `composer` shape, like the buttons beside it) and the dismiss
 *   control follows the rule below.
 * - Positions are stable across a stack: the dismiss control sits in the
 *   top-right corner, its 28px hit box inset 8px from the top and 8px from
 *   the right (the surface's 12px inset pulled in by 4px), so the corner
 *   reads square. When trailing buttons share the row, the dismiss control
 *   centres on that row with them instead, so a wrapped message never
 *   leaves the cross above the buttons; without a dismiss control the
 *   trailing buttons take that same 8px inset themselves, so a button is
 *   equidistant from the top, bottom, and right edges. The radii nest:
 *   the 16px surface (`rounded-xl`) equals the dismiss box's 8px radius
 *   (`rounded-md`) plus that 8px inset, so the dismiss box follows the
 *   surface's arc instead of cutting across it (actions are the shared
 *   `Button` capsule, as on the composer); change one of
 *   the three together with the others. The `composer` shape (the banners
 *   stacked on the composer) takes the composer box's 20px corners and keeps
 *   its controls at the full 12px inset, so 20 = 8 + 12 nests the same way;
 *   its glyph sits in a 32px column 8px from the edge, centred over the
 *   composer's + button, and its copy starts where the composer's text does. Trailing buttons always end at the
 *   right edge
 *   of the copy area. A notice that cannot be dismissed reserves no empty
 *   column, so its buttons reach the same inset the surface has everywhere
 *   else. The recommended action is always the right-most button.
 * - Every control is a real `<button>` with an accessible name; the dismiss
 *   control is the app's medium cross, not a typed `×`.
 * - `className` is for placement only (margins, width). Surface, inset,
 *   radius, typography, and color are owned here.
 */
/** The tray's hairline edge; only `ErrorBanner` asks for `destructive`. */
export type NoticeEdge = 'neutral' | 'destructive';

export function Notice({
  intent = 'neutral',
  icon,
  title,
  children,
  detail,
  detailGap,
  announceDetail = false,
  actions,
  actionsPlacement = 'trailing',
  onDismiss,
  dismissLabel = 'Dismiss',
  dismissTestId,
  role,
  liveRegionScope = 'notice',
  shape,
  surface = 'tray',
  titleLayout = 'inline',
  errorRecordingChokePoint = 'notice',
  errorRecordingDisabled = false,
  edge = 'neutral',
  className = '',
  ...rest
}: NoticeProps): JSX.Element {
  const contextShape = useContext(NoticeShapeContext);
  // The composer banner keeps its controls 12px from the edges (no 4px
  // pull-in) under 20px corners; the default notice pulls them to 8px under
  // 16px corners. Either way control radius + inset = surface radius.
  const resolvedShape = shape ?? contextShape;
  const composerShape = resolvedShape === 'composer';
  // A toast keeps its controls 12px from the edges under 20px corners
  // (20 = 8 + 12) and gives the copy 16px on every side.
  const toastShape = resolvedShape === 'toast';
  // Only the default notice pulls its controls 4px in; a settings notice
  // follows the settings card instead, with its controls on the 16px edge
  // like every row's control.
  const pullControlsIn = resolvedShape === 'default';
  // A destructive notice reports itself, except in a toast: the toast store
  // already recorded that event.
  const recordsError =
    intent === 'destructive' && !toastShape && !errorRecordingDisabled;
  const copyRef = useNoticeErrorRecording(
    recordsError,
    errorRecordingChokePoint,
    recordsError ? [title, children, detail].map(nodeText).join('\u0000') : '',
  );
  const resolvedIcon = icon === undefined ? defaultIcon(intent) : icon;
  const resolvedRole = role ?? (intent === 'destructive' ? 'alert' : 'status');
  const live = resolvedRole !== 'none';
  const hasActions = actions !== undefined && actions !== null;
  const trailingActions = hasActions && actionsPlacement === 'trailing';
  const actionNodes = hasActions ? (
    <NoticeButtonSizeContext.Provider
      value={ACTION_SIZE_BY_SHAPE[resolvedShape]}
    >
      {actions}
    </NoticeButtonSizeContext.Provider>
  ) : null;

  return (
    <div
      {...(live && liveRegionScope === 'notice'
        ? {
            role: resolvedRole,
            'aria-live': resolvedRole === 'alert' ? 'assertive' : 'polite',
          }
        : {})}
      data-notice-intent={intent}
      data-notice-shape={resolvedShape}
      data-notice-surface={surface}
      className={`flex gap-2 text-xs fg-primary ${
        surface === 'tray'
          ? `bg-base bg-[linear-gradient(var(--bg-subtle),var(--bg-subtle))] ring-[length:var(--border-hairline)] ${
              edge === 'destructive'
                ? 'ring-line-destructive'
                : 'ring-line-secondary'
            } ${TRAY_RADIUS_BY_SHAPE[resolvedShape]}`
          : ''
      } ${
        composerShape
          ? // The composer's own geometry: an 8px edge, a 32px glyph column
            // (the + button's width) and 12px to the copy, so the glyph
            // centres over + and the copy starts where the composer's text
            // does; without a glyph the copy still starts there (52px).
            `py-3 pr-3 ${resolvedIcon !== null ? 'pl-2' : 'pl-13'}`
          : toastShape
            ? // 11px plus the copy's 5px line inset puts the text 16px from
              // the top and bottom; the dismiss box adds 1px to sit at 12px.
              'py-2.75 pl-4 pr-3'
            : resolvedShape === 'settings'
              ? // The settings card's inset (SettingsGroup).
                'px-4 py-3'
              : 'px-3 py-2'
      } ${trailingActions ? 'items-center' : 'items-start'} ${className}`}
      {...rest}
    >
      <div className="@container/notice flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <div
            // On the composer the glyph centres on a wrapped message, level
            // with the trailing buttons; elsewhere it heads the first line.
            className={`flex min-w-0 flex-1 basis-64 ${
              composerShape
                ? 'items-center gap-3'
                : toastShape
                  ? 'items-start gap-3'
                  : 'items-start gap-2'
            }`}
          >
            {resolvedIcon !== null && (
              <span
                aria-hidden="true"
                className={`flex h-7 shrink-0 items-center justify-center ${
                  composerShape ? 'w-8' : 'w-4'
                } ${INTENT_ICON_CLASS[intent]}`}
              >
                {resolvedIcon}
              </span>
            )}
            <div
              ref={copyRef}
              className={
                detailGap === 'inline'
                  ? 'flex min-w-0 flex-1 flex-col gap-2 py-1.25'
                  : 'min-w-0 flex-1 py-1.25'
              }
              {...(live && liveRegionScope === 'content'
                ? {
                    role: resolvedRole,
                    'aria-live':
                      resolvedRole === 'alert' ? 'assertive' : 'polite',
                  }
                : {})}
            >
              {title !== undefined && titleLayout === 'stacked' ? (
                // A headline over its explanation: the title on its own line
                // with no added stop, the message under it in `fg-tertiary`.
                // A toast floats away from the work it reports, so its
                // message steps up to `fg-secondary` to stay readable there.
                <div className="text-pretty" data-notice-title-layout="stacked">
                  <div className="font-medium fg-primary">{title}</div>
                  <div
                    className={`mt-0.5 ${toastShape ? 'fg-secondary' : 'fg-tertiary'}`}
                  >
                    {children}
                  </div>
                </div>
              ) : title !== undefined ? (
                // One paragraph: the short title leads in `fg-primary` and the
                // message follows it on the same line in `fg-tertiary`, so a
                // notice reads as "state, then explanation" and wraps as one
                // block instead of stacking a heading over a subtitle.
                // `text-pretty`: a wrapped notice avoids a short orphan line
                // without the even-split shape `balance` forces on short copy.
                <div className="text-pretty">
                  <span className="font-medium fg-primary">
                    {title}
                    {titleNeedsStop(title) && '.'}
                  </span>{' '}
                  <span className="fg-tertiary">{children}</span>
                </div>
              ) : (
                <div className="text-pretty">{children}</div>
              )}
              {detail !== undefined && (
                // 2px of air between the line and its detail, so the detail
                // reads as a second paragraph rather than a wrapped line.
                <div
                  role={announceDetail ? 'alert' : undefined}
                  className={
                    detailGap === 'inline'
                      ? 'text-pretty fg-tertiary empty:hidden'
                      : 'mt-0.5 text-pretty fg-tertiary'
                  }
                >
                  {detail}
                </div>
              )}
            </div>
          </div>
          {/* One element for both placements, so moving the actions between
              them restyles the row instead of remounting the buttons (and
              losing state a stateful action holds). `below` takes a full
              line of the wrapping row, which puts it under the copy. */}
          {hasActions && (
            <div
              data-notice-actions={actionsPlacement}
              className={
                trailingActions
                  ? // Without a dismiss control the buttons are the right
                    // edge: pull them in by the same 4px as the dismiss box
                    // so a button sits 8px from the top, bottom, and right
                    // alike. In a notice narrower than 384px (a sidebar, a
                    // popover) the buttons take their own row under the
                    // copy, lined up with it, as `below` places them.
                    `ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 @max-sm/notice:ml-0 @max-sm/notice:basis-full @max-sm/notice:justify-start ${
                      resolvedIcon === null
                        ? ''
                        : composerShape
                          ? '@max-sm/notice:pl-11'
                          : toastShape
                            ? '@max-sm/notice:pl-4'
                            : '@max-sm/notice:pl-6'
                    } ${onDismiss ? NARROW_UNDER_DISMISS : pullControlsIn ? '-mr-1' : ''}`
                  : `flex min-w-0 max-w-full basis-full flex-wrap items-center gap-2 ${onDismiss ? NARROW_UNDER_DISMISS : ''} ${
                      resolvedIcon === null
                        ? ''
                        : composerShape
                          ? 'pl-11'
                          : toastShape
                            ? // The copy starts 28px in (16px glyph + 12px
                              // gap); the row starts 12px short of it (the
                              // pill's own inset), so each button's label
                              // lines up with the copy.
                              'pl-4'
                            : 'pl-6'
                    }`
              }
            >
              {actionNodes}
            </div>
          )}
        </div>
      </div>
      {onDismiss && (
        <Button
          variant="ghost-overlay"
          size="sm"
          iconOnly
          onClick={onDismiss}
          aria-label={dismissLabel}
          data-testid={dismissTestId}
          className={toastShape ? 'mt-px' : pullControlsIn ? '-mr-1' : ''}
        >
          <CloseMediumIcon size={16} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
