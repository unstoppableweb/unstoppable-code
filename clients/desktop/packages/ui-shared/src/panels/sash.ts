/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *  for license information.
 *
 *  Ported to Canopy from VS Code OSS src/vs/base/browser/ui/sash/sash.ts
 *  (commit c4632cac, 2026-06-30), adapted to Canopy lint rules:
 *  - `const enum` -> `enum`, no `any` casts, no non-null assertions.
 *  - `.monaco-sash` -> `.canopy-sash` (all other class names unchanged).
 *  - Mouse + Gesture drag entry points collapsed into one Pointer Events path
 *    (`pointerdown` + window `pointermove`/`pointerup`); double-tap reset is
 *    covered by the browser-synthesized `dblclick` event.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  type IDisposable,
  toDisposable,
} from '../lib/disposable';
import {
  addDisposableListener,
  addDisposableWindowListener,
  createStyleSheet,
  type EventLike,
  stopEvent,
} from './dom';
import { ABOVE_BROWSER_ATTRIBUTE } from '../lib/above-browser';
import { Emitter, type Event } from '../lib/emitter';
import { getWindow, scheduleWindowTimeout } from '../lib/window-registry';

/**
 * Allow the sashes to be visible at runtime.
 * @remark Use for development purposes only.
 */
const DEBUG = false;

const isMacintosh =
  typeof navigator === 'object' &&
  /Macintosh|Mac OS X/.test(navigator.userAgent);

/**
 * A vertical sash layout provider provides position and height for a sash.
 */
export interface IVerticalSashLayoutProvider {
  getVerticalSashLeft(sash: Sash): number;
  getVerticalSashTop?(sash: Sash): number;
  getVerticalSashHeight?(sash: Sash): number;
}

/**
 * A horizontal sash layout provider provides position and width for a sash.
 */
export interface IHorizontalSashLayoutProvider {
  getHorizontalSashTop(sash: Sash): number;
  getHorizontalSashLeft?(sash: Sash): number;
  getHorizontalSashWidth?(sash: Sash): number;
}

type ISashLayoutProvider =
  | IVerticalSashLayoutProvider
  | IHorizontalSashLayoutProvider;

export interface ISashEvent {
  readonly startX: number;
  readonly currentX: number;
  readonly startY: number;
  readonly currentY: number;
  readonly altKey: boolean;
}

export enum OrthogonalEdge {
  North = 'north',
  South = 'south',
  East = 'east',
  West = 'west',
}

export interface IBoundarySashes {
  readonly top?: Sash;
  readonly right?: Sash;
  readonly bottom?: Sash;
  readonly left?: Sash;
}

export interface ISashOptions {
  /**
   * Whether a sash is horizontal or vertical.
   */
  readonly orientation: Orientation;

  /**
   * The width or height of a vertical or horizontal sash, respectively.
   */
  readonly size?: number;

  /**
   * A reference to another sash, perpendicular to this one, which
   * aligns at the start of this one. A corner sash will be created
   * automatically at that location.
   *
   * The start of a horizontal sash is its left-most position.
   * The start of a vertical sash is its top-most position.
   */
  readonly orthogonalStartSash?: Sash;

  /**
   * A reference to another sash, perpendicular to this one, which
   * aligns at the end of this one. A corner sash will be created
   * automatically at that location.
   *
   * The end of a horizontal sash is its right-most position.
   * The end of a vertical sash is its bottom-most position.
   */
  readonly orthogonalEndSash?: Sash;

  /**
   * Provides a hint as to what mouse cursor to use whenever the user
   * hovers over a corner sash provided by this and an orthogonal sash.
   */
  readonly orthogonalEdge?: OrthogonalEdge;
}

export interface IVerticalSashOptions extends ISashOptions {
  readonly orientation: Orientation.VERTICAL;
}

export interface IHorizontalSashOptions extends ISashOptions {
  readonly orientation: Orientation.HORIZONTAL;
}

export enum Orientation {
  VERTICAL,
  HORIZONTAL,
}

export enum SashState {
  /**
   * Disable any UI interaction.
   */
  Disabled,

  /**
   * Allow dragging down or to the right, depending on the sash orientation.
   *
   * Some OSs allow customizing the mouse cursor differently whenever
   * some resizable component can't be any smaller, but can be larger.
   */
  AtMinimum,

  /**
   * Allow dragging up or to the left, depending on the sash orientation.
   *
   * Some OSs allow customizing the mouse cursor differently whenever
   * some resizable component can't be any larger, but can be smaller.
   */
  AtMaximum,

  /**
   * Enable dragging.
   */
  Enabled,
}

let globalSize = 4;
const onDidChangeGlobalSize = new Emitter<number>();
export function setGlobalSashSize(size: number): void {
  globalSize = size;
  onDidChangeGlobalSize.fire(size);
}

let globalHoverDelay = 300;
const onDidChangeHoverDelay = new Emitter<number>();
export function setGlobalHoverDelay(size: number): void {
  globalHoverDelay = size;
  onDidChangeHoverDelay.fire(size);
}

/**
 * The minimal shape of a pointer event consumed by the sash drag logic.
 * Native `PointerEvent`s satisfy this structurally.
 */
interface ISashPointerEvent extends EventLike {
  readonly pageX: number;
  readonly pageY: number;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}

interface IPointerEventFactory {
  readonly onPointerMove: Event<ISashPointerEvent>;
  readonly onPointerUp: Event<ISashPointerEvent>;
  dispose(): void;
}

class PointerEventFactory implements IPointerEventFactory {
  private readonly disposables = new DisposableStore();
  private _onPointerMove: Event<ISashPointerEvent> | undefined;
  private _onPointerUp: Event<ISashPointerEvent> | undefined;

  constructor(private readonly el: HTMLElement) {}

  get onPointerMove(): Event<ISashPointerEvent> {
    if (!this._onPointerMove) {
      const emitter = this.disposables.add(new Emitter<ISashPointerEvent>());
      // Drag listeners attach to the window OWNING the sash element (window
      // registry), so drags keep tracking when the sash lives in an
      // auxiliary window (doc 05 §7.7).
      this.disposables.add(
        addDisposableWindowListener(getWindow(this.el), 'pointermove', (e) =>
          emitter.fire(e),
        ),
      );
      this._onPointerMove = emitter.event;
    }

    return this._onPointerMove;
  }

  get onPointerUp(): Event<ISashPointerEvent> {
    if (!this._onPointerUp) {
      const emitter = this.disposables.add(new Emitter<ISashPointerEvent>());
      this.disposables.add(
        addDisposableWindowListener(getWindow(this.el), 'pointerup', (e) =>
          emitter.fire(e),
        ),
      );
      this._onPointerUp = emitter.event;
    }

    return this._onPointerUp;
  }

  dispose(): void {
    this.disposables.dispose();
  }
}

class OrthogonalPointerEventFactory implements IPointerEventFactory {
  constructor(private readonly factory: IPointerEventFactory) {}

  get onPointerMove(): Event<ISashPointerEvent> {
    return this.factory.onPointerMove;
  }

  get onPointerUp(): Event<ISashPointerEvent> {
    return this.factory.onPointerUp;
  }

  dispose(): void {
    // noop
  }
}

const PointerEventsDisabledCssClass = 'pointer-events-disabled';

// Upstream tags the raw event object with `__orthogonalSashEvent` /
// `__linkedSashEvent` expando flags through `any` casts. Canopy lint forbids
// those casts, so the same re-entrancy guards are tracked in WeakSets instead.
const orthogonalSashForwardedEvents = new WeakSet<ISashPointerEvent>();
const linkedSashForwardedEvents = new WeakSet<ISashPointerEvent>();

/**
 * A minimal port of the upstream `Delayer` used for the delayed hover state.
 * Timeouts are scheduled on the window resolved by `resolveTarget` (the
 * sash's own window via the window registry), so hover delays stay tied to
 * the window the sash lives in rather than the global timer queue.
 */
class Delayer<T> implements IDisposable {
  private pendingTimeout: IDisposable | undefined = undefined;
  private completionPromise: Promise<T> | undefined = undefined;
  private doResolve: ((value: T) => void) | undefined = undefined;
  private doReject: ((error: Error) => void) | undefined = undefined;
  private task: (() => T) | undefined = undefined;

  constructor(
    public defaultDelay: number,
    private readonly resolveTarget: () => Node,
  ) {}

  trigger(task: () => T, delay: number = this.defaultDelay): Promise<T> {
    this.task = task;
    this.cancelTimeout();

    if (!this.completionPromise) {
      this.completionPromise = new Promise<T>((resolve, reject) => {
        this.doResolve = resolve;
        this.doReject = reject;
      });
    }

    this.pendingTimeout = scheduleWindowTimeout(
      this.resolveTarget(),
      () => {
        this.pendingTimeout = undefined;
        const currentTask = this.task;
        const resolve = this.doResolve;
        this.completionPromise = undefined;
        this.doResolve = undefined;
        this.doReject = undefined;
        this.task = undefined;

        if (currentTask && resolve) {
          resolve(currentTask());
        }
      },
      delay,
    );

    return this.completionPromise;
  }

  cancel(): void {
    this.cancelTimeout();

    if (this.completionPromise) {
      const reject = this.doReject;
      this.completionPromise = undefined;
      this.doResolve = undefined;
      this.doReject = undefined;
      this.task = undefined;
      reject?.(new Error('Canceled'));
    }
  }

  dispose(): void {
    this.cancel();
  }

  private cancelTimeout(): void {
    this.pendingTimeout?.dispose();
    this.pendingTimeout = undefined;
  }
}

/**
 * The {@link Sash} is the UI component which allows the user to resize other
 * components. It's usually an invisible horizontal or vertical line which, when
 * hovered, becomes highlighted and can be dragged along the perpendicular dimension
 * to its direction.
 *
 * Features:
 * - Pointer event handling (mouse and touch)
 * - Corner sash support
 * - Hover with different mouse cursor support
 * - Configurable hover size
 * - Linked sash support, for 2x2 corner sashes
 */
export class Sash extends Disposable {
  private el: HTMLElement;
  private layoutProvider: ISashLayoutProvider;
  private orientation: Orientation;
  private size: number;
  private hoverDelay = globalHoverDelay;
  // Lazy target resolution: `this.el` is assigned in the constructor body,
  // before any hover can trigger the delayer.
  private hoverDelayer = this._register(
    new Delayer<void>(this.hoverDelay, () => this.el),
  );

  private _state: SashState = SashState.Enabled;
  private readonly onDidEnablementChange = this._register(
    new Emitter<SashState>(),
  );
  private readonly _onDidStart = this._register(new Emitter<ISashEvent>());
  private readonly _onDidChange = this._register(new Emitter<ISashEvent>());
  private readonly _onDidReset = this._register(new Emitter<void>());
  private readonly _onDidEnd = this._register(new Emitter<void>());
  private readonly orthogonalStartSashDisposables = this._register(
    new DisposableStore(),
  );
  private _orthogonalStartSash: Sash | undefined;
  private readonly orthogonalStartDragHandleDisposables = this._register(
    new DisposableStore(),
  );
  private readonly orthogonalEndSashDisposables = this._register(
    new DisposableStore(),
  );
  private _orthogonalEndSash: Sash | undefined;
  private readonly orthogonalEndDragHandleDisposables = this._register(
    new DisposableStore(),
  );

  get state(): SashState {
    return this._state;
  }

  get orthogonalStartSash(): Sash | undefined {
    return this._orthogonalStartSash;
  }

  get orthogonalEndSash(): Sash | undefined {
    return this._orthogonalEndSash;
  }

  /**
   * The state of a sash defines whether it can be interacted with by the user
   * as well as what mouse cursor to use, when hovered.
   */
  set state(state: SashState) {
    if (this._state === state) {
      return;
    }

    this.el.classList.toggle('disabled', state === SashState.Disabled);
    this.el.classList.toggle('minimum', state === SashState.AtMinimum);
    this.el.classList.toggle('maximum', state === SashState.AtMaximum);

    this._state = state;
    this.onDidEnablementChange.fire(state);
  }

  /**
   * An event which fires whenever the user starts dragging this sash.
   */
  get onDidStart(): Event<ISashEvent> {
    return this._onDidStart.event;
  }

  /**
   * An event which fires whenever the user moves the mouse while
   * dragging this sash.
   */
  get onDidChange(): Event<ISashEvent> {
    return this._onDidChange.event;
  }

  /**
   * An event which fires whenever the user double clicks this sash.
   */
  get onDidReset(): Event<void> {
    return this._onDidReset.event;
  }

  /**
   * An event which fires whenever the user stops dragging this sash.
   */
  get onDidEnd(): Event<void> {
    return this._onDidEnd.event;
  }

  /**
   * A linked sash will be forwarded the same user interactions and events
   * so it moves exactly the same way as this sash.
   *
   * Useful in 2x2 grids. Not meant for widespread usage.
   */
  linkedSash: Sash | undefined = undefined;

  /**
   * A reference to another sash, perpendicular to this one, which
   * aligns at the start of this one. A corner sash will be created
   * automatically at that location.
   *
   * The start of a horizontal sash is its left-most position.
   * The start of a vertical sash is its top-most position.
   */
  set orthogonalStartSash(sash: Sash | undefined) {
    if (this._orthogonalStartSash === sash) {
      return;
    }

    this.orthogonalStartDragHandleDisposables.clear();
    this.orthogonalStartSashDisposables.clear();

    if (sash) {
      const onChange = (state: SashState): void => {
        this.orthogonalStartDragHandleDisposables.clear();

        if (state !== SashState.Disabled) {
          const handle = this.el.ownerDocument.createElement('div');
          handle.classList.add('orthogonal-drag-handle', 'start');
          this.el.appendChild(handle);
          this.orthogonalStartDragHandleDisposables.add(
            toDisposable(() => handle.remove()),
          );
          this.orthogonalStartDragHandleDisposables.add(
            addDisposableListener(handle, 'mouseenter', () =>
              Sash.onMouseEnter(sash),
            ),
          );
          this.orthogonalStartDragHandleDisposables.add(
            addDisposableListener(handle, 'mouseleave', () =>
              Sash.onMouseLeave(sash),
            ),
          );
        }
      };

      this.orthogonalStartSashDisposables.add(
        sash.onDidEnablementChange.event(onChange, this),
      );
      onChange(sash.state);
    }

    this._orthogonalStartSash = sash;
  }

  /**
   * A reference to another sash, perpendicular to this one, which
   * aligns at the end of this one. A corner sash will be created
   * automatically at that location.
   *
   * The end of a horizontal sash is its right-most position.
   * The end of a vertical sash is its bottom-most position.
   */
  set orthogonalEndSash(sash: Sash | undefined) {
    if (this._orthogonalEndSash === sash) {
      return;
    }

    this.orthogonalEndDragHandleDisposables.clear();
    this.orthogonalEndSashDisposables.clear();

    if (sash) {
      const onChange = (state: SashState): void => {
        this.orthogonalEndDragHandleDisposables.clear();

        if (state !== SashState.Disabled) {
          const handle = this.el.ownerDocument.createElement('div');
          handle.classList.add('orthogonal-drag-handle', 'end');
          this.el.appendChild(handle);
          this.orthogonalEndDragHandleDisposables.add(
            toDisposable(() => handle.remove()),
          );
          this.orthogonalEndDragHandleDisposables.add(
            addDisposableListener(handle, 'mouseenter', () =>
              Sash.onMouseEnter(sash),
            ),
          );
          this.orthogonalEndDragHandleDisposables.add(
            addDisposableListener(handle, 'mouseleave', () =>
              Sash.onMouseLeave(sash),
            ),
          );
        }
      };

      this.orthogonalEndSashDisposables.add(
        sash.onDidEnablementChange.event(onChange, this),
      );
      onChange(sash.state);
    }

    this._orthogonalEndSash = sash;
  }

  /**
   * Create a new vertical sash.
   *
   * @param container A DOM node to append the sash to.
   * @param verticalLayoutProvider A vertical layout provider.
   * @param options The options.
   */
  constructor(
    container: HTMLElement,
    verticalLayoutProvider: IVerticalSashLayoutProvider,
    options: IVerticalSashOptions,
  );

  /**
   * Create a new horizontal sash.
   *
   * @param container A DOM node to append the sash to.
   * @param horizontalLayoutProvider A horizontal layout provider.
   * @param options The options.
   */
  constructor(
    container: HTMLElement,
    horizontalLayoutProvider: IHorizontalSashLayoutProvider,
    options: IHorizontalSashOptions,
  );
  constructor(
    container: HTMLElement,
    layoutProvider: ISashLayoutProvider,
    options: ISashOptions,
  ) {
    super();

    this.el = container.ownerDocument.createElement('div');
    this.el.classList.add('canopy-sash');
    // A hovered or dragged sash's handle overhangs onto the views beside it,
    // which may be an in-app browser page; draw it above the page there.
    this.el.setAttribute(ABOVE_BROWSER_ATTRIBUTE, 'hover');
    container.appendChild(this.el);

    if (options.orthogonalEdge) {
      this.el.classList.add(`orthogonal-edge-${options.orthogonalEdge}`);
    }

    if (isMacintosh) {
      this.el.classList.add('mac');
    }

    this._register(
      addDisposableListener(this.el, 'pointerdown', (e) =>
        this.onPointerStart(e, new PointerEventFactory(this.el)),
      ),
    );
    this._register(
      addDisposableListener(this.el, 'dblclick', (e) =>
        this.onPointerDoublePress(e),
      ),
    );
    this._register(
      addDisposableListener(this.el, 'mouseenter', () =>
        Sash.onMouseEnter(this),
      ),
    );
    this._register(
      addDisposableListener(this.el, 'mouseleave', () =>
        Sash.onMouseLeave(this),
      ),
    );

    if (typeof options.size === 'number') {
      this.size = options.size;

      if (options.orientation === Orientation.VERTICAL) {
        this.el.style.width = `${this.size}px`;
      } else {
        this.el.style.height = `${this.size}px`;
      }
    } else {
      this.size = globalSize;
      this._register(
        onDidChangeGlobalSize.event((size: number) => {
          this.size = size;
          this.layout();
        }),
      );
    }

    this._register(
      onDidChangeHoverDelay.event((delay: number) => {
        this.hoverDelay = delay;
      }),
    );

    this.layoutProvider = layoutProvider;

    this.orthogonalStartSash = options.orthogonalStartSash;
    this.orthogonalEndSash = options.orthogonalEndSash;

    this.orientation = options.orientation || Orientation.VERTICAL;

    if (this.orientation === Orientation.HORIZONTAL) {
      this.el.classList.add('horizontal');
      this.el.classList.remove('vertical');
    } else {
      this.el.classList.remove('horizontal');
      this.el.classList.add('vertical');
    }

    this.el.classList.toggle('debug', DEBUG);

    this.layout();
  }

  private onPointerStart(
    event: ISashPointerEvent,
    pointerEventFactory: IPointerEventFactory,
  ): void {
    stopEvent(event);

    let isMultisashResize = false;

    if (!orthogonalSashForwardedEvents.has(event)) {
      const orthogonalSash = this.getOrthogonalSash(event);

      if (orthogonalSash) {
        isMultisashResize = true;
        orthogonalSashForwardedEvents.add(event);
        orthogonalSash.onPointerStart(
          event,
          new OrthogonalPointerEventFactory(pointerEventFactory),
        );
      }
    }

    if (this.linkedSash && !linkedSashForwardedEvents.has(event)) {
      linkedSashForwardedEvents.add(event);
      this.linkedSash.onPointerStart(
        event,
        new OrthogonalPointerEventFactory(pointerEventFactory),
      );
    }

    if (this.state === SashState.Disabled) {
      return;
    }

    // disable mouse events on iframes as long as we drag the sash
    const iframes = this.el.ownerDocument.getElementsByTagName('iframe');
    for (const iframe of iframes) {
      iframe.classList.add(PointerEventsDisabledCssClass);
    }

    const startX = event.pageX;
    const startY = event.pageY;
    const altKey = event.altKey;
    const startEvent: ISashEvent = {
      startX,
      currentX: startX,
      startY,
      currentY: startY,
      altKey,
    };

    this.el.classList.add('active');
    this._onDidStart.fire(startEvent);

    // fix https://github.com/microsoft/vscode/issues/21675
    const style = createStyleSheet(this.el);
    const updateStyle = (): void => {
      let cursor = '';

      if (isMultisashResize) {
        cursor = 'all-scroll';
      } else if (this.orientation === Orientation.HORIZONTAL) {
        if (this.state === SashState.AtMinimum) {
          cursor = 's-resize';
        } else if (this.state === SashState.AtMaximum) {
          cursor = 'n-resize';
        } else {
          cursor = isMacintosh ? 'row-resize' : 'ns-resize';
        }
      } else {
        if (this.state === SashState.AtMinimum) {
          cursor = 'e-resize';
        } else if (this.state === SashState.AtMaximum) {
          cursor = 'w-resize';
        } else {
          cursor = isMacintosh ? 'col-resize' : 'ew-resize';
        }
      }

      style.textContent = `* { cursor: ${cursor} !important; }`;
    };

    const disposables = new DisposableStore();

    updateStyle();

    if (!isMultisashResize) {
      this.onDidEnablementChange.event(updateStyle, null, disposables);
    }

    const onPointerMove = (e: ISashPointerEvent): void => {
      stopEvent(e, false);
      const moveEvent: ISashEvent = {
        startX,
        currentX: e.pageX,
        startY,
        currentY: e.pageY,
        altKey,
      };

      this._onDidChange.fire(moveEvent);
    };

    const onPointerUp = (e: ISashPointerEvent): void => {
      stopEvent(e, false);

      style.remove();

      this.el.classList.remove('active');
      this._onDidEnd.fire();

      disposables.dispose();

      for (const iframe of iframes) {
        iframe.classList.remove(PointerEventsDisabledCssClass);
      }
    };

    pointerEventFactory.onPointerMove(onPointerMove, null, disposables);
    pointerEventFactory.onPointerUp(onPointerUp, null, disposables);
    disposables.add(pointerEventFactory);
  }

  private onPointerDoublePress(e: MouseEvent): void {
    const orthogonalSash = this.getOrthogonalSash(e);

    if (orthogonalSash) {
      orthogonalSash._onDidReset.fire();
    }

    if (this.linkedSash) {
      this.linkedSash._onDidReset.fire();
    }

    this._onDidReset.fire();
  }

  private static onMouseEnter(
    sash: Sash,
    fromLinkedSash: boolean = false,
  ): void {
    if (sash.el.classList.contains('active')) {
      sash.hoverDelayer.cancel();
      sash.el.classList.add('hover');
    } else {
      void sash.hoverDelayer
        .trigger(() => {
          sash.el.classList.add('hover');
        }, sash.hoverDelay)
        .then(undefined, () => {
          // Cancellation is expected when the pointer leaves before the delay.
        });
    }

    if (!fromLinkedSash && sash.linkedSash) {
      Sash.onMouseEnter(sash.linkedSash, true);
    }
  }

  private static onMouseLeave(
    sash: Sash,
    fromLinkedSash: boolean = false,
  ): void {
    sash.hoverDelayer.cancel();
    sash.el.classList.remove('hover');

    if (!fromLinkedSash && sash.linkedSash) {
      Sash.onMouseLeave(sash.linkedSash, true);
    }
  }

  /**
   * Forcefully stop any user interactions with this sash.
   * Useful when hiding a parent component, while the user is still
   * interacting with the sash.
   */
  clearSashHoverState(): void {
    Sash.onMouseLeave(this);
  }

  /**
   * Layout the sash. The sash will size and position itself
   * based on its provided {@link ISashLayoutProvider layout provider}.
   */
  layout(): void {
    if (this.orientation === Orientation.VERTICAL) {
      if (!('getVerticalSashLeft' in this.layoutProvider)) {
        throw new Error('Vertical sash requires a vertical layout provider');
      }

      const verticalProvider = this.layoutProvider;
      this.el.style.left = `${verticalProvider.getVerticalSashLeft(this) - this.size / 2}px`;

      if (verticalProvider.getVerticalSashTop) {
        this.el.style.top = `${verticalProvider.getVerticalSashTop(this)}px`;
      }

      if (verticalProvider.getVerticalSashHeight) {
        this.el.style.height = `${verticalProvider.getVerticalSashHeight(this)}px`;
      }
    } else {
      if (!('getHorizontalSashTop' in this.layoutProvider)) {
        throw new Error(
          'Horizontal sash requires a horizontal layout provider',
        );
      }

      const horizontalProvider = this.layoutProvider;
      this.el.style.top = `${horizontalProvider.getHorizontalSashTop(this) - this.size / 2}px`;

      if (horizontalProvider.getHorizontalSashLeft) {
        this.el.style.left = `${horizontalProvider.getHorizontalSashLeft(this)}px`;
      }

      if (horizontalProvider.getHorizontalSashWidth) {
        this.el.style.width = `${horizontalProvider.getHorizontalSashWidth(this)}px`;
      }
    }
  }

  private getOrthogonalSash(e: ISashPointerEvent): Sash | undefined {
    const target = e.target;

    // PHASE8: `instanceof HTMLElement` resolves against this module's realm.
    // Safe today because all panel DOM (including DOM adopted into child
    // windows) is created in the opener realm per the doc 13 rule; if a
    // child-realm-created node can ever be a drag target, switch to a
    // realm-agnostic check (e.g. `nodeType === 1` + classList duck-typing).
    if (!target || !(target instanceof HTMLElement)) {
      return undefined;
    }

    if (target.classList.contains('orthogonal-drag-handle')) {
      return target.classList.contains('start')
        ? this.orthogonalStartSash
        : this.orthogonalEndSash;
    }

    return undefined;
  }

  override dispose(): void {
    super.dispose();
    this.el.remove();
  }
}
