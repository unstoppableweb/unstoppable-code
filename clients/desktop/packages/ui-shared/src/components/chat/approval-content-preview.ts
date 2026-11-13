/**
 * Deterministic truncation for tool-approval content (CAN-3001).
 *
 * A pending approval can carry a very large payload — an inline interpreter
 * script, a multi-kilobyte MCP argument blob — and for inline scripts the
 * suggested rule pattern is the complete command too
 * (`suggestedCommandPattern` keeps it whole so one approval never becomes a
 * wildcard grant). Rendering either unbounded pushed the Allow/Deny row off
 * the bottom of the window, and repeating the pattern under every menu row
 * made the dropdown itself several screens tall.
 *
 * These helpers cut the text at fixed line/character budgets so the card and
 * menu header stay a predictable height, and report `truncated` so the UI can
 * offer the full text through a scrollable modal instead. Budgets are
 * counted, not measured, so jsdom tests and the renderer agree.
 */

import type { ApprovalPromptRequest } from '@canopy/protocol/approvals';

/** Line budget for the in-card content preview. */
export const APPROVAL_CONTENT_PREVIEW_MAX_LINES = 8;
/** Character budget for the in-card content preview (guards one huge line). */
export const APPROVAL_CONTENT_PREVIEW_MAX_CHARS = 480;
/** Character budget for the single-line rule target shown in a menu header. */
export const APPROVAL_MENU_TARGET_MAX_CHARS = 64;

export interface ApprovalContentPreview {
  /** The text to render inline. Equals the input when `truncated` is false. */
  readonly text: string;
  /** Whether any of the input was cut and the full text should be offered. */
  readonly truncated: boolean;
}

export interface ApprovalContentPreviewLimits {
  readonly maxLines: number;
  readonly maxChars: number;
}

const DEFAULT_CONTENT_LIMITS: ApprovalContentPreviewLimits = {
  maxLines: APPROVAL_CONTENT_PREVIEW_MAX_LINES,
  maxChars: APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
};

/** Bounds multi-line approval content (a command, MCP params, tool input). */
export function previewApprovalContent(
  content: string,
  limits: ApprovalContentPreviewLimits = DEFAULT_CONTENT_LIMITS,
): ApprovalContentPreview {
  const lines = content.split('\n');
  let text = content;
  let truncated = false;
  if (lines.length > limits.maxLines) {
    text = lines.slice(0, limits.maxLines).join('\n');
    truncated = true;
  }
  if (text.length > limits.maxChars) {
    text = text.slice(0, limits.maxChars);
    truncated = true;
  }
  return { text, truncated };
}

/**
 * Bounds a rule target for a menu header: first line only, capped at
 * `APPROVAL_MENU_TARGET_MAX_CHARS`. The header is a single `truncate` row;
 * this keeps the DOM text short too so a multi-line pattern never adds
 * hidden height or bleeds into the row layout.
 */
export function previewApprovalTargetLabel(
  label: string,
): ApprovalContentPreview {
  const newlineIndex = label.indexOf('\n');
  let text = newlineIndex === -1 ? label : label.slice(0, newlineIndex);
  let truncated = newlineIndex !== -1;
  if (text.length > APPROVAL_MENU_TARGET_MAX_CHARS) {
    text = text.slice(0, APPROVAL_MENU_TARGET_MAX_CHARS);
    truncated = true;
  }
  return { text, truncated };
}

/** The one-line context an arrival announcement names after the title. */
function approvalAnnouncementContext(
  details: ApprovalPromptRequest['details'],
): string {
  switch (details.kind) {
    case 'command':
      return details.command;
    case 'file-write':
      return details.displayPath ?? details.path ?? '';
    case 'mcp':
      return `${details.server}: ${details.tool}`;
    case 'network':
      return details.host;
    case 'tool':
      return details.displayPath ?? details.path ?? details.toolName;
    case 'browser-upload':
      return `To ${details.origin}`;
    case 'browser-file-request':
      return `For ${details.origin}`;
    default:
      return '';
  }
}

/**
 * Polite live-region text for a newly pending approval (CAN-4997): the title,
 * then the command, path, or tool on one bounded line.
 */
export function approvalAnnouncementText(
  pending: Pick<ApprovalPromptRequest, 'title' | 'details'>,
): string {
  const titlePreview = previewApprovalTargetLabel(pending.title);
  const title = `Approval needed: ${titlePreview.text}${titlePreview.truncated ? '…' : ''}`;
  const context = approvalAnnouncementContext(pending.details).trim();
  if (!context) return title;
  const preview = previewApprovalTargetLabel(context);
  return `${title}. ${preview.text}${preview.truncated ? '…' : ''}`;
}
