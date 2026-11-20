import {
  createCoreFeatureFlagHandlers,
  type CoreFeatureFlagHandlers,
  type CoreFeatureFlagHost,
} from '@canopy/core-runtime/feature-flag';
import { getFeatureFlagService } from '../feature-flags/service';

/*
 * Serves `core.featureFlag.*` (CAN-4181) over the FeatureFlagService Electron
 * main hosts, which stays the one evaluator. Handlers are built on the first
 * call, never when the runtime is built, and one set serves every client so
 * the events stream counts one revision sequence. Main-process gates keep
 * reading the service in process; only interfaces go through the dispatcher.
 */

function desktopFeatureFlagHost(): CoreFeatureFlagHost {
  const service = getFeatureFlagService();
  return {
    snapshot: () => service.getSnapshot(),
    subscribe: (listener) => service.onSnapshotChanged(() => listener()),
    contextGeneration: () => service.getContextGeneration(),
  };
}

export function createCoreFeatureFlagAdapter(
  resolveHost: () => CoreFeatureFlagHost = desktopFeatureFlagHost,
): CoreFeatureFlagHandlers {
  let handlers: CoreFeatureFlagHandlers | null = null;
  const resolve = (): CoreFeatureFlagHandlers =>
    (handlers ??= createCoreFeatureFlagHandlers(resolveHost()));
  return {
    queries: {
      'core.featureFlag.snapshot.get': (params, context) =>
        resolve().queries['core.featureFlag.snapshot.get'](params, context),
    },
    streams: {
      'core.featureFlag.events': (params, context, sink) =>
        resolve().streams['core.featureFlag.events'](params, context, sink),
    },
  };
}
