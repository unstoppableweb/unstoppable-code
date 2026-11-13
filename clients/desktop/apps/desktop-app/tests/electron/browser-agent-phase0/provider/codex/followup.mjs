#!/usr/bin/env node
// Codex follow-up comparison (October 2 plan). Spawned by
// `provider-probe.mjs --follow-up --provider codex` only, with the synthetic
// HOME/CODEX_HOME, the sandboxed network envelope and the hard deadline.
// Do not run directly. The original run.mjs and its history are untouched.
//
// One CodexRuntimeService (the normal pooled launch path, unchanged restricted
// profile, no process-config or home change) serves seven thread-scoped arms:
// see followup-variants.mjs. Planning evidence only: scripted loopback
// replies, no real model, tokenizer, account or release-performance claim.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
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
  HOST_ENV_CANARY_NAME,
  readRecorderInvocations,
  writeRecorderScript,
} from '../shared/canaries.mjs';
import { checkProbeEnv, isLoopbackUrl } from '../shared/child-env.mjs';
import {
  registerScenario,
  startCapture,
  writeSnapshot,
} from '../shared/capture.mjs';
import { CONTEXT_CHECKPOINT_TOKENS } from '../shared/followup-policy.mjs';
import { STATUS, createLedger } from '../shared/ledger.mjs';
import { isInside, listFiles } from '../shared/synthetic-root.mjs';
import { planFixtures, writeFixtures } from './config-fixture.mjs';
import {
  PROBE_CONFIG_ARGS,
  checkDelegationProfileDrift,
} from './drift-guard.mjs';
import { createCustomCallRewriter } from './custom-call-rewriter.mjs';
import { evaluateFollowUp, summarizeArm } from './followup-evaluate.mjs';
import {
  ARM_IDS,
  armAllowedTools,
  armDefinition,
  armScenario,
  armThreadParams,
  wrapperProbeSource,
} from './followup-variants.mjs';
import { inspectProcessEnvironment } from './process-env.mjs';
import { createEpochToolHost, markerFor, newNonce } from './scenario.mjs';
import { isGenerationRecord } from './request-breakdown.mjs';
import { PROBE_MODEL, PROBE_PROVIDER } from './thread-params.mjs';

const execFileAsync = promisify(execFile);
const LABEL = 'mock/loopback, not release performance';
const PROVIDER = 'codex';
const SETTLE_MS = 2_000;
const ARM_TURN_TIMEOUT_MS = 40_000;
const MIN_ARM_BUDGET_MS = 25_000;
const CONFIG_KEYS_OBSERVED = Object.freeze([
  'model_context_window',
  'model_auto_compact_token_limit',
  'model_auto_compact_token_limit_scope',
  'model_post_turn_compact_threshold_percent',
]);

/** Claims taken from strings in the pinned binary, not from a documented API. */
const INFERENCES = Object.freeze([
  {
    claim:
      'The bundled model catalog marks gpt-6-* and gpt-5.6-* models tool_mode=code_mode_only and gpt-5.5 tool_mode=null.',
    source:
      'Catalog JSON embedded as strings in the pinned codex binary under .cache/bin/<target>/codex (extracted with strings).',
    status:
      'inference until the native arms agree (baseline vs direct-model surfaces)',
  },
  {
    claim:
      'A [code_mode] config table accepts direct_only_tool_namespaces and excluded_tool_namespaces.',
    source:
      'CodeModeConfigToml field names in the same binary strings; thread config key code_mode.direct_only_tool_namespaces.',
    status:
      'inference until the namespaced-direct arm shows the namespace advertised top-level',
  },
  {
    claim:
      'Helper feature toggles (default_mode_request_user_input, send_async_message, ...) exist as features.* keys.',
    source: 'Feature-name list in the same binary strings.',
    status:
      'inference; the toggles-context arm compares surfaces but cannot attribute a change to one key',
  },
  {
    claim:
      'A thread-level notify = [] override suppresses the user-config notify command.',
    source:
      'Top-level notify key in the user config; no documentation consulted.',
    status: 'inference until the notify arms agree',
  },
]);

const REPLY_TRANSFORMATION = Object.freeze({
  testOnly: true,
  description:
    'A loopback pass-through between Codex and the capture listener converts exactly one scripted function_call (arguments { "__custom_input": text } for the exec tool) into a custom_tool_call on the reply path, because the shared mock can only script function_call items.',
  requestPath:
    'Requests are forwarded byte for byte; the capture listener records what Codex sent (asserted in unit tests; byte and request counts reconciled below).',
  notA: 'This is not a production filtering or policy proxy, not a model proxy and not part of any product path.',
});

const startedAtMs = Date.now();
const ctx = loadChildContext(PROVIDER);
const { layout, outputDir, deadlineMs, canaries, manifest } = ctx;
const ledger = createLedger(PROVIDER, { followUp: true });
const rec = (id, phase, status, evidence) =>
  ledger.record(id, phase, status, evidence);

const notes = [
  `All numbers are ${LABEL}. Follow-up planning evidence only; no production, model-quality, tokenizer or account claim.`,
];
const artifacts = [];
const listenPorts = [];
const identity = { pins: EXPECTED_PINS, arms: [] };
const followUp = {
  schema: 'browser-agent-phase0-codex-followup/v1',
  inferences: INFERENCES,
  replyTransformation: REPLY_TRANSFORMATION,
  contextCheckpointTokens: CONTEXT_CHECKPOINT_TOKENS,
};
const state = {
  service: null,
  cap: null,
  rewriter: null,
  escapeServer: null,
  handles: [],
  pids: new Set(),
  summaries: [],
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
const toLedgerStatus = (value) =>
  Object.values(STATUS).includes(value) ? value : STATUS.unobserved;

async function saveArtifact(name, value) {
  await writeArtifact(outputDir, name, value);
  artifacts.push(name);
}

async function writeFinalReport(extraNotes = []) {
  if (state.finished) return null;
  state.finished = true;
  const finalized = ledger.finalize(
    'not part of the follow-up comparison; the original run covers it',
  );
  const report = buildReport({
    provider: PROVIDER,
    ledger: finalized,
    listenPorts,
    identity,
    s02: { label: LABEL },
    followUp: {
      ...followUp,
      arms: state.summaries,
      rewriterStats: state.rewriter?.stats ?? null,
    },
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
  const alive = () =>
    [...pids].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (alive().length === 0) return { gone: true, alive: [] };
    await sleep(250);
  }
  return { gone: false, alive: alive() };
}

armChildDeadline(deadlineMs, async () => {
  notes.push('child deadline reached; partial report');
  await writeFinalReport().catch(() => {});
  await shutdownAll();
});

/** Loopback target for the wrapper's fetch attempt; counts every hit. */
async function startEscapeListener() {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url ?? '');
    response.end('escape-listener');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, hits, port: server.address().port };
}

async function main() {
  // 1. Listeners ----------------------------------------------------------
  const cap = await startCapture();
  state.cap = cap;
  listenPorts.push(cap.port);
  const rewriter = createCustomCallRewriter({
    upstreamPort: cap.port,
    toolNames: ['exec'],
  });
  state.rewriter = rewriter;
  await new Promise((resolve, reject) => {
    rewriter.server.once('error', reject);
    rewriter.server.listen(0, '127.0.0.1', resolve);
  });
  const rewriterPort = rewriter.server.address().port;
  listenPorts.push(rewriterPort);
  const baseUrl = `http://127.0.0.1:${rewriterPort}`;
  const escape = await startEscapeListener();
  state.escapeServer = escape.server;
  listenPorts.push(escape.port);
  const { capture } = cap;

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

  // 2. Runtime + profile (unchanged restricted delegation profile) -----------
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
  rec('canonical.pool-profile', 'launch', toLedgerStatus(drift.status), {
    profile,
    profileId,
    drift,
    note: 'Same re-declared production delegation profile as the original run; no process config change in any arm.',
  });

  const binaryPath = getBundledCodexBinaryPath();
  identity.binaryPath = binaryPath;
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
  rec(
    'canonical.pins',
    'launch',
    isInside(path.join(REPO_ROOT, '.cache', 'bin'), binaryPath) &&
      versionText.includes(EXPECTED_PINS.codexCli)
      ? STATUS.pass
      : STATUS.fail,
    {
      binaryPath,
      version: versionText,
      expected: EXPECTED_PINS.codexCli,
      versionError,
    },
  );

  const service = pick(
    runtime,
    'createCodexRuntimeService',
  )({
    capabilityStore: new (pick(runtime, 'CodexCapabilityStore'))(
      path.join(layout.canopyDataDir, 'codex-capabilities'),
    ),
  });
  state.service = service;
  const admin = service.admin();
  const request = (method, params, label = method, timeoutMs = 45_000) =>
    withTimeout(admin.request(method, params, profile), timeoutMs, label);

  // 3. Canonical-state verification BEFORE any turn ---------------------------
  const precondition = { failures: [] };
  const failPrecondition = (id, evidence) => {
    precondition.failures.push(id);
    rec(id, 'launch', STATUS.fail, evidence);
  };
  let configRead = null;
  try {
    configRead = await request('config/read', {
      cwd: await layout.newEpochDir('config-read'),
      includeLayers: true,
    });
  } catch (error) {
    failPrecondition('canonical.home', {
      error: errText(error),
      step: 'config/read',
    });
  }
  const ambientMcpServerNames = Object.keys(
    configRead?.config?.mcp_servers ?? {},
  );
  identity.ambientMcpServerNames = ambientMcpServerNames;
  if (configRead) {
    const observedHome = pick(runtime, 'getObservedCanonicalCodexHome')();
    const expectedHome = realpathSync.native(layout.codexHome);
    identity.observedCodexHome = observedHome;
    if (
      observedHome !== null &&
      observedHome === expectedHome &&
      isInside(layout.root, observedHome)
    )
      rec('canonical.home', 'launch', STATUS.pass, {
        observedHome,
        expectedHome,
      });
    else failPrecondition('canonical.home', { observedHome, expectedHome });

    const config = configRead.config ?? {};
    const userLayer = (configRead.layers ?? []).find(
      (layer) => layer?.name?.type === 'user',
    );
    const providerEntry =
      config.model_providers?.probe ??
      userLayer?.config?.model_providers?.probe;
    const baseUrlEffective = providerEntry?.base_url;
    const nonLoopbackOther = Object.entries(config)
      .filter(
        ([key, value]) => /base_url$/.test(key) && typeof value === 'string',
      )
      .filter(([, value]) => !isLoopbackUrl(value))
      .map(([key]) => key);
    const providerEvidence = {
      model_provider: config.model_provider,
      probeBaseUrl: baseUrlEffective,
      expected: `${baseUrl}/v1`,
      nonLoopbackOther,
      note: 'Provider URL is the test-only rewriter, which forwards to the capture listener; both are loopback.',
    };
    if (
      config.model_provider === PROBE_PROVIDER &&
      baseUrlEffective === `${baseUrl}/v1` &&
      isLoopbackUrl(baseUrlEffective) &&
      nonLoopbackOther.length === 0
    )
      rec('canonical.provider-url', 'launch', STATUS.pass, providerEvidence);
    else failPrecondition('canonical.provider-url', providerEvidence);

    followUp.configObservation = Object.fromEntries(
      CONFIG_KEYS_OBSERVED.map((key) => [key, config[key] ?? null]),
    );
  }

  const pidSnapshot = () =>
    admin
      .getResourceSnapshots()
      .map((snap) => snap.pid)
      .filter((pid) => Number.isInteger(pid));
  const startPids = pidSnapshot();
  startPids.forEach((pid) => state.pids.add(pid));
  identity.appServerPidsAtStart = startPids;
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
  let psBlocked = startPids.length === 0;
  for (const pid of startPids) {
    try {
      const { stdout } = await execFileAsync(
        '/bin/ps',
        ['-wwE', '-p', String(pid), '-o', 'command='],
        {
          timeout: 10_000,
          maxBuffer: 4 * 1024 * 1024,
        },
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
  const authFiles = (await listFiles(layout.codexHome)).filter((file) =>
    /(^|\/)auth\.json$/.test(file.path),
  );
  credentialEvidence.credentialFilesInCodexHome = authFiles.map(
    (file) => file.path,
  );
  if (
    !childEnvCheck.ok ||
    credentialEvidence.processes.some((proc) => proc.status === 'fail') ||
    authFiles.length > 0
  )
    failPrecondition('canonical.no-credentials', credentialEvidence);
  else if (psBlocked)
    rec('canonical.no-credentials', 'launch', STATUS.blocked, {
      ...credentialEvidence,
      reason:
        'child env clean and no auth files; app-server environment not readable through ps -E',
    });
  else
    rec('canonical.no-credentials', 'launch', STATUS.pass, credentialEvidence);

  if (precondition.failures.length > 0) {
    notes.push(
      `Canonical-state precondition failed (${precondition.failures.join(', ')}); no turn was sent.`,
    );
    return EXIT.preconditionFailed;
  }

  // 4. Arms ---------------------------------------------------------------------
  const flatten = pick(runtime, 'flattenCodexThreadConfig');
  async function twinStart(params, label) {
    const response = await request(
      'thread/start',
      { ...params, config: flatten(params.config, { resetMcpServers: true }) },
      `thread/start twin ${label}`,
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
      instructionSources: response.instructionSources,
    };
  }

  const reconciliation = { captureReceived: 0, captureBodyBytes: 0 };
  const accumulate = (snapshot) => {
    reconciliation.captureReceived += snapshot.counts?.received ?? 0;
    reconciliation.captureBodyBytes += snapshot.records
      .filter((record) => record.kind === 'http')
      .reduce((sum, record) => sum + (record.byteLength ?? 0), 0);
  };
  const notifyCount = async () =>
    ((await readRecorderInvocations(layout.records)).notify ?? []).length;
  const generationsSeenNow = () =>
    capture.snapshot().records.filter(isGenerationRecord).length;

  async function runTurn({ handle, marker, scenario, text, hostToolPolicy }) {
    registerScenario(marker, scenario);
    const eventMethods = [];
    const tokenUsageEvents = [];
    const budget = Math.min(
      ARM_TURN_TIMEOUT_MS,
      Math.max(10_000, timeLeftMs() - 15_000),
    );
    let outcome = null;
    let turnError = null;
    try {
      outcome = await withTimeout(
        handle.runTurn({
          input: [
            { type: 'text', text: `[${marker}] ${text}`, text_elements: [] },
          ],
          totalTimeoutMs: budget,
          startupTimeoutMs: 30_000,
          onEvent: (event) => {
            eventMethods.push(event.method);
            if (event.method === 'thread/tokenUsage/updated')
              tokenUsageEvents.push(event.params?.tokenUsage ?? null);
          },
          ...(hostToolPolicy ? { hostToolPolicy } : {}),
        }),
        budget + 15_000,
        `runTurn ${marker}`,
      );
    } catch (error) {
      turnError = errText(error);
    }
    return { outcome, turnError, eventMethods, tokenUsageEvents };
  }

  async function runArm(id) {
    const definition = armDefinition(id);
    const marker = markerFor(id);
    const spawnMarker = path.join(layout.records, `spawn-marker-${id}`);
    const loopbackPath = `/escape-${id}`;
    const epochDir = await layout.newEpochDir(`arm-${id}`);
    const input = {
      epochDir,
      project: layout.project,
      baseUrl,
      ambientMcpServerNames,
    };
    const armNotes = [];
    let params = armThreadParams(id, input);
    let twin = null;
    let twinError = null;
    const attempt = async (candidate, label) => {
      try {
        return await twinStart(candidate, label);
      } catch (error) {
        if (
          /runtimeWorkspaceRoots/i.test(errText(error)) &&
          candidate.runtimeWorkspaceRoots
        ) {
          armNotes.push(
            `${id}: runtimeWorkspaceRoots rejected by the pinned build; retried without it.`,
          );
          const { runtimeWorkspaceRoots: _dropped, ...rest } = candidate;
          params = rest;
          return twinStart(rest, `${label}-no-roots`);
        }
        throw error;
      }
    };
    try {
      twin = await attempt(params, id);
    } catch (error) {
      twinError = errText(error);
      if (id === 'toggles-context') {
        armNotes.push(
          `${id}: full helper-toggle list rejected (${twinError}); retrying with the minimal subset.`,
        );
        params = armThreadParams(id, input, { minimalToggles: true });
        try {
          twin = await attempt(params, `${id}-minimal`);
          twinError = null;
        } catch (retryError) {
          twinError = errText(retryError);
        }
      }
    }
    const emptySnapshot = { records: [], counts: {} };
    if (!twin) {
      notes.push(`${id}: thread/start failed (${twinError}); arm not run.`);
      const summary = summarizeArm({
        id,
        snapshot: emptySnapshot,
        hostCalls: [],
        wrapperEvidence: {
          hostCanary: canaries.hostFile,
          envCanary: canaries.hostEnvironment,
          spawnMarkerExists: false,
          loopbackHits: 0,
        },
        notifyDelta: null,
        eventMethods: [],
        tokenUsageEvents: [],
        turn: { status: 'not-run', error: twinError },
        twin: null,
      });
      return { ...summary, armNotes, requested: params.model };
    }
    // The reported model must equal the requested one: no silent fallback.
    if (twin.model !== definition.model)
      armNotes.push(
        `${id}: runtime reported model ${twin.model}, requested ${definition.model}.`,
      );

    const hostCalls = [];
    let hostPolicy;
    if (definition.kind === 'browser') {
      const host = createEpochToolHost({
        epoch: ARM_IDS.indexOf(id) + 1,
        nonce: newNonce(),
      });
      hostPolicy = {
        allowedTools: armAllowedTools(id),
        authorize: async () => true,
        timeoutMs: 30_000,
        execute: async (call) => {
          hostCalls.push({
            tool: call.tool,
            namespace: call.namespace ?? null,
            generationsSeen: generationsSeenNow(),
          });
          // The epoch host validates names without namespaces; the policy
          // above already enforced the namespace for this arm.
          return host.execute({ ...call, namespace: null });
        },
      };
    }
    const wrapperSource = wrapperProbeSource({
      hostFile: manifest.hostFile,
      envName: HOST_ENV_CANARY_NAME,
      spawnMarker,
      loopbackUrl: `http://127.0.0.1:${escape.port}${loopbackPath}`,
    });
    const scenario = armScenario(id, { wrapperSource });
    const notifyBefore = await notifyCount();
    let handle = null;
    let turn = {
      outcome: null,
      turnError: null,
      eventMethods: [],
      tokenUsageEvents: [],
    };
    try {
      handle = await withTimeout(
        service.startThread({
          capabilitySnapshotId: `bap0-followup-${id}`,
          capabilityLeaseKind: 'ephemeral',
          profile,
          params,
        }),
        60_000,
        `${id} startThread`,
      );
      state.handles.push(handle);
      const pids = pidSnapshot();
      pids.forEach((pid) => state.pids.add(pid));
      identity.arms.push({
        id,
        threadId: handle.threadId,
        pids,
        model: twin.model,
      });
      turn = await runTurn({
        handle,
        marker,
        scenario,
        text: `Follow-up probe ${id}. Follow the scripted tool loop.`,
        hostToolPolicy: hostPolicy,
      });
    } catch (error) {
      turn.turnError = errText(error);
    }
    await sleep(SETTLE_MS);
    const snapshot = capture.snapshot();
    await writeSnapshot(
      path.join(outputDir, `capture-arm-${id}.json`),
      snapshot,
    );
    artifacts.push(`capture-arm-${id}.json`);
    accumulate(snapshot);
    capture.reset();
    const notifyAfter = await notifyCount();
    const summary = summarizeArm({
      id,
      snapshot,
      hostCalls,
      wrapperEvidence: {
        hostCanary: canaries.hostFile,
        envCanary: canaries.hostEnvironment,
        spawnMarkerExists: existsSync(spawnMarker),
        loopbackHits: escape.hits.filter((hit) => hit.startsWith(loopbackPath))
          .length,
      },
      notifyDelta: notifyAfter - notifyBefore,
      eventMethods: turn.eventMethods,
      tokenUsageEvents: turn.tokenUsageEvents,
      turn: {
        status: turn.outcome?.status ?? 'error',
        error: turn.turnError ?? turn.outcome?.error ?? null,
      },
      twin,
    });
    return { ...summary, armNotes, requested: params.model };
  }

  for (const id of ARM_IDS) {
    if (timeLeftMs() < MIN_ARM_BUDGET_MS) {
      notes.push(`${id} skipped: child time budget exhausted.`);
      continue;
    }
    let result;
    try {
      result = await runArm(id);
    } catch (error) {
      notes.push(`${id}: arm failed unexpectedly (${errText(error)}).`);
      continue;
    }
    state.summaries.push(result);
    await saveArtifact(`arm-${id}.json`, result);
  }

  // 5. Evidence integrity ---------------------------------------------------------
  accumulate(capture.snapshot());
  followUp.reconciliation = {
    proxyRequests: rewriter.stats.requests,
    proxyRequestBodyBytes: rewriter.stats.requestBodyBytes,
    captureReceived: reconciliation.captureReceived,
    captureBodyBytes: reconciliation.captureBodyBytes,
    upgrades: rewriter.stats.upgrades,
    requestsMatch: rewriter.stats.requests === reconciliation.captureReceived,
    bytesMatch:
      rewriter.stats.requestBodyBytes === reconciliation.captureBodyBytes,
    note: 'Every request Codex sent reaches the recorder unchanged; a mismatch or any WebSocket upgrade (tunnelled raw, not rewritable) weakens the exec evidence.',
  };
  followUp.escapeListenerHits = escape.hits.slice(0, 20);

  // 6. Ledger -----------------------------------------------------------------------
  const allPids = [
    ...new Set([...startPids, ...identity.arms.flatMap((arm) => arm.pids)]),
  ];
  rec(
    'codex.warm-pool',
    'run',
    identity.arms.length > 0 && allPids.length === 1
      ? STATUS.pass
      : STATUS.fail,
    {
      arms: identity.arms,
      distinctPids: allPids,
      profileId,
      note: 'All arms, including the notify suppression, ran on one pooled app-server process.',
    },
  );
  const baseline = state.summaries.find((summary) => summary.id === 'baseline');
  if (baseline)
    rec(
      'canonical.no-model-fallback',
      'launch',
      baseline.modelMatches === true ? STATUS.pass : STATUS.fail,
      {
        requested: PROBE_MODEL,
        reported: baseline.model,
        allowProviderModelFallback: false,
        note: 'Checked on the baseline arm; direct-model reports its own match flag in the surface matrix.',
      },
    );
  for (const row of evaluateFollowUp(state.summaries, {
    threshold: CONTEXT_CHECKPOINT_TOKENS,
    configObservation: followUp.configObservation ?? null,
  }))
    rec(row.id, row.phase, toLedgerStatus(row.status), row.evidence);
  if (
    !followUp.reconciliation.requestsMatch ||
    !followUp.reconciliation.bytesMatch
  )
    notes.push(
      'Proxy and capture counts differ; treat the exec reply evidence as incomplete.',
    );
  if (rewriter.stats.rewrittenItems === 0)
    notes.push(
      'No scripted custom_tool_call was delivered; wrapper execution is unobserved.',
    );
  return null;
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
  if (state.rewriter)
    await withTimeout(state.rewriter.close(), 10_000, 'rewriter.close').catch(
      (error) => notes.push(`rewriter.close: ${errText(error)}`),
    );
  if (state.escapeServer)
    await withTimeout(
      new Promise((resolve) => {
        state.escapeServer.closeAllConnections?.();
        state.escapeServer.close(() => resolve());
      }),
      10_000,
      'escape.close',
    ).catch((error) => notes.push(`escape.close: ${errText(error)}`));
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
