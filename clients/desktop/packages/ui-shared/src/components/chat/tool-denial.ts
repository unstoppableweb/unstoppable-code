import {
  APPROVAL_CANCELLED_MESSAGE,
  APPROVAL_CHECK_FAILED_MESSAGE,
  FAIL_CLOSED_MESSAGE,
  POLICY_DENIED_FALLBACK_MESSAGE,
  SAFETY_DENIED_MESSAGE_PREFIX,
  USER_DENIED_MESSAGE,
  safetyDeniedMessage,
  savedRuleDeniedMessage,
  type SavedRuleDenialScope,
} from '@canopy/protocol/approvals';

/**
 * Who stopped a tool call before it ran. Read from the result text, which is
 * a compatibility heuristic rather than trusted provenance: an ordinary error
 * can repeat a known denial string, and old message-less denials saved as the
 * user sentence cannot be told apart from real user denials (CAN-4809).
 */
export type ToolDenialAttribution =
  | 'safety-rule'
  | 'saved-rule'
  | 'user'
  | 'policy'
  | 'unanswered';

export interface ToolDenial {
  attribution: ToolDenialAttribution;
  /** The denial text with any hook wrapper removed. */
  message: string;
  /** The safety rule's label, such as `force-push`. */
  safetyLabel?: string;
  /** The saved deny rule's scope. */
  savedRuleScope?: SavedRuleDenialScope;
  /** The reason the user typed when they denied the call. */
  userReason?: string;
}

/** Shown when a hook wrapper carried no message of its own. */
export const HOOK_FAILURE_FALLBACK_MESSAGE =
  'A hook stopped this tool call without a message.';

const TOOL_DENIAL_HEADINGS: Record<ToolDenialAttribution, string> = {
  'safety-rule': 'Blocked by safety rule',
  'saved-rule': 'Blocked by saved rule',
  user: 'Denied by you',
  policy: 'Blocked by approval system',
  unanswered: 'Not answered in time',
};

/** The Claude SDK's wrapper around a PreToolUse hook's deny reason. */
const HOOK_ERROR_PREFIX = /^\s*PreToolUse:[\w.-]+ hook error:[ \t]*/;

const USER_DENIED_REASON_PREFIX = `${USER_DENIED_MESSAGE.slice(0, -1)}: `;

/**
 * Claude Code's own result for a call the person denied and stopped: the CLI
 * replaces the denial message with it (cloud "Deny and stop", REG-3132).
 */
const CLAUDE_USER_REJECTED_MESSAGE = 'User rejected tool use';

/**
 * Claude Code's result prefix for a denied call: a cloud harness denial reads
 * `Error: The user denied this tool call: …` (REG-3132).
 */
const CLAUDE_ERROR_PREFIX = 'Error: ';

/**
 * How Agentic Core's result opens for a cloud approval or question still
 * waiting after the turn ended (REG-3134).
 */
const UNANSWERED_MESSAGE_OPENINGS = [
  'The user has not answered this approval yet.',
  'The user has not answered this question yet.',
];

const SAVED_RULE_SCOPES: readonly SavedRuleDenialScope[] = [
  'session',
  'project',
  'global',
  'repository',
];

const POLICY_MESSAGES: ReadonlySet<string> = new Set([
  POLICY_DENIED_FALLBACK_MESSAGE,
  FAIL_CLOSED_MESSAGE,
  APPROVAL_CANCELLED_MESSAGE,
  APPROVAL_CHECK_FAILED_MESSAGE,
]);

/**
 * Remove a leading `PreToolUse:<Tool> hook error:` wrapper from an error
 * result's display text. A wrapper with nothing after it becomes a generic
 * hook-failure message; text without a wrapper is returned unchanged.
 */
export function stripHookErrorPrefix(output: string): string {
  const match = HOOK_ERROR_PREFIX.exec(output);
  if (match == null) return output;
  const rest = output.slice(match[0].length);
  return rest.trim() === '' ? HOOK_FAILURE_FALLBACK_MESSAGE : rest;
}

/**
 * Recognize a Canopy approval denial in an error result's text. Only whole
 * known messages match, so unknown hook failures and other errors stay
 * errors. Callers pass error output only; successful output is never a
 * denial, whatever it says.
 */
export function classifyToolDenial(output: string): ToolDenial | null {
  const displayMessage = stripHookErrorPrefix(output).trimStart();
  const message = displayMessage.trimEnd();
  // Only the person's denial and an unanswered result may carry the CLI's prefix.
  const userMessage = displayMessage.startsWith(CLAUDE_ERROR_PREFIX)
    ? displayMessage.slice(CLAUDE_ERROR_PREFIX.length)
    : displayMessage;
  if (
    userMessage.trimEnd() === USER_DENIED_MESSAGE ||
    message === CLAUDE_USER_REJECTED_MESSAGE
  ) {
    return { attribution: 'user', message: userMessage.trimEnd() };
  }
  if (userMessage.startsWith(USER_DENIED_REASON_PREFIX)) {
    const userReason = userMessage.slice(USER_DENIED_REASON_PREFIX.length);
    if (userReason.trim() === '') return null;
    return { attribution: 'user', message: userMessage, userReason };
  }
  if (
    UNANSWERED_MESSAGE_OPENINGS.some((opening) =>
      userMessage.startsWith(opening),
    )
  ) {
    return { attribution: 'unanswered', message: userMessage.trimEnd() };
  }
  if (POLICY_MESSAGES.has(message)) {
    return { attribution: 'policy', message };
  }
  if (message.startsWith(SAFETY_DENIED_MESSAGE_PREFIX)) {
    const labelEnd = message.indexOf(')', SAFETY_DENIED_MESSAGE_PREFIX.length);
    if (labelEnd < 0) return null;
    const safetyLabel = message.slice(
      SAFETY_DENIED_MESSAGE_PREFIX.length,
      labelEnd,
    );
    if (safetyLabel === '' || message !== safetyDeniedMessage(safetyLabel)) {
      return null;
    }
    return { attribution: 'safety-rule', message, safetyLabel };
  }
  const savedRuleScope = SAVED_RULE_SCOPES.find(
    (scope) => message === savedRuleDeniedMessage(scope),
  );
  if (savedRuleScope != null) {
    return { attribution: 'saved-rule', message, savedRuleScope };
  }
  return null;
}

/** Whether an error result's text is a known denial; see {@link classifyToolDenial}. */
export function isToolDenial(output: string): boolean {
  return classifyToolDenial(output) !== null;
}

/** The heading that names who stopped the call ("Blocked by safety rule"). */
export function toolDenialHeading(denial: ToolDenial): string {
  return TOOL_DENIAL_HEADINGS[denial.attribution];
}

/**
 * A clean step's detail naming the source in lowercase ("blocked by safety
 * rule · force-push", "denied by you").
 */
export function toolDenialDetail(denial: ToolDenial): string {
  const source = toolDenialHeading(denial).toLowerCase();
  if (denial.safetyLabel != null) return `${source} · ${denial.safetyLabel}`;
  if (denial.savedRuleScope != null) {
    return `${source} · ${denial.savedRuleScope} scope`;
  }
  return source;
}
