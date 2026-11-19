import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import path from 'node:path';
import type { JsonValue } from './generated/serde_json/JsonValue';
import type { SandboxMode } from './generated/v2/SandboxMode';
import { getCodexRuntimeHostHooks } from './host-hooks';

/*
 * Codex sandboxes that also deny reads of paths the host names (the desktop's
 * Full-access agent secrets: agent-secrets/ambient-env.ts). The legacy
 * `read-only` and `workspace-write` modes have no deny list, so a sandboxed
 * thread selects a named permissions profile that extends the matching
 * built-in (`:read-only`, `:workspace`) and adds the denies; everything else
 * the built-in allows stays the same.
 *
 * The profiles live in the thread config, and a confined thread's config
 * makes its profile the `default_permissions`, so a configuration rebuilt
 * without the thread's typed selection (native ChatGPT routing) keeps it,
 * as delegated Codex threads do. A Full-access chat thread that defines them
 * names the built-in `:danger-full-access` instead (approval-policy.ts):
 * Codex 0.169 fails that rebuild for a config with profiles and no default.
 * They are not defined in the app-server's
 * spawn `-c` overrides: Codex 0.167 refuses a process configuration that
 * defines profiles without a process-wide `default_permissions`, and one
 * there would also apply to Full-access threads.
 */

/**
 * Where a data root keeps chats' Full-access ambient secrets: one
 * owner-only directory per provider launch (desktop
 * agent-secrets/ambient-env.ts). Every host that runs sandboxed Codex
 * threads over that data root denies it.
 */
export function agentSecretAmbientEnvDirUnder(dataRoot: string): string {
  return path.join(dataRoot, 'agent-secrets', 'ambient');
}

/**
 * The read denies for a data root on `platform`: none on Windows, which
 * writes no ambient file.
 */
export function agentSecretSandboxDeniedReadPaths(
  dataRoots: readonly string[],
  platform: PlatformOperatingSystem = hostPlatformOperatingSystem(),
): string[] {
  if (platform === 'win32') return [];
  return [...new Set(dataRoots.map(agentSecretAmbientEnvDirUnder))];
}

/** The `read-only` sandbox plus the host's read denies. */
export const CODEX_CONFINED_READ_ONLY_PROFILE = 'canopy_read_only';
/** The `workspace-write` sandbox plus the host's read denies. */
export const CODEX_CONFINED_WORKSPACE_PROFILE = 'canopy_workspace';

// A type alias, not an interface, so it stays assignable to a thread's JSON
// config.
type ConfinedProfile = {
  readonly extends: string;
  readonly filesystem: Readonly<Record<string, 'deny'>>;
};

type ThreadConfig = { [key in string]?: JsonValue };

/** The paths every Codex sandbox on this host must not read. */
export function codexSandboxDeniedReadPaths(): readonly string[] {
  return getCodexRuntimeHostHooks().sandboxDeniedReadPaths?.() ?? [];
}

/** The profiles' definitions, or null when the host denies nothing. */
export function codexConfinedPermissionProfiles(
  deniedPaths: readonly string[] = codexSandboxDeniedReadPaths(),
): Record<string, ConfinedProfile> | null {
  if (!deniedPaths.length) return null;
  const filesystem = Object.fromEntries(
    deniedPaths.map((entry) => [entry, 'deny'] as const),
  );
  return {
    [CODEX_CONFINED_READ_ONLY_PROFILE]: { extends: ':read-only', filesystem },
    [CODEX_CONFINED_WORKSPACE_PROFILE]: { extends: ':workspace', filesystem },
  };
}

/** The confined profile for a legacy sandbox mode, if it has one. */
export function codexConfinedProfileFor(
  sandbox: SandboxMode | null | undefined,
): string | null {
  if (sandbox === 'read-only') return CODEX_CONFINED_READ_ONLY_PROFILE;
  if (sandbox === 'workspace-write') return CODEX_CONFINED_WORKSPACE_PROFILE;
  return null;
}

/**
 * A thread config with the profiles defined and `profile` as its default.
 * Keeps any profiles the config already defines.
 */
export function withCodexConfinedProfiles(
  config: ThreadConfig | null | undefined,
  profile: string | null,
  deniedPaths: readonly string[] = codexSandboxDeniedReadPaths(),
): ThreadConfig | null | undefined {
  const profiles = codexConfinedPermissionProfiles(deniedPaths);
  if (!profiles) return config;
  const existing = config?.permissions;
  return {
    ...(config ?? {}),
    permissions: {
      ...(existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : {}),
      ...profiles,
    },
    ...(profile ? { default_permissions: profile } : {}),
  };
}

interface SandboxedThreadParams {
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  config?: ThreadConfig | null;
}

/**
 * Confines a non-interactive thread's legacy `read-only` or
 * `workspace-write` sandbox: selects the matching profile instead, defined in
 * the thread config. A thread that selects its own profile, runs without a
 * sandbox, or runs on a host that denies nothing is left as it is.
 */
export function confineCodexThreadSandbox<P extends SandboxedThreadParams>(
  params: P,
  deniedPaths: readonly string[] = codexSandboxDeniedReadPaths(),
): P {
  const confined = codexConfinedProfileFor(params.sandbox);
  if (!confined || params.permissions || !deniedPaths.length) return params;
  return {
    ...params,
    // Absent to the app-server, which refuses a profile beside a mode.
    sandbox: null,
    permissions: confined,
    config: withCodexConfinedProfiles(params.config, confined, deniedPaths),
  };
}
