/**
 * The desktop host's subagent commands: thin wrappers over the typed
 * managed-delegation and native-subagent IPC that map each result onto the
 * shared viewer's result types. Every IPC rejection becomes a readable
 * `{ ok: false }`; nothing here throws.
 */
import {
  isNativeSubagentKind,
  nativeSubagentInterruptSupported,
} from '@canopy/agent-transcript';
import type { ManagedDelegationWorktreeSummary } from '@canopy/desktop-shared/types';
import type { SubagentNode, SubagentWorktreeSummary } from '@canopy/ui-shared';
import type {
  SubagentCommandResult,
  SubagentMessageRequest,
  SubagentMessageResult,
  SubagentNativeInterruptResult,
} from '@canopy/ui-app/subagents';
import { extractIpcErrorMessage } from '@/lib/errors';
import type { SubagentHostScope } from './subagent-scope';

/** Shown when a command names a subagent kind the host cannot act on. */
export const SUBAGENT_COMMAND_UNSUPPORTED_ERROR =
  "This subagent doesn't support that.";

/** Stops the provider task backing one Claude Code workflow run. */
export async function stopWorkflowRun(
  scope: SubagentHostScope,
  rootChatId: string,
  run: { readonly taskId?: string },
): Promise<SubagentCommandResult> {
  if (!run.taskId) {
    return { ok: false, error: 'This workflow run cannot be stopped.' };
  }
  try {
    const outcome = await window.api.activity.stopBgProcess({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: rootChatId,
      taskId: run.taskId,
    });
    return outcome === 'stopped'
      ? { ok: true }
      : { ok: false, error: 'This workflow run is no longer running.' };
  } catch (error: unknown) {
    return { ok: false, error: extractIpcErrorMessage(error) };
  }
}

/** Stops a live managed delegation and everything it started (D24). */
export async function stopSubagent(
  scope: SubagentHostScope,
  rootChatId: string,
  node: Pick<SubagentNode, 'id' | 'kind'>,
): Promise<SubagentCommandResult> {
  if (node.kind !== 'managed') {
    return { ok: false, error: SUBAGENT_COMMAND_UNSUPPORTED_ERROR };
  }
  try {
    const result = await window.api.managedDelegation.stop({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: rootChatId,
      delegationId: node.id,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (error: unknown) {
    return { ok: false, error: extractIpcErrorMessage(error) };
  }
}

/** Sends a follow-up, steer or interrupt to one managed delegate (D21, D22). */
export async function messageManagedSubagent(
  scope: SubagentHostScope,
  rootChatId: string,
  delegationId: string,
  request: SubagentMessageRequest,
): Promise<SubagentMessageResult> {
  try {
    const result = await window.api.managedDelegation.message({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: rootChatId,
      delegationId,
      operation: request.operation,
      ...(request.message !== undefined ? { message: request.message } : {}),
      operationId: request.operationId,
    });
    return result.ok
      ? { ok: true }
      : { ok: false, code: result.code, error: result.error };
  } catch (error: unknown) {
    return { ok: false, code: 'failed', error: extractIpcErrorMessage(error) };
  }
}

/**
 * Interrupts a native subagent's current run (D26). Only kinds the shared
 * rule allows (`nativeSubagentInterruptSupported`; Claude Task agents today)
 * reach main; any other kind is refused here without a round trip.
 */
export async function interruptNativeSubagent(
  scope: SubagentHostScope,
  rootChatId: string,
  node: Pick<SubagentNode, 'id' | 'kind'>,
): Promise<SubagentNativeInterruptResult> {
  if (
    !isNativeSubagentKind(node.kind) ||
    !nativeSubagentInterruptSupported(node.kind)
  ) {
    return {
      ok: false,
      code: 'unsupported',
      error: SUBAGENT_COMMAND_UNSUPPORTED_ERROR,
    };
  }
  try {
    const result = await window.api.nativeSubagents.interrupt({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: rootChatId,
      subagentKind: node.kind,
      subagentId: node.id,
    });
    return result.ok
      ? { ok: true }
      : { ok: false, code: result.code, error: result.error };
  } catch (error: unknown) {
    return { ok: false, code: 'failed', error: extractIpcErrorMessage(error) };
  }
}

/** Maps main's worktree summary onto the shared display type (D18). */
export function mapSubagentWorktreeSummary(
  summary: ManagedDelegationWorktreeSummary,
): SubagentWorktreeSummary {
  return {
    checkout: summary.checkout,
    startingRevision: summary.startingRevision,
    ...(summary.startingSubject !== undefined
      ? { startingSubject: summary.startingSubject }
      : {}),
    ...(summary.startingBranch !== undefined
      ? { startingBranch: summary.startingBranch }
      : {}),
    filesChanged: summary.filesChanged,
    additions: summary.additions,
    deletions: summary.deletions,
    commitsAhead: summary.commitsAhead,
    untrackedFiles: summary.untrackedFiles,
    applyState: summary.applyState,
    topFiles: summary.topFiles.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
    })),
    truncated: summary.truncated,
  };
}

export type SubagentWorktreeSummaryReadResult =
  | { readonly ok: true; readonly summary: SubagentWorktreeSummary }
  | { readonly ok: false; readonly error: string };

/**
 * Reads an isolated delegate's worktree summary. `revision` must be the
 * delegate's recorded starting revision (`snapshot.isolatedWorkspace.revision`,
 * the tree node's `isolatedRevision`).
 */
export async function readSubagentWorktreeSummary(
  scope: SubagentHostScope,
  delegationId: string,
  revision: string,
): Promise<SubagentWorktreeSummaryReadResult> {
  try {
    const result = await window.api.managedDelegation.worktreeSummary({
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      delegationId,
      revision,
    });
    return result.ok
      ? { ok: true, summary: mapSubagentWorktreeSummary(result.summary) }
      : { ok: false, error: result.error };
  } catch (error: unknown) {
    return { ok: false, error: extractIpcErrorMessage(error) };
  }
}
