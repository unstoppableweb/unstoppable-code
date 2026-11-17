import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import {
  cloudForkKey,
  dismissCloudFork,
  forkCloudChat,
  useCloudForkStore,
  type CloudForkTarget,
} from '@/stores/chat/web-core/cloud-forks';

/** A refused or unconfirmed cloud fork, under the turn it started from (CAN-7007). */
export function CloudForkNotice({
  target,
}: {
  readonly target: CloudForkTarget;
}): JSX.Element | null {
  const fork = useCloudForkStore((state) => state.forks[cloudForkKey(target)]);
  if (fork === undefined || fork.status === 'pending') return null;
  if (fork.status === 'unknown')
    return (
      <Notice
        intent="attention"
        title="Couldn't confirm the fork."
        data-testid="cloud-fork-unknown"
        actions={
          <NoticeButton onClick={() => void forkCloudChat(target)}>
            Try again
          </NoticeButton>
        }
      >
        Trying again finishes it without making a second copy.
      </Notice>
    );
  return (
    <Notice
      intent="attention"
      title="Couldn't fork this chat."
      data-testid="cloud-fork-refused"
      onDismiss={() => dismissCloudFork(target)}
    >
      {fork.reason === 'core.chat.revisionConflict'
        ? 'It changed while forking. Try again.'
        : 'Nothing was copied.'}
    </Notice>
  );
}
