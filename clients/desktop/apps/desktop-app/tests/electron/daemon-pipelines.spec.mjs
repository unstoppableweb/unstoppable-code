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
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, killRetainedDaemons } from './launchCanopy.mjs';
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
import {
  cleanup,
  daemonPid,
  dispatch,
  isAlive,
  launch,
  mockState,
  nativeFixture,
  nativeLaunchEnvironment,
  runNativeSurvivalBatch,
  waitingAt,
} from './nativeSurvivalFixture.mjs';

test.skip(
  !['darwin', 'linux'].includes(process.platform),
  'The retained-process fixture requires a supported POSIX daemon artifact.',
);

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

const survivalCompositions = [
  'native',
  'governed-native',
  'ai-credits',
].flatMap((mode) =>
  ['claude', 'codex'].map((provider) => ({ mode, provider })),
);
for (const { mode, provider } of survivalCompositions) {
  test(`${mode} ${provider} from the main window survives quit, finishes and cancels through a fresh client`, async ({}, testInfo) => {
    test.setTimeout(mode === 'native' ? 480_000 : 360_000);
    // Managed lease waits run in daemon-survival-leases.spec.mjs.
    await runNativeSurvivalBatch(
      {
        mode,
        provider,
        adverseConditions: [],
        qualifyLease: mode === 'native',
      },
      testInfo,
    );
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
