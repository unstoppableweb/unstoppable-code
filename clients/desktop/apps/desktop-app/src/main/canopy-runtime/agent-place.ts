import { AsyncLocalStorage } from 'node:async_hooks';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';

/** Where an agent read comes from: the calling session's project and worktree. */
export interface AgentPlace {
  readonly workspaceId: string;
  readonly worktreeId: string;
}

interface AgentPlaceMark {
  readonly caller: CanopyCallerDescriptor;
  readonly place: AgentPlace;
  consumed: boolean;
}

const marks = new AsyncLocalStorage<AgentPlaceMark>();

/**
 * Runs `dispatch`, one core dispatch as `caller`, from `place`: the calling
 * session's project and worktree, which the CAN-4551 owned-workflow rule
 * checks (CAN-6032). The place lives only in this in-process call chain and
 * is never read from params, so no caller arriving over a relay, a socket or
 * the daemon can claim one.
 */
export function withAgentPlace<Result>(
  caller: CanopyCallerDescriptor,
  place: AgentPlace,
  dispatch: () => Promise<Result>,
): Promise<Result> {
  return marks.run({ caller, place, consumed: false }, dispatch);
}

/**
 * The place main set for the dispatch serving `caller`, or undefined. It
 * answers once, and only for the caller it was set for, so another dispatch
 * started inside the marked one, or by another caller, never inherits it.
 */
export function consumeAgentPlace(
  caller: CanopyCallerDescriptor,
): AgentPlace | undefined {
  const mark = marks.getStore();
  if (
    mark === undefined ||
    mark.consumed ||
    mark.caller.principalId !== caller.principalId ||
    mark.caller.clientInstanceId !== caller.clientInstanceId ||
    mark.caller.authorityId !== caller.authorityId ||
    mark.caller.interfaceKind !== caller.interfaceKind
  )
    return undefined;
  mark.consumed = true;
  return mark.place;
}
