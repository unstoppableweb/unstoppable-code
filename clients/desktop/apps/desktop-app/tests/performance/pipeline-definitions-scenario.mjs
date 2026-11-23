// Pipeline definition reads and writes (CAN-7510): many user workflows, then
// repeated `pipelines:list`, `pipelines:get`, `pipelines:save` (an update of
// an existing workflow), `pipelines:duplicate` and
// `preferences:set-pipeline-disabled` (turning a workflow off and on) calls
// from the renderer.
//
// It times, in the running app, each call's main handler and renderer round
// trip, and for each write the slowest renderer-to-main ping overlapping it
// (the main-thread block it caused), and Electron main's event-loop delay
// over the whole measured window. It reuses the Code Review registry
// workload's handler probe and main ping. Nothing here depends on whether
// main serves the definitions in process or through the daemon, so the same
// driver measures both. No step runs and no agent or model is called.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  codeReviewRegistryProbeMain,
  startMainPingRenderer,
  stopMainPingRenderer,
} from './code-review-registry-scenario.mjs';
import { writeJson } from '../electron/seeders/fsHelpers.mjs';

export const PIPELINE_DEFINITIONS_SCENARIO = 'pipeline-definitions';

const LIST_CHANNEL = 'pipelines:list';
const GET_CHANNEL = 'pipelines:get';
const SAVE_CHANNEL = 'pipelines:save';
const DUPLICATE_CHANNEL = 'pipelines:duplicate';
const DELETE_CHANNEL = 'pipelines:delete';
const ENABLE_CHANNEL = 'preferences:set-pipeline-disabled';
const PROBE_GLOBAL = '__canopyPipelineDefinitionsProbe';
const PING_GLOBAL = '__canopyPipelineDefinitionsPing';
const LOOP_DELAY_GLOBAL = '__canopyPipelineDefinitionsLoopDelay';
const STAMP = '2026-11-01T00:00:00.000Z';
const SAMPLE_PAUSE_MS = 250;
// A ping is in flight before the write starts, and pings either side of a
// short write still bracket it.
const PING_LEAD_MS = 100;
const PING_WINDOW_PAD_MS = 50;
const WRITE_TIMEOUT_MS = 120_000;

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
}

// UUID-length, as the store names a user workflow, so the index has the
// field's size per entry.
function definitionId(index) {
  return `perfdef0-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function definitionName(index) {
  return `Perf definition ${String(index).padStart(4, '0')}`;
}

function definitionYaml(name, index) {
  return [
    `name: ${name}`,
    'on: dispatch',
    'jobs:',
    '  main:',
    '    steps:',
    '      - id: note',
    `        run: echo definition-${index}`,
    '',
  ].join('\n');
}

/**
 * Seeds `pipelineDefinitions` user workflows: each a YAML document and its
 * `pipelines/index.json` entry, in the fields the store writes. The first is
 * the one every get, save and duplicate names.
 */
export function preparePipelineDefinitions(userDataDir, config) {
  const definitions = positiveInteger(
    config.pipelineDefinitions,
    'pipelineDefinitions',
  );
  const samples = positiveInteger(
    config.pipelineDefinitionSamples,
    'pipelineDefinitionSamples',
  );
  const pipelinesDir = path.join(userDataDir, 'pipelines');
  mkdirSync(pipelinesDir, { recursive: true });
  const entries = [];
  for (let index = 0; index < definitions; index += 1) {
    const id = definitionId(index);
    const name = definitionName(index);
    const filename = `${id}.yaml`;
    writeFileSync(
      path.join(pipelinesDir, filename),
      definitionYaml(name, index),
      'utf8',
    );
    entries.push({
      id,
      name,
      filename,
      description: '',
      icon: '',
      createdAt: STAMP,
      updatedAt: STAMP,
      revision: 1,
      triggerTypes: ['dispatch'],
      stepCount: 1,
      scopes: ['global'],
    });
  }
  writeJson(path.join(pipelinesDir, 'index.json'), {
    version: 1,
    pipelines: entries,
  });
  return {
    definitions,
    samples,
    targetId: definitionId(0),
    targetName: definitionName(0),
  };
}

function installProbe(electronApp) {
  return electronApp.evaluate(codeReviewRegistryProbeMain, {
    fsTrace: false,
    probeGlobal: PROBE_GLOBAL,
    channels: [
      LIST_CHANNEL,
      GET_CHANNEL,
      SAVE_CHANNEL,
      DUPLICATE_CHANNEL,
      DELETE_CHANNEL,
      ENABLE_CHANNEL,
    ],
    // The registry probe reads a purge request's container id; no channel here.
    purgeChannel: null,
  });
}

/** Starts Electron main's event-loop delay histogram (10 ms resolution). */
function startMainLoopDelay(electronApp) {
  return electronApp.evaluate((_electron, loopGlobal) => {
    const { monitorEventLoopDelay } =
      process.getBuiltinModule('node:perf_hooks');
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    globalThis[loopGlobal] = histogram;
  }, LOOP_DELAY_GLOBAL);
}

/** Drops what the histogram recorded so far, so warm-up stays out of it. */
function resetMainLoopDelay(electronApp) {
  return electronApp.evaluate((_electron, loopGlobal) => {
    globalThis[loopGlobal].reset();
  }, LOOP_DELAY_GLOBAL);
}

/** Stops the histogram and answers its p99 and max in milliseconds. */
function stopMainLoopDelay(electronApp) {
  return electronApp.evaluate((_electron, loopGlobal) => {
    const histogram = globalThis[loopGlobal];
    histogram.disable();
    delete globalThis[loopGlobal];
    return {
      p99Ms: histogram.percentile(99) / 1e6,
      maxMs: histogram.max / 1e6,
      count: histogram.count,
    };
  }, LOOP_DELAY_GLOBAL);
}

function probeLength(electronApp) {
  return electronApp.evaluate(
    (_electron, probeGlobal) => globalThis[probeGlobal].ipc.length,
    PROBE_GLOBAL,
  );
}

function probeEntriesSince(electronApp, from) {
  return electronApp.evaluate(
    (_electron, { probeGlobal, from }) =>
      globalThis[probeGlobal].ipc.slice(from).map((entry) => ({ ...entry })),
    { probeGlobal: PROBE_GLOBAL, from },
  );
}

/** The one ended handler entry of `channel` among `entries`. */
function singleHandler(entries, channel, label) {
  const matching = entries.filter((entry) => entry.channel === channel);
  if (matching.length !== 1)
    throw new Error(
      `${label}: expected one ${channel} handler call, saw ${matching.length}`,
    );
  const [entry] = matching;
  if (entry.endedAt === null)
    throw new Error(`${label}: the ${channel} handler had not finished`);
  if (!entry.ok)
    throw new Error(`${label}: the ${channel} handler failed: ${entry.error}`);
  return entry;
}

/** Runs in the renderer: one timed list and how many user workflows it had. */
async function listInRenderer() {
  const startedAt = performance.now();
  const result = await window.pipelines.list();
  const roundTripMs = performance.now() - startedAt;
  if (!result.success)
    return { error: result.error ?? 'pipelines:list failed' };
  return {
    roundTripMs,
    listed: result.data.filter((row) => row.source === 'user').length,
  };
}

/** Runs in the renderer: one timed get of the target workflow. */
async function getInRenderer({ id }) {
  const startedAt = performance.now();
  const result = await window.pipelines.get({ id, source: 'user' });
  const roundTripMs = performance.now() - startedAt;
  if (!result.success) return { error: result.error ?? 'pipelines:get failed' };
  return {
    roundTripMs,
    name: result.data.content.name,
    revision: result.data.info?.revision ?? null,
  };
}

/**
 * Runs in the renderer: reads the target, then times a save that renames it
 * under the revision it read (epoch ms bound the write for the pings).
 */
async function saveInRenderer({ id, name }) {
  const loaded = await window.pipelines.get({ id, source: 'user' });
  if (!loaded.success)
    return { error: loaded.error ?? 'pipelines:get failed before a save' };
  const { info } = loaded.data;
  const content = { ...loaded.data.content, name };
  const startedAt = performance.now();
  const result = await window.pipelines.save({
    id,
    name,
    description: info?.description ?? '',
    icon: info?.icon ?? '',
    content,
    ...(typeof info?.revision === 'number' && {
      expectedRevision: info.revision,
    }),
  });
  const endedAt = performance.now();
  if (!result.success)
    return { error: result.error ?? 'pipelines:save failed' };
  return {
    roundTripMs: endedAt - startedAt,
    startedEpochMs: performance.timeOrigin + startedAt,
    endedEpochMs: performance.timeOrigin + endedAt,
  };
}

/** Runs in the renderer: times a duplicate of the target; returns the copy. */
async function duplicateInRenderer({ id }) {
  const startedAt = performance.now();
  const result = await window.pipelines.duplicate(id);
  const endedAt = performance.now();
  if (!result.success || !result.data?.id)
    return { error: result.error ?? 'pipelines:duplicate returned no copy' };
  return {
    copyId: result.data.id,
    roundTripMs: endedAt - startedAt,
    startedEpochMs: performance.timeOrigin + startedAt,
    endedEpochMs: performance.timeOrigin + endedAt,
  };
}

/**
 * Runs in the renderer: times one enabled-state change of the target through
 * the call the Workflows page makes, and checks the preferences it answers.
 */
async function setEnabledInRenderer({ id, disabled }) {
  const startedAt = performance.now();
  const preferences = await window.api.setPipelineDisabledPreference({
    id,
    disabled,
  });
  const endedAt = performance.now();
  const isDisabled = (preferences?.disabledPipelineIds ?? []).includes(id);
  if (isDisabled !== disabled)
    return {
      error: `preferences:set-pipeline-disabled left the workflow ${
        isDisabled ? 'disabled' : 'enabled'
      }`,
    };
  return {
    roundTripMs: endedAt - startedAt,
    startedEpochMs: performance.timeOrigin + startedAt,
    endedEpochMs: performance.timeOrigin + endedAt,
  };
}

/** Runs in the renderer: removes a copy outside the timed calls. */
async function deleteInRenderer({ id }) {
  const result = await window.pipelines.delete(id);
  return result.success
    ? {}
    : { error: result.error ?? 'pipelines:delete failed' };
}

function assertListed(fixture, listed, label) {
  if (listed.error) throw new Error(`${label}: ${listed.error}`);
  if (listed.listed !== fixture.definitions)
    throw new Error(
      `${label}: expected ${fixture.definitions} user workflows, listed ${listed.listed}`,
    );
}

/**
 * Before the measured window: installs the handler probe, lists once and
 * gets the target once, which warms main and checks that every seeded
 * workflow loads.
 */
export async function setupPipelineDefinitions({ page, electronApp, fixture }) {
  await installProbe(electronApp);
  await startMainLoopDelay(electronApp);
  const listed = await page.evaluate(listInRenderer);
  assertListed(fixture, listed, 'Pipeline definitions fixture');
  const got = await page.evaluate(getInRenderer, { id: fixture.targetId });
  if (got.error) throw new Error(`Pipeline definitions fixture: ${got.error}`);
  if (got.name !== fixture.targetName)
    throw new Error(
      `Pipeline definitions fixture: the target loaded as ${got.name}`,
    );
  fixture.warmListMs = listed.roundTripMs;
}

/** Times one renderer write with the main pings that overlap it. */
async function timedWrite(page, electronApp, run, label) {
  const from = await probeLength(electronApp);
  await page.evaluate(startMainPingRenderer, PING_GLOBAL);
  let written;
  let pings;
  try {
    await page.waitForTimeout(PING_LEAD_MS);
    written = await run();
    await page.waitForTimeout(PING_WINDOW_PAD_MS);
  } finally {
    pings = await page.evaluate(stopMainPingRenderer, {
      pingGlobal: PING_GLOBAL,
      timeoutMs: WRITE_TIMEOUT_MS,
    });
  }
  if (written.error) throw new Error(`${label}: ${written.error}`);
  if (pings.errors.length > 0)
    throw new Error(`${label}: a main ping failed: ${pings.errors[0]}`);
  const windowStart = written.startedEpochMs - PING_WINDOW_PAD_MS;
  const windowEnd = written.endedEpochMs + PING_WINDOW_PAD_MS;
  const overlapping = pings.samples
    .filter(
      (ping) =>
        ping.startedAt <= windowEnd && ping.startedAt + ping.ms >= windowStart,
    )
    .map((ping) => ping.ms);
  if (overlapping.length === 0)
    throw new Error(`${label}: no main ping overlapped the write`);
  return {
    written,
    entries: await probeEntriesSince(electronApp, from),
    pingMaxMs: Math.max(...overlapping),
    pings: overlapping.length,
  };
}

export async function runPipelineDefinitions({
  page,
  electronApp,
  tasks,
  fixture,
}) {
  await resetMainLoopDelay(electronApp);
  for (let sample = 0; sample < fixture.samples; sample += 1) {
    const label = `List sample ${sample + 1}`;
    const from = await probeLength(electronApp);
    const listed = await page.evaluate(listInRenderer);
    assertListed(fixture, listed, label);
    const handler = singleHandler(
      await probeEntriesSince(electronApp, from),
      LIST_CHANNEL,
      label,
    );
    tasks.push({
      kind: 'pipeline_definitions_list_main',
      status: 'ok',
      durationMs: handler.endedAt - handler.startedAt,
    });
    tasks.push({
      kind: 'pipeline_definitions_list_round_trip',
      status: 'ok',
      durationMs: listed.roundTripMs,
    });
    await page.waitForTimeout(SAMPLE_PAUSE_MS);
  }

  for (let sample = 0; sample < fixture.samples; sample += 1) {
    const label = `Get sample ${sample + 1}`;
    const from = await probeLength(electronApp);
    const got = await page.evaluate(getInRenderer, { id: fixture.targetId });
    if (got.error) throw new Error(`${label}: ${got.error}`);
    const handler = singleHandler(
      await probeEntriesSince(electronApp, from),
      GET_CHANNEL,
      label,
    );
    tasks.push({
      kind: 'pipeline_definitions_get_main',
      status: 'ok',
      durationMs: handler.endedAt - handler.startedAt,
    });
    tasks.push({
      kind: 'pipeline_definitions_get_round_trip',
      status: 'ok',
      durationMs: got.roundTripMs,
    });
    await page.waitForTimeout(SAMPLE_PAUSE_MS);
  }

  for (let sample = 0; sample < fixture.samples; sample += 1) {
    const label = `Save sample ${sample + 1}`;
    const timed = await timedWrite(
      page,
      electronApp,
      () =>
        page.evaluate(saveInRenderer, {
          id: fixture.targetId,
          name: `${fixture.targetName} (save ${sample + 1})`,
        }),
      label,
    );
    const handler = singleHandler(timed.entries, SAVE_CHANNEL, label);
    tasks.push({
      kind: 'pipeline_definitions_save_main',
      status: 'ok',
      durationMs: handler.endedAt - handler.startedAt,
    });
    tasks.push({
      kind: 'pipeline_definitions_save_round_trip',
      status: 'ok',
      durationMs: timed.written.roundTripMs,
    });
    tasks.push({
      kind: 'pipeline_definitions_save_main_ping_max',
      status: 'ok',
      durationMs: timed.pingMaxMs,
      pings: timed.pings,
    });
    await page.waitForTimeout(SAMPLE_PAUSE_MS);
  }

  for (let sample = 0; sample < fixture.samples; sample += 1) {
    const label = `Duplicate sample ${sample + 1}`;
    const timed = await timedWrite(
      page,
      electronApp,
      () => page.evaluate(duplicateInRenderer, { id: fixture.targetId }),
      label,
    );
    const handler = singleHandler(timed.entries, DUPLICATE_CHANNEL, label);
    tasks.push({
      kind: 'pipeline_definitions_duplicate_main',
      status: 'ok',
      durationMs: handler.endedAt - handler.startedAt,
    });
    tasks.push({
      kind: 'pipeline_definitions_duplicate_round_trip',
      status: 'ok',
      durationMs: timed.written.roundTripMs,
    });
    tasks.push({
      kind: 'pipeline_definitions_duplicate_main_ping_max',
      status: 'ok',
      durationMs: timed.pingMaxMs,
      pings: timed.pings,
    });
    // The copy goes before the next sample, so every duplicate lists the
    // same number of workflows.
    const removed = await page.evaluate(deleteInRenderer, {
      id: timed.written.copyId,
    });
    if (removed.error) throw new Error(`${label}: ${removed.error}`);
    await page.waitForTimeout(SAMPLE_PAUSE_MS);
  }

  // Each sample turns the target off, then on again, so it ends enabled.
  for (let sample = 0; sample < fixture.samples; sample += 1) {
    for (const disabled of [true, false]) {
      const label = `Enable sample ${sample + 1} (${disabled ? 'off' : 'on'})`;
      const timed = await timedWrite(
        page,
        electronApp,
        () =>
          page.evaluate(setEnabledInRenderer, {
            id: fixture.targetId,
            disabled,
          }),
        label,
      );
      const handler = singleHandler(timed.entries, ENABLE_CHANNEL, label);
      tasks.push({
        kind: 'pipeline_definitions_enable_main',
        status: 'ok',
        durationMs: handler.endedAt - handler.startedAt,
      });
      tasks.push({
        kind: 'pipeline_definitions_enable_round_trip',
        status: 'ok',
        durationMs: timed.written.roundTripMs,
      });
      tasks.push({
        kind: 'pipeline_definitions_enable_main_ping_max',
        status: 'ok',
        durationMs: timed.pingMaxMs,
        pings: timed.pings,
      });
      await page.waitForTimeout(SAMPLE_PAUSE_MS);
    }
  }

  const loopDelay = await stopMainLoopDelay(electronApp);
  if (loopDelay.count === 0)
    throw new Error('The main event-loop delay histogram recorded nothing');
  tasks.push({
    kind: 'pipeline_definitions_main_event_loop_delay_p99',
    status: 'ok',
    durationMs: loopDelay.p99Ms,
  });
  tasks.push({
    kind: 'pipeline_definitions_main_event_loop_delay_max',
    status: 'ok',
    durationMs: loopDelay.maxMs,
  });

  return {
    pipelineDefinitions: {
      definitions: fixture.definitions,
      samples: fixture.samples,
      warmListMs: fixture.warmListMs,
    },
  };
}
