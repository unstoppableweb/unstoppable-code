/*
 * The Work Entry registry's file names (CAN-4476), without filesystem access,
 * so modules that only recognize the registry's files need not name it.
 */

export const WORK_ENTRIES_FILE_NAME = 'work-entries.json';

const TEMP_PREFIX = '.work-entries-';
const TEMP_SUFFIX = '.tmp';

/** The sibling temporary name the registry install writes before its rename. */
export function workEntryRegistryTempName(token: string): string {
  return `${TEMP_PREFIX}${token}${TEMP_SUFFIX}`;
}

/** Whether `name` is the registry file or one of its install temp files. */
export function isWorkEntryRegistryArtifactName(name: string): boolean {
  return (
    name === WORK_ENTRIES_FILE_NAME ||
    (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX))
  );
}
