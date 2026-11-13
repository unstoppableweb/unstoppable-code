/**
 * Host port for the Memory panel: the personal memories agents save on this
 * computer, in a user scope (every project) and a workspace scope (one
 * project). The desktop host implements it over its local memory IPC; the
 * web host serves the account's synced memory from the Cloud (CAN-5193). A
 * host with neither does not mount the panel.
 *
 * This is the Memory feature's host adapter boundary, a feature port like
 * `SettingsHostPorts` rather than `CanopyClient` methods: only a host that
 * owns a local memory store can serve it, so mounting the panel is the
 * capability gate, and no `CanopyClient` host has to stub operations it
 * cannot serve. Transport differences stay in each host's implementation;
 * the shared panel never branches on the host.
 *
 * Shapes mirror the desktop local memory contract structurally, so the
 * desktop adapter passes its results through unchanged.
 */

export type LocalMemoryScope =
  | { readonly scope: 'user' }
  | { readonly scope: 'workspace'; readonly workspaceId: string };

export interface LocalMemoryFile {
  readonly fileKey: string;
  readonly kind: 'index' | 'topic' | 'inbox';
  readonly modifiedAt: string;
  readonly sizeBytes: number;
  readonly title?: string;
  readonly excerpt?: string;
  readonly source?: { readonly provider: string; readonly chatId: string };
  /** Absent while usage tracking is unknown for the scope. */
  readonly usageCount?: number;
  /** The computer a synced note was saved on. */
  readonly deviceLabel?: string;
}

export interface LocalMemoryDocumentItem {
  readonly id: string;
  readonly kind: 'heading' | 'list-item' | 'paragraph' | 'code' | 'block';
  readonly text: string;
  readonly level?: number;
  readonly children: readonly LocalMemoryDocumentItem[];
}

export interface LocalMemoryFileDocument {
  readonly fileKey: string;
  readonly revision: string;
  readonly items: readonly LocalMemoryDocumentItem[];
  /** The Markdown after the front matter, exactly as the file has it. */
  readonly markdown?: string;
}

export interface LocalMemoryStatus {
  readonly pendingNotes: number;
  readonly running: boolean;
  readonly rebuilding: boolean;
  readonly lastRunAt: string | null;
  readonly lastResult: 'success' | 'skipped' | 'failed' | 'cancelled' | null;
  readonly lastReason: string | null;
  readonly lastConsolidatedAt: string | null;
}

export interface LocalMemoryRebuildOutcome {
  readonly rebuild: {
    readonly status: 'completed' | 'stopped' | 'failed' | 'skipped';
    readonly reason?: string;
  };
  readonly status: LocalMemoryStatus;
}

/** A chat a memory came from, as the host can show and open it. */
export interface LocalMemoryChatRef {
  readonly title: string;
}

export interface LocalMemoryClient {
  list(scope: LocalMemoryScope): Promise<readonly LocalMemoryFile[]>;
  read(
    scope: LocalMemoryScope,
    fileKey: string,
  ): Promise<LocalMemoryFileDocument>;
  /** Rejects when the file changed since `revision`. */
  updateFile(
    scope: LocalMemoryScope,
    request: {
      readonly fileKey: string;
      readonly revision: string;
      readonly title?: string;
      readonly body: string;
    },
  ): Promise<LocalMemoryFileDocument>;
  /** Rejects when the file changed since `revision`. */
  deleteFile(
    scope: LocalMemoryScope,
    request: { readonly fileKey: string; readonly revision: string },
  ): Promise<void>;
  status(scope: LocalMemoryScope): Promise<LocalMemoryStatus>;
  /**
   * Consolidates the scope's waiting notes now. A host that cannot run
   * consolidation (the web, which shows synced memory) leaves it out, and the
   * panel offers no "Consolidate now".
   */
  consolidate?(scope: LocalMemoryScope): Promise<LocalMemoryStatus>;
  /** Rebuilds the scope's memory; absent where consolidation is. */
  rebuild?(scope: LocalMemoryScope): Promise<LocalMemoryRebuildOutcome>;
  /** Watches the scope for outside changes; returns the stop function. */
  watch(scope: LocalMemoryScope, onChange: () => void): () => void;
  /** Titles of the chats with these ids that the host still knows. */
  lookupChats(
    chatIds: readonly string[],
  ): Promise<ReadonlyMap<string, LocalMemoryChatRef>>;
  /**
   * Calls `onChange` when the host's chat list changes, so chat titles are
   * looked up again; returns the stop function.
   */
  watchChats(onChange: () => void): () => void;
  /** Opens a chat; resolves with a message when it can't. */
  openChat(
    chatId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  openSettings(): void;
  /** Opens a web link from a memory, the way other content links open. */
  openLink(url: string): void;
  /**
   * Memory sync across the account's computers, when the host offers it.
   * Absent hosts show no sync controls.
   */
  readonly sync?: LocalMemorySyncClient;
}

/*
 * Memory sync (CAN-5188, design docs/planning/2026-10-27-cloud-memory-sync
 * §14, §17), mirroring the desktop memory sync contract. Failures are codes
 * the shared UI explains.
 */

export type LocalMemorySyncAvailability =
  | 'signed_out'
  | 'not_offered'
  | 'available';

export type LocalMemorySyncConnection =
  | 'starting'
  | 'running'
  | 'standby'
  | 'paused'
  | 'unavailable'
  | 'update_required'
  | 'stopped';

export type LocalMemorySyncMode = 'sync' | 'device_only';

export interface LocalMemorySyncSettings {
  readonly enabled: boolean;
  readonly userScope: LocalMemorySyncMode;
  readonly defaultProjectScope: LocalMemorySyncMode;
  readonly serverConsolidation: 'allowed' | 'disallowed';
  readonly serverConsolidationAvailable: boolean;
}

export type LocalMemorySyncSettingsPatch = {
  readonly enabled?: boolean;
  readonly userScope?: LocalMemorySyncMode;
  readonly defaultProjectScope?: LocalMemorySyncMode;
  readonly serverConsolidation?: 'allowed' | 'disallowed';
};

export type LocalMemorySyncScopeState =
  | 'syncing'
  | 'paused'
  | 'device_only'
  | 'repair_needed'
  | 'deleted_in_cloud'
  | 'needs_first_enable'
  | 'merging'
  | 'not_started';

export interface LocalMemorySyncUserScope {
  readonly state: LocalMemorySyncScopeState;
  readonly lastSyncedAt: string | null;
  readonly waitingToSend: number;
  readonly keptOnDevice: number;
  /** Conflicts, each resolved on its own (see {@link LocalMemorySyncConflict}). */
  readonly conflicts: readonly LocalMemorySyncConflictSummary[];
  readonly preMergeRevision: number | null;
  readonly problem: string | null;
}

/**
 * One project's memory on this computer, for a project linked to a cloud
 * project of the signed-in account. The project is named by its workspace;
 * the host resolves it to the cloud project the link names now.
 */
export interface LocalMemorySyncProjectMemory {
  readonly workspaceId: string;
  /**
   * The account's choice for the project, which every computer honors;
   * null while this computer has not read it.
   */
  readonly mode: LocalMemorySyncMode | null;
  /** What this project's memory does on this computer now. */
  readonly state: 'sync' | 'device_only' | 'stopped';
  /** Why it is not syncing, when it is not. */
  readonly reason:
    | 'private_memory'
    | 'detached'
    | 'moved'
    | 'kept_on_device'
    | null;
  /** False while the project's Private memory decides. */
  readonly changeable: boolean;
  /** This computer holds memories for it the cloud has not merged yet. */
  readonly needsFirstEnable: boolean;
}

export interface LocalMemorySyncState {
  readonly availability: LocalMemorySyncAvailability;
  readonly connection: LocalMemorySyncConnection | null;
  readonly settings: LocalMemorySyncSettings | null;
  readonly user: LocalMemorySyncUserScope | null;
  /** Linked projects' memory; empty while sync is off or signed out. */
  readonly projects: readonly LocalMemorySyncProjectMemory[];
  readonly deviceLabel: string | null;
}

export type LocalMemorySyncControlResult =
  | {
      readonly ok: true;
      readonly state: LocalMemorySyncState;
      /**
       * Memories the cloud refused, which stay on this computer only. Set
       * by the first-enable apply, so it never reports a plain success for
       * memories it left behind.
       */
      readonly refusedNotes?: number;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly state: LocalMemorySyncState;
    };

export interface LocalMemorySyncDocument {
  readonly path: string;
  readonly content: string;
}

export interface LocalMemorySyncMergePreview {
  readonly previewId: string;
  /**
   * `upload`: the cloud is empty and this computer's memory goes up as is.
   * `keep`: nothing of this computer's is left to merge, so the memory in
   * the cloud is kept as it is and this computer starts syncing with it.
   */
  readonly kind: 'upload' | 'merge' | 'keep';
  readonly cloud: readonly LocalMemorySyncDocument[];
  readonly device: readonly LocalMemorySyncDocument[];
  readonly result: readonly LocalMemorySyncDocument[];
  readonly deviceNotes: number;
  /**
   * Notes that stay on this computer: those an organization keeps off the
   * cloud, and those the cloud refused on an earlier try.
   */
  readonly keptOnDevice: number;
  readonly skipped: number;
  /** Memories that are not plain text, part of {@link skipped}. */
  readonly skippedNotText: number;
  /**
   * Memories too large to sync as they are, which go to the cloud as notes
   * for the next consolidation to fold in. Not part of {@link skipped}.
   */
  readonly tooLargeAsNotes: number;
}

export type LocalMemorySyncPreviewResult =
  | { readonly ok: true; readonly preview: LocalMemorySyncMergePreview }
  | { readonly ok: false; readonly code: string };

/**
 * Why two versions were not merged line by line: the same lines edited in
 * two places (or edited and deleted), or too large or complex to merge.
 */
export type LocalMemorySyncConflictReason =
  | 'overlap'
  | 'too_costly'
  | 'too_large';

export interface LocalMemorySyncConflictSummary {
  readonly path: string;
  readonly detectedAt: string;
  readonly reason: LocalMemorySyncConflictReason;
  /** This computer's side is queued for the next consolidation. */
  readonly merged: boolean;
}

/**
 * A memory changed on two computers at once. It resolves itself: every
 * computer keeps the version that reached the cloud first and this one's
 * goes to the next consolidation, so nothing waits on the person.
 */
/**
 * A version of a memory a conflict names: its text, nothing because it was
 * deleted, or bytes that are not plain text, whose content nothing can show
 * or sync.
 */
export type LocalMemorySyncConflictVersion =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'not_text' };

export interface LocalMemorySyncConflict extends LocalMemorySyncConflictSummary {
  readonly cloud: LocalMemorySyncConflictVersion;
  readonly mine: LocalMemorySyncConflictVersion;
}

export interface LocalMemorySyncRevision {
  readonly revision: number;
  readonly kind:
    | 'consolidation'
    | 'manual_edit'
    | 'import'
    | 'merge'
    | 'restore'
    | 'migration';
  readonly committedAt: string;
  /** A computer by the name its person gave it, the cloud or the web. */
  readonly author:
    | { readonly kind: 'computer'; readonly name: string }
    | { readonly kind: 'cloud' }
    | { readonly kind: 'web' };
  readonly changedDocuments: number;
  readonly consumedNotes: number;
  readonly restoredFromRevision: number | null;
}

export type LocalMemorySyncHistoryResult =
  | {
      readonly ok: true;
      readonly revisions: readonly LocalMemorySyncRevision[];
      readonly nextBefore: number | null;
      readonly currentRevision: number;
    }
  | { readonly ok: false; readonly code: string };

export interface LocalMemorySyncClient {
  state(): Promise<LocalMemorySyncState>;
  /** Calls `onChange` with each new state; returns the stop function. */
  watch(onChange: (state: LocalMemorySyncState) => void): () => void;
  updateSettings(
    patch: LocalMemorySyncSettingsPatch,
  ): Promise<LocalMemorySyncControlResult>;
  /**
   * The first-enable review: changes nothing. `workspaceId` reviews the
   * cloud project that workspace is linked to, instead of the memories
   * saved for every project.
   */
  previewMerge(workspaceId?: string): Promise<LocalMemorySyncPreviewResult>;
  applyMerge(
    previewId: string,
    workspaceId?: string,
  ): Promise<LocalMemorySyncControlResult>;
  /**
   * Keeps a linked project's memories on this computer, or syncs them: the
   * account's choice, which every computer honors. Optional, so a host
   * without project memory leaves it out.
   */
  setProjectMemory?(
    workspaceId: string,
    keepOnThisComputer: boolean,
  ): Promise<LocalMemorySyncControlResult>;
  readConflict(path: string): Promise<LocalMemorySyncConflict | null>;
  /**
   * Optional follow-up on a resolved conflict: `restore` puts this
   * computer's version back as an edit, `dismiss` hides the entry.
   */
  settleConflict(
    path: string,
    action: 'restore' | 'dismiss',
  ): Promise<LocalMemorySyncControlResult>;
  history(before: number | null): Promise<LocalMemorySyncHistoryResult>;
  restore(revision: number): Promise<LocalMemorySyncControlResult>;
  /** Deletes the account's memory from the cloud and turns sync off. */
  deleteFromCloud(): Promise<LocalMemorySyncControlResult>;
}

/** A brief notice the host shows; `action` adds a button such as Undo. */
export interface LocalMemoryNotice {
  readonly message: string;
  readonly tone?: 'success' | 'error';
  readonly action?: { readonly label: string; readonly run: () => void };
}

export type LocalMemoryNotify = (notice: LocalMemoryNotice) => void;
