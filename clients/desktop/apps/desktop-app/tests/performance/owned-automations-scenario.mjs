// Owned-automation list workload (CAN-7083 / CAN-7087): many automations that
// own their workflow, each a converted Orchestrator chat automation with its
// own user pipeline. Every `automations:list` call and every automations-file
// write projects them in Electron main, looking each owned pipeline up in the
// user workflow index; a field profile of about 770 such automations blocked
// main for seconds per pass.
//
// It times, in the running app, the main handler and the renderer round trip
// of repeated `automations:list` calls, and for repeated name-only updates
// through `automations:update` the handler, the time until the windows' push
// lands, and the slowest renderer-to-main ping overlapping the write (the
// main-thread block it caused). It reuses the Code Review registry
// workload's handler probe and main ping. Nothing here depends on how main
// projects, so the same driver measures an unchanged and a changed build.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  codeReviewRegistryProbeMain,
  startMainPingRenderer,
  stopMainPingRenderer,
} from './code-review-registry-scenario.mjs';
import { seedAutomations } from '../electron/seeders/index.mjs';
import { writeJson } from '../electron/seeders/fsHelpers.mjs';

export const OWNED_AUTOMATIONS_SCENARIO = 'owned-automations-list';

const LIST_CHANNEL = 'automations:list';
const UPDATE_CHANNEL = 'automations:update';
const PROBE_GLOBAL = '__canopyOwnedAutomationsProbe';
const PING_GLOBAL = '__canopyOwnedAutomationsPing';
const STAMP = '2026-11-01T00:00:00.000Z';
// One-time runs a week out: never due inside a run, and well inside the
// longest timer Node arms without overflowing.
const RUN_AT_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;
// A one-time automation that is off is dropped on load, so every tenth is a
// cron schedule that is off; the rest are on, like the field profile.
const CRON_EVERY = 10;
// Every fifth sends into an existing Work Entry, which also gives it an
// auto-archive target key.
const WORK_ENTRY_EVERY = 5;
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

function ownerId(index) {
  return `perf-owned-${String(index).padStart(4, '0')}`;
}

// UUID-length, as the store names a converted pipeline, so the index has the
// field's size per entry.
function pipelineId(index) {
  return `perf0000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * The document `chatAutomationToPipeline` writes for an Orchestrator prompt
 * (`serializePipelineDocument` output, checked against the converter when
 * this fixture was written). Without a Work Entry each run creates one.
 */
function ownedPipelineYaml(name, prompt, workEntry) {
  const header = [
    'pipeline:',
    `  name: ${name}`,
    '  scope: global',
    "  'on':",
    '    dispatch:',
    '      inputs:',
    '        bot_id:',
    '          required: false',
  ];
  const reply = (taskId) => [
    '        - id: reply',
    '          uses: builtin/wait-for-agent-reply',
    '          with:',
    '            bot_id: ${{ inputs.bot_id }}',
    `            task_id: ${taskId}`,
    '            chat_id: ${{ steps.send.outputs.chat_id }}',
    '            message_id: ${{ steps.send.outputs.message_id }}',
    "            reply_timeout_minutes: '720'",
  ];
  const lines = workEntry
    ? [
        ...header,
        '        task_id:',
        '          required: false',
        '  jobs:',
        '    chat:',
        '      steps:',
        '        - id: send',
        '          uses: builtin/send-agent-message',
        '          with:',
        '            bot_id: ${{ inputs.bot_id }}',
        '            task_id: ${{ inputs.task_id }}',
        `            text: ${prompt}`,
        "            literal_text: 'true'",
        "            new_chat: 'true'",
        ...reply('${{ inputs.task_id }}'),
      ]
    : [
        ...header,
        '  jobs:',
        '    chat:',
        '      steps:',
        '        - id: entry',
        '          uses: builtin/create-bot-entry',
        '          with:',
        '            bot_id: ${{ inputs.bot_id }}',
        `            title: ${name}`,
        '        - id: send',
        '          uses: builtin/send-agent-message',
        '          with:',
        '            bot_id: ${{ inputs.bot_id }}',
        '            task_id: ${{ steps.entry.outputs.task_id }}',
        `            text: ${prompt}`,
        "            literal_text: 'true'",
        "            replace_empty_chat: 'true'",
        ...reply('${{ steps.entry.outputs.task_id }}'),
      ];
  return `${lines.join('\n')}\n`;
}

/**
 * Seeds `ownedAutomations` converted chat automations: each a
 * `worktree_pipeline` record on a global target running its own user
 * pipeline, the pipeline's YAML and `pipelines/index.json` entry, and the
 * owner and `ownerAutomationId` marker in `pipeline-local-metadata.json` that
 * make the record its owner. Records, entries and metadata have the fields
 * the chat automation conversion writes (checked against it when this
 * fixture was written).
 */
export function prepareOwnedAutomations(userDataDir, config) {
  const owned = positiveInteger(config.ownedAutomations, 'ownedAutomations');
  const listSamples = positiveInteger(
    config.ownedAutomationListSamples,
    'ownedAutomationListSamples',
  );
  const writes = positiveInteger(
    config.ownedAutomationWrites,
    'ownedAutomationWrites',
  );
  const pipelinesDir = path.join(userDataDir, 'pipelines');
  mkdirSync(pipelinesDir, { recursive: true });
  const runAt = new Date(Date.now() + RUN_AT_OFFSET_MS).toISOString();
  const activities = [];
  const entries = [];
  const metadata = {};
  let workEntries = 0;
  for (let index = 0; index < owned; index += 1) {
    const id = ownerId(index);
    const pipeline = pipelineId(index);
    const name = `Review ${index}`;
    const prompt = `Review the changes ${index}`;
    const workEntry = index % WORK_ENTRY_EVERY === 0;
    if (workEntry) workEntries += 1;
    const cron = index % CRON_EVERY === CRON_EVERY - 1;
    const filename = `${pipeline}.yaml`;
    writeFileSync(
      path.join(pipelinesDir, filename),
      ownedPipelineYaml(name, prompt, workEntry),
      'utf8',
    );
    entries.push({
      id: pipeline,
      name,
      filename,
      description: '',
      icon: '',
      createdAt: STAMP,
      updatedAt: STAMP,
      revision: 1,
      triggerTypes: ['dispatch'],
      stepCount: workEntry ? 2 : 3,
      scopes: ['global'],
    });
    metadata[`stored:user:${pipeline}`] = {
      owner: 'personal',
      ownerAutomationId: id,
    };
    activities.push({
      version: 1,
      id,
      name,
      enabled: !cron,
      schedule: cron
        ? { kind: 'cron', expression: '0 9 * * *', timezone: 'local' }
        : { kind: 'one_time', runAt, timezone: 'local' },
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        pipelineId: pipeline,
        pipelineSource: 'user',
        pipelineName: name,
        inputs: workEntry
          ? { bot_id: 'app_advisor', task_id: `perf-work-entry-${index}` }
          : { bot_id: 'app_advisor' },
      },
      createdAt: STAMP,
      updatedAt: STAMP,
      failureCount: 0,
      executionContext: 'personal',
    });
  }
  writeJson(path.join(pipelinesDir, 'index.json'), {
    version: 1,
    pipelines: entries,
  });
  writeJson(path.join(userDataDir, 'pipeline-local-metadata.json'), {
    version: 1,
    entries: metadata,
  });
  seedAutomations({ userDataDir, activities, updatedAt: STAMP });
  return {
    owned,
    indexEntries: entries.length,
    workEntries,
    listSamples,
    writes,
    writeTargetId: ownerId(0),
  };
}

function installProbe(electronApp) {
  return electronApp.evaluate(codeReviewRegistryProbeMain, {
    fsTrace: false,
    probeGlobal: PROBE_GLOBAL,
    channels: [LIST_CHANNEL, UPDATE_CHANNEL],
    // The registry probe reads a purge request's container id; no channel here.
    purgeChannel: null,
  });
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

/** Runs in the renderer: one timed list and what it returned. */
async function listInRenderer() {
  const startedAt = performance.now();
  const snapshot = await window.api.automations.list();
  const roundTripMs = performance.now() - startedAt;
  return {
    roundTripMs,
    activities: snapshot.activities.length,
    chatEditable: snapshot.activities.filter(
      (activity) => activity.ownedPipeline?.chatEditable === true,
    ).length,
  };
}

/**
 * Runs in the renderer: a name-only update, timed to its response and to the
 * windows' push that carries the new name (epoch ms bound the write).
 */
async function updateInRenderer({ id, name, timeoutMs }) {
  let unsubscribe;
  const pushed = new Promise((resolve) => {
    unsubscribe = window.api.automations.onChanged((snapshot) => {
      if (
        snapshot.activities.some(
          (activity) => activity.id === id && activity.name === name,
        )
      )
        resolve(performance.now());
    });
  });
  const startedAt = performance.now();
  try {
    const response = await window.api.automations.update({ id, name });
    const respondedAt = performance.now();
    if (!response.ok)
      return { error: response.error ?? 'automations:update failed' };
    let timer;
    const pushedAt = await Promise.race([
      pushed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (pushedAt === null)
      return {
        error: `No automations push carried the update in ${timeoutMs} ms`,
      };
    const endedAt = Math.max(respondedAt, pushedAt);
    return {
      responseMs: respondedAt - startedAt,
      settledMs: endedAt - startedAt,
      startedEpochMs: performance.timeOrigin + startedAt,
      endedEpochMs: performance.timeOrigin + endedAt,
    };
  } finally {
    unsubscribe?.();
  }
}

function assertListed(fixture, listed, label) {
  if (
    listed.activities !== fixture.owned ||
    listed.chatEditable !== fixture.owned
  )
    throw new Error(
      `${label}: expected ${fixture.owned} chat-editable owned automations, listed ${listed.chatEditable} of ${listed.activities}`,
    );
}

/**
 * Before the measured window: installs the handler probe and lists once,
 * which warms main and checks that every seeded automation projects as an
 * owned, chat-editable chat automation.
 */
export async function setupOwnedAutomations({ page, electronApp, fixture }) {
  await installProbe(electronApp);
  const listed = await page.evaluate(listInRenderer);
  assertListed(fixture, listed, 'Owned automations fixture');
  fixture.warmListMs = listed.roundTripMs;
}

export async function runOwnedAutomations({
  page,
  electronApp,
  tasks,
  fixture,
}) {
  for (let sample = 0; sample < fixture.listSamples; sample += 1) {
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
      kind: 'owned_automations_list_main',
      status: 'ok',
      durationMs: handler.endedAt - handler.startedAt,
    });
    tasks.push({
      kind: 'owned_automations_list_round_trip',
      status: 'ok',
      durationMs: listed.roundTripMs,
    });
    await page.waitForTimeout(SAMPLE_PAUSE_MS);
  }

  const pingsPerWrite = [];
  let listCallsDuringWrites = 0;
  for (let write = 0; write < fixture.writes; write += 1) {
    const label = `Write ${write + 1}`;
    const from = await probeLength(electronApp);
    await page.evaluate(startMainPingRenderer, PING_GLOBAL);
    let updated;
    let pings;
    try {
      await page.waitForTimeout(PING_LEAD_MS);
      updated = await page.evaluate(updateInRenderer, {
        id: fixture.writeTargetId,
        name: `Review 0 (write ${write + 1})`,
        timeoutMs: WRITE_TIMEOUT_MS,
      });
      await page.waitForTimeout(PING_WINDOW_PAD_MS);
    } finally {
      pings = await page.evaluate(stopMainPingRenderer, {
        pingGlobal: PING_GLOBAL,
        timeoutMs: WRITE_TIMEOUT_MS,
      });
    }
    if (updated.error) throw new Error(`${label}: ${updated.error}`);
    if (pings.errors.length > 0)
      throw new Error(`${label}: a main ping failed: ${pings.errors[0]}`);
    const entries = await probeEntriesSince(electronApp, from);
    const handler = singleHandler(entries, UPDATE_CHANNEL, label);
    listCallsDuringWrites += entries.filter(
      (entry) => entry.channel === LIST_CHANNEL,
    ).length;
    // Pings that overlap the write, padded so a short write still has some.
    const windowStart = updated.startedEpochMs - PING_WINDOW_PAD_MS;
    const windowEnd = updated.endedEpochMs + PING_WINDOW_PAD_MS;
    const overlapping = pings.samples
      .filter(
        (ping) =>
          ping.startedAt <= windowEnd &&
          ping.startedAt + ping.ms >= windowStart,
      )
      .map((ping) => ping.ms);
    if (overlapping.length === 0)
      throw new Error(`${label}: no main ping overlapped the write`);
    pingsPerWrite.push(overlapping.length);
    tasks.push({
      kind: 'owned_automations_write_main',
      status: 'ok',
      durationMs: handler.endedAt - handler.startedAt,
    });
    tasks.push({
      kind: 'owned_automations_write_to_push',
      status: 'ok',
      durationMs: updated.settledMs,
      responseMs: updated.responseMs,
    });
    tasks.push({
      kind: 'owned_automations_write_main_ping_max',
      status: 'ok',
      durationMs: Math.max(...overlapping),
      pings: overlapping.length,
    });
    await page.waitForTimeout(SAMPLE_PAUSE_MS);
  }

  return {
    ownedAutomations: {
      owned: fixture.owned,
      indexEntries: fixture.indexEntries,
      workEntries: fixture.workEntries,
      listSamples: fixture.listSamples,
      writes: fixture.writes,
      warmListMs: fixture.warmListMs,
      pingsPerWrite,
      listCallsDuringWrites,
    },
  };
}
