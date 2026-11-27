import type { BillingReadinessSourceId } from '@canopy/app-state/provider-choice';
import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import { subscribeDesktopBillingGateTransitions } from '@/stores/billingReadinessRuntime';

/**
 * Billing setup gate funnel (2026-11-25), the same event names as the web:
 * `billing:setup_gate_view` once per gate episode per surface,
 * `billing:setup_gate_click` for each way out the user picks, and
 * `billing:setup_gate_end` once when a source becomes ready and the gate
 * clears. An episode runs from the latch showing the gate to it hiding;
 * hidden page hosts keep chats mounted, so a remount is not a new view. A
 * scope reset (account switch) hides the gate without an end. Context is the
 * fixed surface, action and source strings only, never an account fact.
 *
 * Known undercount: a user who fixes billing outside the app and relaunches
 * never fires an end, so the funnel also reads the first-send event.
 */

const VIEW_OPERATION = 'canopy.billing_setup_gate';
const CLICK_OPERATION = 'canopy.billing_setup_gate_action';
const END_OPERATION = 'canopy.billing_setup_gate_end';

/** Where the gate was shown. `web_new_task` is the web's. */
export type BillingSetupGateSurface = 'home' | 'chat' | 'first_run';

/** The way out the user picked. */
export type BillingSetupGateAction =
  | 'connect'
  | 'buy'
  | 'set_up'
  | 'settings_open';

const viewedThisEpisode = new Set<BillingSetupGateSurface>();
let lastViewedSurface: BillingSetupGateSurface | null = null;
/** Gates mounted right now, by surface (a surface can mount more than once). */
const mountedSurfaces = new Map<BillingSetupGateSurface, number>();
let unsubscribe: (() => void) | null = null;

function emit(
  name: typeof VIEW_OPERATION | typeof CLICK_OPERATION | typeof END_OPERATION,
  context: Record<string, string>,
): void {
  startClientOperation(name, { context });
  succeedClientOperation(name, { context });
}

function resetEpisode(): void {
  viewedThisEpisode.clear();
  lastViewedSurface = null;
}

function ensureSubscribed(): void {
  if (unsubscribe !== null) return;
  unsubscribe = subscribeDesktopBillingGateTransitions(
    (transition, readiness) => {
      if (transition === 'ended') {
        const source = readiness.readyIds[0];
        if (lastViewedSurface !== null && source !== undefined) {
          emit(END_OPERATION, {
            gate_surface: lastViewedSurface,
            gate_source: source,
          });
        }
        resetEpisode();
      } else if (transition === 'scope-reset' || transition === 'shown') {
        resetEpisode();
        // A scope change that stays at `none` starts a new episode while the
        // gates stay mounted (they never remount), so record their views
        // here; otherwise this episode would have no view and drop its end.
        // On a hidden-to-shown change a gate usually mounts after this and
        // records its own view; one already mounted records here, and the
        // per-episode dedupe keeps either order to a single view.
        if (transition === 'shown') {
          for (const surface of mountedSurfaces.keys()) recordView(surface);
        }
      }
    },
  );
}

/**
 * Record that the gate was shown on `surface`. Call when the gate is shown
 * (latched), not on every mount: a surface counts once per episode.
 */
export function trackBillingSetupGateView(
  surface: BillingSetupGateSurface,
): () => void {
  ensureSubscribed();
  mountedSurfaces.set(surface, (mountedSurfaces.get(surface) ?? 0) + 1);
  recordView(surface);
  return (): void => {
    const count = (mountedSurfaces.get(surface) ?? 1) - 1;
    if (count > 0) mountedSurfaces.set(surface, count);
    else mountedSurfaces.delete(surface);
  };
}

function recordView(surface: BillingSetupGateSurface): void {
  lastViewedSurface = surface;
  if (viewedThisEpisode.has(surface)) return;
  viewedThisEpisode.add(surface);
  emit(VIEW_OPERATION, { gate_surface: surface });
}

/** Record the way out the user clicked. */
export function trackBillingSetupGateClick(options: {
  surface: BillingSetupGateSurface;
  action: BillingSetupGateAction;
  source?: BillingReadinessSourceId;
}): void {
  emit(CLICK_OPERATION, {
    gate_surface: options.surface,
    gate_action: options.action,
    ...(options.source !== undefined ? { gate_source: options.source } : {}),
  });
}

/** Test seam. */
export function resetBillingSetupGateTelemetryForTests(): void {
  resetEpisode();
  mountedSurfaces.clear();
  unsubscribe?.();
  unsubscribe = null;
}
