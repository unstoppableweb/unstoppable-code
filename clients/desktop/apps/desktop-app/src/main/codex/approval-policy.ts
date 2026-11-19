import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import type { ApprovalMode } from '@canopy/desktop-shared/types';
import type { AskForApproval } from '@canopy/execution-engine/node/codex-runtime/generated/v2/AskForApproval';
import type { SandboxMode } from '@canopy/execution-engine/node/codex-runtime/generated/v2/SandboxMode';
import type { SandboxPolicy } from '@canopy/execution-engine/node/codex-runtime/generated/v2/SandboxPolicy';
import {
  CODEX_CONFINED_READ_ONLY_PROFILE,
  codexConfinedPermissionProfiles,
  agentSecretSandboxDeniedReadPaths,
} from '@canopy/execution-engine/node/codex-runtime/confined-sandbox';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { getAgentSecretAmbientEnvDir } from '../lib/paths';

/**
 * Maps a Canopy approval mode to the Codex app-server's `AskForApproval`
 * policy sent on `turn/start`, `thread/start`, `thread/resume`, and
 * `thread/fork`. Ask and Auto keep granular provider prompts for
 * sandbox escalations, exec-policy rules, skills, permission bundles, and MCP
 * elicitations. The read-only sandbox used by Ask and Auto ensures governed
 * writes and destructive workspace commands cannot execute without producing
 * one of those requests. `full-access` preserves today's behavior.
 */
export function codexApprovalPolicyFor(mode: ApprovalMode): AskForApproval {
  if (mode === 'full-access') {
    return 'never';
  }
  return {
    granular: {
      sandbox_approval: true,
      rules: true,
      skill_approval: true,
      request_permissions: true,
      mcp_elicitations: true,
    },
  };
}

/**
 * `turn/start`'s `sandboxPolicy` parameter (an object). `ask`/`auto` start in a
 * read-only sandbox with network access disabled, forcing file mutations and
 * destructive commands through Canopy's approval handlers. `full-access`
 * preserves today's danger-full-access behavior exactly.
 */
export function codexSandboxPolicyFor(
  mode: ApprovalMode,
  cwd: string,
): SandboxPolicy {
  void cwd;
  if (mode === 'full-access') {
    return { type: 'dangerFullAccess' };
  }
  return { type: 'readOnly', networkAccess: false };
}

/**
 * `thread/start` / `thread/resume` / `thread/fork`'s `sandbox` parameter (a
 * string enum, as opposed to `turn/start`'s object-shaped `sandboxPolicy`).
 */
export function codexSandboxModeFor(mode: ApprovalMode): SandboxMode {
  return mode === 'full-access' ? 'danger-full-access' : 'read-only';
}

/**
 * The permission profile a sandboxed (Ask or Accept edits) Codex chat runs
 * under on macOS and Linux: the built-in `:read-only` sandbox plus a read
 * deny for every chat's Full-access ambient secrets
 * (agent-secrets/ambient-env.ts), so one chat's sandboxed agent can't read
 * another chat's values. The legacy sandbox has no deny list, so these chats
 * select this named profile instead (confined-sandbox.ts, which also confines
 * helper and pipeline threads). Windows keeps the legacy sandbox: no ambient
 * file is written there.
 */
export const CODEX_CANOPY_READ_ONLY_PROFILE = CODEX_CONFINED_READ_ONLY_PROFILE;

function usesReadOnlyProfile(platform: PlatformOperatingSystem): boolean {
  return platform !== 'win32';
}

/** The paths no sandboxed Codex thread on this host may read. */
export function codexSandboxDeniedReadPathsFor(
  platform: PlatformOperatingSystem = hostPlatformOperatingSystem(),
): string[] {
  if (!usesReadOnlyProfile(platform)) return [];
  // The current data root (a code-review chat's own, in its scope) and the
  // app's: both may hold chats' ambient secrets.
  return [
    ...new Set([
      getAgentSecretAmbientEnvDir(),
      ...agentSecretSandboxDeniedReadPaths([getCanopyDataDir()], platform),
    ]),
  ];
}

/** The `permissions` config table that defines the profiles. */
export function codexCanopyPermissionProfiles(
  platform: PlatformOperatingSystem = hostPlatformOperatingSystem(),
): ReturnType<typeof codexConfinedPermissionProfiles> {
  return codexConfinedPermissionProfiles(
    codexSandboxDeniedReadPathsFor(platform),
  );
}

/** Codex's built-in profile for the legacy `danger-full-access` sandbox. */
export const CODEX_DANGER_FULL_ACCESS_PROFILE = ':danger-full-access';

/**
 * The thread config's `default_permissions` for a mode, wherever the thread
 * config defines the confined profiles (macOS and Linux): the read-only
 * profile for a sandboxed thread, and Codex's built-in `:danger-full-access`
 * for a Full-access one. Native ChatGPT workspace routing rebuilds the
 * configuration from the thread config without the thread's typed `sandbox`
 * or `permissions` selection. A config that defines profiles but names no
 * default fails that rebuild before inference ("failed to load workspace
 * requirements: invalid input parameter", Codex 0.169, CAN-7253), so every
 * thread names its own: the rebuild keeps the thread's sandbox rather than
 * an ambient one. A later turn's legacy `sandboxPolicy` override still
 * applies over it. Null where no profiles are defined (Windows).
 */
export function codexDefaultPermissionsFor(
  mode: ApprovalMode,
  platform: PlatformOperatingSystem = hostPlatformOperatingSystem(),
): string | null {
  if (!usesReadOnlyProfile(platform)) return null;
  return mode === 'full-access'
    ? CODEX_DANGER_FULL_ACCESS_PROFILE
    : CODEX_CANOPY_READ_ONLY_PROFILE;
}

/**
 * `thread/start`, `thread/resume` and `thread/fork`'s sandbox selection:
 * `danger-full-access` in Full access, else the read-only profile (or the
 * legacy `read-only` mode where the profile isn't used).
 */
export function codexThreadSandboxFields(
  mode: ApprovalMode,
  platform: PlatformOperatingSystem = hostPlatformOperatingSystem(),
): { sandbox: SandboxMode } | { permissions: string } {
  if (mode === 'full-access' || !usesReadOnlyProfile(platform))
    return { sandbox: codexSandboxModeFor(mode) };
  return { permissions: CODEX_CANOPY_READ_ONLY_PROFILE };
}

/**
 * How a mode's thread is sandboxed: by the read-only profile, selected when
 * the thread opens, or by a legacy mode. A chat whose mode crosses between
 * the two reopens its thread (codex-session.ts), since Codex can't switch a
 * thread to a profile per turn: a `turn/start` `permissions` selection
 * reloads the configuration without the thread's profile definitions.
 */
export type CodexThreadSandboxKind = 'profile' | 'legacy';

export function codexThreadSandboxKind(
  mode: ApprovalMode,
  platform: PlatformOperatingSystem = hostPlatformOperatingSystem(),
): CodexThreadSandboxKind {
  return mode !== 'full-access' && usesReadOnlyProfile(platform)
    ? 'profile'
    : 'legacy';
}

/**
 * Whether a turn in `mode` must reopen its thread first: the mode is
 * sandboxed by the confined profile, but the thread opened in Full access or
 * a turn's legacy override has replaced its profile since. Only a reopen
 * restores the profile and its read denies; the legacy read-only policy has
 * none. Null: no thread is open yet.
 */
export function codexNeedsSandboxReopen(
  threadKind: CodexThreadSandboxKind | null,
  mode: ApprovalMode,
  platform: PlatformOperatingSystem = hostPlatformOperatingSystem(),
): boolean {
  return (
    threadKind !== null &&
    codexThreadSandboxKind(mode, platform) === 'profile' &&
    threadKind !== 'profile'
  );
}

/**
 * `turn/start`'s sandbox override, and how the thread is sandboxed after it.
 * A thread still on the profile it opened with keeps it (nothing to send).
 * Any other turn sends the mode's legacy policy, as before. Codex keeps a
 * turn's override for later turns, so once one is sent the thread is
 * `legacy` until it reopens: a Full-access turn on a profile thread whose
 * reopen is deferred (a delegation or background work is still running)
 * makes the next sandboxed turn send read-only again, never nothing.
 */
export function codexTurnSandbox(
  mode: ApprovalMode,
  cwd: string,
  threadKind: CodexThreadSandboxKind,
  platform: PlatformOperatingSystem = hostPlatformOperatingSystem(),
): {
  fields: { sandboxPolicy: SandboxPolicy } | Record<string, never>;
  threadKind: CodexThreadSandboxKind;
} {
  if (
    codexThreadSandboxKind(mode, platform) === 'profile' &&
    threadKind === 'profile'
  )
    return { fields: {}, threadKind: 'profile' };
  return {
    fields: { sandboxPolicy: codexSandboxPolicyFor(mode, cwd) },
    threadKind: 'legacy',
  };
}
