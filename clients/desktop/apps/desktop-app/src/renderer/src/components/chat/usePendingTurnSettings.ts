import { useEffect, useRef, useState } from 'react';
import type { ChatActiveSessionInfo } from '@canopy/desktop-shared/types';
import {
  pendingTurnSettings,
  type PendingTurnSettings,
} from '@canopy/ui-shared/components';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { chatBackendFor } from '@/stores/chat/backend';

/** Re-reads while the session has not yet registered the turn's settings. */
const SETTINGS_RETRY_DELAY_MS = 1_500;
const SETTINGS_RETRY_LIMIT = 3;

/**
 * The composer's view of a model or thinking-level change made while a turn
 * runs on a session that applies setters only from its next turn (OpenCode).
 * Main owns the facts: the session's declaration and the running turn's
 * settings travel on `ChatActiveSessionInfo`, so this reads that info when a
 * turn starts and again after each selection change during it, and compares
 * it with the composer's current selection. Nothing is read between turns,
 * and a failed read reports nothing pending rather than guessing.
 */
export function usePendingTurnSettings(input: {
  readonly projectId: string | undefined;
  readonly worktreeId: string | undefined;
  readonly chatId: string | undefined;
  readonly turnActive: boolean;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  /** The levels the chat's route declares, for the same clamp the session applies. */
  readonly supportedThinkingLevels?: readonly string[];
}): PendingTurnSettings | null {
  const {
    projectId,
    worktreeId,
    chatId,
    turnActive,
    model,
    thinkingLevel,
    supportedThinkingLevels,
  } = input;
  const [session, setSession] = useState<ChatActiveSessionInfo | undefined>();
  // A session registers the turn's settings only after its first awaits, so
  // a read that lands before them is repeated a bounded number of times. The
  // count belongs to one selection: a new selection reads once, afresh.
  const [tick, setTick] = useState(0);
  const retries = useRef({ key: '', count: 0 });
  useEffect(() => {
    if (!turnActive || !projectId || !worktreeId || !chatId) {
      setSession(undefined);
      return;
    }
    const key = [projectId, worktreeId, chatId, model, thinkingLevel].join(
      '\u0000',
    );
    if (retries.current.key !== key) retries.current = { key, count: 0 };
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void chatBackendFor({ projectId })
      .chat.activeSessions({ projectId, worktreeId })
      .then((active) => {
        if (cancelled) return;
        const found = (active.sessions ?? []).find(
          (entry) => entry.chatId === chatId,
        );
        setSession(found);
        const settingsPending =
          found === undefined ||
          (found.settingApplication !== undefined &&
            found.turnSettings === undefined);
        if (settingsPending && retries.current.count < SETTINGS_RETRY_LIMIT) {
          retries.current.count += 1;
          timer = setTimeout(() => {
            if (!cancelled) setTick((count) => count + 1);
          }, SETTINGS_RETRY_DELAY_MS);
        }
      })
      .catch((error: unknown) => {
        // A failed read reports nothing pending; the failure itself is
        // recorded, not surfaced, since the composer stays usable.
        reportClientAppError(error);
        if (!cancelled) setSession(undefined);
      });
    return (): void => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // Re-read when the selection changes mid-turn: the running turn's settings
    // are fixed, but a session may only register them once the turn starts.
  }, [projectId, worktreeId, chatId, turnActive, model, thinkingLevel, tick]);
  return pendingTurnSettings({
    turnActive,
    ...(session?.settingApplication
      ? { settingApplication: session.settingApplication }
      : {}),
    ...(session?.turnSettings ? { turnSettings: session.turnSettings } : {}),
    selected: {
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    },
    ...(supportedThinkingLevels === undefined
      ? {}
      : { supportedThinkingLevels }),
  });
}
