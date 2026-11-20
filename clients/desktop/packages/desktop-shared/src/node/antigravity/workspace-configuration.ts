import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * Antigravity 1.5.1 discovers workspace customizations in these folders in the
 * working directory and in each ancestor up to the nearest Git root (only the
 * working directory without one). It walks from both its process and session
 * working directories, so callers launch with one directory for both. No
 * launch flag disables that discovery; it still runs, but the Canopy agent
 * every launch selects (ANTIGRAVITY_AGENT_DEFINITION in runtime.ts) does not
 * inherit what it finds. Re-probe on a runtime version change.
 */
const CUSTOMIZATION_DIRECTORIES = ['.agents', '.agent', '_agents', '_agent'];

/**
 * Entries whose content the runtime executes or that can carry executable
 * content: hook commands and MCP servers start without a host approval, plugins
 * bundle both, and custom agents can drop the host approval hook. Rules,
 * skills, workflows and their manifests are passive, repository-governed
 * context; skill bodies still need an approved read.
 */
const EXECUTABLE_FILES = [
  'hooks.json',
  'mcp_config.json',
  'plugins.json',
  'agents.json',
];
const EXECUTABLE_FOLDERS = ['plugins', 'agents'];
// Placeholder files that never define a plugin or agent.
const IGNORED_FOLDER_ENTRIES = ['.ds_store', '.gitkeep', '.keep'];

class AntigravityWorkspaceConfigurationError extends Error {
  readonly code = 'ANTIGRAVITY_WORKSPACE_CONFIGURATION';

  constructor(
    message: string,
    readonly paths: readonly string[],
    // The underlying filesystem error, kept for diagnosis.
    readonly fsError?: unknown,
  ) {
    super(message);
    this.name = 'AntigravityWorkspaceConfigurationError';
  }
}

/**
 * Whether the launch preflight refused this workspace. The message lists only
 * paths relative to the discovery root and is safe to show; `fsError` can
 * carry an absolute host path and stays private. The check is by class, so it
 * assumes callers share this module instance, as the desktop main bundle does;
 * a duplicated bundle would see no match and fail closed as a generic error.
 */
export function isAntigravityWorkspaceConfigurationError(
  error: unknown,
): error is Error {
  return error instanceof AntigravityWorkspaceConfigurationError;
}

function errorCode(error: unknown): string | undefined {
  // Structural: filesystem errors can come from another realm.
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

interface DiscoveryDirectory {
  directory: string;
  /** The Git root (or start) the directory's paths are reported from. */
  root: string;
}

async function discoveryChain(start: string): Promise<DiscoveryDirectory[]> {
  const chain: string[] = [];
  for (let directory = start; ; directory = dirname(directory)) {
    chain.push(directory);
    if (await exists(join(directory, '.git')))
      return chain.map((entry) => ({ directory: entry, root: directory }));
    if (dirname(directory) === directory)
      return [{ directory: start, root: start }];
  }
}

/**
 * Directories the runtime searches, from the working directory up. The
 * process working directory is the physical path, so a symlinked cwd is
 * walked both as given and resolved.
 */
async function discoveryDirectories(
  cwd: string,
): Promise<DiscoveryDirectory[]> {
  const seen = new Map<string, DiscoveryDirectory>();
  for (const start of [cwd, await realpath(cwd)])
    for (const entry of await discoveryChain(start))
      if (!seen.has(entry.directory)) seen.set(entry.directory, entry);
  return [...seen.values()];
}

async function executableEntries(folder: string): Promise<string[]> {
  const present = await Promise.all(
    EXECUTABLE_FILES.map((name) => exists(join(folder, name))),
  );
  const found = EXECUTABLE_FILES.filter((_name, index) => present[index]);
  for (const name of EXECUTABLE_FOLDERS) {
    try {
      // Only a regular file with a placeholder name is ignored; a folder or
      // link with that name may still be a plugin or agent.
      const entries = await readdir(join(folder, name), {
        withFileTypes: true,
      });
      if (
        entries.some(
          (entry) =>
            !entry.isFile() ||
            !IGNORED_FOLDER_ENTRIES.includes(entry.name.toLowerCase()),
        )
      )
        found.push(name);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return found;
}

/** Workspace-relative paths of executable configuration the runtime would load. */
async function findAntigravityExecutableWorkspaceConfiguration(
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const found: string[] = [];
  let directories: DiscoveryDirectory[];
  try {
    directories = await discoveryDirectories(cwd);
  } catch (error) {
    // Reaching cwd already requires search access to every ancestor, so a
    // failed Git-root probe means the path itself is broken: fail closed.
    throw new AntigravityWorkspaceConfigurationError(
      "Google chats couldn't check this workspace for Antigravity hooks or MCP servers. Make it readable, then try again.",
      [],
      error,
    );
  }
  // Paths are reported from each chain's discovery root (Git root, or cwd).
  for (const { directory, root } of directories) {
    for (const name of CUSTOMIZATION_DIRECTORIES) {
      signal?.throwIfAborted();
      const folder = join(directory, name);
      try {
        // A dot-dir symlink is followed, as the runtime follows it.
        for (const entry of await executableEntries(folder))
          found.push(relative(root, join(folder, entry)));
      } catch (error) {
        if (isMissing(error)) continue;
        throw new AntigravityWorkspaceConfigurationError(
          `Google chats couldn't check ${relative(root, folder)} for Antigravity hooks or MCP servers. Make it readable, then try again.`,
          [relative(root, folder)],
          error,
        );
      }
    }
  }
  // A symlinked cwd reports the same relative paths from both chains.
  return [...new Set(found)];
}

/**
 * Fails closed before a native launch: the pinned runtime would run these
 * hooks and MCP servers without a host approval (CAP-02, SAFE-09).
 */
export async function assertAntigravityWorkspaceConfigurationIsolated(
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const found = await findAntigravityExecutableWorkspaceConfiguration(
    cwd,
    signal,
  );
  if (found.length === 0) return;
  const listed = found
    .slice(0, 5)
    .map((path) => path.split(sep).join('/'))
    .join(', ');
  throw new AntigravityWorkspaceConfigurationError(
    `This workspace has Antigravity hooks, MCP servers, plugins or custom agents that would run without your approval: ${listed}${found.length > 5 ? ', …' : ''}. Remove them or use another chat model.`,
    found,
  );
}

/**
 * Win32 drops trailing dots and spaces and addresses `name:stream` as `name`.
 * Applied on every platform: it can only widen the denied set.
 */
function normalizedSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/:.*$/, '')
    .replace(/[. ]+$/, '');
}

/**
 * Matches a discovery folder name followed by an executable name anywhere in
 * the path, not only within the current discovery chain. The breadth is
 * deliberate: it also covers writes that would create a new discovery root.
 */
function isExecutableConfigurationSegments(segments: string[]): boolean {
  const lower = segments.map(normalizedSegment);
  return lower.some(
    (segment, index) =>
      CUSTOMIZATION_DIRECTORIES.includes(segment) &&
      index + 1 < lower.length &&
      (EXECUTABLE_FILES.includes(lower[index + 1]) ||
        EXECUTABLE_FOLDERS.includes(lower[index + 1])),
  );
}

const MAX_LINK_HOPS = 16;

/** Realpath of the nearest existing ancestor plus the missing tail, if resolvable. */
async function resolveExisting(path: string): Promise<string | undefined> {
  const pending: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...pending.reverse());
    } catch (error) {
      if (!isMissing(error) || dirname(current) === current) return undefined;
      pending.push(basename(current));
    }
  }
}

/** The target of a dangling symlink at `path`, null when it is not a link. */
async function danglingLinkTarget(
  path: string,
): Promise<string | null | undefined> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return null;
    const link = await readlink(path);
    return isAbsolute(link) ? link : join(dirname(path), link);
  } catch (error) {
    return isMissing(error) ? null : undefined;
  }
}

/**
 * Every path a write to `path` could reach: the nearest existing ancestor is
 * resolved, and a dangling leaf symlink is followed. Undefined when the path
 * can't be resolved, which callers treat as protected.
 */
async function writeTargets(path: string): Promise<string[] | undefined> {
  const targets = [path];
  let leaf = path;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    const resolved = await resolveExisting(leaf);
    if (resolved === undefined) return undefined;
    targets.push(resolved);
    const next = await danglingLinkTarget(resolved);
    if (next === null) return targets;
    if (next === undefined) return undefined;
    targets.push(next);
    leaf = next;
  }
  return undefined;
}

/** Resolved targets of the workspace's discovery folders; undefined if unknown. */
async function resolvedDiscoveryFolders(
  cwd: string,
): Promise<string[] | undefined> {
  const folders: string[] = [];
  try {
    for (const { directory } of await discoveryDirectories(cwd))
      for (const name of CUSTOMIZATION_DIRECTORIES) {
        try {
          folders.push(await realpath(join(directory, name)));
        } catch (error) {
          if (!isMissing(error)) return undefined;
        }
      }
  } catch {
    return undefined;
  }
  return folders;
}

function isUnderDiscoveryFolder(folders: string[], target: string): boolean {
  return folders.some((folder) => {
    const rest = relative(folder, target);
    if (
      !rest ||
      rest === '..' ||
      rest.startsWith(`..${sep}`) ||
      isAbsolute(rest)
    )
      return false;
    const next = normalizedSegment(rest.split(/[\\/]+/)[0]);
    return EXECUTABLE_FILES.includes(next) || EXECUTABLE_FOLDERS.includes(next);
  });
}

/**
 * True when a native write would create or change executable workspace
 * configuration. Matched case-insensitively and after resolving symlinks.
 */
async function isAntigravityExecutableConfigurationPath(
  path: string,
  cwd: string,
): Promise<boolean> {
  // Concatenate rather than join so `..` resolves through the filesystem.
  const targets = await writeTargets(
    isAbsolute(path) ? path : `${cwd}${sep}${path}`,
  );
  if (targets === undefined) return true;
  if (
    targets.some((target) =>
      isExecutableConfigurationSegments(target.split(/[\\/]+/)),
    )
  )
    return true;
  // A discovery folder may be a symlink to a folder with another name.
  const folders = await resolvedDiscoveryFolders(cwd);
  return (
    folders === undefined ||
    targets.some((target) => isUnderDiscoveryFolder(folders, target))
  );
}

/**
 * Hooks and MCP servers written here would run without a host approval. Only
 * `write_file` maps to `Write` today and unmapped native tools are denied; any
 * future native edit mapping must pass through this check too.
 */
export async function writesAntigravityExecutableConfiguration(
  operation: { tool: string; input: Record<string, unknown> },
  cwd: string,
): Promise<boolean> {
  const path = operation.input.file_path;
  if (operation.tool !== 'Write' || typeof path !== 'string') return false;
  return await isAntigravityExecutableConfigurationPath(path, cwd);
}

/**
 * Refuses native Write paths into this process's private profile before an
 * outside-workspace approval. This path guard does not contain approved shells,
 * hardlink aliases or filesystem races; the security hold remains in force.
 */
export async function writesAntigravityProfile(
  operation: { tool: string; input: Record<string, unknown> },
  cwd: string,
  profile: string,
): Promise<boolean> {
  const path = operation.input.file_path;
  if (operation.tool !== 'Write' || typeof path !== 'string') return false;
  const targets = await writeTargets(
    isAbsolute(path) ? path : `${cwd}${sep}${path}`,
  );
  const profileTargets = await writeTargets(profile);
  if (targets === undefined || profileTargets === undefined) return true;
  return targets.some((target) =>
    profileTargets.some((root) => {
      // macOS profiles may live on a case-insensitive volume. Widen the guard
      // on case-sensitive volumes rather than allowing a spelling alias.
      const rest = relative(root.toLowerCase(), target.toLowerCase());
      return (
        rest === '' ||
        (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
      );
    }),
  );
}
