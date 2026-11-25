import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { lstat } from 'node:fs/promises';
import {
  getAntigravityRuntimeRootDir,
  getEnhancedEnv,
  resolveInstalledBinaryPath,
} from '@canopy/desktop-shared/pipelines/config-paths';

import { verifyManagedExecutable } from '../managed-runtime/verification';
import {
  getAntigravityRuntimeArtifact,
  isAntigravityPlatformSupported,
  managedAntigravityExecutable,
} from './runtime-artifacts';
import { verifyAntigravityExecutable } from './runtime-integrity';

// Kept apart from runtime.ts so status readers can resolve the executable
// without loading the ESM-only ACP client that runtime.ts imports.

export function antigravityEnvironment(
  environment: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = {
    ...getEnhancedEnv({
      environment: false,
      includeCanopySecrets: false,
    }),
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) =>
          ![
            'HOME',
            'USERPROFILE',
            'HOMEDRIVE',
            'HOMEPATH',
            'HOMESHARE',
            'ANTIGRAVITY_EXECUTABLE',
          ].includes(key.toUpperCase()),
      ),
    ),
  };
  for (const key of [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_GENAI_USE_VERTEXAI',
    // Neither the launching host nor workflow inputs may inject startup code
    // into the native process or its force_ask approval hook.
    'NODE_OPTIONS',
    'NODE_PATH',
    'BASH_ENV',
    'ENV',
    'SHELLOPTS',
    'BASHOPTS',
    'GCONV_PATH',
    'GLIBC_TUNABLES',
  ])
    delete env[key];
  for (const key of Object.keys(env)) {
    // A child receives each entry as `key=value`, so a key holding `=`
    // arrives as the variable named before it (`BASH_ENV=/w/x` with value
    // `y` arrives as BASH_ENV=/w/x=y), past every exact-name check here. An
    // empty or NUL-holding key names no variable at all.
    if (key === '' || /[=\0]/.test(key) || /^(LD_|DYLD_|BASH_FUNC_)/.test(key))
      delete env[key];
  }
  // Vendor CLI mode, not Canopy's Electron; unaffected by Canopy's fuse.
  env.ELECTRON_RUN_AS_NODE = '1';
  // The pinned runtime must not replace itself outside Canopy's qualification.
  // Neither the host nor workflow inputs may re-enable Google's self-update.
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  return env;
}

/**
 * The managed copy Canopy installed, when present and its bytes still match
 * the pinned executableSha256. A tampered or partial copy is skipped with a
 * warning so the override or PATH can still launch; cancellation propagates.
 * On Linux the launch check is this same pinned-digest check, so resolution
 * runs it through verifyAntigravityExecutable and shares its verdict per file
 * identity: the file is hashed once, not once here and again before spawn,
 * and an unchanged file is not hashed again on the next turn.
 */
async function resolveManagedAntigravityExecutable(
  rootDir: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const artifact = getAntigravityRuntimeArtifact();
  if (!artifact) return undefined;
  const executable = managedAntigravityExecutable(rootDir, artifact);
  try {
    await lstat(executable);
  } catch {
    return undefined;
  }
  try {
    if (hostPlatformOperatingSystem() === 'linux')
      await verifyAntigravityExecutable(executable, signal);
    else
      await verifyManagedExecutable(
        executable,
        artifact.executableSha256,
        signal ?? new AbortController().signal,
        'Antigravity',
      );
    return executable;
  } catch (error) {
    signal?.throwIfAborted();
    process.emitWarning(
      error instanceof Error ? error.message : String(error),
      { code: 'ANTIGRAVITY_MANAGED_RUNTIME_SKIPPED', detail: executable },
    );
    return undefined;
  }
}

/**
 * Launch order: the verified managed copy, then ANTIGRAVITY_EXECUTABLE, then
 * a PATH `agy`/`antigravity`. verifyAntigravityExecutable still checks the
 * signature (macOS) or pinned digest (Linux) and the version of whichever file
 * this returns. Hosts without a pinned artifact, including Windows, are
 * refused here, before any lookup.
 */
export async function resolveAntigravityExecutable(
  options: { managedRootDir?: string; signal?: AbortSignal } = {},
): Promise<string> {
  if (!isAntigravityPlatformSupported())
    throw new Error(
      'Google subscription chats are currently available on macOS and Linux (x64 and arm64).',
    );
  options.signal?.throwIfAborted();
  const managed = await resolveManagedAntigravityExecutable(
    options.managedRootDir ?? getAntigravityRuntimeRootDir(),
    options.signal,
  );
  if (managed) return managed;
  const env = antigravityEnvironment();
  const override = env.ANTIGRAVITY_EXECUTABLE?.trim();
  const executable = await resolveInstalledBinaryPath(
    ['agy', 'antigravity'],
    env,
    override,
  );
  if (executable) return executable;
  if (override)
    throw new Error(
      'The selected Antigravity executable is unavailable. Choose an installed Antigravity CLI.',
    );
  throw new Error(
    'Install Antigravity CLI 1.5.1 from Settings, then refresh Google models.',
  );
}
