// Persistence contract: real registry, state writer, service lifecycle and V2
// repository; only producer teardown and derived/host sidecars are replaced.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
  StorageOutcomeUnknownError,
} from '@canopy/core-runtime/storage';
import {
  removeReviewState,
  writeReviewStateText,
} from '@canopy/core-runtime/node/review';
import { admittedStorageRowForPath } from '@canopy/execution-engine/node/lib/admitted-storage-paths';
import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from './helpers/chat-state-service-fixture';
import * as chatService from '../services/chat-state-service';
import * as atomic from '../lib/atomic-file';
import * as directoryFlush from '@canopy/core-platform/directory-flush';
import { withCodeReviewTargetLifecycle } from '../lib/code-review-storage-admission';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  getArchivedContainerManifestPath,
  getCodeReviewRegistryFilePath,
  getWorktreeAttachmentsDir,
} from '../lib/paths';
import {
  getCodeReviewTarget,
  getCodeReviewTargetSync,
  listCodeReviewTargets,
  markCodeReviewTargetRetiring,
  registerCodeReviewTarget,
  removeCodeReviewTarget,
} from '../lib/code-review-registry';
import {
  removeCodeReviewChatsForWorktree,
  retireCodeReviewTarget,
} from '../lib/code-review-cleanup';
import {
  commitArchivedContainer,
  purgeArchivedContainer,
} from '../lib/archived-containers';

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
let teardown = (): Promise<void> => Promise.resolve();
jest.mock('../lib/worktree-live-cleanup', () => ({
  cleanupLiveWorktreeState: (): Promise<void> => teardown(),
  purgeLiveWorktreeObservabilityData: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../chat-search/service', () => ({
  getChatSearchService: (): object => ({
    deleteWorktreeDocs: (): Promise<void> => Promise.resolve(),
    worktreeContainerPurged: (): Promise<void> => Promise.resolve(),
  }),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupWorktreeChatPluginDirs: (): void => undefined,
}));

const owner = { projectId: 'review-project', worktreeId: 'review-worktree' };
const key = 'review-project--review-worktree';
const scope = { projectId: CODE_REVIEW_CHAT_PROJECT_ID, worktreeId: key };
let root: string;
let fixture: ChatStateServiceFixture;
let priorRoot: string | undefined;

beforeEach(() => {
  priorRoot = process.env.CANOPY_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), 'review-lifecycle-'));
  process.env.CANOPY_DATA_DIR = root;
  fixture = createChatStateServiceFixture({ canonicalPaths: true });
  jest
    .spyOn(chatService, 'getChatStateService')
    .mockReturnValue(fixture.service);
  teardown = (): Promise<void> => Promise.resolve();
});
afterEach(async () => {
  fixture.service.disposeTurnHandoff();
  await fixture.dispose();
  jest.restoreAllMocks();
  if (priorRoot === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = priorRoot;
  rmSync(root, { recursive: true, force: true });
});

it('keeps active ownership and incarnation idempotent, and preserves historical ambiguous bytes', async () => {
  await registerCodeReviewTarget(key, owner);
  const original = readFileSync(getCodeReviewRegistryFilePath(), 'utf8');
  await registerCodeReviewTarget(key, owner);
  expect(readFileSync(getCodeReviewRegistryFilePath(), 'utf8')).toBe(original);
  await expect(
    registerCodeReviewTarget(key, { ...owner, projectId: 'replacement' }),
  ).rejects.toMatchObject({ reason: 'owner_changed' });
  expect(readFileSync(getCodeReviewRegistryFilePath(), 'utf8')).toBe(original);
  writeFileSync(
    getCodeReviewRegistryFilePath(),
    JSON.stringify({
      version: 1,
      extra: 'keep',
      targets: { [key]: { ...owner, raw: 'keep' } },
    }),
  );
  const legacy = readFileSync(getCodeReviewRegistryFilePath(), 'utf8');
  await registerCodeReviewTarget(key, owner);
  expect(readFileSync(getCodeReviewRegistryFilePath(), 'utf8')).toBe(legacy);
});

it('closes late activity, drains admitted work before teardown, then authorizes recreation only after removal', async () => {
  await registerCodeReviewTarget(key, owner);
  const incarnation = (await listCodeReviewTargets())[key].incarnation;
  await fixture.createChat(scope);
  const attachment = join(
    getWorktreeAttachmentsDir(scope.projectId, key),
    'kept.txt',
  );
  mkdirSync(dirname(attachment), { recursive: true });
  writeFileSync(attachment, 'old chat bytes');
  const activity = gate();
  const entered = gate();
  const stopping = gate();
  const stop = gate();
  teardown = async (): Promise<void> => {
    // Producer settlement must still reach canonical storage after retirement.
    await fixture.setRuntime(scope, 'idle', null);
    stopping.release();
    await stop.promise;
  };
  const send = fixture.service.runWithScopeActivity(scope, async () => {
    entered.release();
    await activity.promise;
  });
  await entered.promise;
  // Acquire the lifecycle at an observable barrier rather than timing a turn.
  const closed = gate();
  const original = fixture.service.runWithScopeDeletionLifecycle.bind(
    fixture.service,
  );
  jest
    .spyOn(fixture.service, 'runWithScopeDeletionLifecycle')
    .mockImplementation(async (target, run) => {
      const result = original(target, run);
      closed.release();
      return result;
    });
  const cleanup = removeCodeReviewChatsForWorktree(
    owner.projectId,
    owner.worktreeId,
  );
  await closed.promise;
  await expect(
    fixture.service.runWithScopeActivity(scope, () => Promise.resolve()),
  ).rejects.toMatchObject({ code: 'CHAT_SCOPE_DELETING' });
  expect(existsSync(attachment)).toBe(true);
  activity.release();
  await send;
  await stopping.promise;
  expect(await getCodeReviewTarget(key)).toBeNull();
  expect(getCodeReviewTargetSync(key)).toBeNull();
  const registration = registerCodeReviewTarget(key, owner);
  await registerCodeReviewTarget('unrelated', owner); // No global queue held by teardown.
  expect(existsSync(attachment)).toBe(true);
  stop.release();
  expect(await cleanup).toEqual([]);
  await registration;
  expect((await listCodeReviewTargets())[key].incarnation).not.toBe(
    incarnation,
  );
  expect(existsSync(attachment)).toBe(false);
  await fixture.createChat(scope);
  await expect(
    removeCodeReviewTarget(
      key,
      { ...owner, incarnation },
      getCodeReviewRegistryFilePath(),
    ),
  ).rejects.toMatchObject({ reason: 'owner_changed' });
  expect((await fixture.repository.getState(scope)).tabsFile.tabs).toHaveLength(
    1,
  );
});

it('preserves failed retirement, refuses its waiting registration, and resumes the durable marker on a later registration', async () => {
  await registerCodeReviewTarget(key, owner);
  const started = gate();
  const stop = gate();
  teardown = async (): Promise<void> => {
    started.release();
    await stop.promise;
    throw new Error('producer alive');
  };
  const cleanup = removeCodeReviewChatsForWorktree(
    owner.projectId,
    owner.worktreeId,
  );
  await started.promise;
  const registration = registerCodeReviewTarget(key, owner);
  const refused = expect(registration).rejects.toMatchObject({
    reason: 'retiring',
  });
  stop.release();
  expect(await cleanup).toEqual([expect.stringContaining('producer alive')]);
  await refused;
  expect((await listCodeReviewTargets())[key].state).toBe('retiring');
  await expect(
    fixture.service.runWithScopeActivity(scope, () => Promise.resolve()),
  ).rejects.toMatchObject({ code: 'CHAT_SCOPE_DELETING' });
  teardown = (): Promise<void> => Promise.resolve();
  await registerCodeReviewTarget(key, owner);
  expect((await listCodeReviewTargets())[key].state).toBe('active');
});

it('recognizes a retiring row loaded from disk after process-local lifecycle state is gone', async () => {
  const path = getCodeReviewRegistryFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      targets: {
        [key]: { ...owner, incarnation: 'old-process', state: 'retiring' },
      },
    }),
  );
  await expect(
    fixture.service.runWithScopeActivity(scope, () => Promise.resolve()),
  ).rejects.toMatchObject({ code: 'CHAT_SCOPE_DELETING' });
  let recovered = false;
  teardown = (): Promise<void> => {
    recovered = true;
    return Promise.resolve();
  };
  await registerCodeReviewTarget(key, owner);
  expect(recovered).toBe(true);
  expect((await listCodeReviewTargets())[key].incarnation).not.toBe(
    'old-process',
  );
});

it('returns review-cleanup warnings to ordinary deletion but refuses archive purge without losing its manifest', async () => {
  await registerCodeReviewTarget(key, owner);
  await fixture.createChat(scope);
  teardown = (): Promise<void> => Promise.reject(new Error('producer alive'));
  expect(
    await removeCodeReviewChatsForWorktree(owner.projectId, owner.worktreeId),
  ).toEqual([expect.stringContaining('producer alive')]);
  await commitArchivedContainer({
    version: 1,
    kind: 'worktree',
    projectId: owner.projectId,
    id: owner.worktreeId,
    name: 'Retained review',
    createdAt: '2026-11-01T00:00:00.000Z',
    archivedAt: '2026-11-16T00:00:00.000Z',
    expiresAt: '2026-11-23T00:00:00.000Z',
    retentionDays: 7,
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
  });
  const manifest = getArchivedContainerManifestPath(
    owner.projectId,
    owner.worktreeId,
  );
  const raw = readFileSync(manifest, 'utf8');
  await expect(
    purgeArchivedContainer(owner.projectId, owner.worktreeId),
  ).rejects.toThrow('producer alive');
  expect(readFileSync(manifest, 'utf8')).toBe(raw);
  expect((await listCodeReviewTargets())[key].state).toBe('retiring');
  expect((await fixture.repository.getState(scope)).tabsFile.tabs).toHaveLength(
    1,
  );
});

it('keeps queued registry admission, read and install on its captured routing branch', async () => {
  const path = getCodeReviewRegistryFilePath();
  const entered = gate();
  const release = gate();
  const first = withCodeReviewTargetLifecycle(path, key, async () => {
    entered.release();
    await release.promise;
  });
  await entered.promise;
  const registration = registerCodeReviewTarget(key, owner);
  registerWorkspaceTypes(
    new Map([[CODE_REVIEW_CHAT_PROJECT_ID, 'single-repo']]),
  );
  const otherPath = getCodeReviewRegistryFilePath();
  try {
    expect(otherPath).not.toBe(path);
    release.release();
    await first;
    await registration;
    expect((await listCodeReviewTargets(path))[key]).toMatchObject(owner);
    expect(existsSync(otherPath)).toBe(false);
  } finally {
    release.release();
    registerWorkspaceTypes(new Map());
  }
});

it('refuses stale-owner teardown and compare-and-delete before touching replacement ownership', async () => {
  await registerCodeReviewTarget(key, owner);
  const entry = (await listCodeReviewTargets())[key];
  const path = getCodeReviewRegistryFilePath();
  const attachment = join(
    getWorktreeAttachmentsDir(scope.projectId, key),
    'keep.txt',
  );
  mkdirSync(dirname(attachment), { recursive: true });
  writeFileSync(attachment, 'replacement chat');
  let stopped = false;
  teardown = (): Promise<void> => {
    stopped = true;
    return Promise.resolve();
  };
  await expect(
    retireCodeReviewTarget(path, key, { ...entry, incarnation: 'stale' }),
  ).rejects.toMatchObject({ reason: 'owner_changed' });
  expect(stopped).toBe(false);
  expect(readFileSync(attachment, 'utf8')).toBe('replacement chat');
  await expect(
    markCodeReviewTargetRetiring(path, key, { ...entry, incarnation: 'stale' }),
  ).rejects.toMatchObject({ reason: 'owner_changed' });
  await markCodeReviewTargetRetiring(path, key, entry);
  await expect(
    removeCodeReviewTarget(key, { ...entry, projectId: 'other' }, path),
  ).rejects.toMatchObject({ reason: 'owner_changed' });
  expect((await listCodeReviewTargets())[key].incarnation).toBe(
    entry.incarnation,
  );
});

it.each([
  '{',
  '{"version":2,"targets":{}}',
  '{"version":1,"targets":{"bad":{}}}',
])('preserves unsupported registry bytes: %s', async (raw) => {
  const path = getCodeReviewRegistryFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  await expect(registerCodeReviewTarget(key, owner)).rejects.toThrow();
  await expect(
    removeCodeReviewChatsForWorktree(owner.projectId, owner.worktreeId),
  ).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe(raw);
});

it('keeps the old registry before install and treats a post-install flush error as outcome unknown', async () => {
  await registerCodeReviewTarget(key, owner);
  const path = getCodeReviewRegistryFilePath();
  const raw = readFileSync(path, 'utf8');
  const write = jest.spyOn(atomic, 'writeFileAtomically');
  write.mockRejectedValueOnce(new Error('pre-install'));
  await expect(registerCodeReviewTarget('before', owner)).rejects.toThrow(
    'pre-install',
  );
  expect(readFileSync(path, 'utf8')).toBe(raw);
  const flush = jest.spyOn(directoryFlush, 'flushDirectory');
  flush.mockRejectedValueOnce(new Error('flush'));
  await expect(registerCodeReviewTarget('after', owner)).rejects.toBeInstanceOf(
    StorageOutcomeUnknownError,
  );
  expect(await getCodeReviewTarget('after')).toEqual(owner);
  const installed = readFileSync(path, 'utf8');
  flush.mockRejectedValueOnce(new Error('retry flush unavailable'));
  await expect(registerCodeReviewTarget('after', owner)).rejects.toBeInstanceOf(
    StorageOutcomeUnknownError,
  );
  expect(readFileSync(path, 'utf8')).toBe(installed);
  await registerCodeReviewTarget('after', owner);
  expect(readFileSync(path, 'utf8')).toBe(installed);
  expect(flush).toHaveBeenCalledTimes(3);
  expect(flush).toHaveBeenLastCalledWith(dirname(path));
  expect(write).toHaveBeenCalledTimes(4);
  expect(write).toHaveBeenLastCalledWith(
    path,
    installed,
    expect.objectContaining({ durable: true }),
  );
});

it('reconfirms an outcome-unknown retirement marker before retrying destructive cleanup', async () => {
  await registerCodeReviewTarget(key, owner);
  await fixture.createChat(scope);
  const original = atomic.writeFileAtomically;
  const write = jest.spyOn(atomic, 'writeFileAtomically');
  write.mockImplementationOnce(async (target, data, options) => {
    await original(target, data, options);
    throw new StorageOutcomeUnknownError('directory_flush', new Error('flush'));
  });
  let stopped = false;
  teardown = (): Promise<void> => {
    stopped = true;
    return Promise.resolve();
  };
  expect(
    await removeCodeReviewChatsForWorktree(owner.projectId, owner.worktreeId),
  ).toHaveLength(1);
  expect((await listCodeReviewTargets())[key].state).toBe('retiring');
  expect(stopped).toBe(false);

  write.mockRejectedValueOnce(new Error('retry flush unavailable'));
  await expect(registerCodeReviewTarget(key, owner)).rejects.toThrow(
    'retry flush unavailable',
  );
  expect(stopped).toBe(false);
  expect((await fixture.repository.getState(scope)).tabsFile.tabs).toHaveLength(
    1,
  );

  await registerCodeReviewTarget(key, owner);
  expect(stopped).toBe(true);
  expect((await listCodeReviewTargets())[key].state).toBe('active');
  expect((await fixture.repository.getState(scope)).tabsFile.tabs).toHaveLength(
    0,
  );
});

it('refuses unadmitted and daemon writers before creating or deleting review files', async () => {
  for (const namespace of [
    'code_review_chats_dir',
    'code_review_chats_legacy',
    'code_review_registry',
    'code_review_state',
  ] as const) {
    expect(() =>
      assertAdmittedWriter(
        namespace,
        'daemon',
        'main/lib/code-review-registry',
        STORAGE_OWNERSHIP,
      ),
    ).toThrow();
    expect(() =>
      assertAdmittedWriter(
        namespace,
        'electron_main',
        'unadmitted',
        STORAGE_OWNERSHIP,
      ),
    ).toThrow();
  }
  const state = join(root, 'new', 'code-review.json');
  await expect(writeReviewStateText(state, '{}', 'daemon')).rejects.toThrow();
  expect(existsSync(dirname(state))).toBe(false);
  mkdirSync(dirname(state), { recursive: true });
  writeFileSync(state, 'keep');
  await expect(removeReviewState(state, 'daemon')).rejects.toThrow();
  expect(readFileSync(state, 'utf8')).toBe('keep');
  for (const container of ['workspaces', 'app-workspaces']) {
    const registry = join(
      root,
      container,
      'code-review-chat',
      'chats',
      'registry.json',
    );
    expect(admittedStorageRowForPath(registry, root)).toBe(
      'code_review_registry',
    );
    await expect(
      atomic.writeFileAtomically(registry, '{}'),
    ).rejects.toMatchObject({ reason: 'unadmitted_writer' });
    expect(existsSync(dirname(registry))).toBe(false);
    expect(
      admittedStorageRowForPath(
        join(root, container, 'p', 'worktree-data', 'w', 'code-review.json'),
        root,
      ),
    ).toBe('code_review_state');
  }
});
