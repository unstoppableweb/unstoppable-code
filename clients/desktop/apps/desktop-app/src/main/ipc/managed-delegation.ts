import { z } from 'zod';
import {
  IPC_CHANNELS,
  type ChatDelegationActivity,
  type ManagedDelegationMessageResult,
  type ManagedDelegationTreeResult,
  type ManagedDelegationTranscriptPageResult,
  type ManagedDelegationRootsResult,
  type ManagedDelegationWorktreeSummaryResult,
  type ManagedDelegationExtendLifetimeLimitResult,
  type ManagedDelegationLifetimeStatus,
  type ManagedDelegationPolicyCatalogResult,
  type ManagedDelegationChangesResult,
  type ManagedDelegationTranscriptResult,
  type ManagedDelegationStopAllResult,
  type ManagedDelegationStopResult,
} from '@canopy/desktop-shared/types';
import {
  listDelegationActivity,
  parseDelegationSessionKey,
  subscribeDelegationActivity,
  type DelegationActivityEntry,
} from '../agents/delegation/activity';
import { validateId } from '../lib/validation';
import { sendToAllWindows } from '../lib/window-send';
import { requestDesktopSessionSnapshotInvalidation } from '../services/desktop-session-snapshot-invalidation';
import { registerIpcHandler } from './register';
import { managedDelegationLifetimeStatus } from '../agents/delegation/lifetime-status';

/**
 * Managed delegation is not a migrated `core.*` slice, so its user stop
 * controls and the delegate card's change listing use the ordinary IPC path.
 * Activity comes from the dependency-free activity module; the other handlers
 * load the delegation service on demand.
 */

const chatTargetSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  chatId: z.string(),
});
const scopeSchema = z.object({ projectId: z.string(), worktreeId: z.string() });
const messageSchema = z.preprocess(
  (raw): unknown => {
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'operation' in raw &&
      raw.operation === 'interrupt'
    )
      return { ...raw, message: undefined };
    return raw;
  },
  chatTargetSchema
    .extend({
      delegationId: z.string(),
      operation: z.enum(['follow_up', 'steer', 'interrupt']),
      message: z.string().max(32_768).optional(),
      operationId: z.string().uuid(),
    })
    .superRefine((value, context): void => {
      if (value.operation !== 'interrupt' && !value.message?.trim())
        context.addIssue({ code: 'custom', message: 'Enter a message.' });
    }),
);
const transcriptPageSchema = chatTargetSchema.extend({
  delegationId: z.string(),
  beforeSequence: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
  runGeneration: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  sinceRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
const stopSchema = chatTargetSchema.extend({ delegationId: z.string() });
const changesSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  delegationId: z.string(),
  revision: z.string().regex(/^[a-f0-9]{40,64}$/),
});

const transcriptSchema = chatTargetSchema.extend({
  delegationId: z.string().min(1).max(512),
  runGeneration: z.number().int().min(1),
  archivedContainerId: z.string().optional(),
  standaloneHistory: z.boolean().optional(),
});

/** How long a change listing may take before it is abandoned. */
const CHANGES_TIMEOUT_MS = 30_000;

interface ChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

function parseChatTarget(raw: unknown): ChatTarget {
  const parsed = chatTargetSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid managed delegation request');
  const { projectId, worktreeId, chatId } = parsed.data;
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  validateId(chatId, 'chatId');
  return { projectId, worktreeId, chatId };
}

function toChatActivity(
  entry: DelegationActivityEntry,
): ChatDelegationActivity | null {
  const chat = parseDelegationSessionKey(entry.sessionKey);
  if (!chat) return null;
  return { ...chat, live: entry.live, queued: entry.queued };
}

function stopFailure(error: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error:
      error instanceof Error && error.message
        ? error.message
        : "Couldn't stop the delegation.",
  };
}

function listChatDelegationActivity(): ChatDelegationActivity[] {
  return listDelegationActivity().flatMap((entry) => {
    const activity = toChatActivity(entry);
    return activity ? [activity] : [];
  });
}

let unsubscribeActivity: (() => void) | null = null;
let unsubscribeLifetime: (() => void) | null = null;

export function registerManagedDelegationHandlers(): void {
  unsubscribeLifetime?.();
  unsubscribeLifetime = managedDelegationLifetimeStatus.subscribe(
    (scope): void => {
      sendToAllWindows(IPC_CHANNELS.managedDelegationLifetimeChanged, scope);
    },
  );
  // Registration replaces handlers; replace the broadcast subscription too.
  unsubscribeActivity?.();
  unsubscribeActivity = subscribeDelegationActivity((entry): void => {
    const activity = toChatActivity(entry);
    if (activity)
      sendToAllWindows(IPC_CHANNELS.managedDelegationActivityChanged, activity);
    // The shared sidebar reads its rows' working state from the desktop
    // session snapshot. The runtime-status service that also watches this
    // activity runs only while a Remote Control session is active, so re-pull
    // the snapshot here or a row stays working after its delegates finish.
    requestDesktopSessionSnapshotInvalidation('delegation.activity');
  });

  registerIpcHandler<[unknown], ManagedDelegationMessageResult>(
    IPC_CHANNELS.managedDelegationMessage,
    async (_event, raw): Promise<ManagedDelegationMessageResult> => {
      let request: z.infer<typeof messageSchema>;
      try {
        request = messageSchema.parse(raw);
        parseChatTarget(request);
        validateId(request.delegationId, 'delegationId');
        validateId(request.operationId, 'operationId');
      } catch {
        return {
          ok: false,
          code: 'invalid_request',
          error: 'Invalid managed delegation request.',
        };
      }
      try {
        const { messageManagedDelegationForUser } =
          await import('../agents/delegation/service');
        return await messageManagedDelegationForUser(request);
      } catch {
        return {
          ok: false,
          code: 'failed',
          error: "Couldn't send the delegate's message.",
        };
      }
    },
  );
  registerIpcHandler<[unknown], ManagedDelegationTreeResult>(
    IPC_CHANNELS.managedDelegationTree,
    async (_event, raw): Promise<ManagedDelegationTreeResult> => {
      let target: ChatTarget;
      try {
        target = parseChatTarget(raw);
      } catch {
        return { ok: false, error: 'Invalid managed delegation request.' };
      }
      try {
        const { readManagedDelegationTreeForUser } =
          await import('../agents/delegation/service');
        return {
          ok: true,
          entries: await readManagedDelegationTreeForUser(target),
        };
      } catch {
        return { ok: false, error: "Couldn't read the delegation tree." };
      }
    },
  );
  registerIpcHandler<[unknown], ManagedDelegationTranscriptPageResult>(
    IPC_CHANNELS.managedDelegationTranscriptPage,
    async (_event, raw): Promise<ManagedDelegationTranscriptPageResult> => {
      let request: z.infer<typeof transcriptPageSchema>;
      try {
        request = transcriptPageSchema.parse(raw);
        parseChatTarget(request);
        validateId(request.delegationId, 'delegationId');
      } catch {
        return {
          ok: false,
          code: 'invalid_request',
          error: 'Invalid managed delegation request.',
        };
      }
      try {
        const { readManagedDelegationTranscriptForUser } =
          await import('../agents/delegation/service');
        return await readManagedDelegationTranscriptForUser(request);
      } catch {
        return {
          ok: false,
          code: 'failed',
          error: "Couldn't read the delegate's transcript.",
        };
      }
    },
  );
  registerIpcHandler<[unknown], ManagedDelegationRootsResult>(
    IPC_CHANNELS.managedDelegationRoots,
    async (_event, raw): Promise<ManagedDelegationRootsResult> => {
      const scope = scopeSchema.parse(raw);
      validateId(scope.projectId, 'projectId');
      validateId(scope.worktreeId, 'worktreeId');
      try {
        const { readManagedDelegationRootsForUser } =
          await import('../agents/delegation/service');
        return await readManagedDelegationRootsForUser(scope);
      } catch {
        throw new Error("Couldn't read chats with delegations.");
      }
    },
  );
  // Settings read for Allowed models: cached registry and auth facts only;
  // never starts a provider or allocates a billing route.
  registerIpcHandler<[], ManagedDelegationPolicyCatalogResult>(
    IPC_CHANNELS.managedDelegationModelPolicyCatalog,
    async (): Promise<ManagedDelegationPolicyCatalogResult> => {
      try {
        const { buildManagedDelegationPolicyCatalog } =
          await import('../agents/delegation/model-policy');
        return { ok: true, catalog: buildManagedDelegationPolicyCatalog() };
      } catch {
        return { ok: false, error: "Couldn't load the model catalog." };
      }
    },
  );
  registerIpcHandler<[unknown], ManagedDelegationLifetimeStatus>(
    IPC_CHANNELS.managedDelegationLifetimeStatus,
    async (_event, raw): Promise<ManagedDelegationLifetimeStatus> => {
      let scope: z.infer<typeof scopeSchema>;
      try {
        scope = scopeSchema.parse(raw);
        validateId(scope.projectId, 'projectId');
        validateId(scope.worktreeId, 'worktreeId');
      } catch {
        return { kind: 'error', reason: 'invalid_request' };
      }
      const { getManagedDelegationLifetimeStatus } =
        await import('../agents/delegation/service');
      return getManagedDelegationLifetimeStatus(scope);
    },
  );
  registerIpcHandler<[unknown], ManagedDelegationExtendLifetimeLimitResult>(
    IPC_CHANNELS.managedDelegationExtendLifetimeLimit,
    async (
      _event,
      raw,
    ): Promise<ManagedDelegationExtendLifetimeLimitResult> => {
      let scope: z.infer<typeof scopeSchema>;
      try {
        scope = scopeSchema.parse(raw);
        validateId(scope.projectId, 'projectId');
        validateId(scope.worktreeId, 'worktreeId');
      } catch {
        return { ok: false, reason: 'invalid_request' };
      }
      const { extendManagedDelegationLifetimeLimit } =
        await import('../agents/delegation/service');
      return extendManagedDelegationLifetimeLimit({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
      });
    },
  );
  registerIpcHandler<[unknown], ManagedDelegationWorktreeSummaryResult>(
    IPC_CHANNELS.managedDelegationWorktreeSummary,
    async (_event, raw): Promise<ManagedDelegationWorktreeSummaryResult> => {
      let request: z.infer<typeof changesSchema>;
      try {
        request = changesSchema.parse(raw);
        validateId(request.projectId, 'projectId');
        validateId(request.worktreeId, 'worktreeId');
        validateId(request.delegationId, 'delegationId');
      } catch {
        return { ok: false, error: 'Invalid managed delegation request.' };
      }
      try {
        const { readManagedDelegationWorktreeSummaryForUser } =
          await import('../agents/delegation/service');
        const summary = await readManagedDelegationWorktreeSummaryForUser(
          { projectId: request.projectId, worktreeId: request.worktreeId },
          request.delegationId,
          request.revision,
          AbortSignal.timeout(CHANGES_TIMEOUT_MS),
        );
        return { ok: true, summary };
      } catch {
        return {
          ok: false,
          error: "Couldn't read the delegate's worktree summary.",
        };
      }
    },
  );

  registerIpcHandler<[], ChatDelegationActivity[]>(
    IPC_CHANNELS.managedDelegationActivityList,
    (): ChatDelegationActivity[] => listChatDelegationActivity(),
  );

  registerIpcHandler<[unknown], ManagedDelegationStopResult>(
    IPC_CHANNELS.managedDelegationStop,
    async (_event, raw): Promise<ManagedDelegationStopResult> => {
      const target = parseChatTarget(raw);
      const parsed = stopSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error('Invalid managed delegation request');
      const { delegationId } = parsed.data;
      validateId(delegationId, 'delegationId');
      try {
        // Deferred local import, like the watcher delivery path in
        // app-advisor/watchers.ts (whose build:mac check shows Vite folds it
        // into the packaged main bundle): registering these handlers must not
        // pull the delegation service's import graph into this module's.
        const { stopManagedDelegationForUser } =
          await import('../agents/delegation/service');
        const result = await stopManagedDelegationForUser(target, delegationId);
        return result.ok
          ? { ok: true }
          : { ok: false, error: result.error.message };
      } catch (error) {
        return stopFailure(error);
      }
    },
  );

  registerIpcHandler<[unknown], ManagedDelegationChangesResult>(
    IPC_CHANNELS.managedDelegationChanges,
    async (_event, raw): Promise<ManagedDelegationChangesResult> => {
      const parsed = changesSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error('Invalid managed delegation request');
      const { projectId, worktreeId, delegationId, revision } = parsed.data;
      validateId(projectId, 'projectId');
      validateId(worktreeId, 'worktreeId');
      validateId(delegationId, 'delegationId');
      try {
        // Same deferred service load as the stop handlers.
        const { readManagedDelegationChangesForUser } =
          await import('../agents/delegation/service');
        const changes = await readManagedDelegationChangesForUser(
          { projectId, worktreeId },
          delegationId,
          revision,
          AbortSignal.timeout(CHANGES_TIMEOUT_MS),
        );
        return { ok: true, changes };
      } catch {
        return {
          ok: false,
          error: "Couldn't read the delegate's changes.",
        };
      }
    },
  );

  registerIpcHandler<[unknown], ManagedDelegationTranscriptResult>(
    IPC_CHANNELS.managedDelegationTranscript,
    async (_event, raw): Promise<ManagedDelegationTranscriptResult> => {
      const target = parseChatTarget(raw);
      const parsed = transcriptSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error('Invalid managed delegation request');
      const {
        delegationId,
        runGeneration,
        archivedContainerId,
        standaloneHistory,
      } = parsed.data;
      validateId(delegationId, 'delegationId');
      if (archivedContainerId !== undefined)
        validateId(archivedContainerId, 'archivedContainerId');
      try {
        // Chat state, not the delegation service, owns delegate logs; load it
        // on demand like the other handlers load the service.
        const { getChatStateService } =
          await import('../services/chat-state-service');
        const items = await getChatStateService().readDelegationItems({
          ...target,
          delegationId,
          runGeneration,
          ...(archivedContainerId ? { archivedContainerId } : {}),
          ...(standaloneHistory ? { standaloneHistory } : {}),
        });
        return { ok: true, items };
      } catch {
        return {
          ok: false,
          error: "Couldn't load the delegated task's transcript.",
        };
      }
    },
  );

  registerIpcHandler<[unknown], ManagedDelegationStopAllResult>(
    IPC_CHANNELS.managedDelegationStopAll,
    async (_event, raw): Promise<ManagedDelegationStopAllResult> => {
      const target = parseChatTarget(raw);
      try {
        // Same deferred service load as the single stop above.
        const { stopAllManagedDelegationsForUser } =
          await import('../agents/delegation/service');
        const result = await stopAllManagedDelegationsForUser(target);
        return result.ok
          ? { ok: true, stopped: result.value.stopped }
          : { ok: false, error: result.error.message };
      } catch (error) {
        return stopFailure(error);
      }
    },
  );
}
