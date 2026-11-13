import type { LaunchAtLoginStatus } from '../types';

/**
 * Whether `status` is what the person asked for. A registration waiting for
 * approval counts as on, as it does for the Settings toggle.
 */
export function launchAtLoginSatisfies(
  status: LaunchAtLoginStatus,
  requested: boolean,
): boolean {
  return requested
    ? status.enabled || status.pendingApproval
    : !status.enabled && !status.pendingApproval;
}
