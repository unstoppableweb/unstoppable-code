import { expect } from '@playwright/test';

const DEFAULT_ACTIVITY_GROUP_ID = 'group-activity';

/** Hosted account pages whose "On this computer" region always renders. */
const ACCOUNT_PAGES_WITH_DEVICE_SETTINGS = new Set([
  'account',
  'notifications',
  'integrations',
]);

/**
 * Expands the default activity rail after its panel layout has hydrated.
 *
 * Returns `false` when `optional` is true and the rail cannot be expanded
 * because the surface has no default activity group to expand — either the
 * selected layout does not contain one (for example, a Minimal layout), or no
 * panel layout hydrates at all (the panel test API is not installed on this
 * surface). Both are "nothing to do" for an optional caller, so neither may
 * throw: `selectWorktree()` runs this on EVERY selection, and a surface
 * without a hydrated panel layout would otherwise turn every such selection
 * into a poll-timeout failure across the whole suite.
 *
 * The never-throw guarantee for `optional` callers covers both the hydration
 * wait and the expand limb — a rail that stays collapsed because the expand
 * never takes degrades to `false` rather than throwing. (A page-level
 * rejection, such as a destroyed execution context, still propagates; only
 * in-page failures are absorbed.) A REQUIRED caller throws on all of them.
 *
 * `hydrationTimeout` bounds EACH phase, not the pair: a slow hydration
 * followed by a failing expand poll costs up to 2x that budget, plus up to the
 * inner click's 1s, since `expect.poll` only checks its deadline between
 * callback completions.
 */
export async function expandDefaultActivityRail(page, options = {}) {
  // Scope the affordance lookup to the activity group itself. Note this is
  // readability, not a strict-mode guarantee: both renderers of
  // `panel-group-expand-*` (PanelChrome and PanelCollapsedBar) live inside
  // this same container and are mutually exclusive within a group, so the
  // scoped locator resolves to the same match set as an unscoped one. If two
  // SURFACES each mount a collapsed `group-activity`, this still matches two
  // buttons — that hazard is upstream (one `__canopyPanelTestApi` per grid
  // mount) and is not solved here; the surrounding catch is what keeps it from
  // becoming an unhandled throw.
  const activityGroup = page.getByTestId(
    `panel-group-${DEFAULT_ACTIVITY_GROUP_ID}`,
  );
  // `hydrationTimeout` governs BOTH paths: the optional branch's bounded wait
  // and the required branch's `expect.poll`. Previously it was consulted only
  // on the optional branch, so a required caller's value was silently ignored
  // in favour of the ambient Playwright expect timeout.
  const { optional = false, hydrationTimeout = 5_000 } = options;
  const activityGroupState = () =>
    page.evaluate((groupId) => {
      let layout;
      try {
        layout = window.__canopyPanelTestApi?.getSerializedLayout();
      } catch {
        return null;
      }
      if (!layout) return null;
      const findGroup = (node) => {
        if (node.type === 'leaf') return node.groupId === groupId ? node : null;
        for (const child of node.children) {
          const found = findGroup(child);
          if (found) return found;
        }
        return null;
      };
      const group = findGroup(layout.root);
      if (!group) return 'missing';
      return group.collapsed == null ? 'expanded' : 'collapsed';
    }, DEFAULT_ACTIVITY_GROUP_ID);
  // An optional caller treats "never hydrated" the same as "no activity
  // group": bound the wait and fall through to `false` instead of letting
  // `expect.poll` throw. A required caller keeps the hard assertion so a
  // genuinely broken layout still fails loudly.
  if (optional) {
    const deadline = Date.now() + hydrationTimeout;
    let state = await activityGroupState();
    while (state === null && Date.now() < deadline) {
      await page.waitForTimeout(100);
      state = await activityGroupState();
    }
    if (state === null || state === 'missing') return false;
    return expandActivityRailFromState(state);
  }

  // Capture the value the poll settled on rather than re-reading. A second
  // evaluation can transiently return `null` — exactly what the try/catch
  // inside `activityGroupState` absorbs — and a `null` here would skip both
  // the `'missing'` branch and the expand, handing a required caller a
  // success signal for a rail that was never opened.
  let state = null;
  await expect
    .poll(
      async () => {
        state = await activityGroupState();
        return state;
      },
      {
        message: 'selected worktree panel layout should hydrate',
        timeout: hydrationTimeout,
      },
    )
    .not.toBeNull();

  if (state === 'missing') {
    throw new Error('selected panel layout has no default activity group');
  }

  return expandActivityRailFromState(state);

  async function expandActivityRailFromState(resolvedState) {
    if (resolvedState !== 'collapsed') {
      return true;
    }
    // Expanding a collapsed group follows the same click path as a user and
    // therefore makes that group active. This compatibility helper should
    // reveal the old activity surface without stealing keyboard ownership
    // from the panel the spec already selected.
    const previouslyActiveGroupId = await page.evaluate(
      () => window.__canopyPanelTestApi?.getActiveGroupId() ?? null,
    );
    // Poll to the TERMINAL state rather than asserting on the transient
    // expand affordance. The state read and the click are separate renderer
    // round-trips, and CAN-2836's own auto-expand can commit in between
    // whenever the selected worktree already has work content at hydration —
    // which unmounts the collapsed bar. Asserting `toBeVisible()` on the
    // button would then time out and THROW, even for an `optional` caller
    // this helper promises never to throw for. Treating a concurrent
    // auto-expand as an accepted outcome is the whole point.
    //
    // Re-clicking on each collapsed iteration is safe: both renderers of
    // `panel-group-expand-*` call `onCollapseGroup(groupId, false)`, which is
    // expand-only and idempotent, so a stale read cannot toggle the rail shut.
    let lastClickError = null;
    try {
      await expect
        .poll(
          async () => {
            const current = await activityGroupState();
            // No affordance can exist in these states, so skip the click
            // attempt. This is NOT an early exit — `expect.poll` keeps
            // retrying until `.toBe('expanded')` passes or the timeout
            // elapses, which is what still makes a required caller fail
            // loudly. What it saves is the 1s click attempt per iteration.
            // `null` is deliberately treated as retryable rather than fatal:
            // `activityGroupState` returns it for a transient in-page failure,
            // and a later iteration can still recover to 'collapsed'.
            if (current === null || current === 'missing') {
              return current;
            }
            if (current === 'collapsed') {
              await activityGroup
                .getByTestId(`panel-group-expand-${DEFAULT_ACTIVITY_GROUP_ID}`)
                .click({ timeout: 1_000 })
                .catch((error) => {
                  // Keep the reason for the failure message. Swallowing it
                  // outright leaves only a generic poll timeout, which is
                  // expensive to triage in a driver every spec routes through.
                  lastClickError = error;
                });
            }
            return current;
          },
          {
            message: 'activity rail should finish expanding',
            timeout: hydrationTimeout,
          },
        )
        .toBe('expanded');
    } catch (error) {
      // An `optional` caller is promised a `false`, never a throw — including
      // on this limb, where the expand itself never takes. A required caller
      // still fails loudly, now with the click error attached.
      if (optional) return false;
      if (lastClickError !== null) {
        throw new Error(
          `activity rail never expanded; last click error: ${lastClickError}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (
      previouslyActiveGroupId !== null &&
      previouslyActiveGroupId !== DEFAULT_ACTIVITY_GROUP_ID
    ) {
      await page.evaluate((groupId) => {
        window.__canopyPanelTestApi?.focusPanel(groupId);
      }, previouslyActiveGroupId);
    }
    return true;
  }
}

/**
 * Driver over the unified left sidebar (AppSidebar + More menu + account menu)
 * introduced by the left-panel rework (T1–T8). The sidebar no longer has a flat
 * list of per-page nav buttons; navigation is split across:
 *
 *   - Direct nav buttons: `sidebar-nav-{workflows,plugins,app-advisor,...}`,
 *     including the Labs page rows Overview, Kanban, Statistics and Audit
 *     Trail (each shown only while its experiment is on; E2E builds pin them
 *     on), Remote Control (flag-gated) and Claude Workers (gated on
 *     terminal mode / active worker).
 *   - The "More" popover (`sidebar-more` → `sidebar-more-item-*`):
 *     Environments, Dev pages and Customize sidebar (CAN-3678).
 *   - The account row popover (`sidebar-account-row` → `sidebar-account-menu-item-*`):
 *     Settings, Usage, Feedback, Sign in / Sign out.
 *   - Code Workspaces / Cowork Projects sections for worktree / chat selection.
 *
 * `main` (worktrees) and `chat` no longer have a dedicated sidebar button, so
 * the driver reaches them via the same global page shortcuts users have
 * (`⌘2`/`Ctrl+2` → main, `⌘3`/`Ctrl+3` → chat; see `PAGE_SHORTCUTS` in
 * `useGlobalShortcuts.ts`). Those shortcuts call `navigation.navigate(page)`
 * directly and are page-agnostic, so they work from a fresh unseeded launch.
 */
export class CanopyAppDriver {
  constructor(window) {
    this.window = window;
  }

  get #accel() {
    return process.platform === 'darwin' ? 'Meta' : 'Control';
  }

  async waitForShell(options = {}) {
    const { timeout } = options;
    await this.window.waitForLoadState('domcontentloaded');
    const sidebar = this.window.getByTestId('app-sidebar');
    const legalGate = this.window.getByTestId('legal-consent-gate');
    await expect(sidebar.or(legalGate)).toBeVisible({ timeout });
    if (await legalGate.isVisible().catch(() => false)) {
      await this.acceptLegalConsent({ timeout });
    }
    // The unified sidebar aside is the stable shell-ready signal. It renders
    // once the renderer mounts and only unmounts when the user hides it.
    await expect(sidebar).toBeVisible({
      timeout,
    });
  }

  /**
   * Accept the blocking first-run legal gate (ToS/Privacy). It renders before
   * the shell on any launch where legal consent has not been seeded, so fresh
   * launches must clear it before `waitForShell` / onboarding interactions.
   */
  async acceptLegalConsent(options = {}) {
    const { timeout = 30_000 } = options;
    const gate = this.window.getByTestId('legal-consent-gate');
    await expect(gate).toBeVisible({ timeout });
    await this.window.getByTestId('legal-consent-checkbox').check();
    await this.window.getByTestId('legal-consent-accept').click();
    await expect(gate).toBeHidden({ timeout });
  }

  /**
   * Skip the first-run import page a new install lands on (no onboarding
   * marker, no projects), the way a user who imports nothing would, so a spec
   * can continue on Home.
   */
  async skipFirstRunImport(options = {}) {
    const { timeout = 30_000 } = options;
    const page = this.window.getByTestId('first-run-import-page');
    await expect(page).toBeVisible({ timeout });
    await page.getByTestId('first-run-import-skip').click();
    await expect(page).toBeHidden({ timeout });
  }

  /** Opens the account-row popover. */
  async #openAccountMenu() {
    const menu = this.window.getByTestId('sidebar-account-menu');
    if (!(await menu.isVisible())) {
      await this.window.getByTestId('sidebar-account-row').click();
      await expect(menu).toBeVisible();
    }
    return menu;
  }

  async openMainPage() {
    await this.#blurActiveElement();
    await this.window.keyboard.press(`${this.#accel}+2`);
    await this.expectMainPage();
  }

  async openChatPage() {
    await this.#blurActiveElement();
    await this.window.keyboard.press(`${this.#accel}+3`);
    await this.expectChatPage();
  }

  /**
   * Opens the New task page with `projectId` picked, the way a user does: the
   * sidebar "New task" item, then the project picker. A sole project renders
   * no picker (CAN-2698) and is already selected. The project rows' own "+"
   * creates a task directly, so it is not a route to this page.
   *
   * The default cowork project is deliberately absent from the picker's rows
   * (CAN-2363): it is the catch-all, so the user reaches it by clearing the
   * selected project rather than choosing it from the list.
   */
  async openHomeForProject(projectId) {
    await this.window.getByTestId('sidebar-create-task').click();
    const homePage = this.window.getByTestId('page-home');
    await expect(homePage.getByTestId('home-surface')).toBeVisible();
    if (projectId === 'cowork-default') {
      // Clearing selects the catch-all, so the draft still carries a real
      // workspace id and the selected-state assertion below still holds.
      const clear = homePage.getByTestId('home-workspace-clear');
      if ((await clear.count()) > 0) {
        await clear.click();
      }
    } else {
      const picker = homePage.getByTestId('home-workspace-select');
      if ((await picker.count()) > 0) {
        await picker.click();
        await this.window
          .getByTestId(`home-workspace-option-${projectId}`)
          .click();
      }
    }
    await expect(homePage.getByTestId('home-surface')).toHaveAttribute(
      'data-workspace-selected',
      'true',
    );
    return homePage;
  }

  async #blurActiveElement() {
    // `waitForFunction` is rerunnable across renderer navigations, unlike a
    // one-shot `evaluate`. Fresh launches can finish a navigation after the
    // shell first becomes visible, so keep this focus guard tied to a live
    // execution context before sending a global page shortcut.
    await this.window.waitForFunction(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      return true;
    });
  }

  /**
   * Opens Workflows › Library (CAN-3981), where pipelines and automations
   * are rows of one table.
   */
  async openPipelinesPage() {
    await this.openWorkflowsTab('workflows-library');
    await this.expectPipelinesPage();
  }

  /**
   * Opens one Workflows tab through the sidebar Workflows row and the page's
   * tab bar. Takes a tab's page id (`workflows`, `workflows-schedule`,
   * `workflows-library`) or its name (`runs`, `schedule`, `library`).
   */
  async openWorkflowsTab(tab) {
    const id =
      {
        runs: 'workflows',
        schedule: 'workflows-schedule',
        library: 'workflows-library',
      }[tab] ?? tab;
    await this.window.getByTestId('sidebar-nav-workflows').click();
    await expect(this.window.getByTestId('page-workflows')).toBeVisible();
    const tabButton = this.window.getByTestId(`workflows-tab-${id}`);
    // Selecting the open tab is a no-op, so this is safe on every tab.
    await tabButton.click();
    await expect(tabButton).toHaveAttribute('aria-selected', 'true');
    await expect(
      this.window.getByTestId(
        id === 'workflows' ? 'page-workflows-runs' : `page-${id}`,
      ),
    ).toBeVisible();
  }

  /** The Library row for a pipeline (`source` defaults to the user's own). */
  workflowsLibraryPipelineRow(pipelineId, source = 'user') {
    return this.window.locator(
      `[data-testid="workflows-library-row"][data-row-key="pipeline:${source}:${pipelineId}"]`,
    );
  }

  /** The Library row for an automation. */
  workflowsLibraryAutomationRow(activityId) {
    return this.window.locator(
      `[data-testid="workflows-library-row"][data-row-key="automation:${activityId}"]`,
    );
  }

  /** The Runs row for a watcher. */
  workflowsWatcherRunRow(watcherId) {
    return this.window.locator(
      `[data-testid="workflows-run-row"][data-run-key="watcher:${watcherId}"]`,
    );
  }

  /** The Library row whose name is exactly `name`, for rows keyed by a path. */
  workflowsLibraryRowByName(name) {
    return this.window.getByTestId('workflows-library-row').filter({
      has: this.window
        .getByTestId('workflows-library-name')
        .getByText(name, { exact: true }),
    });
  }

  /**
   * Narrows the Library to rows matching `query`, so a row past the first
   * page of 25 is listed. Pass an empty string to list everything again.
   */
  async searchWorkflowsLibrary(query) {
    await this.window.getByTestId('workflows-library-search').fill(query);
  }

  /**
   * Sets one Library facet from the Filter button nested in the search
   * field: `facet` is `trigger`, `status`, `project` or `source`, and
   * `value` is an option value or `any`. The menu stays open while values
   * are picked, so this closes it again.
   */
  async chooseWorkflowsLibraryFilter(facet, value) {
    // The Filter menu lists one row per filter; each opens its values.
    const menu = this.window.getByTestId('workflows-library-filter-menu');
    await this.window.getByTestId('workflows-library-filter').click();
    await expect(menu).toBeVisible();
    await menu.getByTestId(`workflows-library-filter-${facet}`).click();
    const submenu = this.window.getByTestId(
      `workflows-library-filter-${facet}-menu`,
    );
    await expect(submenu).toBeVisible();
    await submenu
      .getByTestId(
        value === 'any'
          ? `workflows-library-filter-${facet}-any`
          : `workflows-library-filter-${facet}-option-${value}`,
      )
      .click();
    for (let attempt = 0; attempt < 3 && (await menu.isVisible()); attempt += 1)
      await this.window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }

  /**
   * Picks an Audit trail filter value (`all` for its any row). Three filters
   * sit inline after the search; with a selected context there are four,
   * behind one Filter dropdown.
   */
  async chooseAuditTrailFilter(filter, value) {
    const testId = `audit-trail-${filter}-filter`;
    const optionId =
      value === 'all' ? `${testId}-any` : `${testId}-option-${value}`;
    const option = this.window.getByTestId(optionId);
    const filterMenu = this.window.getByTestId('audit-trail-filter');
    if (await filterMenu.isVisible()) {
      // One row per filter in the Filter menu; each opens its values.
      const menu = this.window.getByTestId('audit-trail-filter-menu');
      await filterMenu.click();
      await expect(menu).toBeVisible();
      await menu.getByTestId(testId).click();
      await this.window
        .getByTestId(`${testId}-menu`)
        .getByTestId(optionId)
        .click();
      for (
        let attempt = 0;
        attempt < 3 && (await menu.isVisible());
        attempt += 1
      )
        await this.window.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      return;
    }
    await this.window.getByTestId(testId).click();
    await expect(this.window.getByTestId(`${testId}-menu`)).toBeVisible();
    await option.click();
    await expect(this.window.getByTestId(`${testId}-menu`)).toBeHidden();
  }

  /** Opens a Library row: the automation form, or the pipeline editor. */
  async openWorkflowsLibraryRow(row) {
    await row.getByTestId('workflows-library-name').click();
  }

  /**
   * Picks an item of a Library row's More menu: `edit`, `view-runs`,
   * `duplicate`, `share` or `delete`.
   */
  async chooseWorkflowsLibraryRowAction(row, action) {
    await row.getByTestId('workflows-library-menu').click();
    await this.window
      .getByTestId(`workflows-library-menu-item-${action}`)
      .click();
  }

  /**
   * Starts a new workflow: `build` (a pipeline, in the creation view) or
   * `schedule` (the automation form). Runs and Library open the creation
   * view directly (CAN-4319); an automation starts from Schedule, whose New
   * workflow menu offers it, so a `schedule` start from elsewhere moves there.
   */
  async startNewWorkflow(kind) {
    const direct = this.window.getByTestId('workflows-new-create');
    if (kind === 'build' && (await direct.count()) > 0) {
      await direct.first().click();
      return;
    }
    if ((await this.window.getByTestId('workflows-new').count()) === 0) {
      await this.openWorkflowsTab('workflows-schedule');
    }
    await this.window.getByTestId('workflows-new').first().click();
    await this.window.getByTestId(`workflows-new-${kind}`).click();
  }

  async openPipelineDispatchModal(pipelineName) {
    await this.window.getByTestId('pipeline-dispatch-open').click();
    const modal = this.window.getByTestId('pipeline-trigger-modal-body');
    await expect(modal).toBeVisible();
    const pipeline = modal.getByRole('button', {
      name: pipelineName,
    });
    await expect(pipeline).toBeVisible();
    await pipeline.click();
    await expect(
      this.window.getByTestId('pipeline-trigger-modal-run'),
    ).toBeVisible();
    return modal;
  }

  async openPluginsPage() {
    await this.window.getByTestId('sidebar-nav-plugins').click();
    await this.expectPluginsPage();
  }

  /** Open combined Workflows and reveal the viewer's actual shared rows. */
  async openSharedByMeAutomations() {
    await this.openPluginsPage();
    await this.window.getByTestId('plugins-type-tab-workflow').click();
    await expect(
      this.window.getByTestId('plugins-type-tab-workflow'),
    ).toHaveAttribute('aria-selected', 'true');
    await this.window
      .getByTestId('customize-section-shared-by-me')
      .scrollIntoViewIfNeeded();
  }

  async openAuditPage() {
    await this.window.getByTestId('sidebar-nav-audit').click();
    await this.expectAuditPage();
  }

  async openUsagePage() {
    await this.#openAccountMenu();
    await this.window.getByTestId('sidebar-account-menu-item-usage').click();
    await this.expectUsagePage();
  }

  async openStatisticsPage() {
    await this.window.getByTestId('sidebar-nav-statistics').click();
    await this.expectStatisticsPage();
  }

  /**
   * Opens Workflows › Library (CAN-3981); scheduled automations are its
   * scheduled and one-time rows.
   */
  async openAutomationsPage() {
    await this.openWorkflowsTab('workflows-library');
    await this.expectAutomationsPage();
  }

  /** Opens Workflows › Runs, which lists watchers beside the runs. */
  async openWatchersPage() {
    await this.openWorkflowsTab('workflows');
  }

  /**
   * Opens Marketplace › Agents (CAN-4266: local agents moved here when the
   * Agents page retired). Requires the `canopy-shared-custom-agents` flag.
   * From an open detail too: the current Customize row returns to its root.
   */
  async openMarketplaceAgents() {
    await this.openPluginsPage();
    await expect(
      this.window.getByTestId('plugins-entry-detail-page'),
    ).toHaveCount(0);
    await this.window.getByTestId('plugins-type-tab-agent').click();
    await this.expectMarketplaceAgents();
  }

  async createMarketplaceAgent() {
    await this.window.getByTestId('plugins-add-custom-menu').click();
    await this.window.getByTestId('plugins-add-custom-agent').click();
    await expect(this.window.getByTestId('agent-model-modal')).toBeVisible();
  }

  async openLocalAgentShare(agentId) {
    const detail = this.window.getByTestId('local-agent-marketplace-detail');
    if (!(await detail.isVisible())) await this.openLocalAgentDetail(agentId);
    await expect(detail).toContainText(agentId);
    await this.window.getByTestId('plugins-entry-detail-share').click();
    await expect(this.window.getByTestId('share-agent-modal')).toBeVisible();
  }

  async deleteMarketplaceAgent(agentId) {
    const detail = this.window.getByTestId('local-agent-marketplace-detail');
    if (!(await detail.isVisible())) await this.openLocalAgentDetail(agentId);
    await expect(detail).toContainText(agentId);
    await this.window.getByTestId('local-agent-detail-delete').click();
  }

  /** An agent created from Add custom lands on its own detail. */
  async expectCreatedLocalAgentDetail(agentId) {
    const detail = this.window.getByTestId('local-agent-marketplace-detail');
    await expect(detail).toContainText(agentId);
    return detail;
  }

  /**
   * Any item created from Add custom (skill, collection, MCP server) lands on
   * its own Customize detail, the page a click on its row opens.
   */
  async expectCreatedCustomizeDetail(name) {
    const detail = this.window.getByTestId('plugins-entry-detail-page');
    await expect(detail).toContainText(name);
    return detail;
  }

  /** Opens a local agent's Marketplace detail from the Agents tab. */
  async openLocalAgentDetail(agentId) {
    await this.window
      .getByTestId(`customize-row-agent:local:${agentId}`)
      .click();
    const detail = this.window.getByTestId('local-agent-marketplace-detail');
    await expect(detail).toBeVisible();
    return detail;
  }

  /**
   * Leaves an open Marketplace entry detail through its "Marketplace"
   * breadcrumb, which keeps the selected type tab.
   */
  async closeMarketplaceEntryDetail() {
    await this.window
      .getByTestId('plugins-entry-detail-breadcrumb-root')
      .click();
    await expect(
      this.window.getByTestId('plugins-entry-detail-page'),
    ).toHaveCount(0);
  }

  /** Opens Settings → Environments (CAN-4269: it left the sidebar). */
  async openEnvironmentsSettings() {
    await this.openSettings();
    await this.openSettingsSection('environment');
    await expect(
      this.window.getByTestId('settings-tab-environment'),
    ).toBeVisible();
  }

  async openOverviewPage() {
    await this.window.getByTestId('sidebar-nav-overview').click();
    await expect(this.window.getByTestId('overview-page')).toBeVisible();
  }

  /** Navigates to the Kanban board via its main-nav row (a Labs page). */
  async openKanbanPage() {
    await this.window.getByTestId('sidebar-nav-kanban').click();
    // The board lives inside MainPage's always-mounted tree; the kanban section
    // renders `worktree-panel` when the page is active.
    await expect(this.window.getByTestId('worktree-panel')).toBeVisible();
  }

  /**
   * Re-shows the sidebar if it is hidden, using the sidebar toggle
   * (`sidebar-toggle`). Exactly one `sidebar-toggle` element exists
   * app-wide: the single fixed titlebar-layer toggle rendered by App.tsx at
   * constant window coordinates in both states. When hidden, the aside
   * stays mounted at width 0, so `isVisible()` (empty bounding box) is the
   * right hidden-state check — not element absence.
   */
  async showSidebar() {
    const sidebar = this.window.getByTestId('app-sidebar');
    if (await sidebar.isVisible()) {
      return;
    }
    await this.window.getByTestId('sidebar-toggle').click();
    await expect(sidebar).toBeVisible();
  }

  /**
   * Opens App Advisor in its full workspace window. The sidebar row opens it
   * as the docked page in the main window; this moves the same page into the
   * separate full window, whose nav callers exercise, and returns that page
   * once the cowork-style workspace surface has finished its scoped bootstrap
   * (`app-advisor-workspace-surface` visible with the loading gate gone).
   * Requires the `electronApp` handle.
   */
  async openAppAdvisorWindow(electronApp) {
    await this.window.getByTestId('sidebar-nav-app-advisor').click();
    let advisor;
    await expect
      .poll(
        async () => {
          for (const page of electronApp.windows()) {
            if (!page.url().includes('app-advisor')) continue;
            if (
              await page.getByTestId('app-advisor-workspace-surface').count()
            ) {
              advisor = page;
              return true;
            }
          }
          return false;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(
      advisor.getByTestId('app-advisor-workspace-loading'),
    ).toHaveCount(0, { timeout: 30_000 });
    await advisor.evaluate(() =>
      window.api.appAdvisor.openWindow({ layout: 'full', focus: true }),
    );
    // Full layout mounts navigation even when its saved state is collapsed.
    await expect(advisor.getByTestId('app-advisor-nav')).toBeAttached();
    return advisor;
  }

  /**
   * Selects a worktree row by its stable worktree id, branch attribute, or
   * visible text. The sidebar now promotes the active chat title over the
   * branch label, so callers that hold a worktree id must not depend on that
   * branch text remaining visible.
   */
  async selectWorktree(branchOrText, options = {}) {
    const byWorktreeId = this.window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${branchOrText}"]`,
    );
    const byBranch = this.window.locator(
      `[data-testid="worktree-row"][data-branch="${branchOrText}"]`,
    );
    const byVisibleText = this.window
      .getByTestId('worktree-row')
      .filter({ hasText: branchOrText });
    const exactRow = byWorktreeId.or(byBranch).first();
    // Wait for an exact identity match through renderer hydration before
    // falling back to visible text. Keeping the fuzzy locator separate
    // prevents an earlier substring match from winning by DOM order.
    const exactRowVisible = await exactRow
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    const row = exactRowVisible ? exactRow : byVisibleText.first();
    // CAN-1074 can deliberately cover the canonical flow row with a
    // portalled selected-row or sticky-workspace copy. This driver method is
    // setup/navigation by stable identity, not a hit-testing assertion, so
    // dispatch directly to the resolved canonical row even while that copy
    // occludes its screen coordinates.
    await row.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error('Expected a worktree row element');
      }
      element.click();
    });
    // `HTMLElement.click()` deliberately bypasses actionability for covered
    // canonical rows, so unlike Playwright's click it returns before React's
    // navigation and panel-layout hydration have settled. First wait for the
    // clicked canonical row itself to become selected; generic hydrated
    // surfaces can already be visible while switching between worktrees.
    const selectedRowFrame = this.window
      .locator('[data-sidebar-selected-item]')
      .filter({ has: row });
    await expect(selectedRowFrame).toHaveCount(1);
    // Then keep this shared driver method's historical postcondition: callers
    // can immediately use the selected worktree surface.
    await expect(this.window.getByTestId('worktree-part')).toBeVisible();
    await expect(this.window.getByTestId('panel-grid-root')).toBeVisible();

    // COMPATIBILITY SHIM (CAN-2836): the shipped default now seeds a worktree
    // with the activity rail COLLAPSED, but ~150 specs predate that and assume
    // an expanded rail. Rather than flip all of them in one change, the driver
    // re-expands by default and the specs that assert the real product default
    // opt out with `{ expandDefaultActivityRail: false }`.
    //
    // TODO(CAN-2836-followup): invert this to opt-in
    // (`options.expandDefaultActivityRail === true`) so the harness reflects
    // production, migrating the activity-dependent call sites explicitly. Until
    // then, a NEW spec that cares about the rail's real default must pass
    // `{ expandDefaultActivityRail: false }` — it will otherwise silently
    // inherit an expanded rail that users never see.
    if (options.expandDefaultActivityRail !== false) {
      // Short hydration budget on purpose: this runs on every worktree
      // selection across the suite, so a systemic harness break must not
      // silently add 5s per call. A locally-mounted grid hydrates well
      // inside 2s.
      await expandDefaultActivityRail(this.window, {
        optional: true,
        hydrationTimeout: 2_000,
      });
    }
  }

  /**
   * Returns the canonical in-flow git workspace header. Sticky workspace
   * behavior and selected-item pinning intentionally render header copies in
   * portals, so sidebar-wide text and control locators are ambiguous.
   */
  workspaceHeader(name) {
    return this.window
      .locator(
        '[data-sidebar-workspace-id] [data-testid^="sidebar-project-header-"]',
      )
      .filter({ has: this.window.getByText(name, { exact: true }) });
  }

  workspaceHeaderLabel(name) {
    return this.workspaceHeader(name).getByText(name, { exact: true });
  }

  workspaceSettingsButton(name) {
    return this.workspaceHeader(name).getByLabel(`Settings for ${name}`, {
      exact: true,
    });
  }

  async openSettings() {
    const directSettingsAction = this.window.getByTestId(
      'sidebar-account-action-settings',
    );
    if (await directSettingsAction.isVisible()) {
      await directSettingsAction.click();
    } else {
      await this.#openAccountMenu();
      await this.window
        .getByTestId('sidebar-account-menu-item-settings')
        .click();
    }
    await expect(this.window.getByTestId('settings-overlay')).toBeVisible();
  }

  async openCanopyPortal() {
    // CAN-3659: Remote Control opens from the account menu; the desktop
    // sidebar nav no longer lists it.
    const menu = await this.#openAccountMenu();
    await menu.getByTestId('sidebar-account-menu-item-remote-control').click();
    await this.expectCanopyPortalModal();
  }

  async closeSettings() {
    await this.window.getByTestId('settings-nav-back').click();
    await expect(this.window.getByTestId('settings-overlay')).toBeHidden();
  }

  async openSettingsSection(section) {
    await this.window.getByTestId(`settings-nav-${section}`).click();
    await this.expectSettingsSection(section);
  }

  /**
   * Open a hosted account settings page (CAN-4421) from the Settings rail:
   * `account`, `profile`, `digests`, `notifications`, `integrations`,
   * `security` or `billing`. Settings must already be open with hosted
   * settings available (the launcher pins the flag on).
   */
  async openAccountSettingsPage(page) {
    await this.window.getByTestId(`settings-nav-account-${page}`).click();
    await this.expectAccountSettingsPage(page);
  }

  /**
   * Assert a hosted account page is showing, in any host state. Pages with
   * "On this computer" sections that always render (Account, Notifications,
   * Integrations) also wait for that region; Public profile's catalog card is
   * flag-gated, so it waits for the page frame only.
   */
  async expectAccountSettingsPage(page) {
    const pageKey = `account/${page}`;
    await expect(
      this.window.locator(
        ['hosted-settings-content', 'hosted-settings-frame']
          .map(
            (testId) =>
              `[data-testid="${testId}"][data-hosted-settings-page="${pageKey}"]`,
          )
          .join(', '),
      ),
    ).toBeVisible();
    if (ACCOUNT_PAGES_WITH_DEVICE_SETTINGS.has(page)) {
      await expect(
        this.window.getByTestId(`account-device-settings-${page}`),
      ).toBeVisible();
    }
  }

  /** Exercise the compatibility entry point and wait for canonical Customize UI. */
  async openPluginsTab(tab) {
    await this.window.evaluate((target) => {
      const management = target === 'installed' || target === 'marketplaces';
      window.dispatchEvent(
        new CustomEvent(
          management
            ? 'canopy:plugins-open-management'
            : 'canopy:plugins-open-tab',
          {
            detail: management ? { section: target } : { tab: target },
          },
        ),
      );
    }, tab);
    await this.expectPluginsTab(tab);
  }

  async expectMainPage() {
    await expect(this.window.getByTestId('page-main')).toBeVisible();
  }

  async expectChatPage() {
    await expect(this.window.getByTestId('page-chat')).toBeVisible();
  }

  async expectPipelinesPage() {
    await expect(
      this.window.getByTestId('page-workflows-library'),
    ).toBeVisible();
  }

  async expectPluginsPage() {
    await expect(this.window.getByTestId('page-plugins')).toBeVisible();
    await expect(
      this.window.getByRole('heading', { name: 'Customize', exact: true }),
    ).toBeVisible();
  }

  async expectAuditPage() {
    await expect(this.window.getByTestId('page-audit')).toBeVisible();
    await expect(
      this.window.getByRole('heading', { name: 'Audit Trail' }),
    ).toBeVisible();
  }

  async expectUsagePage() {
    await expect(this.window.getByTestId('page-usage')).toBeVisible();
    await expect(
      this.window.getByRole('heading', { name: 'Usage' }),
    ).toBeVisible();
  }

  async expectStatisticsPage() {
    await expect(this.window.getByTestId('page-statistics')).toBeVisible();
    await expect(
      this.window.getByRole('heading', { name: 'Statistics', exact: true }),
    ).toBeVisible();
  }

  async expectAutomationsPage() {
    await expect(
      this.window.getByTestId('page-workflows-library'),
    ).toBeVisible();
  }

  /** Assert the Marketplace is open on its Agents tab. */
  async expectMarketplaceAgents() {
    await this.expectPluginsPage();
    await expect(
      this.window.getByTestId('plugins-type-tab-agent'),
    ).toHaveAttribute('aria-selected', 'true');
  }

  async expectCanopyPortalModal() {
    await expect(this.window.getByTestId('canopy-portal-modal')).toBeVisible();
    await expect(
      this.window.getByRole('heading', {
        name: 'Remote Control',
        exact: true,
      }),
    ).toBeVisible();
  }

  /** Legacy type names normalize to Customize tabs and their Installed section. */
  async expectPluginsTab(tab) {
    const targets = {
      installed: 'all',
      marketplace: 'sources',
      marketplaces: 'sources',
      skills: 'skill',
      mcp: 'app',
      collections: 'collection',
      bundles: 'collection',
    };
    const target = targets[tab];
    if (!target) throw new Error(`Unknown Customize tab: ${tab}`);
    await this.expectPluginsPage();
    await expect(
      this.window.getByTestId(`plugins-type-tab-${target}`),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      this.window.getByTestId(
        target === 'sources'
          ? 'marketplace-sources'
          : 'customize-section-installed',
      ),
    ).toBeVisible();
  }

  async expectSettingsSection(section) {
    await expect(
      this.window.getByTestId(`settings-tab-${section}`),
    ).toBeVisible();
  }
}

/**
 * Close a panel tab via its hover-revealed close control.
 *
 * The close button shares its slot with the tab's leading icon and is only
 * hit-testable while the tab is `:hover`-ed (`panels.css` swaps the two:
 * the icon goes `visibility: hidden`, the button gets `pointer-events`).
 * On loaded CI runners the `:hover` state repeatedly fails to be in effect
 * at hit-test time — re-renders replace the node under a stationary CDP
 * pointer and Chromium does not re-apply `:hover` until the next mouse move
 * — so a one-shot `click()` keeps reporting the icon (`<svg>`/`<path>` from
 * `.canopy-panel-tab-main`) as "subtree intercepts pointer events" until it
 * times out (CAN-2436: Internal Release 32456587191 attempts 1+3, standalone
 * verify run 32464410606 across five shards / six specs). Re-establish hover
 * and retry the pair until the reveal sticks; the click itself still goes
 * through real pointer dispatch, so a genuinely unclickable control still
 * fails after the deadline.
 *
 * A BUSY tab (a chat streaming its turn) keeps its spinner on hover and
 * renders no close button at all, so close it from its context menu instead
 * of through this helper — see `chat-tab-busy-hover.spec.mjs`.
 *
 * @param {import('playwright').Page} window - window that owns the tab strip
 * @param {string} panelId - panel id, i.e. the `panel-tab-${panelId}` testid
 *   suffix (`panel-chat-<chatId>` for chat tabs)
 */
export async function closePanelTab(
  window,
  panelId,
  { timeout = 30_000 } = {},
) {
  const tab = window.getByTestId(`panel-tab-${panelId}`);
  const close = window.getByTestId(`panel-tab-close-${panelId}`);
  // Windows native hover/click dispatch can take >2s after actionability has
  // passed. Let each real action finish within the existing total retry budget.
  const actionTimeout = process.platform === 'win32' ? 10_000 : 2_000;
  await expect(async () => {
    await tab.hover({ timeout: actionTimeout });
    await close.click({ timeout: actionTimeout });
  }).toPass({ timeout });
}

function boundingBoxesMatch(a, b, tolerance) {
  return (
    a !== null &&
    b !== null &&
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

function formatBoundingBox(box) {
  return box === null
    ? 'null'
    : `{ x: ${box.x}, y: ${box.y}, width: ${box.width}, height: ${box.height} }`;
}

/**
 * Resolve once `locator`'s bounding box has been unchanged for `stableMs`.
 *
 * Measure-then-point interactions (`boundingBox()` → `mouse.move`/`down`) are
 * only correct while the geometry they measured still holds. The sidebar's
 * compact-viewport collapse-into-"More" is an async measurement pass that can
 * land after a spec has already measured a row, moving it out from under the
 * held pointer (CAN-2583). Waiting for a settled box replaces the arbitrary
 * sleeps that would otherwise paper over that race.
 *
 * Boxes are compared with a sub-pixel `tolerance` rather than strict
 * equality: Playwright reports fractional CSS pixels, and demanding
 * bit-identical doubles would let a hair of jitter burn the whole timeout —
 * reintroducing the flake this helper exists to remove. The candidate box is
 * pinned for the whole stable window, so cumulative drift is bounded by
 * `tolerance` and cannot creep poll by poll. The shift this guards against is
 * ~164px, so 0.5px is nowhere near it.
 *
 * @param {import('playwright').Locator} locator - element to measure
 * @returns {Promise<{x: number, y: number, width: number, height: number}>}
 *   the settled bounding box
 */
/**
 * Per-candidate probe budget inside {@link revealRowActions}. Short on
 * purpose: a candidate that cannot answer promptly is one the sidebar is busy
 * replacing, and the enclosing retry will look again.
 */
const CANDIDATE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Wait until a locator resolves to an element that stays connected and stops
 * moving. Lifted out of `workspace-header-hover-click.spec.mjs` and
 * `sidebar-row-actions-menu-open.spec.mjs`, which each carried an identical
 * copy, so every hover-reveal path settles the same way.
 *
 * @param {import('playwright').Page} window
 * @param {import('playwright').Locator} locator
 * @returns {Promise<{x: number, y: number, width: number, height: number}>}
 *   the settled bounding box
 */
export async function waitForStableLocator(window, locator) {
  await expect(async () => {
    const element = await locator.elementHandle();
    expect(element).not.toBeNull();
    await window.waitForTimeout(750);
    expect(await element.evaluate((node) => node.isConnected)).toBe(true);
  }).toPass({ timeout: 15_000 });
  // Connectedness alone is not enough: the sidebar's async collapse-into-
  // "More" measurement pass can move a still-connected row between this
  // check and the hover that follows, so the hover lands off the row and the
  // reveal never fires (CAN-2583). Require settled geometry too.
  return waitForStableBoundingBox(locator);
}

/**
 * Reveal a sidebar row's hover-only trailing actions and return the control
 * that actually became clickable.
 *
 * Two things make this harder than `locator.hover()`:
 *
 *  - `WorkspaceSectionHeader` renders the trailing overlay
 *    `pointer-fine:invisible` until `group-hover/sidebar-item` lands, and
 *    `visibility: hidden` is the one state Playwright will not click through.
 *    A hover that lands anywhere else leaves the control hidden, and the whole
 *    budget is then spent reporting "element is not visible" against the
 *    control rather than against the hover that actually failed.
 *  - The same accessible name can exist several times over: the live row, a
 *    pinned copy of it, and the zero-sized host the collapse-into-"More"
 *    measurement pass renders into. Hovering the row a caller *thinks* owns
 *    the control is therefore not reliable — the sized instance can belong to
 *    a different row entirely.
 *
 * So work from the control outwards: for each instance that has a real box,
 * hover the `group/sidebar-item` that owns it and check whether that instance
 * became visible. Zero-sized instances are the measurement copies and are
 * skipped.
 *
 * @param {import('playwright').Page} window
 * @param {import('playwright').Locator} control - may match more than one node
 * @returns {Promise<import('playwright').Locator>} the revealed instance
 */
export async function revealRowActions(window, control) {
  let revealed = null;
  await expect(async () => {
    const candidates = await control.all();
    expect(candidates.length).toBeGreaterThan(0);
    const diagnostics = [];
    for (const [index, candidate] of candidates.entries()) {
      // Re-measure every attempt: the sidebar's async collapse-into-"More"
      // pass can move a still-connected row between one poll and the next
      // (CAN-2583), and a box captured once sends the pointer to where the
      // row used to be.
      //
      // Every candidate operation is explicitly bounded. This repository sets
      // no `actionTimeout`, so Playwright's default is "wait forever" — and a
      // candidate that detaches during the very rerender we are racing would
      // block here indefinitely. `toPass` cannot cancel a callback that is
      // already pending, so an unbounded call does not fail this helper with
      // its own diagnostic; it hangs until the enclosing test times out with a
      // generic message. A detached candidate is a retryable miss, not a wait.
      let state = null;
      try {
        state = await candidate.evaluate(
          (node) => {
            const row = node.closest('.group\\/sidebar-item') ?? node;
            const rect = row.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              row: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
              // Read from the control itself: the row can be laid out while
              // the control inside it is still withheld.
              opacity: Number(style.opacity),
              pointerEvents: style.pointerEvents,
              visibility: style.visibility,
            };
          },
          undefined,
          { timeout: CANDIDATE_PROBE_TIMEOUT_MS },
        );
      } catch {
        diagnostics.push(`#${index}: unresolvable (detached or slow)`);
        continue;
      }

      const { row } = state;
      if (row.width === 0 || row.height === 0) {
        // The zero-sized host the collapse-into-"More" measurement pass
        // renders into. Never a real control.
        diagnostics.push(`#${index}: zero-sized row`);
        continue;
      }

      // A leading coordinate inside the row: inside the hover group, and on
      // nothing that swallows the pointer. `workspace-header-hover-click`
      // drives this surface the same way for the same reason.
      await window.mouse.move(row.x + 20, row.y + row.height / 2);

      // Actionability, not visibility. Playwright calls an element visible
      // when it has a layout box, and this sidebar withholds its actions with
      // `opacity-0 pointer-events-none` — which keeps the box. Returning on
      // `isVisible()` therefore hands back a control the caller's `.click()`
      // then fails on, with exactly the generic "element is not visible"
      // timeout this helper exists to replace.
      let revealedState = null;
      try {
        revealedState = await candidate.evaluate(
          (node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return {
              opacity: Number(style.opacity),
              pointerEvents: style.pointerEvents,
              visibility: style.visibility,
              inViewport:
                rect.bottom > 0 &&
                rect.right > 0 &&
                rect.top < window.innerHeight &&
                rect.left < window.innerWidth,
            };
          },
          undefined,
          { timeout: CANDIDATE_PROBE_TIMEOUT_MS },
        );
      } catch {
        diagnostics.push(`#${index}: unresolvable after hover`);
        continue;
      }

      if (
        revealedState.opacity > 0 &&
        revealedState.pointerEvents !== 'none' &&
        revealedState.visibility !== 'hidden' &&
        revealedState.inViewport
      ) {
        revealed = candidate;
        return;
      }
      diagnostics.push(
        `#${index}: row ${Math.round(row.x)},${Math.round(row.y)} ${Math.round(row.width)}x${Math.round(row.height)} → opacity=${revealedState.opacity} pointer-events=${revealedState.pointerEvents} visibility=${revealedState.visibility} inViewport=${revealedState.inViewport}`,
      );
    }
    throw new Error(
      `no sidebar row revealed the requested hover action. ${candidates.length} candidate(s) inspected:\n  ${diagnostics.join('\n  ')}`,
    );
  }).toPass({ timeout: 20_000 });
  return revealed;
}

export async function waitForStableBoundingBox(
  locator,
  { stableMs = 300, timeout = 10_000, pollMs = 50, tolerance = 0.5 } = {},
) {
  const deadline = Date.now() + timeout;
  let candidate = null;
  let candidateSince = 0;
  let previous = null;
  for (;;) {
    // `boundingBox()` defaults to NO timeout (Playwright's own default is 0,
    // and this repo sets no `actionTimeout`), so an absent or detached
    // locator would block here forever — past this helper's deadline, past
    // its diagnostic, all the way to the enclosing 60s test timeout and its
    // useless generic message. Bound every poll by the remaining budget, and
    // never by 0, which Playwright reads as "wait forever".
    let box = null;
    try {
      box = await locator.boundingBox({
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch {
      // Unresolvable this poll: fall through as "not settled" and let the
      // deadline check below report it with the collected geometry.
      box = null;
    }
    const now = Date.now();
    if (box !== null && boundingBoxesMatch(box, candidate, tolerance)) {
      if (now - candidateSince >= stableMs) return box;
    } else {
      previous = candidate;
      candidate = box;
      candidateSince = now;
    }
    if (now >= deadline) {
      throw new Error(
        `Bounding box never held still for ${stableMs}ms within ${timeout}ms. ` +
          `Last: ${formatBoundingBox(candidate)}, previous: ${formatBoundingBox(previous)}`,
      );
    }
    await locator.page().waitForTimeout(pollMs);
  }
}

/*
 * Workflows edit shell (CAN-4072). Automations and pipelines open in one
 * full-page shell with Definition / Trigger / Runs sections. Adapters keep
 * their older test ids for Back and Save, so the helpers below match either.
 */

// A pipeline (CAN-4319) leaves through the first crumb of the page's bar.
const WORKFLOW_EDIT_BACK_SELECTOR = [
  '[data-testid="workflow-edit-back"]',
  '[data-testid="pipeline-editor-back"]',
  '[data-testid="workflow-edit-toolbar-back"]',
].join(', ');
const WORKFLOW_EDIT_SAVE_SELECTOR = [
  '[data-testid="automations-form-submit"]',
  '[data-testid="pipeline-save"]',
  '[data-testid="workflow-edit-save"]',
].join(', ');

/** The edit target the navigation store holds, or null on the list. */
export async function workflowEditTarget(page) {
  return page.evaluate(
    () => window.__canopyNavigationTestApi?.workflowEdit() ?? null,
  );
}

/**
 * Selects a shell section (`definition`, `trigger` or `runs`) and returns
 * its mounted panel. Visited sections stay mounted but hidden, so scope
 * field lookups to the returned panel.
 */
export async function openWorkflowEditSection(page, section) {
  const shell = page.getByTestId('workflow-edit-shell');
  await expect(shell).toBeVisible();
  const tab = shell.getByTestId(`workflow-edit-tab-${section}`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = shell.getByTestId(`workflow-edit-section-${section}`);
  await expect(panel).toBeVisible();
  return panel;
}

function isWorkflowEditDraftTarget(target) {
  if (!target) return false;
  if (target.kind === 'automation-draft') return true;
  return (
    target.kind === 'pipeline' &&
    (target.pipelineId === null || target.pipelineId === undefined) &&
    !target.sharedRemoteId
  );
}

/**
 * Presses the shell's primary Save (`Create automation` on a draft) and
 * waits until it lands: a draft swaps to its saved item in place, and a
 * saved item reports no unsaved edits. The shell stays open on the saved
 * item. A draft's `data-dirty` is always "false" (its save state is "new"),
 * so drafts are tracked through the navigation target instead.
 */
export async function saveWorkflowEdit(page, { timeout = 30_000 } = {}) {
  const shell = page.getByTestId('workflow-edit-shell');
  await expect(shell).toBeVisible();
  const draft = isWorkflowEditDraftTarget(await workflowEditTarget(page));
  const save = shell.locator(WORKFLOW_EDIT_SAVE_SELECTOR).first();
  await expect(save).toBeEnabled();
  await save.click();
  if (draft) {
    await expect
      .poll(
        async () => isWorkflowEditDraftTarget(await workflowEditTarget(page)),
        { timeout },
      )
      .toBe(false);
  }
  await expect(shell).toHaveAttribute('data-dirty', 'false', { timeout });
  await expect(save).not.toHaveAttribute('aria-busy', 'true', { timeout });
}

/**
 * Opens the edit shell's ⋯ menu and returns the row with `testId` (Turn
 * on/off, Duplicate or Delete). The menu is portaled, so the row is found on
 * the page rather than inside the shell.
 */
export async function workflowEditMenuItem(page, testId) {
  const menu = page.getByTestId('workflow-edit-menu');
  if (!(await menu.isVisible())) {
    await page
      .getByTestId('workflow-edit-shell')
      .getByTestId('workflow-edit-more')
      .click();
  }
  await expect(menu).toBeVisible();
  return menu.getByTestId(testId);
}

/**
 * Deletes the open item through the ⋯ menu and the shell's confirmation.
 * `deleteTestId` is the adapter's Delete id; its confirm button takes the
 * same id with `-confirm`.
 */
export async function deleteFromWorkflowEdit(page, deleteTestId) {
  await (await workflowEditMenuItem(page, deleteTestId)).click();
  await expect(page.getByTestId('workflow-edit-delete-dialog')).toBeVisible();
  await page.getByTestId(`${deleteTestId}-confirm`).click();
}

/**
 * Presses the shell's Back. With `discard`, answers the unsaved-changes
 * dialog with Discard; without it, the shell must leave without asking.
 * Resolves once the navigation store has moved off this edit target (to the
 * list, or to the target's `returnTo`).
 */
export async function backFromWorkflowEdit(page, { discard = false } = {}) {
  const before = JSON.stringify(await workflowEditTarget(page));
  const dialog = page.getByTestId('workflows-unsaved-dialog');
  await page.locator(WORKFLOW_EDIT_BACK_SELECTOR).first().click();
  if (discard) {
    await expect(dialog).toBeVisible();
    await page.getByTestId('workflows-unsaved-discard').click();
  }
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => JSON.stringify(await workflowEditTarget(page)))
    .not.toBe(before);
}

async function discardWorkflowEditInWindow(page) {
  if (page.isClosed()) return;
  const dialog = page.getByTestId('workflows-unsaved-dialog');
  const shell = page.getByTestId('workflow-edit-shell');
  // `data-dirty` stays "false" on an edited draft, so leave any open shell
  // (or not-found state) through Back. A Back can land on the `returnTo`
  // item, which may itself hold edits.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await dialog.isVisible().catch(() => false)) {
      await page.getByTestId('workflows-unsaved-discard').click();
      await expect(dialog).toBeHidden({ timeout: 5_000 });
      continue;
    }
    const back = page.locator(WORKFLOW_EDIT_BACK_SELECTOR).first();
    const open =
      (await shell.isVisible().catch(() => false)) ||
      (await page
        .getByTestId('workflow-edit-not-found')
        .isVisible()
        .catch(() => false));
    if (!open || !(await back.isVisible().catch(() => false))) return;
    const before = JSON.stringify(await workflowEditTarget(page));
    await back.click({ timeout: 5_000 });
    await expect(async () => {
      const asked = await dialog.isVisible();
      const moved = JSON.stringify(await workflowEditTarget(page)) !== before;
      expect(asked || moved).toBe(true);
    }).toPass({ timeout: 5_000 });
  }
}

/**
 * Leaves every window clean so app teardown is not held by the
 * unsaved-changes quit prompt. Accepts a page or the Electron app (every
 * window). If the shell is open, presses Back (and Discard when it asks);
 * if that cannot run (a modal covers Back), clears the dirty report main
 * uses to intercept the quit. Never throws.
 */
export async function discardWorkflowEditIfOpen(pageOrApp) {
  if (!pageOrApp) return;
  const pages =
    typeof pageOrApp.windows === 'function' ? pageOrApp.windows() : [pageOrApp];
  for (const page of pages) {
    if (page.isClosed()) continue;
    try {
      await discardWorkflowEditInWindow(page);
    } catch {
      // Fall through to the dirty-report reset below.
    }
    await page
      .evaluate(() => window.api?.appWindow?.setUnsavedChanges?.(false))
      .catch(() => undefined);
  }
}
