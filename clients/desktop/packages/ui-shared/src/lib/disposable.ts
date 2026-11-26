/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *  for license information.
 *
 *  Ported to Canopy from VS Code OSS src/vs/base/common/lifecycle.ts
 *  (commit c4632cac, 2026-06-30). Minimal subset required by the Canopy panels
 *  primitives (sash / splitview / gridview), adapted to Canopy lint rules.
 *--------------------------------------------------------------------------------------------*/

/**
 * An object that performs a cleanup operation when `.dispose()` is called.
 */
export interface IDisposable {
  dispose(): void;
}

/**
 * Turn a function into an {@link IDisposable}. The function is guaranteed to
 * run at most once.
 */
export function toDisposable(fn: () => void): IDisposable {
  let disposed = false;

  return {
    dispose(): void {
      if (!disposed) {
        disposed = true;
        fn();
      }
    },
  };
}

/**
 * Disposes of all provided disposables. If any of the disposables throws, the
 * remaining disposables are still disposed and the first error is rethrown
 * afterwards.
 */
export function dispose<T extends IDisposable>(disposables: T[]): T[] {
  const errors: unknown[] = [];

  for (const disposable of disposables) {
    try {
      disposable.dispose();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    const firstError = errors[0];

    if (firstError instanceof Error) {
      throw firstError;
    }

    throw new Error('Encountered an error while disposing of disposables');
  }

  return disposables;
}

/**
 * Combine multiple disposable values into a single {@link IDisposable}.
 */
export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
  return toDisposable(() => {
    dispose(disposables);
  });
}

/**
 * Manages a collection of disposable values.
 */
export class DisposableStore implements IDisposable {
  private readonly _toDispose = new Set<IDisposable>();
  private _isDisposed = false;

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of all registered disposables and mark this object as disposed.
   * Any future disposables added to this object will be disposed immediately.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }

    this._isDisposed = true;
    this.clear();
  }

  /**
   * Dispose of all registered disposables but do not mark this object as
   * disposed.
   */
  clear(): void {
    if (this._toDispose.size === 0) {
      return;
    }

    const disposables = Array.from(this._toDispose);
    this._toDispose.clear();
    dispose(disposables);
  }

  /**
   * Add a new disposable to the collection.
   *
   * Deviation from upstream: adding to a disposed store disposes the incoming
   * disposable immediately (upstream leaks it and warns via `console.warn`,
   * which Canopy lint forbids).
   */
  add<T extends IDisposable>(o: T): T {
    if (Object.is(o, this)) {
      throw new Error('Cannot register a disposable on itself!');
    }

    if (this._isDisposed) {
      o.dispose();
    } else {
      this._toDispose.add(o);
    }

    return o;
  }
}

/**
 * Abstract base class for a source of disposables.
 */
export abstract class Disposable implements IDisposable {
  /**
   * A disposable that does nothing when it is disposed of.
   */
  static readonly None: IDisposable = Object.freeze<IDisposable>({
    dispose(): void {
      // noop
    },
  });

  private readonly _store = new DisposableStore();

  dispose(): void {
    this._store.dispose();
  }

  /**
   * Adds `o` to the collection of disposables managed by this object.
   */
  protected _register<T extends IDisposable>(o: T): T {
    if (Object.is(o, this)) {
      throw new Error('Cannot register a disposable on itself!');
    }

    return this._store.add(o);
  }
}
