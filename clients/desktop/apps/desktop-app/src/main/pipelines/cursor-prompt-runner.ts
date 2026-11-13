import { runCursorPromptWithDriver } from '@canopy/desktop-shared/node/pipelines/cursor-prompt-runner';
import {
  SETUP_WITHDRAWN,
  createSetupWithdrawal,
  stepTimedOutMessage,
} from '@canopy/execution-engine/node/pipelines/step-timeout';
import type {
  CursorPromptRunnerRequest,
  CursorPromptRunnerResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  cursorBaseEnvironment,
  getManagedCursorRuntime,
} from '../cursor/connection';
import { isCursorHarnessEnabled } from '../cursor/feature-flag';
import { cursorConnectionStatus } from '../cursor/runtime-status';
import { spawnProviderProcess } from '../agent-runs/provider-process-host';

const CONNECT_MESSAGE = 'Connect Cursor in Settings to run this step.';

export async function runCursorPipelinePrompt(
  request: CursorPromptRunnerRequest,
): Promise<CursorPromptRunnerResult> {
  // The step's budget starts HERE, at the true entry — the connection probe and
  // the runtime digest below are part of the step the user gave a timeout to.
  const budgetStartedAt = request.budgetStartedAt ?? Date.now();
  const budgetRemainingMs = (): number =>
    budgetStartedAt + request.totalTimeoutMs - Date.now();
  const cancelled = (): CursorPromptRunnerResult => ({
    status: 'cancelled',
    transcript: '',
    failure: {
      version: 1,
      provider: 'cursor',
      agent_harness: 'cursor',
      had_agent_activity: false,
      message: 'Cursor workflow turn was cancelled.',
    },
  });
  const failure = (message: string): CursorPromptRunnerResult => ({
    status: 'failure',
    transcript: '',
    failure: {
      version: 1,
      provider: 'cursor',
      agent_harness: 'cursor',
      had_agent_activity: false,
      message,
    },
  });
  if (!isCursorHarnessEnabled())
    return failure('Cursor is not available on this device.');
  const signal = request.signal ?? new AbortController().signal;

  /**
   * Withdrawal from pending setup.
   *
   * Checking the clock before and after an `await` is accounting, not
   * enforcement: a probe that never settles leaves the step pending for as long
   * as it takes, whatever the declared budget says. This races every setup step
   * against the caller's abort and the step's own remaining budget, and threads
   * the signal INTO the operations that accept one so the work is cancelled
   * rather than orphaned. Shared with the CLI runner so the two cannot drift.
   */
  const withdrawal = createSetupWithdrawal(signal, budgetRemainingMs());
  /** Cancellation and an expired budget are distinct outcomes. */
  const withdrawnResult = (): CursorPromptRunnerResult =>
    withdrawal.reason === 'cancelled'
      ? cancelled()
      : failure(stepTimedOutMessage(request.totalTimeoutMs));

  // One owner for the withdrawal's timer and listeners: every exit below,
  // including a thrown one, goes through this `finally`.
  try {
    return await runSetupAndTurn();
  } finally {
    withdrawal.release();
  }

  async function runSetupAndTurn(): Promise<CursorPromptRunnerResult> {
    // A caller that has already cancelled must not wait for readiness at all.
    if (withdrawal.withdrawn) return withdrawnResult();

    const status = await withdrawal.race(
      cursorConnectionStatus().catch(() => undefined),
    );
    if (status === SETUP_WITHDRAWN) return withdrawnResult();
    if (!status || !(status.supported && status.enabled && status.installed))
      return failure(CONNECT_MESSAGE);
    // Launch/target resolution does not depend on the environment scope
    // (`installer.verify` never reads it), so the scope is threaded only into
    // `cursorBaseEnvironment` below — the one place it actually reaches the
    // spawned child, mirroring how the Codex runner's
    // `resolveCodexRuntimeEnvironmentProfile({ runtime: 'pipeline', ... })`
    // result feeds the Codex spawn profile's `environment`.
    // Resolution can still reject after the gates above pass: those only check
    // that the files are present and executable, while `installer.verify` does
    // the full digest. A present-but-corrupt runtime used to escape here as a
    // bare exception into the generic step catch, which writes `String(error)`
    // with no `agent_failure_metadata_file`, no `provider: 'cursor'`
    // classification, no guidance, and — unlike every other failure path — no
    // secret-value redaction of the message. The documented contract is a
    // `failure` result before any spawn, so it is produced here.
    if (withdrawal.withdrawn) return withdrawnResult();
    // The digest gets the WITHDRAWAL signal, not just the caller's: it is a
    // long, globally serialized verification, and the caller's own budget has to
    // bound its queue wait and its active work without weakening any check.
    const managed = await withdrawal.race(
      getManagedCursorRuntime(withdrawal.signal).then(
        (resolved) => resolved,
        // A cancelled run is NOT a disconnected runtime. Mapping every rejection
        // to the connect sentence told a user who cancelled that their
        // installation was missing, and buried the real reason.
        () => undefined,
      ),
    );
    if (managed === SETUP_WITHDRAWN) return withdrawnResult();
    if (!managed) {
      if (withdrawal.withdrawn) return withdrawnResult();
      // The canonical single form documented in `docs/ux-writing.md`. Appending
      // the raw resolver detail produced a two-sentence string that is not that
      // form, and the detail is already in the step's own diagnostics.
      return failure(CONNECT_MESSAGE);
    }
    if (withdrawal.withdrawn) return withdrawnResult();
    return runCursorPromptWithDriver(
      { ...request, budgetStartedAt },
      {
        launch: managed.launch,
        target: managed.target,
        spawner: spawnProviderProcess,
        baseEnvironment: cursorBaseEnvironment({
          runtime: 'pipeline',
          ...(request.projectId ? { workspaceId: request.projectId } : {}),
        }),
      },
    );
  }
}
