import type {
  ToastStackSwipeInput,
  ToastSwipeGesture,
} from '@canopy/ui-shared';

/**
 * A swipe that would bring the card back has ended once the wheel is quiet
 * this long. Trackpads send an event every frame while the fingers move.
 */
const IDLE_MS = 50;
/** Sparse OS momentum ticks can arrive more than one frame apart. */
const MOMENTUM_IDLE_MS = 150;
/**
 * Past the dismiss line, wait longer before taking a quiet wheel as the
 * fingers lifting: resting fingers send nothing either, and a pause there
 * must not throw the card away.
 */
const IDLE_PAST_LINE_MS = 150;
/**
 * Fallback for browsers without a native momentum flag: sustained shrinking
 * deltas can identify the small inertia tail. Native direct input skips it.
 */
const COASTING_STEPS = 3;
/** Slowing fingers still own the toast; only a tiny cancelled tail is spent. */
const MOMENTUM_TAIL_PX = 1;

const STACK_CARD_SELECTOR = '[data-toast-stack-id]';

function isElementNode(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target &&
    typeof target.closest === 'function'
  );
}

/** Use the platform's inertia signal when the browser exposes it. */
function wheelMomentum(event: WheelEvent): boolean | undefined {
  return 'momentum' in event && typeof event.momentum === 'boolean'
    ? event.momentum
    : undefined;
}

function isHorizontal(event: WheelEvent): boolean {
  return Math.abs(event.deltaX) > Math.abs(event.deltaY);
}

interface TrackingSwipe {
  readonly phase: 'tracking';
  readonly document: Document;
  readonly gesture: ToastSwipeGesture;
  lastStep: number;
  coastingSteps: number;
  lastDirectInputAt: number | undefined;
}

type TrackpadSwipe =
  | { readonly phase: 'idle' }
  | TrackingSwipe
  | {
      readonly phase: 'draining';
      readonly document: Document;
      readonly direction: number;
    };

/**
 * Two-finger trackpad swipe to dismiss for the shared toast stack. Swipes
 * arrive as horizontal wheel events, which the stack's pointer swipe never
 * sees; this feeds them to the stack's swipe controller, so the card moves,
 * leaves and returns through the same controller as a mouse drag.
 *
 * The card under the pointer when the swipe starts follows the fingers,
 * even once it has slid out from under the pointer. The native momentum flag
 * ends direct manipulation without feeding inertia into the card. Browsers
 * without that flag use a bounded tail/quiet fallback. Leftover momentum is
 * drained; a fresh direct event can pick the card back up immediately.
 *
 * Desktop only: the web chat pages sit at their first-load budget.
 */
export const toastTrackpadSwipe: ToastStackSwipeInput = (swipe, host, side) => {
  const sign = side === 'right' ? 1 : -1;
  let state: TrackpadSwipe = { phase: 'idle' };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopFollowing = (): void => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (state.phase !== 'idle') {
      state.document.removeEventListener('wheel', onSwipeWheel, true);
      state = { phase: 'idle' };
    }
  };

  const waitForQuiet = (ms: number, then: () => void): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(then, ms);
  };

  const liveCard = (element: Element | null): HTMLElement | null => {
    const card = element?.closest<HTMLElement>(STACK_CARD_SELECTOR) ?? null;
    return card !== null &&
      host.contains(card) &&
      !card.matches('[data-swipe-flung], [data-ending-style], [data-limited]')
      ? card
      : null;
  };

  // Wheel transactions may keep targeting the outgoing toast until the
  // pointer moves. Fresh direct input must hit-test the current deck instead.
  const cardAtPointer = (event: WheelEvent): HTMLElement | null => {
    const hits = host.ownerDocument.elementsFromPoint?.(
      event.clientX,
      event.clientY,
    );
    if (hits !== undefined) {
      for (const hit of hits) {
        const card = liveCard(hit);
        if (card !== null) return card;
      }
      return null;
    }
    return liveCard(isElementNode(event.target) ? event.target : null);
  };

  const track = (active: TrackingSwipe, event: WheelEvent): void => {
    const { gesture } = active;
    event.preventDefault();
    // Fingers moving toward the edge scroll the other way.
    const step = -sign * event.deltaX;
    const momentum = wheelMomentum(event);
    if (momentum !== true) {
      const { lastStep, coastingSteps } = active;
      active.coastingSteps =
        step * lastStep > 0 &&
        Math.abs(step) <= Math.abs(lastStep) &&
        (coastingSteps > 0 || Math.abs(step) < Math.abs(lastStep))
          ? coastingSteps + 1
          : 0;
      active.lastStep = step;
      gesture.move(step);
      active.lastDirectInputAt = performance.now();
    }
    // The first native momentum tick ends direct input without moving the
    // card. Older browsers use the bounded shrinking-delta fallback.
    if (
      momentum === true ||
      (momentum === undefined &&
        !gesture.ended &&
        active.coastingSteps >= COASTING_STEPS &&
        (gesture.wouldDismiss() || Math.abs(step) <= MOMENTUM_TAIL_PX))
    ) {
      gesture.end(active.lastDirectInputAt);
    }
    if (gesture.ended) {
      // Release the card but keep listening until the momentum tail ends.
      state = {
        phase: 'draining',
        document: active.document,
        direction: Math.sign(step),
      };
      waitForQuiet(MOMENTUM_IDLE_MS, stopFollowing);
      return;
    }
    const inputEndedAt = active.lastDirectInputAt;
    waitForQuiet(gesture.isPastLine() ? IDLE_PAST_LINE_MS : IDLE_MS, () => {
      stopFollowing();
      // Decide at the fingers' last speed, before the quiet wait.
      gesture.end(inputEndedAt);
    });
  };

  const startTracking = (card: HTMLElement, event: WheelEvent): boolean => {
    const gesture = swipe.begin(card);
    if (gesture === null) return false;
    const active: TrackingSwipe = {
      phase: 'tracking',
      document: state.phase === 'idle' ? card.ownerDocument : state.document,
      gesture,
      lastStep: 0,
      coastingSteps: 0,
      lastDirectInputAt: undefined,
    };
    if (state.phase === 'idle') {
      active.document.addEventListener('wheel', onSwipeWheel, {
        capture: true,
        passive: false,
      });
    }
    state = active;
    track(active, event);
    return true;
  };

  function onSwipeWheel(event: WheelEvent): void {
    const momentum = wheelMomentum(event);
    if (!isHorizontal(event) && momentum !== true) {
      // A fresh vertical gesture and its inertia belong to the page.
      if (state.phase === 'draining') stopFollowing();
      return;
    }
    switch (state.phase) {
      case 'idle':
        return;
      case 'tracking':
        track(state, event);
        return;
      case 'draining': {
        const direction = Math.sign(-sign * event.deltaX);
        // Fresh direct input can pick up the next card at the same cursor.
        // Inertia never transfers cards.
        const freshInput =
          momentum === false ||
          (momentum === undefined &&
            direction !== 0 &&
            direction !== state.direction);
        if (freshInput) {
          const card = cardAtPointer(event);
          if (card !== null && startTracking(card, event)) return;
          stopFollowing();
          return;
        }
        event.preventDefault();
        waitForQuiet(MOMENTUM_IDLE_MS, stopFollowing);
      }
    }
  }

  const onWheel = (event: WheelEvent): void => {
    if (state.phase !== 'idle' || !isHorizontal(event)) return;
    const card = cardAtPointer(event);
    if (card === null) return;
    if (wheelMomentum(event) === true) {
      event.preventDefault();
      return;
    }
    startTracking(card, event);
  };

  host.addEventListener('wheel', onWheel, { passive: false });
  return (): void => {
    const gesture = state.phase === 'tracking' ? state.gesture : null;
    stopFollowing();
    gesture?.end();
    host.removeEventListener('wheel', onWheel);
  };
};
