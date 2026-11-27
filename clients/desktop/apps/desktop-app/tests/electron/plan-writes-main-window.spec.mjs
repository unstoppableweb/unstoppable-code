// The main window's plan writes, end to end (CAN-4165).
//
// Since CAN-4165 PRs 7b and 7c the main window writes tracked and detected
// plans through core.plan on the renderer relay instead of the plan channels.
// Each test drives one write from the UI a user touches and checks what main
// saved and what the window shows:
//   1. a chat's pending plan, opened, creates its tracked plan
//      (core.plan.create), and Hide in Activity → Plans hides a plan
//      (core.plan.update);
//   2. the plan detection banner's Track plan imports the detected file
//      (core.plan.import) and marks the detection imported
//      (core.plan.detected.update);
//   3. the banner's dismiss marks the detection seen
//      (core.plan.detected.update).
// The detected scan runs only after an agent turn; the plan lifecycle golden
// pins it on the relay.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { SEEDED_CHAT_TAB_ID } from './panelHarness.mjs';
import {
  buildPanelPlan,
  PLAN_PANEL_WORKSPACE_ID,
  PLAN_PANEL_WORKTREE_ID,
  planGroupOf,
  seedPlanPanelWorktree,
} from './planPanelHarness.mjs';

const WORKSPACE_ROOT_REPO_ID = '__workspace_root__';
const DETECTED_FILE = 'e2e/plan.md';
const DETECTED_CONTENT =
  '# Detected E2E plan\n\nA plan an agent wrote in the chat.\n\n## Phase 1\n\n- Track it.\n';

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function savedTrackedPlans(userDataDir) {
  return (
    readJson(
      path.join(
        userDataDir,
        'workspaces',
        PLAN_PANEL_WORKSPACE_ID,
        'plans',
        `${PLAN_PANEL_WORKTREE_ID}.json`,
      ),
    )?.plans ?? []
  );
}

function detectedPlansPath(userDataDir) {
  return path.join(
    userDataDir,
    'workspaces',
    PLAN_PANEL_WORKSPACE_ID,
    'detected-plans',
    `${PLAN_PANEL_WORKTREE_ID}.json`,
  );
}

function savedDetectedPlans(userDataDir) {
  return readJson(detectedPlansPath(userDataDir))?.entries ?? [];
}

/** One detected plan file in the seeded chat, not yet seen by its banner. */
function seedDetectedPlan(userDataDir, id) {
  const filePath = detectedPlansPath(userDataDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          id,
          sourceRepoId: WORKSPACE_ROOT_REPO_ID,
          sourceFilePath: DETECTED_FILE,
          status: 'detected',
          bannerSeen: false,
          detectedInChatId: SEEDED_CHAT_TAB_ID,
          detectedAt: '2026-11-25T00:00:00.000Z',
        },
      ],
    }),
    'utf8',
  );
}

/**
 * Launch the demo worktree with one detected plan whose file exists. Both are
 * written before launch, so a failed write never leaves an app running.
 */
function launchWithDetectedPlan(id) {
  return seedPlanPanelWorktree({
    plans: [],
    onBeforeLaunch: ({ userDataDir }) => {
      seedDetectedPlan(userDataDir, id);
      // The demo-main checkout the seed script created.
      const planPath = path.join(
        userDataDir,
        'workspaces',
        PLAN_PANEL_WORKSPACE_ID,
        'worktrees',
        PLAN_PANEL_WORKTREE_ID,
        DETECTED_FILE,
      );
      mkdirSync(path.dirname(planPath), { recursive: true });
      writeFileSync(planPath, DETECTED_CONTENT, 'utf8');
    },
  });
}

test.describe('Main-window plan writes (CAN-4165)', () => {
  test('Hide hides a plan, and opening a pending plan creates it', async () => {
    const pendingPlanId = 'e2e-pending-plan';
    const hiddenPlanId = 'e2e-hide-plan';
    const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
      plans: [
        buildPanelPlan({
          id: hiddenPlanId,
          title: 'E2E plan to hide',
          updatedAt: '2026-11-25T00:00:00.000Z',
        }),
      ],
      chatTab: {
        planMode: true,
        pendingPlanExit: {
          plan: '# E2E pending plan\n\nA plan waiting for review.',
          source: 'claude',
        },
        pendingPlanExitRequestId: 'e2e-plan-request',
        trackedPlanId: pendingPlanId,
      },
    });
    try {
      // Hide first: the Plan panel the pending plan opens takes the activity
      // rail's place.
      const primaryList = window.getByTestId('plans-primary-list');
      await expect(
        primaryList.getByTestId(`activity-plan-row-${hiddenPlanId}`),
      ).toBeVisible();
      await window
        .getByTestId(`activity-plan-toggle-hidden-${hiddenPlanId}`)
        .click();
      await expect
        .poll(() =>
          savedTrackedPlans(userDataDir)
            .filter((plan) => plan.id === hiddenPlanId)
            .map((plan) => plan.hidden === true),
        )
        .toEqual([true]);
      await expect(
        primaryList.getByTestId(`activity-plan-row-${hiddenPlanId}`),
      ).toHaveCount(0);
      await expect(window.getByTestId('activity-plans-hidden')).toContainText(
        '1 hidden',
      );

      await expect(window.getByTestId('chat-plan-approval')).toBeVisible();
      await window.getByTestId('chat-plan-explore').click();
      await expect
        .poll(() =>
          savedTrackedPlans(userDataDir)
            .filter((plan) => plan.id === pendingPlanId)
            .map((plan) => plan.reviewStatus),
        )
        .toEqual(['pending']);
      await expect
        .poll(() => planGroupOf(electronApp, window, pendingPlanId))
        .not.toBeNull();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Track plan imports a detected plan and marks it imported', async () => {
    const detectedId = 'e2e-detected-track';
    const { electronApp, userDataDir, window } =
      await launchWithDetectedPlan(detectedId);
    try {
      const banner = window.getByTestId('plan-detection-banner');
      await expect(banner).toContainText('Track plan.md as a plan?');
      await window.getByTestId('plan-detection-banner-import').click();

      await expect.poll(() => savedTrackedPlans(userDataDir).length).toBe(1);
      const [plan] = savedTrackedPlans(userDataDir);
      expect({
        source: plan.source,
        sourceFilePath: plan.sourceFilePath,
        content: plan.content,
      }).toEqual({
        source: 'imported',
        sourceFilePath: DETECTED_FILE,
        content: DETECTED_CONTENT,
      });
      await expect
        .poll(() =>
          savedDetectedPlans(userDataDir).map((entry) => ({
            id: entry.id,
            status: entry.status,
            importedPlanId: entry.importedPlanId,
          })),
        )
        .toEqual([
          { id: detectedId, status: 'imported', importedPlanId: plan.id },
        ]);
      await expect(banner).toHaveCount(0);
      await expect
        .poll(() => planGroupOf(electronApp, window, plan.id))
        .not.toBeNull();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test("the banner's dismiss marks a detected plan seen", async () => {
    const detectedId = 'e2e-detected-dismiss';
    const { electronApp, userDataDir, window } =
      await launchWithDetectedPlan(detectedId);
    try {
      const banner = window.getByTestId('plan-detection-banner');
      await expect(banner).toBeVisible();
      await window.getByTestId('plan-detection-banner-dismiss').click();

      await expect
        .poll(() =>
          savedDetectedPlans(userDataDir).map((entry) => ({
            id: entry.id,
            status: entry.status,
            bannerSeen: entry.bannerSeen,
          })),
        )
        .toEqual([{ id: detectedId, status: 'detected', bannerSeen: true }]);
      await expect(banner).toHaveCount(0);
      expect(savedTrackedPlans(userDataDir)).toEqual([]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
