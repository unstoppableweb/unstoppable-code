import type { ApprovalRule } from '../../types';
import { isAbsolute } from 'node:path';
import type { AcpPermissionRequest } from '@canopy/desktop-shared/node/acp';
import type { NativeToolApprovalPort } from '../approvals/native-tool-port';
import { approvalCheckForClaudeTool } from '../approvals/tool-checks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface AntigravityNativeOperation {
  tool: string;
  input: Record<string, unknown>;
  mutates: boolean;
}

export function antigravityNativeOperation(
  request: AcpPermissionRequest,
): AntigravityNativeOperation | undefined {
  const call = request.request.toolCall;
  const name =
    'name' in call && typeof call.name === 'string' ? call.name : undefined;
  const raw = call.rawInput;
  if (!isRecord(raw)) return undefined;
  let operation: AntigravityNativeOperation | undefined;
  const path = raw.Path ?? raw.TargetFile ?? raw.AbsolutePath;
  if (name === 'read_file' && call.kind === 'read' && typeof path === 'string')
    operation = { tool: 'Read', input: { file_path: path }, mutates: false };
  if (
    name === 'write_file' &&
    call.kind === 'edit' &&
    typeof path === 'string' &&
    typeof raw.Content === 'string'
  )
    operation = {
      tool: 'Write',
      input: {
        file_path: path,
        content: typeof raw.Content === 'string' ? raw.Content : '',
      },
      mutates: true,
    };
  if (
    name === 'run_command' &&
    call.kind === 'execute' &&
    typeof raw.CommandLine === 'string' &&
    (raw.Cwd === undefined ||
      (typeof raw.Cwd === 'string' && isAbsolute(raw.Cwd)))
  )
    operation = {
      tool: 'Bash',
      input: { command: raw.CommandLine, cwd: raw.Cwd },
      mutates: true,
    };
  return operation;
}

/** Unknown native operations remain denied until their effects have a policy mapping. */
export async function authorizeAntigravityTool(
  request: AcpPermissionRequest,
  context: {
    approval: NativeToolApprovalPort;
    cwd: string;
    planMode: boolean;
    stopTurn: () => void;
  },
): Promise<'allow' | 'deny'> {
  if (request.signal.aborted) return 'deny';
  const call = request.request.toolCall;
  const operation = antigravityNativeOperation(request);
  if (!operation || (context.planMode && operation.mutates)) return 'deny';
  const normalized = approvalCheckForClaudeTool(
    operation.tool,
    operation.input,
    operation.tool === 'Bash' && typeof operation.input.cwd === 'string'
      ? operation.input.cwd
      : context.cwd,
  );
  if (normalized.failClosedReason) return 'deny';
  if (
    operation.tool === 'Read' &&
    typeof operation.input.file_path === 'string'
  ) {
    normalized.details = {
      kind: 'tool',
      toolName: 'Read',
      inputSummary: operation.input.file_path,
    };
  }
  for (const requirement of [
    normalized,
    ...(normalized.additionalRequirements ?? []),
  ]) {
    const outcome = await context.approval.check(requirement.check, {
      title: `Google wants to use ${operation.tool}`,
      details: requirement.details,
      suggestedTarget: requirement.suggestedTarget,
      toolUseId: call.toolCallId,
      signal: request.signal,
    });
    if (outcome.stopTurn) {
      context.stopTurn();
      return 'deny';
    }
    if (request.signal.aborted || outcome.decision !== 'allow') return 'deny';
  }
  return 'allow';
}

export function antigravityReadRules(preset: string): ApprovalRule[] {
  return preset === 'read_only' || preset === 'plan'
    ? [
        {
          id: 'antigravity-workflow-read',
          behavior: 'allow',
          target: { kind: 'tool', toolName: 'Read' },
          origin: 'settings',
          createdAt: new Date().toISOString(),
        },
      ]
    : [];
}
