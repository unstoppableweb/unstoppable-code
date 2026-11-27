import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  MenuSurface,
  OverlayScrollArea,
  TitlebarIconButton,
} from '@canopy/ui-shared';
import { BulletListIcon } from '@canopy/ui-shared/icons/AppIcons';
import { openActivitySectionInSidePanel } from '@/lib/panels/activity-section-panel-open';
import { DEFAULT_CHAT_GROUP_ID } from '@/lib/panels/panel-group-ids';
import { useChatStore } from '@/stores/chatStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import {
  ACTIVITY_CARD_ELEMENT_ID,
  isActivityCardOpen,
  useActivityCardStore,
} from '@/stores/activityCardStore';
import { SharedActivityPanelAdapter } from './SharedActivityPanelAdapter';

/**
 * The button that shows or hides the Activity card, at the
 * right end of the main chat group's title row, beside the card it opens.
 * It is a toggle, not a popover trigger: the card stays put while the user
 * works and closes only from here.
 *
 * Renders only where the card can show: the selected worktree's grid, in
 * its main chat group, while that group shows a chat tab
 * (`ActivityCardChatLayout` hosts the card inside the chat). A browser,
 * terminal, or other tab shown there hides it. Pop-out windows render no
 * title-row accessories, so it stays in the main window.
 */
export function ActivityCardToggle({
  projectId,
  worktreeId,
  groupId,
  activeTabKind,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly groupId: string;
  /** The kind of the tab the group shows, or `null` for an empty group. */
  readonly activeTabKind: string | null;
}): JSX.Element | null {
  const enabled = useLabsExperimentEnabled('activity-card');
  const selected = useChatStore(
    (state) =>
      state.selectedWorktree?.projectId === projectId &&
      state.selectedWorktree.worktreeId === worktreeId,
  );
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const open = useActivityCardStore((state) =>
    isActivityCardOpen(state, worktreeKey),
  );
  const toggleWorktree = useActivityCardStore((state) => state.toggle);
  if (
    !enabled ||
    !selected ||
    groupId !== DEFAULT_CHAT_GROUP_ID ||
    activeTabKind !== 'chat'
  ) {
    return null;
  }
  return (
    // Centered on the 36px title row, like the tabs and `+`, which leaves 4px
    // above it; as the row's last control it keeps the same 4px from the
    // card's right edge, matching the first tab's 4px on the left. The 4px
    // before it is the row's gap between controls (after the `+`).
    <span className="pl-1 inline-flex self-center last:pr-1">
      {/* While the card is open the button keeps the hover look (subtle
          surface, primary ink), like the top bar's Side Panel toggle while
          its panel shows. */}
      <TitlebarIconButton
        holdHoverWhenExpanded
        // A tab row chrome control: the row's nested corner radius.
        surface="panelChrome"
        data-testid="worktree-activity-card-toggle"
        icon={BulletListIcon}
        onClick={(): void => toggleWorktree(worktreeKey)}
        aria-expanded={open}
        aria-controls={open ? ACTIVITY_CARD_ELEMENT_ID : undefined}
        aria-label={open ? 'Hide activity' : 'Show activity'}
        title={open ? 'Hide activity' : 'Show activity'}
      />
    </span>
  );
}

/** The card's width (`w-68`), which the chat gives up when the card sits beside it. */
const ACTIVITY_CARD_WIDTH_PX = 272;
/** The chat's own side padding (the transcript's and composer's `px-4`). */
const CHAT_SIDE_PADDING_PX = 16;

/**
 * Where the card goes. `beside` lays it flat in the chat's right margin,
 * clear of the chat's centered column. `over` floats it, elevated, over the
 * chat's right side when the margin is too narrow for it.
 */
type ActivityCardPlacement = 'beside' | 'over';

interface ActivityCardFit {
  readonly placement: ActivityCardPlacement;
  /**
   * How much width the chat gives up on its right, under the card. Zero
   * while the margin beside the centered column fits the card, so the column
   * and composer stay where they are; as the margin narrows, just enough to
   * keep the column clear of the card; the card's whole width for a
   * full-width chat, which has no margin.
   */
  readonly chatInsetPx: number;
}

interface ActivityCardProps {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly placement: ActivityCardPlacement;
}

/**
 * The Activity card itself: the shared ActivityPanel in its `card` layout, so
 * it shows the same sections, counts, and actions as the rail.
 *
 * It is pinned to the chat's right edge, as tall as its rows; only the card
 * takes pointer input, so the chat below a short card stays usable. `beside`,
 * it has no fill or shadow and reads as part of the chat surface it sits in.
 * `over`, it sits on the shared menu surface with the floating shadow. Its
 * right edge sits 4px in, lined up with the right edge of the top bar's •••
 * button above it.
 *
 * Both places share one geometry: the same 4px right inset and 8px top inset
 * around the card, and the same 4px padding inside it (`p-1` here, the menu
 * surface's own `p-1` there). So the rows stay put when the card switches
 * between the two as the window resizes.
 */
const ActivityCard = memo(function ActivityCard({
  projectId,
  worktreeId,
  placement,
}: ActivityCardProps): JSX.Element {
  const selection = useMemo(
    () => ({ projectId, worktreeId }),
    [projectId, worktreeId],
  );
  const content = (
    <OverlayScrollArea className="pointer-events-auto min-h-0 min-w-0 flex-1">
      <SharedActivityPanelAdapter
        key={`${projectId}/${worktreeId}`}
        worktreeSelection={selection}
        layout="card"
        // A row opens its section as a Side Panel tab, so the card stays a
        // short list.
        onOpenCardSection={(sectionId): boolean =>
          openActivitySectionInSidePanel(
            makeWorktreePanelKey(projectId, worktreeId),
            sectionId,
          )
        }
      />
    </OverlayScrollArea>
  );
  // One element tree for both placements, so switching only restyles it: a
  // different root element would remount the Activity panel and reload its
  // sections (the MCP server count flickered back from zero). The floating
  // surface is a layer behind the rows, drawn only when the card floats.
  const over = placement === 'over';
  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-0 z-40 flex w-68 flex-col py-2 pr-1"
      data-testid="activity-card-slot"
      data-placement={placement}
    >
      <section
        id={ACTIVITY_CARD_ELEMENT_ID}
        aria-label="Activity"
        data-testid="activity-card"
        data-style={over ? 'elevated' : 'flat'}
        // Flat, the card has no surface, and the chat's scrollbar runs under
        // its 4px edge padding: only the rows (8px in, clear of the thumb)
        // take the pointer, so the thumb stays draggable beside the card.
        className={`${over ? 'pointer-events-auto' : 'pointer-events-none'} relative flex min-h-0 flex-col`}
      >
        {over ? (
          <MenuSurface
            role="presentation"
            aria-hidden="true"
            data-testid="activity-card-surface"
            className="absolute inset-0"
          />
        ) : null}
        {/* 4px in, as the menu surface pads its rows. */}
        <div className="relative flex min-h-0 flex-col p-1">{content}</div>
      </section>
    </div>
  );
});

/**
 * Where the card fits, given the layout's width and the chat's widest column
 * (the composer shell, `--chat-composer-shell-width`). A probe as wide as that
 * variable measures it, so it follows the Chat width setting. At full width
 * (the variables are `100%`) the chat has no column to keep centered, so the
 * card always takes its own width beside it; that is read from the variable
 * itself, since a narrow layout also makes the probe as wide as the layout.
 */
function useActivityCardFit(
  layoutRef: RefObject<HTMLDivElement | null>,
  probeRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): ActivityCardFit {
  const [fit, setFit] = useState<ActivityCardFit>({
    placement: 'beside',
    chatInsetPx: 0,
  });
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    const probe = probeRef.current;
    if (!enabled || !layout || !probe) return undefined;
    const measure = (): void => {
      const fullWidth = getComputedStyle(probe)
        .getPropertyValue('--chat-composer-shell-width')
        .trim()
        .endsWith('%');
      const available = layout.getBoundingClientRect().width;
      const chatMax = probe.getBoundingClientRect().width;
      const next = activityCardFit(available, chatMax, fullWidth);
      setFit((current) =>
        current.placement === next.placement &&
        current.chatInsetPx === next.chatInsetPx
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    observer.observe(probe);
    return (): void => observer.disconnect();
  }, [enabled, layoutRef, probeRef]);
  return fit;
}

function activityCardFit(
  available: number,
  chatMax: number,
  fullWidth: boolean,
): ActivityCardFit {
  if (fullWidth || available - ACTIVITY_CARD_WIDTH_PX < chatMax) {
    return fullWidth
      ? { placement: 'beside', chatInsetPx: ACTIVITY_CARD_WIDTH_PX }
      : { placement: 'over', chatInsetPx: 0 };
  }
  // The centered column leaves this much on each side. The card needs its
  // width plus the chat's own side padding, so the column keeps the gap from
  // the card it has from the chat's edge.
  const margin = (available - chatMax) / 2;
  const needed = ACTIVITY_CARD_WIDTH_PX + CHAT_SIDE_PADDING_PX;
  // Narrowing the chat by twice the shortfall moves its column left by the
  // shortfall, which is just enough to clear the card.
  const chatInsetPx = Math.min(
    ACTIVITY_CARD_WIDTH_PX,
    Math.max(0, Math.ceil(2 * (needed - margin))),
  );
  return { placement: 'beside', chatInsetPx };
}

/**
 * Lays a chat panel out with the Activity card. The card lives inside the
 * main chat surface, not in a column of its own: in the margin beside the
 * chat's centered column, which stays where it is while the margin fits the
 * card, or over the chat's right side when the margin is too narrow. It
 * shows and hides at once, with no motion.
 *
 * Only the main chat group's shown tab hosts the card, so there is one card
 * at a time: a split layout or a group of many chats never runs a copy per
 * chat. The wrapper is always present (early access only), so showing or
 * hiding the card never remounts the chat.
 *
 * Disabled (early access off), it adds no layout: its wrappers are
 * `display: contents` and the card is never rendered. It stays mounted either
 * way, with the chat in the same keyed slot, so turning early access on or
 * off keeps the chat's state (open turns, scroll position).
 */
export function ActivityCardChatLayout({
  panelId,
  enabled = true,
  visible: panelVisible = true,
  children,
}: {
  readonly panelId: string;
  /** Whether the card is available at all (early access). */
  readonly enabled?: boolean;
  /** Whether this chat's tab is the one shown in its group. */
  readonly visible?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  // Disabled, the layout follows no worktree, so the selectors below do no
  // work for chats without the card.
  const selectedWorktree = useChatStore((state) =>
    enabled ? state.selectedWorktree : null,
  );
  // Each worktree remembers whether its card is shown.
  const open = useActivityCardStore((state) =>
    isActivityCardOpen(
      state,
      selectedWorktree
        ? makeWorktreePanelKey(
            selectedWorktree.projectId,
            selectedWorktree.worktreeId,
          )
        : null,
    ),
  );
  const inMainChatGroup = usePanelLayoutStore((state) =>
    selectedWorktree
      ? (state.layouts[
          makeWorktreePanelKey(
            selectedWorktree.projectId,
            selectedWorktree.worktreeId,
          )
        ]?.groups[DEFAULT_CHAT_GROUP_ID]?.tabs.some(
          (tab) => tab.panelId === panelId,
        ) ?? false)
      : false,
  );
  const hostsCard =
    enabled && panelVisible && inMainChatGroup && selectedWorktree !== null;
  const visible = open && hostsCard;
  // Rendering the Activity panel is the expensive part of showing the card,
  // and doing it on the click stalled it. So the card is rendered ahead of
  // time, once the browser is idle, and stays rendered after it closes;
  // showing it then only reveals it. It hides with `display: none`, not
  // React's `<Activity>`: its sections keep their subscriptions and effects
  // while hidden, so they miss no updates (a summary finishing) and resume
  // as they were.
  const [rendered, setRendered] = useState(visible);
  useEffect(() => {
    if (visible) setRendered(true);
  }, [visible]);
  useEffect(() => {
    if (rendered || !hostsCard) return undefined;
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(() => setRendered(true), {
        timeout: 2000,
      });
      return (): void => window.cancelIdleCallback(idle);
    }
    const timer = window.setTimeout(() => setRendered(true), 200);
    return (): void => window.clearTimeout(timer);
  }, [rendered, hostsCard]);
  const layoutRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const { placement, chatInsetPx } = useActivityCardFit(
    layoutRef,
    probeRef,
    hostsCard,
  );
  // While the card shows, the chat gives up only the width it must. Its
  // scroll area (and so its scrollbar) still reaches the pane's right edge,
  // past that inset: the card's rows sit 8px in, clear of the resting thumb.
  const chatInset = visible ? chatInsetPx : 0;
  const chatStyle: CSSProperties & Record<'--chat-scrollbar-inset', string> = {
    paddingRight: chatInset,
    '--chat-scrollbar-inset': `${-chatInset}px`,
  };
  if (!enabled) {
    return (
      <div className="contents">
        <div key="chat" className="contents">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div
      ref={layoutRef}
      className="relative flex min-h-0 min-w-0 flex-1"
      data-testid="chat-activity-card-layout"
    >
      <div
        key="probe"
        ref={probeRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 h-0 w-[var(--chat-composer-shell-width)]"
      />
      <div
        key="chat"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        style={chatStyle}
      >
        {children}
      </div>
      {(rendered || visible) && hostsCard && selectedWorktree ? (
        <div
          data-testid="activity-card-host"
          className={visible ? 'contents' : 'hidden'}
        >
          <ActivityCard
            projectId={selectedWorktree.projectId}
            worktreeId={selectedWorktree.worktreeId}
            placement={placement}
          />
        </div>
      ) : null}
    </div>
  );
}
