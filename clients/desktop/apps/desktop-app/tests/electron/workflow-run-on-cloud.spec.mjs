import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startCloudPipelinesWebCore } from './fixtures/cloudPipelinesWebCore.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

// CAN-6187 (cloud pipelines CP-37): the workflow Run dialog's "Run on: This
// computer / Cloud" choice, against the built app and a fake web core (there
// is no cloud runner yet). The location is its own field, apart from where
// the run goes:
//   - Run on shows only while this computer's web core reports cloud runs
//     available, as `pipelines:cloud-runs-availability` answers;
//   - each destination (No project, the current task) runs on this computer
//     through the unchanged local start, and the web core is never asked;
//   - Cloud with No project asks for a cloud model for the step the cloud
//     can't run as written, then starts in the web core with scope.targetId
//     set to the cloud target and the confirmed model, and nothing runs here;
//   - Cloud with the current task (CAN-6869) runs at the task's pushed
//     branch: a task whose origin isn't on GitHub is refused; unpushed
//     commits and uncommitted changes are warned about first, nothing is
//     pushed until the person confirms, and the start names the branch and
//     pushed head, sent again while its cloud worktree is set up; a workflow
//     that exists only on this computer can't pick Cloud;
//   - the last choice is remembered per workflow;
//   - `pipelines:execute` with any other execution target is refused, never
//     run on this computer.

const WORKTREE_BRANCH = 'demo-main';
const CLOUD_WORKFLOW = 'Anywhere review';
const LOCAL_PIPELINE_ID = 'run-on-local-review';
const LOCAL_PIPELINE = 'Local-only review';
const RUNNABLE = (name) =>
  `name: ${name}\non: dispatch\nscope: [global, worktree, directory]\njobs:\n  review:\n    steps:\n      - run: echo reviewed\n`;

/** Picks the first owner when the account offers more than Personal. */
async function pickOwner(window) {
  const ownerSelect = window.getByTestId('pipeline-run-owner-select');
  if (await ownerSelect.isVisible().catch(() => false)) {
    await ownerSelect.click();
    await window.getByRole('option').first().click();
  }
}

/** Opens the Run dialog from the local workflow's Library row and picks `name`. */
async function openRunDialog(window, app, name) {
  await app.openPipelinesPage();
  await app.searchWorkflowsLibrary(LOCAL_PIPELINE);
  const row = app.workflowsLibraryPipelineRow(LOCAL_PIPELINE_ID);
  await expect(row).toBeVisible();
  await row.getByTestId('workflows-library-run').click();
  const modal = window.getByTestId('pipeline-trigger-modal-body');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name }).click();
  const continueButton = window.getByTestId('pipeline-trigger-modal-run');
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(window.getByTestId('pipeline-run-context-fields')).toBeVisible();
  // A run with no project names its owner.
  await pickOwner(window);
  return modal;
}

async function listExecutions(window) {
  const result = await window.evaluate(() => window.pipelines.listExecutions());
  expect(result.success).toBe(true);
  return result.data;
}

async function runAndClose(window) {
  const run = window.getByTestId('pipeline-trigger-modal-run');
  await expect(run).toBeEnabled();
  await run.click();
  await expect(window.getByTestId('pipeline-trigger-modal-body')).toBeHidden({
    timeout: 30_000,
  });
}

test('Run on keeps each destination on this computer and starts a cloud run in the web core', async () => {
  test.setTimeout(240_000);
  const cloud = await startCloudPipelinesWebCore({
    workflowName: CLOUD_WORKFLOW,
    rawPipeline: RUNNABLE(CLOUD_WORKFLOW),
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'run-on-cloud-'));
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seeded.workspaces.find(
    (workspace) => workspace.worktreePath,
  )?.worktreePath;
  expect(worktreePath).toBeTruthy();
  const git = (...args) =>
    execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8' }).trim();
  seedStoredPipeline({
    userDataDir,
    id: LOCAL_PIPELINE_ID,
    name: LOCAL_PIPELINE,
    yaml: RUNNABLE(LOCAL_PIPELINE),
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Signed out, no web core reports cloud runs: no Run on at all.
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await openRunDialog(window, app, LOCAL_PIPELINE);
    await expect(window.getByTestId('pipeline-run-location')).toBeVisible();
    await expect(window.getByTestId('pipeline-run-on')).toHaveCount(0);
    await window.getByTestId('pipeline-trigger-modal-cancel').click();
    expect(
      await window.evaluate(() => window.pipelines.cloudRunsAvailability()),
    ).toEqual({ pipelineCloudRuns: false });

    cloud.state.cloudRuns = true;
    await connectMockCloudAccount(window, 'csk_run_on_cloud');
    expect(
      await window.evaluate(() => window.pipelines.cloudRunsAvailability()),
    ).toEqual({ pipelineCloudRuns: true });

    // A workflow only this computer has can't pick Cloud.
    await openRunDialog(window, app, LOCAL_PIPELINE);
    await expect(window.getByTestId('pipeline-run-on')).toBeVisible();
    await expect(window.getByTestId('pipeline-run-on-local')).toBeChecked();
    await expect(window.getByTestId('pipeline-run-on-cloud')).toBeDisabled();
    await window.getByTestId('pipeline-trigger-modal-cancel').click();

    // This computer, No project: the local start, nothing in the cloud.
    const before = (await listExecutions(window)).length;
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await window.getByTestId('pipeline-run-location-global').click();
    await window.getByTestId('pipeline-run-on-local').click();
    await runAndClose(window);
    await expect
      .poll(async () => (await listExecutions(window)).length)
      .toBe(before + 1);
    const globalRun = (await listExecutions(window)).find(
      (run) => run.pipeline_name === CLOUD_WORKFLOW && !run.worktree_id,
    );
    expect(globalRun).toBeTruthy();

    // This computer, the current task.
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await window.getByTestId('pipeline-run-location-current-task').click();
    await expect(window.getByTestId('pipeline-run-on-local')).toBeChecked();
    await runAndClose(window);
    await expect
      .poll(async () => (await listExecutions(window)).length)
      .toBe(before + 2);
    expect(
      (await listExecutions(window)).some(
        (run) => run.pipeline_name === CLOUD_WORKFLOW && run.worktree_id,
      ),
    ).toBe(true);
    expect(cloud.state.starts).toEqual([]);
    expect(cloud.state.preflights).toEqual([]);

    // Cloud, No project: the web core refuses the start until the model step
    // has a confirmed cloud model, recording nothing; the dialog asks, then
    // the start goes with the choice.
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await window.getByTestId('pipeline-run-location-global').click();
    await window.getByTestId('pipeline-run-on-cloud').click();
    await pickOwner(window);
    await expect(window.getByTestId('pipeline-run-on-blocked')).toHaveCount(0);
    await window.getByTestId('pipeline-trigger-modal-run').click();
    const models = window.getByTestId('cloud-model-replacement-dialog');
    await expect(models).toBeVisible();
    expect(cloud.state.starts).toEqual([]);
    expect(cloud.state.refusedStarts).toHaveLength(1);
    await models.getByTestId('cloud-model-replacement-select').click();
    await window.getByRole('option', { name: 'Opus 5.5' }).click();
    await models.getByTestId('cloud-model-replacement-confirm').click();
    await expect(models).toBeHidden({ timeout: 30_000 });
    await expect(
      window.getByTestId('pipeline-trigger-modal-body'),
    ).toBeHidden();
    await expect.poll(() => cloud.state.starts.length).toBe(1);
    expect(cloud.state.starts[0]).toMatchObject({
      scope: { targetId: 'cloud_sandbox_worker' },
      definitionId: cloud.curatedId,
      owner: expect.stringMatching(/^(personal|org:.+)$/),
      eventName: 'dispatch',
      modelChoices: {
        choices: [
          { itemKey: 'review#0', modelId: 'anthropic/claude-opus-5.5' },
        ],
      },
      _meta: { idempotencyKey: expect.any(String) },
    });
    expect(cloud.state.preflights).toHaveLength(1);
    // Nothing ran on this computer for the cloud run.
    expect((await listExecutions(window)).length).toBe(before + 2);

    // An execution target this computer doesn't place runs on is refused
    // before anything starts, here or in the cloud.
    const elsewhere = await window.evaluate(() =>
      window.pipelines.execute(
        { name: 'Elsewhere', on: 'dispatch', jobs: {} },
        {
          pipelineId: 'elsewhere',
          scope: 'global',
          target: { scope: 'global' },
          eventName: 'dispatch',
          targetId: 'another_computer',
          requestedOwner: 'personal',
        },
      ),
    );
    expect(elsewhere).toMatchObject({
      success: false,
      errorCode: 'cloud_target_unavailable',
    });
    expect(cloud.state.starts).toHaveLength(1);
    expect((await listExecutions(window)).length).toBe(before + 2);

    // Cloud, the current task (CAN-6869): its origin isn't on GitHub, so it
    // can't run in the cloud; nothing starts.
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await window.getByTestId('pipeline-run-location-current-task').click();
    await window.getByTestId('pipeline-run-on-cloud').click();
    await expect(window.getByTestId('pipeline-run-on-blocked')).toHaveCount(0);
    // A task's cloud run names its owner too, whose cloud worktree it uses.
    await pickOwner(window);
    await window.getByTestId('pipeline-trigger-modal-run').click();
    // The refusal shows in the dialog's error banner.
    await expect(window.getByText("isn't on GitHub")).toBeVisible();
    expect(cloud.state.starts).toHaveLength(1);

    // On GitHub (pushes go to a local repository instead), with a commit
    // GitHub doesn't have and an uncommitted change.
    const remote = mkdtempSync(path.join(os.tmpdir(), 'run-on-cloud-remote-'));
    execFileSync('git', ['init', '--bare', '-q', remote]);
    try {
      git('remote', 'remove', 'origin');
    } catch {
      // The seed may have no origin.
    }
    git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
    // The user's own URL rewriting (trusted), so pushes stay on this machine.
    git(
      'config',
      `url.${remote}.pushInsteadOf`,
      'https://github.com/acme/app.git',
    );
    git('push', '-q', '-u', 'origin', 'HEAD');
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    git(
      '-c',
      'user.name=E2E',
      '-c',
      'user.email=e2e@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'Local only',
    );
    const commit = (message) =>
      git(
        '-c',
        'user.name=E2E',
        '-c',
        'user.email=e2e@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        message,
      );
    let head = git('rev-parse', 'HEAD');
    writeFileSync(path.join(worktreePath, 'scratch.txt'), 'not committed\n');
    const remoteHead = () =>
      execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], {
        encoding: 'utf8',
      }).trim();
    expect(remoteHead()).not.toBe(head);

    // A configured push URL that isn't the GitHub repository the cloud reads
    // is refused before any warning: a push could publish the branch there.
    git(
      'config',
      'remote.origin.pushurl',
      'https://github.com/someone/else.git',
    );
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(
      window.getByText('pushes somewhere other than its GitHub repository'),
    ).toBeVisible();
    git('config', '--unset', 'remote.origin.pushurl');
    // So is a second URL on origin, which git pushes to as well.
    git(
      'config',
      '--add',
      'remote.origin.url',
      'https://github.com/someone/else.git',
    );
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(
      window.getByText('pushes somewhere other than its GitHub repository'),
    ).toBeVisible();
    git('config', '--unset', 'remote.origin.url', 'someone/else');

    // The dialog warns first; cancelling pushes nothing and starts nothing.
    await window.getByTestId('pipeline-trigger-modal-run').click();
    const warning = window.getByTestId('cloud-run-checkout-dialog');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('1 commit');
    await expect(warning).toContainText('Uncommitted changes');
    await warning.getByTestId('cloud-run-checkout-cancel').click();
    await expect(warning).toBeHidden();
    expect(remoteHead()).not.toBe(head);
    expect(cloud.state.starts).toHaveLength(1);

    // A commit made after the warning was shown: confirming refuses, and
    // neither commit is pushed.
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(warning).toBeVisible();
    commit('Made after the warning');
    await warning.getByTestId('cloud-run-checkout-confirm').click();
    await expect(warning).toContainText('since you confirmed');
    expect(remoteHead()).not.toBe(git('rev-parse', 'HEAD'));
    expect(remoteHead()).not.toBe(head);
    await warning.getByTestId('cloud-run-checkout-cancel').click();
    head = git('rev-parse', 'HEAD');

    // Another branch at the same commit while the warning is shown: the
    // confirmation names the branch too, so it refuses and pushes nothing.
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(warning).toBeVisible();
    git('checkout', '-q', '-b', 'same-commit-elsewhere');
    await warning.getByTestId('cloud-run-checkout-confirm').click();
    await expect(warning).toContainText('since you confirmed');
    expect(() =>
      execFileSync(
        'git',
        ['--git-dir', remote, 'rev-parse', '--verify', 'same-commit-elsewhere'],
        { stdio: 'ignore' },
      ),
    ).toThrow();
    expect(remoteHead()).not.toBe(head);
    await warning.getByTestId('cloud-run-checkout-cancel').click();
    git('checkout', '-q', branch);
    git('branch', '-q', '-D', 'same-commit-elsewhere');

    // Confirmed: exactly the confirmed commit is pushed, then the start names
    // it at the pushed head; while its cloud worktree is set up the warning
    // closes and the same start goes again.
    cloud.state.preparing = 1;
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('2 commits');
    await warning.getByTestId('cloud-run-checkout-confirm').click();
    await expect(warning).toBeHidden({ timeout: 30_000 });
    expect(remoteHead()).toBe(head);
    const taskModels = window.getByTestId('cloud-model-replacement-dialog');
    await expect(taskModels).toBeVisible({ timeout: 45_000 });
    expect(cloud.state.preparingStarts).toHaveLength(1);
    await taskModels.getByTestId('cloud-model-replacement-select').click();
    await window.getByRole('option', { name: 'Opus 5.5' }).click();
    await taskModels.getByTestId('cloud-model-replacement-confirm').click();
    await expect(taskModels).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => cloud.state.starts.length).toBe(2);
    expect(cloud.state.starts[1]).toMatchObject({
      scope: { targetId: 'cloud_sandbox_worker' },
      checkout: { repository: 'acme/app', branch, headSha: head },
      definitionId: cloud.curatedId,
    });
    expect(cloud.state.starts[1].scope).not.toHaveProperty('workspaceId');
    // One launch: every send of it carried the same key.
    expect(cloud.state.preparingStarts[0]._meta.idempotencyKey).toBe(
      cloud.state.starts[1]._meta.idempotencyKey,
    );
    // Nothing ran on this computer for it.
    expect((await listExecutions(window)).length).toBe(before + 2);

    // Opens the Run dialog for the task's cloud run and presses Run.
    const runTaskInCloud = async () => {
      await openRunDialog(window, app, CLOUD_WORKFLOW);
      await window.getByTestId('pipeline-run-location-current-task').click();
      await window.getByTestId('pipeline-run-on-cloud').click();
      await pickOwner(window);
      await window.getByTestId('pipeline-trigger-modal-run').click();
    };

    // While a cloud worktree is set up, the dialog's settings stay as sent,
    // and the resends go at the branch the first send named, even for a
    // clean, pushed task that needed no warning: once the task moves to
    // another branch, at the same commit, the next resend is refused.
    rmSync(path.join(worktreePath, 'scratch.txt'));
    cloud.state.preparing = 5;
    const waitedFrom = cloud.state.preparingStarts.length;
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await window.getByTestId('pipeline-run-location-current-task').click();
    await window.getByTestId('pipeline-run-on-cloud').click();
    await pickOwner(window);
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(warning).toBeHidden();
    await expect(window.getByText('Setting up a cloud worktree')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      window.getByRole('button', { name: 'Back to workflow list' }),
    ).toBeDisabled();
    git('checkout', '-q', '-b', 'moved-while-waiting');
    await expect(window.getByText('since this run was sent')).toBeVisible({
      timeout: 30_000,
    });
    expect(cloud.state.preparingStarts.length).toBeGreaterThan(waitedFrom);
    for (const start of cloud.state.preparingStarts.slice(waitedFrom))
      expect(start.checkout).toMatchObject({ branch, headSha: head });
    expect(cloud.state.starts).toHaveLength(2);
    await window.getByTestId('pipeline-trigger-modal-cancel').click();
    git('checkout', '-q', branch);
    git('branch', '-q', '-D', 'moved-while-waiting');

    // Once a send of it was resent while the cloud worktree was set up, the
    // launch keeps its first checkout whatever comes back in between: after
    // a refusal that keeps its key, a task moved to another branch is
    // refused rather than sent under that key.
    cloud.state.preparing = 1;
    cloud.state.signedOut = 1;
    await runTaskInCloud();
    await expect(window.getByText('Sign in to run workflows')).toBeVisible({
      timeout: 30_000,
    });
    git('checkout', '-q', '-b', 'moved-after-refusal');
    const sentBefore =
      cloud.state.refusedStarts.length + cloud.state.starts.length;
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(window.getByText('since this run was sent')).toBeVisible();
    await expect(warning).toBeHidden();
    expect(cloud.state.refusedStarts.length + cloud.state.starts.length).toBe(
      sentBefore,
    );
    await window.getByTestId('pipeline-trigger-modal-cancel').click();
    git('checkout', '-q', branch);
    git('branch', '-q', '-D', 'moved-after-refusal');
    writeFileSync(path.join(worktreePath, 'scratch.txt'), 'not committed\n');

    // Closing the Run dialog while a cloud worktree is set up stops asking:
    // no further start goes out. (The uncommitted file still asks first.)
    cloud.state.preparing = 5;
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await window.getByTestId('pipeline-run-location-current-task').click();
    await window.getByTestId('pipeline-run-on-cloud').click();
    await pickOwner(window);
    await window.getByTestId('pipeline-trigger-modal-run').click();
    await expect(warning).toBeVisible();
    await warning.getByTestId('cloud-run-checkout-confirm').click();
    await expect(window.getByText('Setting up a cloud worktree')).toBeVisible({
      timeout: 30_000,
    });
    await expect(warning).toBeHidden();
    // Nothing else can start meanwhile; Cancel stays available.
    await expect(
      window.getByTestId('pipeline-trigger-modal-run'),
    ).toBeDisabled();
    await window.getByTestId('pipeline-trigger-modal-cancel').click();
    await expect(
      window.getByTestId('pipeline-trigger-modal-body'),
    ).toBeHidden();
    const asked = cloud.state.preparingStarts.length;
    await window.waitForTimeout(12_000);
    expect(cloud.state.preparingStarts).toHaveLength(asked);
    expect(cloud.state.starts).toHaveLength(2);

    // Closed while a resend is out: that start may yet be recorded, so the
    // launch stays. Running the same workflow again, while it is still out
    // and once its answer was lost, resends it under its key; the person is
    // told it may have started.
    cloud.state.preparing = 1;
    // Runs the task's cloud run again and checks the resend went under the
    // held key. The count is read before Run is pressed: the resend leaves
    // in the click's handler, so its refusal can be in before the click
    // returns.
    const resendsUnderItsKey = async () => {
      const refused = cloud.state.refusedStarts.length;
      await runTaskInCloud();
      await expect
        .poll(() => cloud.state.refusedStarts.length)
        .toBe(refused + 1);
      expect(cloud.state.refusedStarts.at(-1)._meta.idempotencyKey).toBe(
        cloud.state.heldStarts[0]._meta.idempotencyKey,
      );
      expect(cloud.state.starts).toHaveLength(2);
      await expect(taskModels).toBeVisible();
      await taskModels.getByTestId('cloud-model-replacement-cancel').click();
      await window.getByTestId('pipeline-trigger-modal-cancel').click();
    };
    await runTaskInCloud();
    await expect(warning).toBeVisible();
    await warning.getByTestId('cloud-run-checkout-confirm').click();
    await expect(window.getByText('Setting up a cloud worktree')).toBeVisible({
      timeout: 30_000,
    });
    const lost = cloud.holdNextStart();
    await lost.arrived;
    await window.getByTestId('pipeline-trigger-modal-cancel').click();
    await expect(
      window.getByTestId('pipeline-trigger-modal-body'),
    ).toBeHidden();
    await resendsUnderItsKey();
    lost.release();
    await expect(
      window.getByText('The cloud run may have started.'),
    ).toBeVisible({ timeout: 15_000 });
    await resendsUnderItsKey();

    // The choice is remembered for this workflow.
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await expect(window.getByTestId('pipeline-run-on-cloud')).toBeChecked();
    await window.getByTestId('pipeline-trigger-modal-cancel').click();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
