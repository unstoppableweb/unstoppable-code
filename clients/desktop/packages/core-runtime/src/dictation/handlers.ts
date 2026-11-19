import type {
  CanopyInstructionHandlerMap,
  CanopyQueryHandlerMap,
  DictationModel,
  DictationModelFailure,
  DictationModelStatus,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../runtime/errors';
import type { CanopyHandlerContext } from '../runtime/types';
import { DEFAULT_SPEECH_MODEL } from './manifest';
import {
  SpeechModelInstallError,
  type CoreDictationHost,
  type SpeechModelInstallProgress,
  type SpeechModelManifestEntry,
} from './ports';

type DictationQueryHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  'core.dictation.model.status.get'
>;
type DictationInstructionHandlers = Pick<
  CanopyInstructionHandlerMap<CanopyHandlerContext>,
  | 'core.dictation.model.install'
  | 'core.dictation.model.install.cancel'
  | 'core.dictation.model.remove'
>;

export interface CoreDictationHandlers {
  queries: DictationQueryHandlers;
  instructions: DictationInstructionHandlers;
  /** Settles when no install is running. For shutdown and tests. */
  idle(): Promise<void>;
}

export interface CoreDictationHandlerOptions {
  /** The model this version installs; defaults to the manifest's. */
  readonly model?: SpeechModelManifestEntry;
}

const REMOTE_PRINCIPAL_PREFIX = 'remote-device:';
const MESSAGE_LIMIT = 1_024;

/** What an install in progress reports. */
type Job = {
  readonly controller: AbortController;
  done: Promise<void>;
  progress: SpeechModelInstallProgress;
};

function publicModel(entry: SpeechModelManifestEntry): DictationModel {
  return {
    id: entry.id,
    displayName: entry.displayName,
    architecture: entry.architecture,
    language: entry.language,
    sizeBytes: entry.sizeBytes,
    license: entry.license,
  };
}

function failureOf(error: unknown): DictationModelFailure {
  if (error instanceof SpeechModelInstallError) {
    return { code: error.code, message: trimMessage(error.message) };
  }
  const message = error instanceof Error ? error.message : '';
  return { code: 'storage', message: trimMessage(message) };
}

function trimMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, MESSAGE_LIMIT)
    : 'Installing the speech model failed.';
}

function unsupported(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    code: 'core.dictation.unsupported',
    message: 'This computer has no speech model to manage.',
    retry: { kind: 'never' },
  });
}

/**
 * `core.dictation.*` for one host (CAN-7231). Core owns which model this
 * version uses, when to download it, and which copies to remove: an older
 * model is removed only after its replacement verified. The host owns the
 * files.
 */
export function createCoreDictationHandlers(
  host: CoreDictationHost,
  options: CoreDictationHandlerOptions = {},
): CoreDictationHandlers {
  const model = options.model ?? DEFAULT_SPEECH_MODEL;
  let job: Job | null = null;
  let failure: DictationModelFailure | null = null;
  let revision = 0;

  const bump = (): void => {
    revision += 1;
  };

  // Install, cancel and remove run one at a time, so two callers (the launch
  // check and a click, or two windows) can't both start a download, and a
  // removal can't race an install that is still deciding.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  async function status(): Promise<DictationModelStatus> {
    if (!host.supported()) {
      return {
        state: 'unsupported',
        model: null,
        progress: null,
        failure: null,
        sourceConfigured: false,
        extraFilesStored: false,
        revision,
      };
    }
    const installed = await host.isInstalled(model);
    const stored = await host.storedModelIds();
    const base = {
      model: publicModel(model),
      sourceConfigured: host.sourceConfigured(),
      extraFilesStored: stored.some((id) => id !== model.id || !installed),
      revision,
    };
    if (job) {
      return {
        ...base,
        state: job.progress.phase,
        progress: {
          receivedBytes: job.progress.receivedBytes,
          totalBytes: job.progress.totalBytes,
        },
        failure: null,
      };
    }
    if (installed) {
      return { ...base, state: 'installed', progress: null, failure: null };
    }
    if (failure) {
      return { ...base, state: 'failed', progress: null, failure };
    }
    return { ...base, state: 'notInstalled', progress: null, failure: null };
  }

  /** Removes every model's files on disk except `keep`'s. */
  async function removeOthers(keep: string | null): Promise<void> {
    for (const id of await host.storedModelIds()) {
      if (id !== keep) await host.remove(id);
    }
  }

  /** Stops a running install and waits for it to settle. */
  async function stopJob(): Promise<void> {
    const running = job;
    if (!running) return;
    running.controller.abort();
    await running.done;
  }

  function start(): void {
    const current: Job = {
      controller: new AbortController(),
      progress: {
        phase: 'downloading',
        receivedBytes: 0,
        totalBytes: model.sizeBytes,
      },
      done: Promise.resolve(),
    };
    job = current;
    failure = null;
    bump();
    current.done = (async (): Promise<void> => {
      try {
        await host.install(model, {
          signal: current.controller.signal,
          onProgress: (progress) => {
            current.progress = progress;
            bump();
          },
        });
        // Only now that the new model verified does an older one go.
        await removeOthers(model.id);
      } catch (error) {
        if (!current.controller.signal.aborted) failure = failureOf(error);
      } finally {
        if (job === current) job = null;
        bump();
      }
    })();
  }

  function refuseRemote(context: CanopyHandlerContext): void {
    if (!context.caller.principalId.startsWith(REMOTE_PRINCIPAL_PREFIX)) {
      return;
    }
    // A download of hundreds of megabytes, or deleting the model, is for the
    // person at this computer to start.
    throw new CanopyOperationError({
      kind: 'permission_denied',
      message: 'Only someone at this computer can change its speech model.',
      retry: { kind: 'never' },
    });
  }

  return {
    queries: {
      'core.dictation.model.status.get': async () => status(),
    },
    instructions: {
      'core.dictation.model.install': (params, context) => {
        refuseRemote(context);
        if (!host.supported()) throw unsupported();
        return serial(async () => {
          if (job) return status();
          if (await host.isInstalled(model)) return status();
          if (params.trigger === 'launch') {
            // First use waits for someone to ask. A launch only replaces an
            // older model that is verified and installed (not a partial
            // download), so an app update that changed the model fetches the
            // new one before the person next dictates.
            const installed = await host.installedModelIds();
            if (!installed.some((id) => id !== model.id)) return status();
          }
          if (!host.sourceConfigured()) {
            failure = {
              code: 'sourceUnavailable',
              message:
                'This build has no download location for the speech model.',
            };
            bump();
            throw new CanopyOperationError({
              kind: 'failed_precondition',
              code: 'core.dictation.sourceUnavailable',
              message: failure.message,
              retry: { kind: 'never' },
            });
          }
          start();
          return status();
        });
      },
      'core.dictation.model.install.cancel': (_params, context) => {
        refuseRemote(context);
        if (!host.supported()) throw unsupported();
        // Stops the download only: its partial files stay for the next
        // install to resume, and an older model stays installed.
        return serial(async () => {
          await stopJob();
          return status();
        });
      },
      'core.dictation.model.remove': (_params, context) => {
        refuseRemote(context);
        if (!host.supported()) throw unsupported();
        return serial(async () => {
          await stopJob();
          await removeOthers(null);
          failure = null;
          bump();
          return status();
        });
      },
    },
    idle: async () => {
      await job?.done;
    },
  };
}
