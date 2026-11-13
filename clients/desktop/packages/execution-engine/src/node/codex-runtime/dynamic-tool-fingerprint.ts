import { createHash } from 'node:crypto';
import type { JsonValue } from './generated/serde_json/JsonValue';
import type { DynamicToolFunctionSpec } from './generated/v2/DynamicToolFunctionSpec';
import type { DynamicToolSpec } from './generated/v2/DynamicToolSpec';

export interface DynamicToolAvailabilityPolicy {
  [toolName: string]: JsonValue;
}

function stableJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJson(nested ?? null)]),
    );
  }
  return value;
}

function normalizeFunction(tool: DynamicToolFunctionSpec): {
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading: boolean;
} {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: stableJson(tool.inputSchema),
    deferLoading: tool.deferLoading === true,
  };
}

export function dynamicToolSetId(
  tools: DynamicToolSpec[],
  availabilityPolicy: DynamicToolAvailabilityPolicy = {},
): string {
  const normalizedTools = tools
    .map((tool) =>
      tool.type === 'function'
        ? { type: 'function', ...normalizeFunction(tool) }
        : {
            type: 'namespace',
            name: tool.name,
            description: tool.description,
            tools: tool.tools
              .map(normalizeFunction)
              .sort((left, right) => left.name.localeCompare(right.name)),
          },
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const normalizedPolicy = Object.fromEntries(
    Object.entries(availabilityPolicy)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, policy]) => [name, stableJson(policy)]),
  );
  return createHash('sha256')
    .update(
      JSON.stringify({ tools: normalizedTools, policy: normalizedPolicy }),
    )
    .digest('hex');
}
