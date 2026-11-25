import { Surface } from '@canopy/ui-shared/components';
import { Button } from '@canopy/ui-shared';
import {
  PANEL_LAYOUT_ANIMATION_EVENT,
  PANEL_LAYOUT_ANIMATION_MS,
} from '@canopy/ui-shared/panels';
import { LoadingSpinner } from '@/components/shared/loading';
import {
  BROWSER_NATIVE_VIEW_COVER_CHANGED_EVENT,
  BROWSER_NATIVE_VIEW_COVERED_ATTRIBUTE,
  BROWSER_NATIVE_VIEW_FROZEN_ATTRIBUTE,
  hasBrowserNativeViewOverlay,
  subscribeBrowserOverlayTopology,
} from '@/lib/browserNativeOverlay';
import { browserLoadingLabel } from '@/lib/browserUrl';
import { BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT } from '@/lib/browserViewBounds';
import {
  selectUnreadConsoleErrorCount,
  selectUnreadDiagnosticCount,
  selectUnreadFailedRequestCount,
  useBrowserStore,
} from '@/stores/browserStore';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { BrowserCornerRadii } from '@canopy/desktop-shared/types';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { BrowserAddressBar } from './BrowserAddressBar';
import { BrowserDownloadNotices } from './BrowserDownloadNotices';
import { BrowserFileChooserNotice } from './BrowserFileChooserNotice';
import { BrowserPrintRequestNotice } from './BrowserPrintRequestNotice';
import { BrowserAuthRequestNotice } from './BrowserAuthRequestNotice';
import { BrowserSignInDialog } from './BrowserSignInDialog';
import { BrowserInspector } from './BrowserInspector';
import { BrowserJavaScriptDialogModal } from './BrowserJavaScriptDialogModal';
import { RefreshIcon } from '@canopy/ui-shared/icons/AppIcons';
import { recordBrowserTabPreview } from '@/lib/panels/browser-tab-preview';
import { useHiddenRailContentMounted } from '@/components/activity/useHiddenRailContentMounted';

interface BrowserPaneProps {
  projectId: string;
  worktreeId: string;
  /** Exact browser session this pane renders and controls. */
  browserId: string;
  /**
   * Whether the hosting panel is visible (active tab of a shown, expanded
   * group). Drives the embedded `WebContentsView` visibility so it never
   * covers other app chrome, and gates LAZY live-view creation: a hidden
   * restored pane stays inert until it becomes visible or an explicit action
   * targets it.
   */
  visible: boolean;
}

const FREEZE_FRAME_CAPTURE_FALLBACK_MS = 250;
/** A frame at most this old is not re-taken when a control is pressed. */
const FREEZE_FRAME_FRESH_MS = 300;
/**
 * While the pointer moves over the app's controls, the freeze frame is kept
 * at most this old, so a menu or tooltip opened there can cover the page at
 * once instead of waiting on a capture round trip.
 */
const FREEZE_FRAME_PREFETCH_MS = 1_000;
/**
 * How long after a page finishes loading its first frame is taken, so the
 * first overlay over it never has to wait for one.
 */
const FREEZE_FRAME_AFTER_LOAD_MS = 500;
/** Controls whose hover suggests an overlay may open next. */
const FREEZE_FRAME_PREFETCH_TARGETS =
  'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [aria-haspopup]';

/**
 * Whether the latest frame may no longer show the page. A frame taken while
 * pointing at the control just pressed is current enough for the overlay it
 * opens; otherwise the frame must be from within the hover window. The page
 * can change (scrolling, typing) without the app seeing it, so a press alone
 * never makes an old frame current.
 */
function freezeFrameStale(
  pressedAt: number | null,
  capturedAt: number | null,
): boolean {
  if (capturedAt === null) {
    return true;
  }
  const now = performance.now();
  if (
    pressedAt !== null &&
    now - pressedAt <= FREEZE_FRAME_FRESH_MS &&
    pressedAt - capturedAt <= FREEZE_FRAME_PREFETCH_MS
  ) {
    return false;
  }
  return now - capturedAt > FREEZE_FRAME_PREFETCH_MS;
}

/** Whether a frame still lines up with the page area it would cover. */
function freezeFrameFits(
  frame: BrowserFreezeFrame,
  element: HTMLElement | null,
): boolean {
  const rect = element?.getBoundingClientRect();
  return (
    rect === undefined ||
    (Math.abs(rect.width - frame.width) <= 1 &&
      Math.abs(rect.height - frame.height) <= 1)
  );
}

/** How long after the last window resize event a pane reports once more. */
const RESIZE_SETTLED_REPORT_MS = 160;

/**
 * Panes waiting for a window resize's frame to be laid out. Until it is,
 * the page area's rectangle is still the one for the window's last size.
 */
let resizeFramesPending = 0;

/**
 * Calls `callback` after each frame a window resize produced, once that
 * frame is laid out, and only while the window still has that frame's size
 * (otherwise the next resize calls again).
 */
function afterWindowResizeFrame(callback: () => void): () => void {
  let resizedTo: { width: number; height: number } | null = null;
  const settle = (): void => {
    const seen = resizedTo;
    resizedTo = null;
    if (seen !== null) resizeFramesPending -= 1;
    if (
      seen !== null &&
      seen.width === window.innerWidth &&
      seen.height === window.innerHeight
    ) {
      callback();
    }
  };
  // A message is the first task after the frame; a timer where there is no
  // channel (tests).
  const channel =
    typeof MessageChannel === 'undefined' ? null : new MessageChannel();
  if (channel) channel.port1.onmessage = settle;
  let timer: number | null = null;
  const onResize = (): void => {
    const pending = resizedTo !== null;
    resizedTo = { width: window.innerWidth, height: window.innerHeight };
    if (pending) return;
    resizeFramesPending += 1;
    if (channel) {
      channel.port2.postMessage(null);
    } else {
      timer = window.setTimeout(settle, 0);
    }
  };
  window.addEventListener('resize', onResize);
  return (): void => {
    window.removeEventListener('resize', onResize);
    channel?.port1.close();
    if (timer !== null) window.clearTimeout(timer);
    if (resizedTo !== null) resizeFramesPending -= 1;
    resizedTo = null;
  };
}

/** Runs after two more frames, once a DOM change has reached the screen. */
function afterNextPaint(callback: () => void): () => void {
  let second: number | null = null;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(callback);
  });
  return (): void => {
    cancelAnimationFrame(first);
    if (second !== null) {
      cancelAnimationFrame(second);
    }
  };
}

/** Decodes a captured frame ahead of use; a failed decode still resolves. */
function decodeFreezeFrame(image: HTMLImageElement): Promise<void> {
  return typeof image.decode === 'function'
    ? image.decode().catch(() => undefined)
    : Promise.resolve();
}

function roundRect(rect: DOMRect): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * Whether a blocking app-level overlay currently intersects THIS pane's
 * rectangle. Overlay topology changes come from the shared ref-counted body
 * `MutationObserver` (`subscribeBrowserOverlayTopology`); each mounted pane
 * independently re-tests intersection against its own rect, so one overlay
 * can block one of two side-by-side panes while the other stays live.
 */
function useBrowserNativeViewBlocked(
  targetRef: RefObject<HTMLElement | null>,
): boolean {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let frameId: number | null = null;

    // While an overlay covers the page, any reflow can move it off again,
    // so every change is heard; otherwise only overlay changes.
    let coveredNow = false;
    const update = (): void => {
      frameId = null;
      const target = targetRef.current;
      const covered = hasBrowserNativeViewOverlay(
        document,
        target?.getBoundingClientRect() ?? null,
      );
      coveredNow = covered;
      setBlocked(covered);
      // Published at once (not through React), so the above-browser mirror
      // draws the overlay over the live page in this same frame, until a
      // freeze frame stands in for the page.
      const value = covered ? 'true' : 'false';
      if (
        target &&
        target.getAttribute(BROWSER_NATIVE_VIEW_COVERED_ATTRIBUTE) !== value
      ) {
        target.setAttribute(BROWSER_NATIVE_VIEW_COVERED_ATTRIBUTE, value);
        window.dispatchEvent(
          new Event(BROWSER_NATIVE_VIEW_COVER_CHANGED_EVENT),
        );
      }
    };

    const scheduleUpdate = (): void => {
      if (frameId !== null) {
        return;
      }
      frameId = requestAnimationFrame(update);
    };

    update();

    const unsubscribeTopology = subscribeBrowserOverlayTopology(
      scheduleUpdate,
      { everyChange: () => coveredNow },
    );

    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && targetRef.current
        ? new ResizeObserver(scheduleUpdate)
        : null;
    if (targetRef.current) {
      resizeObserver?.observe(targetRef.current);
    }

    return (): void => {
      unsubscribeTopology();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [targetRef]);

  return blocked;
}

interface BrowserFreezeFrame {
  browserId: string;
  runtimeGeneration?: number;
  /** The page epoch (browser, URL and runtime) the frame was captured in. */
  epoch: number;
  /** `performance.now()` when the capture was requested. */
  capturedAt: number;
  /** The page area's CSS size when the capture was requested. */
  width: number;
  height: number;
  dataUrl: string;
}

/**
 * One browser session's pane: the {@link BrowserAddressBar} (always the first
 * content element), the native-view placeholder rect, and the optional
 * inspector column. Exact-ID throughout: bounds, visibility, overlay freeze
 * frames, diagnostics, and interaction-driven activation all address only
 * `browserId`.
 */
/** An element's corner radii, in CSS px. */
function readCornerRadii(element: HTMLElement): BrowserCornerRadii {
  const style = getComputedStyle(element);
  const radius = (value: string): number => Number.parseFloat(value) || 0;
  return {
    topLeft: radius(style.borderTopLeftRadius),
    topRight: radius(style.borderTopRightRadius),
    bottomRight: radius(style.borderBottomRightRadius),
    bottomLeft: radius(style.borderBottomLeftRadius),
  };
}

export function BrowserPane({
  projectId,
  worktreeId,
  browserId,
  visible,
}: BrowserPaneProps): JSX.Element {
  const snapshot = useBrowserStore((s) => {
    const bucket = s.worktrees[`${projectId}/${worktreeId}`];
    return bucket?.browsers[browserId];
  });
  const live = useBrowserStore((s) => {
    const bucket = s.worktrees[`${projectId}/${worktreeId}`];
    return bucket?.live.has(browserId) ?? false;
  });
  // The backend session is still being created (a just-opened tab, or a
  // restored one being rematerialized).
  const opening = useBrowserStore(
    (s) => s.openingBrowserIds[browserId] === true,
  );
  const inspectorOpen = useBrowserStore(
    (s) => s.inspectorOpen[browserId] ?? false,
  );
  const dialog = useBrowserStore((s) => s.dialogs[browserId]);
  const authRequest = useBrowserStore((s) => s.authRequests[browserId]);
  // The sign-in whose credentials dialog is open; closing keeps it pending.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const errorCount = useBrowserStore((s) =>
    selectUnreadDiagnosticCount(s, browserId),
  );
  const unreadConsoleErrorCount = useBrowserStore((s) =>
    selectUnreadConsoleErrorCount(s, browserId),
  );
  const unreadFailedRequestCount = useBrowserStore((s) =>
    selectUnreadFailedRequestCount(s, browserId),
  );
  const applySnapshot = useBrowserStore((s) => s.applySnapshot);
  const setActiveBrowser = useBrowserStore((s) => s.setActiveBrowser);
  const setInspectorTab = useBrowserStore((s) => s.setInspectorTab);
  const toggleInspector = useBrowserStore((s) => s.toggleInspector);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastVisibleNavigationRef = useRef<string | null>(null);
  const nativeViewBlocked = useBrowserNativeViewBlocked(contentRef);
  // Bumped when the page the frames show changes (browser, URL, runtime), so
  // a capture from an earlier page never renders over the current one.
  const freezeEpochRef = useRef(0);
  // The capture running for a page epoch. A capture left over from an
  // earlier page does not block one for the current page.
  const captureInFlightRef = useRef<{
    epoch: number;
    done: Promise<void>;
  } | null>(null);
  const lastCaptureAtRef = useRef<number | null>(null);
  // When the page area last changed size, for holding the standing frame
  // back until a window or panel resize has finished.
  const lastAreaResizeAtRef = useRef<number | null>(null);
  // When the pointer last pressed something in the app: an overlay opened
  // by that press covers the page with the frame taken while pointing.
  const lastPointerPressAtRef = useRef<number | null>(null);
  // A newer frame that landed while the current one covers the page. It is
  // swapped in only once the native view is back on top, so the page never
  // changes under an open overlay.
  const pendingFreezeFrameRef = useRef<BrowserFreezeFrame | null>(null);
  const freezeFrameElementRef = useRef<HTMLImageElement | null>(null);
  // True from the frame covering the page until main has shown the native
  // view again.
  const freezeHoldRef = useRef(false);
  const [freezeFrame, setFreezeFrame] = useState<BrowserFreezeFrame | null>(
    null,
  );
  // The frame known to be on screen under the native view.
  const [paintedFreezeFrame, setPaintedFreezeFrame] =
    useState<BrowserFreezeFrame | null>(null);
  const [freezeCaptureFailed, setFreezeCaptureFailed] = useState(false);
  // From a window resize, or a panel group opening or closing, until the
  // layout has settled.
  const [windowResizing, setWindowResizing] = useState(false);
  // Whether the standing frame is on screen under the live view, for the
  // resize listener, which runs before this component renders again.
  const freezeFramePaintedRef = useRef(false);
  useEffect(() => {
    let settleTimer: number | null = null;
    const hold = (settleMs: number): void => {
      // The page area's observer runs later in this same frame and drops a
      // frame that no longer fits; holding it here keeps it to stand in for
      // the page while the window resizes.
      if (freezeFramePaintedRef.current) freezeHoldRef.current = true;
      setWindowResizing(true);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        setWindowResizing(false);
      }, settleMs);
    };
    const onResize = (): void => hold(RESIZE_SETTLED_REPORT_MS);
    // The panels slide to their places; the live view returns once there.
    const onLayoutAnimation = (): void =>
      hold(PANEL_LAYOUT_ANIMATION_MS + RESIZE_SETTLED_REPORT_MS / 2);
    window.addEventListener('resize', onResize);
    window.addEventListener(PANEL_LAYOUT_ANIMATION_EVENT, onLayoutAnimation);
    return (): void => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener(
        PANEL_LAYOUT_ANIMATION_EVENT,
        onLayoutAnimation,
      );
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, []);
  // The overlay currently over the page, and whether it is waiting for a
  // newer frame before covering it.
  const [freezeBlock, setFreezeBlock] = useState<{
    awaitingFreshFrame: boolean;
  } | null>(null);
  // Tracks whether this live view has ever committed a page, so a navigation
  // only shows the centered loading placeholder when the pane is truly blank
  // (nothing painted yet) rather than over previously-loaded content.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // Whether this session was ever live while mounted here. A hidden restored
  // pane stays inert: it must not receive `setVisible(false)` IPC (there is
  // no native view to hide) and must not create one until visible. Tracked
  // per bound id synchronously during render so rebinding resets it without
  // an effect-ordering race.
  const liveSeenRef = useRef<{ browserId: string; wasLive: boolean }>({
    browserId,
    wasLive: false,
  });
  if (liveSeenRef.current.browserId !== browserId) {
    liveSeenRef.current = { browserId, wasLive: false };
  }
  if (live) {
    liveSeenRef.current.wasLive = true;
  }

  const hasUrl =
    snapshot?.url !== undefined &&
    snapshot.url.length > 0 &&
    snapshot.url !== 'about:blank';
  const failed = snapshot?.status === 'failed';
  const isNavigating = snapshot?.loading === true;
  // Opening the session for a URL, or a first-ever load with nothing painted
  // yet: show one centered spinner in the DOM and keep the (blank) native view
  // hidden until the page commits. A blank tab that is still opening shows
  // its normal empty state; it only turns into a loading state if a URL is
  // submitted before the session is ready.
  const showInitialLoading =
    hasUrl && (opening || (isNavigating && !failed && !hasLoadedOnce));
  // The backend session could not be created (no live view to load into).
  const openFailed = failed && !live && !opening;
  const nativeViewAvailable = visible && live && hasUrl && !failed;
  const activeFreezeFrame =
    freezeFrame !== null &&
    freezeFrame.browserId === browserId &&
    freezeFrame.runtimeGeneration === snapshot?.profile?.runtimeGeneration &&
    freezeFrame.epoch === freezeEpochRef.current
      ? freezeFrame
      : null;
  // An overlay the pointer did not just open (a toast, a shortcut) waits,
  // briefly, for a newer frame than a stale one, since the page may have
  // changed without the app seeing it. Until the page is frozen, the
  // above-browser mirror draws the overlay over the live page (see
  // `useBrowserNativeViewBlocked`), so it is never cut off. Decided in the
  // render the overlay appears in, before the native view could be hidden.
  const blockedWhileAvailable = nativeViewBlocked && nativeViewAvailable;
  const blockStarting = blockedWhileAvailable && freezeBlock === null;
  const awaitingFreshFrame = blockStarting
    ? activeFreezeFrame !== null &&
      freezeFrameStale(lastPointerPressAtRef.current, lastCaptureAtRef.current)
    : freezeBlock?.awaitingFreshFrame === true;
  if (blockStarting) {
    setFreezeBlock({ awaitingFreshFrame });
  } else if (!blockedWhileAvailable && freezeBlock !== null) {
    setFreezeBlock(null);
  }
  // While the window resizes, the page shows its standing frame instead of
  // the live view. The live view is a separate native view: it reaches each
  // new size a frame or more apart from the app around it, so during a drag
  // it slid over its neighbours or trailed them. The frame is part of the
  // app's own picture and moves with it; the live view comes back, laid out
  // for the final size, once the resize has settled.
  const windowResizeFrozen =
    windowResizing &&
    activeFreezeFrame !== null &&
    paintedFreezeFrame === activeFreezeFrame;
  freezeFramePaintedRef.current =
    activeFreezeFrame !== null && paintedFreezeFrame === activeFreezeFrame;
  const nativeViewSuppressed =
    windowResizeFrozen ||
    (nativeViewBlocked &&
      ((activeFreezeFrame !== null &&
        paintedFreezeFrame === activeFreezeFrame &&
        !awaitingFreshFrame) ||
        freezeCaptureFailed));
  if (nativeViewSuppressed) {
    freezeHoldRef.current = true;
  }
  useEffect(() => {
    window.dispatchEvent(new Event(BROWSER_NATIVE_VIEW_COVER_CHANGED_EVENT));
  }, [nativeViewSuppressed]);
  const activeFreezeFrameRef = useRef<BrowserFreezeFrame | null>(null);
  activeFreezeFrameRef.current = activeFreezeFrame;
  // The native view is shown only when the pane is visible, a live view
  // exists, and a real URL has been committed (a blank browser shows its
  // hint). It is hidden while app-level overlays intersect this pane because
  // Electron child views are stacked outside the renderer DOM and otherwise
  // cover modals, dropdowns, and portaled popovers regardless of CSS z-index.
  const viewVisible =
    nativeViewAvailable && !nativeViewSuppressed && !showInitialLoading;

  // Lazy live-view creation: only when the pane is VISIBLE. A hidden restored
  // pane stays inert until shown or explicitly targeted elsewhere.
  useEffect(() => {
    if (!visible) {
      return;
    }
    void useBrowserStore
      .getState()
      .ensureLiveView(projectId, worktreeId, browserId);
  }, [projectId, worktreeId, browserId, visible]);

  // Reconcile on mount/materialization as a backstop for a dialog event that
  // arrived before this pane or the renderer subscription was ready.
  useEffect(() => {
    if (!live) {
      useBrowserStore.getState().clearDialog(browserId);
      return;
    }
    let cancelled = false;
    void window.api.browser
      .getDialog({ browserId })
      .then((pending) => {
        if (cancelled) {
          return;
        }
        if (pending) {
          useBrowserStore.getState().setDialog(browserId, pending);
        } else {
          useBrowserStore.getState().clearDialog(browserId);
        }
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, [browserId, live, snapshot?.profile?.runtimeGeneration]);

  useEffect(() => {
    freezeEpochRef.current += 1;
    pendingFreezeFrameRef.current = null;
    lastCaptureAtRef.current = null;
    setFreezeFrame(null);
    setFreezeCaptureFailed(false);
  }, [browserId, snapshot?.url, snapshot?.profile?.runtimeGeneration]);

  // A fresh pane id starts blank; once any page commits, subsequent
  // navigations show the old content (not the blank-state spinner).
  useEffect(() => {
    setHasLoadedOnce(false);
  }, [browserId, snapshot?.profile?.runtimeGeneration]);

  useEffect(() => {
    if (snapshot?.status === 'ready') {
      setHasLoadedOnce(true);
    }
  }, [snapshot?.status, snapshot?.profile?.runtimeGeneration]);

  const runtimeGeneration = snapshot?.profile?.runtimeGeneration;
  const pageUrlRef = useRef('');
  pageUrlRef.current = snapshot?.url ?? '';
  const pageLoadingRef = useRef(false);
  pageLoadingRef.current = snapshot?.loading === true;
  const nativeViewBlockedRef = useRef(false);
  nativeViewBlockedRef.current = blockedWhileAvailable;

  // One capture at a time per page; the returned promise settles with the
  // running one. The result is scoped to the page epoch it was requested in,
  // not to an overlay: a frame that lands after its overlay closed is kept
  // for the next one.
  const captureFreezeFrame = useCallback((): Promise<void> => {
    const inFlight = captureInFlightRef.current;
    if (inFlight !== null && inFlight.epoch === freezeEpochRef.current) {
      return inFlight.done;
    }
    const area = contentRef.current?.getBoundingClientRect();
    if (!area) {
      return Promise.resolve();
    }
    const epoch = freezeEpochRef.current;
    const capturedAt = performance.now();
    // The page this frame shows: the epoch resets on navigation, so a frame
    // that lands for this epoch is of this URL. While a page loads, the URL
    // is already the new one but the screen can still show the old page, so
    // such a frame is not kept as the tab preview.
    const pageUrl = pageUrlRef.current;
    const pageLoading = pageLoadingRef.current;
    const failIfBlocked = (): void => {
      if (freezeEpochRef.current === epoch && nativeViewBlockedRef.current) {
        setFreezeCaptureFailed(true);
      }
    };
    const done = window.api.browser
      .screenshot({
        browserId,
        purpose: 'freeze-frame',
        ...(runtimeGeneration !== undefined
          ? { expectedRuntimeGeneration: runtimeGeneration }
          : {}),
      })
      .then(async (result) => {
        if (!result.dataUrl) {
          failIfBlocked();
          return;
        }
        const image = new Image();
        image.src = result.dataUrl;
        await decodeFreezeFrame(image);
        if (freezeEpochRef.current !== epoch) {
          return;
        }
        lastCaptureAtRef.current = capturedAt;
        if (!pageLoading && !pageLoadingRef.current) {
          recordBrowserTabPreview(browserId, pageUrl, image);
        }
        const frame: BrowserFreezeFrame = {
          browserId,
          runtimeGeneration,
          epoch,
          capturedAt,
          width: Math.round(area.width),
          height: Math.round(area.height),
          dataUrl: result.dataUrl,
        };
        setFreezeFrame((current) => {
          if (current !== null && freezeHoldRef.current) {
            pendingFreezeFrameRef.current = frame;
            return current;
          }
          return frame;
        });
      })
      .catch(failIfBlocked)
      .finally(() => {
        if (captureInFlightRef.current?.epoch === epoch) {
          captureInFlightRef.current = null;
        }
      });
    captureInFlightRef.current = { epoch, done };
    return done;
  }, [browserId, runtimeGeneration]);

  // An overlay over the page with no frame yet: capture one, and wait no
  // more than the fallback window before hiding the native view without an
  // image. A frame that lands late still fills the pane for as long as the
  // overlay stays. Once a frame covers the page, nothing is re-taken until
  // the overlay closes, so the page holds still under it.
  const hasActiveFreezeFrame = activeFreezeFrame !== null;
  useEffect(() => {
    if (!blockedWhileAvailable) {
      setFreezeCaptureFailed(false);
      return undefined;
    }
    if (hasActiveFreezeFrame || freezeCaptureFailed) {
      return undefined;
    }
    void captureFreezeFrame();
    const timeoutId = window.setTimeout(() => {
      setFreezeCaptureFailed(true);
    }, FREEZE_FRAME_CAPTURE_FALLBACK_MS);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [
    blockedWhileAvailable,
    captureFreezeFrame,
    freezeCaptureFailed,
    hasActiveFreezeFrame,
  ]);

  // A stale frame under an overlay: take a newer one, waiting no more than
  // the fallback window before covering the page with the one there is.
  useEffect(() => {
    if (!awaitingFreshFrame) {
      return undefined;
    }
    let cancelled = false;
    const stopWaiting = (): void => {
      if (!cancelled) {
        setFreezeBlock((block) =>
          block === null ? block : { awaitingFreshFrame: false },
        );
      }
    };
    void captureFreezeFrame().then(stopWaiting);
    const timeoutId = window.setTimeout(
      stopWaiting,
      FREEZE_FRAME_CAPTURE_FALLBACK_MS,
    );
    return (): void => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [awaitingFreshFrame, captureFreezeFrame]);

  // A first frame once the page has loaded and settled.
  const pageReady = snapshot?.status === 'ready';
  useEffect(() => {
    if (!viewVisible || !pageReady || hasActiveFreezeFrame) {
      return undefined;
    }
    // A resize drops the frame, since it no longer fits the area. Taking
    // the next one while the area is still changing would capture, encode
    // and decode a whole page every half second of the drag, each one
    // dropped at the next size, so it waits for the area to hold still.
    let timeoutId = 0;
    const captureOnceStill = (): void => {
      const resizedAt = lastAreaResizeAtRef.current;
      const stillFor =
        resizedAt === null
          ? FREEZE_FRAME_AFTER_LOAD_MS
          : performance.now() - resizedAt;
      if (stillFor < FREEZE_FRAME_AFTER_LOAD_MS) {
        timeoutId = window.setTimeout(
          captureOnceStill,
          FREEZE_FRAME_AFTER_LOAD_MS - stillFor,
        );
        return;
      }
      void captureFreezeFrame();
    };
    timeoutId = window.setTimeout(captureOnceStill, FREEZE_FRAME_AFTER_LOAD_MS);
    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [captureFreezeFrame, hasActiveFreezeFrame, pageReady, viewVisible]);

  // Keep a recent frame while the pointer is on the app's controls, so the
  // overlay they open does not wait on a capture.
  useEffect(() => {
    if (!viewVisible) {
      return undefined;
    }
    const handleIntent = (event: Event): void => {
      const pointerOver = event.type === 'pointerover';
      if (
        pointerOver &&
        !(
          event.target instanceof Element &&
          event.target.closest(FREEZE_FRAME_PREFETCH_TARGETS)
        )
      ) {
        return;
      }
      const now = performance.now();
      if (!pointerOver) {
        lastPointerPressAtRef.current = now;
      }
      const capturedAt = lastCaptureAtRef.current;
      const maxAge = pointerOver
        ? FREEZE_FRAME_PREFETCH_MS
        : FREEZE_FRAME_FRESH_MS;
      if (capturedAt === null || now - capturedAt > maxAge) {
        void captureFreezeFrame();
      }
    };
    const options = { capture: true, passive: true };
    window.addEventListener('pointerover', handleIntent, options);
    window.addEventListener('pointerdown', handleIntent, options);
    window.addEventListener('contextmenu', handleIntent, options);
    return (): void => {
      window.removeEventListener('pointerover', handleIntent, options);
      window.removeEventListener('pointerdown', handleIntent, options);
      window.removeEventListener('contextmenu', handleIntent, options);
    };
  }, [captureFreezeFrame, viewVisible]);

  // A frame sized for another page area would not line up with the page;
  // drop it when the area resizes while the frame is not covering the page
  // (a resize under an overlay is checked once the native view is back).
  useEffect(() => {
    const element = contentRef.current;
    if (
      !element ||
      activeFreezeFrame === null ||
      typeof ResizeObserver === 'undefined'
    ) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      if (
        !freezeHoldRef.current &&
        !freezeFrameFits(activeFreezeFrame, element)
      ) {
        pendingFreezeFrameRef.current = null;
        lastCaptureAtRef.current = null;
        setFreezeFrame(null);
      }
    });
    observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [activeFreezeFrame]);

  // The frame stays drawn under the live native view, so an overlay can hide
  // the view at once. It counts as on screen two frames after it decoded.
  const showFreezeFrame =
    activeFreezeFrame !== null && nativeViewAvailable && !showInitialLoading;
  useEffect(() => {
    if (!showFreezeFrame || activeFreezeFrame === null) {
      setPaintedFreezeFrame(null);
      return undefined;
    }
    let cancelled = false;
    let cancelPaint: (() => void) | null = null;
    const element = freezeFrameElementRef.current;
    void (element ? decodeFreezeFrame(element) : Promise.resolve()).then(() => {
      if (cancelled) {
        return;
      }
      cancelPaint = afterNextPaint(() => {
        setPaintedFreezeFrame(activeFreezeFrame);
      });
    });
    return (): void => {
      cancelled = true;
      cancelPaint?.();
    };
  }, [activeFreezeFrame, showFreezeFrame]);

  // Called once main has shown the native view again: after it has reached
  // the screen, a frame that landed meanwhile replaces the one under it, and
  // a frame that no longer fits the page area (resized under the overlay) is
  // dropped.
  const nativeViewShownRef = useRef<() => void>(() => undefined);
  nativeViewShownRef.current = (): void => {
    afterNextPaint(() => {
      if (nativeViewBlockedRef.current) {
        return;
      }
      freezeHoldRef.current = false;
      const pending = pendingFreezeFrameRef.current;
      pendingFreezeFrameRef.current = null;
      const next =
        pending !== null && pending.epoch === freezeEpochRef.current
          ? pending
          : activeFreezeFrameRef.current;
      if (next === null) {
        return;
      }
      if (!freezeFrameFits(next, contentRef.current)) {
        lastCaptureAtRef.current = null;
        setFreezeFrame(null);
      } else if (next === pending) {
        setFreezeFrame(pending);
      }
    });
  };

  const sendBounds = useCallback((): void => {
    const target = {
      browserId,
      ...(snapshot?.profile?.runtimeGeneration !== undefined
        ? { expectedRuntimeGeneration: snapshot.profile.runtimeGeneration }
        : {}),
    };
    const el = contentRef.current;
    if (!el || !viewVisible) {
      // Hidden/blocked/inactive: hide the native view — but only when one
      // exists. A hidden restored pane is inert and gets no IPC at all.
      if (liveSeenRef.current.wasLive) {
        void window.api.browser
          .setVisible({ ...target, visible: false })
          .catch(() => undefined);
      }
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      // A zero-sized rectangle also means an ancestor hid the still-mounted
      // page (for example app navigation's `display: none`). Never leave the
      // last native frame visible while waiting for the next real layout.
      if (liveSeenRef.current.wasLive) {
        void window.api.browser
          .setVisible({ ...target, visible: false })
          .catch(() => undefined);
      }
      return;
    }
    void window.api.browser
      .setBounds({
        ...target,
        visible: true,
        bounds: roundRect(rect),
        // The page area's rounding (its card's bottom corners), which the
        // native view copies.
        cornerRadii: readCornerRadii(el),
        // What this measurement was laid out for: main follows a window
        // resize from it without waiting for the next report.
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      .then(() => nativeViewShownRef.current())
      .catch(() => nativeViewShownRef.current());
  }, [browserId, viewVisible, snapshot?.profile?.runtimeGeneration]);

  const handleRetry = useCallback((): void => {
    if (openFailed) {
      // Recreate the session; `create` loads its URL itself.
      void useBrowserStore
        .getState()
        .ensureLiveView(projectId, worktreeId, browserId);
      return;
    }
    if (!snapshot?.url || snapshot.url === 'about:blank') {
      return;
    }
    // Explicit action targeting the view: materialize it even when hidden.
    void useBrowserStore
      .getState()
      .ensureLiveView(projectId, worktreeId, browserId)
      .then(() => window.api.browser.navigate({ browserId, url: snapshot.url }))
      .then((next) => applySnapshot(next))
      .catch(() => undefined);
  }, [
    applySnapshot,
    browserId,
    openFailed,
    projectId,
    snapshot?.url,
    worktreeId,
  ]);

  // Pane interaction participates in EXPLICIT activation: pointer/keyboard
  // interaction within the pane makes this browser the worktree's active
  // browser. (Bounds updates never do — activation is interaction-only.)
  const handleActivate = useCallback((): void => {
    void setActiveBrowser(projectId, worktreeId, browserId);
  }, [browserId, projectId, setActiveBrowser, worktreeId]);

  // Drive bounds/visibility on every layout transition: resize observer,
  // window resize, tab/inspector visibility changes, and grid relayouts.
  useEffect(() => {
    sendBounds();
    if (!viewVisible) {
      return undefined;
    }
    const el = contentRef.current;
    let observedSize = false;
    const observer = new ResizeObserver(() => {
      // The first report is the size the area already had.
      if (observedSize) lastAreaResizeAtRef.current = performance.now();
      observedSize = true;
      sendBounds();
    });
    if (el) {
      observer.observe(el);
    }
    // A window resize can move the area without resizing it, which the
    // observer does not see. The panel grid lays itself out later in the
    // same frame, so the area is read once that frame is done: reading it
    // in the event forced a layout of the old grid at the new window size,
    // and reported a rectangle that was never drawn.
    const stopAfterFrame = afterWindowResizeFrame(sendBounds);
    // Once a resize has stopped, report once more. Main moves the page ahead
    // of these reports while the window resizes, so a report lost along the
    // way would otherwise leave the page where main guessed it would be.
    let settleTimer: number | null = null;
    const reportWhenSettled = (): void => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        sendBounds();
      }, RESIZE_SETTLED_REPORT_MS);
    };
    window.addEventListener('resize', reportWhenSettled);
    return (): void => {
      observer.disconnect();
      stopAfterFrame();
      window.removeEventListener('resize', reportWhenSettled);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, [sendBounds, viewVisible, inspectorOpen]);

  const snapshotStatus = snapshot?.status;
  const snapshotUrl = snapshot?.url;

  useEffect(() => {
    // Backstop for a live view that exists but has never begun loading
    // (status 'idle' — e.g. a session materialized without a URL). Gate on
    // `nativeViewAvailable` rather than `viewVisible` so a pane showing the
    // initial-loading spinner (native view hidden) still drives navigation.
    //
    // Only act on 'idle': a 'loading'/'ready' view already has an
    // authoritative navigation in flight, and re-navigating it would abort
    // that load and can race the snapshot back to 'loading'.
    if (!nativeViewAvailable || !snapshotUrl || !hasUrl || failed) {
      return;
    }
    if (snapshotStatus !== 'idle') {
      if (snapshotStatus === 'ready') {
        lastVisibleNavigationRef.current = `${browserId}\0${snapshotUrl}`;
      }
      return;
    }
    const key = `${browserId}\0${snapshotUrl}`;
    if (lastVisibleNavigationRef.current === key) {
      return;
    }
    lastVisibleNavigationRef.current = key;
    void window.api.browser
      .navigate({ browserId, url: snapshotUrl })
      .then((next) => applySnapshot(next))
      .catch(async () => {
        try {
          const next = await window.api.browser.create({
            projectId,
            worktreeId,
            browserId,
            url: snapshotUrl,
            ...(snapshot?.themeMode ? { themeMode: snapshot.themeMode } : {}),
          });
          applySnapshot(next);
          return;
        } catch {
          // Allow a future visibility/status change to retry.
        }
        lastVisibleNavigationRef.current = null;
      });
  }, [
    applySnapshot,
    browserId,
    failed,
    hasUrl,
    nativeViewAvailable,
    projectId,
    snapshot?.themeMode,
    snapshotStatus,
    snapshotUrl,
    worktreeId,
  ]);

  // Native view bounds use window coordinates. Grid relayouts and composer
  // height changes can MOVE the pane without resizing it, so listen for
  // explicit layout invalidations and recompute bounds.
  useEffect(() => {
    let frameId: number | null = null;
    const handleInvalidated = (): void => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        // Mid-resize the grid has not laid out for this frame yet; the
        // report after the frame covers this move too.
        if (resizeFramesPending > 0) return;
        sendBounds();
      });
    };
    window.addEventListener(
      BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT,
      handleInvalidated,
    );
    return (): void => {
      window.removeEventListener(
        BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT,
        handleInvalidated,
      );
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [sendBounds]);

  // On unmount (panel removed/temporarily unmounted, worktree changed) hide
  // the view so it never lingers over unrelated UI. Unmount is presentation
  // teardown only — permanent destruction is the lifecycle coordinator's
  // decision, made from committed panel-layout changes.
  useEffect(() => {
    return (): void => {
      if (liveSeenRef.current.wasLive) {
        void window.api.browser
          .setVisible({ browserId, visible: false })
          .catch(() => undefined);
      }
    };
  }, [browserId]);

  // A hidden tab's address bar mounts once the thread is idle after the
  // switch that mounted it, and at once when the tab is shown: a worktree with
  // several Browser tabs built every tab's bar in its first frame.
  const barMounted = useHiddenRailContentMounted(visible, browserId);

  if (!snapshot) {
    return <div className="min-h-0 flex-1" />;
  }

  // The one-row address bar uses the same
  // actions.
  const Bar = BrowserAddressBar;

  // Session replay records the browser bar (URL and page title). The page
  // area (freeze frame, loading, and error content) and the devtools panel
  // carry their own blocks; both mount with their content.
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid={`browser-pane-${browserId}`}
      // Session lifecycle for automation: a blank tab looks the same while
      // opening and once ready.
      data-browser-state={opening ? 'opening' : live ? 'live' : 'inert'}
      onMouseDownCapture={handleActivate}
      onFocusCapture={handleActivate}
    >
      {barMounted ? (
        <Bar
          browserId={browserId}
          snapshot={snapshot}
          inspectorOpen={inspectorOpen}
          errorCount={errorCount}
          onToggleInspector={(): void => {
            if (!inspectorOpen) {
              if (unreadConsoleErrorCount > 0) {
                setInspectorTab(browserId, 'console');
              } else if (unreadFailedRequestCount > 0) {
                setInspectorTab(browserId, 'network');
              }
            }
            toggleInspector(browserId);
          }}
        />
      ) : null}
      <BrowserFileChooserNotice browserId={browserId} />
      <BrowserPrintRequestNotice browserId={browserId} />
      <BrowserAuthRequestNotice
        browserId={browserId}
        onSignIn={(): void => setSigningIn(authRequest?.id ?? null)}
      />
      <BrowserDownloadNotices browserId={browserId} />
      <div className="flex min-h-0 flex-1">
        <Surface
          variant="pane"
          ref={contentRef}
          data-testid="browser-page-area"
          // Where a live native view can show. The notification corner lifts
          // its toasts into an overlay layer above this area instead of
          // freezing the page. Freeze state must not feed this, or a frozen
          // page would never unfreeze.
          data-browser-native-view-available={
            nativeViewAvailable ? 'true' : 'false'
          }
          // The freeze frame stands in for the live view. Until it does, the
          // above-browser mirror draws overlays over the page.
          {...{
            [BROWSER_NATIVE_VIEW_FROZEN_ATTRIBUTE]: nativeViewSuppressed
              ? 'true'
              : 'false',
          }}
          replay="block"
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {showInitialLoading ? (
            <div
              data-testid="browser-pane-loading"
              role="status"
              className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-s fg-secondary"
            >
              <LoadingSpinner decorative />
              <span className="max-w-full truncate">
                {browserLoadingLabel(snapshot.url)}
              </span>
            </div>
          ) : failed && (hasUrl || openFailed) ? (
            <div
              data-testid="browser-pane-failed"
              className="flex h-full flex-col items-center justify-center px-6 text-center text-s fg-secondary gap-3"
            >
              <div className="flex max-w-full flex-col items-center gap-2">
                <div className="font-medium fg-primary">
                  {openFailed ? "Couldn't open Browser" : 'Unable to load page'}
                </div>
                <div className="max-w-full break-words font-mono text-xs">
                  {snapshot.lastError ?? snapshot.url}
                </div>
              </div>
              <Button
                className=""
                variant="secondary"
                size="compact"
                onClick={handleRetry}
              >
                <RefreshIcon size={14} />
                Try again
              </Button>
            </div>
          ) : !hasUrl ? (
            <div
              data-testid="browser-pane-empty"
              className="flex h-full items-center justify-center text-s fg-secondary"
            >
              Enter a URL to start.
            </div>
          ) : null}
          {showFreezeFrame && (
            <img
              ref={freezeFrameElementRef}
              src={activeFreezeFrame.dataUrl}
              alt=""
              aria-hidden="true"
              // Decoded with the frame it first paints in, so it is never
              // drawn a frame late.
              decoding="sync"
              // The freeze frame only while it stands in for the page; ready
              // (under the live view) otherwise.
              data-testid={
                nativeViewSuppressed
                  ? 'browser-pane-freeze-frame'
                  : 'browser-pane-freeze-frame-ready'
              }
              // Fills the page area from its top-left corner without
              // stretching: if the area grows under an open overlay, the
              // picture still covers all of it.
              className="pointer-events-none absolute inset-0 h-full w-full object-cover object-left-top"
              draggable={false}
            />
          )}
        </Surface>
        {inspectorOpen && (
          <div
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 shrink-0 flex-col`}
            style={{ width: 320, minWidth: 280, maxWidth: '45%' }}
          >
            <BrowserInspector browserId={browserId} />
          </div>
        )}
      </div>
      {dialog && (
        <BrowserJavaScriptDialogModal browserId={browserId} dialog={dialog} />
      )}
      {authRequest && signingIn === authRequest.id && (
        <BrowserSignInDialog
          browserId={browserId}
          request={authRequest}
          onClose={(): void => setSigningIn(null)}
        />
      )}
    </div>
  );
}
