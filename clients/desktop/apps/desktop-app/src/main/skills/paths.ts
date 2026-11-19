import { join } from 'path';
import { BRAND } from '@canopy/brand/current';
import { getSkillSourceDirectoryName } from '@canopy/execution-engine/node/skills/paths';
import { getDataDir } from '../lib/paths';
import {
  BUILT_IN_SKILL_SOURCE_ID,
  CUSTOM_SKILL_SOURCE_ID,
} from '@canopy/protocol/skills';

export const BUILTIN_SOURCE_ID = BUILT_IN_SKILL_SOURCE_ID;
export const CUSTOM_SOURCE_ID = CUSTOM_SKILL_SOURCE_ID;

export function isBuiltinSourceId(sourceId: string): boolean {
  return (
    sourceId === BUILTIN_SOURCE_ID ||
    sourceId === 'builtin' ||
    sourceId === 'builtin/app' ||
    sourceId === `builtin:${BRAND.internalName}` ||
    sourceId === `builtin/${BRAND.internalName}`
  );
}

export function isCustomSourceId(sourceId: string): boolean {
  return sourceId === CUSTOM_SOURCE_ID;
}

export function getSkillsRootDir(): string {
  return join(getDataDir(), 'skills');
}

/**
 * Derive a stable logical source ID from source metadata.
 *
 * - GitHub:  `github:owner:repo`
 * - Local:   `local:<escaped path>` (slashes → underscores, last 100 chars)
 * - URL/etc: `<type>:<escaped>` (slashes → underscores, last 100 chars)
 */
export function deriveSourceId(sourceType: string, source: string): string {
  const prefix = `${sourceType}:`;
  if (sourceType === 'github') {
    // source is "owner/repo" → "github:owner:repo"
    return `${prefix}${source.replace(/\//g, ':')}`;
  }
  // For local/url: replace path separators, keep last 100 chars
  const escaped = source.replace(/[/\\]/g, '_');
  const truncated =
    escaped.length > 100 ? escaped.slice(escaped.length - 100) : escaped;
  return `${prefix}${truncated}`;
}

/**
 * Convert a logical source ID into a directory segment that is valid on the
 * current platform. Logical IDs intentionally contain colons, which Windows
 * reserves in file and directory names. Keep the existing names on other
 * platforms so current installations remain in place.
 */
export function getSourceDirectoryName(
  sourceId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return getSkillSourceDirectoryName(sourceId, platform);
}

export function getSourceDir(
  sourceId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(getSkillsRootDir(), getSourceDirectoryName(sourceId, platform));
}

export function getSourceMetadataPath(sourceId: string): string {
  return join(getSourceDir(sourceId), 'source.json');
}

export function getSkillDir(sourceId: string, skillName: string): string {
  return join(getSourceDir(sourceId), skillName);
}

export function getSkillsLockFilePath(): string {
  return join(getSkillsRootDir(), 'skills-lock.json');
}
