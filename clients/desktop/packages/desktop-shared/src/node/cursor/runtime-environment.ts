import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  isStepStartupInjectionName,
  stepEnvironmentNameLabel,
} from '../provider-process/step-environment';

function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return false;
  const { code }: { code?: unknown } = error;
  return code === 'EEXIST';
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** Fail closed rather than bypass machine-admin hooks outside our private HOME. */
async function rejectSystemHooks(platform: NodeJS.Platform): Promise<void> {
  const file =
    platform === 'darwin'
      ? '/Library/Application Support/Cursor/hooks.json'
      : platform === 'win32'
        ? join(
            // ProgramData is not always on C:, and a redirected root would
            // make this fail-closed check silently pass on a missing path.
            process.env.ProgramData ?? 'C:\\ProgramData',
            'Cursor',
            'hooks.json',
          )
        : '/etc/cursor/hooks.json';
  try {
    await lstat(file);
  } catch (error) {
    if (missing(error)) return;
  }
  throw new Error(
    'Cursor setup is unavailable while system-wide Cursor hooks are configured or cannot be checked.',
  );
}

async function privateDirectory(directory: string): Promise<void> {
  try {
    const existing = await lstat(directory);
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error('Cursor private environment is invalid.');
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    // Two pipeline steps running in parallel can both pass the lstat check and
    // then race here. `EEXIST` means the other one won, which is fine — the
    // checks below still have to pass, so the symlink/owner/mode guarantees are
    // not weakened. Anything else is a real failure. `recursive: true` is
    // deliberately NOT used: it would also silence a pre-existing path that the
    // checks are meant to reject.
    if (!isAlreadyExists(error)) throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Cursor private environment is invalid.');
}

/**
 * The vendor invokes /usr/bin/security, whose default search path follows
 * HOME. This narrow bridge preserves native Keychain sign-in/refresh; it does
 * not copy credentials or expose ~/.cursor or ~/.claude to discovery.
 */
async function bridgeKeychains(home: string): Promise<void> {
  const target = await realpath(join(homedir(), 'Library', 'Keychains'));
  const library = join(home, 'Library');
  await privateDirectory(library);
  await privateSymlink(
    target,
    join(library, 'Keychains'),
    'Cursor credential storage link is invalid.',
  );
}

/** Creates `link` → `target`, accepting an identical existing link. */
async function privateSymlink(
  target: string,
  link: string,
  invalidMessage: string,
): Promise<void> {
  try {
    // Directory links need an explicit type on Windows, where a plain file
    // symlink to a directory is created but does not traverse; a junction
    // also needs no privilege there. Other platforms ignore the type.
    await symlink(
      target,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    let existing: string;
    try {
      existing = await readlink(link);
    } catch {
      throw new Error(invalidMessage);
    }
    if (existing === target) return;
    // The link text can name the same directory another way — a Windows
    // junction reads back with a `\\?\` prefix, a tmp dir by its realpath —
    // so compare what the two resolve to before calling the link invalid.
    let same = false;
    try {
      same = (await realpath(link)) === (await realpath(target));
    } catch {
      same = false;
    }
    if (!same) throw new Error(invalidMessage);
  }
}

/** Only macOS credential storage is shared; no user hooks/configuration folders. */
async function preparePrivateHome(
  root: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const home = join(root, 'home');
  await privateDirectory(home);
  if (platform === 'darwin') await bridgeKeychains(home);
  return home;
}

/**
 * A per-chat HOME layered over the shared private home. The CLI discovers
 * user skills and commands under `~/.cursor`, so giving every chat its own
 * HOME is what keeps one chat's selection out of another's session. Sign-in
 * and caches stay shared through the Keychain bridge and the environment
 * variables the caller keeps pointed at the shared home. The vendor's
 * built-in skills (`~/.cursor/skills-cursor`) are linked from the shared
 * home when the CLI has already extracted them there — that happens on its
 * first run, so the very first chat on a fresh install runs without the link
 * and the CLI extracts its own copy into the overlay; every overlay prepared
 * afterwards links the shared copy instead.
 */
async function prepareHomeOverlay(
  overlay: string,
  sharedHome: string,
  platform: NodeJS.Platform,
): Promise<void> {
  await mkdir(dirname(overlay), { recursive: true, mode: 0o700 });
  await privateDirectory(overlay);
  if (platform === 'darwin') await bridgeKeychains(overlay);
  const cursorDir = join(overlay, '.cursor');
  await privateDirectory(cursorDir);
  const builtins = join(sharedHome, '.cursor', 'skills-cursor');
  let hasBuiltins = false;
  try {
    hasBuiltins = (await lstat(builtins)).isDirectory();
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (hasBuiltins)
    await privateSymlink(
      builtins,
      join(cursorDir, 'skills-cursor'),
      'Cursor built-in skills link is invalid.',
    );
}

/** Cursor-managed sign-in is shared; global hooks and runtime configuration are private. */
/**
 * Environment variable names this runtime refuses to pass to the vendor
 * process, regardless of who asked. The list is isolation and anti-injection,
 * not an oversight: `NODE_OPTIONS`/`NODE_PATH`/`BASH_ENV`/`ENV` are code
 * injection vectors, `GIT_CONFIG_*` rewrites git behaviour under the agent, and
 * the GitHub token names are withheld from a vendor process on purpose.
 *
 * It stays refused. What was missing is that a PIPELINE can declare these in
 * its `secrets:`/`env:` block, and they were then dropped in silence — the same
 * step behaved differently on Cursor than on Claude or Codex with nothing said.
 * `withheldCursorEnvironmentNames` lets the caller say so. Both it and
 * `prepareCursorRuntimeEnvironment` decide through `refusesCursorEnvironmentName`
 * so the report cannot drift from what is actually removed, including the
 * platform-dependent names below.
 */
// `readonly string[]`, not `as const`: the literal union is used nowhere, and
// having it forced every membership test to cast an arbitrary env name into
// the union just to ask whether it was in the list.
const REFUSED_ENVIRONMENT_NAMES: readonly string[] = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'GH_TOKEN',
  'GITHUB_TOKEN',
];

/**
 * Names the pinned CLI reads on Windows to choose Git Bash as its shell. An app
 * started from a Git Bash terminal inherits both. The CLI writes hook commands
 * in PowerShell syntax on Windows whichever shell it picked, so under Git Bash
 * the fail-closed approval hook cannot run and every tool call is denied.
 * Without them the CLI falls back to PowerShell, as it does for an app started
 * from the desktop.
 */
const WINDOWS_SHELL_SELECTION_NAMES: readonly string[] = ['SHELL', 'MSYSTEM'];

/**
 * Whether this runtime removes `name` before launching the vendor process on
 * `platform`. `name` is already upper-cased: Windows environment names are
 * case-insensitive and CreateProcess looks them up that way, so `node_options`
 * would reach the child untouched if this matched raw casing.
 */
function refusesCursorEnvironmentName(
  name: string,
  platform: NodeJS.Platform,
): boolean {
  return (
    name.startsWith('CURSOR_') ||
    name.startsWith('AGENT_CLI_') ||
    name.startsWith('GIT_CONFIG_') ||
    REFUSED_ENVIRONMENT_NAMES.includes(name) ||
    (platform === 'win32' && WINDOWS_SHELL_SELECTION_NAMES.includes(name))
  );
}

/**
 * Names in a step-declared `requested` environment that this runtime will not
 * forward, in sorted order: the refused names and the loader and shell-startup
 * names (`isStepStartupInjectionName`).
 * `platform` must match the one `prepareCursorRuntimeEnvironment` builds for;
 * both default to the host so a caller that passes neither stays consistent.
 */
export function withheldCursorEnvironmentNames(
  requested: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const withheld = new Set<string>();
  for (const key of Object.keys(requested ?? {})) {
    if (
      refusesCursorEnvironmentName(key.toUpperCase(), platform) ||
      isStepStartupInjectionName(key)
    )
      withheld.add(stepEnvironmentNameLabel(key));
  }
  return Array.from(withheld).sort();
}

export interface CursorRuntimeEnvironmentOptions {
  /**
   * A per-chat HOME (see `prepareHomeOverlay`). Everything the vendor keys off
   * environment variables — XDG, Windows profile storage, config, data, and
   * caches — stays at the shared private home unless `stateOverlay` moves the
   * config and data directories.
   */
  homeOverlay?: string;
  /**
   * A throwaway root for the CLI's own config and data directories
   * (`CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR`). The CLI writes its session
   * records and per-project worker state under those two, so a launch that
   * must leave nothing behind, such as model discovery, points them at a
   * directory it deletes afterwards. Sign-in (`APPDATA` on Windows, the
   * Keychain bridge on macOS), XDG paths, and the caches stay at the shared
   * private home, so the launch still sees the managed sign-in.
   */
  stateOverlay?: string;
}

export async function prepareCursorRuntimeEnvironment(
  root: string,
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  options?: CursorRuntimeEnvironmentOptions,
): Promise<NodeJS.ProcessEnv> {
  await rejectSystemHooks(platform);
  await privateDirectory(root);
  const home = await preparePrivateHome(root, platform);
  const overlay = options?.homeOverlay;
  if (overlay !== undefined) await prepareHomeOverlay(overlay, home, platform);
  const state = options?.stateOverlay;
  if (state !== undefined) {
    await mkdir(dirname(state), { recursive: true, mode: 0o700 });
    await privateDirectory(state);
  }
  const configDir = join(state ?? root, 'config');
  const cache = join(root, 'compile-cache');
  const data = join(state ?? root, 'data');
  const xdgConfig = join(home, '.config');
  const xdgDataParent = join(home, '.local');
  const xdgData = join(xdgDataParent, 'share');
  const xdgCache = join(home, '.cache');
  // Windows resolves the user profile through USERPROFILE/APPDATA/LOCALAPPDATA
  // rather than HOME, so the private overlay has to provide those too.
  const appDataParent = join(home, 'AppData');
  const roamingAppData = join(appDataParent, 'Roaming');
  const localAppData = join(appDataParent, 'Local');
  for (const directory of [
    configDir,
    cache,
    data,
    xdgConfig,
    xdgDataParent,
    xdgData,
    xdgCache,
    ...(platform === 'win32'
      ? [appDataParent, roamingAppData, localAppData]
      : []),
  ]) {
    await privateDirectory(directory);
  }
  const file = join(configDir, 'cli-config.json');
  let config: Record<string, unknown> = {
    version: 1,
    editor: { vimMode: false },
    permissions: { allow: [], deny: [] },
  };
  try {
    // Only a regular private file is merged; a symlinked config would import a
    // foreign file's keys. Tool permissions stay app-owned defaults every launch.
    if (!(await lstat(file)).isFile()) throw new Error('Not a regular file');
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      config = { ...config, ...parsed, permissions: config.permissions };
  } catch {
    /* First connection or damaged private config: recreate safe defaults. */
  }
  const temporary = join(configDir, `.config-${randomUUID()}`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ ...config, channel: 'static' }),
      { mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (refusesCursorEnvironmentName(key.toUpperCase(), platform))
      delete env[key];
  }
  return {
    ...env,
    ...(platform === 'win32'
      ? {
          USERPROFILE: overlay ?? home,
          APPDATA: roamingAppData,
          LOCALAPPDATA: localAppData,
        }
      : {}),
    HOME: overlay ?? home,
    ZDOTDIR: overlay ?? home,
    // A per-chat HOME would otherwise give every chat its own npm cache for
    // the `npx` MCP servers the CLI launches.
    ...(overlay !== undefined ? { npm_config_cache: join(home, '.npm') } : {}),
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    CURSOR_CONFIG_DIR: configDir,
    CURSOR_DATA_DIR: data,
    NODE_COMPILE_CACHE: cache,
    NO_OPEN_BROWSER: '1',
  };
}

/** Canonical-home environment keys a pipeline-declared environment must never override. */
const CANONICAL_HOME_ENVIRONMENT_KEYS: readonly string[] = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOMESHARE',
];

/**
 * Strips canonical-home overrides and loader and shell-startup names
 * (`isStepStartupInjectionName`: the bash launcher and the loader act on them
 * before the approval hook) from a
 * pipeline-declared environment before it is merged into the Cursor spawn
 * environment. `prepareCursorRuntimeEnvironment` is the sole authority for
 * Cursor's private home overlay and separately deletes every refused name
 * (`CURSOR_*` included) from the merged object, so a pipeline-declared
 * CURSOR_API_KEY never reaches the spawned child either. This is Cursor's own
 * sanitizer (not a reused Codex helper) so Cursor spawn-state scoping stays
 * independent of Codex's runtime boundary.
 */
function sanitizeCursorStepEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !CANONICAL_HOME_ENVIRONMENT_KEYS.includes(name) &&
        !isStepStartupInjectionName(name)
      );
    }),
  );
}

/**
 * The environment a pipeline step's cursor-agent runs with, its version probe
 * included: the driver's base environment, then the step's own values without
 * home overrides or loader and shell-startup names
 * (`withheldCursorEnvironmentNames` reports
 * them), inside the private runtime profile.
 */
export function prepareCursorStepEnvironment(
  stateDir: string,
  baseEnvironment: NodeJS.ProcessEnv,
  stepEnvironment: Record<string, string>,
): Promise<NodeJS.ProcessEnv> {
  return prepareCursorRuntimeEnvironment(stateDir, {
    ...baseEnvironment,
    ...sanitizeCursorStepEnvironment(stepEnvironment),
    NO_OPEN_BROWSER: '1',
  });
}
