import { resolve } from 'node:path';
import type { ApprovalSessionHandle } from '../approvals/approval-service';
import {
  createCursorHookTransport,
  type CursorHookTransport,
} from '@canopy/desktop-shared/node/cursor/hook-transport';
export { CURSOR_HOOK_SCRIPT as CURSOR_CHECK_HOOK_SCRIPT } from '@canopy/desktop-shared/node/cursor/hook-transport';

export const CURSOR_CHECK_CONTENT = 'CURSOR_APPROVAL_OK\n';
export interface CursorCheckHook extends CursorHookTransport {
  sawWrite(): boolean;
  writeDecision(): 'allow' | 'deny' | undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The existing check intentionally retains its one-file authority. */
export async function createCursorCheckHook(
  approval: ApprovalSessionHandle,
  filePath: string,
): Promise<CursorCheckHook> {
  let active = true;
  let sawWrite = false;
  let writeDecision: 'allow' | 'deny' | undefined;
  const transport = await createCursorHookTransport(
    async (payload) => {
      if (
        !isRecord(payload) ||
        payload.hook_event_name !== 'preToolUse' ||
        !isRecord(payload.tool_input) ||
        typeof payload.tool_input.file_path !== 'string' ||
        resolve(payload.tool_input.file_path) !== filePath ||
        typeof payload.tool_use_id !== 'string' ||
        payload.tool_use_id.length > 4096
      )
        return { decision: 'deny' };
      const isWrite = payload.tool_name === 'Write';
      if (
        (!isWrite && payload.tool_name !== 'Read') ||
        (isWrite &&
          (typeof payload.tool_input.content !== 'string' ||
            payload.tool_input.content.trim() !== CURSOR_CHECK_CONTENT.trim()))
      )
        return { decision: 'deny' };
      if (isWrite) sawWrite = true;
      const decision = await approval.check(
        isWrite
          ? { kind: 'file-write', path: filePath }
          : { kind: 'tool', toolName: 'Read' },
        {
          title: isWrite
            ? 'Cursor wants to create the test file'
            : 'Cursor wants to read the test file',
          description: isWrite
            ? 'Creates one file in the temporary check project.'
            : undefined,
          details: isWrite
            ? { kind: 'file-write', path: filePath }
            : { kind: 'tool', toolName: 'Read', path: filePath },
          toolUseId: payload.tool_use_id,
        },
      );
      if (isWrite) writeDecision = active ? decision.decision : 'deny';
      return decision;
    },
    () => {
      active = false;
      approval.invalidatePending?.();
      approval.dispose();
    },
    // Its one Write carries only CURSOR_CHECK_CONTENT.
    { maxRequestBytes: 64 * 1024 },
  );
  return {
    ...transport,
    sawWrite: (): boolean => sawWrite,
    writeDecision: (): 'allow' | 'deny' | undefined => writeDecision,
  };
}
