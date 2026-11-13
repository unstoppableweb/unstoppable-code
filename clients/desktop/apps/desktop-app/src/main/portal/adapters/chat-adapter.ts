import { isModelHarness } from '@canopy/execution-engine/model-harnesses';
import { supportsChatHarnessChoice } from '@canopy/desktop-shared/lib/chat-model-selection';
import { ChatPlanReviewApprovalSchema } from '@canopy/protocol/portal';
import { isCopilotRuntimeAvailable } from '../../copilot/runtime-availability';
import {
  chatSettingsRoute,
  type ChatSettingsChange,
} from '../../lib/chat-settings-route';
import { createHash, randomUUID } from 'node:crypto';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  getExecutionHarnessForModel,
  getProviderForModel,
  requireProviderForModel,
  isTerminalBackedInterfaceMode,
  isThinkingLevel,
  resolveProviderModelConfig,
  resolveKnownModel,
  type AgentProviderType,
  type McpQuestionAnswer,
  type ChatCommand,
  type ChatModel,
  type ChatTabPluginSelections,
  type ChatCommandRequest,
  type ChatCommandOutcome,
  type ChatCommandResult,
  type ChatStateSnapshot,
  type PortalChatSendIdentity,
  type PortalChatComposerCommand,
  type PortalChatComposerLifecycleCommand,
  type PortalChatQuestionMutationCommand,
  type PortalChatComposerSetterCommand,
  type PortalChatCloudAttachmentRef,
  type PortalChatFileReference,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
  PIPELINE_EDITOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  isRetiredPlanChatScope,
  RETIRED_PLAN_CHAT_MESSAGE,
} from '@canopy/desktop-shared/lib/retired-chat-scopes';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { mergeAgentModelConfig } from '@canopy/execution-engine/lib/codex-speed';
import {
  PortalChatAttachmentError,
  consumePortalChatAttachments,
  materializePortalChatAttachments,
  readPortalChatCloudAttachmentRefs,
  removeMaterializedPortalChatAttachments,
} from '../portal-chat-attachments';
import type { ChatInputDeliveryAction } from '@canopy/protocol/portal';
import {
  BACKGROUND_WORK_CHAT_REFUSAL,
  LIVE_DELEGATES_CHAT_REFUSAL,
} from '../../agents/delegation/activity';
import { sendToWindowDetailed } from '../../lib/window-send';
import { assertShareScopeTarget } from '../../lib/share-scope-target';
import { validateId, validateOptionalRepoId } from '../../lib/validation';
import { expandWorkspacePromptMentions } from '../../lib/workspace-prompt-mentions';
import {
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
} from '../../lib/model-policy-state';
import { readPreferencesFile } from '../../lib/preferences-store';
import { resolveLaneAwareDefaultSelection } from '../../lib/default-model-lane-resolver';
import {
  noDispatchableModelSendMessage,
  resolveSendBillingRefusal,
} from '../../lib/send-billing-refusal';
import {
  resolveAiCreditsScopeOwner,
  type WorkOwnerSession,
} from '../../agents/work-owner';
import {
  pinInheritingAgentToDestination,
  resolveSendModelPin,
} from '../../agents/agent-default-model';
import { isCoworkWorkspace } from '../../lib/workspace-registry';
import { requestPortalComposerCommand } from '../../ipc/portal-composer-command';
import {
  respondToChatQuestion,
  type ChatQuestionResponse,
} from '../../chat-questions/respond';
import { isCursorRuntimeAvailable } from '../../cursor/runtime-availability';
import { isOpenCodeRuntimeAvailable } from '../../opencode/runtime-availability';
import type { PortalAdapterContext } from './types';
import { readPortalSendModelConfigPatch } from './standalone-chat-adapter';
import { queryPortalChatState } from './chat-state-query';
import {
  CoreChatLifecycleResultSchema,
  CoreChatUpdateParamsSchema,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { getActiveDesktopRuntimeIfAccepting } from '../../canopy-runtime/desktop-runtime';
import { getClaudeTerminalSessionService } from '../../integration/claude-terminal-session-service';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { failServiceError, isRecord } from './validation';
import { portalFileReferences } from '../portal-file-references';
import { assertUntrustedChatInput } from '../../agent-messaging/untrusted-input';

function rejectUntrustedPortalChatInput(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
): boolean {
  try {
    assertUntrustedChatInput(command.payload);
    return false;
  } catch {
    context.fail(
      command,
      'invalid_payload',
      'Trusted agent attribution cannot be supplied by the Portal.',
    );
    return true;
  }
}

type PortalChatCommandExecutionOptions = NonNullable<
  Parameters<NonNullable<PortalAdapterContext['dispatchChatCommand']>>[1]
>;

/**
 * Runtime sanitizer for the wire `fileReferences` array: portal payloads are
 * client-supplied JSON, so only well-formed reference entries may reach the
 * scoped host resolution before prompt-mention expansion. The wire carries
 * opaque ids rather than host paths. Malformed entries are dropped
 * per-entry (a valid prompt pill still expands next to a garbage sibling),
 * and mistyped optional fields (`repoName`/`kind`/`textStart`) are omitted so
 * a non-numeric `textStart` degrades to the ordered `indexOf` fallback
 * instead of a `NaN` slice. Returns `undefined` when the payload carries no
 * array at all, which skips expansion.
 */
export function sanitizePortalFileReferences(
  value: unknown,
): PortalChatFileReference[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sanitized: PortalChatFileReference[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.displayPath !== 'string' ||
      typeof entry.referenceId !== 'string' ||
      !entry.referenceId
    ) {
      continue;
    }
    sanitized.push({
      displayPath: entry.displayPath,
      referenceId: entry.referenceId,
      ...(typeof entry.repoName === 'string'
        ? { repoName: entry.repoName }
        : {}),
      ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
      ...(typeof entry.textStart === 'number' &&
      Number.isInteger(entry.textStart) &&
      entry.textStart >= 0
        ? { textStart: entry.textStart }
        : {}),
    });
  }
  return sanitized;
}

/**
 * The stored default model for `providerType`.
 *
 * `readable: false` means preferences could not be read at all, which is NOT
 * the same as "this provider has no default" (`readable: true` with an
 * undefined `model` — Ollama's selection is nullable). The distinction is
 * reported so callers can log or branch on it, but for ENFORCEMENT both mean
 * the same thing and the caller must treat them identically: either way the
 * effective model is unknown, `isModelBlockedByStoredPolicy(undefined)`
 * returns `false`, and waving it through would let the provider's implicit
 * default run with no policy evaluation anywhere in the stack.
 *
 * Used only to police the model a send would *actually* resolve to when the
 * client supplied none — never to change what is sent.
 *
 * `dispatchWorktreeChatTurn` picks the defaults map by target kind —
 * `defaultChatModelByProvider` for a cowork chat, `defaultWorktreeModelByProvider`
 * otherwise — so this mirrors that choice rather than assuming the routing.
 * Cowork targets are expected to arrive on `portal.standalone_chat.send`, which
 * has its own guard, but nothing enforces that here; reading the same map
 * dispatch will read keeps the preflight correct either way instead of
 * silently judging the wrong defaults.
 */
async function readDefaultWorktreeModel(
  // OPTIONAL, and `undefined` is meaningful: it means "this send names no
  // provider", which is exactly what `dispatchWorktreeChatTurn` passes on the
  // same input. The resolver then falls back to the scope's configured
  // `defaultWorktreeProvider`.
  //
  // Defaulting to `'claude'` here made the preflight judge a different lane
  // from the one dispatch would run. Both sides used to hard-code `'claude'`
  // and agreed; once dispatch moved onto the scope's preferred provider, an
  // `ollama`-preferring user had every chat-id-less send refused with "Add a
  // billing source" (the ollama lane never entered the walk), and a
  // `codex`-preferring user whose org blocks the Codex default but allows the
  // Claude one passed the preflight and then failed at dispatch with the tab
  // and user message already persisted.
  providerType:
    | 'claude'
    | 'codex'
    | 'ollama'
    | 'cursor'
    | 'copilot'
    | 'opencode'
    | undefined,
  projectId: string,
  workOwnerSession?: WorkOwnerSession,
): Promise<{
  readable: boolean;
  model?: string;
  noDispatchableModel?: {
    missing: 'billing-lane' | 'policy-allowance' | 'both';
  };
}> {
  const preferences = await readPreferencesFile().catch(() => null);
  if (!preferences) {
    return { readable: false };
  }
  const scope = isCoworkWorkspace(projectId) ? 'chat' : 'worktree';
  const resolution = await resolveLaneAwareDefaultSelection(
    preferences,
    scope,
    // Mirrors the eventual session spawn, which resolves its Canopy
    // Environments credentials for this workspace — otherwise a workspace-only
    // provider credential is invisible here and this preflight disagrees with
    // what the send actually does.
    { workspaceId: projectId, workOwnerSession },
    providerType,
    undefined,
    // A send preflight for whichever provider THIS tab carries — not a question
    // about the user's default model, so it must not stamp the projection.
    false,
  );
  // A DEFINITE dead end is reported as such, never collapsed into "this
  // provider has no default". This is the THIRD consumer of the resolver's
  // dead-end outcome (the other two are in `standalone-chat-adapter.ts` and
  // `standalone-chat-service.ts`), and it was missed because it calls the
  // resolver directly rather than going through the cowork policy helper.
  //
  // Collapsing it meant a Portal worktree send with no payload model and no tab
  // model took the `effectiveModelIsUnknown` path, which only refuses when an
  // ORG POLICY is active. Without one the send proceeded,
  // `sendWorktreeChatMessage` persisted the tab and the user message, and only
  // then did `dispatchWorktreeChatTurn` throw `NoDispatchableModelError` —
  // durably recording a prompt that provably could not run. With a policy
  // active it refused for the wrong reason entirely ("policy could not be
  // applied") on what is purely a billing dead end.
  if (resolution.outcome === 'no-dispatchable-model') {
    return {
      readable: true,
      noDispatchableModel: { missing: resolution.missing },
    };
  }
  const model = resolution.selection.model;
  return model === undefined ? { readable: true } : { readable: true, model };
}

const portalSendsInFlight = new WeakMap<
  NonNullable<PortalAdapterContext['chatStatePort']>,
  Map<string, { fingerprint: string; execution: Promise<void> }>
>();

function portalSendIdentity(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.send']>,
): PortalChatSendIdentity | undefined {
  if (
    !isRecord(command.payload) ||
    typeof command.payload.chatId !== 'string' ||
    typeof command.payload.userMessageId !== 'string'
  )
    return undefined;
  const encoded = JSON.stringify(
    {
      type: command.type,
      target: command.target ?? null,
      payload: command.payload,
    },
    (_key, value: unknown) =>
      isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : value,
  );
  return {
    chatId: command.payload.chatId,
    userMessageId: command.payload.userMessageId,
    fingerprint: createHash('sha256').update(encoded).digest('hex'),
  };
}

export async function handlePortalChatSend(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.send']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(command, context)) return;
  const identity = portalSendIdentity(command);
  const port = context.chatStatePort;
  if (!identity || !port) {
    await executePortalChatSend(command, context, identity);
    return;
  }
  const key = JSON.stringify([
    command.payload.projectId,
    command.payload.worktreeId,
    identity.userMessageId,
  ]);
  let claims = portalSendsInFlight.get(port);
  if (!claims) {
    claims = new Map();
    portalSendsInFlight.set(port, claims);
  }
  const claimed = claims.get(key);
  if (claimed) {
    if (claimed.fingerprint !== identity.fingerprint) {
      context.fail(
        command,
        'invalid_payload',
        'The logical send payload or target has changed.',
      );
      return;
    }
    await claimed.execution;
    await handlePortalChatSend(command, context);
    return;
  }
  const execution = executePortalChatSend(command, context, identity).finally(
    (): void => {
      if (claims.get(key)?.execution === execution) claims.delete(key);
    },
  );
  claims.set(key, { fingerprint: identity.fingerprint, execution });
  await execution;
}

async function executePortalChatSend(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.send']>,
  context: PortalAdapterContext,
  identity: PortalChatSendIdentity | undefined,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(command, context)) return;
  if (!isRecord(command.payload) || typeof command.payload.text !== 'string') {
    context.fail(command, 'invalid_payload', 'Invalid chat send payload.');
    return;
  }
  let materializedAttachmentPaths: string[] = [];
  let attachmentSendCommitted = false;
  try {
    // Although `sendWorktreeChatMessage` re-validates these ids, they must
    // also be validated here, before the `buildExistingTabDispatchOptions`
    // tab-file lookup below ever sees them. An empty-string `chatId` is
    // rejected rather than treated as "mint a new chat" — only an omitted
    // `chatId` means that.
    validateId(command.payload.projectId, 'projectId');
    validateId(command.payload.worktreeId, 'worktreeId');
    if (command.payload.chatId !== undefined) {
      validateId(command.payload.chatId, 'chatId');
    }
    validateOptionalRepoId(command.payload.selectedRepoId, 'selectedRepoId');
    if (isRetiredPlanChatScope(command.payload.projectId)) {
      // A legacy plan chat never starts a turn; refuse before attachments are
      // materialized or anything reaches canonical chat state.
      context.fail(command, 'invalid_payload', RETIRED_PLAN_CHAT_MESSAGE);
      return;
    }
    const userMessageId = Reflect.get(command.payload, 'userMessageId');
    if (userMessageId !== undefined) {
      try {
        validateId(userMessageId, 'userMessageId');
      } catch {
        context.fail(
          command,
          'invalid_payload',
          'userMessageId must be a valid id.',
        );
        return;
      }
    }

    if (command.payload.planReviewApproval !== undefined) {
      const approval = ChatPlanReviewApprovalSchema.safeParse(
        command.payload.planReviewApproval,
      );
      if (
        !approval.success ||
        !context.chatStatePort ||
        !command.payload.chatId ||
        !command.payload.userMessageId ||
        isCoworkWorkspace(command.payload.projectId) ||
        command.payload.projectId === APP_ADVISOR_PROJECT_ID ||
        command.payload.projectId === PIPELINE_EDITOR_PROJECT_ID ||
        command.payload.projectId === STANDALONE_CHAT_PROJECT_ID
      ) {
        context.fail(
          command,
          'invalid_payload',
          'Plan approval requires a current worktree review and canonical chat messaging.',
        );
        return;
      }
    }

    // Refuse a malformed or contradictory speed before any side effect,
    // instead of dropping it or persisting a speed its boolean contradicts.
    const modelConfigPatch = readPortalSendModelConfigPatch(command.payload);
    if (!modelConfigPatch.ok) {
      context.fail(command, 'invalid_payload', modelConfigPatch.error);
      return;
    }

    // Phone/browser-uploaded attachments arrive as refs. Materialize them
    // into local files BEFORE any model/policy work so a failed download never
    // persists a tab or a message. The parse is strict on purpose (see
    // `readPortalChatCloudAttachmentRefs`).
    let cloudAttachmentRefs: PortalChatCloudAttachmentRef[] | undefined;
    try {
      cloudAttachmentRefs = readPortalChatCloudAttachmentRefs(
        Reflect.get(command.payload, 'cloudAttachments'),
      );
    } catch (error) {
      if (error instanceof PortalChatAttachmentError) {
        context.fail(command, error.code, error.message, error.retryable);
        return;
      }
      throw error;
    }
    let attachmentSessionId: string | null = null;
    const materializedAttachmentIds =
      cloudAttachmentRefs?.map((ref) => ref.attachmentId) ?? [];
    if (
      materializedAttachmentIds.length > 0 &&
      (!command.payload.chatId || !command.payload.userMessageId)
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Attachment sends require a chatId and userMessageId.',
      );
      return;
    }

    // A durable receipt can outlive the portal worker cursor that acknowledged
    // it. Probe before touching session-scoped blobs so redelivery after a
    // crash can acknowledge the already-committed message even though the
    // first application consumed those blobs.
    if (
      context.queryChatSendReceipt &&
      command.payload.chatId &&
      command.payload.userMessageId
    ) {
      try {
        const probe = await context.queryChatSendReceipt({
          scope: {
            workspaceId: command.payload.projectId,
            worktreeId: command.payload.worktreeId,
            chatId: command.payload.chatId,
          },
          commandId: command.id,
          ...(identity
            ? {
                identity: {
                  userMessageId: identity.userMessageId,
                  fingerprint: identity.fingerprint,
                },
              }
            : {}),
        });
        if (probe?.outcome === 'conflict') {
          context.fail(
            command,
            'invalid_payload',
            'The logical send payload or target has changed.',
          );
          return;
        }
        const receipt = probe.outcome === 'matched' ? probe.receipt : null;
        if (receipt) {
          if (materializedAttachmentIds.length > 0) {
            // Dynamic import: `portal-session-manager` imports the command
            // handler table, which imports this adapter. Loading it lazily
            // keeps the module graph acyclic at evaluation time.
            const { getCanopyPortalState } =
              await import('../portal-session-manager');
            attachmentSessionId = getCanopyPortalState().sessionId;
            await consumePortalChatAttachments({
              sessionId: attachmentSessionId,
              attachmentIds: materializedAttachmentIds,
            });
          }
          context.complete(command, {
            commandId: command.id,
            revision: receipt.revision,
            entityId: receipt.entityId,
            messageId: receipt.messageId,
            outcome: 'already_applied' as const,
            ...(await sendReceiptFields(
              {
                projectId: command.payload.projectId,
                worktreeId: command.payload.worktreeId,
                chatId: command.payload.chatId,
              },
              receipt.messageId ?? command.payload.userMessageId,
            )),
          });
          return;
        }
      } catch {
        context.fail(
          command,
          'execution_failed',
          'The chat state service is temporarily unavailable.',
          true,
        );
        return;
      }
    }
    // Captured for the post-accept consume below: the blobs stay on the
    // service until the send is actually accepted, so a refusal here or a
    // retryable `conflict` from the revisioned dispatch leaves the client
    // able to send the very same refs again.
    if (cloudAttachmentRefs && cloudAttachmentRefs.length > 0) {
      // App-managed chat scopes resolve their attachments directory through a
      // different rule than the turn path does for the same target
      // (`resolveAgentAttachmentsDir` vs the cowork/worktree split in
      // `worktree-chat-turn.ts`), so a materialized file could land where the
      // turn never looks. Those scopes are not portal-drivable anyway —
      // `dispatchRevisionedChatCommand` already refuses App Advisor and the
      // Pipeline Editor — so refuse the attachment rather than write a file
      // into a directory the send cannot read.
      if (
        command.payload.projectId === APP_ADVISOR_PROJECT_ID ||
        command.payload.projectId === PIPELINE_EDITOR_PROJECT_ID ||
        command.payload.projectId === STANDALONE_CHAT_PROJECT_ID
      ) {
        context.fail(
          command,
          'invalid_payload',
          'Attachments are not supported for this chat.',
        );
        return;
      }
      // Dynamic import: `portal-session-manager` imports the command handler
      // table, which imports this adapter. Loading it lazily keeps the module
      // graph acyclic at evaluation time (same reason `chat-service` below is
      // imported dynamically).
      const { getCanopyPortalState } =
        await import('../portal-session-manager');
      attachmentSessionId = getCanopyPortalState().sessionId;
      try {
        materializedAttachmentPaths = await materializePortalChatAttachments({
          refs: cloudAttachmentRefs,
          projectId: command.payload.projectId,
          worktreeId: command.payload.worktreeId,
          sessionId: attachmentSessionId,
          expiresAt: command.expiresAt,
        });
      } catch (error) {
        if (error instanceof PortalChatAttachmentError) {
          context.fail(command, error.code, error.message, error.retryable);
          return;
        }
        throw error;
      }
    }
    const mergedAttachmentPaths = [
      ...(Array.isArray(command.payload.attachmentPaths)
        ? command.payload.attachmentPaths
        : []),
      ...materializedAttachmentPaths,
    ];

    const {
      assertWorktreeChatSendNotSplitLocked,
      buildExistingTabDispatchOptions,
      ExistingTabDispatchTargetNotFoundError,
      sendWorktreeChatMessage,
    } = await import('../../services/chat-service');
    let tabOptions: Awaited<
      ReturnType<typeof buildExistingTabDispatchOptions>
    > = {};
    if (command.payload.chatId) {
      try {
        tabOptions = await buildExistingTabDispatchOptions(
          command.payload.projectId,
          command.payload.worktreeId,
          command.payload.chatId,
        );
      } catch (error) {
        if (!(error instanceof ExistingTabDispatchTargetNotFoundError)) {
          throw error;
        }
      }
    }
    // Settle the model, including one stored on the chat, before anything below
    // judges it: the policy and billing checks then see the route this send
    // carries, and a nested default is refused before anything is saved.
    let sendModelPin: string | undefined;
    try {
      sendModelPin = await resolveSendModelPin(
        command.payload.projectId,
        tabOptions.model,
        typeof command.payload.model === 'string'
          ? (resolveKnownModel(command.payload.model) ?? command.payload.model)
          : undefined,
      );
    } catch (error) {
      context.fail(
        command,
        'invalid_payload',
        error instanceof Error ? error.message : String(error),
      );
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }
    if (sendModelPin !== undefined) {
      const pinnedProvider = getProviderForModel(sendModelPin);
      if (typeof command.payload.model === 'string') {
        command = {
          ...command,
          payload: {
            ...command.payload,
            model: sendModelPin,
            providerType: pinnedProvider ?? command.payload.providerType,
          },
        };
      } else {
        tabOptions = {
          ...tabOptions,
          model: sendModelPin,
          providerType: pinnedProvider ?? tabOptions.providerType,
          executionHarness: getExecutionHarnessForModel(sendModelPin),
        };
      }
    }
    const coworkSend = isCoworkWorkspace(command.payload.projectId);
    // Shared model IDs keep their native provider even when the saved chat
    // runs through OpenCode. Preserve that host-owned execution choice.
    const payloadProvider =
      (coworkSend && command.payload.model === undefined && tabOptions.model
        ? tabOptions.executionHarness === 'opencode'
          ? 'opencode'
          : getProviderForModel(tabOptions.model)
        : command.payload.providerType) ??
      (typeof command.payload.model === 'string'
        ? getProviderForModel(command.payload.model)
        : undefined);
    // A persisted tab model that resolves to no provider is stale metadata
    // (the model was removed or renamed after the tab last ran), not grounds
    // to abort the send: the effective-model resolution below prefers the
    // payload model anyway, and a model-less payload falls through to the
    // provider's stored default. When that stale model is also the tab's ONLY
    // provider evidence — the case that used to throw here — discard it so it
    // can neither be dispatched nor force a provider; the model actually
    // dispatched is validated by the policy checks below and the downstream
    // turn path. A tab with an explicit `providerType` keeps its model: the
    // pairing is already stated, and the policy preflight below must still
    // judge the persisted selection (aliases and unknown ids included).
    //
    // This discard is adapter-LOCAL. The persisted tab itself — its stale
    // model, harness, model configuration, and session fields — is reset by
    // `sendWorktreeChatMessage` (`clearStaleUnroutableTabModel`), which sees
    // the same tab on disk and applies the same only-provider-evidence rule,
    // so the tab stops advertising routing the turn is not running.
    const tabModelProvider =
      tabOptions.model !== undefined
        ? getProviderForModel(tabOptions.model)
        : undefined;
    if (
      tabOptions.model !== undefined &&
      tabOptions.providerType === undefined &&
      tabModelProvider === undefined
    ) {
      delete tabOptions.model;
    }
    const tabProvider = tabOptions.providerType ?? tabModelProvider ?? 'claude';
    // A persisted session id only resumes on the harness that created it.
    // When the portal payload switches harness — explicitly or implicitly
    // via a model's effective assignment — drop the tab's session/fork
    // fields so the new provider starts fresh instead of pairing a foreign
    // session id (a payload-supplied sdkSessionId still wins via the spread
    // below). Providers are resolved the same way `sendWorktreeChatMessage`
    // resolves them: explicit `providerType` first, then the model's owner,
    // defaulting the tab to 'claude'.
    const tabHarness =
      tabOptions.executionHarness ??
      (tabOptions.model
        ? getExecutionHarnessForModel(tabOptions.model)
        : undefined) ??
      tabOptions.providerType;
    const payloadHarness = command.payload.model
      ? getExecutionHarnessForModel(command.payload.model)
      : command.payload.providerType === 'ollama'
        ? tabHarness
        : command.payload.providerType;
    const switchesHarness =
      payloadHarness !== undefined && payloadHarness !== tabHarness;
    if (switchesHarness) {
      delete tabOptions.sdkSessionId;
      delete tabOptions.claudeForkSession;
      delete tabOptions.claudeForkResumeAt;
      delete tabOptions.claudeForkStartsFresh;
      delete tabOptions.executionHarness;
    }
    // The managed Claude Code terminal owns a terminal-backed tab's
    // sdkSessionId, and `sendWorktreeChatMessage` only routes prompts to the
    // terminal queue for `initiationSource: 'automation'`. A portal send
    // would fall through to a Canopy-native SDK turn that resumes — and then
    // overwrites — the terminal-owned session, so reject it instead. When the
    // Claude TUI chats flag is off, `buildExistingTabDispatchOptions` already
    // omits the terminal-owned session id and the send runs natively.
    if (
      isTerminalBackedInterfaceMode(tabOptions.interfaceMode) &&
      tabOptions.sdkSessionId !== undefined
    ) {
      context.fail(
        command,
        'conflict',
        'Terminal-backed chats cannot be driven from the portal yet.',
      );
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }
    // Deep-merge modelConfig so a partial portal modelConfig cannot silently
    // drop the tab's other persisted settings. Per-field precedence:
    // payload.modelConfig, then the deprecated top-level payload fields, then
    // the persisted tab config. The shared command merge keeps the Codex speed
    // canonical: an exact speed wins with its derived boolean, an explicit
    // legacy boolean replaces the speed (including `false` on Ultra fast), and
    // an unrelated change such as thinking keeps it.
    const hasExplicitModelConfig = modelConfigPatch.explicit;
    const mergedModelConfig = hasExplicitModelConfig
      ? mergeAgentModelConfig(tabOptions.modelConfig, modelConfigPatch.patch)
      : { ...tabOptions.modelConfig };

    // Reject a policy-blocked model BEFORE `sendWorktreeChatMessage` writes
    // the tab/model and the user message. `getOrCreateSession` already
    // fail-closes on a blocked model, but only once the turn starts — by then
    // the message is persisted and projected, so the client sees a failure
    // sitting on top of partial state. The effective model is resolved the
    // same way the turn path resolves it (`worktree-chat-turn.ts`): the
    // payload's explicit model, then the tab's persisted model, then the
    // provider's stored default. Checking only the payload would miss the
    // case where a now-blocked model is the stored default and the client
    // sent no model at all.
    //
    // Scope, stated precisely rather than optimistically:
    //   - An UNREADABLE preferences file is refused outright while a policy is
    //     active (below). It cannot be waved through to a downstream check:
    //     `worktree-chat-turn.ts` turns the same read failure into a null and
    //     dispatches `selectedModel: undefined`, and
    //     `isModelBlockedByStoredPolicy(undefined)` returns `false` — so the
    //     provider's implicit default would run with no policy evaluation
    //     anywhere in the stack.
    //   - Preferences that ARE readable but carry no concrete default for a
    //     non-Ollama provider are refused the same way (below). That state is
    //     unreachable today — `normalizeModelDefaultsByProvider` always
    //     produces `claude`/`codex` selections and only `ollama` is nullable,
    //     while Ollama models are policy-exempt — but the guarantee lives in a
    //     distant normalizer and its lapse would be SILENT rather than loud:
    //     the effective model would be `undefined`, every downstream check
    //     answers "not blocked" for `undefined`, and the provider's own
    //     implicit default would execute unevaluated under an active policy.
    //     Refusing costs nothing on any reachable path and removes the need to
    //     trust a remote invariant for enforcement.
    //   - A chat-id-less send has no `tabOptions`, so it cannot see the empty
    //     tab `sendWorktreeChatMessage` may reuse — and it does not need to.
    //     The provider default judged here is exactly what that send runs
    //     (dispatch resolves `options.model ?? default`, and there are no tab
    //     options), and the service clears any stale model off the reused tab
    //     so it cannot advertise a selection the turn is not running. Nothing
    //     blocked executes regardless — `getOrCreateSession` fail-closes on a
    //     resolved blocked model before any turn starts.
    const requestedModel =
      typeof command.payload.model === 'string'
        ? // Match the alias handling on the set-model path. `isModelBlocked`
          // normalizes aliases internally, so an unresolvable id is still
          // worth checking raw rather than skipping.
          (resolveKnownModel(command.payload.model) ?? command.payload.model)
        : undefined;
    const effectiveProviderType = payloadProvider ?? tabProvider;
    // A Cursor turn runs on the desktop's managed runtime, so it needs the
    // same preflight the desktop chat IPC applies before persisting a Cursor
    // model. Check every routing input: an explicit conflicting provider must
    // not hide the model or the persisted harness from this boundary. When the
    // runtime is connected the send falls through to `sendWorktreeChatMessage`,
    // which already validates Cursor for the worktree surface and clears AI
    // Credits routing on Cursor tabs; approvals still render on the desktop.
    const cursorRequested =
      effectiveProviderType === 'cursor' ||
      tabProvider === 'cursor' ||
      tabHarness === 'cursor' ||
      payloadHarness === 'cursor' ||
      (requestedModel !== undefined &&
        getProviderForModel(requestedModel) === 'cursor');
    const copilotRequested =
      effectiveProviderType === 'copilot' ||
      tabProvider === 'copilot' ||
      tabHarness === 'copilot' ||
      payloadHarness === 'copilot' ||
      (requestedModel !== undefined &&
        getProviderForModel(requestedModel) === 'copilot');
    // The catalog is revoked on disconnect, but existing tabs retain their
    // provider and harness. Refuse before persisting a message or dispatching.
    const opencodeRequested =
      effectiveProviderType === 'opencode' ||
      tabProvider === 'opencode' ||
      tabHarness === 'opencode' ||
      payloadHarness === 'opencode' ||
      (requestedModel !== undefined &&
        getProviderForModel(requestedModel) === 'opencode');
    if (opencodeRequested && !(await isOpenCodeRuntimeAvailable())) {
      context.fail(
        command,
        'invalid_payload',
        'Connect OpenCode in the desktop app to use it here.',
      );
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }
    if (copilotRequested && !(await isCopilotRuntimeAvailable())) {
      context.fail(
        command,
        'invalid_payload',
        'Connect Copilot in the desktop app to use it here.',
      );
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }
    if (cursorRequested && !(await isCursorRuntimeAvailable())) {
      // Matches the set-model path (`handlePortalChatSetModel`): a plain
      // thrown Error here would be mapped to `execution_failed` by the outer
      // `failServiceError` catch, which reads to the client as "the server
      // failed" rather than "your request/state is invalid".
      context.fail(
        command,
        'invalid_payload',
        'Connect Cursor in the desktop app to use it here.',
      );
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }
    // Same derivation as `tabProvider` but WITHOUT its `'claude'` default, so
    // an absent provider stays absent — see `readDefaultWorktreeModel`.
    const preflightProviderType =
      payloadProvider ??
      tabOptions.providerType ??
      (tabOptions.model ? getProviderForModel(tabOptions.model) : undefined);
    const storedDefault =
      requestedModel === undefined && tabOptions.model === undefined
        ? await readDefaultWorktreeModel(
            // The UNDEFAULTED provider — see `readDefaultWorktreeModel`. This
            // is byte-identical to what `sendWorktreeChatMessage` forwards to
            // dispatch, so the two sides resolve the same lane.
            preflightProviderType,
            command.payload.projectId,
            command.payload.chatId
              ? {
                  projectId: command.payload.projectId,
                  worktreeId: command.payload.worktreeId,
                  chatId: command.payload.chatId,
                }
              : undefined,
          )
        : undefined;
    // Unknown means unknown, whether preferences were unreadable or merely
    // carried no concrete default. Ollama is excluded because Ollama models are
    // policy-exempt at every layer, so an absent Ollama default cannot leak a
    // blocked model.
    const effectiveModelIsUnknown =
      storedDefault !== undefined &&
      storedDefault.model === undefined &&
      effectiveProviderType !== 'ollama';
    const workOwner = await resolveAiCreditsScopeOwner({
      kind: 'work',
      projectId: command.payload.projectId,
      worktreeId: command.payload.worktreeId,
      chatId: command.payload.chatId,
    });
    // The STORED-account predicate, not the in-process one. `currentPolicy` is
    // empty until the first account read lands, and startup kicks that off
    // without awaiting it — so during that window the sync predicate answers
    // "no policy" for a genuinely policed user. That matters only here,
    // because this is the branch where the model is UNKNOWN: downstream,
    // `isModelBlockedByStoredPolicy(undefined)` returns early without reading
    // the account at all, so nothing else would evaluate policy and the
    // provider's implicit default would execute unchecked. The stored variant
    // consults the encrypted account and the durable enforcing-org marker, so
    // it fails closed before initialization completes. The `&&` ordering keeps
    // the read off the common path.
    if (
      effectiveModelIsUnknown &&
      (await isOrgModelPolicyActiveForStoredAccount(workOwner))
    ) {
      // Refuse over substitute: the model this send would run is unknown, and
      // every downstream check treats an unknown model as permitted.
      //
      // This deliberately OUTRANKS the billing dead end below. Both refuse, so
      // no partial state is written either way; when a policy is active and the
      // model is unknown the compliance axis is the one that must not be
      // guessed at, and naming a billing cause for it would be a diagnosis this
      // branch cannot actually support.
      context.fail(
        command,
        'invalid_payload',
        'Your organization policy could not be applied to this message. Try again.',
      );
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }
    // A DEFINITE "no lane can run this" answer, refused for its own reason.
    //
    // Reached only when the policy branch above did not already refuse — i.e.
    // no org policy is active, or the provider is Ollama (policy-exempt at
    // every layer, and its default is legitimately nullable, so it must never
    // be refused here).
    //
    // KNOWN GAP for the Ollama carve-out: `dispatchWorktreeChatTurn` has no
    // matching exemption, and `resolveDefaultModelLane` computes `missing` over
    // the cloud lanes only. So an Ollama-forced tab whose configured local
    // model has dropped out of `OLLAMA_MODELS` passes here, gets persisted, and
    // then throws a billing-worded error for a purely local problem. The
    // trigger is narrow — `getOllamaService().initialize()` restores the
    // catalog from its on-disk cache, so a merely stopped server does not hit
    // it — and closing it means either refusing Ollama sends here (which the
    // "policy-exempt, legitimately nullable" rule this carve-out encodes
    // deliberately forbids) or teaching dispatch to fail open for Ollama and
    // let the Ollama runtime give the real error. The latter is the right fix
    // and is a behavior change beyond this preflight.
    //
    // Collapsing this outcome into "unknown model" is what made a Portal
    // worktree send with no payload model and no tab model proceed:
    // `sendWorktreeChatMessage` persisted the tab and the user message, and only
    // THEN did `dispatchWorktreeChatTurn` throw `NoDispatchableModelError` —
    // durably recording a prompt that provably could not run. Mirrors
    // `handlePortalStandaloneChatSend`.
    if (
      storedDefault?.noDispatchableModel &&
      effectiveProviderType !== 'ollama'
    ) {
      context.fail(
        command,
        'invalid_payload',
        noDispatchableModelSendMessage(
          storedDefault.noDispatchableModel.missing,
        ),
      );
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }
    const effectiveModel =
      requestedModel ?? tabOptions.model ?? storedDefault?.model;
    if (
      effectiveModel &&
      (await isModelBlockedByStoredPolicy(effectiveModel, workOwner))
    ) {
      // `invalid_payload` is reused for policy denials because
      // `PortalAdapterFailureCode` is a closed union mirrored cross-repo; the
      // human-readable message is what distinguishes "forbidden" from
      // "malformed" until a dedicated code exists.
      context.fail(
        command,
        'invalid_payload',
        'This model is blocked by your organization policy.',
      );
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }
    // A CONCRETE model (explicitly requested, or persisted on the tab) is
    // judged by ITS OWN lanes, exactly as `resolveStandaloneChatPolicyModels`
    // does for cowork. The dead-end guard above only covers the IMPLICIT
    // default, so a pinned model whose native lane and the credits lane are
    // both confirmed dead still reached `sendWorktreeChatMessage`, which
    // persists the tab and the user message before dispatch fails — the same
    // partial state that guard exists to prevent, one branch over.
    //
    // Fails OPEN on anything unknown (see
    // `resolveConcreteModelDispatchability`): only a provable dead end refuses,
    // because refusing a model the user explicitly picked is unrecoverable
    // while letting it through just yields dispatch's own specific error.
    const concreteBillingRefusal =
      effectiveModel &&
      (requestedModel !== undefined || tabOptions.model !== undefined)
        ? await resolveSendBillingRefusal({
            concreteModel: effectiveModel,
            credentialScope: {
              workspaceId: command.payload.projectId,
              ...(command.payload.chatId
                ? {
                    workOwnerSession: {
                      projectId: command.payload.projectId,
                      worktreeId: command.payload.worktreeId,
                      chatId: command.payload.chatId,
                    },
                  }
                : {}),
            },
          })
        : null;
    if (concreteBillingRefusal !== null) {
      context.fail(command, 'invalid_payload', concreteBillingRefusal);
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
      return;
    }

    // Portal sends enter main directly (no renderer pass), so `@`-mentioned
    // prompt pills must be expanded here — the single expansion point for this
    // path; renderer sends already expanded before dispatch and carry no
    // prompt-kind references. An unreadable prompt keeps its pill intact.
    const opaqueFileReferences = sanitizePortalFileReferences(
      command.payload.fileReferences,
    );
    const wireFileReferences = opaqueFileReferences?.map((reference) =>
      portalFileReferences.resolve(
        {
          sessionId: context.sessionId ?? '',
          projectId: command.payload.projectId,
          worktreeId: command.payload.worktreeId,
          canRead: context.canReadAssets,
        },
        reference,
      ),
    );
    const expanded =
      wireFileReferences !== undefined
        ? await expandWorkspacePromptMentions(
            command.payload.projectId,
            command.payload.text,
            wireFileReferences,
          )
        : undefined;

    if (
      context.chatStatePort &&
      command.payload.chatId &&
      command.payload.userMessageId
    ) {
      assertWorktreeChatSendNotSplitLocked(
        command.payload.projectId,
        command.payload.worktreeId,
      );
      const expandedReferences = expanded?.fileReferences ?? wireFileReferences;
      const outcome = await dispatchRevisionedChatCommand(
        command,
        context,
        {
          projectId: command.payload.projectId,
          worktreeId: command.payload.worktreeId,
          chatId: command.payload.chatId,
        },
        {
          type: 'chat.send_message',
          chatId: command.payload.chatId,
          userMessageId: command.payload.userMessageId,
          text: expanded?.text ?? command.payload.text,
          ...(coworkSend && effectiveModel ? { model: effectiveModel } : {}),
          ...(coworkSend ? { providerType: effectiveProviderType } : {}),
          // Captured with the accepted message, as the compatibility path
          // does. A remote New Task submits Auto here; older clients omit it.
          ...(command.payload.modelSelectionMode === 'auto'
            ? { modelSelectionMode: 'auto' as const }
            : {}),
          ...(command.payload.selectedRepoId
            ? { selectedRepoId: command.payload.selectedRepoId }
            : {}),
          ...(hasExplicitModelConfig &&
          Object.keys(mergedModelConfig).length > 0
            ? { modelConfig: mergedModelConfig }
            : {}),
          ...(command.payload.planReviewApproval
            ? { planReviewApproval: command.payload.planReviewApproval }
            : {}),
          ...(command.payload.planMode !== undefined
            ? { planMode: command.payload.planMode }
            : {}),
          ...(command.payload.codexProposalMode !== undefined
            ? { codexProposalMode: command.payload.codexProposalMode }
            : {}),
          ...(command.payload.inputMode
            ? { inputMode: command.payload.inputMode }
            : {}),
          ...(context.origin ? { agentSent: context.origin } : {}),
          ...(expandedReferences?.length
            ? { fileReferences: expandedReferences }
            : {}),
          ...(mergedAttachmentPaths.length > 0
            ? { attachmentPaths: mergedAttachmentPaths }
            : {}),
        },
        { portalSend: identity },
      );
      // Only a committed command owns the blobs. A `conflict` here is
      // explicitly retryable, so consuming on failure would delete the bytes
      // the retry needs.
      if (outcome === 'applied') {
        attachmentSendCommitted = true;
        await consumePortalChatAttachments({
          sessionId: attachmentSessionId,
          attachmentIds: materializedAttachmentIds,
        });
      } else if (outcome === 'already_applied') {
        // The original application already persisted its own materialized
        // paths. This retry still owns the freshly materialized duplicates,
        // but it also commits consumption of the remote blobs.
        await removeMaterializedPortalChatAttachments(
          materializedAttachmentPaths,
        );
        attachmentSendCommitted = true;
        await consumePortalChatAttachments({
          sessionId: attachmentSessionId,
          attachmentIds: materializedAttachmentIds,
        });
      } else if (outcome === 'indeterminate') {
        // A transport error can arrive after the service committed the
        // message. Probe the durable receipt to release the remote blobs when
        // possible, but retain these local files either way: only a concrete
        // unsuccessful outcome proves that no persisted message owns them.
        try {
          const probe = await context.queryChatSendReceipt?.({
            scope: {
              workspaceId: command.payload.projectId,
              worktreeId: command.payload.worktreeId,
              chatId: command.payload.chatId,
            },
            commandId: command.id,
          });
          if (probe?.outcome === 'matched') {
            attachmentSendCommitted = true;
            await consumePortalChatAttachments({
              sessionId: attachmentSessionId,
              attachmentIds: materializedAttachmentIds,
            });
          }
        } catch {
          // Receipt lookup is itself best-effort. An unavailable store cannot
          // turn an indeterminate dispatch into proof that the send failed.
        }
      } else {
        await removeMaterializedPortalChatAttachments(
          materializedAttachmentPaths,
        );
      }
      return;
    }

    const sendRequest = {
      ...tabOptions,
      ...command.payload,
      ...(context.origin ? { agentSent: context.origin } : {}),
      initiationSource: 'portal' as const,
      fileReferences: wireFileReferences,
      // A payload model implies its provider. `...tabOptions` spreads first
      // and a JSON payload simply omits absent fields, so an explicit
      // payload model with no explicit provider would otherwise inherit the
      // TAB's provider. That hands the service a contradictory pair which it
      // persists, and `worktree-chat-turn` resolves `options.providerType ??
      // getProviderForModel(options.model)` — the stale provider wins, so a
      // Claude model runs through Codex.
      //
      // Reuses `payloadProvider` rather than re-deriving, so this and the
      // session-id drop above can never disagree about which provider the
      // payload implies. That also keeps the guard honest about untrusted
      // input: `command.payload` is remote JSON, and a re-derivation gated on
      // `model !== undefined` would accept `null` and write `'claude'` here
      // while `payloadProvider` stayed `undefined` above. `payloadProvider`
      // is the payload's explicit provider when it has one, so an explicit
      // choice still wins.
      ...(payloadProvider === undefined
        ? {}
        : { providerType: payloadProvider }),
      // Keep a captured harness only while continuing that harness. A model
      // switch must let the downstream service resolve and capture the new
      // harness instead of forcing the previous tab's value.
      ...(!switchesHarness && tabOptions.executionHarness
        ? { executionHarness: tabOptions.executionHarness }
        : {}),
      ...(expanded
        ? {
            text: expanded.text,
            fileReferences:
              expanded.fileReferences.length > 0
                ? expanded.fileReferences
                : undefined,
          }
        : {}),
      ...(!expanded && wireFileReferences !== undefined
        ? { fileReferences: wireFileReferences }
        : {}),
      ...(Object.keys(mergedModelConfig).length > 0
        ? { modelConfig: mergedModelConfig }
        : {}),
    };
    // Watcher and delegation provenance are host-authored. Portal payloads are
    // untrusted runtime JSON and may carry fields outside their TypeScript
    // contract, so strip these fields after the payload spread rather than
    // allowing remote messages to impersonate local host deliveries.
    Reflect.deleteProperty(sendRequest, 'watcherFired');
    Reflect.deleteProperty(sendRequest, 'delegationNoticeBatchId');
    Reflect.deleteProperty(sendRequest, 'watcherPartSnapshots');
    // An internal row is a host-issued delegation request that no surface
    // shows. A remote payload must never mark its own prompt that way.
    Reflect.deleteProperty(sendRequest, 'internalRow');
    Reflect.deleteProperty(sendRequest, 'managedDelegationDeliveryId');
    // Approval state is host-owned. Portal JSON must not escalate a chat by
    // smuggling fields outside the wire contract through the payload spread.
    Reflect.deleteProperty(sendRequest, 'approvalMode');
    Reflect.deleteProperty(sendRequest, 'sessionApprovalRules');
    Reflect.deleteProperty(sendRequest, 'admittedApproval');
    // Refs were materialized above; the service only understands local paths.
    Reflect.deleteProperty(sendRequest, 'cloudAttachments');
    // Sender attribution is main-owned; the payload spread above is never an
    // authority source even when its runtime shape exceeds the wire type.
    Reflect.deleteProperty(sendRequest, 'agentSent');
    if (context.origin) {
      Reflect.set(sendRequest, 'agentSent', context.origin);
    }
    if (mergedAttachmentPaths.length > 0) {
      sendRequest.attachmentPaths = mergedAttachmentPaths;
    }

    const result = await sendWorktreeChatMessage(sendRequest, {
      getWindow: context.getWindow,
    });
    attachmentSendCommitted = true;
    context.complete(command, {
      ok: true,
      chatId: result.chatId,
      ...(await sendReceiptFields(
        {
          projectId: sendRequest.projectId,
          worktreeId: sendRequest.worktreeId,
          chatId: result.chatId,
        },
        sendRequest.userMessageId,
      )),
    });
    // Accepted: the local files are now the record of the message, so the
    // uploaded blobs can be released (best-effort — see
    // `consumePortalChatAttachments`).
    await consumePortalChatAttachments({
      sessionId: attachmentSessionId,
      attachmentIds: materializedAttachmentIds,
    });
  } catch (error) {
    if (!attachmentSendCommitted) {
      await removeMaterializedPortalChatAttachments(
        materializedAttachmentPaths,
      );
    }
    failServiceError(command, context, error);
  }
}

/**
 * Validate the routing fields (`projectId`/`worktreeId`/`chatId`) shared by
 * portal chat mutations. Returns the target on success, or `null` after
 * failing the command.
 */
function readChatCommandTarget(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): { projectId: string; worktreeId: string; chatId: string } | null {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.projectId !== 'string' ||
    payload.projectId.length === 0 ||
    typeof payload.worktreeId !== 'string' ||
    payload.worktreeId.length === 0 ||
    typeof payload.chatId !== 'string' ||
    payload.chatId.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Chat command requires projectId, worktreeId and chatId.',
    );
    return null;
  }
  try {
    validateId(payload.projectId, 'projectId');
    validateId(payload.worktreeId, 'worktreeId');
    validateId(payload.chatId, 'chatId');
  } catch {
    context.fail(
      command,
      'invalid_payload',
      'projectId, worktreeId and chatId must be valid ids.',
    );
    return null;
  }
  return {
    projectId: payload.projectId,
    worktreeId: payload.worktreeId,
    chatId: payload.chatId,
  };
}

/**
 * Push a composer-control change into the desktop renderer so it applies the
 * same store action a local click would (CAN-1217). The renderer's own persist
 * then re-projects the change back to the portal, so this is the single write
 * path. Fails the command if no renderer window can receive the push.
 */
async function dispatchComposerCommand(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  composerCommand: PortalChatComposerCommand,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(command, context)) return;
  // Name the close-blocking work before either the canonical command path or
  // renderer fallback can create a side effect.
  if (composerCommand.kind === 'close') {
    const { chatCloseBlockReason } =
      await import('../../agents/background-work');
    const reason = chatCloseBlockReason(
      composerCommand.projectId,
      composerCommand.worktreeId,
      composerCommand.chatId,
    );
    if (reason === 'delegates') {
      context.fail(command, 'conflict', LIVE_DELEGATES_CHAT_REFUSAL, true);
      return;
    }
    if (reason === 'background') {
      context.fail(command, 'conflict', BACKGROUND_WORK_CHAT_REFUSAL, true);
      return;
    }
  }
  if (context.chatStatePort && composerCommand.kind === 'close') {
    try {
      const snapshot = await queryPortalChatState(context, {
        projectId: composerCommand.projectId,
        worktreeId: composerCommand.worktreeId,
      });
      const tab = snapshot.tabsFile.tabs.find(
        (candidate) => candidate.id === composerCommand.chatId,
      );
      if (!tab) {
        context.fail(command, 'not_found', 'The chat tab was not found.');
        return;
      }
      const runtime = snapshot.runtimeByChatId[composerCommand.chatId];
      const queued = snapshot.queue.find(
        (entry) => entry.chatId === composerCommand.chatId,
      )?.queue;
      if (
        tab.pendingPlanExit !== undefined ||
        (runtime !== undefined &&
          [
            'queued',
            'starting',
            'streaming',
            'awaiting_input',
            'completing',
          ].includes(runtime.status)) ||
        (runtime?.queuedMessageIds.length ?? 0) > 0 ||
        (queued?.length ?? 0) > 0
      ) {
        context.fail(
          command,
          'conflict',
          'The chat cannot be closed while work is active or awaiting review.',
          true,
        );
        return;
      }
      await dispatchRevisionedChatCommand(
        command,
        context,
        composerCommand,
        {
          type: 'chat.close_tab',
          tabId: composerCommand.chatId,
          mode:
            (tab.transcript?.messageCount ??
              tab.transcript?.committedMessageCount ??
              tab.messages.length) > 0
              ? 'archive'
              : 'discard_empty',
          ...(snapshot.tabsFile.tabs.length === 1
            ? { replacementTabId: randomUUID() }
            : {}),
        },
        { expectedRevision: snapshot.revision },
      );
    } catch {
      context.fail(
        command,
        'execution_failed',
        'The chat state service is temporarily unavailable.',
        true,
      );
    }
    return;
  }
  const revisioned = toRevisionedCommand(composerCommand);
  if (context.chatStatePort && revisioned) {
    await dispatchRevisionedChatCommand(
      command,
      context,
      {
        projectId: composerCommand.projectId,
        worktreeId: composerCommand.worktreeId,
        chatId: composerCommand.chatId,
      },
      revisioned,
    );
    return;
  }
  const delivery = sendToWindowDetailed(
    (context.getWindow ?? ((): null => null))(),
    IPC_CHANNELS.chatPortalComposerCommand,
    composerCommand,
  );
  if (!delivery.delivered) {
    context.fail(
      command,
      'execution_failed',
      `Cannot apply composer change without a desktop app window (${delivery.reason}).`,
      true,
    );
    return;
  }
  context.complete(command, { ok: true });
}

async function dispatchCorrelatedChatCommand(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  chatCommand:
    | PortalChatComposerSetterCommand
    | Extract<PortalChatComposerLifecycleCommand, { kind: 'branch' | 'share' }>,
): Promise<void> {
  const revisioned = toRevisionedCommand(chatCommand);
  if (
    (chatCommand.kind === 'model' ||
      chatCommand.kind === 'thinking' ||
      chatCommand.kind === 'plan' ||
      chatCommand.kind === 'fast') &&
    (await portalSettingsUseCore(chatCommand, context))
  ) {
    await dispatchPortalSettingsThroughCore(command, context, chatCommand);
    return;
  }
  if (
    context.chatStatePort &&
    revisioned &&
    chatCommand.kind !== 'model' &&
    chatCommand.kind !== 'thinking' &&
    chatCommand.kind !== 'plan' &&
    chatCommand.kind !== 'fast'
  ) {
    await dispatchRevisionedChatCommand(
      command,
      context,
      {
        projectId: chatCommand.projectId,
        worktreeId: chatCommand.worktreeId,
        chatId: chatCommand.chatId,
      },
      revisioned,
    );
    return;
  }
  const result = await requestPortalComposerCommand(
    { requestId: command.id, command: chatCommand },
    { getMainWindow: context.getWindow ?? ((): null => null) },
  );
  if (result.ok) {
    context.complete(command, { ok: true, ...(result.data ?? {}) });
    return;
  }
  context.fail(command, result.code, result.error, result.retryable);
}

type PortalSettingsCommand = Extract<
  PortalChatComposerSetterCommand,
  { kind: 'model' | 'thinking' | 'plan' | 'fast' }
>;

/**
 * Whether a Portal model, thinking, plan or fast change runs through
 * `core.chat.update` (CAN-4110 D7) rather than the renderer.
 */
async function portalSettingsUseCore(
  command: PortalSettingsCommand,
  context: PortalAdapterContext,
): Promise<boolean> {
  if (
    !context.chatStatePort ||
    !getActiveDesktopRuntimeIfAccepting() ||
    command.projectId === APP_ADVISOR_PROJECT_ID ||
    command.projectId === PIPELINE_EDITOR_PROJECT_ID
  )
    return false;
  const window = context.getWindow();
  const windowOpen = window !== null && !window.isDestroyed();
  const change = portalSettingsChange(command);
  // A model change with a window open needs no snapshot read to refuse.
  if (chatSettingsRoute(change, undefined, windowOpen).route !== 'core')
    return false;
  let snapshot: ChatStateSnapshot;
  try {
    snapshot = await queryPortalChatState(context, {
      projectId: command.projectId,
      worktreeId: command.worktreeId,
    });
  } catch {
    return false;
  }
  const tab = snapshot.tabsFile.tabs.find(
    (candidate) => candidate.id === command.chatId,
  );
  // Without a window the core takes a terminal-backed change and main
  // relaunches the terminal itself (CAN-5097).
  return chatSettingsRoute(change, tab, windowOpen).route === 'core';
}

function portalSettingsChange(
  command: PortalSettingsCommand,
): ChatSettingsChange {
  switch (command.kind) {
    case 'model':
      return { kind: 'model', model: command.model };
    case 'plan':
      return { kind: 'plan', planMode: command.planMode };
    case 'thinking':
      return { kind: 'thinking' };
    case 'fast':
      return { kind: 'fast' };
  }
}

function portalSettingsAction(command: PortalSettingsCommand): unknown {
  switch (command.kind) {
    case 'plan':
      return {
        type: 'chat.patch_tab_settings',
        tabId: command.chatId,
        patch: { planMode: command.planMode },
      };
    case 'thinking':
      return {
        type: 'chat.patch_tab_settings',
        tabId: command.chatId,
        patch: { modelConfig: { thinkingLevel: command.thinkingLevel } },
      };
    case 'fast':
      return {
        type: 'chat.patch_tab_settings',
        tabId: command.chatId,
        patch: { modelConfig: { fastMode: command.fastMode } },
      };
    case 'model':
      return {
        type: 'chat.set_model',
        tabId: command.chatId,
        model: command.model,
        providerType: requireProviderForModel(command.model),
        ...(command.executionHarness
          ? { executionHarness: command.executionHarness }
          : {}),
      };
  }
}

async function dispatchPortalSettingsThroughCore(
  portalCommand: PortalCommandEnvelope,
  context: PortalAdapterContext,
  command: PortalSettingsCommand,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(portalCommand, context)) return;
  const runtime = getActiveDesktopRuntimeIfAccepting();
  if (!runtime) {
    context.fail(
      portalCommand,
      'execution_failed',
      'The desktop app could not apply the composer change.',
      true,
    );
    return;
  }
  const commandId = portalCommand.id;
  let result: ReturnType<typeof CoreChatLifecycleResultSchema.parse>;
  try {
    result = CoreChatLifecycleResultSchema.parse(
      await runtime.instruction(
        'core.chat.update',
        CoreChatUpdateParamsSchema.parse({
          projectId: command.projectId,
          worktreeId: command.worktreeId,
          commandId,
          origin: 'portal',
          action: portalSettingsAction(command),
          _meta: { idempotencyKey: commandId },
        }),
        {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'portal-command',
            authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
            interfaceKind: 'desktop',
            grants: ['core.chat.write'],
          },
          metadata: { idempotencyKey: commandId },
        },
      ),
    );
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.kind === 'invalid_argument'
    ) {
      context.fail(portalCommand, 'invalid_payload', error.payload.message);
      return;
    }
    context.fail(
      portalCommand,
      'execution_failed',
      'The desktop app could not apply the composer change.',
      error instanceof CanopyOperationError &&
        error.payload.kind === 'unavailable'
        ? true
        : undefined,
    );
    return;
  }
  switch (result.outcome) {
    case 'applied':
    case 'already_applied':
      if (command.kind === 'thinking' || command.kind === 'model') {
        const target = {
          projectId: command.projectId,
          worktreeId: command.worktreeId,
          chatId: command.chatId,
        };
        try {
          await getClaudeTerminalSessionService().restartForSettingsChange(
            target,
          );
        } catch (error: unknown) {
          logMainProcessWarn(
            '[portal] Could not restart the Claude terminal after a settings change',
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      }
      context.complete(portalCommand, { ok: true });
      return;
    case 'not_found':
      context.fail(
        portalCommand,
        'not_found',
        'The target chat is no longer available.',
      );
      return;
    case 'conflict':
      context.fail(
        portalCommand,
        'conflict',
        result.reason ?? 'The chat changed. Try again.',
        true,
      );
      return;
    case 'rejected':
      context.fail(
        portalCommand,
        'invalid_target',
        result.reason ?? 'The composer change is not available for this chat.',
      );
      return;
  }
}

function toRevisionedCommand(
  command: PortalChatComposerCommand | PortalChatQuestionMutationCommand,
): ChatCommand | null {
  switch (command.kind) {
    case 'create':
      return { type: 'chat.create_tab', tabId: command.chatId };
    case 'close':
      return {
        type: 'chat.close_tab',
        tabId: command.chatId,
        mode: 'archive',
      };
    case 'model':
      return {
        type: 'chat.set_model',
        tabId: command.chatId,
        model: command.model,
        providerType: requireProviderForModel(command.model),
      };
    case 'thinking':
      return {
        type: 'chat.patch_tab_settings',
        tabId: command.chatId,
        patch: { modelConfig: { thinkingLevel: command.thinkingLevel } },
      };
    case 'plan':
      return {
        type: 'chat.patch_tab_settings',
        tabId: command.chatId,
        patch: { planMode: command.planMode },
      };
    case 'fast':
      return {
        type: 'chat.patch_tab_settings',
        tabId: command.chatId,
        patch: { modelConfig: { fastMode: command.fastMode } },
      };
    case 'plugins':
      return {
        type: 'chat.patch_tab_settings',
        tabId: command.chatId,
        patch: {
          pluginSelections: command.selections,
          ...(command.deferredToolsAllowed !== undefined
            ? { deferredToolsAllowed: command.deferredToolsAllowed }
            : {}),
        },
      };
    case 'answer_question':
      return {
        type: 'chat.answer_question',
        chatId: command.chatId,
        questionId: command.questionRequestId,
        answers: command.answers,
      };
    case 'dismiss_question':
      return {
        type: 'chat.dismiss_question',
        chatId: command.chatId,
        questionId: command.questionRequestId,
      };
    default:
      return null;
  }
}

/**
 * The committed user message and whether it started its turn or waits behind
 * the running one, for remote writers to report. The message is already
 * committed, so a failed queue lookup only omits `delivery`.
 */
export async function sendReceiptFields(
  target: { projectId: string; worktreeId: string; chatId: string },
  userMessageId: string | undefined,
): Promise<{ userMessageId?: string; delivery?: 'accepted' | 'queued' }> {
  if (!userMessageId) return {};
  try {
    const { getChatQueueService } =
      await import('../../services/chat-queue-service');
    const queue = getChatQueueService();
    const queued =
      queue.holdsUserMessage(target, userMessageId) &&
      queue.runningTurnUserMessageId(target) !== userMessageId;
    return { userMessageId, delivery: queued ? 'queued' : 'accepted' };
  } catch {
    return { userMessageId };
  }
}

/**
 * Send one revisioned chat command through the chat-state port, completing or
 * failing the portal command from the outcome. Returns the concrete outcome
 * so callers can distinguish a new commit from an idempotent retry when
 * managing side effects such as materialized attachment files.
 */
async function dispatchRevisionedChatCommand(
  portalCommand: PortalCommandEnvelope,
  context: PortalAdapterContext,
  target: { projectId: string; worktreeId: string; chatId: string },
  chatCommand: ChatCommand,
  options: {
    expectedRevision?: number;
    portalSend?: PortalChatSendIdentity;
  } = {},
): Promise<ChatCommandOutcome | 'indeterminate' | null> {
  if (rejectUntrustedPortalChatInput(portalCommand, context)) return null;
  const port = context.chatStatePort;
  if (!port) {
    context.fail(
      portalCommand,
      'execution_failed',
      'Chat state is unavailable for this command.',
    );
    return null;
  }
  const advisorQueueCommand =
    target.projectId === APP_ADVISOR_PROJECT_ID &&
    (chatCommand.type === 'chat.cancel_queued_message' ||
      chatCommand.type === 'chat.edit_queued_message' ||
      chatCommand.type === 'chat.force_queued_message' ||
      chatCommand.type === 'chat.steer_queued_message' ||
      chatCommand.type === 'chat.set_queued_message_edit_lock' ||
      chatCommand.type === 'chat.input_delivery_action');
  if (
    (target.projectId === APP_ADVISOR_PROJECT_ID && !advisorQueueCommand) ||
    target.projectId === PIPELINE_EDITOR_PROJECT_ID
  ) {
    context.fail(
      portalCommand,
      'invalid_payload',
      'This embedded chat scope is not available through the portal.',
    );
    return null;
  }
  try {
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: portalCommand.id,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      origin: 'portal',
      ...(options.expectedRevision !== undefined
        ? { expectedRevision: options.expectedRevision }
        : {}),
      command: chatCommand,
    };
    const executionOptions: PortalChatCommandExecutionOptions | undefined =
      chatCommand.type === 'chat.send_message' &&
      (context.canReadAssets || options.portalSend)
        ? {
            ...(context.canReadAssets
              ? { canCommitSend: context.canReadAssets }
              : {}),
            ...(options.portalSend ? { portalSend: options.portalSend } : {}),
          }
        : chatCommand.type === 'chat.answer_question' && context.origin
          ? { agentSent: context.origin }
          : undefined;
    const result = context.dispatchChatCommand
      ? executionOptions
        ? await context.dispatchChatCommand(request, executionOptions)
        : await context.dispatchChatCommand(request)
      : executionOptions
        ? await port.command(request, executionOptions)
        : await port.command(request);
    if (result.outcome === 'applied' || result.outcome === 'already_applied') {
      context.complete(
        portalCommand,
        chatCommand.type === 'chat.send_message'
          ? {
              ...result,
              ...(await sendReceiptFields(
                target,
                result.messageId ?? chatCommand.userMessageId,
              )),
            }
          : result,
      );
      return result.outcome;
    }
    const code =
      result.outcome === 'not_found'
        ? 'not_found'
        : result.outcome === 'conflict'
          ? 'conflict'
          : 'execution_failed';
    context.fail(
      portalCommand,
      code,
      result.reason ?? 'The chat command was not applied.',
      result.outcome === 'conflict',
    );
    return result.outcome;
  } catch {
    context.fail(
      portalCommand,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
    return 'indeterminate';
  }
}

type RemoteCreateTabSeed =
  | { noDispatchableModel: 'billing-lane' | 'policy-allowance' | 'both' }
  | Pick<
      Extract<ChatCommand, { type: 'chat.create_tab' }>,
      | 'model'
      | 'defaultStampModel'
      | 'providerType'
      | 'modelConfig'
      | 'deferredToolsAllowed'
      | 'aiCreditsRouting'
      | 'subscriptionBillingOverride'
    >;

/** A model a remote client chose for a chat it is creating (New Task). */
export interface RemoteCreateTabModel {
  model: ChatModel;
  providerType?: AgentProviderType;
}

/** Settings a remote New Task submits with `portal.chat.create_tab`. */
interface RemoteCreateTabSettings {
  requested?: RemoteCreateTabModel;
  pluginSelections?: ChatTabPluginSelections;
}

const REMOTE_CREATE_TAB_PROVIDERS: readonly AgentProviderType[] = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'copilot',
];

function isRemoteCreateTabProvider(value: unknown): value is AgentProviderType {
  return REMOTE_CREATE_TAB_PROVIDERS.some((provider) => provider === value);
}

/**
 * Read the optional New Task settings from a create payload. Every field is
 * optional, so a client that sends none (the `+` button, older browsers) gets
 * the scoped default exactly as before. A provider is honored only with a
 * model: the model owns the tab's routing, and a bare provider would
 * contradict the default model the seed resolves.
 */
function readRemoteCreateTabSettings(
  payload: unknown,
):
  | { ok: true; settings: RemoteCreateTabSettings }
  | { ok: false; error: string } {
  if (!isRecord(payload)) return { ok: true, settings: {} };
  const { model, providerType, pluginSelections } = payload;
  if (
    model !== undefined &&
    (typeof model !== 'string' || model.length === 0 || model.length > 256)
  )
    return { ok: false, error: 'model must be a model id.' };
  if (providerType !== undefined && !isRemoteCreateTabProvider(providerType))
    return { ok: false, error: 'providerType is not supported.' };
  if (pluginSelections !== undefined && !isRecord(pluginSelections))
    return {
      ok: false,
      error: 'pluginSelections must be a plugin-selections object.',
    };
  return {
    ok: true,
    settings: {
      ...(typeof model === 'string'
        ? {
            requested: {
              // Same alias handling as the send preflight; a gateway model whose
              // catalog has not hydrated yet stays as submitted.
              model: resolveKnownModel(model) ?? model,
              ...(providerType !== undefined ? { providerType } : {}),
            },
          }
        : {}),
      ...(pluginSelections !== undefined
        ? { pluginSelections: normalizePluginSelections(pluginSelections) }
        : {}),
    },
  };
}

/** Billing defaults for a remotely created tab on `providerType`. */
function remoteCreateTabBillingSeed(
  providerType: AgentProviderType | undefined,
  billingFramework: string | undefined,
): Pick<
  Extract<ChatCommand, { type: 'chat.create_tab' }>,
  'aiCreditsRouting' | 'subscriptionBillingOverride'
> {
  if (
    providerType === 'cursor' ||
    providerType === 'copilot' ||
    providerType === 'opencode'
  )
    return {};
  if (billingFramework === 'ai-credits')
    return {
      aiCreditsRouting: {
        active: true,
        scope: 'persistent',
        activatedAt: Date.now(),
      },
    };
  return billingFramework === 'subscription'
    ? { subscriptionBillingOverride: true }
    : {};
}

/**
 * The defaults a remotely created tab is born with. Mirrors what the desktop
 * renderer's own `+` button seeds (`appendNewTab`): the scoped default model
 * and the deferred-tools default. Project default plugins are not copied in;
 * the chat inherits them live at each turn. Interface mode is intentionally
 * left unset — its default is gated on a
 * renderer-owned flag and a missing value already hydrates as the native
 * chat, which is the only mode a remote client can drive.
 */
export async function resolveRemoteCreateTabSeed(
  projectId: string,
  requested?: RemoteCreateTabModel,
): Promise<RemoteCreateTabSeed> {
  const cowork = isCoworkWorkspace(projectId);
  const preferences = await readPreferencesFile();
  const deferredToolsAllowed =
    (cowork
      ? preferences.deferredToolsStandaloneChatsEnabled
      : preferences.deferredToolsWorktreeChatsEnabled) ?? true;
  if (requested) {
    // An explicit choice, as the desktop New Task creates its tab with the
    // composer's model. No `defaultStampModel`: a later default change must
    // not reconcile the user's pick away. The send preflight still judges the
    // model's billing lanes before the first message commits.
    const providerType =
      requested.providerType ?? getProviderForModel(requested.model);
    return {
      model: requested.model,
      ...(providerType
        ? {
            providerType,
            modelConfig: resolveProviderModelConfig(
              providerType,
              {},
              preferences.providerModelConfigDefaults,
            ),
          }
        : {}),
      deferredToolsAllowed,
      ...remoteCreateTabBillingSeed(
        providerType,
        preferences.lastChatBillingFramework,
      ),
    };
  }
  const resolution = await resolveLaneAwareDefaultSelection(
    preferences,
    cowork ? 'chat' : 'worktree',
    // Same workspace the eventual session spawn resolves its Canopy
    // Environments credentials for.
    { workspaceId: projectId },
    undefined,
    undefined,
    // Creating a tab is not a statement about the user's default model, so
    // it must not stamp the Portal catalog projection (a debounced
    // preferences write).
    false,
  );
  if (resolution.outcome === 'no-dispatchable-model') {
    return {
      noDispatchableModel:
        resolution.missing === 'policy-allowance' ||
        (resolution.missing === 'both' && !resolution.hasPolicyAllowedLane)
          ? 'policy-allowance'
          : resolution.missing,
    };
  }
  const { selection } = resolution;
  const model = resolveKnownModel(selection.model) ?? selection.model;
  // `getProviderForModel`, not `requireProviderForModel`: a gateway or custom
  // model whose catalog has not hydrated yet is still a valid default, and
  // dispatch derives the provider again from the model at send time. Failing
  // the create here turned a resolvable default into a dead `+` button.
  const providerType = getProviderForModel(model);
  const billingSeed = remoteCreateTabBillingSeed(
    providerType,
    resolution.lane === 'ai-credits' && !resolution.provisional
      ? 'ai-credits'
      : preferences.lastChatBillingFramework,
  );
  return {
    model,
    defaultStampModel: model,
    ...(providerType ? { providerType } : {}),
    modelConfig: providerType
      ? resolveProviderModelConfig(
          providerType,
          selection,
          preferences.providerModelConfigDefaults,
        )
      : {
          ...selection.modelConfig,
          thinkingLevel: selection.thinkingLevel,
        },
    deferredToolsAllowed,
    ...billingSeed,
  };
}

/**
 * Create a new empty worktree chat tab on the desktop with the browser-minted
 * `chatId` (CAN-1233, the portal `+` tab button). Initialize the canonical
 * tab with the scoped desktop default before projecting its summary. The
 * renderer's local fallback label is not persisted and cannot seed remote
 * composers. Older hosts without a state port use the renderer create path.
 */
export async function handlePortalChatCreateTab(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.create_tab']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(command, context)) return;
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  if (
    context.canReadAssets &&
    (!context.canReadAssets() || !context.chatStatePort)
  ) {
    context.fail(
      command,
      'invalid_target',
      'A current paired canonical chat service is required to create this chat.',
    );
    return;
  }
  const key = inFlightCreateTabKey(target);
  const creating = createPortalChatTab(command, context, target);
  const settled = creating.then(
    () => undefined,
    () => undefined,
  );
  inFlightCreateTabs.set(key, settled);
  try {
    await creating;
  } finally {
    if (inFlightCreateTabs.get(key) === settled) {
      inFlightCreateTabs.delete(key);
    }
  }
}

/**
 * Creates still being applied, keyed by chat target. A Portal `+` followed
 * quickly by that tab's close reaches the desktop as two concurrent commands,
 * and the create first resolves the scoped default model. A close that ran
 * meanwhile found no tab ("The chat tab was not found.") and the new chat
 * survived, so a close waits for its chat's in-flight create.
 */
const inFlightCreateTabs = new Map<string, Promise<void>>();

function inFlightCreateTabKey(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

async function createPortalChatTab(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.create_tab']
  >,
  context: PortalAdapterContext,
  target: { projectId: string; worktreeId: string; chatId: string },
): Promise<void> {
  if (context.chatStatePort) {
    // A remote New Task creates its chat with the composer's model and plugins,
    // as the desktop New Task does, so the first prompt runs on them. Older
    // hosts ignore these fields and create a default tab.
    const read = readRemoteCreateTabSettings(command.payload);
    if (!read.ok) {
      context.fail(command, 'invalid_payload', read.error);
      return;
    }
    const { requested, pluginSelections } = read.settings;
    if (
      requested &&
      !(await acceptRemoteCreateTabModel(command, context, target, requested))
    ) {
      return;
    }
    const seed = await resolveRemoteCreateTabSeed(
      target.projectId,
      requested,
    ).catch(() => null);
    if (seed === null) {
      context.fail(
        command,
        'execution_failed',
        'The default model could not be loaded. Try creating the chat again.',
        true,
      );
      return;
    }
    if ('noDispatchableModel' in seed) {
      // A DEFINITE dead end is reported, never collapsed into a modelless
      // tab — that would silently reproduce the unset-model bug this path
      // exists to fix. Mirrors the send preflight above.
      context.fail(
        command,
        'invalid_payload',
        remoteCreateTabNoModelMessage(seed.noDispatchableModel),
      );
      return;
    }
    if (context.canReadAssets && !context.canReadAssets()) {
      context.fail(
        command,
        'invalid_target',
        'The paired session is no longer authorized.',
      );
      return;
    }
    await dispatchRevisionedChatCommand(command, context, target, {
      type: 'chat.create_tab',
      tabId: target.chatId,
      ...seed,
      ...(pluginSelections ? { pluginSelections } : {}),
    });
    return;
  }
  // Without a state port the send takes the compatibility path, which applies
  // the submitted model, Auto mode and plugins itself.
  await dispatchComposerCommand(command, context, {
    ...target,
    kind: 'create',
  });
}

/**
 * The same preflight `portal.chat.set_model` applies before a model is
 * persisted on a tab. Returns false after failing the command.
 */
async function acceptRemoteCreateTabModel(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  target: { projectId: string; worktreeId: string; chatId: string },
  requested: RemoteCreateTabModel,
): Promise<boolean> {
  const refusal = await remoteCreateTabModelRefusal(target, requested);
  if (refusal === null) return true;
  context.fail(command, 'invalid_payload', refusal);
  return false;
}

/**
 * Why a remote client may not create a chat on `requested`: a runtime that is
 * not connected, or a model the work owner's policy blocks. Null when it may.
 * Shared by Portal's create and the hosted controller's (CAN-5985).
 */
export async function remoteCreateTabModelRefusal(
  target: { projectId: string; worktreeId: string; chatId: string },
  requested: RemoteCreateTabModel,
): Promise<string | null> {
  const provider =
    requested.providerType ?? getProviderForModel(requested.model);
  const harness = getExecutionHarnessForModel(requested.model);
  if (
    (provider === 'cursor' || harness === 'cursor') &&
    !(await isCursorRuntimeAvailable())
  ) {
    return 'Connect Cursor in the desktop app to use it here.';
  }
  if (
    (provider === 'copilot' || harness === 'copilot') &&
    !(await isCopilotRuntimeAvailable())
  ) {
    return 'Connect Copilot in the desktop app to use it here.';
  }
  if (
    (provider === 'opencode' || harness === 'opencode') &&
    !(await isOpenCodeRuntimeAvailable())
  ) {
    return 'Connect OpenCode in the desktop app to use it here.';
  }
  const workOwner = await resolveAiCreditsScopeOwner({
    kind: 'work',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
  });
  if (await isModelBlockedByStoredPolicy(requested.model, workOwner)) {
    return 'This model is blocked by your organization policy.';
  }
  return null;
}

/**
 * The refusal for a create seed that has no model to run, as Portal's create
 * reports it: never a modelless tab.
 */
export function remoteCreateTabNoModelMessage(
  missing: 'billing-lane' | 'policy-allowance' | 'both',
): string {
  return missing === 'policy-allowance'
    ? 'Your organization policy allows no model that can run a new chat.'
    : 'No model is available for a new chat. Add a billing source, then try again.';
}

/**
 * Close an existing worktree chat tab on the desktop (the portal tab close
 * button). Reuses the composer-command push: the renderer drives its own
 * `closeTab` — which archives a chat with messages, discards an empty one,
 * replaces the last tab with a fresh empty one, and honors the streaming/
 * queued/pending-plan guard — and the subsequent tab persist emits a
 * `chat_summary` removal delta so connected portal clients evict the tab.
 * Idempotent on the renderer side — an unknown id is a no-op. Fails the command
 * if no renderer window can receive the push.
 */
export async function handlePortalChatCloseTab(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.close_tab']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  await inFlightCreateTabs.get(inFlightCreateTabKey(target));
  await dispatchComposerCommand(command, context, {
    ...target,
    kind: 'close',
  });
}

/**
 * Fork a worktree chat into a new tab (the portal's end-of-turn fork action).
 * Mirrors {@link handlePortalChatCloseTab}: the renderer drives its own
 * `forkTab`, so the portal inherits the desktop's fork semantics rather than
 * reimplementing transcript slicing and model normalization (CAN-2527).
 */
export async function handlePortalChatFork(
  // `unknown`, not the payload-map type: the payload arrives off the wire and
  // this handler is the validation boundary (`readChatCommandTarget` +
  // `isRecord`). A narrower type here would be a fiction the tests could only
  // exercise through casts.
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  const forkAfter = isRecord(command.payload)
    ? command.payload.forkAfterUserMessageId
    : undefined;
  if (forkAfter !== undefined && typeof forkAfter !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      'forkAfterUserMessageId must be a string when provided.',
    );
    return;
  }
  await dispatchComposerCommand(command, context, {
    ...target,
    kind: 'fork',
    ...(forkAfter !== undefined ? { forkAfterUserMessageId: forkAfter } : {}),
  });
}

/**
 * Branch a worktree chat into a new worktree (the portal's end-of-turn branch
 * action). The renderer drives its own `branchTab`, so the portal inherits the
 * desktop's branch semantics rather than reimplementing them (CAN-2528).
 */
export async function handlePortalChatBranch(
  // `unknown`, not the payload-map type: the payload arrives off the wire and
  // this handler is the validation boundary (`readChatCommandTarget` +
  // `isRecord`). A narrower type here would be a fiction the tests could only
  // exercise through casts.
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  const forkAfter = isRecord(command.payload)
    ? command.payload.forkAfterUserMessageId
    : undefined;
  if (forkAfter !== undefined && typeof forkAfter !== 'string') {
    context.fail(
      command,
      'invalid_payload',
      'forkAfterUserMessageId must be a string when provided.',
    );
    return;
  }
  await dispatchCorrelatedChatCommand(command, context, {
    ...target,
    kind: 'branch',
    ...(forkAfter !== undefined ? { forkAfterUserMessageId: forkAfter } : {}),
  });
}

/** Share a worktree chat as a run and return its share URL to the portal. */
export async function handlePortalChatShare(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) return;
  const payload = command.payload;
  const shareScope = isRecord(payload) ? payload.shareScope : undefined;
  if (
    shareScope !== 'private' &&
    shareScope !== 'team' &&
    shareScope !== 'organization'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'shareScope must be private, team, or organization.',
    );
    return;
  }
  const teamId = isRecord(payload) ? payload.teamId : undefined;
  const organizationId = isRecord(payload) ? payload.organizationId : undefined;
  if (
    (teamId !== undefined && typeof teamId !== 'string') ||
    (organizationId !== undefined && typeof organizationId !== 'string')
  ) {
    context.fail(
      command,
      'invalid_payload',
      'teamId and organizationId must be strings when provided.',
    );
    return;
  }
  try {
    assertShareScopeTarget({ shareScope, teamId, organizationId }, 'a run');
  } catch (error) {
    context.fail(
      command,
      'invalid_payload',
      error instanceof Error ? error.message : 'Invalid share target.',
    );
    return;
  }
  await dispatchCorrelatedChatCommand(command, context, {
    ...target,
    kind: 'share',
    shareScope,
    ...(teamId !== undefined ? { teamId } : {}),
    ...(organizationId !== undefined ? { organizationId } : {}),
  });
}

function isQuestionAnswers(value: unknown): value is McpQuestionAnswer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (answer) =>
        isRecord(answer) &&
        typeof answer.question === 'string' &&
        Array.isArray(answer.selectedOptions) &&
        answer.selectedOptions.every(
          (option): option is string => typeof option === 'string',
        ) &&
        (answer.questionId === undefined ||
          typeof answer.questionId === 'string') &&
        (answer.freeformText === undefined ||
          typeof answer.freeformText === 'string'),
    )
  );
}

/**
 * Portal answers and dismissals settle in the core (CAN-4128): through the
 * same function as core.chat.question.respond, never through the renderer.
 */
async function settlePortalChatQuestion(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  target: { projectId: string; worktreeId: string; chatId: string },
  questionId: string,
  response: ChatQuestionResponse,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(command, context)) return;
  if (
    target.projectId === APP_ADVISOR_PROJECT_ID ||
    target.projectId === PIPELINE_EDITOR_PROJECT_ID
  ) {
    context.fail(
      command,
      'invalid_payload',
      'This embedded chat scope is not available through the portal.',
    );
    return;
  }
  const port = context.chatStatePort;
  if (!port) {
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
    return;
  }
  const dispatchChatCommand = context.dispatchChatCommand;
  const outcome = await respondToChatQuestion({
    scope: { projectId: target.projectId, worktreeId: target.worktreeId },
    chatId: target.chatId,
    questionId,
    response,
    commandId: command.id,
    origin: 'portal',
    port,
    // A Portal session of the signed-in user answers as a person; an
    // external agent connected through it answers as an agent.
    ...(response.kind === 'answer'
      ? {
          executionOptions: context.origin
            ? { agentSent: context.origin }
            : { answeredByPerson: true },
        }
      : {}),
    ...(dispatchChatCommand
      ? {
          dispatch: (request, options): Promise<ChatCommandResult> =>
            options
              ? dispatchChatCommand(request, options)
              : dispatchChatCommand(request),
        }
      : {}),
  });
  switch (outcome.status) {
    case 'applied':
    case 'already_settled':
      context.complete(command, outcome.result);
      return;
    case 'not_found':
      context.fail(
        command,
        'not_found',
        'The question is no longer awaiting a response.',
      );
      return;
    case 'cancelled':
      context.fail(
        command,
        'execution_failed',
        'The question is no longer awaiting a response.',
      );
      return;
    case 'invalid':
      context.fail(command, 'execution_failed', outcome.message);
      return;
    case 'conflict':
      context.fail(
        command,
        'conflict',
        'The chat changed; read it again.',
        true,
      );
      return;
    case 'unavailable':
      context.fail(
        command,
        'execution_failed',
        'The chat state service is temporarily unavailable.',
        true,
      );
      return;
  }
}

export async function handlePortalChatAnswerQuestion(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.answer_question']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  if (
    typeof command.payload.requestId !== 'string' ||
    command.payload.requestId.length === 0 ||
    !isQuestionAnswers(command.payload.answers)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Question answer requires a requestId and valid answers array.',
    );
    return;
  }
  await settlePortalChatQuestion(
    command,
    context,
    target,
    command.payload.requestId,
    { kind: 'answer', answers: command.payload.answers },
  );
}

export async function handlePortalChatDismissQuestion(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.dismiss_question']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  if (
    typeof command.payload.requestId !== 'string' ||
    command.payload.requestId.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Question dismissal requires a requestId.',
    );
    return;
  }
  await settlePortalChatQuestion(
    command,
    context,
    target,
    command.payload.requestId,
    { kind: 'dismiss' },
  );
}

export async function handlePortalChatSetModel(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.set_model']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  if (command.payload.selectionMode === 'auto') {
    if (
      ('model' in command.payload && command.payload.model !== undefined) ||
      ('executionHarness' in command.payload &&
        command.payload.executionHarness !== undefined)
    ) {
      context.fail(
        command,
        'invalid_payload',
        'Auto selection must not include a concrete model.',
      );
      return;
    }
    await dispatchRevisionedChatCommand(command, context, target, {
      type: 'chat.patch_tab_settings',
      tabId: target.chatId,
      patch: { modelSelectionMode: 'auto' },
    });
    return;
  }
  if (
    command.payload.selectionMode !== undefined &&
    command.payload.selectionMode !== 'manual'
  ) {
    context.fail(command, 'invalid_payload', 'selectionMode is invalid.');
    return;
  }
  // Reject unknown model ids up front: the renderer's model-change path
  // rejects them via `resolveKnownModel` downstream, so acking here would
  // falsely report success for a model that never actually changes/persists.
  const knownModel =
    typeof command.payload.model === 'string'
      ? resolveKnownModel(command.payload.model)
      : undefined;
  // Policy and runtime checks judge the route an inheriting Agent pins.
  const model = knownModel
    ? await pinInheritingAgentToDestination(knownModel, target.projectId).catch(
        (): undefined => undefined,
      )
    : undefined;
  if (!model) {
    context.fail(command, 'invalid_payload', 'model must be a known model id.');
    return;
  }
  const selectedHarness = command.payload.executionHarness;
  if (
    selectedHarness !== undefined &&
    (!isModelHarness(selectedHarness) ||
      !supportsChatHarnessChoice(model, selectedHarness))
  ) {
    context.fail(
      command,
      'invalid_payload',
      'This model does not support the selected harness.',
    );
    return;
  }
  // Same runtime preflight as the desktop model-change IPC: a Cursor model
  // must not be durably persisted while the managed runtime cannot run it.
  // The renderer's `changeChatModel` path re-checks availability and still
  // refuses Cursor for app-managed projects (Pipeline Editor, plan explore,
  // code review); Cowork runs it since 2026-09-25.
  if (
    getProviderForModel(model) === 'cursor' &&
    !(await isCursorRuntimeAvailable())
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Connect Cursor in the desktop app to use it here.',
    );
    return;
  }
  if (
    (selectedHarness === 'opencode' ||
      getProviderForModel(model) === 'opencode') &&
    !(await isOpenCodeRuntimeAvailable())
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Connect OpenCode in the desktop app to use it here.',
    );
    return;
  }
  if (
    getProviderForModel(model) === 'copilot' &&
    !(await isCopilotRuntimeAvailable())
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Connect Copilot in the desktop app to use it here.',
    );
    return;
  }
  const workOwner = await resolveAiCreditsScopeOwner({
    kind: 'work',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
  });
  if (await isModelBlockedByStoredPolicy(model, workOwner)) {
    context.fail(
      command,
      'invalid_payload',
      'This model is blocked by your organization policy.',
    );
    return;
  }
  await dispatchCorrelatedChatCommand(command, context, {
    ...target,
    kind: 'model',
    model,
    ...(selectedHarness ? { executionHarness: selectedHarness } : {}),
  });
}

export async function handlePortalChatSetThinkingLevel(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.set_thinking_level']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  const thinkingLevel: unknown = command.payload.thinkingLevel;
  if (typeof thinkingLevel !== 'string' || !isThinkingLevel(thinkingLevel)) {
    context.fail(
      command,
      'invalid_payload',
      'thinkingLevel must be a supported thinking level.',
    );
    return;
  }
  await dispatchCorrelatedChatCommand(command, context, {
    ...target,
    kind: 'thinking',
    thinkingLevel,
  });
}

export async function handlePortalChatSetPlanMode(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.set_plan_mode']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  if (typeof command.payload.planMode !== 'boolean') {
    context.fail(command, 'invalid_payload', 'planMode must be a boolean.');
    return;
  }
  await dispatchCorrelatedChatCommand(command, context, {
    ...target,
    kind: 'plan',
    planMode: command.payload.planMode,
  });
}

export async function handlePortalChatSetFastMode(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.set_fast_mode']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  if (typeof command.payload.fastMode !== 'boolean') {
    context.fail(command, 'invalid_payload', 'fastMode must be a boolean.');
    return;
  }
  await dispatchCorrelatedChatCommand(command, context, {
    ...target,
    kind: 'fast',
    fastMode: command.payload.fastMode,
  });
}

export async function handlePortalChatSetPluginSelections(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.set_plugin_selections']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const target = readChatCommandTarget(command, context);
  if (!target) {
    return;
  }
  if (!isRecord(command.payload.selections)) {
    context.fail(
      command,
      'invalid_payload',
      'selections must be a plugin-selections object.',
    );
    return;
  }
  if (
    command.payload.deferredToolsAllowed !== undefined &&
    typeof command.payload.deferredToolsAllowed !== 'boolean'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'deferredToolsAllowed must be a boolean.',
    );
    return;
  }
  // `normalizePluginSelections` accepts the loose wire shape and returns the
  // canonical desktop selections (de-duped collectionIds ∪ legacy bundleIds,
  // sanitized refs), so the renderer's `setPluginSelections` persists exactly
  // what a local Plugins-modal Save would.
  const pluginsCommand: Extract<
    PortalChatComposerSetterCommand,
    { kind: 'plugins' }
  > = {
    ...target,
    kind: 'plugins',
    selections: normalizePluginSelections(command.payload.selections),
    ...(command.payload.deferredToolsAllowed !== undefined
      ? { deferredToolsAllowed: command.payload.deferredToolsAllowed }
      : {}),
  };
  const revisioned = toRevisionedCommand(pluginsCommand);
  // Embedded scopes take the correlated path, which refuses them before any
  // chat state read.
  if (
    !context.chatStatePort ||
    revisioned?.type !== 'chat.patch_tab_settings' ||
    pluginsCommand.selections.mcpHttpAuthPreferences !== undefined ||
    target.projectId === APP_ADVISOR_PROJECT_ID ||
    target.projectId === PIPELINE_EDITOR_PROJECT_ID
  ) {
    await dispatchCorrelatedChatCommand(command, context, pluginsCommand);
    return;
  }
  // The Portal projection omits the chat's MCP auth choices, so a save that
  // leaves them out keeps the saved ones. The canonical commit conflicts
  // (retryably) when the chat's selections changed after this read.
  const snapshot = await queryPortalChatState(context, target).catch(
    () => null,
  );
  if (!snapshot) {
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
    return;
  }
  const tab = snapshot.tabsFile.tabs.find(
    (candidate) => candidate.id === target.chatId,
  );
  if (!tab) {
    context.fail(command, 'not_found', 'The chat tab was not found.');
    return;
  }
  const savedAuthPreferences = tab.pluginSelections?.mcpHttpAuthPreferences;
  await dispatchRevisionedChatCommand(command, context, target, {
    ...revisioned,
    patch: {
      ...revisioned.patch,
      pluginSelections:
        savedAuthPreferences === undefined
          ? pluginsCommand.selections
          : {
              ...pluginsCommand.selections,
              mcpHttpAuthPreferences: savedAuthPreferences,
            },
    },
    expectedPluginSelections: normalizePluginSelections(tab.pluginSelections),
  });
}

export async function handlePortalChatListPluginCatalog(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.list_plugin_catalog']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (
    !isRecord(command.payload) ||
    typeof command.payload.projectId !== 'string' ||
    command.payload.projectId.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Plugin catalog request requires a projectId.',
    );
    return;
  }
  try {
    const { buildPluginCatalog } =
      await import('../../services/plugin-catalog-service');
    context.complete(command, await buildPluginCatalog());
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalChatCancel(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.chat.cancel']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid chat cancel payload.');
    return;
  }
  try {
    const { cancelWorktreeChat } = await import('../../services/chat-service');
    context.complete(command, await cancelWorktreeChat(command.payload));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalChatCancelTurn(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.projectId !== 'string' ||
    typeof payload.worktreeId !== 'string' ||
    typeof payload.chatId !== 'string' ||
    typeof payload.turnId !== 'string'
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Exact turn cancellation requires a worktree chat and turn id.',
    );
    return;
  }
  const standaloneTarget = Object.prototype.hasOwnProperty.call(
    command.target ?? {},
    'standaloneChatLocalId',
  );
  if (
    standaloneTarget ||
    payload.projectId === STANDALONE_CHAT_PROJECT_ID ||
    isCoworkWorkspace(payload.projectId)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Exact turn cancellation is only available for worktree chats.',
    );
    return;
  }
  try {
    validateId(payload.projectId, 'projectId');
    validateId(payload.worktreeId, 'worktreeId');
    validateId(payload.chatId, 'chatId');
    validateId(payload.turnId, 'turnId');
    const { cancelWorktreeChatTurn } =
      await import('../../services/chat-service');
    context.complete(
      command,
      await cancelWorktreeChatTurn({
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        chatId: payload.chatId,
        turnId: payload.turnId,
      }),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

function readQueueEntry(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): {
  projectId: string;
  worktreeId: string;
  chatId: string;
  entryId: string;
} | null {
  if (rejectUntrustedPortalChatInput(command, context)) return null;
  const target = readChatCommandTarget(command, context);
  if (
    !target ||
    typeof command.payload !== 'object' ||
    command.payload === null
  ) {
    return null;
  }
  const entryId =
    'entryId' in command.payload ? command.payload.entryId : undefined;
  if (typeof entryId !== 'string' || entryId.length === 0) {
    context.fail(
      command,
      'invalid_payload',
      'Queue command requires an entryId.',
    );
    return null;
  }
  return { ...target, entryId };
}

export async function handlePortalChatQueueCancel(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.queue.cancel']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const request = readQueueEntry(command, context);
  if (!request) return;
  await dispatchRevisionedChatCommand(command, context, request, {
    type: 'chat.cancel_queued_message',
    chatId: request.chatId,
    queuedMessageId: request.entryId,
  });
}

export async function handlePortalChatQueueEdit(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.queue.edit']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const request = readQueueEntry(command, context);
  if (!request) return;
  if (
    typeof command.payload !== 'object' ||
    command.payload === null ||
    !('text' in command.payload) ||
    typeof command.payload.text !== 'string'
  ) {
    context.fail(command, 'invalid_payload', 'Queue edit requires text.');
    return;
  }
  await dispatchRevisionedChatCommand(command, context, request, {
    type: 'chat.edit_queued_message',
    chatId: request.chatId,
    queuedMessageId: request.entryId,
    text: command.payload.text,
  });
}

export async function handlePortalChatQueueForce(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.queue.force']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const request = readQueueEntry(command, context);
  if (!request) return;
  await dispatchRevisionedChatCommand(command, context, request, {
    type: 'chat.force_queued_message',
    chatId: request.chatId,
    queuedMessageId: request.entryId,
  });
}

export async function handlePortalChatQueueSteer(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const request = readQueueEntry(command, context);
  if (!request) return;
  await dispatchRevisionedChatCommand(command, context, request, {
    type: 'chat.steer_queued_message',
    chatId: request.chatId,
    queuedMessageId: request.entryId,
  });
}

function isChatInputDeliveryAction(
  value: unknown,
): value is ChatInputDeliveryAction {
  return (
    typeof value === 'string' &&
    [
      'cancel',
      'queue',
      'edit',
      'save-draft',
      'save',
      'resend',
      'resend-original',
      'dismiss',
      'close-editor',
    ].includes(value)
  );
}

export async function handlePortalChatInputDelivery(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (rejectUntrustedPortalChatInput(command, context)) return;
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid message action payload.');
    return;
  }
  const request = readQueueEntry(
    {
      ...command,
      payload: { ...command.payload, entryId: command.payload.rowId },
    },
    context,
  );
  if (!request) return;
  const payload = command.payload;
  if (
    typeof payload.rowId !== 'string' ||
    typeof payload.rowRevision !== 'number' ||
    !Number.isSafeInteger(payload.rowRevision) ||
    payload.rowRevision < 1 ||
    !isChatInputDeliveryAction(payload.action) ||
    (payload.text !== undefined &&
      (typeof payload.text !== 'string' || payload.text.length > 512 * 1024))
  ) {
    context.fail(command, 'invalid_payload', 'Invalid message action');
    return;
  }
  await dispatchRevisionedChatCommand(command, context, request, {
    type: 'chat.input_delivery_action',
    chatId: request.chatId,
    rowId: payload.rowId,
    rowRevision: payload.rowRevision,
    action: payload.action,
    ...(payload.text !== undefined ? { text: payload.text } : {}),
  });
}

export async function handlePortalChatQueueSetEditLock(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.chat.queue.set_edit_lock']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  const request = readQueueEntry(command, context);
  if (!request) return;
  if (
    typeof command.payload !== 'object' ||
    command.payload === null ||
    !('locked' in command.payload) ||
    typeof command.payload.locked !== 'boolean' ||
    (command.payload.releaseAcquisitionId !== undefined &&
      (command.payload.locked ||
        typeof command.payload.releaseAcquisitionId !== 'string' ||
        command.payload.releaseAcquisitionId.length === 0)) ||
    (command.payload.acquisitionId !== undefined &&
      (!command.payload.locked ||
        typeof command.payload.acquisitionId !== 'string' ||
        command.payload.acquisitionId.length === 0))
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Queue edit lock requires locked.',
    );
    return;
  }
  const acquisition = command.payload.locked
    ? (command.payload.acquisitionId ?? command.id)
    : command.payload.releaseAcquisitionId;
  await dispatchRevisionedChatCommand(command, context, request, {
    type: 'chat.set_queued_message_edit_lock',
    chatId: request.chatId,
    queuedMessageId: request.entryId,
    locked: command.payload.locked,
    ...(acquisition !== undefined ? { acquisitionId: acquisition } : {}),
  });
}
