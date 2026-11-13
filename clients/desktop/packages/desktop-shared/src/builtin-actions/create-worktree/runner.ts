import { selectW5WritePath } from '../../node/w5-routed-writes/selector';
import { setOutput } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { getCanopyDataDir } from '../../canopy-paths';
import {
  registerW5Host,
  W5HostCohortRefusedError,
} from '@canopy/execution-engine/node/w5-host-cohort';
import { getWorkspaceItem } from '../../node/lib/workspace-service';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  getWorktreeCliRecord,
} from '../../node/lib/worktree-service';
import {
  PIPELINE_HOST_FAILURE_REASON_OUTPUT,
  type PipelineHostFailureReason,
} from '../../pipelines/host-actions';
import {
  createWorktreeIdentifierOutputs,
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
  await runWithActionEnvironment(env, async () => {
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
    if (selectW5WritePath() === 'routed') {
      refuse(
        'target_not_ready',
        'create-worktree needs the CLI host adapter to save through the core daemon.',
      );
    }
    const { projectId: workspaceId, branch, baseBranch, repair } = parsed.value;
    const branchName = branch.kind === 'new' ? branch.name : undefined;

    // TRANSITIONAL (CAN-3797): this detached child writes W5 through the shared
    // writers, so it joins the host cohort before its first read. Remove when
    // the W5 rows move to `daemon` and those writers are deleted (CAN-3802).
    try {
      await registerW5Host({
        dataRoot: getCanopyDataDir(),
        hostKind: 'create-worktree',
      });
    } catch (error) {
      if (!(error instanceof W5HostCohortRefusedError)) throw error;
      refuse('target_not_ready', error.message);
    }

    const workspace = await getWorkspaceItem(workspaceId);
    if (workspace.type === 'cowork') {
      refuse(
        'unsupported_action',
        `Project \`${workspaceId}\` doesn't support worktrees. Use create-project-entry.`,
      );
    }
    const created =
      workspace.type === 'multi-repo'
        ? await createMultiRepoWorktree({
            workspaceId,
            branchName,
            baseBranch,
            repairWorkspaceRoot: repair,
            restoreClaudeMd: parsed.value.restoreClaudeMd,
            startPostCreateSetup: false,
          })
        : await createSingleRepoWorktree({
            workspaceId,
            branchName,
            baseBranch,
            startPostCreateSetup: false,
          });

    const record = await getWorktreeCliRecord(workspaceId, created.id);
    writeOutputs({
      ...emptyCreateWorktreeOutputs(),
      ...createWorktreeIdentifierOutputs(workspaceId, record.id),
      path: record.path,
      branch_name: record.branchName,
      created_at: record.createdAt,
      setup_state: 'skipped',
      [PIPELINE_HOST_FAILURE_REASON_OUTPUT]: '',
    });
  });
}
