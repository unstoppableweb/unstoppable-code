import { useCallback, type JSX } from 'react';
import type { AutoDeleteAttention } from '@canopy/protocol/portal/auto-delete-attention';
import {
  AutoDeleteAttentionPanel,
  type AutoDeleteAttentionNotification,
} from '@canopy/ui-app/auto-delete-attention';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { addToast } from '@/stores/toastStore';

/** Replayable list state supplies both the footer and session toast actions. */
export function DesktopAutoDeleteAttention({
  attention,
  announce = true,
}: {
  attention: readonly AutoDeleteAttention[];
  announce?: boolean;
}): JSX.Element {
  const notifyReason = useCallback((reason: string): void => {
    addToast(reason, 'warning');
  }, []);
  const notify = useCallback(
    ({ id, message, review }: AutoDeleteAttentionNotification): void => {
      addToast(message, 'warning', undefined, {
        key: id,
        category: 'Automation',
        title: 'Auto delete',
        forceInApp: true,
        suppressOsNotification: true,
        blockMessageFromReplay: true,
        action: {
          label: 'Review worktree recovery',
          testId: 'auto-delete-attention-toast-review',
          onClick: review,
        },
      });
    },
    [],
  );
  return (
    <AutoDeleteAttentionPanel
      client={ipcCanopyClient}
      attention={attention}
      announce={announce}
      notify={notify}
      notifyReason={notifyReason}
    />
  );
}
