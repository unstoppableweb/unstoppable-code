// Daemon workflows acceptance (CAN-5086) against the daemon the lane bridges
// into the product's lookup paths. With no Labs switch (CAN-5960), a workflow
// the main window starts runs in the daemon's pipeline host: its step's
// grandparent is the daemon and its output streams live. A workflow with a
// child pipeline step, which the route excludes in code, runs in process
// while the earlier daemon run still opens; its TypeScript step runs there too.
// A run keeps going after the app quits, with the harness keeping the daemon
// across the close (CAN-5862), and the next launch shows its result.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyE2eDaemonHosts } from '../../../../scripts/lib/e2e-core-daemon-artifact.mjs';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  closeCanopy,
  killRetainedDaemons,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import {
  expectPipelineRunPanel,
  closePipelineRunPanels,
  reopenCompletedStep,
  showPipelineJobList,
} from './pipelineUi.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { openNativeObserver } from './nativeSurvivalClient';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  clearScenario,
} from './seeders/registerScenario.mjs';

test.skip(
  !['darwin', 'linux'].includes(process.platform),
  'The retained-process fixture requires a supported POSIX daemon artifact.',
);

const WORKTREE_BRANCH = 'demo-main';
const PIPELINE_NAME = 'E2E Background Workflow';
const CHILD_PIPELINE_NAME = 'E2E Child Pipeline Workflow';
const FIXTURE_DIR = path.join('.canopy', 'e2e-daemon-pipelines');

function fixtureApp(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  mkdirSync(path.join(worktreePath, FIXTURE_DIR), { recursive: true });
  seedStoredPipeline({
    userDataDir,
    id: 'e2e-background-workflow',
    name: PIPELINE_NAME,
    yaml: [
      `name: ${PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  work:',
      '    name: Work',
      '    steps:',
      '      - id: emit',
      '        name: Emit markers',
      '        run: |',
      `          echo "marker-1 grandparent=$(ps -o ppid= -p $PPID | tr -d ' ')"`,
      `          while [ ! -f ${FIXTURE_DIR}/release ]; do sleep 0.2; done`,
      '          echo marker-2',
      '',
    ].join('\n'),
  });
  // A child pipeline step keeps the whole run in process (`child_pipeline`).
  seedStoredPipeline({
    userDataDir,
    id: 'e2e-child-workflow',
    name: CHILD_PIPELINE_NAME,
    yaml: [
      `name: ${CHILD_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  work:',
      '    name: Work',
      '    steps:',
      '      - id: emit',
      '        name: Emit markers',
      '        run: |',
      `          echo "marker-1 grandparent=$(ps -o ppid= -p $PPID | tr -d ' ')"`,
      '      - id: child',
      '        name: Child',
      '        uses: builtin/run-pipeline',
      '        with:',
      '          pipeline_yaml: |',
      '            name: E2E Child',
      '            on: dispatch',
      '            jobs:',
      '              child:',
      '                steps:',
      '                  - run: echo child-ran',
      // CAN-6026: an in-process TypeScript step must run tsx as Node.
      '      - id: typescript',
      '        name: TypeScript',
      '        shell: tsx',
      '        run: |',
      "          const kind: string = 'tsx';",
      '          console.log(`typescript-ran ${kind}`);',
      '',
    ].join('\n'),
  });
  return { userDataDir, worktreePath };
}

function release(worktreePath) {
  writeFileSync(path.join(worktreePath, FIXTURE_DIR, 'release'), 'go\n');
}

function hold(worktreePath) {
  rmSync(path.join(worktreePath, FIXTURE_DIR, 'release'), { force: true });
}

async function launch(userDataDir, options = {}) {
  const { electronApp } = await launchCanopy({ userDataDir, ...options });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
  return { electronApp, window };
}

/** The daemon serving this data root, from its descriptor. */
function daemonPid(userDataDir) {
  const descriptor = path.join(
    realpathSync(userDataDir),
    'runtime',
    'core.json',
  );
  return existsSync(descriptor)
    ? JSON.parse(readFileSync(descriptor, 'utf8')).pid
    : undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Stops a daemon the app left running, then removes the data roots. */
async function cleanup(userDataDir) {
  const pid = daemonPid(userDataDir);
  if (pid !== undefined && isAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    await expect.poll(() => isAlive(pid), { timeout: 30_000 }).toBe(false);
  }
  await removeTestDataDir(userDataDir);
  await removeTestDataDir(`${userDataDir}-secure`);
}

async function dispatch(window, name = PIPELINE_NAME) {
  const cards = window
    .locator('[data-testid^="pipeline-run-card-"]')
    .filter({ hasText: name });
  const before = new Set(
    await cards.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-testid')),
    ),
  );
  await new CanopyAppDriver(window).openPipelineDispatchModal(name);
  const runButton = window.getByTestId('pipeline-trigger-modal-run');
  await expect(runButton).toBeEnabled();
  if ((await runButton.textContent())?.trim() === 'Continue') {
    await runButton.click();
    await expect(runButton).not.toHaveText('Continue');
    await expect(runButton).toBeEnabled();
  }
  await runButton.click();
  // The new run's card, not one an earlier run left in the list.
  let testId;
  await expect
    .poll(
      async () => {
        const ids = await cards.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-testid')),
        );
        testId = ids.find((id) => id && !before.has(id));
        return testId !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return {
    executionId: testId.slice('pipeline-run-card-'.length),
    runCard: window.getByTestId(testId),
  };
}

async function openRunningStep(window, runCard, executionId) {
  await expect(runCard).toContainText('running', { timeout: 60_000 });
  const jobDot = runCard.locator('[data-job-id="work"]');
  await expect(jobDot).toHaveAttribute('aria-label', 'Work: running', {
    timeout: 60_000,
  });
  await jobDot.click();
  await expectPipelineRunPanel(window, executionId);
  await showPipelineJobList(window, { timeout: 15_000 });
  return window.getByTestId('pipeline-step-log-output-emit');
}

async function grandparentOf(output) {
  await expect(output).toContainText('marker-1', { timeout: 60_000 });
  const match = /marker-1 grandparent=(\d+)/.exec(
    (await output.textContent()) ?? '',
  );
  expect(match, 'the printed grandparent pid').toBeTruthy();
  return Number(match[1]);
}

function count(text, marker) {
  return text.split(marker).length - 1;
}

/** The run's stored status, read from the execution store without the app. */
function storedStatus(userDataDir, executionId) {
  const file = path.join(
    realpathSync(userDataDir),
    'pipeline-executions',
    `${executionId}.json`,
  );
  return existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')).status
    : undefined;
}

test.describe('daemon workflows', () => {
  test("a workflow from the main window runs in the daemon's pipeline host and streams its output", async () => {
    test.setTimeout(240_000);
    const { userDataDir, worktreePath } = fixtureApp('c5086-on-');
    let electronApp;
    try {
      const launched = await launch(userDataDir);
      electronApp = launched.electronApp;
      const { window } = launched;
      hold(worktreePath);
      const { executionId, runCard } = await dispatch(window);
      const output = await openRunningStep(window, runCard, executionId);
      // marker-1 arrives live, before the step is released.
      const grandparent = await grandparentOf(output);
      expect(grandparent).toBe(daemonPid(userDataDir));
      await expect(output).not.toContainText('marker-2');
      release(worktreePath);
      await expect(runCard).toContainText('success', { timeout: 60_000 });
      await expect(output).toContainText('marker-2', { timeout: 30_000 });
      const text = (await output.textContent()) ?? '';
      expect(count(text, 'marker-1')).toBe(1);
      expect(count(text, 'marker-2')).toBe(1);
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await cleanup(userDataDir);
    }
  });

  test('a workflow with a child pipeline step runs in process and the earlier daemon run still opens', async () => {
    test.setTimeout(300_000);
    const { userDataDir, worktreePath } = fixtureApp('c5086-off-');
    let electronApp;
    try {
      const first = await launch(userDataDir);
      electronApp = first.electronApp;
      hold(worktreePath);
      const daemonRun = await dispatch(first.window);
      const output = await openRunningStep(
        first.window,
        daemonRun.runCard,
        daemonRun.executionId,
      );
      const daemon = daemonPid(userDataDir);
      expect(await grandparentOf(output)).toBe(daemon);
      release(worktreePath);
      await expect(daemonRun.runCard).toContainText('success', {
        timeout: 60_000,
      });
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;

      const second = await launch(userDataDir);
      electronApp = second.electronApp;
      const { window } = second;
      const appRun = await dispatch(window, CHILD_PIPELINE_NAME);
      expect(appRun.executionId).not.toBe(daemonRun.executionId);
      await expect(appRun.runCard).toContainText('success', {
        timeout: 60_000,
      });
      const appStep = await reopenCompletedStep(
        window,
        appRun.runCard,
        'work',
        'emit',
      );
      const appGrandparent = await grandparentOf(
        appStep.getByTestId('pipeline-step-log-output-emit'),
      );
      expect(appGrandparent).not.toBe(daemon);
      expect(appGrandparent).not.toBe(daemonPid(userDataDir));
      const typescriptStep = await reopenCompletedStep(
        window,
        appRun.runCard,
        'work',
        'typescript',
      );
      await expect(
        typescriptStep.getByTestId('pipeline-step-log-output-typescript'),
      ).toContainText('typescript-ran tsx', { timeout: 30_000 });

      const daemonCard = window.getByTestId(
        `pipeline-run-card-${daemonRun.executionId}`,
      );
      await expect(daemonCard).toContainText('success', { timeout: 30_000 });
      const daemonStep = await reopenCompletedStep(
        window,
        daemonCard,
        'work',
        'emit',
      );
      await expect(
        daemonStep.getByTestId('pipeline-step-log-output-emit'),
      ).toContainText('marker-2', { timeout: 30_000 });
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await cleanup(userDataDir);
    }
  });

  test('a run keeps going after the app quits and the next launch shows its result', async () => {
    test.setTimeout(300_000);
    const { userDataDir, worktreePath } = fixtureApp('c5862-quit-');
    let electronApp;
    try {
      const first = await launch(userDataDir, { retainDaemon: true });
      electronApp = first.electronApp;
      hold(worktreePath);
      const { executionId, runCard } = await dispatch(first.window);
      const output = await openRunningStep(first.window, runCard, executionId);
      const daemon = daemonPid(userDataDir);
      expect(await grandparentOf(output)).toBe(daemon);
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: true,
        retainDaemon: true,
      });
      electronApp = undefined;

      // The app is gone; the daemon and its run are not.
      expect(isAlive(daemon)).toBe(true);
      expect(storedStatus(userDataDir, executionId)).toBe('running');
      release(worktreePath);
      await expect
        .poll(() => storedStatus(userDataDir, executionId), {
          timeout: 60_000,
        })
        .toBe('success');

      const second = await launch(userDataDir);
      electronApp = second.electronApp;
      const card = second.window.getByTestId(
        `pipeline-run-card-${executionId}`,
      );
      await expect(card).toContainText('success', { timeout: 30_000 });
      const step = await reopenCompletedStep(
        second.window,
        card,
        'work',
        'emit',
      );
      const log = step.getByTestId('pipeline-step-log-output-emit');
      await expect(log).toContainText('marker-2', { timeout: 30_000 });
      const text = (await log.textContent()) ?? '';
      expect(count(text, 'marker-1')).toBe(1);
      expect(count(text, 'marker-2')).toBe(1);
    } finally {
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await killRetainedDaemons();
      await cleanup(userDataDir);
    }
  });
});

// Production client TTL: 4 * 15s; idle grace: 30s. retainDaemon exempts only
// harness cleanup. It acquires no lease or execution obligation.
const LEASE_FREE_INTERVAL_MS = 95_000;

async function mockState(endpoint, key) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/${endpoint}?key=${encodeURIComponent(key)}`,
  );
  expect(response.ok).toBe(true);
  return response.json();
}

async function releaseMockBarrier(key, name) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, name }),
  });
  expect(response.ok).toBe(true);
}

async function waitingAt(key, name, execution) {
  let terminal;
  await expect
    .poll(
      async () => {
        // Return terminal failure immediately as an impossible barrier result.
        // Waiting a minute hid launch/config errors behind a transport timeout.
        const state = await execution?.();
        if (
          state &&
          ['success', 'failure', 'cancelled', 'paused'].includes(
            state.execution.status,
          )
        ) {
          terminal = state;
          return true;
        }
        return (await mockState('barrier', key)).barriers.some(
          (barrier) => barrier.name === name && barrier.waiting === 1,
        );
      },
      {
        timeout: 60_000,
        message: `native transport did not reach ${name}`,
      },
    )
    .toBe(true);
  expect(
    terminal,
    `Execution stopped before ${name}: ${JSON.stringify(terminal)}`,
  ).toBeUndefined();
}

async function nativeFailureExecution(observer, userDataDir, executionId) {
  let diagnosticObserver;
  try {
    // Failure can occur in the deliberately client-free interval. Attach only
    // now; never keep a diagnostic lease alive during the lifetime proof.
    const current =
      observer ?? (diagnosticObserver = await openNativeObserver(userDataDir));
    return await current.client.query('worker.pipeline.execution.get', {
      executionId,
      detail: true,
    });
  } catch (error) {
    return { unavailable: String(error) };
  } finally {
    await diagnosticObserver?.close().catch(() => {});
  }
}

function nativeFixture(provider, withResources = false) {
  // Vendor config/read and the daemon use physical paths. In particular,
  // macOS /var is an alias of /private/var, not a distinct profile scope.
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'c6996-native-')),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const home = path.join(userDataDir, 'native-home');
  mkdirSync(home, { recursive: true });
  const model = provider === 'claude' ? 'sonnet' : 'gpt-6-sol';
  const key = `Canopy-C6996${provider}${path.basename(userDataDir).replaceAll('-', '')}`;
  const name = `Native ${provider} survival`;
  if (withResources) {
    const source = path.join(
      seeded.workspaces[0].worktreePath,
      'local-resources',
    );
    const installLocation = path.join(source, 'notes');
    const stamp = '2026-11-16T12:00:00.000Z';
    mkdirSync(path.join(installLocation, `.${provider}-plugin`), {
      recursive: true,
    });
    mkdirSync(path.join(installLocation, 'skills', 'notes'), {
      recursive: true,
    });
    writeFileSync(
      path.join(installLocation, `.${provider}-plugin`, 'plugin.json'),
      JSON.stringify({ name: 'notes', version: '1.0.0' }),
    );
    writeFileSync(
      path.join(installLocation, 'skills', 'notes', 'SKILL.md'),
      '---\nname: notes\ndescription: Preserve the native survival notes resource.\n---\n# Notes\nKeep accurate notes.',
    );
    const status = (harness) => ({
      provider: harness,
      state: harness === provider ? 'valid' : 'invalid',
      accepted: harness === provider,
      pluginCount: harness === provider ? 1 : 0,
      lastCheckedAt: stamp,
    });
    writeFileSync(
      path.join(userDataDir, 'plugins-cache.json'),
      JSON.stringify({
        version: 2,
        lastRefreshed: stamp,
        marketplaces: [
          {
            id: 'local-notes',
            name: 'Local notes',
            sourceType: 'directory',
            sourceUrl: source,
            installLocation: source,
            pluginCount: 1,
            providerStatus: {
              claude: status('claude'),
              codex: status('codex'),
            },
            validProviders: [provider],
            plugins: [
              {
                name: 'notes',
                marketplaceId: 'local-notes',
                sourcePath: './notes',
                providerSupport: {
                  claude: provider === 'claude' ? 'native' : 'none',
                  codex: provider === 'codex' ? 'native' : 'none',
                },
                facets: {
                  [provider]: {
                    provider,
                    mode: 'native',
                    name: 'notes',
                    sourcePath: './notes',
                    installLocation,
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      path.join(userDataDir, 'agent-models.json'),
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: 'agent_model_notes',
            name: 'Notes Agent',
            baseModel: model,
            instructions: 'Keep accurate notes while continuing the workflow.',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [
                { marketplaceId: 'local-notes', pluginName: 'notes' },
              ],
              mcpServerRefs: [],
            },
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
      }),
    );
  }
  for (const [id, tags] of [
    ['finish', ['before', 'after']],
    ['cancel', ['cancel']],
  ]) {
    seedStoredPipeline({
      userDataDir,
      id: `native-${id}`,
      name: `${name} ${id}`,
      yaml: [
        `name: ${name} ${id}`,
        'on: dispatch',
        ...(withResources
          ? [
              'model_aliases:',
              '  - id: worker',
              '    name: Notes Agent',
              '    defaults:',
              '      agent_id: agent_model_notes',
            ]
          : []),
        'jobs:',
        '  work:',
        '    name: Work',
        '    steps:',
        ...tags.flatMap((tag) => [
          `      - id: ${tag}`,
          '        uses: builtin/agent-prompt',
          '        with:',
          `          model: ${withResources ? 'worker' : model}`,
          // dangerous_all is mocked-E2E-only: it offers Claude's native Skill
          // listing. Scripted calls are Ledger-only, with no shell. Survival
          // admission/blockers do not read the preset value (native-survival.ts:129).
          ...(withResources
            ? [
                `          permission_preset: ${provider === 'claude' ? 'dangerous_all' : 'read_only'}`,
              ]
            : []),
          `          prompt: "[${key}] [Canopy-Mock-Request:${tag}] Continue the workflow."`,
        ]),
        '',
      ].join('\n'),
    });
  }
  return { userDataDir, home, key, name, model };
}

function nativeLaunchEnvironment(home, key) {
  // This fixture models a clean native profile, not the coding agent's own
  // provider connection. Empty values suppress inheritance without changing
  // the production admission allowlist. launchCanopy supplies isolated roots.
  const environment = Object.fromEntries(
    Object.keys(process.env)
      .filter((name) =>
        /^(?:CLAUDE_|CLAUDECODE$|ANTHROPIC_|CODEX_|OPENAI_|AZURE_OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(
          name,
        ),
      )
      .map((name) => [name, '']),
  );
  return {
    ...environment,
    HOME: home,
    CANOPY_MOCK_API_KEY: key,
    // E2E starts with enabled-but-unavailable flag defaults (Ledger off).
    // This case needs an actual open Ledger session before owner loss.
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-ledger-enabled': true,
    }),
  };
}

for (const provider of ['claude', 'codex']) {
  test(`native ${provider} from the main window survives quit, finishes and cancels through a fresh client`, async ({}, testInfo) => {
    // This deliberately spans the real production TTL and idle grace.
    test.setTimeout(480_000);
    const { userDataDir, home, key, name, model } = nativeFixture(
      provider,
      true,
    );
    const tool =
      provider === 'claude'
        ? 'mcp__canopy__SearchFeedEntries'
        : 'canopy_search_feed_entries';
    const ledgerCall = (id) =>
      provider === 'claude'
        ? { name: 'mcp__canopy__SearchFeedEntries', input: {}, id }
        : {
            type: 'custom',
            namespace: 'functions',
            name: 'exec',
            input: 'text(await tools.canopy_search_feed_entries({}));',
            id,
          };
    let electronApp;
    let observer;
    let stream;
    let failure;
    const evidence = {
      provider,
      transport: 'e2e mock',
      ownerDependency: 'unassessed',
      cleanup: 'pending',
    };
    try {
      const root = fileURLToPath(new URL('../../../../', import.meta.url));
      const manifest = JSON.parse(
        readFileSync(
          path.join(root, '.cache/e2e-core-daemon/manifest.json'),
          'utf8',
        ),
      );
      verifyE2eDaemonHosts({
        root,
        sourceSha: manifest.sourceSha,
        platform: process.platform,
        arch: process.arch,
      });
      evidence.artifact = manifest;
      await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
        authUsage: { scenario: 'authed-low-usage' },
        llm: {
          steps: [{ text: 'UNEXPECTED-REQUEST-TAG', stopReason: 'end_turn' }],
          captureRequestBodies: true,
          // Claude appends Agent instructions to system; Codex's production
          // buildCodexPrompt prepends them to the user task instead.
          [provider === 'claude' ? 'requiredSystemText' : 'requiredUserText']: [
            'You are now a user defined agent with these additional instructions: Keep accurate notes while continuing the workflow.',
          ],
          openAiStepCursor: 'completed-scenario-tool-calls',
          stepsByRequestTag: {
            before: {
              stepId: 'ledger-turns',
              attempts: [
                {
                  toolCalls: [ledgerCall('ledger-before-quit')],
                },
                {
                  waitFor: 'quit',
                  barrierTimeoutMs: 300_000,
                  toolCalls: [ledgerCall('ledger-after-quit')],
                },
                { text: 'BEFORE-FINISHED' },
              ],
            },
            after: {
              waitFor: 'finish',
              barrierTimeoutMs: 300_000,
              text: 'AFTER-FINISHED',
            },
            cancel: {
              waitFor: 'cancel',
              barrierTimeoutMs: 300_000,
              text: 'MUST-NOT-FINISH',
            },
          },
          requestTextObservers: [
            ...['before', 'after'].map((requestTag) => ({
              key: `ledger-declarations-${requestTag}`,
              requestTag,
              scope: 'tools',
              // Codex declares Ledger inside functions.exec's description,
              // not as a top-level tool name. Inspect the current catalog.
              text: tool,
            })),
            ...['before', 'after'].flatMap((requestTag) => [
              {
                key: `agent-instructions-${requestTag}`,
                requestTag,
                text: 'Keep accurate notes while continuing the workflow.',
              },
              {
                key: `agent-resource-${requestTag}`,
                requestTag,
                text: 'Preserve the native survival notes resource.',
              },
            ]),
            {
              key: 'ledger-open',
              lastMessageContaining: 'ledger-before-quit',
              text: 'entries',
            },
            {
              key: 'ledger-lost',
              lastMessageContaining: 'ledger-after-quit',
              text: 'ledger_runtime_unavailable',
            },
          ],
        },
      });
      const options = {
        retainDaemon: true,
        env: nativeLaunchEnvironment(home, key),
      };
      const first = await launch(userDataDir, options);
      electronApp = first.electronApp;
      // Playwright's process() is the retained-process launcher, not Electron.
      const electronPid = await electronApp.evaluate(() => process.pid);
      evidence.electronPid = electronPid;
      const finish = await dispatch(first.window, `${name} finish`);
      observer = await openNativeObserver(userDataDir);
      Object.assign(evidence, observer.identity, {
        finishExecutionId: finish.executionId,
      });
      const admitted = await observer.client.query(
        'worker.pipeline.execution.get',
        { executionId: finish.executionId, detail: true },
      );
      evidence.ownerDependency = admitted.execution.survival?.blockers;
      expect(
        admitted.execution.survival?.disposition,
        JSON.stringify(admitted),
      ).toBe('continues');
      const finishState = () =>
        observer.client.query('worker.pipeline.execution.get', {
          executionId: finish.executionId,
          detail: true,
        });
      await waitingAt(key, 'quit', finishState);
      // Reaching this response requires the real pre-quit Ledger attempt and
      // tools, not a test-side store read or injected owner reply.
      const activity = await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/activity/${key}`,
      ).then((r) => r.json());
      evidence.preQuitActivity = activity;
      expect(activity.activity?.['llmObserved:ledger-open']).toBeGreaterThan(0);
      // Positive control for the same declaration probe used after quit.
      expect(
        activity.activity?.['llmObserved:ledger-declarations-before'],
      ).toBeGreaterThan(0);
      for (const fact of ['agent-instructions', 'agent-resource'])
        expect(
          activity.activity?.[`llmObserved:${fact}-before`],
          fact,
        ).toBeGreaterThan(0);
      const cancel = await dispatch(first.window, `${name} cancel`);
      await waitingAt(key, 'cancel', () =>
        observer.client.query('worker.pipeline.execution.get', {
          executionId: cancel.executionId,
          detail: true,
        }),
      );
      expect(evidence.build).toBeTruthy();
      for (const executionId of [finish.executionId, cancel.executionId]) {
        const before = await observer.client.query(
          'worker.pipeline.execution.get',
          { executionId, detail: true },
        );
        evidence.ownerDependency =
          before.execution.survival?.blockers ?? 'no assessment';
        expect(
          before.execution.survival?.disposition,
          JSON.stringify(evidence),
        ).toBe('continues');
        expect(before.execution.survival.routes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              harness: provider,
              selection: model,
              requestModel: model,
              runtimeModel: model,
              effectiveRoute: 'native',
              authentication: 'vendor-profile',
            }),
          ]),
        );
        evidence.admittedRoutes ??= {};
        evidence.admittedRoutes[executionId] = before.execution.survival.routes;
      }
      Object.assign(evidence, {
        effectiveRoute: 'native',
        authentication: 'vendor-profile',
        ownerDependency: 'none',
      });
      const identity = observer.identity;
      await observer.close();
      observer = undefined;
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: true,
        retainDaemon: true,
      });
      electronApp = undefined;
      await expect
        .poll(() => isAlive(electronPid), {
          timeout: 15_000,
          message: `Electron completely exited: ${JSON.stringify(evidence)}`,
        })
        .toBe(false);
      const quitAt = Date.now();
      evidence.quitAt = new Date(quitAt).toISOString();
      // PID/time only: no socket, observer or lease in this entire interval.
      await expect
        .poll(
          () => {
            expect(isAlive(identity.pid), JSON.stringify(evidence)).toBe(true);
            return Date.now() - quitAt;
          },
          { timeout: LEASE_FREE_INTERVAL_MS + 5000, intervals: [1000] },
        )
        .toBeGreaterThan(LEASE_FREE_INTERVAL_MS);
      evidence.leaseFreeMs = Date.now() - quitAt;
      await releaseMockBarrier(key, 'quit');
      await waitingAt(key, 'finish');
      const lostActivity = await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/activity/${key}`,
      ).then((r) => r.json());
      evidence.postQuitActivity = lostActivity;
      expect(
        lostActivity.activity?.['llmObserved:ledger-lost'],
      ).toBeGreaterThan(0);
      expect(
        lostActivity.activity?.['llmObserved:ledger-declarations-after'] ?? 0,
        'New post-quit steps must not offer Ledger, including inside code-mode descriptions',
      ).toBe(0);
      for (const fact of ['agent-instructions', 'agent-resource'])
        expect(
          lostActivity.activity?.[`llmObserved:${fact}-after`],
          `post-quit ${fact}`,
        ).toBeGreaterThan(0);
      const afterRequests = (await mockState('requests', key)).requests.filter(
        (request) => request.tag === 'after',
      );
      expect(afterRequests.length).toBeGreaterThan(0);
      evidence.providerModels = [
        ...new Set(afterRequests.map((request) => request.model)),
      ];
      for (const request of afterRequests) {
        // Claude's native CLI expands its managed selector on the wire.
        if (provider === 'claude')
          expect(request.model).toMatch(/^(?:sonnet|claude-sonnet-)/);
        else expect(request.model).toBe(model);
      }
      observer = await openNativeObserver(userDataDir);
      expect(observer.identity).toEqual(identity);
      const stored = await observer.client.query(
        'worker.pipeline.execution.get',
        { executionId: finish.executionId, detail: true },
      );
      expect(stored.execution.status).toBe('running');
      const steps = stored.detail.jobs.flatMap((job) =>
        job.variants.flatMap((variant) => variant.steps),
      );
      expect(steps.find((step) => step.stepId === 'before')?.status).toBe(
        'success',
      );
      const after = steps.find((step) => step.stepId === 'after');
      expect(Date.parse(after.startedAt)).toBeGreaterThan(quitAt);
      evidence.postQuitModelStartedAt = after.startedAt;
      const statuses = [];
      stream = await observer.client.openStream(
        'worker.pipeline.execution.events',
        { executionId: finish.executionId },
        {
          onFrame(frame) {
            if (frame.kind === 'item' && frame.item.kind === 'execution')
              statuses.push(frame.item.execution.status);
          },
        },
      );
      await releaseMockBarrier(key, 'finish');
      await expect
        .poll(
          () =>
            observer.client
              .query('worker.pipeline.execution.get', {
                executionId: finish.executionId,
              })
              .then((r) => r.execution.status),
          { timeout: 60_000 },
        )
        .toBe('success');
      await expect.poll(() => statuses).toContain('success');
      stream.close();
      stream = undefined;
      await observer.client.instruction(
        'worker.pipeline.execution.cancel',
        { executionId: cancel.executionId, mode: 'finalize' },
        { metadata: { idempotencyKey: `cancel-${cancel.executionId}` } },
      );
      await expect
        .poll(
          () =>
            observer.client
              .query('worker.pipeline.execution.get', {
                executionId: cancel.executionId,
                detail: true,
              })
              .then((r) => ({
                status: r.execution.status,
                steps: r.detail.jobs
                  .flatMap((job) =>
                    job.variants.flatMap((variant) => variant.steps),
                  )
                  .map((step) => step.status),
              })),
          { timeout: 60_000 },
        )
        .toEqual({ status: 'cancelled', steps: ['cancelled'] });
      await observer.close();
      observer = undefined;
      // No harness kill may stand in for releasing the execution obligations.
      // retainDaemon exempts cleanup only; terminal runs must permit idle exit.
      await expect
        .poll(() => isAlive(identity.pid), {
          timeout: LEASE_FREE_INTERVAL_MS + 15_000,
          message: `Terminal runs released daemon obligations: ${JSON.stringify(evidence)}`,
        })
        .toBe(false);
      evidence.cleanup = 'natural idle shutdown';
      const requestCountBeforeReopen = (await mockState('requests', key))
        .requests.length;
      const second = await launch(userDataDir, { env: options.env });
      electronApp = second.electronApp;
      for (const [run, status] of [
        [finish, 'success'],
        [cancel, 'cancelled'],
      ]) {
        const card = second.window.getByTestId(
          `pipeline-run-card-${run.executionId}`,
        );
        await expect(card).toContainText(status, { timeout: 30_000 });
        await expect(
          second.window.locator('[data-testid^="pipeline-run-card-"]').filter({
            hasText: `${name} ${status === 'success' ? 'finish' : 'cancel'}`,
          }),
        ).toHaveCount(1);
      }
      await reopenCompletedStep(
        second.window,
        second.window.getByTestId(`pipeline-run-card-${finish.executionId}`),
        'work',
        'after',
      );
      await expect(
        second.window.getByTestId('pipeline-run-background-notice'),
      ).toContainText('Ledger is unavailable');
      expect((await mockState('requests', key)).requests).toHaveLength(
        requestCountBeforeReopen,
      );
      expect(
        (await mockState('requests', key)).requests.filter(
          (request) => request.tag === 'after',
        ),
      ).toHaveLength(afterRequests.length);
      evidence.result =
        'finish success; separate run durably cancelled; reopened without duplicate';
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      evidence.mockRequests = await mockState('requests', key).catch(String);
      if (evidence.finishExecutionId)
        evidence.execution = await nativeFailureExecution(
          observer,
          userDataDir,
          evidence.finishExecutionId,
        );
      failure = new Error(
        `${evidence.error}\nNative survival diagnostics: ${JSON.stringify(evidence)}`,
        { cause: error },
      );
    } finally {
      // Attempt every cleanup, but never replace the original test failure.
      const cleanups = [
        ['streamCleanupError', () => stream?.close()],
        ['observerCleanupError', () => observer?.close()],
        [
          'appCleanupError',
          () =>
            electronApp &&
            closeCanopy(electronApp, userDataDir, { keepUserData: true }),
        ],
        ['daemonCleanupError', () => killRetainedDaemons()],
        [
          'fixtureCleanupError',
          async () => {
            await cleanup(userDataDir);
            evidence.fixtureCleanup = 'complete';
          },
        ],
        ['mockCleanupError', () => clearScenario(DEFAULT_MOCK_BASE_URL, key)],
        [
          'attachmentError',
          () =>
            testInfo.attach('native-survival-evidence', {
              body: JSON.stringify(evidence, null, 2),
              contentType: 'application/json',
            }),
        ],
      ];
      for (const [field, runCleanup] of cleanups) {
        try {
          await runCleanup();
        } catch (error) {
          evidence[field] = String(error);
          failure ??= new Error(`${field}: ${String(error)}`, {
            cause: error,
          });
        }
      }
    }
    if (failure) throw failure;
  });
}

// Each dependency is part of the authored launch, not an injected assessment.
// Hold the first native turn so quitting cannot race with the later dependency.
for (const dependency of [
  'host-step',
  'owner-mcp',
  'network-proxy',
  'ollama',
  'unknown',
]) {
  test(`${dependency} workflow pauses after quit and explains its blocker without a popup loop`, async () => {
    test.setTimeout(240_000);
    const { userDataDir, home, key } = nativeFixture('claude');
    const name = `Pause on quit ${dependency}`;
    const environment = nativeLaunchEnvironment(home, key);
    const profile = path.join(userDataDir, 'provider-state', 'claude');
    mkdirSync(profile, { recursive: true });
    if (dependency === 'owner-mcp')
      writeFileSync(
        path.join(profile, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            owner: {
              type: 'http',
              url: 'https://owner-mcp.invalid',
              headers: { Authorization: 'Bearer fixture-owner-credential' },
            },
          },
        }),
      );
    if (dependency === 'unknown')
      writeFileSync(
        path.join(profile, 'settings.json'),
        JSON.stringify({ futureModelDependency: 'unclassified' }),
      );
    if (dependency === 'network-proxy')
      Object.assign(environment, {
        HTTPS_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      });
    if (dependency === 'ollama') {
      const port = 11534;
      writeFileSync(
        path.join(userDataDir, 'preferences.json'),
        JSON.stringify({
          version: 1,
          preferences: {
            ollamaServerPort: port,
            ollamaConnectionMode: 'manual',
          },
        }),
      );
      writeFileSync(
        path.join(userDataDir, 'ollama-model-cache.json'),
        JSON.stringify({
          version: 1,
          byPort: {
            [port]: {
              refreshedAt: new Date().toISOString(),
              models: [
                {
                  id: 'ollama-llama3',
                  rawModelId: 'llama3',
                  label: 'Llama 3',
                  show: { capabilities: ['completion', 'tools'] },
                },
              ],
            },
          },
        }),
      );
    }
    seedStoredPipeline({
      userDataDir,
      id: 'pause-case',
      name,
      yaml: [
        `name: ${name}`,
        'on: dispatch',
        'jobs:',
        '  work:',
        '    name: Work',
        '    steps:',
        '      - id: before',
        '        uses: builtin/agent-prompt',
        '        with:',
        '          model: sonnet',
        '          setting_sources: project',
        `          prompt: "[${key}] [Canopy-Mock-Request:pause] Wait for the next step."`,
        ...(dependency === 'host-step'
          ? [
              '      - id: desktop',
              '        uses: builtin/move-to-group',
              '        with:',
              '          group: Finished workflows',
            ]
          : [
              '      - id: after',
              '        uses: builtin/agent-prompt',
              '        with:',
              `          model: ${dependency === 'ollama' ? 'ollama-llama3' : 'sonnet'}`,
              `          prompt: "[${key}] [Canopy-Mock-Request:must-not-start] Continue."`,
            ]),
        '',
      ].join('\n'),
    });
    const expectedCode =
      dependency === 'unknown' ? 'configuration-unverified' : dependency;
    const expectedCopy = {
      'host-step': 'This workflow requires a desktop action.',
      'owner-mcp':
        'This workflow uses MCP configuration or credentials that have not been verified without the app.',
      'network-proxy':
        'This model uses a network proxy that has not been verified while the app is closed.',
      ollama:
        'Ollama model steps have not been verified while the app is closed, even with an external server.',
      unknown: 'Background model routing has not been verified for this run.',
    }[dependency];
    let electronApp;
    let observer;
    try {
      await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
        authUsage: { scenario: 'authed-low-usage' },
        llm: {
          steps: [{ text: 'UNEXPECTED-REQUEST-TAG', stopReason: 'end_turn' }],
          stepsByRequestTag: {
            pause: {
              waitFor: 'pause',
              barrierTimeoutMs: 180_000,
              text: 'MUST-NOT-FINISH',
            },
            'must-not-start': { text: 'MUST-NOT-START' },
          },
        },
      });
      const options = { retainDaemon: true, env: environment };
      const first = await launch(userDataDir, options);
      electronApp = first.electronApp;
      if (dependency === 'ollama') {
        // Startup installation discovery precedes publishing the cached model
        // registry. Dispatching before that point takes the unknown-model path.
        await expect
          .poll(
            () =>
              first.window.evaluate(async () =>
                (await window.api.getOllamaState()).models.map(
                  (model) => model.id,
                ),
              ),
            { timeout: 60_000 },
          )
          .toContain('ollama-llama3');
      }
      const run = await dispatch(first.window, name);
      observer = await openNativeObserver(userDataDir);
      const state = () =>
        observer.client.query('worker.pipeline.execution.get', {
          executionId: run.executionId,
          detail: true,
        });
      const initial = await state();
      expect(
        initial.execution.survival?.disposition,
        JSON.stringify(initial),
      ).toBe('pauses');
      expect(
        initial.execution.survival.blockers.map((blocker) => blocker.code),
      ).toContain(expectedCode);
      await waitingAt(key, 'pause', state);
      await openRunningStep(first.window, run.runCard, run.executionId);
      await expect(
        first.window.getByTestId('pipeline-run-background-notice'),
      ).toContainText(expectedCopy);
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: true,
        retainDaemon: true,
      });
      electronApp = undefined;
      await expect
        .poll(async () => (await state()).execution.status, { timeout: 45_000 })
        .toBe('paused');
      const paused = await state();
      expect(
        paused.execution.survival.blockers.map((blocker) => blocker.code),
      ).toContain(expectedCode);
      expect(
        paused.detail.jobs
          .flatMap((job) => job.variants.flatMap((variant) => variant.steps))
          .find((step) => step.stepId === 'before').status,
      ).toBe('paused');
      const requestsAtPause = (await mockState('requests', key)).requests
        .length;
      const second = await launch(userDataDir, options);
      electronApp = second.electronApp;
      const card = second.window.getByTestId(
        `pipeline-run-card-${run.executionId}`,
      );
      await expect(card).toContainText('paused', { timeout: 30_000 });
      await reopenCompletedStep(second.window, card, 'work', 'before');
      const notice = second.window.getByTestId(
        'pipeline-run-background-notice',
      );
      await expect(notice).toContainText(expectedCopy);
      await expect(notice).toContainText('Checkpoint saved');
      await expect(notice.getByRole('button')).toHaveCount(0);
      await expect(second.window.getByRole('dialog')).toHaveCount(0);
      await second.window.keyboard.press('Escape');
      await closePipelineRunPanels(second.window);
      await expect(
        second.window.getByTestId('pipeline-execution-panel'),
      ).toHaveCount(0);
      await expect(card).toContainText('paused');
      expect((await mockState('requests', key)).requests).toHaveLength(
        requestsAtPause,
      );
      expect(
        (await mockState('requests', key)).requests.some(
          (request) => request.tag === 'must-not-start',
        ),
      ).toBe(false);
    } finally {
      await observer?.close();
      if (electronApp)
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      await killRetainedDaemons();
      await cleanup(userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    }
  });
}
