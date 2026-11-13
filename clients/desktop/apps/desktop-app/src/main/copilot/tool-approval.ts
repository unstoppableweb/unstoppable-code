import {
  copilotNativeOperations,
  isCopilotShellControl,
} from '@canopy/copilot-recipient/tool-input';
import type { CopilotPreToolInput } from '@canopy/copilot-recipient/session-policy';
import type {
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  approvalCheckForClaudeTool,
  guardMappedReadPath,
} from '../agents/claude-approval-adapter';

/**
 * The raw path argument behind operation `index`, read the way
 * `copilotNativeOperations` reads it: `view` targets `path`, and
 * `grep`/`glob` map one operation per `paths` entry or search the cwd. A key
 * the mapper ignores for that tool yields a non-string, so the read prompts
 * rather than being judged by an argument the check does not cover.
 */
function copilotRawPaths(
  toolName: string,
  args: unknown,
  index: number,
): unknown[] {
  if (typeof args !== 'object' || args === null) return [];
  const path: unknown = Reflect.get(args, 'path');
  const paths: unknown = Reflect.get(args, 'paths');
  if (toolName === 'view') return paths === undefined ? [path] : [null];
  if (paths !== undefined)
    return [
      path === undefined ? (Array.isArray(paths) ? paths[index] : paths) : null,
    ];
  return path === undefined ? [] : [null];
}

export async function authorizeCopilotNativeTool(
  input: CopilotPreToolInput,
  context: {
    cwd: string;
    approval: ApprovalSessionHandle;
    planMode: boolean;
    signal: AbortSignal;
    toolUseId: string;
  },
): Promise<ApprovalOutcome> {
  if (context.signal.aborted) return { decision: 'deny' };
  if (input.toolName === 'ask_user') return { decision: 'allow' };
  if (isCopilotShellControl(input.toolName, input.toolArgs))
    return { decision: 'allow' };
  const operations = copilotNativeOperations(
    input.toolName,
    input.toolArgs,
    context.cwd,
  );
  if (!operations?.length)
    return { decision: 'deny', message: 'This Copilot tool is not supported.' };
  for (const [index, operation] of operations.entries()) {
    if (context.planMode && operation.mutates)
      return { decision: 'deny', message: 'Plan mode allows read-only tools.' };
    // The mapper already resolved the native path, so judge the raw one.
    const normalized = guardMappedReadPath(
      approvalCheckForClaudeTool(operation.tool, operation.input, context.cwd),
      copilotRawPaths(input.toolName, input.toolArgs, index),
    );
    if (normalized.failClosedReason)
      return { decision: 'deny', message: normalized.failClosedReason };
    for (const requirement of [
      normalized,
      ...(normalized.additionalRequirements ?? []),
    ]) {
      if (context.signal.aborted) return { decision: 'deny' };
      const outcome = await context.approval.check(requirement.check, {
        title: `Copilot wants to use ${operation.tool}`,
        details: requirement.details,
        suggestedTarget: requirement.suggestedTarget,
        toolUseId: context.toolUseId,
      });
      if (context.signal.aborted) return { decision: 'deny' };
      if (outcome.decision !== 'allow' || outcome.stopTurn) return outcome;
    }
  }
  return { decision: 'allow' };
}
