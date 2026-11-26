import { useLayoutEffect, useRef, type JSX } from 'react';
import { DisposableStore, toDisposable } from '../../lib/disposable';
import { getWindow } from '../../lib/window-registry';
import {
  type IHorizontalSashOptions,
  type ISashEvent,
  type IVerticalSashOptions,
  Orientation,
  Sash as SashEngine,
  SashState,
} from '../../panels/sash';

/**
 * Orientation of the divider line itself:
 * - `'vertical'`   — a vertical line that resizes content left/right.
 * - `'horizontal'` — a horizontal line that resizes content up/down.
 */
export type SashOrientation = 'horizontal' | 'vertical';

/** Pointer coordinates for a sash drag, mirroring the engine's sash event. */
export interface SashDragEvent {
  readonly startX: number;
  readonly currentX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly altKey: boolean;
}

export interface SashProps {
  orientation: SashOrientation;
  /** Fired once when a drag starts (pointer down on the sash). */
  onDragStart?: (event: SashDragEvent) => void;
  /** Fired for every pointer move during a drag (live, not committed). */
  onChange?: (event: SashDragEvent) => void;
  /** Fired once when a drag ends (pointer up). Commit sizes here. */
  onDragEnd?: () => void;
  /** Fired when the user double-clicks the sash (reset affordance). */
  onReset?: () => void;
  disabled?: boolean;
  /** Thickness of the sash hit area in pixels (falls back to the global sash size). */
  size?: number;
  className?: string;
  /** Accessible label for the separator. @defaultValue `'Resize'` */
  ariaLabel?: string;
  ariaValueMin?: number;
  ariaValueMax?: number;
  ariaValueNow?: number;
}

const KEYBOARD_RESIZE_STEP = 10;

interface LatestSashProps {
  orientation: SashOrientation;
  disabled: boolean;
  onDragStart?: (event: SashDragEvent) => void;
  onChange?: (event: SashDragEvent) => void;
  onDragEnd?: () => void;
  onReset?: () => void;
}

function toDragEvent(event: ISashEvent): SashDragEvent {
  return {
    startX: event.startX,
    currentX: event.currentX,
    startY: event.startY,
    currentY: event.currentY,
    altKey: event.altKey,
  };
}

/**
 * Thin controlled React wrapper around the imperative panels Sash for
 * consumers that need a lone divider without a SplitView. The engine owns
 * the sash DOM, pointer handling, hover/active state, and drag cursor; this
 * component adds the separator ARIA contract and keyboard arrow-key resize
 * (emitted as a synthetic drag-start/change/drag-end sequence).
 */
export function Sash({
  orientation,
  onDragStart,
  onChange,
  onDragEnd,
  onReset,
  disabled,
  size,
  className,
  ariaLabel,
  ariaValueMin,
  ariaValueMax,
  ariaValueNow,
}: SashProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sashRef = useRef<SashEngine | null>(null);
  const sashElementRef = useRef<HTMLElement | null>(null);

  const latestRef = useRef<LatestSashProps>({
    orientation,
    disabled: disabled ?? false,
  });
  latestRef.current = {
    orientation,
    disabled: disabled ?? false,
    onDragStart,
    onChange,
    onDragEnd,
    onReset,
  };

  // Create/destroy the imperative sash. Recreated only when construction
  // options (orientation, size) change; callbacks flow through latestRef.
  useLayoutEffect(() => {
    const host = hostRef.current;

    if (!host) {
      return undefined;
    }

    const store = new DisposableStore();
    let sash: SashEngine;

    if (orientation === 'vertical') {
      const options: IVerticalSashOptions = {
        orientation: Orientation.VERTICAL,
        size,
      };
      sash = new SashEngine(
        host,
        {
          getVerticalSashLeft: (): number => host.clientWidth / 2,
          getVerticalSashTop: (): number => 0,
          getVerticalSashHeight: (): number => host.clientHeight,
        },
        options,
      );
    } else {
      const options: IHorizontalSashOptions = {
        orientation: Orientation.HORIZONTAL,
        size,
      };
      sash = new SashEngine(
        host,
        {
          getHorizontalSashTop: (): number => host.clientHeight / 2,
          getHorizontalSashLeft: (): number => 0,
          getHorizontalSashWidth: (): number => host.clientWidth,
        },
        options,
      );
    }

    sashRef.current = sash;
    store.add(toDisposable(() => sash.dispose()));
    store.add(
      sash.onDidStart((event) =>
        latestRef.current.onDragStart?.(toDragEvent(event)),
      ),
    );
    store.add(
      sash.onDidChange((event) =>
        latestRef.current.onChange?.(toDragEvent(event)),
      ),
    );
    store.add(sash.onDidEnd(() => latestRef.current.onDragEnd?.()));
    store.add(sash.onDidReset(() => latestRef.current.onReset?.()));

    const sashElement = host.querySelector(':scope > .canopy-sash');
    sashElementRef.current =
      sashElement instanceof HTMLElement ? sashElement : null;

    // Keyboard arrow-key resize: emitted as a synthetic drag sequence so
    // consumers reuse the same live/commit callback discipline as pointer
    // drags.
    const onKeyDown = (event: KeyboardEvent): void => {
      const latest = latestRef.current;

      if (latest.disabled) {
        return;
      }

      const vertical = latest.orientation === 'vertical';
      const decreaseKey = vertical ? 'ArrowLeft' : 'ArrowUp';
      const increaseKey = vertical ? 'ArrowRight' : 'ArrowDown';
      let delta: number;

      if (event.key === decreaseKey) {
        delta = -KEYBOARD_RESIZE_STEP;
      } else if (event.key === increaseKey) {
        delta = KEYBOARD_RESIZE_STEP;
      } else {
        return;
      }

      event.preventDefault();
      const start: SashDragEvent = {
        startX: 0,
        currentX: 0,
        startY: 0,
        currentY: 0,
        altKey: false,
      };
      latest.onDragStart?.(start);
      latest.onChange?.({
        startX: 0,
        currentX: vertical ? delta : 0,
        startY: 0,
        currentY: vertical ? 0 : delta,
        altKey: false,
      });
      latest.onDragEnd?.();
    };

    const element = sashElementRef.current;

    if (element) {
      element.addEventListener('keydown', onKeyDown);
      store.add(
        toDisposable(() => element.removeEventListener('keydown', onKeyDown)),
      );
    }

    // Construct the observer from the host element's own realm (window
    // registry) so relayout tracks the window the sash actually lives in
    // (doc 05 §7.8).
    const hostWindow = getWindow(host);

    if (typeof hostWindow.ResizeObserver !== 'undefined') {
      const observer = new hostWindow.ResizeObserver(() => {
        sashRef.current?.layout();
      });
      observer.observe(host);
      store.add(toDisposable(() => observer.disconnect()));
    }

    return (): void => {
      store.dispose();
      sashRef.current = null;
      sashElementRef.current = null;
    };
  }, [orientation, size]);

  // Enablement + ARIA contract, applied to the engine-owned sash element on
  // every render (cheap attribute writes).
  useLayoutEffect(() => {
    const sash = sashRef.current;
    const element = sashElementRef.current;

    if (sash) {
      sash.state = disabled ? SashState.Disabled : SashState.Enabled;
    }

    if (!element) {
      return;
    }

    element.setAttribute('role', 'separator');
    element.setAttribute('aria-orientation', orientation);
    element.setAttribute('aria-label', ariaLabel ?? 'Resize');
    element.tabIndex = disabled ? -1 : 0;

    if (disabled) {
      element.setAttribute('aria-disabled', 'true');
    } else {
      element.removeAttribute('aria-disabled');
    }

    if (typeof ariaValueMin === 'number') {
      element.setAttribute('aria-valuemin', String(ariaValueMin));
    } else {
      element.removeAttribute('aria-valuemin');
    }

    if (typeof ariaValueMax === 'number') {
      element.setAttribute('aria-valuemax', String(ariaValueMax));
    } else {
      element.removeAttribute('aria-valuemax');
    }

    if (typeof ariaValueNow === 'number') {
      element.setAttribute('aria-valuenow', String(ariaValueNow));
    } else {
      element.removeAttribute('aria-valuenow');
    }
  });

  return (
    <div
      ref={hostRef}
      className={
        className ? `canopy-sash-host ${className}` : 'canopy-sash-host'
      }
    />
  );
}
