import { create, type StateCreator } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import type {
  PortalDiffPayload,
  PortalDiffReadPayload,
  PortalFilePreview,
  PortalFileReadPayload,
} from '@canopy/protocol/portal';
import { isFileSaveConflictError } from '@canopy/app-core';
import { useCanopyClientStore } from '../CanopyClientProvider';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../client-store-lifecycle';
import {
  createAgentFileEditTracker,
  editPathMatchesRelativePath,
  normalizeEditPath,
  type AgentFileEdit,
  type AgentFileEditTracker,
} from './agent-file-edits';
import { mergeInputSkipReason, threeWayMerge } from './three-way-merge';
import {
  analyzeThreeWay,
  resolveOverlaps,
  type OverlapChoice,
  type OverlapRegion,
} from './three-way-conflicts';

/** Neutral view mode; the concrete renderer maps preview/table to the file kind. */
export type FileViewMode = 'raw' | 'preview' | 'table';

/** Async lifecycle of a file or diff read/save. */
export type FileViewerStatus = 'idle' | 'loading' | 'saving' | 'error';

/** One open file, keyed by {@link fileViewerKey}. */
export interface FileViewerSession {
  readonly key: string;
  /** Session incarnation. Absent on an initial/legacy snapshot means zero. */
  readonly generation?: number;
  /** The read request that identifies this file (routing + relative path). */
  readonly request: PortalFileReadPayload;
  /** Last server-confirmed content/version; `null` until the first read lands. */
  readonly preview: PortalFilePreview | null;
  /** Current (possibly edited) buffer contents. */
  readonly content: string;
  /** True when `content` differs from the last confirmed `preview.content`. */
  readonly dirty: boolean;
  readonly viewMode: FileViewMode;
  readonly status: FileViewerStatus;
  readonly error: string | null;
  /** Capability resolved for this session's project at open time. */
  readonly canEdit: boolean;
  /**
   * Set when the file changed on disk while the buffer had unsaved edits.
   * The buffer and its save baseline stay untouched until the user chooses.
   */
  readonly externalChange?: FileExternalChange | null;
  /**
   * True once disk is known to differ from the save baseline, whether or not
   * the notice is still visible. Only an accepted read or a successful save
   * that establishes a new baseline clears it, so Discard and undo know to
   * load the disk version. Absent means false.
   */
  readonly baselineStale?: boolean;
  /**
   * Increments each time a background or explicit read replaces the
   * confirmed content with different content. Initial loads and identical
   * reads leave it unchanged, so hosts can announce real reloads only.
   */
  readonly reloadRevision?: number;
  /**
   * Local edit/discard/reload generation. Feedback can observe intent even
   * when intermediate dirty or reloading states batch into one render.
   */
  readonly bufferRevision?: number;
  /**
   * Set when a save was refused because the document changed after editing
   * began and the changes could not be combined automatically. The buffer
   * and its baseline stay untouched until the user picks a recovery action.
   */
  readonly saveConflict?: FileSaveConflict | null;
  /** The last save that combined the user's edits with a newer version. */
  readonly savedMerge?: FileSavedMerge | null;
  /**
   * A newer disk version the next save would combine with the unsaved
   * buffer. Display state only: the save still detects the stale baseline
   * and merges or stops at the conflict notice. Absent means none.
   */
  readonly combinableChange?: FileCombinableChange | null;
  /**
   * The passages the buffer and a newer complete version both changed,
   * awaiting a choice for each. Present only alongside the
   * {@link externalChange} or {@link saveConflict} it explains.
   */
  readonly overlap?: FileOverlapComparison | null;
  /**
   * Increments when a passage choice settles a comparison with a mix of both
   * versions, so hosts can announce it. Settling to exactly the newer
   * version advances {@link reloadRevision} instead.
   */
  readonly overlapResolvedRevision?: number;
}

/**
 * One comparison of overlapping passages, bound to the exact snapshot it
 * analyzed: the save baseline, the buffer, and the newer version. Choices
 * apply only while all three are unchanged and only with this `token`.
 */
export interface FileOverlapComparison {
  /** Session incarnation, so hosts reset presentation identity after reopen. */
  readonly generation: number;
  /** Identifies this analysis; a choice presenting another token is ignored. */
  readonly token: string;
  /** The save baseline the buffer was edited from (the session's preview). */
  readonly base: PortalFilePreview;
  /** The buffer analyzed. */
  readonly ours: string;
  /** The exact complete newer version compared. */
  readonly latest: PortalFilePreview;
  readonly regions: readonly OverlapRegion[];
  /** One entry per region; `null` until that passage is chosen. */
  readonly choices: readonly (OverlapChoice | null)[];
}

/** A disk change detected while a session had unsaved edits. */
export interface FileExternalChange {
  /** True while Show latest is reading the disk version. */
  readonly reloading: boolean;
  /** Recoverable failure from the last Show latest attempt. */
  readonly error: string | null;
  /** Who made the change, when a reported write identifies it. */
  readonly source?: FileChangeSource | null;
}

/**
 * What invalidated a session. `unknown` re-checks disk without attributing
 * the version it finds.
 */
export type FileChangeSource = 'agent-edit' | 'unknown';

/** Which entry point started a save. Autosave never moves focus. */
export type FileSaveOrigin = 'user' | 'autosave';

/**
 * Why a save stopped at the conflict notice: overlapping changes, a merge
 * that was not attempted (size, binary, incomplete content), an unreadable
 * latest version, a version that changed again during recovery, or newer
 * typing that arrived while recovery was in flight.
 */
export type FileSaveConflictReason =
  | 'overlap'
  | 'merge-skipped'
  | 'read-unavailable'
  | 'changed-again'
  | 'newer-edits';

/** Pending save-conflict recovery for one session. */
export interface FileSaveConflict {
  readonly reason: FileSaveConflictReason;
  /** Who made the newer version, when it is a known attributed version. */
  readonly source: FileChangeSource | null;
  readonly origin: FileSaveOrigin;
  /**
   * The complete newer version this notice represents. Save my version
   * replaces exactly this version; `null` until one has been read.
   */
  readonly latest: PortalFilePreview | null;
  /** The recovery action in flight, if any. */
  readonly resolving: 'overwrite' | 'reload' | null;
  /** Recoverable failure from the last recovery action. */
  readonly error: FileSaveConflictActionError | null;
  /** Increments for each explicit user save request that reached the notice. */
  readonly focusRequest: number;
}

/** A recovery action failure, mapped to copy by the host UI. */
export type FileSaveConflictActionError =
  | { readonly kind: 'latest-unavailable' }
  | { readonly kind: 'save-failed'; readonly message: string };

/** A completed save that combined the user's edits with a newer version. */
export interface FileSavedMerge {
  readonly revision: number;
  readonly source: FileChangeSource | null;
}

/** A newer version detected while editing that Save would combine. */
export interface FileCombinableChange {
  /** Who made the version, when a reported write identifies it. */
  readonly source: FileChangeSource | null;
  readonly version: string;
}

/** Options for {@link FileViewerState.saveFile}. */
export interface FileSaveOptions {
  /** Defaults to `user`. */
  readonly origin?: FileSaveOrigin;
}

/** One open diff, keyed by {@link diffViewerKey}. */
export interface DiffViewerSession {
  readonly key: string;
  readonly request: PortalDiffReadPayload;
  readonly diff: PortalDiffPayload | null;
  readonly status: FileViewerStatus;
  readonly error: string | null;
}

export interface FileViewerState {
  readonly files: Readonly<Record<string, FileViewerSession>>;
  readonly diffs: Readonly<Record<string, DiffViewerSession>>;
  /** Key of the most recently opened file, or `null`. */
  readonly activeFileKey: string | null;
  /** Key of the most recently opened diff, or `null`. */
  readonly activeDiffKey: string | null;
  /**
   * Whether this host can write files. Derived once from
   * `capabilities.fileSystemAccess === 'read-write'`; web relays report `read`.
   */
  readonly canEdit: boolean;

  /**
   * Read a file into a session and mark it active; resolves to its key.
   * Actions are declared as function-typed properties (not method syntax) so
   * hosts can select them off a snapshot (`useStore((s) => s.openFile)`)
   * without tripping `@typescript-eslint/unbound-method` — none of them use
   * `this`.
   */
  openFile: (request: PortalFileReadPayload) => Promise<string>;
  /** Update the editor buffer for a file (recomputes `dirty`). */
  updateContent: (key: string, content: string) => void;
  /**
   * Persist the buffer. Rejects locally (no command) when `canEdit` is false.
   * A stale-version refusal reads the latest version and attempts one
   * automatic three-way merge; otherwise the session gains
   * {@link FileViewerSession.saveConflict}. Resolves true only when the
   * current buffer is clean afterwards.
   */
  saveFile: (key: string, options?: FileSaveOptions) => Promise<boolean>;
  /**
   * Revert to the confirmed content, reading disk when the baseline is stale.
   * A pending save conflict retains the draft until that read succeeds;
   * ignored while a save is in flight.
   */
  discardEdits: (key: string) => void;
  /** Switch a file's view mode. */
  setViewMode: (key: string, viewMode: FileViewMode) => void;
  /** Drop a file session. */
  closeFile: (key: string) => void;
  /**
   * After a file or folder was renamed on disk (`from.relativePath` to
   * `toRelativePath`, in the same root), moves every open session at or under
   * it to its new path, keeping unsaved edits, their baseline and any
   * conflict. A session busy reading or saving stays where it is. Answers the
   * old keys of the sessions it moved.
   */
  renamePath: (
    from: PortalFileReadPayload,
    toRelativePath: string,
  ) => ReadonlySet<string>;
  /**
   * Check an open session against disk without activating it. A clean
   * session takes the disk version; a dirty one keeps its buffer and baseline
   * and gains {@link FileViewerSession.externalChange} when disk differs.
   */
  refreshFile: (key: string) => Promise<void>;
  /**
   * Invalidate a session after a completed write. Coalesces with an
   * in-flight read or save: one follow-up read runs once it settles.
   */
  markFileChanged: (key: string, source?: FileChangeSource) => void;
  /**
   * Replace a dirty buffer with the disk version (Show latest). Applies only
   * when the buffer is unchanged since the action began; a failure keeps the
   * edits and the notice with a retryable error.
   */
  reloadFromDisk: (key: string) => Promise<boolean>;
  /**
   * Hide the notice (Keep my edits, or Decide later for a comparison before
   * saving). The save baseline and {@link FileViewerSession.baselineStale}
   * are unchanged: dismissal does not acknowledge that the baseline is
   * current. A deferred comparison discards its partial choices and returns
   * only for a newer version or through Save.
   */
  dismissExternalChange: (key: string) => void;
  /**
   * Choose which wording one overlapping passage keeps. Ignored unless
   * `token` names the session's current comparison and its snapshot still
   * matches. The last choice installs the combined buffer with the compared
   * version as its baseline; it never writes the file.
   */
  chooseOverlapVersion: (
    key: string,
    token: string,
    passageIndex: number,
    choice: OverlapChoice,
  ) => void;
  /**
   * Save my version: replace the version the conflict notice represents with
   * the current buffer through a conditional write. Without a usable version
   * it reads one first and waits for another activation; a newer version
   * keeps the notice for renewed consent. Resolves true once clean.
   */
  overwriteWithEdits: (key: string) => Promise<boolean>;
  /** Invalidate every open session an agent edit resolves to. */
  notifyFileChanged: (edit: AgentFileEdit) => void;
  /** Read a diff into a session and mark it active; resolves to its key. */
  openDiff: (request: PortalDiffReadPayload) => Promise<string>;
  /** Drop a diff session. */
  closeDiff: (key: string) => void;
}

/**
 * Stable session key for a file read request (multi-repo safe).
 *
 * `fileRootLocalId` takes precedence over `repoId` to mirror the protocol's own
 * resolution rule (`PortalFileReadPayload`: "setting both is permitted but
 * `fileRootLocalId` wins"). Keying on the field the server actually resolves
 * against prevents two distinct files from collapsing onto one session.
 */
export function fileViewerKey(request: PortalFileReadPayload): string {
  const root = request.fileRootLocalId ?? request.repoId ?? '';
  return `${request.projectId}:${request.worktreeId}:${root}:${request.relativePath}`;
}

/** Stable session key for a diff read request. */
export function diffViewerKey(request: PortalDiffReadPayload): string {
  return `${request.workspaceId}:${request.worktreeId}:${request.repoId ?? ''}:${request.path ?? ''}:${request.source ?? 'combined'}`;
}

/**
 * Tolerance for host/client clock skew when separating fresh agent writes from
 * transcript history replayed after the store activates.
 */
const AGENT_EDIT_REPLAY_TOLERANCE_MS = 2 * 60 * 1000;

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Confirmed mtime of a preview in ms, or NaN when it is unavailable. */
function previewMtimeMs(preview: PortalFilePreview | null | undefined): number {
  return preview?.modifiedAt ? Date.parse(preview.modifiedAt) : Number.NaN;
}

/**
 * Whether a read can serve as a merge input or an overwrite baseline: the
 * complete text of the file with a usable version.
 */
function isCompleteTextVersion(preview: PortalFilePreview): boolean {
  return (
    !preview.truncated &&
    !Number.isNaN(previewMtimeMs(preview)) &&
    mergeInputSkipReason(preview.content) === null
  );
}

/**
 * Whether a save of `content`, edited from `base`, would combine with
 * `latest` automatically: the same check the stale-save recovery applies.
 */
function savesCombine(
  base: PortalFilePreview,
  content: string,
  latest: PortalFilePreview,
): boolean {
  return (
    isCompleteTextVersion(base) &&
    isCompleteTextVersion(latest) &&
    threeWayMerge(base.content, content, latest.content).kind === 'clean'
  );
}

/**
 * Choices to keep for a re-analysis of the same baseline and newer version:
 * only passages whose base, ours, and theirs text each match exactly one old
 * and one new passage keep their choice. Ambiguous matches start over.
 */
function carriedChoices(
  previous: FileOverlapComparison,
  regions: readonly OverlapRegion[],
): (OverlapChoice | null)[] {
  const identity = (region: OverlapRegion): string =>
    JSON.stringify([region.base, region.ours, region.theirs]);
  const count = (list: readonly OverlapRegion[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const region of list) {
      const id = identity(region);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  };
  const oldCounts = count(previous.regions);
  const newCounts = count(regions);
  const oldChoices = new Map<string, OverlapChoice | null>();
  previous.regions.forEach((region, index) => {
    oldChoices.set(identity(region), previous.choices[index] ?? null);
  });
  return regions.map((region) => {
    const id = identity(region);
    return oldCounts.get(id) === 1 && newCounts.get(id) === 1
      ? (oldChoices.get(id) ?? null)
      : null;
  });
}

/**
 * Create a file/diff viewer store bound to a single {@link CanopyClient}.
 * Reads go through `client.query('file.read' | 'diff.read')`; saves through
 * `client.command('file.save')`, gated on the host's `fileSystemAccess`
 * capability. Wrapped by {@link createClientStore} for per-client memoization.
 */
export function createFileViewerStore(
  client: CanopyClient,
): ClientStore<FileViewerState> {
  const canEdit = client.capabilities.fileSystemAccess === 'read-write';
  const lifecycle = {
    activate: (): void => undefined,
    dispose: (): void => undefined,
  };

  const createState: StateCreator<FileViewerState> = (set, get) => {
    const patchFile = (
      key: string,
      patch: Partial<FileViewerSession>,
    ): void => {
      set((state) => {
        const prev = state.files[key];
        if (!prev) {
          return state;
        }
        return { files: { ...state.files, [key]: { ...prev, ...patch } } };
      });
    };

    // Monotonic per-key generation. `closeFile` bumps it so an in-flight
    // read/save that resolves after the session was closed (or closed and
    // reopened under the same key) cannot repopulate or patch the replacement.
    const generations = new Map<string, number>();
    const currentGeneration = (key: string): number =>
      generations.get(key) ?? 0;
    const invalidateGeneration = (key: string): void => {
      generations.set(key, currentGeneration(key) + 1);
    };

    // A re-read of an open session keeps the previous content editable, so an
    // edit or a save can land while it is in flight. Each read takes a token
    // and only the latest read for a key may settle the session. A save
    // advances the key's save epoch: a read that started before it must not
    // replace the saved buffer or baseline. An edit made during a read wins
    // while it is still unsaved when the read lands, and keeps the baseline it
    // was made against so a later save still detects a newer disk version.
    let readTokenCounter = 0;
    const latestReadTokens = new Map<string, number>();
    const saveEpochs = new Map<string, number>();
    const currentSaveEpoch = (key: string): number => saveEpochs.get(key) ?? 0;
    // Per-canonical-key in-flight save transactions so concurrent save entries
    // (Cmd/Ctrl+S spam, autosave racing an explicit Save, close-save) collapse
    // onto one physical `file.save`, and a later explicit save while one is in
    // flight issues at most one follow-up when newer content stays dirty.
    const inFlightSaves = new Map<
      string,
      { generation: number; promise: Promise<boolean> }
    >();

    // Reads currently running per key (any mode), and invalidations that
    // arrived while a read or save was busy. A pending invalidation runs one
    // coalesced follow-up read once the key settles, so the latest write is
    // never lost and repeated events do not stack reads.
    // The value records whether the read carries an unchecked write.
    const readsInFlight = new Map<string, boolean>();
    // The newest read started per key, so an open that coalesces with a read
    // already in flight can wait for the content that read applies.
    const latestReads = new Map<string, Promise<boolean>>();
    const pendingInvalidations = new Set<string>();
    // Source of each pending invalidation; mixed sources become unknown.
    const pendingSources = new Map<string, FileChangeSource>();
    const bufferRevisions = new Map<string, number>();
    // The confirmed version a dirty session was edited from, recorded when a
    // read finds disk has moved past it. A combinable change needs no recovery
    // choice, so undo and discard use this to load the newer version. Identity with
    // the session's current preview means the baseline is still stale.
    const staleBaselines = new Map<string, PortalFilePreview>();
    const baselineKnownStale = (session: FileViewerSession): boolean =>
      session.preview !== null &&
      staleBaselines.get(session.key) === session.preview;
    // The newer version a dirty session's last accepted read found, with the
    // baseline it was compared against. Valid only while that baseline is
    // still the session's preview, so typing can re-check combinability
    // without another read.
    const latestVersions = new Map<
      string,
      {
        base: PortalFilePreview;
        latest: PortalFilePreview;
        source: FileChangeSource | null;
      }
    >();
    // Keep the same object for a repeated version so readers see no churn.
    const combinableChangeFor = (
      previous: FileCombinableChange | null | undefined,
      version: string,
      source: FileChangeSource | null,
    ): FileCombinableChange =>
      previous?.version === version && previous.source === source
        ? previous
        : { version, source };
    // The version a reported agent write produced. Attribution belongs to that
    // version only, so a conflict against any other version reads as unknown.
    const attributions = new Map<
      string,
      { source: FileChangeSource; version: string }
    >();
    const sourceForVersion = (
      key: string,
      version: string,
    ): FileChangeSource | null => {
      const attribution = attributions.get(key);
      return attribution?.version === version ? attribution.source : null;
    };
    const queueInvalidation = (key: string, source: FileChangeSource): void => {
      pendingInvalidations.add(key);
      const previous = pendingSources.get(key);
      pendingSources.set(
        key,
        previous === undefined || previous === source ? source : 'unknown',
      );
    };

    const releaseLoading = (key: string): void => {
      if (get().files[key]?.status === 'loading') {
        patchFile(key, { status: 'idle' });
      }
    };

    const flushPendingInvalidation = (key: string): void => {
      if (!pendingInvalidations.has(key)) return;
      const session = get().files[key];
      if (!session) {
        pendingInvalidations.delete(key);
        return;
      }
      if (session.status === 'saving' || readsInFlight.has(key)) return;
      void readSession(
        key,
        session.externalChange?.reloading ? 'reload' : 'refresh',
        pendingSources.get(key) ?? 'unknown',
      );
    };

    // `open` settles a read started by openFile (which set the loading
    // sentinel and activated the key); `refresh` checks disk in the
    // background without touching status or activation; `reload` replaces a
    // dirty buffer for Show latest. A read that carries an `invalidation`
    // was started for a reported write from that source; if a save
    // supersedes it, the write is re-checked once the save settles. Resolves
    // true when it applied.
    const readSession = (
      key: string,
      mode: 'open' | 'refresh' | 'reload',
      invalidation: FileChangeSource | null = null,
    ): Promise<boolean> => {
      const read = runRead(key, mode, invalidation);
      latestReads.set(key, read);
      const forget = (): void => {
        if (latestReads.get(key) === read) latestReads.delete(key);
      };
      void read.then(forget, forget);
      return read;
    };

    // Waits for the key's read in flight and at most one follow-up it starts
    // for a write reported meanwhile, so the caller sees current content
    // without waiting out a file that keeps changing.
    const settleReadsInFlight = async (key: string): Promise<void> => {
      for (let round = 0; round < 2; round += 1) {
        const read = latestReads.get(key);
        if (!read) return;
        await read.catch(() => false);
      }
    };

    const runRead = async (
      key: string,
      mode: 'open' | 'refresh' | 'reload',
      invalidation: FileChangeSource | null,
    ): Promise<boolean> => {
      const session = get().files[key];
      if (!session) return false;
      const generation = currentGeneration(key);
      readTokenCounter += 1;
      const readToken = readTokenCounter;
      latestReadTokens.set(key, readToken);
      const readCarriesInvalidation =
        invalidation !== null ||
        readsInFlight.get(key) === true ||
        pendingInvalidations.has(key);
      readsInFlight.set(key, readCarriesInvalidation);
      pendingInvalidations.delete(key);
      pendingSources.delete(key);
      const saveEpoch = currentSaveEpoch(key);
      const bufferRevision = bufferRevisions.get(key) ?? 0;
      let preview: PortalFilePreview | null = null;
      let failure: string | null = null;
      try {
        preview = await client.query('file.read', session.request);
      } catch (error) {
        failure = errorMessage(error, 'Failed to read file.');
      }
      // A close (and possible reopen) or disposal during the read invalidates
      // this completion; a newer read owns the session.
      if (currentGeneration(key) !== generation) return false;
      // A reported agent write is attributed to the version it produced,
      // even when a newer read supersedes this one.
      if (preview !== null && invalidation === 'agent-edit') {
        recordAttribution(key, preview.version, invalidation);
      }
      if (latestReadTokens.get(key) !== readToken) return false;
      readsInFlight.delete(key);
      const applied = settleRead(key, mode, {
        preview,
        failure,
        saveEpoch,
        bufferRevision,
        invalidation:
          invalidation ?? (readCarriesInvalidation ? 'unknown' : null),
      });
      flushPendingInvalidation(key);
      return applied;
    };

    const recordAttribution = (
      key: string,
      version: string,
      source: FileChangeSource,
    ): void => {
      attributions.set(key, { source, version });
      // A conflict already showing this version learns who made it.
      const conflict = get().files[key]?.saveConflict;
      if (conflict?.latest?.version === version && conflict.source === null) {
        patchConflict(key, { source });
      }
    };

    const patchConflict = (
      key: string,
      patch: Partial<FileSaveConflict>,
    ): void => {
      const conflict = get().files[key]?.saveConflict;
      if (!conflict) return;
      patchFile(key, { saveConflict: { ...conflict, ...patch } });
    };

    // --- Overlap comparisons ---------------------------------------------
    // Each published comparison takes a fresh token; only the key's live
    // token accepts choices, so a stale rendered click, a closed-and-reopened
    // file, or a disposed store cannot reuse consent.
    let overlapTokenCounter = 0;
    const liveOverlapTokens = new Map<string, string>();
    // The newer version a pre-save comparison was deferred for (Decide
    // later). An unchanged re-read keeps it hidden; Save or a newer version
    // brings it back.
    const deferredOverlaps = new Map<string, string>();
    // An output guard can reject a choice even though each input fits. Do
    // not republish that exact unresolvable snapshot on the next read.
    const rejectedOverlaps = new Map<string, FileOverlapComparison>();

    type OverlapOutcome =
      | {
          readonly kind: 'conflicts';
          readonly comparison: FileOverlapComparison;
        }
      | { readonly kind: 'clean'; readonly content: string }
      | { readonly kind: 'skipped' };

    /**
     * Compare a buffer edited from `base` with the complete newer `latest`.
     * Re-analyzing the same snapshot returns `previous` unchanged, so choices
     * and the reveal survive repeated reads; a different newer version starts
     * every choice over.
     */
    const analyzeOverlap = (
      key: string,
      base: PortalFilePreview | null,
      ours: string,
      latest: PortalFilePreview,
      previous: FileOverlapComparison | null | undefined,
    ): OverlapOutcome => {
      if (
        base === null ||
        !isCompleteTextVersion(base) ||
        !isCompleteTextVersion(latest)
      ) {
        return { kind: 'skipped' };
      }
      const rejected = rejectedOverlaps.get(key);
      if (
        rejected?.base === base &&
        rejected.ours === ours &&
        rejected.latest.version === latest.version &&
        rejected.latest.content === latest.content
      ) {
        return { kind: 'skipped' };
      }
      rejectedOverlaps.delete(key);
      if (
        previous &&
        previous.base === base &&
        previous.ours === ours &&
        previous.latest.version === latest.version &&
        previous.latest.content === latest.content &&
        liveOverlapTokens.get(key) === previous.token
      ) {
        return { kind: 'conflicts', comparison: previous };
      }
      const analysis = analyzeThreeWay(base.content, ours, latest.content);
      if (analysis.kind === 'skipped') return { kind: 'skipped' };
      if (analysis.kind === 'clean') return analysis;
      const sameVersions =
        previous !== null &&
        previous !== undefined &&
        previous.base === base &&
        previous.latest.version === latest.version &&
        previous.latest.content === latest.content;
      overlapTokenCounter += 1;
      const token = `${currentGeneration(key)}:${overlapTokenCounter}`;
      liveOverlapTokens.set(key, token);
      return {
        kind: 'conflicts',
        comparison: {
          generation: currentGeneration(key),
          token,
          base,
          ours,
          latest,
          regions: analysis.regions,
          choices: sameVersions
            ? carriedChoices(previous, analysis.regions)
            : analysis.regions.map(() => null),
        },
      };
    };

    /** Drop a session's comparison without touching its recovery notice. */
    const clearOverlapState = (key: string): void => {
      liveOverlapTokens.delete(key);
    };

    /**
     * Install `content` over the compared newer version as the new save
     * baseline in one update, clearing the recovery it settles. Never writes:
     * the next save is an ordinary conditional write against `latest`.
     */
    const adoptLatestWith = (
      key: string,
      content: string,
      latest: PortalFilePreview,
    ): void => {
      const current = get().files[key];
      if (!current) return;
      if (content !== current.content) {
        bufferRevisions.set(key, (bufferRevisions.get(key) ?? 0) + 1);
      }
      staleBaselines.delete(key);
      latestVersions.delete(key);
      deferredOverlaps.delete(key);
      rejectedOverlaps.delete(key);
      clearOverlapState(key);
      const matchesLatest = content === latest.content;
      const baselineChanged = latest.content !== current.preview?.content;
      patchFile(key, {
        preview: latest,
        content,
        bufferRevision: bufferRevisions.get(key) ?? 0,
        combinableChange: null,
        dirty: !matchesLatest,
        externalChange: null,
        saveConflict: null,
        overlap: null,
        baselineStale: false,
        reloadRevision:
          (current.reloadRevision ?? 0) +
          (matchesLatest && baselineChanged ? 1 : 0),
        overlapResolvedRevision:
          (current.overlapResolvedRevision ?? 0) + (matchesLatest ? 0 : 1),
      });
    };

    /** Whether a comparison still describes the session it is attached to. */
    const overlapIsCurrent = (
      session: FileViewerSession,
      overlap: FileOverlapComparison,
    ): boolean =>
      liveOverlapTokens.get(session.key) === overlap.token &&
      session.preview === overlap.base &&
      session.content === overlap.ours &&
      (session.externalChange != null || session.saveConflict != null);

    const settleRead = (
      key: string,
      mode: 'open' | 'refresh' | 'reload',
      result: {
        preview: PortalFilePreview | null;
        failure: string | null;
        saveEpoch: number;
        bufferRevision: number;
        invalidation: FileChangeSource | null;
      },
    ): boolean => {
      const current = get().files[key];
      if (!current) return false;
      const { preview, failure, saveEpoch, bufferRevision, invalidation } =
        result;
      const saveRaced = currentSaveEpoch(key) !== saveEpoch;

      // Failed superseded reads must retain their write invalidation too.
      if (saveRaced && invalidation !== null)
        queueInvalidation(key, invalidation);
      if (preview === null) {
        if (current.overlap && !saveRaced) {
          clearOverlapState(key);
          patchFile(key, { overlap: null });
          if (current.saveConflict) {
            patchConflict(key, { reason: 'read-unavailable', latest: null });
          }
        }
        if (
          mode === 'reload' ||
          current.externalChange ||
          current.saveConflict
        ) {
          releaseLoading(key);
          if (current.saveConflict) {
            patchConflict(key, {
              resolving: null,
              error: { kind: 'latest-unavailable' },
            });
          } else {
            patchFile(key, {
              externalChange: {
                reloading: false,
                error: failure ?? 'Failed to read file.',
                source: current.externalChange?.source ?? null,
              },
            });
          }
          if (mode === 'reload' || current.saveConflict) return false;
        }
        // Keep the last visible content. A clean session shows a recoverable
        // error; unsaved edits keep their buffer and existing status.
        if (!saveRaced) {
          patchFile(key, {
            status: 'error',
            error: failure ?? 'Failed to read file.',
          });
        } else {
          releaseLoading(key);
        }
        return false;
      }

      // A save landed during the read: its result may be newer than what was
      // read. Never apply it; a reported write is re-checked after the save.
      if (saveRaced) {
        releaseLoading(key);
        if (mode === 'reload') {
          if (current.saveConflict) {
            patchConflict(key, { resolving: null });
          } else {
            patchFile(key, {
              externalChange: current.externalChange
                ? { ...current.externalChange, reloading: false, error: null }
                : null,
            });
          }
        }
        if (invalidation !== null) queueInvalidation(key, invalidation);
        return false;
      }

      // A reported write after this read started still needs checking. Keep
      // recovery visible and do not apply or announce superseded bytes. The
      // queued read retains reload semantics unless typing cancelled it.
      if (
        pendingInvalidations.has(key) &&
        (current.baselineStale === true || current.externalChange)
      ) {
        if (
          mode === 'reload' &&
          (bufferRevisions.get(key) ?? 0) !== bufferRevision
        ) {
          patchFile(key, {
            externalChange: { reloading: false, error: null },
          });
        }
        return false;
      }

      const diskChanged = preview.content !== current.preview?.content;
      // Count only replacements of shown content; initial loads and
      // identical reads must not announce a reload.
      const nextRevision =
        (current.reloadRevision ?? 0) +
        (current.preview !== null && diskChanged ? 1 : 0);
      const source =
        invalidation === 'agent-edit'
          ? invalidation
          : sourceForVersion(key, preview.version);
      // A reload canceled by typing still discovered a version. Keep it for
      // subsequent eligibility checks without replacing the draft/baseline.
      if (current.dirty || mode === 'reload') {
        if (diskChanged && current.preview !== null) {
          staleBaselines.set(key, current.preview);
          latestVersions.set(key, {
            base: current.preview,
            latest: preview,
            source,
          });
          patchFile(key, { baselineStale: true });
        } else {
          latestVersions.delete(key);
        }
      }

      if (mode === 'reload') {
        if (current.saveConflict && !isCompleteTextVersion(preview)) {
          patchConflict(key, {
            resolving: null,
            error: { kind: 'latest-unavailable' },
          });
          return false;
        }
        // Typing during the read wins: keep the edits and the notice.
        if ((bufferRevisions.get(key) ?? 0) !== bufferRevision) {
          if (current.saveConflict) {
            // Recovery stays available against the version just read.
            const latest = isCompleteTextVersion(preview)
              ? preview
              : current.saveConflict.latest;
            patchConflict(key, {
              resolving: null,
              reason: 'newer-edits',
              latest,
              source: latest
                ? sourceForVersion(key, latest.version)
                : current.saveConflict.source,
            });
          } else {
            patchFile(key, {
              externalChange: {
                reloading: false,
                error: null,
                source: current.externalChange?.source ?? null,
              },
            });
          }
          return false;
        }
        patchFile(key, {
          preview,
          content: preview.content,
          dirty: false,
          status:
            current.status === 'loading' || current.status === 'error'
              ? 'idle'
              : current.status,
          error: null,
          externalChange: null,
          saveConflict: null,
          overlap: null,
          combinableChange: null,
          baselineStale: false,
          reloadRevision: nextRevision,
        });
        clearOverlapState(key);
        deferredOverlaps.delete(key);
        return true;
      }

      if (current.dirty) {
        // Never replace unsaved edits or advance their baseline. A disk change
        // the next save would combine automatically needs only an explanation,
        // while overlapping changes need a recovery choice. A pending
        // save conflict already owns recovery, so it is not duplicated.
        releaseLoading(key);
        if (current.overlap) {
          settleOverlapRead(key, preview, source);
          return false;
        }
        const outcome =
          current.preview !== null && !current.saveConflict
            ? analyzeOverlap(
                key,
                current.preview,
                current.content,
                preview,
                null,
              )
            : null;
        // A newer clean result settles the deferred decision and lets the
        // normal autosave policy resume against that exact newer baseline.
        if (
          outcome?.kind === 'clean' &&
          deferredOverlaps.has(key) &&
          deferredOverlaps.get(key) !== preview.version &&
          !current.externalChange?.reloading
        ) {
          adoptLatestWith(key, outcome.content, preview);
          return false;
        }
        const combinable =
          outcome !== null
            ? outcome.kind === 'clean'
            : current.preview !== null &&
              savesCombine(current.preview, current.content, preview);
        let externalChange = current.externalChange ?? null;
        if (externalChange) {
          externalChange =
            combinable && !externalChange.reloading
              ? null
              : { ...externalChange, source };
          patchFile(key, { externalChange });
        }
        if (
          outcome?.kind === 'conflicts' &&
          !current.externalChange?.reloading
        ) {
          // Decide later holds until Save or a newer version.
          if (deferredOverlaps.get(key) === preview.version) {
            clearOverlapState(key);
            return false;
          }
          deferredOverlaps.delete(key);
          patchFile(key, {
            overlap: outcome.comparison,
            combinableChange: null,
            externalChange: {
              reloading: false,
              error: current.externalChange?.error ?? null,
              source,
            },
          });
          return false;
        }
        if (
          diskChanged &&
          !combinable &&
          current.preview !== null &&
          !current.externalChange &&
          !current.saveConflict
        ) {
          externalChange = { reloading: false, error: null, source };
          patchFile(key, { externalChange });
        }
        // Explain the combine Save will perform; a notice that asks for a
        // choice owns the state instead.
        patchFile(key, {
          combinableChange:
            diskChanged &&
            combinable &&
            externalChange === null &&
            !current.saveConflict
              ? combinableChangeFor(
                  current.combinableChange,
                  preview.version,
                  source,
                )
              : null,
        });
        return false;
      }

      patchFile(key, {
        preview,
        content: preview.content,
        dirty: false,
        status: 'idle',
        error: null,
        externalChange: null,
        saveConflict: null,
        overlap: null,
        combinableChange: null,
        baselineStale: false,
        reloadRevision: nextRevision,
      });
      clearOverlapState(key);
      deferredOverlaps.delete(key);
      return true;
    };

    /**
     * A read while a comparison is showing. The same newer version keeps it
     * (and its choices); a different one re-compares from scratch, settles
     * cleanly, or falls back to whole-document recovery.
     */
    const settleOverlapRead = (
      key: string,
      preview: PortalFilePreview,
      source: FileChangeSource | null,
    ): void => {
      const current = get().files[key];
      const overlap = current?.overlap;
      if (!current || !overlap) return;
      if (
        current.externalChange?.reloading ||
        (current.saveConflict && current.saveConflict.resolving !== null)
      ) {
        return;
      }
      const outcome = analyzeOverlap(
        key,
        current.preview,
        current.content,
        preview,
        overlap,
      );
      if (outcome.kind === 'clean') {
        adoptLatestWith(key, outcome.content, preview);
        return;
      }
      const sameVersion = preview.version === overlap.latest.version;
      if (outcome.kind === 'skipped') {
        clearOverlapState(key);
        if (current.saveConflict) {
          patchFile(key, {
            overlap: null,
            saveConflict: {
              ...current.saveConflict,
              reason: 'merge-skipped',
              latest: isCompleteTextVersion(preview) ? preview : null,
              source: sameVersion ? current.saveConflict.source : source,
            },
          });
        } else {
          patchFile(key, {
            overlap: null,
            externalChange: {
              reloading: false,
              error: null,
              source,
            },
          });
        }
        return;
      }
      if (outcome.comparison === overlap) return;
      if (current.saveConflict) {
        patchFile(key, {
          overlap: outcome.comparison,
          saveConflict: {
            ...current.saveConflict,
            latest: preview,
            source,
          },
        });
      } else {
        patchFile(key, {
          overlap: outcome.comparison,
          externalChange: {
            reloading: false,
            error: null,
            ...current.externalChange,
            source,
          },
        });
      }
    };

    // --- Save transaction and conflict recovery ---------------------------

    /** Read the latest version for recovery without settling the session. */
    const readLatest = async (
      request: PortalFileReadPayload,
    ): Promise<PortalFilePreview | null> => {
      try {
        return await client.query('file.read', request);
      } catch {
        return null;
      }
    };

    /**
     * Stop at the conflict notice: the buffer and its baseline stay as they
     * are. `focus` counts an explicit user request for the notice.
     */
    const setConflict = (
      key: string,
      conflict: {
        reason: FileSaveConflictReason;
        latest: PortalFilePreview | null;
        origin: FileSaveOrigin;
        focus: boolean;
        source?: FileChangeSource | null;
        /** The passages to choose between, when the versions compare. */
        comparison?: FileOverlapComparison | null;
      },
    ): void => {
      const current = get().files[key];
      if (!current) return;
      const dirty = current.content !== (current.preview?.content ?? '');
      if (!conflict.comparison) clearOverlapState(key);
      if (!dirty) {
        // Undo returned to the baseline meanwhile: nothing left to recover.
        patchFile(key, {
          status: 'idle',
          error: null,
          saveConflict: null,
          overlap: null,
          combinableChange: null,
        });
        return;
      }
      const previous = current.saveConflict;
      deferredOverlaps.delete(key);
      patchFile(key, {
        status: 'idle',
        error: null,
        dirty,
        externalChange: null,
        overlap: conflict.comparison ?? null,
        combinableChange: null,
        saveConflict: {
          reason: conflict.reason,
          latest: conflict.latest,
          origin: conflict.origin,
          source:
            conflict.source !== undefined
              ? conflict.source
              : conflict.latest
                ? sourceForVersion(key, conflict.latest.version)
                : null,
          resolving: null,
          error: null,
          focusRequest:
            (previous?.focusRequest ?? 0) + (conflict.focus ? 1 : 0),
        },
      });
    };

    /**
     * Settle a write of `snapshotContent`. Typing during the round trip keeps
     * the newer buffer, which was derived from the snapshot now saved.
     */
    const applySavedSnapshot = (
      key: string,
      preview: PortalFilePreview,
      snapshotContent: string,
    ): void => {
      const current = get().files[key];
      if (!current) return;
      clearOverlapState(key);
      deferredOverlaps.delete(key);
      const baselineStale = pendingInvalidations.has(key);
      const externalChange = baselineStale
        ? { reloading: false, error: null }
        : null;
      if (current.content !== snapshotContent) {
        patchFile(key, {
          preview,
          dirty: current.content !== preview.content,
          status: 'idle',
          error: null,
          externalChange,
          baselineStale,
          saveConflict: null,
          overlap: null,
          combinableChange: null,
        });
      } else {
        patchFile(key, {
          preview,
          content: preview.content,
          dirty: false,
          status: 'idle',
          error: null,
          externalChange,
          baselineStale,
          saveConflict: null,
          overlap: null,
          combinableChange: null,
        });
      }
    };

    /** Adopt a version that holds both the user's edits and newer changes. */
    const applyMergedVersion = (
      key: string,
      preview: PortalFilePreview,
      source: FileChangeSource | null,
    ): void => {
      const current = get().files[key];
      if (!current) return;
      clearOverlapState(key);
      deferredOverlaps.delete(key);
      const baselineStale = pendingInvalidations.has(key);
      const externalChange = baselineStale
        ? { reloading: false, error: null }
        : null;
      patchFile(key, {
        preview,
        content: preview.content,
        dirty: false,
        status: 'idle',
        error: null,
        externalChange,
        baselineStale,
        saveConflict: null,
        overlap: null,
        combinableChange: null,
        savedMerge: {
          revision: (current.savedMerge?.revision ?? 0) + 1,
          source,
        },
      });
    };

    interface SaveSnapshot {
      readonly key: string;
      readonly request: PortalFileReadPayload;
      readonly base: PortalFilePreview;
      readonly content: string;
      readonly generation: number;
      readonly bufferRevision: number;
      readonly origin: FileSaveOrigin;
    }

    const isStale = (snapshot: SaveSnapshot): boolean =>
      currentGeneration(snapshot.key) !== snapshot.generation ||
      !get().files[snapshot.key];

    /**
     * The document changed again during recovery. A complete newer version is
     * compared with the current buffer: disjoint changes settle into the
     * buffer without a write, overlaps get passage choices, and anything else
     * keeps whole-document recovery.
     */
    const settleChangedAgain = (
      key: string,
      newer: PortalFilePreview | null,
      origin: FileSaveOrigin,
      focus: boolean,
    ): void => {
      const current = get().files[key];
      if (!current) return;
      const latest =
        newer !== null && isCompleteTextVersion(newer) ? newer : null;
      const outcome =
        latest === null
          ? null
          : analyzeOverlap(
              key,
              current.preview,
              current.content,
              latest,
              current.overlap,
            );
      if (latest !== null && outcome?.kind === 'clean') {
        // Recovery ends here: the next save is an ordinary conditional write.
        adoptLatestWith(key, outcome.content, latest);
        patchFile(key, { status: 'idle', error: null });
        return;
      }
      setConflict(key, {
        reason: 'changed-again',
        latest,
        origin,
        focus,
        comparison: outcome?.kind === 'conflicts' ? outcome.comparison : null,
      });
    };

    /**
     * After a stale-version refusal: read the latest version once, try one
     * three-way merge, and issue at most one conditional follow-up write.
     * Resolves true when a version holding the edits was committed.
     */
    const recoverFromStaleSave = async (
      snapshot: SaveSnapshot,
    ): Promise<boolean> => {
      const { key, request, origin } = snapshot;
      const focus = origin === 'user';
      const retainedBeforeRead = latestVersions.get(key);
      const latest = await readLatest(request);
      if (isStale(snapshot)) return false;
      if (latest === null) {
        setConflict(key, {
          reason: 'read-unavailable',
          latest: null,
          origin,
          focus,
        });
        return false;
      }
      if (
        !isCompleteTextVersion(latest) ||
        !isCompleteTextVersion(snapshot.base)
      ) {
        // Incomplete content can neither be merged nor replaced safely.
        setConflict(key, {
          reason: 'merge-skipped',
          latest: isCompleteTextVersion(latest) ? latest : null,
          origin,
          focus,
        });
        return false;
      }
      // Never fold a moving buffer into the merge.
      if ((bufferRevisions.get(key) ?? 0) !== snapshot.bufferRevision) {
        setConflict(key, { reason: 'newer-edits', latest, origin, focus });
        return false;
      }
      const merge = analyzeOverlap(
        key,
        snapshot.base,
        snapshot.content,
        latest,
        get().files[key]?.overlap,
      );
      if (merge.kind !== 'clean') {
        setConflict(key, {
          reason: merge.kind === 'conflicts' ? 'overlap' : 'merge-skipped',
          latest,
          origin,
          focus,
          comparison: merge.kind === 'conflicts' ? merge.comparison : null,
        });
        return false;
      }
      const source = sourceForVersion(key, latest.version);
      // Recovery also discovers versions used by pending feedback. Retain it
      // before the write so typing follows this version even if saving fails.
      // A newer accepted read or baseline replacement still wins.
      if (
        get().files[key]?.preview === snapshot.base &&
        latestVersions.get(key) === retainedBeforeRead
      ) {
        if (latest.content !== snapshot.base.content) {
          latestVersions.set(key, { base: snapshot.base, latest, source });
          staleBaselines.set(key, snapshot.base);
          patchFile(key, { baselineStale: true });
        } else {
          latestVersions.delete(key);
        }
      }
      if (merge.content === latest.content) {
        // The newer version already holds these edits: adopt it unwritten.
        applyMergedVersion(key, latest, source);
        return true;
      }
      saveEpochs.set(key, currentSaveEpoch(key) + 1);
      let saved: PortalFilePreview;
      try {
        saved = await client.command('file.save', {
          ...request,
          content: merge.content,
          expectedVersion: latest.version,
          expectedModifiedAtMs: previewMtimeMs(latest),
        });
      } catch (error) {
        if (isStale(snapshot)) return false;
        if (!isFileSaveConflictError(error)) {
          // Not an overlap: keep the edits and report the write failure.
          const current = get().files[key];
          const known = latestVersions.get(key);
          patchFile(key, {
            status: 'error',
            error: errorMessage(error, 'Failed to save file.'),
            dirty: true,
            combinableChange:
              current?.dirty &&
              !current.externalChange &&
              !current.saveConflict &&
              known !== undefined &&
              known.base === current.preview &&
              savesCombine(known.base, current.content, known.latest)
                ? combinableChangeFor(
                    current.combinableChange,
                    known.latest.version,
                    known.source,
                  )
                : null,
          });
          return false;
        }
        // Changed again: compare the newest version and stop.
        const newer = await readLatest(request);
        if (isStale(snapshot)) return false;
        settleChangedAgain(key, newer, origin, focus);
        return false;
      }
      if (isStale(snapshot)) return true;
      if ((bufferRevisions.get(key) ?? 0) !== snapshot.bufferRevision) {
        // Typing during the merged write: keep the newer buffer and the
        // baseline it was derived from. The committed merge is the version
        // recovery now replaces or shows; never mark the newer buffer clean.
        setConflict(key, {
          reason: 'newer-edits',
          latest: saved,
          origin,
          focus,
          source,
        });
        return true;
      }
      if (latest.content === snapshot.base.content) {
        // Only version metadata changed: the write saved the user's edits,
        // but combined no newer text. Do not announce a combined save.
        applySavedSnapshot(key, saved, snapshot.content);
      } else {
        applyMergedVersion(key, saved, source);
      }
      return true;
    };

    /** One save of `snapshot.content`, recovering from a stale version. */
    const runSave = async (snapshot: SaveSnapshot): Promise<boolean> => {
      const { key } = snapshot;
      let saved: PortalFilePreview;
      try {
        saved = await client.command('file.save', {
          ...snapshot.request,
          content: snapshot.content,
          expectedVersion: snapshot.base.version,
          expectedModifiedAtMs: previewMtimeMs(snapshot.base),
        });
      } catch (error) {
        // A close (and possible reopen) during the write invalidates it.
        if (isStale(snapshot)) return false;
        if (isFileSaveConflictError(error)) {
          return recoverFromStaleSave(snapshot);
        }
        // Leave content, preview, and mtime unchanged; keep dirty so a
        // retry re-sends the same confirmed mtime and a conflict stays
        // fail-closed until a fresh read/save advances it.
        patchFile(key, {
          status: 'error',
          error: errorMessage(error, 'Failed to save file.'),
          dirty: true,
        });
        return false;
      }
      // The session may have been closed (and possibly reopened) while the
      // write was in flight; a stale completion must not patch the
      // replacement session.
      if (isStale(snapshot)) return true;
      applySavedSnapshot(key, saved, snapshot.content);
      return true;
    };

    /**
     * Register a save-like write as the key's in-flight transaction so other
     * save entry points and recovery actions serialize behind it.
     */
    const runTransaction = (
      key: string,
      generation: number,
      work: () => Promise<boolean>,
    ): Promise<boolean> => {
      const transaction: { generation: number; promise: Promise<boolean> } = {
        generation,
        promise: Promise.resolve(false),
      };
      transaction.promise = (async (): Promise<boolean> => {
        try {
          return await work();
        } finally {
          if (
            currentGeneration(key) === generation &&
            pendingInvalidations.has(key)
          ) {
            const current = get().files[key];
            if (current && !current.saveConflict) {
              patchFile(key, {
                baselineStale: true,
                externalChange: current.externalChange ?? {
                  reloading: false,
                  error: null,
                },
                combinableChange: null,
              });
            }
          }
          if (inFlightSaves.get(key) === transaction) {
            inFlightSaves.delete(key);
          }
          // A write reported during the save waits for it; neither success
          // nor failure may drop that invalidation.
          if (currentGeneration(key) === generation) {
            flushPendingInvalidation(key);
          }
        }
      })();
      inFlightSaves.set(key, transaction);
      return transaction.promise;
    };

    /** A committed write counts as saved only when the buffer is clean. */
    const savedAndClean = (
      key: string,
      generation: number,
      committed: boolean,
    ): boolean =>
      committed &&
      (currentGeneration(key) !== generation ||
        get().files[key]?.dirty !== true);

    // Agent-edit subscription lifecycle (CLIENT_STORE_ACTIVATE/DISPOSE): one
    // `chat.message` subscription per provider-scoped store. Completions in
    // messages older than activation (minus clock-skew tolerance) are
    // transcript history, not fresh writes.
    let unsubscribeChat: (() => void) | null = null;
    let editTracker: AgentFileEditTracker | null = null;
    lifecycle.activate = (): void => {
      if (unsubscribeChat) return;
      const tracker = createAgentFileEditTracker({
        notBeforeMs: Date.now() - AGENT_EDIT_REPLAY_TOLERANCE_MS,
      });
      editTracker = tracker;
      unsubscribeChat = client.subscribe('chat.message', (event) => {
        if (!event.message.parts?.length) return;
        // Keep bounded use/result correlation even before a file opens: a
        // session may open while the agent's write is still running.
        const edits = tracker.ingest(event);
        if (edits.length === 0) return;
        const state = get();
        if (Object.keys(state.files).length === 0) return;
        for (const edit of edits) state.notifyFileChanged(edit);
      });
    };
    lifecycle.dispose = (): void => {
      unsubscribeChat?.();
      unsubscribeChat = null;
      editTracker?.clear();
      editTracker = null;
      // Late reads and saves must not apply after disposal.
      for (const session of Object.values(get().files)) {
        invalidateGeneration(session.key);
        patchFile(session.key, {
          status:
            session.status === 'loading' || session.status === 'saving'
              ? 'idle'
              : session.status,
          externalChange: session.externalChange
            ? { ...session.externalChange, reloading: false }
            : null,
          saveConflict: session.saveConflict
            ? { ...session.saveConflict, resolving: null }
            : null,
        });
      }
      readsInFlight.clear();
      inFlightSaves.clear();
      bufferRevisions.clear();
      pendingInvalidations.clear();
      pendingSources.clear();
      attributions.clear();
      latestReadTokens.clear();
      liveOverlapTokens.clear();
      deferredOverlaps.clear();
      rejectedOverlaps.clear();
    };

    return {
      files: {},
      diffs: {},
      activeFileKey: null,
      activeDiffKey: null,
      canEdit,

      async openFile(request): Promise<string> {
        const key = fileViewerKey(request);
        const existing = get().files[key];
        const sessionCapabilities =
          client.capabilitiesFor?.(request.projectId) ?? client.capabilities;
        const sessionCanEdit =
          sessionCapabilities.fileSystemAccess === 'read-write';
        // Re-opening a session with an in-flight read or save just focuses
        // it: re-reading would duplicate work or drop the 'saving' sentinel
        // (and let the save's post-resolve write win a race). A read in
        // flight is awaited, so the open resolves with current content.
        // Unsaved edits are never replaced; an explicit open only checks
        // disk for them.
        if (
          existing &&
          (existing.dirty ||
            existing.status === 'loading' ||
            existing.status === 'saving' ||
            readsInFlight.has(key))
        ) {
          patchFile(key, { canEdit: sessionCanEdit });
          set({ activeFileKey: key });
          if (existing.status === 'saving') {
            queueInvalidation(key, 'unknown');
          } else if (readsInFlight.has(key)) {
            await settleReadsInFlight(key);
          } else if (existing.dirty) {
            await readSession(key, 'refresh');
          }
          return key;
        }
        set((state) => {
          const prev = state.files[key];
          const session: FileViewerSession = prev
            ? {
                ...prev,
                status: 'loading',
                error: null,
                canEdit: sessionCanEdit,
              }
            : {
                key,
                generation: currentGeneration(key),
                request,
                preview: null,
                content: '',
                dirty: false,
                // Newly created sessions default to the rendered view; hosts
                // that persist a per-tab mode (desktop) pass a controlled
                // `viewMode` prop that overrides this, and FileViewer forces
                // raw for kinds with no preview and normalizes CSV to 'table'.
                viewMode: 'preview',
                status: 'loading',
                error: null,
                canEdit: sessionCanEdit,
                externalChange: null,
                baselineStale: false,
                reloadRevision: 0,
                bufferRevision: 0,
                saveConflict: null,
                savedMerge: null,
                combinableChange: null,
              };
          return {
            files: { ...state.files, [key]: session },
            activeFileKey: key,
          };
        });
        await readSession(key, 'open');
        return key;
      },

      updateContent(key, content): void {
        const prev = get().files[key];
        if (!prev) {
          return;
        }
        // Clear a stale save error the moment the buffer actually changes so the
        // editor stops showing a previous failure against the new draft. An
        // active `saving` sentinel is preserved (a concurrent write continues).
        const contentChanged = content !== prev.content;
        if (contentChanged) {
          bufferRevisions.set(key, (bufferRevisions.get(key) ?? 0) + 1);
        }
        const clearError = contentChanged && prev.status === 'error';
        const dirty = content !== (prev.preview?.content ?? '');
        // Typing can turn a combinable change into an overlap and back; the
        // save-time check still decides, so only the explanation follows.
        const latest = latestVersions.get(key);
        const recheck =
          dirty &&
          contentChanged &&
          latest !== undefined &&
          latest.base === prev.preview &&
          !prev.externalChange &&
          !prev.saveConflict;
        const combinableChange = !dirty
          ? null
          : recheck
            ? savesCombine(latest.base, content, latest.latest)
              ? combinableChangeFor(
                  prev.combinableChange,
                  latest.latest.version,
                  latest.source,
                )
              : null
            : (prev.combinableChange ?? null);
        patchFile(key, {
          content,
          dirty,
          bufferRevision: bufferRevisions.get(key) ?? 0,
          combinableChange,
          ...(clearError ? { status: 'idle', error: null } : {}),
        });
        // Typing retires the shown comparison's token at once, then compares
        // the new buffer with the same newer version: unchanged passages keep
        // their choice, edited ones need a new one, and a buffer that no
        // longer overlaps settles into that version. Undo back to the
        // baseline re-checks disk below instead.
        if (prev.overlap && contentChanged && !dirty) {
          clearOverlapState(key);
          patchFile(key, { overlap: null });
        } else if (prev.overlap && contentChanged) {
          const outcome = analyzeOverlap(
            key,
            prev.preview,
            content,
            prev.overlap.latest,
            prev.overlap,
          );
          if (outcome.kind === 'clean' && prev.externalChange?.reloading) {
            // Typing cancels the reload without adopting the older comparison.
            // The pending read still owns the newer version and recovery.
            clearOverlapState(key);
            patchFile(key, { overlap: null });
          } else if (outcome.kind === 'clean') {
            adoptLatestWith(key, outcome.content, prev.overlap.latest);
          } else if (outcome.kind === 'conflicts') {
            patchFile(key, { overlap: outcome.comparison });
            // Typing can remove the last undecided region while every
            // remaining passage still has valid consent. Apply those choices
            // through the same final-resolution path as a button activation.
            if (outcome.comparison.choices.every((entry) => entry !== null)) {
              const choice = outcome.comparison.choices[0];
              if (choice != null) {
                get().chooseOverlapVersion(
                  key,
                  outcome.comparison.token,
                  0,
                  choice,
                );
              }
            }
          } else {
            clearOverlapState(key);
            patchFile(key, { overlap: null });
            if (prev.saveConflict)
              patchConflict(key, { reason: 'merge-skipped' });
          }
          return;
        }
        // Undo can return to a baseline already known to be stale. Re-check
        // it without activating the file; retain recovery until it succeeds.
        // A save conflict has nothing left to save once the buffer is clean.
        if (
          prev.dirty &&
          !dirty &&
          (prev.externalChange ||
            prev.saveConflict ||
            prev.baselineStale === true ||
            baselineKnownStale(prev))
        ) {
          if (prev.saveConflict) patchFile(key, { saveConflict: null });
          if (!prev.externalChange) {
            patchFile(key, {
              externalChange: { reloading: false, error: null },
            });
          }
          get().markFileChanged(key, 'unknown');
        }
      },

      async saveFile(key, options): Promise<boolean> {
        const origin = options?.origin ?? 'user';
        const session = get().files[key];
        if (!session) {
          return false;
        }
        // A clean session has nothing to persist; report success without a
        // command so no redundant write follows a just-completed save.
        if (!session.dirty) {
          return true;
        }
        if (!session.canEdit) {
          patchFile(key, {
            status: 'error',
            error: 'File editing is not available on this host.',
          });
          return false;
        }
        if (origin === 'autosave' && deferredOverlaps.has(key)) return false;
        // An unresolved comparison pauses autosave. An explicit save turns a
        // comparison shown before saving into the save-time one, keeping its
        // choices, without writing: the versions are already known to overlap.
        if (session.overlap && !session.saveConflict) {
          if (origin === 'user') {
            setConflict(key, {
              reason: 'overlap',
              latest: session.overlap.latest,
              origin,
              focus: true,
              source: session.externalChange?.source ?? null,
              comparison: session.overlap,
            });
          }
          return false;
        }
        // A pending conflict waits for an explicit choice: an explicit save
        // re-exposes the notice without restarting the merge or implying
        // overwrite consent, and autosave never retries it.
        if (session.saveConflict) {
          if (origin === 'user') {
            patchConflict(key, {
              focusRequest: session.saveConflict.focusRequest + 1,
            });
          }
          return false;
        }

        // Share one physical write across concurrent callers for this key. A
        // later caller awaits the active transaction and — only if newer content
        // is still dirty when it settles and the session was not closed —
        // initiates at most one follow-up save.
        const active = inFlightSaves.get(key);
        if (active) {
          return active.promise.then((ok) => {
            if (!ok) {
              const conflict = get().files[key]?.saveConflict;
              if (
                origin === 'user' &&
                currentGeneration(key) === active.generation &&
                conflict
              ) {
                patchConflict(key, { focusRequest: conflict.focusRequest + 1 });
              }
              return false;
            }
            const latest = get().files[key];
            if (
              latest &&
              latest.dirty &&
              currentGeneration(key) === active.generation
            ) {
              return get().saveFile(key, options);
            }
            return true;
          });
        }

        // Fail closed: an editable dirty session without a parseable confirmed
        // mtime must not issue an unversioned write, which could silently
        // overwrite an external edit. Retain the buffer and surface guidance.
        const base = session.preview;
        if (base === null || Number.isNaN(previewMtimeMs(base))) {
          patchFile(key, {
            status: 'error',
            error:
              'Unable to save because the file version is unavailable. Reopen the file and try again.',
          });
          return false;
        }
        const generation = currentGeneration(key);
        const snapshot: SaveSnapshot = {
          key,
          request: session.request,
          base,
          content: session.content,
          generation,
          bufferRevision: bufferRevisions.get(key) ?? 0,
          origin,
        };

        saveEpochs.set(key, currentSaveEpoch(key) + 1);

        // A superseded read's unchecked write must survive either Save result.
        if (readsInFlight.get(key) === true) pendingInvalidations.add(key);
        // A read in flight can no longer apply; a later open starts fresh.
        readsInFlight.delete(key);
        patchFile(key, { status: 'saving', error: null });

        const committed = await runTransaction(key, generation, () =>
          runSave(snapshot),
        );
        return savedAndClean(key, generation, committed);
      },

      discardEdits(key): void {
        const prev = get().files[key];
        // Discarding during a save would drop edits the save is writing and
        // could not start the read a stale baseline needs.
        if (!prev || prev.status === 'saving') {
          return;
        }
        if (prev.saveConflict) {
          void get().reloadFromDisk(key);
          return;
        }
        bufferRevisions.set(key, (bufferRevisions.get(key) ?? 0) + 1);
        const content = prev.preview?.content ?? '';
        clearOverlapState(key);
        deferredOverlaps.delete(key);
        if (prev.overlap) patchFile(key, { overlap: null });
        if (
          !prev.externalChange &&
          !prev.saveConflict &&
          prev.baselineStale !== true &&
          !baselineKnownStale(prev)
        ) {
          patchFile(key, {
            content,
            dirty: false,
            status: 'idle',
            error: null,
            externalChange: null,
            saveConflict: null,
            combinableChange: null,
            bufferRevision: bufferRevisions.get(key) ?? 0,
          });
          return;
        }
        // Discard drops the draft, but keeps recovery and errors until the
        // latest disk version is read successfully. Typing during that read wins.
        patchFile(key, {
          content,
          dirty: false,
          combinableChange: null,
          bufferRevision: bufferRevisions.get(key) ?? 0,
        });
        void get().reloadFromDisk(key);
      },

      setViewMode(key, viewMode): void {
        patchFile(key, { viewMode });
      },

      closeFile(key): void {
        // Invalidate any in-flight read/save so a late completion cannot
        // repopulate or patch a session reopened under the same key, and drop
        // the dedup entry so a reopened session starts a fresh transaction.
        invalidateGeneration(key);
        inFlightSaves.delete(key);
        latestReadTokens.delete(key);
        saveEpochs.delete(key);
        readsInFlight.delete(key);
        pendingInvalidations.delete(key);
        pendingSources.delete(key);
        bufferRevisions.delete(key);
        staleBaselines.delete(key);
        latestVersions.delete(key);
        attributions.delete(key);
        liveOverlapTokens.delete(key);
        deferredOverlaps.delete(key);
        rejectedOverlaps.delete(key);
        set((state) => {
          if (!(key in state.files)) {
            return state;
          }
          const files = { ...state.files };
          delete files[key];
          return {
            files,
            activeFileKey:
              state.activeFileKey === key ? null : state.activeFileKey,
          };
        });
      },

      renamePath(from, toRelativePath): ReadonlySet<string> {
        const root = fileViewerKey({ ...from, relativePath: '' });
        const prefix = `${from.relativePath}/`;
        const files = { ...get().files };
        const moved = new Map<string, string>();
        // Each per-key record follows its session, so a moved draft keeps the
        // baseline it was edited from and any conflict or overlap it showed.
        const move = <V>(map: Map<string, V>, at: string, to: string): void => {
          const value = map.get(at);
          if (value === undefined) return;
          map.delete(at);
          map.set(to, value);
        };
        for (const session of Object.values(get().files)) {
          const path = session.request.relativePath;
          if (
            fileViewerKey({ ...session.request, relativePath: '' }) !== root ||
            (path !== from.relativePath && !path.startsWith(prefix)) ||
            // A read or write in flight still targets the old path.
            session.status === 'loading' ||
            session.status === 'saving' ||
            readsInFlight.has(session.key) ||
            inFlightSaves.has(session.key) ||
            latestReads.has(session.key) ||
            // So is a save-conflict recovery's read.
            (session.saveConflict?.resolving ?? null) !== null
          )
            continue;
          const relativePath =
            toRelativePath + path.slice(from.relativePath.length);
          const request = { ...session.request, relativePath };
          const key = fileViewerKey(request);
          // Never overwrite a session already open at the new path.
          if (files[key] !== undefined) continue;
          move(generations, session.key, key);
          move(latestReadTokens, session.key, key);
          move(saveEpochs, session.key, key);
          move(pendingSources, session.key, key);
          move(bufferRevisions, session.key, key);
          move(staleBaselines, session.key, key);
          move(latestVersions, session.key, key);
          move(attributions, session.key, key);
          move(liveOverlapTokens, session.key, key);
          move(deferredOverlaps, session.key, key);
          move(rejectedOverlaps, session.key, key);
          if (pendingInvalidations.delete(session.key))
            pendingInvalidations.add(key);
          const old = session.preview;
          const preview =
            old?.path.endsWith(path) === true
              ? {
                  ...old,
                  path:
                    old.path.slice(0, old.path.length - path.length) +
                    relativePath,
                }
              : old;
          // Baselines match by identity, so every record holding the old
          // preview must hold the new one, or the moved draft's stale,
          // overlap and combinable checks would stop matching.
          const rebase = <V extends { readonly base: PortalFilePreview }>(
            value: V,
          ): V =>
            preview !== null && value.base === old
              ? { ...value, base: preview }
              : value;
          if (preview !== null && staleBaselines.get(key) === old)
            staleBaselines.set(key, preview);
          const latest = latestVersions.get(key);
          if (latest !== undefined) latestVersions.set(key, rebase(latest));
          const rejected = rejectedOverlaps.get(key);
          if (rejected !== undefined)
            rejectedOverlaps.set(key, rebase(rejected));
          delete files[session.key];
          files[key] = {
            ...session,
            key,
            request,
            preview,
            overlap: session.overlap
              ? rebase(session.overlap)
              : session.overlap,
          };
          moved.set(session.key, key);
        }
        if (moved.size === 0) return new Set();
        set((state) => ({
          files,
          activeFileKey:
            state.activeFileKey === null
              ? null
              : (moved.get(state.activeFileKey) ?? state.activeFileKey),
        }));
        return new Set(moved.keys());
      },

      async refreshFile(key): Promise<void> {
        const session = get().files[key];
        if (!session) return;
        // An in-flight read already reflects this request; a save settles
        // first and then re-checks.
        if (session.status === 'saving') {
          queueInvalidation(key, 'unknown');
          return;
        }
        if (session.status === 'loading' || readsInFlight.has(key)) return;
        await readSession(key, 'refresh');
      },

      markFileChanged(key, source = 'unknown'): void {
        const session = get().files[key];
        if (!session) return;
        if (
          session.status === 'saving' ||
          session.status === 'loading' ||
          readsInFlight.has(key)
        ) {
          queueInvalidation(key, source);
          return;
        }
        void readSession(key, 'refresh', source);
      },

      async reloadFromDisk(key): Promise<boolean> {
        const session = get().files[key];
        if (
          !session ||
          session.status === 'saving' ||
          session.externalChange?.reloading === true ||
          (session.saveConflict != null &&
            session.saveConflict.resolving !== null)
        ) {
          return false;
        }
        bufferRevisions.set(key, (bufferRevisions.get(key) ?? 0) + 1);
        patchFile(key, {
          bufferRevision: bufferRevisions.get(key) ?? 0,
          combinableChange: null,
        });
        // Always read fresh content; never show a cached conflict version.
        if (session.saveConflict) {
          patchConflict(key, { resolving: 'reload', error: null });
        } else {
          patchFile(key, {
            externalChange: {
              reloading: true,
              error: null,
              source:
                session.externalChange?.source ??
                session.combinableChange?.source ??
                null,
            },
          });
        }
        return readSession(key, 'reload');
      },

      async overwriteWithEdits(key): Promise<boolean> {
        const session = get().files[key];
        const conflict = session?.saveConflict;
        if (
          !session ||
          !conflict ||
          conflict.resolving !== null ||
          session.status === 'saving' ||
          inFlightSaves.has(key)
        ) {
          return false;
        }
        const generation = currentGeneration(key);
        const latest = conflict.latest;
        if (latest === null || !isCompleteTextVersion(latest)) {
          // Expose the version first; replacing it takes another activation.
          patchConflict(key, { resolving: 'overwrite', error: null });
          const fetched = await readLatest(session.request);
          if (currentGeneration(key) !== generation) return false;
          if (fetched === null || !isCompleteTextVersion(fetched)) {
            patchConflict(key, {
              resolving: null,
              error: { kind: 'latest-unavailable' },
            });
            return false;
          }
          patchConflict(key, {
            resolving: null,
            reason: 'changed-again',
            latest: fetched,
            source: sourceForVersion(key, fetched.version),
          });
          return false;
        }
        const snapshotContent = session.content;
        saveEpochs.set(key, currentSaveEpoch(key) + 1);
        readsInFlight.delete(key);
        patchFile(key, {
          status: 'saving',
          error: null,
          saveConflict: { ...conflict, resolving: 'overwrite', error: null },
        });
        const stale = (): boolean =>
          currentGeneration(key) !== generation || !get().files[key];
        const committed = await runTransaction(
          key,
          generation,
          async (): Promise<boolean> => {
            let saved: PortalFilePreview;
            try {
              // Conditional on the version the notice represents: consent
              // covers that version only, never a newer one.
              saved = await client.command('file.save', {
                ...session.request,
                content: snapshotContent,
                expectedVersion: latest.version,
                expectedModifiedAtMs: previewMtimeMs(latest),
              });
            } catch (error) {
              if (stale()) return false;
              if (isFileSaveConflictError(error)) {
                const newer = await readLatest(session.request);
                if (stale()) return false;
                settleChangedAgain(key, newer, conflict.origin, false);
                return false;
              }
              patchFile(key, { status: 'idle' });
              patchConflict(key, {
                resolving: null,
                error: {
                  kind: 'save-failed',
                  message: errorMessage(error, 'Failed to save file.'),
                },
              });
              return false;
            }
            if (stale()) return true;
            applySavedSnapshot(key, saved, snapshotContent);
            return true;
          },
        );
        return savedAndClean(key, generation, committed);
      },

      dismissExternalChange(key): void {
        const session = get().files[key];
        if (!session?.externalChange || session.externalChange.reloading) {
          return;
        }
        if (session.overlap) {
          deferredOverlaps.set(key, session.overlap.latest.version);
          clearOverlapState(key);
        }
        const latest = latestVersions.get(key);
        patchFile(key, {
          externalChange: null,
          overlap: null,
          combinableChange:
            session.dirty &&
            !session.saveConflict &&
            latest !== undefined &&
            latest.base === session.preview &&
            savesCombine(latest.base, session.content, latest.latest)
              ? combinableChangeFor(
                  session.combinableChange,
                  latest.latest.version,
                  latest.source,
                )
              : null,
        });
      },

      chooseOverlapVersion(key, token, passageIndex, choice): void {
        const session = get().files[key];
        const overlap = session?.overlap;
        if (
          !session ||
          !overlap ||
          overlap.token !== token ||
          (choice !== 'ours' && choice !== 'theirs') ||
          !Number.isInteger(passageIndex) ||
          passageIndex < 0 ||
          passageIndex >= overlap.regions.length ||
          session.status === 'saving' ||
          inFlightSaves.has(key) ||
          session.externalChange?.reloading === true ||
          (session.saveConflict != null &&
            session.saveConflict.resolving !== null) ||
          !overlapIsCurrent(session, overlap)
        ) {
          return;
        }
        const choices = overlap.choices.map((previous, index) =>
          index === passageIndex ? choice : previous,
        );
        const complete = choices.filter(
          (entry): entry is OverlapChoice => entry !== null,
        );
        // A partial choice records intent only; the buffer is untouched.
        if (complete.length !== choices.length) {
          patchFile(key, { overlap: { ...overlap, choices } });
          return;
        }
        const resolution = resolveOverlaps(
          overlap.base.content,
          overlap.ours,
          overlap.latest.content,
          complete,
        );
        if (resolution.kind === 'resolved') {
          adoptLatestWith(key, resolution.content, overlap.latest);
          return;
        }
        if (resolution.kind === 'invalid') {
          // The snapshot no longer yields these passages: compare again and
          // ask for fresh choices.
          const outcome = analyzeOverlap(
            key,
            session.preview,
            session.content,
            overlap.latest,
            null,
          );
          if (outcome.kind === 'conflicts') {
            patchFile(key, { overlap: outcome.comparison });
            return;
          }
          if (outcome.kind === 'clean') {
            adoptLatestWith(key, outcome.content, overlap.latest);
            return;
          }
        }
        // The combined result cannot be produced: whole-document recovery.
        rejectedOverlaps.set(key, overlap);
        clearOverlapState(key);
        if (session.saveConflict) {
          patchFile(key, {
            overlap: null,
            saveConflict: { ...session.saveConflict, reason: 'merge-skipped' },
          });
        } else {
          patchFile(key, { overlap: null });
        }
      },

      notifyFileChanged(edit): void {
        const sessions = Object.values(get().files).filter(
          (session) =>
            edit.scope.projectIds.includes(session.request.projectId) &&
            edit.scope.worktreeIds.includes(session.request.worktreeId) &&
            (edit.scope.fileRootLocalId === undefined ||
              session.request.fileRootLocalId === edit.scope.fileRootLocalId) &&
            (edit.scope.fileRootLocalId !== undefined ||
              edit.scope.repoId === undefined ||
              (session.request.fileRootLocalId === undefined &&
                session.request.repoId === edit.scope.repoId)),
        );
        if (sessions.length === 0) return;
        const keys = new Set<string>();
        for (const rawPath of edit.paths) {
          const target = normalizeEditPath(rawPath);
          if (!target) continue;
          const matches = sessions.filter((session) =>
            editPathMatchesRelativePath(target, session.request.relativePath),
          );
          if (matches.length === 0) continue;
          // Suffix fallback is safe only for one root/path identity. Several
          // sessions for that identity may all refresh; distinct roots skip.
          const identities = new Set(
            matches.map((session) => {
              const path =
                normalizeEditPath(session.request.relativePath)?.path ?? '';
              return JSON.stringify([
                session.request.fileRootLocalId ?? session.request.repoId ?? '',
                target.caseInsensitive ? path.toLowerCase() : path,
              ]);
            }),
          );
          if (identities.size !== 1) continue;
          for (const session of matches) keys.add(session.key);
        }
        keys.forEach((key) => get().markFileChanged(key, 'agent-edit'));
      },

      async openDiff(request): Promise<string> {
        const key = diffViewerKey(request);
        set((state) => ({
          diffs: {
            ...state.diffs,
            [key]: {
              key,
              request,
              diff: state.diffs[key]?.diff ?? null,
              status: 'loading',
              error: null,
            },
          },
          activeDiffKey: key,
        }));
        try {
          const diff = await client.query('diff.read', request);
          set((state) => {
            const prev = state.diffs[key];
            if (!prev) {
              return state;
            }
            return {
              diffs: {
                ...state.diffs,
                [key]: { ...prev, diff, status: 'idle', error: null },
              },
            };
          });
        } catch (error) {
          set((state) => {
            const prev = state.diffs[key];
            if (!prev) {
              return state;
            }
            return {
              diffs: {
                ...state.diffs,
                [key]: {
                  ...prev,
                  status: 'error',
                  error: errorMessage(error, 'Failed to read diff.'),
                },
              },
            };
          });
        }
        return key;
      },

      closeDiff(key): void {
        set((state) => {
          if (!(key in state.diffs)) {
            return state;
          }
          const diffs = { ...state.diffs };
          delete diffs[key];
          return {
            diffs,
            activeDiffKey:
              state.activeDiffKey === key ? null : state.activeDiffKey,
          };
        });
      },
    };
  };
  const store: ClientStore<FileViewerState> =
    create<FileViewerState>(createState);
  store[CLIENT_STORE_ACTIVATE] = (): void => lifecycle.activate();
  store[CLIENT_STORE_DISPOSE] = (): void => lifecycle.dispose();
  return store;
}

/**
 * Single private symbol backing BOTH file-viewer hooks so they always resolve
 * the same provider-scoped store instance. Registering under a second symbol
 * (or a second `createClientStore`/`useCanopyClientStore` call) would mint a
 * distinct store and split ownership of the file buffer — the exact failure
 * mode CAN-1426 exists to prevent.
 */
const fileViewerStoreKey = Symbol('file-viewer-store');

/**
 * Provider-bound imperative handle to the shared file/diff viewer store. The
 * desktop session controller attaches this exact instance so shortcuts,
 * autosave, and close guards operate on the same buffer the FileViewer edits.
 * Returns `ClientStore<FileViewerState>` (a `UseBoundStore<StoreApi<...>>`),
 * which satisfies the controller's `attachStore(store: StoreApi<...>)`.
 */
export function useFileViewerStoreApi(): ClientStore<FileViewerState> {
  return useCanopyClientStore<FileViewerState>(
    fileViewerStoreKey,
    createFileViewerStore,
  );
}

/**
 * Selector hook for the shared file/diff viewer store, bound to the ambient
 * {@link CanopyClient} from `CanopyClientProvider`. Derived from
 * {@link useFileViewerStoreApi} so the two hooks can never resolve different
 * store instances.
 */
export function useFileViewerStore<TSelected>(
  selector: (state: FileViewerState) => TSelected,
): TSelected {
  return useFileViewerStoreApi()(selector);
}
