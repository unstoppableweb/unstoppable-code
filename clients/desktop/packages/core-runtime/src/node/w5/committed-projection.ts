// Explicit commit-log modules only: the commit-log index loads node:sqlite.
import {
  freezeW5Capture,
  W5_CAPTURE_LIMITS,
  type W5CaptureFile,
  type W5CaptureRequest,
  type W5CaptureResult,
  type W5FileChainEvidence,
  type W5FileImage,
  type W5FileLogEvidence,
} from './commit-log/capture-contract';
import type { W5Resource } from './commit-log/commit-log';
import {
  classifyW5FileProvenance,
  classifyW5RevisionEligibility,
  w5ResourceDependencies,
  type W5FileProvenance,
  type W5ProjectionCompleteness,
  type W5RevisionEligibility,
} from './commit-log/eligibility';
import { classifyW5CommitFile } from './commit-events';
import type { W5StoreDecision } from './commit-log-file-store';

/*
 * The per-workspace read cache's host-neutral projection (CAN-7155, W5
 * readers S-9): the W5 files (index, manifests, worktree lists) as their last
 * capture or this process's own commit left them, each current as of a commit
 * id. TRANSITIONAL compatibility path, in-process only: W10 (CAN-7153)
 * replaces it with a core-owned read model. Until a reader is switched onto it
 * (CAN-7155 PRs 3-4) it is never consulted.
 *
 * Classification reuses `eligibility.ts` unchanged: each entry keeps its file's
 * slice of the capture it came from as a frozen one-file capture, so a cached
 * answer is the answer a fresh capture of the same position gives.
 *
 * Two log-wide facts outlive any one file's slice, so the projection keeps
 * them beside the entries: an abandoned commit (permanent; it makes every
 * file `abandoned-history`) and the newest unresolved count (any unresolved
 * commit makes every label `pending`). One projection serves one log: a new
 * log epoch needs a new projection.
 */

/**
 * - `current`: image and evidence are as of `commitId`.
 * - `verifying`: the image is trusted, but its evidence predates a commit
 *   (an own commit, or one that advanced a resource it supports).
 * - `dirty`: the image may be stale; nothing is served until a capture
 *   settles it.
 */
export type W5ProjectionEntryState = 'current' | 'verifying' | 'dirty';

export interface W5ProjectionInstallOptions {
  /** `ticket()` read before the capture was requested. */
  readonly ticket: number;
  /** The projection's own refill: may replace an image at an equal commit id. */
  readonly authoritative?: boolean;
}

export interface W5CommittedProjection {
  /** The mark generation; pass it with a capture requested now. */
  ticket(): number;
  installCapture(
    capture: W5CaptureResult,
    options: W5ProjectionInstallOptions,
  ): void;
  /** One decision this process's store made under `root`, before its lock releases. */
  noteOwnDecision(root: string, decision: W5StoreDecision): void;
  /**
   * Stops serving files a capture could not settle; only a capture requested
   * after this call settles them. `hold` also starts holding a file without
   * an entry, so no capture requested earlier installs it.
   */
  markDirty(
    files: readonly W5CaptureFile[],
    options?: { readonly hold?: boolean },
  ): void;
  /** Every file the projection holds an entry for. */
  files(): W5CaptureFile[];
  state(file: W5CaptureFile): W5ProjectionEntryState | undefined;
  /** The commit id the file's image is current as of. */
  commitId(file: W5CaptureFile): number | undefined;
  /**
   * The file is current as of `commitId` or later, from a capture that left
   * no commit unresolved: a capture of it now would show the same bytes.
   */
  holds(file: W5CaptureFile, commitId: number): boolean;
  /** The frozen image of a current or verifying file. */
  image(file: W5CaptureFile): W5FileImage | undefined;
  /** A current file's provenance; undefined means capture instead. */
  provenance(file: W5CaptureFile): W5FileProvenance | undefined;
  /** As `classifyW5RevisionEligibility`; undefined means capture instead. */
  eligibility(
    resource: W5Resource,
    completeness: W5ProjectionCompleteness,
  ): W5RevisionEligibility | undefined;
  /**
   * Files a refill should capture: marked, or served with unresolved commits.
   * Files whose keys are in `skip` are left out.
   */
  refillPlan(skip?: ReadonlySet<string>): W5CaptureRequest | null;
  /** One coalesced refill: joins the next run when one is already in flight. */
  refill(
    capture: (request: W5CaptureRequest) => Promise<W5CaptureResult>,
  ): Promise<void>;
}

interface Entry {
  readonly file: W5CaptureFile;
  /** Null only for a dirty file never captured. */
  readonly image: W5FileImage | null;
  readonly commitId: number;
  /** A frozen one-file capture; null until a capture classified the image. */
  readonly evidence: W5CaptureResult | null;
  readonly state: W5ProjectionEntryState;
  /** A marked entry settles only from a capture at or after this commit id. */
  readonly required: number;
  /** A marked entry settles only from a capture requested at or after this generation. */
  readonly markedAt: number;
}

export function w5ProjectionFileKey(file: W5CaptureFile): string {
  return 'workspaceId' in file ? `${file.kind}:${file.workspaceId}` : file.kind;
}

function copyFile(file: W5CaptureFile): W5CaptureFile {
  return 'workspaceId' in file
    ? { kind: file.kind, workspaceId: file.workspaceId }
    : { kind: file.kind };
}

function sameBytes(a: W5FileImage | null, b: W5FileImage): boolean {
  if (!a || a.state !== b.state) return false;
  if (a.state === 'present' && b.state === 'present')
    return a.base64 === b.base64;
  if (a.state === 'unreadable' && b.state === 'unreadable')
    return a.reason === b.reason;
  return true;
}

/** The written contents as the capture would read them back. */
function writtenImage(
  file: W5CaptureFile,
  contents: string | null,
): W5FileImage {
  const image: W5FileImage =
    contents === null
      ? { ...copyFile(file), state: 'absent' }
      : {
          ...copyFile(file),
          state: 'present',
          base64: Buffer.from(contents, 'utf8').toString('base64'),
        };
  return Object.freeze(image);
}

/**
 * Each revision key by the file keys whose selector captures it, as
 * `captureEvidence` selects them: one pass over a capture's revisions.
 */
function revisionsByFile(
  revisions: Readonly<Record<string, number>>,
): Map<string, Record<string, number>> {
  const byFile = new Map<string, Record<string, number>>();
  const add = (fileKey: string, key: string, revision: number): void => {
    const owned = byFile.get(fileKey) ?? {};
    owned[key] = revision;
    byFile.set(fileKey, owned);
  };
  for (const [key, revision] of Object.entries(revisions)) {
    if (key === 'workspaces') {
      add('index', key, revision);
      add('index-backup', key, revision);
    } else if (key.startsWith('workspace:'))
      add(`manifest:${key.slice('workspace:'.length)}`, key, revision);
    else if (key.startsWith('worktrees:'))
      add(`worktrees:${key.slice('worktrees:'.length)}`, key, revision);
    else if (key.startsWith('worktree:')) {
      const slash = key.indexOf('/', 'worktree:'.length);
      if (slash > 0)
        add(`worktrees:${key.slice('worktree:'.length, slash)}`, key, revision);
    }
  }
  return byFile;
}

/** The resource whose revision a dependency set's last file carries. */
function revisionOwner(resource: W5Resource): W5CaptureFile {
  const dependencies = w5ResourceDependencies(resource);
  const owner = dependencies[dependencies.length - 1];
  if (!owner) throw new Error('A W5 resource has no dependency');
  return owner;
}

function isAbandoned(capture: W5CaptureResult): boolean {
  return capture.log.retainedCommits !== capture.log.commitId;
}

const PENDING: W5RevisionEligibility = Object.freeze({
  status: 'unverified',
  reason: 'pending',
});

/** An entry whose evidence may predate a log-wide change; its image stands. */
function evidenceStale(entry: Entry, markedAt: number): Entry {
  return entry.state === 'current'
    ? { ...entry, state: 'verifying', required: entry.commitId, markedAt }
    : { ...entry, markedAt: Math.max(entry.markedAt, markedAt) };
}

export function createW5CommittedProjection(): W5CommittedProjection {
  const entries = new Map<string, Entry>();
  let generation = 0;
  // Abandonment is permanent, so once seen no unabandoned evidence is current.
  let abandoned = false;
  // The newest position's unresolved count; at one position it only falls.
  let newest = { commitId: 0, unresolved: 0 };
  const noteLog = (commitId: number, unresolved: number): void => {
    if (commitId > newest.commitId) newest = { commitId, unresolved };
    else if (commitId === newest.commitId)
      newest = {
        commitId,
        unresolved: Math.min(newest.unresolved, unresolved),
      };
  };
  const learnAbandoned = (): void => {
    if (abandoned) return;
    abandoned = true;
    for (const [key, entry] of entries)
      if (entry.evidence && !isAbandoned(entry.evidence))
        entries.set(key, evidenceStale(entry, 0));
  };
  const combined = new WeakMap<
    W5CaptureResult,
    WeakMap<W5CaptureResult, W5CaptureResult>
  >();

  /** Whether a captured image at `commitId` may replace `entry`. */
  const admits = (
    entry: Entry | undefined,
    image: W5FileImage,
    capture: W5CaptureResult,
    options: W5ProjectionInstallOptions,
  ): boolean => {
    const { commitId, unresolvedCommits: unresolved } = capture.log;
    // Unabandoned evidence after an abandonment predates it.
    if (abandoned && !isAbandoned(capture)) return false;
    if (!entry) return true;
    if (commitId < entry.commitId) return false;
    if (entry.state !== 'current') {
      if (commitId < entry.required || options.ticket < entry.markedAt)
        return false;
      if (commitId > entry.commitId || entry.state === 'dirty') return true;
    } else if (commitId > entry.commitId) return true;
    // Equal commit ids: the same bytes take the newer evidence, which only
    // resolves commits at one position; other bytes are an out-of-band edit
    // (Q7) only to an authoritative refill with nothing unresolved.
    if (sameBytes(entry.image, image))
      return (
        entry.evidence === null ||
        unresolved <= entry.evidence.log.unresolvedCommits
      );
    return options.authoritative === true && unresolved === 0;
  };

  const installCapture: W5CommittedProjection['installCapture'] = (
    capture,
    options,
  ) => {
    const { log } = capture;
    noteLog(log.commitId, log.unresolvedCommits);
    if (isAbandoned(capture)) learnAbandoned();
    const rows = new Map<string, W5FileLogEvidence[]>();
    for (const row of log.files) {
      const key = w5ProjectionFileKey(row.file);
      const list = rows.get(key) ?? [];
      list.push({ ...row, file: copyFile(row.file) });
      rows.set(key, list);
    }
    const seen = new Set<string>();
    let revisions: Map<string, Record<string, number>> | undefined;
    capture.files.forEach((captured, index) => {
      const file = copyFile(captured);
      const key = w5ProjectionFileKey(file);
      // The first image of a file is the one `eligibility.ts` classifies.
      if (seen.has(key)) return;
      seen.add(key);
      const aligned = log.chains[index];
      const chain: W5FileChainEvidence | undefined =
        aligned && w5ProjectionFileKey(aligned.file) === key
          ? aligned
          : log.chains.find((entry) => w5ProjectionFileKey(entry.file) === key);
      if (!chain) return;
      const entry = entries.get(key);
      if (!admits(entry, captured, capture, options)) return;
      revisions ??= revisionsByFile(log.revisions);
      const evidence = freezeW5Capture({
        files: [{ ...captured }],
        discovery: 'not-requested',
        log: {
          commitId: log.commitId,
          retainedCommits: log.retainedCommits,
          unresolvedCommits: log.unresolvedCommits,
          schemaVersion: log.schemaVersion,
          revisions: { ...revisions.get(key) },
          files: rows.get(key) ?? [],
          chains: [{ ...chain, file: copyFile(chain.file) }],
          resourceRevisionEligibility: 'unproven',
        },
      });
      const [image] = evidence.files;
      if (!image) return;
      entries.set(key, {
        file,
        image,
        commitId: log.commitId,
        evidence,
        state: 'current',
        required: log.commitId,
        markedAt: 0,
      });
    });
  };

  /**
   * Marks a file; `required` is the decision's commit id when known. Only a
   * named file without an entry gets one, so no stale capture installs it.
   */
  const mark = (
    file: W5CaptureFile,
    state: 'verifying' | 'dirty',
    required: number | undefined,
    named: boolean,
  ): void => {
    const key = w5ProjectionFileKey(file);
    const entry = entries.get(key);
    if (!entry && !named) return;
    if (entry && required !== undefined && entry.commitId > required) return;
    const nextState =
      state === 'verifying' && entry?.image && entry.state !== 'dirty'
        ? 'verifying'
        : 'dirty';
    entries.set(key, {
      file: copyFile(file),
      image: entry?.image ?? null,
      commitId: entry?.commitId ?? 0,
      evidence: entry?.evidence ?? null,
      state: nextState,
      required: Math.max(
        required ?? 0,
        entry?.commitId ?? 0,
        entry && entry.state !== 'current' ? entry.required : 0,
      ),
      markedAt: generation,
    });
  };

  const noteOwnDecision: W5CommittedProjection['noteOwnDecision'] = (
    root,
    { files, advance, outcome },
  ) => {
    generation += 1;
    const written: { file: W5CaptureFile; contents: string | null }[] = [];
    for (const { path, contents } of files) {
      const file = classifyW5CommitFile(root, path);
      if (file) written.push({ file, contents });
    }
    // Files whose evidence carries a revision this decision may have advanced.
    const supporting = advance.flatMap((resource) =>
      w5ResourceDependencies(resource),
    );
    // Log-wide effects reach files this decision never named.
    if (outcome.status === 'conflict') learnAbandoned();
    else if (
      outcome.status === 'recovery-required' &&
      outcome.commitId >= newest.commitId
    )
      newest = {
        commitId: outcome.commitId,
        unresolved: Math.max(1, newest.unresolved),
      };
    else if (outcome.status === 'failed' && outcome.maybeCommitted)
      // It may have left an unresolved or abandoned commit anywhere.
      for (const [key, entry] of entries)
        entries.set(key, evidenceStale(entry, generation));
    if (outcome.status !== 'applied') {
      const required =
        outcome.status === 'failed' ? undefined : outcome.commitId;
      for (const { file } of written) mark(file, 'dirty', required, true);
      for (const file of supporting) mark(file, 'dirty', required, false);
      return;
    }
    const { commitId } = outcome;
    for (const { file, contents } of written) {
      const key = w5ProjectionFileKey(file);
      const entry = entries.get(key);
      if (entry && entry.commitId > commitId) continue;
      const image = writtenImage(file, contents);
      // A capture already holds this position's bytes and their evidence.
      if (
        entry?.state === 'current' &&
        entry.commitId === commitId &&
        sameBytes(entry.image, image)
      )
        continue;
      // File provenance (pre-log, foreign preimage, abandoned history) is not
      // derivable from the outcome; one coalesced capture classifies it.
      entries.set(key, {
        file,
        image,
        commitId,
        evidence: null,
        state: 'verifying',
        required: commitId,
        markedAt: generation,
      });
    }
    const writtenKeys = new Set(
      written.map(({ file }) => w5ProjectionFileKey(file)),
    );
    for (const file of supporting)
      if (!writtenKeys.has(w5ProjectionFileKey(file)))
        mark(file, 'verifying', commitId, false);
  };

  const current = (file: W5CaptureFile): Entry | undefined => {
    const entry = entries.get(w5ProjectionFileKey(file));
    return entry?.state === 'current' && entry.evidence ? entry : undefined;
  };

  const combine = (
    first: W5CaptureResult,
    second: W5CaptureResult,
  ): W5CaptureResult => {
    const known = combined.get(first)?.get(second);
    if (known) return known;
    const commitId = Math.max(first.log.commitId, second.log.commitId);
    const result = freezeW5Capture({
      files: [...first.files, ...second.files],
      discovery: 'not-requested',
      log: {
        commitId,
        // Abandonment is permanent: either side's makes both unverified.
        retainedCommits:
          isAbandoned(first) || isAbandoned(second) ? commitId - 1 : commitId,
        unresolvedCommits: Math.max(
          first.log.unresolvedCommits,
          second.log.unresolvedCommits,
        ),
        schemaVersion: second.log.schemaVersion,
        revisions: { ...first.log.revisions, ...second.log.revisions },
        files: [...first.log.files, ...second.log.files],
        chains: [...first.log.chains, ...second.log.chains],
        resourceRevisionEligibility: 'unproven',
      },
    });
    const inner =
      combined.get(first) ?? new WeakMap<W5CaptureResult, W5CaptureResult>();
    inner.set(second, result);
    combined.set(first, inner);
    return result;
  };

  const eligibility: W5CommittedProjection['eligibility'] = (
    resource,
    completeness,
  ) => {
    const dependencies = w5ResourceDependencies(resource).map(current);
    const owner = current(revisionOwner(resource));
    if (!owner?.evidence) return undefined;
    let evidence: W5CaptureResult = owner.evidence;
    for (const dependency of dependencies) {
      // A revision older than a file it covers may miss that file's advance.
      if (!dependency?.evidence || dependency.commitId > owner.commitId)
        return undefined;
      if (dependency !== owner)
        evidence = combine(dependency.evidence, evidence);
    }
    // As `classifyW5RevisionEligibility` answers a capture at that position.
    if (newest.unresolved > 0) return PENDING;
    return classifyW5RevisionEligibility(evidence, resource, completeness);
  };

  let inFlight: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  const runRefill = (
    capture: (request: W5CaptureRequest) => Promise<W5CaptureResult>,
  ): Promise<void> => {
    const plan = refillPlan();
    if (!plan) return Promise.resolve();
    const ticket = generation;
    // A synchronous throw rejects, as `refill` promises.
    const run = new Promise<W5CaptureResult>((resolve) =>
      resolve(capture(plan)),
    ).then((result) => installCapture(result, { ticket, authoritative: true }));
    const settled = run.finally(() => {
      if (inFlight === settled) inFlight = undefined;
    });
    inFlight = settled;
    return settled;
  };
  const refillPlan = (skip?: ReadonlySet<string>): W5CaptureRequest | null => {
    const files: W5CaptureFile[] = [];
    let first: Entry | undefined;
    for (const [key, entry] of entries) {
      if (files.length >= W5_CAPTURE_LIMITS.files) break;
      if (skip?.has(key)) continue;
      first ??= entry;
      if (
        entry.state !== 'current' ||
        (entry.evidence?.log.unresolvedCommits ?? 0) > 0
      )
        files.push(copyFile(entry.file));
    }
    // Any one file reads the log's counters again.
    if (!files.length && newest.unresolved > 0 && first)
      files.push(copyFile(first.file));
    return files.length ? { files, discoverWorkspaces: false } : null;
  };

  return {
    ticket: () => generation,
    installCapture,
    noteOwnDecision,
    markDirty(files, options): void {
      generation += 1;
      for (const file of files)
        mark(file, 'dirty', undefined, options?.hold === true);
    },
    files: () => Array.from(entries.values(), ({ file }) => copyFile(file)),
    state: (file) => entries.get(w5ProjectionFileKey(file))?.state,
    commitId: (file) => entries.get(w5ProjectionFileKey(file))?.commitId,
    holds(file, commitId): boolean {
      const entry = current(file);
      return (
        entry?.evidence?.log.unresolvedCommits === 0 &&
        entry.commitId >= commitId
      );
    },
    image: (file) => {
      const entry = entries.get(w5ProjectionFileKey(file));
      return entry?.state === 'dirty' ? undefined : (entry?.image ?? undefined);
    },
    provenance: (file) => {
      const entry = current(file);
      return entry?.evidence
        ? classifyW5FileProvenance(entry.evidence, file)
        : undefined;
    },
    eligibility,
    refillPlan,
    refill(capture): Promise<void> {
      if (!inFlight) return runRefill(capture);
      const running = inFlight;
      queued ??= running
        .catch(() => undefined)
        .then(() => {
          queued = undefined;
          return runRefill(capture);
        });
      return queued;
    },
  };
}
