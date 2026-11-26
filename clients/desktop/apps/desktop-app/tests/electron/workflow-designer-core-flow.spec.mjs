import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  saveWorkflowEdit,
  workflowEditTarget,
} from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-4224: the workflow Designer is every pipeline's default view.
//   - A new workflow opens in the Designer. Steps are added from its picker,
//     a job splits into paths, a step's input is edited in its panel, and the
//     workflow saves and reopens in the Designer with what was built.
//   - A bundled pipeline opens read-only in the Designer, with its trigger
//     card; Duplicate makes a copy that opens editable in the Designer.
//   - An automation opens as its trigger card and one action card, whose
//     fields are its panel; the action follows its target, and the "+" after
//     it says why nothing can follow.

const AUTOPILOT_NAME = 'Implementation (Autopilot)';

test.describe.configure({ mode: 'serial' });

test('Workflow designer core flow (CAN-4224)', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-4224-core-'));
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // A new workflow opens in the Designer, with nothing in it yet.
    await app.openPipelinesPage();
    await app.startNewWorkflow('build');
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toBeVisible({ timeout: 20_000 });
    const designer = shell.getByTestId('workflow-designer');
    await expect(designer).toBeVisible();
    await expect(shell.getByTestId('pipeline-mode-designer')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      designer.getByTestId('workflow-designer-trigger'),
    ).toBeVisible();

    // The first step, a script, from the picker.
    await designer.getByTestId('workflow-designer-add-first').click();
    await window
      .getByTestId('workflow-step-picker-option')
      .filter({ hasText: 'Run script' })
      .click();
    await expect(designer.getByTestId('workflow-designer-card')).toHaveCount(1);
    // Its input, edited in the step's panel.
    const script = shell.locator('textarea').first();
    await script.fill('echo built in the designer');

    // A split after it, from the "+" after the last step.
    await designer.getByTestId('workflow-designer-insert').first().click();
    await window
      .getByTestId('workflow-step-picker-option')
      .filter({ hasText: 'Split into paths' })
      .click();
    await expect(designer.getByTestId('workflow-designer-path')).toHaveCount(2);
    await shell.getByTestId('split-panel-text').fill('The request');
    // A third path, and a script on it through its own "+".
    await designer.getByTestId('workflow-designer-add-path').click();
    await expect(designer.getByTestId('workflow-designer-path')).toHaveCount(3);
    const thirdPath = designer.getByTestId('workflow-designer-path').nth(2);
    await thirdPath.getByTestId('workflow-designer-insert').click();
    await window
      .getByTestId('workflow-step-picker-option')
      .filter({ hasText: 'Run script' })
      .click();
    // The script, the router, two empty paths and path 3's step.
    await expect(designer.getByTestId('workflow-designer-card')).toHaveCount(5);
    await shell.locator('textarea').first().fill('echo on path 3');

    await saveWorkflowEdit(window);
    const saved = await workflowEditTarget(window);
    expect(saved?.kind).toBe('pipeline');
    expect(saved?.pipelineId).toBeTruthy();
    const definition = await window.evaluate(
      (id) => window.pipelines.get(id),
      saved.pipelineId,
    );
    expect(definition.success).toBe(true);
    const content = definition.data.content;
    const [buildJobId] = Object.keys(content.jobs).filter(
      (jobId) => !content.jobs[jobId].needs,
    );
    const build = content.jobs[buildJobId];
    expect(build.steps[0].run).toBe('echo built in the designer');
    expect(build.steps[1].uses).toBe('builtin/router');
    expect(build.steps[1].with.text).toBe('The request');
    // Each path is guarded by its route, and only Path 3's holds the script.
    const routes = JSON.parse(build.steps[1].with.routes);
    expect(routes).toEqual(['Path 1', 'Path 2', 'Path 3']);
    const pathJobs = Object.values(content.jobs).filter((job) =>
      String(job.if ?? '').includes('.outputs.route =='),
    );
    expect(pathJobs).toHaveLength(3);
    for (const job of pathJobs)
      expect(job.steps.map((step) => step.run)).toEqual(
        job.if.endsWith("== 'Path 3'") ? ['echo on path 3'] : [],
      );

    // Reopened, it is in the Designer with what was built.
    await app.openPipelinesPage();
    await app.searchWorkflowsLibrary(content.name);
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(saved.pipelineId),
    );
    await expect(shell).toBeVisible({ timeout: 20_000 });
    await expect(designer.getByTestId('workflow-designer-path')).toHaveCount(3);
    await expect(designer.getByTestId('workflow-designer-card')).toHaveCount(5);

    // A bundled pipeline opens read-only in the Designer, with its trigger.
    await app.openPipelinesPage();
    await app.searchWorkflowsLibrary('Autopilot');
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryRowByName(AUTOPILOT_NAME),
    );
    await expect(shell).toBeVisible({ timeout: 20_000 });
    const readOnly = shell.getByTestId('pipeline-read-designer');
    await expect(readOnly).toBeVisible();
    await expect(
      readOnly.getByTestId('workflow-designer-trigger'),
    ).toContainText('Approved plan · New task');
    await expect(readOnly).toContainText('Only from a new task');
    await expect(readOnly.getByTestId('workflow-designer-insert')).toHaveCount(
      0,
    );
    // Its cards have no panel to open, so they show disabled.
    await expect(
      readOnly.getByTestId('workflow-designer-card').first(),
    ).toBeDisabled();
    await expect(
      readOnly.getByTestId('workflow-designer-trigger'),
    ).toBeDisabled();

    // Duplicate makes a copy that opens editable in the Designer.
    // An action of the page's toolbar, outside the shell (CAN-4319).
    await window.getByTestId('pipeline-editor-duplicate').first().click();
    await expect
      .poll(async () => (await workflowEditTarget(window))?.source ?? null, {
        timeout: 20_000,
      })
      .toBe('user');
    await expect(shell.getByTestId('workflow-designer')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      shell.getByTestId('workflow-designer-insert').first(),
    ).toBeVisible();

    // An automation opens as its trigger and its one action, whose fields
    // are its panel. Nothing can follow the action, and the "+" says so.
    await app.openPipelinesPage();
    await app.startNewWorkflow('schedule');
    await expect(shell).toBeVisible({ timeout: 20_000 });
    const automation = shell.getByTestId('automation-designer');
    await expect(automation).toBeVisible();
    await expect(
      automation.getByTestId('workflow-designer-trigger'),
    ).toBeVisible();
    const action = automation.getByTestId('workflow-designer-card');
    await expect(action).toHaveCount(1);
    await expect(action).toContainText('Run workflow');
    await expect(
      automation.getByTestId('workflow-designer-insert-blocked'),
    ).toBeDisabled();
    await expect(
      automation.getByTestId('workflow-designer-insert-blocked-reason'),
    ).toBeVisible();
    // The card's fields are its panel: Enter moves into them, and Escape
    // returns to the card.
    await action.focus();
    await window.keyboard.press('Enter');
    await expect(shell.getByTestId('automations-form-name')).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(action).toBeFocused();
    // Choosing a chat target redraws the card as a chat.
    await shell.getByTestId('automations-form-action-type-app_advisor').click();
    await expect(action).toContainText('Start chat');
    // The trigger card opens Trigger, where when it runs is set.
    await automation.getByTestId('workflow-designer-trigger').click();
    await expect(
      shell.getByTestId('workflow-edit-tab-trigger'),
    ).toHaveAttribute('aria-selected', 'true');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});
