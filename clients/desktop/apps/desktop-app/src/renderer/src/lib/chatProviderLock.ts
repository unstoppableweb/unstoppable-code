import type {
  AgentProviderType,
  ChatInterfaceMode,
  ChatModel,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  canSwitchProviderInPlace,
  getProviderForModel,
  inferLegacyExecutionHarness,
  isTerminalBackedInterfaceMode,
} from '@canopy/desktop-shared/types';
import { getProviderLabel } from '@/lib/providerLabels';
import type { ChatTab } from '@/stores/chat/types';

/**
 * Minimal slice of ChatTab needed to evaluate conversation state.
 */
interface TabLike extends Pick<
  ChatTab,
  'provisionalFirstSend' | 'pendingUserMessages'
> {
  messages: { length: number };
  queuedMessages?: { length: number };
  sdkSessionId?: string;
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  model?: ChatModel;
}

/**
 * True when the tab has user-visible conversation content. A preallocated
 * `sdkSessionId` alone does not count: Claude Code terminal mode can create
 * one before the user has sent anything, and that empty launch must not lock
 * model/provider selection.
 */
function hasConversationState(tab?: TabLike): boolean {
  if (!tab) return false;
  if (
    (tab.provisionalFirstSend?.phase === 'preparing' ||
      tab.provisionalFirstSend?.phase === 'failed') &&
    tab.messages.length === tab.pendingUserMessages?.length &&
    (tab.queuedMessages?.length ?? 0) === 0
  )
    return false;
  return tab.messages.length > 0 || (tab.queuedMessages?.length ?? 0) > 0;
}

export function getLockedProvider(
  tab?: TabLike,
): AgentProviderType | undefined {
  if (!hasConversationState(tab)) return undefined;
  return (
    tab?.providerType ??
    (tab?.model ? getProviderForModel(tab.model) : undefined)
  );
}

/** Return the captured execution harness independently of the model source. */
export function getLockedHarness(tab?: TabLike): ModelHarness | undefined {
  if (!hasConversationState(tab)) return undefined;
  if (tab?.executionHarness) return tab.executionHarness;
  return inferLegacyExecutionHarness({
    model: tab?.model,
    providerType: tab?.providerType,
    hasStarted: true,
  });
}

/**
 * Execution harnesses a chat can be continued between. Ollama is deliberately
 * excluded in both directions: small local models follow a handoff summary
 * poorly, so a "continued" Ollama chat would silently lose the conversation.
 */
const CONTINUABLE_HARNESSES: readonly AgentProviderType[] = ['claude', 'codex'];

/**
 * True when the two providers are different execution harnesses that a chat can
 * be carried between. Used by the model picker to decide whether a
 * locked-provider row renders as a normal selectable model.
 */
export function isContinuableHarnessPair(
  lockedProvider: AgentProviderType | undefined,
  rowProvider: AgentProviderType,
): boolean {
  return (
    lockedProvider !== undefined &&
    lockedProvider !== rowProvider &&
    CONTINUABLE_HARNESSES.includes(lockedProvider) &&
    CONTINUABLE_HARNESSES.includes(rowProvider)
  );
}

/**
 * Copy for a model row that is unavailable purely because the chat is locked to
 * another provider. Follows the DirectoryPicker precedent ("Locked while this
 * session is active, start a new chat to change it").
 */
export function describeLockedProviderReason(
  lockedProvider: AgentProviderType,
  rowProvider: AgentProviderType,
): string {
  return `This chat is running on ${getProviderLabel(lockedProvider)}. Start a new chat to use ${getProviderLabel(rowProvider)} models.`;
}

/**
 * Why a continue was refused.
 *
 * `'not-continuable'` means the pairing itself can never be continued (Ollama,
 * App Advisor, terminal mode, no conversation yet), so its `reason` is only the
 * generic locked-provider copy. Every other code is a transient state block
 * whose `reason` is specific enough to show verbatim in the picker.
 */
export type ContinueBlockedCode =
  | 'not-continuable'
  | 'read-only'
  | 'busy'
  | 'queued'
  | 'pending-plan';

export type ContinueOnOtherHarnessCheck =
  | { ok: true }
  | { ok: false; code: ContinueBlockedCode; reason: string };

/**
 * Slice of a chat tab needed to decide whether it can be continued on another
 * execution harness. Accepts both the store's `ChatTab` and the composer's
 * `ActiveComposerView` projection.
 */
export interface ContinuableTabLike extends TabLike {
  kind?: string;
  status?: string;
  readOnly?: boolean;
  interfaceMode?: ChatInterfaceMode;
  pendingPlanExit?: unknown;
  /**
   * True while an ask-user card for this chat is still awaiting an answer.
   *
   * Cannot be derived from `status`: `handleMcpAskUser` deliberately drops the
   * tab back to `'idle'` and pauses its turn timer while the question waits in
   * `ChatState.pendingQuestions`, because the provider is blocked on the user
   * rather than working. That makes an unanswered question invisible to a
   * status check even though the turn has not finished, so callers must pass it
   * in explicitly.
   */
  hasUnansweredQuestion?: boolean;
}

/**
 * Single predicate gating the "Continue on <Provider>" flow. The model-picker
 * row-enable decision, the confirm dialog and the store action all consult it so
 * they can never disagree about whether a continue is allowed.
 *
 * A continued chat is a brand-new chat id, so this never asks the main process
 * to approve a cross-provider change on an existing session.
 */
export function canContinueOnOtherHarness(
  tab: ContinuableTabLike | undefined,
  targetProvider: AgentProviderType,
  projectId: string | undefined,
): ContinueOnOtherHarnessCheck {
  return checkProviderChange(
    tab,
    targetProvider,
    projectId,
    isContinuableHarnessPair,
  );
}

/**
 * Whether a started chat may switch to `targetProvider` in place, keeping the
 * chat and carrying its conversation to the new provider (CAN-6445). Main
 * allows the same pairs (`canSwitchProviderInPlace`); the transient blockers
 * are the continue flow's, since both hand a settled conversation over.
 */
export function canSwitchChatProvider(
  tab: ContinuableTabLike | undefined,
  targetProvider: AgentProviderType,
  projectId: string | undefined,
): ContinueOnOtherHarnessCheck {
  return checkProviderChange(
    tab,
    targetProvider,
    projectId,
    canSwitchProviderInPlace,
  );
}

function checkProviderChange(
  tab: ContinuableTabLike | undefined,
  targetProvider: AgentProviderType,
  projectId: string | undefined,
  pairAllowed: (
    lockedProvider: AgentProviderType,
    rowProvider: AgentProviderType,
  ) => boolean,
): ContinueOnOtherHarnessCheck {
  if (!tab || tab.kind === 'file') {
    return {
      ok: false,
      code: 'not-continuable',
      reason: 'This chat cannot be continued.',
    };
  }

  const sourceProvider = getLockedProvider(tab);
  if (!sourceProvider) {
    // No conversation state yet, so nothing to continue: the picker is not
    // locked and the user can simply switch the model in place.
    return {
      ok: false,
      code: 'not-continuable',
      reason: 'This chat has nothing to continue yet.',
    };
  }
  if (
    !pairAllowed(sourceProvider, targetProvider) ||
    projectId === APP_ADVISOR_PROJECT_ID ||
    isTerminalBackedInterfaceMode(tab.interfaceMode)
  ) {
    return {
      ok: false,
      code: 'not-continuable',
      reason: describeLockedProviderReason(sourceProvider, targetProvider),
    };
  }

  if (tab.readOnly === true) {
    return {
      ok: false,
      code: 'read-only',
      reason: 'This chat is read only, so it cannot be continued.',
    };
  }

  // A mid-stream snapshot produces a summary that disagrees with whatever the
  // source finishes writing, and queued turns keep advancing the source after
  // the snapshot is taken. Both must settle first.
  //
  // `'error'` is deliberately NOT blocked: an errored tab is settled, not
  // working — the turn is closed and the error system message is already
  // appended. It is also the highest-value case for this feature (a chat that
  // hit a usage limit or a provider error is exactly when the other harness is
  // wanted), and blocking it was inconsistent anyway: persisted tabs restore as
  // `'idle'`, so the same chat became continuable after a restart.
  if (tab.status === 'streaming') {
    return {
      ok: false,
      code: 'busy',
      reason:
        'This chat is still working. Stop or finish the current turn, then switch.',
    };
  }
  if ((tab.queuedMessages?.length ?? 0) > 0) {
    return {
      ok: false,
      code: 'queued',
      reason:
        'This chat still has queued messages. Let them finish or clear them, then switch.',
    };
  }

  // An unanswered ask-user card is a turn in progress that merely looks settled:
  // the provider is parked waiting on the user, so the tab reads `'idle'` with a
  // paused timer. Continuing here would snapshot a transcript whose last turn is
  // mid-flight, and the question itself lives in `pendingQuestions` rather than
  // in the messages the summarizer sees — so the continued chat would silently
  // lose the very interaction the source is blocked on.
  if (tab.hasUnansweredQuestion === true) {
    return {
      ok: false,
      code: 'busy',
      reason:
        'This chat is waiting on your answer. Respond to the question, then switch.',
    };
  }

  // A pending plan approval is bound to the source provider's session and
  // cannot be honored on another harness.
  if (tab.pendingPlanExit) {
    return {
      ok: false,
      code: 'pending-plan',
      reason:
        'Approve or reject the pending plan before continuing on another provider.',
    };
  }

  return { ok: true };
}
