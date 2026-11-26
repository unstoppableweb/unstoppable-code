// ---------------------------------------------------------------------------
// Standardized error display copy for shared-resource flows (shared skills
// and shared Collections).
//
// The renderer surfaces these strings in mutation toast messages, list/detail
// error slots, and modal error banners so the language is consistent across
// every shared-resource surface (Phase F4 step 2 of the frontend plan).
//
// HTTP-status-to-copy mapping:
//   400  -> server-provided message verbatim, else "Invalid request."
//   401  -> "You do not have permission to perform this action."
//   403  -> "You do not have permission to perform this action."
//   404  -> "This shared resource was not found."
//   409  -> resource-specific conflict copy.
//   429  -> "<brand> Cloud is rate limiting requests. Try again shortly."
//   5xx  -> "<brand> Cloud returned an unexpected error. Try again later."
//   network/timeout -> "Could not reach <brand> Cloud. Check your
//                       connection and try again."
//   unsupported capability -> caller-specific (skills vs Collections).
// ---------------------------------------------------------------------------

import {
  classifyShareFailure,
  resourceContextRefusalMessage,
  shareFailureCopy,
} from '@canopy/ui-app/sharing';
import { brandText } from '@/lib/brand';
import { extractIpcErrorMessage } from '@/lib/errors';

const CLOUD_NAME = `${brandText.appName} Cloud`;

export const SHARED_RESOURCE_ERROR_COPY = {
  INVALID_REQUEST: 'Invalid request.',
  PERMISSION_DENIED: 'You do not have permission to perform this action.',
  NOT_FOUND: 'This shared resource was not found.',
  RATE_LIMITED: `${CLOUD_NAME} is rate limiting requests. Try again shortly.`,
  SERVER_ERROR: `${CLOUD_NAME} returned an unexpected error. Try again later.`,
  CONFLICT:
    'This shared resource could not be changed because it is referenced elsewhere.',
  NETWORK_ERROR: `Could not reach ${CLOUD_NAME}. Check your connection and try again.`,
  SKILLS_UNSUPPORTED: `${CLOUD_NAME} does not support shared skills.`,
  COLLECTIONS_UNSUPPORTED: `${CLOUD_NAME} does not support shared collections.`,
  AGENTS_UNSUPPORTED: `${CLOUD_NAME} does not support shared model presets.`,
  AUTOMATIONS_UNSUPPORTED: `${CLOUD_NAME} does not support shared automations.`,
  SKILL_DELETE_CONFLICT:
    'This skill is used by one or more collections. Remove it from those collections before deleting it.',
} as const;

/**
 * Lightweight shape extracted from a thrown error or rejected promise body.
 * The desktop preload bridge propagates main-side errors through promise
 * rejection; callers may set a `status` field or include the original Response
 * status in the message.
 */
export interface SharedResourceErrorInput {
  code?: string;
  status?: number;
  message?: string;
}

/**
 * A 404 is safe to recreate only when the durable author link was written by
 * the account that is still connected. Legacy/unbound links fail closed so an
 * account switch cannot orphan a previous account's share or public link.
 */
export async function missingRemoteShareCanBeRecreated(
  remoteAccountId: string | undefined,
): Promise<boolean> {
  if (!remoteAccountId) return false;
  try {
    const state = await window.api.loadCanopyCloudAccount();
    return state.account?.id === remoteAccountId;
  } catch {
    return false;
  }
}

/**
 * Map an error / status code combination to the canonical display copy.
 *
 * @param input  the thrown error / status descriptor
 * @param options.deleteConflictMessage   override returned on 409s, used by
 *   the shared skill delete flow which has a Collection-specific message.
 */
export function resolveSharedResourceErrorMessage(
  input: unknown,
  options: {
    deleteConflictMessage?: string;
    unsupportedResource?: 'skills' | 'collections' | 'agents' | 'automations';
    /** Resource noun for structured share failures, e.g. `skill`. */
    noun?: string;
  } = {},
): string {
  // Structured share failures carry their category; never re-derive it from
  // the message text.
  const failure = classifyShareFailure(input);
  if (failure) {
    if (failure.kind === 'conflict' && options.deleteConflictMessage) {
      return options.deleteConflictMessage;
    }
    // A resource-context refusal reads as the same sentence the dialog shows.
    return (
      resourceContextRefusalMessage(failure.message) ??
      shareFailureCopy(options.noun ?? 'item', failure)
    );
  }
  const code = readErrorCode(input);
  const status = readErrorStatus(input);
  const rawMessage = readErrorMessage(input);

  const unsupportedResource =
    options.unsupportedResource ?? inferUnsupportedResource(rawMessage);
  if (
    unsupportedResource &&
    (code === 'unsupported-capability' ||
      isUnsupportedCapabilityMessage(rawMessage))
  ) {
    if (unsupportedResource === 'skills') {
      return SHARED_RESOURCE_ERROR_COPY.SKILLS_UNSUPPORTED;
    }
    if (unsupportedResource === 'agents') {
      return SHARED_RESOURCE_ERROR_COPY.AGENTS_UNSUPPORTED;
    }
    if (unsupportedResource === 'automations') {
      return SHARED_RESOURCE_ERROR_COPY.AUTOMATIONS_UNSUPPORTED;
    }
    return SHARED_RESOURCE_ERROR_COPY.COLLECTIONS_UNSUPPORTED;
  }

  if (status === 400) {
    const serverMessage = stripHttpStatusPrefix(rawMessage, status);
    if (serverMessage.length > 0) {
      return serverMessage;
    }
    return SHARED_RESOURCE_ERROR_COPY.INVALID_REQUEST;
  }

  if (status === 401 || status === 403) {
    return SHARED_RESOURCE_ERROR_COPY.PERMISSION_DENIED;
  }

  if (status === 404) {
    return SHARED_RESOURCE_ERROR_COPY.NOT_FOUND;
  }

  if (status === 409) {
    return options.deleteConflictMessage ?? SHARED_RESOURCE_ERROR_COPY.CONFLICT;
  }

  if (status === 429) {
    return SHARED_RESOURCE_ERROR_COPY.RATE_LIMITED;
  }

  if (typeof status === 'number' && status >= 500 && status < 600) {
    return SHARED_RESOURCE_ERROR_COPY.SERVER_ERROR;
  }

  if (isNetworkError(rawMessage)) {
    return SHARED_RESOURCE_ERROR_COPY.NETWORK_ERROR;
  }

  return rawMessage && rawMessage.length > 0
    ? rawMessage
    : SHARED_RESOURCE_ERROR_COPY.SERVER_ERROR;
}

function readErrorCode(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'code' in input) {
    const code = (input as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function readErrorStatus(input: unknown): number | undefined {
  if (input && typeof input === 'object' && 'status' in input) {
    const status = (input as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return status;
    }
  }
  const message = readErrorMessage(input);
  if (!message) return undefined;
  // Match patterns like "HTTP 404" or "(429)" embedded in propagated messages.
  const match = message.match(/(?:^|\s|\()(\d{3})(?:\s|:|\)|$)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The thrown message without Electron's IPC wrapper or an error-class prefix. */
function readErrorMessage(input: unknown): string {
  const raw = readRawErrorMessage(input);
  return raw.length > 0 ? extractIpcErrorMessage(raw) : '';
}

function readRawErrorMessage(input: unknown): string {
  if (input instanceof Error) {
    return input.message;
  }
  if (typeof input === 'string') {
    return input;
  }
  if (input && typeof input === 'object' && 'message' in input) {
    const { message } = input;
    if (typeof message === 'string') return message;
  }
  return '';
}

function isNetworkError(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('timeout')
  );
}

function inferUnsupportedResource(
  message: string,
): 'skills' | 'collections' | 'agents' | 'automations' | undefined {
  if (!message) return undefined;
  const lower = message.toLowerCase();
  if (lower.includes('skills-crud-v1') || lower.includes('shared skills')) {
    return 'skills';
  }
  if (
    lower.includes('collections-crud-v1') ||
    lower.includes('shared collections')
  ) {
    return 'collections';
  }
  if (lower.includes('agents-crud-v1') || lower.includes('shared agents')) {
    return 'agents';
  }
  if (
    lower.includes('automations-crud-v1') ||
    lower.includes('shared automations')
  ) {
    return 'automations';
  }
  return undefined;
}

function isUnsupportedCapabilityMessage(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('does not support') && lower.includes('-crud-v1');
}

function stripHttpStatusPrefix(message: string, status: number): string {
  if (!message) return '';
  const escapedStatus = String(status).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = new RegExp(`^\\s*HTTP\\s+${escapedStatus}\\s*:\\s*`, 'i');
  return message.replace(prefix, '').trim();
}

/**
 * Best-effort HTTP status extraction from a shared-resource client error:
 * a numeric `status` field when present, otherwise the first three-digit
 * number that reads like a status code in the error message. Share modals use
 * it to detect 409 update conflicts.
 */
export function readSharedResourceErrorStatus(
  input: unknown,
): number | undefined {
  const failure = classifyShareFailure(input);
  if (failure) return failure.httpStatus;
  if (input !== null && typeof input === 'object' && 'status' in input) {
    const { status } = input;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return status;
    }
  }
  let message = '';
  if (input instanceof Error) {
    message = input.message;
  } else if (typeof input === 'string') {
    message = input;
  } else if (
    input !== null &&
    typeof input === 'object' &&
    'message' in input
  ) {
    const candidate = input.message;
    if (typeof candidate === 'string') {
      message = candidate;
    }
  }
  const match = message.match(/(?:^|\s|\()(\d{3})(?:\s|:|\)|$)/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}
