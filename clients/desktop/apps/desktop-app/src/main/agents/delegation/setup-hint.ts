import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { ScriptDefinition } from '@canopy/desktop-shared/scripts';
import {
  getResolvedScriptDefinition,
  resolveProjectScripts,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
  type ResolvedScriptMap,
} from '../../lib/script-resolver';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { getWorkspaceType } from '../../lib/workspace-registry';

/** Keeps a pathological setup command from crowding out the task prompt. */
const MAX_SETUP_COMMAND_CHARACTERS = 4_000;

interface SetupScript {
  readonly name: string;
  readonly definition: ScriptDefinition;
}

function scripts(
  resolved: ResolvedScriptMap,
  names: readonly string[],
): SetupScript[] {
  return names.flatMap((name) => {
    const definition = getResolvedScriptDefinition(resolved, name);
    return definition?.command.trim() ? [{ name, definition }] : [];
  });
}

/**
 * Resolves the setup scripts that worktree creation would run for the
 * delegate's checkout. Configuration is read from the delegate's own copy
 * (the parent's committed revision) plus the machine-local overrides.
 */
async function resolveSetupScripts(options: {
  readonly projectId: string;
  readonly selectedRepoId?: string;
  readonly delegateCwd: string;
}): Promise<SetupScript[]> {
  const type = getWorkspaceType(options.projectId);
  if (type === 'single-repo') {
    const { items } = await readAllSidebarItems();
    const project = items.find(
      (item) => item.type === 'single-repo' && item.id === options.projectId,
    );
    if (!project || project.type !== 'single-repo') return [];
    return scripts(
      await resolveProjectScripts(
        { repoPath: project.repoPath, scripts: project.scripts },
        options.delegateCwd,
      ),
      ['setup'],
    );
  }
  if (type !== 'multi-repo') return [];
  if (
    options.selectedRepoId &&
    options.selectedRepoId !== WORKSPACE_ROOT_REPO_ID
  )
    return scripts(
      await resolveWorkspaceRepoScripts(
        options.projectId,
        options.selectedRepoId,
        { repoPath: options.delegateCwd },
      ),
      ['setup'],
    );
  // Child repositories are separate checkouts, so an isolated copy of the
  // workspace root only carries the root's own setup hooks.
  return scripts(
    await resolveWorkspaceRootScripts(options.projectId, {
      workspaceRootPath: options.delegateCwd,
    }),
    ['before-setup', 'after-setup'],
  );
}

function boundedCommand(command: string): string {
  return command.length <= MAX_SETUP_COMMAND_CHARACTERS
    ? command
    : `${command.slice(0, MAX_SETUP_COMMAND_CHARACTERS)}\n# (command truncated; read the project's script configuration for the rest)`;
}

function describeScript(script: SetupScript): string {
  const shell =
    process.platform === 'win32'
      ? script.definition.shell?.windows
      : script.definition.shell?.mac;
  return [
    `${script.name}${shell ? ` (configured shell: ${shell})` : ''}${
      script.definition.interactive
        ? ' — configured as interactive and may prompt for input; run it only if it can finish unattended, otherwise report that setup is required'
        : ''
    }:`,
    '```',
    boundedCommand(script.definition.command.trim()),
    '```',
  ].join('\n');
}

export function isolatedDelegationSetupHint(
  setupScripts: readonly SetupScript[],
  harness:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode',
): string | undefined {
  if (!setupScripts.length) return undefined;
  // Both harnesses keep long commands in a managed task the model can check:
  // Claude's run_in_background task, or Codex's pollable exec session.
  const run =
    harness === 'opencode'
      ? 'Before building or testing, run the setup script with bash from this working directory and confirm it completes. Do not detach background processes. Commands follow the parent approval policy.'
      : harness === 'copilot'
        ? 'Before building or testing, run the setup script with bash or powershell from this working directory and confirm it completes. Use read_bash or read_powershell to check a running command. Do not detach background processes. Commands follow the parent approval policy.'
        : harness === 'cursor'
          ? 'Before building or testing, run the setup script with Shell from this working directory and confirm it completes. Do not detach background processes. Commands follow the parent approval policy.'
          : harness === 'claude'
            ? 'Start the setup script now with Bash from this working directory, using run_in_background: true. Continue with read-only work meanwhile. You are notified when it finishes, and you can Read the output file the Bash result reports; confirm it succeeded before you build, run, or test anything that needs it. Background tasks end with this run.'
            : 'Before you build, run, or test anything that needs them, start the setup script from this working directory with exec_command. If it is still running when the call returns, continue with read-only work and poll its session with write_stdin until it finishes. Your shell sandbox blocks network access and writes outside your granted paths, so if setup cannot complete, report the missing dependencies instead of working around the sandbox.';
  return [
    `Isolated worktree setup: this working directory is a fresh checkout of the parent's last commit. The parent's uncommitted changes are not included, and the project's setup script has not run here, so dependencies and generated files may be missing. ${run}`,
    setupScripts.length === 1
      ? 'Setup script:'
      : 'Setup scripts, in the order worktree setup runs them:',
    ...setupScripts.map(describeScript),
    'These scripts were configured for the parent worktree. If one relies on app-provided environment variables that are unset here, adapt the invocation rather than editing the script, and report any setup failure in your result.',
  ].join('\n\n');
}

/** Returns a prompt hint for an isolated delegate, or nothing when no setup
 * script applies. Configuration errors never block the launch. */
export async function resolveIsolatedDelegationSetupHint(options: {
  readonly projectId: string;
  readonly selectedRepoId?: string;
  readonly delegateCwd: string;
  readonly harness:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
}): Promise<string | undefined> {
  try {
    return isolatedDelegationSetupHint(
      await resolveSetupScripts(options),
      options.harness,
    );
  } catch {
    return undefined;
  }
}
