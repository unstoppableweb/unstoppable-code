import type { ApprovalMode } from '@canopy/desktop-shared/types';
import type { AskForApproval } from '@canopy/execution-engine/node/codex-runtime/generated/v2/AskForApproval';
import type { SandboxMode } from '@canopy/execution-engine/node/codex-runtime/generated/v2/SandboxMode';
import type { SandboxPolicy } from '@canopy/execution-engine/node/codex-runtime/generated/v2/SandboxPolicy';

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
