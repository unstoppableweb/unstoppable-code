import type { CloudSandboxStatus } from '@canopy/protocol/cloud-session';

export type CloudSandboxStatusAction = 'Wake' | 'Try again';

/** Which recovery actions the host offers; a sent turn wakes the sandbox anyway. */
export interface CloudSandboxStatusActions {
  readonly wake: boolean;
  readonly tryAgain: boolean;
}

const ALL_ACTIONS: CloudSandboxStatusActions = { wake: true, tryAgain: true };

/** Each state's copy beside its action, and without it. */
const COPY: Record<
  CloudSandboxStatus['kind'],
  { readonly withAction: string; readonly withoutAction: string }
> = {
  ready: { withAction: '', withoutAction: '' },
  waking: { withAction: 'Waking project…', withoutAction: 'Waking project…' },
  sleeping: {
    withAction: 'Project is sleeping.',
    withoutAction: 'Project is sleeping. Send a message to wake it.',
  },
  failed: {
    withAction: 'Project failed to start.',
    withoutAction: 'Project failed to start. Send a message to start it again.',
  },
  'no-sandbox': {
    withAction: 'Working files are unavailable.',
    withoutAction: 'Working files are unavailable.',
  },
  expired: {
    withAction:
      'This project has expired, so working files are no longer available.',
    withoutAction:
      'This project has expired, so working files are no longer available.',
  },
};

function actionFor(
  kind: CloudSandboxStatus['kind'],
  pendingAction: CloudSandboxStatusAction | null,
  actions: CloudSandboxStatusActions,
): CloudSandboxStatusAction | null {
  if (kind === 'sleeping') return actions.wake ? 'Wake' : null;
  if (kind === 'failed') return actions.tryAgain ? 'Try again' : null;
  if (kind === 'waking') return pendingAction;
  return null;
}

/**
 * Shared project state copy; files and terminals keep their own rendering.
 * Without the action a state needs, the copy names the way out instead: a
 * message starts a turn, which wakes or restarts the sandbox (CAN-6543).
 */
export function cloudSandboxStatusCopy(
  kind: CloudSandboxStatus['kind'],
  pendingAction: CloudSandboxStatusAction | null = null,
  actions: CloudSandboxStatusActions = ALL_ACTIONS,
): { action: CloudSandboxStatusAction | null; copy: string } {
  const action = actionFor(kind, pendingAction, actions);
  return {
    action,
    copy: action === null ? COPY[kind].withoutAction : COPY[kind].withAction,
  };
}
