import { createCoreCoworkStore } from '@canopy/app-state/core-cowork';

/** The one cloud cowork store for this renderer; every sidebar mount shares it. */
export const cloudCoworkStore = createCoreCoworkStore();
