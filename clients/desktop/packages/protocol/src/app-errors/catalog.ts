import type { AppErrorCopy, AppErrorRecovery } from './primitives';

export type AppErrorDefinition = {
  readonly copy: Readonly<AppErrorCopy>;
  readonly summary: string;
  readonly status?: string | number;
} & (
  | { kind: 'defect'; recovery?: never }
  | { kind: 'input' | 'external'; recovery: AppErrorRecovery }
);

export const APP_ERROR_CATALOG = {
  'app.unexpected': {
    kind: 'defect',
    copy: {
      title: 'Something went wrong.',
      description: 'Reload to get back to a working state.',
    },
    summary: 'Unexpected application failure',
  },
  'input.not_accepted': {
    kind: 'input',
    recovery: 'fix_first',
    copy: { title: 'Check what you entered.' },
    summary: 'Input was not accepted',
  },
  'app.runtime_unreachable': {
    kind: 'defect',
    copy: {
      title: "Couldn't reach the agent runtime.",
      description:
        "Agents on it can't start. Try again, or report this if it continues.",
    },
    summary: 'Bundled agent runtime unreachable',
  },
  'external.runtime_unreachable': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "Couldn't reach the agent runtime.",
      description: 'Start it or check its connection settings.',
    },
    summary: 'Agent runtime unreachable',
  },
  'external.sync_paused': {
    kind: 'external',
    recovery: 'wait',
    copy: {
      title: 'Sync is paused.',
      description: 'Your work is saved on this device and syncs later.',
    },
    summary: 'Activity sync paused',
  },
  'external.offline': {
    kind: 'external',
    recovery: 'try_again',
    copy: {
      title: "Couldn't reach the network.",
      description: 'Check your connection, then try again.',
    },
    summary: 'Network unavailable',
  },
  'external.service_unavailable': {
    kind: 'external',
    recovery: 'try_again',
    copy: {
      title: "The service didn't respond.",
      description: 'It may be busy; try again in a moment.',
    },
    summary: 'Service unavailable',
    status: 503,
  },
  'external.rate_limited': {
    kind: 'external',
    recovery: 'wait',
    copy: {
      title: 'Too many requests for now.',
      description: 'Wait a little before continuing.',
    },
    summary: 'Rate limited',
    status: 429,
  },
  'external.sign_in_required': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: 'Your sign-in has expired.',
      description: 'Sign in again to continue.',
    },
    summary: 'Authentication required',
    status: 401,
  },
  'external.state_changed': {
    kind: 'external',
    recovery: 'start_over',
    copy: {
      title: 'Something changed since this started.',
      description: 'Refresh and start this step again.',
    },
    summary: 'State changed',
    status: 409,
  },
  'external.disk_full': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "There isn't enough disk space.",
      description: 'Free up space, then continue.',
    },
    summary: 'Disk full',
    status: 'ENOSPC',
  },
} as const satisfies Record<string, AppErrorDefinition>;

for (const definition of Object.values(APP_ERROR_CATALOG)) {
  Object.freeze(definition.copy);
  Object.freeze(definition);
}
Object.freeze(APP_ERROR_CATALOG);

export type AppErrorCode = keyof typeof APP_ERROR_CATALOG;
export const APP_ERROR_CODES: readonly AppErrorCode[] = Object.freeze(
  Object.keys(APP_ERROR_CATALOG).filter(isAppErrorCode),
);

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(APP_ERROR_CATALOG, value)
  );
}

export function getAppErrorDefinition(code: AppErrorCode): AppErrorDefinition {
  return APP_ERROR_CATALOG[code];
}
