#!/usr/bin/env -S node --import tsx
import { startHostMeasurement } from './host-measurement.mjs';
import { bundleIdentityRecord } from '../../../../scripts/lib/bundle-identity.mjs';
import {
  LOCAL_SMOKE_POLICY,
  formatSmokeAcceptance,
  smokeWorkloadCompleted,
  usesLocalSmokePolicy,
} from './smoke-acceptance.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diagnosticReplayError,
  diagnosticReplayOutcome,
  failedDiagnosticReplay,
} from './diagnostic-replay.mjs';
import { ensureMockServer, PERFORMANCE_MOCK_BASE_URL } from './mock-server.mjs';
import { frameAreaLines } from './monitor.mjs';
import {
  WORK_RATCHET_PROFILE,
  parsePerformanceArgs,
  performanceUsage,
} from './profiles.mjs';
import { quitSummaryLines } from './quit-latency.mjs';
import { finalizeResult, performanceRunSucceeded } from './results.mjs';
import { roundMetric } from './statistics.mjs';
import { formatScalingRatioLines } from './scaling-ratios.mjs';
import { failedPerformanceScenario } from './scenario-failure-diagnostics.mjs';
import { shouldRunPerformanceDiagnostics } from './scenario-status.mjs';
import {
  assertReleaseLikeCloudOrigin,
  runPerformanceScenario,
} from './scenarios.mjs';
import { pruneSmokeDiagnosticArtifacts } from './smoke-artifact-retention.mjs';
import { formatWorkRatchetVerdict, judgeWorkRatchet } from './work-ratchet.mjs';
import { w5StoreCaveats, w5StoreTreatment } from './w5-store-arms.mjs';

const configPathsModule =
  await import('../../../../packages/execution-engine/src/pipelines/config-paths.ts');
const { getBundledClaudeBinaryPath, getBundledCodexBinaryPath } =
  configPathsModule.default ?? configPathsModule;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');

function gitValueAt(rootPath, args, fallback = 'unknown') {
  try {
    return execFileSync('git', args, {
      cwd: rootPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

function gitValue(args, fallback = 'unknown') {
  return gitValueAt(repoRoot, args, fallback);
}

function defaultOutputPath(profile) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  return path.join(
    repoRoot,
    '.performance',
    'desktop',
    `${timestamp}-${profile}.json`,
  );
}

/**
 * `--e2e-root` launches another checkout's E2E bundle in that checkout, with
 * it as the working directory, as `--release-like-root` does for production
 * bundles (`measuredBuildRootOption` in `scenarios.mjs`).
 */
function selectE2eBuildRoot(options) {
  const root = path.resolve(repoRoot, options.e2eRoot);
  const outDirName = process.env.CANOPY_E2E_OUT_DIR ?? 'out-e2e';
  if (!existsSync(path.join(root, outDirName, 'main', 'index.js'))) {
    throw new Error(
      `--e2e-root ${root} has no ${outDirName}/main/index.js. Run \`npm run build:e2e -- --performance-sourcemaps\` in that checkout first.`,
    );
  }
  options.e2eRoot = root;
  return { root, workingDirectory: root };
}

/** The W5 store arm treatment of the E2E bundle under `root`. */
function w5StoreRunTreatment(arm, root) {
  const bundleEntry = path.join(
    root,
    process.env.CANOPY_E2E_OUT_DIR ?? 'out-e2e',
    'main',
    'index.js',
  );
  if (!existsSync(bundleEntry))
    throw new Error(
      `--w5-store needs the E2E bundle ${bundleEntry}. Run \`pnpm run build:e2e --performance-sourcemaps\` first.`,
    );
  return w5StoreTreatment(arm, { bundleEntry });
}

function assertChatPrerequisite(scenarios) {
  const chatScenarios = new Set([
    'chats',
    'mixed-provider-agent-concurrency',
    'managed-delegation-concurrency',
    'delegation-restart-cycles',
    'multi-chat-streaming',
    'multi-chat-streaming-sequential',
    'worktree-concurrency',
    'large-transcript-concurrency',
  ]);
  if (!scenarios.some((scenario) => chatScenarios.has(scenario))) return;
  const requiredProviders = scenarios.some(
    (scenario) =>
      scenario === 'mixed-provider-agent-concurrency' ||
      scenario === 'managed-delegation-concurrency' ||
      scenario === 'delegation-restart-cycles',
  )
    ? [
        {
          name: 'Claude',
          binaryPath: getBundledClaudeBinaryPath(),
          stageCommand: 'npm run stage:claude:host',
        },
        {
          name: 'Codex',
          binaryPath: getBundledCodexBinaryPath(),
          stageCommand: 'npm run stage:codex:host',
        },
      ]
    : [
        {
          name: 'Claude',
          binaryPath: getBundledClaudeBinaryPath(),
          stageCommand: 'npm run stage:claude:host',
        },
      ];
  for (const provider of requiredProviders) {
    if (existsSync(provider.binaryPath)) continue;
    throw new Error(
      `The selected live-chat scenario requires the staged ${provider.name} binary at ${provider.binaryPath}. Run ${provider.stageCommand} first.`,
    );
  }
}

function installedPackageVersion(packagePath, fallback) {
  try {
    return JSON.parse(readFileSync(packagePath, 'utf8')).version ?? fallback;
  } catch {
    return fallback;
  }
}

function environmentMetadata(packageJson, options) {
  const cpu = os.cpus()[0];
  return {
    appVersion: packageJson.version,
    electronVersion: installedPackageVersion(
      path.join(repoRoot, 'node_modules/electron/package.json'),
      packageJson.devDependencies?.electron ?? 'unknown',
    ),
    playwrightVersion: installedPackageVersion(
      path.join(repoRoot, 'node_modules/@playwright/test/package.json'),
      packageJson.devDependencies?.['@playwright/test'] ?? 'unknown',
    ),
    nodeVersion: process.version,
    platform: process.platform,
    osRelease: os.release(),
    architecture: process.arch,
    hostname: os.hostname(),
    cpuModel: cpu?.model ?? 'unknown',
    logicalCpuCount: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    viewport: options.viewport ?? { width: 1400, height: 900 },
    studyViewportPreset: options.studyViewportPreset,
    studyWindowMode: options.studyWindowMode,
    windowVisible: options.showWindow,
  };
}

function printRendererCrashLines(scenario) {
  for (const exit of scenario.rendererProcessGone ?? [])
    console.error(
      `[perf]   renderer exited: reason=${exit.reason ?? 'unknown'} exitCode=${exit.exitCode ?? 'unknown'}`,
    );
  const dumps = scenario.crashDumps;
  if (!dumps) return;
  console.error(
    dumps.retained
      ? `[perf]   crash dumps: ${dumps.files.length} retained in ${dumps.directory}${dumps.skippedFiles ? ` (${dumps.skippedFiles} over the size bound)` : ''}`
      : `[perf]   crash dumps: none retained (${dumps.reason ?? 'no dump written'})`,
  );
}

function printScenarioSummary(scenario) {
  if (scenario.status === 'error') {
    console.error(`[perf] ${scenario.name}: FAILED - ${scenario.error}`);
    printRendererCrashLines(scenario);
    return;
  }
  const response = scenario.monitoring?.summary;
  const statusLabel =
    scenario.status === 'unresponsive'
      ? 'UNRESPONSIVE, '
      : scenario.status === 'diagnostic'
        ? 'DIAGNOSTIC ONLY, '
        : '';
  console.log(
    `[perf] ${scenario.name}: ${statusLabel}${(scenario.durationMs / 1000).toFixed(1)}s, ` +
      `IPC p95 ${response?.ipcOuterMs?.p95?.toFixed(1) ?? 'n/a'}ms, ` +
      `timer-delay p99 ${response?.rendererIntervalDelayMs?.p99?.toFixed(1) ?? 'n/a'}ms, ` +
      `frame-delay max ${response?.rendererFrameDelayMs?.max?.toFixed(1) ?? 'n/a'}ms, ` +
      `key-handler p95 ${response?.rendererKeyEventHandlerMs?.p95?.toFixed(1) ?? 'n/a'}ms, ` +
      `key-to-paint p95 ${response?.rendererKeyToPaintConfirmationMs?.p95?.toFixed(1) ?? 'n/a'}ms, ` +
      `working-set max ${response?.totalWorkingSetMb?.max?.toFixed(1) ?? 'n/a'}MB`,
  );
  printRendererCrashLines(scenario);
  for (const line of frameAreaLines(scenario.frameBudgets)) console.log(line);
  for (const violation of scenario.responsiveness?.violations ?? []) {
    const unit = violation.unit === 'count' ? '' : (violation.unit ?? 'ms');
    console.error(
      `[perf]   ${violation.metric}: ${violation.value.toFixed(1)}${unit} > ${violation.budgetMs}${unit}`,
    );
  }
  const workErrors = scenario.work?.errors ?? [];
  for (const source of new Set(workErrors.map((error) => error.source))) {
    const errors = workErrors.filter((error) => error.source === source);
    console.error(
      `[perf]   work counters (${source}): ${errors.length} sampling error(s); first: ${errors[0].message}`,
    );
  }
  const journey = scenario.startupJourney?.timings;
  if (journey?.j1 || journey?.app_advisor) {
    const ms = (value) =>
      Number.isFinite(value) ? `${value.toFixed(0)}ms` : 'n/a';
    console.log(
      `[perf]   J1: main ready ${ms(journey.j1?.main_ready_ms)}, ` +
        `React mount ${ms(journey.j1?.react_mount_ms)}, ` +
        `composer ${ms(journey.j1?.composer_ready_ms)}; ` +
        `App Advisor ready ${ms(journey.app_advisor?.ready_ms)} after the click`,
    );
  }
  for (const error of scenario.startupJourney?.errors ?? []) {
    console.error(`[perf]   startup journey: ${error}`);
  }
  for (const line of quitSummaryLines(scenario.quit)) {
    if (line.error) console.error(line.text);
    else console.log(line.text);
  }
}

function diagnosticOutputDir(outputPath, scenarioName) {
  const extension = path.extname(outputPath);
  const baseName = path.basename(outputPath, extension);
  return path.join(
    path.dirname(outputPath),
    `${baseName}-diagnostics`,
    scenarioName,
  );
}

function printDiagnosticSummary(scenarioName, diagnostics) {
  console.log(
    `[perf] ${scenarioName} diagnostic capture: ${diagnostics.status}; replay scenario: ${diagnostics.replay?.status ?? 'unavailable'}; report=${diagnostics.artifacts?.report ?? 'unavailable'}`,
  );
  const replayError = diagnosticReplayError(diagnostics);
  if (replayError) {
    console.error(
      `[perf] ${scenarioName} diagnostic replay failed: ${replayError}`,
    );
    return;
  }
  for (const summary of diagnostics.summaries ?? []) {
    const top = summary.topApplication?.[0];
    console.log(
      `[perf]   ${summary.process}: app CPU ${summary.applicationSelfPercent.toFixed(1)}%${top ? `; top ${top.functionName} ${top.selfMs.toFixed(1)}ms (${top.url}${top.line ? `:${top.line}` : ''})` : ''}`,
    );
  }
}

async function attachDiagnosticReplay({
  scenario,
  scenarioName,
  diagnosticName = scenarioName,
  options,
  outputPath,
  mockServers,
}) {
  console.log(
    `[perf] Replaying ${scenarioName} with CPU profilers and Electron tracing...`,
  );
  try {
    const mockServer = await ensureMockServer();
    mockServers.push(mockServer);
    const diagnosticReplay = await runPerformanceScenario(
      scenarioName,
      options.config,
      {
        ...options,
        keepData: false,
        diagnosticOutputDir: diagnosticOutputDir(outputPath, diagnosticName),
        diagnosticContext: {
          status: scenario.status,
          responsiveness: scenario.responsiveness,
        },
      },
    );
    scenario.diagnostics = diagnosticReplayOutcome(diagnosticReplay);
  } catch (error) {
    scenario.diagnostics = failedDiagnosticReplay(error);
  }
  printDiagnosticSummary(scenarioName, scenario.diagnostics);
}

async function main() {
  const options = parsePerformanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log(performanceUsage());
    return;
  }
  assertChatPrerequisite(options.scenarios);

  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const outputPath = path.resolve(
    repoRoot,
    options.output || defaultOutputPath(options.profile),
  );
  const releaseLikeRoot = options.releaseLike
    ? path.resolve(repoRoot, options.releaseLikeRoot || '.')
    : null;
  // Before the mock server starts: the bundle must target the mock's origin.
  if (releaseLikeRoot) {
    assertReleaseLikeCloudOrigin(releaseLikeRoot, PERFORMANCE_MOCK_BASE_URL);
  }
  const measuredBuild = releaseLikeRoot
    ? { root: releaseLikeRoot, workingDirectory: releaseLikeRoot }
    : options.e2eRoot
      ? selectE2eBuildRoot(options)
      : null;
  const gitStatus = gitValue(['status', '--porcelain'], '');
  const bundleRoot = measuredBuild?.root ?? repoRoot;
  const bundleIdentity = bundleIdentityRecord(
    bundleRoot,
    path.join(
      bundleRoot,
      options.releaseLike
        ? 'out'
        : (process.env.CANOPY_E2E_OUT_DIR ?? 'out-e2e'),
    ),
  );
  const treatment = options.w5Store
    ? w5StoreRunTreatment(options.w5Store, measuredBuild?.root ?? repoRoot)
    : null;
  const result = {
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: options.releaseLike ? 'release-like' : 'e2e-relative',
    profile: options.profile,
    ...(options.profile === 'smoke' &&
    !options.releaseLike &&
    !options.studyWindowMode &&
    !options.studyViewportPreset
      ? { acceptancePolicy: LOCAL_SMOKE_POLICY }
      : {}),
    label: options.label,
    startedAt: new Date().toISOString(),
    config: options.config,
    ...(treatment ? { treatment } : {}),
    requestedScenarios: options.scenarios,
    source: {
      commit: gitValue(['rev-parse', 'HEAD']),
      branch: gitValue(['branch', '--show-current']),
      dirty: gitStatus.length > 0,
      ...(measuredBuild
        ? {
            measuredBuild: {
              root: measuredBuild.root,
              commit: gitValueAt(measuredBuild.root, ['rev-parse', 'HEAD']),
              dirty:
                gitValueAt(measuredBuild.root, ['status', '--porcelain'], '')
                  .length > 0,
              workingDirectory: measuredBuild.workingDirectory,
            },
          }
        : {}),
      // Additive: `measuredBuild` keeps reporting the checkout; this says
      // whether the launched bundle was built from it.
      bundleIdentity,
    },
    environment: {
      ...environmentMetadata(packageJson, options),
      windowVisible: options.showWindow,
      chatStoragePolicy: 'delta-journal',
      // A0 provenance: preserve unset separately; the lab also reads main's resolved value.
      CANOPY_E2E_CHAT_FORMAT4: process.env.CANOPY_E2E_CHAT_FORMAT4 ?? null,
      ...(options.rendererCodeCacheScheme
        ? { rendererCodeCacheSchemeEnabled: true }
        : {}),
    },
    diagnosticInstrumentation: {
      gitAttributionWrapper: options.gitAttribution,
    },
    caveats: [
      options.releaseLike
        ? 'Uses the production bundle with an isolated deterministic scenario driver; compare only with a matched release-like baseline on the same machine.'
        : 'Uses the deterministic E2E build and is valid only against a matched E2E baseline.',
      options.liveStartupBackground
        ? 'The startup-settle scenario runs real skill/plugin refreshes over the network; use it for diagnosis, not a deterministic acceptance budget.'
        : options.releaseLike
          ? 'The scenario driver isolates user data and external services; it measures production rendering/runtime behavior, not an installed user profile.'
          : 'E2E suppresses or changes some startup/background work; it is not a production startup benchmark.',
      ...(options.scenarios.includes('startup-realistic')
        ? [
            'The startup-realistic scenario explicitly restores selected E2E-suppressed startup procedures and cold shadow maintenance. It is an environment-dependent diagnostic driver, not release-performance evidence.',
          ]
        : []),
      'The BrowserWindow is hidden by default; compare headless results only with a headless baseline.',
      'Summed process working set is a diagnostic proxy and can double-count shared memory.',
      'Canonical chat storage uses the delta journal. Older baseline builds must enable their retired experiment to exercise the same storage path.',
      ...(options.rendererCodeCacheScheme
        ? [
            'The rendererCodeCacheSchemeEnabled experiment was seeded on: both windows load from the app-renderer:// code-cache scheme. Compare it with a matched run of the same build without the flag, and run --warm-launches so storage migration and code-cache production stay out of the measured launch.',
          ]
        : []),
      ...(options.config.startupWarmLaunches
        ? [
            `Startup scenarios launch their profile ${String(options.config.startupWarmLaunches)} time(s) unmeasured first, so the measured launch is a repeat-state startup. Compare only with runs that use the same --warm-launches.`,
          ]
        : []),
      ...(options.gitAttribution
        ? [
            'Git attribution replaces Git with a logging wrapper. Its elapsed, CPU, memory, process, and responsiveness timings are diagnostic-only and must not be compared with unwrapped runs.',
          ]
        : []),
      ...(options.w5Store ? w5StoreCaveats(options.w5Store) : []),
    ],
    scenarios: [],
  };
  if (bundleIdentity.status !== 'verified')
    console.warn(
      `[perf] Bundle identity ${bundleIdentity.status} (${bundleIdentity.reasons.join(', ')}): ${bundleIdentity.outDir} stamp ${bundleIdentity.stamp?.commit ?? 'missing'}, checkout ${bundleIdentity.checkout?.commit ?? 'unknown'}`,
    );
  // Repeated runs are sample-major: every scenario runs once per sample, each
  // a fresh launch, so slow drift in host load spreads across scenarios.
  const repeated = options.repeat > 1;
  if (repeated) result.repeat = { count: options.repeat, samples: [] };

  const mockServers = [await ensureMockServer()];
  console.log(
    `[perf] Mock server ${mockServers[0].reused ? 'reused' : 'started'}; profile=${options.profile}`,
  );
  try {
    for (let sample = 0; sample < options.repeat; sample += 1) {
      const sampleRecord = repeated
        ? {
            index: sample,
            startedAt: new Date().toISOString(),
            loadAverage: os.loadavg().map((value) => roundMetric(value, 2)),
          }
        : null;
      if (repeated) {
        console.log(
          `[perf] Sample ${sample + 1}/${options.repeat} (load average ${sampleRecord.loadAverage.join(' ')})`,
        );
      }
      await runSample({
        result,
        options,
        outputPath,
        mockServers,
        sample: repeated ? sample : null,
      });
      if (sampleRecord) {
        sampleRecord.completedAt = new Date().toISOString();
        result.repeat.samples.push(sampleRecord);
      }
    }
  } finally {
    for (const mockServer of mockServers.reverse()) {
      await mockServer.stop();
    }
  }

  result.completedAt = new Date().toISOString();
  finalizeResult(result);
  if (options.profile === WORK_RATCHET_PROFILE) {
    // The local work-counter ratchet judges counts only; the verdict is
    // stored with the result it judged.
    result.workRatchet = judgeWorkRatchet(result);
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`[perf] Results: ${outputPath}`);
  if (result.acceptance)
    for (const line of formatSmokeAcceptance(result.acceptance))
      console.log(line);
  // Advisory: a ratio above its bound is reported, never a failure.
  for (const line of formatScalingRatioLines(result)) {
    console.log(line);
  }
  if (result.workRatchet) {
    for (const line of formatWorkRatchetVerdict(result.workRatchet)) {
      console.log(line);
    }
  }
  if (options.profile === 'smoke') {
    const removed = pruneSmokeDiagnosticArtifacts(path.dirname(outputPath));
    if (removed.length > 0) {
      console.log(
        `[perf] Pruned ${removed.length} old smoke diagnostic run${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}`,
      );
    }
  }

  if (!performanceRunSucceeded(result)) {
    process.exitCode = 1;
  }
}

/**
 * Runs every selected scenario once. In a repeated run each record carries
 * its `sample` index; a single-sample run keeps the original record shape.
 */
async function runSample({ result, options, outputPath, mockServers, sample }) {
  for (const [scenarioIndex, scenarioName] of options.scenarios.entries()) {
    if (scenarioIndex > 0 || (sample ?? 0) > 0) {
      const mockServer = await ensureMockServer();
      mockServers.push(mockServer);
    }
    console.log(`[perf] Running ${scenarioName}...`);
    const startedAt = Date.now();
    let scenario;
    const host = usesLocalSmokePolicy(result) ? startHostMeasurement() : null;
    try {
      scenario = await runPerformanceScenario(scenarioName, options.config, {
        ...options,
        crashDumpOutputDir: path.join(
          diagnosticOutputDir(
            outputPath,
            sample === null
              ? scenarioName
              : `${scenarioName}-sample-${sample + 1}`,
          ),
          'crash-dumps',
        ),
      });
    } catch (error) {
      scenario = failedPerformanceScenario(
        scenarioName,
        Date.now() - startedAt,
        error,
      );
    }
    if (host) scenario.hostMeasurement = host.stop();
    if (sample !== null) scenario.sample = sample;
    result.scenarios.push(scenario);
    // Retain incomplete evidence if a later scenario or cleanup aborts. The
    // local policy requires completedAt before any result can pass.
    if (usesLocalSmokePolicy(result)) {
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    printScenarioSummary(scenario);
    // Timing-only smoke breaches are retained. Replay explicitly with --diagnose
    // or after a matched regression, so one noisy host does not multiply load.
    const diagnosticMode =
      usesLocalSmokePolicy(result) &&
      smokeWorkloadCompleted(scenario) &&
      options.diagnosticsMode !== 'always'
        ? 'off'
        : options.diagnosticsMode;
    if (shouldRunPerformanceDiagnostics(diagnosticMode, scenario)) {
      await attachDiagnosticReplay({
        scenario,
        scenarioName,
        diagnosticName:
          sample === null
            ? scenarioName
            : `${scenarioName}-sample-${sample + 1}`,
        options,
        outputPath,
        mockServers,
      });
    }
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  console.error(performanceUsage());
  process.exitCode = 1;
});
