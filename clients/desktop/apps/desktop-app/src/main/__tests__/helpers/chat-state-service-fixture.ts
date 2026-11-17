/**
 * A real `ChatStateService` over a temp V2 repository, for integration tests
 * outside `services/__tests__/chat-state-service.test.ts` (whose helpers are
 * closure-local). The callbacks match that file's `serviceWithRepository`
 * stubs; each scope gets its own storage files.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  type ChatRuntimeStatus,
} from '@canopy/desktop-shared/types';
import { getChatQueueService } from '../../services/chat-queue-service';
import type { ChatScopeKey } from '../../services/chat-state-contracts';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';

export interface ChatStateServiceFixture {
  service: ChatStateService;
  repository: ChatStateV2Repository;
  /** Issues `chat.create_tab` for `chat-1` in the scope. */
  createChat(scope: ChatScopeKey): Promise<void>;
  /** Appends a user message and records the provider's acceptance of it as its turn. */
  acceptTurn(scope: ChatScopeKey, userMessageId: string): Promise<void>;
  /** Commits a provider runtime patch for `chat-1`. */
  setRuntime(
    scope: ChatScopeKey,
    status: ChatRuntimeStatus,
    activeUserMessageId: string | null,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export function createChatStateServiceFixture(options?: {
  canonicalPaths: true;
}): ChatStateServiceFixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'canopy-chat-state-fixture-'));
  const repository = new ChatStateV2Repository(
    options?.canonicalPaths
      ? {}
      : {
          resolvePaths: (
            scope,
          ): { tabs: string; archives: string; journal: string } => {
            const prefix = join(
              tempDir,
              `${scope.projectId}--${scope.worktreeId}`,
            );
            return {
              tabs: `${prefix}-chats.json`,
              archives: `${prefix}-archives.json`,
              journal: `${prefix}-journal.jsonl`,
            };
          },
        },
  );
  let ids = 0;
  const service = new ChatStateService({
    repository,
    now: (): number => 1_786_104_000_000,
    createId: (): string => `event-${(ids += 1)}`,
    dispatch: (): Promise<void> => Promise.resolve(),
    onInputPickup: (): Promise<void> => Promise.resolve(),
    authorizeSend: (): Promise<void> => Promise.resolve(),
    approvePlanReview: (): Promise<boolean> => Promise.resolve(true),
    withPlanReviewRevision: async <T>(
      _request: unknown,
      commit: () => Promise<T>,
    ): Promise<{ accepted: true; result: T }> => ({
      accepted: true,
      result: await commit(),
    }),
    cleanupSession: (): Promise<void> => Promise.resolve(),
    // Fixture commands must not start the host's observability disk writer.
    recordDiagnostic: (): void => undefined,
  });

  return {
    service,
    repository,
    async createChat(scope): Promise<void> {
      const result = await service.command({
        schemaVersion: 1,
        commandId: `create-${scope.worktreeId}`,
        ...scope,
        command: {
          type: 'chat.create_tab',
          tabId: 'chat-1',
          title: 'Durable chat',
          providerType: 'claude',
          model: 'claude-opus-4-6',
        },
      });
      if (result.outcome !== 'applied')
        throw new Error(`chat.create_tab was ${result.outcome}`);
    },
    async acceptTurn(scope, userMessageId): Promise<void> {
      await repository.transact(
        scope,
        [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: {
              id: userMessageId,
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Question' }],
            },
          },
        ],
        { source: 'migration' },
      );
      await service.ingestProviderEvent({
        ...scope,
        chatId: 'chat-1',
        mutationId: `chat-1:${userMessageId}:accepted`,
        turnUserMessageId: userMessageId,
        data: {
          type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
          canopy_turn_user_message_id: userMessageId,
        },
      });
    },
    async setRuntime(scope, status, activeUserMessageId): Promise<void> {
      await repository.transact(
        scope,
        [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status,
              ...(activeUserMessageId
                ? {
                    activeTurn: {
                      userMessageId: activeUserMessageId,
                      startedAt: 1,
                    },
                  }
                : {}),
              queuedMessageIds: [],
            },
          },
        ],
        { source: 'provider' },
      );
    },
    async dispose(): Promise<void> {
      getChatQueueService().resetForTests();
      await repository.drainAll();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
