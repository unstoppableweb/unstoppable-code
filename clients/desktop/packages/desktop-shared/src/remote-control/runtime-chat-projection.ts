/**
 * Desktop binding of the runtime chat projection, which lives in the
 * browser-safe `@canopy/agent-transcript` package so the portable CanopyClient
 * adapter shares it. These wrappers inject the desktop's full
 * `getRemoteControlChatToolFamily` resolver, so desktop output is unchanged and
 * existing importers keep this path.
 */
import {
  createCursorAssistantPatchProjector as createCursorAssistantPatchProjectorCore,
  runtimeChatEventToRemoteControlMessage as runtimeChatEventToRemoteControlMessageCore,
  type CursorAssistantPatchProjector,
  type RuntimeChatProjectionInput,
} from '@canopy/agent-transcript/remote-control/runtime-chat-projection';
import { isVisiblePersistedChatMessage } from '@canopy/agent-transcript';
import {
  chatTurnTimerId,
  type ChatTurnEffect,
} from '@canopy/agent-transcript/turn';
import type {
  RemoteControlChatMessage,
  RemoteControlTurnTimerEndReason,
} from '@canopy/protocol/remote-control/shell';
import type { PersistedChatMessage } from '../types';
import { getRemoteControlChatToolFamily } from '../lib/remote-control-tool-family';
import {
  isRecord,
  persistedMessageToRemoteControlMessage,
  turnTimerAutoRoutedModelData,
} from './persisted-chat-projection';

export {
  isCursorAssistantPatchEvent,
  isTerminalRuntimeChatEvent,
  type CursorAssistantPatchProjector,
  type RuntimeChatProjectionInput,
  type RuntimeToolAdmission,
} from '@canopy/agent-transcript/remote-control/runtime-chat-projection';

export function runtimeChatEventToRemoteControlMessage(
  input: RuntimeChatProjectionInput,
): RemoteControlChatMessage | null {
  return runtimeChatEventToRemoteControlMessageCore({
    ...input,
    toolFamilyFor: getRemoteControlChatToolFamily,
  });
}

export function createCursorAssistantPatchProjector(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatId: string;
}): CursorAssistantPatchProjector {
  return createCursorAssistantPatchProjectorCore({
    ...input,
    toolFamilyFor: getRemoteControlChatToolFamily,
  });
}

/**
 * Project the canonical turn timers one acknowledged state commit touched, in
 * effect order and once per timer. Rows come only from the committed timer
 * messages and keep their persisted `chatTurnTimerId(T)` id, so live and
 * snapshot rows share one id. A timer effect without a committed row for the
 * same turn projects nothing; the host reports it. A turn Auto routed carries
 * its model chip (turn-state phase 43f): `autoRoutedModels` is the tab's map
 * of user message id to model, and the timer block names its user message.
 */
export function projectCanonicalRemoteControlTurnTimers(input: {
  scope: 'worktree' | 'standalone' | 'app_advisor';
  chatId: string;
  effects: readonly ChatTurnEffect[];
  timerMessages: readonly PersistedChatMessage[];
  autoRoutedModels?: Readonly<Record<string, string>>;
}): RemoteControlChatMessage[] {
  const endReasons = new Map<string, RemoteControlTurnTimerEndReason>();
  for (const effect of input.effects) {
    if (effect.type === 'turn.ended' && effect.outcome !== 'completed') {
      endReasons.set(effect.turnId, effect.outcome);
    }
  }
  const seen = new Set<string>();
  const rows: RemoteControlChatMessage[] = [];
  const project = (row: PersistedChatMessage, turnId: string): void => {
    const isTimer = (block: PersistedChatMessage['blocks'][number]): boolean =>
      block.type === 'turn_timer' && block.turnId === turnId;
    if (!row.blocks.some(isTimer) || !isVisiblePersistedChatMessage(row))
      return;
    const timer = row.blocks.find(isTimer);
    const message = persistedMessageToRemoteControlMessage(
      { scope: input.scope, chatId: input.chatId, message: row },
      { includeInFlightTurnTimers: true },
    );
    const endReason = endReasons.get(turnId);
    const routed = turnTimerAutoRoutedModelData(
      input.autoRoutedModels,
      timer?.type === 'turn_timer' ? timer.userMessageId : undefined,
    );
    rows.push(
      endReason === undefined && routed === undefined
        ? message
        : {
            ...message,
            parts: message.parts?.map((part) =>
              part.kind === 'turn_timer' && isRecord(part.data)
                ? {
                    ...part,
                    data: {
                      ...part.data,
                      ...routed,
                      ...(endReason === undefined ? {} : { endReason }),
                    },
                  }
                : part,
            ),
          },
    );
  };
  for (const effect of input.effects) {
    if (!('timerId' in effect) || seen.has(effect.timerId)) continue;
    seen.add(effect.timerId);
    const row = input.timerMessages.find(
      (message) => message.id === effect.timerId,
    );
    if (row) project(row, effect.turnId);
  }
  // A binding alone can rewrite a row's anchor or wake cause, with no effect.
  for (const row of input.timerMessages) {
    if (seen.has(row.id)) continue;
    const timer = row.blocks.find((block) => block.type === 'turn_timer');
    if (
      timer?.type !== 'turn_timer' ||
      timer.turnId === undefined ||
      row.id !== chatTurnTimerId(timer.turnId)
    )
      continue;
    seen.add(row.id);
    project(row, timer.turnId);
  }
  return rows;
}
