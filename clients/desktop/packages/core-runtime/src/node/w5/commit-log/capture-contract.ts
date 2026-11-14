import { isRecord } from './is-record';
import { isSafeWorkspaceId } from '../../identifiers';

// Historical desktop slugs are ASCII; 255 bytes is the filesystem segment cap.
export const W5_CAPTURE_WORKSPACE_ID_MAX = 255;
export const W5_CAPTURE_KEY_MAX =
  'worktree:/'.length + W5_CAPTURE_WORKSPACE_ID_MAX + 256;

export const W5_CAPTURE_LIMITS = Object.freeze({
  files: 256,
  bytes: 8 * 1024 * 1024,
  responseBytes: 16 * 1024 * 1024,
  evidenceRows: 4096,
});

export type W5CaptureFile =
  | { readonly kind: 'index' | 'index-backup' }
  | { readonly kind: 'manifest' | 'worktrees'; readonly workspaceId: string };

/**
 * Unsupported hosts, and Windows hosts without a handle-confined reader,
 * refuse before capture file opens.
 */
export interface W5CaptureRequest {
  readonly files: readonly W5CaptureFile[];
  /** Discover both workspace files from the captured primary index, not a host read. */
  readonly discoverWorkspaces: boolean;
}

export type W5FileUnreadableReason = 'unsafe-path' | 'not-file' | 'io';

export type W5FileImage = W5CaptureFile &
  (
    | { readonly state: 'present'; readonly base64: string }
    | { readonly state: 'absent' }
    | { readonly state: 'unreadable'; readonly reason: W5FileUnreadableReason }
  );

/** One capture file read through a host's handle confinement. */
export type W5ConfinedFileRead =
  | { readonly state: 'present'; readonly bytes: Uint8Array }
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable'; readonly reason: W5FileUnreadableReason }
  /** More than the `maxBytes` the read was allowed. */
  | { readonly state: 'too-large' }
  /** The root did not open, or its handle failed mid-read: the whole capture refuses. */
  | { readonly state: 'root-unavailable' }
  /** The root's handle names another path: the whole capture refuses. */
  | { readonly state: 'root-changed' };

/**
 * Windows capture reads (CAN-5202), supplied by the trusted host. `root` is
 * the resolved trusted root; its opened handle must name exactly that path,
 * or the read is `root-changed`. Each of `components` is opened relative to
 * its parent's handle without following any reparse point, and any reparse
 * point is `unsafe-path`.
 */
export interface W5ConfinedFileReader {
  read(
    root: string,
    components: readonly string[],
    maxBytes: number,
  ): Promise<W5ConfinedFileRead>;
}

/** Loads the host's reader on first use; null where the mechanism is unavailable. */
export type W5ConfinedFileReaderSource = () => W5ConfinedFileReader | null;

export interface W5FileLogEvidence {
  readonly file: W5CaptureFile;
  readonly commitId: number;
  readonly state: 'committed' | 'applied' | 'recovery-required';
  readonly previousFingerprint: string | null;
  readonly newFingerprint: string | null;
}

/** One captured path's whole retained decision chain, summarized in commit order. */
export interface W5FileChainEvidence {
  readonly file: W5CaptureFile;
  readonly decisions: number;
  /** The first retained decision replaced an absent file. */
  readonly startsAbsent: boolean;
  /** Decisions whose preimage differs from the preceding decision's image, or is malformed. */
  readonly discontinuities: number;
}

export interface W5CaptureEvidence {
  /** The allocation high-water mark, not the newest surviving commit. */
  readonly commitId: number;
  /** Surviving commits; fewer than `commitId` means abandoned history. */
  readonly retainedCommits: number;
  /** Committed or recovery-required decisions on any path. */
  readonly unresolvedCommits: number;
  readonly schemaVersion: number;
  /** Only scopes represented by captured selectors; worktree lists include all child keys. */
  readonly revisions: Readonly<Record<string, number>>;
  /** Per path: latest applied decision plus every unresolved decision, in commit order. */
  readonly files: readonly W5FileLogEvidence[];
  /** Exactly one entry per captured path. */
  readonly chains: readonly W5FileChainEvidence[];
  /** Retained log rows do not bind file images to resource revisions; see `eligibility.ts`. */
  readonly resourceRevisionEligibility: 'unproven';
}

export interface W5CaptureResult {
  readonly files: readonly W5FileImage[];
  readonly discovery:
    | 'not-requested'
    | 'complete'
    | 'unavailable'
    | 'invalid-index';
  readonly log: W5CaptureEvidence;
}

/** A capture file's path components under its W5 root; the one projection. */
export function w5CaptureFileComponents(
  file: W5CaptureFile,
): readonly string[] {
  switch (file.kind) {
    case 'index':
      return ['index.json'];
    case 'index-backup':
      return ['index.json.bak'];
    case 'manifest':
      return [file.workspaceId, 'workspace.json'];
    case 'worktrees':
      return [file.workspaceId, 'worktrees.json'];
  }
}

export function isW5CaptureWorkspaceId(value: unknown): value is string {
  return (
    isSafeWorkspaceId(value) ||
    (typeof value === 'string' &&
      value.length <= W5_CAPTURE_WORKSPACE_ID_MAX &&
      /^[a-z0-9][a-z0-9-]*$/.test(value))
  );
}

export function isW5CaptureFile(value: unknown): value is W5CaptureFile {
  if (!isRecord(value)) return false;
  if (value.kind === 'index' || value.kind === 'index-backup')
    return Object.keys(value).every((key) => key === 'kind');
  return (
    (value.kind === 'manifest' || value.kind === 'worktrees') &&
    isW5CaptureWorkspaceId(value.workspaceId) &&
    Object.keys(value).every((key) => key === 'kind' || key === 'workspaceId')
  );
}

export function isW5CaptureRequest(value: unknown): value is W5CaptureRequest {
  return (
    isRecord(value) &&
    Object.keys(value).every(
      (key) => key === 'files' || key === 'discoverWorkspaces',
    ) &&
    typeof value.discoverWorkspaces === 'boolean' &&
    Array.isArray(value.files) &&
    value.files.length <= W5_CAPTURE_LIMITS.files &&
    Array.from(value.files).every(isW5CaptureFile)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFingerprint(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
  );
}

function isChainEvidence(value: unknown): value is W5FileChainEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'file',
      'decisions',
      'startsAbsent',
      'discontinuities',
    ]) &&
    isW5CaptureFile(value.file) &&
    isRevision(value.decisions) &&
    typeof value.startsAbsent === 'boolean' &&
    (value.decisions > 0 || !value.startsAbsent) &&
    isRevision(value.discontinuities) &&
    value.discontinuities <= value.decisions
  );
}

function imageFile(value: Record<string, unknown>): W5CaptureFile | undefined {
  const file =
    value.kind === 'index' || value.kind === 'index-backup'
      ? { kind: value.kind }
      : { kind: value.kind, workspaceId: value.workspaceId };
  return isW5CaptureFile(file) ? file : undefined;
}

/** Chains align one-to-one, in order, with the captured images. */
function isChainFor(chain: unknown, image: unknown): boolean {
  if (!isChainEvidence(chain) || !isRecord(image)) return false;
  const file = imageFile(image);
  return (
    file?.kind === chain.file.kind &&
    ('workspaceId' in file ? file.workspaceId : null) ===
      ('workspaceId' in chain.file ? chain.file.workspaceId : null)
  );
}

export function isW5CaptureResult(value: unknown): value is W5CaptureResult {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['files', 'discovery', 'log']) ||
    !Array.isArray(value.files) ||
    value.files.length > W5_CAPTURE_LIMITS.files ||
    !isRecord(value.log)
  )
    return false;
  let bytes = 0;
  for (const file of value.files) {
    if (!isRecord(file) || !imageFile(file)) return false;
    const keys = ['kind', 'state'];
    if (file.kind === 'manifest' || file.kind === 'worktrees')
      keys.push('workspaceId');
    if (file.state === 'present') keys.push('base64');
    if (file.state === 'unreadable') keys.push('reason');
    if (!hasOnlyKeys(file, keys)) return false;
    if (file.state === 'present') {
      if (
        typeof file.base64 !== 'string' ||
        file.base64.length > (W5_CAPTURE_LIMITS.bytes * 4) / 3 + 4
      )
        return false;
      const decoded = Buffer.from(file.base64, 'base64');
      if (decoded.toString('base64') !== file.base64) return false;
      bytes += decoded.length;
      if (bytes > W5_CAPTURE_LIMITS.bytes) return false;
    } else if (file.state === 'unreadable') {
      if (
        file.reason !== 'unsafe-path' &&
        file.reason !== 'not-file' &&
        file.reason !== 'io'
      )
        return false;
    } else if (file.state !== 'absent') return false;
  }
  const log = value.log;
  const images: readonly unknown[] = value.files;
  return (
    bytes <= W5_CAPTURE_LIMITS.bytes &&
    (value.discovery === 'not-requested' ||
      value.discovery === 'complete' ||
      value.discovery === 'unavailable' ||
      value.discovery === 'invalid-index') &&
    hasOnlyKeys(log, [
      'commitId',
      'retainedCommits',
      'unresolvedCommits',
      'schemaVersion',
      'revisions',
      'files',
      'chains',
      'resourceRevisionEligibility',
    ]) &&
    isRevision(log.commitId) &&
    isRevision(log.retainedCommits) &&
    log.retainedCommits <= log.commitId &&
    isRevision(log.unresolvedCommits) &&
    log.unresolvedCommits <= log.retainedCommits &&
    Array.isArray(log.chains) &&
    log.chains.length === images.length &&
    Array.from(log.chains).every((chain: unknown, index) =>
      isChainFor(chain, images[index]),
    ) &&
    isRevision(log.schemaVersion) &&
    log.schemaVersion > 0 &&
    log.resourceRevisionEligibility === 'unproven' &&
    isRecord(log.revisions) &&
    Object.keys(log.revisions).length <= W5_CAPTURE_LIMITS.evidenceRows &&
    Object.entries(log.revisions).every(
      ([key, revision]) =>
        key.length <= W5_CAPTURE_KEY_MAX && isRevision(revision),
    ) &&
    Array.isArray(log.files) &&
    log.files.length + Object.keys(log.revisions).length <=
      W5_CAPTURE_LIMITS.evidenceRows &&
    Array.from(log.files).every(
      (row: unknown) =>
        isRecord(row) &&
        hasOnlyKeys(row, [
          'file',
          'commitId',
          'state',
          'previousFingerprint',
          'newFingerprint',
        ]) &&
        isW5CaptureFile(row.file) &&
        isRevision(row.commitId) &&
        row.commitId > 0 &&
        (row.state === 'committed' ||
          row.state === 'applied' ||
          row.state === 'recovery-required') &&
        isFingerprint(row.previousFingerprint) &&
        isFingerprint(row.newFingerprint),
    ) &&
    Buffer.byteLength(JSON.stringify(value)) <= W5_CAPTURE_LIMITS.responseBytes
  );
}

/** Structured clone drops freezing; freeze again at the host boundary. */
export function freezeW5Capture(result: W5CaptureResult): W5CaptureResult {
  for (const file of result.files) Object.freeze(file);
  for (const row of [...result.log.files, ...result.log.chains]) {
    Object.freeze(row.file);
    Object.freeze(row);
  }
  Object.freeze(result.files);
  Object.freeze(result.log.files);
  Object.freeze(result.log.chains);
  Object.freeze(result.log.revisions);
  Object.freeze(result.log);
  return Object.freeze(result);
}
