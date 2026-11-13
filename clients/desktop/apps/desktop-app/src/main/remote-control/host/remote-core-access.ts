import { CanopyOperationError } from '@canopy/core-runtime';
import {
  UPDATE_GRANTS,
  UPDATE_INSTRUCTION_DEFINITIONS,
  UPDATE_QUERY_DEFINITIONS,
  UPDATE_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import {
  REMOTE_CORE_OPERATIONS,
  type CoreCallResult,
} from '../remote-protocol';

type RemoteCoreDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction' | 'openStream'
>;

export type RemoteCoreSubscription =
  | { ok: true; close: () => void }
  | Extract<CoreCallResult, { ok: false }>;

/**
 * The core operations this computer serves to a paired computer over its
 * session, whatever protocol that computer speaks. Each call runs on the
 * desktop dispatcher as the controller's own `remote-device:<deviceId>`
 * principal, so `core.update` applies its limits for paired computers.
 */
export interface RemoteCoreAccess {
  readonly operations: Readonly<Record<string, number>>;
  call(
    controllerDeviceId: string,
    operation: string,
    version: number,
    params: unknown,
  ): Promise<CoreCallResult>;
  subscribe(
    controllerDeviceId: string,
    operation: string,
    version: number,
    params: unknown,
    onFrame: (frame: unknown) => void,
  ): Promise<RemoteCoreSubscription>;
}

function failure(
  kind: string,
  message: string,
  code?: string,
): Extract<CoreCallResult, { ok: false }> {
  return {
    ok: false,
    error: {
      kind,
      message,
      ...(code ? { code } : {}),
      retry: { kind: 'never' },
    },
  };
}

function asFailure(error: unknown): Extract<CoreCallResult, { ok: false }> {
  if (error instanceof CanopyOperationError) {
    const { kind, message, code, details, retry } = error.payload;
    return {
      ok: false,
      error: {
        kind,
        message,
        ...(code ? { code } : {}),
        ...(details === undefined ? {} : { details }),
        retry,
      },
    };
  }
  return failure('internal', 'The request could not be completed.');
}

function invalid(): Extract<CoreCallResult, { ok: false }> {
  return failure('invalid_argument', 'The request was not valid.');
}

/** Accepts only a listed operation at the version this computer serves. */
function served(operation: string, version: number): boolean {
  return Object.entries(REMOTE_CORE_OPERATIONS).some(
    ([name, servedVersion]) => name === operation && servedVersion === version,
  );
}

function remoteCaller(controllerDeviceId: string): CanopyCallerDescriptor {
  return {
    principalId: `remote-device:${controllerDeviceId}`,
    clientInstanceId: `remote-session:${controllerDeviceId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: [UPDATE_GRANTS.read, UPDATE_GRANTS.write],
  };
}

export function createRemoteCoreAccess(
  resolveDispatcher: () => RemoteCoreDispatcher,
): RemoteCoreAccess {
  const run = async (
    action: () => Promise<unknown>,
  ): Promise<CoreCallResult> => {
    try {
      return { ok: true, result: await action() };
    } catch (error) {
      return asFailure(error);
    }
  };

  return {
    operations: REMOTE_CORE_OPERATIONS,
    call: (controllerDeviceId, operation, version, params) => {
      if (!served(operation, version)) {
        return Promise.resolve(
          failure(
            'capability_unavailable',
            `This computer does not serve ${operation} version ${version}.`,
          ),
        );
      }
      const dispatcher = resolveDispatcher();
      const caller = remoteCaller(controllerDeviceId);
      switch (operation) {
        case 'core.update.status.get': {
          const parsed =
            UPDATE_QUERY_DEFINITIONS[operation].params.safeParse(params);
          if (!parsed.success) return Promise.resolve(invalid());
          return run(() =>
            dispatcher.query(operation, parsed.data, { caller }),
          );
        }
        case 'core.update.check': {
          const parsed =
            UPDATE_INSTRUCTION_DEFINITIONS[operation].params.safeParse(params);
          if (!parsed.success) return Promise.resolve(invalid());
          return run(() =>
            dispatcher.instruction(operation, parsed.data, {
              caller,
              // The deadline and trace context travel with the key.
              metadata: parsed.data._meta,
            }),
          );
        }
        case 'core.update.download': {
          const parsed =
            UPDATE_INSTRUCTION_DEFINITIONS[operation].params.safeParse(params);
          if (!parsed.success) return Promise.resolve(invalid());
          return run(() =>
            dispatcher.instruction(operation, parsed.data, {
              caller,
              // The deadline and trace context travel with the key.
              metadata: parsed.data._meta,
            }),
          );
        }
        case 'core.update.apply': {
          const parsed =
            UPDATE_INSTRUCTION_DEFINITIONS[operation].params.safeParse(params);
          if (!parsed.success) return Promise.resolve(invalid());
          return run(() =>
            dispatcher.instruction(operation, parsed.data, {
              caller,
              // The deadline and trace context travel with the key.
              metadata: parsed.data._meta,
            }),
          );
        }
        case 'core.update.apply.cancel': {
          const parsed =
            UPDATE_INSTRUCTION_DEFINITIONS[operation].params.safeParse(params);
          if (!parsed.success) return Promise.resolve(invalid());
          return run(() =>
            dispatcher.instruction(operation, parsed.data, { caller }),
          );
        }
        default:
          return Promise.resolve(
            failure(
              'invalid_argument',
              `${operation} is a stream; open it with core.subscribe.`,
            ),
          );
      }
    },
    subscribe: async (
      controllerDeviceId,
      operation,
      version,
      params,
      onFrame,
    ) => {
      if (!served(operation, version) || operation !== 'core.update.events') {
        return failure(
          'capability_unavailable',
          `This computer does not stream ${operation} version ${version}.`,
        );
      }
      const parsed =
        UPDATE_STREAM_DEFINITIONS[operation].params.safeParse(params);
      if (!parsed.success) return invalid();
      try {
        const handle = await resolveDispatcher().openStream(
          operation,
          parsed.data,
          { caller: remoteCaller(controllerDeviceId), onFrame },
        );
        return { ok: true, close: () => handle.close() };
      } catch (error) {
        return asFailure(error);
      }
    },
  };
}
