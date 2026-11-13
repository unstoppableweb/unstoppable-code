/**
 * What a tool-approval prompt shows and what a person may decide on it. The
 * desktop approval service and the cloud chat both present requests in this
 * shape, so one shared card renders them (CAN-5653).
 */

/** Maximum UTF-16 string units per supplied file-change text field. */
export const APPROVAL_FILE_CHANGE_MAX_CHARS = 20_000;

/** Display-only request text, bounded before delivery and persistence. */
export type ApprovalFileChange =
  | {
      kind: 'edit';
      oldText: string;
      newText: string;
      replaceAll?: boolean;
      truncated?: boolean;
    }
  | {
      kind: 'write';
      content: string;
      truncated?: boolean;
    };

/**
 * Display text for the person deciding, supplied by the trusted host adapter.
 * `cwd` and `path` are the tool call's own target as the provider stated it
 * (the directory a command runs in, the file a write changes): the person
 * must see exactly what they approve. No consumer resolves or opens them;
 * they are never identifiers for host access.
 */
export type ApprovalRequestDetails =
  | { kind: 'command'; command: string; cwd?: string; reason?: string }
  | {
      kind: 'file-write';
      /** The provider's target path, shown as supplied. */
      path?: string;
      /** Host-projected relative path; never an approval rule target. */
      displayPath?: string;
      change?: ApprovalFileChange;
      reason?: string;
      itemId?: string;
    }
  | {
      kind: 'mcp';
      server: string;
      tool: string;
      paramsDisplay?: string;
      reason?: string;
    }
  | { kind: 'network'; host: string; reason?: string }
  | {
      kind: 'tool';
      toolName: string;
      /** A read tool's target path, shown as supplied. */
      path?: string;
      /** Host-projected relative path; never an approval rule target. */
      displayPath?: string;
      inputSummary?: string;
      reason?: string;
    }
  | {
      kind: 'browser-upload';
      /** Origin of the frame that receives the files. */
      origin: string;
      /** Origin of the page, shown when it differs from `origin`. */
      topOrigin?: string;
      files: Array<{ displayPath: string; sizeBytes: number }>;
      reason?: string;
    }
  | {
      /** `browser.request_files`: the user chooses files or declines. */
      kind: 'browser-file-request';
      /** Origin of the frame that receives the files. */
      origin: string;
      /** Origin of the page, shown when it differs from `origin`. */
      topOrigin?: string;
      /** Why the agent asks, in its own words. */
      purpose?: string;
      multiple: boolean;
    };

export type ApprovalRuleTarget =
  | { kind: 'command'; pattern: string }
  | { kind: 'file-write'; path: string }
  | { kind: 'mcp'; server: string; tool?: string }
  | { kind: 'network'; host: string }
  | { kind: 'tool'; toolName: string }
  /** In-app browser uploads to an origin; `path` is an optional workspace-relative glob. */
  | { kind: 'browser-upload'; origin: string; path?: string };

export type ApprovalRuleScope = 'session' | 'project' | 'global';

export interface ApprovalPromptDecision {
  behavior: 'allow' | 'deny';
  scope: ApprovalRuleScope | 'once';
  /** Required when scope !== 'once'; the rule to persist. */
  target?: ApprovalRuleTarget;
  /** Deny-only free-text fed back to the agent. */
  message?: string;
  /** Deny-only: also interrupt the turn. */
  stopTurn?: boolean;
}

/** The part of a pending approval request its prompt renders. */
export interface SecretInputApprovalPrompt {
  kind: 'secret-input';
  bindingId: string;
  label: 'API key';
}

export interface ApprovalPromptRequest {
  secretInput?: SecretInputApprovalPrompt;
  requestId: string;
  /** Provider-supplied or derived title for the approval card. */
  title: string;
  description?: string;
  details: ApprovalRequestDetails;
  /** Pre-computed rule candidate for the prompt's "always" buttons. */
  suggestedTarget?: ApprovalRuleTarget;
  /** Set when a subagent, not the root turn, made the tool call. */
  subagentId?: string;
}

function boundedFileChangeText(text: string): string {
  if (text.length <= APPROVAL_FILE_CHANGE_MAX_CHARS) return text;
  let end = APPROVAL_FILE_CHANGE_MAX_CHARS;
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  )
    end -= 1;
  return text.slice(0, end);
}

/**
 * The proposed change of a Claude Code `Edit` or `Write` call, each text cut
 * at `APPROVAL_FILE_CHANGE_MAX_CHARS` without splitting a surrogate pair.
 */
export function approvalFileChangeForClaudeTool(
  toolName: string,
  input: Record<string, unknown>,
): ApprovalFileChange | undefined {
  if (
    toolName === 'Edit' &&
    typeof input.old_string === 'string' &&
    typeof input.new_string === 'string'
  ) {
    const oldText = boundedFileChangeText(input.old_string);
    const newText = boundedFileChangeText(input.new_string);
    return {
      kind: 'edit',
      oldText,
      newText,
      ...(typeof input.replace_all === 'boolean'
        ? { replaceAll: input.replace_all }
        : {}),
      ...(oldText.length < input.old_string.length ||
      newText.length < input.new_string.length
        ? { truncated: true }
        : {}),
    };
  }
  if (toolName === 'Write' && typeof input.content === 'string') {
    const content = boundedFileChangeText(input.content);
    return {
      kind: 'write',
      content,
      ...(content.length < input.content.length ? { truncated: true } : {}),
    };
  }
  return undefined;
}
