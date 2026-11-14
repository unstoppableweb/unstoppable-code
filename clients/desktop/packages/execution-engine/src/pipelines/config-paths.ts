import {
  execFileLoginShellProbe,
  type LoginShellProbe,
} from './login-shell-probe';
export type { LoginShellProbe } from './login-shell-probe';
import { constants, existsSync, realpathSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { getGitExecutableDetectionMode } from '@canopy/protocol/git-executable';
import { BRAND } from '@canopy/brand/current';
import { getBrandEnv } from '../brand/env';
import { sanitizeEnvVars } from '../lib/mcp-security';
import { stripAgentSecretValues } from '../lib/agent-secret-values-env';
import { getCanopyDataDir, getCanopyRuntimeMode } from '../canopy-paths';
import { findExecutableOnPath } from '../node/lib/path-lookup';
import type { ResolveEnvironmentRequest } from '../types/user-environment';

const LOGIN_SHELL_PATH_TTL_MS = 5 * 60_000; // 5 minutes
const MACOS_DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const LINUX_DEFAULT_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const LINUX_PATH_MARKER = '__CANOPY_LOGIN_PATH__';

/**
 * Env marker stamped on the result of `getEnhancedEnv()` in any process that
 * actually injects user-configured environment variables (i.e. the Electron
 * main process). Descendants inherit this marker and short-circuit their own
 * `getEnhancedEnv()` call so they never re-read or re-decrypt the persisted
 * file — the values are already in their `process.env`.
 */
export const CANOPY_ENV_ENHANCED_MARKER = 'CANOPY_ENV_ENHANCED';

let cachedLoginShellPath: string | undefined;
let cachedLoginShellPathAt = 0;
let claudeModAdmissionEnabled = false;

type UserEnvironmentInjector = (
  context?: ResolveEnvironmentRequest,
) => Record<string, string>;
let userEnvironmentInjector: UserEnvironmentInjector | null = null;

/**
 * Secrets injector — like {@link userEnvironmentInjector} but reserved for
 * Canopy-managed credentials (e.g. the GitHub PAT exposed as `GH_TOKEN`).
 * Callers can opt out via {@link GetEnhancedEnvOptions.includeCanopySecrets}
 * so flows that deliberately need to bypass Canopy-injected credentials
 * (e.g. running `gh auth login` interactively) can do so without affecting
 * user-set environment variables.
 */
type SecretsEnvInjector = () => Record<string, string>;
let secretsEnvInjector: SecretsEnvInjector | null = null;

type BundledTarget =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'win32-x64'
  | 'linux-x64'
  | 'linux-arm64';

function getBundledTarget(): BundledTarget | null {
  if (
    hostOperatingSystem() === 'darwin' &&
    (process.arch === 'arm64' || process.arch === 'x64')
  ) {
    return `darwin-${process.arch}`;
  }
  if (hostOperatingSystem() === 'win32' && process.arch === 'x64') {
    return 'win32-x64';
  }
  if (
    hostOperatingSystem() === 'linux' &&
    (process.arch === 'x64' || process.arch === 'arm64')
  ) {
    return `linux-${process.arch}`;
  }
  return null;
}

function withExeOnWindows(name: string): string {
  return hostOperatingSystem() === 'win32' ? `${name}.exe` : name;
}

/**
 * Tools every bundled target stages in its `bin/` directory. Codex finds
 * `codex-code-mode-host` beside its own executable, so the host has no
 * override of its own and always follows the resolved Codex.
 */
export const BUNDLED_BINARY_MEMBERS = [
  'claude',
  'codex',
  'codex-code-mode-host',
  'gh',
  'rg',
  'rtk',
] as const;

export type BundledBinaryMember = (typeof BUNDLED_BINARY_MEMBERS)[number];

/** Recognize only bare host command names, preserving explicit paths. */
export function getBundledBinaryMember(
  command: string,
): BundledBinaryMember | undefined {
  return BUNDLED_BINARY_MEMBERS.find(
    (member) => command === member || command === withExeOnWindows(member),
  );
}

/**
 * - `override`: an explicit environment override, used as given.
 * - `bundled`: the staged file exists in the bundled `bin/` directory.
 * - `missing`: the bundle promises the member but the file is absent; `path`
 *   is where it was expected.
 * - `host-fallback`: macOS/Windows development only; a PATH install replaces
 *   a staged provider that is not there yet.
 * - `unbundled`: the platform has no bundled target; `path` is the bare name.
 */
export type BundledBinaryStatus =
  | 'override'
  | 'bundled'
  | 'missing'
  | 'host-fallback'
  | 'unbundled';

export interface BundledBinaryResolution {
  member: BundledBinaryMember;
  status: BundledBinaryStatus;
  path: string;
}

/** Resolve an unbundled CLI without substituting for an explicit invalid override. */
export async function resolveInstalledBinaryPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  override?: string,
): Promise<string | undefined> {
  if (override) {
    if (!path.isAbsolute(override)) return undefined;
    try {
      const executable = await realpath(override);
      if (!(await stat(executable)).isFile()) return undefined;
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      return undefined;
    }
  }
  for (const name of names) {
    const executable = findExecutableOnPath(name, env.PATH ?? '');
    if (executable) return executable;
  }
  return undefined;
}

/** A resolved path before the bundled file's existence has been checked. */
interface BundledBinaryLocation {
  source: 'override' | 'bundle' | 'host-fallback' | 'unbundled';
  path: string;
}

type OverridableBundledBinaryMember = Exclude<
  BundledBinaryMember,
  'codex-code-mode-host'
>;

const BUNDLED_BINARY_OVERRIDE_ENV: Record<
  OverridableBundledBinaryMember,
  { brandSuffix: string; executableEnv: string }
> = {
  claude: {
    brandSuffix: 'CLAUDE_BINARY_PATH',
    executableEnv: 'CLAUDE_CODE_EXECUTABLE',
  },
  codex: {
    brandSuffix: 'CODEX_BINARY_PATH',
    executableEnv: 'CODEX_EXECUTABLE',
  },
  gh: { brandSuffix: 'GH_BINARY_PATH', executableEnv: 'GH_EXECUTABLE' },
  rg: { brandSuffix: 'RG_BINARY_PATH', executableEnv: 'RG_EXECUTABLE' },
  rtk: { brandSuffix: 'RTK_BINARY_PATH', executableEnv: 'RTK_EXECUTABLE' },
};

/**
 * Dev worktrees on macOS and Windows can resolve `.cache/bin` before host
 * binaries are staged, so a missing staged provider falls back to a PATH
 * install. It is resolved to an absolute path so Windows never searches the
 * user-controlled spawn cwd for an unqualified executable name. Bundled Linux
 * targets report the missing member instead: a host install would mask a broken
 * staging step with a provider the bundle does not pin.
 */
function findDevHostProviderFallback(
  executableName: string,
  bundledPath: string,
): string | undefined {
  if (
    !isDevRuntime() ||
    hostOperatingSystem() === 'linux' ||
    existsSync(bundledPath)
  ) {
    return undefined;
  }
  return findExecutableOnPath(executableName, getLoginShellPath()) ?? undefined;
}

function locateBundledBinary(
  member: BundledBinaryMember,
): BundledBinaryLocation {
  if (member === 'codex-code-mode-host') {
    const codex = locateBundledBinary('codex');
    return {
      source: codex.source,
      path: path.join(path.dirname(codex.path), withExeOnWindows(member)),
    };
  }

  const { brandSuffix, executableEnv } = BUNDLED_BINARY_OVERRIDE_ENV[member];
  const override =
    getBrandEnv(process.env, brandSuffix) ?? getTrimmedEnvVar(executableEnv);
  if (override) {
    return { source: 'override', path: override };
  }

  const executableName = withExeOnWindows(member);
  const binDir = getBundledBinDir();
  if (!binDir) {
    return { source: 'unbundled', path: executableName };
  }

  const bundledPath = path.join(binDir, executableName);
  const hostFallback =
    member === 'claude' || member === 'codex'
      ? findDevHostProviderFallback(executableName, bundledPath)
      : undefined;
  return hostFallback
    ? { source: 'host-fallback', path: hostFallback }
    : { source: 'bundle', path: bundledPath };
}

/** Resolves a promised bundle member and reports where the path came from. */
export function resolveBundledBinary(
  member: BundledBinaryMember,
): BundledBinaryResolution {
  const location = locateBundledBinary(member);
  if (location.source !== 'bundle') {
    return { member, status: location.source, path: location.path };
  }
  return {
    member,
    status: existsSync(location.path) ? 'bundled' : 'missing',
    path: location.path,
  };
}

/** Promised bundle members whose staged file is absent. */
export function listMissingBundledBinaries(): BundledBinaryResolution[] {
  return BUNDLED_BINARY_MEMBERS.map((member) =>
    resolveBundledBinary(member),
  ).filter(({ status }) => status === 'missing');
}

function getTrimmedEnvVar(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getBundledResourcesDirOverride(): string | undefined {
  // The packaged CLI also supplies its extraction cache here; this is not a
  // test-only data-root override.
  const overridePath = getBrandEnv(process.env, 'BUNDLED_RESOURCES_DIR');
  if (!overridePath || !path.isAbsolute(overridePath)) {
    return undefined;
  }

  return overridePath;
}

function getPipelineBundledBinDirOverride(): string | undefined {
  const overridePath =
    getBrandEnv(process.env, 'CLAUDE_BINARY_PATH') ??
    getBrandEnv(process.env, 'CODEX_BINARY_PATH') ??
    getBrandEnv(process.env, 'GH_BINARY_PATH') ??
    getBrandEnv(process.env, 'RTK_BINARY_PATH') ??
    getBrandEnv(process.env, 'RG_BINARY_PATH') ??
    getBrandEnv(process.env, 'DICTATE_BINARY_PATH');

  if (!overridePath || !path.isAbsolute(overridePath)) {
    return undefined;
  }

  return path.dirname(overridePath);
}

let loginShellPathRefreshInFlight: Promise<void> | null = null;
let loginShellPathGeneration = 0;

/** Supported Linux desktops share the Git detector's login-shell resolution. */
export function isLinuxLoginShellPathSupported(): boolean {
  return (
    getGitExecutableDetectionMode(hostOperatingSystem() ?? '', process.arch) ===
    'linux'
  );
}

function getLoginShellPathFallback(): string {
  return (
    process.env.PATH ||
    (isLinuxLoginShellPathSupported() ? LINUX_DEFAULT_PATH : MACOS_DEFAULT_PATH)
  );
}

/**
 * Environment for short-lived Linux probes (the login shell, `git --version`):
 * a copy of `process.env` without loader, startup-file or Node injection
 * variables. Never mutates `process.env`.
 */
export function getLinuxProbeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (
      value !== undefined &&
      !name.startsWith('LD_') &&
      !name.startsWith('DYLD_') &&
      !name.startsWith('BASH_FUNC_') &&
      ![
        'BASH_ENV',
        'ENV',
        'SHELLOPTS',
        'BASHOPTS',
        'GCONV_PATH',
        'GLIBC_TUNABLES',
      ].includes(name)
    ) {
      env[key] = value;
    }
  }
  return sanitizeEnvVars(env);
}

let loginShellProbe: LoginShellProbe = execFileLoginShellProbe;

/**
 * Runs login-shell lookups through a host's execution host port, so they
 * launch like its other execution children. Without one (the CLI), lookups
 * use an unreferenced `execFile`. `undefined` restores that default.
 */
export function setLoginShellProbe(probe: LoginShellProbe | undefined): void {
  loginShellProbe = probe ?? execFileLoginShellProbe;
}

function processEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  return env;
}

function runLinuxShellProbe(
  file: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  maxBuffer: number,
): Promise<string | undefined> {
  return loginShellProbe({ file, args, env, timeoutMs, maxBuffer }).catch(
    () => undefined,
  );
}

async function isExecutableLinuxShell(
  shell: string,
  generation: number,
): Promise<boolean> {
  if (!path.posix.isAbsolute(shell) || /[\0\r\n]/.test(shell)) return false;
  try {
    const shellStat = await stat(shell);
    if (generation !== loginShellPathGeneration || !shellStat.isFile())
      return false;
    await access(shell, constants.X_OK);
    return generation === loginShellPathGeneration;
  } catch {
    return false;
  }
}

async function getLinuxAccountShell(
  env: Record<string, string>,
): Promise<string | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    return undefined;
  const output = await runLinuxShellProbe(
    '/usr/bin/getent',
    ['passwd', String(uid)],
    env,
    1000,
    16 * 1024,
  );
  const records = output?.trim().split('\n');
  if (records?.length !== 1) return undefined;
  const fields = records[0].split(':');
  return fields.length === 7 && fields[2] === String(uid)
    ? fields[6]
    : undefined;
}

/**
 * The real-UID account shell for Linux x64/arm64 terminals, via the same bounded
 * `getent` lookup the login-shell PATH probe uses. Never rejects.
 */
export async function resolveLinuxAccountShell(): Promise<string | undefined> {
  if (!isLinuxLoginShellPathSupported()) return undefined;
  try {
    return await getLinuxAccountShell(getLinuxProbeEnv());
  } catch {
    return undefined;
  }
}

async function resolveLinuxLoginShellPath(
  generation: number,
): Promise<string | undefined> {
  const env = getLinuxProbeEnv();
  const shell = process.env.SHELL?.trim() || (await getLinuxAccountShell(env));
  if (generation !== loginShellPathGeneration) return undefined;
  // A broken default/profile must not bypass executable validation for Bash.
  const candidates =
    shell && shell !== '/bin/bash' ? [shell, '/bin/bash'] : ['/bin/bash'];
  for (const candidate of candidates) {
    const executable = await isExecutableLinuxShell(candidate, generation);
    if (generation !== loginShellPathGeneration) return undefined;
    if (!executable) continue;
    const output = await runLinuxShellProbe(
      candidate,
      ['-lic', `exec /usr/bin/printf '${LINUX_PATH_MARKER}%s\\n' "$PATH"`],
      env,
      10_000,
      64 * 1024,
    );
    if (generation !== loginShellPathGeneration) return undefined;
    if (output === undefined) continue;
    // Startup output need not end with a newline. Never trust the final noise
    // line; quoted PATH preserves unexported values and Fish's colon joining.
    const markerAt = output.lastIndexOf(LINUX_PATH_MARKER);
    if (markerAt < 0) continue;
    const value = output
      .slice(markerAt + LINUX_PATH_MARKER.length)
      .split('\n')[0]
      .replace(/\r$/, '');
    if (value.trim().length > 0 && !/[\0\r]/.test(value)) return value;
  }
  return undefined;
}

function startLoginShellPathRefresh(): Promise<void> {
  if (loginShellPathRefreshInFlight) {
    return loginShellPathRefreshInFlight;
  }
  const fallback = getLoginShellPathFallback();
  const generation = loginShellPathGeneration;
  if (isLinuxLoginShellPathSupported()) {
    loginShellPathRefreshInFlight = resolveLinuxLoginShellPath(generation)
      .catch(() => undefined)
      .then((resolved): void => {
        if (generation !== loginShellPathGeneration) return;
        cachedLoginShellPath = resolved ?? cachedLoginShellPath ?? fallback;
        cachedLoginShellPathAt = Date.now();
        loginShellPathRefreshInFlight = null;
      });
    return loginShellPathRefreshInFlight;
  }
  const shell = process.env.SHELL || '/bin/zsh';
  loginShellPathRefreshInFlight = loginShellProbe({
    file: shell,
    args: ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'],
    env: processEnvironment(),
    timeoutMs: 10_000,
    maxBuffer: 1024 * 1024,
  })
    .catch(() => undefined)
    .then((stdout): void => {
      if (generation !== loginShellPathGeneration) return;
      loginShellPathRefreshInFlight = null;
      if (stdout === undefined) {
        cachedLoginShellPath = cachedLoginShellPath ?? fallback;
      } else {
        // Take the last non-empty line to skip any motd / shell init output
        const lines = stdout
          .split('\n')
          .filter((line) => line.trim().length > 0);
        const resolved = lines.length > 0 ? lines[lines.length - 1].trim() : '';
        cachedLoginShellPath =
          resolved.length > 0 ? resolved : (cachedLoginShellPath ?? fallback);
      }
      cachedLoginShellPathAt = Date.now();
    });
  return loginShellPathRefreshInFlight;
}

/**
 * Resolve the full login-shell PATH on macOS and Linux x64/arm64. Linux validates
 * the configured/account shell and probes marked output, with a Bash fallback.
 * Desktop launchers (Finder/Dock or GNOME) can supply a minimal inherited
 * PATH. Running the
 * user's login shell and reading its PATH variable picks up
 * Homebrew, nvm, pyenv, and other tool-manager additions. Printing the quoted
 * shell variable also preserves an unexported PATH, while Fish joins its path
 * list with colons. The fixed printf format preserves literal backslashes.
 * Keep exec so logout output cannot replace the captured PATH.
 *
 * The interactive login shell can take multiple seconds with heavy shell
 * init, so resolution is stale-while-revalidate: this function NEVER blocks.
 * Expired cache entries are returned immediately while a background refresh
 * updates the cache for later callers; before the first resolution completes
 * it returns the process PATH fallback. Call {@link prewarmLoginShellPath}
 * early at app startup so the cache is warm before the first spawn needs it.
 *
 * Other platforms retain process.env.PATH without probing.
 */
export function getLoginShellPath(): string {
  if (hostOperatingSystem() !== 'darwin' && !isLinuxLoginShellPathSupported()) {
    return process.env.PATH ?? '';
  }

  const expired =
    cachedLoginShellPath === undefined ||
    Date.now() - cachedLoginShellPathAt >= LOGIN_SHELL_PATH_TTL_MS;
  if (expired) {
    void startLoginShellPathRefresh();
  }
  return cachedLoginShellPath ?? getLoginShellPathFallback();
}

/**
 * Kick off (and await) the initial login-shell PATH resolution. Intended for
 * app startup so the first terminal/agent spawn sees the full user PATH
 * instead of the inherited fallback. `force` also refreshes a fresh cache, for
 * an explicit user recheck after installing a tool; it shares an in-flight
 * probe and keeps the previous value if the probe fails. No-op outside macOS
 * and supported Linux desktops.
 */
export async function prewarmLoginShellPath(options?: {
  force?: boolean;
}): Promise<void> {
  if (hostOperatingSystem() !== 'darwin' && !isLinuxLoginShellPathSupported()) {
    return;
  }
  if (
    !options?.force &&
    cachedLoginShellPath !== undefined &&
    Date.now() - cachedLoginShellPathAt < LOGIN_SHELL_PATH_TTL_MS
  ) {
    return;
  }
  await startLoginShellPathRefresh();
}

/** @internal — exposed for testing only */
export function resetLoginShellPathCache(): void {
  loginShellPathGeneration += 1;
  cachedLoginShellPath = undefined;
  cachedLoginShellPathAt = 0;
  loginShellPathRefreshInFlight = null;
}

/**
 * Register the source of user-configured environment variables.
 *
 * Only the Electron main process should register an injector — it has access
 * to `safeStorage` to decrypt the persisted on-disk file. Descendants (action
 * subprocesses, helper agents, SEA CLI launched from the app) inherit the
 * already-merged env via the `CANOPY_ENV_ENHANCED` marker and never need to
 * decrypt anything.
 *
 * Pass `null` to unregister (used by tests).
 */
export function registerUserEnvironmentInjector(
  injector: UserEnvironmentInjector | null,
): void {
  userEnvironmentInjector = injector;
}

function getUserEnvironmentForSpawn(
  context?: ResolveEnvironmentRequest,
): Record<string, string> {
  if (!userEnvironmentInjector) {
    return {};
  }
  try {
    return userEnvironmentInjector(context);
  } catch {
    return {};
  }
}

/**
 * Register the source of Canopy-managed secret environment variables (e.g.
 * the encrypted GitHub PAT exposed as `GH_TOKEN`). Only the Electron main
 * process should register an injector. Descendants inherit the merged env
 * via {@link CANOPY_ENV_ENHANCED_MARKER}.
 *
 * Pass `null` to unregister (used by tests).
 */
export function registerSecretsEnvInjector(
  injector: SecretsEnvInjector | null,
): void {
  secretsEnvInjector = injector;
}

function getSecretsForSpawn(): Record<string, string> {
  if (!secretsEnvInjector) {
    return {};
  }
  try {
    return secretsEnvInjector();
  } catch {
    return {};
  }
}

function isDevRuntime(): boolean {
  return getCanopyRuntimeMode() === 'dev';
}

function findDevResourcesDir(startPath: string): string | undefined {
  let current = path.resolve(startPath);

  while (true) {
    const brandedResourcesDir = path.join(
      current,
      '.cache',
      'brand',
      BRAND.id,
      'resources',
    );
    if (hasBundledResources(brandedResourcesDir)) {
      return brandedResourcesDir;
    }

    const workspaceResourcesDir = path.join(
      current,
      'packages',
      'desktop-shared',
      'resources',
    );
    if (hasBundledResources(workspaceResourcesDir)) {
      return workspaceResourcesDir;
    }

    const packageResourcesDir = path.join(current, 'resources');
    if (hasBundledResources(packageResourcesDir)) {
      return packageResourcesDir;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function getDevResourcesDir(): string {
  // Source runs are now dev under Jest; preserve its committed-resource preference.
  const workspaceResourcesDir =
    process.env.JEST_WORKER_ID !== undefined
      ? findWorkspaceResourcesDirFallback(process.cwd())
      : undefined;
  return (
    workspaceResourcesDir ??
    findDevResourcesDir(process.cwd()) ??
    path.resolve(process.cwd(), 'packages', 'desktop-shared', 'resources')
  );
}

function getResolvedExecPath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function hasBundledResources(candidateDir: string): boolean {
  return (
    existsSync(path.join(candidateDir, 'pipelines')) ||
    existsSync(path.join(candidateDir, 'actions')) ||
    existsSync(path.join(candidateDir, 'skills')) ||
    existsSync(path.join(candidateDir, 'plugins'))
  );
}

/**
 * Walks up from `startPath` looking only for the committed workspace
 * resources directory (`packages/desktop-shared/resources`), deliberately
 * skipping the per-brand `.cache/brand/<id>/resources` mirror that
 * {@link findDevResourcesDir} prefers. Used for source runs under Jest and as
 * a Jest-only last-resort fallback for non-dev runtimes, whose resource
 * lookups would otherwise resolve relative to the Node executable. This keeps
 * tests independent of whether `brand:prepare` has generated a brand mirror.
 */
function findWorkspaceResourcesDirFallback(
  startPath: string,
): string | undefined {
  let current = path.resolve(startPath);

  while (true) {
    const workspaceResourcesDir = path.join(
      current,
      'packages',
      'desktop-shared',
      'resources',
    );
    if (hasBundledResources(workspaceResourcesDir)) {
      return workspaceResourcesDir;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function getBundledResourcesDir(): string {
  // Source runs are dev even under NODE_ENV=test; keep explicit fixture roots.
  const overridePath = getBundledResourcesDirOverride();
  if (overridePath) {
    return overridePath;
  }

  if (isDevRuntime()) {
    return getDevResourcesDir();
  }

  if (typeof process.resourcesPath === 'string') {
    return process.resourcesPath;
  }

  const execDir = path.dirname(getResolvedExecPath());
  const parentDir = path.resolve(execDir, '..');
  if (
    path.basename(execDir) === 'cli' &&
    path.basename(parentDir) === 'Resources' &&
    hasBundledResources(parentDir)
  ) {
    return parentDir;
  }

  // Jest-only last resort for non-dev runtimes: avoid resolving relative to
  // the Node executable. The gate is deliberately narrow — a real SEA CLI
  // run manually from a repo checkout must NOT
  // silently pick up the source tree and mask a broken staging step.
  if (process.env.JEST_WORKER_ID !== undefined) {
    const workspaceResourcesDir = findWorkspaceResourcesDirFallback(
      process.cwd(),
    );
    if (workspaceResourcesDir) {
      return workspaceResourcesDir;
    }
  }

  return path.resolve(execDir, 'resources');
}

export function getUserPipelinesDir(): string {
  return path.join(getCanopyDataDir(), 'pipelines');
}

export function getUserPipelineIndexPath(): string {
  return path.join(getUserPipelinesDir(), 'index.json');
}

export function getBundledPipelinesDir(): string {
  return path.join(getBundledResourcesDir(), 'pipelines');
}

/**
 * CLI-only escape hatch for {@link getBundledCodeGraphDir}. The desktop CLI's
 * `initEmbeddedResources()` (`apps/desktop-cli/src/index.ts`) unconditionally
 * extracts embedded actions/pipelines content and points `BUNDLED_RESOURCES_DIR`
 * at that extraction cache for the lifetime of the process — see
 * `packages/desktop-shared/src/node/pipelines/embedded-resources.ts`. Code-graph
 * wasm/query resources are deliberately NOT routed through that string-embed
 * pipeline (binary wasm would corrupt through a UTF-8 round trip), so once the
 * override is set, `getBundledResourcesDir()`'s override branch always wins
 * and the plain `<bundled resources dir>/code-graph` join below would resolve
 * to the extraction cache — which never contains a `code-graph` subdirectory.
 *
 * `scripts/build-cli.mjs` stages the real `code-graph/` resource directory
 * into `resources/code-graph/` beside EVERY built CLI binary: the standalone
 * SEA build (`dist/cli/canopy`) and each `.cache/cli/<target>/` staging dir.
 * The Electron-embedded CLI copy is covered by the same layout —
 * `build.extraResources` copies `.cache/cli/<target>` wholesale into
 * `Contents/Resources/cli/`, staged `resources/code-graph/` included — so the
 * single `<execDir>/resources/code-graph` lookup below resolves for every CLI
 * distribution. It bypasses the override entirely; Electron main/renderer
 * never set the override and fall through to the general resolution
 * (`process.resourcesPath`).
 */
function getCliStagedCodeGraphDir(): string | undefined {
  if (isDevRuntime() || typeof process.resourcesPath === 'string') {
    // Dev runtime and Electron main/renderer already resolve code-graph
    // correctly through the general resolution below.
    return undefined;
  }

  const execDir = path.dirname(getResolvedExecPath());
  const siblingCandidate = path.join(execDir, 'resources', 'code-graph');
  if (existsSync(siblingCandidate)) {
    return siblingCandidate;
  }

  return undefined;
}

export function getBundledCodeGraphDir(): string {
  const cliStagedDir = getCliStagedCodeGraphDir();
  if (cliStagedDir) {
    return cliStagedDir;
  }
  return path.join(getBundledResourcesDir(), 'code-graph');
}

export function getBundledActionsDir(): string {
  return path.join(getBundledResourcesDir(), 'actions');
}

export function getBundledPluginsDir(): string {
  return path.join(getBundledResourcesDir(), 'plugins');
}

export function getBundledClaudePluginMarketplaceManifestPath(): string {
  return path.join(
    getBundledPluginsDir(),
    '.claude-plugin',
    'marketplace.json',
  );
}

export function getBundledCodexPluginMarketplaceManifestPath(): string {
  return path.join(
    getBundledPluginsDir(),
    '.agents',
    'plugins',
    'marketplace.json',
  );
}

export function hasBundledPlugins(): boolean {
  return (
    existsSync(getBundledClaudePluginMarketplaceManifestPath()) ||
    existsSync(getBundledCodexPluginMarketplaceManifestPath())
  );
}

export function getBundledBinDir(): string {
  const pipelineOverride = getPipelineBundledBinDirOverride();
  if (pipelineOverride) {
    return pipelineOverride;
  }

  const target = getBundledTarget();
  if (!target) {
    return '';
  }

  if (isDevRuntime()) {
    return path.resolve(process.cwd(), '.cache', 'bin', target);
  }

  if (typeof process.resourcesPath === 'string') {
    return path.join(process.resourcesPath, 'bin');
  }

  const execDir = path.dirname(getResolvedExecPath());
  // A Linux standalone CLI keeps its tools beside the executable, and its
  // parent is often a home directory whose `bin/` holds unrelated host tools.
  // Only the in-app CLI under `resources/cli` uses `resources/bin`.
  if (
    target.startsWith('linux-') &&
    (path.basename(execDir) !== 'cli' ||
      path.basename(path.dirname(execDir)) !== 'resources')
  ) {
    return execDir;
  }

  const siblingBinDir = path.resolve(execDir, '..', 'bin');
  if (existsSync(siblingBinDir)) {
    return siblingBinDir;
  }

  return execDir;
}

export function getBundledCanopyCliPath(): string {
  if (isDevRuntime()) {
    return path.resolve(
      process.cwd(),
      'dist',
      'cli',
      withExeOnWindows(BRAND.cliName),
    );
  }

  if (typeof process.resourcesPath === 'string') {
    return path.join(
      process.resourcesPath,
      'cli',
      withExeOnWindows(BRAND.cliName),
    );
  }

  return getResolvedExecPath();
}

export interface GetEnhancedEnvOptions {
  /**
   * When `false`, omit Canopy-managed secret env vars (e.g. the PAT-derived
   * `GH_TOKEN`) from the result. Any externally-set values present in
   * `process.env` still pass through unchanged. Defaults to `true`.
   *
   * The opt-out only takes effect on the source path (Electron main). On the
   * descendant short-circuit path the parent has already merged secrets into
   * `process.env`, so this option is a no-op there — flows that need a
   * secret-free spawn must run from main.
   */
  includeCanopySecrets?: boolean;
  /**
   * Runtime/workspace environment to inject. `false` disables user-configured
   * variables while still preserving Canopy's managed PATH and marker.
   * Apply this opt-out in the source process before spawning children; a
   * descendant that already inherited `CANOPY_ENV_ENHANCED` keeps whatever
   * user variables the parent put in `process.env`.
   * Omitted preserves the legacy global behavior and resolves the Canopy
   * runtime without a workspace override.
   */
  environment?: ResolveEnvironmentRequest | false;
}

/**
 * Chromium hands the app's own child processes its crash handler pipe through
 * this variable. A process Canopy spawns is not one of them: an Electron app
 * that an agent launches (an E2E run, a repro) would connect to the user's
 * running handler, write its crashes into the app's crash database and have
 * them reported as the app's own. Withheld here, never removed from
 * `process.env`, which the app's renderers still inherit.
 */
const HOST_CRASH_REPORTER_PIPE_ENV = 'CHROME_CRASHPAD_PIPE_NAME';
const CLAUDE_CODE_PLUGIN_DIRS_ENV = 'CLAUDE_CODE_PLUGIN_DIRS';

/** Apply the desktop Claude Mod feature-flag state to future environment copies. */
export function setClaudeModAdmissionEnabled(enabled: boolean): void {
  claudeModAdmissionEnabled = enabled;
}

function stripHostCrashReporterPipe(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  delete env[HOST_CRASH_REPORTER_PIPE_ENV];
  return env;
}

function stripInheritedClaudePluginDirs(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!claudeModAdmissionEnabled) return env;
  const copy = { ...env };
  delete copy[CLAUDE_CODE_PLUGIN_DIRS_ENV];
  return copy;
}

/**
 * Where the desktop main entry records the environment main started with,
 * before the bundle and its dependencies load
 * (`scripts/lib/desktop-main-entry.mjs`). Other processes record nothing.
 */
const STARTUP_ENVIRONMENT_SLOT = Symbol.for('canopy.startupEnvironment');

/**
 * Variables a library sets on this process's `process.env` when it loads.
 * The Claude Agent SDK sets `NoDefaultCurrentDirectoryInExePath=1`. This
 * process keeps it, because Node resolves the programs it spawns by this
 * process's value. A child's cmd.exe reads its own copy, though, and would
 * stop running programs from its current directory by bare name, which a
 * standalone terminal allows and builds rely on: node-pty's winpty build runs
 * `cd shared && GetCommitHash.bat`. A child gets the startup value instead.
 */
const LIBRARY_INJECTED_ENV_NAMES = ['NoDefaultCurrentDirectoryInExePath'];

function readStartupEnvironment(): Record<string, string> | undefined {
  const recorded: unknown = Reflect.get(globalThis, STARTUP_ENVIRONMENT_SLOT);
  if (typeof recorded !== 'object' || recorded === null) return undefined;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(recorded)) {
    if (typeof value === 'string') environment[key] = value;
  }
  return environment;
}

function envKeysNamed(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string[] {
  if (process.platform !== 'win32') {
    return Object.prototype.hasOwnProperty.call(env, name) ? [name] : [];
  }
  const lowerName = name.toLowerCase();
  return Object.keys(env).filter((key) => key.toLowerCase() === lowerName);
}

/**
 * Gives `env` the startup value of each library-injected variable, except
 * one `configured` sets explicitly for spawns. Without a recorded startup
 * environment `env` keeps its values.
 */
function restoreLibraryInjectedEnvironment(
  env: Record<string, string | undefined>,
  configured: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  const startup = readStartupEnvironment();
  if (!startup) return env;
  for (const name of LIBRARY_INJECTED_ENV_NAMES) {
    if (envKeysNamed(configured, name).length > 0) continue;
    for (const key of envKeysNamed(env, name)) delete env[key];
    for (const key of envKeysNamed(startup, name)) env[key] = startup[key];
  }
  return env;
}

/**
 * A relaunched or updated app inherits this process's environment and would
 * record a library-injected value as the user's own. Call this immediately
 * before handing off to the next instance.
 */
export function restoreStartupEnvironmentForRelaunch(): void {
  restoreLibraryInjectedEnvironment(process.env);
}

export function getEnhancedEnv(
  options: GetEnhancedEnvOptions = {},
): Record<string, string | undefined> {
  const includeCanopySecrets = options.includeCanopySecrets !== false;
  const binDir = getBundledBinDir();
  const basePath = getLoginShellPath();
  const pathValue = binDir
    ? basePath
      ? `${binDir}${path.delimiter}${basePath}`
      : binDir
    : basePath;

  const hasLocalInjectors =
    userEnvironmentInjector !== null || secretsEnvInjector !== null;

  // Descendant short-circuit: an ancestor process already merged the user's
  // environment variables into our `process.env`, so we just keep PATH fresh
  // and pass through. If this process registered injectors, it is an
  // environment source even when it inherited the marker from its own parent.
  if (process.env[CANOPY_ENV_ENHANCED_MARKER] === '1' && !hasLocalInjectors) {
    return stripInheritedClaudePluginDirs(
      stripHostCrashReporterPipe(
        stripAgentSecretValues(
          restoreLibraryInjectedEnvironment({
            ...process.env,
            PATH: pathValue,
          }),
        ),
      ),
    );
  }

  // Source path: only the Electron main process registers injectors. In every
  // other context these return `{}` and user vars/secrets are simply absent.
  const userEnvironment =
    options.environment === false
      ? {}
      : getUserEnvironmentForSpawn(options.environment);
  const secrets = includeCanopySecrets ? getSecretsForSpawn() : {};
  // A builtin agent action's aggregate of configured values is for that
  // action only; nothing it spawns needs it. Stripped from the object this
  // function already builds, so a spawn still copies the environment once.
  return stripInheritedClaudePluginDirs(
    stripHostCrashReporterPipe(
      stripAgentSecretValues(
        restoreLibraryInjectedEnvironment(
          {
            ...process.env,
            ...userEnvironment,
            ...secrets,
            [CANOPY_ENV_ENHANCED_MARKER]: '1',
            PATH: pathValue,
          },
          userEnvironment,
        ),
      ),
    ),
  );
}

export function getBundledClaudeBinaryPath(): string {
  return locateBundledBinary('claude').path;
}

export function getBundledCodexBinaryPath(): string {
  return locateBundledBinary('codex').path;
}

export function getBundledCodexCodeModeHostPath(): string {
  return locateBundledBinary('codex-code-mode-host').path;
}

export function getBundledGhBinaryPath(): string {
  return locateBundledBinary('gh').path;
}

export function getBundledRgBinaryPath(): string {
  return locateBundledBinary('rg').path;
}

export function getBundledRtkBinaryPath(): string {
  return locateBundledBinary('rtk').path;
}

export function getRtkDataDir(): string {
  return path.join(getCanopyDataDir(), 'rtk');
}

export function getRtkDbPath(): string {
  return path.join(getRtkDataDir(), 'history.db');
}

export function getRtkTeeDir(): string {
  return path.join(getRtkDataDir(), 'tee');
}

export function getRtkManagedEnv(): Record<string, string> {
  return {
    RTK_TELEMETRY_DISABLED: '1',
    RTK_DB_PATH: getRtkDbPath(),
    RTK_TEE_DIR: getRtkTeeDir(),
  };
}

/** Managed Cursor CLI runtimes, one directory per pinned version. */
export function getCursorRuntimeRootDir(): string {
  return path.join(getCanopyDataDir(), 'cursor-runtime');
}

/** Private HOME/XDG overlay the managed Cursor CLI runs against. */
export function getCursorRuntimeStateDir(): string {
  return path.join(getCanopyDataDir(), 'cursor-runtime-state');
}

export function getCopilotRuntimeReceiptsDir(): string {
  return path.join(getCanopyDataDir(), 'copilot-runtime-receipts');
}

export function getCopilotRuntimeRootDir(): string {
  return path.join(getCanopyDataDir(), 'copilot-runtime');
}

export function getOpenCodeRuntimeRootDir(): string {
  return path.join(getCanopyDataDir(), 'opencode-runtime');
}

export function getOpenCodeRuntimeStateDir(): string {
  return path.join(getCanopyDataDir(), 'opencode-runtime-state');
}

/**
 * Managed CLI configuration and state; never credentials
 * (docs/desktop-persistence.md). Per-chat session state uses a separate config
 * directory.
 */
export function getCopilotRuntimeStateDir(): string {
  return path.join(getCanopyDataDir(), 'copilot-runtime-state');
}

export function getBundledDictateBinaryPath(): string {
  const pipelineOverride = getBrandEnv(process.env, 'DICTATE_BINARY_PATH');
  if (pipelineOverride) {
    return pipelineOverride;
  }

  const override = getTrimmedEnvVar('DICTATE_EXECUTABLE');
  if (override) {
    return override;
  }

  if (hostOperatingSystem() !== 'darwin') {
    return '';
  }

  const binDir = getBundledBinDir();
  return binDir ? path.join(binDir, BRAND.dictation.binaryName) : '';
}

export function getProjectActionsDirCandidates(repoPath: string): string[] {
  return BRAND.storage.projectConfigDirNames.map((dirName) =>
    path.join(repoPath, dirName, 'actions'),
  );
}

export function getProjectPipelinesDirCandidates(repoPath: string): string[] {
  return BRAND.storage.projectConfigDirNames.map((dirName) =>
    path.join(repoPath, dirName, 'pipelines'),
  );
}

export function getProjectActionsDir(repoPath: string): string {
  return getProjectActionsDirCandidates(repoPath)[0];
}

export function getProjectPipelinesDir(repoPath: string): string {
  return getProjectPipelinesDirCandidates(repoPath)[0];
}

export function getBundledSkillsDir(): string {
  return path.join(getBundledResourcesDir(), 'skills');
}

export function getBundledSkillDir(skillName: string): string {
  return path.join(getBundledSkillsDir(), skillName);
}
