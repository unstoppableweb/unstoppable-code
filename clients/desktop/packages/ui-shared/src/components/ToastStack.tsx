'use client';

import { Toast } from '@base-ui/react/toast';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { InAppNotificationPlacement } from '../lib/notification-placement';
import { isPromiseLike } from '../lib/promise-like';
import { NoticeButton, type NoticeIntent } from './Notice';
import { attachToastSwipe, type ToastSwipe } from './toast-swipe';

/**
 * Most toasts the stack shows at once. Older ones stay mounted but hidden
 * (Base UI's `data-limited`) and come back as newer ones leave.
 */
export const TOAST_STACK_LIMIT = 3;

/** What the stack needs to know about a host toast. */
export interface ToastStackItem {
  readonly id: string;
  readonly intent: NoticeIntent;
  /**
   * How long the toast stays up, in ms. The clock holds while the stack is
   * hovered or focused and while the window is in the background. `0` keeps
   * the toast until it is dismissed.
   */
  readonly timeoutMs: number;
}

export interface ToastActionButtonProps {
  readonly label: ReactNode;
  /**
   * The action. Return a promise for work that takes a while (`Try again`):
   * the button spins inside its capsule until it settles, and only then does
   * the toast close. A failed retry raises its own toast.
   */
  readonly run: () => unknown;
  /** Closes the toast once the action has run. */
  readonly onDone: () => void;
  /** The label while the action runs. Defaults to `label`. */
  readonly busyLabel?: ReactNode;
  /**
   * Shared by every button that runs the same action, such as a toast's card
   * and its details dialog (the toast's id): while the action runs, each of
   * them spins and none starts it again.
   */
  readonly actionKey?: string;
  readonly 'data-testid'?: string;
}

/** Toast actions still running, by the `actionKey` their buttons share. */
const runningToastActions = new Set<string>();
const runningToastActionListeners = new Set<() => void>();

function setToastActionRunning(key: string, running: boolean): void {
  if (running) runningToastActions.add(key);
  else runningToastActions.delete(key);
  for (const listener of runningToastActionListeners) listener();
}

function subscribeToRunningToastActions(listener: () => void): () => void {
  runningToastActionListeners.add(listener);
  return (): void => {
    runningToastActionListeners.delete(listener);
  };
}

/**
 * A toast's single action, such as `Try again` on a failed action. Presses
 * never reach the card behind it (which may open a destination), and a
 * second press while the action runs does nothing.
 */
export function ToastActionButton({
  label,
  run,
  onDone,
  busyLabel,
  actionKey,
  'data-testid': dataTestId,
}: ToastActionButtonProps): JSX.Element {
  const [ownBusy, setOwnBusy] = useState(false);
  const sharedBusy = useSyncExternalStore(
    subscribeToRunningToastActions,
    () => actionKey !== undefined && runningToastActions.has(actionKey),
    () => false,
  );
  const busy = ownBusy || sharedBusy;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  return (
    <NoticeButton
      data-testid={dataTestId}
      busy={busy}
      busyLabel={busyLabel}
      onClick={(event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        if (busy) return;
        const result = run();
        if (!isPromiseLike(result)) {
          onDone();
          return;
        }
        setOwnBusy(true);
        if (actionKey !== undefined) setToastActionRunning(actionKey, true);
        const settle = (): void => {
          if (actionKey !== undefined) setToastActionRunning(actionKey, false);
          if (mounted.current) setOwnBusy(false);
          onDone();
        };
        Promise.resolve(result).then(settle, settle);
      }}
    >
      {label}
    </NoticeButton>
  );
}

interface ToastStackData<T extends ToastStackItem> {
  readonly item: T;
}

/**
 * A host's own swipe input for the stack, such as the desktop's two-finger
 * trackpad swipe, driven through the stack's swipe controller so it feels
 * like a mouse drag. Returns its cleanup.
 */
export type ToastStackSwipeInput = (
  swipe: ToastSwipe,
  host: HTMLElement,
  side: ToastStackSide,
) => () => void;

export interface ToastStackProps<T extends ToastStackItem> {
  /** The host's live toasts, oldest first. */
  readonly toasts: readonly T[];
  readonly placement: InAppNotificationPlacement;
  /**
   * The stack closed a toast on its own: its time ran out, or the user swiped
   * it away or pressed Escape. The host drops it from `toasts`. A host's own
   * Dismiss button removes the toast from `toasts` directly instead.
   */
  readonly onClose: (id: string) => void;
  /**
   * The card's content, usually a `Notice` with `surface="none"` and
   * `shape="toast"`, whose controls nest in the card's 20px corners.
   */
  readonly renderToast: (toast: T) => ReactNode;
  /**
   * Extra swipe input on top of the shared pointer swipe. Kept out of the
   * shared stack so hosts that don't need it don't load it.
   */
  readonly swipeInput?: ToastStackSwipeInput;
  readonly 'data-testid'?: string;
}

/** Base UI's own drag is off: the stack's swipe controller owns swiping. */
const NO_BASE_UI_SWIPE: never[] = [];

/** The screen edge the stack sits against: cards enter from and leave to it. */
function sideOf(placement: InAppNotificationPlacement): ToastStackSide {
  return placement.endsWith('left') ? 'left' : 'right';
}

/** How far each toast behind the front one peeks out, in px. */
const TOAST_PEEK_PX = 8;
export type ToastStackSide = 'left' | 'right';

function isElementNode(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target &&
    typeof target.closest === 'function'
  );
}

function isHTMLElementNode(active: Element | null): active is HTMLElement {
  return (
    active !== null &&
    active.nodeType === 1 &&
    'blur' in active &&
    typeof active.blur === 'function'
  );
}

/**
 * Mirrors the host's list into Base UI's toast manager: new ids are added,
 * changed toasts are updated in place, and ids the host dropped are closed
 * (with their exit animation). A toast Base UI closes itself is reported
 * once through `onClose`.
 */
function ToastStackSync<T extends ToastStackItem>({
  toasts,
  onClose,
}: {
  readonly toasts: readonly T[];
  readonly onClose: (id: string) => void;
}): null {
  const manager = Toast.useToastManager<ToastStackData<T>>();
  const { add, close, update } = manager;
  const shown = useRef(new Map<string, T>());
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const liveIds = new Set(toasts.map((toast) => toast.id));
    for (const id of Array.from(shown.current.keys())) {
      if (liveIds.has(id)) continue;
      // Forget it first so the close it triggers is not reported back.
      shown.current.delete(id);
      close(id);
    }
    for (const toast of toasts) {
      const previous = shown.current.get(toast.id);
      if (previous === toast) continue;
      shown.current.set(toast.id, toast);
      if (previous !== undefined) {
        update(toast.id, { data: { item: toast } });
        continue;
      }
      const { id } = toast;
      add({
        id,
        type: toast.intent,
        timeout: toast.timeoutMs,
        // Every toast is announced politely, failures included. Base UI's
        // urgent priority hides the card from assistive technology until the
        // stack has focus, which would put a failure's actions out of reach.
        priority: 'low',
        data: { item: toast },
        onClose: (): void => {
          if (shown.current.delete(id)) onCloseRef.current(id);
        },
      });
    }
  }, [toasts, add, close, update]);

  return null;
}

interface ToastStackCardStyle extends CSSProperties {
  readonly '--canopy-toast-offset-y': string;
}

function ToastStackCards<T extends ToastStackItem>({
  placement,
  renderToast,
  swipeInput,
}: {
  readonly placement: InAppNotificationPlacement;
  readonly renderToast: (toast: T) => ReactNode;
  readonly swipeInput: ToastStackSwipeInput | undefined;
}): JSX.Element {
  const { toasts, close, update } = Toast.useToastManager<ToastStackData<T>>();
  const stackRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  const updateRef = useRef(update);
  const toastsRef = useRef(toasts);
  const swipeInputRef = useRef(swipeInput);
  useEffect(() => {
    closeRef.current = close;
    updateRef.current = update;
    toastsRef.current = toasts;
    swipeInputRef.current = swipeInput;
  });
  const side = sideOf(placement);
  const edge = placement.startsWith('top') ? 'top' : 'bottom';
  useEffect(() => {
    const host = stackRef.current;
    if (host === null) return undefined;
    // A swiped card is already leaving; closing it reports it to the host
    // (through the toast's `onClose`) and lets the deck close up behind it.
    const swipe = attachToastSwipe(host, {
      side,
      edge,
      onDismiss: (id) => closeRef.current(id),
      // A held card keeps its toast up: no timer while pressed, and a fresh
      // one once let go.
      onHold: (id, held) => {
        const timeoutMs =
          toastsRef.current.find((toast) => toast.id === id)?.data?.item
            .timeoutMs ?? 0;
        if (timeoutMs > 0) {
          updateRef.current(id, { timeout: held ? 0 : timeoutMs });
        }
      },
    });
    const detachInput = swipeInputRef.current?.(swipe, host, side);
    return (): void => {
      detachInput?.();
      swipe.detach();
    };
  }, [side, edge]);
  // The stack is out of flow (each card is absolute), so the viewport
  // reserves the front card plus the edges peeking behind it. Anything the
  // host stacks beside it in the same corner keeps its place.
  const resting = toasts.filter(
    (toast) => toast.transitionStatus !== 'ending' && toast.limited !== true,
  );
  const frontHeight = resting[0]?.height ?? 0;
  const reservedHeight =
    resting.length === 0
      ? 0
      : frontHeight + (resting.length - 1) * TOAST_PEEK_PX;

  // Base UI includes exiting cards in offsetY until they unmount. Exclude
  // them immediately so the next live card fills the stationary cursor's slot.
  const liveOffsets = new Map<string, number>();
  let liveOffset = 0;
  for (const toast of toasts) {
    liveOffsets.set(toast.id, liveOffset);
    if (toast.transitionStatus !== 'ending' && toast.limited !== true) {
      liveOffset += toast.height ?? 0;
    }
  }

  return (
    <div
      ref={stackRef}
      className="canopy-toast-stack"
      style={{ height: `${String(reservedHeight)}px` }}
    >
      {toasts.map((toast) => {
        const style: ToastStackCardStyle = {
          '--canopy-toast-offset-y': `${String(liveOffsets.get(toast.id) ?? 0)}px`,
        };
        return toast.data === undefined ? null : (
          <Toast.Root
            key={toast.id}
            toast={toast}
            swipeDirection={NO_BASE_UI_SWIPE}
            data-testid="toast-stack-card"
            data-toast-stack-id={toast.id}
            data-toast-intent={toast.data.item.intent}
            style={style}
            // Base UI moves focus to the next card when one closes; keyboard
            // focus shows the shared ring, never the browser default outline.
            className="canopy-toast focus-ring pointer-events-auto rounded-2xl bg-quaternary shadow-xl"
          >
            <Toast.Content className="canopy-toast-content">
              {renderToast(toast.data.item)}
            </Toast.Content>
          </Toast.Root>
        );
      })}
    </div>
  );
}

/**
 * The shared notification stack, built on Base UI's headless toast.
 *
 * Hosts keep their own toast list (what to show, history, preferences) and
 * draw each card's content; the stack owns timing, stacking, motion, swipe to
 * dismiss (`toast-swipe.ts`), and the polite live region. Cards slide in from
 * the stack's side of the screen and leave to it. Cards rest as a deck with
 * the newest in front and spread out while the stack is hovered or focused.
 * F6 moves focus into the stack.
 *
 * Render it inside the host's notification corner
 * (`getInAppNotificationContainerClasses`); it fills that corner's width and
 * grows away from the screen edge.
 */
export function ToastStack<T extends ToastStackItem>({
  toasts,
  placement,
  onClose,
  renderToast,
  swipeInput,
  'data-testid': dataTestId,
}: ToastStackProps<T>): JSX.Element {
  return (
    <Toast.Provider limit={TOAST_STACK_LIMIT}>
      <ToastStackSync toasts={toasts} onClose={onClose} />
      <Toast.Viewport
        data-testid={dataTestId}
        data-edge={placement.startsWith('top') ? 'top' : 'bottom'}
        data-side={sideOf(placement)}
        className="canopy-toast-viewport"
      >
        <ToastStackCards
          placement={placement}
          renderToast={renderToast}
          swipeInput={swipeInput}
        />
      </Toast.Viewport>
    </Toast.Provider>
  );
}

/**
 * Names the toast for assistive technology: wrap the toast's headline in it.
 * Renders a `<span>`, so it can sit inside a `Notice` title.
 */
export function ToastStackTitle({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <Toast.Title render={<span />}>{children}</Toast.Title>;
}

/**
 * Describes the toast for assistive technology: wrap the toast's message in
 * it. Renders a `<span>`, so it can sit inside a `Notice` message. The message
 * shows at most three lines. `onOverflowChange` reports whether the clamp
 * hides any of it, so the host can offer the rest in a details view even when
 * its own text preview kept the whole message.
 */
export function ToastStackDescription({
  children,
  onOverflowChange,
}: {
  readonly children: ReactNode;
  readonly onOverflowChange?: (overflowing: boolean) => void;
}): JSX.Element {
  const clampRef = useRef<HTMLSpanElement>(null);
  const onOverflowChangeRef = useRef(onOverflowChange);
  useEffect(() => {
    onOverflowChangeRef.current = onOverflowChange;
  });
  // Measured once per card: hosts hand in a fresh message element on every
  // render, so keying this on `children` rebuilt the observers and forced a
  // layout read each time the stack updated. A resize re-measures, and so
  // does new text, which a clamp already at three lines would not resize for.
  useEffect(() => {
    const element = clampRef.current;
    if (element === null || onOverflowChangeRef.current === undefined) return;
    const report = (): void => {
      // A pixel of slack absorbs subpixel line-height rounding.
      onOverflowChangeRef.current?.(
        element.scrollHeight > element.clientHeight + 1,
      );
    };
    report();
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    resize?.observe(element);
    const text =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(report);
    text?.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return (): void => {
      resize?.disconnect();
      text?.disconnect();
    };
  }, []);
  return (
    <Toast.Description render={<span />}>
      <span ref={clampRef} className="line-clamp-3">
        {children}
      </span>
    </Toast.Description>
  );
}

export interface ToastStackActivatableCardProps {
  /**
   * Runs when the card itself is clicked or its screen-reader button is
   * pressed. Without it the card is plain and not clickable.
   */
  readonly onActivate?: () => void;
  /** Accessible name of the card's screen-reader activation button. */
  readonly activateLabel: string;
  /**
   * Hand focus off the card before activating, so the Escape that closes a
   * dialog the card opens leaves the toast alone.
   */
  readonly blurFocusBeforeActivate?: boolean;
  /** The toast's type, exposed as `data-toast-type`. */
  readonly toastType: string;
  readonly children: ReactNode;
}

/**
 * A stacked toast's card. With `onActivate`, a click anywhere outside the
 * card's own buttons activates it, and a visually hidden button gives keyboard
 * and screen-reader users the same path.
 */
export function ToastStackActivatableCard({
  onActivate,
  activateLabel,
  blurFocusBeforeActivate = false,
  toastType,
  children,
}: ToastStackActivatableCardProps): JSX.Element {
  const clickable = onActivate !== undefined;
  const pointerListener = useRef<AbortController | null>(null);
  const pointerActivated = useRef(false);
  useEffect((): (() => void) => {
    return (): void => pointerListener.current?.abort();
  }, []);
  const activateCard = (card: HTMLElement): void => {
    const active = card.ownerDocument.activeElement;
    // Escape should close only the detail dialog, even if focus was in the card.
    if (
      blurFocusBeforeActivate &&
      isHTMLElementNode(active) &&
      card.contains(active)
    ) {
      active.blur();
    }
    onActivate?.();
  };

  return (
    <div
      onPointerDown={
        clickable
          ? (event): void => {
              if (
                event.button !== 0 ||
                (isElementNode(event.target) &&
                  event.target.closest('button,a,input,textarea'))
              ) {
                return;
              }
              pointerListener.current?.abort();
              pointerActivated.current = false;
              const card = event.currentTarget;
              const pointerId = event.pointerId;
              const startX = event.clientX;
              const startY = event.clientY;
              const controller = new AbortController();
              pointerListener.current = controller;
              card.ownerDocument.addEventListener(
                'pointerup',
                (up): void => {
                  if (up.pointerId !== pointerId) return;
                  controller.abort();
                  if (Math.hypot(up.clientX - startX, up.clientY - startY) > 8)
                    return;
                  // A drag that started here may have captured the pointer
                  // on Toast.Root, retargeting the click away from this card.
                  pointerActivated.current = true;
                  activateCard(card);
                  window.setTimeout(() => {
                    pointerActivated.current = false;
                  }, 0);
                },
                { signal: controller.signal },
              );
              card.ownerDocument.addEventListener(
                'pointercancel',
                () => controller.abort(),
                {
                  once: true,
                  signal: controller.signal,
                },
              );
            }
          : undefined
      }
      onClick={
        clickable
          ? (e): void => {
              if (pointerActivated.current) return;
              // The card's own buttons (Dismiss, Copy, an action) never also
              // activate the card.
              if (isElementNode(e.target) && e.target.closest('button')) {
                return;
              }
              // Escape inside a toast closes it. Hand focus off before a
              // dialog opens, so the Escape that closes the dialog leaves
              // the toast alone.
              activateCard(e.currentTarget);
            }
          : undefined
      }
      data-testid="toast-card"
      data-toast-type={toastType}
      // Inset: the card clips its content, so an outside ring would be cut.
      // Only the hidden open button rings the card; Dismiss and the actions
      // draw their own ring, so the card stays plain while they have focus.
      className={`rounded-2xl ${clickable ? 'cursor-pointer has-[[data-toast-open]:focus-visible]:outline-2 has-[[data-toast-open]:focus-visible]:-outline-offset-2 has-[[data-toast-open]:focus-visible]:outline-line-focus' : ''}`}
    >
      {clickable && (
        <button
          type="button"
          data-toast-open=""
          aria-label={activateLabel}
          className="sr-only pointer-events-none"
          onClick={(e): void => {
            e.stopPropagation();
            if (blurFocusBeforeActivate) e.currentTarget.blur();
            onActivate();
          }}
        />
      )}
      {children}
    </div>
  );
}
