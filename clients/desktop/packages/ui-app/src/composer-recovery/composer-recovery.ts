import type { PortalChatMessage } from '@canopy/protocol/portal';

/**
 * Composer recovery after a refused turn (CAN-5348).
 *
 * A send clears the composer and commits the user message before the host
 * knows whether anything can pay for the turn. When the turn is then refused
 * before the agent did any work, the composer gets the submission back so the
 * user can press Send again once billing recovers. This module is the
 * host-agnostic lifecycle and decision: hosts own event delivery, transcript
 * projection, and how editor content and reserved inputs are applied.
 *
 * Identity is the user-message ID supplied to dispatch, never prompt text or
 * transcript position. Refusals carry that ID even before the transcript lands.
 */

/** How the host settled the dispatch of a recorded submission. */
export type ComposerRecoverySettlement =
  /** Dispatch has not reported back yet; accepted-send cleanup may still run. */
  | 'pending'
  /** Dispatch was accepted and its cleanup has finished. */
  | 'accepted'
  /**
   * Dispatch was rejected after commit and the host already returned the
   * reserved inputs to the composer, so only editor content may be restored.
   */
  | 'reserved-inputs-restored';

export interface ComposerRecoverySubmission<TEditorValue, TReservedInputs> {
  /** Cloned editor value as submitted, including rich nodes and pills. */
  editorValue: TEditorValue;
  /** Host-defined reserved inputs (attachments, selections, revert input). */
  reservedInputs: TReservedInputs;
  /** Final outbound text after prompt expansion and path rewriting. */
  outboundText: string;
  /** User-message identity supplied to the host dispatch. */
  userMessageId: string;
  /** Last user message in the transcript just before dispatch. */
  priorLastUserMessageId: string | null;
  /** Whether the send emptied the composer; a kept newer draft is never replaced. */
  composerCleared: boolean;
}

export interface ComposerRecoveryAbortBinding {
  userMessageId: string;
  /** Diagnostic transcript count only; never used as submission identity. */
  userMessageOrdinal: number;
}

export interface ComposerRecoveryEntry<TEditorValue, TReservedInputs> {
  readonly generation: number;
  readonly submission: ComposerRecoverySubmission<
    TEditorValue,
    TReservedInputs
  >;
  readonly settlement: ComposerRecoverySettlement;
  /** The user changed composer input after the send cleared it. */
  readonly userEdited: boolean;
  readonly abort: ComposerRecoveryAbortBinding | null;
  /** Application is in progress; other effects must wait. */
  readonly claimed: boolean;
  /** A failed application remains retained until the host remounts/retries. */
  readonly applicationFailed: boolean;
}

/** Minimal transcript projection a host supplies for decisions. */
export interface ComposerRecoveryTranscriptMessage {
  id: string;
  isUser: boolean;
  /** Assistant output or tool activity, per the host's resume-safety rule. */
  hasAgentActivity: boolean;
}

export interface ComposerRecoveryTranscriptHead {
  lastUserMessageId: string | null;
  userMessageCount: number;
}

export interface ComposerRecoveryOccupancy {
  /** Editor text or pills. */
  editorContent: boolean;
  attachments: boolean;
  selections: boolean;
  revertAttachment: boolean;
  savedDraft: boolean;
}

export type ComposerRecoveryMode = 'compose' | 'terminal';

export interface ComposerRecoveryLiveState {
  /** The composer for this target is mounted and has loaded its draft. */
  composerHydrated: boolean;
  /** `null` while the transcript for this target is not loaded. */
  transcript: readonly ComposerRecoveryTranscriptMessage[] | null;
  occupancy: ComposerRecoveryOccupancy;
  mode: ComposerRecoveryMode;
}

export type ComposerRecoveryWaitReason =
  | 'no-abort'
  | 'dispatch-pending'
  | 'claimed'
  | 'application-failed'
  | 'composer-hydrating'
  | 'transcript-loading';

export type ComposerRecoverySkipReason =
  | 'no-submission'
  | 'composer-not-cleared'
  | 'turn-progressed'
  | 'turn-missing'
  | 'turn-superseded'
  | 'agent-activity'
  | 'composer-mode'
  | 'user-input'
  | 'composer-occupied';

export type ComposerRecoveryDecision =
  | { kind: 'wait'; reason: ComposerRecoveryWaitReason }
  | { kind: 'skip'; reason: ComposerRecoverySkipReason }
  | { kind: 'restore'; generation: number; restoreReservedInputs: boolean };

/** The newest user message and the count of user messages in a transcript. */
export function composerRecoveryTranscriptHead(
  transcript: readonly ComposerRecoveryTranscriptMessage[],
): ComposerRecoveryTranscriptHead {
  let lastUserMessageId: string | null = null;
  let userMessageCount = 0;
  for (const message of transcript) {
    if (!message.isUser) continue;
    userMessageCount += 1;
    lastUserMessageId = message.id;
  }
  return { lastUserMessageId, userMessageCount };
}

function findAbortedMessageIndex(
  transcript: readonly ComposerRecoveryTranscriptMessage[],
  binding: ComposerRecoveryAbortBinding,
): number {
  return transcript.findIndex(
    (message) => message.isUser && message.id === binding.userMessageId,
  );
}

function lastUserMessageIndex(
  transcript: readonly ComposerRecoveryTranscriptMessage[],
): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.isUser) return index;
  }
  return -1;
}

function hasActivityAfter(
  transcript: readonly ComposerRecoveryTranscriptMessage[],
  index: number,
): boolean {
  return transcript
    .slice(index + 1)
    .some((message) => !message.isUser && message.hasAgentActivity);
}

/** Whether the turn this submission started has visibly done agent work. */
function submissionTurnProgressed(
  transcript: readonly ComposerRecoveryTranscriptMessage[],
  userMessageId: string,
): boolean {
  const ownIndex = transcript.findIndex(
    (message) => message.isUser && message.id === userMessageId,
  );
  return ownIndex >= 0 && hasActivityAfter(transcript, ownIndex);
}

/**
 * Whether the composer already holds input. Reserved inputs a rejection already
 * returned belong to this submission, so they do not count.
 */
function composerOccupied(
  occupancy: ComposerRecoveryOccupancy,
  includeReservedInputs: boolean,
): boolean {
  if (occupancy.editorContent || occupancy.savedDraft) return true;
  return (
    includeReservedInputs &&
    (occupancy.attachments ||
      occupancy.selections ||
      occupancy.revertAttachment)
  );
}

/**
 * Decide whether a recorded submission should be restored now, later, or
 * never. `wait` leaves the entry untouched; `skip` is terminal and the host
 * releases the entry; `restore` must be claimed before it is applied.
 */
export function decideComposerRecovery<TEditorValue, TReservedInputs>(
  entry: ComposerRecoveryEntry<TEditorValue, TReservedInputs> | undefined,
  live: ComposerRecoveryLiveState,
): ComposerRecoveryDecision {
  if (!entry) return { kind: 'skip', reason: 'no-submission' };
  if (entry.claimed) return { kind: 'wait', reason: 'claimed' };
  // The dispatch callbacks still own acceptance bookkeeping and reservation
  // rollback. Keep their generation alive even when recovery is ineligible.
  if (entry.settlement === 'pending') {
    return { kind: 'wait', reason: 'dispatch-pending' };
  }
  if (!entry.submission.composerCleared) {
    return { kind: 'skip', reason: 'composer-not-cleared' };
  }
  const transcript = live.transcript;
  if (!entry.abort) {
    // Release once the turn did real work: no refusal can restore it anymore.
    if (
      transcript !== null &&
      submissionTurnProgressed(transcript, entry.submission.userMessageId)
    ) {
      return { kind: 'skip', reason: 'turn-progressed' };
    }
    return { kind: 'wait', reason: 'no-abort' };
  }
  if (!live.composerHydrated) {
    return { kind: 'wait', reason: 'composer-hydrating' };
  }
  if (transcript === null || transcript.length === 0) {
    return { kind: 'wait', reason: 'transcript-loading' };
  }
  const abortedIndex = findAbortedMessageIndex(transcript, entry.abort);
  if (abortedIndex < 0) return { kind: 'wait', reason: 'transcript-loading' };
  if (lastUserMessageIndex(transcript) !== abortedIndex) {
    return { kind: 'skip', reason: 'turn-superseded' };
  }
  if (hasActivityAfter(transcript, abortedIndex)) {
    return { kind: 'skip', reason: 'agent-activity' };
  }
  if (live.mode !== 'compose') return { kind: 'skip', reason: 'composer-mode' };
  if (entry.userEdited) return { kind: 'skip', reason: 'user-input' };
  if (entry.applicationFailed) {
    return { kind: 'wait', reason: 'application-failed' };
  }
  const restoreReservedInputs = entry.settlement !== 'reserved-inputs-restored';
  if (composerOccupied(live.occupancy, restoreReservedInputs)) {
    return { kind: 'skip', reason: 'composer-occupied' };
  }
  return {
    kind: 'restore',
    generation: entry.generation,
    restoreReservedInputs,
  };
}

export interface ComposerRecoveryStore<TEditorValue, TReservedInputs> {
  /** Invalidate older async preparation before the new send yields. */
  beginSubmission(key: string): number;
  isCurrentSubmission(key: string, generation: number): boolean;
  /** Closing a target also retires its dispatch identity. */
  forget(key: string): void;
  /**
   * Record a dispatched submission for `key`, superseding any earlier one.
   * Returns the generation that scopes every later transition.
   */
  record(
    key: string,
    submission: ComposerRecoverySubmission<TEditorValue, TReservedInputs>,
    generation?: number,
  ): number;
  settle(
    key: string,
    generation: number,
    settlement: Exclude<ComposerRecoverySettlement, 'pending'>,
  ): void;
  /** The user changed composer input; a cleared composer is theirs now. */
  noteUserInput(key: string): void;
  /**
   * Bind a refusal for `key` to its committed user message. Ignored when the
   * newest user message predates the submission or an abort is already bound.
   */
  recordAbort(key: string, head: ComposerRecoveryTranscriptHead): boolean;
  get(
    key: string,
  ): ComposerRecoveryEntry<TEditorValue, TReservedInputs> | undefined;
  /** Claim the entry for application; `false` when another caller holds it. */
  claim(key: string, generation: number): boolean;
  /** Return a claimed entry after a failed application. */
  unclaim(key: string, generation: number): void;
  failApplication(key: string, generation: number): void;
  retryApplication(key: string): void;
  /** Drop the entry, optionally only when it is still `generation`. */
  release(key: string, generation?: number): void;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
}

export function createComposerRecoveryStore<
  TEditorValue,
  TReservedInputs,
>(): ComposerRecoveryStore<TEditorValue, TReservedInputs> {
  type Entry = ComposerRecoveryEntry<TEditorValue, TReservedInputs>;
  const entries = new Map<string, Entry>();
  const currentSubmissions = new Map<
    string,
    { generation: number; userEdited: boolean }
  >();
  const listeners = new Set<() => void>();
  let nextGeneration = 1;
  let version = 0;

  const notify = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  const update = (
    key: string,
    generation: number | undefined,
    change: (entry: Entry) => Entry | null,
  ): boolean => {
    const entry = entries.get(key);
    if (!entry) return false;
    if (generation !== undefined && entry.generation !== generation) {
      return false;
    }
    const next = change(entry);
    if (next === entry) return false;
    if (next === null) entries.delete(key);
    else entries.set(key, next);
    notify();
    return true;
  };

  const beginSubmission = (key: string): number => {
    const generation = nextGeneration;
    nextGeneration += 1;
    currentSubmissions.set(key, { generation, userEdited: false });
    if (entries.delete(key)) notify();
    return generation;
  };
  return {
    beginSubmission,
    isCurrentSubmission: (key, generation): boolean =>
      currentSubmissions.get(key)?.generation === generation,
    forget(key): void {
      currentSubmissions.delete(key);
      if (entries.delete(key)) notify();
    },
    record(key, submission, suppliedGeneration): number {
      const generation = suppliedGeneration ?? beginSubmission(key);
      const current = currentSubmissions.get(key);
      if (current?.generation !== generation) return generation;
      entries.set(key, {
        generation,
        submission: structuredClone(submission),
        settlement: 'pending',
        userEdited: current.userEdited,
        abort: null,
        claimed: false,
        applicationFailed: false,
      });
      notify();
      return generation;
    },
    settle(key, generation, settlement): void {
      update(key, generation, (entry) =>
        entry.settlement === 'pending' ? { ...entry, settlement } : entry,
      );
    },
    noteUserInput(key): void {
      // Preparation can yield before the complete outbound snapshot exists.
      // Retain edits on its generation so adding then clearing input still
      // prevents that submission from returning after a later refusal.
      const current = currentSubmissions.get(key);
      if (current) current.userEdited = true;
      update(key, undefined, (entry) =>
        entry.userEdited || !entry.submission.composerCleared
          ? entry
          : { ...entry, userEdited: true },
      );
    },
    recordAbort(key, head): boolean {
      return update(key, undefined, (entry) => {
        if (
          entry.abort !== null ||
          head.lastUserMessageId !== entry.submission.userMessageId
        ) {
          return entry;
        }
        return {
          ...entry,
          abort: {
            userMessageId: head.lastUserMessageId,
            userMessageOrdinal: head.userMessageCount,
          },
        };
      });
    },
    get(key): Entry | undefined {
      return entries.get(key);
    },
    claim(key, generation): boolean {
      return update(key, generation, (entry) =>
        entry.claimed ? entry : { ...entry, claimed: true },
      );
    },
    unclaim(key, generation): void {
      update(key, generation, (entry) =>
        entry.claimed ? { ...entry, claimed: false } : entry,
      );
    },
    failApplication(key, generation): void {
      update(key, generation, (entry) => ({
        ...entry,
        claimed: false,
        applicationFailed: true,
      }));
    },
    retryApplication(key): void {
      update(key, undefined, (entry) =>
        entry.applicationFailed
          ? { ...entry, applicationFailed: false }
          : entry,
      );
    },
    release(key, generation): void {
      update(key, generation, () => null);
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    getVersion(): number {
      return version;
    },
  };
}

/** Apply under one claim; failed mutations are compensated before retaining a retry. */
export function applyComposerRecovery<TEditorValue, TReservedInputs>(
  store: ComposerRecoveryStore<TEditorValue, TReservedInputs>,
  key: string,
  generation: number,
  apply: () => void,
  rollback: () => void,
): boolean {
  if (!store.claim(key, generation)) return false;
  try {
    apply();
    store.release(key, generation);
    return true;
  } catch {
    try {
      rollback();
    } catch {
      // The immutable snapshot remains available even if compensation fails.
    } finally {
      store.failApplication(key, generation);
    }
    return false;
  }
}

/** Shared guard for returning a rejected draft to the still-current composer. */
export function canRestoreComposerDraft(input: {
  submittedTarget: string | undefined;
  currentTarget: string | undefined;
  submittedRevision: number | undefined;
  currentRevision: number;
}): boolean {
  return (
    input.submittedTarget !== undefined &&
    input.submittedTarget === input.currentTarget &&
    input.submittedRevision !== undefined &&
    input.submittedRevision === input.currentRevision
  );
}

/**
 * What a host says once a refused send's draft is back in the composer
 * (CAN-5972, CAN-6364, CAN-6401). The reason is the server's own sentence.
 */
export function composerRefusalNotice(reason?: string): string {
  const trimmed = reason?.trim();
  return trimmed
    ? `Your message wasn't sent: ${trimmed}`
    : "Your message wasn't sent.";
}

/**
 * A chat deleted on another device while its composer held unsent work
 * (CAN-6614). The host keeps the draft and attachments, and offers
 * {@link CHAT_DELETED_ELSEWHERE_ACTION} to carry them into a new chat.
 */
export const CHAT_DELETED_ELSEWHERE_TITLE = 'Chat deleted.';
export const CHAT_DELETED_ELSEWHERE_ACTION = 'Start new chat';

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/**
 * What a deleted chat's composer still holds, after
 * {@link CHAT_DELETED_ELSEWHERE_TITLE}. `attachAgain` names the files the
 * new chat can't take by itself (a paste has no file to read again): all of
 * them asks for "your files", some of them names each.
 */
export function chatDeletedElsewhereNotice(kept: {
  readonly draft: boolean;
  readonly attachments: number;
  readonly attachAgain: readonly string[];
}): string {
  const draft = kept.draft ? 'Your draft is still here. ' : '';
  if (kept.attachAgain.length > 0)
    return kept.attachAgain.length >= kept.attachments
      ? `${draft}Attach your files again in the new chat.`
      : `${draft}Attach ${listOf(kept.attachAgain)} again in the new chat.`;
  const held =
    kept.draft && kept.attachments > 0
      ? ' Your draft and attachments are still here.'
      : kept.draft
        ? ' Your draft is still here.'
        : kept.attachments > 0
          ? ' Your attachments are still here.'
          : '';
  return `It was deleted on another device.${held}`;
}

/**
 * What the new chat says about files it couldn't take from the deleted one
 * (CAN-6614): a pasted file has nothing to read again, and a file on disk
 * may have moved since.
 */
export function chatFilesNotAttachedNotice(names: readonly string[]): string {
  return `Couldn't attach ${listOf(names)} to the new chat. Attach ${
    names.length === 1 ? 'it' : 'them'
  } again.`;
}

/** Explicit host-projected refusal; neither text nor message position grants recovery. */
export function composerRefusedUserMessageId(
  message: PortalChatMessage,
): string | undefined {
  if (message.role !== 'assistant') return undefined;
  for (const part of message.parts ?? []) {
    if (
      part.kind !== 'text' ||
      typeof part.data !== 'object' ||
      part.data === null ||
      !('composerRefusal' in part.data)
    )
      continue;
    const refusal = part.data.composerRefusal;
    if (
      typeof refusal !== 'object' ||
      refusal === null ||
      !('code' in refusal) ||
      !('userMessageId' in refusal)
    )
      continue;
    if (
      refusal.code === 'no_billing_source' &&
      typeof refusal.userMessageId === 'string'
    )
      return refusal.userMessageId;
  }
  return undefined;
}

export function composerRecoveryPortalTranscript(
  messages: readonly PortalChatMessage[],
): ComposerRecoveryTranscriptMessage[] {
  return messages.map((message) => {
    const refusal = composerRefusedUserMessageId(message);
    let errorText = message.errorMessage;
    if (refusal !== undefined) {
      for (const part of message.parts ?? []) {
        if (
          typeof part.data === 'object' &&
          part.data !== null &&
          'composerRefusal' in part.data &&
          'errorText' in part.data &&
          typeof part.data.errorText === 'string'
        )
          errorText = part.data.errorText;
      }
    }
    return {
      id: message.messageId,
      isUser: message.role === 'user',
      hasAgentActivity:
        (message.role === 'assistant' &&
          message.text.trim().length > 0 &&
          (refusal === undefined || message.text !== errorText)) ||
        (message.role !== 'user' &&
          (message.parts ?? []).some((part) =>
            ['tool_use', 'tool_result', 'thinking', 'image', 'agent'].includes(
              part.kind,
            ),
          )),
    };
  });
}
