'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  AGENT_ACTIVITY_STOP_ALL_CANCEL_LABEL,
  AGENT_ACTIVITY_STOP_ALL_CONFIRM_LABEL,
  DELEGATED_AGENT_STOPPING_LABEL,
  ExecutionActionButton,
  Button,
  ConfirmDialog,
} from '@canopy/ui-shared/components';

export interface StopAllConfirmControlProps {
  /** The live items one Stop all covers; the control leaves with the last. */
  liveIds: readonly string[];
  onStopAll: () => Promise<boolean>;
  /** The resting action's visible caption. */
  label: string;
  /** The resting action's accessible name. */
  accessibleLabel: string;
  /** The confirm step's question, naming the count. */
  prompt: (count: number) => string;
  /** Section actions confirm in a dialog without displacing the heading. */
  appearance?: 'default' | 'section';
  message?: string;
  /** Test id of the resting action; its confirm parts add suffixes. */
  testId: string;
}

/**
 * A Stop all action with inline confirmation. Accepted, it reads Stopping…
 * until every item it covered has left `liveIds`.
 */
export function StopAllConfirmControl({
  liveIds,
  onStopAll,
  label,
  accessibleLabel,
  prompt,
  appearance = 'default',
  message,
  testId,
}: StopAllConfirmControlProps): JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  // Items the accepted stop covered. They stay listed until they
  // settle; meanwhile the header reads Stopping… instead of offering Stop all
  // for work that is already being stopped.
  const [stoppedIds, setStoppedIds] = useState<ReadonlySet<string> | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<string | null>(null);
  const hasLive = liveIds.length > 0;
  const stoppingOnly =
    stoppedIds !== null && liveIds.every((id) => stoppedIds.has(id));

  useEffect(() => {
    if (!hasLive) setConfirming(false);
    if (stoppedIds && !liveIds.some((id) => stoppedIds.has(id))) {
      setStoppedIds(null);
    }
  }, [hasLive, liveIds, stoppedIds]);

  useEffect(() => {
    const testId = focusTargetRef.current;
    if (!testId) return;
    focusTargetRef.current = null;
    containerRef.current
      ?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      ?.focus();
  }, [confirming]);

  if (!hasLive) return null;

  const cancel = (): void => {
    focusTargetRef.current = testId;
    setConfirming(false);
  };
  const confirm = (): void => {
    if (sending) return;
    const covered = new Set(liveIds);
    setSending(true);
    // After a failure, focus returns to Stop all so the user can retry.
    const settle = (accepted: boolean): void => {
      if (accepted) setStoppedIds(covered);
      else focusTargetRef.current = testId;
      setSending(false);
      setConfirming(false);
    };
    onStopAll().then(settle, () => settle(false));
  };

  return (
    <div
      ref={containerRef}
      className="flex shrink-0 items-center gap-2"
      onKeyDown={(event): void => {
        if (confirming && !sending && event.key === 'Escape') {
          event.stopPropagation();
          cancel();
        }
      }}
    >
      {confirming && appearance !== 'section' ? (
        <div
          role="group"
          aria-label={prompt(liveIds.length)}
          className="flex items-center gap-2"
          data-testid={`${testId}-confirmation`}
        >
          <span className="text-xs fg-secondary">{prompt(liveIds.length)}</span>
          <ExecutionActionButton
            label={
              sending
                ? DELEGATED_AGENT_STOPPING_LABEL
                : AGENT_ACTIVITY_STOP_ALL_CONFIRM_LABEL
            }
            ariaLabel={
              sending
                ? DELEGATED_AGENT_STOPPING_LABEL
                : AGENT_ACTIVITY_STOP_ALL_CONFIRM_LABEL
            }
            variant="destructive-chip"
            disabled={sending}
            dataTestId={`${testId}-confirm`}
            stopKeyDownPropagation={false}
            onClick={confirm}
          />
          <ExecutionActionButton
            label={AGENT_ACTIVITY_STOP_ALL_CANCEL_LABEL}
            ariaLabel={AGENT_ACTIVITY_STOP_ALL_CANCEL_LABEL}
            disabled={sending}
            dataTestId={`${testId}-cancel`}
            stopKeyDownPropagation={false}
            onClick={cancel}
          />
        </div>
      ) : appearance === 'section' ? (
        <Button
          variant="ghost"
          size="compact"
          aria-label={
            stoppingOnly ? DELEGATED_AGENT_STOPPING_LABEL : accessibleLabel
          }
          disabled={stoppingOnly || sending}
          data-testid={testId}
          onClick={() => setConfirming(true)}
        >
          {stoppingOnly ? DELEGATED_AGENT_STOPPING_LABEL : label}
        </Button>
      ) : (
        <ExecutionActionButton
          label={stoppingOnly ? DELEGATED_AGENT_STOPPING_LABEL : label}
          ariaLabel={
            stoppingOnly ? DELEGATED_AGENT_STOPPING_LABEL : accessibleLabel
          }
          variant="destructive"
          disabled={stoppingOnly || sending}
          dataTestId={testId}
          stopKeyDownPropagation
          onClick={(): void => {
            focusTargetRef.current = `${testId}-cancel`;
            setConfirming(true);
          }}
        />
      )}
      {confirming && appearance === 'section' && (
        <ConfirmDialog
          title={prompt(liveIds.length)}
          message={message}
          confirmLabel={AGENT_ACTIVITY_STOP_ALL_CONFIRM_LABEL}
          busyLabel={DELEGATED_AGENT_STOPPING_LABEL}
          destructive
          busy={sending}
          onConfirm={confirm}
          onCancel={cancel}
          dataTestId={`${testId}-confirmation`}
          confirmTestId={`${testId}-confirm`}
          cancelTestId={`${testId}-cancel`}
        />
      )}
    </div>
  );
}
