import {
  isProviderProcessOwner,
  type ProviderProcessOwner,
  type ProviderProcessStdin,
} from '@canopy/desktop-shared/node/provider-process/spawn';

export const PROVIDER_PROCESS_HOST_ENTRY = 'provider-process-host-worker.js';
export const PROVIDER_PROCESS_HOST_SERVICE = 'provider-process-host';
export const PROVIDER_PROCESS_STDOUT_WINDOW_BYTES = 64 * 1024;
export const PROVIDER_PROCESS_STDERR_LIMIT_BYTES = 1024 * 1024;

export type ProviderProcessHostRequest =
  | {
      type: 'spawn';
      requestId: string;
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string | undefined>;
      owner: ProviderProcessOwner;
      stdin?: ProviderProcessStdin;
      /** CAN-6726: also stop traced descendants that left the child's group. */
      reapDescendantGroups?: boolean;
      windowsVerbatimArguments?: boolean;
    }
  | { type: 'stdin'; requestId: string; dataBase64: string }
  | { type: 'stdin-end'; requestId: string }
  | { type: 'stop'; requestId: string; graceMs: number }
  /** CAN-6738: record the child's escaped descendants for the reap at stop. */
  | { type: 'record-descendants'; requestId: string }
  | { type: 'stdout-ack'; requestId: string; bytes: number }
  | { type: 'shutdown' };

export type ProviderProcessHostResponse =
  | { type: 'started'; requestId: string; pid: number }
  | { type: 'stdout'; requestId: string; dataBase64: string }
  | { type: 'stderr'; requestId: string; dataBase64: string }
  | { type: 'error'; requestId: string; message: string; code?: string }
  | {
      type: 'exit';
      requestId: string;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      type: 'close';
      requestId: string;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  /** CAN-6738: the descendant cleanup of a reaping child's stop, after its close. */
  | {
      type: 'stopped';
      requestId: string;
      cleanup: 'none' | 'reaped' | 'unverified';
    }
  | { type: 'shutdown-complete' };

function field(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isEnvironment(
  value: unknown,
): value is Record<string, string | undefined> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return Object.values(value).every(
    (item) => typeof item === 'string' || item === undefined,
  );
}

function isStdin(value: unknown): value is ProviderProcessStdin | undefined {
  return value === undefined || value === 'pipe' || value === 'ignore';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isSignal(value: unknown): value is NodeJS.Signals | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isExitCode(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isInteger(value))
  );
}

export function isProviderProcessHostRequest(
  value: unknown,
): value is ProviderProcessHostRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = field(value, 'type');
  if (type === 'shutdown') return true;
  if (!isRequestId(field(value, 'requestId'))) return false;
  switch (type) {
    case 'spawn':
      return (
        typeof field(value, 'command') === 'string' &&
        isStringArray(field(value, 'args')) &&
        typeof field(value, 'cwd') === 'string' &&
        isEnvironment(field(value, 'env')) &&
        isProviderProcessOwner(field(value, 'owner')) &&
        isStdin(field(value, 'stdin')) &&
        isOptionalBoolean(field(value, 'reapDescendantGroups')) &&
        isOptionalBoolean(field(value, 'windowsVerbatimArguments'))
      );
    case 'stdin':
      return typeof field(value, 'dataBase64') === 'string';
    case 'stdin-end':
      return true;
    case 'stop':
      return isCount(field(value, 'graceMs'));
    case 'record-descendants':
      return true;
    case 'stdout-ack':
      return isCount(field(value, 'bytes'));
    default:
      return false;
  }
}

export function isProviderProcessHostResponse(
  value: unknown,
): value is ProviderProcessHostResponse {
  if (typeof value !== 'object' || value === null) return false;
  const type = field(value, 'type');
  if (type === 'shutdown-complete') return true;
  if (!isRequestId(field(value, 'requestId'))) return false;
  switch (type) {
    case 'started': {
      const pid = field(value, 'pid');
      return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
    }
    case 'stdout':
    case 'stderr':
      return typeof field(value, 'dataBase64') === 'string';
    case 'error': {
      const code = field(value, 'code');
      return (
        typeof field(value, 'message') === 'string' &&
        (code === undefined || typeof code === 'string')
      );
    }
    case 'exit':
    case 'close':
      return (
        isExitCode(field(value, 'code')) && isSignal(field(value, 'signal'))
      );
    case 'stopped': {
      const cleanup = field(value, 'cleanup');
      return (
        cleanup === 'none' || cleanup === 'reaped' || cleanup === 'unverified'
      );
    }
    default:
      return false;
  }
}
