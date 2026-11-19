#!/usr/bin/env node
/**
 * B4 retained-delegation replay heap probe.
 *
 * Uses a private Jest harness to exercise the real ChatStateService,
 * ChatStateV2Repository/Backend, FileDelegationStorage, and
 * createManagedDelegationSession path. Only the provider/runner launch path is
 * idle: retained records are already settled, so replay never starts a child.
 *
 * Run unchanged and candidate from the repository root:
 *   node --expose-gc apps/desktop-app/tests/performance/b4-replay-heap-probe.mjs
 *   node --expose-gc apps/desktop-app/tests/performance/b4-replay-heap-probe.mjs --chats 4 --rows 10000
 *
 * All generated files and chat/delegation fixtures are placed under TMPDIR.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../',
);
const defaults = {
  chats: 4,
  rows: 10_000,
  textBytes: 256,
  recordsPerChat: 2,
  eagerControl: false,
};

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`--${name} must be a positive safe integer`);
  return parsed;
}

function parseArgs(args) {
  const values = { ...defaults };
  for (let index = 0; index < args.length; index += 1) {
    const match = /^--(chats|rows|text-bytes|records-per-chat)=(.*)$/.exec(
      args[index],
    );
    if (match) {
      const key =
        { 'text-bytes': 'textBytes', 'records-per-chat': 'recordsPerChat' }[
          match[1]
        ] ?? match[1];
      values[key] = positiveInteger(match[1], match[2]);
      continue;
    }
    if (args[index] === '--eager-control') {
      values.eagerControl = true;
      continue;
    }
    if (args[index] === '--help') {
      process.stdout.write(
        'Usage: node b4-replay-heap-probe.mjs [--chats N] [--rows N] [--text-bytes N] [--records-per-chat N] [--eager-control]\n',
      );
      process.exit(0);
    }
    const name = args[index]?.replace(/^--/, '');
    if (!['chats', 'rows', 'text-bytes', 'records-per-chat'].includes(name))
      throw new Error(`Unknown option: ${args[index]}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for --${name}`);
    const key =
      { 'text-bytes': 'textBytes', 'records-per-chat': 'recordsPerChat' }[
        name
      ] ?? name;
    values[key] = positiveInteger(name, value);
    index += 1;
  }
  if (values.chats < 2) throw new Error('--chats must be at least 2');
  if (values.rows < 100) throw new Error('--rows must be at least 100');
  if (values.textBytes < 32)
    throw new Error('--text-bytes must be at least 32');
  return values;
}

function harnessSource(config, root) {
  const imports = (file) => path.join(repoRoot, file).replaceAll('\\', '/');
  const moduleImports = {
    storage: imports('packages/desktop-shared/src/node/delegation/storage.ts'),
    lifecycle: imports(
      'packages/desktop-shared/src/node/delegation/lifecycle.ts',
    ),
    backend: imports(
      'apps/desktop-app/src/main/services/chat-state-v2-backend.ts',
    ),
    repository: imports(
      'apps/desktop-app/src/main/services/chat-state-v2-repository.ts',
    ),
    service: imports(
      'apps/desktop-app/src/main/services/chat-state-service.ts',
    ),
    paths: imports('apps/desktop-app/src/main/lib/paths.ts'),
    delegation: imports(
      'apps/desktop-app/src/main/agents/delegation/service.ts',
    ),
    interfacePort: imports(
      'apps/desktop-app/src/main/agents/agent-interface-port.ts',
    ),
    fixture: imports(
      'apps/desktop-app/src/main/__tests__/helpers/chat-delta-journal-harness.ts',
    ),
  };
  return `// @ts-nocheck
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ChatStorageV2 } from ${JSON.stringify(imports('apps/desktop-app/src/main/lib/chat-storage-v2.ts'))};
import { FileDelegationStorage } from ${JSON.stringify(moduleImports.storage)};
import { ChatStateV2Backend } from ${JSON.stringify(moduleImports.backend)};
import { ChatStateV2Repository } from ${JSON.stringify(moduleImports.repository)};
import { ChatStateService, resetChatStateServiceForTests } from ${JSON.stringify(moduleImports.service)};
import { getWorktreeDataDir } from ${JSON.stringify(moduleImports.paths)};
import { createDelegationRunState } from ${JSON.stringify(moduleImports.lifecycle)};
import { createManagedDelegationSession, shutdownManagedDelegations } from ${JSON.stringify(moduleImports.delegation)};
import { windowAgentInterfacePort } from ${JSON.stringify(moduleImports.interfacePort)};
import { scopeSource, message } from ${JSON.stringify(moduleImports.fixture)};

const config = ${JSON.stringify(config)};
const tempRoot = ${JSON.stringify(root)};
const projectId = 'b4-probe-project';
const worktreeId = 'b4-probe-scope';
const scope = { projectId, worktreeId };
const parentIds = Array.from({ length: config.chats }, (_, index) => 'b4-parent-' + String(index).padStart(2, '0'));
const unrelatedLiveId = 'b4-unrelated-live';
const unrelatedArchivedId = 'b4-unrelated-archived';
const archivedId = unrelatedArchivedId;
const allIds = [...parentIds, unrelatedLiveId, unrelatedArchivedId];
const archiveKey = path.join(tempRoot, 'chat-data');
const paths = {
  tabs: path.join(archiveKey, 'chats', worktreeId + '.json'),
  archives: path.join(archiveKey, 'chat-archives', worktreeId + '.json'),
  journal: path.join(archiveKey, 'chat-journals', worktreeId + '.jsonl'),
};
const parentSet = new Set(parentIds);
const measurements = {
  coldScopeLoad: { fullTranscriptCalls: 0, parentTranscripts: 0, unrelatedLiveTranscripts: 0, unrelatedArchivedTranscripts: 0, parentRows: 0, unrelatedLiveRows: 0, unrelatedArchivedRows: 0, peakHeapBytes: 0, retainedAboveStartBytes: 0, heldByReadBytes: 0 },
  replayScan: { fullTranscriptCalls: 0, parentTranscripts: 0, unrelatedLiveTranscripts: 0, unrelatedArchivedTranscripts: 0, parentRows: 0, unrelatedLiveRows: 0, unrelatedArchivedRows: 0, streamedParentReads: 0, peakHeapBytes: 0, retainedAboveStartBytes: 0, heldByReadBytes: 0 },
};
// Fixture seeding reads before the measured window are not replay reads.
let measuring = false;
let activePhase;
let peakHeapBytes = 0;
let startHeapBytes = 0;
let publishedTranscripts = 0;
let sessions = [];
let repository;
let chatService;
const sampleHeap = () => {
  const heapUsedBytes = process.memoryUsage().heapUsed;
  peakHeapBytes = Math.max(peakHeapBytes, heapUsedBytes);
  if (activePhase) measurements[activePhase].peakHeapBytes = Math.max(measurements[activePhase].peakHeapBytes, heapUsedBytes);
};
// The sampled peak includes garbage V8 has not collected yet, so it varies
// with GC timing. Retained bytes force a collection where a read holds the
// most: after a full read returns, or halfway through a streamed parent.
// Held bytes subtract a collection taken just before that read starts.
const collectedHeap = () => {
  global.gc();
  return process.memoryUsage().heapUsed;
};
const recordHeld = (phase, before) => {
  if (!global.gc) return;
  const counts = measurements[phase];
  const held = collectedHeap();
  counts.retainedAboveStartBytes = Math.max(counts.retainedAboveStartBytes, held - startHeapBytes);
  counts.heldByReadBytes = Math.max(counts.heldByReadBytes, held - before);
};
const originalConsumeTranscript = ChatStateV2Backend.prototype.consumeTranscript;
ChatStateV2Backend.prototype.consumeTranscript = function(chatId, fullOutputs, consume, options) {
  if (!parentSet.has(chatId)) return originalConsumeTranscript.call(this, chatId, fullOutputs, consume, options);
  measurements.replayScan.streamedParentReads += 1;
  const half = Math.floor(config.rows / 2);
  // Collect before the read opens its reader, so active rows and reader
  // setup count as held.
  const before = global.gc ? collectedHeap() : 0;
  return originalConsumeTranscript.call(this, chatId, fullOutputs, (messages) => consume((async function* () {
    // The negative control drains every row first, as an eager reader would;
    // the gate must report it as holding the transcript.
    let rows = messages;
    if (config.eagerControl) {
      const drained = [];
      for await (const row of messages) drained.push(row);
      rows = drained;
    }
    let index = 0;
    for await (const row of rows) {
      index += 1;
      if (index === half) recordHeld('replayScan', before);
      yield row;
    }
  })()), options);
};
const originalState = ChatStateV2Backend.prototype.state;
ChatStateV2Backend.prototype.state = async function(selection = {}) {
  const isColdLoad = selection.fullTranscript === true && selection.rawStreamCards === true;
  const phase =
    measuring && selection.fullTranscript === true ? (isColdLoad ? 'coldScopeLoad' : 'replayScan') : undefined;
  const previousPhase = activePhase;
  if (phase) { activePhase = phase; sampleHeap(); }
  const before = phase && global.gc ? collectedHeap() : 0;
  try {
    const state = await originalState.call(this, selection);
    if (phase) {
      const wanted = selection.chatIds ? new Set(selection.chatIds) : undefined;
      const live = state.tabsFile.tabs.filter((tab) => !wanted || wanted.has(tab.id));
      const archived = state.archivesFile.archived.map((entry) => entry.tab).filter((tab) => !wanted || wanted.has(tab.id));
      const selected = [...live.map((tab) => ({ tab, location: 'live' })), ...archived.map((tab) => ({ tab, location: 'archived' }))];
      const counts = measurements[phase];
      counts.fullTranscriptCalls += 1;
      for (const { tab, location } of selected) {
        if (parentSet.has(tab.id)) {
          counts.parentTranscripts += 1;
          counts.parentRows += tab.messages.length;
        } else if (tab.id === unrelatedLiveId && location === 'live') {
          counts.unrelatedLiveTranscripts += 1;
          counts.unrelatedLiveRows += tab.messages.length;
        } else if (tab.id === unrelatedArchivedId && location === 'archived') {
          counts.unrelatedArchivedTranscripts += 1;
          counts.unrelatedArchivedRows += tab.messages.length;
        }
      }
      sampleHeap();
      recordHeld(phase, before);
    }
    return state;
  } finally {
    activePhase = previousPhase;
  }
};
const sampler = setInterval(sampleHeap, 5);
sampler.unref();

function content(bytes, seed) {
  const prefix = seed + ':';
  return (prefix + 'x'.repeat(bytes)).slice(0, bytes);
}
function makeChat(id, retainedParent) {
  const rows = Array.from({ length: config.rows }, (_, index) =>
    message(index === 0 && retainedParent ? id + '-anchor' : id + '-row-' + index,
      index === 0 && retainedParent ? 'retained anchor ' + id : content(config.textBytes, id + '-' + index),
      index % 2 === 0 ? 'user' : 'assistant', index + 1),
  );
  return { id, rows };
}
function recordFor(chatId, generationIndex) {
  const delegationId = randomUUID();
  const callKey = createHash('sha256').update(delegationId).digest('hex');
  const parent = {
    harnessId: 'claude', projectId, worktreeId, chatId,
    sessionKey: projectId + '/' + worktreeId + '/' + chatId,
    turnId: chatId + '-anchor', toolCallId: chatId + '-tool-' + generationIndex,
    runtimeGeneration: 1, depth: 0,
  };
  const state = {
    ...createDelegationRunState(delegationId, 1),
    sequence: 1, status: 'completed', startedAt: 1, finishedAt: 2,
    transcript: [], finalText: 'retained result', outputTruncated: false,
  };
  return {
    version: 1, depth: 1, parent,
    task: { modelId: 'probe-model', description: 'Retained fixture', prompt: 'Retained fixture', executionMode: 'background', contextPolicy: 'task_only', isolation: 'shared_worktree' },
    callKey, requestHash: callKey, createdAt: 1, state,
    launch: { version: 1, delegationId, launchKey: callKey, runGeneration: 1, phase: 'settled', terminalStatus: 'completed' },
    delivery: { status: 'unclaimed' },
  };
}

test('measures real retained delegation replay against a cold fixture scope', async () => {
  const data = await Promise.all([
    ...parentIds.map((id) => Promise.resolve(makeChat(id, true))),
    Promise.resolve(makeChat(unrelatedLiveId, false)),
    Promise.resolve(makeChat(unrelatedArchivedId, false)),
  ]);
  const chats = data.map(({ id, rows }) => ({ id, messages: rows }));
  const store = ChatStorageV2.fromLegacyPaths(paths, { maxManifestVersion: 4 });
  await store.migrate(scopeSource(chats));
  const seedRepository = new ChatStateV2Repository({ resolvePaths: () => paths });
  const beforeArchive = await seedRepository.getState(scope, { chatIds: [archivedId], fullTranscript: true });
  const archivedTab = beforeArchive.tabsFile.tabs.find((tab) => tab.id === archivedId);
  if (!archivedTab) throw new Error('Archive fixture tab was not seeded');
  await seedRepository.transact(scope, [
    { type: 'tab.removed', tabId: archivedId },
    { type: 'archive.upserted', entry: { tab: archivedTab, archivedAt: new Date(1).toISOString(), turnCount: 1 } },
  ], { source: 'migration', chatIds: [archivedId], fullTranscript: true });
  await seedRepository.drainAll();

  const runsDirectory = path.join(getWorktreeDataDir(projectId, worktreeId), 'delegation', 'runs');
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  let recordCount = 0;
  for (const chatId of parentIds) {
    for (let generationIndex = 0; generationIndex < config.recordsPerChat; generationIndex += 1) {
      const record = recordFor(chatId, generationIndex);
      await writeFile(path.join(runsDirectory, record.state.delegationId + '.json'), JSON.stringify(record), { mode: 0o600 });
      recordCount += 1;
    }
  }
  // Prove the real retained-record reader can load the seeded fixture before
  // installing the measured service. No decoded record is retained below.
  const records = await new FileDelegationStorage(runsDirectory).load();
  if (records.length !== recordCount) throw new Error('Fixture record count mismatch');
  data.length = 0;
  chats.length = 0;
  if (global.gc) global.gc();
  await new Promise((resolve) => setImmediate(resolve));
  if (global.gc) global.gc();
  startHeapBytes = process.memoryUsage().heapUsed;
  peakHeapBytes = startHeapBytes;
  measuring = true;

  repository = new ChatStateV2Repository({ resolvePaths: () => paths });
  chatService = new ChatStateService({ repository });
  resetChatStateServiceForTests(chatService);
  for (const chatId of parentIds) {
    activePhase = 'replayScan';
    sessions.push(await createManagedDelegationSession({
      harness: 'claude',
      sessionKey: projectId + '/' + worktreeId + '/' + chatId,
      currentOptions: () => ({ projectId, worktreeId, chatId, cwd: tempRoot }),
      currentTurn: () => undefined,
      interfacePort: windowAgentInterfacePort(() => null),
      onTranscript: () => { publishedTranscripts += 1; },
    }));
    sampleHeap();
  }
  activePhase = undefined;
  measuring = false;
  clearInterval(sampler);
  if (publishedTranscripts !== recordCount)
    throw new Error('Expected all retained records to replay: ' + publishedTranscripts + '/' + recordCount);

  const coldLoad = { ...measurements.coldScopeLoad };
  const replay = { ...measurements.replayScan };
  // Keep the aggregate peak consistent even if Jest's async phase sampler
  // observes a larger phase-local sample than the outer interval callback.
  const measuredPeakHeapBytes = Math.max(
    peakHeapBytes,
    measurements.coldScopeLoad.peakHeapBytes,
    measurements.replayScan.peakHeapBytes,
  );
  await shutdownManagedDelegations();
  sessions.length = 0;
  await chatService.drain();
  resetChatStateServiceForTests();
  ChatStateV2Backend.prototype.state = originalState;
  ChatStateV2Backend.prototype.consumeTranscript = originalConsumeTranscript;
  repository = undefined;
  chatService = undefined;
  await new Promise((resolve) => setImmediate(resolve));
  if (global.gc) { global.gc(); await new Promise((resolve) => setImmediate(resolve)); global.gc(); }
  const postDrainHeapBytes = process.memoryUsage().heapUsed;
  const result = {
    schemaVersion: 1,
    probe: 'B4 retained delegation replay heap',
    environment: { node: process.version, platform: process.platform, arch: process.arch, gcExposed: typeof global.gc === 'function' },
    fixture: { eagerControl: config.eagerControl, parentChats: config.chats, unrelatedLiveChats: 1, unrelatedArchivedChats: 1, rowsPerChat: config.rows, textBytesPerRow: config.textBytes, recordsPerParent: config.recordsPerChat, totalRetainedRecords: recordCount },
    heap: { startHeapBytes, peakHeapBytes: measuredPeakHeapBytes, peakAboveStartBytes: measuredPeakHeapBytes - startHeapBytes, postDrainHeapBytes, postDrainAboveStartBytes: postDrainHeapBytes - startHeapBytes },
    coldScopeLoad: coldLoad,
    replayScan: replay,
    replayPublishedTranscripts: publishedTranscripts,
    note: 'Cold load and replay materialization counts are separate. Cold load counts the repository load-time fullTranscript projection; replay counts per-parent service reads. retainedAboveStartBytes is measured after a forced collection where each read holds the most, and heldByReadBytes subtracts a collection taken just before that read; the sampled peak includes uncollected garbage. Heap values are harness measurements, not a deterministic budget.',
  };
  await writeFile(process.env.B4_RESULT_PATH, JSON.stringify(result, null, 2) + '\\n');
}, 300_000);
`;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'canopy-b4-replay-heap-'));
  const testDir = path.join(tempRoot, '__tests__');
  await mkdir(testDir, { recursive: true, mode: 0o700 });
  const testPath = path.join(testDir, 'b4-replay-heap-probe.test.ts');
  const resultPath = path.join(tempRoot, 'result.json');
  await writeFile(testPath, harnessSource(config, tempRoot), { mode: 0o600 });
  const jestCli = path.join(repoRoot, 'node_modules/jest/bin/jest.js');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    CANOPY_DATA_DIR: path.join(tempRoot, 'data'),
    CANOPY_SECURE_DATA_DIR: path.join(tempRoot, 'secure'),
    B4_RESULT_PATH: resultPath,
  };
  const run = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      jestCli,
      '--config',
      path.join(repoRoot, 'jest.config.js'),
      '--runInBand',
      '--runTestsByPath',
      testPath,
      '--roots',
      testDir,
      '--no-coverage',
      '--verbose=false',
    ],
    { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    process.stderr.write(run.stdout ?? '');
    process.stderr.write(run.stderr ?? '');
    throw new Error(
      `B4 Jest harness exited ${run.status ?? 'without a status'}`,
    );
  }
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await rm(tempRoot, { recursive: true, force: true });
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
