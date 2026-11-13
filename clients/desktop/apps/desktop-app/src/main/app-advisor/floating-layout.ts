import {
  APP_ADVISOR_FLOATING_DEFAULT_SIZE,
  type AppAdvisorFloatingSize,
  type AppAdvisorWindowLayout,
  type AppAdvisorWindowOpenRequest,
} from '@canopy/desktop-shared/types';
import type { AppAdvisorFloatingShowResult } from './advisor-host';

/**
 * Early access: App Advisor opens as a chat panel floating inside the main
 * Canopy window, in the bottom-right of its content area. Open full window
 * moves the same renderer into the full App Advisor window (nav, tabs,
 * panels) at its saved size. See `advisor-host.ts`.
 */

/** Gap between the panel and the window's content edges, in CSS px. */
export const APP_ADVISOR_FLOATING_MARGIN = 16;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The layout an open request leaves the window in. Without early access the
 * window is always the full one. An explicit request wins; otherwise a
 * visible window keeps its layout and a hidden one opens floating.
 */
export function resolveAppAdvisorWindowLayout({
  requested,
  current,
  visible,
  earlyAccess,
}: {
  readonly requested: AppAdvisorWindowLayout | undefined;
  readonly current: AppAdvisorWindowLayout;
  readonly visible: boolean;
  readonly earlyAccess: boolean;
}): AppAdvisorWindowLayout {
  if (!earlyAccess) return 'full';
  if (requested) return requested;
  return visible ? current : 'floating';
}

/**
 * The layout an open request asks for. The archive views (an archived
 * container, an archived chat, the archived overview) render in the full
 * window and the docked page, not the floating panel, so a request for one
 * asks for the full window unless the docked page shows; the request's
 * background and focus options still decide how it shows. `archivedChat`:
 * the request's `chatId` names an archived chat (known once main resolves
 * it). `docked`: the docked page shows now.
 */
export function appAdvisorRequestedLayout(
  request: AppAdvisorWindowOpenRequest | undefined,
  {
    archivedChat = false,
    docked = false,
  }: { readonly archivedChat?: boolean; readonly docked?: boolean } = {},
): AppAdvisorWindowLayout | undefined {
  if (archivedChat || request?.archivedContainer || request?.archivedOverview)
    return request?.layout === 'docked' || (docked && !request?.layout)
      ? 'docked'
      : 'full';
  return request?.layout;
}

/**
 * Whether to remake the hidden App Advisor window before an open, so the
 * early access switch applies to it: early access makes it as a view-hosted
 * renderer (`hostsView`), and turning the switch either way after it was
 * made leaves it in the other mode. Only a window that is hidden and running
 * no App Advisor turn is remade, since its renderer answers a running turn's
 * questions and actions; otherwise it keeps its mode until a later open.
 */
export function shouldRemakeAppAdvisorWindow({
  hostsView,
  earlyAccess,
  visible,
  turnsActive,
  unsentDraft,
}: {
  readonly hostsView: boolean;
  readonly earlyAccess: boolean;
  readonly visible: boolean;
  readonly turnsActive: boolean;
  /** A chat holds typed, unsent text, which a new page would not have. */
  readonly unsentDraft: boolean;
}): boolean {
  return hostsView !== earlyAccess && !visible && !turnsActive && !unsentDraft;
}

/**
 * The floating panel's bounds inside the main window's content area (both in
 * DIP): its interface-scaled size (`size`, CSS px at 100%), capped to the
 * content, in the content's bottom-right corner inset by the scaled margin.
 */
export function floatingAppAdvisorBounds(
  content: { readonly width: number; readonly height: number },
  zoom: number,
  size: AppAdvisorFloatingSize = APP_ADVISOR_FLOATING_DEFAULT_SIZE,
): Rect {
  const margin = Math.round(APP_ADVISOR_FLOATING_MARGIN * zoom);
  const width = Math.max(
    0,
    Math.min(Math.round(size.width * zoom), content.width - 2 * margin),
  );
  const height = Math.max(
    0,
    Math.min(Math.round(size.height * zoom), content.height - 2 * margin),
  );
  return {
    x: content.width - width - margin,
    y: content.height - height - margin,
    width,
    height,
  };
}

/**
 * Script for App Advisor's page that resolves `true` two animation frames
 * after the page renders `layout` at `size` (DIP; `zoom` is the page's zoom
 * factor), by when that frame is painted, or `false` after `waitMs`. The page
 * marks the floating layout with `data-app-advisor-floating` on its body.
 * Only a page that is visible runs animation frames.
 */
export function appAdvisorPaintProbe({
  layout,
  size,
  zoom,
  waitMs,
}: {
  readonly layout: AppAdvisorWindowLayout;
  readonly size: { readonly width: number; readonly height: number };
  readonly zoom: number;
  readonly waitMs: number;
}): string {
  const floating = String(layout === 'floating');
  return `new Promise((resolve) => {
  const matches = () =>
    document.body !== null &&
    document.body.hasAttribute('data-app-advisor-floating') === ${floating} &&
    Math.abs(window.innerWidth * ${String(zoom)} - ${String(size.width)}) <= 2 &&
    Math.abs(window.innerHeight * ${String(zoom)} - ${String(size.height)}) <= 2;
  const deadline = performance.now() + ${String(waitMs)};
  const check = () => {
    if (matches()) {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    } else if (performance.now() > deadline) {
      resolve(false);
    } else {
      requestAnimationFrame(check);
    }
  };
  check();
})`;
}

/**
 * Whether closing App Advisor leaves its bubble in the main window: only a
 * minimize of the floating panel does. Close, and anything from the full
 * window, hides it outright. `options` is untrusted renderer input; anything
 * but `{ minimize: true }` reads as a plain close.
 */
export function appAdvisorCloseLeavesBubble({
  options,
  floating,
}: {
  readonly options: unknown;
  readonly floating: boolean;
}): boolean {
  return (
    floating &&
    typeof options === 'object' &&
    options !== null &&
    'minimize' in options &&
    options.minimize === true
  );
}

/**
 * Where an open request leaves App Advisor after asking for the floating
 * panel. Superseded means a newer move (a close, another open) replaced it
 * while the panel painted: the open shows nothing, rather than falling back
 * to the full window, which is only for a missing main window.
 */
export function appAdvisorLayoutAfterFloatingShow(
  result: AppAdvisorFloatingShowResult,
): AppAdvisorWindowLayout | 'superseded' {
  if (result === 'shown') return 'floating';
  if (result === 'superseded') return 'superseded';
  return 'full';
}
