import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import * as path from 'node:path';
import {
  inspectClaudePluginHooks,
  parseClaudeJsonFile,
} from './claude-mod-admission';

export interface ClaudePluginProjectionOptions {
  sourcePluginPath: string;
  projectionRootDir: string;
  removeMcpServers?: boolean;
  removeModules?: boolean;
}

interface ProjectionSnapshotEntry {
  relativePath: string;
  absolutePath: string;
  kind: 'directory' | 'file';
  stat: BigIntStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function collectSnapshot(root: string): ProjectionSnapshotEntry[] | null {
  const entries: ProjectionSnapshotEntry[] = [];
  const visit = (directory: string, relativeDirectory: string): boolean => {
    let names: string[];
    try {
      names = readdirSync(directory).sort(compareBytewise);
    } catch {
      return false;
    }
    for (const name of names) {
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      let stat: BigIntStats;
      try {
        stat = lstatSync(absolutePath, { bigint: true });
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        entries.push({ relativePath, absolutePath, kind: 'directory', stat });
        if (!visit(absolutePath, relativePath)) return false;
      } else if (stat.isFile()) {
        entries.push({ relativePath, absolutePath, kind: 'file', stat });
      } else {
        return false;
      }
    }
    return true;
  };

  try {
    const rootStat = lstatSync(root, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    if (!visit(root, '')) return null;
    return entries.sort((left, right) =>
      compareBytewise(left.relativePath, right.relativePath),
    );
  } catch {
    return null;
  }
}

function sameSnapshot(
  before: readonly ProjectionSnapshotEntry[],
  after: readonly ProjectionSnapshotEntry[],
): boolean {
  return (
    before.length === after.length &&
    before.every((entry, index) => {
      const current = after[index];
      return (
        current !== undefined &&
        entry.relativePath === current.relativePath &&
        entry.kind === current.kind &&
        sameStat(entry.stat, current.stat)
      );
    })
  );
}

function sameTreeShape(
  source: readonly ProjectionSnapshotEntry[],
  projected: readonly ProjectionSnapshotEntry[],
): boolean {
  return (
    source.length === projected.length &&
    source.every((entry, index) => {
      const copy = projected[index];
      return (
        copy !== undefined &&
        entry.relativePath === copy.relativePath &&
        entry.kind === copy.kind
      );
    })
  );
}

function safeSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length === 0 || normalized === '.' || normalized === '..'
    ? 'plugin'
    : normalized;
}

/**
 * A key for one source tree state and set of removals. Any write to the source
 * changes a ctime, so a changed plugin gets a new projection, and launches of
 * an unchanged plugin reuse one copy instead of adding a copy per launch.
 */
function projectionKey(
  sourceRoot: string,
  snapshot: readonly ProjectionSnapshotEntry[],
  options: ClaudePluginProjectionOptions,
): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify([
      sourceRoot,
      options.removeModules === true,
      options.removeMcpServers === true,
    ]),
  );
  for (const entry of snapshot) {
    hash.update(
      `\0${entry.relativePath}\0${entry.kind}\0${entry.stat.ino}\0${entry.stat.size}\0${entry.stat.mtimeNs}\0${entry.stat.ctimeNs}`,
    );
  }
  return hash.digest('hex').slice(0, 24);
}

/** Re-check a projection before every use: it lives in a writable data folder. */
function isValidProjection(
  projectedRoot: string,
  options: ClaudePluginProjectionOptions,
): boolean {
  if (!existsSync(projectedRoot)) return false;
  const inspection = inspectClaudePluginHooks(projectedRoot);
  if (!inspection.success) return false;
  if (options.removeModules === true && inspection.hasMods) return false;
  if (
    options.removeMcpServers === true &&
    ((inspection.manifest !== null && 'mcpServers' in inspection.manifest) ||
      existsSync(path.join(projectedRoot, '.mcp.json')))
  ) {
    return false;
  }
  return true;
}

function cleanProjection(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // The caller still fails closed if cleanup itself cannot complete.
  }
}

function prepareProjectionRoot(
  requestedRoot: string,
  sourceRoot: string,
): string | null {
  let existingAncestor = requestedRoot;
  const missingSegments: string[] = [];
  while (true) {
    try {
      lstatSync(existingAncestor);
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') return null;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return null;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  try {
    const canonicalAncestor = realpathSync(existingAncestor);
    const canonicalTarget = path.resolve(canonicalAncestor, ...missingSegments);
    if (
      canonicalTarget === sourceRoot ||
      isPathInside(sourceRoot, canonicalTarget)
    ) {
      return null;
    }
    mkdirSync(canonicalTarget, { recursive: true });
    const canonicalRoot = realpathSync(canonicalTarget);
    return canonicalRoot === sourceRoot ||
      isPathInside(sourceRoot, canonicalRoot)
      ? null
      : canonicalRoot;
  } catch {
    return null;
  }
}

function parseJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = parseClaudeJsonFile(readFileSync(filePath));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripTopLevelKey(filePath: string, keyToRemove: string): boolean {
  const parsed = parseJsonObject(filePath);
  if (!parsed) return false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== keyToRemove) next[key] = value;
  }
  // A write failure propagates, so the launch can report its errno.
  writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return true;
}

function manifestMcpReferences(
  manifest: Record<string, unknown> | null,
): string[] | null {
  const value = manifest?.mcpServers;
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === 'string')
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : null;
  }
  if (isRecord(value)) return [];
  return null;
}

function removeMcpFiles(
  sourceRoot: string,
  projectedRoot: string,
  manifest: Record<string, unknown> | null,
): boolean {
  const references = manifestMcpReferences(manifest);
  if (!references) return false;
  const removePaths = new Set(['.mcp.json']);
  for (const reference of references) {
    const sourcePath = path.resolve(sourceRoot, reference);
    if (!isPathInside(sourceRoot, sourcePath)) return false;
    removePaths.add(path.relative(sourceRoot, sourcePath));
  }
  for (const relativePath of removePaths) {
    const destinationPath = path.resolve(projectedRoot, relativePath);
    if (!isPathInside(projectedRoot, destinationPath)) return false;
    rmSync(destinationPath, { recursive: true, force: true });
  }
  if (manifest) {
    const manifestPath = path.join(
      projectedRoot,
      '.claude-plugin',
      'plugin.json',
    );
    if (!stripTopLevelKey(manifestPath, 'mcpServers')) return false;
  }
  return true;
}

function removeModDeclarations(
  sourceRoot: string,
  projectedRoot: string,
  hooksFiles: readonly string[],
): boolean {
  for (const hooksFile of hooksFiles) {
    const relativePath = path.relative(sourceRoot, hooksFile);
    if (!isPathInside(sourceRoot, hooksFile)) return false;
    const projectedPath = path.resolve(projectedRoot, relativePath);
    if (!isPathInside(projectedRoot, projectedPath)) return false;
    if (!stripTopLevelKey(projectedPath, 'modules')) return false;
  }
  return true;
}

/**
 * Return a plugin copy with only the requested top-level capabilities removed,
 * reusing the copy made for the same source state. A failed copy or validation
 * is deleted and never returns the installed source path. A failure carries
 * the file-system or unexpected error behind it, for the host's error report;
 * a refused source or copy has none. The error can name paths: never put it in
 * a result that leaves the process.
 */
export function projectClaudePluginForLaunch(
  options: ClaudePluginProjectionOptions,
): { ok: true; path: string } | { ok: false; error?: unknown } {
  let temporaryDirectory: string | undefined;
  try {
    const inspection = inspectClaudePluginHooks(options.sourcePluginPath);
    if (!inspection.success) return { ok: false };
    const sourceRoot = inspection.pluginRoot;
    const before = collectSnapshot(sourceRoot);
    if (!before) return { ok: false };

    const requestedProjectionRoot = path.resolve(options.projectionRootDir);
    if (
      requestedProjectionRoot === sourceRoot ||
      isPathInside(sourceRoot, requestedProjectionRoot)
    ) {
      return { ok: false };
    }
    const projectionRoot = prepareProjectionRoot(
      requestedProjectionRoot,
      sourceRoot,
    );
    if (!projectionRoot) return { ok: false };
    const baseName = path.basename(sourceRoot) || 'plugin';
    const finalParent = path.join(
      projectionRoot,
      `${safeSegment(baseName)}-${projectionKey(sourceRoot, before, options)}`,
    );
    const finalRoot = path.join(finalParent, baseName);
    if (isValidProjection(finalRoot, options)) {
      return { ok: true, path: finalRoot };
    }
    temporaryDirectory = mkdtempSync(
      path.join(projectionRoot, 'claude-mod-projection-'),
    );
    const projectedRoot = path.join(temporaryDirectory, baseName);
    cpSync(sourceRoot, projectedRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
    });

    const after = collectSnapshot(sourceRoot);
    const projectedSnapshot = collectSnapshot(projectedRoot);
    if (
      !after ||
      !projectedSnapshot ||
      !sameSnapshot(before, after) ||
      !sameTreeShape(before, projectedSnapshot)
    ) {
      cleanProjection(temporaryDirectory);
      return { ok: false };
    }

    if (
      options.removeModules === true &&
      !removeModDeclarations(sourceRoot, projectedRoot, inspection.hooksFiles)
    ) {
      cleanProjection(temporaryDirectory);
      return { ok: false };
    }
    if (
      options.removeMcpServers === true &&
      !removeMcpFiles(sourceRoot, projectedRoot, inspection.manifest)
    ) {
      cleanProjection(temporaryDirectory);
      return { ok: false };
    }

    if (!isValidProjection(projectedRoot, options)) {
      cleanProjection(temporaryDirectory);
      return { ok: false };
    }
    // An invalid copy at the final path is replaced; a valid one written by a
    // concurrent launch wins and this launch's copy is dropped.
    if (existsSync(finalParent) && !isValidProjection(finalRoot, options)) {
      cleanProjection(finalParent);
    }
    try {
      renameSync(temporaryDirectory, finalParent);
    } catch (error) {
      cleanProjection(temporaryDirectory);
      return isValidProjection(finalRoot, options)
        ? { ok: true, path: finalRoot }
        : { ok: false, error };
    }
    temporaryDirectory = undefined;
    return isValidProjection(finalRoot, options)
      ? { ok: true, path: finalRoot }
      : { ok: false };
  } catch (error) {
    if (temporaryDirectory) {
      cleanProjection(temporaryDirectory);
    }
    return { ok: false, error };
  }
}
