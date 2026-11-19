import type {
  ChatQueueTarget,
  ChatSendMessageRequest,
  SettingsHeldChange,
} from '@canopy/desktop-shared/types';
import { orderedSettingsHeldChanges } from '@canopy/protocol/remote-control/shell';
import {
  chatHasNativeBackgroundWork,
  canPreserveSessionCapabilitySnapshot,
  canReuseSession,
  getSession,
  getSessionChangedOptions,
  getSessionRecreateReasons,
  getSessionTurnSettings,
  type SessionRecreateReason,
  type SessionTurnSettings,
} from '../agents/session-manager';

/** What starting a turn for a request would do to the chat's live session. */
export type TurnSessionReuseDecision =
  | { kind: 'absent' }
  | { kind: 'reuse' }
  | {
      kind: 'recycle';
      /** Names of the session options that differ; never their values. */
      changedOptions: readonly string[];
      recreateReasons: readonly SessionRecreateReason[];
    };

/**
 * Decides, before any prompt commit, whether dispatching `request` would reuse
 * or recycle the chat's live session, using the same session preparation and
 * matcher as `dispatchWorktreeChatTurn`. With `deferRecreateMarkers` (a send
 * that runs with the live session's settings), every recreate marker except
 * `stop` waits while native background work lives, as dispatch does.
 */
export async function decideTurnSessionReuse(
  request: ChatSendMessageRequest,
  options: { deferRecreateMarkers?: boolean } = {},
): Promise<TurnSessionReuseDecision> {
  // Keep the dispatch module lazy: queue and settings callers need the cheap
  // helpers below without loading the provider dispatch funnel.
  const { prepareWorktreeTurnSession } = await import('./worktree-chat-turn');
  // Model-less requests retain dispatch's lane-default preference persistence
  // and passive auth observation (which preserves native background work).
  const prepared = await prepareWorktreeTurnSession(
    {
      ...request,
      planMode: request.planMode ?? false,
      initiationSource: request.initiationSource ?? 'user',
      getWindow: () => null,
      onBeforeChatEvent: () => Promise.resolve(),
    },
    undefined,
    { checkModelAvailability: false },
  );
  if (!getSession(request.projectId, request.worktreeId, request.chatId)) {
    return { kind: 'absent' };
  }
  const recreateReasons = getSessionRecreateReasons(
    request.projectId,
    request.worktreeId,
    request.chatId,
  );
  const recreate =
    recreateReasons.length > 0 &&
    !(
      recreateReasons.every((reason) =>
        isRecreateDeferrable(reason, options.deferRecreateMarkers === true),
      ) &&
      chatHasNativeBackgroundWork(
        request.projectId,
        request.worktreeId,
        request.chatId,
      )
    );
  if (prepared.existingCodeGraphToolsAdvertised !== undefined) {
    const initialOptions = prepared.buildSessionOptions();
    const canReuse = !recreate && (await canReuseSession(initialOptions));
    if (
      !canReuse &&
      !(await canPreserveSessionCapabilitySnapshot(initialOptions))
    ) {
      prepared.sessionConfiguration =
        await prepared.resolveSessionConfiguration(
          prepared.currentCodeGraphToolsAvailable,
        );
    }
  }
  // Dispatch creates the session with the chat's turn approval authority, and
  // a session whose rules differ is replaced; predict with the same rules.
  const { resolveChatTurnApprovalAuthority } =
    await import('./chat-turn-approval-authority');
  const approval = await resolveChatTurnApprovalAuthority(request, {
    checkAdmission: false,
  });
  const sessionOptions = {
    ...prepared.buildSessionOptions(),
    approvalMode: approval.approvalMode,
    sessionApprovalRules: approval.sessionApprovalRules,
  };
  if (!recreate && (await canReuseSession(sessionOptions))) {
    return { kind: 'reuse' };
  }
  return {
    kind: 'recycle',
    changedOptions: await getSessionChangedOptions(sessionOptions),
    recreateReasons,
  };
}

/**
 * Whether a recreate marker may wait while native background work lives. An
 * aborted query (`stop`) never waits; approval already applies live; a send on
 * the live session's settings defers the rest to a later turn.
 */
export function isRecreateDeferrable(
  reason: SessionRecreateReason,
  usesLiveSessionSettings: boolean,
): boolean {
  return (
    reason !== 'stop' && (usesLiveSessionSettings || reason === 'approval')
  );
}

/**
 * A recycle that would stop live native background work. An aborted session
 * (`stop`) must be recreated and has no live work to protect.
 */
export function holdsForBackgroundWork(
  target: ChatQueueTarget,
  decision: TurnSessionReuseDecision,
): boolean {
  return (
    decision.kind === 'recycle' &&
    !decision.recreateReasons.includes('stop') &&
    chatHasNativeBackgroundWork(
      target.projectId,
      target.worktreeId,
      target.chatId,
    )
  );
}

// Session option names and recreate reasons, by what a person would call
// them. Unlisted entries (`stop`, live-applied `approval`, `unspecified`) name
// nothing a held send waits to apply.
const SETTINGS_HELD_CHANGE_BY_CAUSE: Readonly<
  Partial<Record<string, SettingsHeldChange>>
> = {
  model: 'model',
  selectedModel: 'model',
  providerType: 'agent',
  executionHarness: 'agent',
  assistantMode: 'agent',
  plan: 'plan_mode',
  pluginSelections: 'plugins',
  plugins: 'plugins',
  toolProfile: 'tools',
  deferredToolsAllowed: 'tools',
  codeGraphToolsAdvertised: 'tools',
  systemPromptAppend: 'instructions',
  sessionApprovalRules: 'approval_rules',
  managedDelegationMode: 'delegation',
  managed_delegation: 'delegation',
  codex_preferences: 'codex_preferences',
  // Mods belong to plugins, so a held send names the plugin change.
  claude_mods: 'plugins',
  authGeneration: 'account',
  routing: 'account',
  account: 'account',
  workOwner: 'organization',
  executionContext: 'organization',
  organization: 'organization',
};

/** What a recycle would change, in display order; empty when not a recycle. */
export function settingsHeldChanges(
  decision: TurnSessionReuseDecision,
): SettingsHeldChange[] {
  if (decision.kind !== 'recycle') return [];
  return orderedSettingsHeldChanges(
    [...decision.changedOptions, ...decision.recreateReasons].flatMap(
      (cause) => SETTINGS_HELD_CHANGE_BY_CAUSE[cause] ?? [],
    ),
  );
}

/** A pre-commit refusal: the row stays queued until the work ends. */
export class TurnHeldForBackgroundWorkError extends Error {
  readonly code = 'turn_held_for_background_work';

  constructor() {
    super(
      'Sending this message would stop background work that is still running.',
    );
    this.name = 'TurnHeldForBackgroundWorkError';
  }
}

export function isTurnHeldForBackgroundWorkError(
  error: unknown,
): error is TurnHeldForBackgroundWorkError {
  return error instanceof TurnHeldForBackgroundWorkError;
}

/**
 * Returns `request` with its user-editable settings (model, provider, harness,
 * plugins, plan mode, model config) replaced by the ones the chat's live
 * session runs with, so the send cannot restart it. Account, work-owner and
 * routing identity are never rewritten. Without a live session the request is
 * returned unchanged.
 */
export function applyLiveSessionSettings<T extends ChatSendMessageRequest>(
  request: T,
): T {
  const settings = liveSessionSettingsOverlay(request);
  return settings ? { ...request, ...settings } : request;
}

/**
 * The live session's user-editable settings, without approval: approval
 * always follows the live approval registry and is never held.
 */
export function liveSessionSettingsOverlay(
  target: ChatQueueTarget,
):
  | Omit<SessionTurnSettings, 'approvalMode' | 'sessionApprovalRules'>
  | undefined {
  const settings = getSessionTurnSettings(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
  if (!settings) return undefined;
  const overlay = { ...settings };
  delete overlay.approvalMode;
  delete overlay.sessionApprovalRules;
  return overlay;
}
