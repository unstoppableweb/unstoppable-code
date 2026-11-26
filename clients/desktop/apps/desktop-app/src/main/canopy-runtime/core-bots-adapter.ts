import { createHash } from 'node:crypto';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { stableStringify } from '@canopy/protocol/plans';
import type {
  CanopyInstructionHandlerMap,
  CanopyQueryHandlerMap,
  BotCreateParams,
  BotDeleteParams,
  BotGetParams,
  BotListResult,
  BotRecord,
  BotResult,
  BotSetPinsParams,
  BotUpdateParams,
} from '@canopy/protocol/canopy-core';
import {
  BotRegistryError,
  getBotRegistryStore,
  type BotCreateInput,
  type BotRegistryReceipt,
  type BotRegistryFailure,
  type BotRegistryStore,
  type BotUpdatePatch,
} from '../bots/registry-store';
import {
  projectVisible,
  readVisibleBot,
  readVisibleBots,
} from '../bots/visibility';

export type CoreBotsQueryHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  'core.bots.list' | 'core.bots.get'
>;

export type CoreBotsInstructionHandlers = Pick<
  CanopyInstructionHandlerMap<CanopyHandlerContext>,
  | 'core.bots.create'
  | 'core.bots.update'
  | 'core.bots.pins.set'
  | 'core.bots.delete'
>;

export interface CoreBotsHost {
  store: Pick<BotRegistryStore, 'create' | 'update' | 'setPins' | 'delete'>;
  visibility: {
    readVisibleBots(): Promise<BotRecord[]>;
    readVisibleBot(botId: string): Promise<BotRecord>;
    projectVisible(record: BotRecord): Promise<BotRecord>;
  };
}

export interface CoreBotsAdapter {
  queries: CoreBotsQueryHandlers;
  instructions: CoreBotsInstructionHandlers;
}

interface BotOperationErrorMapping {
  readonly kind:
    | 'not_found'
    | 'conflict'
    | 'already_exists'
    | 'invalid_argument'
    | 'failed_precondition'
    | 'capability_unavailable'
    | 'unavailable';
  readonly code?:
    | 'core.bots.notFound'
    | 'core.bots.revisionConflict'
    | 'core.bots.nameConflict'
    | 'core.bots.invalidInput'
    | 'core.bots.unknownProject'
    | 'core.bots.defaultBotProtected'
    | 'core.bots.unavailable'
    | 'core.bots.storageFailed';
  readonly message: string;
  readonly retry: { readonly kind: 'never' };
}

const BOT_OPERATION_ERRORS: Record<
  BotRegistryFailure,
  BotOperationErrorMapping
> = {
  unknown_bot: {
    kind: 'not_found',
    code: 'core.bots.notFound',
    message: 'This Bot is not available.',
    retry: { kind: 'never' },
  },
  revision_conflict: {
    kind: 'conflict',
    code: 'core.bots.revisionConflict',
    message: 'This Bot changed before your request completed.',
    retry: { kind: 'never' },
  },
  name_conflict: {
    kind: 'already_exists',
    code: 'core.bots.nameConflict',
    message: 'A Bot with that name already exists.',
    retry: { kind: 'never' },
  },
  invalid_input: {
    kind: 'invalid_argument',
    code: 'core.bots.invalidInput',
    message: 'Check the Bot details and try again.',
    retry: { kind: 'never' },
  },
  unknown_project: {
    kind: 'not_found',
    code: 'core.bots.unknownProject',
    message: 'The selected project is not available.',
    retry: { kind: 'never' },
  },
  default_bot_protected: {
    kind: 'failed_precondition',
    code: 'core.bots.defaultBotProtected',
    message: 'This change is not available for the default Bot.',
    retry: { kind: 'never' },
  },
  experiment_off: {
    kind: 'capability_unavailable',
    code: 'core.bots.unavailable',
    message: 'Bots are unavailable while the experiment is off.',
    retry: { kind: 'never' },
  },
  storage_failed: {
    kind: 'unavailable',
    code: 'core.bots.storageFailed',
    message: 'The Bots registry could not be read or updated.',
    retry: { kind: 'never' },
  },
  key_reused: {
    kind: 'conflict',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  },
};

const desktopBotsHost = (): CoreBotsHost => ({
  store: getBotRegistryStore(),
  visibility: { readVisibleBots, readVisibleBot, projectVisible },
});

function botErrorReason(error: unknown): BotRegistryFailure {
  if (
    error instanceof BotRegistryError &&
    Object.prototype.hasOwnProperty.call(BOT_OPERATION_ERRORS, error.reason)
  ) {
    return error.reason;
  }
  return 'storage_failed';
}

function toBotOperationError(error: unknown): CanopyOperationError {
  if (error instanceof CanopyOperationError) return error;
  const reason = botErrorReason(error);
  if (reason === 'key_reused') {
    return new CanopyOperationError({
      kind: 'conflict',
      message: 'This idempotency key was used with other parameters.',
      retry: { kind: 'never' },
    });
  }
  const mapping = BOT_OPERATION_ERRORS[reason];
  // A write the store may have installed is resolved by replaying its key.
  const outcomeUnknown =
    error instanceof BotRegistryError && error.outcomeUnknown;
  return new CanopyOperationError({
    kind: mapping.kind,
    ...(mapping.code === undefined ? {} : { code: mapping.code }),
    message: mapping.message,
    details: { reason },
    retry: outcomeUnknown ? { kind: 'same_idempotency_key' } : mapping.retry,
  });
}

async function withBotErrors<Value>(
  operation: () => Promise<Value>,
): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    throw toBotOperationError(error);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function replayed(params: { readonly _meta: unknown }): unknown {
  const { _meta: metadata, ...rest } = params;
  void metadata;
  return rest;
}

function botReceipt(
  context: CanopyHandlerContext,
  params: { readonly _meta: unknown },
): BotRegistryReceipt | undefined {
  const idempotencyKey = context.metadata.idempotencyKey;
  if (idempotencyKey === undefined) return undefined;
  return {
    scope: hash(`${context.caller.principalId}\0${idempotencyKey}`),
    fingerprint: hash(stableStringify(replayed(params)) ?? 'null'),
  };
}

/** Desktop's in-process owner for the local Bot registry. */
export function createCoreBotsAdapter(host?: CoreBotsHost): CoreBotsAdapter {
  // Resolved on first use: building the runtime must not open the registry
  // or read its path (tests and early startup compose the runtime first).
  let resolvedHost = host;
  const currentHost = (): CoreBotsHost => (resolvedHost ??= desktopBotsHost());
  return {
    queries: {
      'core.bots.list': async (): Promise<BotListResult> =>
        withBotErrors(async () => ({
          bots: await currentHost().visibility.readVisibleBots(),
        })),
      'core.bots.get': async (params: BotGetParams): Promise<BotResult> =>
        withBotErrors(async () => ({
          bot: await currentHost().visibility.readVisibleBot(params.botId),
        })),
    },
    instructions: {
      'core.bots.create': (
        params: BotCreateParams,
        context: CanopyHandlerContext,
      ): Promise<BotResult> =>
        withBotErrors(async () => {
          const input: BotCreateInput = { name: params.name };
          if (params.description !== undefined)
            input.description = params.description;
          if (params.glyph !== undefined) input.glyph = params.glyph;
          if (params.pins !== undefined) input.pins = params.pins;
          if (params.showInSidebar !== undefined)
            input.showInSidebar = params.showInSidebar;
          if (params.pinnedToTop !== undefined)
            input.pinnedToTop = params.pinnedToTop;
          const { store, visibility } = currentHost();
          const record = await store.create(input, botReceipt(context, params));
          return { bot: await visibility.projectVisible(record) };
        }),
      'core.bots.update': (
        params: BotUpdateParams,
        context: CanopyHandlerContext,
      ): Promise<BotResult> =>
        withBotErrors(async () => {
          const patch: BotUpdatePatch = params.patch;
          const { store, visibility } = currentHost();
          const record = await store.update(
            params.botId,
            params.expectedRevision,
            patch,
            botReceipt(context, params),
          );
          return { bot: await visibility.projectVisible(record) };
        }),
      'core.bots.pins.set': (
        params: BotSetPinsParams,
        context: CanopyHandlerContext,
      ): Promise<BotResult> =>
        withBotErrors(async () => {
          const { store, visibility } = currentHost();
          const record = await store.setPins(
            params.botId,
            params.expectedRevision,
            params.projectIds,
            botReceipt(context, params),
          );
          return { bot: await visibility.projectVisible(record) };
        }),
      'core.bots.delete': (
        params: BotDeleteParams,
        context: CanopyHandlerContext,
      ): Promise<BotResult> =>
        withBotErrors(async () => ({
          bot: await currentHost().store.delete(
            params.botId,
            params.expectedRevision,
            botReceipt(context, params),
          ),
        })),
    },
  };
}
