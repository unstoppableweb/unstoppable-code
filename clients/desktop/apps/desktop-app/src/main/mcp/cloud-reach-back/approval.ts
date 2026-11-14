import {
  redactSecrets,
  SECRET_ASSIGNMENT_KEYS_SOURCE,
} from '@canopy/execution-engine/lib/redaction';
import {
  CLOUD_REACH_BACK_APPROVAL_PROJECT_ID,
  type ApprovalRule,
} from '@canopy/desktop-shared/types';
import type {
  ApprovalSessionContext,
  ApprovalSessionHandle,
} from '../../approvals/approval-service';
import type { SendableBrowserWindow } from '../../lib/window-send';
import type { ReachBackDecision } from './activity-log';

/**
 * The reach-back approval (CAN-6176 Q3): before a cloud chat runs a tool on
 * this computer that its server doesn't mark read-only, and that wasn't
 * chosen at opt-in to run without asking, the person is asked here.
 *
 * One app-level approval session (`createApprovalSession`) shows the prompt
 * in the main window. It is never auto-approved: the session asks in `ask`
 * mode with no session rules, and each prompt checks a tool name unique to
 * its request, so no saved rule (an "always allow" for the real tool name
 * included) can match it. The prompt offers no rule to save. It denies when
 * no window can show it, or after {@link REACH_BACK_APPROVAL_TIMEOUT_MS}.
 */

export const REACH_BACK_APPROVAL_TIMEOUT_MS = 120_000;
const SUMMARY_LIMIT = 300;
/** The approval scope the session reports under; it holds no chat. */
const SCOPE = CLOUD_REACH_BACK_APPROVAL_PROJECT_ID;

export type ReachBackApprovalDecision = Extract<
  ReachBackDecision,
  'asked_allowed' | 'asked_denied' | 'approval_timeout' | 'no_window'
>;

export interface ReachBackApprovalRequest {
  /** The request's id: the checked tool name is unique to it. */
  readonly requestId: string;
  readonly chat: { readonly id: string; readonly title: string } | null;
  readonly serverName: string;
  /** The tool to run; null to start the server's process (a stdio server). */
  readonly toolName: string | null;
  readonly arguments: unknown;
  /** Withdrawn or past its deadline: the prompt is taken down. */
  readonly signal: AbortSignal;
}

export interface ReachBackApprover {
  ask(request: ReachBackApprovalRequest): Promise<ReachBackApprovalDecision>;
  dispose(): void;
}

const SECRET_KEY = new RegExp(SECRET_ASSIGNMENT_KEYS_SOURCE, 'i');
const MASK_DEPTH_LIMIT = 32;

/**
 * Every value under a secret-named key, at any depth, replaced whole: the
 * free-text pass after it masks a value only up to its first space or comma.
 */
function maskSecretKeys(value: unknown, depth = 0): unknown {
  if (depth > MASK_DEPTH_LIMIT) return '<redacted>';
  if (Array.isArray(value))
    return value.map((item) => maskSecretKeys(item, depth + 1));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '<redacted>' : maskSecretKeys(item, depth + 1),
      ]),
    );
  return value;
}

/** A short, one-line argument summary with secret-looking values redacted. */
export function argumentSummary(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(maskSecretKeys(value)) ?? '';
  } catch {
    text = '';
  }
  const redacted = redactSecrets(text.replace(/\s+/g, ' '));
  return redacted.length <= SUMMARY_LIMIT
    ? redacted
    : `${redacted.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function windowCanShow(window: SendableBrowserWindow | null): boolean {
  return (
    window !== null &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed()
  );
}

export function createReachBackApprover(deps: {
  readonly getWindow: () => SendableBrowserWindow | null;
  readonly createSession: (
    context: ApprovalSessionContext,
  ) => ApprovalSessionHandle;
  readonly timeoutMs?: number;
}): ReachBackApprover {
  const timeoutMs = deps.timeoutMs ?? REACH_BACK_APPROVAL_TIMEOUT_MS;
  /** Emptied after every check, so a session-scope grant never carries over. */
  const sessionRules: ApprovalRule[] = [];
  const session = deps.createSession({
    sessionKey: SCOPE,
    projectId: SCOPE,
    worktreeId: SCOPE,
    chatId: SCOPE,
    provider: 'claude',
    // Rule tiers are keyed by this; no rule names a reach-back request.
    workspaceRoot: SCOPE,
    mode: 'ask',
    sessionRules,
    getWindow: deps.getWindow,
    promptTimeoutMs: timeoutMs,
    trackChatTurn: false,
  });

  return {
    async ask(request) {
      if (!windowCanShow(deps.getWindow())) return 'no_window';
      let timedOut = false;
      const timer = new AbortController();
      const handle = setTimeout(() => {
        timedOut = true;
        timer.abort();
      }, timeoutMs);
      const chat = request.chat?.title ?? 'A cloud chat';
      try {
        const outcome = await session.check(
          { kind: 'tool', toolName: `${SCOPE}:${request.requestId}` },
          {
            signal: AbortSignal.any([timer.signal, request.signal]),
            title:
              request.toolName === null
                ? `${chat} wants to start the ${request.serverName} server on this computer`
                : `${chat} wants to run ${request.toolName} on this computer`,
            description:
              request.toolName === null
                ? 'It runs here until the chat is done with it or stays idle for 10 minutes.'
                : `From the ${request.serverName} server. It runs here and its result goes to the cloud chat.`,
            details: {
              kind: 'tool',
              toolName: request.toolName ?? request.serverName,
              inputSummary: argumentSummary(request.arguments),
            },
          },
        );
        if (timedOut) return 'approval_timeout';
        if (outcome.decision === 'allow') return 'asked_allowed';
        return windowCanShow(deps.getWindow()) ? 'asked_denied' : 'no_window';
      } catch {
        // The prompt was taken down: by the timer, or because the cloud
        // withdrew the request. Either way it did not run.
        return timedOut ? 'approval_timeout' : 'asked_denied';
      } finally {
        clearTimeout(handle);
        sessionRules.length = 0;
      }
    },
    dispose() {
      session.dispose();
    },
  };
}
