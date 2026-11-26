// The New task (Home) composer keeps Plan mode and Workflow in its + menu,
// under Current settings. Plan's chip sits beside + while it is on. Workflow
// opens the Attach a workflow dialog, and an inserted workflow's chip sits
// beside + (CAN-7513).
import { expect } from '@playwright/test';

export const HOME_PLAN_MODE_ITEM = 'home-plan-mode-button';
export const HOME_PIPELINE_MODE_ITEM = 'home-pipeline-mode-button';

/** Opens the Home composer's + menu and picks the row `itemTestId`. */
export async function pickHomeComposerMenuItem(window, home, itemTestId) {
  await home.getByTestId('home-composer-plus-button').click();
  const item = window.getByTestId(itemTestId);
  await expect(item).toBeVisible();
  await item.click();
}

/** Opens the Attach a workflow dialog from the Home composer's + menu. */
export async function openHomeAttachWorkflow(window, home) {
  await pickHomeComposerMenuItem(window, home, HOME_PIPELINE_MODE_ITEM);
  await expect(window.getByTestId('pipeline-trigger-modal')).toBeVisible();
}

/** Toggles Plan mode from the Home composer's + menu. */
export async function toggleHomePlanMode(window, home) {
  await pickHomeComposerMenuItem(window, home, HOME_PLAN_MODE_ITEM);
}
