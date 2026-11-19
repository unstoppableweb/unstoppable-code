// Persistence contract: real registry, state writer, service lifecycle and V2
// repository; only producer teardown and derived/host sidecars are replaced.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  buildCodeReviewScopeKey,
  type ChatTabsFile,
} from '@canopy/desktop-shared/types';
import * as mainProcessLogging from '../lib/main-process-logging';
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
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  DELTA_CHECKPOINT_MARKER_NAME,
  DELTA_CHECKPOINT_STAGED_SUFFIX,
} from '../lib/chat-delta-journal/format';
import {
  ChatDeltaJournalWriter,
  demoteFromDeltaJournal,
} from '../lib/chat-delta-journal/writer';
import { message } from './helpers/chat-delta-journal-harness';
import * as atomic from '../lib/atomic-file';
import * as fsPromises from 'node:fs/promises';
jest.mock('node:fs/promises', () => {
  const fs = jest.requireActual<typeof fsPromises>('node:fs/promises');
  return {
    __esModule: true,
    ...fs,
    readFile: fs.readFile.bind(fs),
    readdir: fs.readdir.bind(fs),
    rename: fs.rename.bind(fs),
  };
});
import * as directoryFlush from '@canopy/core-platform/directory-flush';
import * as archiveIo from '../archive/archive-io-runner';
import {
  ensureCodeReviewNamespaceQualification,
  getCodeReviewNamespaceGuardrail,
  withCodeReviewTargetLifecycle,
} from '../lib/code-review-storage-admission';
import { runCodeReviewTask } from '../lib/code-review-deletion-fence';
import { migrateAppManagedChatWorkspaces } from '../lib/app-managed-workspaces';
import { migrateAppAdvisorChatsToWorkEntries } from '../lib/app-advisor-work-entry-migration';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  getArchivedContainerManifestPath,
  getCodeReviewRegistryFilePath,
  getCodeReviewStateFilePath,
  getWorktreeAttachmentsDir,
  getWorktreeDataDir,
  w5RecordReadPaths,
} from '../lib/paths';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
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
// Host services outside the generic worktree cleanup being exercised.
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): object => ({
    cancelLocalScope: (): Promise<void> => Promise.resolve(),
    commitLocalScopeCancellation: (): Promise<void> => Promise.resolve(),
    releaseLocalScopeFence: (): Promise<void> => Promise.resolve(),
    handleChatTerminalEvent: (): Promise<void> => Promise.resolve(),
  }),
}));
jest.mock('../browser/browser-profile-lifecycle', () => ({
  retireRemovedBrowserTask: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../code-graph/daemon-code-graph-route', () => ({
  drainDaemonCodeGraphWorktree: (): Promise<void> => Promise.resolve(),
}));

const owner = { projectId: 'review-project', worktreeId: 'review-worktree' };
const key = 'review-project--review-worktree';
const scope = { projectId: CODE_REVIEW_CHAT_PROJECT_ID, worktreeId: key };
let root: string;
let fixture: ChatStateServiceFixture;
let priorRoot: string | undefined;

beforeEach(async () => {
  priorRoot = process.env.CANOPY_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), 'review-lifecycle-'));
  process.env.CANOPY_DATA_DIR = root;
  registerWorkspaceTypes(new Map());
  await ensureCodeReviewNamespaceQualification();
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
  registerWorkspaceTypes(new Map());
  if (priorRoot === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = priorRoot;
  rmSync(root, { recursive: true, force: true });
});

/**
 * q-34: a failed qualification never refuses. Startup resolves, the failure is
 * the guardrail witness, and later effects proceed on the routed root.
 */
async function expectUnqualified(message?: string): Promise<void> {
  await expect(migrateAppManagedChatWorkspaces()).resolves.toBeUndefined();
  const guardrail = getCodeReviewNamespaceGuardrail();
  expect(guardrail).toMatchObject({
    qualified: false,
    failure: { code: 'code_review_namespace_unqualified' },
  });
  if (message !== undefined)
    expect(guardrail.failure?.message).toContain(message);
}

describe('selected-root namespace custody and admission', () => {
  function put(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  function candidate(name: 'legacy' | 'workspace' | 'app'): string {
    return name === 'legacy'
      ? join(root, 'code-review-chats')
      : join(
          root,
          name === 'app' ? 'app-workspaces' : 'workspaces',
          'code-review-chat',
        );
  }
  function registryAt(
    name: 'legacy' | 'workspace' | 'app',
    targets: object,
  ): string {
    const path = join(
      candidate(name),
      name === 'legacy' ? '' : 'chats',
      'registry.json',
    );
    put(path, JSON.stringify({ version: 1, extension: 'retain', targets }));
    return path;
  }
  const predecessorTitle = 'Predecessor';
  /** Writes a real V2 scope, then makes it the unindexed workspace predecessor. */
  async function seedPredecessorScope(
    target = scope,
    form?: 'format 2' | 'mid-checkpoint',
  ): Promise<void> {
    const seeder = new ChatStateV2Repository();
    try {
      await seeder.transact(
        target,
        [
          {
            type: 'tab.created',
            tab: {
              id: 'chat-1',
              title: predecessorTitle,
              createdAt: '2026-11-17',
              messages: [message('m1', 'Predecessor history', 'user')],
            },
          },
        ],
        { source: 'renderer-command' },
      );
      await seeder.flushScope(target);
    } finally {
      await seeder.drainAll();
    }
    const store = new ChatStorageV2(candidate('app'), target.worktreeId);
    if (form === 'format 2')
      expect(await demoteFromDeltaJournal(store)).toBe(true);
    if (form === 'mid-checkpoint') {
      // A crash once the staged indexes are marked for publication.
      const writer = await ChatDeltaJournalWriter.open(store, {
        onBoundary: (point) =>
          point === 'checkpoint-publishing-marked'
            ? Promise.reject(new Error('crash'))
            : Promise.resolve(),
      });
      const next = structuredClone(writer.indexes());
      next.live.revision += 1;
      next.archive.revision += 1;
      next.recovery.mutationIds = [...next.recovery.mutationIds, 'streamed'];
      await writer.commit({
        expectedRevision: writer.indexes().live.revision,
        next,
        writes: [
          {
            chatId: 'chat-1',
            kind: 'active-upsert',
            messages: [message('m2', 'streaming')],
          },
        ],
        mutationIds: ['streamed'],
      });
      await expect(writer.checkpoint()).rejects.toThrow('crash');
    }
    mkdirSync(join(root, 'workspaces'), { recursive: true });
    renameSync(candidate('app'), candidate('workspace'));
  }
  async function coldChat(
    target = scope,
  ): Promise<{ title?: string; message?: string }> {
    const cold = new ChatStateV2Repository();
    try {
      const [tab] = (
        await cold.getState(target, {
          chatIds: ['chat-1'],
          fullTranscript: true,
        })
      ).tabsFile.tabs;
      return { title: tab?.title, message: tab?.messages[0]?.id };
    } finally {
      await cold.drainAll();
    }
  }

  it('admits absent candidates without creating a namespace or completion marker', async () => {
    await migrateAppManagedChatWorkspaces();
    expect(existsSync(candidate('app'))).toBe(false);
    expect(existsSync(join(root, '.code-review-namespace-custody'))).toBe(
      false,
    );
    await registerCodeReviewTarget(key, owner);
    expect(await getCodeReviewTarget(key)).toEqual(owner);
  });

  it('splits App Advisor Work Entries at startup and keeps Code Review available after failed qualification', async () => {
    const source = registryAt('legacy', { [key]: owner });
    writeFileSync(source, '{');
    put(
      join(root, 'workspaces', APP_ADVISOR_PROJECT_ID, 'chats', 'global.json'),
      JSON.stringify({
        version: 1,
        activeTabId: 'advisor-chat',
        tabs: [
          {
            id: 'advisor-chat',
            title: 'Existing chat',
            kind: 'chat',
            createdAt: '2026-11-17T00:00:00.000Z',
            messages: [],
          },
        ],
      } satisfies ChatTabsFile),
    );
    await expectUnqualified();
    await migrateAppAdvisorChatsToWorkEntries();
    expect(
      (await readWorkEntriesFileStrict(APP_ADVISOR_PROJECT_ID)).entries.map(
        (entry) => entry.id,
      ),
    ).toContain('advisor-chat');
    expect(
      existsSync(
        join(
          root,
          'app-workspaces',
          APP_ADVISOR_PROJECT_ID,
          'chats',
          'global.json',
        ),
      ),
    ).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, 'migrations.json'), 'utf8')),
    ).toMatchObject({ app_advisor_work_entries: true });
    await registerCodeReviewTarget('new-key', owner);
    expect(await getCodeReviewTarget('new-key')).toEqual(owner);
    expect(readFileSync(source, 'utf8')).toBe('{');
    expect(getCodeReviewNamespaceGuardrail().proceeded).toEqual(['mutation']);
  });

  it('moves only missing whole predecessor scopes after failed startup qualification, as base did', async () => {
    const appRegistry = registryAt('app', { [key]: owner });
    const legacyRegistry = registryAt('legacy', {
      [key]: { ...owner, projectId: 'different' },
    });
    const raw = [appRegistry, legacyRegistry].map((path) =>
      readFileSync(path, 'utf8'),
    );
    const tabs = (title: string): string =>
      JSON.stringify({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title,
            kind: 'chat',
            createdAt: '2026-11-17',
            messages: [],
          },
        ],
      } satisfies ChatTabsFile);
    put(join(candidate('legacy'), 'legacy-only.json'), tabs('Legacy only'));
    put(join(candidate('app'), 'chats', 'shared.json'), tabs('App copy'));
    put(join(candidate('legacy'), 'shared.json'), tabs('Legacy copy'));
    put(join(candidate('legacy'), 'shared.json.bak'), tabs('Legacy backup'));
    const wsOnly = join('chat-storage-v2', 'ws-only', 'live-index.json');
    put(join(candidate('workspace'), wsOnly), 'workspace-only index');
    const bad = join('chat-storage-manifests', 'bad.json');
    put(join(candidate('workspace'), bad), '{"version":9}');
    put(join(candidate('workspace'), 'chats', 'bad.json'), tabs('Bad'));
    await expectUnqualified();
    // Missing whole scopes become reachable on the routed root.
    expect(readFileSync(join(candidate('app'), wsOnly), 'utf8')).toBe(
      'workspace-only index',
    );
    const repository = new ChatStateV2Repository();
    try {
      const legacyOnly = {
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'legacy-only',
      };
      expect(
        (await repository.getState(legacyOnly)).tabsFile.tabs.map(
          (tab) => tab.title,
        ),
      ).toEqual(['Legacy only']);
    } finally {
      await repository.drainAll();
    }
    // Divergent, unreadable and registry data is never merged over or moved.
    expect(
      [appRegistry, legacyRegistry].map((path) => readFileSync(path, 'utf8')),
    ).toEqual(raw);
    expect(
      readFileSync(join(candidate('app'), 'chats', 'shared.json'), 'utf8'),
    ).toBe(tabs('App copy'));
    expect(existsSync(join(candidate('app'), 'chats', 'shared.json.bak'))).toBe(
      false,
    );
    expect(
      readFileSync(join(candidate('legacy'), 'shared.json.bak'), 'utf8'),
    ).toBe(tabs('Legacy backup'));
    expect(readFileSync(join(candidate('workspace'), bad), 'utf8')).toBe(
      '{"version":9}',
    );
    expect(existsSync(join(candidate('workspace'), 'chats', 'bad.json'))).toBe(
      true,
    );
    expect(existsSync(join(candidate('app'), bad))).toBe(false);
    // One-shot like base: later launches leave remaining predecessors alone.
    put(join(candidate('legacy'), 'later.json'), tabs('Later'));
    await expectUnqualified();
    expect(existsSync(join(candidate('legacy'), 'later.json'))).toBe(true);
  });

  it('retries a predecessor move a fault left incomplete on the next launch, as base did', async () => {
    registryAt('app', { [key]: owner });
    registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
    const stuck = join('chat-journals', 'stuck.jsonl');
    const moved = join('chat-storage-v2', 'moved', 'live-index.json');
    put(join(candidate('workspace'), stuck), 'stuck journal');
    put(join(candidate('workspace'), moved), 'moved index');
    put(join(candidate('legacy'), 'late.json'), 'late tabs');
    const rename = fsPromises.rename;
    const fault = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        if (
          source === join(candidate('workspace'), stuck) ||
          source === join(candidate('legacy'), 'late.json')
        )
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return rename(source, destination);
      });
    await expectUnqualified();
    const markers = (): unknown =>
      JSON.parse(readFileSync(join(root, 'migrations.json'), 'utf8'));
    // One faulting entry neither strands its siblings nor blocks startup.
    expect(readFileSync(join(candidate('app'), moved), 'utf8')).toBe(
      'moved index',
    );
    expect(markers()).toMatchObject({ app_advisor_home: true });
    expect(markers()).not.toHaveProperty('app_workspaces');
    expect(markers()).not.toHaveProperty('code_review_chats_app_workspace');
    fault.mockRestore();
    await expectUnqualified();
    expect(readFileSync(join(candidate('app'), stuck), 'utf8')).toBe(
      'stuck journal',
    );
    expect(
      readFileSync(join(candidate('app'), 'chats', 'late.json'), 'utf8'),
    ).toBe('late tabs');
    expect(markers()).toMatchObject({
      app_workspaces: true,
      code_review_chats_app_workspace: true,
    });
  });

  it('finishes a predecessor scope a fault left half moved before recording its move', async () => {
    registryAt('app', { [key]: owner });
    registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
    const tabs = join('chats', 'split.json');
    const journal = join('chat-journals', 'split.jsonl');
    put(join(candidate('workspace'), tabs), 'split tabs');
    put(join(candidate('workspace'), journal), 'split journal');
    // A scope the destination already held stays divergent.
    put(join(candidate('app'), 'chats', 'held.json'), 'fresh tabs');
    put(join(candidate('workspace'), 'chat-journals', 'held.jsonl'), 'old');
    const rename = fsPromises.rename;
    const fault = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        if (source === join(candidate('workspace'), journal))
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return rename(source, destination);
      });
    const markers = (): unknown =>
      JSON.parse(readFileSync(join(root, 'migrations.json'), 'utf8'));
    await expectUnqualified();
    expect(readFileSync(join(candidate('app'), tabs), 'utf8')).toBe(
      'split tabs',
    );
    // The moved tabs file is not proof the whole scope moved.
    await expectUnqualified();
    expect(existsSync(join(candidate('workspace'), journal))).toBe(true);
    expect(markers()).not.toHaveProperty('app_workspaces');
    fault.mockRestore();
    await expectUnqualified();
    expect(readFileSync(join(candidate('app'), journal), 'utf8')).toBe(
      'split journal',
    );
    expect(markers()).toMatchObject({ app_workspaces: true });
    expect(
      readFileSync(
        join(candidate('workspace'), 'chat-journals', 'held.jsonl'),
        'utf8',
      ),
    ).toBe('old');
    expect(
      existsSync(join(candidate('app'), 'chat-journals', 'held.jsonl')),
    ).toBe(false);
  });

  it('keeps a split scope unrecorded while a user write displaces its leftover', async () => {
    registryAt('app', { [key]: owner });
    registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
    const journal = join('chat-journals', 'split.jsonl');
    put(join(candidate('workspace'), 'chats', 'split.json'), 'split tabs');
    put(join(candidate('workspace'), journal), 'old journal');
    const rename = fsPromises.rename;
    const fault = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        if (source === join(candidate('workspace'), journal))
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return rename(source, destination);
      });
    await expectUnqualified();
    fault.mockRestore();
    put(join(candidate('app'), journal), 'new journal');
    await expectUnqualified();
    expect(readFileSync(join(candidate('app'), journal), 'utf8')).toBe(
      'new journal',
    );
    expect(readFileSync(join(candidate('workspace'), journal), 'utf8')).toBe(
      'old journal',
    );
    expect(
      JSON.parse(readFileSync(join(root, 'migrations.json'), 'utf8')),
    ).not.toHaveProperty('app_workspaces');
  });

  it('never moves a V2 store ahead of its manifest after failed startup qualification', async () => {
    await seedPredecessorScope();
    registryAt('app', { [key]: owner });
    registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
    const manifest = join('chat-storage-manifests', `${key}.json`);
    const store = join('chat-storage-v2', key);
    const rename = fsPromises.rename;
    const fault = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        if (source === join(candidate('workspace'), manifest))
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return rename(source, destination);
      });
    await expectUnqualified();
    // Alone, the store would read as V1 and a cold load would delete it.
    expect(existsSync(join(candidate('app'), store))).toBe(false);
    expect(existsSync(join(candidate('workspace'), manifest))).toBe(true);
    expect(existsSync(join(candidate('workspace'), store))).toBe(true);
    fault.mockRestore();
    await expectUnqualified();
    expect(existsSync(join(candidate('workspace'), store))).toBe(false);
    expect(await coldChat()).toEqual({
      title: predecessorTitle,
      message: 'm1',
    });
  });

  it('keeps a split scope unrecorded once a cold load creates the rest of it', async () => {
    registryAt('app', { [key]: owner });
    registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
    const split = {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'split',
    };
    const tabs = join('chats', 'split.json');
    put(join(candidate('workspace'), 'attachments', 'split', 'a.txt'), 'file');
    put(join(candidate('workspace'), tabs), 'predecessor tabs');
    const rename = fsPromises.rename;
    const fault = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        if (source === join(candidate('workspace'), tabs))
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return rename(source, destination);
      });
    await expectUnqualified();
    fault.mockRestore();
    expect(
      readFileSync(
        join(candidate('app'), 'attachments', 'split', 'a.txt'),
        'utf8',
      ),
    ).toBe('file');
    // The half-moved V1 scope reads as empty and migrates to V2.
    const repository = new ChatStateV2Repository();
    try {
      await repository.getState(split);
    } finally {
      await repository.drainAll();
    }
    expect(
      existsSync(
        join(candidate('app'), 'chat-storage-manifests', 'split.json'),
      ),
    ).toBe(true);
    await expectUnqualified();
    // Moving the tabs beside that manifest would hide them; they stay counted.
    expect(readFileSync(join(candidate('workspace'), tabs), 'utf8')).toBe(
      'predecessor tabs',
    );
    expect(existsSync(join(candidate('app'), tabs))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(root, 'migrations.json'), 'utf8')),
    ).not.toHaveProperty('app_workspaces');
    expect(
      existsSync(
        join(
          root,
          '.code-review-namespace-custody',
          'adopting-workspace-tree.json',
        ),
      ),
    ).toBe(true);
  });

  it.each([2, 3, 4])(
    'retains supported manifest-%s predecessor authority verbatim',
    async (version) => {
      const raw = JSON.stringify({
        version,
        scopeId: key,
        migrationId: 'predecessor',
        sourceRevision: 0,
        sourceDigest: 'a'.repeat(64),
        cleanupComplete: version !== 2,
        ...(version === 3 ? { journal: 'chat-delta-journal-v1' } : {}),
        ...(version === 2 ? { extension: 'retain unknown V2 fields' } : {}),
      });
      const relative = join('chat-storage-manifests', `${key}.json`);
      put(join(candidate('workspace'), relative), raw);
      await migrateAppManagedChatWorkspaces();
      expect(readFileSync(join(candidate('app'), relative), 'utf8')).toBe(raw);
      expect(existsSync(candidate('workspace'))).toBe(false);
    },
  );

  it.each(['mismatched-scope', 'malformed', 'unsupported'])(
    'preserves %s predecessor manifests and fails qualification',
    async (invalid) => {
      const raw = JSON.stringify({
        version: invalid === 'unsupported' ? 5 : 2,
        scopeId: invalid === 'mismatched-scope' ? 'other' : key,
        migrationId: 'predecessor',
        sourceRevision: 0,
        sourceDigest: invalid === 'malformed' ? 'invalid' : 'a'.repeat(64),
        cleanupComplete: false,
      });
      const source = join(
        candidate('workspace'),
        'chat-storage-manifests',
        `${key}.json`,
      );
      put(source, raw);
      await expectUnqualified();
      expect(readFileSync(source, 'utf8')).toBe(raw);
      expect(existsSync(candidate('app'))).toBe(false);
    },
  );

  it.each(['absent', 'completed'])(
    'qualifies steady state without reading chat bytes with %s custody',
    async (custody) => {
      registryAt('app', { [key]: owner });
      put(
        join(
          candidate('app'),
          'chat-storage-v2',
          key,
          'transcripts',
          'chat.jsonl',
        ),
        'resident chat history',
      );
      if (custody === 'completed')
        put(
          join(
            root,
            '.code-review-namespace-custody',
            'completed-prior',
            'before',
            'history',
          ),
          'retained history',
        );
      const reads = jest.spyOn(fsPromises, 'readFile');
      const walks = jest.spyOn(fsPromises, 'readdir');
      await migrateAppManagedChatWorkspaces();
      const destination = candidate('app');
      expect(
        reads.mock.calls.filter(
          ([path]) => typeof path === 'string' && path.startsWith(destination),
        ),
      ).toEqual([]);
      expect(
        walks.mock.calls.filter(
          ([path]) => typeof path === 'string' && path.startsWith(destination),
        ),
      ).toEqual([]);
      expect(await getCodeReviewTarget(key)).toEqual(owner);
    },
  );

  it.each(['pending', 'preparing-interrupted'])(
    'does not take the structural-only path with %s custody and absent sources',
    async (evidence) => {
      const path = registryAt('app', { [key]: owner });
      writeFileSync(path, '{');
      const custody = join(root, '.code-review-namespace-custody');
      for (const name of ['before', 'source-0', 'source-1'])
        mkdirSync(join(custody, evidence, name), {
          recursive: true,
        });
      if (evidence === 'pending') {
        // Forward replay has nothing to add, so it completes and keeps its
        // frozen images; an unreadable live file is not its to judge.
        await migrateAppManagedChatWorkspaces();
        expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
        const [completed] = readdirSync(custody);
        expect(completed).toMatch(/^completed-/);
        expect(readdirSync(join(custody, completed)).sort()).toEqual([
          'before',
          'source-0',
          'source-1',
        ]);
      } else await expectUnqualified();
      expect(readFileSync(path, 'utf8')).toBe('{');
    },
  );

  it('checks indexed routing without traversing destination history in steady state', async () => {
    put(
      w5RecordReadPaths.index(),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: CODE_REVIEW_CHAT_PROJECT_ID,
            type: 'single-repo',
            name: 'Real sentinel',
            color: 'blue',
          },
        ],
      }),
    );
    registryAt('workspace', { [key]: owner });
    const reads = jest.spyOn(fsPromises, 'readFile');
    const walks = jest.spyOn(fsPromises, 'readdir');
    await expectUnqualified();
    registerWorkspaceTypes(
      new Map([[CODE_REVIEW_CHAT_PROJECT_ID, 'single-repo']]),
    );
    await migrateAppManagedChatWorkspaces();
    const destination = candidate('workspace');
    expect(
      reads.mock.calls.filter(
        ([path]) => typeof path === 'string' && path.startsWith(destination),
      ),
    ).toEqual([]);
    expect(
      walks.mock.calls.filter(
        ([path]) => typeof path === 'string' && path.startsWith(destination),
      ),
    ).toEqual([]);
    expect(
      reads.mock.calls.some(([path]) => path === w5RecordReadPaths.index()),
    ).toBe(true);
  });

  it.each(['file', 'link'])(
    'does not qualify a %s destination root even without predecessors or custody',
    async (kind) => {
      if (kind === 'file') put(candidate('app'), 'not a directory');
      else {
        mkdirSync(join(root, 'app-workspaces'), { recursive: true });
        symlinkSync(join(root, 'missing-target'), candidate('app'), 'dir');
      }
      await expectUnqualified();
    },
  );

  it.each(['changed', 'unreadable'])(
    'finishes a retired transaction when a write after its verified publication is %s',
    async (later) => {
      const path = registryAt('app', { [key]: owner });
      const raw = readFileSync(path, 'utf8');
      const pending = join(root, '.code-review-namespace-custody', 'pending');
      for (const name of ['before', 'source-0', 'source-1', 'retired-0'])
        mkdirSync(join(pending, name), { recursive: true });
      for (const name of ['source-0', 'retired-0']) {
        put(join(pending, name, 'registry.json'), raw);
        put(join(pending, name, `${key}.json`), 'published history');
      }
      // A Code Review write after verification, before the retirement finished.
      const chat = join(candidate('app'), 'chats', `${key}.json`);
      put(chat, 'later history');
      const read = fsPromises.readFile;
      const reads = jest
        .spyOn(fsPromises, 'readFile')
        .mockImplementation(async (file, options) => {
          // The comparison only warns, so a read error must not keep `pending`.
          if (later === 'unreadable' && file === chat)
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return read(file, options);
        });
      await migrateAppManagedChatWorkspaces();
      // The comparison stops at the first unreadable path.
      if (later === 'changed')
        expect(reads.mock.calls.some(([file]) => file === path)).toBe(true);
      expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
      expect(existsSync(pending)).toBe(false);
      const custody = join(root, '.code-review-namespace-custody');
      expect(
        readdirSync(custody).some((name) => name.startsWith('completed-')),
      ).toBe(true);
      reads.mockRestore();
      expect(readFileSync(path, 'utf8')).toBe(raw);
      expect(readFileSync(chat, 'utf8')).toBe('later history');
    },
  );

  it('reconciles missing, identical and disjoint namespaces, retaining raw predecessor evidence', async () => {
    const first = registryAt('legacy', { [key]: { ...owner, custom: 'keep' } });
    const raw = readFileSync(first, 'utf8');
    registryAt('app', { [key]: { ...owner, custom: 'keep' } });
    registryAt('workspace', { other: { projectId: 'other', worktreeId: 'w' } });
    put(
      join(candidate('legacy'), `${key}.json`),
      'identical legacy chat bytes',
    );
    put(
      join(candidate('app'), 'chats', `${key}.json`),
      'identical legacy chat bytes',
    );
    put(
      join(candidate('workspace'), 'chat-journals', 'other.jsonl'),
      'other history',
    );
    // Old permissive markers do not qualify or skip these candidates.
    put(
      join(root, 'migrations.json'),
      JSON.stringify({
        version: 1,
        app_workspaces: true,
        code_review_chats_app_workspace: true,
      }),
    );
    await migrateAppManagedChatWorkspaces();
    expect(await listCodeReviewTargets()).toEqual({
      [key]: { ...owner, custom: 'keep' },
      other: { projectId: 'other', worktreeId: 'w' },
    });
    expect(
      readFileSync(
        join(candidate('app'), 'chat-journals', 'other.jsonl'),
        'utf8',
      ),
    ).toBe('other history');
    expect(existsSync(candidate('legacy'))).toBe(false);
    expect(existsSync(candidate('workspace'))).toBe(false);
    const custody = join(root, '.code-review-namespace-custody');
    const completed = readdirSync(custody).find((name) =>
      name.startsWith('completed-'),
    );
    expect(completed).toBeDefined();
    if (completed === undefined) throw new Error('Missing custody evidence');
    expect(
      readFileSync(
        join(custody, completed, 'retired-0', 'registry.json'),
        'utf8',
      ),
    ).toBe(raw);
    await registerCodeReviewTarget('new-key', owner);
    await migrateAppManagedChatWorkspaces();
    expect(await getCodeReviewTarget('new-key')).toEqual(owner);
  });

  it('persists nested review writes and admits lifecycle callbacks after one second of pending qualification, including a startup retry', async () => {
    const { setCodeReviewArmed } =
      await import('../lib/code-review-persistence');
    const predecessor = join(candidate('legacy'), 'migrating-chat.json');
    const destination = join(candidate('app'), 'chats', 'migrating-chat.json');
    const chatBytes = JSON.stringify({ version: 1, tabs: [] });
    put(predecessor, chatBytes);
    const publish = atomic.writeFileAtomically;
    const entered = gate();
    const pending = gate();
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        if (path === destination) {
          entered.release();
          await pending.promise;
        }
        await publish(path, data, options);
      });
    const warn = jest
      .spyOn(mainProcessLogging, 'logMainProcessWarn')
      .mockImplementation(() => undefined);
    const qualification = ensureCodeReviewNamespaceQualification(true);
    await entered.promise;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const admitted = jest.fn(() => Promise.resolve('admitted'));
    const lifecycle = withCodeReviewTargetLifecycle(
      getCodeReviewRegistryFilePath(),
      key,
      admitted,
    );
    // The scheduler wraps persistence in another review task too.
    const write = runCodeReviewTask(
      owner,
      () => setCodeReviewArmed(owner.projectId, owner.worktreeId),
      () => Promise.reject(new Error('unexpected stopped scope')),
    );
    const statePath = getCodeReviewStateFilePath(
      owner.projectId,
      owner.worktreeId,
    );
    let retry:
      | ReturnType<typeof ensureCodeReviewNamespaceQualification>
      | undefined;
    try {
      await jest.advanceTimersByTimeAsync(500);
      retry = ensureCodeReviewNamespaceQualification(true);
      await jest.advanceTimersByTimeAsync(499);
      expect(admitted).not.toHaveBeenCalled();
      expect(existsSync(statePath)).toBe(false);
      expect(warn).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      // Assert admission before awaiting I/O: on base this fails, not hangs.
      expect(admitted).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      await expect(lifecycle).resolves.toBe('admitted');
      await expect(write).resolves.toMatchObject({ armed: true });
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        armed: true,
      });
      expect(getCodeReviewNamespaceGuardrail().qualified).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('namespace qualification still pending'),
        { waitMs: 1_000 },
      );
      // Later admissions share the expired deadline, not another full second.
      await expect(
        setCodeReviewArmed(owner.projectId, owner.worktreeId),
      ).resolves.toMatchObject({ armed: true });
      await withCodeReviewTargetLifecycle(
        getCodeReviewRegistryFilePath(),
        key,
        admitted,
      );
      expect(admitted).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      pending.release();
      await Promise.allSettled([qualification, retry, lifecycle, write]);
    }
    expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
    expect(readFileSync(destination, 'utf8')).toBe(chatBytes);
    expect(existsSync(predecessor)).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      armed: true,
    });
  });

  it('recovers a predecessor retiring row on the first registration admitted after the qualification timeout', async () => {
    registryAt('legacy', {
      [key]: { ...owner, incarnation: 'old-process', state: 'retiring' },
    });
    registryAt('app', {});
    const path = getCodeReviewRegistryFilePath();
    const attachment = join(
      getWorktreeAttachmentsDir(scope.projectId, key),
      'old.txt',
    );
    put(attachment, 'retired attachment');
    const entered = gate();
    const pending = gate();
    const publish = atomic.writeFileAtomically;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (file, data, options) => {
        if (file === path) {
          entered.release();
          await pending.promise;
        }
        await publish(file, data, options);
      });
    const warn = jest
      .spyOn(mainProcessLogging, 'logMainProcessWarn')
      .mockImplementation(() => undefined);
    const qualification = ensureCodeReviewNamespaceQualification(true);
    await entered.promise;
    expect(await getCodeReviewTarget(key)).toBeNull();
    const read = fsPromises.readFile;
    const prePublicationReads: Promise<unknown>[] = [];
    let published = false;
    jest.spyOn(fsPromises, 'readFile').mockImplementation((file, options) => {
      const reading = read(file, options);
      if (file === path && !published)
        prePublicationReads.push(reading.catch(() => undefined));
      return reading;
    });
    let recovered = 0;
    teardown = async (): Promise<void> => {
      recovered++;
      expect(existsSync(attachment)).toBe(true);
      // Recovery must not hold the global mutation queue across teardown.
      await registerCodeReviewTarget('unrelated', owner);
    };
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const registration = registerCodeReviewTarget(key, owner);
    const registrationResult = registration.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await jest.advanceTimersByTimeAsync(1_000);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('namespace qualification still pending'),
        { waitMs: 1_000 },
      );
      expect(recovered).toBe(0);
      // Finish any early snapshot before letting the registry merge publish.
      await Promise.all(prePublicationReads);
      jest.useRealTimers();
      published = true;
      pending.release();
      await qualification;
      expect(await registrationResult).toBeUndefined();
      expect(recovered).toBe(1);
      const recoveredTarget = (await listCodeReviewTargets())[key];
      expect(recoveredTarget).toMatchObject({
        ...owner,
        state: 'active',
      });
      expect(typeof recoveredTarget.incarnation).toBe('string');
      expect(recoveredTarget.incarnation).toBeTruthy();
      expect(recoveredTarget.incarnation).not.toBe('old-process');
      expect(await getCodeReviewTarget(key)).toEqual(owner);
      expect(await getCodeReviewTarget('unrelated')).toEqual(owner);
      expect(existsSync(attachment)).toBe(false);
    } finally {
      jest.useRealTimers();
      pending.release();
      await Promise.allSettled([qualification, registration]);
    }
  });

  it.each(['success', 'failure'] as const)(
    'keeps review writes and lifecycle callbacks waiting for in-time qualification (%s)',
    async (outcome) => {
      const reconciliation =
        await import('../lib/code-review-namespace-reconciliation');
      const { setCodeReviewArmed } =
        await import('../lib/code-review-persistence');
      const reconcile = reconciliation.reconcileCodeReviewNamespaces;
      const entered = gate();
      const pending = gate();
      jest
        .spyOn(reconciliation, 'reconcileCodeReviewNamespaces')
        .mockImplementation(async () => {
          entered.release();
          await pending.promise;
          if (outcome === 'failure') throw new Error('qualification fault');
          await reconcile();
        });
      const warn = jest
        .spyOn(mainProcessLogging, 'logMainProcessWarn')
        .mockImplementation(() => undefined);
      const qualification = ensureCodeReviewNamespaceQualification(true);
      await entered.promise;
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      const admitted = jest.fn(() => Promise.resolve('admitted'));
      const lifecycle = withCodeReviewTargetLifecycle(
        getCodeReviewRegistryFilePath(),
        key,
        admitted,
      );
      const write = setCodeReviewArmed(owner.projectId, owner.worktreeId);
      const statePath = getCodeReviewStateFilePath(
        owner.projectId,
        owner.worktreeId,
      );
      try {
        await jest.advanceTimersByTimeAsync(999);
        expect(admitted).not.toHaveBeenCalled();
        expect(existsSync(statePath)).toBe(false);
        pending.release();
        await qualification;
        await expect(lifecycle).resolves.toBe('admitted');
        await expect(write).resolves.toMatchObject({ armed: true });
        expect(admitted).toHaveBeenCalledTimes(1);
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
          armed: true,
        });
        await jest.advanceTimersByTimeAsync(1_001);
        expect(
          warn.mock.calls.some(([line]) => line.includes('still pending')),
        ).toBe(false);
        expect(getCodeReviewNamespaceGuardrail()).toMatchObject(
          outcome === 'success'
            ? { qualified: true, proceeded: [] }
            : {
                qualified: false,
                failure: { code: 'code_review_namespace_unqualified' },
                proceeded: ['mutation'],
              },
        );
      } finally {
        jest.useRealTimers();
        pending.release();
        await Promise.allSettled([qualification, lifecycle, write]);
      }
    },
  );

  it('holds a registration waiting on in-flight qualification until the startup retry publishes', async () => {
    const reconciliation =
      await import('../lib/code-review-namespace-reconciliation');
    const admission = await import('../lib/code-review-storage-admission');
    const reconcile = reconciliation.reconcileCodeReviewNamespaces;
    const lifecycle = admission.withCodeReviewTargetLifecycle;
    registryAt('app', { base: owner });
    const predecessor = { projectId: 'predecessor', worktreeId: 'w' };
    const firstAttempt = gate();
    let calls = 0;
    let reconciling = false;
    let registering = false;
    let overlapped = false;
    jest
      .spyOn(reconciliation, 'reconcileCodeReviewNamespaces')
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) await firstAttempt.promise;
        // The retry finds a predecessor, so it captures and publishes a union.
        else registryAt('legacy', { predecessor });
        overlapped ||= registering;
        reconciling = true;
        try {
          await reconcile();
        } finally {
          overlapped ||= registering;
          reconciling = false;
        }
      });
    jest
      .spyOn(admission, 'withCodeReviewTargetLifecycle')
      .mockImplementation((path, scopeKey, operation) =>
        lifecycle(path, scopeKey, async (waited) => {
          overlapped ||= reconciling;
          registering = true;
          try {
            return await operation(waited);
          } finally {
            registering = false;
          }
        }),
      );
    const inFlight = migrateAppManagedChatWorkspaces();
    const registration = registerCodeReviewTarget('new', owner);
    const retry = migrateAppManagedChatWorkspaces();
    // A lazy qualification after the reservation joins the retry.
    const lazy = ensureCodeReviewNamespaceQualification();
    firstAttempt.release();
    await Promise.all([inFlight, registration, retry, lazy]);
    expect(calls).toBe(2);
    expect(overlapped).toBe(false);
    expect(getCodeReviewNamespaceGuardrail()).toEqual({
      qualified: true,
      proceeded: [],
    });
    const targets = await listCodeReviewTargets();
    expect(Object.keys(targets).sort()).toEqual(['base', 'new', 'predecessor']);
    expect(targets.base).toEqual(owner);
    expect(targets.predecessor).toEqual(predecessor);
    expect(await getCodeReviewTarget('new')).toEqual(owner);
  });

  it('keeps a registration admitted before the startup retry when reconciliation republishes the registry', async () => {
    const admission = await import('../lib/code-review-storage-admission');
    const lifecycle = admission.withCodeReviewTargetLifecycle;
    const write = atomic.writeFileAtomically;
    const appRegistry = registryAt('app', { base: owner });
    const predecessor = { projectId: 'predecessor', worktreeId: 'w' };
    const admitted = gate();
    const proceed = gate();
    jest
      .spyOn(admission, 'withCodeReviewTargetLifecycle')
      .mockImplementation((path, scopeKey, operation) =>
        lifecycle(path, scopeKey, async (waited) => {
          admitted.release();
          await proceed.promise;
          return operation(waited);
        }),
      );
    // Already past admission on the settled lazy qualification from setup.
    const registration = registerCodeReviewTarget('new', owner);
    await admitted.promise;
    registryAt('legacy', { predecessor });
    const reads = jest.spyOn(fsPromises, 'readFile');
    const registryReads = (): Promise<unknown>[] =>
      reads.mock.calls.flatMap(([file], i) => {
        const result = reads.mock.results[i];
        return file === appRegistry && result?.type === 'return'
          ? [result.value]
          : [];
      });
    const settle = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));
    let held = false;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        if (
          !held &&
          path === appRegistry &&
          options?.admittedWriter?.module ===
            'main/lib/code-review-namespace-reconciliation'
        ) {
          held = true;
          const prior = registryReads().length;
          proceed.release();
          await settle();
          // Drain a pre-publication ownership read, if one was started.
          await registryReads()[prior];
          await settle();
          // Its queued read started only if mutations were not held; then it
          // commits before this publish and would be overwritten.
          if (registryReads().length > prior + 1) await registration;
        }
        return write(path, data, options);
      });
    await migrateAppManagedChatWorkspaces();
    proceed.release();
    await registration;
    expect(held).toBe(true);
    expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
    const targets = await listCodeReviewTargets();
    expect(Object.keys(targets).sort()).toEqual(['base', 'new', 'predecessor']);
    expect(targets.predecessor).toEqual(predecessor);
  });

  it.each(['chats', 'chat-storage-v2', 'chat-journals'])(
    'does not merge divergent %s authority despite identical registry ownership, and later effects proceed',
    async (family) => {
      const path = registryAt('app', { [key]: owner });
      registryAt('workspace', { [key]: owner });
      const tail =
        family === 'chat-storage-v2' ? `${key}/live-index.json` : `${key}.json`;
      put(join(candidate('app'), family, tail), 'first history');
      put(join(candidate('workspace'), family, tail), 'second history');
      const predecessor = join(
        candidate('workspace'),
        'chats',
        'registry.json',
      );
      const raw = readFileSync(path, 'utf8');
      const predecessorRaw = readFileSync(predecessor, 'utf8');
      await expectUnqualified();
      expect(readFileSync(path, 'utf8')).toBe(raw);
      // Effects proceed on the routed app-managed root, as before reconciliation.
      await registerCodeReviewTarget('late', owner);
      expect(await getCodeReviewTarget('late')).toEqual(owner);
      const late = {
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'late',
      };
      await fixture.createChat(late);
      const { setCodeReviewArmed } =
        await import('../lib/code-review-persistence');
      await setCodeReviewArmed(owner.projectId, owner.worktreeId);
      let cleaned = false;
      await fixture.service.runWithScopeDeletionLifecycle(late, () => {
        cleaned = true;
        return Promise.resolve();
      });
      expect(cleaned).toBe(true);
      // Only the fixture's unparseable history may fail its own retirement.
      const warnings = await removeCodeReviewChatsForWorktree(
        owner.projectId,
        owner.worktreeId,
      );
      expect(warnings.filter((warning) => !warning.includes(key))).toEqual([]);
      expect(Object.keys(await listCodeReviewTargets())).not.toContain('late');
      // The unmerged predecessor keeps its bytes and is never retired.
      expect(readFileSync(predecessor, 'utf8')).toBe(predecessorRaw);
      expect(
        readFileSync(join(candidate('workspace'), family, tail), 'utf8'),
      ).toBe('second history');
      expect(existsSync(join(root, '.code-review-namespace-custody'))).toBe(
        false,
      );
      expect(getCodeReviewNamespaceGuardrail().proceeded).toEqual(
        expect.arrayContaining(['cleanup', 'cold_load', 'mutation']),
      );
    },
  );

  it('qualifies a root before its first cold canonical read and reads it even when qualification fails', async () => {
    const qualifiedRoot = root;
    const otherRoot = join(root, 'other-root');
    const source = join(otherRoot, 'code-review-chats', 'registry.json');
    put(source, '{');
    process.env.CANOPY_DATA_DIR = otherRoot;
    try {
      expect((await fixture.service.getState(scope)).tabsFile.tabs).toEqual([]);
      const guardrail = getCodeReviewNamespaceGuardrail();
      expect(guardrail).toMatchObject({
        qualified: false,
        failure: { code: 'code_review_namespace_unqualified' },
      });
      expect(guardrail.proceeded).toContain('cold_load');
      expect(readFileSync(source, 'utf8')).toBe('{');
    } finally {
      process.env.CANOPY_DATA_DIR = qualifiedRoot;
    }
  });

  it('completes a cold load that overlaps a failed requalification, keeping predecessor bytes', async () => {
    const checking = gate();
    const checked = gate();
    const repository = new ChatStateV2Repository({
      hasLiveDependency: async (): Promise<boolean> => {
        checking.release();
        await checked.promise;
        return false;
      },
    });
    const loading = repository.getState(scope);
    void loading.catch(() => undefined);
    try {
      await checking.promise;
      const path = registryAt('app', { [key]: owner });
      registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
      const raw = readFileSync(path, 'utf8');
      const legacyRaw = readFileSync(
        join(candidate('legacy'), 'registry.json'),
        'utf8',
      );
      await expectUnqualified();
      checked.release();
      expect((await loading).tabsFile.tabs).toEqual([]);
      expect(existsSync(join(candidate('app'), 'chat-storage-v2'))).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(raw);
      expect(
        readFileSync(join(candidate('legacy'), 'registry.json'), 'utf8'),
      ).toBe(legacyRaw);
      expect((await repository.getState(scope)).tabsFile.tabs).toEqual([]);
      // Operator resolution followed by startup retry qualifies again.
      rmSync(candidate('legacy'), { recursive: true, force: true });
      await migrateAppManagedChatWorkspaces();
      expect(getCodeReviewNamespaceGuardrail()).toEqual({
        qualified: true,
        proceeded: [],
      });
    } finally {
      checked.release();
      await loading.catch(() => undefined);
      await repository.drainAll();
    }
  });

  it('promotes on readiness after failed qualification and keeps predecessor bytes', async () => {
    let promote = false;
    const repository = new ChatStateV2Repository({
      enableFormat4: true,
      format4Promotion: (): boolean => promote,
    });
    try {
      await repository.getState(scope);
      const manifest = join(
        candidate('app'),
        'chat-storage-manifests',
        `${key}.json`,
      );
      const before = readFileSync(manifest, 'utf8');
      expect(JSON.parse(before)).toMatchObject({ version: 3 });
      registryAt('app', { [key]: owner });
      const legacy = registryAt('legacy', {
        [key]: { ...owner, projectId: 'different' },
      });
      const legacyRaw = readFileSync(legacy, 'utf8');
      await expectUnqualified();
      expect((await repository.getState(scope)).tabsFile.tabs).toEqual([]);
      await expect(repository.generationStoreReadiness(scope)).resolves.toEqual(
        {
          formatVersion: 3,
          enableFormat4: true,
          promotes: false,
        },
      );
      expect(readFileSync(manifest, 'utf8')).toBe(before);
      promote = true;
      await expect(repository.generationStoreReadiness(scope)).resolves.toEqual(
        {
          formatVersion: 4,
          enableFormat4: true,
          promotes: false,
        },
      );
      expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({
        version: 4,
      });
      expect(repository.getLifecycle(scope)).toBe('ready');
      expect(readFileSync(legacy, 'utf8')).toBe(legacyRaw);
      expect(getCodeReviewNamespaceGuardrail().proceeded).toContain(
        'promotion',
      );
    } finally {
      await repository.drainAll();
    }
  });

  it.each([
    [false, 'flush'],
    [true, 'flush'],
    [false, 'evict'],
    [true, 'evict'],
    [false, 'drain'],
    [true, 'drain'],
  ] as const)(
    'persists accepted resident metadata and accepts new writes after failed qualification (format4=%s, %s)',
    async (enableFormat4, persistence) => {
      const repository = new ChatStateV2Repository({
        enableFormat4,
        deltaJournalIdleCheckpointMs: 60_000,
        idleScopeUnloadMs: 0,
      });
      try {
        await repository.transact(
          scope,
          [
            {
              type: 'tab.created',
              tab: {
                id: 'chat-1',
                title: 'Original',
                createdAt: '2026-11-17',
                messages: [],
              },
            },
          ],
          { source: 'renderer-command' },
        );
        const index = join(
          candidate('app'),
          'chat-storage-v2',
          key,
          'live-index.json',
        );
        const before = readFileSync(index, 'utf8');
        await repository.transact(
          scope,
          [
            {
              type: 'tab.metadata_patched',
              tabId: 'chat-1',
              patch: { title: 'Accepted before failure' },
            },
          ],
          { source: 'renderer-command' },
        );
        // The accepted metadata remains journal-only until persistence below.
        expect(readFileSync(index, 'utf8')).toBe(before);
        expect((await repository.getState(scope)).tabsFile.tabs[0]?.title).toBe(
          'Accepted before failure',
        );
        registryAt('app', { [key]: owner });
        registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
        await expectUnqualified();
        await repository.transact(
          scope,
          [
            {
              type: 'tab.metadata_patched',
              tabId: 'chat-1',
              patch: { title: 'Accepted after failure' },
            },
          ],
          { source: 'renderer-command' },
        );
        if (persistence === 'flush') await repository.flushScope(scope);
        else if (persistence === 'evict')
          expect(await repository.evictScope(scope)).toBe(true);
        else await repository.drainAll();
        expect(JSON.parse(readFileSync(index, 'utf8'))).toMatchObject({
          tabs: [{ title: 'Accepted after failure' }],
        });
        const cold = new ChatStateV2Repository({ enableFormat4 });
        try {
          await expect(cold.flushScope(scope)).resolves.toBeUndefined();
          expect((await cold.getState(scope)).tabsFile.tabs[0]?.title).toBe(
            'Accepted after failure',
          );
        } finally {
          await cold.drainAll();
        }
      } finally {
        await repository.drainAll();
      }
    },
  );

  const child = {
    kind: 'delegation' as const,
    chatId: 'chat-1',
    delegationId: 'delegate',
    runGeneration: 1,
  };
  const childRow = (
    sequence: number,
  ): Parameters<ChatStateV2Repository['commitChildStream']>[3][number] => ({
    ...message(`delegate-item-${sequence}`, `Child row ${sequence}`),
    parentBlockId: 'agent-delegate',
    delegationSequence: sequence,
    itemRevision: 0,
    final: true,
  });
  const checkpointLeftover = (): string =>
    join(
      candidate('app'),
      'chat-storage-v2',
      key,
      DELTA_CHECKPOINT_MARKER_NAME,
    );
  /** Seeds the sentinel scope as format 4 without a journal; returns its manifest. */
  async function seedCheckpointOnlyScope(): Promise<string> {
    const manifest = join(
      candidate('app'),
      'chat-storage-manifests',
      `${key}.json`,
    );
    // Only capture publishes a format 4 manifest without a journal.
    const source = {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'review-project--capture-source',
    };
    const seeder = new ChatStateV2Repository({ enableFormat4: true });
    try {
      await seeder.transact(
        source,
        [
          {
            type: 'tab.created',
            tab: {
              id: 'chat-1',
              title: 'Review',
              createdAt: '2026-11-17',
              messages: [message('initial', 'Initial', 'user')],
            },
          },
        ],
        { source: 'renderer-command' },
      );
      await seeder.generationStoreReadiness(source);
      await seeder.openChildStream(source, child);
      await seeder.commitChildStream(source, child, 'row-1', [childRow(1)]);
      await seeder.captureScope(
        source,
        new ChatStorageV2(candidate('app'), key),
      );
    } finally {
      await seeder.drainAll();
    }
    const checkpointed = readFileSync(manifest, 'utf8');
    expect(JSON.parse(checkpointed)).toMatchObject({ version: 4 });
    expect(JSON.parse(checkpointed)).not.toHaveProperty('journal');
    return manifest;
  }

  it('keeps checkpoint-only child reads, cold reads and child writes available after failed qualification', async () => {
    const manifest = await seedCheckpointOnlyScope();
    const checkpointed = readFileSync(manifest, 'utf8');
    const repository = new ChatStateV2Repository({ enableFormat4: true });
    try {
      const pageRequest = {
        chatId: 'chat-1',
        delegationId: 'delegate',
        limit: 10,
      };
      const descriptor = await repository.getChildStreamState(scope, child);
      expect(descriptor).toBeDefined();
      const results = await repository.resultsPage(scope, pageRequest);
      const documents = await repository.listChildSearchDocuments(
        scope,
        'chat-1',
      );
      registryAt('app', { [key]: owner });
      registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
      await expectUnqualified();
      await expect(
        repository.getChildStreamState(scope, child),
      ).resolves.toEqual(descriptor);
      await expect(repository.resultsPage(scope, pageRequest)).resolves.toEqual(
        results,
      );
      await expect(
        repository.listChildSearchDocuments(scope, 'chat-1'),
      ).resolves.toEqual(documents);
      await expect(
        repository.readStoredParentMessage(scope, 'chat-1', 'initial'),
      ).resolves.toMatchObject({ id: 'initial' });
      expect(readFileSync(manifest, 'utf8')).toBe(checkpointed);
      // A rejected backend read drops its indexes, so the next read is cold.
      await expect(
        repository.getChildStreamState(scope, { ...child, chatId: 'missing' }),
      ).rejects.toThrow('outside the captured scope');
      await expect(
        repository.getChildStreamState(scope, child),
      ).resolves.toEqual(descriptor);
      const cold = new ChatStateV2Repository({ enableFormat4: true });
      try {
        await expect(cold.getChildStreamState(scope, child)).resolves.toEqual(
          descriptor,
        );
      } finally {
        await cold.drainAll();
      }
      await repository.commitChildStream(scope, child, 'row-2', [childRow(2)]);
      await expect(
        repository.openChildStream(scope, { ...child, delegationId: 'other' }),
      ).resolves.toBeDefined();
      expect(getCodeReviewNamespaceGuardrail().proceeded).toContain('mutation');
      await repository.drainAll();
      await expect(
        repository.getChildStreamState(scope, child),
      ).rejects.toThrow('Chat state repository is draining');
    } finally {
      await repository.drainAll();
    }
  });

  it.each([
    ['unqualified', false],
    ['unqualified', true],
    ['qualified', false],
  ] as const)(
    'idle unload of a %s checkpoint-only read scope (after rejection=%s) flushes as usual',
    async (qualification, rejection) => {
      await seedCheckpointOnlyScope();
      // The pin holds the real idle-unload timer until the leftover is planted.
      let pinned = true;
      const repository = new ChatStateV2Repository({
        enableFormat4: true,
        idleScopeUnloadMs: 300,
        isScopePinned: (): boolean => pinned,
      });
      const resident = (): boolean | undefined =>
        repository
          .residencySnapshot()
          .find((row) => row.scope.worktreeId === key)?.backendResident;
      try {
        await expect(
          repository.getChildStreamState(scope, child),
        ).resolves.toBeDefined();
        if (qualification === 'unqualified') {
          registryAt('app', { [key]: owner });
          registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
          await expectUnqualified();
          await expect(
            repository.getChildStreamState(scope, child),
          ).resolves.toBeDefined();
        }
        if (rejection)
          await expect(
            repository.getChildStreamState(scope, {
              ...child,
              chatId: 'missing',
            }),
          ).rejects.toThrow('outside the captured scope');
        writeFileSync(checkpointLeftover(), '{}');
        expect(resident()).toBe(true);
        pinned = false;
        for (let attempt = 0; resident() !== false; attempt += 1) {
          if (attempt === 300) throw new Error('Idle unload did not run');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(repository.getLifecycle(scope)).toBe('unloaded');
        // The guardrail does not change backend crash hygiene.
        expect(existsSync(checkpointLeftover())).toBe(false);
        await expect(
          repository.getChildStreamState(scope, child),
        ).resolves.toBeDefined();
      } finally {
        await repository.drainAll();
      }
    },
  );

  it('runs queued repromotion after failed qualification without losing accepted resident history', async () => {
    const repository = new ChatStateV2Repository({
      deltaJournalLargeRecordBytes: 1,
      idleScopeUnloadMs: 0,
    });
    const manifest = join(
      candidate('app'),
      'chat-storage-manifests',
      `${key}.json`,
    );
    try {
      await repository.transact(
        scope,
        [
          {
            type: 'tab.created',
            tab: {
              id: 'chat-1',
              title: 'Original',
              createdAt: '2026-11-17',
              messages: [],
            },
          },
        ],
        { source: 'renderer-command' },
      );
      await repository.getRevision(scope);
      expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({
        version: 3,
      });
      await repository.transactWith(
        scope,
        async () => {
          registryAt('app', { [key]: owner });
          registryAt('legacy', { [key]: { ...owner, projectId: 'different' } });
          await expectUnqualified();
          return [
            {
              type: 'message.upserted',
              chatId: 'chat-1',
              message: message(
                'accepted-message',
                'Accepted history '.repeat(256),
                'user',
              ),
            },
          ];
        },
        { source: 'renderer-command' },
      );
      // Wait behind queued reconciliation, not just the accepted transaction.
      await repository.getRevision(scope);
      expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({
        version: 3,
      });
      expect(repository.getLifecycle(scope)).toBe('ready');
      await expect(repository.flushScope(scope)).resolves.toBeUndefined();
      expect(
        (
          await repository.getState(scope, {
            chatIds: ['chat-1'],
            fullTranscript: true,
          })
        ).tabsFile.tabs[0]?.messages[0]?.id,
      ).toBe('accepted-message');
      await repository.transact(scope, [], { source: 'renderer-command' });
      expect(getCodeReviewNamespaceGuardrail().proceeded).toEqual(
        expect.arrayContaining(['mutation', 'promotion']),
      );
    } finally {
      await repository.drainAll();
    }
  });

  it('keeps canonical provider writes and repository deletion available after failed qualification', async () => {
    await fixture.createChat(scope);
    await fixture.acceptTurn(scope, 'user-1');
    const revision = await fixture.repository.getRevision(scope);
    registryAt('app', { [key]: owner });
    const legacy = registryAt('legacy', {
      [key]: { ...owner, projectId: 'different' },
    });
    const legacyRaw = readFileSync(legacy, 'utf8');
    await expectUnqualified();
    await fixture.setRuntime(scope, 'streaming', 'user-1');
    expect(await fixture.repository.getRevision(scope)).toBeGreaterThan(
      revision,
    );
    let cleaned = false;
    await fixture.repository.runWithScopeDeletion(scope, () => {
      cleaned = true;
      return Promise.resolve();
    });
    expect(cleaned).toBe(true);
    // Reaches its own emptiness precondition rather than a namespace refusal.
    await expect(fixture.repository.deleteEmptyScope(scope)).rejects.toThrow(
      'semantically empty',
    );
    expect(readFileSync(legacy, 'utf8')).toBe(legacyRaw);
    expect(getCodeReviewNamespaceGuardrail().proceeded).toEqual(
      expect.arrayContaining(['mutation', 'cleanup']),
    );
  });

  it('does not combine a scope primary with divergent fallback authority from another namespace', async () => {
    registryAt('app', { [key]: owner });
    registryAt('legacy', { [key]: owner });
    const primary = join(candidate('app'), 'chats', `${key}.json`);
    const backup = join(candidate('legacy'), `${key}.json.bak`);
    put(primary, 'current history');
    put(backup, 'different recoverable history');
    await expectUnqualified();
    expect(readFileSync(primary, 'utf8')).toBe('current history');
    expect(readFileSync(backup, 'utf8')).toBe('different recoverable history');
    expect(existsSync(join(root, '.code-review-namespace-custody'))).toBe(
      false,
    );
  });

  it.each([
    '{',
    '{"version":1,"workspaces":{}}',
    '{"version":1,"workspaces":[null]}',
    '{"version":1,"workspaces":[{"id":"other","type":"unknown"}]}',
  ])(
    'does not treat an unreadable index as an unindexed sentinel: %s',
    async (raw) => {
      const file = join(candidate('workspace'), 'real-user-file');
      put(file, 'never move');
      put(w5RecordReadPaths.index(), raw);
      await expectUnqualified();
      expect(readFileSync(file, 'utf8')).toBe('never move');
      expect(existsSync(candidate('app'))).toBe(false);
    },
  );

  it('preserves an indexed real sentinel and does not qualify incomplete routing initialization', async () => {
    put(
      w5RecordReadPaths.index(),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: CODE_REVIEW_CHAT_PROJECT_ID,
            type: 'single-repo',
            name: 'Real sentinel',
            color: 'blue',
          },
        ],
      }),
    );
    const file = join(candidate('workspace'), 'real-user-file');
    put(file, 'indexed user bytes');
    symlinkSync(
      join(root, 'unavailable-checkout'),
      join(candidate('workspace'), 'checkout'),
      'dir',
    );
    await expectUnqualified();
    expect(readFileSync(file, 'utf8')).toBe('indexed user bytes');
    registerWorkspaceTypes(
      new Map([[CODE_REVIEW_CHAT_PROJECT_ID, 'single-repo']]),
    );
    await migrateAppManagedChatWorkspaces();
    expect(readFileSync(file, 'utf8')).toBe('indexed user bytes');
    registryAt('legacy', { [key]: owner });
    await expectUnqualified();
    expect(readFileSync(file, 'utf8')).toBe('indexed user bytes');
    expect(existsSync(candidate('legacy'))).toBe(true);
  });

  it('preserves unreadable candidates, mismatched manifests and linked namespaces', async () => {
    const legacy = registryAt('legacy', { [key]: owner });
    writeFileSync(legacy, '{');
    await expectUnqualified();
    expect(readFileSync(legacy, 'utf8')).toBe('{');
    writeFileSync(
      legacy,
      JSON.stringify({ version: 1, targets: { [key]: owner } }),
    );
    put(
      join(candidate('workspace'), 'chat-storage-manifests', `${key}.json`),
      '{"version":2,"scopeId":"different"}',
    );
    await expectUnqualified();
    rmSync(candidate('workspace'), { recursive: true });
    mkdirSync(join(root, 'workspaces'), { recursive: true });
    symlinkSync(candidate('legacy'), candidate('workspace'), 'dir');
    await expectUnqualified();
    expect(existsSync(legacy)).toBe(true);
  });

  it('does not qualify on index read errors and never moves a possible real sentinel', async () => {
    put(w5RecordReadPaths.index(), '{"version":1,"workspaces":[]}');
    put(join(candidate('workspace'), 'keep'), 'real?');
    const original = fsPromises.readFile;
    jest.spyOn(fsPromises, 'readFile').mockImplementation((...args) => {
      if (args[0] === w5RecordReadPaths.index())
        return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
      return original(...args);
    });
    await expectUnqualified();
    expect(readFileSync(join(candidate('workspace'), 'keep'), 'utf8')).toBe(
      'real?',
    );
  });

  it('replays a frozen partial publication with a fresh module and retires sources only after verification', async () => {
    registryAt('workspace', { [key]: owner });
    put(
      join(candidate('workspace'), 'chat-storage-v2', key, 'live-index.json'),
      'index',
    );
    put(
      join(
        candidate('workspace'),
        'chat-storage-v2',
        key,
        'transcripts',
        'chat.json',
      ),
      'transcript',
    );
    const original = atomic.writeFileAtomically;
    let failed = false;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        if (
          !failed &&
          path ===
            join(
              candidate('app'),
              'chat-storage-v2',
              key,
              'transcripts',
              'chat.json',
            )
        ) {
          failed = true;
          throw new Error('interrupted publication');
        }
        return original(path, data, options);
      });
    await expectUnqualified();
    expect(failed).toBe(true);
    expect(
      readFileSync(
        join(
          candidate('workspace'),
          'chat-storage-v2',
          key,
          'transcripts',
          'chat.json',
        ),
        'utf8',
      ),
    ).toBe('transcript');
    expect(
      existsSync(join(root, '.code-review-namespace-custody', 'pending')),
    ).toBe(true);
    jest.restoreAllMocks();
    await jest.isolateModulesAsync(async () => {
      const fresh = await import('../lib/code-review-storage-admission');
      expect(
        await fresh.ensureCodeReviewNamespaceQualification(),
      ).toBeUndefined();
    });
    expect(
      readFileSync(
        join(
          candidate('app'),
          'chat-storage-v2',
          key,
          'transcripts',
          'chat.json',
        ),
        'utf8',
      ),
    ).toBe('transcript');
    expect(existsSync(candidate('workspace'))).toBe(false);
    expect(
      existsSync(join(root, '.code-review-namespace-custody', 'pending')),
    ).toBe(false);
  });

  it.each(['chats', 'chat-storage-manifests'])(
    'recovers abandoned publication temporaries for planned %s files into custody',
    async (family) => {
      const raw =
        family === 'chats'
          ? 'source history'
          : JSON.stringify({
              version: 3,
              scopeId: key,
              migrationId: 'predecessor',
              sourceRevision: 0,
              sourceDigest: 'a'.repeat(64),
              cleanupComplete: true,
              journal: 'chat-delta-journal-v1',
            });
      const relative = join(family, `${key}.json`);
      put(join(candidate('workspace'), relative), raw);
      const pending = join(root, '.code-review-namespace-custody', 'pending');
      for (const name of ['before', 'source-0', 'source-1'])
        mkdirSync(join(pending, name), { recursive: true });
      put(join(pending, 'source-1', relative), raw);
      const temporary = join(
        family,
        `.${key}.json.123.12345678-1234-4234-8234-123456789abc.tmp`,
      );
      const alreadyRetained = join(
        family,
        `.${key}.json.456.12345678-1234-4234-8234-123456789abc.tmp`,
      );
      put(
        join(pending, 'publication-temporaries', alreadyRetained),
        '{earlier partial',
      );
      put(join(candidate('app'), temporary), '{partial');
      await jest.isolateModulesAsync(async () => {
        const fresh = await import('../lib/code-review-storage-admission');
        expect(
          await fresh.ensureCodeReviewNamespaceQualification(),
        ).toBeUndefined();
      });
      expect(readFileSync(join(candidate('app'), relative), 'utf8')).toBe(raw);
      expect(existsSync(join(candidate('app'), temporary))).toBe(false);
      expect(existsSync(candidate('workspace'))).toBe(false);
      const custody = join(root, '.code-review-namespace-custody');
      const completed = readdirSync(custody).find((name) =>
        name.startsWith('completed-'),
      );
      if (completed === undefined) throw new Error('Missing completed custody');
      expect(
        readFileSync(
          join(custody, completed, 'publication-temporaries', temporary),
          'utf8',
        ),
      ).toBe('{partial');
      expect(
        readFileSync(
          join(custody, completed, 'publication-temporaries', alreadyRetained),
          'utf8',
        ),
      ).toBe('{earlier partial');
    },
  );

  it.each(['nested-link', 'leaf-link', 'foreign-file', 'conflicting-file'])(
    'refuses %s in retained temporary custody before changing live evidence',
    async (kind) => {
      const relative = join('chats', `${key}.json`);
      const source = join(candidate('workspace'), relative);
      put(source, 'source history');
      const pending = join(root, '.code-review-namespace-custody', 'pending');
      for (const name of ['before', 'source-0', 'source-1'])
        mkdirSync(join(pending, name), { recursive: true });
      put(join(pending, 'source-1', relative), 'source history');
      const retained = join(pending, 'publication-temporaries');
      const sibling = `.${key}.json.123.12345678-1234-4234-8234-123456789abc.tmp`;
      const temporary = join(candidate('app'), 'chats', sibling);
      put(temporary, '{partial');
      mkdirSync(retained, { recursive: true });
      if (kind === 'nested-link') {
        const unrelated = join(root, 'unrelated-storage');
        mkdirSync(unrelated);
        symlinkSync(unrelated, join(retained, 'chats'));
      } else if (kind === 'leaf-link') {
        mkdirSync(join(retained, 'chats'));
        symlinkSync(source, join(retained, 'chats', sibling));
      } else if (kind === 'conflicting-file')
        put(join(retained, 'chats', sibling), 'retained evidence');
      else put(join(retained, 'foreign'), 'unknown evidence');
      await expectUnqualified();
      expect(readFileSync(source, 'utf8')).toBe('source history');
      expect(readFileSync(temporary, 'utf8')).toBe('{partial');
      expect(existsSync(join(candidate('app'), relative))).toBe(false);
      expect(existsSync(join(root, 'unrelated-storage', sibling))).toBe(false);
      if (kind === 'conflicting-file')
        expect(readFileSync(join(retained, 'chats', sibling), 'utf8')).toBe(
          'retained evidence',
        );
    },
  );

  it.each(['unplanned', 'malformed-name', 'link', 'directory'])(
    'does not adopt %s temporary-shaped destination evidence',
    async (kind) => {
      const relative = join('chats', `${key}.json`);
      put(join(candidate('workspace'), relative), 'source history');
      const pending = join(root, '.code-review-namespace-custody', 'pending');
      for (const name of ['before', 'source-0', 'source-1'])
        mkdirSync(join(pending, name), { recursive: true });
      put(join(pending, 'source-1', relative), 'source history');
      const name = kind === 'unplanned' ? 'foreign.json' : `${key}.json`;
      const suffix =
        kind === 'malformed-name'
          ? 'not-a-uuid'
          : '12345678-1234-4234-8234-123456789abc';
      const temporary = join(
        candidate('app'),
        'chats',
        `.${name}.123.${suffix}.tmp`,
      );
      mkdirSync(dirname(temporary), { recursive: true });
      if (kind === 'link')
        symlinkSync(join(candidate('workspace'), relative), temporary);
      else if (kind === 'directory')
        put(join(temporary, 'foreign'), 'foreign history');
      else put(temporary, 'foreign history');
      if (kind === 'link') {
        await expectUnqualified();
        expect(
          readFileSync(join(candidate('workspace'), relative), 'utf8'),
        ).toBe('source history');
      } else {
        // q-34: replay abandons custody it cannot explain; the fresh
        // reconcile keeps the file as ordinary destination content.
        await migrateAppManagedChatWorkspaces();
        expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
        expect(readFileSync(join(candidate('app'), relative), 'utf8')).toBe(
          'source history',
        );
      }
      expect(existsSync(temporary)).toBe(true);
    },
  );

  it('preserves preexisting temporary-shaped files rather than adopting them on fresh reconciliation', async () => {
    const relative = join('chats', `${key}.json`);
    put(join(candidate('workspace'), relative), 'source history');
    const temporary = join(
      candidate('app'),
      'chats',
      `.${key}.json.123.12345678-1234-4234-8234-123456789abc.tmp`,
    );
    put(temporary, 'preexisting evidence');
    await migrateAppManagedChatWorkspaces();
    expect(readFileSync(temporary, 'utf8')).toBe('preexisting evidence');
    expect(readFileSync(join(candidate('app'), relative), 'utf8')).toBe(
      'source history',
    );
  });

  it('qualifies a fresh run that a resident write to a destination-only scope overlaps', async () => {
    const resident = join(candidate('app'), 'chats', 'resident.json');
    put(resident, 'resident history');
    put(join(candidate('workspace'), 'chats', 'new.json'), 'new history');
    const original = atomic.writeFileAtomically;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        if (path === join(candidate('app'), 'chats', 'new.json'))
          writeFileSync(resident, 'resident write');
        return original(path, data, options);
      });
    await migrateAppManagedChatWorkspaces();
    expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
    expect(
      existsSync(join(root, '.code-review-namespace-custody', 'pending')),
    ).toBe(false);
    expect(readFileSync(resident, 'utf8')).toBe('resident write');
    expect(
      readFileSync(join(candidate('app'), 'chats', 'new.json'), 'utf8'),
    ).toBe('new history');
  });

  it('keeps a published scope whole when Code Review writes it before an in-process retry', async () => {
    await seedPredecessorScope();
    const later = join(candidate('app'), 'chats', 'zz.json');
    put(join(candidate('workspace'), 'chats', 'zz.json'), 'later history');
    const original = atomic.writeFileAtomically;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        if (path === later)
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return original(path, data, options);
      });
    await expectUnqualified('busy');
    jest.restoreAllMocks();
    const manifest = join('chat-storage-manifests', `${key}.json`);
    expect(existsSync(join(candidate('app'), manifest))).toBe(true);
    // q-34: the published scope is live before the transaction completes.
    const repository = new ChatStateV2Repository();
    try {
      await repository.transact(
        scope,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat-1',
            patch: { title: 'Edited after failure' },
          },
        ],
        { source: 'renderer-command' },
      );
      await repository.flushScope(scope);
      await migrateAppManagedChatWorkspaces();
    } finally {
      await repository.drainAll();
    }
    expect(getCodeReviewNamespaceGuardrail().qualified).toBe(false);
    expect(readFileSync(later, 'utf8')).toBe('later history');
    expect(existsSync(join(candidate('app'), manifest))).toBe(true);
    expect(await coldChat()).toEqual({
      title: 'Edited after failure',
      message: 'm1',
    });
    // The predecessor keeps its copy of the touched scope.
    expect(existsSync(join(candidate('workspace'), manifest))).toBe(true);
  });

  it('finishes a scope a fault interrupted before its manifest, even after a cold load', async () => {
    await seedPredecessorScope();
    const attachment = join('attachments', key, 'a.txt');
    put(join(candidate('workspace'), attachment), 'attached');
    const original = atomic.writeFileAtomically;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        if (path === join(candidate('app'), attachment))
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return original(path, data, options);
      });
    await expectUnqualified('busy');
    jest.restoreAllMocks();
    // q-34: Code Review opens the scope first. Without its manifest the cold
    // load would create a fresh scope over the predecessor history.
    await expect(coldChat()).rejects.toThrow();
    await migrateAppManagedChatWorkspaces();
    expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
    expect(readFileSync(join(candidate('app'), attachment), 'utf8')).toBe(
      'attached',
    );
    expect(await coldChat()).toEqual({
      title: predecessorTitle,
      message: 'm1',
    });
  });

  it.each(['format 2', 'mid-checkpoint'] as const)(
    'keeps a %s scope unloadable until replay installs the transcript a fault skipped',
    async (form) => {
      await seedPredecessorScope(scope, form);
      const store = join(candidate('app'), 'chat-storage-v2', key);
      const storeFiles = (): Record<string, string> =>
        Object.fromEntries(
          readdirSync(store, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => {
              const path = join(entry.parentPath, entry.name);
              return [path, readFileSync(path, 'utf8')];
            }),
        );
      const transcript = join(store, 'transcripts', 'chat-1.jsonl');
      const original = atomic.writeFileAtomically;
      jest
        .spyOn(atomic, 'writeFileAtomically')
        .mockImplementation(async (path, data, options) => {
          if (path === transcript)
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          return original(path, data, options);
        });
      await expectUnqualified('busy');
      jest.restoreAllMocks();
      const manifest = join(
        candidate('app'),
        'chat-storage-manifests',
        `${key}.json`,
      );
      const published = readFileSync(manifest, 'utf8');
      expect(JSON.parse(published)).toMatchObject({
        version: form === 'format 2' ? 2 : 3,
      });
      const partial = storeFiles();
      if (form === 'mid-checkpoint')
        expect(Object.keys(partial)).toContain(
          join(store, `live-index.json${DELTA_CHECKPOINT_STAGED_SUFFIX}`),
        );
      // q-34: Code Review opens the scope before the next launch replays it.
      // It neither promotes the scope nor finishes its staged checkpoint.
      await expect(coldChat()).rejects.toThrow();
      expect(readFileSync(manifest, 'utf8')).toBe(published);
      expect(storeFiles()).toEqual(partial);
      await migrateAppManagedChatWorkspaces();
      expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
      expect(existsSync(transcript)).toBe(true);
      expect(await coldChat()).toEqual({
        title: predecessorTitle,
        message: 'm1',
      });
    },
  );

  it.each(['unrelated-link', 'family-link'])(
    'replays a partial publication beside an %s in the destination',
    async (kind) => {
      const relative = join('chats', `${key}.json`);
      put(join(candidate('workspace'), relative), 'source history');
      const pending = join(root, '.code-review-namespace-custody', 'pending');
      for (const name of ['before', 'source-0', 'source-1'])
        mkdirSync(join(pending, name), { recursive: true });
      put(join(pending, 'source-1', relative), 'source history');
      const outside = join(root, 'outside');
      mkdirSync(outside);
      // A provider may replace a frozen profile directory with a link.
      const profile = join('worktree-data', 'other', 'profile');
      const link =
        kind === 'unrelated-link'
          ? join(candidate('app'), profile)
          : join(candidate('app'), 'chats');
      if (kind === 'unrelated-link')
        put(join(pending, 'before', profile, 'settings.json'), 'settings');
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(outside, link);
      await migrateAppManagedChatWorkspaces();
      if (kind === 'unrelated-link') {
        expect(readFileSync(join(candidate('app'), relative), 'utf8')).toBe(
          'source history',
        );
        expect(existsSync(pending)).toBe(false);
      } else {
        // A linked family never redirects a replay write.
        expect(getCodeReviewNamespaceGuardrail().qualified).toBe(false);
        expect(readdirSync(outside)).toEqual([]);
        expect(
          readFileSync(join(candidate('workspace'), relative), 'utf8'),
        ).toBe('source history');
      }
    },
  );

  it('keeps predecessor bytes across failed preparation and retries without treating abandoned evidence as completion', async () => {
    const source = registryAt('legacy', { [key]: owner });
    const raw = readFileSync(source, 'utf8');
    const original = atomic.writeFileAtomically;
    let interrupted = false;
    jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        if (path.includes('source-0') && path.endsWith('registry.json')) {
          interrupted = true;
          throw new Error('interrupted preparation');
        }
        return original(path, data, options);
      });
    await expectUnqualified('interrupted preparation');
    expect(interrupted).toBe(true);
    // q-34: startup still moves the missing predecessor as base did, verbatim.
    expect(existsSync(source)).toBe(false);
    expect(
      readFileSync(join(candidate('app'), 'chats', 'registry.json'), 'utf8'),
    ).toBe(raw);
    const custody = join(root, '.code-review-namespace-custody');
    const abandoned = readdirSync(custody).filter((name) =>
      name.startsWith('preparing-'),
    );
    expect(abandoned).toHaveLength(1);
    expect(existsSync(join(custody, 'pending'))).toBe(false);
    jest.restoreAllMocks();
    await jest.isolateModulesAsync(async () => {
      const fresh = await import('../lib/code-review-storage-admission');
      expect(
        await fresh.ensureCodeReviewNamespaceQualification(),
      ).toBeUndefined();
    });
    expect(
      readFileSync(join(candidate('app'), 'chats', 'registry.json'), 'utf8'),
    ).toBe(raw);
    expect(existsSync(source)).toBe(false);
    expect(readdirSync(custody)).toContain(abandoned[0]);
  });

  it.each(['source', 'destination', 'lost-preimage', 'foreign-file'])(
    'refuses changed %s evidence on restart after partial publication',
    async (changed) => {
      registryAt('workspace', { [key]: owner });
      const source = join(candidate('workspace'), 'chats', `${key}.json`);
      const destination = join(candidate('app'), 'chats', `${key}.json`);
      const preimage = join(candidate('app'), 'chats', 'preexisting.json');
      put(source, 'frozen source');
      put(preimage, 'original destination');
      const original = atomic.writeFileAtomically;
      let interrupted = false;
      jest
        .spyOn(atomic, 'writeFileAtomically')
        .mockImplementation(async (path, data, options) => {
          if (path === destination) {
            interrupted = true;
            throw new Error('interrupted publication');
          }
          return original(path, data, options);
        });
      await expectUnqualified('interrupted publication');
      expect(interrupted).toBe(true);
      jest.restoreAllMocks();
      if (changed === 'source') put(source, 'changed source');
      else if (changed === 'destination') put(destination, 'foreign bytes');
      else if (changed === 'lost-preimage') rmSync(preimage);
      else put(join(candidate('app'), 'foreign'), 'foreign addition');
      // q-34 lets Code Review write after a failed publication. Replay adds
      // only what the sources contribute, so a lost preimage or a foreign file
      // does not stop it; a changed planned file abandons replay and stays.
      // A changed source still fails closed.
      const reconciled =
        changed === 'lost-preimage' || changed === 'foreign-file';
      await jest.isolateModulesAsync(async () => {
        const fresh = await import('../lib/code-review-storage-admission');
        const failure = await fresh.ensureCodeReviewNamespaceQualification();
        if (reconciled) expect(failure).toBeUndefined();
        else
          expect(failure).toMatchObject({
            code: 'code_review_namespace_unqualified',
          });
      });
      const custody = join(root, '.code-review-namespace-custody');
      if (reconciled) {
        expect(readFileSync(destination, 'utf8')).toBe('frozen source');
        expect(existsSync(source)).toBe(false);
      } else
        expect(readFileSync(source, 'utf8')).toBe(
          changed === 'source' ? 'changed source' : 'frozen source',
        );
      expect(existsSync(join(custody, 'pending'))).toBe(changed === 'source');
      if (changed !== 'source') {
        // The settled transaction keeps its frozen predecessor bytes.
        const settled = readdirSync(custody).find((name) =>
          name.startsWith(reconciled ? 'completed-' : 'abandoned-'),
        );
        if (settled === undefined) throw new Error('Missing settled custody');
        expect(
          readFileSync(
            join(custody, settled, 'source-1', 'chats', `${key}.json`),
            'utf8',
          ),
        ).toBe('frozen source');
      }
      if (changed === 'destination')
        expect(readFileSync(destination, 'utf8')).toBe('foreign bytes');
      if (changed === 'foreign-file')
        expect(readFileSync(join(candidate('app'), 'foreign'), 'utf8')).toBe(
          'foreign addition',
        );
      if (changed !== 'lost-preimage')
        expect(readFileSync(preimage, 'utf8')).toBe('original destination');
    },
  );

  it.each(['registration', 'retiring-row', 'edited-publication'])(
    'completes its own partial publication forward after a later %s, never undoing a live file',
    async (later) => {
      registryAt('workspace', { [key]: owner });
      const manifest = join('chat-storage-manifests', `${key}.json`);
      // A store gate: publication installs it last.
      const index = join('chat-storage-v2', key, 'live-index.json');
      const transcript = join('chat-storage-v2', key, 'transcripts', 'c.json');
      const summary = join('summaries', `${key}.json`);
      const other = join('chats', 'other.json');
      const manifestRaw = JSON.stringify({
        version: 3,
        scopeId: key,
        migrationId: 'predecessor',
        sourceRevision: 0,
        sourceDigest: 'a'.repeat(64),
        cleanupComplete: true,
        journal: 'chat-delta-journal-v1',
      });
      put(join(candidate('workspace'), manifest), manifestRaw);
      put(join(candidate('workspace'), index), 'index');
      put(join(candidate('workspace'), transcript), 'transcript');
      put(join(candidate('workspace'), summary), 'summary');
      put(join(candidate('workspace'), other), 'other history');
      const original = atomic.writeFileAtomically;
      jest
        .spyOn(atomic, 'writeFileAtomically')
        .mockImplementation(async (path, data, options) => {
          if (path === join(candidate('app'), index))
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          return original(path, data, options);
        });
      await expectUnqualified('busy');
      jest.restoreAllMocks();
      const custody = join(root, '.code-review-namespace-custody');
      expect(existsSync(join(custody, 'pending'))).toBe(true);
      // Everything but the index published before the fault; q-34 keeps
      // Code Review open.
      expect(readFileSync(join(candidate('app'), summary), 'utf8')).toBe(
        'summary',
      );
      if (later === 'registration')
        await registerCodeReviewTarget('new-key', owner);
      else if (later === 'retiring-row')
        await markCodeReviewTargetRetiring(
          getCodeReviewRegistryFilePath(),
          key,
          owner,
        );
      else writeFileSync(join(candidate('app'), summary), 'edited summary');
      await migrateAppManagedChatWorkspaces();
      expect(existsSync(join(custody, 'pending'))).toBe(false);
      const edited = later === 'edited-publication';
      const settled = readdirSync(custody).find((name) =>
        name.startsWith(edited ? 'abandoned-' : 'completed-'),
      );
      if (settled === undefined) throw new Error('Missing settled custody');
      expect(
        readFileSync(join(custody, settled, 'source-1', index), 'utf8'),
      ).toBe('index');
      expect(readFileSync(join(candidate('app'), other), 'utf8')).toBe(
        'other history',
      );
      // Forward-only recovery never removes or replaces a published file.
      expect(readFileSync(join(candidate('app'), manifest), 'utf8')).toBe(
        manifestRaw,
      );
      if (!edited) {
        expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
        expect(readFileSync(join(candidate('app'), index), 'utf8')).toBe(
          'index',
        );
        expect(existsSync(candidate('workspace'))).toBe(false);
        const targets = await listCodeReviewTargets();
        if (later === 'registration')
          expect(Object.keys(targets).sort()).toEqual([key, 'new-key'].sort());
        else {
          // The later lifecycle change is kept and no later union trips on it.
          expect(targets).toEqual({
            [key]: { ...owner, incarnation: 'legacy', state: 'retiring' },
          });
          await migrateAppManagedChatWorkspaces();
          expect(getCodeReviewNamespaceGuardrail().qualified).toBe(true);
        }
      } else {
        // A later edit makes the scope live authority: it stays whole, with
        // its source, and the conflict stays visible.
        expect(getCodeReviewNamespaceGuardrail().qualified).toBe(false);
        expect(readFileSync(join(candidate('app'), summary), 'utf8')).toBe(
          'edited summary',
        );
        expect(existsSync(join(candidate('app'), index))).toBe(false);
        expect(readFileSync(join(candidate('workspace'), index), 'utf8')).toBe(
          'index',
        );
        expect(readFileSync(join(candidate('app'), transcript), 'utf8')).toBe(
          'transcript',
        );
        expect(
          readFileSync(join(candidate('workspace'), manifest), 'utf8'),
        ).toBe(manifestRaw);
      }
    },
  );

  it('retains both predecessors across interrupted retirement and resumes a partially retired transaction', async () => {
    registryAt('legacy', { [key]: owner });
    registryAt('workspace', { other: { projectId: 'other', worktreeId: 'w' } });
    const rename = fsPromises.rename;
    jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        if (source === candidate('workspace'))
          throw Object.assign(new Error('cross-device retirement'), {
            code: 'EXDEV',
          });
        return rename(source, destination);
      });
    await expectUnqualified('cross-device retirement');
    const pending = join(root, '.code-review-namespace-custody', 'pending');
    expect(existsSync(join(pending, 'retired-0', 'registry.json'))).toBe(true);
    expect(
      existsSync(join(candidate('workspace'), 'chats', 'registry.json')),
    ).toBe(true);
    jest.restoreAllMocks();
    await migrateAppManagedChatWorkspaces();
    expect(Object.keys(await listCodeReviewTargets()).sort()).toEqual(
      [key, 'other'].sort(),
    );
    expect(existsSync(candidate('workspace'))).toBe(false);
    expect(existsSync(pending)).toBe(false);
  });

  it('retires review chats and lets archive purge proceed after failed qualification, keeping predecessor bytes', async () => {
    registryAt('app', { [key]: owner });
    const legacy = registryAt('legacy', {
      [key]: { ...owner, projectId: 'different' },
    });
    const legacyRaw = readFileSync(legacy, 'utf8');
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
    expect(existsSync(manifest)).toBe(true);
    await expectUnqualified();
    // Archive directory I/O runs in an Electron utility process; stop there.
    const archiveStep = jest
      .spyOn(archiveIo, 'runArchiveIoRequest')
      .mockRejectedValue(new Error('archive I/O reached'));
    await expect(
      purgeArchivedContainer(owner.projectId, owner.worktreeId),
    ).rejects.toThrow('archive I/O reached');
    expect(archiveStep).toHaveBeenCalled();
    // Purge's review-chat stage retired the routed root's rows.
    expect(await listCodeReviewTargets()).toEqual({});
    expect(
      await removeCodeReviewChatsForWorktree(owner.projectId, owner.worktreeId),
    ).toEqual([]);
    expect(readFileSync(legacy, 'utf8')).toBe(legacyRaw);
    expect(getCodeReviewNamespaceGuardrail().proceeded).toContain('cleanup');
  });

  it('removes project and sentinel worktree data after failed qualification, keeping predecessor bytes', async () => {
    registryAt('app', { [key]: owner });
    const legacy = registryAt('legacy', {
      [key]: { ...owner, projectId: 'different' },
    });
    const raw = readFileSync(legacy, 'utf8');
    await expectUnqualified();
    const data = getWorktreeDataDir(owner.projectId, owner.worktreeId);
    put(join(data, 'panel-layout.json'), '{}');
    put(
      getCodeReviewStateFilePath(owner.projectId, owner.worktreeId),
      JSON.stringify({ version: 1, commentThreads: [] }),
    );
    const warnings = await cleanupPersistedWorktreeData(
      owner.projectId,
      owner.worktreeId,
    );
    expect(existsSync(data)).toBe(false);
    expect(warnings).toEqual([]);
    expect(await listCodeReviewTargets()).toEqual({});
    expect(readFileSync(legacy, 'utf8')).toBe(raw);
    await registerCodeReviewTarget('late', owner);
    expect(await getCodeReviewTarget('late')).toEqual(owner);

    const sentinel = join(getWorktreeDataDir(scope.projectId, key), 'x.json');
    put(sentinel, '{}');
    const sentinelWarnings = await cleanupPersistedWorktreeData(
      scope.projectId,
      key,
    );
    expect(
      sentinelWarnings.filter(
        (warning) =>
          warning.includes('legacy review chat') ||
          warning.includes('worktree metadata'),
      ),
    ).toEqual([]);
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(legacy, 'utf8')).toBe(raw);
  });
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

describe('scope identity (CAN-6848 PR 4)', () => {
  /** A registry as base registration wrote it: rows without lifecycle fields. */
  function writeHistoricalRegistry(targets: object): void {
    const path = getCodeReviewRegistryFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, targets }, null, 2));
  }
  /** Every stored file of one review chat scope, keyed by relative path. */
  function scopeFiles(scopeKey: string): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (directory: string, relative: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute, path);
        else if (
          path
            .split('/')
            .some(
              (segment) =>
                segment === scopeKey || segment.startsWith(`${scopeKey}.`),
            )
        )
          files[path] = readFileSync(absolute, 'base64');
      }
    };
    walk(join(root, 'app-workspaces', CODE_REVIEW_CHAT_PROJECT_ID), '');
    return files;
  }
  const reviewScope = (worktreeId: string): typeof scope => ({
    projectId: CODE_REVIEW_CHAT_PROJECT_ID,
    worktreeId,
  });

  it('registers a target with history under its own versioned key without renaming or reassigning the historical scope', async () => {
    writeHistoricalRegistry({ [key]: owner });
    await fixture.createChat(scope);
    await fixture.repository.flushScope(scope);
    const historical = scopeFiles(key);
    expect(Object.keys(historical)).toEqual(
      expect.arrayContaining([
        `chat-storage-manifests/${key}.json`,
        expect.stringMatching(new RegExp(`^chat-storage-v2/${key}/`)),
      ]),
    );
    const current = buildCodeReviewScopeKey(owner.projectId, owner.worktreeId);
    expect(current).not.toBe(key);
    await registerCodeReviewTarget(current, owner);
    const registered = readFileSync(getCodeReviewRegistryFilePath(), 'utf8');
    await registerCodeReviewTarget(current, owner); // Retry is idempotent.
    expect(readFileSync(getCodeReviewRegistryFilePath(), 'utf8')).toBe(
      registered,
    );
    const targets = await listCodeReviewTargets();
    expect(targets[key]).toEqual(owner);
    expect(targets[current]).toMatchObject({ ...owner, state: 'active' });
    expect(scopeFiles(key)).toEqual(historical);
    const manifest: unknown = JSON.parse(
      Buffer.from(
        historical[`chat-storage-manifests/${key}.json`],
        'base64',
      ).toString('utf8'),
    );
    expect(manifest).toMatchObject({ scopeId: key });
    expect(getCodeReviewTargetSync(key)).toEqual(owner);
    expect(getCodeReviewTargetSync(current)).toEqual(owner);
    await fixture.createChat(reviewScope(current));
    expect(
      (await fixture.repository.getState(scope)).tabsFile.tabs,
    ).toHaveLength(1);
    // Both keys name only this target, so deleting it removes both.
    expect(
      await removeCodeReviewChatsForWorktree(owner.projectId, owner.worktreeId),
    ).toEqual([]);
    expect(await listCodeReviewTargets()).toEqual({});
    expect(scopeFiles(key)).toEqual({});
    expect(scopeFiles(current)).toEqual({});
  });

  it("keeps an ambiguous historical scope through its recorded owner's deletion, and still finishes a committed retirement", async () => {
    // `(amb--tree, part)` built this key too; the row records the last writer.
    const ambiguous = { projectId: 'amb', worktreeId: 'tree--part' };
    const ambiguousKey = 'amb--tree--part';
    const retiring = { projectId: 'amb', worktreeId: 'old--part' };
    const retiringKey = 'amb--old--part';
    writeHistoricalRegistry({
      [ambiguousKey]: ambiguous,
      [retiringKey]: { ...retiring, incarnation: 'legacy', state: 'retiring' },
    });
    await fixture.createChat(reviewScope(ambiguousKey));
    await fixture.repository.flushScope(reviewScope(ambiguousKey));
    const attachment = join(
      getWorktreeAttachmentsDir(CODE_REVIEW_CHAT_PROJECT_ID, ambiguousKey),
      'kept.txt',
    );
    mkdirSync(dirname(attachment), { recursive: true });
    writeFileSync(attachment, 'shared history');
    // Literal, so the cleanup contract does not depend on the builder.
    const current = 'cr2-1amb-1tree-0-0part';
    await registerCodeReviewTarget(current, ambiguous);
    await fixture.createChat(reviewScope(current));
    const kept = scopeFiles(ambiguousKey);
    const keptRow = (await listCodeReviewTargets())[ambiguousKey];
    expect(keptRow).toEqual(ambiguous);
    const warn = jest
      .spyOn(mainProcessLogging, 'logMainProcessWarn')
      .mockImplementation(() => undefined);
    // Leaked, not refused: no warning, which archive purge would reject.
    expect(
      await removeCodeReviewChatsForWorktree(
        ambiguous.projectId,
        ambiguous.worktreeId,
      ),
    ).toEqual([]);
    expect(Object.keys(await listCodeReviewTargets()).sort()).toEqual(
      [ambiguousKey, retiringKey].sort(),
    );
    expect(scopeFiles(ambiguousKey)).toEqual(kept);
    expect(readFileSync(attachment, 'utf8')).toBe('shared history');
    expect(scopeFiles(current)).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('another worktree shares'),
      { scopeKey: ambiguousKey, ...ambiguous },
    );
    expect(getCodeReviewTargetSync(ambiguousKey)).toBeNull();
    expect(
      (await fixture.repository.getState(reviewScope(ambiguousKey))).tabsFile
        .tabs,
    ).toHaveLength(1);
    // The persisted marker already authorized this deletion.
    expect(
      await removeCodeReviewChatsForWorktree(
        retiring.projectId,
        retiring.worktreeId,
      ),
    ).toEqual([]);
    expect(Object.keys(await listCodeReviewTargets())).toEqual([ambiguousKey]);
    expect(
      buildCodeReviewScopeKey(ambiguous.projectId, ambiguous.worktreeId),
    ).toBe(current);
  });

  it('never resolves a kept ambiguous scope to a later worktree that reuses its ids', async () => {
    const ambiguous = { projectId: 'amb', worktreeId: 'tree--part' };
    const ambiguousKey = 'amb--tree--part';
    writeHistoricalRegistry({ [ambiguousKey]: ambiguous });
    await fixture.createChat(reviewScope(ambiguousKey));
    await fixture.repository.flushScope(reviewScope(ambiguousKey));
    const kept = scopeFiles(ambiguousKey);
    expect(getCodeReviewTargetSync(ambiguousKey)).toEqual(ambiguous);
    jest
      .spyOn(mainProcessLogging, 'logMainProcessWarn')
      .mockImplementation(() => undefined);
    let stopped = 0;
    let stopFailure: Error | undefined;
    teardown = (): Promise<void> => {
      stopped += 1;
      return stopFailure ? Promise.reject(stopFailure) : Promise.resolve();
    };
    const deleteWorktree = (): Promise<string[]> =>
      removeCodeReviewChatsForWorktree(
        ambiguous.projectId,
        ambiguous.worktreeId,
      );
    const expectKept = async (): Promise<void> => {
      // Base deleted the row, so lookups found nothing; a leak must match.
      expect(getCodeReviewTargetSync(ambiguousKey)).toBeNull();
      expect(await getCodeReviewTarget(ambiguousKey)).toBeNull();
      expect((await listCodeReviewTargets())[ambiguousKey]).toEqual({
        ...ambiguous,
        detached: true,
      });
      expect(scopeFiles(ambiguousKey)).toEqual(kept);
    };

    expect(await deleteWorktree()).toEqual([]);
    // The deleted checkout's review sessions stop even though bytes stay.
    expect(stopped).toBe(1);
    await expectKept();
    const detached = readFileSync(getCodeReviewRegistryFilePath(), 'utf8');
    expect(await deleteWorktree()).toEqual([]); // Retry is idempotent.
    expect(readFileSync(getCodeReviewRegistryFilePath(), 'utf8')).toBe(
      detached,
    );
    // Base had no row left here, so a failure must not reject archive purge.
    stopFailure = new Error('session stuck');
    expect(await deleteWorktree()).toEqual([]);
    expect(stopped).toBe(3);
    stopFailure = undefined;

    // A new worktree reuses the ids and opens review under its own key.
    const current = buildCodeReviewScopeKey(
      ambiguous.projectId,
      ambiguous.worktreeId,
    );
    await registerCodeReviewTarget(current, ambiguous);
    await fixture.createChat(reviewScope(current));
    expect(getCodeReviewTargetSync(current)).toEqual(ambiguous);
    // Re-registering the old key, as an older build would, cannot attribute it.
    await registerCodeReviewTarget(ambiguousKey, ambiguous);
    await expectKept();

    // Deleting the new worktree removes only its own review chats.
    expect(await deleteWorktree()).toEqual([]);
    expect(Object.keys(await listCodeReviewTargets())).toEqual([ambiguousKey]);
    expect(scopeFiles(current)).toEqual({});
    await expectKept();
    expect(
      (await fixture.repository.getState(reviewScope(ambiguousKey))).tabsFile
        .tabs,
    ).toHaveLength(1);
  });
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
