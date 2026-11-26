'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  isLiveSubagentStatus,
  type SubagentNode,
  type SubagentStatus,
} from '@canopy/ui-shared';
import {
  SUBAGENT_QUEUE_SEND_FAILED_LABEL,
  SUBAGENT_INTERRUPT_FAILED_LABEL,
  SUBAGENT_SEND_FAILED_LABEL,
} from '@canopy/ui-shared';
import type { SubagentMessageRequest, SubagentMessageResult } from '../types';
import {
  getSubagentComposerDraft,
  useSubagentComposerDraft,
  useSubagentComposerStore,
} from './subagent-composer-store';

export interface UseSubagentMessageQueueOptions {
  readonly key: string;
  readonly node: SubagentNode;
  readonly onMessageSubagent?: (
    request: SubagentMessageRequest,
  ) => Promise<SubagentMessageResult>;
  readonly createOperationId?: () => string;
}

export interface SubagentMessageQueueActions {
  readonly submit: (text: string) => void;
  readonly interrupt: () => void;
  readonly steerDraft: (id: string) => void;
  readonly interruptDraft: (id: string) => void;
  readonly retryDraft: (id: string) => void;
  readonly editDraft: (id: string) => void;
  readonly clearDraft: (id: string) => void;
}

function createOperationId(): string {
  return globalThis.crypto.randomUUID();
}

function errorReason(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function failureLabel(operation: SubagentMessageRequest['operation']): string {
  if (operation === 'interrupt') return SUBAGENT_INTERRUPT_FAILED_LABEL;
  return SUBAGENT_SEND_FAILED_LABEL;
}

function latestRunGeneration(node: SubagentNode): number {
  return node.runs.reduce(
    (latest, run) => Math.max(latest, run.runGeneration),
    0,
  );
}

function requestFor(
  operation: SubagentMessageRequest['operation'],
  message: string | undefined,
  operationId: string,
): SubagentMessageRequest {
  return operation === 'interrupt'
    ? { operation, operationId }
    : { operation, message: message ?? '', operationId };
}

/**
 * Runs the managed self-recipient's queue. All completion updates go directly
 * to the module store, so a promise may settle safely after its panel unmounts.
 */
export function useSubagentMessageQueue({
  key,
  node,
  onMessageSubagent,
  createOperationId: operationIdFactory = createOperationId,
}: UseSubagentMessageQueueOptions): SubagentMessageQueueActions {
  const draft = useSubagentComposerDraft(key);
  const previousStatus = useRef<SubagentStatus | undefined>(undefined);
  const runGeneration = latestRunGeneration(node);
  const runGenerationRef = useRef(runGeneration);
  runGenerationRef.current = runGeneration;
  const control = node.snapshot?.control;
  const controlIdRef = useRef(control?.operationId);
  controlIdRef.current = control?.operationId;

  const executeOperation = useCallback(
    async (
      operation: SubagentMessageRequest['operation'],
      message: string | undefined,
      queuedDraftId: string | undefined,
      clearInputText: string | undefined,
    ): Promise<void> => {
      if (!onMessageSubagent) return;
      const store = useSubagentComposerStore.getState();
      if (!store.beginOperation(key)) return;
      if (queuedDraftId) {
        store.updateQueuedDraft(key, queuedDraftId, (queued) => ({
          ...queued,
          state: operation === 'interrupt' ? 'interrupting' : 'sending',
          error: undefined,
          retryOnStatusChange: false,
        }));
      }
      // A follow-up starts a later run; remember where this one began.
      const fromRunGeneration = runGenerationRef.current;
      const baselineControlId = controlIdRef.current;
      try {
        const operationId = operationIdFactory();
        const result = await onMessageSubagent(
          requestFor(operation, message, operationId),
        );
        if (result.ok) {
          if (operation === 'follow_up') {
            store.setWaitForLiveAfterFollowUp(key, true, fromRunGeneration);
            if (clearInputText !== undefined) {
              const latest = getSubagentComposerDraft(key);
              if (latest.input === clearInputText) store.setInput(key, '');
            }
          }
          if (queuedDraftId) {
            if (operation === 'interrupt') {
              store.updateQueuedDraft(key, queuedDraftId, (queued) => ({
                ...queued,
                state: 'awaiting-settle',
                error: undefined,
                retryOperation: undefined,
              }));
            } else if (operation === 'steer') {
              // Accepted is not delivered: keep the draft until the
              // delegate reports this steer's outcome.
              store.updateQueuedDraft(key, queuedDraftId, (queued) => ({
                ...queued,
                state: 'sending',
                error: undefined,
                deliveryOperationId: operationId,
                ...(baselineControlId !== undefined
                  ? { deliveryBaselineOperationId: baselineControlId }
                  : {}),
              }));
            } else {
              store.removeQueuedDraft(key, queuedDraftId);
            }
          }
          store.setError(key, null);
          return;
        }
        if (result.code === 'busy') {
          let retryDraftId = queuedDraftId;
          if (
            !retryDraftId &&
            operation === 'follow_up' &&
            message !== undefined
          ) {
            retryDraftId = store.enqueueDraft(key, message, 'front');
            if (clearInputText !== undefined) {
              const latest = getSubagentComposerDraft(key);
              if (latest.input === clearInputText) store.setInput(key, '');
            }
          }
          if (retryDraftId) {
            store.updateQueuedDraft(key, retryDraftId, (queued) => ({
              ...queued,
              state: 'queued',
              error: undefined,
              retryOnStatusChange: true,
              retryOperation: operation,
            }));
          } else {
            store.setError(key, failureLabel(operation), result.error);
          }
          return;
        }
        const prefix = queuedDraftId
          ? SUBAGENT_QUEUE_SEND_FAILED_LABEL
          : failureLabel(operation);
        if (queuedDraftId) {
          store.updateQueuedDraft(key, queuedDraftId, (queued) => ({
            ...queued,
            state: 'failed',
            error: prefix,
            errorDetails: result.error,
            retryOnStatusChange: false,
            retryOperation: operation,
          }));
        } else {
          store.setError(key, prefix, result.error);
        }
      } catch (error: unknown) {
        const prefix = queuedDraftId
          ? SUBAGENT_QUEUE_SEND_FAILED_LABEL
          : failureLabel(operation);
        const reason = errorReason(error);
        if (queuedDraftId) {
          store.updateQueuedDraft(key, queuedDraftId, (queued) => ({
            ...queued,
            state: 'failed',
            error: prefix,
            errorDetails: reason,
            retryOnStatusChange: false,
            retryOperation: operation,
          }));
        } else {
          store.setError(key, prefix, reason);
        }
      } finally {
        store.endOperation(key);
      }
    },
    [key, onMessageSubagent, operationIdFactory],
  );

  const submit = useCallback(
    (rawText: string): void => {
      const text = rawText.trim();
      if (text.length === 0 || !onMessageSubagent) return;
      const current = getSubagentComposerDraft(key);
      if (
        isLiveSubagentStatus(node.status) ||
        current.inFlight ||
        current.waitForLiveAfterFollowUp ||
        current.queue.length > 0
      ) {
        useSubagentComposerStore.getState().enqueueDraft(key, text);
        useSubagentComposerStore.getState().setInput(key, '');
        return;
      }
      void executeOperation('follow_up', text, undefined, rawText);
    },
    [executeOperation, key, node.status, onMessageSubagent],
  );

  const interrupt = useCallback((): void => {
    void executeOperation('interrupt', undefined, undefined, undefined);
  }, [executeOperation]);

  const steerDraft = useCallback(
    (id: string): void => {
      const queued = getSubagentComposerDraft(key).queue.find(
        (item) => item.id === id,
      );
      if (!queued) return;
      void executeOperation('steer', queued.text, id, undefined);
    },
    [executeOperation, key],
  );

  const interruptDraft = useCallback(
    (id: string): void => {
      if (!getSubagentComposerDraft(key).queue.some((item) => item.id === id))
        return;
      void executeOperation('interrupt', undefined, id, undefined);
    },
    [executeOperation, key],
  );

  const retryDraft = useCallback(
    (id: string): void => {
      const queued = getSubagentComposerDraft(key).queue.find(
        (item) => item.id === id,
      );
      if (!queued) return;
      const operation = queued.retryOperation ?? 'follow_up';
      void executeOperation(
        operation,
        operation === 'interrupt' ? undefined : queued.text,
        id,
        undefined,
      );
    },
    [executeOperation, key],
  );

  const editDraft = useCallback(
    (id: string): void => {
      const store = useSubagentComposerStore.getState();
      const state = getSubagentComposerDraft(key);
      const queued = state.queue.find((item) => item.id === id);
      if (
        !queued ||
        queued.state === 'sending' ||
        queued.state === 'interrupting'
      )
        return;
      store.setInput(
        key,
        state.input ? `${queued.text}\n\n${state.input}` : queued.text,
      );
      store.removeQueuedDraft(key, id);
    },
    [key],
  );

  const clearDraft = useCallback(
    (id: string): void => {
      const queued = getSubagentComposerDraft(key).queue.find(
        (item) => item.id === id,
      );
      if (queued?.state === 'sending' || queued?.state === 'interrupting')
        return;
      useSubagentComposerStore.getState().removeQueuedDraft(key, id);
    },
    [key],
  );

  useEffect((): void => {
    const store = useSubagentComposerStore.getState();
    for (const queued of getSubagentComposerDraft(key).queue) {
      const operationId = queued.deliveryOperationId;
      if (operationId === undefined || !control) continue;
      if (control.operationId !== operationId) {
        // The tree may not show this steer yet. A control other than the
        // one before it was accepted later, so this steer is settled.
        if (control.operationId !== queued.deliveryBaselineOperationId) {
          store.removeQueuedDraft(key, queued.id);
        }
        continue;
      }
      if (control.status === 'failed') {
        store.updateQueuedDraft(key, queued.id, (current) => ({
          ...current,
          state: 'failed',
          error: SUBAGENT_QUEUE_SEND_FAILED_LABEL,
          errorDetails: control.error,
          retryOnStatusChange: false,
          retryOperation: 'steer',
          deliveryOperationId: undefined,
          deliveryBaselineOperationId: undefined,
        }));
      } else if (
        control.status === 'completed' ||
        control.steeringDelivery?.kind === 'accepted'
      ) {
        store.removeQueuedDraft(key, queued.id);
      }
    }
  }, [control, draft, key]);

  useEffect((): void => {
    const previous = previousStatus.current;
    const statusChanged = previous !== undefined && previous !== node.status;
    previousStatus.current = node.status;
    const store = useSubagentComposerStore.getState();
    if (isLiveSubagentStatus(node.status)) {
      if (getSubagentComposerDraft(key).waitForLiveAfterFollowUp) {
        store.setWaitForLiveAfterFollowUp(key, false);
      }
      return;
    }
    const current = getSubagentComposerDraft(key);
    if (
      current.waitForLiveAfterFollowUp &&
      (previous === undefined ||
        (current.followUpFromRunGeneration !== null &&
          runGeneration > current.followUpFromRunGeneration))
    ) {
      // A tab may have been unmounted for the entire accepted run, or the run
      // may have started and settled between two tree reads. Either way the
      // remaining queue is ready for its next follow-up.
      store.setWaitForLiveAfterFollowUp(key, false);
    }
    const refreshed = getSubagentComposerDraft(key);
    if (refreshed.inFlight || refreshed.waitForLiveAfterFollowUp) return;
    const oldest = refreshed.queue[0];
    if (!oldest) return;
    const maySend =
      (oldest.state === 'queued' && oldest.retryOnStatusChange !== true) ||
      oldest.state === 'awaiting-settle' ||
      (oldest.retryOnStatusChange === true &&
        (previous === undefined || statusChanged));
    if (!maySend || !onMessageSubagent) return;
    const operation = oldest.retryOperation ?? 'follow_up';
    void executeOperation(
      operation,
      operation === 'interrupt' ? undefined : oldest.text,
      oldest.id,
      undefined,
    );
  }, [
    draft,
    executeOperation,
    key,
    node.status,
    onMessageSubagent,
    runGeneration,
  ]);

  return {
    submit,
    interrupt,
    steerDraft,
    interruptDraft,
    retryDraft,
    editDraft,
    clearDraft,
  };
}
