import { getSkillFilePathValidationError } from '../skill-name';
import type { SkillEditableFile } from '../types/skills';

/** A supporting file an agent writes into a custom skill (CAN-7498). */
export interface CustomSkillActionFile {
  /** Skill-relative POSIX path, such as `references/api.md`. */
  path: string;
  /** The file's full text content. */
  content: string;
}

export type CustomSkillActionFileSet =
  | { files: SkillEditableFile[] }
  | { error: string };

const MAIN_SKILL_FILE = 'skill.md';

/** The files a create sends: each written in full. */
export function customSkillCreateFiles(
  files: readonly CustomSkillActionFile[],
): SkillEditableFile[] {
  return files.map((file) => ({ path: file.path, content: file.content }));
}

/**
 * The full supporting-file set a custom skill save takes after an agent's
 * update: every existing file kept as it is, the given files added or
 * replaced, and the removed paths left out. Paths compare case-insensitively,
 * as the skill service compares them; the save still checks every path and
 * limit, the same as an edit in the Skills editor.
 */
export function mergeCustomSkillActionFiles(input: {
  /** The skill's listed files; `SKILL.md` is ignored. */
  existingFiles: readonly string[];
  /** True when the listing stopped early, so the set can't be known. */
  truncated: boolean;
  files?: readonly CustomSkillActionFile[];
  removeFiles?: readonly string[];
}): CustomSkillActionFileSet {
  if (input.truncated)
    return {
      error:
        'This skill has too many files to change this way. Edit its files in the Skills editor.',
    };
  const existing = new Map<string, string>();
  for (const filePath of input.existingFiles) {
    const key = filePath.toLowerCase();
    if (key === MAIN_SKILL_FILE) continue;
    // Each kept file goes back to the save under its listed path, which the
    // save trims and checks; a path it would change or refuse can't be kept
    // as it is, and would be deleted.
    const pathError = getSkillFilePathValidationError(filePath);
    if (pathError)
      return {
        error: `"${filePath}" can't be kept by a file change: ${pathError} Rename it first.`,
      };
    existing.set(key, filePath);
  }
  const writes = new Map<string, SkillEditableFile>();
  for (const file of input.files ?? []) {
    const filePath = file.path.trim();
    const key = filePath.toLowerCase();
    if (writes.has(key)) return { error: `Duplicate file path "${filePath}".` };
    writes.set(key, { path: filePath, content: file.content });
  }
  const removals = new Set<string>();
  for (const rawPath of input.removeFiles ?? []) {
    const filePath = rawPath.trim();
    const key = filePath.toLowerCase();
    if (key === MAIN_SKILL_FILE)
      return {
        error: 'SKILL.md is the main skill file and cannot be removed.',
      };
    if (writes.has(key))
      return {
        error: `"${filePath}" is in both files and removeFiles. Send it in one of them.`,
      };
    if (!existing.has(key)) return { error: `File "${filePath}" not found.` };
    removals.add(key);
  }
  const files: SkillEditableFile[] = [];
  existing.forEach((filePath, key) => {
    if (!removals.has(key) && !writes.has(key)) files.push({ path: filePath });
  });
  writes.forEach((file) => {
    files.push(file);
  });
  return { files };
}
