import {
  createCoreDictationHandlers,
  type CoreDictationHandlers,
  type CoreDictationHost,
} from '@canopy/core-runtime/dictation';

/*
 * Registers `core.dictation.*` over the speech model store Electron main
 * hosts (CAN-7231). The store loads on the first call, never when the runtime
 * is built, and one handler set serves every caller so one download runs at
 * a time.
 */

type DictationHostResolver = () => Promise<CoreDictationHost>;

async function loadDesktopDictationHost(): Promise<CoreDictationHost> {
  const [{ createDesktopDictationHost }, { desktopSpeechModelHostOptions }] =
    await Promise.all([
      import('../voice/speech-model-host'),
      import('../voice/speech-model-source'),
    ]);
  return createDesktopDictationHost(desktopSpeechModelHostOptions());
}

export function createCoreDictationAdapter(
  resolveHost: DictationHostResolver = loadDesktopDictationHost,
): Pick<CoreDictationHandlers, 'queries' | 'instructions'> {
  let handlers: Promise<CoreDictationHandlers> | null = null;
  const resolve = (): Promise<CoreDictationHandlers> => {
    handlers ??= resolveHost().then(
      (host) => createCoreDictationHandlers(host),
      (error: unknown) => {
        // Let the next call try loading the store again.
        handlers = null;
        throw error;
      },
    );
    return handlers;
  };
  return {
    queries: {
      'core.dictation.model.status.get': async (params, context) =>
        (await resolve()).queries['core.dictation.model.status.get'](
          params,
          context,
        ),
    },
    instructions: {
      'core.dictation.model.install': async (params, context) =>
        (await resolve()).instructions['core.dictation.model.install'](
          params,
          context,
        ),
      'core.dictation.model.install.cancel': async (params, context) =>
        (await resolve()).instructions['core.dictation.model.install.cancel'](
          params,
          context,
        ),
      'core.dictation.model.remove': async (params, context) =>
        (await resolve()).instructions['core.dictation.model.remove'](
          params,
          context,
        ),
    },
  };
}
