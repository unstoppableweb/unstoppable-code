import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  DICTATION_GRANTS,
  type CanopyCallerDescriptor,
  type DictationModelStatus,
} from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { readPreferencesFile } from '../lib/preferences-store';
import { allowsAutomaticCall } from '../local-only/policy';
import { registerIpcHandler } from './register';
import type { DesktopIpcCallerResolver } from './file-tree';

type DictationDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

/** Electron main's own caller for the launch check. */
const LAUNCH_CALLER: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'electron-main-speech-model-launch',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [],
};

/** How long after launch to check whether a newer model should download. */
const LAUNCH_PREFETCH_DELAY_MS = 30_000;

function dictationCaller(
  caller: CanopyCallerDescriptor,
): CanopyCallerDescriptor {
  return {
    ...caller,
    grants: [DICTATION_GRANTS.read, DICTATION_GRANTS.write],
  };
}

/**
 * The `voice:speech-model-*` channels project `core.dictation.model.*` on
 * the desktop dispatcher (CAN-7231). A refusal that the status explains, such
 * as a build with no download location, answers with that status so
 * Settings shows it; anything else rejects with the operation's message.
 */
export function createSpeechModelActions(
  dispatcher: DictationDispatcher,
  callerDescriptor: CanopyCallerDescriptor,
): {
  status(): Promise<DictationModelStatus>;
  install(trigger: 'user' | 'launch'): Promise<DictationModelStatus>;
  cancel(): Promise<DictationModelStatus>;
  remove(): Promise<DictationModelStatus>;
} {
  const caller = dictationCaller(callerDescriptor);
  const status = (): Promise<DictationModelStatus> =>
    dispatcher.query('core.dictation.model.status.get', {}, { caller });
  const explainedByStatus = async (
    action: () => Promise<DictationModelStatus>,
  ): Promise<DictationModelStatus> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CanopyOperationError) {
        const code = error.payload.code;
        if (
          code === 'core.dictation.sourceUnavailable' ||
          code === 'core.dictation.unsupported'
        ) {
          return status();
        }
        throw new Error(error.payload.message);
      }
      throw error;
    }
  };
  return {
    status,
    install: (trigger) =>
      explainedByStatus(() =>
        dispatcher.instruction(
          'core.dictation.model.install',
          { trigger },
          { caller },
        ),
      ),
    cancel: () =>
      explainedByStatus(() =>
        dispatcher.instruction(
          'core.dictation.model.install.cancel',
          {},
          { caller },
        ),
      ),
    remove: () =>
      explainedByStatus(() =>
        dispatcher.instruction('core.dictation.model.remove', {}, { caller }),
      ),
  };
}

export function registerSpeechModelHandlers(
  dispatcher: DictationDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler(IPC_CHANNELS.voiceSpeechModelStatus, (event) =>
    createSpeechModelActions(dispatcher, resolveCaller(event)).status(),
  );
  registerIpcHandler(IPC_CHANNELS.voiceSpeechModelInstall, (event) =>
    createSpeechModelActions(dispatcher, resolveCaller(event)).install('user'),
  );
  registerIpcHandler(IPC_CHANNELS.voiceSpeechModelCancel, (event) =>
    createSpeechModelActions(dispatcher, resolveCaller(event)).cancel(),
  );
  registerIpcHandler(IPC_CHANNELS.voiceSpeechModelRemove, (event) =>
    createSpeechModelActions(dispatcher, resolveCaller(event)).remove(),
  );
}

/**
 * When dictation is on, asks core at launch whether a newer model should
 * download in the background. Core only starts one to replace an older
 * installed model; a first install waits for someone to ask. Linux only:
 * other hosts have no model to manage.
 */
export function scheduleSpeechModelLaunchPrefetch(
  dispatcher: DictationDispatcher,
): void {
  if (hostPlatformOperatingSystem() !== 'linux') return;
  // A local-only build never downloads on its own; Settings still can.
  if (!allowsAutomaticCall('dictation.speech-model-update')) return;
  const timer = setTimeout(() => {
    void (async (): Promise<void> => {
      const preferences = await readPreferencesFile();
      if (!preferences.voiceDictationEnabled) return;
      await createSpeechModelActions(dispatcher, LAUNCH_CALLER).install(
        'launch',
      );
    })().catch(() => {
      // Best effort: Settings reports the model's state and offers a retry.
    });
  }, LAUNCH_PREFETCH_DELAY_MS);
  timer.unref();
}
