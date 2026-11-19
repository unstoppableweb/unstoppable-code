import { createContext } from 'react';
import type {
  AgentDelegationSnapshot,
  AgentDelegationStatus,
  DelegationWorkspaceChanges,
} from '@canopy/protocol/delegation';
import {
  AGENT_ACTIVITY_STOP_ALL_FAILED_LABEL,
  DELEGATED_AGENT_STOP_FAILED_LABEL,
} from '@canopy/ui-shared/components';
import {
  stopAllCloudDelegations,
  stopCloudDelegation,
} from '@/cloud-chats/cloud-delegation-stop';
import { isWebCoreScope } from '@/lib/chat-authority';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useGitHubStore } from '@/stores/githubStore';
import type { DisplayBlock, TurnGroupOrMessage } from './types';

/** The root chat whose delegation tree a user stop targets. */
export interface ManagedDelegationChatTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** Live managed delegations in one chat, derived from its transcript. */
export interface ManagedDelegationStopState {
  /** Queued, starting or running delegations at any depth and mode. */
  readonly liveDelegationIds: readonly string[];
  /** Delegations with at least one live descendant, sorted. */
  readonly withLiveDescendants: readonly string[];
}

/**
 * Host wiring for the delegated-task card's Stop. Provided by the chat's
 * message list; absent (so no Stop renders) in read-only and detached views.
 */
export interface ManagedDelegationStopControls {
  readonly target: ManagedDelegationChatTarget;
  readonly withLiveDescendants: ReadonlySet<string>;
  /**
   * The scope reads a delegate's retained worktree here
   * (`delegationWorktreeDetails`): a card offers Load changes only then.
   */
  readonly worktreeDetails: boolean;
  /**
   * A cloud chat's delegates as the web core last read them (CAN-7245): the
   * transcript keeps each card's first state, so a card shows and stops by
   * this instead.
   */
  readonly liveSnapshots?: ReadonlyMap<string, AgentDelegationSnapshot>;
  /**
   * Per cloud delegate, bumps when the web core reads its lifecycle change:
   * its open child pages read again, as the web's do (CAN-7245).
   */
  readonly liveEpochs?: ReadonlyMap<string, number>;
  /**
   * The delegates a cloud chat's cards own (CAN-7245): only these get a
   * Stop, so a delegate's own delegate shown in a card's pages offers none.
   */
  readonly ownDelegationIds?: ReadonlySet<string>;
}

export const ManagedDelegationStopContext =
  createContext<ManagedDelegationStopControls | null>(null);

interface DelegationEntry {
  readonly status: AgentDelegationStatus;
  readonly parentDelegationId?: string;
  readonly runGeneration: number;
}

function isLiveStatus(status: AgentDelegationStatus): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * Walks every managed delegation block (nested ones included), keeping the
 * latest run of each, the way the Agent activity section does. A settled
 * intermediate parent still links a live grandchild to its ancestors.
 */
export function selectManagedDelegationStopState(
  groups: readonly TurnGroupOrMessage[],
  liveSnapshots?: ReadonlyMap<string, AgentDelegationSnapshot>,
): ManagedDelegationStopState {
  const latest = new Map<string, DelegationEntry>();
  const visit = (block: DisplayBlock): void => {
    if (block.type === 'delegated_agent_call') {
      const runGeneration = block.runGeneration ?? 1;
      const previous = latest.get(block.delegationId);
      const live = liveSnapshots?.get(block.delegationId);
      if (!previous || runGeneration >= previous.runGeneration) {
        latest.set(block.delegationId, {
          status:
            live !== undefined && (live.runGeneration ?? 1) >= runGeneration
              ? live.status
              : block.status,
          ...(block.parentDelegationId !== undefined
            ? { parentDelegationId: block.parentDelegationId }
            : {}),
          runGeneration,
        });
      }
    }
    if ('subBlocks' in block) block.subBlocks.forEach(visit);
  };
  for (const group of groups) {
    const messages =
      group.kind === 'turn-group' ? group.assistantMessages : [group.message];
    for (const message of messages) message.blocks.forEach(visit);
  }
  const liveDelegationIds: string[] = [];
  const withLiveDescendants = new Set<string>();
  latest.forEach((entry: DelegationEntry, delegationId: string): void => {
    if (!isLiveStatus(entry.status)) return;
    liveDelegationIds.push(delegationId);
    const seen = new Set<string>([delegationId]);
    let parent: string | undefined = entry.parentDelegationId;
    while (parent !== undefined && !seen.has(parent)) {
      withLiveDescendants.add(parent);
      seen.add(parent);
      const parentEntry: DelegationEntry | undefined = latest.get(parent);
      parent = parentEntry?.parentDelegationId;
    }
  });
  return {
    liveDelegationIds,
    withLiveDescendants: Array.from(withLiveDescendants).sort(),
  };
}

/** Every managed delegation a chat's transcript names, at any depth. */
export function selectManagedDelegationIds(
  groups: readonly TurnGroupOrMessage[],
): string[] {
  const ids = new Set<string>();
  const visit = (block: DisplayBlock): void => {
    if (block.type === 'delegated_agent_call') ids.add(block.delegationId);
    if ('subBlocks' in block) block.subBlocks.forEach(visit);
  };
  for (const group of groups) {
    const messages =
      group.kind === 'turn-group' ? group.assistantMessages : [group.message];
    for (const message of messages) message.blocks.forEach(visit);
  }
  return Array.from(ids).sort();
}

function reportStopFailure(
  target: ManagedDelegationChatTarget,
  lead: string,
  detail: string,
): void {
  const message = detail.trim() ? `${lead} ${detail.trim()}` : lead;
  useGitHubStore.getState().addToast(message, 'error', undefined, {
    category: 'Chat',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
  });
}

/**
 * Stops one delegation and the tasks it started, as the user. Resolves
 * `true` when main accepted the stop; a failure raises a notice and resolves
 * `false`.
 */
export async function requestManagedDelegationStop(
  target: ManagedDelegationChatTarget,
  delegationId: string,
): Promise<boolean> {
  if (isWebCoreScope(target.projectId)) {
    const result = await stopCloudDelegation(target, delegationId);
    if (result.ok) return true;
    reportStopFailure(target, DELEGATED_AGENT_STOP_FAILED_LABEL, result.error);
    return false;
  }
  try {
    const result = await window.api.managedDelegation.stop({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      delegationId,
    });
    if (result.ok) return true;
    reportStopFailure(target, DELEGATED_AGENT_STOP_FAILED_LABEL, result.error);
    return false;
  } catch (error: unknown) {
    reportStopFailure(
      target,
      DELEGATED_AGENT_STOP_FAILED_LABEL,
      extractIpcErrorMessage(error),
    );
    return false;
  }
}

/**
 * Stops every live managed delegation in the chat, as the user. Background
 * processes, pipeline runs and native provider subagents are untouched.
 */
export async function requestManagedDelegationStopAll(
  target: ManagedDelegationChatTarget,
): Promise<boolean> {
  if (isWebCoreScope(target.projectId)) {
    const result = await stopAllCloudDelegations(target);
    if (result.ok) return true;
    reportStopFailure(
      target,
      AGENT_ACTIVITY_STOP_ALL_FAILED_LABEL,
      result.error,
    );
    return false;
  }
  try {
    const result = await window.api.managedDelegation.stopAll({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
    });
    if (result.ok) return true;
    reportStopFailure(
      target,
      AGENT_ACTIVITY_STOP_ALL_FAILED_LABEL,
      result.error,
    );
    return false;
  } catch (error: unknown) {
    reportStopFailure(
      target,
      AGENT_ACTIVITY_STOP_ALL_FAILED_LABEL,
      extractIpcErrorMessage(error),
    );
    return false;
  }
}

/**
 * Reads an isolated delegate's changes from its retained worktree for the
 * delegated-task card, which reports a failure itself.
 */
export async function requestManagedDelegationChanges(
  target: ManagedDelegationChatTarget,
  delegationId: string,
  revision: string,
): Promise<DelegationWorkspaceChanges> {
  const result = await window.api.managedDelegation.changes({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    delegationId,
    revision,
  });
  if (!result.ok) throw new Error(result.error);
  return result.changes;
}
