import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import { toAppError } from '@canopy/protocol/app-errors';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  listWebCoreChatSecrets,
  revokeWebCoreChatSecret,
} from '@/stores/chat/web-core';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import type { ComposerAgentSecrets } from './useChatAgentSecrets';

/*
 * A cloud chat's held agent secrets for the composer's Secrets chip (agent
 * secret requests, U5 on desktop): names and dates only, read over the web
 * core (`core.chat.secret.list`) and revoked there (`core.chat.secret.revoke`),
 * as the web cloud chat's chip does. Cloud chats have no ambient environment,
 * so nothing offers Restart to apply.
 */

type CloudSecrets = ComposerAgentSecrets['state']['secrets'];

const NONE: CloudSecrets = [];
// No name in the text: the chip's notice isn't blocked from session replay,
// and the row still shows which secret it was.
const REVOKE_FAILED = "Couldn't revoke the secret. Try again.";

// A list that can't be read for now is read again after these delays, so a
// failed first read doesn't leave the chip hidden until the next request.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

/** A refusal the web core says never to retry (feature off, no access). */
function refusedForGood(error: unknown): boolean {
  return (
    error instanceof CoreCoworkRequestError &&
    error.payload.retry.kind === 'never'
  );
}

function summaries(
  secrets: Awaited<ReturnType<typeof listWebCoreChatSecrets>>,
): CloudSecrets {
  return secrets.map((secret) => ({
    name: secret.name,
    scope: 'chat' as const,
    ...(secret.lastUsedAt === null
      ? {}
      : { lastUsedAt: Date.parse(secret.lastUsedAt) }),
  }));
}

/**
 * The cloud chat's held secrets, read when the chat opens and whenever
 * `settledKey` changes (a secret request appearing or settling, a turn
 * ending). Nothing is read while agent secret requests are off for this
 * person.
 */
export function useWebCoreChatSecrets(
  cloudChatId: string | undefined,
  settledKey: string,
): ComposerAgentSecrets {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests.key),
  );
  const chatId = enabled ? cloudChatId : undefined;
  // The list with the chat it was read for: another chat's, or one read
  // before the feature turned off, never shows, not even for one render.
  const [held, setHeld] = useState<{
    readonly chatId: string | undefined;
    readonly secrets: CloudSecrets;
  }>({ chatId: undefined, secrets: NONE });
  const secrets =
    chatId !== undefined && held.chatId === chatId ? held.secrets : NONE;
  const setSecrets = useCallback(
    (update: CloudSecrets | ((current: CloudSecrets) => CloudSecrets)): void =>
      setHeld((previous) => {
        const current = previous.chatId === chatId ? previous.secrets : NONE;
        return {
          chatId,
          secrets: typeof update === 'function' ? update(current) : update,
        };
      }),
    [chatId],
  );
  const generation = useRef(0);
  // The composer outlives a chat switch, so each reply checks it is still
  // for the chat on show; undefined once the chat closes.
  const shownChat = useRef<string | undefined>(undefined);
  // Bumped each time a chat opens (a switch, or the flag turning back on),
  // so a reply from an earlier opening of the same chat does nothing.
  const opening = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const read = useCallback(
    async (attempt = 0): Promise<void> => {
      if (!chatId) return;
      clearTimeout(retry.current);
      const started = (generation.current += 1);
      const current = (): boolean =>
        generation.current === started && shownChat.current === chatId;
      try {
        const next = summaries(await listWebCoreChatSecrets(chatId));
        if (current()) setSecrets(next);
      } catch (error) {
        // Classified only: the reply holds names, never a value.
        toAppError(error);
        if (!current()) return;
        if (refusedForGood(error)) {
          setSecrets(NONE);
          return;
        }
        // Keeps what shows and tries again a few times.
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined)
          retry.current = setTimeout(() => void read(attempt + 1), delay);
      }
    },
    [chatId, setSecrets],
  );

  // A reply that lands after the chat closes does nothing, and the chat's
  // list is read afresh when it opens again.
  useEffect(() => {
    shownChat.current = chatId;
    opening.current += 1;
    return (): void => {
      shownChat.current = undefined;
      generation.current += 1;
      clearTimeout(retry.current);
      setHeld({ chatId: undefined, secrets: NONE });
    };
  }, [chatId]);
  useEffect(() => {
    void read();
  }, [read, settledKey]);

  const revoke = useCallback(
    async (name: string): Promise<string | undefined> => {
      if (!chatId) return REVOKE_FAILED;
      const opened = opening.current;
      const shown = (): boolean =>
        opening.current === opened && shownChat.current === chatId;
      // A reply for an earlier opening of a chat that is open again says
      // nothing itself, but that opening's list may predate it: read again.
      const stale = (): undefined => {
        if (shownChat.current === chatId) void read();
        return undefined;
      };
      // The outcome is unknown: a refusal for good clears the list, as a
      // read's does; otherwise a fresh read shows where things stand. A
      // reply for an earlier opening, or another chat, says nothing at all.
      const failed = (error: unknown): string | undefined => {
        if (!shown()) return stale();
        if (refusedForGood(error)) {
          generation.current += 1;
          setSecrets(NONE);
        } else void read();
        return REVOKE_FAILED;
      };
      // The row goes at once; the fresh read publishes the whole list, and
      // an older read still under way can't bring the row back.
      const gone = (): undefined => {
        setSecrets((current) =>
          current.filter((secret) => secret.name !== name),
        );
        void read();
        return undefined;
      };
      let revoked: boolean;
      try {
        revoked = await revokeWebCoreChatSecret(chatId, name);
      } catch (error) {
        toAppError(error);
        return failed(error);
      }
      if (!shown()) return stale();
      if (revoked) return gone();
      // Not revoked: the secret was already gone, or the chat couldn't be
      // reached. Only a fresh list without it says which; its own read, so
      // a refresh that lands meanwhile can't make it inconclusive. It only
      // answers that question: the list itself comes from `read`.
      let stillHeld: boolean;
      try {
        stillHeld = (await listWebCoreChatSecrets(chatId)).some(
          (secret) => secret.name === name,
        );
      } catch (error) {
        toAppError(error);
        return failed(error);
      }
      if (!shown()) return stale();
      return stillHeld ? REVOKE_FAILED : gone();
    },
    [chatId, read, setSecrets],
  );
  const restart = useCallback((): Promise<void> => Promise.resolve(), []);
  const refresh = useCallback((): void => {
    void read();
  }, [read]);

  return useMemo(
    () => ({
      state: { secrets, ambient: 'none' as const },
      revoke,
      restart,
      refresh,
    }),
    [secrets, revoke, restart, refresh],
  );
}
