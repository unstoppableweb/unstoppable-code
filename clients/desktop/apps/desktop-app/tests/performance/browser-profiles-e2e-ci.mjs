#!/usr/bin/env node
/** Bounded hosted/local deterministic E2E gate. Never production acceptance. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import {
  comparablePackage,
  assertProductionBootstrapImports,
  requireHostedMac,
  requireLocalPhysicalMac,
  prepareReleasePaths,
  assertReleaseStageIdentity,
  runCommandProcess,
  outputFootprint,
} from './browser-profiles-release-ci.mjs';
import { applyDevScriptSafetyWithWait } from '../../../../scripts/lib/dev-script-safety.mjs';
import { comparePerformanceResults } from './comparison.mjs';
import { percentile } from './statistics.mjs';
import { assessResponsiveness } from './responsiveness.mjs';
import {
  assertHeadlessStudyMetadata,
  assertHeadlessWindowEvidence,
  HEADLESS_STUDY_VIEWPORT as STUDY_VIEWPORT,
  HEADLESS_STUDY_MODE as STUDY_VIEWPORT_PRESET,
} from './browser-profiles-evidence.mjs';
import { parsePerformanceArgs } from './profiles.mjs';

const TEST_ROOT = 'apps/desktop-app/tests/';
const SCENARIOS = `${TEST_ROOT}performance/scenarios.mjs`;
const DRIVER = `${TEST_ROOT}performance/run.mjs`;
export const THRESHOLDS = Object.freeze({
  maxRegressionPercent: 10,
  minRegressionMs: 20,
});
const SETTINGS = Object.freeze({
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  TZ: 'UTC',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  CANOPY_SKIP_BINARY_STAGING_POSTINSTALL: 'true',
  CANOPY_E2E_BUILD_CACHE: '0',
  CANOPY_E2E_BUILD: '1',
  CANOPY_E2E_OUT_DIR: 'out-e2e',
  CANOPY_PERFORMANCE_SOURCEMAPS: '1',
  CANOPY_BRAND: 'canopy',
  CANOPY_RELEASE_FLAVOR: 'stable',
  CANOPY_RENDERER_SOURCEMAPS: 'false',
  // Current builds no longer read Datadog configuration; the pinned historical
  // baseline still does, so these keep its Datadog RUM and hidden maps off.
  CANOPY_DATADOG_ENABLED: 'false',
  CANOPY_DATADOG_SOURCEMAPS: 'false',
  // Current builds never obfuscate; these keep the pinned historical baseline,
  // which still reads them, building a comparable unobfuscated renderer.
  CANOPY_RENDERER_OBFUSCATION: 'false',
  CANOPY_RENDERER_OBFUSCATE_VENDOR: 'false',
  CANOPY_OLLAMA_ENABLED: 'true',
  CANOPY_DESKTOP_SHARED_SIDEBAR: 'false',
  CANOPY_DESKTOP_SIDEBAR_SHADOW: 'false',
  LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID: '',
  CANOPY_CLOUD_BASE_URL: 'http://127.0.0.1:4011',
  CANOPY_MOCK_LLM_BASE_URL: 'http://127.0.0.1:4011',
  CANOPY_LINEAR_API_BASE_URL: 'http://127.0.0.1:4011/graphql',
  CANOPY_E2E_MOCK_BASE_URL: 'http://127.0.0.1:4011',
  CANOPY_PERFORMANCE_MOCK_BASE_URL: 'http://127.0.0.1:4012',
});
const canonical = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
const equal = (a, b, message) =>
  assert.equal(canonical(a), canonical(b), message);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const BASELINE_NATIVE_UI_ORIGINAL_BLOCK = `      const firstNative = await browserViewByTitle(electronApp, PAGE_ONE_TITLE);
      const secondNative = await browserViewByTitle(
        electronApp,
        PAGE_TWO_TITLE,
      );
      expect(firstNative?.bounds.width).toBeGreaterThan(0);
      expect(secondNative?.bounds.width).toBeGreaterThan(0);
      expect(firstNative.bounds).not.toEqual(secondNative.bounds);
`;
const BASELINE_NATIVE_UI_INSTALLED_BLOCK = `      await expect
        .poll(async () => {
          const views = await nativeBrowserViews(electronApp);
          const firstBounds = views.find(
            (view) => view.title === PAGE_ONE_TITLE,
          )?.bounds;
          const secondBounds = views.find(
            (view) => view.title === PAGE_TWO_TITLE,
          )?.bounds;

          return {
            firstPositive: Boolean(
              firstBounds && firstBounds.width > 0 && firstBounds.height > 0,
            ),
            secondPositive: Boolean(
              secondBounds && secondBounds.width > 0 && secondBounds.height > 0,
            ),
            separate: Boolean(
              firstBounds &&
              secondBounds &&
              (firstBounds.x !== secondBounds.x ||
                firstBounds.y !== secondBounds.y ||
                firstBounds.width !== secondBounds.width ||
                firstBounds.height !== secondBounds.height),
            ),
            nonOverlapping: Boolean(
              firstBounds &&
              secondBounds &&
              (firstBounds.x + firstBounds.width <= secondBounds.x ||
                secondBounds.x + secondBounds.width <= firstBounds.x ||
                firstBounds.y + firstBounds.height <= secondBounds.y ||
                secondBounds.y + secondBounds.height <= firstBounds.y),
            ),
          };
        })
        .toEqual({
          firstPositive: true,
          secondPositive: true,
          separate: true,
          nonOverlapping: true,
        });
`;
const BASELINE_NATIVE_UI_PATCH =
  `diff --git a/apps/desktop-app/tests/electron/browser-chrome.spec.mjs b/apps/desktop-app/tests/electron/browser-chrome.spec.mjs
index a09d8e8954..c8c417c151 100644
--- a/apps/desktop-app/tests/electron/browser-chrome.spec.mjs
+++ b/apps/desktop-app/tests/electron/browser-chrome.spec.mjs
@@ -879,14 +879,47 @@ test.describe('repeatable Browser panels (one session per panel)', () => {
       ).toHaveValue(pageTwoUrl);
~
       // The two native views have independent non-overlapping bounds.
-      const firstNative = await browserViewByTitle(electronApp, PAGE_ONE_TITLE);
-      const secondNative = await browserViewByTitle(
-        electronApp,
-        PAGE_TWO_TITLE,
-      );
-      expect(firstNative?.bounds.width).toBeGreaterThan(0);
-      expect(secondNative?.bounds.width).toBeGreaterThan(0);
-      expect(firstNative.bounds).not.toEqual(secondNative.bounds);
+      await expect
+        .poll(async () => {
+          const views = await nativeBrowserViews(electronApp);
+          const firstBounds = views.find(
+            (view) => view.title === PAGE_ONE_TITLE,
+          )?.bounds;
+          const secondBounds = views.find(
+            (view) => view.title === PAGE_TWO_TITLE,
+          )?.bounds;
+
+          return {
+            firstPositive: Boolean(
+              firstBounds && firstBounds.width > 0 && firstBounds.height > 0,
+            ),
+            secondPositive: Boolean(
+              secondBounds && secondBounds.width > 0 && secondBounds.height > 0,
+            ),
+            separate: Boolean(
+              firstBounds &&
+              secondBounds &&
+              (firstBounds.x !== secondBounds.x ||
+                firstBounds.y !== secondBounds.y ||
+                firstBounds.width !== secondBounds.width ||
+                firstBounds.height !== secondBounds.height),
+            ),
+            nonOverlapping: Boolean(
+              firstBounds &&
+              secondBounds &&
+              (firstBounds.x + firstBounds.width <= secondBounds.x ||
+                secondBounds.x + secondBounds.width <= firstBounds.x ||
+                firstBounds.y + firstBounds.height <= secondBounds.y ||
+                secondBounds.y + secondBounds.height <= firstBounds.y),
+            ),
+          };
+        })
+        .toEqual({
+          firstPositive: true,
+          secondPositive: true,
+          separate: true,
+          nonOverlapping: true,
+        });
~
       // An overlay intersecting only pane one blocks only its native view.
       const firstBox = await window
`.replaceAll('\n~\n', '\n \n');
export const BASELINE_NATIVE_UI_OVERLAY = Object.freeze({
  path: `${TEST_ROOT}electron/browser-chrome.spec.mjs`,
  scope:
    'Diagnostic/test-only baseline native UI observation overlay; production and bundles are unchanged.',
  baselineCommit: '50ad63d648b27f867aa248cf3e8517aac0b4308d',
  replacementSourceCommit: 'd6d6d526b4c71874b2f9ab8f8a299cd4f5ecaac7',
  originalSha256:
    'bfbbcd244957a2fcf5e2f83c193f104c456519cfd9647d0f178d8947349ec77c',
  installedSha256:
    '71f9c7d382eb06047e8fbc50ec19632092ac4067172a1686fd5b015fbbaf9b9e',
  originalBlock: BASELINE_NATIVE_UI_ORIGINAL_BLOCK,
  originalBlockSha256:
    '365b9c22d8c60a004eda3673eb648236a9ad2814e723fa32230c16ef5ca40292',
  installedBlock: BASELINE_NATIVE_UI_INSTALLED_BLOCK,
  installedBlockSha256:
    'f58c78b8e9f072a6b3ad41a0bcbe85ff92e46ce192098a298a7bc0926269b103',
  patch: BASELINE_NATIVE_UI_PATCH,
  patchSha256:
    '74068f620d0212fc3cc2a191c0584f13b6a85f75841c2b1c4d44dff6fe9ee18c',
  artifactPrefix: 'baseline-native-ui-observation-overlay',
});
const occurrences = (source, value) => source.split(value).length - 1;
function assertSourceOverlayContract(contract) {
  assert(contract.originalBlock && contract.installedBlock);
  assert.notEqual(contract.originalBlock, contract.installedBlock);
  assert.equal(
    digest(contract.originalBlock),
    contract.originalBlockSha256,
    'Original observation block contract changed',
  );
  assert.equal(
    digest(contract.installedBlock),
    contract.installedBlockSha256,
    'Reviewed observation block contract changed',
  );
  assert.equal(
    digest(contract.patch),
    contract.patchSha256,
    'Observation overlay patch contract changed',
  );
}
export function buildExactSourceOverlay(
  source,
  contract = BASELINE_NATIVE_UI_OVERLAY,
) {
  assertSourceOverlayContract(contract);
  assert.equal(
    occurrences(source, contract.installedBlock),
    0,
    'Reviewed observation block already present; refuse patched source',
  );
  assert.equal(
    occurrences(source, contract.originalBlock),
    1,
    'Expected original observation block exactly once',
  );
  assert.equal(
    digest(source),
    contract.originalSha256,
    'Frozen source preimage changed',
  );
  const installed = source.replace(
    contract.originalBlock,
    contract.installedBlock,
  );
  assert.equal(
    digest(installed),
    contract.installedSha256,
    'Installed source identity differs',
  );
  return installed;
}
export function assertCandidateNativeUiObservation(source) {
  assertSourceOverlayContract(BASELINE_NATIVE_UI_OVERLAY);
  assert.equal(
    occurrences(source, BASELINE_NATIVE_UI_OVERLAY.installedBlock),
    1,
    'Candidate must contain the reviewed observation block exactly once',
  );
  assert.equal(
    occurrences(source, BASELINE_NATIVE_UI_OVERLAY.originalBlock),
    0,
    'Candidate must keep the original observation block absent',
  );
  return {
    path: BASELINE_NATIVE_UI_OVERLAY.path,
    sourceSha256: digest(source),
    blockSha256: BASELINE_NATIVE_UI_OVERLAY.installedBlockSha256,
    sourceCommit: BASELINE_NATIVE_UI_OVERLAY.replacementSourceCommit,
  };
}
const errorText = (error) => error?.stack ?? String(error);
export async function withExactSourceOverlay(
  {
    root,
    output,
    evidence,
    contract,
    sourceHash = hashFileUntil,
    workDeadline = manifestDeadline,
    cleanupDeadline = (startedAt) => startedAt + 5 * 60_000,
    now = Date.now,
  },
  operation,
) {
  assertSourceOverlayContract(contract);
  assert.equal(typeof operation, 'function');
  assert(
    !path.isAbsolute(contract.path) &&
      !path.normalize(contract.path).startsWith(`..${path.sep}`),
    'Source overlay path escaped checkout',
  );
  const target = path.join(root, contract.path);
  const original = await readFile(target, 'utf8');
  const installed = buildExactSourceOverlay(original, contract);
  const artifacts = {
    original: `${contract.artifactPrefix}-source-before.mjs`,
    installed: `${contract.artifactPrefix}-source-applied.mjs`,
    patch: `${contract.artifactPrefix}.patch`,
    evidence: `${contract.artifactPrefix}.json`,
  };
  Object.assign(evidence, {
    path: contract.path,
    scope: contract.scope,
    baselineCommit: contract.baselineCommit,
    replacementSource: {
      commit: contract.replacementSourceCommit,
      originalBlock: {
        bytes: contract.originalBlock,
        sha256: contract.originalBlockSha256,
      },
      installedBlock: {
        bytes: contract.installedBlock,
        sha256: contract.installedBlockSha256,
      },
    },
    original: { bytes: original, sha256: digest(original) },
    installed: { bytes: installed, sha256: digest(installed) },
    patch: { bytes: contract.patch, sha256: contract.patchSha256 },
    artifacts,
    apply: { status: 'preparing' },
    operation: { status: 'not-started' },
    restore: { status: 'not-required' },
  });
  await writeFile(path.join(output, artifacts.original), original, {
    flag: 'wx',
  });
  await writeFile(path.join(output, artifacts.installed), installed, {
    flag: 'wx',
  });
  await writeFile(path.join(output, artifacts.patch), contract.patch, {
    flag: 'wx',
  });
  await writeFile(
    path.join(output, artifacts.evidence),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx' },
  );
  let result,
    primaryError,
    restorationError,
    mutationAttempted = false;
  try {
    evidence.apply = { status: 'verifying-preimage' };
    assert(
      now() < workDeadline,
      'Work deadline exhausted before source overlay',
    );
    assert.equal(
      await sourceHash(
        target,
        workDeadline,
        'Work deadline exhausted while verifying source overlay preimage',
        now,
      ),
      contract.originalSha256,
      'Frozen source changed before overlay installation',
    );
    evidence.apply = { status: 'installing' };
    mutationAttempted = true;
    await writeFile(target, installed);
    assert.equal(
      await sourceHash(
        target,
        workDeadline,
        'Work deadline exhausted while verifying installed source overlay',
        now,
      ),
      contract.installedSha256,
      'Installed source write differs',
    );
    assert(
      now() < workDeadline,
      'Work deadline exhausted before baseline UI overlay operation',
    );
    evidence.apply = {
      status: 'applied',
      at: new Date().toISOString(),
      sha256: contract.installedSha256,
    };
    evidence.restore = { status: 'pending' };
    evidence.operation = { status: 'running' };
    result = await operation();
    evidence.operation = { status: 'completed' };
  } catch (error) {
    primaryError = error;
    if (evidence.operation.status === 'running')
      evidence.operation = { status: 'failed', error: errorText(error) };
    else if (evidence.apply.status === 'applied')
      evidence.operation = {
        status: 'not-started',
        error: errorText(error),
      };
    else
      evidence.apply = {
        ...evidence.apply,
        status: 'failed',
        error: errorText(error),
      };
  }
  if (mutationAttempted) {
    const cleanupStartedAt = now(),
      deadline = cleanupDeadline(cleanupStartedAt);
    evidence.restore = {
      status: 'checking',
      cleanupDeadline: deadline,
      maximumMs: 5 * 60_000,
    };
    try {
      assert(
        Number.isFinite(deadline) &&
          now() < deadline &&
          deadline <= cleanupStartedAt + 5 * 60_000,
        'Source overlay cleanup deadline exhausted',
      );
      const current = await sourceHash(
        target,
        deadline,
        'Source overlay cleanup deadline exhausted while checking ownership',
        now,
      );
      let mode = 'already-original-source';
      if (current !== contract.originalSha256) {
        assert.equal(
          current,
          contract.installedSha256,
          'Source ownership unknown; refuse overwrite during restoration',
        );
        mode = 'owned-installed-source';
        await writeFile(target, original);
        assert.equal(
          await sourceHash(
            target,
            deadline,
            'Source overlay cleanup deadline exhausted while verifying restoration',
            now,
          ),
          contract.originalSha256,
          'Restored source identity differs',
        );
      }
      evidence.restore = {
        status: 'restored',
        mode,
        at: new Date().toISOString(),
        sha256: contract.originalSha256,
        cleanupDeadline: deadline,
        maximumMs: 5 * 60_000,
      };
    } catch (error) {
      restorationError = error;
      evidence.restore = {
        ...evidence.restore,
        status: 'failed',
        error: errorText(error),
      };
    }
  }
  await writeFile(
    path.join(output, artifacts.evidence),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (primaryError && restorationError)
    throw new AggregateError(
      [primaryError, restorationError],
      `${errorText(primaryError)}\nSource restoration failed: ${errorText(restorationError)}`,
      { cause: primaryError },
    );
  if (primaryError) throw primaryError;
  if (restorationError)
    throw new Error(
      `Baseline UI source restoration failed: ${errorText(restorationError)}`,
      {
        cause: restorationError,
      },
    );
  return result;
}
export const withBaselineNativeUiObservationOverlay = (
  root,
  output,
  evidence,
  operation,
  lifecycle,
) =>
  withExactSourceOverlay(
    {
      root,
      output,
      evidence,
      ...lifecycle,
      contract: BASELINE_NATIVE_UI_OVERLAY,
    },
    operation,
  );
const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });

export function nativeUiCounts(log) {
  const text = stripVTControlCharacters(log);
  return Object.fromEntries(
    ['passed', 'failed', 'skipped', 'flaky'].map((kind) => [
      kind,
      Number(
        [
          ...text.matchAll(
            new RegExp('(?:^|\\n)\\s*([0-9]+) ' + kind + '\\b', 'g'),
          ),
        ].at(-1)?.[1] ?? 0,
      ),
    ]),
  );
}
export function schedule(protocol = 'full') {
  assert(
    ['full', 'qualification'].includes(protocol),
    'Only closed full/qualification protocols are enabled',
  );
  return [
    { stage: 'candidate', phase: 'smoke', pair: -2, profile: 'smoke' },
    ...Array.from(
      { length: protocol === 'qualification' ? 3 : 6 },
      (_, i) => i - 1,
    ).flatMap((pair) =>
      (pair >= 0 && pair % 2
        ? ['candidate', 'baseline']
        : ['baseline', 'candidate']
      ).map((stage) => ({
        stage,
        phase: pair < 0 ? 'warmup' : 'measured',
        pair,
        profile: 'baseline',
        ...(protocol === 'qualification' && pair < 0 ? { diagnose: true } : {}),
      })),
    ),
  ];
}
export function metricPolicies(metrics) {
  assert(metrics && Object.keys(metrics).length, 'Missing metrics');
  return Object.fromEntries(
    Object.entries(metrics)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { value, ...policy }]) => {
        assert(Number.isFinite(value), `Nonfinite metric: ${key}`);
        assert(
          typeof policy.unit === 'string' && policy.direction === 'lower',
          `Missing metric policy: ${key}`,
        );
        return [key, policy];
      }),
  );
}
export function validateRun(raw, attempt, identity) {
  assert.equal(attempt.code, 0, 'Primary command failed');
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.suite, 'desktop-app-performance');
  assert.equal(raw.benchmarkKind, 'e2e-relative');
  assert.equal(raw.profile, attempt.profile);
  equal(
    raw.config,
    parsePerformanceArgs([
      '--profile',
      attempt.profile,
      '--scenarios',
      'browser-panels',
    ]).config,
    'Workload config differs',
  );
  equal(raw.requestedScenarios, ['browser-panels']);
  assert.equal(raw.source?.commit, identity.commit, 'Source commit differs');
  assert.equal(raw.scenarios?.length, 1);
  assertHeadlessStudyMetadata(raw.environment);
  const scenario = raw.scenarios[0];
  // Primaries and diagnostic replays retain the same canonical availability,
  // workload and responsiveness gates; replay values never replace the primary.
  const validateScenario = (scenario) => {
    assertHeadlessWindowEvidence(scenario.windowEvidence);
    assert.equal(scenario.name, 'browser-panels');
    assert.equal(
      scenario.status,
      'ok',
      'Primary scenario failed; diagnostics cannot replace it',
    );
    assert(
      scenario.tasks.length === 12 &&
        scenario.tasks.every(
          (task) => task.status === 'ok' && Number.isFinite(task.durationMs),
        ),
      'Incomplete tasks',
    );
    assert.equal(scenario.counters?.panelsCreated, 2);
    assert.equal(scenario.counters?.lifecycleCycles, 2);
    assert.equal(
      scenario.counters?.seededHistoricalPartitions,
      raw.config.browserHistoricalPartitions,
    );
    const runtime = scenario.counters?.runtime;
    for (const field of ['electron', 'chrome', 'node', 'executable'])
      assert(
        typeof runtime?.[field] === 'string' && runtime[field],
        `Missing actual runtime ${field}`,
      );
    assert.equal(
      runtime.executable,
      identity.executable,
      'Unexpected launched Electron',
    );
    assert.equal(runtime.electron, raw.environment?.electronVersion);
    assert.equal(runtime.electron, identity.electronVersion);
    const summary = scenario.monitoring?.summary;
    for (const field of [
      'ipcOuterMs',
      'rendererFrameDelayMs',
      'totalWorkingSetMb',
      'totalCpuPercent',
    ])
      assert(
        summary?.[field]?.count > 0 && Number.isFinite(summary[field].max),
        `Missing samples: ${field}`,
      );
    assert(
      scenario.monitoring.raw?.ipcSamples?.length > 0 &&
        scenario.monitoring.raw?.resourceSamples?.length > 0 &&
        scenario.monitoring.raw?.renderer,
      'Missing raw monitoring',
    );
    assert.equal(scenario.responsiveness?.passed, true);
    assert.equal(
      assessResponsiveness(
        summary,
        raw.config.responsivenessThresholds,
        scenario.tasks,
      ).passed,
      true,
      'Canonical responsiveness failed',
    );
    assert.equal(
      scenario.monitoring.raw.renderer.longTaskObserverAvailable,
      true,
      'Missing affirmative long-task observer coverage',
    );
    assert(
      scenario.monitoring.raw.renderer.frames?.length > 0,
      'Missing primary frame timestamps',
    );
    assert(
      scenario.monitoring.raw.renderer.taskEvents?.length >= 24,
      'Missing primary task boundaries',
    );
  };
  validateScenario(scenario);
  if (attempt.diagnose) {
    assert.equal(
      scenario.diagnostics?.status,
      'ok',
      'Required diagnostic capture failed',
    );
    assert.equal(
      scenario.diagnostics?.replay?.status,
      'ok',
      'Required diagnostic scenario failed',
    );
  }
  if (scenario.diagnostics?.replay) {
    validateScenario(scenario.diagnostics.replay);
  }

  metricPolicies(raw.metrics);
  return raw;
}
export function aggregatePopulation(rows, statistic) {
  assert(['median', 'p95'].includes(statistic));
  assert.equal(rows.length, 5, 'Exactly five measured runs required');
  equal(
    rows.map((row) => row.attempt.pair).sort(),
    [0, 1, 2, 3, 4],
    'Missing/duplicate pair',
  );
  const first = rows[0];
  for (const row of rows) {
    assert.equal(row.attempt.phase, 'measured');
    assert.equal(row.attempt.status, 'ok', 'Failed/incomplete sample retained');
    assert.equal(row.attempt.stage, first.attempt.stage);
    equal(row.identity, first.identity, 'Sample identity changed');
    validateRun(row.raw, row.attempt, row.identity);
    equal(row.raw.environment, first.raw.environment, 'Environment changed');
    equal(
      row.raw.scenarios[0].counters.runtime,
      first.raw.scenarios[0].counters.runtime,
      'Actual runtime changed',
    );
    equal(
      metricPolicies(row.raw.metrics),
      metricPolicies(first.raw.metrics),
      'Metric keyset/policy differs',
    );
  }
  return {
    ...structuredClone(first.raw),
    label: `${statistic} across five complete independent runs`,
    aggregation: {
      statistic,
      count: 5,
      samplePaths: rows.map((row) => row.attempt.reportPath),
    },
    metrics: Object.fromEntries(
      Object.entries(first.raw.metrics).map(([key, metric]) => [
        key,
        {
          ...metric,
          value: percentile(
            rows.map((row) => row.raw.metrics[key].value),
            statistic === 'median' ? 0.5 : 0.95,
          ),
        },
      ]),
    ),
  };
}
export function assertMatchedPopulations(before, after) {
  equal(
    metricPolicies(before.metrics),
    metricPolicies(after.metrics),
    'Cross-stage metric keyset/policy differs',
  );
  const runtime = (raw) => {
    const versions = { ...raw.scenarios[0].counters.runtime };
    delete versions.executable;
    return versions;
  };
  equal(runtime(before), runtime(after), 'Cross-stage actual runtime differs');
  assert.equal(
    comparePerformanceResults(before, after, THRESHOLDS).compatible,
    true,
    'Canonical compatibility failed',
  );
}
export function runtimeOverlay(source) {
  assert(
    !source.includes('runtime: await electronApp.evaluate'),
    'Runtime overlay already present',
  );
  const anchor = '    panelsCreated: bindings.length,';
  assert.equal(
    source.split(anchor).length,
    2,
    'Runtime insertion anchor changed',
  );
  return source.replace(
    anchor,
    `    runtime: await electronApp.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, executable: process.execPath })),\n${anchor}`,
  );
}
const REVIEWED_STUDY_OVERLAYS = Object.freeze({
  'apps/desktop-app/tests/electron/mock-server/routes/linear.mjs':
    Object.freeze({
      original:
        'e7784a752425a492af075f427559a6b87997050c753ee5d6602bd177d14bb507',
      installed:
        'e7784a752425a492af075f427559a6b87997050c753ee5d6602bd177d14bb507',
    }),
  'apps/desktop-app/tests/electron/seeders/seedPluginsCache.mjs': Object.freeze(
    {
      original:
        '5261125033d1822c48e072da6c32aec28f42441c48416c282f58210b366c3ef5',
      installed:
        '5261125033d1822c48e072da6c32aec28f42441c48416c282f58210b366c3ef5',
    },
  ),
  'apps/desktop-app/tests/electron/seeders/seedSharedContainerRecipientReplicas.mjs':
    Object.freeze({
      original:
        '8c6ccc783e0351d804ad8cebdf5d3329fd81ef638e034cd7071e7f51a124881c',
      installed:
        '8c6ccc783e0351d804ad8cebdf5d3329fd81ef638e034cd7071e7f51a124881c',
    }),
  'apps/desktop-app/tests/electron/seeders/seedCoworkWorkspace.mjs':
    Object.freeze({
      original:
        '72f1500fb176e3d769f39189d227a108b9c78d25028f4393158f3702c06cd8af',
      installed:
        '6fe0dc288be4b115078cc3edb06a4df71cd6000766e0fa8cd7465db584e173b7',
    }),
  'packages/execution-engine/src/pipelines/config-paths.ts': Object.freeze({
    original:
      'ca1693b07d8d06c7a429b05ef0a27408405f8bc4bebbdd011367031888b01c91',
    installed:
      '1ceb4e94ff9590fe1fdc4b8158358ca508a836059512d6f669b51677433ce0c0',
  }),
  'apps/desktop-app/tests/performance/comparison.mjs':
    'a27d241c8e1f32bc04cde6d2a0a699e0b6e9d1e9b641d5f7bce3215444ac4493',
  // The work-counter metric layer extends the metric builder after the study.
  'apps/desktop-app/tests/performance/results.mjs':
    '3db81289f98f79850d8b483eec1986efe3fb6d850592ef4c17385dc822cc6ab3',
  'apps/desktop-app/tests/performance/diagnostic-replay.mjs':
    '42e55c9eb0da37905b69d523c49799203f487f7fd868380fedbd5aae00f98301',
  'apps/desktop-app/tests/performance/diagnostics.mjs': Object.freeze({
    original:
      '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
    installed:
      '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
  }),
  'apps/desktop-app/tests/performance/scenarios.mjs': Object.freeze({
    original:
      'dba1f957e931f61e9e42d1d22d3e6d1ac36510d3567661d1ae9cd4756df7501b',
    installed:
      'a83f2e15140d9800e2aa33a5782b6e3374ef2493840ea0ab45d3ed7c2863208b',
  }),
  'apps/desktop-app/tests/performance/monitor.mjs':
    '5d644bd000078fce4776cc0f8d09072cfc3ec719cf98da331dd1e27db53de02c',
  'apps/desktop-app/tests/performance/process-tree-supervisor.mjs':
    '0cff1607b1d40332ef15c1e96135a4d53c73d3ca5e9aed45dc67eaf53851a04d',
  'apps/desktop-app/tests/performance/profiles.mjs':
    '63217c1d9d4714ec0602a0f4cca00f157322ea101a2a207e3ea4d3c9f9a10667',
  'apps/desktop-app/tests/performance/run.mjs':
    'cb020cfeb90787f53f1288dd6cb7ac60a27b31287ea0b2015b279c05998d96bf',
  'apps/desktop-app/tests/performance/compare.mjs':
    '8fcc3452ce5c3a6f93500a965d44126e09de7cf79aca6f09ee0f217a7a3ebeda',
  'apps/desktop-app/tests/electron/launchCanopy.mjs':
    'fd591e8a4999aecea184e1201bc4167f2e954efcbab0e6fef1481f6254be7c4a',
  'apps/desktop-app/tests/electron/mock-server/start.mjs':
    'b8bf252001dea13c8ec6a8527cc83f463c861998434c3bf88a430171c12cbbf2',
  // Copilot device-flow fixtures extend the shared mock server. The closed
  // study's original bytes remain the baseline for both stages.
  'apps/desktop-app/tests/electron/mock-server/control-plane.mjs':
    Object.freeze({
      original:
        '26151d75fd5f5113976d7828ec8de5eee3ce04b6f56eadf547695adb39356bb0',
      installed:
        '26151d75fd5f5113976d7828ec8de5eee3ce04b6f56eadf547695adb39356bb0',
    }),
  'apps/desktop-app/tests/electron/mock-server/routes/github.mjs':
    Object.freeze({
      original:
        '8133d1c52c17c84cb8f5ecd82842d197b7b5af257326fd1b5ce1415d84b0eae5',
      installed:
        '8133d1c52c17c84cb8f5ecd82842d197b7b5af257326fd1b5ce1415d84b0eae5',
    }),
  'apps/desktop-app/tests/electron/mock-server/routes/authUsage.mjs':
    '906969adafd4cbeb19ced6eff9999b8d020d90060fc9677d4f58ec36af9f4cc7',
  'apps/desktop-app/tests/electron/mock-server/routes/cloud.mjs':
    '601aa335a9629e230303be07b12984a3660fa07209462e61bc52f35ed320b6b6',
  'apps/desktop-app/tests/electron/mock-server/routes/shared-containers.mjs':
    Object.freeze({
      original:
        '5cc71d2e9400c2548e75d18bde4455605720aaff7e1014b45bc8abd80d55f629',
      installed:
        'd77491ba99d2759cfcc09d6d61325343d3e12a4e1eff8cd97be35ed6c5806996',
    }),
  'apps/desktop-app/tests/electron/mock-server/routes/llm.mjs':
    'c754a74d2376a9c8f17cf3bb6eec41bfd2061762ff54777e895543a9219cdbdc',
  // Turn-state phase 29 adds opt-in lifecycle controls; the study installed the
  // original bytes in both stages.
  'apps/desktop-app/tests/electron/mock-server/routes/responsesWs.mjs':
    Object.freeze({
      original:
        '00ae19cf7a13c7d7a3f268455649cbbce5601d203a20762aaf86439c38eafc50',
      installed:
        '00ae19cf7a13c7d7a3f268455649cbbce5601d203a20762aaf86439c38eafc50',
    }),
  'apps/desktop-app/tests/electron/seeders/registerScenario.mjs': Object.freeze(
    {
      original:
        '97592c545b5ef2b726a2d52c74476f02d3b313a31dcb46d89811bac12e2375fb',
      installed:
        'c64cf244d9ae5d4ab1df2bbe3b4baaee984320a35ee39302d87b5ff2f9d916b2',
    },
  ),
  'apps/desktop-app/tests/electron/seeders/index.mjs':
    '5a6c6afa74f46a3450ff05484a8675b278a8c762eb2182937bf9274b6437c1f7',
  // REG-3033 lets the curated plugin seeder take plugin definitions. The
  // study's original seeder bytes are proven against `original`, and the
  // candidate seeder is proven against `installed` before either root takes
  // it, as every other reviewed current helper is.
  'apps/desktop-app/tests/electron/seeders/seedCuratedPlugins.mjs':
    Object.freeze({
      original:
        '5395ab3bc9ee12656266cc03d3de649d1fe5da075c489b85a7048724c32d174f',
      installed:
        '1c8ebb49c8d3bb95ca0fee31ae43b42a3220b8b9b97557059555338ce5a84aa1',
    }),
  // Pipeline toast coverage seeds the pause checkpoint carried by injected
  // events. Keep the closed study's seeder bytes as the original identity.
  'apps/desktop-app/tests/electron/seeders/seedPipelineExecution.mjs':
    Object.freeze({
      original:
        'f5e8f97569647201d7635d502b5cb721ec20ee2cfe2c8c9214bb39e8abebb961',
      installed:
        '31748ae7e78be9b3429f93ab319288f97ac55391155c12ce53d6f3fdba3f696e',
    }),
  // Demo seeding later stopped inheriting repository Git env vars, which let a
  // run from a Git hook configure the caller's repository. Both stages install
  // the current helper.
  'demo-apps/lib/git.mjs':
    'dd68843f3563b4032413368eeadc369dcc0c9ca81010105cfabf85185ccd3721',
});
// Keep the study's installed identities above and pin reviewed current
// compositions when shared harness fixtures change after the closed study.
const REVIEWED_CURRENT_STUDY_OVERLAYS = Object.freeze({
  // C3 adds the opt-in many-worktree file-index corpus and its lab capture;
  // B7 adds the opt-in scope-residency scenario; the merge with develop adds
  // its opt-in sidebar reorder and Code Review registry scenarios; the
  // opt-in delegation-restart-cycles scenario follows; the next merge adds
  // develop's W5 store arms and 120 Hz frame report, and the one after it
  // CAN-5651's startup-settle catalog cache seed from the shared helper, and
  // the opt-in Feed overview scenario composes with them.
  'apps/desktop-app/tests/performance/scenarios.mjs':
    'aeeda501273e8eba8aff3fba5423d57f9b0e0c709add217cad37e49ea5657101',
  // CAN-3606 adds bounded Linear issue attachment responses to the shared
  // fixture; transcript reference previews add team-key catalog and
  // exact-issue routes.
  // CAN-4529 shares the control plane's cached JSON body reader so routes on
  // /graphql can inspect a request and decline it.
  'apps/desktop-app/tests/electron/mock-server/routes/linear.mjs':
    '246ce4fcefec010d2e733b0cbc9447626cd365c7a512b5b681aa2a2ceb164b63',
  // Turn-state phase 29 adds opt-in lifecycle controls (barriers, attempts,
  // error modes, request observations); existing scenarios are unchanged.
  'apps/desktop-app/tests/electron/mock-server/control-plane.mjs':
    'e81dc69afa01861ef9c256b013374cd6db720334aafab4b1e0a3ee1e37af5bfa',
  'apps/desktop-app/tests/electron/mock-server/routes/responsesWs.mjs':
    'a9edd302584f93e9799fbfca09d5c7bd9b7b76d8dffd58e68f9c4dafc145a71a',
  // CAN-3707 adds merge queue responses to the reviewed GitHub mock; CAN-3781
  // adds pull request watcher responses; CAN-3838 adds the merge queue timeline.
  // PR #4824 composes those responses with merge queue PR status fixtures;
  // CAN-3979 adds transcript reference preview responses; CAN-4529 adds
  // pull request search responses; CAN-4938 adds opt-in Copilot refresh
  // rotation controls; PR #7217 answers the shared status query by number.
  'apps/desktop-app/tests/electron/mock-server/routes/github.mjs':
    '2e9cb83c87fceca7123465572cc7f02476998e36079a2063317afee8b95e7f49',
  // Project template checklist coverage (CAN-3032) seeds built-in marketplace
  // plugins in the plugins cache, and the additionalPlugins docs describe
  // `details` and `facets` rows for member previews.
  'apps/desktop-app/tests/electron/seeders/seedPluginsCache.mjs':
    '8a4926e6d2c0f7dce21c5b1b3a8d3cd8604c80e6584eddaf20e19ac66e6b43c0',
  // Start-page recipient coverage adds optional fixture metadata; the reload
  // check keeps the seeded Launch command alive until revocation stops it.
  // CAN-4187 can seed a web page into the publisher's preferred layout.
  // CAN-4908 distinguishes revision-two note bytes for copy consistency coverage.
  // A comment now names `.claude/skills` as the committed symlink example.
  // CAN-4785 seeds one mock-served remote image and one unreachable one.
  'apps/desktop-app/tests/electron/seeders/seedSharedContainerRecipientReplicas.mjs':
    'd66c3d0396bd0f199c6724b013db8405626d34fa6ae972795648db75d9681d93',
  // Project template checklist coverage (CAN-3032) adds template stamping,
  // starter prompts, default plugin selections, and index merging to the
  // cowork seeder without changing the study's original bytes.
  'apps/desktop-app/tests/electron/seeders/seedCoworkWorkspace.mjs':
    '70ecdc752d747535445d6ad545197b36a9e1029c89c45917a6cfb9dc2791993f',
  // CAN-4052 adds the recipient's recoverable share removal and restore routes.
  // CAN-4266 serves empty signed-in listings for accounts without seeded shares.
  // CAN-4655 serves revision capability packages and their downloads.
  'apps/desktop-app/tests/electron/mock-server/routes/shared-containers.mjs':
    'cdfdaa6b38cb3f21cde94622acd1215339905cd3f6111fe1693f4091b05e5494',
  // The shared server now catches rejected and throwing route handlers.
  'apps/desktop-app/tests/electron/mock-server/start.mjs':
    '5fd5993e8e6b15da85d95dbfcf089265a42926645d2f3ddbaf0bdee5734e31d6',
  // Reject symlinked Git directories and inherited numbered config overrides.
  'demo-apps/lib/git.mjs':
    '6bfbd61985893654924b066533f526acd28ead8dcdbbf2e1547746039c45ddde',
});
const REVIEWED_LIFECYCLE_HELPER = `${TEST_ROOT}electron/browser-profile-test-lifecycle.mjs`;
const REVIEWED_LIFECYCLE_HELPER_SHA256 =
  'b2191a0b2253628f906ff6b8d83b018ea4e00de6d36c365812a1682b8fa8a6f4';
// CAN-3662 seeds Early access through durable Labs choices.
// Cost's fixture adds these helpers to the shared harness closure. They were
// absent from the frozen study; admit only the reviewed current bytes.
// PR #5422 seeds cache tokens for the cost token label assertions.
const REVIEWED_COST_HARNESS_HELPERS = Object.freeze({
  'apps/desktop-app/tests/electron/seeders/seedCostInsights.mjs':
    'ccaa70de629282d3d650439438d8e7b2d9bb6036be7a620dd016dc682c53fbd9',
  'apps/desktop-app/tests/electron/seeders/seedEarlyAccess.mjs':
    '416e1fb3cba46281cdd2951ea4a8d90a4808ba04da83e0ce5d96e4e8ae04b5cd',
  'apps/desktop-app/tests/electron/seeders/subagentViewerCapture.mjs':
    'c75266f465bb35d5568246d073439151a5d3bf9b4aac2e3b09627e485e7ca7e1',
  'apps/desktop-app/tests/electron/seeders/subagentViewerRecords.mjs':
    'ac0b028a428e694052d1321142d70585f19e55246e3fd990e6e205cb8c11ce7b',
  'apps/desktop-app/tests/performance/cost-index-fixture.mjs':
    'e64956dc86938be3a581ecb521857a311381b46fe30d8ecb1d1ea1e35a0c788d',
});
// CAN-4386 adds the hosted settings mock and its shared fixture helpers;
// CAN-4421 extends them for the consolidated Settings rail; CAN-3383 adds the
// organization data-sharing viewer route; CAN-4532 extends the fixtures for
// the organization Projects page; CAN-4553 adds organization membership
// routes and an incoming-invitation fixture; CAN-4558 matches production's
// organization lists and memory team header, fills settings route gaps and
// serves the memory fact detail read; PR #6025 adds the account Labs route;
// CAN-4693 (PR #6134) serves the strict authenticated auth-link mint; PR
// #6467 reports the organization's GitHub connection in its bootstrap; PR
// #6634 serves the Appearance page's account data; PR #7366 seeds two billing
// charges for the Account billing table flow.
const REVIEWED_HOSTED_SETTINGS_HELPERS = Object.freeze({
  'apps/desktop-app/tests/electron/seeders/hostedSettingsCloud.mjs':
    '7727df3daf3f476fa3a8d1659dd4e853c703c0a92e7cc49347a6bf48199d3288',
  'apps/desktop-app/tests/electron/mock-server/routes/hosted-settings-fixtures.mjs':
    '76aa450ea4dd54fd07f20913ea18cd5f9ea5d4d882ae9e1e9cd97e8887f1a0a0',
  // CAN-5110: scoped outgoing invitation pages/revocation and seeded creators.
  'apps/desktop-app/tests/electron/mock-server/routes/hosted-settings.mjs':
    '7202c24c96df662d648cb67142c5a4af72afb7c3c2b379550330bcee85942427',
});
// CAN-5188 adds the memory sync mock route, absent from the frozen study
// baseline; the study's scenarios never call it.
const REVIEWED_MEMORY_SYNC_HELPERS = Object.freeze({
  'apps/desktop-app/tests/electron/mock-server/routes/memory-sync.mjs':
    '76acab5b21ecbc468f79ae273e1f79c3d21b75f16321631dd5a2d7173276a859',
});
// Sidebar reorder adds two helpers absent from the frozen study baseline.
const REVIEWED_SIDEBAR_REORDER_HELPERS = Object.freeze({
  'apps/desktop-app/tests/performance/sidebar-reorder-scenario.mjs':
    '9200629d6acfc57a59e399877c65b1dcab4344c346cfeac961aa62945b922af7',
  'apps/desktop-app/tests/electron/sidebarReorderFixture.mjs':
    '4449473bf92cff60f9e5d9e6870001a7ecd01b0fdb4ae00273cd6a16b2494fbb',
});
// CAN-5022 extracts the existing catalog from the cloud route. Pin the helper
// bytes separately while preserving the closed study's original route source.
// CAN-5651 reads the served catalog version from source through a shared
// helper that the startup-settle cache seed also uses.
const REVIEWED_GATEWAY_CATALOG_HELPERS = Object.freeze({
  'apps/desktop-app/tests/electron/mock-server/routes/ai-gateway-catalog.mjs':
    '3694fbd3a00c10d6d651c1b59c34a538cada399d13bf9a080a519353bb5f6379',
  'apps/desktop-app/tests/electron/ai-gateway-catalog-versions.mjs':
    '88d6d1c7db87def04df4c717580fe51cd4df66642136ff5cf8497dcf15f6e505',
});
// CAN-4495 adds the opt-in Code Review registry workload, absent from the
// frozen study baseline.
const REVIEWED_CODE_REVIEW_REGISTRY_HELPERS = Object.freeze({
  'apps/desktop-app/tests/performance/code-review-registry-scenario.mjs':
    '43278aae640f28f4fd8b8dadc452444fb8427307138ab98650224e4820972255',
});
// CAN-5532 adds the opt-in W5 store arm workloads, absent from the frozen
// study baseline.
const REVIEWED_W5_STORE_HELPERS = Object.freeze({
  'apps/desktop-app/tests/performance/w5-store-arms.mjs':
    '7b93d96005b2f16ae556d51819b4e15027aabee43967d3bb0360257787c693bd',
  'apps/desktop-app/tests/performance/w5-store-scenario.mjs':
    '1e4cc446b6f7528b6c797109f0984b702ef0f818b3ffe874949ac582bd07e1bb',
});
const REVIEWED_ADDED_HARNESS_HELPERS = Object.freeze([
  ...Object.keys(REVIEWED_GATEWAY_CATALOG_HELPERS),
  ...Object.keys(REVIEWED_SIDEBAR_REORDER_HELPERS),
  ...Object.keys(REVIEWED_CODE_REVIEW_REGISTRY_HELPERS),
  ...Object.keys(REVIEWED_W5_STORE_HELPERS),
  // CAN-3753: matched local smoke policy; closed studies retain strict gating.
  'apps/desktop-app/tests/performance/host-measurement.mjs',
  'apps/desktop-app/tests/performance/smoke-acceptance.mjs',
  'apps/desktop-app/tests/performance/scenario-failure-diagnostics.mjs',
  'apps/desktop-app/tests/performance/work-ratchet.mjs',
  'apps/desktop-app/tests/performance/disk-io.mjs',
  'apps/desktop-app/tests/performance/scaling-ratios.mjs',
  'apps/desktop-app/tests/performance/verdicts.mjs',
  ...Object.keys(REVIEWED_HOSTED_SETTINGS_HELPERS),
  ...Object.keys(REVIEWED_MEMORY_SYNC_HELPERS),
  ...Object.keys(REVIEWED_COST_HARNESS_HELPERS),
  'apps/desktop-app/tests/electron/cowork-summary-fixture.mjs',
  // B7 adds the deterministic scope-residency fixture.
  'apps/desktop-app/tests/performance/scope-residency-fixture.mjs',
  'apps/desktop-app/tests/electron/fixtures/curatedPipelinesCloud.mjs',
  'apps/desktop-app/tests/electron/mock-server/request-guard.mjs',
  'apps/desktop-app/tests/electron/seeders/claudeQueryPrelude.mjs',
  'apps/desktop-app/tests/electron/seeders/connectMockCloudAccount.mjs',
  'apps/desktop-app/tests/electron/seeders/seedBlueprintCatalog.mjs',
  'apps/desktop-app/tests/electron/seeders/seedChatsSectionFixture.mjs',
  'apps/desktop-app/tests/electron/seeders/seedCuratedPipelinesCapture.mjs',
  'apps/desktop-app/tests/electron/seeders/seedOrgContextScoping.mjs',
  'apps/desktop-app/tests/electron/seeders/seedPinnedItemsFixture.mjs',
  'apps/desktop-app/tests/electron/seeders/seedPipelineShareUnresolvedInvocations.mjs',
  // #5948: canonical turn lifecycle receipts for injected E2E turns.
  'apps/desktop-app/tests/electron/seeders/publishTurnLifecycle.mjs',
  // Foreground-first A0: the 80k-row lab transcript fixture and its driver.
  'apps/desktop-app/tests/electron/lab-transcript-fixture.mjs',
  'apps/desktop-app/tests/electron/lab-transcript-driver.mjs',
  // Foreground-first C2: the many-chat residency fixture.
  'apps/desktop-app/tests/electron/many-chat-fixture.mjs',
  // The delegation-restart-cycles scenario reuses the Electron flows'
  // transcript rewrite observer and background drawer helper.
  'apps/desktop-app/tests/electron/backgroundDrawer.mjs',
  'apps/desktop-app/tests/electron/delegationStorageWorkload.mjs',
  'apps/desktop-app/tests/electron/stress-transcript-driver.mjs',
  'apps/desktop-app/tests/electron/stress-transcript-fixture.mjs',
  'apps/desktop-app/tests/performance/disk-io.mjs',
  'apps/desktop-app/tests/performance/quit-latency.mjs',
  'apps/desktop-app/tests/performance/scaling-ratios.mjs',
  'apps/desktop-app/tests/performance/scenario-failure-diagnostics.mjs',
  'apps/desktop-app/tests/performance/verdicts.mjs',
  'apps/desktop-app/tests/performance/work-ratchet.mjs',
  'apps/desktop-app/tests/performance/worktree-git-gate.mjs',
  'scripts/lib/e2e-harness-measurement.mjs',
]);
const REVIEWED_MEASUREMENT_HELPER_SHA256 =
  'd9f0634bd0ec475ede901072aabb8b3196b5da14d3142786a18cdb4475241fff';

export async function readBaselineHarnessSource(root, file, after) {
  try {
    return await readFile(path.join(root, file), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (file === REVIEWED_LIFECYCLE_HELPER) {
      assert.equal(
        digest(after),
        REVIEWED_LIFECYCLE_HELPER_SHA256,
        'Unreviewed harness delta: lifecycle helper bytes',
      );
      return null;
    }
    if (REVIEWED_ADDED_HARNESS_HELPERS.includes(file)) return null;
    if (
      [
        `${TEST_ROOT}performance/browser-profiles-evidence.mjs`,
        `${TEST_ROOT}performance/browser-profiles-production-headless-bootstrap.cjs`,
      ].includes(file)
    )
      return null;
    throw error;
  }
}

export function matchedHarnessSource(file, before, after) {
  if (file === REVIEWED_LIFECYCLE_HELPER) {
    assert.equal(
      before,
      null,
      'Lifecycle helper unexpectedly exists in frozen baseline',
    );
    assert.equal(
      digest(after),
      REVIEWED_LIFECYCLE_HELPER_SHA256,
      'Unreviewed harness delta: lifecycle helper bytes',
    );
    return after;
  }
  const newHelper = `${TEST_ROOT}performance/browser-profiles-evidence.mjs`;
  if (
    [
      newHelper,
      `${TEST_ROOT}performance/browser-profiles-production-headless-bootstrap.cjs`,
      ...REVIEWED_ADDED_HARNESS_HELPERS,
    ].includes(file)
  ) {
    assert.equal(
      before,
      null,
      'New study helper unexpectedly exists in baseline',
    );
    if (file === 'scripts/lib/e2e-harness-measurement.mjs')
      assert.equal(
        digest(after),
        REVIEWED_MEASUREMENT_HELPER_SHA256,
        'Unreviewed measurement helper bytes',
      );
    if (Object.hasOwn(REVIEWED_SIDEBAR_REORDER_HELPERS, file))
      assert.equal(
        digest(after),
        REVIEWED_SIDEBAR_REORDER_HELPERS[file],
        'Unreviewed sidebar reorder helper bytes',
      );
    if (Object.hasOwn(REVIEWED_CODE_REVIEW_REGISTRY_HELPERS, file))
      assert.equal(
        digest(after),
        REVIEWED_CODE_REVIEW_REGISTRY_HELPERS[file],
        'Unreviewed Code Review registry helper bytes',
      );
    if (Object.hasOwn(REVIEWED_W5_STORE_HELPERS, file))
      assert.equal(
        digest(after),
        REVIEWED_W5_STORE_HELPERS[file],
        'Unreviewed W5 store helper bytes',
      );
    if (Object.hasOwn(REVIEWED_COST_HARNESS_HELPERS, file))
      assert.equal(
        digest(after),
        REVIEWED_COST_HARNESS_HELPERS[file],
        'Unreviewed Cost fixture helper bytes',
      );
    if (Object.hasOwn(REVIEWED_HOSTED_SETTINGS_HELPERS, file))
      assert.equal(
        digest(after),
        REVIEWED_HOSTED_SETTINGS_HELPERS[file],
        'Unreviewed hosted settings helper bytes',
      );
    if (Object.hasOwn(REVIEWED_GATEWAY_CATALOG_HELPERS, file))
      assert.equal(
        digest(after),
        REVIEWED_GATEWAY_CATALOG_HELPERS[file],
        'Unreviewed gateway catalog helper bytes',
      );
    if (Object.hasOwn(REVIEWED_MEMORY_SYNC_HELPERS, file))
      assert.equal(
        digest(after),
        REVIEWED_MEMORY_SYNC_HELPERS[file],
        'Unreviewed memory sync helper bytes',
      );
    return after;
  }
  if (Object.hasOwn(REVIEWED_STUDY_OVERLAYS, file)) {
    const identity = REVIEWED_STUDY_OVERLAYS[file];
    assert.equal(
      digest(before),
      typeof identity === 'string' ? identity : identity.original,
      `Original reviewed helper bytes changed: ${file}`,
    );
    if (typeof identity !== 'string')
      assert.equal(
        digest(after),
        REVIEWED_CURRENT_STUDY_OVERLAYS[file] ?? identity.installed,
        `Installed reviewed helper bytes changed: ${file}`,
      );
    return file === SCENARIOS ? runtimeOverlay(after) : after;
  }
  if (before !== after)
    assert(
      [
        `${TEST_ROOT}electron/canopyApp.mjs`,
        `${TEST_ROOT}electron/panelHarness.mjs`,
      ].includes(file),
      `Unreviewed harness delta: ${file}`,
    );
  // Preserve previously reviewed original Windows/callback helpers; unused by this macOS study.
  return before;
}
export function assertAllowedHarnessOverlay(file) {
  assert(
    file.startsWith(TEST_ROOT) ||
      (file === 'demo-apps/lib/git.mjs' &&
        Object.hasOwn(REVIEWED_STUDY_OVERLAYS, file) &&
        Object.hasOwn(REVIEWED_CURRENT_STUDY_OVERLAYS, file)) ||
      file === 'scripts/lib/e2e-harness-measurement.mjs',
    `Production overlay prohibited: ${file}`,
  );
}
export async function harnessFiles(root) {
  const ts = createRequire(path.join(root, 'package.json'))('typescript'),
    files = new Set();
  const compilerOptions = ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config,
    ts.sys,
    root,
  ).options;
  async function visit(relative) {
    if (files.has(relative)) return;
    assert(!relative.startsWith('../'), 'Harness import escaped checkout');
    files.add(relative);
    const absolute = path.join(root, relative),
      source = ts.createSourceFile(
        absolute,
        await readFile(absolute, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      ),
      imports = [];
    function walk(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        !node.importClause?.isTypeOnly &&
        !node.isTypeOnly
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        assert(
          ts.isStringLiteral(node.arguments[0]),
          `Nonliteral harness import: ${relative}`,
        );
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    }
    if (
      relative ===
      `${TEST_ROOT}performance/browser-profiles-production-headless-bootstrap.cjs`
    )
      assertProductionBootstrapImports(source.text, ts);
    walk(source);
    for (const specifier of imports.filter(
      (value) => value.startsWith('.') || value.startsWith('@canopy/'),
    )) {
      const resolved = ts.resolveModuleName(
        specifier,
        absolute,
        { ...compilerOptions, allowJs: true, resolveJsonModule: true },
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      assert(
        resolved,
        `Unresolved harness import: ${relative} -> ${specifier}`,
      );
      const target = await realpath(resolved);
      assert(target.startsWith(`${root}/`));
      if (!target.includes('/node_modules/'))
        await visit(path.relative(root, target));
    }
  }
  for (const file of [
    DRIVER,
    `${TEST_ROOT}performance/browser-profiles-production-headless-bootstrap.cjs`,
    `${TEST_ROOT}performance/compare.mjs`,
    `${TEST_ROOT}electron/mock-server/start.mjs`,
    `${TEST_ROOT}performance/process-tree-supervisor.mjs`,
    'demo-apps/seed-canopy-data.mjs',
  ])
    await visit(file);
  return files;
}

export async function assertMatchedBuildInputs(roots) {
  // Keep the closed study's input inventory: later cache helpers do not exist
  // at its pinned baseline. Required historical inputs must still match exactly.
  for (const file of [
    'scripts/build-e2e.mjs',
    'scripts/lib/e2e-build-cache.mjs',
    'scripts/run-guarded-dev-script.mjs',
    'scripts/lib/dev-script-safety.mjs',
    'tsconfig.json',
    'tsconfig.base.json',
  ])
    equal(
      await hashFile(path.join(roots.baseline, file)),
      await hashFile(path.join(roots.candidate, file)),
      `Build/guard config differs: ${file}`,
    );
}

export function comparableBuildConfig(source) {
  return source
    .replace(
      "const browserProfileInventoryWorkerEntry = resolve(\n  repoRoot,\n  'apps/desktop-app/src/main/browser/inventory-worker.ts',\n);\n\n",
      '',
    )
    .replace(
      '      this.addWatchFile(browserProfileInventoryWorkerEntry);\n',
      '',
    )
    .replace(
      "          {\n            entry: browserProfileInventoryWorkerEntry,\n            outfile: 'browser-profile-inventory-worker.js',\n          },\n",
      '',
    );
}
let manifestDeadline = Infinity;
async function hashFileUntil(
  file,
  deadline,
  message = 'Hash deadline exhausted',
  now = Date.now,
) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    assert(now() < deadline, message);
    hash.update(chunk);
  }
  return hash.digest('hex');
}
async function hashFile(file) {
  return hashFileUntil(file, manifestDeadline, 'Manifest deadline exhausted');
}
async function manifest(root, relative = '', checkRoot = root) {
  const result = {};
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    assert(
      Date.now() < manifestDeadline,
      'Manifest traversal deadline exhausted',
    );
    const name = path.join(relative, entry.name),
      absolute = path.join(root, name);
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(absolute);
      assert(
        resolved.startsWith(`${checkRoot}/`),
        `Symlink escapes checkout: ${absolute}`,
      );
      result[name] = {
        symlink: await readlink(absolute),
        resolved: path.relative(checkRoot, resolved),
      };
    } else if (entry.isDirectory())
      Object.assign(result, await manifest(root, name, checkRoot));
    else if (entry.isFile()) result[name] = await hashFile(absolute);
  }
  return result;
}
/** Only the observed node-pty 1.1.0 node-gyp bookkeeping fields may vary by checkout. */
function normalizeNodePtyBookkeeping(file, source, root) {
  if (file === 'node_modules/node-pty/build/config.gypi') {
    const line = `    "local_prefix": ${JSON.stringify(root)},`;
    return source
      .split('\n')
      .map((value) =>
        value === line ? '    "local_prefix": "<CHECKOUT>",' : value,
      )
      .join('\n');
  }
  if (file !== 'node_modules/node-pty/build/Makefile') return source;
  return source
    .split('\n')
    .map((line) => {
      if (!line.startsWith('cmd_regen_makefile = ')) return line;
      // Do not replace arbitrary paths, other variables, includes, recipes or file content.
      const locations = [
        [
          `; ${root}/node_modules/node-gyp/gyp/gyp_main.py `,
          '; <CHECKOUT>/node_modules/node-gyp/gyp/gyp_main.py ',
        ],
        [
          `"-Dnode_gyp_dir=${root}/node_modules/node-gyp"`,
          '"-Dnode_gyp_dir=<CHECKOUT>/node_modules/node-gyp"',
        ],
        [
          `"-Dmodule_root_dir=${root}/node_modules/node-pty"`,
          '"-Dmodule_root_dir=<CHECKOUT>/node_modules/node-pty"',
        ],
        [
          ` -I${root}/node_modules/node-pty/build/config.gypi `,
          ' -I<CHECKOUT>/node_modules/node-pty/build/config.gypi ',
        ],
        [
          ` -I${root}/node_modules/node-gyp/addon.gypi`,
          ' -I<CHECKOUT>/node_modules/node-gyp/addon.gypi',
        ],
      ];
      for (const [from, to] of locations) {
        // The final include may be followed by another token or end-of-line only.
        const index = line.indexOf(from);
        if (
          index >= 0 &&
          (from.endsWith(' ') ||
            from.endsWith('"') ||
            [' ', undefined].includes(line[index + from.length]))
        )
          line = line.replace(from, to);
      }
      return line;
    })
    .join('\n');
}
/** pnpm checkouts carry pnpm-lock.yaml; older (npm) checkouts package-lock.json. */
export async function stagePackageManager(root) {
  try {
    await lstat(path.join(root, 'pnpm-lock.yaml'));
    return {
      lockfile: 'pnpm-lock.yaml',
      executable: 'pnpm',
      install: ['install', '--frozen-lockfile'],
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {
      lockfile: 'package-lock.json',
      executable: 'npm',
      install: ['ci', '--no-audit', '--no-fund'],
    };
  }
}
// pnpm's own install bookkeeping (timestamps, absolute paths), not dependencies.
const PNPM_BOOKKEEPING = new Set([
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.pnpm-task-run-state-v1',
]);
export async function dependencyManifest(root) {
  root = await realpath(root);
  const readJson = async (file) =>
    JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const packageJson = await readJson('package.json');
  const pnpm = (await stagePackageManager(root)).lockfile === 'pnpm-lock.yaml';
  // A pnpm lockfile has no install-path map; workspace links are checked below.
  const lock = pnpm ? null : await readJson('package-lock.json');
  const workspaces = pnpm
    ? (await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'))
        .split('\n')
        .map((line) => line.match(/^ {2}- (\S+)$/)?.[1])
        .filter(Boolean)
    : packageJson.workspaces;
  assert(
    Array.isArray(workspaces) && workspaces.length > 0,
    'Explicit canonical workspace list required',
  );
  if (lock)
    equal(
      workspaces,
      lock.packages?.['']?.workspaces,
      'Lockfile workspace list differs',
    );
  const locations = ['node_modules'];
  for (const workspace of workspaces) {
    assert(
      typeof workspace === 'string' &&
        /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+$/.test(workspace) &&
        !workspace
          .split('/')
          .some(
            (part) => part === '..' || part === '.' || part === 'node_modules',
          ),
      'Only explicit contained workspace paths are supported',
    );
    if (lock)
      assert(
        lock.packages[workspace] && !lock.packages[workspace].link,
        `Workspace absent from canonical lock: ${workspace}`,
      );
    assert.equal(
      await realpath(path.join(root, workspace)),
      path.join(root, workspace),
      'Workspace directory symlinks are not supported',
    );
    locations.push(`${workspace}/node_modules`);
  }
  for (const file of Object.keys(lock?.packages ?? {})) {
    if (!file.includes('node_modules/')) continue;
    assert(
      locations.some((location) => file.startsWith(`${location}/`)),
      `Lockfile dependency escapes canonical workspaces: ${file}`,
    );
  }
  const raw = {},
    links = [];
  async function walk(relative) {
    assert(
      Date.now() < manifestDeadline,
      'Dependency traversal deadline exhausted',
    );
    if (PNPM_BOOKKEEPING.has(relative)) return;
    const absolute = path.join(root, relative),
      info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(absolute);
      assert(
        resolved.startsWith(`${root}/`),
        `Dependency symlink escapes checkout: ${relative}`,
      );
      const target = path.relative(root, resolved),
        targetInfo = await lstat(resolved);
      raw[relative] = { symlink: await readlink(absolute), resolved: target };
      if (targetInfo.isFile())
        raw[relative].targetSha256 = await hashFile(resolved);
      else {
        assert(
          targetInfo.isDirectory(),
          'Unsupported dependency symlink target',
        );
        links.push({ relative, target });
      }
    } else if (info.isDirectory()) {
      raw[relative] = { directory: true };
      for (const entry of await readdir(absolute))
        await walk(path.join(relative, entry));
    } else {
      assert(info.isFile(), `Unsupported dependency entry: ${relative}`);
      raw[relative] = await hashFile(absolute);
    }
  }
  for (const location of locations) {
    try {
      assert.equal(
        await realpath(path.join(root, location)),
        path.join(root, location),
        'Dependency roots must be independent physical directories',
      );
      await walk(location);
    } catch (error) {
      // Only absence of the root is permitted; a broken descendant link is a failure.
      if (error.code !== 'ENOENT' || location === 'node_modules') throw error;
      await assert.rejects(lstat(path.join(root, location)), {
        code: 'ENOENT',
      });
      raw[location] = { absent: true };
    }
  }
  for (const { relative, target } of links) {
    const entry = lock?.packages[relative];
    assert(
      raw[target]?.directory ||
        (workspaces.includes(target) &&
          (pnpm || (entry?.link === true && entry.resolved === target))),
      `Unattested dependency directory link: ${relative} -> ${target}`,
    );
  }
  const comparable = structuredClone(raw),
    normalizations = [];
  for (const file of [
    'node_modules/node-pty/build/Makefile',
    'node_modules/node-pty/build/config.gypi',
  ]) {
    if (typeof raw[file] !== 'string') continue;
    const original = await readFile(path.join(root, file), 'utf8');
    assert.equal(
      digest(original),
      raw[file],
      'Bookkeeping changed while sealing manifest',
    );
    const normalized = normalizeNodePtyBookkeeping(file, original, root);
    if (normalized === original) continue;
    if (lock)
      assert.equal(
        lock.packages['node_modules/node-pty']?.version,
        '1.1.0',
        'Unreviewed locked node-pty bookkeeping version',
      );
    assert.equal(
      (await readJson('node_modules/node-pty/package.json')).version,
      '1.1.0',
      'Unreviewed installed node-pty bookkeeping version',
    );
    comparable[file] = digest(normalized);
    normalizations.push({
      file,
      originalSha256: raw[file],
      comparableSha256: comparable[file],
      rationale:
        'Only the observed node-pty 1.1.0 node-gyp regeneration command checkout paths or config.gypi local_prefix field; all other bytes remain strict',
      original,
      normalized,
    });
  }
  return { raw, comparable, normalizations };
}
export function compareDependencyManifests(before, after) {
  const keys = [
    ...new Set([...Object.keys(before.raw), ...Object.keys(after.raw)]),
  ].sort();
  const rawDifferences = keys
    .filter((key) => canonical(before.raw[key]) !== canonical(after.raw[key]))
    .map((file) => ({
      file,
      before: before.raw[file] ?? null,
      after: after.raw[file] ?? null,
    }));
  const mismatches = [
    ...new Set([
      ...Object.keys(before.comparable),
      ...Object.keys(after.comparable),
    ]),
  ]
    .sort()
    .filter(
      (key) =>
        canonical(before.comparable[key]) !== canonical(after.comparable[key]),
    );
  return { passed: mismatches.length === 0, mismatches, rawDifferences };
}
async function sourceManifest(root) {
  const result = {};
  for (const name of git(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
    .split('\0')
    .filter(Boolean)
    .sort()) {
    const file = path.join(root, name),
      info = await lstat(file);
    result[name] = info.isSymbolicLink()
      ? { symlink: await readlink(file) }
      : await hashFile(file);
  }
  return result;
}
function attestHost() {
  requireHostedMac();
  assert.equal(process.version, 'v24.22.1');
  assert.equal(os.userInfo().username, 'runner');
  assert(process.env.GITHUB_WORKSPACE.startsWith('/Users/runner/work/'));
  assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? ''));
  let pid = process.ppid,
    worker = false;
  for (let depth = 0; pid > 1 && depth < 20; depth++) {
    const row = execFileSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'ppid=,comm='],
      { encoding: 'utf8', timeout: 30_000 },
    )
      .trim()
      .match(/^(\d+)\s+(.+)$/);
    assert(row, 'Cannot attest real runner ancestry');
    worker ||= path.basename(row[2]) === 'Runner.Worker';
    pid = Number(row[1]);
  }
  assert(
    worker,
    'Real Runner.Worker ancestry required; env spoofing is unsupported',
  );
}
export function parseE2EOptions(args = process.argv.slice(2)) {
  const { values, tokens } = parseArgs({
    tokens: true,
    args,
    options: {
      execution: { type: 'string', default: 'hosted' },
      protocol: { type: 'string', default: 'full' },
      'window-mode': { type: 'string', default: 'headless' },
      workspace: { type: 'string' },
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      output: { type: 'string' },
      'candidate-commit': { type: 'string' },
    },
  });
  assert(values.baseline && values.candidate && values.output);
  assert(
    tokens.filter(
      (token) => token.kind === 'option' && token.name === 'window-mode',
    ).length <= 1,
    'Study window mode must be specified once',
  );
  assert.equal(
    values['window-mode'],
    'headless',
    'Only headless study mode is supported',
  );
  assert(
    ['hosted', 'local-physical'].includes(values.execution),
    'Unsupported execution',
  );
  assert(
    ['full', 'qualification'].includes(values.protocol),
    'Unsupported protocol',
  );
  if (values.execution === 'local-physical') {
    assert.equal(
      values.protocol,
      'full',
      'Local E2E requires the full protocol',
    );
    assert(values.workspace, 'Local workspace required');
    assert(
      /^[a-f0-9]{40}$/.test(values['candidate-commit'] ?? ''),
      'Candidate commit must be an exact full SHA',
    );
  } else
    assert(
      !values.workspace && !values['candidate-commit'],
      'Local-only identity options',
    );
  return values;
}

export function e2eChildEnvironment(execution, source = process.env) {
  assert(['hosted', 'local-physical'].includes(execution));
  const env = {
    ...Object.fromEntries(
      [
        'PATH',
        'HOME',
        'TMPDIR',
        'USER',
        'SHELL',
        'RUNNER_TEMP',
        'RUNNER_OS',
        'RUNNER_ENVIRONMENT',
        'GITHUB_WORKSPACE',
        'GITHUB_RUN_ID',
        'GITHUB_RUN_ATTEMPT',
        'ImageOS',
        'ImageVersion',
      ]
        .filter(
          (key) =>
            source[key] !== undefined &&
            (execution === 'hosted' ||
              !/^(?:RUNNER_|GITHUB_|ImageOS$|ImageVersion$)/.test(key)),
        )
        .map((key) => [key, source[key]]),
    ),
    ...SETTINGS,
  };
  if (execution === 'local-physical') {
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}`;
  }
  return env;
}

const localE2EOwners = new WeakSet();
export async function withLocalE2ELease(
  operation,
  { env = process.env, signal, acquire = applyDevScriptSafetyWithWait } = {},
) {
  const safety = await acquire({ suite: 'e2e', env, signal });
  const owner = { memory: safety.memory, lease: safety.lease?.metadata };
  try {
    assert(
      !safety.ciBypass && !safety.memory.skipped && safety.lease,
      'Local E2E requires the actual normal e2e lease',
    );
    signal?.throwIfAborted();
    localE2EOwners.add(owner);
    return await operation(owner);
  } finally {
    localE2EOwners.delete(owner);
    await safety.lease?.release();
  }
}

export function e2eCommand(execution, kind, tail = [], owner) {
  assert(['hosted', 'local-physical'].includes(execution));
  const local = execution === 'local-physical';
  if (local)
    assert(
      localE2EOwners.has(owner),
      'Local child requires controller-owned active lease',
    );
  const guard = [
    'scripts/run-guarded-dev-script.mjs',
    '--suite',
    'performance',
    '--',
  ];
  if (kind === 'build')
    return local
      ? {
          executable: 'pnpm',
          args: ['run', 'build:e2e', '--performance-sourcemaps'],
        }
      : {
          executable: process.execPath,
          args: [
            ...guard,
            'pnpm',
            'run',
            'build:e2e',
            '--performance-sourcemaps',
          ],
        };
  if (kind === 'ui')
    return local
      ? {
          executable: process.execPath,
          args: [
            'node_modules/@playwright/test/cli.js',
            'test',
            '--config',
            LOCAL_RUNNER_CONFIG,
            ...tail,
          ],
        }
      : {
          executable: 'pnpm',
          args: ['run', 'test:electron:built', ...tail],
        };
  assert.equal(kind, 'driver');
  return {
    executable: process.execPath,
    args: [
      ...(local ? [] : [...guard, process.execPath]),
      '--import',
      'tsx',
      DRIVER,
      ...tail,
    ],
  };
}

export const LOCAL_RUNNER_CONFIG =
  'playwright.local-browser-profiles.config.mjs';
const LOCAL_RUNNER_BYTES = `import config from './playwright.config.mjs';
export default { ...config, webServer: { ...config.webServer, reuseExistingServer: false } };
`;
export async function withLocalRunnerConfig(root, evidence, operation) {
  const file = path.join(root, LOCAL_RUNNER_CONFIG);
  const original = await hashFile(path.join(root, 'playwright.config.mjs'));
  Object.assign(evidence, {
    file: LOCAL_RUNNER_CONFIG,
    bytes: LOCAL_RUNNER_BYTES,
    sha256: digest(LOCAL_RUNNER_BYTES),
    originalConfigSha256: original,
    permittedSourceDelta: {
      added: [LOCAL_RUNNER_CONFIG],
      removed: [LOCAL_RUNNER_CONFIG],
    },
    status: 'creating',
  });
  await writeFile(file, LOCAL_RUNNER_BYTES, { flag: 'wx' });
  evidence.status = 'created';
  try {
    return await operation();
  } finally {
    assert.equal(
      await hashFile(path.join(root, 'playwright.config.mjs')),
      original,
      'Original runner config changed',
    );
    assert.equal(
      await hashFile(file),
      evidence.sha256,
      'Owned adapter changed; refuse unowned removal',
    );
    await unlink(file);
    evidence.status = 'removed';
  }
}

export async function assertMockEndpointUnserved(port = 4011) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once('connect', () =>
      finish(
        new Error(
          'Fixed mock endpoint already served; refusing foreign listener',
        ),
      ),
    );
    socket.once('error', (error) =>
      finish(error.code === 'ECONNREFUSED' ? null : error),
    );
    socket.setTimeout(2000, () =>
      finish(new Error('Mock endpoint precheck timed out')),
    );
  });
}

export function assertMockStartupOwnership(
  log,
  command,
  endpoint = 'http://127.0.0.1:4011',
) {
  const text = stripVTControlCharacters(log);
  const startup = text.indexOf(`[mock-server] listening on ${endpoint}`);
  const tests = text.search(/Running 4 tests? using 1 worker/);
  assert(
    startup >= 0 && tests > startup,
    'Missing owned mock-server startup output before reviewed observation-overlay baseline native test execution',
  );
  assert(
    !/EADDRINUSE|already used|already in use/i.test(text),
    'Mock listener ownership race',
  );
  assert(
    command.mockStartup && command.mockCleanup?.groupsGone,
    'Missing observed owned mock process identity/cleanup',
  );
  assert(
    command.cleanup?.groupGone &&
      !command.error &&
      !command.timedOut &&
      !command.interrupted,
    'Owned mock command cleanup incomplete',
  );
  return {
    startupBeforeTests: true,
    startupOffset: startup,
    testExecutionOffset: tests,
    commandProcessGroupId: command.cleanup.processGroupId,
    commandGroupGone: true,
  };
}

const PROCESS_SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024;

const processSnapshot = (timeoutMs = 30_000) =>
  execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: PROCESS_SNAPSHOT_MAX_BUFFER,
  });
function processRows(snapshot) {
  return snapshot.split('\n').flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/,
    );
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            started: match[4],
            command: match[5],
          },
        ]
      : [];
  });
}
export function observeOwnedMockServer(leaderPid, snapshot) {
  const rows = processRows(snapshot),
    descendants = new Set([leaderPid]);
  let added;
  do {
    added = false;
    for (const row of rows)
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        added = true;
      }
  } while (added);
  const owned = rows.filter((row) => descendants.has(row.pid));
  assert(
    owned.some(
      (row) =>
        /(?:^|\/)apps\/desktop-app\/tests\/electron\/mock-server\/start\.mjs(?:\s|$)/.test(
          row.command,
        ) ||
        /(?:^|\s)apps\/desktop-app\/tests\/electron\/mock-server\/start\.mjs(?:\s|$)/.test(
          row.command,
        ),
    ),
    'Startup output has no live mock-server descendant of the owned command',
  );
  const groups = [...new Set(owned.map((row) => row.pgid))];
  assert(
    groups.every((id) => descendants.has(id)),
    'Mock process group has an unowned leader',
  );
  return { leaderPid, processes: owned, groups };
}
export function assertObservedMockGroupsGone(observation, snapshot) {
  const rows = processRows(snapshot);
  assert(
    !rows.some((row) => observation.groups.includes(row.pgid)),
    'Observed owned mock process group remains',
  );
  return {
    groupIds: observation.groups,
    groupsGone: true,
    observedAt: new Date().toISOString(),
  };
}

export function observeMockCommandOutput(
  logFd,
  record,
  controller,
  endpoint = 'http://127.0.0.1:4011',
) {
  let startupText = '';
  return (child) => {
    const receive = (chunk) => {
      try {
        writeSync(logFd, chunk);
        if (record.mockStartup || record.mockObservationError) return;
        startupText = (
          startupText + stripVTControlCharacters(chunk.toString())
        ).slice(-16384);
        if (!startupText.includes(`[mock-server] listening on ${endpoint}`))
          return;
        record.mockStartup = observeOwnedMockServer(
          child.pid,
          processSnapshot(),
        );
      } catch (error) {
        record.mockObservationError = String(error);
        controller.abort(error);
      }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
  };
}
/** An existing original member anchors a still-owned PGID, even if its leader
 * exited. Reparenting is expected after runner failure; PID, PGID, start time
 * and command must still match. A reused group with no live anchor is foreign.
 */
export function verifiedMockCleanupGroups(observation, snapshot) {
  const rows = processRows(snapshot);
  return observation.groups.flatMap((group) => {
    const live = rows.filter((row) => row.pgid === group);
    if (!live.length) return [];
    const originals = observation.processes.filter((row) => row.pgid === group);
    for (const original of originals) {
      const current = live.find((row) => row.pid === original.pid);
      if (current)
        assert(
          current.started === original.started &&
            current.command === original.command,
          `Owned mock identity changed; refusing group ${group}`,
        );
    }
    const anchor = live.find((row) =>
      originals.some(
        (original) =>
          row.pid === original.pid &&
          row.started === original.started &&
          row.command === original.command,
      ),
    );
    assert(anchor, `No live original mock identity; refusing group ${group}`);
    return [{ group, anchor }];
  });
}

export async function completeMockCommandCleanup(record, deadline) {
  if (!record.mockStartup) return;
  const startedAt = Date.now();
  // Preserve the prior ten-second local cleanup cap, including fresh identity
  // snapshots and post-KILL disappearance/reaping. Reserve half for escalation.
  const cleanupDeadline = Math.min(startedAt + 10_000, deadline);
  const termDeadline = startedAt + Math.max(0, cleanupDeadline - startedAt) / 2;
  const cleanup = { maximumMs: 10_000, actions: [] };
  record.mockCleanup = cleanup;
  const snapshot = () => {
    assert(
      Date.now() < cleanupDeadline,
      'Owned mock cleanup deadline exhausted',
    );
    return processSnapshot(
      Math.max(1, Math.min(30_000, cleanupDeadline - Date.now())),
    );
  };
  const signalOwned = (signal) => {
    for (const group of record.mockStartup.groups) {
      const targets = verifiedMockCleanupGroups(
        { ...record.mockStartup, groups: [group] },
        snapshot(),
      );
      for (const target of targets) {
        assert(
          Date.now() < cleanupDeadline,
          'Owned mock cleanup deadline exhausted before signal',
        );
        const action = { ...target, signal, at: new Date().toISOString() };
        cleanup.actions.push(action);
        try {
          process.kill(-target.group, signal);
          action.sent = true;
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
          action.alreadyGone = true;
        }
      }
    }
  };
  const waitGone = async (until) => {
    for (;;) {
      const current = snapshot();
      if (
        !processRows(current).some((row) =>
          record.mockStartup.groups.includes(row.pgid),
        )
      ) {
        Object.assign(
          cleanup,
          assertObservedMockGroupsGone(record.mockStartup, current),
        );
        return true;
      }
      if (Date.now() >= until) return false;
      await delay(Math.min(100, Math.max(1, until - Date.now())));
    }
  };
  try {
    signalOwned('SIGTERM');
    if (!(await waitGone(termDeadline))) {
      signalOwned('SIGKILL');
      assert(
        await waitGone(cleanupDeadline),
        'Observed owned mock process group remains after escalation',
      );
    }
  } catch (error) {
    record.mockCleanupError = String(error);
  } finally {
    cleanup.durationMs = Date.now() - startedAt;
  }
}

export async function withE2EInterruption(operation) {
  const controller = new AbortController();
  const interrupt = (name) => {
    process.exitCode = 1;
    controller.abort(new Error(`E2E study interrupted by ${name}`));
  };
  const terminate = () => interrupt('SIGTERM'),
    cancel = () => interrupt('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', cancel);
  try {
    return await operation(controller);
  } finally {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', cancel);
  }
}

export async function prepareE2EPaths(
  values,
  hostedWorkspace = process.env.GITHUB_WORKSPACE,
) {
  if (values.execution === 'local-physical') return prepareReleasePaths(values);
  const workspace = await realpath(hostedWorkspace);
  const roots = {
    baseline: await realpath(values.baseline),
    candidate: await realpath(values.candidate),
  };
  const output = path.resolve(values.output);
  for (const root of Object.values(roots))
    assert(
      root.startsWith(`${workspace}/`) &&
        !output.startsWith(`${root}/`) &&
        output !== root,
    );
  assert(
    roots.baseline !== roots.candidate &&
      !roots.baseline.startsWith(`${roots.candidate}/`) &&
      !roots.candidate.startsWith(`${roots.baseline}/`),
  );
  assert.equal(
    await realpath(path.dirname(output)),
    workspace,
    'Output must be a new workspace child',
  );
  await mkdir(output); // No reuse, even for an unsuccessful previous population.
  return { roots, output, workspace };
}

async function main() {
  const values = parseE2EOptions();
  const executionStartedAt = Date.now();
  const local = values.execution === 'local-physical';
  const terminalDeadline =
    executionStartedAt +
    (values.protocol === 'qualification' ? 60 : 180) * 60_000;
  await withE2EInterruption(async (controller) => {
    const timer = local
      ? setTimeout(
          () => controller.abort(new Error('E2E work deadline exhausted')),
          Math.max(1, terminalDeadline - 5 * 60_000 - Date.now()),
        )
      : null;
    try {
      if (local) {
        requireLocalPhysicalMac();
        await withLocalE2ELease(
          (owner) =>
            executeStudy(
              values,
              executionStartedAt,
              terminalDeadline,
              controller,
              owner,
            ),
          { signal: controller.signal },
        );
      } else {
        attestHost();
        await executeStudy(
          values,
          executionStartedAt,
          terminalDeadline,
          controller,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  });
}

async function executeStudy(
  values,
  executionStartedAt,
  terminalDeadline,
  controller,
  owner,
) {
  const local = values.execution === 'local-physical';
  const qualification = values.protocol === 'qualification';
  const deadline = local ? terminalDeadline - 5 * 60_000 : terminalDeadline;
  manifestDeadline = deadline;
  controller.signal.throwIfAborted();
  const { roots, output } = await prepareE2EPaths(values);
  const candidateCommit = local
    ? values['candidate-commit']
    : process.env.GITHUB_SHA;
  const saveJson = (name, value, immutable = false) =>
    writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, {
      flag: immutable ? 'wx' : 'w',
    });
  const env = e2eChildEnvironment(values.execution);
  const batch = {
    execution: values.execution,
    ...(local
      ? {
          safetyAdmission: owner,
          candidateCommit,
          control: { root: path.resolve('.') },
        }
      : {}),
    protocol: qualification
      ? 'deterministic-e2e-qualification-headless-v3'
      : 'deterministic-e2e-relative-five-headless-v3',
    studyWindowMode: STUDY_VIEWPORT_PRESET,
    studyViewportPreset: STUDY_VIEWPORT_PRESET,
    viewport: STUDY_VIEWPORT,
    windowVisible: false,
    maximumPrimaryInvocations: qualification ? 7 : 13,
    maximumScenarioExecutions: qualification ? 14 : 26,
    comparison: qualification
      ? 'not-applicable-to-qualification'
      : 'canonical-five-pair',
    releaseAcceptance: false,
    startedAt: new Date().toISOString(),
    deadline: new Date(terminalDeadline).toISOString(),
    workDeadline: new Date(deadline).toISOString(),
    host: {
      machine: digest(os.hostname()),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model,
      memory: os.totalmem(),
      node: process.version,
      image: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
    },
    ...(local
      ? {}
      : {
          run: {
            id: process.env.GITHUB_RUN_ID,
            attempt: process.env.GITHUB_RUN_ATTEMPT,
            sha: process.env.GITHUB_SHA,
          },
        }),
    settings: Object.fromEntries(
      Object.keys(SETTINGS)
        .filter((key) => key in env)
        .map((key) => [key, env[key]]),
    ),
    environmentHashes: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, digest(value)]),
    ),
    schedule: schedule(values.protocol),
    stages: {},
    commands: [],
    attempts: [],
    checks: [],
    comparisons: {},
    limitations: [
      ...(local
        ? [
            'Actual guarded admission is not proof of uninterrupted host exclusivity; foreign callers may allow multiple slots. Host load and process observations remain authoritative.',
            'Fresh local matched population; no hosted byte-equivalence or upload claim.',
          ]
        : []),
      'Hidden native 1400x900 workload timing; boundary observations do not establish uninterrupted native foreground responsiveness.',
      'Deterministic E2E-relative only; neither release-like evidence nor browser-profile production acceptance.',
      'The baseline four-case native UI prerequisite uses the exact frozen 50ad test source with only the reviewed d6d6 observation block temporarily installed; production, bundles, actions and case budgets are unchanged.',
      qualification
        ? 'Two retained qualification observations per stage plus warmups/smoke; no comparison or acceptance.'
        : 'Five independent samples and an excluded warmup per stage; no stable-release switch.',
      'Aggregate scenario details are the first raw run retained for schema compatibility; metrics alone are aggregated. All full raw runs remain authoritative.',
    ],
  };
  const save = () => saveJson('batch.json', batch);
  async function command(label, root, executable, args, minutes = 20) {
    assert(
      !controller.signal.aborted && deadline - Date.now() > 60_000,
      'Deadline/interruption: preserve incomplete population',
    );
    const log = await open(path.join(output, `${label}.log`), 'wx');
    const record = {
      label,
      root,
      executable,
      args,
      startedAt: new Date().toISOString(),
      loadBefore: os.loadavg(),
    };
    batch.commands.push(record);
    const observeMock = local && label === 'baseline-native-browser-ui';
    await save();
    try {
      Object.assign(
        record,
        await runCommandProcess({
          executable,
          args,
          cwd: root,
          env,
          stdio: observeMock
            ? ['ignore', 'pipe', 'pipe']
            : ['ignore', log.fd, log.fd],
          onSpawn: observeMock
            ? observeMockCommandOutput(log.fd, record, controller)
            : undefined,
          timeoutMs: Math.min(minutes * 60_000, deadline - Date.now() - 60_000),
          signal: controller.signal,
        }),
      );
    } finally {
      await completeMockCommandCleanup(record, deadline);
      await log.close();
      record.completedAt = new Date().toISOString();
      record.durationMs = Date.now() - Date.parse(record.startedAt);
      record.loadAfter = os.loadavg();
      await save();
    }
    assert(
      !record.mockObservationError &&
        !record.mockCleanupError &&
        !record.timedOut &&
        !record.interrupted &&
        !record.signal &&
        !record.error &&
        !record.descendantsAfterLeaderExit &&
        record.cleanup?.groupGone,
      `${label}: command or owned-group cleanup failed`,
    );
    return record;
  }
  function noLeftovers() {
    const lines = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 30_000,
    }).split('\n');
    assert(
      !lines.some((line) =>
        Object.values(roots).some(
          (root) =>
            line.includes(`${root}/node_modules/electron/`) ||
            line.includes(`${root}/${TEST_ROOT}electron/mock-server/start.mjs`),
        ),
      ),
      'Owned stage Electron/mock processes remain; stop without generic kills',
    );
  }
  const identities = {},
    rows = [],
    dependencyManifests = {},
    harnessHashes = {};
  let sealed;
  async function verify(label, dependencies = false) {
    const verificationStartedAt = Date.now();
    noLeftovers();
    assert(Date.now() < deadline && !controller.signal.aborted);
    for (const [stage, root] of Object.entries(roots)) {
      equal(
        await sourceManifest(root),
        sealed[stage],
        `${label}: source mutation`,
      );
      equal(
        await manifest(path.join(root, 'out-e2e')),
        batch.stages[stage].bundles,
        `${label}: bundle mutation`,
      );
      if (dependencies) {
        const dependencyStartedAt = Date.now();
        equal(
          await dependencyManifest(root),
          dependencyManifests[stage],
          `${label}: dependency mutation`,
        );
        batch.dependencyTraversals ??= [];
        batch.dependencyTraversals.push({
          label,
          stage,
          durationMs: Date.now() - dependencyStartedAt,
        });
      }
    }
    for (const [file, hash] of Object.entries(harnessHashes))
      for (const root of Object.values(roots))
        assert.equal(
          await hashFile(path.join(root, file)),
          hash,
          `${label}: harness/support mutation: ${file}`,
        );
    batch.checks.push({
      label,
      dependencies,
      durationMs: Date.now() - verificationStartedAt,
      at: new Date().toISOString(),
    });
    await save();
  }
  try {
    await save();
    if (local)
      Object.assign(batch.control, {
        commit: git('.', ['rev-parse', 'HEAD']).trim(),
        tree: git('.', ['rev-parse', 'HEAD^{tree}']).trim(),
        controllerSha256: await hashFile(fileURLToPath(import.meta.url)),
      });
    for (const [stage, root] of Object.entries(roots)) {
      assert.equal(
        git(root, ['status', '--porcelain']).trim(),
        '',
        'Pristine checkout required',
      );
      const commit = git(root, ['rev-parse', 'HEAD']).trim(),
        tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
      assertReleaseStageIdentity(stage, commit, tree, candidateCommit);
      const original = await sourceManifest(root);
      assert(
        !Object.keys(original).some((file) =>
          /(?:^|\/)\.env(?:\.(?:local|production|development|test)(?:\.local)?)?$/.test(
            file,
          ),
        ),
        'Runtime env files prohibited',
      );
      await saveJson(`${stage}-original-source.json`, original, true);
      batch.stages[stage] = {
        root,
        commit,
        tree,
        originalSourceHash: digest(canonical(original)),
      };
    }
    const json = async (root, name) =>
      JSON.parse(await readFile(path.join(root, name), 'utf8'));
    const managers = {
      baseline: await stagePackageManager(roots.baseline),
      candidate: await stagePackageManager(roots.candidate),
    };
    equal(
      managers.baseline.lockfile,
      managers.candidate.lockfile,
      'Lockfiles differ',
    );
    equal(
      await hashFile(path.join(roots.baseline, managers.baseline.lockfile)),
      await hashFile(path.join(roots.candidate, managers.candidate.lockfile)),
      'Lockfiles differ',
    );
    equal(
      comparablePackage(await json(roots.baseline, 'package.json')),
      comparablePackage(await json(roots.candidate, 'package.json')),
      'Build/package configuration differs',
    );
    await assertMatchedBuildInputs(roots);
    const buildConfigs = {};
    for (const [stage, root] of Object.entries(roots)) {
      buildConfigs[stage] = await readFile(
        path.join(root, 'apps/desktop-app/electron.vite.config.ts'),
        'utf8',
      );
      await writeFile(
        path.join(output, `${stage}-electron.vite.config.ts`),
        buildConfigs[stage],
        { flag: 'wx' },
      );
    }
    equal(
      comparableBuildConfig(buildConfigs.baseline),
      comparableBuildConfig(buildConfigs.candidate),
      'Build settings differ beyond the added profile inventory worker',
    );
    batch.buildConfiguration = {
      allowedDelta:
        'Candidate additionally emits its production browser-profile-inventory-worker; existing settings identical',
      baseline: digest(buildConfigs.baseline),
      candidate: digest(buildConfigs.candidate),
    };
    for (const [stage, root] of Object.entries(roots)) {
      await assert.rejects(lstat(path.join(root, 'out-e2e')), {
        code: 'ENOENT',
      });
      await assert.rejects(lstat(path.join(root, 'node_modules')), {
        code: 'ENOENT',
      });
      assert.equal(
        (
          await command(
            `${stage}-install`,
            root,
            managers[stage].executable,
            managers[stage].install,
            35,
          )
        ).code,
        0,
      );
      assert.equal(
        (
          await command(
            `${stage}-electron-install`,
            root,
            process.execPath,
            ['node_modules/electron/install.js'],
            10,
          )
        ).code,
        0,
      );
      const build = e2eCommand(values.execution, 'build', [], owner);
      assert.equal(
        (
          await command(
            `${stage}-build`,
            root,
            build.executable,
            build.args,
            35,
          )
        ).code,
        0,
      );
      const dependencyStartedAt = Date.now();
      const dependencies = await dependencyManifest(root);
      batch.dependencyTraversals ??= [];
      batch.dependencyTraversals.push({
        label: 'initial',
        stage,
        durationMs: Date.now() - dependencyStartedAt,
      });
      const bundles = await manifest(path.join(root, 'out-e2e'));
      assert(
        Object.keys(bundles).length > 10 &&
          Object.keys(bundles).some((name) => name.endsWith('.map')),
        'Missing E2E source-mapped bundle',
      );
      const req = createRequire(path.join(root, 'package.json'));
      identities[stage] = {
        commit: batch.stages[stage].commit,
        executable: await realpath(req('electron')),
        electronVersion: req('electron/package.json').version,
        bundleHash: digest(canonical(bundles)),
        dependencyHash: digest(canonical(dependencies)),
      };
      dependencyManifests[stage] = dependencies;
      Object.assign(batch.stages[stage], {
        dependencies: {
          manifest: `${stage}-dependencies.json`,
          sha256: digest(canonical(dependencies)),
          files: Object.keys(dependencies.raw).length,
        },
        bundles,
        identity: identities[stage],
      });
      await saveJson(`${stage}-dependencies.json`, dependencies, true);
      await saveJson(`${stage}-bundles.json`, bundles, true);
      await saveJson(
        `${stage}-post-build-source.json`,
        await sourceManifest(root),
        true,
      );
      assert.equal(
        (
          await command(`${stage}-archive`, root, 'tar', [
            '-czf',
            path.join(output, `${stage}-out-e2e.tar.gz`),
            '-C',
            root,
            'out-e2e',
          ])
        ).code,
        0,
      );
    }
    assert.notEqual(
      await realpath(path.join(roots.baseline, 'node_modules')),
      await realpath(path.join(roots.candidate, 'node_modules')),
    );
    const dependencyComparison = compareDependencyManifests(
      dependencyManifests.baseline,
      dependencyManifests.candidate,
    );
    await saveJson('dependency-comparison.json', dependencyComparison, true);
    assert.equal(
      dependencyComparison.passed,
      true,
      'Installed dependency trees differ',
    );
    noLeftovers();
    const nativeSourceBefore = {};
    for (const [stage, root] of Object.entries(roots))
      nativeSourceBefore[stage] = await sourceManifest(root);
    batch.nativeBaselineUiOverlay = {
      candidate: assertCandidateNativeUiObservation(
        await readFile(
          path.join(roots.candidate, BASELINE_NATIVE_UI_OVERLAY.path),
          'utf8',
        ),
      ),
    };
    const ui = e2eCommand(
      values.execution,
      'ui',
      ['browser-chrome.spec.mjs', '--reporter=line', '--retries=0'],
      owner,
    );
    const nativeUi = () =>
      command(
        'baseline-native-browser-ui',
        roots.baseline,
        ui.executable,
        ui.args,
        25,
      );
    await withBaselineNativeUiObservationOverlay(
      roots.baseline,
      output,
      batch.nativeBaselineUiOverlay,
      async () => {
        controller.signal.throwIfAborted();
        assert(
          Date.now() < deadline,
          'Deadline/interruption before baseline native UI gate',
        );
        const appliedSource = {
          ...nativeSourceBefore.baseline,
          [BASELINE_NATIVE_UI_OVERLAY.path]:
            BASELINE_NATIVE_UI_OVERLAY.installedSha256,
        };
        if (local) {
          await assertMockEndpointUnserved();
          batch.nativeRunnerConfig = { endpointPrecheck: 'unserved' };
          batch.nativeBaselineUi = await withLocalRunnerConfig(
            roots.baseline,
            batch.nativeRunnerConfig,
            async () => {
              equal(
                await sourceManifest(roots.baseline),
                {
                  ...appliedSource,
                  [LOCAL_RUNNER_CONFIG]: batch.nativeRunnerConfig.sha256,
                },
                'Unexpected composed UI overlay/runner adapter source delta',
              );
              await saveJson(
                'local-runner-config.json',
                batch.nativeRunnerConfig,
                true,
              );
              await writeFile(
                path.join(output, LOCAL_RUNNER_CONFIG),
                batch.nativeRunnerConfig.bytes,
                { flag: 'wx' },
              );
              const result = await nativeUi();
              batch.nativeRunnerConfig.ownership = assertMockStartupOwnership(
                await readFile(
                  path.join(output, 'baseline-native-browser-ui.log'),
                  'utf8',
                ),
                result,
              );
              noLeftovers();
              await assertMockEndpointUnserved();
              batch.nativeRunnerConfig.endpointAfterCleanup = 'unserved';
              return result;
            },
          );
        } else {
          equal(
            await sourceManifest(roots.baseline),
            appliedSource,
            'Unexpected baseline UI observation overlay source delta',
          );
          batch.nativeBaselineUi = await nativeUi();
        }
        batch.nativeBaselineUi.counts = nativeUiCounts(
          await readFile(
            path.join(output, 'baseline-native-browser-ui.log'),
            'utf8',
          ),
        );
        assert.equal(
          batch.nativeBaselineUi.code,
          0,
          'Baseline native browser assertions with reviewed observation overlay failed',
        );
        assert.deepEqual(
          batch.nativeBaselineUi.counts,
          { passed: 4, failed: 0, skipped: 0, flaky: 0 },
          'Baseline native UI observation-overlay counts incomplete',
        );
      },
      {
        workDeadline: deadline,
        cleanupDeadline: (cleanupStartedAt) =>
          local
            ? Math.min(terminalDeadline, cleanupStartedAt + 5 * 60_000)
            : cleanupStartedAt + 5 * 60_000,
      },
    );
    const postGateIdentities = {};
    for (const [stage, root] of Object.entries(roots)) {
      const source = await sourceManifest(root),
        bundles = await manifest(path.join(root, 'out-e2e')),
        dependencies = await dependencyManifest(root);
      equal(
        source,
        nativeSourceBefore[stage],
        `${stage}: source changed after baseline UI observation overlay removal`,
      );
      equal(
        bundles,
        batch.stages[stage].bundles,
        `${stage}: bundle changed during baseline UI gate`,
      );
      equal(
        dependencies,
        dependencyManifests[stage],
        `${stage}: dependency changed during baseline UI gate`,
      );
      postGateIdentities[stage] = {
        sourceSha256: digest(canonical(source)),
        bundleSha256: digest(canonical(bundles)),
        dependencySha256: digest(canonical(dependencies)),
      };
    }
    batch.nativeBaselineUiOverlay.postGateIdentities = postGateIdentities;
    batch.nativeBaselineUiOverlay.productionChanged = false;
    await writeFile(
      path.join(output, batch.nativeBaselineUiOverlay.artifacts.evidence),
      `${JSON.stringify(batch.nativeBaselineUiOverlay, null, 2)}\n`,
    );
    await save();
    // Resolve the executed harness closure, including spawned support entrypoints.
    const files = await harnessFiles(roots.candidate);
    const overlay = [];
    for (const file of [...files].sort()) {
      const after = await readFile(path.join(roots.candidate, file), 'utf8');
      const before = await readBaselineHarnessSource(
        roots.baseline,
        file,
        after,
      );
      const installed = matchedHarnessSource(file, before, after);
      for (const [stage, root] of Object.entries(roots)) {
        const backup = path.join(output, 'harness', stage, file);
        await mkdir(path.dirname(backup), { recursive: true });
        if (stage !== 'baseline' || before !== null)
          await copyFile(path.join(root, file), backup);
        else
          await writeFile(`${backup}.absent`, 'Absent from frozen baseline\n');
        if ((stage === 'baseline' ? before : after) !== installed) {
          assertAllowedHarnessOverlay(file);
          await writeFile(path.join(root, file), installed);
        }
        assert.equal(
          await hashFile(path.join(root, file)),
          digest(installed),
          `${stage}: installed helper identity differs: ${file}`,
        );
      }
      harnessHashes[file] = digest(installed);
      overlay.push({
        file,
        baselineOriginal: before === null ? null : digest(before),
        candidateOriginal: digest(after),
        installed: digest(installed),
        ...(file === `${TEST_ROOT}electron/panelHarness.mjs`
          ? {
              rationale:
                'Reviewed aad5ea6ac0 optional failure callback is excluded; original recovered baseline helper used by both benchmark stages',
            }
          : {}),
      });
    }
    for (const file of [
      'demo-apps/catalog.json',
      'demo-apps/archives/ts-pnpm-vite.zip',
    ])
      equal(
        await hashFile(path.join(roots.baseline, file)),
        await hashFile(path.join(roots.candidate, file)),
        'Spawned fixture differs',
      );
    await saveJson('harness-manifest.json', overlay, true);
    sealed = {};
    for (const [stage, root] of Object.entries(roots)) {
      await writeFile(
        path.join(output, `${stage}-harness-overlay.patch`),
        git(root, [
          'diff',
          '--binary',
          'HEAD',
          '--',
          TEST_ROOT,
          'demo-apps/lib/git.mjs',
          'scripts/lib/e2e-harness-measurement.mjs',
        ]),
        { flag: 'wx' },
      );
      sealed[stage] = await sourceManifest(root);
      await saveJson(`${stage}-sealed-source.json`, sealed[stage], true);
      identities[stage].harnessHash = digest(
        canonical(overlay.map(({ file, installed }) => ({ file, installed }))),
      );
    }
    await verify('before-population', true);
    batch.preparationMs = Date.now() - executionStartedAt;
    for (const [ordinal, plan] of batch.schedule.entries()) {
      await verify(`before-${ordinal}`);
      const name = `${String(ordinal).padStart(2, '0')}-${plan.stage}-${plan.phase}-${plan.pair}`,
        reportPath = path.join(output, `${name}.json`);
      const attempt = { ...plan, reportPath, status: 'running' };
      batch.attempts.push(attempt);
      await save();
      const driver = e2eCommand(
        values.execution,
        'driver',
        [
          '--profile',
          plan.profile,
          '--scenarios',
          'browser-panels',
          '--headless',
          '--study-window-mode',
          values['window-mode'],
          ...(plan.diagnose ? ['--diagnose'] : []),
          '--output',
          reportPath,
        ],
        owner,
      );
      const result = await command(
        name,
        roots[plan.stage],
        driver.executable,
        driver.args,
      );
      attempt.code = result.code;
      try {
        const raw = JSON.parse(await readFile(reportPath, 'utf8'));
        attempt.primary = {
          status: raw.scenarios?.[0]?.status,
          error: raw.scenarios?.[0]?.error,
          violations: raw.scenarios?.[0]?.responsiveness?.violations,
        };
        attempt.diagnostics = {
          captureStatus: raw.scenarios?.[0]?.diagnostics?.status ?? 'not-run',
          replayStatus:
            raw.scenarios?.[0]?.diagnostics?.replay?.status ?? 'not-run',
          violations:
            raw.scenarios?.[0]?.diagnostics?.replay?.responsiveness?.violations,
        };
        validateRun(raw, attempt, identities[plan.stage]);
        attempt.status = 'ok';
        rows.push({ attempt, raw, identity: identities[plan.stage] });
      } catch (error) {
        attempt.status = 'failed';
        attempt.error = error.stack ?? String(error);
      }
      await verify(`after-${ordinal}`);
      await save();
      process.stdout.write(`${name}: ${attempt.status}\n`);
    }
    await verify('after-population', true);
    for (const statistic of qualification ? [] : ['median', 'p95']) {
      try {
        const before = aggregatePopulation(
            rows.filter(
              (row) =>
                row.attempt.phase === 'measured' &&
                row.attempt.stage === 'baseline',
            ),
            statistic,
          ),
          after = aggregatePopulation(
            rows.filter(
              (row) =>
                row.attempt.phase === 'measured' &&
                row.attempt.stage === 'candidate',
            ),
            statistic,
          );
        assertMatchedPopulations(before, after);
        const beforePath = path.join(output, `baseline-${statistic}.json`),
          afterPath = path.join(output, `candidate-${statistic}.json`);
        await saveJson(`baseline-${statistic}.json`, before, true);
        await saveJson(`candidate-${statistic}.json`, after, true);
        const comparison = comparePerformanceResults(before, after, THRESHOLDS);
        batch.comparisons[statistic] = comparison;
        await saveJson(`comparison-${statistic}.json`, comparison, true);
        const cli = await command(
          `compare-${statistic}`,
          roots.candidate,
          'pnpm',
          [
            'run',
            'perf:desktop:compare',
            beforePath,
            afterPath,
            '--max-regression-percent',
            '10',
            '--min-regression-ms',
            '20',
            '--no-diagnostics',
          ],
        );
        batch.comparisons[statistic].cliCode = cli.code;
        assert.equal(
          cli.code,
          comparison.passed ? 0 : 1,
          'CLI/library disagreement',
        );
      } catch (error) {
        const measured = batch.comparisons[statistic];
        batch.comparisons[statistic] = {
          ...(measured ?? { passed: false }),
          status: measured
            ? 'comparison-command-failed'
            : 'not-run-incomplete-population',
          error: error.stack ?? String(error),
        };
      }
    }
  } catch (error) {
    batch.fatalError = error.stack ?? String(error);
  } finally {
    const finalizationStartedAt = Date.now();
    manifestDeadline = local
      ? Math.min(terminalDeadline, finalizationStartedAt + 5 * 60_000)
      : finalizationStartedAt + 5 * 60_000;
    try {
      noLeftovers();
      batch.cleanup = 'no-stage-processes-observed';
    } catch (error) {
      batch.cleanup = String(error);
      batch.fatalError ??= batch.cleanup;
    }
    await persistE2EFinalization({
      batch,
      qualification,
      output,
      execution: values.execution,
      signal: controller.signal,
      finalizationStartedAt,
      finalizationDeadline: manifestDeadline,
    });
  }
}

export async function persistE2EFinalization(
  {
    batch,
    qualification,
    output,
    execution,
    signal,
    finalizationStartedAt,
    finalizationDeadline = finalizationStartedAt + 5 * 60_000,
  },
  {
    writeJson = (name, value) =>
      writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`),
  } = {},
) {
  manifestDeadline = finalizationDeadline;
  const check = () =>
    assert(
      Date.now() < finalizationDeadline,
      'E2E finalization deadline exhausted',
    );
  const saveJson = async (name, value) => {
    check();
    await writeJson(name, value);
    check();
  };
  const save = () => saveJson('batch.json', batch);
  const interruptedOnEntry = Boolean(signal?.aborted);
  const latch = () => {
    process.exitCode = 1;
    batch.interruption ??= {
      phase: interruptedOnEntry ? 'before-finalization' : 'finalization',
      at: new Date().toISOString(),
      reason: String(signal.reason ?? 'E2E interrupted'),
    };
    batch.fatalError ??= 'E2E study interrupted';
    batch.passed = false;
  };
  signal?.addEventListener('abort', latch, { once: true });
  if (interruptedOnEntry) latch();
  async function persist() {
    for (const attempt of batch.attempts)
      if (attempt.status === 'running') attempt.status = 'incomplete';
    batch.missingAttempts = batch.schedule.length - batch.attempts.length;
    batch.missingIds = batch.schedule.slice(batch.attempts.length);
    batch.counts = {
      expected: batch.schedule.length,
      observed: batch.attempts.length,
      failed: batch.attempts.filter((x) => x.status !== 'ok').length,
    };
    batch.passed =
      !batch.fatalError &&
      batch.nativeBaselineUi?.code === 0 &&
      batch.nativeBaselineUiOverlay?.restore?.status === 'restored' &&
      batch.nativeBaselineUiOverlay?.productionChanged === false &&
      batch.attempts.length === batch.schedule.length &&
      batch.attempts.every((attempt) => attempt.status === 'ok') &&
      (qualification ||
        ['median', 'p95'].every(
          (key) =>
            batch.comparisons[key]?.passed &&
            batch.comparisons[key]?.cliCode === 0,
        ));
    batch.completedAt = new Date().toISOString();
    await save();
    await writeFile(
      path.join(output, 'report.md'),
      `# Deterministic browser E2E gate\n\nStatus: **${batch.passed ? 'passed' : 'failed/incomplete'}**. Release acceptance: **false**.\n\n${batch.attempts.length}/${batch.schedule.length} runs attempted; ${batch.missingAttempts} missing. Baseline native UI exit code with the reviewed observation-only test overlay: ${batch.nativeBaselineUi?.code ?? 'not completed'}; actual counts: ${JSON.stringify(batch.nativeBaselineUi?.counts ?? 'unavailable')}; source restoration: ${batch.nativeBaselineUiOverlay?.restore?.status ?? 'not completed'}. Production remains unchanged: ${batch.nativeBaselineUiOverlay?.productionChanged === false}.\n\n${batch.attempts.map((entry) => `- ${entry.stage} ${entry.phase} ${entry.pair}: ${entry.status} (command exit ${entry.code ?? 'unavailable'}; primary ${entry.primary?.status ?? 'unavailable'}; capture ${entry.diagnostics?.captureStatus ?? 'not-run'}; replay ${entry.diagnostics?.replayStatus ?? 'not-run'})`).join('\n')}\n\nMedian comparison: ${qualification ? 'not-applicable-to-qualification' : (batch.comparisons.median?.status ?? batch.comparisons.median?.passed ?? 'not run / incomplete population')}; p95 comparison: ${qualification ? 'not-applicable-to-qualification' : (batch.comparisons.p95?.status ?? batch.comparisons.p95?.passed ?? 'not run / incomplete population')}.\n\nSee [full statuses/provenance](batch.json), every raw JSON/log, immutable manifests and bundle archives.\n\n${batch.limitations.join('\n\n')}\n`,
    );
    batch.outputFootprint = await outputFootprint(output, manifestDeadline);
    batch.finalization = {
      durationBeforeManifestMs: Date.now() - finalizationStartedAt,
      maximumMs: 300000,
      interrupted: Boolean(batch.interruption),
      uploadTiming:
        execution === 'local-physical'
          ? 'Local evidence only; no upload'
          : 'GitHub upload action and timing-step logs',
    };
    await save();
    const artifacts = await manifest(output);
    delete artifacts['artifact-manifest.json'];
    delete artifacts['finalization.json'];
    await saveJson('artifact-manifest.json', artifacts);
    await saveJson('finalization.json', {
      interrupted: Boolean(batch.interruption),
      durationMs: Date.now() - finalizationStartedAt,
      maximumMs: 300000,
      manifestExclusions: ['artifact-manifest.json', 'finalization.json'],
    });
    if (!batch.passed) process.exitCode = 1;
  }
  try {
    await persist();
    if (signal?.aborted && !interruptedOnEntry) await persist();
  } finally {
    signal?.removeEventListener('abort', latch);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
