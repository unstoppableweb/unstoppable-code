import type { PermissionPreset } from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import type { OpenCodeToolInput } from './runtime';
import type { CursorHookOutcome } from '../cursor/hook-transport';
import { openCodeNativeOperations } from './tool-input';

export function headlessOpenCodeDecision(
  preset: PermissionPreset,
  input: OpenCodeToolInput,
  cwd: string,
): CursorHookOutcome {
  if (preset === 'none')
    return { decision: 'deny', message: 'This step runs with no tools.' };
  if (preset !== 'dangerous_all' && preset !== 'read_only' && preset !== 'plan')
    return { decision: 'deny' };
  const operations = openCodeNativeOperations(
    input.toolName,
    input.toolArgs,
    cwd,
  );
  if (!operations?.length)
    return {
      decision: 'deny',
      message: 'This tool is unavailable in unattended OpenCode steps.',
    };
  return {
    decision:
      preset === 'dangerous_all' ||
      operations.every(
        (operation) =>
          !operation.mutates &&
          (preset === 'plan' ||
            (operation.tool !== 'WebFetch' && operation.tool !== 'WebSearch')),
      )
        ? 'allow'
        : 'deny',
  };
}
