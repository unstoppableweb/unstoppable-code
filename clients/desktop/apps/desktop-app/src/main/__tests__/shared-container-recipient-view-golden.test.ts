// CAN-6501 golden: the recipient view-state shared-container IPC as desktop
// serves it before core.publication / core.sharedContainer take ownership.
// Real dismiss, restore and list-dismissed handlers with the shared-container
// server client, cloud client, account store, reconciliation service, replica
// store, acceptance and run-environment stores, on a data root the golden
// owns. All three channels call the hosted service, which is an in-test
// server at `fetch`. Replaced: IPC registration, the cloud base URL, the
// shared-containers flag value and the inbox watcher's signal (a spy).
// Electron's safeStorage is the repo's pass-through Jest mock, so the stored
// account and run values aren't natively encrypted here. Only the clock is
// faked. Each case resets the stores, the account and the hosted state and
// seeds what it reads, so any case runs alone. Re-record deliberately with
// `pnpm test <this file> -u` and review the diff.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { SHARED_CONTAINER_DISMISSAL_NOT_FOUND_ERROR_CODE } from '@canopy/protocol/shared-containers';
import type * as CloudConfig from '../canopy-cloud/config';
import {
  cloud,
  fakeCloud,
  FIXED_TIME,
  handlers,
  invoke as invokeChannel,
  isRecord,
  json,
  ownDataRoot,
  recordPushes,
  saveAccount,
  stable,
  type Json,
  type OwnedDataRoot,
} from './helpers/shared-containers-golden-harness';

jest.setTimeout(30_000);

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CloudConfig>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));

// Hosted ids are UUIDs.
const CONTAINER_ID = '00000000-0000-4000-8000-00000000c001';
const OTHER_CONTAINER_ID = '00000000-0000-4000-8000-00000000c002';
const GONE_CONTAINER_ID = '00000000-0000-4000-8000-00000000c003';
const REVISION_ID = '00000000-0000-4000-8000-00000000e001';
const ORG_ID = '00000000-0000-4000-8000-00000000a001';
const OWNER_ID = '00000000-0000-4000-8000-00000000b001';
const DISMISSALS = 'shared-container-dismissals-v1';
const BASE_CAPABILITIES = ['shared-containers-v1', DISMISSALS];
const flags = { sharedContainers: true };

/** A hosted container summary, as the recipient listing returns it. */
function summary(id: string, extra: Json = {}): Json {
  return {
    id,
    organizationId: ORG_ID,
    organizationName: 'Example Org',
    ownerUserId: OWNER_ID,
    owner: { userId: OWNER_ID, name: 'Example Publisher' },
    access: 'organization',
    containerType: 'CODE_WORKTREE',
    // The hosted serializer sets this for every non-chat container.
    backend: 'desktop',
    title: 'Golden container',
    revision: 1,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    capabilities: ['VIEW'],
    ...extra,
  };
}

// --- Dismissal routes of the hosted service -----------------------------------

const dismissed = new Set<string>();
// Grants a restore re-created; the route answers a replay from the live grant.
const restored = new Set<string>();
// The dismissal row's grant ID, which the route pages by.
const grantOf = (id: string): string => `${id.slice(0, -4)}d${id.slice(-3)}`;
// The route's keyset cursor: base64url JSON of the last row's time and grant.
const keysetCursor = (id: string): string =>
  Buffer.from(
    JSON.stringify({ v: 1, ts: FIXED_TIME, id: grantOf(id) }),
    'utf8',
  ).toString('base64url');
const planned: { method: string; status: number; body: Json }[] = [];
cloud.route = (method, path): Response => {
  const plan = planned.findIndex((entry) => entry.method === method);
  if (plan >= 0) {
    const [{ status, body }] = planned.splice(plan, 1);
    return json(status, body);
  }
  const url = new URL(path, 'https://cloud.example.test');
  if (url.pathname === '/api/v1/shared-containers/dismissed') {
    // Every dismissal here is an organization share, so only that scope lists
    // it, newest first and then by grant, as the route orders them.
    const ids =
      url.searchParams.get('organizationId') === ORG_ID
        ? [...dismissed].sort().reverse()
        : [];
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return json(400, { error: 'limit must be between 1 and 50' });
    }
    // A cursor the route can't decode reads as the first page.
    const after = ids.findIndex(
      (id) => keysetCursor(id) === url.searchParams.get('cursor'),
    );
    const page = ids.slice(after + 1, after + 1 + limit);
    const last = page.at(-1);
    return json(200, {
      containers: page.map((id) => summary(id, { dismissedAt: FIXED_TIME })),
      nextCursor:
        last !== undefined && ids.indexOf(last) < ids.length - 1
          ? keysetCursor(last)
          : null,
    });
  }
  const match =
    /^\/api\/v1\/shared-containers\/([^/]+)\/(dismiss|restore)$/.exec(
      url.pathname,
    );
  const id = match?.[1] ?? '';
  if (match?.[2] === 'dismiss' && method === 'DELETE') {
    // The route's answer once the grant is gone: a bare 404.
    if (dismissed.has(id) || id === GONE_CONTAINER_ID) {
      return json(404, { error: 'Container not found' });
    }
    dismissed.add(id);
    restored.delete(id);
    return new Response(null, { status: 204 });
  }
  if (match?.[2] === 'restore' && method === 'POST') {
    if (dismissed.delete(id)) restored.add(id);
    if (restored.has(id)) return json(200, { container: summary(id) });
  }
  // One answer for every restore it can't make, as the route sends it.
  return json(404, {
    error: 'Shared container not found',
    code: SHARED_CONTAINER_DISMISSAL_NOT_FOUND_ERROR_CODE,
  });
};
/** Answer the next `method` request with `status` and `body`. */
function plan(method: string, status: number, body: Json): void {
  planned.push({ method, status, body });
}

// --- Harness ------------------------------------------------------------------

let owned: OwnedDataRoot;
let fetchSpy: jest.SpyInstance;
let pushes: ReturnType<typeof recordPushes>;
let signals: jest.SpyInstance;
let requestMark = 0;

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> =>
  stable(await invokeChannel(channel, ...args), owned.root);
const newRequests = (): unknown =>
  stable(cloud.requests.slice(requestMark), owned.root);
const dataPath = (...segments: string[]): string =>
  join(owned.dataDir, ...segments);
/** A JSON object file under the data root, or {} when it is absent. */
function readRecord(...segments: string[]): Json {
  const path = dataPath(...segments);
  const value: unknown = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : {};
  return isRecord(value) ? value : {};
}
const keysOf = (value: unknown): string[] =>
  isRecord(value) ? Object.keys(value) : [];

/** The local records a dismiss removes, per container. */
function localRecords(containerId: string): Json {
  const accepted = readRecord('shared-container-acceptance.json').accepted;
  const runEnv = readRecord('shared-container-run-env.json').containers;
  const index = readRecord('shared-containers', 'index.json').containers;
  const record = isRecord(accepted) ? accepted[containerId] : undefined;
  return {
    accepted: keysOf(accepted).includes(containerId),
    // Run consent can go while the acceptance record stays.
    runConsent: isRecord(record)
      ? {
          allowedAt: record.runAllowedAt ?? null,
          publisherUserId: record.runAllowedPublisherUserId ?? null,
        }
      : null,
    runEnvironment: keysOf(runEnv).includes(containerId),
    replicaIndexed: keysOf(index).includes(containerId),
    replicaBytes: existsSync(dataPath('shared-containers', containerId)),
  };
}

/** An accepted, run-allowed container with a replica and stored run values. */
async function seedRecipient(containerId: string): Promise<void> {
  const acceptance = await import('../shared-containers/acceptance-store');
  const at = (): Date => new Date(FIXED_TIME);
  await acceptance.acceptSharedContainer(
    containerId,
    ORG_ID,
    at,
    'organization',
  );
  await acceptance.allowSharedContainerRun(containerId, OWNER_ID, at);
  const runEnv = await import('../shared-containers/run-env-store');
  await runEnv.writeSharedContainerRunEnvironment(containerId, [
    { key: 'REGION', value: 'fake-region' },
  ]);
  const root = dataPath('shared-containers');
  const revision = join(root, containerId, 'revisions', REVISION_ID);
  mkdirSync(join(revision, 'artifacts'), { recursive: true });
  writeFileSync(join(revision, 'artifacts', 'container.json'), '{}');
  const index = readRecord('shared-containers', 'index.json');
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      artifacts: {},
      promotionCommits: {},
      ...index,
      containers: {
        ...(isRecord(index.containers) ? index.containers : {}),
        [containerId]: {
          containerId,
          organizationId: ORG_ID,
          access: 'organization',
          containerType: 'CODE_WORKTREE',
          updatedAt: FIXED_TIME,
          status: 'available',
          revisionId: REVISION_ID,
          revision: 1,
          revisionCreatedAt: FIXED_TIME,
        },
      },
    }),
  );
}

beforeAll(async () => {
  // The golden owns its data roots before any code under test loads.
  owned = ownDataRoot('shared-container-recipient-view-golden-');
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(fakeCloud);
  pushes = recordPushes();
  jest.useFakeTimers({
    now: new Date(FIXED_TIME),
    doNotFake: [
      'nextTick',
      'setImmediate',
      'queueMicrotask',
      'hrtime',
      'performance',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
  // The real flag service, with the shared-containers flag under test control.
  const service = (await import('../feature-flags')).getFeatureFlagService();
  const isEnabled = service.isEnabled.bind(service);
  jest
    .spyOn(service, 'isEnabled')
    .mockImplementation((key) =>
      key === CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key
        ? flags.sharedContainers
        : isEnabled(key),
    );
  const { getSharedContainerInboxWatcher } =
    await import('../services/shared-container-inbox-watcher');
  signals = jest.spyOn(getSharedContainerInboxWatcher(), 'signalLocalChange');
  const { registerSharedContainerHandlers } =
    await import('../ipc/shared-containers');
  registerSharedContainerHandlers({
    dispatcher: { instruction: jest.fn() },
    resolveCaller: () => {
      throw new Error('Recipient view channels must not dispatch to core');
    },
  });
});

afterAll(async () => {
  try {
    // The real observability service flushes on a timer; settle it inside the
    // owned root so no write lands in the next file of this worker. Without
    // that root (setup failed) it would flush into the inherited data dir.
    if (owned) {
      await (await import('../observability'))
        .getObservabilityService()
        .dispose();
    }
    jest.useRealTimers();
    fetchSpy?.mockRestore();
  } finally {
    owned?.release();
  }
});

// Every case starts from empty local stores, no dismissed share and a
// signed-in account on a server with recoverable removal.
beforeEach(async () => {
  for (const path of [
    'shared-container-acceptance.json',
    'shared-container-run-env.json',
  ]) {
    rmSync(dataPath(path), { force: true });
  }
  // Empty the replica root but keep it: replacing the root itself is a root
  // identity change, which the replica store refuses to clean up after.
  const replicas = dataPath('shared-containers');
  for (const entry of existsSync(replicas) ? readdirSync(replicas) : []) {
    rmSync(join(replicas, entry), { recursive: true, force: true });
  }
  dismissed.clear();
  restored.clear();
  cloud.capabilities = BASE_CAPABILITIES;
  await saveAccount(BASE_CAPABILITIES);
  requestMark = cloud.requests.length;
  pushes.clear();
  signals.mockClear();
});

// Every planned answer is used by its step; nothing lands outside the root.
afterEach(() => {
  expect(planned).toEqual([]);
  expect(owned.outsideWrites).toEqual([]);
});

describe('shared-container recipient view state (CAN-6501 golden)', () => {
  it('refuses every recipient view channel while shared containers are disabled', async () => {
    flags.sharedContainers = false;
    const refusals = {
      dismiss: await invoke(IPC_CHANNELS.sharedContainersDismiss, {
        containerId: CONTAINER_ID,
      }),
      restore: await invoke(IPC_CHANNELS.sharedContainersRestore, {
        containerId: CONTAINER_ID,
      }),
      listDismissed: await invoke(
        IPC_CHANNELS.sharedContainersListDismissed,
        {},
      ),
    };
    flags.sharedContainers = true;
    expect({ refusals, requests: newRequests() }).toMatchSnapshot();
    expect(signals).not.toHaveBeenCalled();
  });

  it('dismisses an accepted container: hosted grant and local records', async () => {
    await seedRecipient(CONTAINER_ID);
    await seedRecipient(OTHER_CONTAINER_ID);
    const before = localRecords(CONTAINER_ID);
    expect(before).toEqual({
      accepted: true,
      runConsent: { allowedAt: FIXED_TIME, publisherUserId: OWNER_ID },
      runEnvironment: true,
      replicaIndexed: true,
      replicaBytes: true,
    });
    const refusals = {
      invalidId: await invoke(IPC_CHANNELS.sharedContainersDismiss, {
        containerId: '../escape',
      }),
      invalidOrganization: await invoke(IPC_CHANNELS.sharedContainersDismiss, {
        containerId: CONTAINER_ID,
        organizationId: '../escape',
      }),
    };
    expect(newRequests()).toEqual([]);
    owned.insideWrites.length = 0;
    const dismissedOnce = await invoke(IPC_CHANNELS.sharedContainersDismiss, {
      containerId: CONTAINER_ID,
      organizationId: ORG_ID,
    });
    // The guard saw each store the dismiss cleans write inside the root.
    expect(owned.insideWrites).toEqual(
      expect.arrayContaining(
        [
          'shared-container-acceptance.json',
          'shared-container-run-env.json',
          join('shared-containers', 'index.json'),
        ].map((path) => dataPath(path)),
      ),
    );
    const after = localRecords(CONTAINER_ID);
    const signalsAfterFirst = signals.mock.calls.length;
    // A repeat finds the grant gone (a validated 404) and still converges.
    // Pins current defect; fix tracked in CAN-7456. It pushes replica-changed
    // and signals the inbox again for the already-purged container.
    const dismissedAgain = await invoke(IPC_CHANNELS.sharedContainersDismiss, {
      containerId: CONTAINER_ID,
      organizationId: ORG_ID,
    });
    expect({
      refusals,
      dismissedOnce,
      dismissedAgain,
      before,
      after,
      // The other accepted container keeps every record.
      other: localRecords(OTHER_CONTAINER_ID),
      signalsAfterFirst,
      signals: signals.mock.calls.length,
      requests: newRequests(),
      pushes: pushes.list(),
    }).toMatchSnapshot();
  });

  it('cleans up locally when the hosted dismiss fails', async () => {
    await seedRecipient(OTHER_CONTAINER_ID);
    expect(localRecords(OTHER_CONTAINER_ID)).toEqual({
      accepted: true,
      runConsent: { allowedAt: FIXED_TIME, publisherUserId: OWNER_ID },
      runEnvironment: true,
      replicaIndexed: true,
      replicaBytes: true,
    });
    plan('DELETE', 500, { error: 'Internal error' });
    const failed = await invoke(IPC_CHANNELS.sharedContainersDismiss, {
      containerId: OTHER_CONTAINER_ID,
      organizationId: ORG_ID,
    });
    // Pins current defect; fix tracked in CAN-7456. The replica and run values
    // are purged but acceptance and run consent stay, and no view is signalled.
    expect({
      failed,
      after: localRecords(OTHER_CONTAINER_ID),
      signals: signals.mock.calls.length,
      requests: newRequests(),
      pushes: pushes.list(),
    }).toMatchSnapshot();
  });

  it('lists dismissed containers from the hosted service', async () => {
    const list = (request: unknown): Promise<unknown> =>
      invoke(IPC_CHANNELS.sharedContainersListDismissed, request);
    dismissed.add(CONTAINER_ID);
    dismissed.add(OTHER_CONTAINER_ID);
    const refusals = {
      missingRequest: await list(undefined),
      invalidOrganization: await list({ organizationId: '../escape' }),
    };
    expect(newRequests()).toEqual([]);
    const listed = await list({ organizationId: ORG_ID, limit: 1 });
    const repeated = await list({ organizationId: ORG_ID, limit: 1 });
    expect(repeated).toEqual(listed);
    // The route's cursor comes back unchanged and fetches the next page; an
    // over-large page is clamped before it reaches the route.
    const cursor =
      isRecord(listed) && isRecord(listed.resolved)
        ? listed.resolved.nextCursor
        : undefined;
    expect(cursor).toBe(keysetCursor(OTHER_CONTAINER_ID));
    const paged = await list({ organizationId: ORG_ID, cursor, limit: 500 });
    plan('GET', 401, { error: 'Unauthorized' });
    const unauthorized = await list({});
    expect({
      refusals,
      listed,
      paged,
      unauthorized,
      signals: signals.mock.calls.length,
      requests: newRequests(),
    }).toMatchSnapshot();
  });

  it('restores a dismissed container as a pending invitation', async () => {
    const restore = (containerId: string): Promise<unknown> =>
      invoke(IPC_CHANNELS.sharedContainersRestore, {
        containerId,
        organizationId: ORG_ID,
      });
    dismissed.add(CONTAINER_ID);
    const refusals = {
      invalidId: await invoke(IPC_CHANNELS.sharedContainersRestore, {
        containerId: '../escape',
      }),
    };
    const restored = await restore(CONTAINER_ID);
    const signalsAfterRestore = signals.mock.calls.length;
    // Restoring needs a new accept: no acceptance record comes back.
    const acceptedAfterRestore = localRecords(CONTAINER_ID).accepted;
    // A replay after a lost answer finds the live grant and succeeds again.
    const replayed = await restore(CONTAINER_ID);
    // A container that was never dismissed has nothing to restore.
    const notRestorable = await restore(OTHER_CONTAINER_ID);
    plan('POST', 500, { error: 'Internal error' });
    const failed = await restore(GONE_CONTAINER_ID);
    expect({
      refusals,
      restored,
      signalsAfterRestore,
      acceptedAfterRestore,
      replayed,
      notRestorable,
      failed,
      signals: signals.mock.calls.length,
      requests: newRequests(),
      pushes: pushes.list(),
    }).toMatchSnapshot();
  });

  it('answers unsupported when the server predates recoverable removal', async () => {
    cloud.capabilities = ['shared-containers-v1'];
    await saveAccount(['shared-containers-v1']);
    const result = {
      listDismissed: await invoke(
        IPC_CHANNELS.sharedContainersListDismissed,
        {},
      ),
      restore: await invoke(IPC_CHANNELS.sharedContainersRestore, {
        containerId: CONTAINER_ID,
      }),
    };
    expect({
      result,
      signals: signals.mock.calls.length,
      requests: newRequests(),
    }).toMatchSnapshot();
  });
});
