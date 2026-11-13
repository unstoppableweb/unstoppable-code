import type {
  LocalMemorySyncConflictSummary,
  LocalMemorySyncProjectMemory,
  LocalMemorySyncRevision,
  LocalMemorySyncState,
} from '@canopy/app-core/local-memory';
import { formatRelativeTime } from '@canopy/ui-shared/lib';

/*
 * The words memory sync uses, in one place: the Memory panel's status line,
 * the settings section, the merge review and the history view. A control's
 * failure arrives as a code and is explained here; server text is never
 * shown.
 */

/**
 * Private memory already decides where a project's memories live, so the
 * sync switch neither moves nor contradicts it. Said the same way as a
 * refusal and as the switch's note.
 */
const PRIVATE_MEMORY_KEEPS_HERE =
  "Private memory keeps this project's memories on this computer.";

const CONTROL_FAILURES: Readonly<Record<string, string>> = {
  offline: "Couldn't reach the cloud. Check your connection and try again.",
  not_running:
    'Memory sync is starting on this computer. Try again in a moment.',
  sync_off: 'Turn on memory sync first.',
  update_required: 'Update the app to keep syncing memories.',
  changed: 'Memories changed while you were reviewing. Review the merge again.',
  nothing_to_merge: 'This computer has no memories to merge.',
  merge_failed: "Couldn't merge your memories. Try again.",
  model_unavailable:
    "Your memory model isn't available, so memories can't be merged now.",
  memory_off: 'Turn on local memory to merge memories.',
  memory_lease_held:
    'Another computer is updating your memories. Try again in a minute.',
  not_found: 'That conflict was already resolved.',
  not_synced: "This computer's memories aren't synced yet.",
  memory_busy:
    'Memories are being updated on this computer. Try again in a moment.',
  // The project memory switch and a project's own merge review: the project
  // is named by its own settings, so these say what stands in the way.
  not_bound: "This project isn't linked to a project in the cloud.",
  private_memory: PRIVATE_MEMORY_KEEPS_HERE,
  not_syncing: "This project's memories aren't syncing on this computer.",
  sync_disabled: 'Turn on memory sync first.',
  off: 'Memory sync is starting on this computer. Try again in a moment.',
  failed: "Couldn't change where this project's memories are kept.",
};

const SYNC_PROBLEMS: Readonly<Record<string, string>> = {
  document_secret:
    "A memory looks like it holds a secret, so it isn't synced. Remove the secret to sync it.",
  memory_secret_detected:
    "A memory looks like it holds a secret, so it isn't synced. Remove the secret to sync it.",
  document_too_large: 'A memory is too large to sync. Shorten it to sync it.',
  memory_request_too_large:
    "A change is too large to sync. It's kept on this computer.",
  document_topic_limit:
    "A new topic isn't synced because there are already as many topics as sync allows.",
  document_name: "A memory's file name can't be synced. Rename it to sync it.",
  document_not_text:
    "A memory isn't plain text, so it isn't synced. Save it as UTF-8 text to sync it.",
  memory_quota_exceeded:
    "Your cloud memory is full, so new changes aren't synced. They're kept on this computer.",
  memory_origin_blocked:
    'Your organization keeps some memories on this computer only.',
  memory_local_edit_unsettled:
    "A change to a memory couldn't be finished on this computer. It's kept here until it can be.",
};

/**
 * The switch's own label, which says what it does on this computer. The
 * feature's internal name is "keep memory on this device"; every visible
 * string in memory sync says "computer", so this one does too.
 */
export const MEMORY_PROJECT_KEEP_LABEL = 'Keep memories on this computer';

/**
 * What else a person needs to know about a project's memories beside the
 * switch, or null when the switch alone says it: why the choice is not
 * theirs to make, why the memories are not syncing anyway, and when this
 * computer still holds memories the cloud has not merged.
 */
export function memoryProjectMemoryNote(
  memory: LocalMemorySyncProjectMemory,
): string | null {
  switch (memory.reason) {
    case 'private_memory':
      return PRIVATE_MEMORY_KEEPS_HERE;
    case 'detached':
      return "This project isn't linked to a project in the cloud any more, so its memories stay on this computer.";
    case 'moved':
      return 'This project moved to an organization, so its memories stay on this computer.';
    default:
      break;
  }
  if (memory.mode === null) return 'Starting sync…';
  if (memory.needsFirstEnable) {
    return "This computer's memories for this project aren't synced yet.";
  }
  return null;
}

/**
 * Why the last sync left a change behind, or null for a code with nothing
 * to tell the person. Any other refusal reads as a general sentence.
 */
export function memorySyncProblemText(code: string | null): string | null {
  if (code === null || code === 'offline') return null;
  return (
    SYNC_PROBLEMS[code] ??
    "Some changes couldn't be synced. They're kept on this computer."
  );
}

/** A control failure as one sentence. */
export function memorySyncFailureText(code: string): string {
  return CONTROL_FAILURES[code] ?? "Couldn't update memory sync. Try again.";
}

export interface MemorySyncStatusLine {
  readonly text: string;
  readonly tone: 'quiet' | 'attention' | 'problem';
}

/**
 * The Memory panel's sync line, or null when the account doesn't sync: a
 * person who never turned sync on sees nothing new.
 */
export function memorySyncStatusLine(
  state: LocalMemorySyncState | null,
): MemorySyncStatusLine | null {
  if (state?.availability !== 'available' || !state.settings?.enabled) {
    return null;
  }
  const user = state.user;
  if (user === null) return { text: 'Starting sync…', tone: 'quiet' };
  if (state.connection === 'update_required') {
    return { text: 'Update the app to keep syncing.', tone: 'problem' };
  }
  switch (user.state) {
    case 'needs_first_enable':
    case 'merging':
      return {
        text: "This computer's memories aren't synced yet.",
        tone: 'attention',
      };
    case 'device_only':
      return { text: 'Kept on this computer only.', tone: 'quiet' };
    case 'deleted_in_cloud':
      return {
        text: 'Deleted from the cloud. This computer keeps its copy.',
        tone: 'quiet',
      };
    case 'paused':
      return { text: 'Sync is paused.', tone: 'quiet' };
    case 'not_started':
      return { text: 'Starting sync…', tone: 'quiet' };
    default:
      break;
  }
  if (user.problem === 'offline' || state.connection === 'unavailable') {
    return {
      text: "Can't reach the cloud. Changes are saved here until it's back.",
      tone: 'attention',
    };
  }
  const problem = memorySyncProblemText(user.problem);
  if (problem !== null) return { text: problem, tone: 'attention' };
  if (user.waitingToSend > 0) {
    return { text: 'Syncing…', tone: 'quiet' };
  }
  if (user.lastSyncedAt === null) return { text: 'Syncing…', tone: 'quiet' };
  const syncedMs = Date.parse(user.lastSyncedAt);
  return {
    text:
      Date.now() - syncedMs < 60_000
        ? 'Synced just now'
        : `Synced ${formatRelativeTime(user.lastSyncedAt)}`,
    tone: 'quiet',
  };
}

/** What a history entry did, as the history list says it. */
export function memoryRevisionLabel(revision: LocalMemorySyncRevision): string {
  switch (revision.kind) {
    case 'consolidation':
      return 'Consolidated';
    case 'manual_edit':
      return 'Edited';
    case 'import':
      return 'Uploaded';
    case 'merge':
      return 'Merged';
    case 'restore':
      return revision.restoredFromRevision === null
        ? 'Restored'
        : `Restored version ${revision.restoredFromRevision}`;
    case 'migration':
      return 'Moved';
  }
}

/**
 * Who made a history entry, and whether that is a name a person gave their
 * computer (masked in session replay).
 */
export function memoryRevisionAuthor(revision: LocalMemorySyncRevision): {
  readonly text: string;
  readonly personal: boolean;
} {
  switch (revision.author.kind) {
    case 'computer':
      return { text: revision.author.name, personal: true };
    case 'cloud':
      return { text: 'The cloud', personal: false };
    case 'web':
      return { text: 'The web', personal: false };
  }
}

/** The status line's link to the merged edits, by how many there are. */
export function memoryMergedEditsLabel(count: number): string {
  return count === 1
    ? '1 edit merged automatically'
    : `${count} edits merged automatically`;
}

/**
 * Why an edit was merged automatically, and what happens to it. Conflicts
 * from earlier builds read as `overlap`.
 */
export function memoryConflictReasonText(
  conflict: Pick<LocalMemorySyncConflictSummary, 'reason' | 'merged'>,
): string {
  const why =
    conflict.reason === 'overlap'
      ? 'This memory was edited in two places at once.'
      : 'This memory was too large or complex to merge line by line.';
  const next = conflict.merged
    ? 'Your edit was added as a note, and the next consolidation folds it in.'
    : 'Your edit is added as a note on the next sync, and the next consolidation folds it in.';
  return `${why} Your computers use the version that synced first. ${next}`;
}

/** A title for a document path: its file name without `.md`. */
export function memoryDocumentTitle(path: string): string {
  if (path === 'MEMORY.md') return 'Memory index';
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return name.replace(/[-_]+/g, ' ').trim() || name;
}
