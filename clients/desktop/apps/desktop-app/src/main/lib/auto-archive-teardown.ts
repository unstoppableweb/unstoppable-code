import type { ScriptRunRequest } from '@canopy/desktop-shared/types';
import { cancelWorktreeSetup, runScript } from '../services/scripts-service';
import { readWorkspaceConfig } from './workspace-persistence';

export class AutoArchiveTeardownFailedError extends Error {
  constructor(
    message: string,
    readonly code: 'TEARDOWN_TIMEOUT' | 'TEARDOWN_FAILED' = 'TEARDOWN_FAILED',
  ) {
    super(message);
    this.name = 'AutoArchiveTeardownFailedError';
  }
}

/**
 * Resolve the same configured scripts as manual deletion; failures preserve
 * the target. `operation` names the deletion in a failure message.
 */
export async function runAutoArchiveTeardown(
  workspaceId: string,
  worktreeId: string,
  multiRepo: boolean,
  operation = 'Auto Delete',
): Promise<void> {
  // Teardown must not run beside a setup the deletion is about to discard.
  await cancelWorktreeSetup({ projectId: workspaceId, worktreeId });
  const run = async (request: ScriptRunRequest): Promise<void> => {
    const result = await runScript(request);
    if (!result.success) {
      throw new AutoArchiveTeardownFailedError(
        `${operation} ${request.scriptName} failed${result.timedOut ? ' (timed out)' : ''}: ${result.output}`,
        result.timedOut ? 'TEARDOWN_TIMEOUT' : 'TEARDOWN_FAILED',
      );
    }
  };
  if (!multiRepo) {
    await run({
      target: 'project',
      projectId: workspaceId,
      worktreeId,
      scriptName: 'teardown',
    });
    return;
  }
  const config = await readWorkspaceConfig(workspaceId);
  await run({
    target: 'workspace-root',
    workspaceId,
    worktreeId,
    scriptName: 'before-teardown',
  });
  const results = await Promise.allSettled(
    (config.repos ?? []).map((repo) =>
      run({
        target: 'workspace-repo',
        workspaceId,
        worktreeId,
        repoId: repo.id,
        scriptName: 'teardown',
      }),
    ),
  );
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  const unexpected = errors.filter(
    (error) => !(error instanceof AutoArchiveTeardownFailedError),
  );
  if (unexpected.length) throw unexpected[0];
  if (errors.length)
    throw new AutoArchiveTeardownFailedError(
      errors.map(String).join('; '),
      errors.some(
        (error) =>
          error instanceof AutoArchiveTeardownFailedError &&
          error.code === 'TEARDOWN_TIMEOUT',
      )
        ? 'TEARDOWN_TIMEOUT'
        : 'TEARDOWN_FAILED',
    );
  await run({
    target: 'workspace-root',
    workspaceId,
    worktreeId,
    scriptName: 'after-teardown',
  });
}
