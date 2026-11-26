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
      title: "Couldn't connect to the agent runtime.",
      description: 'Retry, or switch to another model.',
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
  'external.ai_credits_required': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "You're out of credits",
      description: 'Buy more credits to keep going.',
    },
    summary: 'AI Credits billing source unavailable',
    status: 402,
  },
  'external.ai_credits_budget_exhausted': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: 'This chat reached its credits limit.',
      description: 'A new chat starts with a fresh one.',
    },
    summary: 'AI Credits session budget exhausted',
    status: 402,
  },
  'external.ai_credits_access_required': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: 'Chat stopped.',
      description: 'This model is not available for this request.',
    },
    summary: 'AI Credits model access required',
    status: 403,
  },
  'external.ai_credits_owner_unavailable': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "You're no longer in this organization.",
      description:
        "Its credits can't pay for this chat. Ask an org admin to add you back.",
    },
    summary: 'AI Credits work owner membership required',
    status: 403,
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
  // CAN-7137: a write refused because the background service (Core) is
  // unavailable for the rest of this run. Only a relaunch reconnects it, so
  // the copy says Restart instead of the generic Reload.
  'external.background_service_unavailable': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "Something's stuck in the background.",
      description:
        "Restart the app to get things working again. Until then, you can't add or change projects.",
    },
    summary: 'Background service unavailable',
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
  'external.worktree_recovery_required': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "Couldn't remove this worktree.",
      description: 'The previous removal needs review.',
    },
    summary: 'Worktree recovery required',
  },
  'external.worktree_recovery_retryable': {
    kind: 'external',
    recovery: 'try_again',
    copy: {
      title: "Couldn't remove this worktree.",
      description: "The previous removal didn't finish.",
    },
    summary: 'Worktree recovery retryable',
  },
  'external.worktree_recovery_cleanup': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "Couldn't remove this worktree.",
      description: "The archive was saved, but cleanup didn't finish.",
    },
    summary: 'Worktree recovery cleanup',
  },
  'external.worktree_recovery_unreadable': {
    kind: 'external',
    recovery: 'fix_first',
    copy: { title: "Couldn't check the previous removal." },
    summary: 'Worktree recovery unreadable',
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
  'external.removal_not_permitted': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "Couldn't remove the remaining files.",
      description:
        'Check file permissions or immutable flags, then try again. The remaining files were kept.',
    },
    summary: 'File removal not permitted by the operating system',
    status: 'EPERM',
  },
  'external.chat_history_link_outside': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "Couldn't delete this chat history.",
      description:
        "One of its files links outside the app's data folder. Remove the link, then try again.",
    },
    summary: 'Chat history file links outside the data folder',
  },
  'external.sign_in_timed_out': {
    kind: 'external',
    recovery: 'try_again',
    copy: {
      title: 'Sign-in timed out.',
      description: "It wasn't finished in your browser in time.",
    },
    summary: 'Browser sign-in timed out',
  },
  'external.browser_unavailable': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "Couldn't open a web browser.",
      description:
        'Set a default browser in your system settings, then try again.',
    },
    summary: 'System browser could not be opened',
  },
  // OpenCode's sign-in program is installed separately, so the copy must not
  // assume the app ships the program (CAN-6895).
  'external.sign_in_launch_failed': {
    kind: 'external',
    recovery: 'fix_first',
    copy: {
      title: "Couldn't start the sign-in program.",
      description:
        'Security software may have blocked it, or it may be missing. Allow or reinstall it, then try again.',
    },
    summary: 'Sign-in program failed to launch',
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
