import { mkdtempSync } from 'node:fs';
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
//   - Cloud with the current task is blocked in the dialog and starts
//     nowhere; a workflow that exists only on this computer can't pick Cloud;
//   - the last choice is remembered per workflow;
//   - `pipelines:execute` with any other execution target is refused, never
//     run on this computer.

const WORKTREE_BRANCH = 'demo-main';
const CLOUD_WORKFLOW = 'Anywhere review';
const LOCAL_PIPELINE_ID = 'run-on-local-review';
const LOCAL_PIPELINE = 'Local-only review';
const RUNNABLE = (name) =>
  `name: ${name}\non: dispatch\nscope: [global, worktree, directory]\njobs:\n  review:\n    steps:\n      - run: echo reviewed\n`;

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
  // A run with no project names its owner; pick one when the account offers
  // more than Personal.
  const ownerSelect = window.getByTestId('pipeline-run-owner-select');
  if (await ownerSelect.isVisible().catch(() => false)) {
    await ownerSelect.click();
    await window.getByRole('option').first().click();
  }
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
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
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
    await expect(window.getByTestId('pipeline-run-on-local')).toHaveAttribute(
      'aria-checked',
      'true',
    );
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
    await expect(window.getByTestId('pipeline-run-on-local')).toHaveAttribute(
      'aria-checked',
      'true',
    );
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

    // Cloud, the current task: blocked here, started nowhere.
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await window.getByTestId('pipeline-run-location-current-task').click();
    await window.getByTestId('pipeline-run-on-cloud').click();
    await expect(window.getByTestId('pipeline-run-on-blocked')).toBeVisible();
    await expect(
      window.getByTestId('pipeline-trigger-modal-run'),
    ).toBeDisabled();

    // Cloud, No project: the web core refuses the start until the model step
    // has a confirmed cloud model, recording nothing; the dialog asks, then
    // the start goes with the choice.
    await window.getByTestId('pipeline-run-location-global').click();
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

    // The choice is remembered for this workflow.
    await openRunDialog(window, app, CLOUD_WORKFLOW);
    await expect(window.getByTestId('pipeline-run-on-cloud')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await window.getByTestId('pipeline-trigger-modal-cancel').click();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
