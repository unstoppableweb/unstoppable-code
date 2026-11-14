import { setOutput } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import {
  PIPELINE_HOST_FAILURE_REASON_OUTPUT,
  type PipelineHostFailureReason,
} from '../../pipelines/host-actions';
import {
  emptyCreateWorktreeOutputs,
  parseCreateWorktreeInputs,
  type CreateWorktreeInputs,
} from '../../pipelines/host-create-worktree';

const INPUT_NAMES = [
  'project_id',
  'workspace_id',
  'branch',
  'existing_branch',
  'base_branch',
  'base_task_id',
  'base_worktree_id',
  'repair',
  'restore_claude_md',
  'worktree_setup',
  'group',
] as const;

function readInputs(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const inputs: Record<string, string | undefined> = {};
  for (const name of INPUT_NAMES) {
    inputs[name] = env[`INPUT_${name.toUpperCase()}`];
  }
  return inputs;
}

function writeOutputs(outputs: Record<string, string>): void {
  for (const [name, value] of Object.entries(outputs)) {
    setOutput(name, value);
  }
}

/** Writes every output empty with the typed reason, then fails the step. */
function refuse(
  failureReason: PipelineHostFailureReason,
  message: string,
): never {
  writeOutputs({
    ...emptyCreateWorktreeOutputs(),
    [PIPELINE_HOST_FAILURE_REASON_OUTPUT]: failureReason,
  });
  throw new Error(message);
}

/**
 * The first input only the desktop app supports, in documented order. The
 * shared CLI service has no existing-branch option, never stacks on a base
 * worktree, and can't reach sidebar groups or desktop setup.
 */
function firstDesktopOnlyInput(
  parsed: CreateWorktreeInputs,
  inputs: Record<string, string | undefined>,
): string | undefined {
  if (parsed.branch.kind === 'existing') return 'existing_branch';
  if (parsed.baseTaskId !== undefined) {
    return inputs.base_task_id?.trim() ? 'base_task_id' : 'base_worktree_id';
  }
  if (parsed.group !== undefined) return 'group';
  if (parsed.setup !== 'skip') return 'worktree_setup';
  return undefined;
}

export async function runCreateWorktreeAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, () => {
    const inputs = readInputs(env);
    const parsed = parseCreateWorktreeInputs(inputs);
    if (!parsed.ok) {
      refuse('validation_failed', parsed.message);
    }
    const desktopOnly = firstDesktopOnlyInput(parsed.value, inputs);
    if (desktopOnly !== undefined) {
      refuse(
        'needs_desktop',
        `create-worktree "${desktopOnly}" needs the desktop app.`,
      );
    }
    refuse(
      'target_not_ready',
      'create-worktree needs the CLI host adapter to save through the core daemon.',
    );
  });
}
