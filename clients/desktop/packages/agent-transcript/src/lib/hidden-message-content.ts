import type { ChatWatcherFiredInfo } from '@canopy/protocol/remote-control/shell';

/**
 * One on-screen part of a message that may carry hidden provider context.
 * Host messages to a delegate (watcher notifications, a subordinate's
 * steering request, capability reloads) reach the provider as
 * `<system_instruction>` blocks with no separate display text, and the
 * broker appends one that arrives while a follow-up is queued to that run's
 * prompt. The UI derives what to show from the message itself, part by part.
 */
export type VisibleMessagePart =
  /** Visible text: a typed message or a readable notice. */
  | { readonly kind: 'text'; readonly text: string }
  /** A watcher notification, shown with the watcher-fired title. */
  | {
      readonly kind: 'watcher';
      readonly text: string;
      readonly watcherFired: ChatWatcherFiredInfo;
    }
  /** A delegate's request for steering from its parent. */
  | {
      readonly kind: 'steering_request';
      readonly text: string;
      readonly requestedBy?: string;
    }
  /** Instructions only the model sees, with nothing else to show. */
  | { readonly kind: 'hidden' };

const SYSTEM_INSTRUCTION_PATTERN =
  /<system_instruction>[\s\S]*?(?:<\/system_instruction>|$)/gi;
const WATCHER_EVENT_PATTERN =
  /<([a-z][a-z0-9]*)_watcher_event>([\s\S]*?)<\/\1_watcher_event>/i;
const WATCHER_DELETED_PATTERN =
  /<([a-z][a-z0-9]*)_watcher_deleted>([\s\S]*?)<\/\1_watcher_deleted>/i;
const SUBORDINATE_REQUEST_PATTERN =
  /<subordinate_request>([\s\S]*?)<\/subordinate_request>/i;
const SUBORDINATE_SENDER_PATTERN =
  /A managed subordinate \((.*?)\) requested steering/;
const DELEGATION_FINISHED_WATCHER_KIND = 'Delegate finished';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function payloadLabel(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const label = payload?.['label'];
  return typeof label === 'string' && label.trim().length > 0
    ? label.trim()
    : undefined;
}

/**
 * The watcher-fired title. Delegate watches use the main chat's wording
 * (`describeWatcherFiredKind`); other watchers carry no kind in their
 * payload, so they are named by their label.
 */
function watcherKind(payload: Record<string, unknown> | undefined): string {
  if (payload?.['kind'] === 'delegation_finished') {
    return DELEGATION_FINISHED_WATCHER_KIND;
  }
  const target = payload?.['target'];
  if (isRecord(target) && target['kind'] === 'managed_delegation') {
    return target['outcome'] === 'timeout'
      ? 'Delegate watch timed out'
      : 'Delegate watch completed';
  }
  return payloadLabel(payload) ?? 'Watcher';
}

/** Reverses the escaping the broker applies inside a subordinate request. */
function unescapeSubordinateText(text: string): string {
  return text
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n');
}

/** The visible form of one hidden instruction block, if it has one. */
function hiddenBlockPart(block: string): VisibleMessagePart {
  const watcherEvent = WATCHER_EVENT_PATTERN.exec(block);
  if (watcherEvent) {
    const payload = parsePayload(watcherEvent[2] ?? '');
    return {
      kind: 'watcher',
      text: payloadLabel(payload) ?? '',
      watcherFired: { kind: watcherKind(payload) },
    };
  }
  const watcherDeleted = WATCHER_DELETED_PATTERN.exec(block);
  if (watcherDeleted) {
    const label = payloadLabel(parsePayload(watcherDeleted[2] ?? ''));
    return {
      kind: 'text',
      text: label ? `Watcher deleted: ${label}` : 'Watcher deleted',
    };
  }
  const subordinateRequest = SUBORDINATE_REQUEST_PATTERN.exec(block);
  if (subordinateRequest) {
    const sender = SUBORDINATE_SENDER_PATTERN.exec(block)?.[1];
    return {
      kind: 'steering_request',
      text: unescapeSubordinateText((subordinateRequest[1] ?? '').trim()),
      ...(sender ? { requestedBy: unescapeSubordinateText(sender) } : {}),
    };
  }
  return { kind: 'hidden' };
}

/**
 * Splits a message into what to show, in order. Visible text and each
 * recognized host message become their own part; other hidden instructions
 * are dropped beside visible content, as the main chat drops them, and show
 * as one `hidden` part when nothing else is visible.
 */
export function visibleMessageParts(
  text: string,
): readonly VisibleMessagePart[] {
  const parts: VisibleMessagePart[] = [];
  const pushText = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length > 0) parts.push({ kind: 'text', text: trimmed });
  };
  let hidden = false;
  let cursor = 0;
  for (const match of Array.from(text.matchAll(SYSTEM_INSTRUCTION_PATTERN))) {
    pushText(text.slice(cursor, match.index));
    const part = hiddenBlockPart(match[0]);
    if (part.kind === 'hidden') hidden = true;
    else parts.push(part);
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return text.length > 0 ? [{ kind: 'text', text }] : [];
  pushText(text.slice(cursor));
  return parts.length === 0 && hidden ? [{ kind: 'hidden' }] : parts;
}

/** Whether a visible prompt part is text an authored message already shows. */
export function isVisiblePartShown(
  part: VisibleMessagePart,
  shownTexts: readonly string[],
): boolean {
  return (
    part.kind === 'text' &&
    shownTexts.some((shown) => shown.trim() === part.text.trim())
  );
}

/**
 * The first part of a run's prompt that an authored message in the run
 * already shows. A host message folded into a queued follow-up belongs after
 * that message.
 */
export function subagentPromptAuthoredText(
  prompt: string,
  authoredTexts: readonly string[],
): string | undefined {
  const part = visibleMessageParts(prompt).find((candidate) =>
    isVisiblePartShown(candidate, authoredTexts),
  );
  return part?.kind === 'text' ? part.text : undefined;
}

/**
 * A delegate's steering request when that is all the message carries. The
 * broker delivers one to its root chat as a hidden instruction block with no
 * separate display text, so the chat shows it from the message itself.
 */
export function subordinateSteeringRequest(
  text: string,
): { readonly text: string; readonly requestedBy?: string } | undefined {
  const parts = visibleMessageParts(text);
  const [part] = parts;
  if (parts.length !== 1 || part?.kind !== 'steering_request') return undefined;
  return part.requestedBy
    ? { text: part.text, requestedBy: part.requestedBy }
    : { text: part.text };
}
