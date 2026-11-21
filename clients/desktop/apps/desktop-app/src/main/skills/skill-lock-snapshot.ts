import { promises as fs } from 'fs';
import { skillLockMigrationSettled } from './lock-file';
import { getSkillsLockFilePath } from './paths';

/**
 * Entries are the lock's `skills` record as stored, unvalidated; read their
 * fields with `skillLockEntryString`.
 */
export type SkillLockSnapshot =
  | { state: 'ok'; entries: ReadonlyMap<string, unknown> }
  | { state: 'unreadable' };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A lock entry field when it is a string, else null. */
export function skillLockEntryString(
  entry: unknown,
  field: 'skillFolderHash' | 'skillPath' | 'updatedAt',
): string | null {
  if (!isObject(entry)) return null;
  const value = entry[field];
  return typeof value === 'string' ? value : null;
}

/**
 * A read-only view of skills-lock.json (CAN-4124 D10). Never writes and never
 * migrates: absent is an empty lock; unparsable JSON, a non-object `skills`
 * or any version other than 2 (including 1) is unreadable, never empty.
 */
export async function readSkillLockSnapshot(): Promise<SkillLockSnapshot> {
  // A started v1 migration commits before revisions are read (CAN-4483).
  await skillLockMigrationSettled();
  let text: string;
  try {
    text = await fs.readFile(getSkillsLockFilePath(), 'utf8');
  } catch (error) {
    return isObject(error) && error.code === 'ENOENT'
      ? { state: 'ok', entries: new Map() }
      : { state: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'unreadable' };
  }
  if (!isObject(parsed) || parsed.version !== 2 || !isObject(parsed.skills))
    return { state: 'unreadable' };
  return { state: 'ok', entries: new Map(Object.entries(parsed.skills)) };
}
