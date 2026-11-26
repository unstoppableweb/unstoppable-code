/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *  for license information.
 *
 *  Ported to Canopy from VS Code OSS src/vs/base/browser/dom.ts (commit
 *  c4632cac, 2026-06-30): the `registerWindow` / `getWindow` /
 *  `getActiveWindow` window-registry cluster plus the window-scoped
 *  scheduling helpers. Contract-level port, not a line-for-line copy —
 *  Canopy keys the registry by `Window` identity instead of branding windows
 *  with a `vscodeWindowId`, and only the scheduling surface the panel
 *  components actually need is included.
 *--------------------------------------------------------------------------------------------*/

/**
 * The shared multi-window registry for the panels system (Phase 7 of the VS
 * Code-style panel work, doc 05 §5).
 *
 * The load-bearing multi-window rule: every piece of code that touches the
 * DOM must use the OWNING window/document of the element it is working with,
 * never the global `window`/`document`. This module is how panel code
 * answers "which window owns this node?" once auxiliary (pulled-out) windows
 * exist:
 *
 * - The main window is auto-registered at module load (guarded so the module
 *   stays importable from SSR/Node contexts — ui-shared is web-consumed).
 * - Phase 8 registers each `about:blank` child window via
 *   {@link registerWindow} after opening it, and disposes the registration
 *   on close/merge-back.
 * - All panel listeners, measurement, and scheduling resolve their realm
 *   through {@link getWindow}/{@link getDocument} relative to a node.
 *
 * Pure DOM + local emitter/disposable shims: no React, no Electron, no Node
 * APIs, zero runtime dependencies.
 */

import { Disposable, type IDisposable, toDisposable } from './disposable';
import { Emitter, type Event } from './emitter';

/**
 * A window handle with the full global surface (`ResizeObserver`,
 * `requestAnimationFrame`, ...). Matches the type of `document.defaultView`
 * and the global `window`; a cross-realm child window resolves to the same
 * shape through its own `window` self-reference.
 */
export type PanelWindow = Window & typeof globalThis;

/**
 * Anything {@link getWindow} can resolve a window from: a DOM node (via
 * `ownerDocument.defaultView`), a UI event (via `view`), or nothing (falls
 * back to the main window).
 */
export type WindowTarget = Node | UIEvent | null | undefined;

const mainWindowRef: PanelWindow | undefined =
  // SSR guard: ui-shared is imported by the Next.js web app; module load must
  // not assume a DOM environment.
  typeof window !== 'undefined' ? window : undefined;

/** Registered windows in registration order; the main window is first. */
const registeredWindows = new Set<PanelWindow>();

if (mainWindowRef) {
  registeredWindows.add(mainWindowRef);
}

const didRegisterEmitter = new Emitter<PanelWindow>();
const didUnregisterEmitter = new Emitter<PanelWindow>();

/** Fires with each window added through {@link registerWindow}. */
export const onDidRegisterWindow: Event<PanelWindow> = didRegisterEmitter.event;

/** Fires with each window removed by disposing its registration. */
export const onDidUnregisterWindow: Event<PanelWindow> =
  didUnregisterEmitter.event;

function requireMainWindow(): PanelWindow {
  if (!mainWindowRef) {
    throw new Error(
      'Panel window registry used outside a DOM environment (no main window)',
    );
  }

  return mainWindowRef;
}

/**
 * Registers an auxiliary window so {@link getWindows} /
 * {@link getActiveWindow} see it. Returns the disposable that unregisters it
 * (dispose on window close/merge-back). Registering an already-registered
 * window (including the auto-registered main window) is a no-op.
 *
 * PHASE8: lifecycle is caller-owned — this module intentionally attaches no
 * `beforeunload`/`unload` listeners. The aux-window service must dispose the
 * registration when the child window closes.
 */
export function registerWindow(targetWindow: Window): IDisposable {
  // Normalize through the window's self-reference so cross-realm handles
  // (e.g. the `WindowProxy` returned by `window.open`) register with the
  // full global surface type.
  const win = targetWindow.window;

  if (registeredWindows.has(win)) {
    return Disposable.None;
  }

  registeredWindows.add(win);
  didRegisterEmitter.fire(win);

  return toDisposable(() => {
    if (registeredWindows.delete(win)) {
      didUnregisterEmitter.fire(win);
    }
  });
}

function isNode(target: Node | UIEvent): target is Node {
  return 'nodeType' in target;
}

function isDocumentNode(node: Node): node is Document {
  return node.nodeType === 9; /* Node.DOCUMENT_NODE */
}

/**
 * Resolves the window that owns `target`: a node's
 * `ownerDocument.defaultView` (or a document's own `defaultView`), a UI
 * event's `view`, falling back to the main window. This is the multi-window
 * primitive every DOM-touching panel helper routes through (doc 05 §1.4).
 */
export function getWindow(target: WindowTarget): PanelWindow {
  if (target) {
    if (isNode(target)) {
      if (isDocumentNode(target)) {
        return target.defaultView ?? requireMainWindow();
      }

      const view = target.ownerDocument?.defaultView;

      if (view) {
        return view;
      }
    } else if (target.view) {
      return target.view.window;
    }
  }

  return requireMainWindow();
}

/** Resolves the document that owns `target` (see {@link getWindow}). */
export function getDocument(target: WindowTarget): Document {
  if (target && isNode(target) && isDocumentNode(target)) {
    return target;
  }

  return getWindow(target).document;
}

/**
 * Returns the focused window across all registered windows
 * (`document.hasFocus()`-based, like the upstream `getActiveWindow`),
 * falling back to the main window when none has focus.
 */
export function getActiveWindow(): PanelWindow {
  const main = requireMainWindow();

  if (registeredWindows.size > 1) {
    for (const win of registeredWindows) {
      try {
        if (win.document.hasFocus()) {
          return win;
        }
      } catch {
        // A closed/navigated-away child window can throw on access; skip it.
      }
    }
  }

  return main;
}

/** Snapshot of all registered windows, main window first. */
export function getWindows(): readonly PanelWindow[] {
  return Array.from(registeredWindows);
}

/** {@link getWindow} plus direct `Window` targets, for scheduling helpers. */
export type SchedulingTarget = WindowTarget | Window;

function isWindowLike(target: SchedulingTarget): target is Window {
  return (
    typeof target === 'object' &&
    target !== null &&
    'self' in target &&
    'setTimeout' in target &&
    'document' in target
  );
}

function resolveWindow(target: SchedulingTarget): PanelWindow {
  if (target && isWindowLike(target)) {
    return target.window;
  }

  return getWindow(target);
}

/**
 * Schedules `callback` at the next animation frame of the window owning
 * `target` — never the global `requestAnimationFrame`, which only paints
 * with the main window (doc 05 §7.7). Disposing cancels a not-yet-run frame.
 *
 * Environments without `requestAnimationFrame` (minimal test setups) run the
 * callback synchronously, matching the panel components' historical
 * fallback.
 */
export function scheduleWindowAnimationFrame(
  target: SchedulingTarget,
  callback: () => void,
): IDisposable {
  const win = resolveWindow(target);

  if (typeof win.requestAnimationFrame !== 'function') {
    callback();
    return Disposable.None;
  }

  let ran = false;
  const handle = win.requestAnimationFrame(() => {
    ran = true;
    callback();
  });

  return toDisposable(() => {
    if (!ran) {
      win.cancelAnimationFrame(handle);
    }
  });
}

/**
 * Schedules `callback` on the timer queue of the window owning `target`
 * (multi-window-aware `setTimeout`, doc 05 §5): timers tied to an auxiliary
 * window's realm are not throttled with the main window's background state.
 * Disposing clears a not-yet-fired timeout.
 */
export function scheduleWindowTimeout(
  target: SchedulingTarget,
  callback: () => void,
  delayMs: number,
): IDisposable {
  const win = resolveWindow(target);
  let ran = false;
  const handle = win.setTimeout(() => {
    ran = true;
    callback();
  }, delayMs);

  return toDisposable(() => {
    if (!ran) {
      win.clearTimeout(handle);
    }
  });
}
