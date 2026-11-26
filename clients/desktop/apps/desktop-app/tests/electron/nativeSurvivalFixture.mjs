import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyE2eDaemonHosts } from '../../../../scripts/lib/e2e-core-daemon-artifact.mjs';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  closeCanopy,
  killRetainedDaemons,
  launchCanopy,
  removeTestDataDir,
} from './launchCanopy.mjs';
import { reopenCompletedStep } from './pipelineUi.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { openNativeObserver } from './nativeSurvivalClient';
import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import { CANOPY_ORG_PROJECTS_ENABLED_ENV } from './featureFlagEnv.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  clearScenario,
} from './seeders/registerScenario.mjs';

const WORKTREE_BRANCH = 'demo-main';
const PIPELINE_NAME = 'E2E Background Workflow';

export async function launch(userDataDir, options = {}, beforeNavigation) {
  const { electronApp } = await launchCanopy({ userDataDir, ...options });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await beforeNavigation?.(window);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
    return { electronApp, window };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

/** The daemon serving this data root, from its descriptor. */
export function daemonPid(userDataDir) {
  const descriptor = path.join(
    realpathSync(userDataDir),
    'runtime',
    'core.json',
  );
  return existsSync(descriptor)
    ? JSON.parse(readFileSync(descriptor, 'utf8')).pid
    : undefined;
}

/**
 * The E2E daemon's own shutdown receipt (`apps/core-daemon/src/main.ts`):
 * its pid, stop reason and phase statuses. Throws when it wrote none.
 */
function daemonShutdownReceipt(userDataDir, pid) {
  const receipt = path.join(
    realpathSync(userDataDir),
    `e2e-daemon-shutdown-${pid}.json`,
  );
  if (!existsSync(receipt))
    throw new Error(`Daemon ${pid} wrote no shutdown receipt`);
  return JSON.parse(readFileSync(receipt, 'utf8'));
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Stops a daemon the app left running, then removes the data roots. */
export async function cleanup(userDataDir) {
  const pid = daemonPid(userDataDir);
  if (pid !== undefined && isAlive(pid)) {
    process.kill(pid, 'SIGTERM');
    await expect.poll(() => isAlive(pid), { timeout: 30_000 }).toBe(false);
  }
  await removeTestDataDir(userDataDir);
  await removeTestDataDir(`${userDataDir}-secure`);
}

export async function dispatch(window, name = PIPELINE_NAME) {
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

// Production client TTL: 4 * 15s; idle grace: 30s. retainDaemon exempts only
// harness cleanup. It acquires no lease or execution obligation.
const LEASE_FREE_INTERVAL_MS = 95_000;

async function mockControlPlaneQuery(endpoint) {
  const url = `${DEFAULT_MOCK_BASE_URL}/__mock/${endpoint}`;
  const signal = AbortSignal.timeout(10_000);
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { connection: 'close' },
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      // Retry only this test-side, read-only query, never provider traffic.
      if (
        attempt === 0 &&
        !signal.aborted &&
        (code === 'ECONNRESET' || code === 'EPIPE')
      )
        continue;
      throw new Error(
        `Mock control-plane GET ${url} failed${code ? ` (${code})` : ''}: ${String(error)}`,
        { cause: error },
      );
    }
  }
}

export async function mockState(endpoint, key) {
  return mockControlPlaneQuery(`${endpoint}?key=${encodeURIComponent(key)}`);
}

// Every inference request the mock serves while open, keyed by neither prompt
// nor credential, so an unmarked request still reaches the fault assertions.
// The mock refuses a second live journal; this worker's pid owns this one.
async function inferenceJournal(method, name) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/inference-journal${method === 'POST' ? '' : `?name=${encodeURIComponent(name)}`}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST'
        ? { body: JSON.stringify({ name, ownerPid: process.pid }) }
        : {}),
    },
  );
  if (!response.ok)
    throw new Error(
      `Mock inference journal ${method} failed: ${response.status} ${await response.text()}`,
    );
}

async function inferenceJournalRequests(name) {
  return (
    await mockControlPlaneQuery(
      `inference-journal?name=${encodeURIComponent(name)}`,
    )
  ).requests;
}

async function releaseMockBarrier(key, name) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, name }),
  });
  expect(response.ok).toBe(true);
}

export async function waitingAt(key, name, execution) {
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

const MANAGED_ORG_ID = 'c6997000-0000-4000-8000-000000000001';
const MANAGED_ADVERSE_CASES = [
  'unknown-policy',
  'organization-loss',
  'exhausted',
  'revoked',
  'disconnected',
];

const packageModels = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
);
function managedCloud(model, overrides = {}) {
  const governedId =
    [
      ...packageModels['claude-code'].models,
      ...packageModels.codex.models,
    ].find((entry) => entry.id === model)?.gatewayId ?? model;
  return {
    managedSurvival: true,
    account: { id: 'managed-survival-account', name: 'Managed survival' },
    extraCapabilities: ['enforce_model_policy'],
    organizations: [
      {
        id: MANAGED_ORG_ID,
        name: 'Survival organization',
        role: 'MEMBER',
        createdAt: '2026-11-16T12:00:00.000Z',
        updatedAt: '2026-11-16T12:00:00.000Z',
      },
    ],
    enforcedSettings: [
      {
        organizationId: MANAGED_ORG_ID,
        organizationName: 'Survival organization',
        policies: [
          {
            kind: 'model-policy',
            blockedModelIds: [],
            reviewedModelIds: [governedId],
          },
        ],
      },
    ],
    orgBillingStates: [
      {
        organizationId: MANAGED_ORG_ID,
        organizationName: 'Survival organization',
        teamsEntitled: true,
      },
    ],
    orgSpendableById: { [MANAGED_ORG_ID]: 'empty' },
    ...overrides,
  };
}

export function nativeFixture(
  provider,
  withResources = false,
  mode = 'native',
  adverseConditions = MANAGED_ADVERSE_CASES,
) {
  // Vendor config/read and the daemon use physical paths. In particular,
  // macOS /var is an alias of /private/var, not a distinct profile scope.
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'c6996-native-')),
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const home = path.join(userDataDir, 'native-home');
  mkdirSync(home, { recursive: true });
  const model =
    provider === 'claude'
      ? 'sonnet'
      : mode === 'native'
        ? 'gpt-6-sol'
        : 'gpt-6.1-terra';
  const key = `Canopy-C6996${provider}${path.basename(userDataDir).replaceAll('-', '')}`;
  const name = `${mode === 'native' ? 'Native' : mode} ${provider} survival`;
  if (mode !== 'native') {
    const workspaceFile = path.join(
      userDataDir,
      'workspaces',
      'demo-ts-pnpm-vite',
      'workspace.json',
    );
    const workspace = JSON.parse(readFileSync(workspaceFile, 'utf8'));
    writeFileSync(
      workspaceFile,
      JSON.stringify({
        ...workspace,
        owner: {
          type: 'organization',
          organizationId: MANAGED_ORG_ID,
          projectId: 'c6997000-0000-4000-8000-000000000002',
          instanceId: 'c6997000-0000-4000-8000-000000000003',
          bindingGeneration: 0,
        },
      }),
    );
    // The dispatch can target the current task or no project; bind both to
    // the organization whose membership the adverse case removes.
    writeFileSync(
      path.join(userDataDir, 'pipeline-local-metadata.json'),
      JSON.stringify({
        version: 1,
        entries: Object.fromEntries(
          ['finish', 'cancel', ...adverseConditions].map((id) => [
            `stored:user:native-${id}`,
            { owner: `org:${MANAGED_ORG_ID}` },
          ]),
        ),
      }),
    );
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: {
          aiCreditsRoutingMode: mode === 'ai-credits' ? 'on' : 'off',
        },
      }),
    );
  }
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
    ...(mode === 'native'
      ? []
      : adverseConditions.map((id) => [id, [`before-${id}`, `after-${id}`]])),
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
          `      - id: ${tag.replaceAll('-', '_')}`,
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

export function nativeLaunchEnvironment(
  home,
  key,
  organizationProjects = false,
) {
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
      // Merge flag values, not environment objects: both use the same JSON key.
      ...(organizationProjects
        ? JSON.parse(
            CANOPY_ORG_PROJECTS_ENABLED_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
          )
        : {}),
      'canopy-ledger-enabled': true,
    }),
  };
}

/** Inspect only this fixture daemon's descendants, never another test's env. */
function assertManagedChildIsolation(pid, provider, keys) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([pid]);
  let size;
  do {
    size = descendants.size;
    for (const [child, parent] of rows)
      if (descendants.has(parent)) descendants.add(child);
  } while (size !== descendants.size);
  descendants.delete(pid);
  expect(descendants.size, 'live owned children').toBeGreaterThan(0);
  let providerSeen = false;
  for (const child of descendants) {
    // Cooperative exits may race the census. A still-live provider is required.
    if (!isAlive(child)) continue;
    let command;
    try {
      command = execFileSync(
        'ps',
        ['eww', '-p', String(child), '-o', 'command='],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      if (!isAlive(child)) continue;
      throw error;
    }
    providerSeen ||= new RegExp(`(?:^|/)${provider}(?:\\s|$)`).test(command);
    for (const key of keys)
      expect(
        command.includes(key),
        'upstream key in a child argv/environment',
      ).toBe(false);
  }
  expect(providerSeen, 'the real provider child was inspected').toBe(true);
  return descendants.size;
}

function assertManagedFileIsolation(userDataDir, keys, sinks, executionId) {
  let files = 0;
  let auditFiles = 0;
  let attributedAuditRecords = 0;
  function scan(directory, audit = false) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' && !audit) return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file, audit);
      else if (entry.isFile()) {
        let body;
        try {
          body = readFileSync(file);
        } catch (error) {
          // Live provider session files and SQLite sidecars can disappear.
          if (error.code === 'ENOENT' && !audit) continue;
          throw error;
        }
        files++;
        if (audit) {
          auditFiles++;
          for (const line of body
            .toString('utf8')
            .split('\n')
            .filter(Boolean)) {
            const record = JSON.parse(line);
            if (record.pipelineExecutionId === executionId)
              attributedAuditRecords++;
          }
        }
        for (const key of keys)
          expect(
            body.includes(Buffer.from(key)),
            `upstream key in ${path.relative(userDataDir, file)}`,
          ).toBe(false);
      }
    }
  }
  for (const folder of [
    'logs',
    'pipeline-executions',
    'native-home',
    'provider-state',
    'runtime',
  ])
    scan(path.join(userDataDir, folder));
  for (const [sink, directory] of Object.entries(sinks))
    scan(directory, sink === 'audit');
  expect(auditFiles, 'persisted audit files inspected').toBeGreaterThan(0);
  expect(
    attributedAuditRecords,
    'persisted audit for the fixture execution',
  ).toBeGreaterThan(0);
  expect(
    files,
    'logs, visible run metadata and provider files inspected',
  ).toBeGreaterThan(0);
  return files;
}

function isSessionTitleRequest(request) {
  const system = request.body?.system;
  const text =
    typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.map((block) => block.text ?? '').join('\n')
        : '';
  // The SDK title helper echoes the workflow tag; match the mock's fingerprint.
  return /You are naming a coding session/i.test(text);
}

export async function runNativeSurvivalBatch(
  { mode, provider, adverseConditions, qualifyLease },
  testInfo,
) {
  expect(adverseConditions.length + 2).toBeLessThanOrEqual(4);
  const { userDataDir, home, key, name, model } = nativeFixture(
    provider,
    true,
    mode,
    adverseConditions,
  );
  const managed = mode !== 'native';
  const credits = mode === 'ai-credits';
  // The account key is intentionally not the prompt/transport scenario key.
  // A child seeing `key` says nothing about account-key isolation.
  const cloudKeys = managed
    ? [
        `csk_${path.basename(userDataDir)}_initial`,
        `csk_${path.basename(userDataDir)}_replacement`,
      ]
    : [];
  const publicIsolated = (value) => {
    for (const secret of cloudKeys)
      expect(
        JSON.stringify(value).includes(secret),
        'upstream key in a public result/event',
      ).toBe(false);
    return value;
  };
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
    composition: mode,
    qualifyLease,
    adverseConditions,
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
    if (managed) {
      // Any other spec's model traffic would land in this run's journal.
      expect(
        testInfo.config.workers,
        'inference-journal specs run on one worker (the survival lane)',
      ).toBe(1);
      for (const [index, cloudKey] of cloudKeys.entries())
        await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
          cloud: managedCloud(model, {
            credentialLabel: index === 0 ? 'initial' : 'replacement',
          }),
        });
      await inferenceJournal('POST', key);
    }
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      authUsage: { scenario: 'authed-low-usage' },
      llm: {
        steps: [{ text: 'UNEXPECTED-REQUEST-TAG', stopReason: 'end_turn' }],
        captureRequestBodies: true,
        captureBrokerAuthentication: managed,
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
          ...(managed
            ? Object.fromEntries(
                adverseConditions.flatMap((condition) => [
                  [
                    `before-${condition}`,
                    {
                      waitFor: condition,
                      barrierTimeoutMs: 600_000,
                      text: 'FIRST-STEP-FINISHED',
                    },
                  ],
                  [`after-${condition}`, { text: 'ADVERSE-STEP-EXECUTED' }],
                ]),
              )
            : {}),
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
      env: {
        ...nativeLaunchEnvironment(home, key, managed),
        ...(managed && {
          CANOPY_E2E_DAEMON_CLOUD_ACCOUNT: '1',
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        }),
        // Do not let Codex's native mock provider replace the daemon broker.
        ...(credits && { CANOPY_E2E_CODEX_REAL_ROUTING: '1' }),
      },
    };
    const first = await launch(
      userDataDir,
      options,
      managed
        ? async (window) => {
            await connectMockCloudAccount(window, cloudKeys[0], {
              expectedAccount: {
                account: { id: 'managed-survival-account' },
              },
            });
            evidence.desktopAccountConnected = true;
            await expect
              .poll(
                async () => {
                  const state = await window.evaluate(() =>
                    window.api.workspaceContext.get(),
                  );
                  return state.organizations.map(
                    (organization) => organization.id,
                  );
                },
                { timeout: 30_000 },
              )
              .toContain(MANAGED_ORG_ID);
            const context = await window.evaluate(
              (organizationId) =>
                window.api.workspaceContext.set({
                  context: { kind: 'organization', organizationId },
                }),
              MANAGED_ORG_ID,
            );
            expect(context.context).toEqual({
              kind: 'organization',
              organizationId: MANAGED_ORG_ID,
            });
          }
        : undefined,
    );
    electronApp = first.electronApp;
    // Playwright's process() is the retained-process launcher, not Electron.
    const electronPid = await electronApp.evaluate(() => process.pid);
    evidence.electronPid = electronPid;
    if (managed) {
      observer = await openNativeObserver(userDataDir);
      const receiptPath = path.join(
        userDataDir,
        'runtime/e2e-cloud-composition.json',
      );
      await expect
        .poll(
          () => {
            try {
              evidence.daemonComposition = JSON.parse(
                readFileSync(receiptPath, 'utf8'),
              );
              return evidence.daemonComposition;
            } catch {
              return null;
            }
          },
          {
            timeout: 15_000,
            message:
              'E2E daemon composition receipt must exist and confirm the selector and resolved Cloud endpoint before custody.get',
          },
        )
        .toEqual({
          selectorReceived: true,
          activationSelected: true,
          cloudEndpointConfigured: true,
        });
      await expect
        .poll(
          async () =>
            publicIsolated(
              await observer.client.query(
                'core.integration.cloudAccount.custody.get',
                {},
              ),
            ).entry?.account?.id,
          {
            timeout: 30_000,
            message:
              'selected daemon provisioned through the desktop account port (native vault required)',
          },
        )
        .toBe('managed-survival-account');
      await observer.close();
      observer = undefined;
    }
    const finish = await dispatch(first.window, `${name} finish`);
    observer = await openNativeObserver(userDataDir);
    Object.assign(evidence, observer.identity, {
      finishExecutionId: finish.executionId,
    });
    const admitted = publicIsolated(
      await observer.client.query('worker.pipeline.execution.get', {
        executionId: finish.executionId,
        detail: true,
      }),
    );
    evidence.ownerDependency = admitted.execution.survival?.blockers;
    evidence.workOwner = admitted.execution.owner;
    expect(admitted.execution.owner).toBe(
      managed ? `org:${MANAGED_ORG_ID}` : 'personal',
    );
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
    const activity = await mockControlPlaneQuery(
      `activity/${encodeURIComponent(key)}`,
    );
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
    if (credits) {
      const beforeRequests = (await mockState('requests', key)).requests.filter(
        (request) =>
          request.tag === 'before' && !isSessionTitleRequest(request),
      );
      expect(
        beforeRequests.length,
        'pre-quit inference used the broker',
      ).toBeGreaterThan(0);
      for (const request of beforeRequests) {
        expect(request.brokerAuthenticated).toBe(true);
        expect(request.fixtureCredentialLabel).toBe('initial');
      }
      evidence.preQuitBrokerCredential = 'initial';
      evidence.preQuitInferenceRequests = beforeRequests.length;
    }
    const cancel = await dispatch(first.window, `${name} cancel`);
    await waitingAt(key, 'cancel', () =>
      observer.client.query('worker.pipeline.execution.get', {
        executionId: cancel.executionId,
        detail: true,
      }),
    );
    const adverseRuns = new Map();
    // This is the optional desktop Advisor, not the daemon run status.
    // Keep its failure reason in the evidence before the app quits.
    evidence.workflowAdvisors = await first.window.evaluate(
      async (executionIds) =>
        Promise.all(
          executionIds.map(async (executionId) => {
            const result =
              await window.pipelines.getAdvisorSnapshot(executionId);
            const snapshot = result.success ? result.data : null;
            return {
              executionId,
              readSucceeded: result.success,
              status: snapshot?.status,
              model: snapshot?.model,
              lastError: snapshot?.lastError?.message,
            };
          }),
        ),
      [finish.executionId, cancel.executionId],
    );
    if (managed) {
      for (const condition of adverseConditions) {
        const run = await dispatch(first.window, `${name} ${condition}`);
        adverseRuns.set(condition, run);
        const admittedAdverse = publicIsolated(
          await observer.client.query('worker.pipeline.execution.get', {
            executionId: run.executionId,
          }),
        );
        expect(admittedAdverse.execution.owner, condition).toBe(
          `org:${MANAGED_ORG_ID}`,
        );
        evidence.adverseOwners ??= {};
        evidence.adverseOwners[condition] = admittedAdverse.execution.owner;
        await waitingAt(key, condition, () =>
          observer.client.query('worker.pipeline.execution.get', {
            executionId: run.executionId,
            detail: true,
          }),
        );
      }
      evidence.childrenBeforeQuit = assertManagedChildIsolation(
        observer.identity.pid,
        provider,
        cloudKeys,
      );
    }
    expect(evidence.build).toBeTruthy();
    for (const executionId of [finish.executionId, cancel.executionId]) {
      const before = await observer.client.query(
        'worker.pipeline.execution.get',
        { executionId, detail: true },
      );
      evidence.ownerDependency =
        before.execution.survival?.blockers ?? 'no assessment';
      expect(before.execution.owner).toBe(
        managed ? `org:${MANAGED_ORG_ID}` : 'personal',
      );
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
            runtimeModel: credits ? expect.any(String) : model,
            effectiveRoute: credits ? 'ai-credits' : 'native',
            authentication: 'vendor-profile',
          }),
        ]),
      );
      if (managed) {
        expect(before.execution.survival.epochs).toContainEqual(
          expect.objectContaining({ authority: 'cloud-account-credential' }),
        );
        expect(before.execution.survival.credentialFamilies).not.toContain(
          'cloud-account',
        );
        publicIsolated(before);
      }
      evidence.admittedRoutes ??= {};
      evidence.admittedRoutes[executionId] = before.execution.survival.routes;
    }
    Object.assign(evidence, {
      effectiveRoute: credits ? 'ai-credits' : 'native',
      authentication: 'vendor-profile',
      ownerDependency: 'none',
    });
    const identity = observer.identity;
    await observer.close();
    observer = undefined;
    let noClientSince = Date.now();
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
    if (qualifyLease) {
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
    }
    if (managed && credits && qualifyLease) {
      // Only billing requests made by the next post-lease step count.
      const activity = await mockControlPlaneQuery(
        `activity/${encodeURIComponent(cloudKeys[0])}`,
      );
      evidence.postLeaseCloudActivity = activity.activity;
    }
    if (managed && !qualifyLease) {
      // Lease cases must reach their next inference before any client returns.
      // Force a real HTTP account/policy refresh with no Electron process.
      // This ordinary peer has no owner proof and supplies no account answer.
      observer = await openNativeObserver(userDataDir);
      expect(observer.identity).toEqual(identity);
      await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKeys[0], {
        cloud: managedCloud(model, {
          credentialLabel: 'initial',
          account: {
            id: 'managed-survival-account',
            name: 'Refreshed without Electron',
          },
        }),
      });
      const refreshed = publicIsolated(
        await observer.client.instruction(
          'core.integration.cloudAccount.refresh',
          {},
        ),
      );
      expect(refreshed.outcome).toBe('applied');
      expect(refreshed.custody.entry.account.name).toBe(
        'Refreshed without Electron',
      );
      evidence.refreshWhileAbsent = refreshed.outcome;
      // Replace the key while the first inference is still in flight.
      await observer.client.instruction(
        'core.integration.cloudAccount.connectWithKey',
        { apiKey: cloudKeys[1] },
        {
          metadata: { idempotencyKey: `replace-${finish.executionId}` },
        },
      );
      const replaced = publicIsolated(
        await observer.client.query(
          'core.integration.cloudAccount.custody.get',
          {},
        ),
      );
      expect(replaced.credentialGeneration).toBeGreaterThan(
        refreshed.custody.credentialGeneration,
      );
      expect(replaced.sessionExpired).toBe(false);
      await observer.close();
      observer = undefined;
      noClientSince = Date.now();
    }
    await releaseMockBarrier(key, 'quit');
    await waitingAt(key, 'finish');
    const lostActivity = await mockControlPlaneQuery(
      `activity/${encodeURIComponent(key)}`,
    );
    evidence.postQuitActivity = lostActivity;
    expect(lostActivity.activity?.['llmObserved:ledger-lost']).toBeGreaterThan(
      0,
    );
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
      if (managed) {
        expect(request.fixtureCredentialLabel).toBe(
          credits ? (qualifyLease ? 'initial' : 'replacement') : null,
        );
        expect(request.brokerAuthenticated).toBe(credits);
      }
      // Claude's native CLI expands its managed selector on the wire.
      if (credits)
        expect(request.model).toBe(
          evidence.admittedRoutes[finish.executionId][0].runtimeModel,
        );
      else if (provider === 'claude')
        expect(request.model).toMatch(/^(?:sonnet|claude-sonnet-)/);
      else expect(request.model).toBe(model);
    }
    // Fast form of the no-client proof: the post-quit step ran with neither
    // Electron nor any observer attached, and the same daemon kept the run.
    expect(isAlive(identity.pid), JSON.stringify(evidence)).toBe(true);
    evidence.noClientPostQuitMs = Date.now() - noClientSince;
    if (managed && credits && qualifyLease) {
      const activity = await mockControlPlaneQuery(
        `activity/${encodeURIComponent(cloudKeys[0])}`,
      );
      for (const kind of ['aiCreditsSubscription', 'aiCreditsBalance'])
        expect(activity.activity?.[kind]).toBeGreaterThan(
          evidence.postLeaseCloudActivity?.[kind] ?? 0,
        );
      evidence.postLeaseAvailability = activity.activity;
    }
    observer = await openNativeObserver(userDataDir);
    expect(observer.identity).toEqual(identity);
    if (managed) {
      evidence.childrenAfterQuit = assertManagedChildIsolation(
        identity.pid,
        provider,
        cloudKeys,
      );
      const activity = await mockControlPlaneQuery(
        `activity/${encodeURIComponent(cloudKeys[1])}`,
      );
      const initialActivity = await mockControlPlaneQuery(
        `activity/${encodeURIComponent(cloudKeys[0])}`,
      );
      if (credits) {
        const usedActivity = qualifyLease ? initialActivity : activity;
        const unusedActivity = qualifyLease ? activity : initialActivity;
        expect(usedActivity.activity?.aiCreditsSubscription).toBeGreaterThan(0);
        expect(usedActivity.activity?.aiCreditsBalance).toBeGreaterThan(0);
        expect(
          usedActivity.activity?.['managedProxyAuthenticated:after'],
        ).toBeGreaterThan(0);
        expect(
          unusedActivity.activity?.['managedProxyAuthenticated:after'] ?? 0,
        ).toBe(0);
      } else {
        for (const response of [activity, initialActivity])
          expect(response.activity?.managedProxyAuthenticated ?? 0).toBe(0);
        // Unmarked requests too: no account key reaches any model request.
        for (const request of await inferenceJournalRequests(key)) {
          const where = `native ${request.helper ? `${request.helper} ` : ''}request #${request.index} tagged ${request.tag ?? 'none'}`;
          expect(request.fixtureCredentialLabel, where).toBe(null);
          expect(request.brokerAuthenticated, where).toBe(false);
        }
      }
      evidence.availabilityWhileAbsent = credits
        ? `subscription and balance probed; broker authenticated with ${qualifyLease ? 'initial custody after lease expiry' : 'replacement'}`
        : 'native; no credits traffic';
    }
    const stored = await observer.client.query(
      'worker.pipeline.execution.get',
      { executionId: finish.executionId, detail: true },
    );
    expect(stored.execution.status).toBe('running');
    publicIsolated(stored);
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
    const frames = [];
    stream = await observer.client.openStream(
      'worker.pipeline.execution.events',
      { executionId: finish.executionId },
      {
        onFrame(frame) {
          frames.push(frame);
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
    for (const frame of frames) publicIsolated(frame);
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
    if (managed) {
      evidence.adverse = {};
      const restore = async (overrides = {}) => {
        await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKeys[1], {
          cloud: managedCloud(model, {
            ...overrides,
            credentialLabel: 'replacement',
          }),
        });
      };
      for (const [condition, run] of adverseRuns) {
        evidence.adverseExecutionId = run.executionId;
        const state = () =>
          observer.client.query('worker.pipeline.execution.get', {
            executionId: run.executionId,
            detail: true,
          });
        await waitingAt(key, condition, state);
        const beforeFault = publicIsolated(await state());
        expect(beforeFault.execution.status, condition).toBe('running');
        expect(beforeFault.execution.survival?.disposition, condition).toBe(
          'continues',
        );
        // The held turn was dispatched before the key replacement, so it
        // carries the initial credential on the run's own route.
        const preFaultRequests = (await mockState('requests', key)).requests;
        const heldTurn = preFaultRequests.filter(
          (request) =>
            request.tag === `before-${condition}` &&
            !isSessionTitleRequest(request),
        );
        expect(heldTurn.length, `${condition}: in-flight turn`).toBeGreaterThan(
          0,
        );
        for (const request of heldTurn) {
          expect(request.brokerAuthenticated, condition).toBe(credits);
          expect(request.fixtureCredentialLabel, condition).toBe(
            credits ? 'initial' : null,
          );
        }
        const faultBaseline = (await inferenceJournalRequests(key)).length;
        const overrides =
          condition === 'unknown-policy'
            ? {
                enforcedSettings: [
                  {
                    organizationId: MANAGED_ORG_ID,
                    organizationName: 'Survival organization',
                    policies: [{ kind: 'model-policy' }],
                  },
                ],
              }
            : condition === 'organization-loss'
              ? { organizations: [], enforcedSettings: [] }
              : condition === 'exhausted'
                ? { aiCreditsBalance: { credits: 0, eligible: false } }
                : condition === 'revoked'
                  ? { accountHttpStatus: 401 }
                  : {};
        await restore(overrides);
        if (condition === 'disconnected') {
          const custody = publicIsolated(
            await observer.client.query(
              'core.integration.cloudAccount.custody.get',
              {},
            ),
          );
          const disconnected = publicIsolated(
            await observer.client.instruction(
              'core.integration.cloudAccount.disconnect',
              { expectedCredentialGeneration: custody.credentialGeneration },
            ),
          );
          expect(disconnected.account.connected).toBe(false);
        } else {
          const refreshed = publicIsolated(
            await observer.client.instruction(
              'core.integration.cloudAccount.refresh',
              {},
            ),
          );
          expect(refreshed.outcome).toBe(
            condition === 'revoked' ? 'unauthenticated' : 'applied',
          );
          if (condition === 'unknown-policy')
            expect(
              refreshed.custody.entry.modelPolicyEnforcementUnavailable,
            ).toBe(true);
          if (condition === 'organization-loss')
            expect(refreshed.custody.entry.organizations).toEqual([]);
          if (condition === 'revoked')
            expect(refreshed.custody.sessionExpired).toBe(true);
        }
        await releaseMockBarrier(key, condition);
        const nativeUnaffected = condition === 'exhausted' && !credits;
        let result;
        await expect
          .poll(
            async () => {
              result = publicIsolated(
                await observer.client.query('worker.pipeline.execution.get', {
                  executionId: run.executionId,
                  detail: true,
                }),
              );
              return result.execution.status;
            },
            {
              timeout: 60_000,
              message: `${mode} ${condition}: no unauthorized model step or billing fallback`,
            },
          )
          .toBe(nativeUnaffected ? 'success' : 'paused');
        const taggedRequests = (
          await mockState('requests', key)
        ).requests.filter((request) => request.tag === `after-${condition}`);
        const requests = taggedRequests.filter(
          (request) => !isSessionTitleRequest(request),
        );
        evidence.adverseRequestCounts ??= {};
        evidence.adverseRequestCounts[condition] = {
          step: requests.length,
          sessionTitle: taggedRequests.length - requests.length,
        };
        expect(requests).toHaveLength(nativeUnaffected ? 1 : 0);
        if (nativeUnaffected) {
          expect(requests[0].brokerAuthenticated).toBe(false);
          expect(requests[0].fixtureCredentialLabel).toBe(null);
        }
        evidence.adverse[condition] = result.execution.status;
        if (!nativeUnaffected) {
          expect(result.execution.survival?.disposition, condition).toBe(
            'pauses',
          );
          const blockers = result.execution.survival.blockers.map(
            (blocker) => blocker.code,
          );
          // Active broker revocation and a denied next-step owner answer
          // reach different checkpoints; neither is a generic owner loss.
          expect(blockers.length, condition).toBeGreaterThan(0);
          for (const code of blockers)
            expect(['ai-credits', 'setup-lease'], condition).toContain(code);
          evidence.adverseBlockers ??= {};
          evidence.adverseBlockers[condition] = blockers;
          await observer.client.instruction(
            'worker.pipeline.execution.cancel',
            { executionId: run.executionId, mode: 'finalize' },
            {
              metadata: { idempotencyKey: `settle-${run.executionId}` },
            },
          );
          await expect
            .poll(
              () =>
                observer.client
                  .query('worker.pipeline.execution.get', {
                    executionId: run.executionId,
                  })
                  .then((r) => r.execution.status),
              { timeout: 60_000 },
            )
            .toBe('cancelled');
        }
        // Every model request since the fault, on any tag or none (including a
        // retry of the in-flight turn), keeps the run's route; a credits
        // request must carry a credential the fault left current.
        const postFault = (await inferenceJournalRequests(key)).filter(
          (request) => request.index >= faultBaseline,
        );
        evidence.adversePostFaultRequests ??= {};
        evidence.adversePostFaultRequests[condition] = postFault.map(
          (request) => ({
            index: request.index,
            tag: request.tag,
            sessionTitle: request.helper === 'session-title',
            brokerAuthenticated: request.brokerAuthenticated,
            fixtureCredentialLabel: request.fixtureCredentialLabel,
          }),
        );
        const currentCredential =
          condition === 'revoked' || condition === 'disconnected'
            ? undefined
            : 'replacement';
        if (credits && currentCredential === undefined)
          expect(
            evidence.adversePostFaultRequests[condition],
            `${condition}: no model request after the credential was retired`,
          ).toEqual([]);
        for (const request of postFault) {
          const where = `${condition}: post-fault ${request.helper ? `${request.helper} ` : ''}request #${request.index} tagged ${request.tag ?? 'none'}`;
          expect(request.brokerAuthenticated, where).toBe(credits);
          expect(request.fixtureCredentialLabel, where).toBe(
            credits ? currentCredential : null,
          );
        }
        await restore();
        publicIsolated(
          await observer.client.instruction(
            'core.integration.cloudAccount.connectWithKey',
            { apiKey: cloudKeys[1] },
            {
              metadata: { idempotencyKey: `restore-${run.executionId}` },
            },
          ),
        );
      }
    }
    await observer.close();
    observer = undefined;
    let expectedStopReasons = ['idle'];
    if (qualifyLease) {
      // No harness kill may stand in for releasing the execution obligations.
      // retainDaemon exempts cleanup only; terminal runs must permit idle exit.
      await expect
        .poll(() => isAlive(identity.pid), {
          timeout: LEASE_FREE_INTERVAL_MS + 15_000,
          message: `Terminal runs released daemon obligations: ${JSON.stringify(evidence)}`,
        })
        .toBe(false);
      evidence.cleanup = 'natural idle shutdown';
    } else {
      // Preserve the durable-reopen proof without another production idle wait.
      // A daemon already gone was not stopped here, so it must have idled.
      // One that idles out as the signal lands keeps its idle reason.
      if (isAlive(identity.pid)) {
        process.kill(identity.pid, 'SIGTERM');
        expectedStopReasons = ['signal SIGTERM', 'idle'];
      }
      await expect
        .poll(() => isAlive(identity.pid), {
          timeout: 30_000,
          message: 'Non-lease check daemon stopped before durable reopen',
        })
        .toBe(false);
      evidence.cleanup = 'explicit teardown after non-lease check';
    }
    // The exited PID proves only an exit; the daemon's own receipt proves
    // why it stopped and that every shutdown phase completed.
    evidence.daemonShutdown = daemonShutdownReceipt(userDataDir, identity.pid);
    expect(evidence.daemonShutdown.pid).toBe(identity.pid);
    expect(
      expectedStopReasons,
      `Original daemon ${identity.pid} stop reason`,
    ).toContain(evidence.daemonShutdown.reason);
    expect(evidence.daemonShutdown.phases.length).toBeGreaterThan(0);
    for (const phase of evidence.daemonShutdown.phases)
      expect(phase.status, `shutdown phase ${phase.id}`).toBe('completed');
    evidence.phase = 'read mock requests before reopen';
    const requestCountBeforeReopen = (await mockState('requests', key)).requests
      .length;
    evidence.phase = 'reopen desktop';
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
    observer = await openNativeObserver(userDataDir);
    expect(observer.identity.pid).not.toBe(identity.pid);
    expect(observer.identity.build).toBe(identity.build);
    evidence.restartedDaemon = observer.identity;
    for (const [run, status] of [
      [finish, 'success'],
      [cancel, 'cancelled'],
    ]) {
      const recovered = await observer.client.query(
        'worker.pipeline.execution.get',
        { executionId: run.executionId, detail: true },
      );
      publicIsolated(recovered);
      expect(recovered.execution.status).toBe(status);
    }
    if (managed) {
      const publicAccount = await second.window.evaluate(() =>
        window.api.loadCanopyCloudAccount(),
      );
      publicIsolated(publicAccount);
      for (const [condition, run] of adverseRuns)
        await expect(
          second.window.getByTestId(`pipeline-run-card-${run.executionId}`),
        ).toContainText(
          condition === 'exhausted' && !credits ? 'success' : 'cancelled',
          { timeout: 30_000 },
        );
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
    evidence.phase = 'read mock requests after reopen';
    expect((await mockState('requests', key)).requests).toHaveLength(
      requestCountBeforeReopen,
    );
    expect(
      (await mockState('requests', key)).requests.filter(
        (request) => request.tag === 'after',
      ),
    ).toHaveLength(afterRequests.length);
    if (managed) {
      const sinks = await second.electronApp.evaluate(async () => {
        const flush = Reflect.get(
          globalThis,
          '__CANOPY_E2E_FLUSH_OBSERVABILITY__',
        );
        if (typeof flush !== 'function')
          throw new Error('Missing observability fixture');
        return flush();
      });
      evidence.isolationFiles = assertManagedFileIsolation(
        userDataDir,
        cloudKeys,
        sinks,
        finish.executionId,
      );
    }
    evidence.result =
      'finish success; separate run durably cancelled; reopened without duplicate';
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    for (const secret of cloudKeys)
      evidence.error = evidence.error.replaceAll(
        secret,
        '[redacted fixture account key]',
      );
    evidence.mockRequests = await mockState('requests', key).catch(String);
    if (managed) {
      evidence.inferenceJournal =
        await inferenceJournalRequests(key).catch(String);
      evidence.mockCloudActivity = {};
      for (const [index, cloudKey] of cloudKeys.entries()) {
        const activity = await mockControlPlaneQuery(
          `activity/${encodeURIComponent(cloudKey)}`,
        )
          .then((response) => response.activity)
          .catch(() => 'unavailable');
        evidence.mockCloudActivity[index === 0 ? 'initial' : 'replacement'] =
          activity;
      }
    }
    if (evidence.adverseExecutionId ?? evidence.finishExecutionId)
      evidence.execution = await nativeFailureExecution(
        observer,
        userDataDir,
        evidence.adverseExecutionId ?? evidence.finishExecutionId,
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
      ['journalCleanupError', () => managed && inferenceJournal('DELETE', key)],
      ...cloudKeys.map((cloudKey, index) => [
        `cloudCleanupError${index}`,
        () => clearScenario(DEFAULT_MOCK_BASE_URL, cloudKey),
      ]),
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
}
