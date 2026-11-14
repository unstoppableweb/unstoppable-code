import { Element, Text } from 'slate';
import type { Descendant } from 'slate';
import type { CustomText, FileReferenceElement } from '@canopy/ui-rich/types';
import { richDraftHasContent } from '@canopy/ui-rich/editor/append-draft-text';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { readTryItDraft } from './tryItDraftStorage';

const PREFIX = 'canopy:chat-draft:v1:';
const VERSION = 1;

/** Serialized size limit for one draft, in UTF-16 code units. */
export const CHAT_DRAFT_MAX_CHARS = 64 * 1024;
/** Combined size limit for every stored draft, keys included. */
export const CHAT_DRAFT_BUDGET_CHARS = 1024 * 1024;
export const CHAT_DRAFT_WRITE_DELAY_MS = 500;

export type StoredChatDraft =
  | { readonly kind: 'none' }
  | { readonly kind: 'draft'; readonly content: Descendant[] }
  | { readonly kind: 'unreadable' };

export type ChatDraftWriteResult = 'saved' | 'removed' | 'failed';

const NONE: StoredChatDraft = { kind: 'none' };
const UNREADABLE: StoredChatDraft = { kind: 'unreadable' };

function isPayloadUrl(value: string): boolean {
  return /^\s*(?:data|blob):/i.test(value);
}

function sanitizeText(node: CustomText): CustomText {
  return { text: node.text };
}

function sanitizeReference(
  node: FileReferenceElement,
): FileReferenceElement | null {
  if (isPayloadUrl(node.absolutePath) || isPayloadUrl(node.displayPath))
    return null;
  return {
    type: 'file-reference',
    displayPath: node.displayPath,
    absolutePath: node.absolutePath,
    ...(node.repoName !== undefined ? { repoName: node.repoName } : {}),
    ...(node.kind !== undefined ? { kind: node.kind } : {}),
    children: [{ text: '' }],
  };
}

function sanitizeInlines(
  children: readonly Descendant[],
): (CustomText | FileReferenceElement)[] {
  const result: (CustomText | FileReferenceElement)[] = [];
  for (const child of children) {
    if (Text.isText(child)) {
      result.push(sanitizeText(child));
    } else if (Element.isElement(child)) {
      if (child.type === 'file-reference') {
        const reference = sanitizeReference(child);
        if (reference) result.push(reference);
      } else {
        result.push(...sanitizeInlines(child.children));
      }
    }
  }
  // Slate needs a text node around inline voids and in every block.
  return result.length === 0 || !Text.isText(result[result.length - 1])
    ? [...result, { text: '' }]
    : result;
}

/**
 * Keeps only text and file references (paths and names), so a stored draft
 * never carries file bytes, data URLs or editor-only properties.
 */
export function sanitizeChatDraft(
  content: readonly Descendant[],
): Descendant[] {
  const result: Descendant[] = [];
  for (const node of content) {
    if (Text.isText(node)) {
      result.push({ type: 'paragraph', children: [sanitizeText(node)] });
    } else if (Element.isElement(node)) {
      result.push({
        type: 'paragraph',
        children: sanitizeInlines(
          node.type === 'paragraph' ? node.children : [node],
        ),
      });
    }
  }
  return result;
}

function storageKey(chatId: string): string {
  return PREFIX + chatId;
}

function removeKeyQuietly(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    // Storage unavailable: nothing to remove.
    reportClientAppError(error);
  }
}

function isDraftContent(value: unknown): value is Descendant[] {
  return (
    Array.isArray(value) &&
    value.every(
      (node: unknown) =>
        (Element.isElement(node) &&
          (node.type === 'paragraph' || node.type === 'file-reference')) ||
        Text.isText(node),
    )
  );
}

/** Interface-local composer state; never a canonical chat/transcript write. */
export function readChatDraft(chatId: string): StoredChatDraft {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(chatId));
  } catch (error) {
    // Unavailable storage reads as no draft.
    reportClientAppError(error);
    return NONE;
  }
  if (raw === null) return NONE;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('v' in value) ||
      value.v !== VERSION ||
      !('savedAt' in value) ||
      typeof value.savedAt !== 'number' ||
      !('content' in value) ||
      !isDraftContent(value.content)
    )
      return UNREADABLE;
    const content = sanitizeChatDraft(value.content);
    return richDraftHasContent(content) ? { kind: 'draft', content } : NONE;
  } catch (error) {
    reportClientAppError(error);
    return UNREADABLE;
  }
}

/** A staged Try-it draft wins over the plain draft; there is one per chat. */
export function readStoredTabDraft(chatId: string): StoredChatDraft {
  const tryIt = readTryItDraft(chatId);
  if (tryIt) return { kind: 'draft', content: tryIt.content };
  return readChatDraft(chatId);
}

const SAVED_AT = /^\{"v":\d+,"savedAt":(\d+),/;

/** Evicts the oldest other drafts until `needed` more characters fit. */
function makeRoom(key: string, needed: number): void {
  const others: { key: string; size: number; savedAt: number }[] = [];
  let total = 0;
  for (let index = 0; index < localStorage.length; index += 1) {
    const otherKey = localStorage.key(index);
    if (otherKey === null || otherKey === key || !otherKey.startsWith(PREFIX))
      continue;
    const value = localStorage.getItem(otherKey) ?? '';
    const size = otherKey.length + value.length;
    total += size;
    others.push({
      key: otherKey,
      size,
      savedAt: Number(SAVED_AT.exec(value)?.[1] ?? 0),
    });
  }
  if (total + needed <= CHAT_DRAFT_BUDGET_CHARS) return;
  others.sort((a, b) => a.savedAt - b.savedAt);
  for (const other of others) {
    if (total + needed <= CHAT_DRAFT_BUDGET_CHARS) return;
    localStorage.removeItem(other.key);
    total -= other.size;
  }
}

let writeFailureRecorded = false;

/**
 * Stores `content` as the chat's draft, or removes it when empty. A draft
 * that can't be stored (too large, storage full or unavailable) is removed
 * so an older copy is never restored in its place; the caller keeps the
 * in-memory draft.
 */
export function writeChatDraft(
  chatId: string,
  content: readonly Descendant[],
): ChatDraftWriteResult {
  const key = storageKey(chatId);
  const sanitized = sanitizeChatDraft(content);
  if (!richDraftHasContent(sanitized)) {
    removeKeyQuietly(key);
    return 'removed';
  }
  const value = JSON.stringify({
    v: VERSION,
    savedAt: Date.now(),
    content: sanitized,
  });
  if (value.length > CHAT_DRAFT_MAX_CHARS) {
    removeKeyQuietly(key);
    return 'failed';
  }
  try {
    makeRoom(key, key.length + value.length);
    localStorage.setItem(key, value);
    return 'saved';
  } catch (error) {
    // Storage full or unavailable: the draft stays in memory. Typing retries
    // every pause, so only the first failure is recorded.
    if (!writeFailureRecorded) {
      writeFailureRecorded = true;
      reportClientAppError(error);
    }
    removeKeyQuietly(key);
    return 'failed';
  }
}

interface PendingWrite {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly content: readonly Descendant[];
  readonly onFailed: (() => void) | undefined;
}

const pendingWrites = new Map<string, PendingWrite>();

function runPendingWrite(chatId: string): void {
  const pending = pendingWrites.get(chatId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingWrites.delete(chatId);
  if (writeChatDraft(chatId, pending.content) === 'failed')
    pending.onFailed?.();
}

export function cancelChatDraftWrite(chatId: string): void {
  const pending = pendingWrites.get(chatId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingWrites.delete(chatId);
}

/** Writes the chat's draft after typing pauses; a later call replaces it. */
export function scheduleChatDraftWrite(
  chatId: string,
  content: readonly Descendant[],
  onFailed?: () => void,
): void {
  cancelChatDraftWrite(chatId);
  pendingWrites.set(chatId, {
    timer: setTimeout(() => runPendingWrite(chatId), CHAT_DRAFT_WRITE_DELAY_MS),
    content,
    onFailed,
  });
}

export function flushPendingChatDraftWrites(): void {
  for (const chatId of Array.from(pendingWrites.keys()))
    runPendingWrite(chatId);
}

export function removeChatDraft(chatId: string): void {
  cancelChatDraftWrite(chatId);
  removeKeyQuietly(storageKey(chatId));
}

let saveFailureReported = false;

/** True the first time only: a failed save is reported once per session. */
export function claimChatDraftSaveFailureReport(): boolean {
  if (saveFailureReported) return false;
  saveFailureReported = true;
  return true;
}

let quitFlushInstalled = false;

/**
 * Saves open composers and pending writes when the window unloads, so a
 * quit inside the write delay keeps the last keystrokes.
 */
export function installChatDraftQuitFlush(saveOpenDrafts: () => void): void {
  if (quitFlushInstalled || typeof window === 'undefined') return;
  quitFlushInstalled = true;
  const flush = (): void => {
    saveOpenDrafts();
    flushPendingChatDraftWrites();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}
