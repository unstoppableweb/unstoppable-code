import type { Dirent } from 'node:fs';
import { access, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

const CLAUDE_PROJECT_SCAN_ENTRY_LIMIT = 10_000;

export function getClaudeCodeProjectsDir(
  configDir?: string,
  cwd = process.cwd(),
): string {
  // Claude resolves even empty or whitespace config values against its cwd.
  return path.join(
    path.resolve(
      cwd,
      configDir ??
        process.env.CLAUDE_CONFIG_DIR ??
        path.join(homedir(), '.claude'),
    ),
    'projects',
  );
}

export function claudeProjectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9_-]/g, '-');
}

export function normalizeClaudeProjectCwd(
  cwd: string,
  platform: NodeJS.Platform | null,
): string {
  return platform === 'darwin' ? cwd.normalize('NFC') : cwd;
}

export function currentClaudeProjectSlug(
  cwd: string,
  platform: NodeJS.Platform | null = hostOperatingSystem(),
): string {
  // SDK 0.3.321 normalizes the canonical macOS cwd before sanitizing/hashing.
  return slugClaudeProjectCwd(normalizeClaudeProjectCwd(cwd, platform));
}

function slugClaudeProjectCwd(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let hash = 0;
  for (let index = 0; index < cwd.length; index++)
    hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Candidate `<Claude config>/projects/<dir>` names for a cwd, most likely first.
 *
 * Claude Code ≥2.1.x slugs the resolved cwd on Linux and the real path elsewhere,
 * and hashes long paths, after NFC normalization on macOS. Older
 * untruncated and underscore-preserving forms remain fallback candidates
 * for resolved and unresolved paths.
 */
export async function claudeProjectDirCandidates(
  cwd: string,
  platform: NodeJS.Platform | null = hostOperatingSystem(),
): Promise<string[]> {
  const resolved = path.resolve(cwd);
  let real = resolved;
  try {
    real = await realpath(resolved);
  } catch {
    // Removed worktrees still need to fall back to the unresolved path.
  }
  const normalizedReal = normalizeClaudeProjectCwd(real, platform);
  const normalizedResolved = normalizeClaudeProjectCwd(resolved, platform);
  const modernSlug = (value: string): string =>
    value.replace(/[^A-Za-z0-9-]/g, '-');
  const legacySlug = (value: string): string =>
    value.replace(/[^A-Za-z0-9_-]/g, '-');
  return Array.from(
    new Set([
      currentClaudeProjectSlug(
        platform === 'linux' ? resolved : real,
        platform,
      ),
      currentClaudeProjectSlug(real, platform),
      currentClaudeProjectSlug(resolved, platform),
      modernSlug(normalizedReal),
      modernSlug(normalizedResolved),
      legacySlug(normalizedReal),
      legacySlug(normalizedResolved),
      // Retain pre-normalization shadows; recovery must not resurrect old chats.
      slugClaudeProjectCwd(real),
      slugClaudeProjectCwd(resolved),
      modernSlug(real),
      modernSlug(resolved),
      legacySlug(real),
      legacySlug(resolved),
    ]),
  );
}

export async function resolveClaudeCodeSessionTranscriptPath(
  sdkSessionId: string,
  cwd: string,
): Promise<string | undefined> {
  const projectsDir = getClaudeCodeProjectsDir(undefined, cwd);
  const fileName = `${sdkSessionId}.jsonl`;
  return findClaudeCodeSessionTranscriptInProjectsDir(
    projectsDir,
    fileName,
    cwd,
  );
}

export interface ClaudeCodeSessionTranscriptCandidates {
  paths: string[];
  /** True when the bounded project scan could not inspect every candidate. */
  scanExhausted: boolean;
}

/**
 * Return current-cwd slug matches, or bounded compatibility-scan matches
 * only when none exist. A current copy is authoritative over retained originals.
 */
export async function findClaudeCodeSessionTranscriptCandidates(
  sdkSessionId: string,
  cwd: string,
  configDir?: string,
): Promise<ClaudeCodeSessionTranscriptCandidates> {
  const projectsDir = getClaudeCodeProjectsDir(configDir, cwd);
  const fileName = `${sdkSessionId}.jsonl`;
  const paths = new Set<string>();
  for (const dirName of await claudeProjectDirCandidates(cwd)) {
    const candidatePath = path.join(projectsDir, dirName, fileName);
    try {
      await access(candidatePath);
      paths.add(candidatePath);
    } catch {
      // Continue through the remaining slug candidates and bounded scan.
    }
  }

  if (paths.size > 0) return { paths: Array.from(paths), scanExhausted: false };

  const stack = [projectsDir];
  let visitedEntries = 0;
  let scanExhausted = false;
  while (stack.length > 0 && visitedEntries < CLAUDE_PROJECT_SCAN_ENTRY_LIMIT) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A skipped directory could contain another matching transcript.
      scanExhausted = true;
      continue;
    }
    for (const entry of entries) {
      if (visitedEntries >= CLAUDE_PROJECT_SCAN_ENTRY_LIMIT) {
        scanExhausted = true;
        break;
      }
      visitedEntries += 1;
      if (entry.isFile() && entry.name === fileName) {
        paths.add(path.join(dir, entry.name));
      }
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      }
    }
  }
  if (stack.length > 0) scanExhausted = true;

  return { paths: Array.from(paths), scanExhausted };
}

export async function findClaudeCodeSessionTranscriptInProjectsDir(
  projectsDir: string,
  fileName: string,
  cwd: string,
): Promise<string | undefined> {
  for (const dirName of await claudeProjectDirCandidates(cwd)) {
    const canonicalPath = path.join(projectsDir, dirName, fileName);
    try {
      await access(canonicalPath);
      return canonicalPath;
    } catch {
      // Try the next slug candidate, then the bounded scan.
    }
  }

  const stack = [projectsDir];
  let visitedEntries = 0;
  while (stack.length > 0 && visitedEntries < CLAUDE_PROJECT_SCAN_ENTRY_LIMIT) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visitedEntries += 1;
      if (entry.isFile() && entry.name === fileName) {
        return path.join(dir, entry.name);
      }
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      }
      if (visitedEntries >= CLAUDE_PROJECT_SCAN_ENTRY_LIMIT) {
        break;
      }
    }
  }
  return undefined;
}
