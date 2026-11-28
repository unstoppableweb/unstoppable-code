import { basename, dirname, join, resolve } from 'node:path';

/**
 * Workspace instruction-file policy (`AGENTS.md` / `CLAUDE.md`): layout
 * classification, alias rules, restore and regeneration decisions. Every file
 * effect goes through an injected port so the host modules that own the files
 * stay their writers (CAN-4106).
 */

export type InstructionFileName = 'AGENTS.md' | 'CLAUDE.md';

/** Where a project's editable instructions live, and how they are paired. */
export interface InstructionFileTarget {
  filePath: string;
  exists: boolean;
  /** A direct same-folder link that must be kept while its target is edited. */
  aliasPath?: string;
  /** An equal regular copy that is written with the primary file. */
  mirrorPath?: string;
}

export interface InstructionFileEntry {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface InstructionFileReadPort {
  lstat(path: string): Promise<InstructionFileEntry>;
  readlink(path: string): Promise<string>;
  readText(path: string): Promise<string>;
  /** Rejects when the file cannot be read by the current process. */
  assertReadable(path: string): Promise<void>;
}

export interface InstructionFileWritePort {
  writeText(path: string, content: string): Promise<void>;
  /** Copies without replacing an existing destination. */
  copyFileExclusive(source: string, destination: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

export type InstructionFilePorts = InstructionFileReadPort &
  InstructionFileWritePort;

export interface InstructionAliasPort {
  lstat(path: string): Promise<InstructionFileEntry>;
  readlink(path: string): Promise<string>;
  readText(path: string): Promise<string>;
  /** Removes a file, link or directory; a missing path is not an error. */
  remove(path: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  hardLink(existingPath: string, path: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
}

/**
 * Rules for following an instruction-file symbolic link. Both are explicit
 * because callers differ (CAN-4517, CAN-4638): editing accepts a link whose
 * target is still missing, while readiness and repository policy reject it.
 */
export interface InstructionAliasRules {
  /** `reject` refuses any `..` segment, even one that resolves in-folder. */
  readonly parentSegments: 'reject' | 'allow';
  /** `allow` accepts a direct link whose target does not exist yet. */
  readonly danglingTarget: 'allow' | 'reject';
}

export const EDITABLE_INSTRUCTION_ALIAS_RULES: InstructionAliasRules = {
  parentSegments: 'reject',
  danglingTarget: 'allow',
};

export const READABLE_INSTRUCTION_ALIAS_RULES: InstructionAliasRules = {
  parentSegments: 'reject',
  danglingTarget: 'reject',
};

/** A layout the editor must not write through. Its message is user-visible. */
export class UnsupportedInstructionLayoutError extends Error {}

export function instructionFileErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function counterpartName(name: string): InstructionFileName {
  return name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
}

/** A link to `counterpart` in the link's own folder, under `rules`. */
export async function isDirectInstructionAlias(
  linkPath: string,
  counterpart: string,
  files: Pick<InstructionFileReadPort, 'readlink'>,
  rules: InstructionAliasRules,
): Promise<boolean> {
  const linkTarget = await files.readlink(linkPath);
  return (
    (rules.parentSegments === 'allow' ||
      !linkTarget.split(/[\\/]/).includes('..')) &&
    resolve(dirname(linkPath), linkTarget) === resolve(counterpart)
  );
}

/** Readiness accepts regular files and a single alias to the other root file. */
export async function isProjectInstructionFileReadable(
  dir: string,
  name: InstructionFileName,
  files: InstructionFileReadPort,
): Promise<boolean> {
  try {
    let filePath = join(dir, name);
    let entry = await files.lstat(filePath);
    if (entry.isSymbolicLink()) {
      const counterpart = join(dir, counterpartName(name));
      if (
        !(await isDirectInstructionAlias(
          filePath,
          counterpart,
          files,
          READABLE_INSTRUCTION_ALIAS_RULES,
        ))
      )
        return false;
      // A dangling target fails this lstat, so readiness rejects it.
      filePath = counterpart;
      entry = await files.lstat(filePath);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    await files.assertReadable(filePath);
    return true;
  } catch (error) {
    const code = instructionFileErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function optionalEntry(
  path: string,
  files: Pick<InstructionFileReadPort, 'lstat'>,
): Promise<InstructionFileEntry | undefined> {
  try {
    return await files.lstat(path);
  } catch (error) {
    if (instructionFileErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/** Preserve project-owned files; only follow the established in-folder alias. */
export async function resolveProjectInstructionFile(
  dir: string,
  files: InstructionFileReadPort,
  rules: InstructionAliasRules = EDITABLE_INSTRUCTION_ALIAS_RULES,
): Promise<InstructionFileTarget> {
  const agentsPath = join(dir, 'AGENTS.md');
  const claudePath = join(dir, 'CLAUDE.md');
  const [agents, claude] = await Promise.all([
    optionalEntry(agentsPath, files),
    optionalEntry(claudePath, files),
  ]);
  if (agents?.isSymbolicLink()) {
    if (
      (claude
        ? claude.isFile() && !claude.isSymbolicLink()
        : rules.danglingTarget === 'allow') &&
      (await isDirectInstructionAlias(agentsPath, claudePath, files, rules))
    ) {
      return {
        filePath: claudePath,
        exists: Boolean(claude),
        aliasPath: agentsPath,
      };
    }
    throw new UnsupportedInstructionLayoutError(
      'Cannot edit AGENTS.md through this symbolic link. Use a regular file or a link to CLAUDE.md in the same folder.',
    );
  }
  if (agents) {
    if (!agents.isFile())
      throw new UnsupportedInstructionLayoutError(
        'AGENTS.md must be a regular file.',
      );
    // Older Windows projects use equal regular copies. Preserve that pairing,
    // but never overwrite a separate Claude-specific instruction file.
    const mirrored =
      claude?.isFile() &&
      !claude.isSymbolicLink() &&
      (await files.readText(agentsPath)) === (await files.readText(claudePath));
    return {
      filePath: agentsPath,
      exists: true,
      ...(mirrored ? { mirrorPath: claudePath } : {}),
    };
  }
  if (claude) {
    if (claude.isSymbolicLink()) {
      if (
        rules.danglingTarget === 'allow' &&
        (await isDirectInstructionAlias(claudePath, agentsPath, files, rules))
      ) {
        return { filePath: agentsPath, exists: false, aliasPath: claudePath };
      }
      throw new UnsupportedInstructionLayoutError(
        'Cannot edit CLAUDE.md through this symbolic link. Use a regular instruction file.',
      );
    }
    if (!claude.isFile())
      throw new UnsupportedInstructionLayoutError(
        'CLAUDE.md must be a regular file.',
      );
    return { filePath: claudePath, exists: true };
  }
  return { filePath: agentsPath, exists: false };
}

export async function resolveOptionalProjectInstructionFile(
  dir: string,
  files: InstructionFileReadPort,
): Promise<InstructionFileTarget | undefined> {
  try {
    return await resolveProjectInstructionFile(dir, files);
  } catch (error) {
    if (error instanceof UnsupportedInstructionLayoutError) return undefined;
    throw error;
  }
}

export async function writeProjectInstructionFile(
  target: Pick<InstructionFileTarget, 'filePath' | 'mirrorPath'>,
  content: string,
  files: Pick<InstructionFileWritePort, 'writeText'>,
): Promise<void> {
  await files.writeText(target.filePath, content);
  if (target.mirrorPath) await files.writeText(target.mirrorPath, content);
}

/**
 * Restore missing guidance, retaining the source's regular files or direct
 * alias. Windows copies the alias; POSIX falls back to a copy when symbolic
 * links are not permitted. Never replaces an existing destination file.
 */
export async function restoreProjectInstructionFiles(
  source: InstructionFileTarget,
  target: InstructionFileTarget,
  platform: NodeJS.Platform,
  files: InstructionFilePorts,
): Promise<void> {
  if (!source.exists || target.exists) return;
  const targetDir = dirname(target.filePath);
  const primaryName = basename(source.filePath);
  const destination = target.aliasPath
    ? target.filePath
    : join(targetDir, primaryName);
  await files.copyFileExclusive(source.filePath, destination);
  // A known broken destination alias defines its own layout. Fill its target
  // without replacing that alias or creating a cycle from the source layout.
  if (target.aliasPath) return;

  const counterpart = join(
    dirname(source.filePath),
    counterpartName(primaryName),
  );
  const entry = await optionalEntry(counterpart, files);
  if (!entry) return;
  const counterpartDestination = join(targetDir, counterpartName(primaryName));
  if (entry.isFile() && !entry.isSymbolicLink()) {
    // This includes equal compatibility copies and independent Claude guidance.
    await files.copyFileExclusive(counterpart, counterpartDestination);
  } else if (
    entry.isSymbolicLink() &&
    (await isDirectInstructionAlias(
      counterpart,
      source.filePath,
      files,
      EDITABLE_INSTRUCTION_ALIAS_RULES,
    ))
  ) {
    if (platform !== 'win32') {
      try {
        await files.symlink(primaryName, counterpartDestination);
        return;
      } catch (error) {
        const code = instructionFileErrorCode(error);
        if (code !== 'EPERM' && code !== 'EACCES') throw error;
      }
    }
    await files.copyFileExclusive(destination, counterpartDestination);
  }
}

function symlinkTargetsMatch(
  linkPath: string,
  existingTarget: string,
  expectedTarget: string,
): boolean {
  if (existingTarget === expectedTarget) return true;
  const linkDir = dirname(linkPath);
  return resolve(linkDir, existingTarget) === resolve(linkDir, expectedTarget);
}

/** Point `linkPath` at `targetPath`, replacing any other entry there. */
export async function ensureRelativeSymlink(
  linkPath: string,
  targetPath: string,
  alias: InstructionAliasPort,
): Promise<void> {
  try {
    const existing = await alias.lstat(linkPath);
    if (existing.isSymbolicLink()) {
      const existingTarget = await alias.readlink(linkPath);
      if (symlinkTargetsMatch(linkPath, existingTarget, targetPath)) return;
    }
    await alias.remove(linkPath);
  } catch (error) {
    if (instructionFileErrorCode(error) !== 'ENOENT') throw error;
  }

  try {
    await alias.symlink(targetPath, linkPath);
  } catch (error) {
    if (instructionFileErrorCode(error) !== 'EEXIST') throw error;
    // A concurrent creator may have won; accept only the same link.
    const existing = await alias.lstat(linkPath);
    if (!existing.isSymbolicLink()) throw error;
    const existingTarget = await alias.readlink(linkPath);
    if (!symlinkTargetsMatch(linkPath, existingTarget, targetPath)) throw error;
  }
}

async function replaceWithHardLinkOrCopy(
  linkPath: string,
  targetPath: string,
  alias: InstructionAliasPort,
): Promise<void> {
  const resolvedTargetPath = resolve(dirname(linkPath), targetPath);
  await alias.remove(linkPath);
  try {
    await alias.hardLink(resolvedTargetPath, linkPath);
  } catch {
    await alias.copyFile(resolvedTargetPath, linkPath);
  }
}

/**
 * Windows never symlinks: it hard links, then copies. POSIX symlinks and,
 * when the caller allows it, falls back to the same hard link or copy after
 * EPERM/EACCES.
 */
export async function ensureRelativeAlias(
  linkPath: string,
  targetPath: string,
  options: {
    readonly platform: NodeJS.Platform;
    readonly posixPermissionFallback: boolean;
  },
  alias: InstructionAliasPort,
): Promise<void> {
  if (options.platform === 'win32') {
    await replaceWithHardLinkOrCopy(linkPath, targetPath, alias);
    return;
  }
  if (!options.posixPermissionFallback) {
    await ensureRelativeSymlink(linkPath, targetPath, alias);
    return;
  }
  try {
    await ensureRelativeSymlink(linkPath, targetPath, alias);
  } catch (error) {
    const code = instructionFileErrorCode(error);
    if (code !== 'EPERM' && code !== 'EACCES') throw error;
    await replaceWithHardLinkOrCopy(linkPath, targetPath, alias);
  }
}

/** An exclusive copy failed after it may have created or written its destination. */
export class InstructionCounterpartCopyError extends Error {
  readonly copyError: unknown;

  constructor(cause: unknown) {
    super('The instruction counterpart could not be fully copied.');
    this.name = 'InstructionCounterpartCopyError';
    this.copyError = cause;
  }
}

/** Add a counterpart without ever removing or replacing an occupied entry. */
export async function createRelativeAliasExclusive(
  linkPath: string,
  targetPath: string,
  platform: NodeJS.Platform,
  files: Pick<InstructionAliasPort, 'symlink' | 'hardLink'> &
    Pick<InstructionFileWritePort, 'copyFileExclusive'>,
  options: { allowWindowsCompatibilityFallback?: boolean } = {},
): Promise<'symlink' | 'hard-link' | 'copy'> {
  if (platform !== 'win32') {
    await files.symlink(targetPath, linkPath);
    return 'symlink';
  }
  const source = resolve(dirname(linkPath), targetPath);
  try {
    await files.hardLink(source, linkPath);
    return 'hard-link';
  } catch (error) {
    // Unsupported links and cross-volume links can be represented by a copy.
    // Managed homes retain the legacy fallback for permission errors and
    // filesystems that report EISDIR when a hard link is unsupported.
    // I/O and occupied-destination errors must remain failures.
    const code = instructionFileErrorCode(error);
    const compatibilityFallback =
      options.allowWindowsCompatibilityFallback &&
      (code === 'EPERM' || code === 'EACCES' || code === 'EISDIR');
    if (
      !compatibilityFallback &&
      !['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code ?? '')
    )
      throw error;
    try {
      await files.copyFileExclusive(source, linkPath);
      return 'copy';
    } catch (copyError) {
      // EEXIST guarantees the exclusive copy left the occupied entry alone.
      // Other failures may occur after creation; never remove it to roll back.
      if (instructionFileErrorCode(copyError) === 'EEXIST') throw copyError;
      throw new InstructionCounterpartCopyError(copyError);
    }
  }
}

/** A matching link, or a regular copy with the target's exact content. */
export async function hasExpectedRelativeAlias(
  linkPath: string,
  targetPath: string,
  alias: Pick<InstructionAliasPort, 'lstat' | 'readlink' | 'readText'>,
): Promise<boolean> {
  try {
    const existing = await alias.lstat(linkPath);
    if (existing.isSymbolicLink()) {
      const existingTarget = await alias.readlink(linkPath);
      return symlinkTargetsMatch(linkPath, existingTarget, targetPath);
    }
    const resolvedTargetPath = resolve(dirname(linkPath), targetPath);
    const [linkContent, targetContent] = await Promise.all([
      alias.readText(linkPath),
      alias.readText(resolvedTargetPath),
    ]);
    return linkContent === targetContent;
  } catch {
    return false;
  }
}

export interface MultiRepoGuidanceHeadings {
  readonly current: string;
  /** Heading of older builds; recognized so a second block is never added. */
  readonly legacy: string;
}

/**
 * Replace the generated guidance block (current or legacy heading) at the end
 * of existing instructions with the current default, or append it when
 * absent. Everything before the heading is preserved verbatim.
 */
export function mergeMultiRepoGuidance(
  existingContent: string,
  defaultContent: string,
  headings: MultiRepoGuidanceHeadings,
): string {
  const currentIndex = existingContent.indexOf(headings.current);
  const headingIndex =
    currentIndex === -1
      ? existingContent.indexOf(headings.legacy)
      : currentIndex;
  const guidanceBlock = `${headings.current}\n\n${defaultContent.trim()}\n`;

  if (headingIndex === -1) {
    const trimmed = existingContent.trimEnd();
    return trimmed.length === 0
      ? `${guidanceBlock}\n`
      : `${trimmed}\n\n${guidanceBlock}\n`;
  }

  const before = existingContent.slice(0, headingIndex).trimEnd();
  return before.length === 0
    ? `${guidanceBlock}\n`
    : `${before}\n\n${guidanceBlock}\n`;
}
