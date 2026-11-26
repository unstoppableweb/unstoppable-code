// CAN-4169 golden: run sharing as desktop serves it before core.publication
// takes ownership. Real runs:share, runs:share-eligibility and runs:unshare
// handlers, shared-run sync, comments registry, cloud client, account store
// and auto-updater, on a data root the golden owns. Replaced: IPC
// registration, the cloud base URL, HTTP (an in-test runs server) and the
// session sources a share reads. Timers and the clock are faked. Re-record
// deliberately with `pnpm test <this file> -u` and review the diff.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareEntries,
  matchesHistoryRequest,
  normalizeAuditEntry,
} from '@canopy/core-runtime/observability';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { AgentAuditEntry } from '@canopy/execution-engine/types/observability';
import { isUuid } from '@canopy/protocol/uuid';
import type * as CloudConfig from '../canopy-cloud/config';
import type * as ChatTabsReader from '../lib/chat-tabs-reader';
import type * as AutoUpdater from '../services/shared-run-auto-updater';
import {
  cloud,
  fakeCloud,
  diagnostics,
  drain,
  FIXED_TIME,
  handlers,
  invoke,
  must,
  isRecord,
  LAPSED_TEAM_ID,
  mark as markLists,
  json,
  observability,
  ORG_ID,
  fault,
  ownDataRoot,
  registryFile as readRegistry,
  runId,
  saveAccount,
  savedShares,
  saveShare,
  session,
  since,
  stable,
  TEAM_ID,
  teamShare,
  track,
  WORKSPACE_ID,
  WORKTREE_ID,
  type Json,
  type OwnedDataRoot,
  type RecordedRequest,
} from './helpers/shared-runs-golden-harness';

jest.setTimeout(30_000);

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));
// Share failures log a warning; keep the run output readable.
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../lib/main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<typeof ChatTabsReader>('../lib/chat-tabs-reader'),
  readSharedRunMetadata: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<unknown> =>
    Promise.resolve(
      savedShares.get(`${projectId}/${worktreeId}/${chatId}`) ?? null,
    ),
}));
// Audit history a share reads, and the auto-updater's entries listeners.
const auditEntries: Json[] = [];
const observabilityListeners = new Set<(event: unknown) => void>();
const sharingObservability = {
  ...observability,
  // As ObservabilityService.loadHistory: parsed rows, newest first.
  loadHistory: (
    request: Parameters<typeof matchesHistoryRequest>[1],
  ): Promise<{ entries: AgentAuditEntry[] }> =>
    Promise.resolve({
      entries: auditEntries
        .map((entry) => must(normalizeAuditEntry(entry)))
        .filter((entry) => matchesHistoryRequest(entry, request))
        .sort(compareEntries),
    }),
  subscribe: (listener: (event: unknown) => void): (() => boolean) => {
    observabilityListeners.add(listener);
    return () => observabilityListeners.delete(listener);
  },
};
jest.mock('../observability', () => ({
  getObservabilityService: (): typeof sharingObservability =>
    sharingObservability,
}));

const ingestCalls: unknown[][] = [];
const ingestResults: Json[] = [];
const telemetrySync = {
  ingestSessionForShare: (...args: unknown[]): Promise<Json> => {
    ingestCalls.push(args);
    return Promise.resolve(
      ingestResults.shift() ?? {
        status: 'ok',
        workspaceLocalId: 'share-ws-1',
        worktreeLocalId: 'share-wt-1',
      },
    );
  },
};
jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: (): typeof telemetrySync => telemetrySync,
}));
const flushes: string[] = [];
const chatState = {
  flushScope: (projectId: string, worktreeId: string): Promise<void> => {
    flushes.push(`${projectId}/${worktreeId}`);
    return Promise.resolve();
  },
};
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): typeof chatState => chatState,
}));
// An obviously fake token in the diff pins that the share redacts it.
const FAKE_DIFF_TOKEN = `ghp_${'0'.repeat(36)}`;
jest.mock('../services/diff-service', () => ({
  readDiff: (): Promise<{ patch: string }> =>
    Promise.resolve({
      patch: `diff --git a/upload.ts b/upload.ts\n+const token = '${FAKE_DIFF_TOKEN}';\n`,
    }),
}));

interface ServerRun {
  externalId: string;
  clientLocalRunId: string;
  shareScope: unknown;
  title: unknown;
  clientChatId: unknown;
}
const serverRuns = new Map<string, ServerRun>();
let mintedRuns = 0;
const byClientRunId = (id: unknown): ServerRun | undefined =>
  [...serverRuns.values()].find((run) => run.clientLocalRunId === id);
const byClientChatId = (chatId: string): ServerRun | undefined =>
  [...serverRuns.values()].find((run) => run.clientChatId === chatId);

cloud.route = (method, path, body): Response => {
  const match = /^<api>\/runs(?:\/([^/]+))?$/.exec(path);
  if (match && !match[1] && method === 'POST') {
    // As apps/web/src/lib/runs/run-service.ts parseOptionalUuid does.
    for (const field of ['teamId', 'organizationId']) {
      const id = body[field] ?? '';
      if (id !== '' && (typeof id !== 'string' || !isUuid(id)))
        return json(400, { error: `${field} must be a valid UUID` });
    }
    // The server upserts by (author, clientLocalRunId).
    let run = byClientRunId(body.clientLocalRunId);
    // As run-service.ts: a background refresh never recreates a deleted grant.
    if (!run && body.preserveExistingOwner === true) {
      return json(404, { error: 'Run not found' });
    }
    if (!run) {
      mintedRuns += 1;
      run = {
        externalId: runId(mintedRuns),
        clientLocalRunId: String(body.clientLocalRunId),
        shareScope: body.shareScope,
        title: body.title,
        clientChatId: body.clientChatId,
      };
      serverRuns.set(run.externalId, run);
    }
    run.title = body.title;
    if (body.preserveExistingOwner !== true) run.shareScope = body.shareScope;
    const { externalId, shareScope, title } = run;
    const dates = { createdAt: FIXED_TIME, updatedAt: FIXED_TIME };
    return json(201, { externalId, shareScope, title, ...dates });
  }
  const run = match?.[1] ? byClientRunId(decodeURIComponent(match[1])) : null;
  if (!run || method !== 'DELETE') {
    return json(404, { error: 'Run not found.' });
  }
  serverRuns.delete(run.externalId);
  return json(200, { unshared: true });
};

const { faults } = cloud;
let owned: OwnedDataRoot | undefined;
let dataDir: string;
let autoUpdater:
  | ReturnType<typeof AutoUpdater.getSharedRunAutoUpdater>
  | undefined;

function mark(): void {
  markLists(cloud.requests, diagnostics);
  ingestCalls.length = 0;
  flushes.length = 0;
}
const newRequests = (): RecordedRequest[] => since(cloud.requests);
const newDiagnostics = (): Json[] => since(diagnostics);
const registryFile = (): unknown => readRegistry(dataDir);
/** One chat's comments registry row, without the rows other cases add. */
function registryRow(chatId: string): unknown {
  const file = registryFile();
  const entries: unknown[] =
    isRecord(file) && Array.isArray(file.entries) ? file.entries : [];
  return (
    entries.find((entry) => isRecord(entry) && entry.chatId === chatId) ?? null
  );
}

let auditSequence = 0;
/** A finished worktree chat turn, as observability persists it; each is newer. */
function auditEntry(chatId: string, overrides: Json = {}): Json {
  auditSequence += 1;
  const startedAt = Date.parse(FIXED_TIME) + auditSequence * 1_000;
  return {
    id: `audit-${String(auditSequence).padStart(3, '0')}`,
    startedAt: new Date(startedAt).toISOString(),
    toolCounts: {},
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    model: 'claude-golden-model',
    label: 'Fix the flaky upload test',
    durationMs: 1_000,
    totalCostUsd: 0.25,
    tokens: {
      input: 100,
      output: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    },
    toolUseCount: 4,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId,
    ...overrides,
  };
}

// As observability/service.ts upsertRecentEntry: history first, then the event.
function finishTurn(entry: Json): void {
  auditEntries.push(entry);
  const parsed = must(normalizeAuditEntry(entry));
  for (const listener of observabilityListeners) {
    listener({ type: 'entries', entries: [parsed] });
  }
}

beforeAll(async () => {
  // The golden owns its data roots before any code under test loads.
  owned = ownDataRoot('shared-runs-golden-');
  dataDir = owned.dataDir;
  // A personal single-repo workspace, so the share's work owner is none.
  const workspaceDir = join(dataDir, 'workspaces', WORKSPACE_ID);
  const worktreePath = join(workspaceDir, 'worktrees', WORKTREE_ID);
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: worktreePath,
      repos: [],
    }),
  );

  jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
  jest.useFakeTimers({
    now: new Date(FIXED_TIME),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'queueMicrotask',
      'hrtime',
      'performance',
    ],
  });

  await saveAccount(['runs-crud-v1', 'run-comments-v1']);
  const registry = await import('../lib/workspace-registry');
  registry.registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  const { registerRunsHandlers } = await import('../ipc/runs');
  // These goldens never call the comment channels, the ones that dispatch.
  registerRunsHandlers({ query: jest.fn(), instruction: jest.fn() }, jest.fn());
  const updater = (
    await import('../services/shared-run-auto-updater')
  ).getSharedRunAutoUpdater();
  autoUpdater = updater;
  // Teardown waits for every re-share a debounce timer started; shutdown
  // only clears timers, so one already running would outlive it.
  const reshare: unknown = Reflect.get(updater, 'reshareIfShared');
  if (typeof reshare !== 'function') throw new Error('reshareIfShared moved');
  Reflect.set(updater, 'reshareIfShared', (...args: unknown[]) => {
    const work: unknown = Reflect.apply(reshare, updater, args);
    return track(Promise.resolve(work));
  });
});

// Safe after a partial setup. In-flight re-shares settle before the guard and
// env come off, so a late write can't reach the restored data root.
afterAll(async () => {
  try {
    autoUpdater?.shutdown();
    await drain();
    jest.useRealTimers();
    jest.restoreAllMocks();
  } finally {
    owned?.release();
  }
});

beforeEach(() => {
  mark();
});

// Every planned fault and ingest outcome is used by the step it was set for.
afterEach(() => {
  expect(faults).toEqual([]);
  expect(ingestResults).toEqual([]);
  expect(owned?.outsideWrites).toEqual([]);
});

describe('shared runs (CAN-4169 golden)', () => {
  it('answers runs:share-eligibility from audit history and owner policy', async () => {
    auditEntries.push(
      auditEntry('chat-shared'),
      auditEntry('chat-running', { status: 'running' }),
    );
    const shareable = await invoke(
      IPC_CHANNELS.runsShareEligibility,
      session('chat-shared'),
    );
    const onlyRunning = await invoke(
      IPC_CHANNELS.runsShareEligibility,
      session('chat-running'),
    );
    const noHistory = await invoke(
      IPC_CHANNELS.runsShareEligibility,
      session('chat-empty'),
    );
    // A work owner that can't be resolved fails closed.
    const unknownOwner = await invoke(IPC_CHANNELS.runsShareEligibility, {
      ...session('chat-shared'),
      projectId: 'unregistered-project',
    });
    const invalidId = await invoke(IPC_CHANNELS.runsShareEligibility, {
      ...session('chat-shared'),
      chatId: '../escape',
    });
    expect(
      stable({
        shareable,
        onlyRunning,
        noHistory,
        unknownOwner,
        invalidId,
        requests: newRequests(),
      }),
    ).toMatchSnapshot();
  });

  it('shares a run through runs:share and registers it for comments', async () => {
    // The newest turn's metadata titles and describes the shared run.
    auditEntries.push(
      auditEntry('chat-shared', {
        totalCostUsd: 0.5,
        label: 'Retry uploads with backoff',
        provider: 'codex',
        model: 'codex-golden-model',
        status: 'interrupted',
      }),
    );
    const first = await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-shared'),
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    const afterFirst = registryFile();
    const firstIngest = [...ingestCalls];
    const firstFlushes = [...flushes];
    const firstRequests = newRequests();

    // Re-sharing the same chat reuses its idempotency key and keeps the
    // registry entry, so the server updates the run in place.
    mark();
    const again = await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-shared'),
      shareScope: 'organization',
      organizationId: ORG_ID,
    });
    const againRequests = newRequests();
    expect(
      stable({
        first,
        firstIngest,
        firstFlushes,
        firstRequests,
        registry: afterFirst,
        again,
        againRequests,
        registryAfterAgain: registryFile(),
      }),
    ).toMatchSnapshot();
  });

  it('refuses runs:share without an audience, activity, policy or billing', async () => {
    // Pins current defect; fix tracked in CAN-7426: noScope and
    // teamWithoutId lose their message.
    const noScope = await invoke(
      IPC_CHANNELS.runsShare,
      session('chat-shared'),
    );
    const teamWithoutId = await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-shared'),
      shareScope: 'team',
    });
    const invalidTeam = await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-shared'),
      shareScope: 'team',
      teamId: 'Team With Spaces',
    });
    const lapsedTeam = await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-shared'),
      shareScope: 'team',
      teamId: LAPSED_TEAM_ID,
    });
    const unknownOwner = await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-shared'),
      projectId: 'unregistered-project',
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    const noActivity = await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-empty'),
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    auditEntries.push(auditEntry('chat-other'));
    ingestResults.push({
      status: 'blocked-by-org-policy',
      organizationNames: ['Example Org'],
    });
    const ingestBlocked = await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-other'),
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    expect(
      stable({
        noScope,
        teamWithoutId,
        invalidTeam,
        lapsedTeam,
        unknownOwner,
        noActivity,
        ingestBlocked,
        requests: newRequests(),
        registry: registryFile(),
      }),
    ).toMatchSnapshot();
  });

  it('classifies failed shares and retries with the same key', async () => {
    auditEntries.push(auditEntry('chat-retry'));
    const share = {
      ...session('chat-retry'),
      shareScope: 'team',
      teamId: TEAM_ID,
    };
    fault('POST', '<api>/runs', 401, 'Invalid API key.');
    const signedOut = await invoke(IPC_CHANNELS.runsShare, share);
    fault('POST', '<api>/runs', 500, 'Internal error.');
    const serverError = await invoke(IPC_CHANNELS.runsShare, share);
    ingestResults.push({ status: 'no-activity' });
    const ingestFailed = await invoke(IPC_CHANNELS.runsShare, share);
    const registryBeforeRetry = registryFile();
    const retried = await invoke(IPC_CHANNELS.runsShare, share);
    const keys = new Set(
      newRequests().map((request) =>
        isRecord(request.body) ? request.body.clientLocalRunId : null,
      ),
    );
    expect(keys.size).toBe(1);
    expect(
      stable({
        signedOut,
        serverError,
        ingestFailed,
        registryBeforeRetry,
        retried,
        requests: newRequests().map(({ method, path }) => `${method} ${path}`),
        registry: registryFile(),
      }),
    ).toMatchSnapshot();
  });

  it('re-shares a shared chat after finished turns settle', async () => {
    must(autoUpdater).start();
    must(autoUpdater).start();
    // Run alone, no earlier case has shared chat-shared: record the two
    // finished turns the eligibility and share cases leave and share it, so
    // the hosted run exists and the snapshot matches the full run.
    if (!byClientChatId('chat-shared')) {
      auditEntries.push(
        auditEntry('chat-shared'),
        auditEntry('chat-shared', { totalCostUsd: 0.5 }),
      );
      await invoke(IPC_CHANNELS.runsShare, {
        ...session('chat-shared'),
        shareScope: 'team',
        teamId: TEAM_ID,
      });
      mark();
    }
    const run = must(byClientChatId('chat-shared'));
    saveShare('chat-shared', teamShare(run.externalId));
    finishTurn(auditEntry('chat-shared'));
    jest.advanceTimersByTime(5_000);
    finishTurn(auditEntry('chat-shared'));
    jest.advanceTimersByTime(9_999);
    await drain();
    const beforeDebounce = newRequests().length;
    jest.advanceTimersByTime(1);
    await drain();
    const reshare = {
      requests: newRequests(),
      ingest: [...ingestCalls],
      registry: registryRow('chat-shared'),
    };

    // A failed re-share records a diagnostic instead of surfacing.
    mark();
    fault('POST', '<api>/runs', 401, 'Invalid API key.');
    finishTurn(auditEntry('chat-shared'));
    jest.advanceTimersByTime(10_000);
    await drain();
    const failed = {
      requests: newRequests().map(({ method, path }) => `${method} ${path}`),
      diagnostics: newDiagnostics(),
    };

    // Deleted on another device: the refresh fails closed with the hosted 404
    // and doesn't recreate the grant.
    // Pins current defect; fix tracked in CAN-7426: the saved share and
    // comments entry are kept, so every later finished turn retries the POST.
    mark();
    const gone = must(byClientChatId('chat-shared'));
    serverRuns.delete(gone.externalId);
    finishTurn(auditEntry('chat-shared'));
    jest.advanceTimersByTime(10_000);
    await drain();
    const deletedElsewhere = {
      requests: newRequests().map(({ method, path }) => `${method} ${path}`),
      diagnostics: newDiagnostics(),
      recreated: byClientChatId('chat-shared') ?? null,
      registry: registryRow('chat-shared'),
    };
    serverRuns.set(gone.externalId, gone);
    expect(
      stable({ beforeDebounce, reshare, failed, deletedElsewhere }),
    ).toMatchSnapshot();
  });

  it('never re-shares for running turns, helper events, unshared or private chats', async () => {
    // Its own shared chat with a saved team share and finished history, so
    // each event below would re-share it if its filter were gone.
    must(autoUpdater).start();
    auditEntries.push(auditEntry('chat-filters'));
    await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-filters'),
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    saveShare(
      'chat-filters',
      teamShare(must(byClientChatId('chat-filters')).externalId),
    );
    saveShare('chat-private', {
      externalId: runId(99),
      shareScope: 'private',
      sharedAt: FIXED_TIME,
    });
    auditEntries.push(auditEntry('chat-private'));
    // finishTurn records each in history first, so chat-unshared has finished
    // history and reaches the updater's missing-share check.
    const ignored: Record<string, Json> = {
      runningTurn: auditEntry('chat-filters', { status: 'running' }),
      chatSummary: auditEntry('chat-filters', { eventType: 'chat_summary' }),
      unsharedChat: auditEntry('chat-unshared'),
      privateShare: auditEntry('chat-private'),
    };
    const registryBefore = registryFile();
    // Any request, diagnostic, ingest or flush is an effect.
    const effects: Record<string, unknown[]> = {};
    try {
      for (const [name, entry] of Object.entries(ignored)) {
        mark();
        finishTurn(entry);
        jest.advanceTimersByTime(10_000);
        await drain();
        effects[name] = [
          ...newRequests(),
          ...newDiagnostics(),
          ...ingestCalls,
          ...flushes,
        ];
      }
    } finally {
      must(autoUpdater).shutdown();
      await drain();
    }
    const none = Object.keys(ignored).map((name) => [name, []]);
    expect(effects).toEqual(Object.fromEntries(none));
    expect(registryFile()).toEqual(registryBefore);
  });

  it('unshares through runs:unshare, cancelling a pending re-share', async () => {
    must(autoUpdater).start();
    finishTurn(auditEntry('chat-shared'));
    jest.advanceTimersByTime(5_000);
    const unshared = await invoke(
      IPC_CHANNELS.runsUnshare,
      session('chat-shared'),
    );
    const registryAfterUnshare = registryFile();
    // The renderer clears the saved share later; the cancelled timer must not
    // re-share in the meantime.
    jest.advanceTimersByTime(30_000);
    await drain();
    const unshareRequests = newRequests();
    saveShare('chat-shared', null);

    // Unshared from another device: the row is still here locally, the
    // delete answers 404 and the unshare converges.
    auditEntries.push(auditEntry('chat-elsewhere'));
    await invoke(IPC_CHANNELS.runsShare, {
      ...session('chat-elsewhere'),
      shareScope: 'team',
      teamId: TEAM_ID,
    });
    serverRuns.delete(must(byClientChatId('chat-elsewhere')).externalId);
    const registryBeforeGone = registryFile();
    mark();
    const alreadyGone = await invoke(
      IPC_CHANNELS.runsUnshare,
      session('chat-elsewhere'),
    );
    const alreadyGoneRequests = newRequests();
    const registryAfterGone = registryFile();

    // Signed out: the unshare rejects and the registry entry stays.
    mark();
    const retryKey = must(byClientChatId('chat-retry')).clientLocalRunId;
    fault('DELETE', `<api>/runs/${retryKey}`, 401, 'Invalid API key.');
    const signedOut = await invoke(
      IPC_CHANNELS.runsUnshare,
      session('chat-retry'),
    );
    must(autoUpdater).shutdown();
    expect(
      stable({
        unshared,
        registryAfterUnshare,
        unshareRequests,
        registryBeforeGone,
        alreadyGone,
        alreadyGoneRequests,
        registryAfterGone,
        signedOut,
        signedOutRequests: newRequests(),
        registry: registryFile(),
      }),
    ).toMatchSnapshot();
  });
});
