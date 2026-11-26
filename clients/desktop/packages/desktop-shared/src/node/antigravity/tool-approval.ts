import type { ApprovalRule } from '../../types';
import { isAbsolute } from 'node:path';
import {
  FAIL_CLOSED_MESSAGE,
  POLICY_DENIED_FALLBACK_MESSAGE,
} from '@canopy/protocol/approvals';
import type { AcpPermissionRequest } from '@canopy/desktop-shared/node/acp';
import type { NativeToolApprovalPort } from '../approvals/native-tool-port';
import { approvalCheckForClaudeTool } from '../approvals/tool-checks';
import { writesAntigravityExecutableConfiguration } from './workspace-configuration';

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
  // Never approve one alias while the native tool executes another. Missing
  // aliases are fine; supplied aliases must identify the exact same path.
  const paths = [raw.Path, raw.TargetFile, raw.AbsolutePath].filter(
    (value) => value !== undefined,
  );
  const path = paths[0];
  if (
    (name === 'read_file' || name === 'write_file') &&
    paths.some((value) => typeof value !== 'string' || value !== path)
  )
    return undefined;
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

/**
 * Whether a permission request is for a tool on one of the turn's host-routed
 * MCP servers (`mcp_<server>_<tool>`, the approval hook's rule). Antigravity
 * 1.5.14 asks ACP permission for MCP calls, which 1.5.1 ran without asking.
 * Every routed server authorizes each call in the host immediately before
 * execution, so this request is answered without a second approval. As in the
 * hook, a server name may contain `_`; that is safe only because no unrouted
 * server can be present (see antigravityToolGateHeader in runtime.ts).
 */
export function isRoutedAntigravityMcpCall(
  request: AcpPermissionRequest,
  routedServers: readonly string[],
): boolean {
  const call = request.request.toolCall;
  const name =
    'name' in call && typeof call.name === 'string' ? call.name : undefined;
  if (
    !name ||
    Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  return routedServers.some(
    (server) =>
      /^[A-Za-z0-9_-]+$/.test(server) &&
      name.startsWith(`mcp_${server}_`) &&
      name.length > `mcp_${server}_`.length,
  );
}

/** Plan mode refuses every mutating native call without a prompt. */
export const ANTIGRAVITY_PLAN_MODE_DENIED_MESSAGE =
  'Plan mode is read-only; the command was not run.';

/**
 * The decision and, for a denial, the text the transcript shows as the tool's
 * result. ACP's permission reply carries only an option id, so this text never
 * reaches the model; the host renders it in place of the runtime's empty one.
 */
export interface AntigravityToolAuthorization {
  decision: 'allow' | 'deny';
  message?: string;
}

interface AntigravityAuthorizationContext {
  approval: NativeToolApprovalPort;
  cwd: string;
  planMode: boolean;
  stopTurn: () => void;
}

/** Unknown native operations remain denied until their effects have a policy mapping. */
export async function authorizeAntigravityToolCall(
  request: AcpPermissionRequest,
  context: AntigravityAuthorizationContext,
): Promise<AntigravityToolAuthorization> {
  if (request.signal.aborted) return { decision: 'deny' };
  const call = request.request.toolCall;
  const operation = antigravityNativeOperation(request);
  if (!operation)
    return { decision: 'deny', message: POLICY_DENIED_FALLBACK_MESSAGE };
  if (context.planMode && operation.mutates)
    return { decision: 'deny', message: ANTIGRAVITY_PLAN_MODE_DENIED_MESSAGE };
  if (await writesAntigravityExecutableConfiguration(operation, context.cwd))
    return { decision: 'deny', message: POLICY_DENIED_FALLBACK_MESSAGE };
  const normalized = approvalCheckForClaudeTool(
    operation.tool,
    operation.input,
    operation.tool === 'Bash' && typeof operation.input.cwd === 'string'
      ? operation.input.cwd
      : context.cwd,
  );
  if (normalized.failClosedReason)
    return { decision: 'deny', message: FAIL_CLOSED_MESSAGE };
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
    const denied = {
      decision: 'deny' as const,
      message: outcome.message ?? POLICY_DENIED_FALLBACK_MESSAGE,
    };
    if (outcome.stopTurn) {
      context.stopTurn();
      return denied;
    }
    if (request.signal.aborted) return { decision: 'deny' };
    if (outcome.decision !== 'allow') return denied;
  }
  return { decision: 'allow' };
}

/** The bare decision, for callers that render no denial text. */
export async function authorizeAntigravityTool(
  request: AcpPermissionRequest,
  context: AntigravityAuthorizationContext,
): Promise<'allow' | 'deny'> {
  return (await authorizeAntigravityToolCall(request, context)).decision;
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
