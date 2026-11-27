import {
  ConfigDocumentGetResultSchema,
  ConfigDocumentLoadErrorSchema,
  applyPreferenceSaveRules,
  mergeUsageDataPatch,
  type ConfigDocumentGetResult,
  type ConfigDocumentLoadError,
  type ConfigDocumentOwnerUpdateParams,
  type ConfigDocumentRevision,
  type ConfigDocumentUpdateParams,
  type ConfigDocumentUpdateResult,
  type ConfigLegacyClientLocalGetResult,
} from '@canopy/protocol/canopy-core/core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  StorageWriteRefusedError,
  isStorageOutcomeUnknownError,
} from '../../storage';
import { StorageRowOwnerError } from '../../storage/owner-records';
import { KeyedOutcomes } from '../operations/keyed-outcomes';
import { isRecord } from '../w5/commit-log/is-record';
import type { PreferencesLoadError } from './codec';
import {
  configDocumentRevision,
  type ConfigCommitEvents,
} from './commit-events';
import type {
  DaemonPreferences,
  DaemonStoredPreferences,
} from './daemon-document';
import { PreferencesRecoveryRequiredError } from './errors';
import { readLegacyClientLocal } from './legacy-client-local';

/*
 * The preferences document operations on the daemon's module (CAN-7956).
 * Not registered: the definitions stay outside the composed registries until
 * the CAN-5722 flip. The open write runs the shared save rules (K) on the
 * caller's raw patch, then the codec; the owner write runs only the codec.
 * Both check `expectedRevision` and merge `usageData` per key inside the
 * serialized commit. A write whose merge leaves the revision unchanged
 * writes nothing, so a keyed retry after a restart, which `KeyedOutcomes`
 * (in memory) cannot replay, either changes nothing or, when it names the
 * revision it read, answers `revisionConflict`.
 */

const DOCUMENT_RESOURCE = 'core.config.document';

type Context = CanopyHandlerContext;

export interface CoreConfigDocumentHandlers {
  readonly queries: {
    'core.config.document.get': (
      params: object,
      context: Context,
    ) => Promise<ConfigDocumentGetResult>;
    'core.config.legacyClientLocal.get': (
      params: object,
      context: Context,
    ) => Promise<ConfigLegacyClientLocalGetResult>;
  };
  readonly instructions: {
    'core.config.document.update': (
      params: ConfigDocumentUpdateParams,
      context: Context,
    ) => Promise<ConfigDocumentUpdateResult>;
    'core.config.document.ownerUpdate': (
      params: ConfigDocumentOwnerUpdateParams,
      context: Context,
    ) => Promise<ConfigDocumentGetResult>;
    'core.config.loadError.acknowledge': (
      params: { readonly timestamp: string },
      context: Context,
    ) => Promise<{
      acknowledged: boolean;
      loadError: ConfigDocumentLoadError | null;
    }>;
  };
}

export interface CoreConfigDocumentHandlersOptions {
  readonly preferences: DaemonPreferences;
  readonly events: ConfigCommitEvents;
  /** Keys an organization enforces; none by default. */
  readonly enforcedPaths?: () => readonly string[];
}

function projectLoadError(
  error: PreferencesLoadError | null,
): ConfigDocumentLoadError | null {
  if (error === null) return null;
  // Path-free: whether a copy was set aside or restored, never where.
  const required = {
    timestamp: error.timestamp,
    reason: error.reason,
    backedUp: error.backupPath !== undefined,
    restored: error.restoredFromPath !== undefined,
  };
  const actual = error.actualVersion;
  const full = ConfigDocumentLoadErrorSchema.safeParse({
    ...required,
    ...(error.code !== undefined && { code: error.code }),
    ...(error.expectedVersion !== undefined && {
      expectedVersion: error.expectedVersion,
    }),
    ...((actual === null ||
      ['string', 'number', 'boolean'].includes(typeof actual)) && {
      actualVersion: actual,
    }),
  });
  return full.success
    ? full.data
    : ConfigDocumentLoadErrorSchema.parse(required);
}

function refusal(
  kind: 'conflict' | 'invalid_argument' | 'failed_precondition' | 'unavailable',
  message: string,
  options: {
    code?:
      | 'core.config.invalidState'
      | 'core.config.revisionConflict'
      | 'core.config.protectedKey';
    retry?: 'never' | 'same_idempotency_key' | 'after_refresh';
  } = {},
): CanopyOperationError {
  const retry = options.retry ?? 'never';
  return new CanopyOperationError({
    kind,
    message,
    ...(options.code !== undefined && { code: options.code }),
    retry:
      retry === 'after_refresh'
        ? { kind: retry, resource: DOCUMENT_RESOURCE }
        : { kind: retry },
  });
}

const notKeptHere = (message: string, cause: Error): CanopyOperationError =>
  new CanopyOperationError(
    { kind: 'capability_unavailable', message, retry: { kind: 'never' } },
    cause,
  );

/** Typed answers for the repository's and the storage gate's failures. */
function operationError(error: unknown): unknown {
  if (error instanceof CanopyOperationError) return error;
  if (error instanceof PreferencesRecoveryRequiredError)
    return refusal(
      'failed_precondition',
      'Preferences could not be read, so nothing was saved.',
      { code: 'core.config.invalidState', retry: 'after_refresh' },
    );
  // The kind desktop's `core.config.update` gives a row owned elsewhere.
  if (error instanceof StorageRowOwnerError)
    return notKeptHere(error.message, error);
  if (error instanceof StorageWriteRefusedError)
    return notKeptHere('This core does not keep preferences.', error);
  if (isStorageOutcomeUnknownError(error))
    return refusal(
      'unavailable',
      'The preferences save may not have completed.',
      {
        retry: 'same_idempotency_key',
      },
    );
  return error;
}

/** A settled answer a keyed retry replays; anything else may run again. */
function isFinal(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    (error.payload.kind === 'conflict' ||
      error.payload.kind === 'invalid_argument')
  );
}

export function createCoreConfigDocumentHandlers(
  options: CoreConfigDocumentHandlersOptions,
): CoreConfigDocumentHandlers {
  const { repository, codec } = options.preferences;
  const { events } = options;
  const enforcedPaths = options.enforcedPaths ?? ((): string[] => []);
  const keyed = <T>(): KeyedOutcomes<T> =>
    new KeyedOutcomes<T>({
      reusedError: () =>
        refusal(
          'conflict',
          'This idempotency key was used with other parameters.',
        ),
      forget: (error) => !isFinal(error),
    });
  const updates = keyed<ConfigDocumentUpdateResult>();
  const ownerUpdates = keyed<ConfigDocumentGetResult>();

  const documentOf = (
    stored: DaemonStoredPreferences,
  ): ConfigDocumentGetResult => {
    const value: unknown = JSON.parse(JSON.stringify(codec.project(stored)));
    return ConfigDocumentGetResultSchema.parse({
      revision: configDocumentRevision(stored),
      value,
      enforcedPaths: [...enforcedPaths()],
      loadError: projectLoadError(repository.peekLoadError()),
    });
  };

  /** One serialized commit: the revision check, the usage-data merge, the codec. */
  const commit = async (
    patch: Record<string, unknown>,
    expectedRevision: ConfigDocumentRevision | undefined,
    context: Context,
  ): Promise<ConfigDocumentGetResult> => {
    let previous: DaemonStoredPreferences | undefined;
    try {
      const change = await repository.update(
        (latest) => {
          if (
            expectedRevision !== undefined &&
            configDocumentRevision(latest) !== expectedRevision
          )
            throw refusal(
              'conflict',
              'Preferences changed since they were read.',
              { code: 'core.config.revisionConflict', retry: 'after_refresh' },
            );
          const usageData = patch.usageData;
          const merged =
            isRecord(usageData) && isRecord(latest.usageData)
              ? {
                  ...patch,
                  usageData: mergeUsageDataPatch(latest.usageData, usageData),
                }
              : patch;
          let next: DaemonStoredPreferences;
          try {
            next = codec.merge(latest, merged, {
              loadError: repository.peekLoadError(),
              migrationTimestamp: () => repository.migrationTimestamp(),
            });
          } catch (refused) {
            // The codec refuses a save by throwing; its message says why.
            throw refusal(
              'invalid_argument',
              (refused instanceof Error ? refused.message : '').slice(
                0,
                1024,
              ) || 'These preferences could not be saved.',
            );
          }
          if (configDocumentRevision(next) === configDocumentRevision(latest))
            return null;
          previous = latest;
          return merged;
        },
        (committed) => {
          if (previous !== undefined)
            events.committed(
              { previous, next: committed },
              context.caller.clientInstanceId,
            );
        },
      );
      return documentOf(change.next);
    } catch (error) {
      throw operationError(error);
    }
  };

  return {
    queries: {
      'core.config.document.get': async () => {
        const document = documentOf(await repository.read('persisted'));
        // After the read, so a recovery it latched reads as unconfirmed. A
        // choice that can't be proven never fails the document read: the
        // field is left out, which the client reads as `unconfirmed`.
        const storedUsageData = await options.preferences
          .readStoredUsageData()
          .catch(() => undefined);
        return storedUsageData === undefined
          ? document
          : { ...document, storedUsageData };
      },
      'core.config.legacyClientLocal.get': () =>
        readLegacyClientLocal(repository),
    },
    instructions: {
      'core.config.document.update': (params, context) => {
        const { patch, expectedRevision } = params;
        return updates.run(context, { patch, expectedRevision }, async () => {
          const rules = applyPreferenceSaveRules(patch);
          if ('refused' in rules)
            throw refusal(
              'invalid_argument',
              `${rules.refused} has its own owner and can't be saved here.`,
              { code: 'core.config.protectedKey' },
            );
          const document = await commit(rules.patch, expectedRevision, context);
          return { ...document, dropped: [...rules.dropped] };
        });
      },
      'core.config.document.ownerUpdate': (params, context) => {
        const { patch, expectedRevision } = params;
        return ownerUpdates.run(context, { patch, expectedRevision }, () =>
          commit(patch, expectedRevision, context),
        );
      },
      'core.config.loadError.acknowledge': async ({ timestamp }) => {
        await repository.idle();
        const pending = repository.peekLoadError();
        const acknowledged =
          pending !== null &&
          Date.parse(pending.timestamp) === Date.parse(timestamp);
        if (acknowledged) repository.acknowledgeLoadError();
        return {
          acknowledged,
          loadError: projectLoadError(repository.peekLoadError()),
        };
      },
    },
  };
}
