import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startCloudPipelinesWebCore } from './fixtures/cloudPipelinesWebCore.mjs';
import {
  cloudJob,
  cloudStep,
} from '../../../../scripts/lib/fake-cloud-runs-web-core.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';

// CAN-6326 (cloud pipelines CP-38): cloud runs on desktop, against the built
// app and a fake web core over the real POST + SSE binding.
//   - The Workflows Runs feed lists cloud runs beside this computer's only
//     while the web core reports cloud runs available, and says where each
//     ran.
//   - A cloud run's detail shows who started it and where, why it paused
//     (owner_lost included), its full step log read by position past one
//     page, and its report.
//   - The detail follows the run live over the web core push: a new log line
//     and a status change arrive without a reload.
//   - Answering a pause, Cancel and Start over go to the web core with the
//     run's own id, and nothing runs on this computer.
//   - Signing out drops the account's cloud runs from the feed.

const CLOUD_WORKFLOW = 'Anywhere review';
const LOG_LINES = 1500;
const LOCAL_WORKFLOW = 'Local check';

function runRow(window, executionId) {
  return window.locator(
    `[data-testid="workflows-run-row"][data-run-key="cloud-run:${executionId}"]`,
  );
}

async function openRun(window, executionId) {
  await runRow(window, executionId).getByTestId('workflows-run-name').click();
  const dialog = window.getByTestId('cloud-run-detail-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeRun(window) {
  await window.getByTestId('cloud-run-detail-close').click();
  await expect(window.getByTestId('cloud-run-detail-dialog')).toBeHidden();
}

test('Cloud runs list, open and answer their controls over the web core', async () => {
  test.setTimeout(240_000);
  const cloud = await startCloudPipelinesWebCore({
    workflowName: CLOUD_WORKFLOW,
    rawPipeline: `name: ${CLOUD_WORKFLOW}\non: dispatch\njobs:\n  review:\n    steps:\n      - run: echo reviewed\n`,
  });
  const runs = cloud.cloudRuns;
  const log = Array.from(
    { length: LOG_LINES },
    (_, index) => `line ${index + 1}`,
  );
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  // Waiting for an answer, with a full log longer than one read.
  const paused = runs.addRun({
    name: 'Cloud review',
    status: 'paused',
    startedAt: at(3),
    jobs: [
      cloudJob('review', 'Review', 'paused', [
        cloudStep('approve', 'Approve the change', 'paused'),
      ]),
    ],
    pendingPauses: [
      {
        id: 'checkpoint-1',
        kind: 'input',
        jobId: 'review-1',
        logicalJobId: 'review',
        stepId: 'approve',
        attempt: 0,
        iteration: 1,
        detectedAt: at(2),
        request: {
          title: 'Approve the change?',
          fields: [{ key: 'reason', label: 'Why', type: 'string' }],
        },
      },
    ],
    statusReasons: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'input_required',
        code: 'input_requested',
        detectedAt: at(2),
        source: {
          jobId: 'review-1',
          stepId: 'approve',
          attempt: 0,
          iteration: 1,
        },
      },
    ],
    logs: { 'review-1:approve': log },
  });
  // Paused when its owner went away; a schedule started it.
  const ownerLost = runs.addRun({
    name: 'Nightly cloud sweep',
    status: 'paused',
    startedAt: at(10),
    initiator: {
      kind: 'automation',
      automationId: 'schedule-1',
      automationName: 'Nightly',
    },
    jobs: [
      cloudJob('sweep', 'Sweep', 'paused', [
        cloudStep('scan', 'Scan', 'paused'),
      ]),
    ],
    statusReasons: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'owner_lost',
        code: 'owner_lost',
        detectedAt: at(9),
        source: { jobId: 'sweep-1', stepId: 'scan', attempt: 0, iteration: 1 },
      },
    ],
  });
  // Failed, with a report.
  const failed = runs.addRun({
    name: 'Cloud lint',
    status: 'failure',
    startedAt: at(20),
    error: 'Lint found 3 problems.',
    jobs: [
      cloudJob('lint', 'Lint', 'failure', [
        cloudStep('eslint', 'Run ESLint', 'failure'),
      ]),
    ],
    artifacts: [{ kind: 'report', jobId: null, stepId: null }],
    reports: { 'report::': '# Lint report\n\nThree problems in `app.ts`.' },
    logs: { 'lint-1:eslint': ['app.ts: 3 problems'] },
  });

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'cloud-runs-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // A run on this computer, before the cloud is available.
    const local = await window.evaluate(
      (name) =>
        window.pipelines.execute(
          {
            name,
            on: 'dispatch',
            scope: ['global'],
            jobs: { check: { steps: [{ run: 'echo checked' }] } },
          },
          {
            pipelineId: 'cloud-runs-local-check',
            scope: 'global',
            target: { scope: 'global' },
            eventName: 'dispatch',
            requestedOwner: 'personal',
          },
        ),
      LOCAL_WORKFLOW,
    );
    expect(local.success).toBe(true);

    // Signed out, no cloud runs: the feed lists this computer's run only and
    // says nothing about where it ran.
    await app.openWorkflowsTab('runs');
    const localRow = window
      .getByTestId('workflows-run-row')
      .filter({ hasText: LOCAL_WORKFLOW });
    await expect(localRow).toBeVisible({ timeout: 30_000 });
    await expect(runRow(window, paused)).toHaveCount(0);
    await expect(localRow).not.toContainText('This computer');
    expect(runs.calls).toEqual([]);

    // Signed in with cloud runs available: both, each saying where it ran.
    cloud.state.cloudRuns = true;
    await connectMockCloudAccount(window, 'csk_cloud_runs');
    expect(
      await window.evaluate(() => window.pipelines.cloudRunsAvailability()),
    ).toEqual({ pipelineCloudRuns: true });
    await app.openMainPage();
    await app.openWorkflowsTab('runs');
    for (const id of [paused, ownerLost, failed])
      await expect(runRow(window, id)).toBeVisible({ timeout: 30_000 });
    await expect(
      runRow(window, paused).getByTestId('workflows-run-location-cloud'),
    ).toHaveText('Cloud');
    await expect(localRow).toContainText('This computer');
    await expect(runRow(window, paused)).toHaveAttribute(
      'data-run-status',
      'waiting',
    );
    await expect(runRow(window, ownerLost)).toContainText('Connection lost');
    await expect(runRow(window, ownerLost)).toContainText('Schedule');
    expect(
      runs.calls.find(
        (call) => call.method === 'worker.pipeline.execution.list',
      ),
    ).toMatchObject({
      params: { scope: { targetId: 'cloud_sandbox_worker' }, detail: true },
    });

    // The paused run's detail: who started it, where, why, and its whole
    // log, read by position past the first page.
    const dialog = await openRun(window, paused);
    await expect(dialog.getByTestId('cloud-run-started-by')).toContainText(
      'Manual',
    );
    await expect(dialog.getByTestId('cloud-run-location')).toContainText(
      'Cloud',
    );
    // The pause form asks for the input; its reason doesn't repeat it.
    await expect(dialog.getByTestId('pipeline-run-pause-form')).toBeVisible();
    await expect(
      dialog.getByTestId('cloud-run-status-reason-input_required'),
    ).toHaveCount(0);
    const output = dialog.getByTestId('ansi-output');
    await expect(output).toContainText(`line ${LOG_LINES}`, {
      timeout: 30_000,
    });
    // The log starts at its first line: a whole log, not a tail.
    await expect(output.locator(':scope > div').first()).toHaveText('line 1');
    const reads = runs.calls.filter(
      (call) => call.method === 'core.pipeline.execution.stepLog.read',
    );
    expect(reads.map((call) => call.params.fromIndex)).toEqual(
      expect.arrayContaining([0, 1000]),
    );
    expect(reads[0].params).toMatchObject({
      executionId: paused,
      jobId: 'review-1',
      stepId: 'approve',
    });

    // Live: a new line and a status change arrive over the push.
    await expect
      .poll(() =>
        runs.calls.some(
          (call) => call.method === 'worker.pipeline.execution.events',
        ),
      )
      .toBe(true);
    runs.appendLog(paused, 'review-1', 'approve', ['a live line']);
    await expect(output).toContainText('a live line', { timeout: 30_000 });

    // Answer the pause: the answer reaches the web core for this checkpoint.
    await dialog
      .getByTestId('portal-pipeline-pause-field-reason')
      .fill('Looks good');
    await dialog.getByTestId('portal-pipeline-pause-submit').click();
    await expect
      .poll(() =>
        runs.calls.find(
          (call) => call.method === 'worker.pipeline.execution.resume',
        ),
      )
      .toMatchObject({
        params: {
          executionId: paused,
          initiationSource: 'user',
          requestId: expect.any(String),
          pauseResponses: [
            {
              checkpointId: 'checkpoint-1',
              jobId: 'review-1',
              stepId: 'approve',
              answers: { reason: 'Looks good' },
            },
          ],
        },
      });
    await expect(dialog.getByTestId('cloud-run-detail-status')).toHaveText(
      'running',
      { timeout: 30_000 },
    );

    // Cancel it from the detail.
    await dialog.getByTestId('pipeline-run-detail-cancel').click();
    await expect
      .poll(
        () =>
          runs.calls.find(
            (call) => call.method === 'worker.pipeline.execution.cancel',
          )?.params.executionId,
      )
      .toBe(paused);
    await expect(dialog.getByTestId('cloud-run-detail-status')).toHaveText(
      'cancelled',
      { timeout: 30_000 },
    );
    await closeRun(window);
    await expect(runRow(window, paused)).toHaveAttribute(
      'data-run-status',
      'canceled',
    );

    // The owner-lost pause explains itself.
    const lostDialog = await openRun(window, ownerLost);
    await expect(
      lostDialog.getByTestId('cloud-run-status-reason-owner_lost'),
    ).toContainText('Paused when the connection to this run was lost.');
    await expect(lostDialog.getByTestId('cloud-run-started-by')).toContainText(
      'Schedule · Nightly',
    );
    await closeRun(window);

    // The failed run: its report, then Start over. The web core refuses an
    // ended cloud run's in-place retry for now, so Try again isn't offered.
    const failedDialog = await openRun(window, failed);
    await expect(failedDialog.getByTestId('cloud-run-error')).toContainText(
      'Lint found 3 problems.',
    );
    await failedDialog.getByTestId('cloud-run-artifact-report').click();
    await expect(
      failedDialog.getByTestId('cloud-run-artifact-content'),
    ).toContainText('Three problems in');
    await expect(
      failedDialog.getByTestId('pipeline-run-detail-retry'),
    ).toHaveCount(0);
    await failedDialog.getByTestId('pipeline-run-detail-rerun').click();
    await expect
      .poll(
        () =>
          runs.calls.find(
            (call) => call.method === 'worker.pipeline.execution.retry',
          )?.params,
      )
      .toMatchObject({
        executionId: failed,
        mode: 'from_start',
        newExecutionId: expect.any(String),
        requestId: expect.any(String),
      });
    const rerun = runs.calls.find(
      (call) => call.method === 'worker.pipeline.execution.retry',
    ).params.newExecutionId;
    // The detail moves to the new run and follows it live.
    await expect(
      failedDialog.getByTestId('cloud-run-detail-status'),
    ).toHaveText('running', { timeout: 30_000 });
    await expect
      .poll(() =>
        runs.calls.some(
          (call) =>
            call.method === 'worker.pipeline.execution.events' &&
            call.params.executionId === rerun,
        ),
      )
      .toBe(true);
    runs.updateRun(rerun, { execution: { status: 'success' } });
    await expect(
      failedDialog.getByTestId('cloud-run-detail-status'),
    ).toHaveText('success', { timeout: 30_000 });
    await closeRun(window);
    await expect(runRow(window, rerun)).toBeVisible();

    // Signing out forgets the account's cloud runs; this computer's stays.
    await window.evaluate(() => window.api.clearCanopyCloudApiKey());
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    for (const id of [paused, ownerLost, failed, rerun])
      await expect(runRow(window, id)).toHaveCount(0, { timeout: 30_000 });
    await expect(localRow).toBeVisible();

    // Nothing ran on this computer for any of it.
    const executions = await window.evaluate(() =>
      window.pipelines.listExecutions(),
    );
    expect(
      executions.data.filter((run) => run.pipeline_name !== LOCAL_WORKFLOW),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
