'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  agentVisualFontFaceKey,
  buildAgentVisualFontsMessage,
} from '../../lib/agent-visual-fonts';
import {
  AGENT_VISUAL_FRAME_ALLOW,
  AGENT_VISUAL_FRAME_SANDBOX,
  AGENT_VISUAL_HEARTBEAT_INTERVAL_MS,
  AGENT_VISUAL_HEARTBEAT_MISSES,
  buildAgentVisualGestureRequest,
  buildAgentVisualGestureWatchMessage,
  buildAgentVisualHostContextMessage,
  buildAgentVisualLoadMessage,
  buildAgentVisualSrcDoc,
  buildAgentVisualWrapperSrcDoc,
  clampAgentVisualHeight,
  parseAgentVisualFrameMessage,
  pickAgentVisualHeightHint,
  type AgentVisualTheme,
} from '../../lib/agent-visual-html';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { DownloadIcon, ExternalIcon } from '../../icons/AppIcons';
import { BUBBLE_ACTION_GLYPH_PX } from '../bubble-badge';
import { ControlButton, Button } from '../../primitives/Button';
import { Tooltip } from '../../primitives/Tooltip';
import {
  AGENT_VISUAL_MODIFIER_KEYS,
  agentVisualNeedsClick,
  hostPointerBefore,
  lastHostTypingAt,
  rememberAgentVisualNeedsClick,
  subscribeAgentVisualNeedsClick,
  watchHostPointer,
  watchHostTyping,
} from './agent-visual-frame-focus';
import {
  loadAgentVisualFonts,
  watchAgentVisualFontLoads,
} from './agent-visual-frame-fonts';
import {
  getAgentVisualTheme,
  observeAgentVisualFrame,
  subscribeAgentVisualTheme,
} from './agent-visual-frame-runtime';

export type AgentVisualFrameStatus =
  | 'loading'
  | 'ready'
  | 'unresponsive'
  | 'navigated'
  | 'error';

export interface AgentVisualFrameTestIds {
  frame: string;
  interactButton: string;
  expandButton: string;
  saveButton: string;
  unavailableState: string;
  errorState: string;
  retryButton: string;
}

export interface AgentVisualFrameProps {
  document: string;
  title: string;
  maxHeight: number;
  heights?: ReadonlyArray<readonly [number, number]>;
  /** Host snapshot; Worker A shares one observer per ownerDocument. */
  theme: AgentVisualTheme;
  onOpenLink(url: string): void;
  onExpand?(): void;
  onSave?(): void;
  onStatusChange?(status: AgentVisualFrameStatus): void;
  variant: 'inline' | 'expanded';
  /**
   * Admitted to one of the window's live frames ahead of inline visuals, as an
   * expanded one is, without its layout. For a visual the user opened to look
   * at, such as an entry in the Chat visuals panel.
   */
  prioritized?: boolean;
  /**
   * A same-origin URL where the host serves the relay's shell document
   * (`buildAgentVisualShellDocument`, with its response headers). Set by a
   * host whose page policy would apply to an inline frame and block the
   * visual's scripts; the frame then loads from this URL and takes its agent
   * document by message. Absent, the frame is built inline around it.
   */
  frameUrl?: string;
  /**
   * Whether the visual may load CDN scripts, styles and fonts. Defaults to
   * true; hosts pass `allowsAgentVisualRemoteAssets(capabilities)`.
   */
  remoteAssets?: boolean;
  testIds: AgentVisualFrameTestIds;
}

export function useAgentVisualHostTheme(): AgentVisualTheme {
  const ownerDocument = typeof document === 'undefined' ? null : document;
  const subscribe = useCallback(
    (listener: () => void) =>
      ownerDocument
        ? subscribeAgentVisualTheme(ownerDocument, listener)
        : (): void => {},
    [ownerDocument],
  );
  const snapshot = useCallback(
    () =>
      ownerDocument
        ? getAgentVisualTheme(ownerDocument)
        : { appearance: 'light' as const, variables: {} },
    [ownerDocument],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const DEADLINE_MS =
  AGENT_VISUAL_HEARTBEAT_INTERVAL_MS * AGENT_VISUAL_HEARTBEAT_MISSES;
/**
 * How long the frame's wrapper has to confirm a gesture. A page that holds its
 * thread until the user's next key arrives would see that key counted as the
 * gesture, so only a prompt answer is believed.
 */
const GESTURE_ANSWER_MS = 150;
/** Not every engine tells the host when focus enters a frame, so it looks. */
const FOCUS_WATCH_MS = 100;
/** How long scrolling has to stop over a visual before the pointer is let in. */
const SCROLL_REST_MS = 150;
/** How long after a key typed in the app the pointer waits to be let in. */
const TYPING_QUIET_MS = 1000;

/**
 * A visual answers the pointer as soon as it moves over it, and takes keyboard
 * focus only after a press inside it.
 *
 * The frame is inert at rest, so its script cannot take focus. Pointer movement
 * the host sees over the visual lifts that, unless the user is typing in the
 * app, and a key typed there restores it. While the pointer is let in, focus
 * entering the frame has to be confirmed by the frame's wrapper, which knows
 * whether the user pressed inside the visual. Unconfirmed focus goes back to
 * where it was, and a visual that took it with no gesture then needs a click
 * the host can see.
 */
export function AgentVisualFrame(
  props: AgentVisualFrameProps,
): React.JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [intersecting, setIntersecting] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [activated, setActivated] = useState(false);
  const [status, setStatus] = useState<AgentVisualFrameStatus>('loading');
  const [retry, setRetry] = useState(0);
  const [reportedHeight, setReportedHeight] = useState<number>();
  const height =
    reportedHeight ??
    pickAgentVisualHeightHint(
      props.heights,
      container?.clientWidth,
      props.maxHeight,
    );
  // A visual that took focus with no gesture inside it, in this copy or in
  // any other copy of the same document.
  const needsClickSnapshot = useCallback(
    (): boolean => agentVisualNeedsClick(props.document),
    [props.document],
  );
  const needsClick = useSyncExternalStore(
    subscribeAgentVisualNeedsClick,
    needsClickSnapshot,
    needsClickSnapshot,
  );
  const frame = useRef<HTMLIFrameElement | null>(null);
  const activatedRef = useRef(false);
  /** A click or key press on the host control opened the visual. */
  const explicitRef = useRef(false);
  /** The wrapper confirmed a gesture for the focus the frame now holds. */
  const confirmedRef = useRef(false);
  const gestureCheck = useRef<{ id: number; cancel(): void } | null>(null);
  /** A check that ran out of time; its answer can still condemn the visual. */
  const lateGestureId = useRef<number | null>(null);
  const nextGestureId = useRef(0);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  /**
   * The pointer may have moved inside the frame, out of the app's sight,
   * since it last crossed an element of the app.
   */
  const pointerMayBeInFrame = useRef(false);
  const cancelPendingOpen = useRef<(() => void) | null>(null);
  const focusBefore = useRef<HTMLElement | null>(null);
  const watchFocus = useRef((): void => {});
  /** The wrapper is sampling focus and activation for this pointer visit. */
  const watchingRef = useRef(false);
  const statusRef = useRef<AgentVisualFrameStatus | null>(null);
  const lastAlive = useRef(0);
  const ready = useRef(false);
  const callbacks = useRef({
    onOpenLink: (url: string): void => props.onOpenLink(url),
    onStatusChange: (status: AgentVisualFrameStatus): void =>
      props.onStatusChange?.(status),
  });
  callbacks.current = {
    onOpenLink: (url: string): void => props.onOpenLink(url),
    onStatusChange: (status: AgentVisualFrameStatus): void =>
      props.onStatusChange?.(status),
  };
  const source = useRef<{
    document: string;
    retry: number;
    theme: AgentVisualTheme;
    title: string;
    frameUrl: string | undefined;
    remoteAssets: boolean;
    /** Counts rebuilds, so a served frame is loaded again for each. */
    version: number;
    agentSrcDoc: string;
    /** The inline wrapper; absent for a frame the host serves. */
    srcDoc: string | undefined;
  } | null>(null);
  const theme = useRef(props.theme);
  theme.current = props.theme;
  const ownerDocument = container?.ownerDocument ?? null;
  const ownsRealm =
    ownerDocument !== null &&
    typeof document !== 'undefined' &&
    ownerDocument === document;
  const mounted =
    ownsRealm &&
    intersecting &&
    allowed &&
    status !== 'error' &&
    status !== 'unresponsive' &&
    status !== 'navigated';

  const remoteAssets = props.remoteAssets !== false;
  // A live frame takes theme changes by message, without reloading; a frame
  // that is not mounted is rebuilt so its next mount starts in the current theme.
  if (
    !source.current ||
    source.current.document !== props.document ||
    source.current.retry !== retry ||
    source.current.frameUrl !== props.frameUrl ||
    source.current.remoteAssets !== remoteAssets ||
    (!mounted && source.current.theme !== props.theme)
  ) {
    const agentSrcDoc = buildAgentVisualSrcDoc(props.document, props.theme, {
      remoteAssets,
    });
    source.current = {
      document: props.document,
      retry,
      theme: props.theme,
      title: props.title,
      frameUrl: props.frameUrl,
      remoteAssets,
      version: (source.current?.version ?? 0) + 1,
      agentSrcDoc,
      srcDoc:
        props.frameUrl === undefined
          ? buildAgentVisualWrapperSrcDoc(agentSrcDoc, {
              title: props.title,
              appearance: props.theme.appearance,
              remoteAssets,
            })
          : undefined,
    };
  }

  const updateStatus = useCallback((next: AgentVisualFrameStatus) => {
    if (statusRef.current === next) return;
    statusRef.current = next;
    setStatus(next);
    callbacks.current.onStatusChange?.(next);
  }, []);
  const deactivate = useCallback(() => {
    if (watchingRef.current) {
      watchingRef.current = false;
      frame.current?.contentWindow?.postMessage(
        buildAgentVisualGestureWatchMessage(false),
        '*',
      );
    }
    activatedRef.current = false;
    explicitRef.current = false;
    confirmedRef.current = false;
    pointerAt.current = null;
    cancelPendingOpen.current?.();
    cancelPendingOpen.current = null;
    gestureCheck.current?.cancel();
    gestureCheck.current = null;
    setActivated(false);
  }, []);
  useEffect(
    () => (): void => {
      cancelPendingOpen.current?.();
      gestureCheck.current?.cancel();
    },
    [],
  );
  useEffect(() => {
    if (!ownerDocument || !ownsRealm) return;
    watchHostTyping(ownerDocument);
    watchHostPointer(ownerDocument);
  }, [ownerDocument, ownsRealm]);

  const prioritized =
    props.variant === 'expanded' || props.prioritized === true;
  useEffect(() => {
    if (!container || !ownsRealm || !ownerDocument) return;
    return observeAgentVisualFrame(
      ownerDocument,
      container,
      prioritized,
      (visible, permitted) => {
        setIntersecting(visible);
        setAllowed(permitted);
        // Losing the slot unmounts the frame; its replacement starts view-only.
        if (!visible || !permitted) deactivate();
      },
    );
  }, [container, ownsRealm, ownerDocument, prioritized, deactivate]);

  useEffect(() => {
    if (!mounted || !ownerDocument) return;
    const view = ownerDocument.defaultView;
    if (!view) return;
    ready.current = false;
    lastAlive.current = Date.now();
    updateStatus('loading');
    const checkFocus = (): void => {
      if (ownerDocument.activeElement !== frame.current) {
        confirmedRef.current = false;
        return;
      }
      if (!activatedRef.current) {
        updateStatus('error');
        return;
      }
      if (explicitRef.current || confirmedRef.current || gestureCheck.current)
        return;
      nextGestureId.current += 1;
      const id = nextGestureId.current;
      const timer = view.setTimeout((): void => {
        if (gestureCheck.current?.id !== id) return;
        gestureCheck.current = null;
        // A page too busy to answer is not a hostile one: focus goes back,
        // and only a refusal that still arrives counts against the visual.
        lateGestureId.current = id;
        returnFocus();
      }, GESTURE_ANSWER_MS);
      gestureCheck.current = {
        id,
        cancel: (): void => view.clearTimeout(timer),
      };
      frame.current?.contentWindow?.postMessage(
        buildAgentVisualGestureRequest(id),
        '*',
      );
    };
    const returnFocus = (): void => {
      const previous = focusBefore.current;
      const held = ownerDocument.activeElement === frame.current;
      deactivate();
      if (!held) return;
      // Some engines keep the frame's window focused until this one asks.
      view.focus();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      else frame.current?.blur();
      // An engine that leaves focus in the frame anyway loses the visual.
      view.setTimeout(checkFocus, 0);
    };
    // A visual that takes focus with no gesture inside it gives it back, and
    // moving the pointer over it no longer opens it, here or anywhere else it
    // is shown.
    const refuseFocus = (): void => {
      rememberAgentVisualNeedsClick(props.document);
      returnFocus();
    };
    watchFocus.current = checkFocus;
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = parseAgentVisualFrameMessage(event.data);
      if (!message) return;
      if (message.kind === 'size-changed') {
        setReportedHeight(
          clampAgentVisualHeight(
            message.height,
            Math.min(props.maxHeight, 2000),
          ),
        );
      } else if (message.kind === 'open-link') {
        const target = new URL(message.url);
        if (
          activatedRef.current &&
          ownerDocument.activeElement === frame.current &&
          view.navigator.userActivation?.isActive === true &&
          target.origin !== view.location.origin
        ) {
          callbacks.current.onOpenLink(target.href);
        }
      } else if (message.kind === 'gesture') {
        if (lateGestureId.current === message.id) {
          lateGestureId.current = null;
          if (message.gesture === 'none') refuseFocus();
          return;
        }
        const pending = gestureCheck.current;
        if (pending?.id !== message.id) return;
        pending.cancel();
        gestureCheck.current = null;
        // Only a press seen before the focus counts. A gesture seen only
        // after it can be a key typed into a field the page focused itself;
        // when the wrapper cannot tell, the focus goes back without blame.
        if (message.gesture === 'none') refuseFocus();
        else if (message.gesture === 'unclear') returnFocus();
        else if (ownerDocument.activeElement === frame.current)
          confirmedRef.current = true;
      } else if (message.state === 'awaiting-document') {
        // Only a frame the host serves asks; an inline one holds its document.
        // The target origin is `*` because the sandboxed shell has an opaque
        // origin; the message goes only to this frame's own window, which
        // the handler above already matched as the sender.
        const current = source.current;
        if (current?.frameUrl !== undefined)
          frame.current?.contentWindow?.postMessage(
            buildAgentVisualLoadMessage({
              srcdoc: current.agentSrcDoc,
              title: current.title,
              appearance: current.theme.appearance,
            }),
            '*',
          );
      } else if (message.state === 'ready' || message.state === 'alive') {
        // A theme posted while the new frame was still loading was lost.
        if (message.state === 'ready')
          frame.current?.contentWindow?.postMessage(
            buildAgentVisualHostContextMessage(theme.current),
            '*',
          );
        ready.current = true;
        lastAlive.current = Date.now();
        updateStatus('ready');
      } else if (message.state === 'navigated') {
        deactivate();
        updateStatus('navigated');
      }
    };
    const onFocus = (event: FocusEvent): void => {
      if (ownerDocument.activeElement === frame.current) {
        checkFocus();
        return;
      }
      if (event.target instanceof view.HTMLElement)
        focusBefore.current = event.target;
      deactivate();
    };
    // Focus entering an out-of-process frame blurs this window without always
    // dispatching focusin here, so recheck once the focus change has settled.
    const onBlur = (): void => {
      view.setTimeout(checkFocus, 0);
    };
    const onVisibility = (): void => {
      if (ownerDocument.visibilityState === 'visible')
        lastAlive.current = Date.now();
    };
    // Chromium and WebKit treat the pointer as having left the container once
    // it enters the iframe, so no pointerleave follows when it moves off the
    // visual; the pointer arriving on a host element outside it is reliable.
    const onPointerOver = (event: Event): void => {
      if (
        !container ||
        !(event.target instanceof view.Node) ||
        container.contains(event.target)
      )
        return;
      pointerMayBeInFrame.current = false;
      if (ownerDocument.activeElement !== frame.current) deactivate();
    };
    // Typing in the app closes the visual, so its script cannot move focus
    // into it mid-word. Escape closes it the same way.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        ownerDocument.activeElement !== frame.current &&
        !AGENT_VISUAL_MODIFIER_KEYS.has(event.key)
      )
        deactivate();
    };
    const tick = (): void => {
      if (ownerDocument.visibilityState !== 'visible' || !intersecting) return;
      if (Date.now() - lastAlive.current >= DEADLINE_MS) {
        deactivate();
        updateStatus(ready.current ? 'unresponsive' : 'error');
      }
    };
    view.addEventListener('message', onMessage);
    ownerDocument.addEventListener('focusin', onFocus);
    view.addEventListener('blur', onBlur);
    ownerDocument.addEventListener('visibilitychange', onVisibility);
    ownerDocument.addEventListener('keydown', onKeyDown, true);
    ownerDocument.addEventListener('pointerover', onPointerOver);
    const timer = view.setInterval(tick, 1000);
    return (): void => {
      view.removeEventListener('message', onMessage);
      ownerDocument.removeEventListener('focusin', onFocus);
      view.removeEventListener('blur', onBlur);
      ownerDocument.removeEventListener('visibilitychange', onVisibility);
      ownerDocument.removeEventListener('keydown', onKeyDown, true);
      ownerDocument.removeEventListener('pointerover', onPointerOver);
      view.clearInterval(timer);
    };
  }, [
    mounted,
    container,
    ownerDocument,
    retry,
    props.maxHeight,
    props.document,
    updateStatus,
    deactivate,
    intersecting,
  ]);

  useEffect(() => {
    if (!mounted) return;
    frame.current?.contentWindow?.postMessage(
      buildAgentVisualHostContextMessage(props.theme),
      '*',
    );
  }, [mounted, props.theme]);

  const fontSans = props.theme.variables['--font-sans'];
  const fontMono = props.theme.variables['--font-mono'];
  useEffect(() => {
    // The app's own font faces, so the visual's text matches the app. A frame
    // that is still loading drops the message; `ready` sends it again. A face
    // the app is still loading is left out, so each finished load sends the
    // faces this frame does not have yet.
    if (!mounted || status !== 'ready' || !ownerDocument) return;
    let cancelled = false;
    const sent = new Set<string>();
    const sendFonts = (): void => {
      void loadAgentVisualFonts(ownerDocument, theme.current).then((faces) => {
        if (cancelled) return;
        const fresh = faces.filter(
          (face) => !sent.has(agentVisualFontFaceKey(face)),
        );
        if (fresh.length === 0) return;
        for (const face of fresh) sent.add(agentVisualFontFaceKey(face));
        frame.current?.contentWindow?.postMessage(
          buildAgentVisualFontsMessage(fresh),
          '*',
        );
      });
    };
    sendFonts();
    const unwatch = watchAgentVisualFontLoads(ownerDocument, sendFonts);
    return (): void => {
      cancelled = true;
      unwatch();
    };
  }, [mounted, status, ownerDocument, fontSans, fontMono]);

  useEffect(() => {
    // Only the host control moves focus in; the pointer alone never does. An
    // inert frame refuses focus, so focus follows the commit that clears it.
    if (activated && explicitRef.current) frame.current?.focus();
  }, [activated]);

  useEffect(() => {
    if (!activated || !mounted) return;
    const view = ownerDocument?.defaultView;
    if (!view) return;
    const timer = view.setInterval(
      (): void => watchFocus.current(),
      FOCUS_WATCH_MS,
    );
    return (): void => view.clearInterval(timer);
  }, [activated, mounted, ownerDocument]);

  const activate = (): void => {
    if (!mounted || !frame.current) return;
    explicitRef.current = true;
    activatedRef.current = true;
    pointerMayBeInFrame.current = true;
    setActivated(true);
  };
  const openToPointer = (): void => {
    // Read again rather than from the render: another copy of this visual may
    // have been refused since, and a delayed open runs later still.
    if (agentVisualNeedsClick(props.document)) return;
    const view = ownerDocument?.defaultView;
    const focused = ownerDocument?.activeElement;
    focusBefore.current =
      view &&
      focused instanceof view.HTMLElement &&
      focused !== ownerDocument.body
        ? focused
        : null;
    explicitRef.current = false;
    activatedRef.current = true;
    pointerMayBeInFrame.current = true;
    // The wrapper orders the user's press against focus entering the visual,
    // so it samples both for as long as the pointer has the visual open.
    if (!watchingRef.current) {
      watchingRef.current = true;
      frame.current?.contentWindow?.postMessage(
        buildAgentVisualGestureWatchMessage(true),
        '*',
      );
    }
    setActivated(true);
  };
  // Lets the pointer in after `delay`, if it is still over the visual then.
  const openToPointerAfter = (control: HTMLElement, delay: number): void => {
    const view = ownerDocument?.defaultView;
    if (!view) return;
    cancelPendingOpen.current?.();
    const timer = view.setTimeout((): void => {
      cancelPendingOpen.current = null;
      if (control.isConnected && control.matches(':hover')) openToPointer();
    }, delay);
    cancelPendingOpen.current = (): void => view.clearTimeout(timer);
  };
  // A hand that brushes the mouse mid-sentence should not open a visual: the
  // next key would land in whatever took focus there.
  const typingQuietLeft = (): number =>
    ownerDocument
      ? lastHostTypingAt(ownerDocument) + TYPING_QUIET_MS - Date.now()
      : 0;
  const letPointerIn = (event: React.PointerEvent<HTMLButtonElement>): void => {
    // Touch movement scrolls; a tap reaches the control as a click.
    if (!mounted || event.pointerType === 'touch') return;
    // The first move onto the visual is measured from where the app last saw
    // the pointer, unless it may have moved inside the frame since.
    const seen =
      pointerAt.current ??
      (pointerMayBeInFrame.current || !ownerDocument
        ? null
        : hostPointerBefore(ownerDocument, event.nativeEvent));
    pointerAt.current = { x: event.clientX, y: event.clientY };
    // A layout change under a resting pointer replays its position, so only
    // movement counts.
    if (!seen || (seen.x === event.clientX && seen.y === event.clientY)) return;
    const wait = typingQuietLeft();
    if (wait > 0) openToPointerAfter(event.currentTarget, wait);
    else openToPointer();
  };
  // Scrolling can bring a visual under a pointer that then clicks without
  // moving. Once the scroll rests there, the pointer is let in; sooner, the
  // visual could take the scroll.
  const letRestingPointerIn = (
    event: React.WheelEvent<HTMLButtonElement>,
  ): void => {
    if (!mounted) return;
    openToPointerAfter(
      event.currentTarget,
      Math.max(SCROLL_REST_MS, typingQuietLeft()),
    );
  };
  const failed =
    status === 'error' || status === 'unresponsive' || status === 'navigated';
  const unavailable = ownerDocument !== null && !ownsRealm;
  const glyph = {
    width: BUBBLE_ACTION_GLYPH_PX,
    height: BUBBLE_ACTION_GLYPH_PX,
  };
  return (
    // The frame box holds the visual at its full rectangle; the corner actions
    // sit outside it so they can overhang the corner, as the badges on a user
    // bubble do.
    <div
      ref={setContainer}
      className="group/visual relative"
      style={{
        height: props.variant === 'expanded' ? '100%' : height,
      }}
    >
      <div className="relative h-full overflow-hidden">
        {unavailable ? (
          <div
            data-testid={props.testIds.unavailableState}
            className="flex h-full items-center justify-center px-4 text-s fg-secondary"
          >
            Open this chat in the main window to see the visual.
          </div>
        ) : null}
        {failed ? (
          <div
            data-testid={props.testIds.errorState}
            role="status"
            className="flex h-full items-center justify-center gap-3 px-4 text-s fg-secondary"
          >
            {status === 'unresponsive'
              ? 'This visual stopped responding.'
              : status === 'navigated'
                ? 'This visual tried to leave its frame and was stopped.'
                : "This visual couldn't be shown."}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid={props.testIds.retryButton}
              onClick={(): void => {
                ready.current = false;
                deactivate();
                updateStatus('loading');
                setRetry((value): number => value + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {mounted ? (
          <>
            <iframe
              // A served frame takes one document, so each rebuild is a new
              // frame; an inline one reloads when its srcdoc changes.
              key={
                source.current.frameUrl === undefined
                  ? undefined
                  : source.current.version
              }
              ref={frame}
              data-testid={props.testIds.frame}
              title={props.title}
              sandbox={AGENT_VISUAL_FRAME_SANDBOX}
              referrerPolicy="no-referrer"
              allow={AGENT_VISUAL_FRAME_ALLOW}
              src={source.current.frameUrl}
              srcDoc={source.current.srcDoc}
              inert={!activated}
              // Agent content: kept out of session replay on every surface.
              className={`${REPLAY_BLOCK_CLASS} block h-full w-full border-0`}
            />
            {!activated ? (
              // Over the visual at rest: it sees the pointer arrive, and it is
              // the control a keyboard, a tap, or a visual that needs a click
              // opens the visual with.
              <ControlButton
                type="button"
                data-testid={props.testIds.interactButton}
                aria-label={`Interact with ${props.title}`}
                onPointerMove={letPointerIn}
                onWheel={letRestingPointerIn}
                onClick={activate}
                presentation="agent-frame-activate"
                appearance={{ needsClick }}
              />
            ) : null}
          </>
        ) : null}
      </div>
      {/* After the frame in tab order, so Tab out of the visual reaches them. */}
      <div
        className={`absolute z-10 flex items-center gap-1 transition-opacity pointer-coarse:opacity-100 ${
          // A frame the pointer is in takes the hover with it, so the actions
          // stay up for as long as the pointer is let in.
          activated
            ? 'opacity-100'
            : 'opacity-0 group-focus-within/visual:opacity-100 group-hover/visual:opacity-100'
        } ${
          // A dialog clips at its edge, so the actions stay inside the frame.
          props.variant === 'expanded' ? 'right-2 top-2' : '-right-2 -top-2'
        }`}
      >
        {/* A window that cannot show the visual has no use for its panel. */}
        {props.onExpand && props.variant === 'inline' && !unavailable ? (
          <Tooltip label="Open in Chat visuals">
            <Button
              variant="secondary"
              size="compact"
              iconOnly
              touchArea="contained"
              data-testid={props.testIds.expandButton}
              aria-label="Open in Chat visuals"
              onClick={(): void => props.onExpand?.()}
            >
              <ExternalIcon {...glyph} />
            </Button>
          </Tooltip>
        ) : null}
        {props.onSave ? (
          <Tooltip label="Save as HTML">
            <Button
              variant="secondary"
              size="compact"
              iconOnly
              touchArea="contained"
              data-testid={props.testIds.saveButton}
              aria-label="Save as HTML"
              onClick={(): void => props.onSave?.()}
            >
              <DownloadIcon {...glyph} />
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
