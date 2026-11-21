import { SPACE_ROLE_GAP_CLASS, type SpaceRole } from './Stack';
import {
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  BUBBLE_INDICATOR_BADGE_CLASS,
  BUBBLE_INFO_SURFACE_CLASS,
  BUBBLE_MUTED_SURFACE_CLASS,
  BUBBLE_SURFACE_CLASS,
} from './bubble-badge';
import type { ChatMessageContextMenuTargetProps } from './ChatMessageContextMenu';
import { BubbleCopyBadge } from './BubbleCopyBadge';
import { Button } from './Button';
import { getWindow } from '../panels/window-registry';
import { Tooltip } from './Tooltip';
import { useIsPhone } from './useMediaQuery';
import { RevertIcon as AppCatalogRevertIcon } from '../icons/AppIcons';

/**
 * Descendants whose clicks must never trigger `onNavigate`: real controls
 * inside the bubble body (links, the Show more/less toggle, form fields).
 * The hover-revealed copy/revert badges are siblings of the surface, so they
 * never reach this handler at all.
 */
const NAVIGATE_EXCLUDED_SELECTOR =
  'a, button, [role="button"], input, textarea, select, summary';

/** The hover-revealed Copy/Revert badge cluster. */
const BUBBLE_ACTIONS_SELECTOR = '[data-bubble-actions]';
const FOOTER_INSET_CLASS: Readonly<Record<SpaceRole, string>> = {
  tight: 'pt-1',
  inline: 'pt-2',
  item: 'pt-3',
  group: 'pt-4',
  block: 'pt-5',
  section: 'pt-6',
  page: 'pt-8',
  hero: 'pt-10',
};

export interface UserBubbleProps {
  /**
   * Plain-text representation of the message used by the copy-to-clipboard
   * affordance. Hosts compose this from their internal block structure.
   */
  copyText: string;
  /** Rendered bubble content (typically the block-renderer output for
   * the desktop or a simple `<p>` for the web). */
  children?: ReactNode;
  /** Optional revert-to-this-turn handler. Renders a hover-revealed
   * "revert" affordance to the left of the copy button. */
  onRevert?: () => void;
  /** Optional leading badge (e.g., a "voice" mic indicator) anchored to
   * the top-left of the bubble. */
  leading?: ReactNode;
  /** Optional title line rendered inside the bubble above the message
   * content (e.g., the watcher-fired "broadcast" header). */
  header?: ReactNode;
  /**
   * Bubble tint. `default` keeps the primary/accent pill; `info` renders the
   * info-tinted variant used for Canopy-generated (watcher-fired) messages;
   * `muted` is a flat muted fill with no shadow, for a chat on its own
   * raised surface. `transcript-row` keeps the message actions around a
   * full-width transcript event.
   */
  variant?: 'default' | 'info' | 'muted' | 'transcript-row';
  /** Optional media rendered inside the bubble, between the header and
   * the message content (e.g. the images sent with the message). */
  media?: ReactNode;
  /** Optional content rendered below the bubble (e.g., attachment
   * thumbnails). */
  footer?: ReactNode;
  /** Own the inset and gaps around margin-free attachment/memory footer blocks. */
  footerGap?: SpaceRole;
  /** Test ID hook for automation on the outer bubble wrapper. */
  dataTestId?: string;
  /** Optional extra status data attribute (e.g., for portal styling). */
  dataStatus?: string;
  /**
   * Optional navigate-on-click handler for the bubble body. When provided,
   * the surface shows a pointer cursor, and clicks that neither land on an
   * interactive descendant (links, the Show more/less toggle, form fields)
   * nor finish a text selection invoke it with the surface element.
   */
  onNavigate?: (element: HTMLElement) => void;
  /**
   * Puts the Copy and Revert badges on the bubble's top-right corner at
   * every width, reserving no room for them in the bubble. Off (the
   * default), narrow phone-tier bubbles keep them inside, with right padding
   * reserved. The desktop turns it on under early access.
   */
  actionsOnCorner?: boolean;
  /**
   * The message's right-click menu target (`useChatMessageContextMenu`).
   * Attached to the outer wrapper, which also becomes the message's focus
   * target for the Menu key and Shift+F10. Events from the Copy and Revert
   * badges keep their pointer context menus. Their existing tab stops also
   * provide keyboard access to the message menu without a duplicate tab stop.
   */
  contextMenu?: ChatMessageContextMenuTargetProps;
}

/**
 * Pure display user message bubble. Provides the rounded primary-tinted
 * pill shell, a hover-revealed copy button, and an optional revert
 * affordance. Hosts render their own block content via `children`.
 */
export function UserBubble({
  copyText,
  children,
  onRevert,
  leading,
  header,
  variant = 'default',
  media,
  footer,
  footerGap,
  dataTestId,
  dataStatus,
  onNavigate,
  actionsOnCorner = false,
  contextMenu,
}: UserBubbleProps): JSX.Element {
  const handleNavigateClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!onNavigate) return;
    if (startedOutside(event.target, event.currentTarget)) return;
    const view = getWindow(event.currentTarget);
    const target = event.target;
    if (
      target instanceof view.Element &&
      target.closest(NAVIGATE_EXCLUDED_SELECTOR)
    ) {
      return;
    }
    // A click that ends a drag-selection must select, not navigate. A plain
    // click collapses any prior selection on mousedown, so this only skips
    // genuine selection gestures.
    const selection = view.getSelection();
    if (selection && !selection.isCollapsed) return;
    onNavigate(event.currentTarget);
  };
  // The pointer cursor is the whole navigation affordance: hovering leaves
  // the resting surface as is, in every variant.
  const navigateClass = onNavigate ? ' cursor-pointer' : '';

  const isPhone = useIsPhone();

  const handleContextMenu = contextMenu
    ? (event: MouseEvent<HTMLDivElement>): void => {
        if (startedOutside(event.target, event.currentTarget)) return;
        if (isFromBubbleActions(event.target, event.currentTarget)) return;
        contextMenu.onContextMenu(event);
      }
    : undefined;
  const handleKeyDown = contextMenu
    ? (event: KeyboardEvent<HTMLDivElement>): void => {
        if (startedOutside(event.target, event.currentTarget)) return;
        contextMenu.onKeyDown(event);
      }
    : undefined;

  // PHONE-TIER GEOMETRY. At 390px a full-width tinted, ringed shell sitting
  // directly above the composer reads as a second composer rather than as
  // something the user said: same width, same corner radius, same surface
  // family, a few pixels apart. Shrinking the surface to its content and
  // pushing it flush right restores the one authorship cue a phone transcript
  // still has room for — which side of the column a message sits on.
  //
  // APPLIED TO THE WRAPPER, NOT THE BUBBLE. The wrapper is the positioning
  // context for the corner badges AND the box `footer` lays out in, so shrinking
  // only the inner bubble right-aligns the bubble while leaving its own
  // decorations behind at full column width: the `leading` badge
  // (`absolute -left-2`) strands itself at the far left of the transcript, and
  // the `footer` attachment chips stay left-aligned under a right-aligned
  // message. Shrinking the wrapper moves all four together — badge cluster,
  // leading badge, bubble, footer — which is the only way they stay one object.
  //
  // A block-level box with `width: fit-content` and `margin-left: auto` right-
  // aligns on its own, so this stays a plain block rather than becoming a flex
  // parent (which would re-lay-out the children it is meant to leave alone).
  //
  // The 85% cap is what makes a long message wrap instead of running edge to
  // edge — an uncapped `w-fit` message long enough to fill the column comes
  // out full width again and silently loses the cue on exactly the messages
  // that most need it.
  //
  // Tier-gated rather than written as a `sm:`-prefixed utility on purpose: the
  // tablet and desktop class strings must come out byte-identical to what they
  // were.
  //
  // WHICH DESKTOP SURFACES THIS REACHES. The gate is viewport-based, not
  // host-based, so "the Electron renderer is inert" is only true where the
  // renderer cannot be narrow enough to match. The desktop main window sets
  // `minWidth: 800` (`apps/desktop-app/src/main/index.ts`), so the Code tab
  // never matches the phone query and is genuinely unaffected. The App Advisor
  // popout sets `APP_ADVISOR_MIN_WIDTH = 360` and renders this component
  // through `PanelGridSurface` -> chat panels -> `ChatMessageItem`, so between
  // 360px and 639px it DOES get this treatment. That is intended rather than
  // incidental: a 400px popout has exactly the problem described above — a
  // full-width tinted shell directly above the composer reads as a second
  // composer, and the `-right-2` badge overhang clips against the panel edge —
  // so the same geometry is the right answer there for the same reason.
  //
  // PULL-OUT PANEL WINDOWS are the one realm this does NOT follow into, and it
  // is worth recording why rather than leaving it to be rediscovered.
  // `useLayoutTier` reads the GLOBAL `window.matchMedia`, while this package's
  // `panels/window-registry` rule is that DOM-touching code must use the owning
  // window of the element it works with. A narrow aux window would therefore
  // read the MAIN window's tier, not its own. That is inert today only because
  // the main window's `minWidth: 800` keeps `useIsPhone()` permanently false in
  // that realm — so if the main window's minimum ever drops below 640, or an
  // aux window ever needs its own tier, `useMediaQuery` needs a window-scoped
  // `matchMedia` before this gate can be trusted there.
  const phoneSurfaceClass =
    isPhone && variant !== 'transcript-row' ? ' ml-auto w-fit max-w-17/20' : '';

  // ACTION BADGES. Two independent axes meet on this one element, and it is
  // worth being explicit about which is which.
  //
  // POSITION is width-dependent. The corner overhang (`-right-2 -top-2`) is
  // only safe while the bubble spans the column and has the transcript's own
  // horizontal padding to spill into. Once the phone bubble is flush right,
  // that same -8px puts the cluster past the transcript's edge, where it
  // clips. On the phone tier it therefore sits inside the bubble's own bounds.
  //
  // VISIBILITY is pointer-dependent, not width-dependent, so it is not tier
  // gated. `opacity-0` + `group-hover:opacity-100` has no coarse-pointer
  // escape, and a touch device has no hover — meaning that on a phone, a
  // tablet, or a touchscreen laptop there is simply no way to reach Copy or
  // Revert on a user message. `pointer-coarse:opacity-100` is the same escape
  // `ChatTab` already carries on its close button; reusing that idiom keeps
  // the two from drifting apart.
  //
  // Both candidates are spelled out literally so Tailwind's scanner emits
  // them.
  //
  // `actionsOnCorner` keeps the corner overhang at every tier: the host
  // vouches that its transcript's horizontal padding (16px on the desktop and
  // the App Advisor panel) leaves room for it beside a flush-right bubble.
  // The clean chat look keeps the same corner badges: a row under the bubble
  // sat beside the turn's "Worked for" line and read as a stray control.
  // Keyboard focus reveals them too, so a tabbed-to badge is never invisible.
  const badgeClusterClass =
    isPhone && !actionsOnCorner
      ? 'absolute right-1 top-1 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:gap-4 pointer-coarse:opacity-100'
      : 'absolute -right-2 -top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:gap-4 pointer-coarse:opacity-100';

  // CLEARANCE FOR THE IN-BUBBLE CLUSTER. Once the cluster moves inside the
  // bubble's bounds on the phone tier, it overlaps the text: the bubble shrinks
  // to its content, so a short message's first line runs straight underneath
  // the Copy (and Revert) badges, and on a touch device those badges are
  // permanently visible via `pointer-coarse:opacity-100` rather than appearing
  // on hover. Reserving the cluster's width as right padding is what keeps the
  // first line clear.
  //
  // The arithmetic, so it stays correct if the badges are resized: each badge is
  // `h-7 w-7` (28px) with a `gap-1` (4px) between them, and the cluster is
  // inset `right-1` (4px). One badge therefore needs 4 + 28 = 32px of clearance
  // and two need 4 + 28 + 4 + 28 = 64px; the values below add the surface's own
  // 4px breathing room on top. Copy is always rendered, so the one-badge case is
  // the floor rather than zero.
  //
  // On a coarse pointer the gap widens to `gap-4` (16px): each Button's touch
  // hit area reaches 8px past its 28px disc, so 16px lets the two 44px targets
  // meet without overlapping. Two badges then need 4 + 28 + 16 + 28 = 76px,
  // plus the same 4px.
  //
  // Padding applies to the whole box, so a message long enough to wrap carries
  // the reservation on every line, not just the one that needs it. That is the
  // deliberate trade: a float/`shape-outside` spacer would confine it to the
  // first line at the cost of a layout-affecting element inside the content box,
  // which is exactly what the `w-fit` geometry above is sensitive to.
  //
  // Both candidates are spelled out literally so Tailwind's scanner emits them.
  const phoneBadgeClearanceClass =
    !isPhone || actionsOnCorner
      ? ''
      : onRevert
        ? ' pr-17 pointer-coarse:pr-20'
        : ' pr-9';

  return (
    <div
      className={`group relative${phoneSurfaceClass}${contextMenu ? ' focus-ring rounded-xl' : ''}`}
      data-testid={dataTestId}
      data-status={dataStatus}
      data-role="user"
      // Focusable by pointer and script (focus returns here when the menu
      // closes) without adding a tab stop per message.
      tabIndex={contextMenu ? -1 : undefined}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
    >
      {leading != null && (
        <span
          className={`absolute -left-2 -top-2 z-10 ${BUBBLE_INDICATOR_BADGE_CLASS}`}
        >
          {leading}
        </span>
      )}
      <div className={badgeClusterClass} data-bubble-actions="">
        {onRevert && (
          <Tooltip label="Revert this turn">
            <Button
              variant="secondary"
              size="compact"
              iconOnly
              onClick={onRevert}
              aria-label="Revert this turn"
              data-testid="reset-to-point-button"
            >
              <AppCatalogRevertIcon size="sm" aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
        <BubbleCopyBadge copyText={copyText} dataTestId="user-bubble-copy" />
      </div>
      <div
        className={
          (variant === 'transcript-row'
            ? 'min-w-0'
            : variant === 'info'
              ? `${BUBBLE_INFO_SURFACE_CLASS} text-s fg-primary`
              : variant === 'muted'
                ? `${BUBBLE_MUTED_SURFACE_CLASS} text-s fg-primary`
                : `${BUBBLE_SURFACE_CLASS} text-s fg-primary`) +
          navigateClass +
          phoneBadgeClearanceClass
        }
        data-testid="remote-control-chat-message-content"
        onClick={onNavigate ? handleNavigateClick : undefined}
      >
        {header}
        {media}
        {children}
      </div>
      {footerGap === undefined ? (
        footer
      ) : (
        <div
          className={`flex flex-col ${SPACE_ROLE_GAP_CLASS[footerGap]} ${FOOTER_INSET_CLASS[footerGap]} empty:hidden`}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * An overlay a slot opens (the media viewer, a preview) portals out of the
 * bubble on the page, but its events still bubble here through React's tree.
 * One that did not start inside the bubble is not a click, a right-click or
 * a key on the bubble.
 */
function startedOutside(
  target: EventTarget | null,
  bubble: HTMLElement,
): boolean {
  return !(isNode(target) && bubble.contains(target));
}

/**
 * A node, told by its shape and not by `instanceof`: a pulled-out panel's
 * content is created in the opener window and adopted into the panel's own,
 * so there it is no instance of the `Node` of the window it is shown in, and
 * a check against that window's constructor took every click on the bubble
 * for one from outside it.
 */
function isNode(target: EventTarget | null): target is Node {
  return target !== null && 'nodeType' in target;
}

function isFromBubbleActions(
  target: EventTarget | null,
  wrapper: HTMLElement,
): boolean {
  const view = getWindow(wrapper);
  return (
    target instanceof view.Element &&
    target.closest(BUBBLE_ACTIONS_SELECTOR) !== null
  );
}
