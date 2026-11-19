import { mapWithConcurrency } from '../lib/concurrency';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, posix, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import type {
  PortalChangedFile,
  PortalChangedFilesPayload,
  PortalDiffPayload,
  PortalDiffReadPayload,
} from '@canopy/desktop-shared/types';
import { getResolvedGitExecutableForSpawn } from '../lib/git-executable';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import {
  estimateUntrackedChanges,
  MAX_UNTRACKED_FILES,
  type UntrackedChange,
} from '../lib/untracked-line-estimate';
import { validateId } from '../lib/validation';
import { resolveEffectiveBaseBranchForRepo } from '../lib/worktree-base-branches';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { PortalServiceError } from './portal-service-error';
import {
  secretSafeView,
  SecretViewUnavailableError,
} from '../agent-secrets/view-redaction';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import { resolveSharedContainerViewerReadRoots } from '../shared-containers/read/viewer-root';

const execFileAsync = promisify(execFile);
type DiffReadSource = NonNullable<PortalDiffReadPayload['source']>;
export function getNullDiffSourceForPlatform(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

const NULL_DIFF_SOURCE = getNullDiffSourceForPlatform();

export function normalizeStatus(value: string): PortalChangedFile['status'] {
  const status = value.trim();
  switch (status) {
    case 'DD':
    case 'AU':
    case 'UD':
    case 'UA':
    case 'DU':
    case 'AA':
    case 'UU':
    case 'U':
      return 'unmerged';
  }
  switch (status[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case '?':
      return 'untracked';
    case 'M':
    default:
      return 'modified';
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    await getResolvedGitExecutableForSpawn(),
    args,
    {
      cwd,
      maxBuffer: 1024 * 1024 * 16,
      windowsHide: process.platform === 'win32',
    },
  );
  return stdout.trimEnd();
}

async function gitAllowDiffExit(args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch (error) {
    if (isRecord(error) && typeof error.stdout === 'string') {
      return error.stdout.trimEnd();
    }
    throw error;
  }
}

async function isGitRepositoryRoot(cwd: string): Promise<boolean> {
  try {
    const topLevel = await git(['rev-parse', '--show-toplevel'], cwd);
    return (await realpath(topLevel)) === (await realpath(cwd));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isPathInsideRoot(pathValue: string, rootPath: string): boolean {
  return pathValue === rootPath || pathValue.startsWith(`${rootPath}${sep}`);
}

function normalizeDiffPath(value: string): string {
  if (win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new PortalServiceError(
      'invalid_target',
      'Diff path must be relative.',
    );
  }
  const normalizedInput = value.replace(/\\/g, '/');
  if (posix.isAbsolute(normalizedInput)) {
    throw new PortalServiceError(
      'invalid_target',
      'Diff path must be relative.',
    );
  }
  if (normalizedInput.split('/').some((segment) => segment === '..')) {
    throw new PortalServiceError(
      'invalid_target',
      'Diff path cannot traverse outside the worktree.',
    );
  }
  const normalized = posix.normalize(normalizedInput);
  return normalized === '.'
    ? ''
    : normalized.split('/').filter(Boolean).join('/');
}

async function resolveNearestExistingAncestor(
  pathValue: string,
): Promise<string> {
  let cursor = pathValue;
  for (;;) {
    try {
      return await realpath(cursor);
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      cursor = parent;
    }
  }
}

async function validateDiffPathInsideWorktree(
  cwd: string,
  pathValue?: string,
): Promise<string | undefined> {
  if (!pathValue) {
    return undefined;
  }
  const relativePath = normalizeDiffPath(pathValue);
  if (!relativePath) {
    return undefined;
  }
  const rootReal = await realpath(cwd);
  const absolutePath = join(cwd, ...relativePath.split('/'));
  const targetReal = await resolveNearestExistingAncestor(absolutePath);
  if (!isPathInsideRoot(targetReal, rootReal)) {
    throw new PortalServiceError(
      'invalid_target',
      'Diff path is outside the selected worktree.',
    );
  }
  return relativePath;
}

function parseNameStatus(
  output: string,
  committed: boolean,
): PortalChangedFile[] {
  if (!output) {
    return [];
  }
  return output.split('\n').flatMap((line): PortalChangedFile[] => {
    const fields = line.split('\t');
    const code = fields[0] ?? '';
    const filePath = fields[fields.length - 1] ?? '';
    if (!filePath) {
      return [];
    }
    const renamedFrom = fields.length > 2 ? fields[1] : undefined;
    return [
      {
        filePath,
        status: normalizeStatus(code),
        staged: committed ? true : code[0] !== ' ' && code[0] !== '?',
        ...(renamedFrom !== undefined
          ? { renamedFrom, previousPath: renamedFrom }
          : {}),
      },
    ];
  });
}

type NumstatEntry =
  | { readonly insertions: number; readonly deletions: number }
  | { readonly binary: true };

/**
 * Parse a `git diff --numstat` output frame into a map keyed by file path so
 * the per-file insertion/deletion counts can be merged onto the entries
 * `listChangedFiles` / `listCommittedChangedFiles` produced from
 * `git status` / `git diff --name-status`.
 *
 * Binary files surface as `-` for both fields in numstat output; they are
 * recorded as binary (REG-3024), so the caller's PortalChangedFile carries
 * `binary: true` and keeps `insertions` / `deletions` undefined.
 */
function parseNumstat(output: string): Map<string, NumstatEntry> {
  const result = new Map<string, NumstatEntry>();
  if (!output) return result;
  for (const line of output.split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    const filePath = fields[fields.length - 1] ?? '';
    if (!filePath) continue;
    const insertionsRaw = fields[0];
    const deletionsRaw = fields[1];
    if (insertionsRaw === '-' && deletionsRaw === '-') {
      result.set(filePath, { binary: true });
      continue;
    }
    const insertions = Number.parseInt(insertionsRaw, 10);
    const deletions = Number.parseInt(deletionsRaw, 10);
    if (Number.isFinite(insertions) && Number.isFinite(deletions)) {
      result.set(filePath, { insertions, deletions });
    }
  }
  return result;
}

function mergeNumstatIntoFiles(
  files: PortalChangedFile[],
  numstat: Map<string, NumstatEntry>,
): PortalChangedFile[] {
  return files.map((file) => {
    const entry = numstat.get(file.filePath);
    if (!entry) return file;
    if ('binary' in entry) return { ...file, binary: true };
    return {
      ...file,
      insertions: entry.insertions,
      deletions: entry.deletions,
    };
  });
}

function normalizeDiffReadSource(value: unknown): DiffReadSource {
  if (value === undefined) {
    return 'uncommitted';
  }
  if (
    value === 'uncommitted' ||
    value === 'committed' ||
    value === 'combined'
  ) {
    return value;
  }
  throw new PortalServiceError('invalid_payload', 'Invalid diff source.');
}

function mergeChangedFiles(
  uncommitted: PortalChangedFile[],
  committed: PortalChangedFile[],
): PortalChangedFile[] {
  const files = new Map<string, PortalChangedFile>();
  for (const file of committed) {
    files.set(file.filePath, file);
  }
  for (const file of uncommitted) {
    files.set(file.filePath, file);
  }
  return Array.from(files.values()).sort((left, right) =>
    left.filePath.localeCompare(right.filePath),
  );
}

interface CommittedDiffBase {
  /** Ref the committed set diffs against (e.g. `origin/develop`). */
  baseRef: string;
  mergeBase: string;
}

async function resolveUpstreamDiffBase(
  cwd: string,
): Promise<CommittedDiffBase | null> {
  const upstream = await git(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd)
    .then((value) => value.trim())
    .catch(() => '');
  if (!upstream) {
    return null;
  }
  const mergeBase = await git(['merge-base', upstream, 'HEAD'], cwd)
    .then((value) => value.trim())
    .catch(() => '');
  if (!mergeBase) {
    return null;
  }
  return { baseRef: upstream, mergeBase };
}

/**
 * Resolves the ref the "committed" changed-file set (and committed diff
 * reads) compare against.
 *
 * Prefers the worktree's effective base branch, resolved from local data
 * only like the overview diff stats (`getWorktreeDiffStatsOnly`), so the file
 * list and the +N/-M numbers agree. After a remote default-branch change the
 * stored default can lag until a remote-capable refresh (`getWorktreeStats`)
 * records the new one; both then converge. The `@{upstream}` fallback covers
 * checkouts with no resolvable base, but it is not sufficient alone:
 * `git push -u` retargets the upstream to the branch's own remote ref, which
 * collapses an upstream-based committed diff to zero files while the stats
 * pill keeps reporting the branch's changes against its base.
 */
async function resolveCommittedDiffBase(
  workspaceId: string,
  worktreeId: string,
  cwd: string,
  repoId?: string,
): Promise<CommittedDiffBase | null> {
  // Local only, as for the overview diff stats: a Portal worktree snapshot
  // builds this inline in the serial command loop, so a remote that waits on
  // a credential helper would stall every Portal command queued behind it.
  const effective = await resolveEffectiveBaseBranchForRepo({
    projectId: workspaceId,
    worktreeId,
    repoPath: cwd,
    ...(repoId ? { repoId } : {}),
    allowRemoteLookup: false,
  }).catch(() => null);
  const branch = effective?.branch;
  if (branch) {
    const baseRef = effective.existsInRemote
      ? `origin/${branch}`
      : effective.existsLocally
        ? branch
        : null;
    if (baseRef) {
      const mergeBase = await git(['merge-base', baseRef, 'HEAD'], cwd)
        .then((value) => value.trim())
        .catch(() => '');
      if (mergeBase) {
        return { baseRef, mergeBase };
      }
    }
  }
  return resolveUpstreamDiffBase(cwd);
}

async function listChangedFilesAtPath(
  cwd: string,
  options: { estimateUntrackedLines?: boolean } = {},
): Promise<PortalChangedFile[]> {
  const [status, numstatOutput] = await Promise.all([
    git(
      [
        '-c',
        'core.quotePath=false',
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ],
      cwd,
    ),
    git(['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD'], cwd).catch(
      () => '',
    ),
  ]);
  if (!status) {
    return [];
  }
  const files = status.split('\n').flatMap((line): PortalChangedFile[] => {
    const code = line.slice(0, 2);
    const rawPath = line.slice(3);
    if (!rawPath) {
      return [];
    }
    const renameParts = rawPath.split(' -> ');
    const filePath = renameParts[renameParts.length - 1] ?? rawPath;
    const renamedFrom = renameParts.length > 1 ? renameParts[0] : undefined;
    return [
      {
        filePath,
        status: normalizeStatus(code),
        staged: code[0] !== ' ' && code[0] !== '?',
        ...(renamedFrom !== undefined
          ? { renamedFrom, previousPath: renamedFrom }
          : {}),
      },
    ];
  });
  const withNumstat = mergeNumstatIntoFiles(files, parseNumstat(numstatOutput));
  if (options.estimateUntrackedLines === false) {
    return withNumstat;
  }
  // `git diff --numstat HEAD` has no row for untracked files, so they would
  // reach web/mobile without counts while the desktop activity panel shows
  // `+N`. Estimate them the same way that panel does.
  const untrackedPaths = withNumstat
    .filter((file) => file.status === 'untracked')
    .map((file) => file.filePath)
    .slice(0, MAX_UNTRACKED_FILES);
  if (untrackedPaths.length === 0) {
    return withNumstat;
  }
  const estimates = await estimateUntrackedChanges(cwd, untrackedPaths);
  const changeByPath = new Map<string, UntrackedChange>();
  untrackedPaths.forEach((filePath, index) => {
    const estimate = estimates[index];
    if (estimate !== undefined) {
      changeByPath.set(filePath, estimate);
    }
  });
  return withNumstat.map((file) => {
    const change = changeByPath.get(file.filePath);
    if (change === undefined) return file;
    // A binary untracked file has no lines to count (REG-3024).
    return change.binary
      ? { ...file, binary: true }
      : { ...file, insertions: change.insertions, deletions: 0 };
  });
}

export async function listChangedFiles(
  workspaceId: string,
  worktreeId: string,
): Promise<PortalChangedFile[]> {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  const cwd = resolveWorktreeCwd(workspaceId, worktreeId);
  return listChangedFilesAtPath(cwd);
}

async function listCommittedChangedFilesAtPath(
  workspaceId: string,
  worktreeId: string,
  cwd: string,
  repoId?: string,
): Promise<PortalChangedFile[]> {
  const base = await resolveCommittedDiffBase(
    workspaceId,
    worktreeId,
    cwd,
    repoId,
  );
  return listCommittedChangedFilesForBase(cwd, base);
}

async function listCommittedChangedFilesForBase(
  cwd: string,
  base: CommittedDiffBase | null,
): Promise<PortalChangedFile[]> {
  if (!base) {
    return [];
  }
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    git(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-status',
        `${base.mergeBase}..HEAD`,
      ],
      cwd,
    ).catch(() => ''),
    git(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--numstat',
        `${base.mergeBase}..HEAD`,
      ],
      cwd,
    ).catch(() => ''),
  ]);
  return mergeNumstatIntoFiles(
    parseNameStatus(nameStatusOutput, true),
    parseNumstat(numstatOutput),
  );
}

export async function listCommittedChangedFiles(
  workspaceId: string,
  worktreeId: string,
): Promise<PortalChangedFile[]> {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  const cwd = resolveWorktreeCwd(workspaceId, worktreeId);
  return listCommittedChangedFilesAtPath(workspaceId, worktreeId, cwd);
}

export async function listChangedFileSets(
  workspaceId: string,
  worktreeId: string,
): Promise<PortalChangedFilesPayload> {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  if (workspaceId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const roots = await resolveSharedContainerViewerReadRoots(worktreeId);
    const revisionId = roots[0]?.revisionId;
    if (!revisionId) {
      return {
        workspaceLocalId: workspaceId,
        worktreeLocalId: worktreeId,
        uncommitted: [],
        committed: [],
      };
    }
    const reader = getSharedContainerReader();
    const sets = await Promise.all(
      roots.map(async (root) => {
        const uncommitted: PortalChangedFile[] = [];
        const committed: PortalChangedFile[] = [];
        let cursor: string | undefined;
        do {
          const page = await reader.listRepositoryTree({
            containerId: worktreeId,
            revisionId,
            repoId: root.repoId,
            ...(cursor ? { cursor } : {}),
            limit: 100,
          });
          for (const item of page.items) {
            if (item.kind !== 'file' || !item.status || !item.source) continue;
            (item.source === 'committed' ? committed : uncommitted).push({
              filePath: item.path,
              status: item.status,
              insertions: item.insertions,
              deletions: item.deletions,
              repoId: root.repoId,
              repoName: root.repoName,
            });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return { uncommitted, committed };
      }),
    );
    return {
      workspaceLocalId: workspaceId,
      worktreeLocalId: worktreeId,
      uncommitted: sets.flatMap((set) => set.uncommitted),
      committed: sets.flatMap((set) => set.committed),
    };
  }
  if (isMultiRepoWorkspace(workspaceId)) {
    const worktreePath = resolveWorktreeCwd(workspaceId, worktreeId);
    const repos = await listWorkspaceWorktreeRepoEntries(
      workspaceId,
      worktreePath,
    );
    const sets = await mapWithConcurrency(repos, 4, async (repo) => {
      if (!(await isGitRepositoryRoot(repo.repoPath))) {
        return { uncommitted: [], committed: [] };
      }
      const [uncommitted, committed] = await Promise.all([
        listChangedFilesAtPath(repo.repoPath),
        listCommittedChangedFilesAtPath(
          workspaceId,
          worktreeId,
          repo.repoPath,
          repo.repoId,
        ),
      ]).catch(() => [[], []] as const);
      const withRepoIdentity = (
        file: PortalChangedFile,
      ): PortalChangedFile => ({
        ...file,
        repoId: repo.repoId,
        repoName: repo.repoName,
      });
      return {
        uncommitted: uncommitted.map(withRepoIdentity),
        committed: committed.map(withRepoIdentity),
      };
    });
    return {
      workspaceLocalId: workspaceId,
      worktreeLocalId: worktreeId,
      uncommitted: sets.flatMap((set) => set.uncommitted),
      committed: sets.flatMap((set) => set.committed),
    };
  }
  const [uncommitted, committed] = await Promise.all([
    listChangedFiles(workspaceId, worktreeId),
    listCommittedChangedFiles(workspaceId, worktreeId),
  ]);
  return {
    workspaceLocalId: workspaceId,
    worktreeLocalId: worktreeId,
    uncommitted,
    committed,
  };
}

export async function readDiff(
  request: PortalDiffReadPayload,
): Promise<PortalDiffPayload> {
  validateId(request.workspaceId, 'workspaceId');
  validateId(request.worktreeId, 'worktreeId');
  if (request.workspaceId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const roots = await resolveSharedContainerViewerReadRoots(
      request.worktreeId,
    );
    const revisionId = roots[0]?.revisionId;
    const root = request.repoId
      ? roots.find((candidate) => candidate.repoId === request.repoId)
      : roots.length === 1
        ? roots[0]
        : undefined;
    if (!revisionId || !root) {
      throw new PortalServiceError(
        'invalid_target',
        'Diff root is unavailable.',
      );
    }
    const source = normalizeDiffReadSource(request.source);
    const reader = getSharedContainerReader();
    const selectedSources =
      source === 'combined'
        ? (['committed', 'uncommitted'] as const)
        : ([source] as const);
    const entries: Array<{
      repoId: string;
      repoName: string;
      path: string;
      status: string;
      source: 'committed' | 'uncommitted';
      insertions?: number;
      deletions?: number;
    }> = [];
    if (request.path) {
      const path = normalizeDiffPath(request.path);
      entries.push(
        ...selectedSources.map((selectedSource) => ({
          repoId: root.repoId,
          repoName: root.repoName,
          path,
          status: 'modified',
          source: selectedSource,
        })),
      );
    } else {
      for (const selectedRoot of request.repoId ? [root] : roots) {
        let cursor: string | undefined;
        do {
          const page = await reader.listRepositoryTree({
            containerId: request.worktreeId,
            revisionId,
            repoId: selectedRoot.repoId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          for (const entry of page.items) {
            if (
              entry.kind !== 'file' ||
              (entry.source !== 'committed' &&
                entry.source !== 'uncommitted') ||
              !selectedSources.includes(entry.source)
            ) {
              continue;
            }
            entries.push({
              repoId: selectedRoot.repoId,
              repoName: selectedRoot.repoName,
              path: entry.path,
              status: entry.status ?? 'modified',
              source: entry.source,
              ...(entry.insertions === undefined
                ? {}
                : { insertions: entry.insertions }),
              ...(entry.deletions === undefined
                ? {}
                : { deletions: entry.deletions }),
            });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
    }
    const patchParts: string[] = [];
    for (const entry of entries) {
      try {
        const diff = await reader.readOverlayDiff({
          containerId: request.worktreeId,
          revisionId,
          repoId: entry.repoId,
          path: entry.path,
          source: entry.source,
        });
        if (diff.binary) continue;
        // Each side is shown whole in the patch: one holding an agent
        // secret value, or one cut short, withholds it.
        await secretSafeView({
          kind: 'diff',
          oldValue: diff.oldValue,
          newValue: diff.newValue,
          truncated: diff.truncated === true,
        });
        const oldLines = diff.oldValue.split('\n');
        const newLines = diff.newValue.split('\n');
        patchParts.push(
          [
            `--- a/${entry.path}`,
            `+++ b/${entry.path}`,
            `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
            ...oldLines.map((line) => `-${line}`),
            ...newLines.map((line) => `+${line}`),
          ].join('\n'),
        );
      } catch (error) {
        if (error instanceof SecretViewUnavailableError)
          throw new PortalServiceError('invalid_target', error.message);
        if (request.path) throw error;
      }
    }
    const sharedPatch = patchParts.join('\n');
    if (sharedPatch) await withholdSecretPatch(sharedPatch, []);
    return {
      workspaceLocalId: request.workspaceId,
      worktreeLocalId: request.worktreeId,
      ...(request.path ? { filePath: normalizeDiffPath(request.path) } : {}),
      files: entries.map((entry) => ({
        filePath: entry.path,
        status: entry.status,
        repoId: entry.repoId,
        repoName: entry.repoName,
        ...(entry.insertions === undefined
          ? {}
          : { insertions: entry.insertions }),
        ...(entry.deletions === undefined
          ? {}
          : { deletions: entry.deletions }),
      })),
      patch: sharedPatch,
    };
  }
  const cwd = resolveWorktreeCwd(
    request.workspaceId,
    request.worktreeId,
    request.repoId,
  );
  const filePath = await validateDiffPathInsideWorktree(cwd, request.path);
  const source = normalizeDiffReadSource(request.source);
  // Resolve history only for sources that need it, sharing the same base
  // between committed metadata and the patch. Keep the complete source roster:
  // the shared diff viewer displays it even when the patch targets one path.
  const basePromise =
    source === 'uncommitted'
      ? Promise.resolve(null)
      : resolveCommittedDiffBase(
          request.workspaceId,
          request.worktreeId,
          cwd,
          request.repoId,
        );
  const [uncommitted, committed, base] = await Promise.all([
    source === 'committed'
      ? []
      : listChangedFilesAtPath(cwd, { estimateUntrackedLines: false }),
    source === 'uncommitted'
      ? []
      : basePromise.then((resolvedBase) =>
          listCommittedChangedFilesForBase(cwd, resolvedBase),
        ),
    basePromise,
  ]);
  const files =
    source === 'committed'
      ? committed
      : source === 'combined'
        ? mergeChangedFiles(uncommitted, committed)
        : uncommitted;
  const selectedFile =
    filePath !== undefined
      ? files.find((file) => file.filePath === filePath)
      : undefined;
  const pathArgs = ['--', ...(filePath ? [filePath] : [])];
  const args =
    source === 'committed'
      ? base
        ? ['diff', `${base.mergeBase}..HEAD`, ...pathArgs]
        : null
      : source === 'combined'
        ? ['diff', base?.mergeBase ?? 'HEAD', ...pathArgs]
        : ['diff', 'HEAD', ...pathArgs];
  const patch =
    source === 'uncommitted' && filePath && selectedFile?.status === 'untracked'
      ? await gitAllowDiffExit(
          ['diff', '--no-index', '--', NULL_DIFF_SOURCE, filePath],
          cwd,
        ).catch(() => '')
      : args
        ? await git(args, cwd).catch(() => '')
        : '';
  const rangeLabel =
    source === 'committed'
      ? base
        ? `${base.baseRef}...HEAD`
        : undefined
      : source === 'combined'
        ? base
          ? `${base.mergeBase.slice(0, 12)}..WORKTREE`
          : 'HEAD..WORKTREE'
        : undefined;
  // The patch is withheld whole when what it shows holds an agent secret
  // value, or a file in it is a secrets file.
  if (patch)
    await withholdSecretPatch(
      patch,
      filePath !== undefined && !selectedFile
        ? [join(cwd, filePath)]
        : (selectedFile ? [selectedFile] : files).flatMap((file) => [
            join(cwd, file.filePath),
            ...(file.previousPath ? [join(cwd, file.previousPath)] : []),
          ]),
    );
  return {
    workspaceLocalId: request.workspaceId,
    worktreeLocalId: request.worktreeId,
    ...(filePath ? { filePath } : {}),
    files,
    patch,
    ...(rangeLabel ? { rangeLabel } : {}),
  };
}

/**
 * Throws a Portal error, so the patch is withheld whole, when what it shows
 * holds an agent secret value or one of `paths` is a secrets file: a patch
 * shows parts of files with diff markers, so it can't be redacted.
 */
async function withholdSecretPatch(
  patch: string,
  paths: readonly string[],
): Promise<void> {
  try {
    await secretSafeView({ kind: 'patch', patch, paths });
  } catch (error) {
    if (error instanceof SecretViewUnavailableError)
      throw new PortalServiceError('invalid_target', error.message);
    throw error;
  }
}
