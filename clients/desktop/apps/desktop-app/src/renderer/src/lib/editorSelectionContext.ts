import type { InsertChatTextDetail } from '@canopy/app-core';

export function isChatComposerFocusRequest(value: unknown): value is {
  targetTabId: string;
  markHandled: (result: 'focused' | 'modal-blocked') => void;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'targetTabId' in value &&
    typeof value.targetTabId === 'string' &&
    'markHandled' in value &&
    typeof value.markHandled === 'function'
  );
}
/**
 * Editor selection → composer context (CAN-1250).
 *
 * A selection captured in the file editor becomes a pending "context chip" on
 * the chat composer instead of pasted text. This module owns the shared chip
 * shape, the document-level events that route capture/reveal between the
 * editor panels and the visible composer, freshness checking against the live
 * buffer, and the send-time serialization into structured blocks the agent can
 * parse.
 */

/** One captured editor selection staged on a chat tab's composer. */
export interface EditorSelectionContext {
  id: string;
  projectId: string;
  worktreeId: string;
  /** Absolute path on disk — used for reveal routing and freshness checks. */
  absolutePath: string;
  /** Repo-root-relative path shown to the user and sent to the agent. */
  displayPath: string;
  /** File root / repo id when the workspace has multiple roots. */
  repoId?: string;
  /** 1-based range with Monaco's exclusive end column. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** Exact selected text at capture time. */
  text: string;
  language?: string;
  /** The editor buffer had unsaved edits when the selection was captured. */
  capturedDirty: boolean;
  /** Server-confirmed file revision (mtime ISO string) at capture, if known. */
  capturedModifiedAt?: string;
}

/**
 * How a captured selection relates to the file's current content:
 * - `fresh`: the captured range still matches.
 * - `stale`: the file changed under the captured range.
 * - `missing`: the file content is unavailable (deleted/unreadable).
 * - `checking`: the fallback disk read has not completed yet.
 */
export type SelectionFreshness = 'fresh' | 'stale' | 'missing' | 'checking';

/** A selection paired with its last computed freshness for serialization. */
export interface SelectionWithFreshness {
  selection: EditorSelectionContext;
  freshness: SelectionFreshness;
}

/**
 * A captured selection before an id is assigned. Editor surfaces stage these
 * directly on the chat store (`addPendingEditorSelection`) — the default panel
 * layout tabs the editor and the composer into the same leaf, so a visible
 * composer cannot be assumed at capture time.
 */
export type AddEditorSelectionDetail = Omit<EditorSelectionContext, 'id'>;

/** Requests that the active file editor stage its current selection. */
export const SEND_EDITOR_SELECTION_TO_CHAT_EVENT =
  'canopy:send-editor-selection-to-chat';

export {
  INSERT_CHAT_TEXT_EVENT,
  isInsertChatTextDetail,
  type InsertChatTextDetail,
} from '@canopy/app-core';

export function shouldHandleChatTextInsertion(
  detail: InsertChatTextDetail,
  composerTabId: string | undefined,
  composerVisible: boolean,
  composerEditing = false,
): boolean {
  if (composerEditing) return false;
  return detail.targetTabId === undefined
    ? composerVisible
    : detail.targetTabId === composerTabId;
}

/** Synchronous acknowledgement used by the App Advisor action dispatcher. */
export interface SendEditorSelectionToChatDetail {
  tabId: string;
  markHandled: () => void;
}

export function isSendEditorSelectionToChatDetail(
  value: unknown,
): value is SendEditorSelectionToChatDetail {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'tabId' in value &&
    typeof value.tabId === 'string' &&
    'markHandled' in value &&
    typeof value.markHandled === 'function'
  );
}

/** Dispatched by the composer chips to reveal a range in the file's editor. */
export const REVEAL_EDITOR_RANGE_EVENT = 'canopy:reveal-editor-range';

/** Payload for the `canopy:reveal-editor-range` document event. */
export interface RevealEditorRangeDetail {
  absolutePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Reveals requested while the target file's editor is not mounted (or not yet
 * loaded) are stashed per path. The composer dispatches the reveal event AND
 * stashes here; a mounted editor with content handles the event directly and
 * consumes the stash, while a later-mounting editor picks the stash up once
 * its content is ready.
 */
const pendingEditorRangeReveals = new Map<string, RevealEditorRangeDetail>();

/** Stash a reveal request for editors that mount (or load) later. */
export function stashPendingEditorRangeReveal(
  detail: RevealEditorRangeDetail,
): void {
  pendingEditorRangeReveals.set(detail.absolutePath, detail);
}

/** Read the stashed reveal for a path without consuming it. */
export function peekPendingEditorRangeReveal(
  absolutePath: string,
): RevealEditorRangeDetail | null {
  return pendingEditorRangeReveals.get(absolutePath) ?? null;
}

/** Take (and clear) the stashed reveal for a path. */
export function consumePendingEditorRangeReveal(
  absolutePath: string,
): RevealEditorRangeDetail | null {
  const detail = pendingEditorRangeReveals.get(absolutePath) ?? null;
  pendingEditorRangeReveals.delete(absolutePath);
  return detail;
}

/** Minimal structural view of a chat tab for capture-target resolution. */
export interface SelectionTargetTabLike {
  id: string;
  kind?: string;
  readOnly?: boolean;
}

/**
 * Resolve which chat tab a captured selection should stage on:
 * 1. the active tab, when it is an editable chat tab;
 * 2. the explicitly tracked `lastActiveEditableChatId`, when it still
 *    resolves to an editable chat tab;
 * 3. the first editable chat tab in tab order — legacy persisted files
 *    predate `lastActiveEditableChatId`, and capture silently failing while a
 *    chat tab exists reads as "Send to Chat does nothing" (CAN-1250).
 *
 * Returns `null` only when the worktree has no editable chat tab at all.
 */
export function resolveSelectionTargetTabId(args: {
  tabs: readonly SelectionTargetTabLike[];
  activeTabId: string;
  lastActiveEditableChatId?: string;
}): string | null {
  const isEditableChatTab = (tab: SelectionTargetTabLike): boolean =>
    tab.kind !== 'file' && !tab.readOnly;
  const activeTab = args.tabs.find((tab) => tab.id === args.activeTabId);
  if (activeTab && isEditableChatTab(activeTab)) {
    return activeTab.id;
  }
  const remembered = args.lastActiveEditableChatId
    ? args.tabs.find(
        (tab) =>
          tab.id === args.lastActiveEditableChatId && isEditableChatTab(tab),
      )
    : undefined;
  if (remembered) {
    return remembered.id;
  }
  return args.tabs.find(isEditableChatTab)?.id ?? null;
}

/**
 * Monaco ranges use an exclusive end column. When a multiline selection ends
 * at column 1, that final line contributes no selected text and must not be
 * presented as part of the inclusive user/model-facing line range.
 */
function formatSelectionLines(
  selection: Pick<
    EditorSelectionContext,
    'startLine' | 'endLine' | 'endColumn'
  >,
): string {
  const inclusiveEndLine =
    selection.endLine > selection.startLine && selection.endColumn === 1
      ? selection.endLine - 1
      : selection.endLine;
  return selection.startLine === inclusiveEndLine
    ? `${selection.startLine}`
    : `${selection.startLine}-${inclusiveEndLine}`;
}

/** `App.tsx:2-3` (or `App.tsx:5` for a single-line selection). */
export function formatSelectionLabel(
  selection: Pick<
    EditorSelectionContext,
    'displayPath' | 'startLine' | 'endLine' | 'endColumn'
  >,
): string {
  const filename =
    selection.displayPath.split('/').pop() ?? selection.displayPath;
  return `${filename}:${formatSelectionLines(selection)}`;
}

/**
 * Compare a captured selection against the file's current content. Monaco uses
 * 1-based columns with an exclusive end column, so extract that exact range
 * rather than searching the surrounding lines for the captured text.
 */
export function computeSelectionFreshness(
  selection: Pick<
    EditorSelectionContext,
    'startLine' | 'startColumn' | 'endLine' | 'endColumn' | 'text'
  >,
  currentContent: string | null,
): SelectionFreshness {
  if (currentContent === null) {
    return 'missing';
  }

  const {
    startLine,
    startColumn,
    endLine,
    endColumn,
    text: capturedText,
  } = selection;
  if (
    startLine < 1 ||
    endLine < startLine ||
    startColumn < 1 ||
    endColumn < 1
  ) {
    return 'stale';
  }

  let currentLine = 1;
  let currentLineStart = 0;
  let startLineStart = startLine === 1 ? 0 : -1;
  let startLineEnd = -1;
  let endLineStart = endLine === 1 ? 0 : -1;
  let endLineEnd = -1;

  for (let index = 0; index <= currentContent.length; index += 1) {
    if (
      index !== currentContent.length &&
      currentContent.charCodeAt(index) !== 10
    ) {
      continue;
    }

    const lineEnd =
      index !== currentContent.length &&
      index > currentLineStart &&
      currentContent.charCodeAt(index - 1) === 13
        ? index - 1
        : index;
    if (currentLine === startLine) {
      startLineStart = currentLineStart;
      startLineEnd = lineEnd;
    }
    if (currentLine === endLine) {
      endLineStart = currentLineStart;
      endLineEnd = lineEnd;
      break;
    }

    currentLine += 1;
    currentLineStart = index + 1;
  }

  if (
    startLineStart < 0 ||
    startLineEnd < 0 ||
    endLineStart < 0 ||
    endLineEnd < 0
  ) {
    return 'stale';
  }

  const firstLineLength = startLineEnd - startLineStart;
  const lastLineLength = endLineEnd - endLineStart;
  if (
    startColumn > firstLineLength + 1 ||
    endColumn > lastLineLength + 1 ||
    (startLine === endLine && endColumn < startColumn)
  ) {
    return 'stale';
  }

  const selectionStart = startLineStart + startColumn - 1;
  const selectionEnd = endLineStart + endColumn - 1;
  const currentSelection = currentContent
    .slice(selectionStart, selectionEnd)
    .replace(/\r\n/g, '\n');
  return currentSelection === capturedText.replace(/\r\n/g, '\n')
    ? 'fresh'
    : 'stale';
}

/**
 * True when an equivalent selection (same file, same range, same text) is
 * already staged — used to keep repeated ⌘L presses from stacking duplicates.
 */
export function isDuplicateSelection(
  existing: readonly EditorSelectionContext[],
  candidate: Omit<EditorSelectionContext, 'id'>,
): boolean {
  return existing.some(
    (entry) =>
      entry.absolutePath === candidate.absolutePath &&
      entry.startLine === candidate.startLine &&
      entry.startColumn === candidate.startColumn &&
      entry.endLine === candidate.endLine &&
      entry.endColumn === candidate.endColumn &&
      entry.text === candidate.text,
  );
}

/**
 * Append a captured selection to a tab's staged list, assigning it an id.
 * Duplicates (same file, range, and text) return the original list unchanged
 * so repeated ⌘L presses do not stack identical chips.
 */
export function appendSelectionToList(
  existing: readonly EditorSelectionContext[] | undefined,
  detail: AddEditorSelectionDetail,
): readonly EditorSelectionContext[] {
  const current = existing ?? [];
  if (isDuplicateSelection(current, detail)) {
    return current;
  }
  return [...current, { ...detail, id: crypto.randomUUID() }];
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function serializeSelectionBlock(entry: SelectionWithFreshness): string {
  const { selection, freshness } = entry;
  const attributes: string[] = [
    `file="${escapeXmlAttribute(selection.displayPath)}"`,
  ];
  if (selection.repoId) {
    attributes.push(`repo="${escapeXmlAttribute(selection.repoId)}"`);
  }
  attributes.push(`lines="${formatSelectionLines(selection)}"`);
  if (selection.language) {
    attributes.push(`language="${escapeXmlAttribute(selection.language)}"`);
  }
  if (selection.capturedDirty) {
    attributes.push('unsaved="true"');
  }
  if (freshness !== 'fresh') {
    attributes.push(`status="${freshness}"`);
  }
  return `<code_selection ${attributes.join(' ')}>\n${escapeXmlText(selection.text)}\n</code_selection>`;
}

/**
 * Append staged selections to the outgoing message text as structured blocks.
 * The composer draft itself is never mutated — this runs on the already
 * serialized text at send time, mirroring prompt-mention expansion.
 */
export function appendSelectionContextBlocks(
  text: string,
  selections: readonly SelectionWithFreshness[],
): string {
  if (selections.length === 0) {
    return text;
  }
  const blocks = selections.map(serializeSelectionBlock).join('\n\n');
  return text.length > 0 ? `${text}\n\n${blocks}` : blocks;
}
