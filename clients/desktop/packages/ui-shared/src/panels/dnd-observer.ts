/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code OSS: src/vs/base/browser/dom.ts (DragAndDropObserver,
// IDragAndDropObserverCallbacks). Upstream commit c4632cac (2026-06-30).

import { Disposable, type IDisposable, toDisposable } from '../lib/disposable';

/**
 * Callbacks for {@link DragAndDropObserver}. This is the framework-agnostic
 * contract a React hook can later wrap: pass an element plus these callbacks,
 * dispose to detach.
 */
export interface IDragAndDropObserverCallbacks {
  readonly onDragEnter?: (e: DragEvent) => void;
  readonly onDragLeave?: (e: DragEvent) => void;
  readonly onDrop?: (e: DragEvent) => void;
  readonly onDragEnd?: (e: DragEvent) => void;
  readonly onDragStart?: (e: DragEvent) => void;
  readonly onDrag?: (e: DragEvent) => void;
  readonly onDragOver?: (e: DragEvent, dragDuration: number) => void;
}

type DragAndDropEventType =
  | 'dragstart'
  | 'drag'
  | 'dragenter'
  | 'dragover'
  | 'dragleave'
  | 'dragend'
  | 'drop';

function addDisposableListener(
  element: HTMLElement,
  type: DragAndDropEventType,
  handler: (e: DragEvent) => void,
): IDisposable {
  element.addEventListener(type, handler);
  return toDisposable((): void => {
    element.removeEventListener(type, handler);
  });
}

/**
 * Normalizes native HTML5 drag events on a single element.
 *
 * - Counter-based dragenter/dragleave tracking: native events fire once per
 *   child element crossed, so naively toggling on enter/leave flickers.
 *   `onDragLeave` only fires when the counter returns to 0 (the pointer truly
 *   left the element's subtree). See https://github.com/microsoft/vscode/issues/14470.
 * - `dragover` is `preventDefault()`ed so the `drop` event fires (Chrome
 *   quirk), and `onDragOver` receives the drag duration so far.
 * - `drop`/`dragend` hard-reset the counter.
 */
export class DragAndDropObserver extends Disposable {
  // A helper to fix issues with repeated DRAG_ENTER / DRAG_LEAVE
  // calls see https://github.com/microsoft/vscode/issues/14470
  // when the element has child elements where the events are fired
  // repeadedly.
  private counter = 0;

  // Allows to measure the duration of the drag operation.
  private dragStartTime = 0;

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: IDragAndDropObserverCallbacks,
  ) {
    super();

    this.registerListeners();
  }

  private registerListeners(): void {
    if (this.callbacks.onDragStart) {
      this._register(
        addDisposableListener(
          this.element,
          'dragstart',
          (e: DragEvent): void => {
            this.callbacks.onDragStart?.(e);
          },
        ),
      );
    }

    if (this.callbacks.onDrag) {
      this._register(
        addDisposableListener(this.element, 'drag', (e: DragEvent): void => {
          this.callbacks.onDrag?.(e);
        }),
      );
    }

    this._register(
      addDisposableListener(this.element, 'dragenter', (e: DragEvent): void => {
        this.counter++;
        this.dragStartTime = e.timeStamp;

        this.callbacks.onDragEnter?.(e);
      }),
    );

    this._register(
      addDisposableListener(this.element, 'dragover', (e: DragEvent): void => {
        e.preventDefault(); // needed so that the drop event fires (https://stackoverflow.com/questions/21339924/drop-event-not-firing-in-chrome)

        this.callbacks.onDragOver?.(e, e.timeStamp - this.dragStartTime);
      }),
    );

    this._register(
      addDisposableListener(this.element, 'dragleave', (e: DragEvent): void => {
        this.counter--;

        if (this.counter === 0) {
          this.dragStartTime = 0;

          this.callbacks.onDragLeave?.(e);
        }
      }),
    );

    this._register(
      addDisposableListener(this.element, 'dragend', (e: DragEvent): void => {
        this.counter = 0;
        this.dragStartTime = 0;

        this.callbacks.onDragEnd?.(e);
      }),
    );

    this._register(
      addDisposableListener(this.element, 'drop', (e: DragEvent): void => {
        this.counter = 0;
        this.dragStartTime = 0;

        this.callbacks.onDrop?.(e);
      }),
    );
  }
}
