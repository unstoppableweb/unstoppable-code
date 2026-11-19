import {
  parseAgentDelegationWaitRequest,
  type AgentDelegationResult,
  type AgentDelegationSnapshot,
  type AgentDelegationWaitRequest,
  type AgentDelegationWaitResult,
} from '@canopy/protocol/delegation';
import { isDelegationTerminal } from './lifecycle';

export interface DelegationWaitSource {
  /** Must be scoped by the host to the authenticated parent. */
  getSnapshot(delegationId: string): AgentDelegationSnapshot | undefined;
  subscribe(listener: () => void): () => void;
}

/** Event-driven lookup only: never consumes delivery or cancels child work. */
export async function waitForDelegations(
  request: AgentDelegationWaitRequest,
  source: DelegationWaitSource,
  signal?: AbortSignal,
  onError?: (error: unknown) => void,
): Promise<AgentDelegationResult<AgentDelegationWaitResult>> {
  const parsed = parseAgentDelegationWaitRequest(request);
  if (!parsed.ok) return parsed;
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      result: AgentDelegationResult<AgentDelegationWaitResult>,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        unsubscribe?.();
      } catch {
        // A host cleanup fault must not strand an already-settled wait.
      }
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void =>
      finish({
        ok: false,
        error: {
          code: 'parent_unavailable',
          message: 'The delegation wait was cancelled.',
          retryable: false,
        },
      });
    const inspect = (timedOut: boolean): void => {
      if (settled) return;
      try {
        const snapshots: AgentDelegationSnapshot[] = [];
        for (const id of parsed.value.delegationIds) {
          const snapshot = source.getSnapshot(id);
          if (!snapshot || snapshot.delegationId !== id) {
            finish({
              ok: false,
              error: {
                code: 'invalid_request',
                message:
                  'A requested delegation is unavailable to this parent.',
                retryable: false,
              },
            });
            return;
          }
          snapshots.push(snapshot);
        }
        const completed = snapshots.some(
          (snapshot) =>
            snapshot.status === 'interrupted' ||
            isDelegationTerminal(snapshot.status),
        );
        if (completed || timedOut)
          finish({
            ok: true,
            value: { timedOut: timedOut && !completed, snapshots },
          });
      } catch (error) {
        onError?.(error);
        finish({
          ok: false,
          error: {
            code: 'runtime_error',
            message: 'Delegation results could not be read.',
            retryable: true,
          },
        });
      }
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      unsubscribe = source.subscribe(() => inspect(false));
      if (settled) {
        unsubscribe();
        return;
      }
      timer = setTimeout(() => inspect(true), parsed.value.timeoutMs);
      inspect(parsed.value.timeoutMs === 0);
    } catch (error) {
      onError?.(error);
      finish({
        ok: false,
        error: {
          code: 'runtime_error',
          message: 'Delegation updates are unavailable.',
          retryable: true,
        },
      });
    }
  });
}
