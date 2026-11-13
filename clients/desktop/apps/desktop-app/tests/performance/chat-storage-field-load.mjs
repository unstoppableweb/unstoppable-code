#!/usr/bin/env node
/**
 * Replays a captured field load (`field-load-capture.mjs`) against the real
 * chat-storage commit path and the real Codex owner-admission lanes.
 *
 *   pnpm run perf:desktop:chat-storage-field-load [--profile smoke|field]
 *     [--capture FILE] [--duration-ms N] [--byte-scale N] [--output FILE]
 *
 * `smoke` shrinks every byte dimension so local and CI checks stay quick.
 * `field` replays the capture at full size: the 2026-10-06 default has ten
 * concurrent turns over 1 to 78 MB committed transcripts, running delegated
 * agent cards inside committed history, and several Codex chats sharing one
 * pooled app-server. Transcripts hold deterministic synthetic text only.
 *
 * Each captured working-set chat becomes one owner, seeded to the captured
 * committed size, tab-index size, and card positions; chats captured in one
 * scope share a scope here too. Every owner then runs one open turn in a
 * closed loop: its next provider event is admitted only when the previous
 * event's durable commit settles, as both providers do while chat storage
 * does not group-commit. A captured share of the events patch a running
 * delegated-agent card in committed history; the rest append to the active
 * turn.
 *
 * Claude owners stand for one process each, so they only ever wait on their
 * own commits. Codex owners share one `OwnerAdmissionLanes` and one ordered
 * pipe, exactly as on a pooled app-server: the pump stops reading when the
 * lanes pause the source at the retained-frame cap, so a slow owner's backlog
 * stalls every owner on the pool. Every pooled frame commits, which is the
 * worst case: a live app-server also sends text deltas that commit nothing,
 * so the field pipe drains faster per frame than this one.
 *
 * The report uses the units of the `chat_storage_activity_summary` app
 * diagnostic (per-minute commits, bytes written, syncs, commit time), so the
 * replay can be read against the capture's own field medians. Plain Node
 * stands in for Electron main; times are E2E-relative, not release evidence.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { percentile } from './field-load-capture.mjs';
import { createD11Replay, D11_LIFECYCLE_SCHEDULE } from './d11-card-replay.mjs';

const DEFAULT_CAPTURE = new URL(
  './field-loads/2026-10-06-orchestrator-storm.json',
  import.meta.url,
);

export const FIELD_LOAD_PROFILES = {
  smoke: { byteScale: 1 / 64, durationMs: 6_000, maxOwners: 5 },
  field: { byteScale: 1, durationMs: 120_000, maxOwners: 16 },
};

const MIN_COMMITTED_BYTES = 64 * 1024;
const MIN_ROW_BYTES = 256;
/** Wire bytes of one Codex notification when the capture has no hold peak. */
const DEFAULT_FRAME_BYTES = 1_536;
/** Rounds of the pooled pipe's frame schedule before it yields the loop. */
const PUMP_BATCH_ROUNDS = 16;
/** Most frames one pooled owner gets per round, however busy it was. */
const MAX_FRAME_WEIGHT = 32;
const NO_CARDS = {
  bytes: { p50: 0 },
  liveByteFractions: [],
  lastByteFractions: [],
};

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Turns a capture into the owners to replay. Pure, so the mapping from field
 * numbers to workload is testable without touching storage.
 */
export function fieldLoadReplayPlan(capture, profile) {
  const byteCap = capture.diagnostics?.codexStdoutHolds?.['stdout-byte-cap'];
  const frameBytes =
    byteCap?.peakQueuedFrames > 0
      ? Math.round(byteCap.peakQueuedBytes / byteCap.peakQueuedFrames)
      : DEFAULT_FRAME_BYTES;
  const working = capture.scopes.flatMap((scope) =>
    scope.chats
      // The working set: chats whose transcript was shaped (an active turn
      // or an observed rewrite, above the capture's size floor) and any
      // smaller chat with an active turn.
      .filter((chat) => chat.transcript || chat.activeTurn)
      .map((chat) => ({ scope, chat })),
  );
  working.sort(
    (left, right) => right.chat.committedBytes - left.chat.committedBytes,
  );
  const chatsInScope = new Map();
  const owners = working.slice(0, profile.maxOwners).map(({ scope, chat }) => {
    // Chats of one captured scope share a scope here too: one index and one
    // serialized commit queue.
    const ordinal = (chatsInScope.get(scope.label) ?? 0) + 1;
    chatsInScope.set(scope.label, ordinal);
    const cards = chat.transcript?.delegationCards ?? NO_CARDS;
    const committedBytes = Math.max(
      MIN_COMMITTED_BYTES,
      Math.round(chat.committedBytes * profile.byteScale),
    );
    const meanRowBytes = Math.max(
      MIN_ROW_BYTES,
      Math.round(
        chat.transcript
          ? chat.transcript.bytes / Math.max(1, chat.transcript.rows)
          : chat.committedBytes / Math.max(1, chat.committedMessages),
      ),
    );
    // Only cards that were still running can be patched. A chat whose cards
    // had all settled by capture time still shows the rewrites they caused,
    // so its most recent cards stand in for the ones that were running.
    const rewritesPerMinute = chat.committedRewrites?.perMinute.p50 ?? 0;
    const cardByteFractions =
      cards.liveByteFractions.length > 0
        ? cards.liveByteFractions
        : rewritesPerMinute > 0
          ? cards.lastByteFractions.slice(-4)
          : [];
    const fieldCommitsPerMinute = Math.max(
      scope.commitsPerMinute,
      rewritesPerMinute,
    );
    return {
      scope: scope.label,
      chat: ordinal,
      provider: chat.provider === 'codex' ? 'codex' : 'claude',
      committedBytes,
      meanRowBytes,
      tabIndexBytes: Math.round(chat.tabIndexBytes * profile.byteScale),
      cardByteFractions,
      cardBytes: Math.max(MIN_ROW_BYTES, cards.bytes.p50),
      // `persisted-projection` models delegate logs: a running card commits
      // when it appears and when it settles, never for progress, so within a
      // replay window it is not patched.
      patchShare:
        profile.cardPolicy === 'persisted-projection' ||
        profile.cardPolicy === 'stream-descriptor' ||
        profile.cardPolicy === 'd11-cards' ||
        cardByteFractions.length === 0 ||
        fieldCommitsPerMinute === 0
          ? 0
          : clamp(rewritesPerMinute / fieldCommitsPerMinute, 0, 1),
      field: {
        commitsPerMinute: scope.commitsPerMinute,
        rewritesPerMinute,
        committedBytes: chat.committedBytes,
      },
    };
  });
  // A pooled app-server interleaves its owners' frames on one pipe in
  // proportion to how much each chat is producing. The captured commit rates
  // give that mix; the quietest pooled owner gets one frame per round.
  const pooled = owners.filter((owner) => owner.provider === 'codex');
  const quietest = Math.max(
    1,
    Math.min(...pooled.map((owner) => owner.field.commitsPerMinute)),
  );
  for (const owner of pooled)
    owner.frameWeight = clamp(
      Math.round(owner.field.commitsPerMinute / quietest),
      1,
      MAX_FRAME_WEIGHT,
    );
  return {
    label: capture.label,
    durationMs: profile.durationMs,
    byteScale: profile.byteScale,
    cardPolicy: profile.cardPolicy ?? 'legacy',
    streamCount: profile.streamCount,
    incrementalStreamMetadata: profile.incrementalStreamMetadata === true,
    frameBytes,
    owners,
    pooledOwners: pooled.map((owner) => `${owner.scope}/${String(owner.chat)}`),
    ...(profile.cardPolicy === 'd11-cards'
      ? { cardSeeding: 'broker', lifecycleSchedule: D11_LIFECYCLE_SCHEDULE }
      : {}),
  };
}

function filler(marker, bytes) {
  const unit = `${marker} `;
  return unit
    .repeat(Math.ceil(bytes / unit.length))
    .slice(0, Math.max(1, bytes));
}

function textRow(id, timestamp, bytes) {
  return {
    id,
    role: 'assistant',
    timestamp,
    blocks: [{ type: 'text', text: filler(id, bytes - 96) }],
  };
}

function cardTranscript(chatId, ordinal, sequence, bytes) {
  const delegationId = `delegation-${chatId}-${String(ordinal)}`;
  return {
    delegationId,
    runGeneration: 1,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'seed-turn',
    parentToolCallId: `spawn-${chatId}-${String(ordinal)}`,
    createdAt: 1,
    task: {
      description: 'Synthetic delegate',
      prompt: 'Synthetic delegate',
      executionMode: 'background',
    },
    transcript: [],
    snapshot: {
      delegationId,
      status: 'running',
      outputTruncated: false,
      // A running card is only valid with the route it was assigned.
      routeSnapshot: {
        selectedModelId: 'synthetic-model',
        runtimeModelId: 'synthetic-model',
        harnessId: 'claude',
      },
      // The sequence changes the row; the padding keeps its size constant.
      partialText: filler(
        `progress-${String(sequence).padStart(8, '0')}`,
        bytes,
      ),
    },
  };
}

/** One summary line of numbers for a list of durations. */
function latency(values) {
  return {
    count: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(1)),
    p95Ms: Number(percentile(values, 0.95).toFixed(1)),
    maxMs: Number((values.length ? Math.max(...values) : 0).toFixed(1)),
  };
}

function perMinute(value, elapsedMs) {
  return Number(((value * 60_000) / elapsedMs).toFixed(1));
}

async function loadRuntime() {
  // tsx loads these TypeScript sources as CommonJS; take the exports from
  // whichever shape the loader produced.
  const load = async (specifier) => {
    const module = await import(specifier);
    return module.default ?? module;
  };
  return {
    ...(await load('../../src/main/lib/chat-storage-v2.ts')),
    ...(await load('../../src/main/services/chat-state-v2-backend.ts')),
    ...(await load(
      '../../src/main/services/chat-transcript-rewrite-diagnostics.ts',
    )),
    ...(await load(
      '../../../../packages/desktop-shared/src/node/chat-storage-activity.ts',
    )),
    ...(await load(
      '../../../../packages/execution-engine/src/node/codex-runtime/owner-admission-lanes.ts',
    )),
    ...(await load(
      '../../../../packages/agent-transcript/src/lib/delegation-transcript.ts',
    )),
    ...(await load(
      '../../../../packages/desktop-shared/src/node/work-counters.ts',
    )),
  };
}

/** Synthetic committed rows of one chat, with cards at the captured offsets. */
async function* seedMessages(runtime, owner, chatId, seeded) {
  const cardOffsets = owner.cardByteFractions.map((fraction) =>
    Math.round(fraction * owner.committedBytes),
  );
  let bytes = 0;
  let nextCard = 0;
  while (bytes < owner.committedBytes) {
    seeded.rows += 1;
    if (nextCard < cardOffsets.length && bytes >= cardOffsets[nextCard]) {
      const [card] = runtime.delegationTranscriptMessages(
        cardTranscript(chatId, nextCard, 0, owner.cardBytes),
      );
      nextCard += 1;
      bytes += owner.cardBytes;
      yield card;
      continue;
    }
    bytes += owner.meanRowBytes;
    yield textRow(
      `seed-${chatId}-${String(seeded.rows)}`,
      seeded.rows,
      owner.meanRowBytes,
    );
    // Seeding is not measured; keep the loop responsive anyway.
    if (seeded.rows % 512 === 0)
      await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Seeds one scope with its owners' chats and opens a turn on each. */
export function storageFormatOption(value = 'v2') {
  if (!['v2', 'v3', 'v4'].includes(value))
    throw new Error(`Unknown storage format: ${value}`);
  return value;
}

async function seedScope(runtime, root, scope, owners, storageFormat, d11) {
  const store = new runtime.ChatStorageV2(root, scope, undefined, {
    maxManifestVersion: storageFormat === 'v4' ? 4 : 3,
  });
  const chats = owners.map((owner) => ({
    owner,
    chatId: `chat-${String(owner.chat)}`,
    seeded: { rows: 0 },
  }));
  await store.migrate(() =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: chats[0].chatId, runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* () {
        for (const { owner, chatId, seeded } of chats) {
          yield await Promise.resolve({
            metadata: {
              id: chatId,
              title: chatId,
              createdAt: '2026-10-06T00:00:00.000Z',
              providerType: owner.provider,
              // Stands in for the captured tab-index footprint (delivery,
              // artifact, and turn-diff bookkeeping) every commit
              // republishes.
              globalInstructionsSnapshot: filler('index', owner.tabIndexBytes),
            },
            messages: d11
              ? d11.seedMessages(owner, chatId, seeded)
              : seedMessages(runtime, owner, chatId, seeded),
          });
        }
      })(),
    }),
  );
  const backend = new runtime.ChatStateV2Backend(
    store,
    storageFormat === 'v2'
      ? {}
      : {
          deltaJournal: {},
          ...(storageFormat === 'v4' ? { enableFormat4: true } : {}),
        },
  );
  if (storageFormat !== 'v2') await backend.promoteToDeltaJournal();
  if (storageFormat === 'v4') await backend.promoteToFormat4();
  let d11Scope;
  if (d11) {
    await backend.flush();
    backend.releaseJournal();
    await backend.disposeArtifactMaintenance();
    d11Scope = await d11.attachScope(scope, owners, chats, store);
  }
  runtime.registerChatStorageScope(store.directory, {
    projectId: 'field-load',
    worktreeId: scope,
  });

  const states = [];
  for (const { owner, chatId, seeded } of chats) {
    const commit = (mutations) =>
      d11Scope
        ? d11Scope.commit(chatId, mutations)
        : backend.transact(() => mutations, {
            source: 'provider',
            chatIds: [chatId],
          });
    const turnStartedAt = seeded.rows + 1;
    // Open the turn the way a prompt does: a committed user row plus an open
    // timer in the active tail.
    await commit([
      {
        type: 'runtime.patched',
        chatId,
        runtime: { status: 'streaming', queuedMessageIds: [] },
      },
      {
        type: 'message.upserted',
        chatId,
        message: {
          id: `turn-user-${chatId}`,
          role: 'user',
          timestamp: turnStartedAt,
          blocks: [{ type: 'text', text: 'Synthetic prompt' }],
        },
      },
      {
        type: 'message.upserted',
        chatId,
        message: {
          id: `turn-timer-${chatId}`,
          role: 'system',
          timestamp: turnStartedAt,
          blocks: [
            { type: 'turn_timer', startedAt: turnStartedAt, completedAt: null },
          ],
        },
      },
    ]);

    const state = {
      ...owner,
      seededRows: seeded.rows,
      events: 0,
      patches: 0,
      appendMs: [],
      patchMs: [],
      cardSequence: owner.cardByteFractions.map(() => 0),
      dispatched: 0,
      delivered: 0,
      starvedMs: 0,
      starvedAt: undefined,
    };
    // Spread the patches evenly through the events instead of sampling, so a
    // run is deterministic.
    const patchEvery =
      owner.patchShare > 0 ? Math.max(1, Math.round(1 / owner.patchShare)) : 0;
    state.next = async () => {
      state.events += 1;
      const startedAt = performance.now();
      if (patchEvery > 0 && state.events % patchEvery === 0) {
        const card = state.patches % state.cardSequence.length;
        state.patches += 1;
        state.cardSequence[card] += 1;
        const [message] = runtime.delegationTranscriptMessages(
          cardTranscript(
            chatId,
            card,
            state.cardSequence[card],
            owner.cardBytes,
          ),
        );
        await commit([{ type: 'message.upserted', chatId, message }]);
        state.patchMs.push(performance.now() - startedAt);
        return;
      }
      await commit([
        {
          type: 'message.upserted',
          chatId,
          message: textRow(
            `turn-${chatId}-${String(state.events)}`,
            turnStartedAt + state.events,
            owner.meanRowBytes,
          ),
        },
      ]);
      state.appendMs.push(performance.now() - startedAt);
    };
    if (d11) state.next = d11.wrapForeground(owner, state.next);
    states.push(state);
  }
  return { backend, owners: states };
}

/** Runs the plan and returns the report artifact. */
export async function runFieldLoadReplay(plan, { root, storageFormat = 'v2' }) {
  if (plan.cardPolicy === 'd11-cards' && storageFormat !== 'v4')
    throw new Error('d11-cards policy requires --storage-format v4');
  const runtime = await loadRuntime();
  const rewrites = [];
  let d11;
  let diagnosticClock = 0;
  runtime.setChatTranscriptRewriteDiagnosticsForTests({
    sink: (record) => {
      rewrites.push(record);
      d11?.observeRewrite(record);
    },
    // One record per rewrite: step past the per-chat rate limit each time.
    now: () =>
      (diagnosticClock +=
        runtime.CHAT_TRANSCRIPT_REWRITE_DIAGNOSTIC_INTERVAL_MS),
  });

  const backends = [];
  try {
    if (plan.cardPolicy === 'd11-cards')
      d11 = await createD11Replay(plan, root);
    const result = await replay(
      runtime,
      plan,
      root,
      backends,
      rewrites,
      storageFormat,
      d11,
    );
    if (plan.cardPolicy !== 'stream-descriptor') return result;
    if (storageFormat !== 'v4')
      throw new Error('stream-descriptor policy requires --storage-format v4');
    return {
      ...result,
      childStreams: await runChildDescriptorScenario(
        runtime,
        root,
        plan,
        backends,
        rewrites,
      ),
    };
  } finally {
    try {
      await d11?.close();
    } finally {
      runtime.setChatTranscriptRewriteDiagnosticsForTests();
      for (const backend of backends)
        await backend.disposeArtifactMaintenance();
    }
  }
}

async function runChildDescriptorScenario(
  runtime,
  root,
  plan,
  backends,
  rewrites,
) {
  const streamCount = plan.streamCount ?? 26;
  const threshold = plan.byteScale < 1 ? 256 * 1024 : 4 * 1024 * 1024;
  const scenarioRoot = path.join(root, 'child-streams');
  const store = new runtime.ChatStorageV2(
    scenarioRoot,
    'child-scope',
    undefined,
    {
      maxManifestVersion: 4,
    },
  );
  const parent = 'child-parent';
  const unrelated = 'unrelated';
  const parentSeedBytes =
    plan.byteScale < 1 ? 2 * 1024 * 1024 : 32 * 1024 * 1024;
  await store.migrate(() =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: parent, runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* () {
        for (const id of [parent, unrelated])
          yield {
            metadata: { id, title: id, createdAt: '2026-10-06' },
            messages: (async function* () {
              const count =
                id === parent ? Math.ceil(parentSeedBytes / 4096) : 1;
              for (let index = 0; index < count; index++) {
                yield textRow(`${id}-seed-${index}`, index + 1, 4096);
                if (index % 256 === 255)
                  await new Promise((resolve) => setImmediate(resolve));
              }
            })(),
          };
      })(),
    }),
  );
  const backend = new runtime.ChatStateV2Backend(store, {
    deltaJournal: {
      checkpointJournalBytes: threshold,
      ...(plan.incrementalStreamMetadata
        ? { incrementalStreamMetadata: true }
        : {}),
    },
    enableFormat4: true,
  });
  backends.push(backend);
  await backend.promoteToDeltaJournal();
  await backend.promoteToFormat4();
  runtime.resetWorkCounters();
  const targets = Array.from({ length: streamCount }, (_, index) => ({
    kind: 'delegation',
    chatId: parent,
    delegationId: `child-${index}`,
    runGeneration: 0,
  }));
  const registrationStartedAt = performance.now();
  for (const target of targets) await backend.registerTranscriptStream(target);
  const registrationCounters = runtime.snapshotWorkCounters();
  if ((registrationCounters.chatStorage['deltaJournal.checkpoints'] ?? 0) !== 0)
    throw new Error('Registration-only child events caused a checkpoint');
  await backend.flush();
  const registrationMs = performance.now() - registrationStartedAt;
  runtime.resetWorkCounters();
  const childOnlyStart = runtime.snapshotWorkCounters();
  const beforeRewrites = rewrites.length;
  const checkpoints = [];
  const finalIds = new Map(targets.map((target) => [target.delegationId, []]));
  const item = (target, sequence, final, bytes) => ({
    id: `${target.delegationId}:item-${sequence}`,
    role: 'assistant',
    timestamp: sequence + 2,
    parentBlockId: target.delegationId,
    delegationSequence: sequence,
    itemRevision: 0,
    final,
    blocks: [{ type: 'text', text: filler(target.delegationId, bytes) }],
  });
  // One long-open item remains present through every size-triggered cycle.
  await backend.commitChildStream(targets[0], 'long-open', [
    item(targets[0], 0, false, 8_192),
  ]);
  const minimumJournalBytes = threshold * 10;
  let producedBytes = 0;
  let sequence = 1;
  let unrelatedCommits = 0;
  const unrelatedCommitMs = [];
  while (producedBytes < minimumJournalBytes) {
    const target = targets[sequence % targets.length];
    const row = item(target, sequence, true, 96 * 1024);
    const before = runtime.snapshotWorkCounters();
    await backend.commitChildStream(target, `child-final-${sequence}`, [row]);
    finalIds.get(target.delegationId).push(row.id);
    producedBytes += Buffer.byteLength(JSON.stringify(row));
    const afterEvent = runtime.snapshotWorkCounters();
    if (
      (afterEvent.chatStorage['deltaJournal.checkpoints'] ?? 0) !==
      (before.chatStorage['deltaJournal.checkpoints'] ?? 0)
    )
      throw new Error('One child event caused a checkpoint');
    if (backend.pendingPrimaryRecordCount() !== 0)
      throw new Error('Child-only record was classified as primary');
    if (backend.journalCheckpointDue()) {
      const cycleBefore = runtime.snapshotWorkCounters();
      await backend.checkpointPendingJournal();
      const cycleAfter = runtime.snapshotWorkCounters();
      checkpoints.push({
        trigger: 'size',
        sequence,
        before: cycleBefore.chatStorage,
        after: cycleAfter.chatStorage,
      });
    }
    if (sequence % 10 === 0) {
      const started = performance.now();
      await backend.transact(
        () => [
          {
            type: 'message.upserted',
            chatId: unrelated,
            message: textRow(`unrelated-${sequence}`, sequence + 2, 512),
          },
        ],
        { source: 'provider', chatIds: [unrelated] },
      );
      unrelatedCommitMs.push(performance.now() - started);
      unrelatedCommits += 1;
    }
    sequence += 1;
  }
  if (backend.pendingJournalRecords() > 0) {
    const cycleBefore = runtime.snapshotWorkCounters();
    await backend.checkpointPendingJournal();
    checkpoints.push({
      trigger: 'explicit-flush',
      sequence,
      before: cycleBefore.chatStorage,
      after: runtime.snapshotWorkCounters().chatStorage,
    });
  }
  const snapshot = runtime.snapshotWorkCounters();
  const counted = snapshot.chatStorage;
  const journalBytes = counted['written.deltaJournal.bytes'] ?? 0;
  const childRewriteBytes =
    (counted['written.childActiveSidecar.bytes'] ?? 0) +
    (counted['written.childStreamMetadata.bytes'] ?? 0);
  if (checkpoints.filter((cycle) => cycle.trigger === 'size').length < 2)
    throw new Error('Child-only workload did not span complete size cycles');
  const rewriteBoundPassed = childRewriteBytes <= journalBytes / 8;
  if (rewrites.length !== beforeRewrites)
    throw new Error('Child progress rewrote the parent transcript');
  const directory = path.join(
    store.directory,
    'transcripts',
    'delegations',
    parent,
    'v2',
  );
  const seen = new Map();
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const log = await readFile(
      path.join(directory, name, 'transcript.jsonl'),
      'utf8',
    );
    for (const line of log.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
    }
  }
  for (const ids of finalIds.values())
    for (const id of ids)
      if (seen.get(id) !== 1)
        throw new Error(`Final child row not appended exactly once: ${id}`);
  if (unrelatedCommits === 0)
    throw new Error('Unrelated chat made no progress');
  runtime.resetWorkCounters();
  const settleTarget = targets[1];
  const streamKey = createHash('sha256')
    .update(
      JSON.stringify(['delegation', parent, settleTarget.delegationId, 0]),
    )
    .digest('hex');
  const descriptor = JSON.parse(
    await readFile(path.join(directory, streamKey, 'descriptor.json'), 'utf8'),
  );
  const settleRevision = (await backend.revision()) + 1;
  await backend.commitChildStream(settleTarget, 'settlement-only', [], {
    key: 'settlement-only',
    descriptorUpdate: {
      version: 1,
      target: settleTarget,
      expectedStreamRevision: descriptor.streamRevision,
      nextStreamRevision: descriptor.streamRevision + 1,
      status: 'settled',
      settleReceipt: {
        mutationId: 'settlement-only',
        scopeRevision: settleRevision,
        streamRevision: descriptor.streamRevision + 1,
        committedRowCount: descriptor.committedRowCount,
        committedByteLength: descriptor.committedByteLength,
        committedSha256: descriptor.committedSha256,
      },
    },
  });
  const settlementCounters = runtime.snapshotWorkCounters();
  if ((settlementCounters.chatStorage['deltaJournal.checkpoints'] ?? 0) !== 0)
    throw new Error('Settlement-only child event caused a checkpoint');
  const fault = {
    enospcAttributed: false,
    retryRecovered: false,
    pendingCaptureRejected: false,
    checkpointedCaptureRecovered: false,
    lateEventRejected: false,
  };
  if (streamCount === 26) {
    const artifacts = backend.storage.transcripts.artifacts;
    const originalPut = artifacts.put.bind(artifacts);
    artifacts.put = async () => {
      throw Object.assign(new Error('injected disk exhaustion'), {
        code: 'ENOSPC',
      });
    };
    const faultRow = {
      ...item(targets[0], sequence, true, 0),
      blocks: [
        {
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: 'fault-tool',
          output: 'disk-bound '.repeat(20_000),
          isError: false,
        },
      ],
    };
    try {
      await backend.commitChildStream(targets[0], 'fault-retry', [faultRow]);
    } catch (error) {
      fault.enospcAttributed = error?.code === 'ENOSPC';
    } finally {
      artifacts.put = originalPut;
    }
    if (!fault.enospcAttributed) throw new Error('ENOSPC was not attributed');
    fault.retryRecovered = (
      await backend.commitChildStream(targets[0], 'fault-retry', [faultRow])
    ).applied;
    const captured = new runtime.ChatStorageV2(
      scenarioRoot,
      'concurrent-capture',
      undefined,
      { maxManifestVersion: 4 },
    );
    try {
      await store.copyTo(captured);
    } catch (error) {
      fault.pendingCaptureRejected = /checkpointed/.test(String(error));
    }
    if (!fault.pendingCaptureRejected)
      throw new Error('Pending capture was not rejected');
    await backend.flush();
    await store.copyTo(captured);
    fault.checkpointedCaptureRecovered = (await captured.authority()) === 'v2';
    await backend.storage.transcripts.childDeleteFence.retire(parent);
    try {
      await backend.commitChildStream(targets[0], 'late-after-cancel', []);
    } catch (error) {
      fault.lateEventRejected = /deleted/.test(String(error));
    }
    if (!fault.lateEventRejected)
      throw new Error('Late completion was not cancelled');
  }
  return {
    streamCount,
    threshold,
    parentSeedBytes,
    registrationMs: Math.round(registrationMs),
    registrationOnly: registrationCounters,
    settlementOnly: settlementCounters,
    fault,
    parentFullRewrites: rewrites.length - beforeRewrites,
    producedBytes,
    journalBytes,
    childRewriteBytes,
    rewriteBoundPassed,
    incrementalStreamMetadata: plan.incrementalStreamMetadata,
    ...(streamCount === 500 &&
    !rewriteBoundPassed &&
    !plan.incrementalStreamMetadata
      ? { deferred: 'incremental-stream-metadata-staging' }
      : {}),
    checkpointCycles: checkpoints,
    unrelatedCommits,
    unrelatedCommitLatency: latency(unrelatedCommitMs),
    finalRows: Array.from(finalIds.values()).reduce(
      (sum, ids) => sum + ids.length,
      0,
    ),
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    counters: { before: childOnlyStart, after: snapshot },
  };
}

async function replay(
  runtime,
  plan,
  root,
  backends,
  rewrites,
  storageFormat,
  d11,
) {
  const seedStartedAt = performance.now();
  const byScope = new Map();
  for (const owner of plan.owners) {
    if (!byScope.has(owner.scope)) byScope.set(owner.scope, []);
    byScope.get(owner.scope).push(owner);
  }
  const owners = [];
  for (const [scope, scopeOwners] of byScope) {
    const seeded = await seedScope(
      runtime,
      root,
      scope,
      scopeOwners,
      storageFormat,
      d11,
    );
    backends.push(seeded.backend);
    owners.push(...seeded.owners);
  }
  await d11?.prepareMeasurement();
  const seedMs = performance.now() - seedStartedAt;
  runtime.takeChatStorageActivity();
  rewrites.length = 0;

  const pooled = owners.filter((owner) => owner.provider === 'codex');
  const isolated = owners.filter((owner) => owner.provider !== 'codex');
  const failures = [];
  const pool = {
    paused: false,
    pauses: 0,
    pausedMs: 0,
    pausedAt: 0,
    wake: null,
  };
  let running = true;
  const lanes = new runtime.OwnerAdmissionLanes(
    {
      isLiveOwner: () => running,
      pauseSource: () => {
        pool.paused = true;
        pool.pauses += 1;
        pool.pausedAt = performance.now();
      },
      resumeSource: () => {
        pool.paused = false;
        pool.pausedMs += performance.now() - pool.pausedAt;
        pool.wake?.();
      },
      onSourcePauseChange: () => undefined,
      onAdmissionFailure: (error) => failures.push(error),
      onDeliveryFailure: (error) => failures.push(error),
      // The replay reports the pause itself; long-hold lines add nothing.
      reportLongHold: () => undefined,
      warnLongHold: () => undefined,
    },
    {
      highWaterBytes: runtime.DEFAULT_OWNER_LANE_HIGH_WATER_BYTES,
      lowWaterBytes: runtime.DEFAULT_OWNER_LANE_LOW_WATER_BYTES,
      longHoldThresholdMs: runtime.DEFAULT_LONG_STDOUT_HOLD_THRESHOLD_MS,
    },
  );

  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const utilizationStart = performance.eventLoopUtilization();
  const startedAt = performance.now();
  const deadline = startedAt + plan.durationMs;
  d11?.begin(startedAt, deadline);
  const inFlight = new Set();
  const track = (promise) => {
    inFlight.add(promise);
    void promise.then(
      () => inFlight.delete(promise),
      (error) => {
        inFlight.delete(promise);
        failures.push(error);
      },
    );
    return promise;
  };

  const loops = isolated.map(async (owner) => {
    while (performance.now() < deadline && failures.length === 0) {
      try {
        await owner.next();
      } catch (error) {
        failures.push(error);
      }
    }
  });
  // One round of the pipe: each pooled owner's frames in its captured share.
  const schedule = pooled.flatMap((owner) =>
    Array.from({ length: owner.frameWeight }, () => owner),
  );
  const pump = (async () => {
    // One ordered pipe: frames for every pooled owner interleave, and none is
    // read while the lanes hold the source paused.
    while (
      pooled.length > 0 &&
      performance.now() < deadline &&
      failures.length === 0
    ) {
      if (pool.paused) {
        await new Promise((resolve) => {
          pool.wake = resolve;
          setTimeout(resolve, Math.max(0, deadline - performance.now()));
        });
        continue;
      }
      for (
        let round = 0;
        round < PUMP_BATCH_ROUNDS && !pool.paused;
        round += 1
      ) {
        for (const owner of schedule) {
          owner.dispatched += 1;
          lanes.dispatch(owner, {
            kind: 'notification',
            measureBytes: () => plan.frameBytes,
            deliver: () => {
              if (!running) return undefined;
              if (owner.starvedAt !== undefined) {
                owner.starvedMs += performance.now() - owner.starvedAt;
                owner.starvedAt = undefined;
              }
              owner.delivered += 1;
              return track(
                owner.next().then(() => {
                  // Every frame read for this owner is committed, yet the
                  // pipe stays paused behind another owner's backlog.
                  if (owner.delivered === owner.dispatched && pool.paused)
                    owner.starvedAt = performance.now();
                }),
              );
            },
          });
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  await Promise.all([...loops, pump]);
  // Frames still queued at the deadline are the backlog; drop them and let
  // the commits already admitted finish.
  running = false;
  if (pool.paused) pool.pausedMs += performance.now() - pool.pausedAt;
  for (const owner of pooled)
    if (owner.starvedAt !== undefined)
      owner.starvedMs += performance.now() - owner.starvedAt;
  lanes.discardAll();
  await Promise.allSettled(Array.from(inFlight));
  const foregroundDrainedMs = performance.now() - startedAt;
  await d11?.drain();
  const elapsedMs = performance.now() - startedAt;
  loopDelay.disable();
  const utilization = performance.eventLoopUtilization(utilizationStart);
  const activity = runtime.takeChatStorageActivity();
  // Thrown only now, with every admitted commit settled: the caller removes
  // the fixture directory next.
  if (failures.length > 0) throw failures[0];
  // The correctness oracle reads outside the measured window and counters.
  const d11Cards = d11 ? await d11.verify({ foregroundDrainedMs }) : undefined;

  const scopeActivity = new Map(
    (activity?.scopes ?? []).map((scope) => [
      scope.identity?.worktreeId,
      scope.activity,
    ]),
  );
  const scopeEvents = new Map();
  for (const owner of owners)
    scopeEvents.set(
      owner.scope,
      (scopeEvents.get(owner.scope) ?? 0) + owner.events,
    );
  const total = activity?.total;
  return {
    benchmark: 'chat-storage-field-load',
    cardPolicy: plan.cardPolicy,
    capture: plan.label,
    byteScale: plan.byteScale,
    durationMs: Math.round(elapsedMs),
    seedMs: Math.round(seedMs),
    ...(d11Cards ? { d11Cards, resolvedPlan: plan } : {}),
    perMinute: {
      commits: perMinute(total?.commits ?? 0, elapsedMs),
      mutations: perMinute(total?.mutations ?? 0, elapsedMs),
      bytesWritten: perMinute(total?.bytesWritten ?? 0, elapsedMs),
      fileSyncs: perMinute(total?.fileSyncs ?? 0, elapsedMs),
      directorySyncs: perMinute(total?.directorySyncs ?? 0, elapsedMs),
      commitMsTotal: perMinute(total?.commitMsTotal ?? 0, elapsedMs),
      committedRewrites: perMinute(rewrites.length, elapsedMs),
    },
    commitMsMax: total?.commitMsMax ?? 0,
    eventLoop: {
      utilization: Number(utilization.utilization.toFixed(3)),
      delayP99Ms: Number((loopDelay.percentile(99) / 1e6).toFixed(1)),
      delayMaxMs: Number((loopDelay.max / 1e6).toFixed(1)),
    },
    codexPool: {
      owners: pooled.length,
      frameBytes: plan.frameBytes,
      sourcePauses: pool.pauses,
      sourcePausedMs: Math.round(pool.pausedMs),
      sourcePausedShare: Number((pool.pausedMs / elapsedMs).toFixed(3)),
    },
    owners: owners.map((owner) => ({
      scope: owner.scope,
      chat: owner.chat,
      provider: owner.provider,
      committedBytes: owner.committedBytes,
      seededRows: owner.seededRows,
      runningCards: owner.cardByteFractions.length,
      patchShare: Number(owner.patchShare.toFixed(3)),
      commitsPerMinute: perMinute(owner.events, elapsedMs),
      // Bytes are counted per scope; chats sharing one share this mean.
      scopeBytesWrittenPerCommit: Math.round(
        (scopeActivity.get(owner.scope)?.bytesWritten ?? 0) /
          Math.max(1, scopeEvents.get(owner.scope)),
      ),
      append: latency(owner.appendMs),
      cardPatch: latency(owner.patchMs),
      ...(owner.provider === 'codex'
        ? {
            // Time this owner had nothing to commit while the shared pipe
            // was paused at the cap by other owners' queued frames.
            frameWeight: owner.frameWeight,
            starvedShare: Number((owner.starvedMs / elapsedMs).toFixed(3)),
            backlogFrames: owner.dispatched - owner.delivered,
          }
        : {}),
      field: owner.field,
    })),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'smoke' },
      'storage-format': { type: 'string', default: 'v2' },
      capture: { type: 'string' },
      'duration-ms': { type: 'string' },
      'byte-scale': { type: 'string' },
      'card-policy': { type: 'string', default: 'legacy' },
      'stream-count': { type: 'string' },
      'incremental-stream-metadata': { type: 'boolean', default: false },
      output: { type: 'string' },
    },
  });
  if (
    ![
      'legacy',
      'persisted-projection',
      'stream-descriptor',
      'd11-cards',
    ].includes(values['card-policy'])
  )
    throw new Error(`Unknown card policy: ${values['card-policy']}`);
  const base = FIELD_LOAD_PROFILES[values.profile];
  if (!base) throw new Error(`Unknown profile: ${values.profile}`);
  const storageFormat = storageFormatOption(values['storage-format']);
  const profile = {
    ...base,
    ...(values['duration-ms']
      ? { durationMs: Number(values['duration-ms']) }
      : {}),
    ...(values['byte-scale']
      ? { byteScale: Number(values['byte-scale']) }
      : {}),
    cardPolicy: values['card-policy'],
    ...(values['stream-count']
      ? { streamCount: Number(values['stream-count']) }
      : {}),
    incrementalStreamMetadata: values['incremental-stream-metadata'],
  };
  const capturePath = values.capture
    ? path.resolve(values.capture)
    : fileURLToPath(DEFAULT_CAPTURE);
  const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  const plan = fieldLoadReplayPlan(capture, profile);
  if (plan.owners.length === 0)
    throw new Error(`${capturePath} has no working-set chat to replay`);
  const root = await mkdtemp(path.join(tmpdir(), 'canopy-field-load-'));
  try {
    const replay = {
      profile: values.profile,
      storageFormat,
      ...(await runFieldLoadReplay(plan, { root, storageFormat })),
    };
    const output = path.resolve(
      values.output ??
        `.performance/desktop/chat-storage-field-load-${values.profile}.json`,
    );
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(
        {
          ...replay,
          // The capture's own per-minute medians, to read the replay against.
          field: {
            chatStorage: capture.diagnostics?.chatStorage,
            codexStdoutHolds: capture.diagnostics?.codexStdoutHolds,
          },
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
    if (replay.d11Cards && !replay.d11Cards.correctness.passed)
      throw new Error(
        `D11 correctness failed: ${replay.d11Cards.correctness.violations.join('; ')}`,
      );
    if (
      replay.childStreams &&
      !replay.childStreams.rewriteBoundPassed &&
      (replay.childStreams.streamCount !== 500 ||
        replay.childStreams.incrementalStreamMetadata)
    )
      throw new Error(
        'Child sidecar and metadata rewrite bytes exceeded journal bytes / 8',
      );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().then(
    // Storage maintenance timers must not keep a finished benchmark alive.
    () => process.exit(process.exitCode ?? 0),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
