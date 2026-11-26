/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *  for license information.
 *
 *  Ported to Canopy from VS Code OSS src/vs/base/browser/dom.ts and
 *  src/vs/base/browser/domStylesheets.ts (commit c4632cac, 2026-06-30).
 *  Minimal subset required by the Canopy panels primitives, adapted to Canopy
 *  lint rules.
 *--------------------------------------------------------------------------------------------*/

import { type IDisposable, toDisposable } from '../lib/disposable';

/**
 * The minimal shape of an event that can be stopped.
 */
export interface EventLike {
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Prevents the default action of an event and optionally stops it from
 * bubbling (upstream `EventHelper.stop`).
 */
export function stopEvent(event: EventLike, cancelBubble?: boolean): void {
  event.preventDefault();

  if (cancelBubble) {
    event.stopPropagation();
  }
}

/**
 * Adds an event listener to an element and returns an {@link IDisposable}
 * that removes it.
 */
export function addDisposableListener<K extends keyof HTMLElementEventMap>(
  element: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): IDisposable {
  element.addEventListener(type, handler);
  return toDisposable(() => element.removeEventListener(type, handler));
}

/**
 * Adds an event listener to a window and returns an {@link IDisposable} that
 * removes it.
 */
export function addDisposableWindowListener<K extends keyof WindowEventMap>(
  targetWindow: Window,
  type: K,
  handler: (event: WindowEventMap[K]) => void,
): IDisposable {
  targetWindow.addEventListener(type, handler);
  return toDisposable(() => targetWindow.removeEventListener(type, handler));
}

/**
 * Creates an empty `<style>` element inside the given container (upstream
 * `createStyleSheet`). The caller owns removal.
 *
 * Multi-window rule (doc 05 §4, verified by the Phase 0 spike): the style is
 * created via `container.ownerDocument` — node-relative, never the global
 * `document` — so injected CSS (e.g. the sash drag cursor) lives in the
 * document it must apply to, including auxiliary windows.
 */
export function createStyleSheet(container: HTMLElement): HTMLStyleElement {
  const style = container.ownerDocument.createElement('style');
  container.appendChild(style);
  return style;
}
