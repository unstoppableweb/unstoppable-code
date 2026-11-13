import { openCodeNativeOperations } from '@canopy/desktop-shared/node/opencode/tool-input';
import type { OpenCodeToolInput } from '@canopy/desktop-shared/node/opencode/runtime';
import type {
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  approvalCheckForClaudeTool,
  guardMappedReadPath,
} from '../agents/claude-approval-adapter';

/**
 * The raw path argument behind a read, read the way
 * `openCodeNativeOperations` reads it: `read` takes `path`, then `filePath`,
 * and `grep`/`glob` take `path` or search the cwd. Conflicting keys, or a key
 * the mapper ignores for that tool, yield a non-string so the read prompts.
 */
function openCodeRawPaths(
  toolName: string,
  args: Record<string, unknown>,
): unknown[] {
  const { path, filePath } = args;
  if (toolName === 'read') {
    if (path !== undefined && filePath !== undefined && path !== filePath)
      return [null];
    return [path ?? filePath];
  }
  if (filePath !== undefined) return [null];
  return path === undefined ? [] : [path];
}

export async function authorizeOpenCodeNativeTool(
  input: OpenCodeToolInput,
  context: {
    cwd: string;
    approval: ApprovalSessionHandle;
    planMode: boolean;
    signal: AbortSignal;
    toolUseId: string;
  },
): Promise<ApprovalOutcome> {
  if (context.signal.aborted) return { decision: 'deny' };
  if (input.toolName === 'todowrite' || input.toolName === 'todoread')
    return { decision: 'allow' };
  const operations = openCodeNativeOperations(
    input.toolName,
    input.toolArgs,
    context.cwd,
  );
  if (!operations?.length)
    return {
      decision: 'deny',
      message:
        'This OpenCode tool is not supported. Use the supplied app tools.',
    };
  for (const operation of operations) {
    if (context.planMode && operation.mutates)
      return { decision: 'deny', message: 'Plan mode allows read-only tools.' };
    const operationCwd =
      operation.tool === 'Bash' && typeof operation.input.cwd === 'string'
        ? operation.input.cwd
        : context.cwd;
    // The native schema has no enforceable domain filter. Broad-grant semantics
    // preserve every narrower network denial, including in Full Access.
    const normalized: ReturnType<typeof approvalCheckForClaudeTool> =
      operation.tool === 'WebSearch'
        ? {
            check: { kind: 'network', host: '*', isGrant: true },
            details: {
              kind: 'network',
              host: '*',
              reason: 'OpenCode web search chooses its own domains.',
            },
            suggestedTarget: { kind: 'network', host: '*' },
          }
        : // The mapper already resolved the native path, so judge the raw one.
          guardMappedReadPath(
            approvalCheckForClaudeTool(
              operation.tool,
              operation.input,
              operationCwd,
            ),
            openCodeRawPaths(input.toolName, input.toolArgs),
          );
    if (normalized.failClosedReason)
      return { decision: 'deny', message: normalized.failClosedReason };
    for (const requirement of [
      normalized,
      ...(normalized.additionalRequirements ?? []),
    ]) {
      if (context.signal.aborted) return { decision: 'deny' };
      const outcome = await context.approval.check(requirement.check, {
        title: `OpenCode wants to use ${operation.tool}`,
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
