/** CAN-4733 (security review, Low): the desktop dispatcher scopes a dispatch tag before its in-process worker's receipts, as the daemon core does. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchTagPrincipal,
  peerScopedDispatchTag,
  WORKER_EXECUTOR_DISPATCH_TAGS_PER_PEER_MAX,
} from '@canopy/core-runtime';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { DESKTOP_DISPATCH_TAGS_PER_RENDERER_MAX } from '../desktop-dispatch-tag-bounds';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import type * as MutationAdapter from '../worker-filesystem-mutation-adapter';

/** How often the delete handler ran: a refused dispatch must not reach it. */
let mockDeleteRuns = 0;
/** The dispatch tag the delete handler last ran with. */
let mockDeleteTag: string | undefined;
jest.mock('../worker-filesystem-mutation-adapter', () => {
  const actual = jest.requireActual<typeof MutationAdapter>(
    '../worker-filesystem-mutation-adapter',
  );
  return {
    ...actual,
    createWorkerFilesystemMutationAdapter: (
      ...args: Parameters<typeof actual.createWorkerFilesystemMutationAdapter>
    ): ReturnType<typeof actual.createWorkerFilesystemMutationAdapter> => {
      const handlers = actual.createWorkerFilesystemMutationAdapter(...args);
      const remove = handlers['worker.filesystem.entry.delete'];
      return {
        ...handlers,
        'worker.filesystem.entry.delete': (
          ...call: Parameters<typeof remove>
        ): ReturnType<typeof remove> => {
          mockDeleteRuns += 1;
          mockDeleteTag = call[1]?.metadata.dispatchId;
          return remove(...call);
        },
      };
    },
  };
});

jest.setTimeout(300_000);

const UNSCOPED = 'This dispatch tag was not scoped to a caller by the core.';
const PEER_BOUND =
  'This caller may record no more dispatch tags on this worker until it restarts.';
/**
 * A renderer relay session's caller, as `createRendererRelay` builds it: the
 * surface's principal and a fresh client instance per session.
 */
function relaySession(
  session: string,
  surface: 'main' | 'app-advisor' = 'main',
): CanopyCallerDescriptor {
  return {
    principalId: `local-desktop-renderer:${surface}`,
    clientInstanceId: `renderer-relay:${session}`,
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read', 'worker.filesystem.write'],
  };
}
const caller = relaySession('first');

let dir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-dispatch-tags-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  runtime = createDesktopRuntime();
});
afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const REUSED = 'This dispatch tag was already used for another dispatch.';

/** A tagged delete in a workspace that doesn't exist, so it fails in its host, past the receipts. */
function taggedDelete(
  from: CanopyCallerDescriptor,
  idempotencyKey: string,
  dispatchId: string,
): Promise<unknown> {
  const meta = { idempotencyKey, dispatchId };
  return runtime
    .instruction(
      'worker.filesystem.entry.delete',
      {
        scope: { workspaceId: 'missing-workspace', worktreeId: 'missing' },
        fileRootId: 'missing',
        relativePath: 'file',
        expectedVersion: null,
        recursive: false,
        disposition: 'permanent',
        _meta: meta,
      },
      { caller: from, metadata: meta },
    )
    .then(
      () => 'resolved',
      (error: unknown) => error,
    );
}

/** The delete reached its host: it wasn't refused for its tag before running. */
function expectReachedHost(outcome: unknown): void {
  expect(outcome).not.toBe('resolved');
  expect(outcome).not.toMatchObject({ payload: { message: UNSCOPED } });
  expect(outcome).not.toMatchObject({ payload: { message: REUSED } });
}

it("passes a renderer's raw dispatch tag to the in-process worker scoped, never refused as unscoped", async () => {
  expectReachedHost(
    await taggedDelete(caller, 'tagged-delete', 'renderer-tag'),
  );
  // The worker received the three-part form: principal, peer, then the tag.
  expect(mockDeleteTag).toBe(peerScopedDispatchTag(caller, 'renderer-tag'));
  expect(mockDeleteTag?.split(':').slice(0, 2)).toEqual([
    'peer',
    dispatchTagPrincipal(caller.principalId),
  ]);
});

it('(c) keeps a raw tag a renderer picks under its own session, so a new session of the same window never has its own fresh tag refused as reused', async () => {
  const first = relaySession('collide-a');
  const second = relaySession('collide-b');
  expectReachedHost(await taggedDelete(first, 'shared-1', 'shared'));
  // The tag was recorded: the same renderer reusing it is refused.
  await expect(
    taggedDelete(first, 'shared-2', 'shared'),
  ).resolves.toMatchObject({ payload: { kind: 'conflict', message: REUSED } });
  // Another renderer picking the same raw tag gets its own.
  expectReachedHost(await taggedDelete(second, 'shared-3', 'shared'));
});

it("leaves another renderer session's tags working after one session exhausts its share", async () => {
  const greedy = relaySession('greedy');
  const other = relaySession('other');
  for (let i = 0; i < WORKER_EXECUTOR_DISPATCH_TAGS_PER_PEER_MAX; i += 1024) {
    const batch = Array.from({ length: 1024 }, (_, j) =>
      taggedDelete(greedy, `greedy-${i + j}`, `greedy-${i + j}`),
    );
    for (const outcome of await Promise.all(batch)) {
      expect(outcome).not.toMatchObject({ payload: { message: PEER_BOUND } });
    }
  }
  await expect(
    taggedDelete(greedy, 'greedy-over', 'greedy-over'),
  ).resolves.toMatchObject({
    payload: {
      kind: 'resource_exhausted',
      message: PEER_BOUND,
      details: { receipt: 'keys-exhausted', scope: 'peer' },
    },
  });
  // The other session's raw tag, even one the greedy session used, still runs.
  expectReachedHost(await taggedDelete(other, 'other-1', 'greedy-0'));
});

const PRINCIPAL_BOUND =
  "This caller's principal may record no more dispatch tags on this worker, from any of its sessions, until it restarts.";
const mainProcess: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'desktop-core',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'worker.filesystem.write'],
};

/**
 * Rotates relay sessions of one window, one full peer share each, until a
 * tag is refused past the peer bound; returns that refusal.
 */
async function rotateUntilRefused(
  surface: 'main' | 'app-advisor',
  label: string,
): Promise<unknown> {
  // The run-wide bound is 16 sessions' worth; a 17th means nothing refused.
  for (let session = 0; session <= 16; session += 1) {
    const rotated = relaySession(`${label}-${session}`, surface);
    for (let i = 0; i < WORKER_EXECUTOR_DISPATCH_TAGS_PER_PEER_MAX; i += 1024) {
      const batch = Array.from({ length: 1024 }, (_, j) =>
        // Every session reuses the same raw tags: each is its own (c).
        taggedDelete(rotated, `${label}-${session}-${i + j}`, `tag-${i + j}`),
      );
      const refused = (await Promise.all(batch)).find(
        (outcome) =>
          typeof outcome === 'object' &&
          outcome !== null &&
          'payload' in outcome &&
          (outcome as { payload: { kind?: string } }).payload.kind ===
            'resource_exhausted',
      );
      if (refused) return refused;
    }
  }
  return 'never refused';
}

it('(a) caps one renderer window across the relay sessions it rotates through, with a typed refusal that never reaches the handler', async () => {
  expect(
    DESKTOP_DISPATCH_TAGS_PER_RENDERER_MAX /
      WORKER_EXECUTOR_DISPATCH_TAGS_PER_PEER_MAX,
  ).toBe(4);
  // The app-advisor principal is fresh: exactly four sessions' worth runs.
  const before = mockDeleteRuns;
  await expect(
    rotateUntilRefused('app-advisor', 'advisor'),
  ).resolves.toMatchObject({
    payload: {
      kind: 'resource_exhausted',
      message: PRINCIPAL_BOUND,
      details: { receipt: 'keys-exhausted', scope: 'principal' },
      retry: { kind: 'never' },
    },
  });
  expect(mockDeleteRuns - before).toBe(DESKTOP_DISPATCH_TAGS_PER_RENDERER_MAX);
  // A fresh session of the same window gets no fresh share, and its refused
  // dispatch never reaches the handler.
  const refusedFrom = mockDeleteRuns;
  await expect(
    taggedDelete(relaySession('advisor-next', 'app-advisor'), 'next', 'fresh'),
  ).resolves.toMatchObject({
    payload: { kind: 'resource_exhausted', details: { scope: 'principal' } },
  });
  // Nothing was recorded: the same session sending that tag again is refused
  // for the cap again, never as a reused tag.
  await expect(
    taggedDelete(relaySession('advisor-next', 'app-advisor'), 'again', 'fresh'),
  ).resolves.toMatchObject({
    payload: { kind: 'resource_exhausted', details: { scope: 'principal' } },
  });
  expect(mockDeleteRuns).toBe(refusedFrom);
});

it('(b) keeps a main-process peer dispatching once both renderer windows are exhausted', async () => {
  // The main window's principal already holds the earlier tests' tags.
  await expect(rotateUntilRefused('main', 'window')).resolves.toMatchObject({
    payload: { kind: 'resource_exhausted', details: { scope: 'principal' } },
  });
  const before = mockDeleteRuns;
  expectReachedHost(await taggedDelete(mainProcess, 'main-process-1', 'tag-0'));
  expect(mockDeleteRuns).toBe(before + 1);
});
