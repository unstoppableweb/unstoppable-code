// CAN-4171 capture golden: turn, product and org-memory feedback as the
// desktop serves them today, pinned before preparation and delivery move
// behind the core boundary. It drives the real IPC handlers, client, outbox
// file and encrypted account store on the suite's own data roots; only IPC
// registration, the cloud base URL, the work-owner lookup, the replica fences
// and fetch are replaced. Every credential here is a fake.
import { app, safeStorage } from 'electron';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { AI_CREDITS_WORK_OWNER_HEADER } from '@canopy/protocol/llm-gateway';
import { MEMORY_SEARCH_CAPABILITY } from '@canopy/protocol/memory';
import type * as CloudConfig from '../../canopy-cloud/config';
import type * as WorkOwner from '../../agents/work-owner';
import type * as Outbox from '../turn-feedback-outbox';
import {
  clearCanopyCloudAccount,
  invalidateCanopyCloudAccountCache,
  saveCanopyCloudAccount,
  type CanopyCloudAccountEntry,
} from '../../lib/canopy-cloud-account-store';
import { getTurnFeedbackOutboxFilePath } from '../../lib/paths';
import { resetCanopyCloudSessionCredential } from '../../canopy-cloud/session-status';
import { registerTurnFeedbackHandlers } from '../../ipc/turn-feedback';
import { registerFeedbackHandlers } from '../../ipc/feedback';
import { registerOrgMemoryHandlers } from '../../ipc/org-memory';
import { subscribeTurnFeedbackFlush } from '../turn-feedback-client';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
const BASE = 'https://cloud.golden.invalid';
jest.mock('../../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => BASE,
}));
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '77777777-7777-4777-8777-777777777777';
jest.mock('../../agents/work-owner', () => ({
  ...jest.requireActual<typeof WorkOwner>('../../agents/work-owner'),
  resolveAiCreditsScopeOwner: (): Promise<object> =>
    Promise.resolve({ kind: 'organization', organizationId: ORG }),
}));
jest.mock('../../shared-containers/organization-snapshot-transition', () => ({
  organizationSnapshotTransition:
    (): ((persist: () => Promise<unknown>) => Promise<unknown>) =>
    (persist: () => Promise<unknown>): Promise<unknown> =>
      persist(),
}));
jest.mock('../../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): object => ({
    withReplicaPurgeFence: (
      persist: () => Promise<unknown>,
    ): Promise<unknown> => persist(),
  }),
}));

const suiteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'feedback-golden-')));
const ISOLATED_DIRS = {
  CANOPY_DATA_DIR: join(suiteRoot, 'data'),
  CANOPY_SECURE_DATA_DIR: join(suiteRoot, 'secure'),
};
const inherited = Object.fromEntries(
  Object.keys(ISOLATED_DIRS).map((name) => [name, process.env[name]]),
);

function account(
  id: string,
  extra: Partial<CanopyCloudAccountEntry> = {},
): CanopyCloudAccountEntry {
  return {
    apiKey: `golden-key-${id}`,
    authMode: 'api_key',
    credentialSource: 'manual',
    capabilities: ['account-v1', MEMORY_SEARCH_CAPABILITY],
    memorySearchOrganizationExternalIds: [ORG],
    account: { id, name: id, email: `${id}@example.test`, role: 'DEVELOPER' },
    organizations: [],
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...extra,
  };
}
const ACCOUNT_A = account('account-a');
const ACCOUNT_B = account('account-b');
const GUEST = account('guest-device', {
  authMode: 'guest',
  credentialSource: 'guest',
});

function seal(value: string): Buffer {
  return Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`);
}
function unseal(value: Buffer): string {
  const sealed = value.toString('utf8');
  if (!sealed.startsWith('sealed:')) throw new Error('Unable to decrypt');
  return Buffer.from(sealed.slice('sealed:'.length), 'base64').toString();
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
  workOwner: string | null;
}
type Reply = { status: number; json?: unknown } | 'offline';
let sent: Sent[] = [];
let serve: (request: Sent) => Reply = () => 'offline';

async function signIn(entry: CanopyCloudAccountEntry | null): Promise<void> {
  await clearCanopyCloudAccount();
  resetCanopyCloudSessionCredential();
  invalidateCanopyCloudAccountCache();
  if (entry) await saveCanopyCloudAccount(entry);
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return (await handler({ sender: { id: 7 } }, ...args)) as T;
}

interface OutboxFile {
  version: number;
  entries: Array<Record<string, unknown>>;
}
function outbox(): OutboxFile | null {
  const file = getTurnFeedbackOutboxFilePath();
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as OutboxFile)
    : null;
}
function resetOutbox(): void {
  const file = getTurnFeedbackOutboxFilePath();
  if (relative(suiteRoot, file).startsWith('..'))
    throw new Error(`Refusing to delete ${file} outside the suite root`);
  rmSync(file, { force: true });
}
// Yields to pending I/O until `done` holds, failing after a short deadline.
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Hosted feedback ids are row UUIDs.
const FEEDBACK_ID = '2d0b9e3a-4f5c-4a7b-8c8d-9e0f1a2b3c4d';
const UNBOUND_FEEDBACK_ID = '3e1c0f4b-5a6d-4b8c-9d9e-0f1a2b3c4d5e';
const RATE = {
  clientUserMessageId: 'msg-1-1795150000000',
  clientChatId: 'chat-golden',
  rating: 'down',
  provider: 'claude',
  model: 'claude-golden',
  eventType: 'worktree_chat',
  chatMode: 'canopy',
  projectId: 'project-golden',
  worktreeId: 'worktree-golden',
};
const POSTED_RATING = {
  clientUserMessageId: RATE.clientUserMessageId,
  clientChatId: RATE.clientChatId,
  rating: 'down',
  provider: 'claude',
  model: 'claude-golden',
  eventType: 'worktree_chat',
  chatMode: 'canopy',
  appVersion: app.getVersion(),
};

beforeAll(() => {
  for (const [name, dir] of Object.entries(ISOLATED_DIRS)) {
    mkdirSync(dir, { recursive: true });
    process.env[name] = dir;
  }
  jest.spyOn(safeStorage, 'encryptString').mockImplementation(seal);
  jest.spyOn(safeStorage, 'decryptString').mockImplementation(unseal);
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(init?.headers);
    const request: Sent = {
      method: init?.method ?? 'GET',
      path: url.origin === BASE ? `${url.pathname}${url.search}` : url.href,
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : null,
      authorization: headers.get('authorization'),
      workOwner: headers.get(AI_CREDITS_WORK_OWNER_HEADER),
    };
    sent.push(request);
    const reply = serve(request);
    if (reply === 'offline')
      return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(JSON.stringify(reply.json ?? {}), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  registerTurnFeedbackHandlers();
  registerFeedbackHandlers();
  registerOrgMemoryHandlers();
});

beforeEach(async () => {
  sent = [];
  serve = (): Reply => 'offline';
  resetOutbox();
  await signIn(ACCOUNT_A);
});

afterAll(() => {
  jest.restoreAllMocks();
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(suiteRoot, { recursive: true, force: true });
});

describe('turn feedback as the desktop serves it (CAN-4171)', () => {
  it('records a rating with its work owner, and amends and retracts it on the server', async () => {
    serve = ({ method }): Reply => ({
      status: 200,
      json:
        method === 'DELETE'
          ? { deleted: true }
          : {
              feedbackId: FEEDBACK_ID,
              clientUserMessageId: RATE.clientUserMessageId,
              rating: 'down',
              hasComment: true,
              createdAt: '2026-11-20T00:00:00.000Z',
              updatedAt: '2026-11-20T00:00:00.000Z',
            },
    });
    expect(await invoke(IPC_CHANNELS.turnFeedbackRate, RATE)).toEqual({
      recorded: true,
      queued: false,
      feedbackId: FEEDBACK_ID,
    });
    expect(
      await invoke(IPC_CHANNELS.turnFeedbackDetail, {
        clientUserMessageId: RATE.clientUserMessageId,
        feedbackId: FEEDBACK_ID,
        reason: 'got-stuck',
        comment: 'wrong file',
      }),
    ).toEqual({ recorded: true, queued: false });
    expect(
      await invoke(IPC_CHANNELS.turnFeedbackClear, {
        clientUserMessageId: RATE.clientUserMessageId,
        feedbackId: FEEDBACK_ID,
      }),
    ).toEqual({ cleared: true });

    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/v1/feedback/turns',
        body: POSTED_RATING,
        authorization: `Bearer ${ACCOUNT_A.apiKey}`,
        workOwner: `org:${ORG}`,
      },
      {
        method: 'PATCH',
        path: `/api/v1/feedback/turns/${FEEDBACK_ID}`,
        body: { reason: 'got-stuck', comment: 'wrong file' },
        authorization: `Bearer ${ACCOUNT_A.apiKey}`,
        workOwner: null,
      },
      {
        method: 'DELETE',
        path: `/api/v1/feedback/turns/${FEEDBACK_ID}`,
        body: null,
        authorization: `Bearer ${ACCOUNT_A.apiKey}`,
        workOwner: null,
      },
    ]);
    expect(outbox()?.entries).toEqual([]);
  });

  it('queues a rating the server cannot take now, bound to the signed-in account, and drops a rejected one', async () => {
    for (const reply of [
      'offline',
      { status: 401 },
      { status: 429 },
      { status: 503 },
    ] as const) {
      resetOutbox();
      serve = (): Reply => reply;
      expect(await invoke(IPC_CHANNELS.turnFeedbackRate, RATE)).toEqual({
        recorded: false,
        queued: true,
      });
      const [queued] = outbox()?.entries ?? [];
      expect(typeof queued?.queuedAt).toBe('number');
      expect({ ...queued, queuedAt: 'set' }).toEqual({
        ...POSTED_RATING,
        accountId: ACCOUNT_A.account?.id,
        workOwner: `org:${ORG}`,
        queuedAt: 'set',
      });
    }
    resetOutbox();
    serve = (): Reply => ({ status: 400 });
    expect(await invoke(IPC_CHANNELS.turnFeedbackRate, RATE)).toEqual({
      recorded: false,
      queued: false,
    });
    expect(outbox()).toBeNull();
  });

  it('queues unbound while signed out or as a guest, and refuses malformed requests without a call', async () => {
    for (const entry of [null, GUEST]) {
      resetOutbox();
      await signIn(entry);
      serve = (): Reply => 'offline';
      expect(await invoke(IPC_CHANNELS.turnFeedbackRate, RATE)).toEqual({
        recorded: false,
        queued: true,
      });
      expect(outbox()?.entries.map((queued) => queued.accountId)).toEqual([
        undefined,
      ]);
    }
    sent = [];
    expect(
      await invoke(IPC_CHANNELS.turnFeedbackRate, {
        ...RATE,
        rating: 'sideways',
      }),
    ).toEqual({ recorded: false, queued: false });
    expect(
      await invoke(IPC_CHANNELS.turnFeedbackDetail, {
        clientUserMessageId: RATE.clientUserMessageId,
      }),
    ).toEqual({ recorded: false, queued: false });
    expect(await invoke(IPC_CHANNELS.turnFeedbackClear, {})).toEqual({
      cleared: false,
    });
    expect(await invoke(IPC_CHANNELS.turnFeedbackList, {})).toEqual({
      feedback: [],
    });
    expect(sent).toEqual([]);
  });

  it('keeps detail with the queued rating, lists it over the server rows, and clears it locally', async () => {
    serve = (): Reply => 'offline';
    await invoke(IPC_CHANNELS.turnFeedbackRate, RATE);
    sent = [];
    expect(
      await invoke(IPC_CHANNELS.turnFeedbackDetail, {
        clientUserMessageId: RATE.clientUserMessageId,
        reason: 'got-stuck',
        comment: 'queued note',
      }),
    ).toEqual({ recorded: false, queued: true });
    expect(sent).toEqual([]);

    const queuedAt = outbox()?.entries[0]?.queuedAt;
    serve = ({ method }): Reply =>
      method === 'GET'
        ? {
            status: 200,
            json: {
              feedback: [
                {
                  feedbackId: '0b8f7c1e-2d3a-4e5f-8a6b-7c8d9e0f1a2b',
                  clientUserMessageId: RATE.clientUserMessageId,
                  rating: 'up',
                  hasComment: false,
                  createdAt: '2026-11-19T00:00:00.000Z',
                  updatedAt: '2026-11-19T00:00:00.000Z',
                },
                {
                  feedbackId: '1c9a8d2f-3e4b-4f6a-9b7c-8d9e0f1a2b3c',
                  clientUserMessageId: 'msg-2',
                  rating: 'up',
                  hasComment: false,
                  createdAt: '2026-11-19T00:00:00.000Z',
                  updatedAt: '2026-11-19T00:00:00.000Z',
                },
              ],
            },
          }
        : 'offline';
    const at = new Date(Number(queuedAt)).toISOString();
    expect(
      await invoke(IPC_CHANNELS.turnFeedbackList, {
        clientChatId: RATE.clientChatId,
      }),
    ).toEqual({
      feedback: [
        {
          feedbackId: '',
          clientUserMessageId: RATE.clientUserMessageId,
          rating: 'down',
          reason: 'got-stuck',
          hasComment: true,
          createdAt: at,
          updatedAt: at,
        },
        {
          feedbackId: '1c9a8d2f-3e4b-4f6a-9b7c-8d9e0f1a2b3c',
          clientUserMessageId: 'msg-2',
          rating: 'up',
          hasComment: false,
          createdAt: '2026-11-19T00:00:00.000Z',
          updatedAt: '2026-11-19T00:00:00.000Z',
        },
      ],
    });
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /api/v1/feedback/turns?clientChatId=${RATE.clientChatId}`,
    ]);

    // Another account on this machine neither sees nor clears it.
    await signIn(ACCOUNT_B);
    serve = (): Reply => ({ status: 200, json: { feedback: [] } });
    expect(
      await invoke(IPC_CHANNELS.turnFeedbackList, {
        clientChatId: RATE.clientChatId,
      }),
    ).toEqual({ feedback: [] });
    await signIn(ACCOUNT_A);
    expect(
      await invoke(IPC_CHANNELS.turnFeedbackClear, {
        clientUserMessageId: RATE.clientUserMessageId,
      }),
    ).toEqual({ cleared: true });
    expect(outbox()?.entries).toEqual([]);
  });

  it('flushes on sign-in in order, keeps other accounts and failures for later, and survives a restart', async () => {
    serve = (): Reply => 'offline';
    await signIn(null);
    await invoke(IPC_CHANNELS.turnFeedbackRate, {
      ...RATE,
      clientUserMessageId: 'msg-unbound',
    });
    await invoke(IPC_CHANNELS.turnFeedbackDetail, {
      clientUserMessageId: 'msg-unbound',
      comment: 'from offline',
    });
    await signIn(ACCOUNT_B);
    await invoke(IPC_CHANNELS.turnFeedbackRate, {
      ...RATE,
      clientUserMessageId: 'msg-b',
    });
    await signIn(ACCOUNT_A);
    await invoke(IPC_CHANNELS.turnFeedbackRate, {
      ...RATE,
      clientUserMessageId: 'msg-a1',
    });
    await invoke(IPC_CHANNELS.turnFeedbackRate, {
      ...RATE,
      clientUserMessageId: 'msg-a2',
    });
    await invoke(IPC_CHANNELS.turnFeedbackRate, {
      ...RATE,
      clientUserMessageId: 'msg-a3',
    });

    // A restart reads the same file: the queue lives on disk, not in memory.
    let onDisk: string[] = [];
    await jest.isolateModulesAsync(async () => {
      const fresh = jest.requireActual<typeof Outbox>(
        '../turn-feedback-outbox',
      );
      onDisk = (await fresh.readTurnFeedbackOutbox()).map(
        (entry) => entry.clientUserMessageId,
      );
    });
    expect(onDisk).toEqual([
      'msg-unbound',
      'msg-b',
      'msg-a1',
      'msg-a2',
      'msg-a3',
    ]);

    // Signing in flushes: a 400 drops that entry, a 503 stops the run there.
    sent = [];
    let posts = 0;
    serve = ({ method, body }): Reply => {
      if (method === 'PATCH') return { status: 200, json: {} };
      posts += 1;
      const id = (body as { clientUserMessageId: string }).clientUserMessageId;
      if (id === 'msg-a1') return { status: 400 };
      if (id === 'msg-a2') return { status: 503 };
      return { status: 200, json: { feedbackId: UNBOUND_FEEDBACK_ID } };
    };
    await signIn(null);
    const unsubscribe = subscribeTurnFeedbackFlush();
    try {
      await saveCanopyCloudAccount(ACCOUNT_A);
      // Only the account listener starts this flush; it settles the outbox in
      // one write, so three entries left means the run has ended. A read that
      // lands mid-write does not parse yet.
      await until(() => {
        try {
          return posts === 3 && outbox()?.entries.length === 3;
        } catch {
          return false;
        }
      });
    } finally {
      unsubscribe();
    }
    expect(
      sent.map(({ method, path, body, workOwner }) => [
        method,
        path,
        (body as { clientUserMessageId?: string; comment?: string })
          .clientUserMessageId ?? (body as { comment?: string }).comment,
        workOwner,
      ]),
    ).toEqual([
      ['POST', '/api/v1/feedback/turns', 'msg-unbound', `org:${ORG}`],
      [
        'PATCH',
        `/api/v1/feedback/turns/${UNBOUND_FEEDBACK_ID}`,
        'from offline',
        null,
      ],
      ['POST', '/api/v1/feedback/turns', 'msg-a1', `org:${ORG}`],
      ['POST', '/api/v1/feedback/turns', 'msg-a2', `org:${ORG}`],
    ]);
    expect(
      outbox()?.entries.map((entry) => [
        entry.clientUserMessageId,
        entry.accountId,
      ]),
    ).toEqual([
      ['msg-b', ACCOUNT_B.account?.id],
      ['msg-a2', ACCOUNT_A.account?.id],
      ['msg-a3', ACCOUNT_A.account?.id],
    ]);
  });
});

describe('product and org-memory feedback as the desktop serves them (CAN-4171)', () => {
  const REPORT = {
    type: 'bug',
    description: '  The diff panel stays empty.  ',
    title: 'Empty diff',
    context: { activePage: 'chat', appVersion: '0.0.0-test' },
    includeDiagnostics: false,
    submissionId: '22222222-2222-4222-8222-222222222222',
  };

  it('files a report once per submission, without diagnostics, and names a conflict', async () => {
    serve = (): Reply => ({
      status: 201,
      json: { reportId: 'internal-issue', referenceId: 'REP-0123ABCD' },
    });
    const first = invoke(IPC_CHANNELS.feedbackReportSubmit, REPORT);
    const again = invoke(IPC_CHANNELS.feedbackReportSubmit, REPORT);
    expect(await first).toEqual({
      submitted: true,
      diagnosticsStatus: 'not-requested',
      referenceId: 'REP-0123ABCD',
    });
    expect(await again).toEqual(await first);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/v1/feedback/reports',
        body: {
          type: 'bug',
          submissionId: REPORT.submissionId,
          description: 'The diff panel stays empty.',
          context: REPORT.context,
          attachDiagnostics: false,
          title: 'Empty diff',
        },
        authorization: `Bearer ${ACCOUNT_A.apiKey}`,
        workOwner: null,
      },
    ]);
    const conflict = { name: 'FeedbackSubmissionConflictError' };
    await expect(
      invoke(IPC_CHANNELS.feedbackReportSubmit, {
        ...REPORT,
        description: 'Changed',
      }),
    ).rejects.toMatchObject(conflict);
    await expect(
      invoke(IPC_CHANNELS.feedbackReportSubmit, {
        ...REPORT,
        submissionId: undefined,
      }),
    ).rejects.toThrow('A submission ID is required.');

    serve = (): Reply => ({ status: 409, json: {} });
    await expect(
      invoke(IPC_CHANNELS.feedbackSubmit, {
        ...REPORT,
        submissionId: undefined,
      }),
    ).rejects.toMatchObject(conflict);
  });

  it('files an error report only for a signed-in account', async () => {
    const errorReport = {
      ...REPORT,
      submissionId: '44444444-4444-4444-8444-444444444444',
      error: {
        referenceId: 'ERR-0123ABCD',
        code: 'renderer.crash',
        kind: 'defect',
        occurredAt: 1_795_150_000_000,
        copy: { title: 'Something went wrong' },
        detail: { message: 'Boom' },
      },
    };
    for (const entry of [null, GUEST]) {
      await signIn(entry);
      sent = [];
      await expect(
        invoke(IPC_CHANNELS.feedbackReportSubmit, errorReport),
      ).rejects.toThrow('Sign in to report this error.');
      expect(sent).toEqual([]);
    }

    await signIn(ACCOUNT_A);
    sent = [];
    // The hosted service files an error report under its ERR- reference.
    serve = (): Reply => ({
      status: 201,
      json: {
        reportId: 'internal-issue',
        referenceId: errorReport.error.referenceId,
      },
    });
    expect(
      await invoke(IPC_CHANNELS.feedbackReportSubmit, errorReport),
    ).toEqual({
      submitted: true,
      diagnosticsStatus: 'not-requested',
      referenceId: 'ERR-0123ABCD',
    });
    expect(
      sent.map(({ method, path, body, authorization }) => [
        method,
        path,
        (body as { error?: { referenceId?: string } }).error?.referenceId,
        authorization,
      ]),
    ).toEqual([
      [
        'POST',
        '/api/v1/feedback/reports',
        'ERR-0123ABCD',
        `Bearer ${ACCOUNT_A.apiKey}`,
      ],
    ]);
  });

  it('records memory feedback only for an organization the account can search', async () => {
    const request = {
      organizationExternalId: ORG,
      searchId: '55555555-5555-4555-8555-555555555555',
      factId: '66666666-6666-4666-8666-666666666666',
      rating: 'dislike',
      comment: '  stale  ',
    };
    serve = (): Reply => ({ status: 200, json: { recorded: true } });
    expect(await invoke(IPC_CHANNELS.orgMemoryFeedbackSubmit, request)).toEqual(
      { recorded: true },
    );
    expect(sent).toEqual([
      {
        method: 'POST',
        path: `/api/v1/${BRAND.web.apiNamespace}/memory/feedback`,
        body: {
          organizationExternalId: ORG,
          searchId: request.searchId,
          factId: request.factId,
          rating: 'dislike',
          comment: 'stale',
        },
        authorization: `Bearer ${ACCOUNT_A.apiKey}`,
        workOwner: null,
      },
    ]);

    sent = [];
    await signIn(
      account('account-c', {
        memorySearchOrganizationExternalIds: [OTHER_ORG],
      }),
    );
    expect(await invoke(IPC_CHANNELS.orgMemoryFeedbackSubmit, request)).toEqual(
      { recorded: false },
    );
    expect(
      await invoke(IPC_CHANNELS.orgMemoryFeedbackSubmit, {
        ...request,
        organizationExternalId: undefined,
      }),
    ).toEqual({ recorded: false });
    expect(sent).toEqual([]);
  });
});
