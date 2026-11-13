import type { PermissionPreset } from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import type {
  CopilotPreToolInput,
  CopilotToolDecision,
} from '@canopy/copilot-recipient/session-policy';
import {
  copilotNativeOperations,
  isCopilotShellControl,
} from '@canopy/copilot-recipient/tool-input';

export function headlessCopilotDecision(
  preset: PermissionPreset,
  input: CopilotPreToolInput,
  cwd: string,
): CopilotToolDecision {
  if (preset === 'none')
    return { decision: 'deny', message: 'This step runs with no tools.' };
  if (preset !== 'dangerous_all' && preset !== 'read_only' && preset !== 'plan')
    return { decision: 'deny' };
  if (isCopilotShellControl(input.toolName, input.toolArgs))
    return { decision: 'allow' };
  const operations = copilotNativeOperations(
    input.toolName,
    input.toolArgs,
    cwd,
  );
  if (!operations?.length)
    return {
      decision: 'deny',
      message: 'This tool is unavailable in unattended Copilot steps.',
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
