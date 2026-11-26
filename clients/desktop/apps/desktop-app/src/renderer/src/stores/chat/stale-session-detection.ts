import type { AgentProviderType } from '@canopy/desktop-shared/types';
import { STALE_SESSION_DETECTION_THRESHOLD_MS } from './constants';

/**
 * Providers whose runtime reopens or rebuilds a lost session itself, so a
 * fast, empty failure is an ordinary error (a startup fault, a refused
 * attachment) rather than a session the renderer must retire. Marking such a
 * chat stale would make it read-only and drop its saved session ID, blocking
 * a next send that would have worked.
 *
 * - Cursor: a failed load starts a fresh session.
 * - Antigravity (Google): main rebuilds a missing native session from the
 *   chat's saved messages, and keeps the saved session ID on every other
 *   failure (including attachment refusals before the resume), so the next
 *   send resumes the same conversation.
 *
 * The text-based explicit expiry check does not apply to these providers
 * either; main never reports their sessions as expired that way.
 */
const PROVIDERS_THAT_RECOVER_LOST_SESSIONS: ReadonlySet<AgentProviderType> =
  new Set<AgentProviderType>(['cursor', 'antigravity']);

export function providerRecoversLostSessions(
  provider: AgentProviderType | undefined,
): boolean {
  return (
    provider !== undefined && PROVIDERS_THAT_RECOVER_LOST_SESSIONS.has(provider)
  );
}

export interface StaleSessionResumeSignal {
  isTerminal: boolean;
  isCancellationTerminal: boolean;
  provider: AgentProviderType | undefined;
  lastTurnWasResumeAttempt: boolean | undefined;
  /** Main's canonical empty-completion verdict, which owns this state when set. */
  hasEmptyCompletionRecovery: boolean;
  cancelRequestedByUser: boolean | undefined;
  /** Read only when every cheaper check passes; this walks the transcript. */
  hasAssistantMessageAfterLastUser: () => boolean;
  suppressImplicitDetection: boolean;
  hasExplicitExpirySignal: boolean;
  /** Read only when every cheaper check passes; this walks the transcript. */
  lastTurnDurationMs: () => number | null | undefined;
}

/**
 * Whether a finished turn looks like a resume of an expired session: it
 * resumed, ended almost instantly and produced no assistant output.
 */
export function shouldDetectStaleSessionResume(
  signal: StaleSessionResumeSignal,
): boolean {
  return (
    signal.isTerminal &&
    !signal.isCancellationTerminal &&
    // Codex reports a missing rollout explicitly on its own send path.
    signal.provider !== 'codex' &&
    !providerRecoversLostSessions(signal.provider) &&
    signal.lastTurnWasResumeAttempt === true &&
    // Main's canonical empty-completion verdict owns this state. Replacing
    // it with the legacy stale-session transition would make the tab
    // read-only before its Resume / Try again / Report this notice can render.
    !signal.hasEmptyCompletionRecovery &&
    signal.cancelRequestedByUser !== true &&
    !signal.hasAssistantMessageAfterLastUser() &&
    (!signal.suppressImplicitDetection || signal.hasExplicitExpirySignal) &&
    (signal.lastTurnDurationMs() ?? Infinity) <
      STALE_SESSION_DETECTION_THRESHOLD_MS
  );
}
