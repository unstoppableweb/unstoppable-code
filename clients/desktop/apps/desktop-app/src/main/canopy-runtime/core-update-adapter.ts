import {
  createCoreUpdateHandlers,
  type CoreUpdateHandlers,
  type CoreUpdateHost,
} from '@canopy/core-runtime/update';
import { remoteUpdatePolicy } from '../remote-control/remote-update-policy';

/*
 * Registers `core.update.*` over the desktop package installer Electron main
 * hosts. The updater loads on the first call, never when the runtime is
 * built, and one handler set serves every client so the event stream counts
 * one sequence.
 */

type UpdateHostResolver = () => Promise<CoreUpdateHost>;

async function loadDesktopUpdateHost(): Promise<CoreUpdateHost> {
  const { createDesktopCoreUpdateHost } =
    await import('../updater/core-update-host');
  return createDesktopCoreUpdateHost();
}

export function createCoreUpdateAdapter(
  resolveHost: UpdateHostResolver = loadDesktopUpdateHost,
): CoreUpdateHandlers {
  let handlers: Promise<CoreUpdateHandlers> | null = null;
  const resolve = (): Promise<CoreUpdateHandlers> => {
    handlers ??= resolveHost().then((host) =>
      createCoreUpdateHandlers(host, { remote: remoteUpdatePolicy }),
    );
    return handlers;
  };
  return {
    queries: {
      'core.update.status.get': async (params, context) =>
        (await resolve()).queries['core.update.status.get'](params, context),
    },
    instructions: {
      'core.update.check': async (params, context) =>
        (await resolve()).instructions['core.update.check'](params, context),
      'core.update.download': async (params, context) =>
        (await resolve()).instructions['core.update.download'](params, context),
      'core.update.apply': async (params, context) =>
        (await resolve()).instructions['core.update.apply'](params, context),
      'core.update.apply.cancel': async (params, context) =>
        (await resolve()).instructions['core.update.apply.cancel'](
          params,
          context,
        ),
    },
    streams: {
      'core.update.events': async (params, context, sink) =>
        (await resolve()).streams['core.update.events'](params, context, sink),
    },
  };
}
