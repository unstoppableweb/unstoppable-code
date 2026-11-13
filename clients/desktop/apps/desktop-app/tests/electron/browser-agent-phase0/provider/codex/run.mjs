#!/usr/bin/env node
// Codex half of the browser-agent Phase 0 probe (spikes S0.1 and S0.2).
// Spawned by provider-probe.mjs only: `node --import tsx provider/codex/run.mjs`
// with a synthetic HOME/CODEX_HOME and a hard deadline. Do not run directly.
//
// Planning evidence tooling: no production, performance or model-quality
// claims. All inference is the local scripted mock on a loopback capture
// listener; all timings are "mock/loopback, not release performance".
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { EXIT, EXPECTED_PINS, REPO_ROOT } from '../shared/constants.mjs';
import {
  armChildDeadline,
  buildReport,
  loadChildContext,
  writeArtifact,
} from '../shared/child-runtime.mjs';
import {
  canariesFor,
  readRecorderInvocations,
  writeRecorderScript,
} from '../shared/canaries.mjs';
import { checkProbeEnv, isLoopbackUrl } from '../shared/child-env.mjs';
import {
  evaluateCanary,
  registerScenario,
  startCapture,
  summarizeSnapshot,
  writeSnapshot,
} from '../shared/capture.mjs';
import { STATUS, createLedger } from '../shared/ledger.mjs';
import {
  BROWSER_AGENT_TOOL_NAMES,
  schemaOverheadSummary,
} from '../shared/tool-schemas.mjs';
import { isInside, listFiles } from '../shared/synthetic-root.mjs';
import { planFixtures, writeFixtures } from './config-fixture.mjs';
import {
  PROBE_CONFIG_ARGS,
  checkDelegationProfileDrift,
} from './drift-guard.mjs';
import { recommendGuard } from './guard-math.mjs';
import {
  aggregateStatuses,
  evaluateAcrossWindows,
} from './phase-classifier.mjs';
import { inspectProcessEnvironment } from './process-env.mjs';
import {
  browserLoopScenario,
  codingScenario,
  createEpochToolHost,
  failureScenario,
  markerFor,
  newNonce,
} from './scenario.mjs';
import {
  PROBE_MODEL,
  PROBE_PROVIDER,
  browserThreadParams,
  codingThreadParams,
} from './thread-params.mjs';
import {
  analyzeWindow,
  compareToolSurface,
  globalAgentsTable,
  harnessOverhead,
} from './window-analysis.mjs';

const execFileAsync = promisify(execFile);
const LABEL = 'mock/loopback, not release performance';
const PROVIDER = 'codex';
const EPOCHS = 3;
const SETTLE_MS = 1_500;

const startedAtMs = Date.now();
const ctx = loadChildContext(PROVIDER);
const { layout, outputDir, deadlineMs, canaries } = ctx;
const ledger = createLedger(PROVIDER);
const rec = (id, phase, status, evidence) =>
  ledger.record(id, phase, status, evidence);

const notes = [
  `All S0.2 numbers are ${LABEL}. Planning evidence only; no production, model-quality or release-performance claim.`,
];
const artifacts = [];
const listenPorts = [];
const identity = { pins: EXPECTED_PINS, epochs: [], handles: [] };
const s02 = { label: LABEL };
const state = {
  service: null,
  cap: null,
  handles: [],
  pids: new Set(),
  finished: false,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
const pick = (mod, name) => mod[name] ?? mod.default?.[name];
const errText = (error) => String(error?.message ?? error).slice(0, 400);
const timeLeftMs = () => deadlineMs - 25_000 - (Date.now() - startedAtMs);
const toStatus = (value) =>
  ({
    pass: STATUS.pass,
    fail: STATUS.fail,
    blocked: STATUS.blocked,
    unobserved: STATUS.unobserved,
  })[value] ?? STATUS.unobserved;

async function saveArtifact(name, value) {
  await writeArtifact(outputDir, name, value);
  artifacts.push(name);
}

async function writeFinalReport(extraNotes = []) {
  if (state.finished) return;
  state.finished = true;
  const finalized = ledger.finalize(
    'not reached in this run (probe stopped early; see notes)',
  );
  const report = buildReport({
    provider: PROVIDER,
    ledger: finalized,
    listenPorts,
    identity,
    s02,
    artifacts: [...artifacts, 'report.json'],
    notes: [...notes, ...extraNotes],
  });
  await writeArtifact(outputDir, 'report.json', report);
  return finalized;
}

async function shutdownAll() {
  for (const handle of state.handles)
    await withTimeout(handle.unsubscribe(), 8_000, 'unsubscribe').catch(
      () => {},
    );
  if (state.service)
    await withTimeout(
      state.service.shutdown(),
      30_000,
      'service.shutdown',
    ).catch((error) => notes.push(`service.shutdown: ${errText(error)}`));
  state.service = null;
}

async function pidsGone(pids) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const alive = [...pids].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return { gone: true, alive: [] };
    await sleep(250);
  }
  return {
    gone: false,
    alive: [...pids].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
  };
}

// A deadline hit writes whatever exists, then exits with EXIT.crash.
armChildDeadline(deadlineMs, async () => {
  notes.push('child deadline reached; partial report');
  await writeFinalReport().catch(() => {});
  await shutdownAll();
});

async function main() {
  // 1. Capture listener + fixtures --------------------------------------
  const cap = await startCapture();
  state.cap = cap;
  listenPorts.push(cap.port);
  const { capture, baseUrl } = cap;
  const recorders = {
    notify: await writeRecorderScript(
      layout.records,
      'notify',
      canaries.notify,
    ),
    mcp: await writeRecorderScript(
      layout.records,
      'mcp',
      canaries.mcpUserConfig,
    ),
    hook: await writeRecorderScript(layout.records, 'hook', canaries.hook),
  };
  const plan = planFixtures({ layout, canaries, baseUrl, recorders });
  const fixtureManifest = await writeFixtures(plan, [
    layout.home,
    layout.ancestor,
  ]);
  await saveArtifact('fixtures.json', { fixtures: fixtureManifest, recorders });
  notes.push(
    'Unverified offline (no codex run was possible while authoring): [[hooks.<Event>]] TOML shape, [plugins."name@market"] enable table and plugin cache layout, memories/ file layout, rules syntax. The positive control decides per fixture whether it was live; a fixture that is not live makes its absence result blocked.',
    'project/AGENTS.override.md shadows project/AGENTS.md in Codex (override wins per directory); projectInstructions may therefore not be live in the control and is then reported blocked.',
  );

  // 2. Runtime + profile ---------------------------------------------------
  const runtimeModule =
    await import('@canopy/execution-engine/node/codex-runtime/index.ts');
  const runtime = runtimeModule.default ?? runtimeModule;
  const configPaths =
    await import('@canopy/execution-engine/pipelines/config-paths.ts');
  const getBundledCodexBinaryPath = pick(
    configPaths,
    'getBundledCodexBinaryPath',
  );
  const profile = {
    environmentPolicy: 'restricted',
    includeCanopySecrets: false,
    logicalWorkspaceEnvironmentId: 'bap0-probe:delegation',
    configArgs: [...PROBE_CONFIG_ARGS],
  };
  const routeSource = await readFile(
    path.join(
      REPO_ROOT,
      'apps/desktop-app/src/main/agents/delegation/route-runtime.ts',
    ),
    'utf8',
  );
  const drift = checkDelegationProfileDrift(routeSource);
  const profileId = pick(runtime, 'resolveCodexSpawnProfile')(profile).id;
  identity.profileId = profileId;
  rec('canonical.pool-profile', 'launch', toStatus(drift.status), {
    profile,
    profileId,
    drift,
    note: 'Probe re-declares the production delegation profile (no mockProviderId); route-runtime.ts source text compared, not imported.',
  });

  // Binary + version (run with the synthetic environment; this starts `codex --version` only).
  const binaryPath = getBundledCodexBinaryPath();
  identity.binaryPath = binaryPath;
  const underCache = isInside(
    path.join(REPO_ROOT, '.cache', 'bin'),
    binaryPath,
  );
  let versionText = '';
  let versionError = null;
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], {
      env: process.env,
      timeout: 15_000,
    });
    versionText = stdout.trim();
  } catch (error) {
    versionError = errText(error);
  }
  identity.codexVersion = versionText || null;
  const versionOk = versionText.includes(EXPECTED_PINS.codexCli);
  rec(
    'canonical.pins',
    'launch',
    underCache && versionOk ? STATUS.pass : STATUS.fail,
    {
      binaryPath,
      underRepoCache: underCache,
      version: versionText,
      expected: EXPECTED_PINS.codexCli,
      versionError,
      note: 'Claude CLI / Agent SDK pins are checked by the Claude half.',
    },
  );

  const capabilityDir = path.join(layout.canopyDataDir, 'codex-capabilities');
  const tService = performance.now();
  const service = pick(
    runtime,
    'createCodexRuntimeService',
  )({
    capabilityStore: new (pick(runtime, 'CodexCapabilityStore'))(capabilityDir),
  });
  state.service = service;
  const admin = service.admin();
  const request = (method, params, label = method, timeoutMs = 45_000) =>
    withTimeout(admin.request(method, params, profile), timeoutMs, label);

  // 3. Canonical-state verification BEFORE any turn -----------------------
  const configDir = await layout.newEpochDir('config-read');
  let configRead = null;
  const precondition = { failures: [] };
  const failPrecondition = (id, evidence) => {
    precondition.failures.push(id);
    rec(id, 'launch', STATUS.fail, evidence);
  };
  try {
    configRead = await request('config/read', {
      cwd: configDir,
      includeLayers: true,
    });
  } catch (error) {
    failPrecondition('canonical.home', {
      error: errText(error),
      step: 'config/read',
    });
  }
  const tConfigRead = performance.now();
  s02.processStartAndConfigReadMs = Math.round(tConfigRead - tService);
  const ambientMcpServerNames = Object.keys(
    configRead?.config?.mcp_servers ?? {},
  );
  identity.ambientMcpServerNames = ambientMcpServerNames;

  if (configRead) {
    // (a) canonical home
    const observedHome = pick(runtime, 'getObservedCanonicalCodexHome')();
    const expectedHome = realpathSync.native(layout.codexHome);
    const homeOk =
      observedHome !== null &&
      observedHome === expectedHome &&
      isInside(layout.root, observedHome);
    identity.observedCodexHome = observedHome;
    if (homeOk)
      rec('canonical.home', 'launch', STATUS.pass, {
        observedHome,
        expectedHome,
        insideSyntheticRoot: true,
      });
    else failPrecondition('canonical.home', { observedHome, expectedHome });

    // (b) effective provider
    const config = configRead.config ?? {};
    const userLayer = (configRead.layers ?? []).find(
      (layer) => layer?.name?.type === 'user',
    );
    const providerEntry =
      config.model_providers?.probe ??
      userLayer?.config?.model_providers?.probe;
    const baseUrlEffective = providerEntry?.base_url;
    const otherUrls = Object.entries(config).filter(
      ([key, value]) => /base_url$/.test(key) && typeof value === 'string',
    );
    const nonLoopbackOther = otherUrls
      .filter(([, value]) => !isLoopbackUrl(value))
      .map(([key]) => key);
    const providerOk =
      config.model_provider === PROBE_PROVIDER &&
      baseUrlEffective === `${baseUrl}/v1` &&
      isLoopbackUrl(baseUrlEffective) &&
      nonLoopbackOther.length === 0;
    const providerEvidence = {
      model_provider: config.model_provider,
      probeBaseUrl: baseUrlEffective,
      expected: `${baseUrl}/v1`,
      otherBaseUrlKeys: otherUrls.map(([key]) => key),
      nonLoopbackOther,
      modelProvidersVisible: Boolean(config.model_providers),
    };
    if (providerOk)
      rec('canonical.provider-url', 'launch', STATUS.pass, providerEvidence);
    else failPrecondition('canonical.provider-url', providerEvidence);
  }

  // (c) app-server process environment
  const snapshots = admin.getResourceSnapshots();
  const pids = snapshots
    .map((snap) => snap.pid)
    .filter((pid) => Number.isInteger(pid));
  pids.forEach((pid) => state.pids.add(pid));
  identity.appServerPidsAtStart = pids;
  const credentialEvidence = {
    childEnv: null,
    processes: [],
    credentialFilesInCodexHome: [],
  };
  const childEnvCheck = checkProbeEnv(process.env, { root: layout.root });
  credentialEvidence.childEnv = {
    ok: childEnvCheck.ok,
    violations: childEnvCheck.violations.map(({ name, reason }) => ({
      name,
      reason,
    })),
  };
  let psBlocked = false;
  for (const pid of pids) {
    try {
      const { stdout } = await execFileAsync(
        '/bin/ps',
        ['-wwE', '-p', String(pid), '-o', 'command='],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const inspection = inspectProcessEnvironment(stdout, layout);
      credentialEvidence.processes.push({
        pid,
        status: inspection.status,
        variableNames: inspection.names,
        credentialNames: inspection.credentialNames,
        problems: inspection.problems,
      });
      if (inspection.status === 'blocked') psBlocked = true;
    } catch (error) {
      psBlocked = true;
      credentialEvidence.processes.push({
        pid,
        status: 'blocked',
        error: errText(error),
      });
    }
  }
  if (pids.length === 0) psBlocked = true;
  const authFiles = (await listFiles(layout.codexHome)).filter((file) =>
    /(^|\/)auth\.json$/.test(file.path),
  );
  credentialEvidence.credentialFilesInCodexHome = authFiles.map(
    (file) => file.path,
  );
  const credFail =
    !childEnvCheck.ok ||
    credentialEvidence.processes.some((proc) => proc.status === 'fail') ||
    authFiles.length > 0;
  if (credFail)
    failPrecondition('canonical.no-credentials', credentialEvidence);
  else if (psBlocked)
    rec('canonical.no-credentials', 'launch', STATUS.blocked, {
      ...credentialEvidence,
      reason:
        'child env clean and no auth files, but the app-server process environment was not readable through ps -E; proceeding is allowed because canonical home + provider checks passed',
    });
  else
    rec('canonical.no-credentials', 'launch', STATUS.pass, credentialEvidence);

  if (precondition.failures.length > 0) {
    notes.push(
      `Canonical-state precondition failed (${precondition.failures.join(', ')}); no turn was sent.`,
    );
    return EXIT.preconditionFailed;
  }

  // Twin thread/start through admin: the runtime's startThread does not expose
  // the start response (instructionSources, model, modelProvider), so an
  // identical ephemeral thread is started and deleted without ever running a turn.
  async function twinStart(params, label) {
    const flatten = pick(runtime, 'flattenCodexThreadConfig');
    const response = await request(
      'thread/start',
      { ...params, config: flatten(params.config, { resetMcpServers: true }) },
      `thread/start twin ${label}`,
      45_000,
    );
    const threadId = response.thread.id;
    await request(
      'thread/unsubscribe',
      { threadId },
      'twin unsubscribe',
      10_000,
    ).catch(() => {});
    await request('thread/delete', { threadId }, 'twin delete', 10_000).catch(
      () => {},
    );
    return {
      twinThreadId: threadId,
      model: response.model,
      modelProvider: response.modelProvider,
      cwd: response.cwd,
      runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
      instructionSources: response.instructionSources,
      approvalPolicy: response.approvalPolicy,
      activePermissionProfile: response.activePermissionProfile,
    };
  }
  const globalAgentsPath = path.join(layout.codexHome, 'AGENTS.md');
  const globalOverridePath = path.join(layout.codexHome, 'AGENTS.override.md');
  const allowedSources = new Set([globalAgentsPath, globalOverridePath]);
  const rolloutBefore = await listFiles(layout.codexHome);

  // (e) coding twin: requested model/provider must be reported back.
  const codingParams = codingThreadParams({ project: layout.project, baseUrl });
  let codingTwin = null;
  try {
    codingTwin = await twinStart(codingParams, 'coding');
  } catch (error) {
    failPrecondition('canonical.no-model-fallback', {
      error: errText(error),
      step: 'coding twin thread/start',
    });
  }
  if (codingTwin) {
    const modelOk =
      codingTwin.model === PROBE_MODEL &&
      codingTwin.modelProvider === PROBE_PROVIDER;
    const evidence = {
      requested: {
        model: PROBE_MODEL,
        modelProvider: PROBE_PROVIDER,
        allowProviderModelFallback: codingParams.allowProviderModelFallback,
      },
      reported: {
        model: codingTwin.model,
        modelProvider: codingTwin.modelProvider,
      },
      codeModeDisabledInThreadConfig:
        codingParams.config.features.code_mode === false,
      note: 'Verified on a twin ephemeral thread/start (runtime does not expose the start response). Browser epochs re-verify per thread.',
    };
    if (
      modelOk &&
      evidence.codeModeDisabledInThreadConfig &&
      codingParams.allowProviderModelFallback === false
    )
      rec('canonical.no-model-fallback', 'launch', STATUS.pass, evidence);
    else failPrecondition('canonical.no-model-fallback', evidence);
  }
  if (precondition.failures.length > 0) {
    notes.push(
      `Canonical-state precondition failed (${precondition.failures.join(', ')}); no turn was sent.`,
    );
    return EXIT.preconditionFailed;
  }
  identity.codingTwin = codingTwin;
  const recordersBeforeControl = await readRecorderInvocations(layout.records);
  capture.reset();

  // 4(ii). Coding thread positive control ------------------------------------
  const agentsTokens = [
    canaries.codexGlobalAgents,
    canaries.codexGlobalAgentsReplacement,
  ];
  const codingMarker = markerFor('coding');
  registerScenario(codingMarker, codingScenario());
  const tThread0 = performance.now();
  const codingHandle = await withTimeout(
    service.startThread({
      capabilitySnapshotId: 'bap0-coding-control',
      capabilityLeaseKind: 'ephemeral',
      profile,
      params: codingParams,
    }),
    60_000,
    'coding startThread',
  );
  state.handles.push(codingHandle);
  const tThread1 = performance.now();
  s02.sessionStart = {
    label: LABEL,
    coldServiceCreateToFirstThreadStartMs: Math.round(tThread1 - tService),
    coldFirstThreadStartLatencyMs: Math.round(tThread1 - tThread0),
    coldBreakdown: {
      processStartAndConfigReadMs: s02.processStartAndConfigReadMs,
      includesCanonicalChecksAndCodingTwin: true,
    },
    warm: [],
  };
  const pidSnapshot = () =>
    admin
      .getResourceSnapshots()
      .map((snap) => snap.pid)
      .filter((pid) => Number.isInteger(pid));
  const codingPids = pidSnapshot();
  codingPids.forEach((pid) => state.pids.add(pid));
  identity.coding = {
    threadId: codingHandle.threadId,
    pids: codingPids,
    profileId,
  };
  const threadIds = [codingHandle.threadId];

  async function maxSeq() {
    const snap = capture.snapshot();
    return snap.records.reduce((max, record) => Math.max(max, record.seq), 0);
  }

  /** Run one scripted turn; resolves with outcome + timing + events. */
  async function runTurn({
    handle,
    marker,
    scenario,
    text,
    totalTimeoutMs,
    hostTools,
  }) {
    registerScenario(marker, scenario);
    const events = [];
    const tokenUsageEvents = [];
    const startSeq = await maxSeq();
    const t0 = performance.now();
    let firstRequestMs = null;
    const poll = setInterval(() => {
      if (firstRequestMs !== null) return;
      const snap = capture.snapshot();
      if (
        snap.records.some(
          (record) =>
            record.seq > startSeq &&
            record.surface === 'openai-responses' &&
            (record.prompt === 'full' || record.prompt === 'delta'),
        )
      )
        firstRequestMs = performance.now() - t0;
    }, 10);
    let outcome;
    let turnError = null;
    try {
      outcome = await withTimeout(
        handle.runTurn({
          input: [
            { type: 'text', text: `[${marker}] ${text}`, text_elements: [] },
          ],
          totalTimeoutMs,
          startupTimeoutMs: 30_000,
          onEvent: (event) => {
            events.push(event.method);
            if (event.method === 'thread/tokenUsage/updated')
              tokenUsageEvents.push(event.params?.tokenUsage ?? null);
          },
          ...(hostTools
            ? {
                hostToolPolicy: {
                  allowedTools: BROWSER_AGENT_TOOL_NAMES.map((tool) => ({
                    namespace: null,
                    tool,
                  })),
                  authorize: async () => true,
                  execute: (call) => hostTools.execute(call),
                  timeoutMs: 30_000,
                },
              }
            : {}),
        }),
        totalTimeoutMs + 15_000,
        `runTurn ${marker}`,
      );
    } catch (error) {
      turnError = errText(error);
    } finally {
      clearInterval(poll);
    }
    const totalMs = performance.now() - t0;
    const completionSeq = await maxSeq();
    const eventCounts = {};
    for (const method of events)
      eventCounts[method] = (eventCounts[method] ?? 0) + 1;
    return {
      outcome,
      turnError,
      totalMs,
      firstRequestMs,
      completionSeq,
      eventCounts,
      tokenUsageEvents: tokenUsageEvents.slice(-3),
    };
  }

  const controlTurn = await runTurn({
    handle: codingHandle,
    marker: codingMarker,
    scenario: codingScenario(),
    text: `Coding control ${canaries.codingThreadContext}. Reply briefly.`,
    totalTimeoutMs: 45_000,
  });
  await sleep(SETTLE_MS);
  const controlSnapshot = capture.snapshot();
  await writeSnapshot(
    path.join(outputDir, 'capture-coding-control.json'),
    controlSnapshot,
  );
  artifacts.push('capture-coding-control.json');
  capture.reset();
  const recordersAfterControl = await readRecorderInvocations(layout.records);
  const count = (set, name) => (set[name] ?? []).length;

  // Diagnostics in the control cwd (hooks/list: is the hook declaration even parsed?)
  const diagnostics = { control: {}, epoch: {} };
  async function diag(target, key, method, params) {
    try {
      target[key] = await request(method, params, method, 30_000);
    } catch (error) {
      target[key] = { error: errText(error) };
    }
  }
  await diag(diagnostics.control, 'hooksList', 'hooks/list', {
    cwds: [layout.project],
  });
  await diag(diagnostics.control, 'skillsList', 'skills/list', {
    cwds: [layout.project],
    forceReload: true,
  });

  // Fixture liveness from the control (complete full prompts only).
  const liveness = {};
  const controlFound = (id) =>
    evaluateCanary(controlSnapshot, canaries[id], 'accepted');
  for (const entry of canariesFor(PROVIDER)) {
    if (
      [
        'hostEnvironment',
        'hostFile',
        'codexGlobalAgents',
        'codexGlobalAgentsReplacement',
      ].includes(entry.id)
    )
      continue;
    const found = controlFound(entry.id);
    liveness[entry.id] = {
      live: found.status === STATUS.pass,
      basis:
        found.status === STATUS.pass
          ? 'canary present in control request'
          : 'canary not present in control request',
      hits: found.hits.length,
    };
  }
  liveness.codexGlobalAgents = {
    live: controlFound('codexGlobalAgents').status === STATUS.pass,
    basis: 'canary in control request',
  };
  liveness.mcpUserConfig.live =
    liveness.mcpUserConfig.live || count(recordersAfterControl, 'mcp') > 0;
  liveness.mcpUserConfig.recorderInvocations = count(
    recordersAfterControl,
    'mcp',
  );
  const hookListed = JSON.stringify(
    diagnostics.control.hooksList ?? {},
  ).includes(canaries.hook);
  liveness.hook.live =
    liveness.hook.live ||
    count(recordersAfterControl, 'hook') > 0 ||
    hookListed;
  liveness.hook.basis = `recorder invocations=${count(recordersAfterControl, 'hook')}; listed by hooks/list=${hookListed} (process-level features.hooks=false in the delegation profile prevents execution)`;
  liveness.notify.live =
    liveness.notify.live || count(recordersAfterControl, 'notify') > 0;
  liveness.notify.recorderInvocations = count(recordersAfterControl, 'notify');
  liveness.rules.live = false;
  liveness.rules.basis =
    'rules feed the exec policy, not prompt text; never observable in outbound bytes';
  const controlAnalysis = analyzeWindow(controlSnapshot, {
    completionSeq: controlTurn.completionSeq,
    agentsTokens,
  });
  const controlSources = codingTwin.instructionSources;
  const controlResult = {
    status: controlTurn.outcome?.status ?? 'error',
    error: controlTurn.turnError ?? controlTurn.outcome?.error ?? null,
    firstRequestMs: controlTurn.firstRequestMs,
    requestCount: controlAnalysis.summaries.length,
    instructionSourcesTwin: controlSources,
    liveness,
    recorders: { before: recordersBeforeControl, after: recordersAfterControl },
    requestTools: controlAnalysis.summaries[0]?.toolNames ?? [],
    harness: harnessOverhead(controlAnalysis.summaries[0]),
  };
  await saveArtifact('coding-control.json', controlResult);
  if (!controlResult.requestCount)
    notes.push(
      `Coding control produced no generation request (status ${controlResult.status}: ${controlResult.error ?? 'none'}); every fixture is unproven-live, so absence results are blocked.`,
    );

  // 4(iii). Browser epochs on the same process -------------------------------
  const epochWindows = [];
  const epochReports = [];
  const replacementPath = globalAgentsPath;
  const startPids = pidSnapshot();
  const expectedNames = [...BROWSER_AGENT_TOOL_NAMES];
  const recorderCounts = { afterControl: recordersAfterControl };

  async function browserEpoch({ label, index, scenario, failure = false }) {
    const epochDir = await layout.newEpochDir(label);
    const nonce = newNonce();
    const host = createEpochToolHost({
      epoch: index,
      nonce,
      onCall: async (entry) => {
        if (index === 1 && entry.step === 0)
          await writeFile(
            replacementPath,
            `# Probe replacement global instructions\n${canaries.codexGlobalAgentsReplacement}\n`,
          );
      },
    });
    const report = {
      label,
      index,
      epochDir,
      sentinel: host.sentinel,
      status: 'not-run',
    };
    if (timeLeftMs() < 35_000) {
      report.status = 'skipped';
      report.reason = 'child time budget exhausted';
      notes.push(`${label} skipped: child time budget exhausted.`);
      epochReports.push(report);
      return report;
    }
    // Global AGENTS state for this epoch (epoch 1: original; 2: replaced during 1; 3+: deleted).
    if (index === 3 || failure) {
      await unlink(globalAgentsPath).catch(() => {});
      report.globalAgentsDeletedBeforeStart = !existsSync(globalAgentsPath);
    }
    let params = browserThreadParams({
      epochDir,
      baseUrl,
      ambientMcpServerNames,
    });
    let twin = null;
    try {
      twin = await twinStart(params, label);
    } catch (error) {
      if (/runtimeWorkspaceRoots/i.test(errText(error))) {
        notes.push(
          `${label}: pinned build rejected runtimeWorkspaceRoots (${errText(error)}); retried without it.`,
        );
        params = browserThreadParams({
          epochDir,
          baseUrl,
          ambientMcpServerNames,
          withRuntimeWorkspaceRoots: false,
        });
        try {
          twin = await twinStart(params, label);
        } catch (retryError) {
          report.twinError = errText(retryError);
        }
      } else report.twinError = errText(error);
    }
    report.twin = twin;
    if (twin) {
      const unexpected = twin.instructionSources.filter(
        (source) => !allowedSources.has(source),
      );
      report.instructionSources = twin.instructionSources;
      report.unexpectedInstructionSources = unexpected;
      report.modelMatches =
        twin.model === PROBE_MODEL && twin.modelProvider === PROBE_PROVIDER;
      if (unexpected.length > 0) {
        report.status = 'discarded-before-send';
        report.reason = `instructionSources contains non-accepted sources: ${unexpected.join(', ')}`;
        epochReports.push(report);
        return report;
      }
    } else
      notes.push(
        `${label}: twin thread/start unavailable (${report.twinError}); instructionSources unobserved, turn still run against the loopback mock.`,
      );

    const marker = markerFor(failure ? 'fail' : `e${index}`);
    const tStart0 = performance.now();
    const handle = await withTimeout(
      service.startThread({
        capabilitySnapshotId: `bap0-${label}`,
        capabilityLeaseKind: 'ephemeral',
        profile,
        params,
      }),
      60_000,
      `${label} startThread`,
    );
    const startMs = Math.round(performance.now() - tStart0);
    state.handles.push(handle);
    threadIds.push(handle.threadId);
    report.threadId = handle.threadId;
    report.startThreadMs = startMs;
    const pidsNow = pidSnapshot();
    pidsNow.forEach((pid) => state.pids.add(pid));
    report.pids = pidsNow;
    s02.sessionStart.warm.push({ label, startThreadMs: startMs });
    const turn = await runTurn({
      handle,
      marker,
      scenario,
      text: `Browser probe ${label}. Follow the scripted tool loop.`,
      totalTimeoutMs: failure ? 25_000 : 45_000,
      hostTools: host,
    });
    await sleep(SETTLE_MS);
    const snapshot = capture.snapshot();
    const snapshotName = `capture-${failure ? 'launch-failure' : label}.json`;
    await writeSnapshot(path.join(outputDir, snapshotName), snapshot);
    artifacts.push(snapshotName);
    capture.reset();
    const analysis = analyzeWindow(snapshot, {
      completionSeq: turn.completionSeq,
      ...(failure ? { singlePhase: 'launch-failure' } : {}),
      agentsTokens,
      contentTokens: {
        globalOriginal: canaries.codexGlobalAgents,
        globalReplacement: canaries.codexGlobalAgentsReplacement,
        ownSentinel: host.sentinel,
      },
    });
    Object.assign(report, {
      status: turn.outcome?.status ?? 'error',
      error: turn.turnError ?? turn.outcome?.error ?? null,
      firstRequestMs:
        turn.firstRequestMs === null ? null : Math.round(turn.firstRequestMs),
      turnMs: Math.round(turn.totalMs),
      eventCounts: turn.eventCounts,
      usage: turn.outcome?.usage ?? null,
      tokenUsageEvents: turn.tokenUsageEvents,
      toolCalls: host.calls,
      requestCount: analysis.summaries.length,
      emptyCwdAfterTurn: (await listFiles(epochDir)).length === 0,
      snapshotSummary: {
        counts: snapshot.counts,
        kinds: snapshot.kinds,
        bytes: snapshot.bytes,
      },
    });
    epochReports.push(report);
    epochWindows.push({
      label,
      failure,
      snapshot,
      phases: analysis.phases,
      analysis,
      host,
      report,
      turn,
    });
    return report;
  }

  for (let index = 1; index <= EPOCHS; index += 1) {
    await browserEpoch({
      label: `epoch-${index}`,
      index,
      scenario: browserLoopScenario(),
    });
    recorderCounts[`afterEpoch${index}`] = await readRecorderInvocations(
      layout.records,
    );
  }
  // 4(iv). Launch failure -----------------------------------------------------
  await browserEpoch({
    label: 'launch-failure',
    index: 4,
    scenario: failureScenario(),
    failure: true,
  });
  recorderCounts.afterFailure = await readRecorderInvocations(layout.records);
  identity.epochs = epochReports.map(
    ({
      label,
      threadId,
      pids,
      sentinel,
      status,
      instructionSources,
      startThreadMs,
    }) => ({
      label,
      threadId,
      pids,
      sentinel,
      status,
      instructionSources,
      startThreadMs,
    }),
  );
  identity.handles = threadIds;

  // 4(v). Diagnostics ---------------------------------------------------------
  const lastEpochDir =
    epochReports.find((report) => report.label === 'epoch-3')?.epochDir ??
    configDir;
  await diag(diagnostics.epoch, 'hooksList', 'hooks/list', {
    cwds: [lastEpochDir],
  });
  await diag(diagnostics.epoch, 'skillsList', 'skills/list', {
    cwds: [lastEpochDir],
    forceReload: true,
  });
  await diag(diagnostics.epoch, 'configRead', 'config/read', {
    cwd: lastEpochDir,
    includeLayers: true,
  });
  const summarizeSkills = (value) =>
    value?.data?.map((entry) => ({
      cwd: entry.cwd,
      skills: (entry.skills ?? []).map((skill) => ({
        name: skill.name,
        scope: skill.scope,
        enabled: skill.enabled,
        pluginId: skill.pluginId ?? null,
      })),
      errors: entry.errors?.length ?? 0,
    })) ?? value;
  const summarizeLayers = (value) =>
    value?.layers?.map((layer) => ({
      source: layer.name,
      disabledReason: layer.disabledReason,
      topLevelKeys: Object.keys(layer.config ?? {}),
    })) ?? value;
  const diagnosticsReport = {
    note: 'skills/list and config/read are catalog queries, not prompt evidence.',
    controlCwd: {
      hooksList: diagnostics.control.hooksList,
      skillsList: summarizeSkills(diagnostics.control.skillsList),
    },
    epochCwd: {
      hooksList: diagnostics.epoch.hooksList,
      skillsList: summarizeSkills(diagnostics.epoch.skillsList),
      configLayers: summarizeLayers(diagnostics.epoch.configRead),
    },
    initialConfigLayers: summarizeLayers(configRead),
    recorderInvocations: {
      beforeControl: recordersBeforeControl,
      afterControl: recordersAfterControl,
      afterEpochs: recorderCounts,
    },
  };
  const rolloutAfter = await listFiles(layout.codexHome);
  const beforePaths = new Set(rolloutBefore.map((file) => file.path));
  const addedFiles = rolloutAfter.filter((file) => !beforePaths.has(file.path));
  const addedRollouts = addedFiles.filter(
    (file) =>
      /(^|\/)(sessions|archived_sessions)\//.test(file.path) ||
      /rollout-.*\.jsonl$/.test(file.path),
  );
  diagnosticsReport.codexHomeFilesAdded = addedFiles;
  await saveArtifact('diagnostics.json', diagnosticsReport);

  // 5. Ledger evaluation ------------------------------------------------------
  evaluateLedger({
    epochWindows,
    epochReports,
    controlResult,
    liveness,
    recorderCounts,
    recordersAfterControl,
    diagnosticsReport,
    addedRollouts,
    addedFiles,
    startPids,
    expectedNames,
    layout,
    canaries,
    threadIds,
    configRead,
    codingTwin,
  });
  // 6. S0.2 ---------------------------------------------------------------------
  computeS02({ epochWindows, epochReports });
  // Shutdown happens in finally; PID liveness check recorded there.
  await saveArtifact(
    'requests.json',
    epochWindows.map((window) => ({
      label: window.label,
      phases: Object.fromEntries(window.phases),
      summaries: window.analysis.summaries,
      growth: window.analysis.growth,
      nonGeneration: window.analysis.nonGeneration,
    })),
  );
  await saveArtifact(
    'epochs.json',
    epochReports.map(({ twin, ...rest }) => ({ ...rest, twin })),
  );
  await saveArtifact(
    'canary-windows.json',
    epochWindows.map((window) => ({
      label: window.label,
      summary: summarizeSnapshot(window.snapshot),
    })),
  );
  return null;
}

function canaryStatusWithLiveness(id, aggregate, liveness) {
  if (aggregate === 'pass' && liveness[id] && liveness[id].live !== true)
    return { status: STATUS.blocked, liveness: liveness[id] };
  return {
    status: toStatus(aggregate),
    liveness: liveness[id] ?? {
      live: null,
      basis: 'no fixture (orchestrator or environment canary)',
    },
  };
}

function evaluateLedger({
  epochWindows,
  epochReports,
  controlResult,
  liveness,
  recorderCounts,
  recordersAfterControl,
  diagnosticsReport,
  addedRollouts,
  addedFiles,
  startPids,
  expectedNames,
  canaries,
  threadIds,
  configRead,
  codingTwin,
}) {
  const count = (set, name) => (set?.[name] ?? []).length;
  const browserWindows = epochWindows.filter((window) => !window.failure);
  const failureWindow = epochWindows.find((window) => window.failure);
  const PHASES3 = ['before-inference', 'after-tools', 'completion'];
  const browserOnly = canariesFor(PROVIDER).filter(
    (entry) => entry.expected === 'absent',
  );
  const phaseStatuses = {
    'before-inference': [],
    'after-tools': [],
    completion: [],
    'launch-failure': [],
  };

  // canary.* (expected absent)
  for (const entry of browserOnly) {
    const token = canaries[entry.id];
    const evaluate = (snapshot, filter) =>
      evaluateCanary(snapshot, token, 'absent', filter);
    for (const phase of PHASES3) {
      const aggregate = evaluateAcrossWindows(browserWindows, phase, evaluate);
      const { status, liveness: live } = canaryStatusWithLiveness(
        entry.id,
        aggregate.status,
        liveness,
      );
      phaseStatuses[phase].push(status);
      rec(`canary.${entry.id}`, phase, status, {
        expected: entry.expected,
        where: entry.where,
        perWindow: aggregate.perWindow,
        liveness: live,
      });
    }
    if (failureWindow) {
      const aggregate = evaluateAcrossWindows(
        [failureWindow],
        'launch-failure',
        evaluate,
      );
      const { status, liveness: live } = canaryStatusWithLiveness(
        entry.id,
        aggregate.status,
        liveness,
      );
      phaseStatuses['launch-failure'].push(status);
      rec(`canary.${entry.id}`, 'launch-failure', status, {
        expected: entry.expected,
        perWindow: aggregate.perWindow,
        liveness: live,
      });
    } else
      rec(`canary.${entry.id}`, 'launch-failure', STATUS.unobserved, {
        reason: 'launch-failure window not run',
      });
  }

  // Accepted global AGENTS canaries and their counting/change table.
  const e1 = browserWindows.find((window) => window.label === 'epoch-1');
  const e2 = browserWindows.find((window) => window.label === 'epoch-2');
  const e3 = browserWindows.find((window) => window.label === 'epoch-3');
  const firstOf = (window) => window?.analysis.summaries[0];
  const laterOf = (window) => window?.analysis.summaries.slice(1) ?? [];
  const table = Object.fromEntries(
    browserWindows.map((window) => [
      window.label,
      globalAgentsTable(window.analysis.summaries),
    ]),
  );
  const failureTable = failureWindow
    ? globalAgentsTable(failureWindow.analysis.summaries)
    : [];
  const originalFirst =
    firstOf(e1)?.contains?.globalOriginal === true &&
    (firstOf(e1)?.globalAgents.bytes ?? 0) > 0;
  rec(
    'canary.codexGlobalAgents',
    'before-inference',
    originalFirst ? STATUS.pass : e1 ? STATUS.fail : STATUS.unobserved,
    {
      expected: 'accepted',
      epoch1FirstRequest: firstOf(e1)?.contains ?? null,
      globalAgentsBytes: firstOf(e1)?.globalAgents.bytes ?? null,
    },
  );
  rec('canary.codexGlobalAgents', 'after-tools', STATUS.measured, {
    note: 'accepted source; presence per later request is the mid-turn reload observation',
    epoch1: laterOf(e1).map((summary) => summary.contains),
    epoch2: laterOf(e2).map((summary) => summary.contains),
  });
  rec('canary.codexGlobalAgents', 'completion', STATUS.unobserved, {
    reason:
      'no model request is expected after turn completion; none recorded for the accepted source',
  });
  rec('canary.codexGlobalAgents', 'launch-failure', STATUS.measured, {
    note: 'the global file was deleted before this thread',
    requests: failureTable,
  });
  const replacementSecond = firstOf(e2)?.contains?.globalReplacement === true;
  const replacementNotEarly = firstOf(e1)?.contains?.globalReplacement !== true;
  rec(
    'canary.codexGlobalAgentsReplacement',
    'before-inference',
    replacementSecond && replacementNotEarly
      ? STATUS.pass
      : e2
        ? STATUS.fail
        : STATUS.unobserved,
    {
      expected: 'accepted',
      epoch2FirstRequestHasReplacement: replacementSecond,
      epoch1FirstRequestLackedReplacement: replacementNotEarly,
    },
  );
  rec('canary.codexGlobalAgentsReplacement', 'after-tools', STATUS.measured, {
    epoch1LaterRequests: laterOf(e1).map((summary) => summary.contains),
  });
  rec('canary.codexGlobalAgentsReplacement', 'completion', STATUS.unobserved, {
    reason: 'no record after completion',
  });
  rec(
    'canary.codexGlobalAgentsReplacement',
    'launch-failure',
    STATUS.measured,
    { requests: failureTable },
  );

  const midTurnReload = laterOf(e1).some(
    (summary) => summary.contains?.globalReplacement === true,
  );
  const removalObserved = e3
    ? firstOf(e3)?.contains?.globalOriginal !== true &&
      firstOf(e3)?.contains?.globalReplacement !== true
    : null;
  rec('codex.global-agents-change', 'after-tools', STATUS.measured, {
    midTurnReloadObservedInEpoch1: midTurnReload,
    epoch2FirstRequestHasReplacement: replacementSecond,
    removalObservedInEpoch3: removalObserved,
    table,
    note: 'measured, not judged: records which request carried which global content',
  });
  const countedOk = [firstOf(e1), firstOf(e2)].every(
    (summary) => summary && summary.globalAgents.bytes > 0,
  );
  rec(
    'codex.global-agents-counted',
    'before-inference',
    e1 && e2 ? (countedOk ? STATUS.pass : STATUS.fail) : STATUS.unobserved,
    {
      bytesPerRequestFirst: {
        epoch1: firstOf(e1)?.globalAgents.bytes,
        epoch2: firstOf(e2)?.globalAgents.bytes,
        epoch3: firstOf(e3)?.globalAgents.bytes,
      },
    },
  );
  rec('codex.global-agents-counted', 'after-tools', STATUS.measured, {
    table,
    epoch3Note: 'epoch 3 has the global file deleted: zero bytes expected',
  });

  // launch.tool-surface
  const surfaceEvidence = [];
  let surfaceFail = false;
  for (const window of browserWindows) {
    for (const [index, summary] of window.analysis.summaries.entries()) {
      const comparison = compareToolSurface(
        summary.toolNames ?? [],
        expectedNames,
      );
      surfaceEvidence.push({
        window: window.label,
        request: index,
        phase: summary.phase,
        ...comparison,
        advertised: summary.toolNames,
      });
      if (!comparison.equal) surfaceFail = true;
    }
  }
  for (const phase of ['before-inference', 'after-tools']) {
    const rows = surfaceEvidence.filter((row) => row.phase === phase);
    const status =
      rows.length === 0
        ? STATUS.unobserved
        : rows.some((row) => !row.equal)
          ? STATUS.fail
          : STATUS.pass;
    rec('launch.tool-surface', phase, status, {
      expected: expectedNames,
      rows: rows.map(({ advertised, ...rest }) => rest),
      extraBuiltIns: [...new Set(rows.flatMap((row) => row.extra))],
    });
  }
  notes.push(
    surfaceFail
      ? 'launch.tool-surface: extra or missing advertised tools were recorded verbatim (see ledger rows).'
      : 'launch.tool-surface: advertised tools equal the 22 browser tools in every captured browser request.',
  );

  // launch.instruction-sources, config-read, hooks-list
  const sourceRows = epochReports.map((report) => ({
    label: report.label,
    instructionSources: report.instructionSources ?? null,
    unexpected: report.unexpectedInstructionSources ?? null,
    status: report.status,
  }));
  const observedSources = sourceRows.filter(
    (row) => row.instructionSources !== null,
  );
  const sourcesBad = sourceRows.some(
    (row) => (row.unexpected ?? []).length > 0,
  );
  rec(
    'launch.instruction-sources',
    'launch',
    observedSources.length === 0
      ? STATUS.blocked
      : sourcesBad
        ? STATUS.fail
        : STATUS.pass,
    {
      rows: sourceRows,
      codingControlSourcesTwin: codingTwin.instructionSources,
      note: 'Read from a twin thread/start (identical params, never run); only the global AGENTS.md / AGENTS.override.md are accepted.',
    },
  );
  const layersSummary = diagnosticsReport.initialConfigLayers;
  rec(
    'launch.config-read',
    'launch',
    Array.isArray(layersSummary) ? STATUS.pass : STATUS.blocked,
    {
      layers: layersSummary,
      ambientMcpServersDisabledByName: Object.keys(
        configRead?.config?.mcp_servers ?? {},
      ),
      epochCwdLayers: diagnosticsReport.epochCwd.configLayers,
    },
  );
  const hooksOk =
    diagnosticsReport.epochCwd.hooksList &&
    !diagnosticsReport.epochCwd.hooksList.error;
  const hookRuns =
    count(recorderCounts.afterFailure, 'hook') -
    count(recordersAfterControl, 'hook');
  rec(
    'launch.hooks-list',
    'launch',
    hooksOk && hookRuns === 0
      ? STATUS.pass
      : hooksOk
        ? STATUS.fail
        : STATUS.blocked,
    {
      control: diagnosticsReport.controlCwd.hooksList,
      epoch: diagnosticsReport.epochCwd.hooksList,
      hookRecorderInvocationsDuringBrowserThreads: hookRuns,
    },
  );

  // Inertness requirements (recorders), gated by control liveness.
  const delta = (name) =>
    count(recorderCounts.afterFailure, name) -
    count(recordersAfterControl, name);
  const gate = (id, inert, liveOk) =>
    inert ? (liveOk ? STATUS.pass : STATUS.blocked) : STATUS.fail;
  for (const phase of ['after-tools', 'completion'])
    rec(
      'close.codex-hooks-inert',
      phase,
      gate('hook', delta('hook') === 0, liveness.hook?.live),
      {
        hookRecorderDelta: delta('hook'),
        liveness: liveness.hook,
        note: 'blocked = the hook never ran even in the control (process-level features.hooks=false in the delegation profile), so inertness is by the profile flag, not shown to come from the thread overrides',
      },
    );
  const mcpAdvertised = surfaceEvidence
    .flatMap((row) => row.advertised ?? [])
    .filter((name) => /mcp|bap0_mcpuserconfig/i.test(name));
  for (const phase of ['before-inference', 'after-tools'])
    rec(
      'close.codex-mcp-inert',
      phase,
      gate(
        'mcp',
        delta('mcp') === 0 && mcpAdvertised.length === 0,
        liveness.mcpUserConfig?.live,
      ),
      {
        mcpRecorderDelta: delta('mcp'),
        mcpToolsAdvertised: mcpAdvertised,
        liveness: liveness.mcpUserConfig,
      },
    );
  rec(
    'close.codex-notify-inert',
    'completion',
    gate('notify', delta('notify') === 0, liveness.notify?.live),
    {
      notifyRecorderDelta: delta('notify'),
      liveness: liveness.notify,
      note: 'notify fires after a turn; counted after a 1.5 s settle per window',
    },
  );

  // close.ephemeral-rollouts
  rec(
    'close.ephemeral-rollouts',
    'completion',
    addedRollouts.length === 0 ? STATUS.pass : STATUS.fail,
    {
      rolloutFilesAdded: addedRollouts,
      allFilesAddedUnderCodexHome: addedFiles.map((file) => file.path),
      threadsStarted: threadIds.length,
      note: 'state/log databases may change; only sessions/rollout files are judged',
    },
  );

  // close.only-accepted-source per phase
  const sourcesOk = !sourcesBad && observedSources.length > 0;
  for (const phase of [
    'before-inference',
    'after-tools',
    'completion',
    'launch-failure',
  ]) {
    const statuses = phaseStatuses[phase];
    const aggregate = aggregateStatuses(
      statuses.length ? statuses : ['unobserved'],
    );
    const status =
      aggregate === 'pass' && !sourcesOk ? STATUS.blocked : toStatus(aggregate);
    rec('close.only-accepted-source', phase, status, {
      canaryStatuses: statuses,
      instructionSourcesOk: sourcesOk,
    });
  }

  // close.org-managed (existence only; contents are never read)
  const managedPaths = [
    '/etc/codex',
    '/etc/codex/config.toml',
    '/etc/codex/requirements.toml',
    '/etc/codex/managed_config.toml',
    '/Library/Application Support/Codex',
    '/Library/Managed Preferences',
  ];
  const present = managedPaths.filter((candidate) => existsSync(candidate));
  const layerTypes = (Array.isArray(layersSummary) ? layersSummary : []).map(
    (layer) => layer.source?.type,
  );
  const managedLayers = layerTypes.filter((type) =>
    ['mdm', 'system', 'enterpriseManaged'].includes(type),
  );
  rec(
    'close.org-managed',
    'launch',
    present.length > 0 ? STATUS.blocked : STATUS.unobserved,
    {
      existingPathsChecked: managedPaths,
      present,
      layerTypesReported: layerTypes,
      managedLayerTypes: managedLayers,
      note: 'Existence only; contents never read. Absence of these paths does not prove no MDM or cloud-managed layer, and organization policy cannot be reproduced here.',
    },
  );

  // launch.empty-cwd
  const cwdRows = epochReports.map((report) => ({
    label: report.label,
    dir: report.epochDir,
    emptyAfterTurn: report.emptyCwdAfterTurn ?? null,
  }));
  rec('launch.empty-cwd', 'launch', STATUS.pass, {
    rows: cwdRows.map(({ label, dir }) => ({ label, dir })),
    note: 'Each epoch dir created empty via newEpochDir (asserted outside every repository); removal is done by the orchestrator with the synthetic root.',
  });
  rec(
    'launch.empty-cwd',
    'completion',
    cwdRows.some((row) => row.emptyAfterTurn === false)
      ? STATUS.fail
      : cwdRows.some((row) => row.emptyAfterTurn === true)
        ? STATUS.pass
        : STATUS.unobserved,
    { rows: cwdRows },
  );

  // codex.warm-pool
  const codingPidsList = identity.coding?.pids ?? [];
  const allPids = [
    ...new Set([
      ...codingPidsList,
      ...startPids,
      ...epochReports.flatMap((report) => report.pids ?? []),
    ]),
  ];
  const ranEpochs = epochReports.filter((report) => report.threadId).length;
  const sameProcess =
    allPids.length === 1 && codingPidsList.length === 1 && ranEpochs > 0;
  rec('codex.warm-pool', 'run', sameProcess ? STATUS.pass : STATUS.fail, {
    codingThread: identity.coding,
    epochs: epochReports.map((report) => ({
      label: report.label,
      threadId: report.threadId,
      pids: report.pids,
    })),
    profileId: identity.profileId,
    distinctPids: allPids,
  });

  // rotation.*
  const sentinels = epochReports.map((report) => ({
    label: report.label,
    sentinel: report.sentinel,
  }));
  const rotationRows = [];
  let rotationStatus = STATUS.pass;
  epochWindows.forEach((window, index) => {
    const earlier = epochWindows
      .slice(0, index)
      .filter((candidate) => !candidate.failure);
    for (const previous of earlier) {
      const result = evaluateCanary(
        window.snapshot,
        previous.host.sentinel,
        'absent',
      );
      rotationRows.push({
        window: window.label,
        absentSentinelOf: previous.label,
        status: result.status,
        detail: result.detail,
      });
      rotationStatus = aggregateStatuses([
        rotationStatus,
        toStatus(result.status),
      ]);
    }
  });
  const ownPresent = browserWindows.map((window) => ({
    window: window.label,
    sentinelSeenInLaterRequests: laterOf(window).some(
      (summary) => summary.contains?.ownSentinel === true,
    ),
  }));
  if (ownPresent.some((row) => !row.sentinelSeenInLaterRequests))
    rotationStatus = aggregateStatuses([rotationStatus, STATUS.blocked]);
  rec(
    'rotation.old-canary-absent',
    'run',
    rotationRows.length === 0 ? STATUS.unobserved : rotationStatus,
    {
      rows: rotationRows,
      ownSentinelPresenceControl: ownPresent,
      sentinels,
      note: "blocked when an epoch's own sentinel never reached a later request (positive control for tool-result evidence)",
    },
  );
  const unique = new Set(threadIds).size === threadIds.length;
  rec('rotation.no-resume', 'run', unique ? STATUS.pass : STATUS.fail, {
    threadIds,
    note: 'Every thread came from startThread; resumeThread/forkThread are never called; all ids distinct.',
  });
  const loopRows = browserWindows.map((window) => ({
    window: window.label,
    status: window.report.status,
    toolCalls: window.host.calls.map((call) => call.tool),
    expected: [
      'observe',
      'read_text',
      'scroll',
      'observe',
      'record_progress',
      'finish',
    ],
    requests: window.analysis.summaries.length,
  }));
  const loopOk =
    loopRows.length === EPOCHS &&
    loopRows.every(
      (row) =>
        row.status === 'completed' &&
        JSON.stringify(row.toolCalls) === JSON.stringify(row.expected),
    );
  rec(
    'rotation.repeated-tools',
    'after-tools',
    loopOk ? STATUS.pass : STATUS.fail,
    { rows: loopRows },
  );

  // phase.*
  rec('phase.compaction', 'compaction', STATUS.unobserved, {
    reason:
      'Not exercised: the mock cannot force provider compaction and no compaction was triggered.',
  });
  rec('phase.restart', 'restart', STATUS.unobserved, {
    reason:
      'Not exercised: no application restart in this probe; the app-server process was never restarted (PID recorded).',
  });
  const failureStatuses = phaseStatuses['launch-failure'];
  const failureInduced =
    failureWindow && failureWindow.report.status !== 'completed';
  rec(
    'phase.launch-failure',
    'launch-failure',
    !failureWindow
      ? STATUS.unobserved
      : !failureInduced
        ? STATUS.blocked
        : toStatus(
            aggregateStatuses(
              failureStatuses.length ? failureStatuses : ['unobserved'],
            ),
          ),
    {
      turnStatus: failureWindow?.report.status,
      error: failureWindow?.report.error,
      requestsSeen: failureWindow?.report.requestCount,
      canaryStatuses: failureStatuses,
      note: 'blocked when the induced failure did not make the turn fail',
    },
  );

  // budget.pre-request
  rec('budget.pre-request', 'run', STATUS.unresolved, {
    reason:
      'No app-server pre-request hook for mid-turn tool-loop requests was found: generated protocol only offers user-config command hooks (userPromptSubmit once per turn, preToolUse/postToolUse per tool call) which the delegation profile disables (features.hooks=false) and which cannot see the assembled request.',
    measuredAlternative:
      'The host-owned dynamic-tool execute callback sees every tool result before it re-enters the context, so a host-side cumulative byte bound is possible; it is not a provider pre-request guarantee.',
    needed:
      'A request-assembly hook or a per-request byte/token ceiling enforced by the runtime, or a conservative host-side per-page/total result budget proven sufficient by these measurements.',
  });
}

function computeS02({ epochWindows, epochReports }) {
  const browser = epochWindows.filter((window) => !window.failure);
  const summaries = (window) => window.analysis.summaries;
  s02.firstRequestLatencyMs = {
    label: LABEL,
    perThread: epochReports.map((report) => ({
      label: report.label,
      ms: report.firstRequestMs ?? null,
      turnMs: report.turnMs ?? null,
    })),
  };
  const warm = (s02.sessionStart?.warm ?? []).map(
    (entry) => entry.startThreadMs,
  );
  rec(
    's02.session-start',
    'run',
    warm.length > 0 && s02.sessionStart ? STATUS.measured : STATUS.unobserved,
    {
      ...s02.sessionStart,
      warmStartThreadMs: warm,
      coldVsWarmNote:
        'cold includes app-server spawn, initialize, config/read, canonical checks and a twin thread/start',
    },
  );
  const overhead = browser.map((window) => ({
    label: window.label,
    firstRequest: harnessOverhead(summaries(window)[0]),
  }));
  s02.harnessOverhead = {
    label: LABEL,
    perEpoch: overhead,
    toolSchemaDefinitions: schemaOverheadSummary(),
  };
  rec(
    's02.harness-overhead',
    'run',
    overhead.some((row) => row.firstRequest)
      ? STATUS.measured
      : STATUS.unobserved,
    s02.harnessOverhead,
  );
  const growth = browser.map((window) => ({
    label: window.label,
    series: window.analysis.growth,
    toolCalls: window.host.calls.map(
      ({ tool, argumentBytes, resultBytes }) => ({
        tool,
        argumentBytes,
        resultBytes,
      }),
    ),
    classBytesByRequest: summaries(window).map((summary) => ({
      seq: summary.seq,
      totalBytes: summary.totalBytes,
      effective: summary.effective,
      classBytes: summary.classBytes,
      toolCount: summary.toolCount,
    })),
  }));
  s02.pageGrowth = { label: LABEL, perEpoch: growth };
  rec(
    's02.page-growth',
    'run',
    growth.some((row) => row.series.length > 1)
      ? STATUS.measured
      : STATUS.unobserved,
    s02.pageGrowth,
  );
  const accounting = epochReports.map((report) => {
    const window = epochWindows.find(
      (candidate) => candidate.label === report.label,
    );
    const last = window ? summaries(window).at(-1) : null;
    return {
      label: report.label,
      providerReportedViaAppServer: {
        synthetic: true,
        source:
          'scripted/default usage from the mock relayed by the app-server; unrelated to request bytes',
        usage: report.usage,
        tokenUsageEvents: report.tokenUsageEvents,
      },
      byteEstimate: last?.effectiveBytes
        ? {
            estimate: true,
            lastRequestBytes: last.effectiveBytes,
            tokensAt4BytesPerToken: Math.ceil(last.effectiveBytes / 4),
            tokensAt3BytesPerToken: Math.ceil(last.effectiveBytes / 3),
          }
        : null,
    };
  });
  s02.tokenAccounting = { label: LABEL, perThread: accounting };
  rec(
    's02.token-accounting',
    'run',
    accounting.length > 0 ? STATUS.measured : STATUS.unobserved,
    s02.tokenAccounting,
  );
  // Guard from the first browser epoch that has a full loop.
  const loop = browser.find((window) => window.analysis.growth.length >= 6);
  if (!loop) {
    rec('s02.guard-recommendation', 'run', STATUS.unresolved, {
      reason:
        'no epoch completed enough requests to measure baseline/observation/receipt growth',
    });
    return;
  }
  const g = loop.analysis.growth;
  const baselineBytes = g[0].effectiveBytes;
  const observationBytes = g[1].addedBytes; // request after the first observe
  const receiptBytes = [g[3]?.addedBytes, g[5]?.addedBytes].filter((n) =>
    Number.isFinite(n),
  );
  const receiptStepBytes = receiptBytes.length
    ? Math.round(receiptBytes.reduce((a, b) => a + b, 0) / receiptBytes.length)
    : null;
  const guard = recommendGuard({
    baselineBytes,
    observationBytes,
    receiptStepBytes,
  });
  s02.guardRecommendation = {
    label: LABEL,
    basedOn: loop.label,
    baselineBytes,
    observationBytes,
    receiptStepBytes,
    guard,
  };
  rec(
    's02.guard-recommendation',
    'run',
    guard.status === 'measured' ? STATUS.measured : STATUS.unresolved,
    s02.guardRecommendation,
  );
}

let exitCode = EXIT.ok;
try {
  const early = await main();
  if (early !== null && early !== undefined) exitCode = early;
} catch (error) {
  notes.push(`probe error: ${errText(error)}`);
  exitCode = EXIT.crash;
} finally {
  await shutdownAll();
  const pidCheck = await pidsGone(state.pids);
  identity.appServerPidsAtExit = {
    checked: [...state.pids],
    gone: pidCheck.gone,
    alive: pidCheck.alive,
  };
  if (!pidCheck.gone)
    notes.push(
      `app-server PID(s) still alive after shutdown: ${pidCheck.alive.join(', ')}`,
    );
  if (state.cap)
    await withTimeout(state.cap.close(), 10_000, 'capture.close').catch(
      (error) => notes.push(`capture.close: ${errText(error)}`),
    );
  let finalized = null;
  try {
    finalized = await writeFinalReport();
  } catch (error) {
    process.stderr.write(`report write failed: ${errText(error)}\n`);
    exitCode = EXIT.crash;
  }
  if (exitCode === EXIT.ok && finalized?.failed)
    exitCode = EXIT.requirementFailed;
  process.exit(exitCode);
}
