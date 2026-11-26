import { remoteNoticeExplainsMissingRows } from '@canopy/protocol/remote-control/shell';
import {
  backgroundServiceNoticeCopy,
  backgroundServiceRepairCommand,
} from '@canopy/ui-shared/lib';
import { formatBrandText } from '@/lib/brand';
import type { RemoteHostNotices } from '@/stores/recoveryShellSnapshotStore';

export interface RemoteHostUnavailableCopy {
  readonly title: string;
  readonly message: string;
  readonly includesCommand: boolean;
}

/**
 * Copy explaining why a paired computer's sidebar rows could not load while
 * its background service is unavailable or workspace changes are blocked.
 * Static copy only so replay and autocapture stay safe.
 */
export function describeRemoteHostUnavailable(
  notices: RemoteHostNotices | null,
): RemoteHostUnavailableCopy | null {
  if (!notices || !remoteNoticeExplainsMissingRows(notices)) return null;
  const { backgroundService, w5Recovery } = notices;
  if (backgroundService?.state === 'unavailable') {
    const repairCommand =
      backgroundService.reason === 'endpoint_repair_required'
        ? backgroundServiceRepairCommand(formatBrandText('{cli}'))
        : undefined;
    const copy = backgroundServiceNoticeCopy(
      backgroundService.retry,
      backgroundService.recovery,
      false,
      repairCommand,
      true,
      backgroundService.reason === 'data_folder_shared',
    );
    return {
      ...copy,
      includesCommand: repairCommand !== undefined,
    };
  }
  if (
    w5Recovery &&
    w5Recovery.state !== 'hidden' &&
    w5Recovery.state !== 'complete'
  ) {
    const title =
      w5Recovery.state === 'restart-required'
        ? 'Workspace recovery needs a restart'
        : w5Recovery.state === 'refused'
          ? 'Workspace recovery needs attention'
          : 'Some workspace changes are blocked';
    return {
      title,
      message: 'Check workspace recovery in the app on the paired computer.',
      includesCommand: false,
    };
  }
  return null;
}

/**
 * Body copy for Home's "Couldn’t prepare this chat" notice. Explains a paired
 * computer's background-service outage or blocked workspace recovery when
 * present; falls back to the default copy otherwise.
 */
export function homeUnavailableChatMessage(
  notices: RemoteHostNotices | null,
): string {
  const unavailable = describeRemoteHostUnavailable(notices);
  if (!unavailable) return 'Your draft is kept.';
  return `${unavailable.title}. ${unavailable.message} Your draft is kept.`;
}
