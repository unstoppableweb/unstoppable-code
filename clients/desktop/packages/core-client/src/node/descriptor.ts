import { CanopyClientError } from '../errors';
import type {
  CanopyDaemonProcessInspector,
  CanopyRuntimeDescriptor,
  CanopyRuntimeDescriptorSource,
} from './daemon-ports';
import { canopyLaunchDetails, canopyLaunchStep } from './daemon-refusal';
import { canopyConnectError } from './endpoint';

export type CanopyDescriptorState =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'stale';
      readonly reason: 'process_exited' | 'identity_mismatch';
    }
  | {
      readonly kind: 'incompatible' | 'live';
      readonly descriptor: CanopyRuntimeDescriptor;
    };

export interface CanopyDescriptorClassifyInput {
  readonly source: CanopyRuntimeDescriptorSource;
  readonly supervisor: CanopyDaemonProcessInspector;
  readonly protocolVersions: readonly number[];
  readonly signal: AbortSignal;
  readonly secureStorageLayout?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Padded values fail closed rather than being normalized. */
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;

/** Strict hand-written check; unknown additive fields are dropped, anything else is `null`. */
export function parseCanopyRuntimeDescriptor(
  value: unknown,
): CanopyRuntimeDescriptor | null {
  if (!isRecord(value) || !isRecord(value.endpoint)) return null;
  if (!isRecord(value.protocolRange)) return null;
  if (value.version !== 1) return null;
  const { pid, startIdentity, buildVersion, tokenRef } = value;
  const { kind, path } = value.endpoint;
  const { min, max } = value.protocolRange;
  if (kind !== 'socket' && kind !== 'pipe') return null;
  if (!isPositiveInteger(pid) || !isPositiveInteger(min)) return null;
  if (!isPositiveInteger(max) || min > max) return null;
  if (!isText(startIdentity) || !isText(path)) return null;
  if (!isText(buildVersion) || !isText(tokenRef)) return null;
  const fields = { pid, startIdentity, buildVersion, tokenRef };
  return {
    version: 1,
    ...fields,
    ...(isText(value.secureStorageLayout) && {
      secureStorageLayout: value.secureStorageLayout,
    }),
    endpoint: { kind, path },
    protocolRange: { min, max },
  };
}

const cancelled = (): CanopyClientError =>
  canopyConnectError('cancelled', 'Core discovery was cancelled.');

/**
 * Port failures keep a fixed kind and text: their messages may name paths or
 * tokens. Only the allowlisted launch facts, the step and the port's typed kind
 * cross as details. The step is this port's unless a private-path check refused.
 */
async function callPort<T>(
  signal: AbortSignal,
  operation: 'read_descriptor' | 'inspect_process',
  call: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw cancelled();
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([call(), aborted]);
  } catch (error) {
    if (
      !signal.aborted &&
      error instanceof CanopyClientError &&
      error.payload.kind === 'capability_unavailable'
    )
      throw canopyConnectError(
        'capability_unavailable',
        'Core process identity cannot be verified on this host.',
      );
    if (signal.aborted) throw cancelled();
    const inner = canopyLaunchDetails(error);
    throw canopyConnectError('unavailable', 'Core discovery failed.', {
      ...inner,
      operation: canopyLaunchStep(inner, operation),
      ...(error instanceof CanopyClientError
        ? { portKind: error.payload.kind }
        : {}),
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Checks the PID's start identity before protocol majors; never deletes, writes, or spawns. */
export async function classifyCanopyDescriptor(
  input: CanopyDescriptorClassifyInput,
): Promise<CanopyDescriptorState> {
  const { source, supervisor, protocolVersions, signal } = input;
  if (!protocolVersions.every(isPositiveInteger))
    throw canopyConnectError(
      'invalid_argument',
      'Protocol versions must be positive integers.',
    );
  const raw = await callPort(signal, 'read_descriptor', () =>
    source.read(signal),
  );
  if (raw === null) return { kind: 'absent' };
  const descriptor = parseCanopyRuntimeDescriptor(raw);
  if (!descriptor)
    throw canopyConnectError(
      'failed_precondition',
      'Core runtime descriptor is malformed.',
    );
  const running = await callPort(signal, 'inspect_process', () =>
    supervisor.inspectProcess(descriptor.pid, signal),
  );
  if (!running) return { kind: 'stale', reason: 'process_exited' };
  if (running.startIdentity !== descriptor.startIdentity)
    return { kind: 'stale', reason: 'identity_mismatch' };
  if (
    input.secureStorageLayout !== undefined &&
    descriptor.secureStorageLayout !== input.secureStorageLayout
  )
    throw canopyConnectError(
      'failed_precondition',
      'The running daemon uses an older secure storage layout. Quit all app, CLI and daemon processes, then start the current app or CLI.',
    );
  const { min, max } = descriptor.protocolRange;
  const compatible = protocolVersions.some((v) => v >= min && v <= max);
  return { kind: compatible ? 'live' : 'incompatible', descriptor };
}
