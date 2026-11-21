import {
  assertStoredSkillContext,
  copySkillInstallOrigin,
  recordSharedSkillInstall,
  getSharedSkillInstallIds,
  hasSkillInstallReceipt,
} from './skill-install-context';
import {
  skillResourceContextEnabled,
  skillContextSnapshot,
  assertSkillContextSnapshot,
} from './resource-lanes';
import {
  recordSharedItemInstall,
  recordSharedItemLocalUninstall,
} from '../canopy-cloud/shared-item-subscriptions';
import * as fs from 'fs';
import * as path from 'path';
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import * as yaml from 'js-yaml';
import { BRAND } from '@canopy/brand/current';
import { isPipelinePackageDigest } from '@canopy/protocol/pipelines';
import type {
  IPCResult,
  IPCResultWithAppError,
} from '@canopy/execution-engine/types/pipeline';
import { reportInstallFailure } from '../lib/install-failure-reporting';
import type {
  InstalledSkillInfo,
  FetchAvailableSkillsResponse,
  PublicShareSkillOrigin,
  SaveCustomSkillRequest,
  SkillContentResponse,
  SkillEditableFile,
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillUpdateProgress,
  SourceMetadata,
  WriteRawSkillRequest,
  WriteRawSkillResult,
  SkillWriteFailureCode,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';
import { runSkillMutation, skillMutationPending } from './skill-mutations';
import { CloudCopyConsentStore } from './cloud-copy-consents';
import { isInstalledSkillSourceId } from './installed-skill-cloud-copy';
import {
  SKILL_REPLACEMENT_JOURNAL,
  hasPendingSkillReplacement,
} from './skill-replacement-state';
import { writeFileAtomically, syncDirectory } from '../lib/atomic-file';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import { damagedCopyPath } from '@canopy/execution-engine/node/lib/damaged-copies';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { normalizeGitHubRepoRef } from '@canopy/execution-engine/plugin-refs';
import {
  getCustomSkillNameValidationError,
  getSkillFilePathValidationError,
} from '@canopy/desktop-shared/skill-name';
import { parseGitHubSource } from './source-parser';
import {
  discoverSkillsFromGitHub,
  getGitHubToken,
  fetchGitHubTree,
} from './skill-discovery';
import { sanitizeName, installSkill } from './installer';
import { fetchRiskAssessment } from './risk';
import {
  readLockFile,
  assertLockWritable,
  addLockEntry,
  removeLockEntry,
  fetchSkillFolderHash,
  checkForUpdate,
  getLockKey,
  parseLockKey,
} from './lock-file';
import {
  getSkillDir,
  getSkillsRootDir,
  getSourceDir,
  getSourceMetadataPath,
  deriveSourceId,
  BUILTIN_SOURCE_ID,
  CUSTOM_SOURCE_ID,
  isBuiltinSourceId,
  isCustomSourceId,
} from './paths';
import {
  getBundledSkillsDir,
  getBundledSkillDir,
} from '../pipelines/config-paths';
import { isPathInside } from '../lib/path-safety';
import { parseFrontmatter, parseFrontmatterAndBody } from '../lib/frontmatter';
import { safeReadText } from '../lib/fs-utils';
import {
  parseShareRemoteMetadata,
  type ShareRemoteMetadata,
} from '@canopy/protocol/sharing';

type SkillUpdateProgressReporter = (progress: SkillUpdateProgress) => void;

const SKILL_SHARE_LINKS_FILE = '.share-links.json';

function getSkillShareLinksPath(): string {
  return path.join(getSkillsRootDir(), SKILL_SHARE_LINKS_FILE);
}

interface SkillShareLinksRead {
  links: Record<string, ShareRemoteMetadata>;
  /**
   * The bytes read when the file exists but can't be parsed, so its links are
   * unknown; they are what a write first copies aside.
   */
  damagedBytes?: Buffer;
}

/** A missing store has no links; a file that can't be read at all throws. */
function readSkillShareLinksFile(): SkillShareLinksRead {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(getSkillShareLinksPath());
  } catch (error) {
    if (hasFileSystemErrorCode(error, 'ENOENT')) return { links: {} };
    throw error;
  }
  const damaged = { links: {}, damagedBytes: bytes };
  // Decoding would turn a bad byte into U+FFFD and a rewrite would lose it.
  if (!isUtf8(bytes)) return damaged;
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return damaged;
    }
    const links: Record<string, ShareRemoteMetadata> = {};
    for (const [localId, value] of Object.entries(parsed)) {
      const remote = parseShareRemoteMetadata(value);
      if (!remote) return damaged;
      links[localId] = remote;
    }
    return { links };
  } catch {
    return damaged;
  }
}

/** A damaged store reads as no links, so listing shows no share state. */
function readSkillShareLinks(): Record<string, ShareRemoteMetadata> {
  return readSkillShareLinksFile().links;
}

/**
 * Durable and atomic. The bytes of a damaged store, as read when it was judged
 * damaged, are first copied aside durably under an unused name; a lost link
 * to a private copy is found again by an identical republish.
 */
function writeSkillShareLinks(
  links: Record<string, ShareRemoteMetadata>,
  damagedBytes?: Buffer,
): void {
  const filePath = getSkillShareLinksPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (damagedBytes)
    writeFileAtomicallySync(damagedCopyPath(filePath), damagedBytes, {
      durable: true,
    });
  try {
    writeFileAtomicallySync(filePath, `${JSON.stringify(links, null, 2)}\n`, {
      encoding: 'utf8',
      durable: true,
    });
  } catch (error) {
    if (!isStorageOutcomeUnknownError(error)) throw error;
    logMainProcessWarn(
      '[skills] Share links installed, but their folder flush failed',
      error,
    );
  }
}

export function writeSkillRemoteMetadata(
  localId: string,
  remote: ShareRemoteMetadata,
): void {
  const { links, damagedBytes } = readSkillShareLinksFile();
  links[localId] = { ...remote };
  writeSkillShareLinks(links, damagedBytes);
}

export function clearSkillRemoteMetadataByRemoteId(remoteId: string): number {
  const links = readSkillShareLinks();
  let count = 0;
  for (const [localId, remote] of Object.entries(links)) {
    if (remote.remoteId !== remoteId) continue;
    delete links[localId];
    count += 1;
  }
  if (count > 0) writeSkillShareLinks(links);
  return count;
}

function moveSkillRemoteMetadata(
  sourceLocalId: string,
  destinationLocalId: string,
): (() => void) | undefined {
  const links = readSkillShareLinks();
  const remote = links[sourceLocalId];
  if (!remote) return undefined;
  const previousDestination = links[destinationLocalId];
  links[destinationLocalId] = remote;
  delete links[sourceLocalId];
  writeSkillShareLinks(links);
  return (): void => {
    const { links: rollbackLinks, damagedBytes } = readSkillShareLinksFile();
    rollbackLinks[sourceLocalId] = remote;
    if (previousDestination) {
      rollbackLinks[destinationLocalId] = previousDestination;
    } else {
      delete rollbackLinks[destinationLocalId];
    }
    writeSkillShareLinks(rollbackLinks, damagedBytes);
  };
}

/**
 * Check that a value is a safe, single-level directory name with no traversal.
 */
function isSafeSegment(value: string): boolean {
  return (
    !!value &&
    value !== '.' &&
    value !== '..' &&
    !path.isAbsolute(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value === path.basename(value)
  );
}

/**
 * Validate that a resolved skill path stays inside the skills root directory.
 * Returns the resolved path or null if traversal is detected.
 */
function validateSkillPath(sourceId: string, skillName: string): string | null {
  if (!isSafeSegment(sourceId) || !isSafeSegment(skillName)) return null;
  const root = path.resolve(getSkillsRootDir());
  const skillDir = path.resolve(getSkillDir(sourceId, skillName));
  if (!isPathInside(root, skillDir) || skillDir === root) return null;
  return skillDir;
}

/** Narrow an unknown thrown value to a Node errno with the given code. */
function hasFileSystemErrorCode(error: unknown, code: string): boolean {
  // Realm-safe on purpose: a native filesystem error raised under a test
  // runner is not an `instanceof Error` of the caller's realm.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/**
 * Validate every existing path component below a canonical trusted root before
 * mutating it. Missing suffixes are safe to create after their nearest
 * existing ancestor has passed containment and symlink checks.
 */
async function isSafeMutationPath(
  trustedRoot: string,
  targetPath: string,
): Promise<boolean> {
  const root = path.resolve(trustedRoot);
  const target = path.resolve(targetPath);
  if (target === root || !isPathInside(root, target)) return false;

  let canonicalRoot: string;
  try {
    canonicalRoot = await fsp.realpath(root);
  } catch (error) {
    return hasFileSystemErrorCode(error, 'ENOENT');
  }

  let current = root;
  const relative = path.relative(root, target);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stats = await fsp.lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
      const canonicalCurrent = await fsp.realpath(current);
      if (
        canonicalCurrent !== canonicalRoot &&
        !isPathInside(canonicalRoot, canonicalCurrent)
      ) {
        return false;
      }
    } catch (error) {
      if (hasFileSystemErrorCode(error, 'ENOENT')) return true;
      throw error;
    }
  }

  return true;
}

/**
 * Resolve the on-disk directory a skill's files live in for read-only access.
 * Built-in skills resolve into the bundled resources tree; everything else
 * resolves through {@link validateSkillPath}.
 */
function resolveSkillDirForRead(
  sourceId: string,
  skillName: string,
): string | null {
  if (isBuiltinSourceId(sourceId)) {
    if (!isSafeSegment(skillName)) return null;
    const root = path.resolve(getBundledSkillsDir());
    const skillDir = path.resolve(getBundledSkillDir(skillName));
    return isPathInside(root, skillDir) && skillDir !== root ? skillDir : null;
  }
  return validateSkillPath(sourceId, skillName);
}

type ResolvedSkillDir =
  | { status: 'ok'; path: string }
  | { status: 'invalid' }
  | { status: 'missing' };

/**
 * Canonically anchor a skill directory to its trusted storage root. Every
 * path component below that root must be a real directory entry rather than
 * a symlink, preventing source- or skill-level links from escaping storage.
 */
async function resolveCanonicalSkillDirForRead(
  sourceId: string,
  skillName: string,
): Promise<ResolvedSkillDir> {
  const skillDir = resolveSkillDirForRead(sourceId, skillName);
  if (!skillDir) return { status: 'invalid' };

  const trustedRoot = path.resolve(
    isBuiltinSourceId(sourceId) ? getBundledSkillsDir() : getSkillsRootDir(),
  );
  const relative = path.relative(trustedRoot, skillDir);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { status: 'invalid' };
  }

  try {
    let current = trustedRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const stats = await fsp.lstat(current);
      if (stats.isSymbolicLink()) return { status: 'invalid' };
    }

    const [canonicalRoot, canonicalSkillDir] = await Promise.all([
      fsp.realpath(trustedRoot),
      fsp.realpath(skillDir),
    ]);
    if (
      canonicalSkillDir === canonicalRoot ||
      !isPathInside(canonicalRoot, canonicalSkillDir)
    ) {
      return { status: 'invalid' };
    }
    const stats = await fsp.stat(canonicalSkillDir);
    return stats.isDirectory()
      ? { status: 'ok', path: canonicalSkillDir }
      : { status: 'missing' };
  } catch (error) {
    if (hasFileSystemErrorCode(error, 'ENOENT')) {
      return { status: 'missing' };
    }
    throw error;
  }
}

/**
 * Resolve a skill-relative file path. Deliberately more
 * permissive than the authoring-side validation (installed GitHub skills may
 * contain names custom authoring rejects) but still traversal-safe. Only
 * local reads accept literal POSIX backslashes; mutation callers retain the
 * restricted policy, and portable bundle validation remains separate.
 */
function resolveSkillFilePath(
  skillDir: string,
  filePath: string,
  pathPolicy: 'restricted' | 'local-read' = 'restricted',
): string | null {
  if (
    !filePath ||
    (filePath.includes('\\') &&
      (pathPolicy !== 'local-read' || path.sep === '\\')) ||
    path.isAbsolute(filePath)
  ) {
    return null;
  }
  const segments = filePath.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.startsWith('.'),
    )
  ) {
    return null;
  }
  const root = path.resolve(skillDir);
  const resolved = path.resolve(root, ...segments);
  if (!isPathInside(root, resolved)) return null;
  return resolved;
}

/**
 * Recursively collect file paths (POSIX-relative to `dir`). Dot-entries are
 * skipped so `.git` and editor metadata never surface in the UI.
 */
async function collectSkillFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectSkillFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Collect a bounded file preview without blocking Electron's main event loop.
 * The visit budget also bounds deeply nested trees that contain few files.
 */
async function collectSkillFilesBounded(
  dir: string,
  maxFiles: number,
  maxEntries: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const pending: Array<{ absolute: string; relative: string }> = [
    { absolute: dir, relative: '' },
  ];
  let entriesVisited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const directory = await fsp.opendir(current.absolute);
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        if (entriesVisited >= maxEntries) {
          return {
            files: files.sort((a, b) => a.localeCompare(b)),
            truncated: true,
          };
        }
        entriesVisited += 1;
        if (entry.name.startsWith('.')) continue;

        const relative = current.relative
          ? `${current.relative}/${entry.name}`
          : entry.name;
        if (entry.isDirectory()) {
          pending.push({
            absolute: path.join(current.absolute, entry.name),
            relative,
          });
        } else if (entry.isFile() && relative !== 'SKILL.md') {
          files.push(relative);
          if (files.length >= maxFiles) {
            const hasUnvisitedEntry = (await directory.read()) !== null;
            return {
              files: files.sort((a, b) => a.localeCompare(b)),
              truncated: hasUnvisitedEntry || pending.length > 0,
            };
          }
        }
      }
    } finally {
      await directory.close();
    }
  }

  return {
    files: files.sort((a, b) => a.localeCompare(b)),
    truncated: false,
  };
}

/**
 * Remove every supporting entry that is not part of the editor's desired
 * file set. Unlike the UI preview walker, exact-sync cleanup includes hidden
 * entries and removes symlinks without following them.
 */
async function removeObsoleteSkillEntries(
  dir: string,
  keep: ReadonlySet<string>,
  base = '',
): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (relative === 'SKILL.md') continue;
    const normalizedRelative = relative.toLowerCase();

    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await fsp.rm(absolute, { force: true });
      continue;
    }
    if (entry.isDirectory()) {
      let keptDescendant = false;
      keep.forEach((candidate) => {
        if (candidate.startsWith(`${normalizedRelative}/`)) {
          keptDescendant = true;
        }
      });
      if (!keptDescendant) {
        await fsp.rm(absolute, { recursive: true, force: true });
        continue;
      }
      await removeObsoleteSkillEntries(absolute, keep, relative);
      try {
        await fsp.rmdir(absolute);
      } catch (error) {
        if (!hasFileSystemErrorCode(error, 'ENOTEMPTY')) throw error;
      }
      continue;
    }
    if (!keep.has(normalizedRelative)) {
      await fsp.rm(absolute, { force: true });
    }
  }
}

type ResolvedSkillFile =
  | { status: 'ok'; path: string }
  | { status: 'invalid' }
  | { status: 'missing' };

/**
 * Resolve a file through the canonical skill root and reject every symlinked
 * path segment before opening it.
 */
async function resolveSkillFileForRead(
  skillDir: string,
  filePath: string,
): Promise<ResolvedSkillFile> {
  if (!resolveSkillFilePath(skillDir, filePath, 'local-read')) {
    return { status: 'invalid' };
  }

  let root: string;
  try {
    root = await fsp.realpath(skillDir);
  } catch (error) {
    if (hasFileSystemErrorCode(error, 'ENOENT')) {
      return { status: 'missing' };
    }
    throw error;
  }

  let current = root;
  const segments = filePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) return { status: 'invalid' };
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fsp.lstat(current);
    } catch (error) {
      if (hasFileSystemErrorCode(error, 'ENOENT')) {
        return { status: 'missing' };
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return { status: 'invalid' };
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      return { status: 'missing' };
    }
  }

  const canonical = await fsp.realpath(current);
  if (!isPathInside(root, canonical)) {
    return { status: 'invalid' };
  }
  const stats = await fsp.stat(canonical);
  return stats.isFile()
    ? { status: 'ok', path: canonical }
    : { status: 'missing' };
}

function getSkillUpdateStatusPath(): string {
  return path.join(getSkillsRootDir(), 'update-status.json');
}

function readSkillUpdateStatus(): Record<string, boolean> {
  try {
    const filePath = getSkillUpdateStatusPath();
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    );
    const status = Object.create(null) as Record<string, boolean>;
    for (const [key, value] of entries) {
      status[key] = value;
    }
    return status;
  } catch {
    return {};
  }
}

function writeSkillUpdateStatus(status: Record<string, boolean>): void {
  const filePath = getSkillUpdateStatusPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(status, null, 2) + '\n', 'utf-8');
}

function setSkillUpdateStatus(
  sourceId: string,
  skillName: string,
  updateAvailable: boolean,
): void {
  const key = getLockKey(sourceId, skillName);
  const status = readSkillUpdateStatus();
  status[key] = updateAvailable;
  writeSkillUpdateStatus(status);
}

function removeSkillUpdateStatus(sourceId: string, skillName: string): void {
  const key = getLockKey(sourceId, skillName);
  const status = readSkillUpdateStatus();
  if (!(key in status)) return;
  delete status[key];
  writeSkillUpdateStatus(status);
}

function writeSourceMetadata(sourceId: string, metadata: SourceMetadata): void {
  const dir = getSourceDir(sourceId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getSourceMetadataPath(sourceId);
  fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), 'utf-8');
}

function readSkillDescription(sourceId: string, skillName: string): string {
  const skillMdPath = path.join(getSkillDir(sourceId, skillName), 'SKILL.md');
  const content = safeReadText(skillMdPath);
  if (!content) return '';
  const fm = parseFrontmatter<{ description?: string }>(content);
  return fm?.description || '';
}

function deriveShareableSource(entry: {
  sourceType: string;
  sourceUrl: string;
}): InstalledSkillInfo['shareableSource'] {
  if (entry.sourceType !== 'github') {
    return undefined;
  }

  const parsed = parseGitHubSource(entry.sourceUrl);
  if (!parsed) {
    return undefined;
  }

  try {
    return {
      type: 'github',
      repo: normalizeGitHubRepoRef(`${parsed.owner}/${parsed.repo}`),
    };
  } catch {
    return undefined;
  }
}

function loadBuiltinSkills(): InstalledSkillInfo[] {
  const dir = getBundledSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const results: InstalledSkillInfo[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = safeReadText(skillMdPath);
    const description = content
      ? parseFrontmatter<{ description?: string }>(content)?.description || ''
      : '';

    results.push({
      name: entry.name,
      sourceId: BUILTIN_SOURCE_ID,
      description,
      source: `${BRAND.displayName} (built-in)`,
      installedAt: '',
      updatedAt: '',
      updateAvailable: false,
      builtIn: true,
      shareableSource: { type: 'builtin', id: 'app' },
    });
  }

  return results;
}

function loadCustomSkills(): InstalledSkillInfo[] {
  const dir = getSourceDir(CUSTOM_SOURCE_ID);
  if (!fs.existsSync(dir)) return [];

  const results: InstalledSkillInfo[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = safeReadText(skillMdPath);
    const description = content
      ? parseFrontmatter<{ description?: string }>(content)?.description || ''
      : '';
    let stat: fs.Stats;
    try {
      stat = fs.statSync(skillMdPath);
    } catch (error) {
      // Windows atomic-save race: a refresh can stat SKILL.md while it is
      // delete-pending (EPERM), held (EBUSY) or mid-swap (ENOENT). Skip the
      // row; the next refresh lists it.
      if (
        hasFileSystemErrorCode(error, 'ENOENT') ||
        hasFileSystemErrorCode(error, 'EPERM') ||
        hasFileSystemErrorCode(error, 'EBUSY')
      ) {
        continue;
      }
      throw error;
    }
    const installedAt = stat.birthtime.toISOString();
    const updatedAt = stat.mtime.toISOString();

    results.push({
      name: entry.name,
      sourceId: CUSTOM_SOURCE_ID,
      description,
      source: `${BRAND.displayName} (custom)`,
      installedAt,
      updatedAt,
      updateAvailable: false,
      custom: true,
    });
  }

  return results;
}

export function loadSkills(): IPCResult<InstalledSkillInfo[]> {
  try {
    const lock = readLockFile();
    const updateStatus = readSkillUpdateStatus();
    const skills: InstalledSkillInfo[] = [];
    const shareLinks = readSkillShareLinks();

    for (const [key, entry] of Object.entries(lock.skills)) {
      const { sourceId, skillName } = parseLockKey(key);
      const skillDir = getSkillDir(sourceId, skillName);
      if (!fs.existsSync(skillDir)) continue;
      const shareableSource = deriveShareableSource(entry);

      skills.push({
        name: skillName,
        sourceId,
        description: readSkillDescription(sourceId, skillName),
        source: entry.source,
        installedAt: entry.installedAt,
        updatedAt: entry.updatedAt,
        updateAvailable: updateStatus[key] ?? false,
        ...(shareableSource ? { shareableSource } : {}),
        ...(shareLinks[`${sourceId}/${skillName}`]
          ? { remote: shareLinks[`${sourceId}/${skillName}`] }
          : {}),
      });
    }

    // Merge built-in skills from bundled resources
    skills.push(
      ...loadBuiltinSkills().map((skill) => ({
        ...skill,
        ...(shareLinks[`${skill.sourceId}/${skill.name}`]
          ? { remote: shareLinks[`${skill.sourceId}/${skill.name}`] }
          : {}),
      })),
    );

    // Merge user-authored custom skills
    skills.push(
      ...loadCustomSkills().map((skill) => ({
        ...skill,
        ...(shareLinks[`${skill.sourceId}/${skill.name}`]
          ? { remote: shareLinks[`${skill.sourceId}/${skill.name}`] }
          : {}),
      })),
    );

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { success: true, data: skills };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function fetchAvailable(
  source: string,
): Promise<IPCResult<FetchAvailableSkillsResponse>> {
  try {
    const parsed = parseGitHubSource(source);
    if (!parsed) {
      return {
        success: false,
        error:
          'Invalid source. Use owner/repo or a GitHub URL (e.g. https://github.com/owner/repo).',
      };
    }

    const { owner, repo, branch, subPath } = parsed;
    const normalizedSource = `${owner}/${repo}`;

    const discoveryResult = await discoverSkillsFromGitHub(
      owner,
      repo,
      branch,
      subPath,
    );

    const { skills, hasMarketplace } = discoveryResult;

    // Fetch risk for the discovered skills
    const skillNames = skills.map((s) => s.name);
    const riskData =
      skillNames.length > 0
        ? await fetchRiskAssessment(normalizedSource, skillNames)
        : {};

    // Filter out already installed skills from this source
    const lock = readLockFile();
    const sourceId = deriveSourceId('github', normalizedSource);
    // An entry whose folder is gone is offered again, so a reinstall repairs it.
    const installedForSource = new Set(
      Object.entries(lock.skills)
        .filter(([, entry]) => entry.sourceId === sourceId)
        .map(([key]) => parseLockKey(key).skillName)
        .filter((name) => fs.existsSync(getSkillDir(sourceId, name))),
    );
    const availableSkills = skills.filter(
      (s) => !installedForSource.has(sanitizeName(s.name)),
    );

    return {
      success: true,
      data: {
        source: normalizedSource,
        skills: availableSkills,
        riskInfo: riskData,
        hasMarketplace,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export async function installSkills(
  source: string,
  skillNames: string[],
): Promise<IPCResultWithAppError<void>> {
  try {
    const parsed = parseGitHubSource(source);
    if (!parsed) {
      return { success: false, error: 'Invalid source.' };
    }

    const { owner, repo, branch, subPath } = parsed;
    const token = await getGitHubToken();
    const { tree, resolvedBranch } = await fetchGitHubTree(
      owner,
      repo,
      token,
      branch,
    );

    // Discover skills to get their sourcePaths
    const { skills } = await discoverSkillsFromGitHub(
      owner,
      repo,
      resolvedBranch,
      subPath,
    );

    const normalizedSource = `${owner}/${repo}`;
    const sourceId = deriveSourceId('github', normalizedSource);

    // Refuse, or finish a v1 migration, before any skill folder is published.
    assertLockWritable();

    // Ensure source directory exists and write source.json
    const sourceDir = getSourceDir(sourceId);
    fs.mkdirSync(sourceDir, { recursive: true });

    writeSourceMetadata(sourceId, {
      type: 'github',
      sourceId,
      url: `https://github.com/${normalizedSource}`,
      owner,
      repo,
    });

    const now = new Date().toISOString();

    for (const skillName of skillNames) {
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) continue;

      await installSkill(
        owner,
        repo,
        resolvedBranch,
        skill,
        tree,
        sourceDir,
        token,
      );

      // Fetch tree SHA for version tracking
      const hash = await fetchSkillFolderHash(
        owner,
        repo,
        skill.sourcePath,
        resolvedBranch,
      );

      // Recorded right after its own publish, before the next download.
      const sanitized = sanitizeName(skill.name);
      addLockEntry(sourceId, sanitized, {
        sourceId,
        source: normalizedSource,
        sourceType: 'github',
        sourceUrl: `https://github.com/${normalizedSource}`,
        skillPath: skill.sourcePath,
        skillFolderHash: hash || '',
        installedAt: now,
        updatedAt: now,
      });
      setSkillUpdateStatus(sourceId, sanitized, false);
    }

    return { success: true, data: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      ...reportInstallFailure(error, 'skill.install'),
    };
  }
}

/** Production uninstall boundary shares the mutation lock with updates and edits. */
export async function removeSkillForContext(
  sourceId: string,
  skillName: string,
): Promise<IPCResult<void>> {
  return runSkillMutation(async () => {
    try {
      const { prepareSkillUninstall } = await import('./skill-install-context');
      const commitRemoval = await prepareSkillUninstall(
        `${sourceId}/${skillName}`,
      );
      const result = removeSkillUnlocked(sourceId, skillName);
      if (result.success) await commitRemoval();
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function removeSkill(
  sourceId: string,
  skillName: string,
): IPCResult<void> {
  if (skillMutationPending())
    return {
      success: false,
      error:
        'Skill unavailable (local-conflict). Another skill change is in progress. Try again.',
    };
  return removeSkillUnlocked(sourceId, skillName);
}

function removeSkillUnlocked(
  sourceId: string,
  skillName: string,
): IPCResult<void> {
  if (isBuiltinSourceId(sourceId)) {
    return { success: false, error: 'Built-in skills cannot be removed.' };
  }
  try {
    const skillDir = validateSkillPath(sourceId, skillName);
    if (!skillDir) {
      return { success: false, error: 'Invalid skill path.' };
    }
    // A refused lock fails the removal before the folder is deleted.
    if (!isCustomSourceId(sourceId)) assertLockWritable();
    const localId = `${sourceId}/${skillName}`;
    // The link goes first: a store that can't be read or written refuses the
    // removal before the folder is deleted.
    const shareLinks = readSkillShareLinksFile().links;
    const link = shareLinks[localId];
    const clearsLink =
      link !== undefined &&
      !keepsInstalledCloudCopyLink(sourceId, localId, link);
    if (clearsLink) {
      delete shareLinks[localId];
      writeSkillShareLinks(shareLinks);
    }
    if (fs.existsSync(skillDir)) {
      try {
        fs.rmSync(skillDir, { recursive: true, force: true });
      } catch (error) {
        if (clearsLink) writeSkillRemoteMetadata(localId, link);
        throw error;
      }
    }
    if (!isCustomSourceId(sourceId)) {
      removeLockEntry(sourceId, skillName);
    }
    removeSkillUpdateStatus(sourceId, skillName);
    // The subscription ledger names every share this copy came from.
    if (isCustomSourceId(sourceId))
      recordSharedItemLocalUninstall({ kind: 'skill', localId });

    // Clean up empty source directory (only source.json remaining)
    const root = path.resolve(getSkillsRootDir());
    const sourceDir = path.resolve(getSourceDir(sourceId));
    if (!isPathInside(root, sourceDir) || sourceDir === root) {
      return { success: false, error: 'Invalid skill path.' };
    }
    if (fs.existsSync(sourceDir)) {
      const remaining = fs
        .readdirSync(sourceDir)
        .filter((f) => f !== 'source.json');
      if (remaining.length === 0) {
        fs.rmSync(sourceDir, { recursive: true, force: true });
      }
    }

    return { success: true, data: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Whether uninstalling keeps a skill's link to its cloud copy (CAN-6943):
 * only for a skill installed from GitHub, a URL or a local folder whose cloud
 * copy's consent names that same copy. The copy stays in the account, and a
 * reinstall finds it again instead of starting a second one. Every other
 * link, a custom skill's included, goes with the skill as before.
 */
function keepsInstalledCloudCopyLink(
  sourceId: string,
  localId: string,
  link: ShareRemoteMetadata,
): boolean {
  if (!isInstalledSkillSourceId(sourceId)) return false;
  const consent =
    CloudCopyConsentStore.inSkillsRoot(getSkillsRootDir()).get(localId);
  return (
    consent !== null &&
    consent.remoteId === link.remoteId &&
    consent.accountId === link.accountId
  );
}

const MAX_CUSTOM_SKILL_FILES = 100;

/**
 * Validate a custom skill's supporting-file set. Returns the normalized
 * files or an error string. Runs before any disk mutation so an invalid
 * payload never leaves a half-written skill directory.
 */
function normalizeCustomSkillFiles(
  files: SkillEditableFile[],
):
  | { files: Array<{ rel: string; content: string | null }> }
  | { error: string } {
  if (files.length > MAX_CUSTOM_SKILL_FILES) {
    return {
      error: `A skill can have at most ${MAX_CUSTOM_SKILL_FILES} files.`,
    };
  }
  const seen = new Set<string>();
  const normalized: Array<{ rel: string; content: string | null }> = [];
  for (const file of files) {
    const rel = (file.path || '').trim();
    const pathError = getSkillFilePathValidationError(rel);
    if (pathError) {
      return { error: pathError };
    }
    const lower = rel.toLowerCase();
    if (seen.has(lower)) {
      return { error: `Duplicate file path "${rel}".` };
    }
    seen.add(lower);
    normalized.push({ rel, content: file.content ?? null });
  }
  const lowerPaths = normalized.map((f) => f.rel.toLowerCase());
  for (const { rel } of normalized) {
    const prefix = `${rel.toLowerCase()}/`;
    if (lowerPaths.some((other) => other.startsWith(prefix))) {
      return {
        error: `File "${rel}" conflicts with a folder of the same name.`,
      };
    }
  }
  return { files: normalized };
}

async function alignSkillFilePathCasing(
  skillDir: string,
  filePath: string,
): Promise<void> {
  let parent = skillDir;
  for (const segment of filePath.split('/')) {
    const entries = await fsp.readdir(parent, { withFileTypes: true });
    const existing =
      entries.find((entry) => entry.name === segment) ??
      entries.find(
        (entry) => entry.name.toLowerCase() === segment.toLowerCase(),
      );
    if (!existing) return;

    const desiredPath = path.join(parent, segment);
    if (existing.name !== segment) {
      const existingPath = path.join(parent, existing.name);
      const temporaryPath = path.join(
        skillDir,
        `.canopy-case-rename-${randomUUID()}`,
      );
      await fsp.rename(existingPath, temporaryPath);
      await fsp.rename(temporaryPath, desiredPath);
    }
    parent = desiredPath;
  }
}

async function buildCustomSkillStage(
  stagingDir: string,
  sourceSkillDir: string | null,
  skillContent: string,
  normalizedFiles: Array<{
    rel: string;
    content: string | null;
  }> | null,
): Promise<void> {
  if (
    normalizedFiles?.some(
      ({ rel }) => rel.split('/')[0]?.toLowerCase() === 'skill.md',
    )
  ) {
    throw new Error('SKILL.md is reserved for the main skill file.');
  }

  if (sourceSkillDir) {
    await fsp.cp(sourceSkillDir, stagingDir, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    await fsp.rm(path.join(stagingDir, 'SKILL.md'), {
      recursive: true,
      force: true,
    });
  } else {
    await fsp.mkdir(stagingDir);
  }

  await fsp.writeFile(path.join(stagingDir, 'SKILL.md'), skillContent, 'utf-8');

  if (!normalizedFiles) return;

  const existingFiles = await collectSkillFiles(stagingDir);
  const existingPaths = new Set(
    existingFiles.map((relativePath) => relativePath.toLowerCase()),
  );
  for (const { rel } of normalizedFiles) {
    if (existingPaths.has(rel.toLowerCase())) {
      await alignSkillFilePathCasing(stagingDir, rel);
    }
  }

  for (const { rel, content } of normalizedFiles) {
    // A null content means "keep the existing file as-is" (binary or
    // oversized files the editor cannot round-trip).
    if (content === null) continue;
    const absolute = resolveSkillFilePath(stagingDir, rel);
    if (!absolute) {
      throw new Error(`Invalid file path "${rel}".`);
    }
    const segments = rel.split('/');
    let parent = stagingDir;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      try {
        const parentStats = await fsp.lstat(parent);
        if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
          await fsp.rm(parent, { recursive: true, force: true });
        }
      } catch (error) {
        if (!hasFileSystemErrorCode(error, 'ENOENT')) throw error;
      }
      await fsp.mkdir(parent, { recursive: true });
    }
    try {
      const targetStats = await fsp.lstat(absolute);
      if (targetStats.isSymbolicLink() || targetStats.isDirectory()) {
        await fsp.rm(absolute, { recursive: true, force: true });
      }
    } catch (error) {
      if (!hasFileSystemErrorCode(error, 'ENOENT')) throw error;
    }
    await fsp.writeFile(absolute, content, 'utf-8');
  }

  const keep = new Set(normalizedFiles.map((file) => file.rel.toLowerCase()));
  await removeObsoleteSkillEntries(stagingDir, keep);
}

async function commitCustomSkillStage(
  stagingDir: string,
  targetDir: string,
  sourceSkillDir: string | null,
  backupDir: string,
  persistOrigin?: () => Promise<void>,
): Promise<void> {
  let originalMoved = false;
  let stagedMoved = false;
  try {
    if (sourceSkillDir) {
      await fsp.rename(sourceSkillDir, backupDir);
      originalMoved = true;
    }
    await fsp.rename(stagingDir, targetDir);
    stagedMoved = true;
    await persistOrigin?.();
  } catch (error) {
    if (originalMoved && sourceSkillDir) {
      try {
        if (stagedMoved)
          await fsp.rm(targetDir, { recursive: true, force: true });
        await fsp.rename(backupDir, sourceSkillDir);
      } catch (rollbackError) {
        const originalMessage =
          error instanceof Error ? error.message : String(error);
        const rollbackMessage =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        throw new Error(
          `${originalMessage} (restoring the original skill also failed: ${rollbackMessage})`,
        );
      }
    }
    throw error;
  }

  if (originalMoved) {
    // The new tree is already committed. A stale hidden backup is preferable
    // to reporting a failed save after the live skill has been replaced.
    try {
      await fsp.rm(backupDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

interface SaveCustomSkillOptions {
  preservedMetadata?: Record<string, unknown>;
}

export async function saveCustomSkill(
  payload: SaveCustomSkillRequest,
  options: SaveCustomSkillOptions = {},
): Promise<IPCResultWithAppError<{ name: string }>> {
  return runSkillMutation(() => saveCustomSkillUnlocked(payload, options));
}

async function saveCustomSkillUnlocked(
  payload: SaveCustomSkillRequest,
  options: SaveCustomSkillOptions,
): Promise<IPCResultWithAppError<{ name: string }>> {
  let stagingDir: string | null = null;
  try {
    const skillName = payload.name || '';
    const nameError = getCustomSkillNameValidationError(skillName);
    if (nameError) {
      return { success: false, error: nameError };
    }
    const description = (payload.description || '').trim();
    if (!description) {
      return { success: false, error: 'Skill description is required.' };
    }

    // Validate the supporting-file set before any disk mutation.
    let normalizedFiles: Array<{
      rel: string;
      content: string | null;
    }> | null = null;
    if (payload.files) {
      const result = normalizeCustomSkillFiles(payload.files);
      if ('error' in result) {
        return { success: false, error: result.error };
      }
      normalizedFiles = result.files;
    }

    await assertStoredSkillContext(
      `${CUSTOM_SOURCE_ID}/${payload.originalName || skillName}`,
    );
    await assertStoredSkillContext(`${CUSTOM_SOURCE_ID}/${skillName}`);
    const targetDir = validateSkillPath(CUSTOM_SOURCE_ID, skillName);
    if (!targetDir) {
      return { success: false, error: 'Invalid skill name.' };
    }

    const originalName = payload.originalName || '';
    const isRename = !!originalName && originalName !== skillName;
    let oldDir: string | null = null;

    if (originalName) {
      oldDir = validateSkillPath(CUSTOM_SOURCE_ID, originalName);
      if (!oldDir) {
        return { success: false, error: 'Invalid original skill name.' };
      }
      if (!fs.existsSync(oldDir)) {
        return {
          success: false,
          error: `Original skill "${originalName}" does not exist.`,
        };
      }
    }

    const skillsRoot = getSkillsRootDir();
    if (!(await isSafeMutationPath(skillsRoot, targetDir))) {
      return {
        success: false,
        error: 'Skill directory is unsafe to modify.',
      };
    }
    if (
      oldDir &&
      oldDir !== targetDir &&
      !(await isSafeMutationPath(skillsRoot, oldDir))
    ) {
      return {
        success: false,
        error: 'Original skill directory is unsafe to modify.',
      };
    }

    const sourceDir = getSourceDir(CUSTOM_SOURCE_ID);
    fs.mkdirSync(sourceDir, { recursive: true });
    if (!fs.existsSync(getSourceMetadataPath(CUSTOM_SOURCE_ID))) {
      writeSourceMetadata(CUSTOM_SOURCE_ID, {
        type: 'custom',
        sourceId: CUSTOM_SOURCE_ID,
        url: '',
      });
    }

    if (isRename) {
      if (!oldDir) {
        return { success: false, error: 'Invalid original skill name.' };
      }
      if (fs.existsSync(targetDir)) {
        return {
          success: false,
          error: `A skill named "${skillName}" already exists.`,
        };
      }
    } else if (!originalName && fs.existsSync(targetDir)) {
      return {
        success: false,
        error: `A skill named "${skillName}" already exists.`,
      };
    }

    const frontmatterObj: Record<string, unknown> = {
      name: skillName,
      description,
    };
    if (payload.extraMetadata) {
      for (const [rawKey, rawValue] of Object.entries(payload.extraMetadata)) {
        const key = rawKey.trim();
        if (!key || /\s/.test(key)) continue;
        if (key === 'name' || key === 'description') continue;
        const value = (rawValue ?? '').trim();
        if (!value) continue;
        frontmatterObj[key] = value;
      }
    } else if (payload.preservedMetadata ?? options.preservedMetadata) {
      for (const [key, value] of Object.entries(
        payload.preservedMetadata ?? options.preservedMetadata ?? {},
      )) {
        if (key === 'name' || key === 'description') continue;
        if (!key.trim() || /\s/.test(key) || value === undefined) continue;
        frontmatterObj[key] = value;
      }
    }

    const frontmatter = yaml.dump(frontmatterObj, { lineWidth: -1 }).trimEnd();
    const body = payload.body || '';
    const trailingNewline = body.endsWith('\n') ? '' : '\n';
    const content = `---\n${frontmatter}\n---\n\n${body}${trailingNewline}`;

    const sourceSkillDir = originalName ? oldDir : null;
    stagingDir = path.join(sourceDir, `.canopy-skill-stage-${randomUUID()}`);
    const backupDir = path.join(
      sourceDir,
      `.canopy-skill-backup-${randomUUID()}`,
    );
    await buildCustomSkillStage(
      stagingDir,
      sourceSkillDir,
      content,
      normalizedFiles,
    );
    const persistOrigin = isRename
      ? async (): Promise<void> => {
          const sourceLocalId = `${CUSTOM_SOURCE_ID}/${originalName}`;
          const destinationLocalId = `${CUSTOM_SOURCE_ID}/${skillName}`;
          const rollbackRemote = moveSkillRemoteMetadata(
            sourceLocalId,
            destinationLocalId,
          );
          try {
            if (skillResourceContextEnabled()) {
              await copySkillInstallOrigin(sourceLocalId, destinationLocalId);
            }
          } catch (error) {
            try {
              rollbackRemote?.();
            } catch (rollbackError) {
              const originalMessage =
                error instanceof Error ? error.message : String(error);
              const rollbackMessage =
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError);
              throw new Error(
                `${originalMessage} (restoring the skill share link also failed: ${rollbackMessage})`,
              );
            }
            throw error;
          }
        }
      : undefined;
    await commitCustomSkillStage(
      stagingDir,
      targetDir,
      sourceSkillDir,
      backupDir,
      persistOrigin,
    );
    stagingDir = null;

    return { success: true, data: { name: skillName } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      ...reportInstallFailure(error, 'skill.save_custom'),
    };
  } finally {
    if (stagingDir) {
      try {
        await fsp.rm(stagingDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function hashRawSkill(rawSkill: string | Uint8Array): string {
  return createHash('sha256').update(rawSkill).digest('hex');
}

function ensureCustomSourceMetadata(): void {
  const sourceDir = getSourceDir(CUSTOM_SOURCE_ID);
  fs.mkdirSync(sourceDir, { recursive: true });
  if (!fs.existsSync(getSourceMetadataPath(CUSTOM_SOURCE_ID))) {
    writeSourceMetadata(CUSTOM_SOURCE_ID, {
      type: 'custom',
      sourceId: CUSTOM_SOURCE_ID,
      url: '',
    });
  }
}

function resolveAvailableCustomSkillName(
  baseName: string,
  rawSkill: string,
  reusableIds?: ReadonlySet<string>,
  excludedIds?: ReadonlySet<string>,
): {
  skillName: string;
  existingMatch: boolean;
} {
  const sanitized = sanitizeName(baseName || '');
  if (!sanitized || sanitized === 'unnamed-skill') {
    throw new Error('Skill name is required.');
  }

  const desiredHash = hashRawSkill(rawSkill);
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidate = attempt === 1 ? sanitized : `${sanitized}-${attempt}`;
    const candidateDir = validateSkillPath(CUSTOM_SOURCE_ID, candidate);
    if (!candidateDir) {
      throw new Error('Invalid skill name.');
    }
    const skillMdPath = path.join(candidateDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return { skillName: candidate, existingMatch: false };
    }
    const candidateId = `${CUSTOM_SOURCE_ID}/${candidate}`;
    if (
      (!reusableIds || reusableIds.has(candidateId)) &&
      !excludedIds?.has(candidateId) &&
      hashRawSkill(fs.readFileSync(skillMdPath, 'utf-8')) === desiredHash
    ) {
      return { skillName: candidate, existingMatch: true };
    }
  }

  throw new Error(`Unable to find an available name for "${sanitized}".`);
}

function parseCustomSkillId(skillId: string): string | null {
  const prefix = `${CUSTOM_SOURCE_ID}/`;
  const skillName = skillId.startsWith(prefix)
    ? skillId.slice(prefix.length)
    : skillId;
  if (!isSafeSegment(skillName)) {
    return null;
  }
  return skillName;
}

function parseRawSkillIdentity(
  skillId: string,
): { sourceId: string; skillName: string } | null {
  const lastSlash = skillId.lastIndexOf('/');
  if (lastSlash < 0) {
    const skillName = parseCustomSkillId(skillId);
    return skillName ? { sourceId: CUSTOM_SOURCE_ID, skillName } : null;
  }

  const sourceId = skillId.slice(0, lastSlash);
  const skillName = skillId.slice(lastSlash + 1);
  if (!isSafeSegment(sourceId) || !isSafeSegment(skillName)) return null;
  if (isBuiltinSourceId(sourceId) || isCustomSourceId(sourceId)) {
    return { sourceId, skillName };
  }

  const lockEntry = readLockFile().skills[getLockKey(sourceId, skillName)];
  return lockEntry?.sourceType === 'local' && lockEntry.sourceId === sourceId
    ? { sourceId, skillName }
    : null;
}

export async function readRawSkill(skillId: string): Promise<string> {
  const identity = parseRawSkillIdentity(skillId);
  if (!identity) {
    throw new Error('Invalid skill id.');
  }
  return readSkillFileOf(identity, skillId);
}

/** The lock sources an installed skill's cloud copy may come from (CAN-6943). */
const INSTALLED_CLOUD_COPY_SOURCE_TYPES: readonly string[] = [
  'github',
  'url',
  'local',
];

/**
 * The SKILL.md of a skill installed from GitHub, a URL or a local folder, for
 * its cloud copy (CAN-6943): only a lock entry of that source, read through
 * the same guarded path as `readRawSkill`. `readRawSkill` itself keeps
 * reading local-folder installs only, so its other callers are unchanged.
 */
export async function readInstalledSkillForCloudCopy(
  skillId: string,
): Promise<string> {
  return readSkillFileOf(installedCloudCopyIdentity(skillId), skillId);
}

/** Entries a folder fingerprint walks before it refuses: twice the package cap. */
const INSTALLED_FINGERPRINT_MAX_ENTRIES = 2 * 1024;

/**
 * A fingerprint of an installed skill's whole folder (CAN-6943): every
 * path, each file's SHA-256 and each link's target, without following links.
 * Its cloud copy's consent records it, so a change to any supporting file,
 * not only SKILL.md, shows the copy as out of date. Same identity and folder
 * checks as `readInstalledSkillForCloudCopy`.
 */
export async function fingerprintInstalledSkillForCloudCopy(
  skillId: string,
): Promise<string> {
  const { sourceId, skillName } = installedCloudCopyIdentity(skillId);
  await assertStoredSkillContext(`${sourceId}/${skillName}`);
  const resolved = await resolveCanonicalSkillDirForRead(sourceId, skillName);
  if (resolved.status !== 'ok') throw new Error('Invalid skill id.');
  const fingerprint = createHash('sha256');
  let entries = 0;
  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    for (const name of (await fsp.readdir(dir)).sort()) {
      entries += 1;
      if (entries > INSTALLED_FINGERPRINT_MAX_ENTRIES)
        throw new Error('This skill has too many files to compare.');
      const absolute = path.join(dir, name);
      const relative = relativeDir === '' ? name : `${relativeDir}/${name}`;
      const stats = await fsp.lstat(absolute);
      if (stats.isSymbolicLink()) {
        fingerprint.update(
          `link\0${relative}\0${await fsp.readlink(absolute)}\n`,
        );
      } else if (stats.isDirectory()) {
        fingerprint.update(`dir\0${relative}\n`);
        await walk(absolute, relative);
      } else if (stats.isFile()) {
        const content = createHash('sha256')
          .update(await fsp.readFile(absolute))
          .digest('hex');
        fingerprint.update(`file\0${relative}\0${content}\n`);
      } else {
        fingerprint.update(`other\0${relative}\n`);
      }
    }
  };
  await walk(resolved.path, '');
  return fingerprint.digest('hex');
}

function installedCloudCopyIdentity(skillId: string): {
  sourceId: string;
  skillName: string;
} {
  const lastSlash = skillId.lastIndexOf('/');
  const sourceId = skillId.slice(0, Math.max(lastSlash, 0));
  const skillName = skillId.slice(lastSlash + 1);
  if (
    lastSlash < 0 ||
    !isSafeSegment(sourceId) ||
    !isSafeSegment(skillName) ||
    isBuiltinSourceId(sourceId) ||
    isCustomSourceId(sourceId)
  )
    throw new Error('Invalid skill id.');
  const lockEntry = readLockFile().skills[getLockKey(sourceId, skillName)];
  if (
    lockEntry === undefined ||
    lockEntry.sourceId !== sourceId ||
    !INSTALLED_CLOUD_COPY_SOURCE_TYPES.includes(lockEntry.sourceType)
  )
    throw new Error('Invalid skill id.');
  return { sourceId, skillName };
}

async function readSkillFileOf(
  identity: { sourceId: string; skillName: string },
  skillId: string,
): Promise<string> {
  const { sourceId, skillName } = identity;
  await assertStoredSkillContext(`${sourceId}/${skillName}`);
  const resolvedSkillDir = await resolveCanonicalSkillDirForRead(
    sourceId,
    skillName,
  );
  if (resolvedSkillDir.status === 'invalid') {
    throw new Error('Invalid skill id.');
  }
  const notFoundError = isCustomSourceId(sourceId)
    ? `Custom skill "${skillId}" not found.`
    : `Skill "${skillId}" not found.`;
  if (resolvedSkillDir.status === 'missing') {
    throw new Error(notFoundError);
  }
  const skillDir = resolvedSkillDir.path;
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  try {
    const stats = await fsp.lstat(skillMdPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(notFoundError);
    }
  } catch (error) {
    if (hasFileSystemErrorCode(error, 'ENOENT')) {
      throw new Error(notFoundError);
    }
    throw error;
  }
  return fsp.readFile(skillMdPath, 'utf-8');
}

/** Main import boundary: authorize source bytes and persist scoped provenance. */
export async function writeRawSkillForContext(
  input: WriteRawSkillRequest,
): Promise<WriteRawSkillResult> {
  if (input.replaceInstalled !== undefined) {
    if (
      !skillResourceContextEnabled() ||
      typeof input.sourceRemoteId !== 'string' ||
      !input.sourceRemoteId.trim() ||
      input.publicShare !== undefined
    )
      throw skillWriteError(
        'replacement-unsupported',
        'Open the scoped skill on an updated device and review it again.',
      );
    validateReplacement(input.replaceInstalled);
  }
  if (!skillResourceContextEnabled()) return writeRawSkill(input);
  // Capture before waiting for another mutation or doing any network reads.
  const snapshot = await skillContextSnapshot();
  return runSkillMutation(async () => {
    await assertSkillContextSnapshot(snapshot);
    if (input.sourceRemoteId) {
      // A collection member rides on the collection's subscription.
      return writeSharedSkillForContext(input.sourceRemoteId, {
        subscribe: input.inCollection !== true,
        replacement: input.replaceInstalled,
        snapshot,
      });
    }
    if (input.publicShare !== undefined) {
      // The origin arrives over IPC; its shape is checked before any field is
      // used, so a malformed payload reads as an invalid id rather than a
      // TypeError or a misleading "changed" rejection.
      if (!isPublicShareSkillOrigin(input.publicShare))
        throw new Error('Invalid share id.');
      return writePublicShareSkillForContext(input.publicShare);
    }
    throw new Error('A shared skill source is required.');
  });
}

function isPublicShareSkillOrigin(
  value: unknown,
): value is PublicShareSkillOrigin {
  return (
    typeof value === 'object' &&
    value !== null &&
    'externalId' in value &&
    typeof value.externalId === 'string' &&
    'contentHash' in value &&
    typeof value.contentHash === 'string' &&
    (!('collection' in value) ||
      value.collection === undefined ||
      isPublicShareSkillOrigin(value.collection))
  );
}

function skillWriteError(code: SkillWriteFailureCode, message: string): Error {
  return new Error(`Skill unavailable (${code}). ${message}`);
}

function validateReplacement(
  value: unknown,
): asserts value is NonNullable<WriteRawSkillRequest['replaceInstalled']> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('skillName' in value) ||
    typeof value.skillName !== 'string' ||
    getCustomSkillNameValidationError(value.skillName) ||
    !('expectedLocalContentHash' in value) ||
    typeof value.expectedLocalContentHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.expectedLocalContentHash) ||
    !('expectedSourceContentHash' in value) ||
    typeof value.expectedSourceContentHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.expectedSourceContentHash) ||
    ('expectedSourcePackageDigest' in value &&
      value.expectedSourcePackageDigest !== undefined &&
      !isPipelinePackageDigest(value.expectedSourcePackageDigest))
  )
    throw skillWriteError(
      'invalid-replacement',
      'Refresh and review the installed skill again.',
    );
}

function assertReviewedSource(
  detail: SharedSkillDetail,
  replacement: NonNullable<WriteRawSkillRequest['replaceInstalled']>,
): void {
  if (
    hashRawSkill(detail.rawSkill) !==
      replacement.expectedSourceContentHash.toLowerCase() ||
    detail.package?.digest !== replacement.expectedSourcePackageDigest
  )
    throw skillWriteError(
      'source-conflict',
      'The shared skill changed. Refresh and review it again.',
    );
}

/** Refuse links at every level, including SKILL.md, immediately before a rename. */
function replacementFile(skillName: string): string {
  const target = validateSkillPath(CUSTOM_SOURCE_ID, skillName);
  if (!target)
    throw skillWriteError(
      'invalid-replacement',
      'The installed skill path is invalid.',
    );
  const file = path.join(target, 'SKILL.md');
  const root = path.resolve(getSkillsRootDir());
  try {
    let current = root;
    for (const segment of ['', ...path.relative(root, file).split(path.sep)]) {
      if (segment) current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (
        stat.isSymbolicLink() ||
        (current === file ? !stat.isFile() : !stat.isDirectory())
      )
        throw skillWriteError(
          'invalid-replacement',
          'The installed skill path is unsafe.',
        );
    }
  } catch (error) {
    if (hasFileSystemErrorCode(error, 'ENOENT'))
      throw skillWriteError(
        'missing-copy',
        'The installed copy is missing. Restore it and review the skill again.',
      );
    throw error;
  }
  return file;
}

async function replaceSharedSkill(
  detail: SharedSkillDetail,
  aliases: ReadonlySet<string>,
  replacement: NonNullable<WriteRawSkillRequest['replaceInstalled']>,
  snapshot: string,
  subscribe: boolean,
): Promise<WriteRawSkillResult> {
  const skillName = replacement.skillName;
  const skillId = `${CUSTOM_SOURCE_ID}/${skillName}`;
  if (!aliases.has(skillId))
    throw skillWriteError(
      'review-required',
      'This copy does not belong to the shared skill. Refresh and review it again.',
    );
  assertReviewedSource(detail, replacement);
  const file = replacementFile(skillName);
  const directory = path.dirname(file);
  const journal = path.join(directory, SKILL_REPLACEMENT_JOURNAL);
  const stage = path.join(directory, '.canopy-shared-update-stage');
  const oldBytes = await fsp.readFile(file);
  const oldHash = hashRawSkill(oldBytes);
  const nextHash = hashRawSkill(detail.rawSkill);
  if (oldHash !== replacement.expectedLocalContentHash.toLowerCase())
    throw skillWriteError(
      'local-conflict',
      'Your installed skill changed. Refresh and review your edits again.',
    );

  // An interrupted attempt is never replayed from stored source bytes or grants.
  // A fresh explicit review reauthorizes the same alias and reconciles its receipt.
  // Ordinary Install remains blocked by the receipt, even after an interruption.
  if (fs.existsSync(journal)) {
    const stat = await fsp.lstat(journal);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw skillWriteError(
        'recovery-required',
        'The interrupted update could not be verified. Restore the installed copy and try again.',
      );
    let pending: unknown;
    try {
      pending = JSON.parse(await fsp.readFile(journal, 'utf8'));
    } catch {
      throw skillWriteError(
        'recovery-required',
        'The interrupted update could not be read. Restore the installed copy and try again.',
      );
    }
    if (
      typeof pending !== 'object' ||
      pending === null ||
      !('version' in pending) ||
      pending.version !== 1 ||
      !('remoteId' in pending) ||
      pending.remoteId !== detail.id ||
      !('previousHash' in pending) ||
      typeof pending.previousHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pending.previousHash) ||
      !('nextHash' in pending) ||
      typeof pending.nextHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pending.nextHash)
    )
      throw skillWriteError(
        'recovery-required',
        'The interrupted update belongs to another source. Restore the installed copy and try again.',
      );
  }
  // A crash before journal publication can leave only the reserved stage file.
  // It carries no authority and can be discarded before a freshly reviewed write.
  await fsp.rm(stage, { force: true });

  let renamed = false;
  let receiptRollback: (() => Promise<void>) | undefined;
  try {
    const mode = (await fsp.stat(file)).mode & 0o777;
    await stageReplacementBytes(stage, detail.rawSkill, mode);
    await writeFileAtomically(
      journal,
      JSON.stringify({
        version: 1,
        remoteId: detail.id,
        previousHash: oldHash,
        nextHash,
      }),
      { mode: 0o600, durable: true },
    );
    if (!(await getSharedSkillInstallIds(detail.id, true)).has(skillId))
      throw skillWriteError(
        'review-required',
        'The installed copy changed owners. Refresh and review it again.',
      );
    await assertStoredSkillContext(skillId);
    // Reauthorization can itself await a source read. Compare the reviewed
    // revision after that read, not only before it.
    const { getSharedSkill } = await import('./canopy-server-client');
    const fresh = await getSharedSkill(detail.id);
    if (fresh.id !== detail.id)
      throw skillWriteError(
        'source-conflict',
        'The shared skill identity changed. Open its link again.',
      );
    assertReviewedSource(fresh, replacement);
    await assertSkillContextSnapshot(snapshot);
    if (!skillResourceContextEnabled())
      throw skillWriteError(
        'replacement-unsupported',
        'Skill updates are unavailable. Review the skill again.',
      );
    // No await between this comparison and rename: managed writers hold the
    // mutation lock. An external editor can still race the filesystem operation;
    // atomic rename is not a filesystem compare-and-swap primitive.
    replacementFile(skillName);
    if (hashRawSkill(fs.readFileSync(file)) !== oldHash)
      throw skillWriteError(
        'local-conflict',
        'Your installed skill changed. Refresh and review your edits again.',
      );
    fs.renameSync(stage, file);
    renamed = true;
    await syncDirectory(directory);
    receiptRollback = await recordSharedSkillInstall(
      fresh,
      skillId,
      undefined,
      snapshot,
    );
    await assertSkillContextSnapshot(snapshot);
  } catch (error) {
    // Restore bytes only if they are still ours. Receipt compensation uses the
    // existing snapshot-conditional rollback, never a blind previous-row write.
    try {
      if (renamed) {
        replacementFile(skillName);
        if (hashRawSkill(fs.readFileSync(file)) !== nextHash)
          throw skillWriteError(
            'recovery-required',
            'The installed copy changed during recovery. Review it again.',
          );
        await stageReplacementBytes(
          stage,
          oldBytes,
          fs.statSync(file).mode & 0o777,
        );
        replacementFile(skillName);
        if (hashRawSkill(fs.readFileSync(file)) !== nextHash)
          throw skillWriteError(
            'recovery-required',
            'The installed copy changed during recovery. Review it again.',
          );
        fs.renameSync(stage, file);
        await syncDirectory(directory);
      }
      await receiptRollback?.();
      await fsp.rm(journal, { force: true });
    } catch {
      throw skillWriteError(
        'recovery-required',
        'The update was interrupted. Refresh and review the installed copy to finish recovery.',
      );
    }
    throw error;
  } finally {
    await fsp.rm(stage, { force: true });
  }
  const result: WriteRawSkillResult = { skillId, skillName };
  // A durable replacement is successful even if later subscription bookkeeping
  // fails. Retrying with a fresh review of these bytes is safe and repairs it.
  let subscriptionComplete = true;
  if (subscribe) {
    try {
      recordSharedItemInstall({
        kind: 'skill',
        remoteId: detail.id,
        sourceKind: 'shared',
        contentHash: nextHash,
        localId: skillId,
      });
    } catch {
      result.subscriptionWarning = 'subscription-update-failed';
      subscriptionComplete = false;
    }
  }
  if (subscriptionComplete)
    await fsp.rm(journal, { force: true }).catch(() => undefined);
  return result;
}

async function stageReplacementBytes(
  stage: string,
  bytes: string | Uint8Array,
  mode: number,
): Promise<void> {
  const handle = await fsp.open(stage, 'wx', mode);
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The first readable receipted alias, in local-id order, already matching the source. */
async function currentReceiptedCopy(
  ids: ReadonlySet<string>,
  rawSkill: string,
): Promise<{ skillName: string; existingMatch: true } | undefined> {
  const desired = hashRawSkill(rawSkill);
  for (const id of Array.from(ids).sort()) {
    if (!id.startsWith(`${CUSTOM_SOURCE_ID}/`)) continue;
    const skillName = parseCustomSkillId(id);
    if (!skillName) continue;
    let file: string;
    try {
      file = replacementFile(skillName);
    } catch {
      continue;
    }
    // An interrupted replacement still needs a fresh review to reconcile.
    if (await hasPendingSkillReplacement(skillName)) continue;
    if (hashRawSkill(await fsp.readFile(file)) === desired)
      return { skillName, existingMatch: true };
  }
  return undefined;
}

async function writeSharedSkillForContext(
  sourceRemoteId: string,
  options: {
    subscribe: boolean;
    replacement?: WriteRawSkillRequest['replaceInstalled'];
    snapshot: string;
  },
): Promise<WriteRawSkillResult> {
  const snapshot = options.snapshot;
  const { getSharedSkill } = await import('./canopy-server-client');
  const detail = await getSharedSkill(sourceRemoteId);
  if (options.replacement && detail.id !== sourceRemoteId)
    throw skillWriteError(
      'source-conflict',
      'The shared skill identity changed. Open its link again.',
    );
  const rawSkill = detail.rawSkill;
  const reusableIds = await getSharedSkillInstallIds(detail.id, true);
  if (options.replacement)
    return replaceSharedSkill(
      detail,
      reusableIds,
      options.replacement,
      snapshot,
      options.subscribe,
    );
  // An identical receipted copy is this install, so re-importing it (from a
  // collection or App Advisor) stays idempotent. Any other receipted copy needs
  // the reviewed replacement and never allocates another name.
  const reused =
    reusableIds.size > 0
      ? await currentReceiptedCopy(reusableIds, rawSkill)
      : undefined;
  if (reusableIds.size > 0 && reused === undefined)
    throw skillWriteError(
      'review-required',
      'This skill already has an installed copy. Refresh and review that copy before updating.',
    );
  for (let attempt = 1; ; attempt += 1) {
    const resolved =
      reused ??
      resolveAvailableCustomSkillName(detail.name, rawSkill, reusableIds);
    const skillId = `${CUSTOM_SOURCE_ID}/${resolved.skillName}`;
    await assertStoredSkillContext(skillId);
    const rollback = await recordSharedSkillInstall(detail, skillId);
    let written: { skillId: string; skillName: string } | null;
    try {
      await assertSkillContextSnapshot(snapshot);
      written = claimRawSkillWrite(resolved, rawSkill);
    } catch (error) {
      await rollback?.();
      throw error;
    }
    if (written) {
      if (options.subscribe)
        recordSharedItemInstall({
          kind: 'skill',
          remoteId: detail.id,
          sourceKind: 'shared',
          contentHash: detail.contentHash,
          localId: written.skillId,
        });
      return written;
    }
    // Another import claimed the name while this one awaited its checks; the
    // receipt named that destination, so release it and check the next one.
    await rollback?.();
    assertNameClaimAttempts(attempt);
  }
}

const MAX_NAME_CLAIM_ATTEMPTS = 3;

function assertNameClaimAttempts(attempt: number): void {
  if (attempt >= MAX_NAME_CLAIM_ATTEMPTS)
    throw new Error('Could not claim a skill name. Try again.');
}

/**
 * Write the resolved name, or report that another import claimed it first.
 *
 * The context checks between resolving a name and writing it await, so a
 * concurrent import can take the name in the meantime. The atomic claim is
 * an exclusive create of `SKILL.md`, the file the name resolver keys on: it
 * fails with `EEXIST` only when a skill really landed there, rather than
 * silently re-resolving to a suffixed name the caller never context-checked.
 * A directory without a `SKILL.md` is still free, as it always was. An
 * identical existing copy needs no write at all.
 */
function claimRawSkillWrite(
  resolved: { skillName: string; existingMatch: boolean },
  rawSkill: string,
): { skillId: string; skillName: string } | null {
  ensureCustomSourceMetadata();
  const skillId = `${CUSTOM_SOURCE_ID}/${resolved.skillName}`;
  if (resolved.existingMatch) return { skillId, skillName: resolved.skillName };
  const targetDir = validateSkillPath(CUSTOM_SOURCE_ID, resolved.skillName);
  if (!targetDir) {
    throw new Error('Invalid skill name.');
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const skillMdPath = path.join(targetDir, 'SKILL.md');
  let fd: number;
  try {
    fd = fs.openSync(skillMdPath, 'wx');
  } catch (error) {
    if (hasFileSystemErrorCode(error, 'EEXIST')) return null;
    throw error;
  }
  let failure: { error: unknown } | undefined;
  try {
    fs.writeFileSync(fd, rawSkill, 'utf-8');
  } catch (error) {
    failure = { error };
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    failure ??= { error };
  }
  if (failure) {
    // Neither a failed write nor a failed close may leave a claimed skill
    // behind, especially after the owned-source receipt is rolled back.
    fs.rmSync(skillMdPath, { force: true });
    throw failure.error;
  }
  return { skillId, skillName: resolved.skillName };
}

/** Canonical share UUID, as the share deep-link handler requires. */
const PUBLIC_SHARE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A Marketplace or share-link skill is a public share. It has no owning team
 * or organization, so there is no shared source to receipt; main verifies the
 * origin itself by re-reading the share and writes the published bytes as
 * personal content, the same way the packaged-files installer treats a public
 * share. Caller bytes are never written on this path.
 */
async function writePublicShareSkillForContext(
  origin: PublicShareSkillOrigin,
): Promise<{ skillId: string; skillName: string }> {
  // Renderer-supplied; the id reaches a request path, so it is checked here
  // the same way the share deep-link handler checks its external id. Catalog
  // and link ids are already lowercase; any other spelling is normalized.
  const externalId = origin.externalId.toLowerCase();
  if (!PUBLIC_SHARE_ID_PATTERN.test(externalId))
    throw new Error('Invalid share id.');
  // Taken before the network read so a context switch during the read is
  // caught by the check before the write.
  const collectionId = origin.collection?.externalId.toLowerCase();
  if (collectionId !== undefined && !PUBLIC_SHARE_ID_PATTERN.test(collectionId))
    throw new Error('Invalid share id.');
  const snapshot = await skillContextSnapshot();
  const { getPublicCollectionShareSnapshot, getPublicSkillShareSnapshot } =
    await import('../canopy-cloud/public-share-client');
  let published: { name: string; rawSkill: string };
  if (origin.collection && collectionId !== undefined) {
    // A Public collection pins its custom skills inside its own snapshot; they
    // have no standalone share. Re-read that snapshot and take the bytes the
    // recipient reviewed from it.
    const collection = await getPublicCollectionShareSnapshot(collectionId);
    const pinned = collection.customSkills.find(
      (skill) => skill.id.toLowerCase() === externalId,
    );
    if (
      collection.contentHash !== origin.collection.contentHash ||
      pinned?.contentHash !== origin.contentHash
    )
      throw new Error('The shared collection changed. Open the link again.');
    published = pinned;
  } else {
    const share = await getPublicSkillShareSnapshot(externalId);
    // A link that resolved through the authenticated team or organization
    // fallback is owned content and must come back through the receipt path.
    if (share.scopedShare === true || share.sourceRemoteId !== undefined)
      throw new Error(
        'This skill belongs to a team or organization. Open it from there to install it.',
      );
    if (share.contentHash !== origin.contentHash)
      throw new Error(
        'The shared skill changed. Refresh and review it before installing.',
      );
    published = share;
  }
  // No receipt binds a public install, so an identical local copy is reused as
  // it is without enforcement, except one that an install receipt binds to a
  // team or organization: that copy belongs to its context (the renderer
  // cannot even see it from another), so it counts as a collision and the
  // install takes a suffix like any differing bytes would.
  const MAX_RECEIPTED_REUSE_SKIPS = 32;
  const receipted = new Set<string>();
  for (let attempt = 1; ; attempt += 1) {
    let resolved = resolveAvailableCustomSkillName(
      published.name,
      published.rawSkill,
      undefined,
      receipted,
    );
    let skillId = `${CUSTOM_SOURCE_ID}/${resolved.skillName}`;
    while (resolved.existingMatch && (await hasSkillInstallReceipt(skillId))) {
      if (receipted.size >= MAX_RECEIPTED_REUSE_SKIPS)
        throw new Error('Could not claim a skill name. Try again.');
      receipted.add(skillId);
      resolved = resolveAvailableCustomSkillName(
        published.name,
        published.rawSkill,
        undefined,
        receipted,
      );
      skillId = `${CUSTOM_SOURCE_ID}/${resolved.skillName}`;
    }
    await assertStoredSkillContext(skillId);
    await assertSkillContextSnapshot(snapshot);
    if (resolved.existingMatch && (await hasSkillInstallReceipt(skillId))) {
      if (receipted.size >= MAX_RECEIPTED_REUSE_SKIPS)
        throw new Error('Could not claim a skill name. Try again.');
      receipted.add(skillId);
      assertNameClaimAttempts(attempt);
      continue;
    }
    const written = claimRawSkillWrite(resolved, published.rawSkill);
    if (written) {
      // A collection's pinned skill rides on the collection's subscription.
      if (!origin.collection)
        recordSharedItemInstall({
          kind: 'skill',
          remoteId: externalId,
          sourceKind: 'public',
          contentHash: origin.contentHash,
          localId: written.skillId,
        });
      return written;
    }
    assertNameClaimAttempts(attempt);
  }
}

export function writeRawSkill(input: { skillName: string; rawSkill: string }): {
  skillId: string;
  skillName: string;
} {
  if (skillMutationPending())
    throw skillWriteError(
      'local-conflict',
      'Another skill change is in progress. Try again.',
    );
  ensureCustomSourceMetadata();
  const resolved = resolveAvailableCustomSkillName(
    input.skillName,
    input.rawSkill,
  );
  if (!resolved.existingMatch) {
    const targetDir = validateSkillPath(CUSTOM_SOURCE_ID, resolved.skillName);
    if (!targetDir) {
      throw new Error('Invalid skill name.');
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'SKILL.md'), input.rawSkill, 'utf-8');
  }
  return {
    skillId: `${CUSTOM_SOURCE_ID}/${resolved.skillName}`,
    skillName: resolved.skillName,
  };
}

export async function updateSkill(
  sourceId: string,
  skillName: string,
): Promise<IPCResultWithAppError<void>> {
  if (isBuiltinSourceId(sourceId)) {
    return { success: false, error: 'Built-in skills cannot be updated.' };
  }
  try {
    await assertStoredSkillContext(`${sourceId}/${skillName}`);
    const lock = readLockFile();
    const lockKey = getLockKey(sourceId, skillName);
    const entry = lock.skills[lockKey];
    if (!entry) {
      return { success: false, error: `Skill "${skillName}" not found.` };
    }

    const parsed = parseGitHubSource(entry.source);
    if (!parsed) {
      return { success: false, error: 'Invalid source in lock file.' };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken();
    const { tree, resolvedBranch } = await fetchGitHubTree(owner, repo, token);

    // Re-discover skills to find this specific one
    const { skills } = await discoverSkillsFromGitHub(
      owner,
      repo,
      resolvedBranch,
    );
    const skill = skills.find((s) => sanitizeName(s.name) === skillName);
    if (!skill) {
      return {
        success: false,
        error: `Skill "${skillName}" no longer found in source.`,
      };
    }

    const sourceDir = getSourceDir(sourceId);

    // installSkill stages the download and swaps it in, so a failure keeps the old copy.
    if (!validateSkillPath(sourceId, skillName)) {
      return { success: false, error: 'Invalid skill path.' };
    }
    // A refused lock fails the update before any file is swapped.
    assertLockWritable();

    await installSkill(
      owner,
      repo,
      resolvedBranch,
      skill,
      tree,
      sourceDir,
      token,
    );

    // Update lock entry
    const hash = await fetchSkillFolderHash(
      owner,
      repo,
      skill.sourcePath,
      resolvedBranch,
    );

    addLockEntry(sourceId, skillName, {
      ...entry,
      skillPath: skill.sourcePath,
      skillFolderHash: hash || '',
      updatedAt: new Date().toISOString(),
    });
    setSkillUpdateStatus(sourceId, skillName, false);

    return { success: true, data: undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      ...reportInstallFailure(error, 'skill.update'),
    };
  }
}

export async function checkUpdates(
  progress?: SkillUpdateProgressReporter,
): Promise<IPCResult<Record<string, boolean>>> {
  try {
    progress?.({
      operation: 'check-updates',
      status: 'running',
      message: 'Checking installed skills for updates...',
    });
    const lock = readLockFile();
    const result: Record<string, boolean> = {};

    for (const [key, entry] of Object.entries(lock.skills)) {
      const { skillName } = parseLockKey(key);
      result[key] = await checkForUpdate(skillName, entry);
    }

    const latestLock = readLockFile();
    const cachedStatus = readSkillUpdateStatus();
    const mergedResult: Record<string, boolean> = {};
    for (const [key, latestEntry] of Object.entries(latestLock.skills)) {
      const checkedEntry = lock.skills[key];
      if (
        checkedEntry &&
        checkedEntry.skillFolderHash === latestEntry.skillFolderHash &&
        key in result
      ) {
        mergedResult[key] = result[key];
      } else if (key in cachedStatus) {
        mergedResult[key] = cachedStatus[key];
      }
    }

    writeSkillUpdateStatus(mergedResult);
    progress?.({
      operation: 'check-updates',
      status: 'complete',
      message: 'Skill update check complete.',
      updateMap: mergedResult,
    });

    return { success: true, data: mergedResult };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress?.({
      operation: 'check-updates',
      status: 'error',
      message,
    });
    return { success: false, error: message };
  }
}

export function readSkillContent(
  sourceId: string,
  skillName: string,
): IPCResult<SkillContentResponse> {
  try {
    // Handle built-in skills: read from bundled resources
    if (isBuiltinSourceId(sourceId)) {
      const builtinMdPath = path.join(
        getBundledSkillDir(skillName),
        'SKILL.md',
      );
      if (!fs.existsSync(builtinMdPath)) {
        return {
          success: false,
          error: `Built-in skill "${skillName}" not found.`,
        };
      }
      const raw = fs.readFileSync(builtinMdPath, 'utf-8');
      const parsed = parseFrontmatterAndBody(raw);
      return { success: true, data: parsed };
    }

    const validatedDir = validateSkillPath(sourceId, skillName);
    if (!validatedDir) {
      return { success: false, error: 'Invalid skill path.' };
    }
    const skillMdPath = path.join(validatedDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return {
        success: false,
        error: `SKILL.md not found for "${skillName}".`,
      };
    }

    const raw = fs.readFileSync(skillMdPath, 'utf-8');
    const parsed = parseFrontmatterAndBody(raw);
    return { success: true, data: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

const MAX_SKILL_FILES_LISTED = 500;
const MAX_SKILL_ENTRIES_VISITED = 2_000;
const MAX_SKILL_FILE_READ_BYTES = 512 * 1024;

export async function listSkillFiles(
  sourceId: string,
  skillName: string,
): Promise<IPCResult<SkillFilesResponse>> {
  try {
    await assertStoredSkillContext(`${sourceId}/${skillName}`);
    const resolvedSkillDir = await resolveCanonicalSkillDirForRead(
      sourceId,
      skillName,
    );
    if (resolvedSkillDir.status === 'invalid') {
      return { success: false, error: 'Invalid skill path.' };
    }
    if (resolvedSkillDir.status === 'missing') {
      return { success: false, error: `Skill "${skillName}" not found.` };
    }
    const skillDir = resolvedSkillDir.path;

    const supportingFiles = await collectSkillFilesBounded(
      skillDir,
      MAX_SKILL_FILES_LISTED,
      MAX_SKILL_ENTRIES_VISITED,
    );
    let hasSkillFile = false;
    try {
      const mainFileStats = await fsp.lstat(path.join(skillDir, 'SKILL.md'));
      hasSkillFile = mainFileStats.isFile() && !mainFileStats.isSymbolicLink();
    } catch (error) {
      if (!hasFileSystemErrorCode(error, 'ENOENT')) throw error;
    }
    const files = hasSkillFile
      ? ['SKILL.md', ...supportingFiles.files]
      : supportingFiles.files;
    return {
      success: true,
      data: { files, truncated: supportingFiles.truncated },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export async function readSkillFile(
  sourceId: string,
  skillName: string,
  filePath: string,
): Promise<IPCResult<SkillFileContentResponse>> {
  try {
    await assertStoredSkillContext(`${sourceId}/${skillName}`);
    const lexicalSkillDir = resolveSkillDirForRead(sourceId, skillName);
    if (!lexicalSkillDir) {
      return { success: false, error: 'Invalid skill path.' };
    }
    if (!resolveSkillFilePath(lexicalSkillDir, filePath, 'local-read')) {
      return { success: false, error: 'Invalid file path.' };
    }
    const resolvedSkillDir = await resolveCanonicalSkillDirForRead(
      sourceId,
      skillName,
    );
    if (resolvedSkillDir.status === 'invalid') {
      return { success: false, error: 'Invalid skill path.' };
    }
    if (resolvedSkillDir.status === 'missing') {
      return { success: false, error: `File "${filePath}" not found.` };
    }
    const skillDir = resolvedSkillDir.path;
    const resolved = await resolveSkillFileForRead(skillDir, filePath);
    if (resolved.status === 'invalid') {
      return { success: false, error: 'Invalid file path.' };
    }
    if (resolved.status === 'missing') {
      return { success: false, error: `File "${filePath}" not found.` };
    }

    const handle = await fsp.open(resolved.path, 'r');
    let buffer: Buffer;
    let truncated: boolean;
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { success: false, error: `File "${filePath}" not found.` };
      }
      const bytesToRead = Math.min(stats.size, MAX_SKILL_FILE_READ_BYTES);
      buffer = Buffer.alloc(bytesToRead);
      let offset = 0;
      while (offset < bytesToRead) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          bytesToRead - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      buffer = buffer.subarray(0, offset);
      truncated = stats.size > offset;
    } finally {
      await handle.close();
    }

    if (buffer.subarray(0, 8192).includes(0)) {
      return {
        success: true,
        data: { content: '', truncated, binary: true },
      };
    }

    let content: string;
    try {
      const decoder = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      });
      content = decoder.decode(buffer, { stream: truncated });
    } catch {
      return {
        success: true,
        data: { content: '', truncated, binary: true },
      };
    }
    return { success: true, data: { content, truncated, binary: false } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
