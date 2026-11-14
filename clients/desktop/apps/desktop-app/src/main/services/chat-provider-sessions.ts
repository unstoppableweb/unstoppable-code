import type {
  AgentProviderType,
  ParkedProviderSession,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

/**
 * The tab's active provider session fields. A provider switch moves them
 * into `providerSessions`, never deletes them, so the earlier provider's
 * session can be resumed (CAN-6445).
 */
const ACTIVE_SESSION_FIELDS = [
  'sdkSessionId',
  'globalInstructionsSnapshot',
  'codexReconstructionSeedId',
  'claudeForkSessionOnNextSend',
  'claudeTerminal',
] as const;

function userTurns(tab: PersistedChatTab): number | undefined {
  return tab.transcript?.userMessageCount;
}

/**
 * Moves the tab's active session to a provider switch's outcome, on `next`.
 *
 * - The outgoing provider's session is parked under its provider, with the
 *   user-turn count it had answered.
 * - Switching to a provider whose parked session has answered every user turn
 *   so far resumes it: nothing ran on another provider since it was parked.
 * - Otherwise the next turn starts a fresh session, and the tab is marked so
 *   that turn carries the conversation as a seed. A parked session that is
 *   not resumed stays parked.
 *
 * `resume: false` only parks: for a caller whose turn cannot take a resumed
 * session id, so restoring one would let the fresh session replace it.
 */
export function applyProviderSwitchToSession(
  tab: PersistedChatTab,
  next: PersistedChatTab,
  from: AgentProviderType | undefined,
  to: AgentProviderType,
  options: { resume: boolean } = { resume: true },
): void {
  for (const field of ACTIVE_SESSION_FIELDS) delete next[field];
  const parked: Partial<Record<AgentProviderType, ParkedProviderSession>> = {
    ...tab.providerSessions,
  };
  const turns = userTurns(tab);
  if (from !== undefined && tab.sdkSessionId) {
    parked[from] = {
      sdkSessionId: tab.sdkSessionId,
      ...(tab.globalInstructionsSnapshot !== undefined
        ? { globalInstructionsSnapshot: tab.globalInstructionsSnapshot }
        : {}),
      ...(from === 'codex' && tab.codexReconstructionSeedId !== undefined
        ? { codexReconstructionSeedId: tab.codexReconstructionSeedId }
        : {}),
      // A pending Claude fork still owes its fork: resuming without the
      // marker would write into the parent session.
      ...(tab.claudeForkSessionOnNextSend === true
        ? { claudeForkSessionOnNextSend: true }
        : {}),
      ...(turns !== undefined ? { userMessageCount: turns } : {}),
    };
  }
  const returning = parked[to];
  if (
    options.resume &&
    returning !== undefined &&
    turns !== undefined &&
    returning.userMessageCount === turns
  ) {
    next.sdkSessionId = returning.sdkSessionId;
    if (returning.globalInstructionsSnapshot !== undefined)
      next.globalInstructionsSnapshot = returning.globalInstructionsSnapshot;
    if (returning.codexReconstructionSeedId !== undefined)
      next.codexReconstructionSeedId = returning.codexReconstructionSeedId;
    if (returning.claudeForkSessionOnNextSend === true)
      next.claudeForkSessionOnNextSend = true;
    delete parked[to];
    delete next.providerSwitchSeedPending;
  } else if (turns === undefined || turns > 0) {
    next.providerSwitchSeedPending = true;
  }
  if (Object.keys(parked).length > 0) next.providerSessions = parked;
  else delete next.providerSessions;
}

/**
 * A harness change on the same provider. The new harness cannot resume the
 * old harness's session, so the next turn starts fresh and, once the chat has
 * a user turn, carries the conversation as a seed.
 */
export function resetSessionForHarnessChange(
  tab: PersistedChatTab,
  next: PersistedChatTab,
): void {
  for (const field of ACTIVE_SESSION_FIELDS) delete next[field];
  if (userTurns(tab) !== 0) next.providerSwitchSeedPending = true;
}
