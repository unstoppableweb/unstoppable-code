import { createCoreCoworkStore } from '@canopy/app-state/core-cowork';
import { createRelayCoreCoworkInvoker } from './relay-invoker';

/**
 * The one cloud cowork store for this renderer; every sidebar mount shares
 * it. A lost connection reconnects by itself through the relay (CAN-6442).
 */
export const cloudCoworkStore = createCoreCoworkStore({
  reconnect: () =>
    typeof window === 'undefined' || !window.canopyCore
      ? null
      : createRelayCoreCoworkInvoker(window.canopyCore),
});
