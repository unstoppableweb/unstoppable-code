/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *  for license information.
 *
 *  Ported to Canopy from VS Code OSS src/vs/base/common/event.ts
 *  (commit c4632cac, 2026-06-30). Minimal subset required by the Canopy panels
 *  primitives (sash / splitview / gridview), adapted to Canopy lint rules.
 *--------------------------------------------------------------------------------------------*/

import {
  combinedDisposable,
  Disposable,
  DisposableStore,
  type IDisposable,
  toDisposable,
} from './disposable';

/**
 * An event with zero or one parameters that can be subscribed to. The event is
 * a function itself: calling it subscribes the given listener and returns an
 * {@link IDisposable} that unsubscribes it.
 */
export type Event<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: IDisposable[] | DisposableStore,
) => IDisposable;

interface ListenerEntry<T> {
  readonly fn: (e: T) => unknown;
  readonly thisArgs: unknown;
}

/**
 * The Emitter can be used to expose an {@link Event} to the public to fire it
 * from the insides. Sample:
 *
 * ```ts
 * class Document {
 *   private readonly _onDidChange = new Emitter<(value: string) => unknown>();
 *   public onDidChange = this._onDidChange.event;
 *
 *   // getter-style
 *   // get onDidChange(): Event<(value: string) => unknown> {
 *   //   return this._onDidChange.event;
 *   // }
 *
 *   private _doIt() {
 *     // ...
 *     this._onDidChange.fire(value);
 *   }
 * }
 * ```
 */
export class Emitter<T> {
  private listeners: ListenerEntry<T>[] = [];
  private disposed = false;
  private _event: Event<T> | undefined;

  get event(): Event<T> {
    if (!this._event) {
      const event: Event<T> = (listener, thisArgs?, disposables?) => {
        if (this.disposed) {
          return Disposable.None;
        }

        const entry: ListenerEntry<T> = { fn: listener, thisArgs };
        this.listeners.push(entry);

        const result = toDisposable(() => {
          const index = this.listeners.indexOf(entry);

          if (index >= 0) {
            this.listeners.splice(index, 1);
          }
        });

        if (disposables instanceof DisposableStore) {
          disposables.add(result);
        } else if (Array.isArray(disposables)) {
          disposables.push(result);
        }

        return result;
      };

      this._event = event;
    }

    return this._event;
  }

  /**
   * To be kept private to fire an event to subscribers.
   */
  fire(event: T): void {
    for (const entry of [...this.listeners]) {
      entry.fn.call(entry.thisArgs, event);
    }
  }

  dispose(): void {
    this.listeners.length = 0;
    this.disposed = true;
  }
}

function eventMap<I, O>(event: Event<I>, map: (i: I) => O): Event<O> {
  return (listener, thisArgs, disposables) =>
    event((i) => listener.call(thisArgs, map(i)), undefined, disposables);
}

function eventAny<T>(...events: Event<T>[]): Event<T> {
  return (listener, thisArgs, disposables) =>
    combinedDisposable(
      ...events.map((event) =>
        event((e) => listener.call(thisArgs, e), undefined, disposables),
      ),
    );
}

function eventSignal<T>(event: Event<T>): Event<void> {
  return (listener, thisArgs, disposables) =>
    event(() => listener.call(thisArgs, undefined), undefined, disposables);
}

function eventFilter<T, R extends T>(
  event: Event<T>,
  filter: (e: T) => e is R,
): Event<R>;
function eventFilter<T>(event: Event<T>, filter: (e: T) => boolean): Event<T>;
function eventFilter<T>(event: Event<T>, filter: (e: T) => boolean): Event<T> {
  return (listener, thisArgs, disposables) =>
    event(
      (e) => {
        if (filter(e)) {
          listener.call(thisArgs, e);
        }
      },
      undefined,
      disposables,
    );
}

function eventLatch<T>(
  event: Event<T>,
  equals: (a: T, b: T) => boolean = (a, b) => a === b,
): Event<T> {
  let cache: { readonly value: T } | undefined = undefined;

  return eventFilter(event, (value) => {
    const shouldEmit = cache === undefined || !equals(value, cache.value);
    cache = { value };
    return shouldEmit;
  });
}

function eventSplit<T, U>(
  event: Event<T | U>,
  isT: (e: T | U) => e is T,
): [Event<T>, Event<U>] {
  return [
    eventFilter(event, isT),
    eventFilter<T | U, U>(event, (e): e is U => !isT(e)),
  ];
}

interface EventUtils {
  /**
   * An event which never fires.
   */
  readonly None: Event<never>;

  /**
   * Maps an event of one type into an event of another type using a mapping
   * function.
   */
  readonly map: <I, O>(event: Event<I>, map: (i: I) => O) => Event<O>;

  /**
   * Given a collection of events, returns a single event which emits whenever
   * any of the provided events emit.
   */
  readonly any: <T>(...events: Event<T>[]) => Event<T>;

  /**
   * Wraps an event in another event that ignores the emitted value.
   */
  readonly signal: <T>(event: Event<T>) => Event<void>;

  /**
   * Filters an event using a given filter function.
   */
  readonly filter: typeof eventFilter;

  /**
   * Wraps an event in another event that only fires when the emitted value
   * changed (per the given equality function).
   */
  readonly latch: <T>(
    event: Event<T>,
    equals?: (a: T, b: T) => boolean,
  ) => Event<T>;

  /**
   * Splits an event whose parameter is a union type into two separate events
   * for each type in the union.
   */
  readonly split: typeof eventSplit;
}

/**
 * Helper functions over {@link Event} values, mirroring the subset of the
 * upstream `Event` namespace used by the panels primitives.
 */
export const Event: EventUtils = {
  None: () => Disposable.None,
  map: eventMap,
  any: eventAny,
  signal: eventSignal,
  filter: eventFilter,
  latch: eventLatch,
  split: eventSplit,
};

/**
 * A Relay is an event forwarder which functions as a replugabble event pipe.
 * Once created, you can connect an input event to it and it will simply
 * forward events from that input event through its own `event` property. The
 * `input` can be changed at any point in time.
 *
 * Deviation from upstream: the relay subscribes to its input eagerly rather
 * than only while it has listeners.
 */
export class Relay<T> implements IDisposable {
  private inputEventListener: IDisposable = Disposable.None;
  private readonly emitter = new Emitter<T>();

  readonly event: Event<T> = this.emitter.event;

  set input(event: Event<T>) {
    this.inputEventListener.dispose();
    this.inputEventListener = event((e) => this.emitter.fire(e));
  }

  dispose(): void {
    this.inputEventListener.dispose();
    this.emitter.dispose();
  }
}
