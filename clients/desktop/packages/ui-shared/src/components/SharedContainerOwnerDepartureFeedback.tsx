import type { JSX } from 'react';
import { Notice, NoticeButton } from './Notice';

export interface SharedContainerOwnerDepartureFeedbackProps {
  kind: 'load' | 'dismiss';
  retrying: boolean;
  onRetry: () => void;
}

/** Recovery copy stays shared; hosts own their request and retry state. */
export function SharedContainerOwnerDepartureFeedback({
  kind,
  retrying,
  onRetry,
}: SharedContainerOwnerDepartureFeedbackProps): JSX.Element {
  return (
    <Notice
      intent="attention"
      actions={
        <NoticeButton disabled={retrying} onClick={onRetry}>
          Try again
        </NoticeButton>
      }
    >
      {kind === 'load'
        ? "Couldn't load notices. Try again."
        : "Couldn't dismiss the notice. Try again."}
    </Notice>
  );
}
