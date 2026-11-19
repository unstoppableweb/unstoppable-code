import path from 'node:path';
import { CLAUDE_NONESSENTIAL_TRAFFIC_OPT_OUT_ENV } from '@canopy/execution-engine/node/local-only-build';

/** Preserve only the verified runtime's private paths and process basics. */
export function buildDelegationCursorEnvironment(
  managed: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    'HOME',
    'ZDOTDIR',
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'USERNAME',
    'PROCESSOR_ARCHITECTURE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'CURSOR_CONFIG_DIR',
    'CURSOR_DATA_DIR',
    'NODE_COMPILE_CACHE',
    'npm_config_cache',
  ]) {
    const value = managed[key];
    if (value !== undefined) result[key] = value;
  }
  return {
    ...result,
    NO_OPEN_BROWSER: '1',
    LANG: 'en_US.UTF-8',
  };
}

export interface DelegationClaudeCredentials {
  readonly apiKey?: string;
  readonly authToken?: string;
  readonly oauthToken?: string;
  readonly baseUrl?: string;
  readonly customHeaders?: string;
  readonly disableExperimentalBetas?: boolean;
  /** Gateway routes reject inline tool definitions (CAN-4647). */
  readonly disableInlineTools?: boolean;
}

/** The only Windows profile values a delegated Claude process receives, all
 * host-resolved: process basics that Windows tools and runtimes expect. */
export const DELEGATION_WINDOWS_PROFILE_KEYS = [
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'USERNAME',
  'PROCESSOR_ARCHITECTURE',
] as const;
export type DelegationWindowsProfile = Partial<
  Record<(typeof DELEGATION_WINDOWS_PROFILE_KEYS)[number], string>
>;

export interface DelegationCommandEnvironmentOptions {
  canonicalHome: string;
  temporaryDirectory: string;
  windowsDirectory?: string;
  commandPath?: string;
  windowsProfile?: DelegationWindowsProfile;
  platform?: NodeJS.Platform;
}

/**
 * The process basics a delegated command receives: home, temporary
 * directories, locale, the captured command PATH and, on Windows, the host
 * profile values. No provider credentials or other host variables.
 */
export function buildDelegationCommandEnvironment(
  options: DelegationCommandEnvironmentOptions,
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (
    !pathApi.isAbsolute(options.canonicalHome) ||
    !pathApi.isAbsolute(options.temporaryDirectory)
  )
    throw new Error('Invalid delegation runtime paths');
  const environment: Record<string, string> = {
    HOME: options.canonicalHome,
    PATH: options.commandPath ?? '',
    TMPDIR: options.temporaryDirectory,
    TMP: options.temporaryDirectory,
    TEMP: options.temporaryDirectory,
    LANG: 'en_US.UTF-8',
  };
  if (platform === 'win32') {
    const windowsDirectory = options.windowsDirectory;
    if (!windowsDirectory || !pathApi.isAbsolute(windowsDirectory))
      throw new Error('Windows system directory is unavailable');
    environment.SystemRoot = windowsDirectory;
    environment.WINDIR = windowsDirectory;
    environment.USERPROFILE = options.canonicalHome;
    environment.ComSpec = pathApi.join(windowsDirectory, 'System32', 'cmd.exe');
    environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    for (const key of DELEGATION_WINDOWS_PROFILE_KEYS) {
      const value = options.windowsProfile?.[key];
      // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
      if (!value || /[\u0000-\u001f\u007f]/.test(value)) continue;
      // Directory values must be absolute; names are passed through as-is.
      if (
        (key === 'APPDATA' ||
          key === 'LOCALAPPDATA' ||
          key === 'ProgramData') &&
        !pathApi.isAbsolute(value)
      )
        continue;
      environment[key] = value;
    }
  }
  return environment;
}

/** Explicit host-resolved inputs only. Never merge SDK or process environments. */
export function buildDelegationClaudeEnvironment(
  options: DelegationCommandEnvironmentOptions & {
    /** Where the CLI writes `run_in_background` task output
     * (`CLAUDE_CODE_TMPDIR`); a directory the child may read. */
    backgroundTaskDirectory?: string;
    /** The host's `CLAUDE_CONFIG_DIR`, so user settings match a parent chat. */
    claudeConfigDirectory?: string;
    credentials: DelegationClaudeCredentials;
    /** Windows: Git Bash for Claude's Bash tool (`CLAUDE_CODE_GIT_BASH_PATH`). */
    gitBashPath?: string;
  },
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (
    (options.backgroundTaskDirectory !== undefined &&
      !pathApi.isAbsolute(options.backgroundTaskDirectory)) ||
    (options.claudeConfigDirectory !== undefined &&
      !pathApi.isAbsolute(options.claudeConfigDirectory))
  )
    throw new Error('Invalid delegation runtime paths');
  const environment = buildDelegationCommandEnvironment(options);
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
    CLAUDE_NONESSENTIAL_TRAFFIC_OPT_OUT_ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  environment.DISABLE_AUTOUPDATER =
    CLAUDE_NONESSENTIAL_TRAFFIC_OPT_OUT_ENV.DISABLE_AUTOUPDATER;
  if (options.backgroundTaskDirectory)
    environment.CLAUDE_CODE_TMPDIR = options.backgroundTaskDirectory;
  if (options.claudeConfigDirectory)
    environment.CLAUDE_CONFIG_DIR = options.claudeConfigDirectory;
  if (platform === 'win32') {
    const gitBash = options.gitBashPath;
    if (
      gitBash &&
      pathApi.isAbsolute(gitBash) &&
      pathApi.basename(gitBash).toLowerCase() === 'bash.exe'
    )
      environment.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
  }
  const { credentials } = options;
  if (credentials.apiKey !== undefined)
    environment.ANTHROPIC_API_KEY = credentials.apiKey;
  if (credentials.authToken !== undefined)
    environment.ANTHROPIC_AUTH_TOKEN = credentials.authToken;
  if (credentials.oauthToken !== undefined)
    environment.CLAUDE_CODE_OAUTH_TOKEN = credentials.oauthToken;
  if (credentials.baseUrl !== undefined)
    environment.ANTHROPIC_BASE_URL = credentials.baseUrl;
  if (credentials.customHeaders !== undefined)
    environment.ANTHROPIC_CUSTOM_HEADERS = credentials.customHeaders;
  if (credentials.disableExperimentalBetas)
    environment.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  if (credentials.disableInlineTools)
    environment.CLAUDE_CODE_INLINE_TOOLS = 'false';
  return environment;
}
