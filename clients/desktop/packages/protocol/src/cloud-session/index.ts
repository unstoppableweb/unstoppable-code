/** Browser-safe contracts for a cloud agent session's sandbox filesystem. */

export const CLOUD_SESSION_WAKE_HEADER = 'x-canopy-wake';
export const CLOUD_SESSION_WAKE_HEADER_VALUE = '1';

/**
 * Largest sandbox file the download path serves, mirroring agentic-core's
 * `SANDBOX_FILE_DOWNLOAD_MAX_BYTES`. The runner is what actually enforces the
 * limit (it stats before reading); this copy exists so the browser can name
 * the limit in its 413 copy and tests can assert against one number.
 */
export const CLOUD_SESSION_FILE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

export type CloudSessionFileEntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'other';

interface CloudSessionFileEntryBase {
  readonly name: string;
  readonly path: string;
  readonly size: number | null;
}

export interface CloudSessionSupportedFileEntry extends CloudSessionFileEntryBase {
  readonly type: 'file' | 'directory';
  readonly mtimeMs: number;
}

export interface CloudSessionUnsupportedFileEntry extends CloudSessionFileEntryBase {
  readonly type: 'symlink' | 'other';
  readonly mtimeMs: number | null;
}

export type CloudSessionFileEntry =
  | CloudSessionSupportedFileEntry
  | CloudSessionUnsupportedFileEntry;

export interface CloudSessionFileListing {
  readonly path: string;
  readonly absolutePath?: string;
  readonly entries: readonly CloudSessionFileEntry[];
  readonly truncated: boolean;
}

export interface CloudSessionFileContent {
  readonly path: string;
  readonly content: string;
  readonly encoding: 'utf8' | 'base64';
  readonly size: number;
  readonly mtimeMs: number;
  readonly truncated: boolean;
  readonly binary: boolean;
}

/** Result of resolving an agent-authored link against a session workspace. */
export interface CloudSessionFileLinkResolution {
  /** Canonical workspace-relative path, or null when the link is not a file. */
  readonly relativePath: string | null;
}

/**
 * Conditional writes use the version returned by the latest complete read.
 * Core refuses a stale version with HTTP 409 / `FILE_CONFLICT`; the hosted
 * route preserves it as `CloudSessionCodedError` (metadata becomes details).
 * Other 409 codes are not file-save conflicts. The same FILE_CONFLICT code
 * also covers create-only collisions: omitting expectedMtimeMs is create-only,
 * never permission to overwrite. Recovery must send a confirmed version.
 *
 * Server contract evidence:
 * https://github.com/unstoppabledomains/agentic-core/blob/c30e3894abd9d4ca13064cde947f7e55de8c48de/test/e2e/session-sandbox-files.e2e.spec.ts#L436-L485
 */
export interface CloudSessionFileWriteRequest {
  readonly path: string;
  readonly content: string;
  readonly encoding: 'base64';
  readonly expectedSize?: number;
  readonly expectedMtimeMs?: number;
}

export interface CloudSessionFileWriteResult {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly created: boolean;
}

export interface CloudSessionPathMutationResult {
  readonly path: string;
  readonly kind: 'create' | 'mkdir' | 'delete' | 'rename';
  readonly fromPath?: string;
  readonly mtimeMs?: number;
}

export interface CloudSessionCodedError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * Which range a cloud worktree git read covers (REG-3024), matching desktop:
 * `committed` is merge base to `HEAD`, `uncommitted` is `HEAD` to the working
 * tree (staged, unstaged and untracked), `combined` is merge base to the
 * working tree.
 */
export type CloudSessionGitScope = 'uncommitted' | 'committed' | 'combined';

export const CLOUD_SESSION_GIT_SCOPES: readonly CloudSessionGitScope[] = [
  'uncommitted',
  'committed',
  'combined',
];

/** One changed file of a `GET /api/cloud/chats/:chatId/git/changes` read. */
export interface CloudSessionGitChangedFile {
  readonly filePath: string;
  readonly status:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'type_changed'
    | 'untracked';
  /** The rename or copy source. */
  readonly previousPath?: string;
  /** Present for complete `uncommitted` and `combined` samples only. */
  readonly staged?: boolean;
  /** Absent for binary files and truncated output. */
  readonly insertions?: number;
  readonly deletions?: number;
  readonly binary?: boolean;
}

/** One repository's changes, sampled at one `HEAD`. */
export interface CloudSessionGitRepositoryChanges {
  readonly repoId: string;
  /** `owner/name`. */
  readonly repository?: string;
  /**
   * What a multi-repository worktree shows for it (REG-3023): the project
   * root's name or its canopy.json `name`. Absent for one repository, which
   * shows its `repository` name.
   */
  readonly repoName?: string;
  readonly scope: CloudSessionGitScope;
  /** The branch the range resolved against; `null` for `uncommitted`. */
  readonly base: string | null;
  readonly headSha: string;
  readonly mergeBaseSha: string | null;
  /** The listing hit the producer's bound: files are missing. */
  readonly truncated: boolean;
  readonly files: readonly CloudSessionGitChangedFile[];
}

/**
 * One repository of a changes read. A repository that could not be read
 * reports its own coded error without failing the others.
 */
export type CloudSessionGitChangesEntry =
  | { readonly state: 'OK'; readonly changes: CloudSessionGitRepositoryChanges }
  | {
      readonly state: 'ERROR';
      readonly repoId: string;
      readonly repository?: string;
      /** As `CloudSessionGitRepositoryChanges.repoName`. */
      readonly repoName?: string;
      readonly error: { readonly code: string; readonly message: string };
    };

/** `GET /api/cloud/chats/:chatId/git/changes`: every requested repository. */
export interface CloudSessionGitChanges {
  /** The sandbox generation every OK entry agreed on; `null` when unknown or mixed. */
  readonly generation: string | null;
  readonly repositories: readonly CloudSessionGitChangesEntry[];
}

/** `GET /api/cloud/chats/:chatId/git/diff`: one path's patch. */
export interface CloudSessionGitDiff {
  readonly repoId: string;
  readonly scope: CloudSessionGitScope;
  readonly base: string | null;
  readonly headSha: string;
  readonly mergeBaseSha: string | null;
  readonly generation: string | null;
  readonly path: string;
  /** Cut at the producer's size bound when `truncated`. */
  readonly patch: string;
  readonly binary: boolean;
  readonly truncated: boolean;
}

export type CloudFileRootClassification = {
  readonly kind: 'sandbox' | 'artifacts' | 'attachments' | 'workspace-files';
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId: string;
  readonly chatId: string | null;
  /**
   * A repository worktree's root listed over the web core (CAN-6093): the
   * web core's root id and its workspace-relative mount path ('' is the
   * workspace). Absent on every other root, which is the whole workspace.
   */
  readonly fileRoot?: CloudSandboxFileRoot;
};

export interface CloudSandboxFileRoot {
  readonly fileRootId: string;
  readonly mountPath: string;
}

const SANDBOX_ROOT_PREFIX = 'sandbox-';
const ARTIFACTS_ROOT_PREFIX = 'artifacts-';
export const CHAT_ATTACHMENTS_ROOT_PREFIX = 'chat-attachments-';
const ROOT_SCOPE_SEPARATOR = '|';

function cloudFileRootId(
  prefix: string,
  worktreeLocalId: string,
  chatId: string,
): string {
  return `${prefix}${encodeURIComponent(worktreeLocalId)}${ROOT_SCOPE_SEPARATOR}${encodeURIComponent(chatId)}`;
}

export function cloudSandboxFileRootId(
  worktreeLocalId: string,
  chatId: string,
  fileRoot?: CloudSandboxFileRoot,
): string {
  const id = cloudFileRootId(SANDBOX_ROOT_PREFIX, worktreeLocalId, chatId);
  return fileRoot === undefined
    ? id
    : `${id}${ROOT_SCOPE_SEPARATOR}${encodeURIComponent(fileRoot.fileRootId)}${ROOT_SCOPE_SEPARATOR}${encodeURIComponent(fileRoot.mountPath)}`;
}

/**
 * The workspace path a sandbox root's `relativePath` names: the REST file
 * routes (index, search, download, resolve) address the workspace, so this
 * is the one place a repository root's mount path is added.
 */
export function cloudSandboxWorkspacePath(
  rootId: string,
  relativePath: string,
): string {
  const mountPath = classifyCloudFileRootId(rootId)?.fileRoot?.mountPath ?? '';
  if (mountPath === '') return relativePath;
  return relativePath === '' ? mountPath : `${mountPath}/${relativePath}`;
}

/** The inverse: `workspacePath` relative to the root, or null outside it. */
export function cloudSandboxRootRelativePath(
  rootId: string,
  workspacePath: string,
): string | null {
  const mountPath = classifyCloudFileRootId(rootId)?.fileRoot?.mountPath ?? '';
  if (mountPath === '') return workspacePath;
  if (workspacePath === mountPath) return '';
  return workspacePath.startsWith(`${mountPath}/`)
    ? workspacePath.slice(mountPath.length + 1)
    : null;
}

/** The root holding `workspacePath` most closely: a repository child over the workspace root. */
export function innermostCloudSandboxRoot(
  rootIds: readonly string[],
  workspacePath: string,
): string | undefined {
  return rootIds
    .filter(
      (rootId) => cloudSandboxRootRelativePath(rootId, workspacePath) !== null,
    )
    .sort(
      (left, right) =>
        (classifyCloudFileRootId(right)?.fileRoot?.mountPath.length ?? 0) -
        (classifyCloudFileRootId(left)?.fileRoot?.mountPath.length ?? 0),
    )[0];
}

export function cloudArtifactsFileRootId(
  worktreeLocalId: string,
  chatId: string,
): string {
  return cloudFileRootId(ARTIFACTS_ROOT_PREFIX, worktreeLocalId, chatId);
}

export function cloudChatAttachmentsFileRootId(
  worktreeLocalId: string,
  chatId: string,
): string {
  return cloudFileRootId(CHAT_ATTACHMENTS_ROOT_PREFIX, worktreeLocalId, chatId);
}

export function cloudChatAttachmentRelativePath(
  attachmentId: string,
  filename: string,
): string {
  return `${encodeURIComponent(attachmentId)}/${encodeURIComponent(filename)}`;
}

export function parseCloudChatAttachmentRelativePath(
  relativePath: string,
): { attachmentId: string; filename: string } | null {
  const segments = relativePath.split('/');
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0)
  ) {
    return null;
  }
  try {
    const [attachmentId, filename] = segments.map((segment) =>
      decodeURIComponent(segment),
    );
    return attachmentId.length > 0 && filename.length > 0
      ? { attachmentId, filename }
      : null;
  } catch {
    return null;
  }
}

function classifyPrefixedCloudFileRootId(
  kind: CloudFileRootClassification['kind'],
  suffix: string,
): CloudFileRootClassification | null {
  const separatorIndex = suffix.indexOf(ROOT_SCOPE_SEPARATOR);
  if (separatorIndex === -1) {
    return suffix.length > 0
      ? { kind, worktreeLocalId: suffix, chatId: null }
      : null;
  }
  // Each segment is URI-encoded, so `|` only ever separates them.
  const segments = suffix.split(ROOT_SCOPE_SEPARATOR);
  if (segments.length !== 2 && !(kind === 'sandbox' && segments.length === 4))
    return null;
  try {
    const [worktreeLocalId, chatId, fileRootId, mountPath] = segments.map(
      (segment) => decodeURIComponent(segment),
    );
    if (worktreeLocalId.length === 0 || chatId.length === 0) return null;
    if (fileRootId === undefined || mountPath === undefined)
      return { kind, worktreeLocalId, chatId };
    return fileRootId.length > 0
      ? { kind, worktreeLocalId, chatId, fileRoot: { fileRootId, mountPath } }
      : null;
  } catch {
    return null;
  }
}

export function classifyCloudFileRootId(
  rootId: string,
): CloudFileRootClassification | null {
  if (rootId.startsWith('workspace-files-')) {
    const parsed = classifyPrefixedCloudFileRootId(
      'workspace-files',
      rootId.slice('workspace-files-'.length),
    );
    return parsed !== null && parsed.chatId !== null
      ? {
          kind: 'workspace-files',
          worktreeLocalId: parsed.worktreeLocalId,
          workspaceLocalId: parsed.chatId,
          chatId: null,
        }
      : null;
  }
  if (rootId.startsWith(SANDBOX_ROOT_PREFIX)) {
    return classifyPrefixedCloudFileRootId(
      'sandbox',
      rootId.slice(SANDBOX_ROOT_PREFIX.length),
    );
  }
  if (rootId.startsWith(ARTIFACTS_ROOT_PREFIX)) {
    return classifyPrefixedCloudFileRootId(
      'artifacts',
      rootId.slice(ARTIFACTS_ROOT_PREFIX.length),
    );
  }
  if (rootId.startsWith(CHAT_ATTACHMENTS_ROOT_PREFIX)) {
    return classifyPrefixedCloudFileRootId(
      'attachments',
      rootId.slice(CHAT_ATTACHMENTS_ROOT_PREFIX.length),
    );
  }
  return null;
}

export function isCloudSandboxFileRootId(rootId: string): boolean {
  return classifyCloudFileRootId(rootId)?.kind === 'sandbox';
}

export function cloudWorkspaceFilesRootId(
  worktreeLocalId: string,
  workspaceLocalId: string,
): string {
  return cloudFileRootId('workspace-files-', worktreeLocalId, workspaceLocalId);
}
export function cloudWorkspaceFileRelativePath(
  fileId: string,
  versionId: string,
  filename: string,
): string {
  const relativePath = [fileId, versionId, filename]
    .map(encodeURIComponent)
    .join('/');
  if (parseCloudWorkspaceFileRelativePath(relativePath) === null)
    throw new Error('Invalid workspace file path');
  return relativePath;
}
export function parseCloudWorkspaceFileRelativePath(
  relativePath: string,
): { fileId: string; versionId: string; filename: string } | null {
  const segments = relativePath.split('/');
  if (segments.length !== 3) return null;
  try {
    const [fileId, versionId, filename] = segments.map(decodeURIComponent);
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      !uuid.test(fileId) ||
      !uuid.test(versionId) ||
      !filename ||
      filename === '.' ||
      filename === '..' ||
      /[/\\]/.test(filename) ||
      filename
        .split('')
        .some(
          (character) =>
            character.charCodeAt(0) < 32 ||
            (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
        )
    )
      return null;
    return { fileId, versionId, filename };
  } catch {
    return null;
  }
}

export interface CloudSessionFileIndex {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

/** Browser-facing contract for a cloud chat's sandbox terminal (REG-2984). */
export interface CloudSessionTerminalCredential {
  /** Queryless ws(s):// URL. The client appends `?token=` only when connecting. */
  readonly url: string;
  /** Opaque provider-session credential. Memory only: never storage, logs, or telemetry. */
  readonly token: string;
  readonly cwd: string;
}

export type CloudSessionTerminalKeepaliveReason =
  | 'CLIENT_IDLE'
  | 'SANDBOX_NOT_RUNNING'
  | 'SESSION_CAP_REACHED'
  | 'SESSION_ANCHOR_MISSING';

export interface CloudSessionTerminalKeepaliveRequest {
  readonly idleMs: number;
}

export interface CloudSessionTerminalKeepaliveResult {
  readonly sandboxId: string;
  readonly sandboxKey: string;
  readonly sandboxStatus: string;
  readonly running: boolean;
  readonly honoured: boolean;
  readonly extended: boolean;
  /** Omitted (never null) when Core gives no reason. */
  readonly reason?: CloudSessionTerminalKeepaliveReason;
  readonly expiresAt: string | null;
  readonly sessionCapAt: string | null;
  readonly activityWindowMs: number;
}

export const CLOUD_SESSION_TERMINAL_KEEPALIVE_MAX_IDLE_MS = 86_400_000;
export const CLOUD_SESSION_TERMINAL_KEEPALIVE_INTERVAL_MS = 60_000;

export * from './agent-task';
export * from './agent-task-row';
export * from './sandbox-status';
