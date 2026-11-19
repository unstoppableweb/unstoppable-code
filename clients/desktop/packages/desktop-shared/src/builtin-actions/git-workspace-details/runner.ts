import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { rejectGitDiffFailure } from '../../lib/git-diff-failure';
import { getGitExecutableCommand } from '../../lib/git-executable';
import { setOutput, writeOutputFile } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024 * 32;
const MAX_UNTRACKED_FILE_BYTES = 512_000;
const INSTRUCTION_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md'];

interface ChangedFileRecord {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  previousPath?: string;
  origin?: string;
  protectedBaseline?: boolean;
  baselineReason?: string;
}

interface FileSnapshotRecord extends ChangedFileRecord {
  exists: boolean;
  contentHash: string | null;
}

interface BaselineClassificationRecord extends ChangedFileRecord {
  origin: string;
  protectedBaseline: boolean;
  baselineStatus: string | null;
  baselineExists: boolean | null;
  currentExists: boolean | null;
  baselineContentChanged: boolean;
  reason: string;
  planAuthorized: boolean;
  authorizationReason: string;
  reviewOrigin:
    | 'pipeline_changed'
    | 'plan_authorized_pre_existing'
    | 'protected_drift'
    | 'pre_existing_unchanged'
    | 'unclassified';
}

interface InstructionScopeRecord {
  path: string;
  appliesToFiles: string[];
}

interface WorkspaceDetailsRecord {
  generatedAt: string;
  repoRoot: string;
  currentBranch: string;
  requestedBaseBranch: string | null;
  baseBranch: string | null;
  mergeBase: string | null;
  /** Commit the reviewed diff was taken from; null for multi-repo workspaces. */
  head: string | null;
  includeUncommitted: boolean;
  hasUncommittedChanges: boolean;
  committedDiffAvailable: boolean;
  changedFiles: ChangedFileRecord[];
  reviewChangedFiles: BaselineClassificationRecord[];
  protectedDriftFiles: BaselineClassificationRecord[];
  candidateInstructionFiles: InstructionScopeRecord[];
  baselineClassification: BaselineClassificationRecord[];
}

interface PlanScopePathRecord {
  path?: string;
  prefix?: string;
  requirementIds?: string[];
  reason?: string;
}

interface PlanScopeBroadAreaRecord {
  description: string;
  requirementIds: string[];
}

interface PlanScopeRecord {
  version: number;
  allowedExactPaths: PlanScopePathRecord[];
  allowedPathPrefixes: PlanScopePathRecord[];
  broadAreas: PlanScopeBroadAreaRecord[];
}

interface RepoCheckpointRecord {
  repoRoot: string;
  relativePrefix: string;
  currentBranch: string;
  baseBranch: string | null;
  mergeBase: string | null;
  head: string | null;
  changedFiles: FileSnapshotRecord[];
}

interface WorkspaceCheckpointRecord {
  version: number;
  generatedAt: string;
  repoRoot: string;
  currentBranch: string;
  baseBranch: string | null;
  mergeBase: string | null;
  repoSnapshots: RepoCheckpointRecord[];
  changedFiles: FileSnapshotRecord[];
}

interface RepoDiffContext {
  repoRoot: string;
  relativePrefix: string;
  currentBranch: string;
  baseBranch: string | null;
  mergeBase: string | null;
  head: string | null;
  hasUncommittedChanges: boolean;
  committedDiff: string;
  uncommittedDiff: string;
  changedFiles: ChangedFileRecord[];
  fileSnapshots: FileSnapshotRecord[];
}

const SAFE_WORKSPACE_REPO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join('/');
}

function joinRepoPath(prefix: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRepoPath(relativePath).replace(
    /^\.\//,
    '',
  );
  if (!prefix) {
    return normalizedRelativePath;
  }
  return `${prefix}/${normalizedRelativePath}`;
}

async function runGit(
  args: string[],
  cwd: string,
  trim = true,
): Promise<string> {
  const result = await execFileAsync(
    getGitExecutableCommand(process.env),
    args,
    {
      cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: process.platform === 'win32',
    },
  );
  return trim ? result.stdout.trim() : result.stdout;
}

/** Diff and untracked reads reject with a typed error; they never yield ''. */
function runGitDiffRead(
  args: string[],
  cwd: string,
  trim = true,
): Promise<string> {
  return rejectGitDiffFailure(() => runGit(args, cwd, trim));
}

function parseBooleanInput(
  raw: string | undefined,
  defaultValue: boolean,
): boolean {
  if (!raw || raw.trim().length === 0) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new Error('include_uncommitted must be "true" or "false" when set');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeWorkspaceRepoId(value: string): boolean {
  return SAFE_WORKSPACE_REPO_ID_PATTERN.test(value);
}

function readManifestRepoIds(parsed: unknown): string[] {
  if (!isRecord(parsed)) {
    return [];
  }
  const reposValue = parsed.repos;
  if (!Array.isArray(reposValue)) {
    return [];
  }

  const repoIds = new Set<string>();
  for (const entry of reposValue) {
    if (!isRecord(entry)) {
      continue;
    }
    const idValue = entry.id;
    if (typeof idValue !== 'string') {
      continue;
    }
    const trimmed = idValue.trim();
    if (isSafeWorkspaceRepoId(trimmed)) {
      repoIds.add(trimmed);
    }
  }

  return Array.from(repoIds).sort((left, right) => left.localeCompare(right));
}

async function readCanopyManifestRepoIds(repoRoot: string): Promise<string[]> {
  const canopyJsonPath = path.join(repoRoot, 'canopy.json');
  try {
    const raw = await readFile(canopyJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return readManifestRepoIds(parsed);
  } catch {
    return [];
  }
}

async function resolveWorkspaceRepoPrefixes(
  cwd: string,
  repoRoot: string,
): Promise<string[]> {
  if (path.resolve(cwd) !== path.resolve(repoRoot)) {
    return [''];
  }

  const manifestRepoIds = await readCanopyManifestRepoIds(repoRoot);
  const reposDir = path.join(repoRoot, 'repos');
  if (manifestRepoIds.length === 0 || !(await isDirectory(reposDir))) {
    return [''];
  }

  const discoveredRepoIds = new Set(manifestRepoIds);
  const entries = await readdir(reposDir, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (entry.isDirectory() && isSafeWorkspaceRepoId(entry.name)) {
      discoveredRepoIds.add(entry.name);
    }
  }

  const childPrefixes: string[] = [];
  for (const repoId of Array.from(discoveredRepoIds).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const repoPath = path.join(reposDir, repoId);
    try {
      const childRepoRoot = await runGit(
        ['rev-parse', '--show-toplevel'],
        repoPath,
      );
      if (path.resolve(childRepoRoot) === path.resolve(repoPath)) {
        childPrefixes.push(`repos/${repoId}`);
      }
    } catch {
      // Missing or non-git child repos should not hide changes from healthy repos.
    }
  }

  return ['', ...childPrefixes];
}

async function resolveBaseBranch(
  cwd: string,
  requestedBaseBranch: string | undefined,
): Promise<string | null> {
  const trimmedRequested = requestedBaseBranch?.trim();
  if (trimmedRequested) {
    return trimmedRequested;
  }

  try {
    const output = await runGit(
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      cwd,
    );
    const match = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Fall through to local detection.
  }

  try {
    const output = await runGit(
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      cwd,
    );
    const prefix = 'refs/remotes/origin/';
    if (output.startsWith(prefix)) {
      return output.slice(prefix.length);
    }
  } catch {
    // Fall through to common defaults.
  }

  for (const candidate of ['main', 'master']) {
    try {
      await runGit(
        ['rev-parse', '--verify', `refs/remotes/origin/${candidate}`],
        cwd,
      );
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

async function resolveMergeBase(
  cwd: string,
  baseBranch: string | null,
): Promise<string | null> {
  if (!baseBranch) {
    return null;
  }

  for (const candidate of [`origin/${baseBranch}`, baseBranch]) {
    try {
      const mergeBase = await runGit(['merge-base', candidate, 'HEAD'], cwd);
      if (mergeBase) {
        return mergeBase;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function mapChangedFileStatus(statusCode: string): string {
  switch (statusCode[0]) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'unmerged';
    case 'T':
      return 'type-changed';
    default:
      return 'unknown';
  }
}

function normalizeNumstatPath(rawPath: string): string {
  const arrowToken = ' => ';
  const arrowIndex = rawPath.indexOf(arrowToken);
  if (arrowIndex === -1) {
    return rawPath;
  }

  const braceMatch = rawPath.match(/^(.*)\{[^}]* => ([^}]*)\}(.*)$/);
  if (braceMatch) {
    return `${braceMatch[1]}${braceMatch[2]}${braceMatch[3]}`;
  }

  return rawPath.slice(arrowIndex + arrowToken.length);
}

function parseChangedFiles(
  statusOutput: string,
  numstatOutput: string,
): Map<string, ChangedFileRecord> {
  const changedFiles = new Map<string, ChangedFileRecord>();

  for (const line of statusOutput.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 2) {
      continue;
    }

    const statusCode = parts[0];
    const nextPath = parts[parts.length - 1];
    const previousPath =
      (statusCode.startsWith('R') || statusCode.startsWith('C')) &&
      parts.length >= 3
        ? parts[1]
        : undefined;

    changedFiles.set(nextPath, {
      path: nextPath,
      status: mapChangedFileStatus(statusCode),
      insertions: 0,
      deletions: 0,
      ...(previousPath ? { previousPath } : {}),
    });
  }

  for (const line of numstatOutput.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) {
      continue;
    }

    const rawPath = parts[parts.length - 1];
    const normalizedPath = normalizeNumstatPath(rawPath);
    const current = changedFiles.get(normalizedPath);
    if (!current) {
      continue;
    }

    changedFiles.set(normalizedPath, {
      ...current,
      insertions: parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0,
      deletions: parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0,
    });
  }

  return changedFiles;
}

async function estimateUntrackedInsertions(
  cwd: string,
  relativePath: string,
): Promise<number> {
  try {
    const absolutePath = path.join(cwd, relativePath);
    const fileStat = await stat(absolutePath);
    if (fileStat.size > MAX_UNTRACKED_FILE_BYTES) {
      return Math.ceil(fileStat.size / 40);
    }

    const content = await readFile(absolutePath, 'utf8');
    if (content.length === 0) {
      return 0;
    }
    const lines = content.endsWith('\n')
      ? content.slice(0, -1).split(/\r?\n/)
      : content.split(/\r?\n/);
    return lines.length;
  } catch {
    return 0;
  }
}

async function loadCombinedChangedFiles(
  cwd: string,
  diffBaseRef: string,
  includeUncommitted: boolean,
): Promise<ChangedFileRecord[]> {
  const diffRef = includeUncommitted ? diffBaseRef : `${diffBaseRef}..HEAD`;
  const [statusOutput, numstatOutput, untrackedOutput] = await Promise.all([
    runGitDiffRead(
      ['diff', diffRef, '--name-status', '--find-renames', '--find-copies'],
      cwd,
    ),
    runGitDiffRead(
      ['diff', diffRef, '--numstat', '--find-renames', '--find-copies'],
      cwd,
    ),
    includeUncommitted
      ? runGitDiffRead(['ls-files', '--others', '--exclude-standard'], cwd)
      : Promise.resolve(''),
  ]);

  const changedFiles = parseChangedFiles(statusOutput, numstatOutput);
  const untrackedFiles = untrackedOutput.split(/\r?\n/).filter(Boolean);

  for (const untrackedFile of untrackedFiles) {
    if (changedFiles.has(untrackedFile)) {
      continue;
    }

    changedFiles.set(untrackedFile, {
      path: untrackedFile,
      status: 'untracked',
      insertions: await estimateUntrackedInsertions(cwd, untrackedFile),
      deletions: 0,
    });
  }

  return Array.from(changedFiles.values()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function prefixChangedFiles(
  records: ChangedFileRecord[],
  relativePrefix: string,
): ChangedFileRecord[] {
  if (!relativePrefix) {
    return records;
  }

  return records.map((record) => ({
    ...record,
    path: joinRepoPath(relativePrefix, record.path),
    ...(record.previousPath
      ? { previousPath: joinRepoPath(relativePrefix, record.previousPath) }
      : {}),
  }));
}

function prefixFileSnapshots(
  records: FileSnapshotRecord[],
  relativePrefix: string,
): FileSnapshotRecord[] {
  if (!relativePrefix) {
    return records;
  }

  return records.map((record) => ({
    ...record,
    path: joinRepoPath(relativePrefix, record.path),
    ...(record.previousPath
      ? { previousPath: joinRepoPath(relativePrefix, record.previousPath) }
      : {}),
  }));
}

async function hashFileContent(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

async function snapshotChangedFiles(
  cwd: string,
  records: ChangedFileRecord[],
): Promise<FileSnapshotRecord[]> {
  const snapshots: FileSnapshotRecord[] = [];

  for (const record of records) {
    const absolutePath = path.join(cwd, record.path);
    const exists = await fileExists(absolutePath);
    snapshots.push({
      ...record,
      exists,
      contentHash: exists ? await hashFileContent(absolutePath) : null,
    });
  }

  return snapshots;
}

async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath);
    return content.includes(0);
  } catch {
    return true;
  }
}

function buildNewFilePatch(relativePath: string, content: string): string {
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const lines =
    normalizedContent.length === 0
      ? []
      : normalizedContent.endsWith('\n')
        ? normalizedContent.slice(0, -1).split('\n')
        : normalizedContent.split('\n');
  const addedLines = lines.map((line) => `+${line}`).join('\n');
  const lineCount = lines.length;

  const segments = [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lineCount} @@`,
  ];

  if (addedLines.length > 0) {
    segments.push(addedLines);
  }

  return `${segments.join('\n')}\n`;
}

async function buildUntrackedDiff(cwd: string): Promise<string> {
  const untrackedOutput = await runGitDiffRead(
    ['ls-files', '--others', '--exclude-standard'],
    cwd,
  );
  const untrackedFiles = untrackedOutput.split(/\r?\n/).filter(Boolean);
  let diff = '';

  for (const relativePath of untrackedFiles) {
    const absolutePath = path.join(cwd, relativePath);
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      continue;
    }

    if (fileStat.size > MAX_UNTRACKED_FILE_BYTES) {
      continue;
    }

    if (await isBinaryFile(absolutePath)) {
      continue;
    }

    const content = await readFile(absolutePath, 'utf8');
    diff += buildNewFilePatch(relativePath, content);
  }

  return diff;
}

async function buildUncommittedDiff(cwd: string): Promise<string> {
  const trackedDiff = await runGitDiffRead(['diff', 'HEAD'], cwd, false);
  const untrackedDiff = await buildUntrackedDiff(cwd);
  return `${trackedDiff}${untrackedDiff}`;
}

function prefixDiffPaths(diff: string, relativePrefix: string): string {
  if (!relativePrefix || diff.trim().length === 0) {
    return diff;
  }

  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git a/')) {
        return line.replace(
          /^diff --git a\/(.+) b\/(.+)$/,
          `diff --git a/${relativePrefix}/$1 b/${relativePrefix}/$2`,
        );
      }
      if (line.startsWith('--- a/')) {
        return line.replace(/^--- a\/(.+)$/, `--- a/${relativePrefix}/$1`);
      }
      if (line.startsWith('+++ b/')) {
        return line.replace(/^\+\+\+ b\/(.+)$/, `+++ b/${relativePrefix}/$1`);
      }
      if (line.startsWith('rename from ')) {
        return line.replace(
          /^rename from (.+)$/,
          `rename from ${relativePrefix}/$1`,
        );
      }
      if (line.startsWith('rename to ')) {
        return line.replace(
          /^rename to (.+)$/,
          `rename to ${relativePrefix}/$1`,
        );
      }
      if (line.startsWith('copy from ')) {
        return line.replace(
          /^copy from (.+)$/,
          `copy from ${relativePrefix}/$1`,
        );
      }
      if (line.startsWith('copy to ')) {
        return line.replace(/^copy to (.+)$/, `copy to ${relativePrefix}/$1`);
      }
      return line;
    })
    .join('\n');
}

async function collectRepoDiffContext(
  workspaceRoot: string,
  relativePrefix: string,
  requestedBaseBranch: string | undefined,
  includeUncommitted: boolean,
): Promise<RepoDiffContext> {
  const repoPath = relativePrefix
    ? path.join(workspaceRoot, relativePrefix)
    : workspaceRoot;
  const repoRoot = await runGit(['rev-parse', '--show-toplevel'], repoPath);
  const currentBranch = await runGit(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoPath,
  );
  const head = await runGit(['rev-parse', 'HEAD'], repoPath).catch(() => null);
  const baseBranch = await resolveBaseBranch(repoPath, requestedBaseBranch);
  const mergeBase = await resolveMergeBase(repoPath, baseBranch);
  const hasUncommittedChanges =
    (
      await runGit(
        ['status', '--porcelain', '--untracked-files=normal'],
        repoPath,
      )
    ).length > 0;

  const diffBaseRef = mergeBase ?? 'HEAD';
  const committedDiff = mergeBase
    ? await runGitDiffRead(['diff', `${mergeBase}..HEAD`], repoPath, false)
    : '';
  const uncommittedDiff = includeUncommitted
    ? await buildUncommittedDiff(repoPath)
    : '';
  const rawChangedFiles = await loadCombinedChangedFiles(
    repoPath,
    diffBaseRef,
    includeUncommitted,
  );
  const changedFiles = prefixChangedFiles(rawChangedFiles, relativePrefix);
  const fileSnapshots = prefixFileSnapshots(
    await snapshotChangedFiles(repoPath, rawChangedFiles),
    relativePrefix,
  );

  return {
    repoRoot,
    relativePrefix,
    currentBranch,
    baseBranch,
    mergeBase,
    head,
    hasUncommittedChanges,
    committedDiff: prefixDiffPaths(committedDiff, relativePrefix),
    uncommittedDiff: prefixDiffPaths(uncommittedDiff, relativePrefix),
    changedFiles,
    fileSnapshots,
  };
}

function commonStringValue(values: Array<string | null>): string | null {
  const nonEmptyValues = values.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (nonEmptyValues.length === 0) {
    return null;
  }
  const first = nonEmptyValues[0];
  return nonEmptyValues.every((value) => value === first) ? first : null;
}

function parseSnapshotRecord(value: unknown): FileSnapshotRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const pathValue = value.path;
  const statusValue = value.status;
  if (typeof pathValue !== 'string' || typeof statusValue !== 'string') {
    return null;
  }

  const insertionsValue = value.insertions;
  const deletionsValue = value.deletions;
  const previousPathValue = value.previousPath;
  const contentHashValue = value.contentHash;

  return {
    path: normalizeRepoPath(pathValue).replace(/^\.\//, ''),
    status: statusValue,
    insertions:
      typeof insertionsValue === 'number' && Number.isFinite(insertionsValue)
        ? insertionsValue
        : 0,
    deletions:
      typeof deletionsValue === 'number' && Number.isFinite(deletionsValue)
        ? deletionsValue
        : 0,
    ...(typeof previousPathValue === 'string'
      ? { previousPath: normalizeRepoPath(previousPathValue) }
      : {}),
    exists: value.exists === true,
    contentHash:
      typeof contentHashValue === 'string' && contentHashValue.length > 0
        ? contentHashValue
        : null,
  };
}

function collectSnapshotRecords(value: unknown): FileSnapshotRecord[] {
  if (!isRecord(value)) {
    return [];
  }

  const records: FileSnapshotRecord[] = [];
  if (Array.isArray(value.changedFiles)) {
    for (const entry of value.changedFiles) {
      const snapshot = parseSnapshotRecord(entry);
      if (snapshot) {
        records.push(snapshot);
      }
    }
  }

  if (Array.isArray(value.repoSnapshots)) {
    for (const repoSnapshot of value.repoSnapshots) {
      if (
        !isRecord(repoSnapshot) ||
        !Array.isArray(repoSnapshot.changedFiles)
      ) {
        continue;
      }
      for (const entry of repoSnapshot.changedFiles) {
        const snapshot = parseSnapshotRecord(entry);
        if (snapshot) {
          records.push(snapshot);
        }
      }
    }
  }

  return records;
}

async function loadCheckpointSnapshotMap(
  checkpointFile: string | undefined,
): Promise<Map<string, FileSnapshotRecord>> {
  const snapshotMap = new Map<string, FileSnapshotRecord>();
  const normalizedCheckpointFile = checkpointFile?.trim();
  if (!normalizedCheckpointFile) {
    return snapshotMap;
  }
  if (!(await fileExists(normalizedCheckpointFile))) {
    return snapshotMap;
  }

  const parsed: unknown = JSON.parse(
    await readFile(normalizedCheckpointFile, 'utf8'),
  );
  for (const snapshot of collectSnapshotRecords(parsed)) {
    snapshotMap.set(snapshot.path, snapshot);
  }
  return snapshotMap;
}

function normalizePlanScopePath(value: string): string {
  return normalizeRepoPath(value).replace(/^\.\//, '').trim();
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readPlanScopePathRecords(value: unknown): PlanScopePathRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records: PlanScopePathRecord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const rawPath = typeof entry.path === 'string' ? entry.path : '';
    const rawPrefix = typeof entry.prefix === 'string' ? entry.prefix : '';
    const normalizedPath = rawPath ? normalizePlanScopePath(rawPath) : '';
    const normalizedPrefix = rawPrefix ? normalizePlanScopePath(rawPrefix) : '';
    const requirementIds = readStringList(entry.requirementIds);
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';

    if (normalizedPath) {
      records.push({
        path: normalizedPath,
        requirementIds,
        reason,
      });
    } else if (normalizedPrefix) {
      records.push({
        prefix: normalizedPrefix.endsWith('/')
          ? normalizedPrefix
          : `${normalizedPrefix}/`,
        requirementIds,
        reason,
      });
    }
  }

  return records;
}

async function loadPlanScope(
  planScopeFile: string | undefined,
): Promise<PlanScopeRecord | null> {
  const normalizedPlanScopeFile = planScopeFile?.trim();
  if (
    !normalizedPlanScopeFile ||
    !(await fileExists(normalizedPlanScopeFile))
  ) {
    return null;
  }

  const parsed: unknown = JSON.parse(
    await readFile(normalizedPlanScopeFile, 'utf8'),
  );
  if (!isRecord(parsed)) {
    return null;
  }

  const broadAreas = Array.isArray(parsed.broadAreas)
    ? parsed.broadAreas.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.description !== 'string') {
          return [];
        }
        return [
          {
            description: entry.description.trim(),
            requirementIds: readStringList(entry.requirementIds),
          },
        ];
      })
    : [];

  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    allowedExactPaths: readPlanScopePathRecords(parsed.allowedExactPaths),
    allowedPathPrefixes: readPlanScopePathRecords(parsed.allowedPathPrefixes),
    broadAreas,
  };
}

function matchPlanScope(
  relativePath: string,
  planScope: PlanScopeRecord | null,
): { authorized: boolean; reason: string } {
  if (!planScope) {
    return { authorized: false, reason: '' };
  }

  const normalizedPath = normalizePlanScopePath(relativePath);
  for (const record of planScope.allowedExactPaths) {
    const exactPath = record.path ? normalizePlanScopePath(record.path) : '';
    if (!exactPath || exactPath !== normalizedPath) {
      continue;
    }
    const reason = record.reason?.trim() || 'Matched plan-scope exact path.';
    return { authorized: true, reason };
  }

  for (const record of planScope.allowedPathPrefixes) {
    const rawPrefix = record.prefix ?? record.path ?? '';
    const normalizedPrefix = normalizePlanScopePath(rawPrefix);
    if (!normalizedPrefix) {
      continue;
    }
    const prefix = normalizedPrefix.endsWith('/')
      ? normalizedPrefix
      : `${normalizedPrefix}/`;
    if (
      normalizedPath === normalizedPrefix ||
      normalizedPath.startsWith(prefix)
    ) {
      const reason = record.reason?.trim() || 'Matched plan-scope path prefix.';
      return { authorized: true, reason };
    }
  }

  return { authorized: false, reason: '' };
}

function changedSnapshotContent(
  current: FileSnapshotRecord,
  baseline: FileSnapshotRecord,
): boolean {
  return (
    current.status !== baseline.status ||
    current.exists !== baseline.exists ||
    current.contentHash !== baseline.contentHash
  );
}

function classifyBaselineChanges(
  currentSnapshots: FileSnapshotRecord[],
  checkpointSnapshots: Map<string, FileSnapshotRecord>,
  planScope: PlanScopeRecord | null,
): BaselineClassificationRecord[] {
  const currentMap = new Map<string, FileSnapshotRecord>();
  for (const snapshot of currentSnapshots) {
    currentMap.set(snapshot.path, snapshot);
  }

  if (checkpointSnapshots.size === 0) {
    return currentSnapshots.map((snapshot) => ({
      ...snapshot,
      origin: 'unclassified',
      protectedBaseline: false,
      baselineStatus: null,
      baselineExists: null,
      currentExists: snapshot.exists,
      baselineContentChanged: false,
      reason: 'No pipeline-start checkpoint was provided.',
      planAuthorized: false,
      authorizationReason: '',
      reviewOrigin: 'unclassified',
    }));
  }

  const classified: BaselineClassificationRecord[] = [];
  for (const current of currentSnapshots) {
    const baseline = checkpointSnapshots.get(current.path);
    if (!baseline) {
      classified.push({
        ...current,
        origin: 'pipeline_changed',
        protectedBaseline: false,
        baselineStatus: null,
        baselineExists: null,
        currentExists: current.exists,
        baselineContentChanged: false,
        reason:
          'This path was not part of the pipeline-start changed-file checkpoint.',
        planAuthorized: false,
        authorizationReason: '',
        reviewOrigin: 'pipeline_changed',
      });
      continue;
    }

    const baselineContentChanged = changedSnapshotContent(current, baseline);
    if (!baselineContentChanged) {
      classified.push({
        ...current,
        origin: 'pre_existing_unchanged',
        protectedBaseline: true,
        baselineStatus: baseline.status,
        baselineExists: baseline.exists,
        currentExists: current.exists,
        baselineContentChanged: false,
        reason:
          'This path was already changed at pipeline start and still matches that checkpoint.',
        planAuthorized: false,
        authorizationReason: '',
        reviewOrigin: 'pre_existing_unchanged',
      });
      continue;
    }

    const authorization = matchPlanScope(current.path, planScope);
    classified.push({
      ...current,
      origin:
        baseline.exists && !current.exists
          ? 'pipeline_deleted_pre_existing'
          : 'pipeline_modified_pre_existing',
      protectedBaseline: true,
      baselineStatus: baseline.status,
      baselineExists: baseline.exists,
      currentExists: current.exists,
      baselineContentChanged: true,
      reason:
        'This protected path was already changed at pipeline start and changed again after the checkpoint.',
      planAuthorized: authorization.authorized,
      authorizationReason: authorization.reason,
      reviewOrigin: authorization.authorized
        ? 'plan_authorized_pre_existing'
        : 'protected_drift',
    });
  }

  const baselineSnapshots = Array.from(checkpointSnapshots.values());
  for (const baseline of baselineSnapshots) {
    if (currentMap.has(baseline.path)) {
      continue;
    }
    const authorization = matchPlanScope(baseline.path, planScope);
    classified.push({
      path: baseline.path,
      status: 'reverted',
      insertions: 0,
      deletions: 0,
      ...(baseline.previousPath ? { previousPath: baseline.previousPath } : {}),
      origin: 'pipeline_reverted_pre_existing',
      protectedBaseline: true,
      baselineStatus: baseline.status,
      baselineExists: baseline.exists,
      currentExists: null,
      baselineContentChanged: true,
      reason:
        'This protected path was changed at pipeline start but no longer appears in the current changed-file set.',
      planAuthorized: authorization.authorized,
      authorizationReason: authorization.reason,
      reviewOrigin: authorization.authorized
        ? 'plan_authorized_pre_existing'
        : 'protected_drift',
    });
  }

  return classified.sort((left, right) => left.path.localeCompare(right.path));
}

function isPipelineOwnedChange(record: BaselineClassificationRecord): boolean {
  return record.origin !== 'pre_existing_unchanged';
}

function isReviewableChange(record: BaselineClassificationRecord): boolean {
  return (
    record.reviewOrigin === 'pipeline_changed' ||
    record.reviewOrigin === 'plan_authorized_pre_existing' ||
    record.reviewOrigin === 'unclassified'
  );
}

function isProtectedDrift(record: BaselineClassificationRecord): boolean {
  return record.reviewOrigin === 'protected_drift';
}

function buildWorkspaceCheckpoint(
  generatedAt: string,
  repoRoot: string,
  currentBranch: string,
  baseBranch: string | null,
  mergeBase: string | null,
  repoContexts: RepoDiffContext[],
): WorkspaceCheckpointRecord {
  const repoSnapshots = repoContexts.map((context) => ({
    repoRoot: normalizeRepoPath(context.repoRoot),
    relativePrefix: context.relativePrefix,
    currentBranch: context.currentBranch,
    baseBranch: context.baseBranch,
    mergeBase: context.mergeBase,
    head: context.head,
    changedFiles: context.fileSnapshots,
  }));
  const changedFiles = repoContexts
    .flatMap((context) => context.fileSnapshots)
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    version: 1,
    generatedAt,
    repoRoot: normalizeRepoPath(repoRoot),
    currentBranch,
    baseBranch,
    mergeBase,
    repoSnapshots,
    changedFiles,
  };
}

async function collectInstructionScopes(
  repoRoot: string,
  changedFiles: ChangedFileRecord[],
): Promise<InstructionScopeRecord[]> {
  const scopeMap = new Map<string, Set<string>>();

  async function addInstructionFile(
    instructionPath: string,
    changedPath: string | null,
  ): Promise<void> {
    if (!(await fileExists(instructionPath))) {
      return;
    }

    const relativePath = normalizeRepoPath(
      path.relative(repoRoot, instructionPath),
    );
    const current = scopeMap.get(relativePath) ?? new Set<string>();
    if (changedPath) {
      current.add(changedPath);
    }
    scopeMap.set(relativePath, current);
  }

  for (const instructionFileName of INSTRUCTION_FILE_NAMES) {
    await addInstructionFile(path.join(repoRoot, instructionFileName), null);
  }

  for (const changedFile of changedFiles) {
    let currentDirectory = path.dirname(path.join(repoRoot, changedFile.path));

    while (true) {
      for (const instructionFileName of INSTRUCTION_FILE_NAMES) {
        await addInstructionFile(
          path.join(currentDirectory, instructionFileName),
          changedFile.path,
        );
      }

      if (path.resolve(currentDirectory) === path.resolve(repoRoot)) {
        break;
      }

      const parentDirectory = path.dirname(currentDirectory);
      if (parentDirectory === currentDirectory) {
        break;
      }
      currentDirectory = parentDirectory;
    }
  }

  return Array.from(scopeMap.entries())
    .map(([instructionPath, appliesToFiles]) => ({
      path: instructionPath,
      appliesToFiles: Array.from(appliesToFiles).sort((left, right) =>
        left.localeCompare(right),
      ),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function renderChangedFileSummary(record: ChangedFileRecord): string {
  const stats = `+${String(record.insertions)} -${String(record.deletions)}`;
  const renameDetails = record.previousPath
    ? ` (${record.previousPath} -> ${record.path})`
    : '';
  return `- ${record.status}: ${record.path} (${stats})${renameDetails}`;
}

function renderInstructionScopeSummary(record: InstructionScopeRecord): string {
  if (record.appliesToFiles.length === 0) {
    return `- ${record.path} (root instruction file)`;
  }

  return `- ${record.path} (applies to: ${record.appliesToFiles.join(', ')})`;
}

function renderBaselineClassificationSummary(
  record: BaselineClassificationRecord,
): string {
  const stats = `+${String(record.insertions)} -${String(record.deletions)}`;
  const protectedMarker = record.protectedBaseline ? ' protected' : '';
  const authorization = record.planAuthorized
    ? ` plan-authorized: ${record.authorizationReason || 'matched plan scope'};`
    : '';
  return `- ${record.origin}${protectedMarker}: ${record.path} (${stats}); reviewOrigin=${record.reviewOrigin};${authorization} ${record.reason}`;
}

function renderWorkspaceSummary(details: WorkspaceDetailsRecord): string {
  const changedFilesSection =
    details.changedFiles.length > 0
      ? details.changedFiles.map(renderChangedFileSummary).join('\n')
      : '- No changed files detected.';
  const instructionScopesSection =
    details.candidateInstructionFiles.length > 0
      ? details.candidateInstructionFiles
          .map(renderInstructionScopeSummary)
          .join('\n')
      : '- No instruction files detected.';
  const baselineClassificationSection =
    details.baselineClassification.length > 0
      ? details.baselineClassification
          .map(renderBaselineClassificationSummary)
          .join('\n')
      : '- No baseline classification was produced.';
  const reviewChangedFilesSection =
    details.reviewChangedFiles.length > 0
      ? details.reviewChangedFiles
          .map(renderBaselineClassificationSummary)
          .join('\n')
      : '- No reviewable pipeline changes detected.';
  const protectedDriftSection =
    details.protectedDriftFiles.length > 0
      ? details.protectedDriftFiles
          .map(renderBaselineClassificationSummary)
          .join('\n')
      : '- No protected drift detected.';

  return [
    '# Git Project Details',
    '',
    `- Repo root: ${details.repoRoot}`,
    `- Current branch: ${details.currentBranch}`,
    `- Requested base branch: ${details.requestedBaseBranch ?? '(auto)'}`,
    `- Resolved base branch: ${details.baseBranch ?? '(none)'}`,
    `- Merge base: ${details.mergeBase ?? '(unavailable)'}`,
    `- Include uncommitted changes: ${String(details.includeUncommitted)}`,
    `- Has uncommitted changes: ${String(details.hasUncommittedChanges)}`,
    `- Committed diff available: ${String(details.committedDiffAvailable)}`,
    '',
    `## Changed Files (${String(details.changedFiles.length)})`,
    changedFilesSection,
    '',
    `## Baseline-Aware Change Classification (${String(details.baselineClassification.length)})`,
    baselineClassificationSection,
    '',
    `## Reviewable Pipeline Changes (${String(details.reviewChangedFiles.length)})`,
    reviewChangedFilesSection,
    '',
    `## Protected Drift (${String(details.protectedDriftFiles.length)})`,
    protectedDriftSection,
    '',
    `## Candidate Instruction Files (${String(details.candidateInstructionFiles.length)})`,
    instructionScopesSection,
    '',
  ].join('\n');
}

function buildCombinedDiff(
  mergeBase: string | null,
  committedDiff: string,
  uncommittedDiff: string,
  multiRepo: boolean,
): string {
  const committedHeader = multiRepo
    ? '=== COMMITTED DIFF (per-repo merge base..HEAD) ==='
    : mergeBase
      ? `=== COMMITTED DIFF (${mergeBase}..HEAD) ===`
      : '=== COMMITTED DIFF (unavailable: merge base not found) ===';

  const committedBody =
    (mergeBase || multiRepo) && committedDiff.trim().length > 0
      ? committedDiff
      : mergeBase || multiRepo
        ? '\n'
        : 'Unable to determine the merge base for committed changes.\n';

  const uncommittedBody =
    uncommittedDiff.trim().length > 0 ? uncommittedDiff : '\n';

  return [
    committedHeader,
    committedBody,
    '',
    multiRepo
      ? '=== UNCOMMITTED DIFF (per-repo HEAD -> working tree) ==='
      : '=== UNCOMMITTED DIFF (HEAD -> working tree) ===',
    uncommittedBody,
  ].join('\n');
}

function parseDiffHeaderPaths(line: string): string[] {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) {
    return [];
  }
  return [
    normalizeRepoPath(match[1]).replace(/^\.\//, ''),
    normalizeRepoPath(match[2]).replace(/^\.\//, ''),
  ];
}

function diffHeaderMatchesReviewPaths(
  line: string,
  reviewPaths: Set<string>,
): boolean {
  return parseDiffHeaderPaths(line).some((diffPath) =>
    reviewPaths.has(diffPath),
  );
}

function filterDiffToReviewPaths(
  fullDiff: string,
  reviewChangedFiles: BaselineClassificationRecord[],
  checkpointProvided: boolean,
): string {
  if (!checkpointProvided) {
    return fullDiff;
  }

  const reviewPaths = new Set(
    reviewChangedFiles.flatMap((record) =>
      record.previousPath ? [record.path, record.previousPath] : [record.path],
    ),
  );
  if (reviewPaths.size === 0) {
    return [
      '=== REVIEW DIFF (filtered to pipeline-owned and plan-authorized changes) ===',
      'No reviewable changed files were detected.',
      '',
    ].join('\n');
  }

  const lines = fullDiff.split('\n');
  const outputLines: string[] = [
    '=== REVIEW DIFF (filtered to pipeline-owned and plan-authorized changes) ===',
  ];
  let currentSection: string[] = [];
  let includeCurrentSection = false;
  let sawDiffHeader = false;

  const flushSection = (): void => {
    if (includeCurrentSection && currentSection.length > 0) {
      outputLines.push(...currentSection);
    }
    currentSection = [];
    includeCurrentSection = false;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      sawDiffHeader = true;
      flushSection();
      currentSection = [line];
      includeCurrentSection = diffHeaderMatchesReviewPaths(line, reviewPaths);
      continue;
    }

    if (currentSection.length > 0) {
      currentSection.push(line);
    } else if (line.startsWith('===')) {
      outputLines.push(line);
    }
  }

  flushSection();

  if (!sawDiffHeader) {
    return [
      '=== REVIEW DIFF (fallback: no diff headers found) ===',
      fullDiff,
    ].join('\n');
  }

  return `${outputLines.join('\n')}\n`;
}

function renderProtectedDriftSummary(
  protectedDriftFiles: BaselineClassificationRecord[],
): string {
  if (protectedDriftFiles.length === 0) {
    return '# Protected Drift\n\nNo protected drift detected.\n';
  }

  return [
    '# Protected Drift',
    '',
    'These paths were changed before the pipeline checkpoint and then changed, deleted, or reverted by later pipeline or verification activity without matching the plan scope.',
    '',
    ...protectedDriftFiles.map(renderBaselineClassificationSummary),
    '',
  ].join('\n');
}

export async function runGitWorkspaceDetailsAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const cwd = process.cwd();
    const requestedBaseBranch = env.INPUT_BASE_BRANCH?.trim() || undefined;
    const includeUncommitted = parseBooleanInput(
      env.INPUT_INCLUDE_UNCOMMITTED,
      true,
    );
    const checkpointFile = env.INPUT_CHECKPOINT_FILE?.trim() || undefined;
    const planScopeFile = env.INPUT_PLAN_SCOPE_FILE?.trim() || undefined;
    const checkpointSnapshots = await loadCheckpointSnapshotMap(checkpointFile);
    const planScope = await loadPlanScope(planScopeFile);

    const repoRoot = await runGit(['rev-parse', '--show-toplevel'], cwd);
    const repoPrefixes = await resolveWorkspaceRepoPrefixes(cwd, repoRoot);
    const repoContexts = await Promise.all(
      repoPrefixes.map((relativePrefix) =>
        collectRepoDiffContext(
          repoRoot,
          relativePrefix,
          requestedBaseBranch,
          includeUncommitted,
        ),
      ),
    );
    const currentBranch =
      commonStringValue(repoContexts.map((context) => context.currentBranch)) ??
      '(multiple)';
    const baseBranch = commonStringValue(
      repoContexts.map((context) => context.baseBranch),
    );
    const mergeBase =
      repoContexts.length === 1 ? repoContexts[0].mergeBase : null;
    const head = repoContexts.length === 1 ? repoContexts[0].head : null;
    const hasUncommittedChanges = repoContexts.some(
      (context) => context.hasUncommittedChanges,
    );
    const committedDiff = repoContexts
      .map((context) => context.committedDiff)
      .filter((diff) => diff.trim().length > 0)
      .join('\n');
    const uncommittedDiff = repoContexts
      .map((context) => context.uncommittedDiff)
      .filter((diff) => diff.trim().length > 0)
      .join('\n');
    const changedFiles = repoContexts
      .flatMap((context) => context.changedFiles)
      .sort((left, right) => left.path.localeCompare(right.path));
    const fileSnapshots = repoContexts
      .flatMap((context) => context.fileSnapshots)
      .sort((left, right) => left.path.localeCompare(right.path));
    const baselineClassification = classifyBaselineChanges(
      fileSnapshots,
      checkpointSnapshots,
      planScope,
    );
    const pipelineChangedFiles = baselineClassification.filter(
      isPipelineOwnedChange,
    );
    const reviewChangedFiles =
      baselineClassification.filter(isReviewableChange);
    const protectedDriftFiles = baselineClassification.filter(isProtectedDrift);
    const instructionScopes = await collectInstructionScopes(
      repoRoot,
      reviewChangedFiles,
    );
    const generatedAt = new Date().toISOString();
    const workspaceCheckpoint = buildWorkspaceCheckpoint(
      generatedAt,
      repoRoot,
      currentBranch,
      baseBranch,
      mergeBase,
      repoContexts,
    );

    const details: WorkspaceDetailsRecord = {
      generatedAt,
      repoRoot: normalizeRepoPath(repoRoot),
      currentBranch,
      requestedBaseBranch: requestedBaseBranch ?? null,
      baseBranch,
      mergeBase,
      head,
      includeUncommitted,
      hasUncommittedChanges,
      committedDiffAvailable: repoContexts.some(
        (context) => context.mergeBase !== null,
      ),
      changedFiles,
      reviewChangedFiles,
      protectedDriftFiles,
      candidateInstructionFiles: instructionScopes,
      baselineClassification,
    };
    const combinedDiff = buildCombinedDiff(
      mergeBase,
      committedDiff,
      uncommittedDiff,
      repoContexts.length > 1,
    );

    const workspaceCheckpointFile = writeOutputFile(
      'workspace_checkpoint_file',
      'workspace-checkpoint.json',
      `${JSON.stringify(workspaceCheckpoint, null, 2)}\n`,
    );
    const workspaceDetailsFile = writeOutputFile(
      'workspace_details_file',
      'workspace-details.json',
      `${JSON.stringify(details, null, 2)}\n`,
    );
    const workspaceSummaryFile = writeOutputFile(
      'workspace_summary_file',
      'workspace-details.md',
      renderWorkspaceSummary(details),
    );
    const changedFilesFile = writeOutputFile(
      'changed_files_file',
      'changed-files.json',
      `${JSON.stringify(changedFiles, null, 2)}\n`,
    );
    const baselineClassificationFile = writeOutputFile(
      'baseline_classification_file',
      'baseline-classification.json',
      `${JSON.stringify(baselineClassification, null, 2)}\n`,
    );
    const pipelineChangedFilesFile = writeOutputFile(
      'pipeline_changed_files_file',
      'pipeline-changed-files.json',
      `${JSON.stringify(pipelineChangedFiles, null, 2)}\n`,
    );
    const reviewChangedFilesFile = writeOutputFile(
      'review_changed_files_file',
      'review-changed-files.json',
      `${JSON.stringify(reviewChangedFiles, null, 2)}\n`,
    );
    const protectedDriftFile = writeOutputFile(
      'protected_drift_file',
      'protected-drift.json',
      `${JSON.stringify(protectedDriftFiles, null, 2)}\n`,
    );
    const protectedDriftSummaryFile = writeOutputFile(
      'protected_drift_summary_file',
      'protected-drift.md',
      renderProtectedDriftSummary(protectedDriftFiles),
    );
    const instructionScopesFile = writeOutputFile(
      'instruction_scopes_file',
      'instruction-scopes.json',
      `${JSON.stringify(instructionScopes, null, 2)}\n`,
    );
    const diffFile = writeOutputFile(
      'diff_file',
      'workspace.diff',
      combinedDiff,
    );
    const reviewDiffFile = writeOutputFile(
      'review_diff_file',
      'review.diff',
      filterDiffToReviewPaths(
        combinedDiff,
        reviewChangedFiles,
        checkpointSnapshots.size > 0,
      ),
    );

    void workspaceCheckpointFile;
    void workspaceDetailsFile;
    void workspaceSummaryFile;
    void changedFilesFile;
    void baselineClassificationFile;
    void pipelineChangedFilesFile;
    void reviewChangedFilesFile;
    void protectedDriftFile;
    void protectedDriftSummaryFile;
    void instructionScopesFile;
    void diffFile;
    void reviewDiffFile;

    setOutput('repo_root', normalizeRepoPath(repoRoot));
    setOutput('current_branch', currentBranch);
    setOutput('base_branch', baseBranch ?? '');
    setOutput('merge_base', mergeBase ?? '');
    setOutput('has_uncommitted_changes', String(hasUncommittedChanges));
    setOutput(
      'committed_diff_available',
      String(repoContexts.some((context) => context.mergeBase !== null)),
    );
    setOutput('changed_file_count', String(changedFiles.length));
    setOutput(
      'pipeline_changed_file_count',
      String(pipelineChangedFiles.length),
    );
    setOutput('review_changed_file_count', String(reviewChangedFiles.length));
    setOutput('protected_drift_file_count', String(protectedDriftFiles.length));
    setOutput(
      'protected_changed_file_count',
      String(
        baselineClassification.filter((record) => record.protectedBaseline)
          .length,
      ),
    );
    setOutput('instruction_file_count', String(instructionScopes.length));
  });
}
