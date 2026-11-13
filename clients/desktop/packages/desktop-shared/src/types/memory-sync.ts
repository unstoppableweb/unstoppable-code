/**
 * The desktop's memory sync controls as the renderer sees them (design
 * docs/planning/2026-10-27-cloud-memory-sync §14, §17): whether sync is
 * offered, the account's settings, the user scope's state, the first-enable
 * review, conflicts and history. Failures are codes the shared UI explains,
 * never server text.
 */

/** Whether this computer can offer memory sync to the signed-in account. */
export type MemorySyncAvailability =
  /** No Canopy Cloud account, or a guest. */
  | 'signed_out'
  /** The account is not offered memory sync yet. */
  | 'not_offered'
  | 'available';

export type MemorySyncConnection =
  | 'starting'
  | 'running'
  /** Another copy of the app on this computer syncs for the account. */
  | 'standby'
  /** Sync is off for the account. */
  | 'paused'
  /** Canopy Cloud does not answer memory sync yet. */
  | 'unavailable'
  | 'update_required'
  | 'stopped';

export type MemorySyncMode = 'sync' | 'device_only';

export interface MemorySyncSettingsView {
  enabled: boolean;
  userScope: MemorySyncMode;
  defaultProjectScope: MemorySyncMode;
  serverConsolidation: 'allowed' | 'disallowed';
  /** Whether Canopy Cloud may consolidate for this account at all. */
  serverConsolidationAvailable: boolean;
}

export type MemorySyncSettingsPatch = Partial<
  Pick<
    MemorySyncSettingsView,
    'enabled' | 'userScope' | 'defaultProjectScope' | 'serverConsolidation'
  >
>;

export type MemorySyncScopeState =
  | 'syncing'
  | 'paused'
  | 'device_only'
  | 'repair_needed'
  | 'deleted_in_cloud'
  /** This computer holds memory the cloud does not have yet. */
  | 'needs_first_enable'
  /** A first enable started and has not finished. */
  | 'merging'
  /** Nothing to sync yet. */
  | 'not_started';

/**
 * Why two versions of a memory were not merged line by line: `overlap`, the
 * same lines edited in two places (or edited in one and deleted in the
 * other); `too_costly` and `too_large`, too large or complex to merge.
 */
export type MemorySyncConflictReason = 'overlap' | 'too_costly' | 'too_large';

/** A conflict, which resolves itself: see {@link MemorySyncConflict}. */
export interface MemorySyncConflictSummary {
  path: string;
  detectedAt: string;
  reason: MemorySyncConflictReason;
  /** This computer's side is queued for the next consolidation. */
  merged: boolean;
}

export interface MemorySyncUserScope {
  state: MemorySyncScopeState;
  lastSyncedAt: string | null;
  /** Notes and edits saved here and not sent yet. */
  waitingToSend: number;
  /** Notes kept on this computer only (organization policy, refusals). */
  keptOnDevice: number;
  conflicts: MemorySyncConflictSummary[];
  /** The revision from before this computer's memories were merged in. */
  preMergeRevision: number | null;
  /** The last failure, as a code, while it lasts. */
  problem: string | null;
}

/**
 * One project's memory on this computer, for a project bound to a cloud
 * project of the signed-in account (design §22). A project is named by its
 * workspace; this computer resolves it to the cloud project its binding
 * names now, so the renderer never holds a cloud project ID.
 */
export interface MemorySyncProjectMemory {
  workspaceId: string;
  /**
   * The account's choice for the project, which every computer honors, or
   * its default for projects; null while this computer has not read it.
   */
  mode: MemorySyncMode | null;
  /** What this project's memory does on this computer now. */
  state: 'sync' | 'device_only' | 'stopped';
  /** Why it is not syncing, when it is not. */
  reason: 'private_memory' | 'detached' | 'moved' | 'kept_on_device' | null;
  /** False while the project's Private memory decides. */
  changeable: boolean;
  /** This computer holds memories for it the cloud has not merged yet. */
  needsFirstEnable: boolean;
}

export interface MemorySyncState {
  availability: MemorySyncAvailability;
  connection: MemorySyncConnection | null;
  settings: MemorySyncSettingsView | null;
  user: MemorySyncUserScope | null;
  /** Bound projects' memory; empty while sync is off or signed out. */
  projects: MemorySyncProjectMemory[];
  /** This computer's name, as the notes it saves record it. */
  deviceLabel: string | null;
}

export type MemorySyncControlResult =
  | {
      ok: true;
      state: MemorySyncState;
      /**
       * Memories the cloud refused, which stay on this computer only. Set
       * by the first-enable apply, so it never reports a plain success for
       * memories it left behind.
       */
      refusedNotes?: number;
    }
  | { ok: false; code: string; state: MemorySyncState };

export interface MemorySyncDocument {
  path: string;
  content: string;
}

export interface MemorySyncMergePreview {
  previewId: string;
  /**
   * `upload`: the cloud is empty and this computer's memory goes up as is.
   * `keep`: nothing of this computer's is left to merge, so the memory in
   * the cloud is kept as it is and this computer starts syncing with it.
   */
  kind: 'upload' | 'merge' | 'keep';
  cloud: MemorySyncDocument[];
  device: MemorySyncDocument[];
  result: MemorySyncDocument[];
  /** Notes this computer sends. */
  deviceNotes: number;
  /**
   * Notes that stay on this computer: those an organization keeps off the
   * cloud, and those the cloud refused on an earlier try.
   */
  keptOnDevice: number;
  /** Memories that cannot be sent (too large, unreadable). */
  skipped: number;
  /** Memories that are not plain text, part of {@link skipped}. */
  skippedNotText: number;
  /**
   * Memories too large to sync as they are, which go to the cloud as notes
   * for the next consolidation to fold in. Not part of {@link skipped}.
   */
  tooLargeAsNotes: number;
}

export type MemorySyncPreviewResult =
  | { ok: true; preview: MemorySyncMergePreview }
  | { ok: false; code: string };

/**
 * A memory changed on this computer and another one at once. It resolves
 * itself: every computer keeps the version that reached the cloud first,
 * and this computer's version goes to the next consolidation as notes, so
 * nothing waits on the person. The kept copy can be restored.
 */
/**
 * A version of a memory a conflict names: its text, nothing because it was
 * deleted, or bytes that are not plain text, whose content nothing can show
 * or sync.
 */
export type MemorySyncConflictVersion =
  | { kind: 'text'; text: string }
  | { kind: 'deleted' }
  | { kind: 'not_text' };

export interface MemorySyncConflict {
  path: string;
  detectedAt: string;
  reason: MemorySyncConflictReason;
  merged: boolean;
  /** The version every device uses now. */
  cloud: MemorySyncConflictVersion;
  /** This computer's version. */
  mine: MemorySyncConflictVersion;
}

/** `restore` puts this computer's version back; `dismiss` hides the entry. */
export type MemorySyncConflictAction = 'restore' | 'dismiss';

export type MemorySyncRevisionKind =
  | 'consolidation'
  | 'manual_edit'
  | 'import'
  | 'merge'
  | 'restore'
  | 'migration';

/**
 * Who made a revision: a computer by the name its person gave it, the
 * cloud's consolidation, or the web.
 */
export type MemorySyncAuthor =
  | { kind: 'computer'; name: string }
  | { kind: 'cloud' }
  | { kind: 'web' };

export interface MemorySyncRevision {
  revision: number;
  kind: MemorySyncRevisionKind;
  committedAt: string;
  author: MemorySyncAuthor;
  changedDocuments: number;
  consumedNotes: number;
  restoredFromRevision: number | null;
}

export type MemorySyncHistoryResult =
  | {
      ok: true;
      revisions: MemorySyncRevision[];
      nextBefore: number | null;
      /** The revision this computer has applied. */
      currentRevision: number;
    }
  | { ok: false; code: string };
