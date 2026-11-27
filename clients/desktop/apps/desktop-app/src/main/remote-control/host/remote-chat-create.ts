/**
 * What a remote controller's new chat is born with, and what a remote send
 * reports back. Shared by the hosted controller (CAN-5985), agent messaging
 * and Portal's create while Portal still runs.
 */
import { listPersonalGatewayDefaultModels } from '@canopy/desktop-shared/lib/org-model-gateway';
import {
  AI_GATEWAY_MODELS,
  getExecutionHarnessForModel,
  getProviderForModel,
  resolveProviderModelConfig,
  resolveKnownModel,
  type AgentProviderType,
  type ChatCommand,
  type ChatModel,
  type ModelHarness,
} from '@canopy/desktop-shared/types';
import { AgentModelSelectionError } from '@canopy/execution-engine/lib/agent-model-selection';
import {
  assertAgentModelAdmission,
  pinInheritingAgentToDestination,
} from '../../agents/agent-default-model';
import { getAiCreditsRoutingContextWithStatus } from '../../agents/ai-credits-routing';
import {
  resolveAiCreditsScopeOwner,
  resolveInvocationWorkOwner,
} from '../../agents/work-owner';
import { getCurrentModelGatewayIndex } from '../../lib/model-gateway-state';
import { raceWithTimeout } from '../../memory/memory-context';
import { isCopilotRuntimeAvailable } from '../../copilot/runtime-availability';
import { isCursorRuntimeAvailable } from '../../cursor/runtime-availability';
import { resolveLaneAwareDefaultSelection } from '../../lib/default-model-lane-resolver';
import { isModelBlockedByStoredPolicy } from '../../lib/model-policy-state';
import { readPreferencesFile } from '../../lib/preferences-store';
import { isCoworkWorkspace } from '../../lib/workspace-registry';
import { isOpenCodeRuntimeAvailable } from '../../opencode/runtime-availability';

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

export type RemoteCreateTabSeed =
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
  /** The harness the request chose; the model's default when omitted. */
  executionHarness?: ModelHarness;
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
    providerType === 'antigravity' ||
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
 * Bound on the one credits read the remembered seed waits for. Creating a tab
 * must never hang on the cloud: past this, the remembered choice is kept and
 * the session's typed `no_billing_source` refusal is the backstop.
 */
const REMEMBERED_CREDITS_SEED_READ_BOUND_MS = 1_500;

/**
 * The remembered billing choice a remotely created tab is seeded with: the
 * stored `lastChatBillingFramework`, except a remembered `'ai-credits'` when
 * the credits read for this workspace's owner has SETTLED as ineligible
 * (billing setup gate, 2026-11-25). Mirrors the renderer's
 * `rememberedBillingSeed`: a Personal gateway stands in for AI Credits on the
 * same lane and keeps the seed; an unknown, degraded, failed or slow read
 * keeps it. The stored preference is never rewritten, so the choice seeds
 * again once credits are eligible.
 *
 * One divergence: the renderer counts a Personal gateway only for Personal
 * work (`isOrgGatewayExcluded`), while this keeps the seed whenever one is
 * listed, so it never pays the owner and credits reads for that user. An
 * organization chat created this way at a settled zero balance keeps the
 * credits seed, and main's typed No billing source refusal answers its first
 * turn.
 */
async function rememberedRemoteBillingFramework(
  projectId: string,
  remembered: string | undefined,
): Promise<string | undefined> {
  if (remembered !== 'ai-credits') return remembered;
  if (
    listPersonalGatewayDefaultModels(
      getCurrentModelGatewayIndex(),
      AI_GATEWAY_MODELS,
    ).length > 0
  )
    return remembered;
  // `null` on a failed or slow read, which keeps the remembered choice.
  const answer = await raceWithTimeout(
    resolveInvocationWorkOwner({ projectId }).then((owner) =>
      getAiCreditsRoutingContextWithStatus({ owner }),
    ),
    REMEMBERED_CREDITS_SEED_READ_BOUND_MS,
  );
  const context = answer?.context ?? null;
  return context !== null &&
    context.creditsEligibilityKnown &&
    !context.creditsEligible
    ? undefined
    : remembered;
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
        await rememberedRemoteBillingFramework(
          projectId,
          preferences.lastChatBillingFramework,
        ),
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
    // A resolved credits lane force-seeds credits, as before; only the
    // remembered choice is judged against a settled ineligible balance.
    resolution.lane === 'ai-credits' && !resolution.provisional
      ? 'ai-credits'
      : await rememberedRemoteBillingFramework(
          projectId,
          preferences.lastChatBillingFramework,
        ),
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
 * Why a remote client may not create a chat on `requested`: a runtime that is
 * not connected, or a model the work owner's policy blocks. Null when it may.
 * Shared by Portal's create and the hosted controller's (CAN-5985).
 */
export async function remoteCreateTabModelRefusal(
  target: { projectId: string; worktreeId: string; chatId: string },
  requested: RemoteCreateTabModel,
): Promise<string | null> {
  let model: ChatModel;
  try {
    model = await pinInheritingAgentToDestination(
      requested.model,
      target.projectId,
    );
    await assertAgentModelAdmission(model, {
      ...target,
      executionHarness:
        requested.executionHarness ?? getExecutionHarnessForModel(model),
    });
  } catch (error) {
    if (error instanceof AgentModelSelectionError) return error.message;
    throw error;
  }
  const provider = requested.providerType ?? getProviderForModel(model);
  const harness =
    requested.executionHarness ?? getExecutionHarnessForModel(model);
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
  if (await isModelBlockedByStoredPolicy(model, workOwner)) {
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
