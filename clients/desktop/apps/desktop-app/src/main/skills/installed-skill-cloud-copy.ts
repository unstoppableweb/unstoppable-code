import type { InstalledSkillInfo } from '@canopy/protocol/skills';
import { isBuiltinSourceId, isCustomSourceId } from './paths';

/**
 * Skills installed from GitHub, a URL or a local folder, offered for a
 * private cloud copy behind `canopy-desktop-cloud-copy-installed-skills`
 * (CAN-6943). Their source ids are `github:owner:repo`, `url:<escaped>` and
 * `local:<escaped>` (see `deriveSourceId`); any other source, a built-in or
 * custom skill, one installed from someone's cloud share, or a plugin's skill
 * is never one.
 */
const INSTALLED_SOURCE_PREFIXES: readonly string[] = [
  'github:',
  'url:',
  'local:',
];

export function isInstalledSkillSourceId(sourceId: string): boolean {
  return (
    INSTALLED_SOURCE_PREFIXES.some((prefix) => sourceId.startsWith(prefix)) &&
    !sourceId.includes('/') &&
    !isBuiltinSourceId(sourceId) &&
    !isCustomSourceId(sourceId)
  );
}

/** `<sourceId>/<name>` of an installed-source skill, or null. */
export function parseInstalledSkillLocalId(
  localId: string,
): { sourceId: string; skillName: string } | null {
  const slash = localId.indexOf('/');
  if (slash <= 0 || localId.indexOf('/', slash + 1) !== -1) return null;
  const sourceId = localId.slice(0, slash);
  const skillName = localId.slice(slash + 1);
  if (skillName === '' || !isInstalledSkillSourceId(sourceId)) return null;
  return { sourceId, skillName };
}

/** The installed-source skill a desktop catalog entry id names, or null. */
export function parseInstalledSkillEntry(
  entryId: string,
): { sourceId: string; skillName: string } | null {
  return entryId.startsWith('skill:')
    ? parseInstalledSkillLocalId(entryId.slice('skill:'.length))
    : null;
}

/**
 * Whether a loaded skill may go to the cloud as an installed-source copy:
 * from the lock file, and not installed from a cloud share, whose copy is
 * someone else's.
 */
export function isCopyableInstalledSkill(skill: InstalledSkillInfo): boolean {
  return (
    isInstalledSkillSourceId(skill.sourceId) &&
    skill.custom !== true &&
    skill.builtIn !== true &&
    skill.installedFromShare === undefined
  );
}
