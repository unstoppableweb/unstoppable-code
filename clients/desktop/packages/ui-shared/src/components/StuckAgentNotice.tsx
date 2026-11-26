'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import { Notice, NoticeButton } from '../primitives/Notice';

export type StuckAgentCheckResult = 'running' | 'settled';

export interface StuckAgentNoticeProps {
  minutes: number;
  onCheckStatus: () => Promise<StuckAgentCheckResult>;
  /** Closes the notice. The host shows it again when the turn stalls anew. */
  onDismiss?: () => void;
}

type CheckState = 'unchecked' | 'checking' | 'running' | 'failed';

/** A callback-driven warning that lets the host recheck a potentially stuck turn. */
export function StuckAgentNotice({
  minutes,
  onCheckStatus,
  onDismiss,
}: StuckAgentNoticeProps): JSX.Element {
  const [checkState, setCheckState] = useState<CheckState>('unchecked');
  const checkInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const handleCheckStatus = async (): Promise<void> => {
    if (checkInFlightRef.current) return;
    checkInFlightRef.current = true;
    setCheckState('checking');

    try {
      const result = await onCheckStatus();
      if (mountedRef.current) {
        setCheckState(result === 'running' ? 'running' : 'unchecked');
      }
    } catch {
      if (mountedRef.current) setCheckState('failed');
    } finally {
      checkInFlightRef.current = false;
    }
  };

  const title = `No response for ${String(minutes)} ${
    minutes === 1 ? 'minute' : 'minutes'
  }`;
  const showAction = checkState !== 'running';

  return (
    <Notice
      intent="attention"
      title={title}
      data-testid="stuck-agent-warning"
      onDismiss={onDismiss}
      {...(checkState === 'failed'
        ? { detail: "Couldn't check the agent's status." }
        : {})}
      {...(showAction
        ? {
            actions: (
              <NoticeButton
                variant="secondary"
                onClick={(): void => {
                  void handleCheckStatus();
                }}
                disabled={checkState === 'checking'}
                {...(checkState === 'checking' ? { 'aria-busy': 'true' } : {})}
                data-testid="stuck-agent-check-status"
              >
                Check status
              </NoticeButton>
            ),
          }
        : {})}
    >
      {checkState === 'running'
        ? 'The agent is still working.'
        : 'The agent might be stuck.'}
    </Notice>
  );
}
