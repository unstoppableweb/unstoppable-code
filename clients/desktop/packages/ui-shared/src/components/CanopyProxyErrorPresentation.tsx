import type { JSX, ReactNode } from 'react';
import { MODEL_LIBRARY_UNLOCK_COPY } from './creditsPromptCopy';
import { Notice } from '../primitives/Notice';

export interface CanopyProxyErrorPresentationProps {
  state: 'unresolved' | 'resolved';
  dataTestId: string;
  title?: ReactNode;
  children?: ReactNode;
  /**
   * How a failure is announced: `live` interrupts (`alert`) because it just
   * happened; `replay` is history and stays polite (`status`). A resolved
   * notice is always polite.
   */
  announcement: 'live' | 'replay';
  detail?: ReactNode;
  actions?: ReactNode;
}

/**
 * Proxy refusal display shared by interactive notices and read-only replays.
 * It never prints the error id: Copy details in `actions` carries it.
 */
export function CanopyProxyErrorPresentation({
  state,
  dataTestId,
  title,
  children,
  announcement,
  detail,
  actions,
}: CanopyProxyErrorPresentationProps): JSX.Element {
  const resolved = state === 'resolved';
  return (
    <Notice
      intent={resolved ? 'positive' : 'attention'}
      role={resolved || announcement === 'replay' ? 'status' : 'alert'}
      data-testid={dataTestId}
      // Transcript rows size to their content, and the notice's container
      // query gives it no intrinsic width; this marker lets the desktop and
      // Portal rows stretch it to the reading width instead.
      data-chat-notice=""
      title={
        resolved ? (
          <span data-testid={`${dataTestId}-unlock-confirmed`}>
            {MODEL_LIBRARY_UNLOCK_COPY.confirmed}
          </span>
        ) : (
          title
        )
      }
      detail={resolved ? undefined : detail}
      actions={actions}
    >
      {/* The refused message was never sent, and nothing resends it. */}
      {resolved ? 'Send your message again.' : children}
    </Notice>
  );
}
