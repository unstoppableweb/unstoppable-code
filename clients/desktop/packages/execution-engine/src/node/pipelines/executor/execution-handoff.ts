import * as fs from 'node:fs/promises';
import { writeFileAtomically } from '../../lib/atomic-file';
import {
  ExecutionStateWriteRefusedError,
  executionStoreEntries,
  installRestoredExecutionState,
  isExecutionStateWriteRefusal,
  type RestoredExecutionStateInstall,
} from './execution-state';
import { pipelineOwnerFence } from './owner-fence';

/*
 * The handoff of one execution between cloud runner incarnations (CAN-6198,
 * cloud pipelines CP-08). It carries the whole execution, not only its state
 * file: the directory holds the host-step journals under
 * `host/<sha256(idempotencyKey)>/` (with `wait-for-agent-reply`'s
 * `binding.json` and the setup logs `create-worktree` copied), the step logs
 * and the outputs, and they are what make a replay safe. A handoff is laid
 * out as an executions directory of its own: `<id>.json`, `<id>.cancel`
 * when a cancellation is pending, and `<id>/`.
 *
 * State paths are absolute, so an incarnation restores into the same data
 * root its layout gives every incarnation. The transfer between sandboxes
 * is the runner's checkpoint operation (CP-11).
 */

function fileErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  if (!(await exists(from))) return;
  await fs.cp(from, to, {
    recursive: true,
    force: true,
    errorOnExist: false,
    verbatimSymlinks: true,
  });
}

/**
 * Copies one execution from `executionsDir` into `destination`. The state
 * is taken first, so everything it names is in the directory copied after
 * it; a journal newer than the state is what a replay reuses.
 */
export async function exportExecutionHandoff(
  executionsDir: string,
  executionId: string,
  destination: string,
): Promise<void> {
  const from = executionStoreEntries(executionId, executionsDir);
  const to = executionStoreEntries(executionId, destination);
  const state = await fs.readFile(from.state, 'utf8');
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  // A handoff holds one export of the run: nothing an earlier one left.
  await fs.rm(to.directory, { recursive: true, force: true });
  await fs.rm(to.cancellation, { force: true });
  await writeFileAtomically(to.state, state, {
    encoding: 'utf8',
    durable: true,
  });
  if (await exists(from.cancellation))
    await fs.copyFile(from.cancellation, to.cancellation);
  await copyTree(from.directory, to.directory);
}

/**
 * Restores one execution from a handoff into `executionsDir`: its directory
 * and cancellation marker first, then its state through the store's write
 * admission, all under the execution's write lock, so a state file is
 * present only once everything it names is. A store that already holds the
 * execution keeps it, directory and all (`already_present`). A runner whose
 * lease ended restores nothing.
 */
export async function restoreExecutionHandoff(
  source: string,
  executionsDir: string,
  executionId: string,
): Promise<RestoredExecutionStateInstall> {
  if (pipelineOwnerFence().fenced.aborted)
    throw new ExecutionStateWriteRefusedError(executionId, 'owner_fenced');
  const from = executionStoreEntries(executionId, source);
  const to = executionStoreEntries(executionId, executionsDir);
  const document: unknown = JSON.parse(await fs.readFile(from.state, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error(`The handoff of execution "${executionId}" has no state.`);
  const record: Readonly<Record<string, unknown>> = { ...document };
  const copied: string[] = [];
  return installRestoredExecutionState(executionId, executionsDir, record, {
    prepare: async () => {
      if (!(await exists(to.directory))) copied.push(to.directory);
      await copyTree(from.directory, to.directory);
      if (await exists(from.cancellation)) {
        if (!(await exists(to.cancellation))) copied.push(to.cancellation);
        await fs.copyFile(from.cancellation, to.cancellation);
      }
    },
    // A restore refused after its copy leaves nothing it copied behind.
    rollback: async (error) => {
      if (!isExecutionStateWriteRefusal(error, 'owner_fenced')) return;
      await Promise.all(
        copied.map((target) => fs.rm(target, { recursive: true, force: true })),
      );
    },
  });
}
