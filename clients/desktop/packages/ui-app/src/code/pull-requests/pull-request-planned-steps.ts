import type {
  RemoteControlPrActionPayload,
  RemoteControlWorktreePrActionsState,
} from '@canopy/protocol/remote-control/shell';

// The Portal steps of a PR action (REG-3025): pure, with no React, so the
// web's always-loaded PR hook can import it without the header's components.

type RemoteControlActionsRepo =
  RemoteControlWorktreePrActionsState['repos'][number];

/** The Portal git step a pending action is on. */
export type RemoteControlPullRequestStep = 'pull' | 'commit' | 'push';

/** The steps a Portal action will run, from the state the user acted on. */
export function remoteControlPlannedSteps(
  payload: RemoteControlPrActionPayload,
  repo: RemoteControlActionsRepo | null,
): readonly (RemoteControlPullRequestStep | 'create')[] {
  switch (payload.action) {
    case 'commit':
      return [
        ...(payload.pullFirst === true ? (['pull'] as const) : []),
        'commit',
        ...(payload.push === true ? (['push'] as const) : []),
      ];
    case 'push':
    case 'pull':
      return [payload.action];
    case 'create_auto': {
      // A branch behind its upstream pulls first (the server does too).
      if ((repo?.behind ?? 0) > 0) {
        return repo?.dirty === true
          ? ['pull', 'commit', 'push', 'create']
          : ['pull', 'push', 'create'];
      }
      if (repo?.dirty === true) return ['commit', 'push', 'create'];
      const pushed = repo?.published === true && (repo.ahead ?? 0) === 0;
      return pushed ? ['create'] : ['push', 'create'];
    }
    default:
      return [];
  }
}
