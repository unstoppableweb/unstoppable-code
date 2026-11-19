import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';
import type { TurnFileRecord } from '@canopy/protocol/turn-files';
import { collectTurnFiles, type TurnFileBlock } from './turn-files';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultOf(value: unknown): TurnFileBlock['result'] {
  if (!record(value) || typeof value.isError !== 'boolean') return undefined;
  return {
    output: typeof value.output === 'string' ? value.output : '',
    isError: value.isError,
  };
}

/** Core's cloud file tools use lower-case names and a filePath argument. */
function toolInput(
  toolName: string,
  input: unknown,
): { toolName: string; input: string } {
  if (toolName === 'edit' || toolName === 'write') {
    let value: unknown = input;
    if (typeof input === 'string') {
      try {
        value = JSON.parse(input);
      } catch {
        value = undefined;
      }
    }
    return {
      toolName: toolName === 'edit' ? 'Edit' : 'Write',
      input: JSON.stringify(
        record(value)
          ? {
              ...value,
              file_path: value.filePath ?? value.file_path ?? value.path,
            }
          : {},
      ),
    };
  }
  return {
    toolName,
    input: typeof input === 'string' ? input : JSON.stringify(input),
  };
}

/** Host projection for both live cloud parts and reloaded Portal transcripts. */
export function collectRemoteControlTurnFiles(
  messages: readonly RemoteControlChatMessage[],
  retained: readonly TurnFileRecord[] = [],
): TurnFileRecord[] {
  const results = new Map<string, NonNullable<TurnFileBlock['result']>>();
  for (const message of messages) {
    if (message.role === 'user') continue;
    for (const part of message.parts ?? []) {
      if (part.kind !== 'tool_result' || !record(part.data)) continue;
      const result = resultOf(part.data);
      if (typeof part.data.toolUseId === 'string' && result)
        results.set(part.data.toolUseId, result);
    }
  }
  return collectTurnFiles(
    messages.map((message) => ({
      id: message.messageId,
      role: message.role,
      blocks: (message.parts ?? []).flatMap((part): TurnFileBlock[] => {
        if (part.kind !== 'tool_use' || !record(part.data)) return [];
        const data = part.data;
        if (typeof data.toolName !== 'string' || data.input === undefined)
          return [];
        const result =
          (typeof data.toolUseId === 'string'
            ? results.get(data.toolUseId)
            : undefined) ?? resultOf(data.result);
        return [
          {
            type: 'tool_use',
            ...(typeof data.toolUseId === 'string'
              ? { toolUseId: data.toolUseId }
              : {}),
            ...toolInput(data.toolName, data.input),
            ...(result ? { result } : {}),
          },
        ];
      }),
    })),
    retained,
  );
}
