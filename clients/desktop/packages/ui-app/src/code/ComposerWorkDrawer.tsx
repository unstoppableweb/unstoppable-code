'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import {
  Button,
  Count,
  hasEscapeEnabledOverlay,
  OverlayScrollArea,
  StatusGlyph,
  SpinnerStyleProvider,
  Surface,
} from '@canopy/ui-shared/components';
import { MinusIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  DRAWER_CARD_ACTIONS_CLASS,
  DRAWER_CARD_GROUP_CLASS,
} from '@canopy/ui-shared/lib';

import { DrawerRowPresentationContext } from './activity/background-tray/drawer-presentation';

export interface ComposerWorkDrawerSections {
  readonly needsYou: ReactNode;
  readonly running: ReactNode;
  readonly watching: ReactNode;
  readonly pullRequests?: ReactNode;
  readonly completed: ReactNode;
  readonly controls?: ReactNode;
  readonly viewportRef?: Ref<HTMLDivElement>;
  readonly onExpandedChange?: (expanded: boolean) => void;
}
export interface ComposerWorkDrawerBackground {
  readonly count: number;
  readonly needsYou: number;
  readonly running: number;
  readonly watching?: number;
  readonly pullRequests?: number;
  readonly panel?: ReactNode;
  readonly sections?: ComposerWorkDrawerSections;
  readonly viewportRef?: Ref<HTMLDivElement>;
  readonly onExpandedChange?: (expanded: boolean) => void;
}
export interface ComposerWorkDrawerProps {
  /**
   * Opens the first kind's card on mount, for previews and mocks. Work never
   * opens a card on its own.
   */
  readonly defaultExpanded?: boolean;
  readonly queuedCount: number;
  readonly queuedPanelRef?: Ref<HTMLDivElement>;
  readonly queuedPanel?: ReactNode;
  readonly background?: ComposerWorkDrawerBackground;
}
export function drawerReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
/** The card's motion: the drawer curve, in fast and out faster. */
const CARD_ENTER_MS = 200;
const CARD_EXIT_MS = 150;

/**
 * The `--ease-drawer` token's curve, for the Web Animations API, which takes
 * no CSS variables. The fallback is the token's value.
 */
function drawerEasing(node: Element): string {
  return (
    getComputedStyle(node).getPropertyValue('--ease-drawer').trim() ||
    'cubic-bezier(0.32, 0.72, 0, 1)'
  );
}

/**
 * The card opens from the pills' edge. Its space is reserved at once (one
 * layout change, never a height animated frame by frame), and the card
 * wipes up into it: a clip from the bottom with an 8px rise and a fade, as
 * CSS transitions, so a click mid-way reverses from where it is. Closing
 * keeps the space until the card has left. Keyboard opens and closes are
 * instant, and so is everything under reduced motion: the app's reduced
 * motion rule zeroes every CSS transition.
 */
function DrawerReveal({
  expanded,
  animate,
  children,
}: {
  readonly expanded: boolean;
  readonly animate: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  // A closing card keeps its space until its exit transition ends.
  const [closing, setClosing] = useState(false);
  const [wasExpanded, setWasExpanded] = useState(expanded);
  if (wasExpanded !== expanded) {
    setWasExpanded(expanded);
    setClosing(!expanded && animate);
  }
  useEffect(() => {
    if (!closing) return;
    // In case the transition never reports its end (a hidden tab).
    const timer = setTimeout(() => setClosing(false), CARD_EXIT_MS + 100);
    return (): void => clearTimeout(timer);
  }, [closing]);
  const reserved = expanded || closing;
  return (
    <div
      inert={!expanded}
      aria-hidden={!expanded}
      className="-mx-1 shrink-0 overflow-hidden"
      style={{ height: reserved ? 'auto' : 0 }}
    >
      <div
        className={`flow-root px-1 transition-[clip-path,translate,opacity] ease-drawer ${
          animate ? (expanded ? 'duration-200' : 'duration-150') : 'duration-0'
        } ${
          expanded
            ? 'translate-y-0 opacity-100 drawer-card-clip-open'
            : 'translate-y-2 opacity-0 drawer-card-clip-closed'
        }`}
        onTransitionEnd={(event): void => {
          if (
            !expanded &&
            event.target === event.currentTarget &&
            event.propertyName === 'opacity'
          )
            setClosing(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Escape closes the open work. Desktop portals its queue from the transcript,
 * so this observes DOM ancestry after React's handlers, letting nested
 * controls claim Escape first.
 */
function useEscapeToClose(
  sectionRef: RefObject<HTMLDivElement | null>,
  open: boolean,
  close: () => void,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const section = sectionRef.current;
    if (!open || !section) return;
    const ownerDocument = section.ownerDocument;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        !(event.target instanceof Element) ||
        !section.contains(event.target) ||
        hasEscapeEnabledOverlay(ownerDocument) ||
        event.target.closest('[role="dialog"], [data-dragging]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    ownerDocument.addEventListener('keydown', onKeyDown);
    return (): void => ownerDocument.removeEventListener('keydown', onKeyDown);
  }, [open, sectionRef]);
}

interface WorkKind {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly content: ReactNode;
  readonly controls?: ReactNode;
  readonly glyph?: 'running';
  /** Work waiting on the user: the label takes the warning ink, no glyph. */
  readonly attention?: boolean;
}

/**
 * The chat's work above its composer, shared by desktop and web: one pill per
 * kind of work (Needs you, Queued, Running, Pull requests, Watching). A pill
 * opens a floating card above the pills with that kind alone; another pill
 * swaps the card's contents; the same pill, the card's minus button or Esc
 * closes it. Every kind's content stays mounted (hidden) so portals and refs
 * into it, such as desktop's queue, keep their targets.
 */
export function ComposerWorkDrawer({
  defaultExpanded = false,
  queuedCount,
  queuedPanelRef,
  queuedPanel,
  background,
}: ComposerWorkDrawerProps): JSX.Element | null {
  const sections = background?.sections;
  const needsYou = background?.needsYou ?? 0;
  const running = background?.running ?? 0;
  const watching = background?.watching ?? 0;
  const pullRequests = background?.pullRequests ?? 0;
  const kinds: readonly WorkKind[] = [
    {
      key: 'needs-you',
      label: 'Needs you',
      count: needsYou,
      content: sections?.needsYou,
      controls: running === 0 ? sections?.controls : undefined,
      attention: true,
    },
    {
      key: 'queued',
      label: 'Queued',
      count: queuedCount,
      content: (
        <div ref={queuedPanelRef} data-testid="composer-work-drawer-queued">
          {queuedPanel}
        </div>
      ),
    },
    {
      key: 'running',
      label: 'Running',
      count: running,
      content: sections ? (
        <>
          {sections.running}
          {sections.completed}
        </>
      ) : (
        background?.panel
      ),
      controls: sections?.controls,
      glyph: 'running',
    },
    {
      key: 'pull-requests',
      label: 'Pull requests',
      count: pullRequests,
      content: sections?.pullRequests,
    },
    {
      key: 'watching',
      label: 'Watching',
      count: watching,
      content: sections?.watching,
    },
  ];
  const shown = kinds.filter(({ count }) => count > 0);
  const [selected, setSelected] = useState<string | null>(() =>
    defaultExpanded ? (shown[0]?.key ?? null) : null,
  );
  const [animate, setAnimate] = useState(false);
  // The kind the card shows: the open one, or while it closes, the one it
  // showed, so its rows leave with it.
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (selected !== null && selected !== lastKey) setLastKey(selected);
  // A kind whose work ends closes its card, and forgets it: work that
  // returns later never reopens a card on its own.
  const open = shown.find(({ key }) => key === selected) ?? null;
  if (selected !== null && open === null) setSelected(null);
  const expanded = open !== null;
  const shownKind = open ?? shown.find(({ key }) => key === lastKey) ?? null;
  // The execution controls (View tree, Stop all): the same element for every
  // kind that offers them.
  const cardControls = sections?.controls;
  const onExpandedChange =
    background?.onExpandedChange ?? background?.sections?.onExpandedChange;
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);
  const cardId = useId();
  const sectionRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef(new Map<string, HTMLButtonElement>());
  const cardBodyRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const groupRefs = useRef(new Map<string, HTMLDivElement>());
  // Switching pills on an open card: the card's height before the switch
  // and the side the new kind comes from (1: its pill is to the right).
  const switchFrom = useRef<{
    readonly height: number;
    readonly direction: 1 | -1;
  } | null>(null);
  // The kind sliding out, shown over the new one until it has left.
  const [leaving, setLeaving] = useState<string | null>(null);
  const switchMotion = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const from = switchFrom.current;
    switchFrom.current = null;
    // A fast second click starts from where the first left things.
    for (const running of switchMotion.current) running.cancel();
    switchMotion.current = [];
    const body = cardBodyRef.current;
    const incoming = open ? groupRefs.current.get(open.key) : undefined;
    if (!from || !body || !incoming || typeof body.animate !== 'function')
      return;
    const reduce = drawerReducedMotion();
    const travel = (side: number): string =>
      reduce ? 'none' : `translateX(${String(side * 12)}px)`;
    const easing = drawerEasing(body);
    const enter = { duration: CARD_ENTER_MS, easing };
    const motion: Animation[] = [
      incoming.animate(
        [
          { transform: travel(from.direction), opacity: 0 },
          { transform: 'none', opacity: 1 },
        ],
        enter,
      ),
    ];
    if (labelRef.current)
      motion.push(
        labelRef.current.animate(
          [
            { transform: travel(from.direction / 2), opacity: 0 },
            { transform: 'none', opacity: 1 },
          ],
          enter,
        ),
      );
    const outgoing = leaving ? groupRefs.current.get(leaving) : undefined;
    if (outgoing) {
      const exit = outgoing.animate(
        [
          { transform: 'none', opacity: 1 },
          { transform: travel(-from.direction), opacity: 0 },
        ],
        { duration: CARD_EXIT_MS, easing, fill: 'forwards' },
      );
      exit.onfinish = (): void => setLeaving(null);
      motion.push(exit);
    }
    // The card's height follows the new kind's, on the same curve, so the
    // card never jumps; reduced motion lets it settle at once.
    const height = body.getBoundingClientRect().height;
    if (!reduce && Math.abs(height - from.height) > 0.5)
      motion.push(
        body.animate(
          [
            { height: `${String(from.height)}px`, overflow: 'hidden' },
            { height: `${String(height)}px`, overflow: 'hidden' },
          ],
          enter,
        ),
      );
    switchMotion.current = motion;
    // Only the switch itself drives this; `leaving` is set with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.key]);
  useEffect(
    () => (): void => {
      for (const running of switchMotion.current) running.cancel();
    },
    [],
  );
  // Closing hands focus back to the card's pill before the card turns
  // inert, so keyboard and screen-reader users keep their place.
  const closeCard = (animateClose: boolean): void => {
    if (open) pillRefs.current.get(open.key)?.focus();
    setAnimate(animateClose);
    setSelected(null);
  };
  useEscapeToClose(sectionRef, expanded, () => closeCard(false));
  if (shown.length === 0) return null;
  return (
    <SpinnerStyleProvider value="comet">
      <DrawerRowPresentationContext.Provider value="drawer">
        <div
          ref={sectionRef}
          data-testid="composer-work-drawer"
          data-chat-cancel-shortcut-ignore={expanded ? 'true' : undefined}
          // The stack's inset from the composer's edges lives here alone,
          // so the pills and the floating card move together: 8px, the
          // composer's + button's inset, so their edges line up with it.
          className="flex min-w-0 flex-col px-2 pb-2"
        >
          <DrawerReveal expanded={expanded} animate={animate}>
            {/* The card's gap to the pills is padding, so it closes with it. */}
            <div className="pb-2">
              <Surface
                as="section"
                variant="card"
                // The rows' 18px corners nest in its 22px ones over the 4px
                // inset, as in the drawer it replaced.
                size="drawer"
                id={cardId}
                aria-label={shownKind?.label ?? 'Work'}
                className="min-w-0"
              >
                <div
                  ref={cardBodyRef}
                  className={`${DRAWER_CARD_GROUP_CLASS} flex min-w-0 flex-col p-1`}
                >
                  <div className="flex min-h-8 items-center gap-1.5 pl-2.75 pr-1 text-s fg-tertiary">
                    <span
                      ref={labelRef}
                      className="inline-flex items-center gap-1.5"
                    >
                      {shownKind?.label} <Count value={shownKind?.count ?? 0} />
                    </span>
                    <div className="ml-auto flex items-center gap-0">
                      {/* The card's own actions show on hover, focus or
                          touch; its close button always shows. One mounted
                          instance, hidden for kinds without them, so a Stop
                          all waiting for its confirmation keeps it across a
                          switch or a close. */}
                      {cardControls ? (
                        <span
                          hidden={!shownKind?.controls}
                          className={`flex items-center ${DRAWER_CARD_ACTIONS_CLASS}`}
                        >
                          {cardControls}
                        </span>
                      ) : null}
                      <Button
                        variant="ghost-quiet"
                        size="sm"
                        iconOnly
                        aria-label={`Hide ${shownKind?.label.toLowerCase() ?? 'work'}`}
                        data-testid="composer-work-card-close"
                        onClick={(event): void => closeCard(event.detail > 0)}
                      >
                        <MinusIcon />
                      </Button>
                    </div>
                  </div>
                  <OverlayScrollArea
                    viewportRef={
                      background?.viewportRef ?? sections?.viewportRef
                    }
                    viewportProps={{
                      'data-testid': 'composer-work-drawer-list',
                    }}
                    className="[--background-drawer-list-max:min(18.25rem,calc(35vh+1.5rem))]"
                    // Rounded like its rows, 4px inside the card's corners, so a
                    // row cut by the list's edge while scrolling keeps their
                    // corner.
                    viewport="drawer"
                    viewportClassName="max-h-[var(--background-drawer-list-max)]"
                    edgeFadeSize={6}
                    edgeFadeTopSize={16}
                  >
                    {/* The kind sliding out lies over the new one until it
                        has left. */}
                    <div className="relative">
                      {kinds.map(({ key, label, content }) => {
                        const outgoing =
                          leaving === key && shownKind?.key !== key;
                        return (
                          <div
                            key={key}
                            ref={(node: HTMLDivElement | null): void => {
                              if (node) groupRefs.current.set(key, node);
                              else groupRefs.current.delete(key);
                            }}
                            hidden={shownKind?.key !== key && !outgoing}
                            inert={outgoing}
                            aria-hidden={outgoing || undefined}
                            className={
                              outgoing
                                ? 'pointer-events-none absolute inset-x-0 top-0'
                                : undefined
                            }
                            data-work-group={label}
                          >
                            {content}
                          </div>
                        );
                      })}
                    </div>
                  </OverlayScrollArea>
                </div>
              </Surface>
            </div>
          </DrawerReveal>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {shown.map(({ key, label, count, glyph, attention }) => {
              const isOpen = open?.key === key;
              return (
                <Button
                  key={key}
                  ref={(node: HTMLButtonElement | null): void => {
                    if (node) pillRefs.current.set(key, node);
                    else pillRefs.current.delete(key);
                  }}
                  // At rest a pill takes the faint `tinted` fill; the open one
                  // the raised `secondary` fill, so it stands out. Neither
                  // draws a border, so opening one moves nothing.
                  variant={isOpen ? 'secondary' : 'tinted'}
                  size="compact"
                  leadingIcon={glyph !== undefined}
                  aria-expanded={isOpen}
                  aria-controls={cardId}
                  data-testid="composer-work-pill"
                  data-work-kind={key}
                  onClick={(event): void => {
                    setAnimate(event.detail > 0 && (isOpen || !expanded));
                    // Another pill on an open card: the content slides
                    // toward the new pill's side. Keyboard switches are
                    // instant.
                    if (open && !isOpen && event.detail > 0) {
                      const order = shown.map((kind) => kind.key);
                      switchFrom.current = {
                        height:
                          cardBodyRef.current?.getBoundingClientRect().height ??
                          0,
                        direction:
                          order.indexOf(key) > order.indexOf(open.key) ? 1 : -1,
                      };
                      setLeaving(open.key);
                    } else setLeaving(null);
                    setSelected(isOpen ? null : key);
                  }}
                >
                  {/* The pill's own inset and gap, as every
                      icon-first capsule: the glyph at its default size leads the
                      label, with no slot or spinner override. */}
                  {glyph ? <StatusGlyph tone="state" state={glyph} /> : null}
                  <span className={attention ? 'fg-warning-strong' : undefined}>
                    {label}
                  </span>
                  <span className="fg-quaternary">{count}</span>
                </Button>
              );
            })}
          </div>
        </div>
      </DrawerRowPresentationContext.Provider>
    </SpinnerStyleProvider>
  );
}
