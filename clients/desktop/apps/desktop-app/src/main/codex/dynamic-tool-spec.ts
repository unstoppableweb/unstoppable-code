import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import type { DynamicToolFunctionSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolFunctionSpec';

export type CodexFunctionToolSpec = DynamicToolSpec & { type: 'function' };

export function defineCodexFunctionToolSpec(
  spec: DynamicToolFunctionSpec,
): CodexFunctionToolSpec {
  return {
    type: 'function',
    ...spec,
  };
}
