/**
 * Adapted from https://github.com/vercel-labs/skills
 * Original source: MIT License
 * https://github.com/vercel-labs/skills/blob/main/src/installer.ts
 */

import * as fs from 'fs';
import * as fsp from 'node:fs/promises';
import * as path from 'path';
import type { AvailableSkill } from '@canopy/desktop-shared/types/skills';
import { httpsGetBuffer } from '../lib/http';
import { isPathInside } from '../lib/path-safety';
import { isErrnoException } from '../lib/type-guards';

/** Files excluded during installation */
const EXCLUDE_FILES = new Set(['metadata.json']);

/**
 * Sanitize a skill name for use as a directory name.
 * Lowercases, replaces non-safe characters with hyphens, and caps at 255 chars.
 */
export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '');
  return sanitized.substring(0, 255) || 'unnamed-skill';
}

function isExcluded(name: string, isDirectory: boolean): boolean {
  return (
    EXCLUDE_FILES.has(name) ||
    name.startsWith('_') ||
    (isDirectory && name === '.git')
  );
}

interface TreeEntry {
  path: string;
  type: string;
}

const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

/**
 * Remove download staging an exit left behind for more than a day. A staging
 * folder holding a `previous` copy may be the only copy of a skill, so it is
 * kept for a person to recover.
 */
async function sweepStaleStaging(sourceDir: string): Promise<void> {
  const names = await fsp.readdir(sourceDir).catch((): string[] => []);
  for (const name of names) {
    if (!name.startsWith('.install-')) continue;
    const stagingRoot = path.join(sourceDir, name);
    try {
      const { mtimeMs } = await fsp.stat(stagingRoot);
      if (Date.now() - mtimeMs < STALE_STAGING_MS) continue;
      // Only a confirmed-missing previous copy lets the staging go.
      const previousMissing = await fsp
        .lstat(path.join(stagingRoot, 'previous'))
        .then(
          () => false,
          (error: unknown) =>
            isErrnoException(error) && error.code === 'ENOENT',
        );
      if (previousMissing)
        await fsp.rm(stagingRoot, { recursive: true, force: true });
    } catch {
      // Best effort: a sweep that cannot finish must not fail the install.
    }
  }
}

/**
 * Install a skill by downloading its files from GitHub and writing them
 * to `{outputDir}/{sanitizedName}/`.
 *
 * @param owner - GitHub repo owner
 * @param repo - GitHub repo name
 * @param branch - Branch to fetch from
 * @param skill - The skill to install (with sourcePath from discovery)
 * @param treeEntries - Full tree listing from the GitHub Trees API
 * @param sourceDir - Source-specific directory (e.g. {userData}/skills/{sourceId}/)
 * @param token - GitHub auth token (optional)
 */
export async function installSkill(
  owner: string,
  repo: string,
  branch: string,
  skill: AvailableSkill,
  treeEntries: TreeEntry[],
  sourceDir: string,
  token: string | null,
): Promise<void> {
  const sanitized = sanitizeName(skill.name);
  const skillDir = path.join(sourceDir, sanitized);

  if (!isPathInside(sourceDir, skillDir)) {
    throw new Error(`Unsafe skill directory path: ${skillDir}`);
  }

  // Download beside the destination. A network failure must leave the entire
  // existing install (including local-only files) untouched.
  await sweepStaleStaging(sourceDir);
  // After the sweep's await, so a concurrent uninstall cannot remove it first.
  fs.mkdirSync(sourceDir, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(sourceDir, '.install-'));
  const stagedSkillDir = path.join(stagingRoot, 'next');
  const backupDir = path.join(stagingRoot, 'previous');
  let retainBackup = false;
  try {
    fs.mkdirSync(stagedSkillDir);
    // Find all files under this skill's source path
    const prefix = skill.sourcePath === '.' ? '' : skill.sourcePath + '/';
    const skillFiles = treeEntries.filter((entry) => {
      if (entry.type !== 'blob') return false;
      if (prefix && !entry.path.startsWith(prefix)) return false;
      if (!prefix && entry.path.includes('/')) {
        // When sourcePath is root, include all files — file-level exclusion
        // checks below (isExcluded, isPathInside) handle .git, underscored dirs, etc.
        return true;
      }
      return true;
    });

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    for (const fileEntry of skillFiles) {
      // Compute relative path within the skill directory
      const relativePath = prefix
        ? fileEntry.path.substring(prefix.length)
        : fileEntry.path;

      // Check exclusions
      const fileName = path.basename(relativePath);
      const dirName = path.dirname(relativePath);
      if (isExcluded(fileName, false)) continue;
      if (dirName.split('/').some((segment) => isExcluded(segment, true))) {
        continue;
      }

      const targetPath = path.join(stagedSkillDir, relativePath);
      if (!isPathInside(stagedSkillDir, targetPath)) continue;

      // Ensure parent directory exists
      const parentDir = path.dirname(targetPath);
      fs.mkdirSync(parentDir, { recursive: true });

      // Download and write file
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fileEntry.path}`;
      const content = await httpsGetBuffer(rawUrl, { headers });
      fs.writeFileSync(targetPath, content);
    }
    const hadExisting = fs.existsSync(skillDir);
    if (hadExisting) fs.renameSync(skillDir, backupDir);
    try {
      fs.renameSync(stagedSkillDir, skillDir);
    } catch (error) {
      if (hadExisting) {
        // If restoration itself fails, keep the recoverable backup on disk.
        retainBackup = true;
        fs.renameSync(backupDir, skillDir);
        retainBackup = false;
      }
      throw error;
    }
  } finally {
    if (!retainBackup) fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}
