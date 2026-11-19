/**
 * Shared-container viewer scopes reach format 4 through the background sweep
 * alone (CAN-7178 follow-up 1, SWAN option C). An ordinary open still never
 * promotes one, the sweep never takes one from the projection that writes it,
 * and promotion keeps every bit of the viewer's view state.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type {
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import type * as CodeReviewAdmissionModule from '../lib/code-review-storage-admission';
import { noteCodeReviewNamespaceEffect } from '../lib/code-review-storage-admission';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import { listChatFormat4SweepCandidates } from '../services/chat-format4-sweep';
import { drainOpenRepositories } from './helpers/chat-delta-journal-scope';

jest.mock('../lib/code-review-storage-admission', () => {
  const actual = jest.requireActual<typeof CodeReviewAdmissionModule>(
    '../lib/code-review-storage-admission',
  );
  return {
    ...actual,
    noteCodeReviewNamespaceEffect: jest.fn(
      actual.noteCodeReviewNamespaceEffect,
    ),
  };
});

jest.setTimeout(60_000);

const VIEWER: ChatScopeKey = {
  projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
  worktreeId: 'replica',
};
const REVIEW: ChatScopeKey = {
  projectId: CODE_REVIEW_CHAT_PROJECT_ID,
  worktreeId: 'review-1',
};
const APP_MANAGED = new Set<string>([
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
]);

let dataDir: string;
let promotion = true;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'format4-sweep-viewer-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  resetResolvedCanopyDataDirForTests();
  promotion = true;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await drainOpenRepositories();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(dataDir, { recursive: true, force: true });
});

/** The canonical families: app-managed scopes live under `app-workspaces/`. */
function pathsFor(scope: ChatScopeKey): {
  tabs: string;
  archives: string;
  journal: string;
} {
  const workspace = join(
    dataDir,
    APP_MANAGED.has(scope.projectId) ? 'app-workspaces' : 'workspaces',
    scope.projectId,
  );
  return {
    tabs: join(workspace, 'chats', `${scope.worktreeId}.json`),
    archives: join(workspace, 'chat-archives', `${scope.worktreeId}.json`),
    journal: join(workspace, 'chat-journals', `${scope.worktreeId}.jsonl`),
  };
}

const storeFor = (scope: ChatScopeKey = VIEWER): ChatStorageV2 =>
  ChatStorageV2.fromLegacyPaths(pathsFor(scope));

function repository(): ChatStateV2Repository {
  return new ChatStateV2Repository({
    resolvePaths: pathsFor,
    enableFormat4: true,
    format4Promotion: () => promotion,
    deltaJournalIncrementalStreamMetadata: true,
    deltaJournalIdleCheckpointMs: 60_000,
    idleScopeUnloadMs: 0,
  });
}

/** A published, read-only viewer tab carrying view state the viewer set. */
function viewerTab(
  id: string,
  text: string,
  view: Pick<
    PersistedChatTab,
    'unread' | 'unreadMarkedManually' | 'attentionDismissedAt'
  > = {},
): PersistedChatTab {
  return {
    id,
    title: id,
    createdAt: '2026-11-19T00:00:00Z',
    readOnly: true,
    messages: [
      {
        id: `${id}-m1`,
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text }],
      },
    ],
    ...view,
  };
}

/** What the shared-container projection writes for a replica. */
function projected(
  tabs: PersistedChatTab[],
  activeTabId: string,
): ChatTabsFile {
  return { version: 1, tabs, activeTabId };
}

async function project(
  target: ChatStateV2Repository,
  file: ChatTabsFile,
  hooks: { preparePublish?: () => Promise<void> } = {},
): Promise<void> {
  await target.replaceCompatibilityTabs(VIEWER, file, {
    authoritative: true,
    activeTabId: file.activeTabId,
    ...hooks,
  });
}

/** The view state a viewer sees: order, active tab and each tab's flags. */
async function viewState(target: ChatStateV2Repository): Promise<unknown> {
  const tabs = (await target.getState(VIEWER)).tabsFile;
  return {
    activeTabId: tabs.activeTabId,
    tabs: tabs.tabs.map((tab) => ({
      id: tab.id,
      unread: tab.unread,
      unreadMarkedManually: tab.unreadMarkedManually,
      attentionDismissedAt: tab.attentionDismissedAt,
    })),
  };
}

const VIEWED = projected(
  [
    viewerTab('second', 'Second published chat', {
      unread: true,
      unreadMarkedManually: true,
    }),
    viewerTab('first', 'First published chat', {
      attentionDismissedAt: 1_763_510_400_000,
    }),
    viewerTab('third', 'Third published chat'),
  ],
  'first',
);

/** A viewer scope the projection wrote and nobody has promoted. */
async function seedViewer(): Promise<void> {
  const target = repository();
  await project(target, VIEWED);
  await target.drainAll();
  expect(['v2', 'v3']).toContain(await storeFor().format());
}

describe('an ordinary open of a viewer scope', () => {
  it('never promotes it, with the format 4 switch on', async () => {
    await seedViewer();
    const before = await storeFor().format();
    const target = repository();
    await target.getState(VIEWER);
    await target.drainAll();
    expect(await storeFor().format()).toBe(before);
    expect(['v2', 'v3']).toContain(before);
  });
});

describe('the sweep and a viewer scope', () => {
  it('promotes it to format 4 and keeps tab order, the active tab, unread, unreadMarkedManually and attentionDismissedAt', async () => {
    await seedViewer();
    const reader = repository();
    const before = await viewState(reader);
    await reader.drainAll();

    const target = repository();
    expect(await target.sweepFormat4(VIEWER)).toEqual({
      outcome: 'promoted',
    });
    expect(await storeFor().format()).toBe('v4');
    expect(await viewState(target)).toEqual(before);
    await target.drainAll();
  });

  it('answers held while the projection writes it, and leaves the store byte-unchanged', async () => {
    await seedViewer();
    const manifest = await readFile(storeFor().manifestPath);
    const target = repository();
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const projection = project(
      target,
      projected([viewerTab('later', 'Published later')], 'later'),
      {
        preparePublish: async () => {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    );
    await writing;
    expect(await target.sweepFormat4(VIEWER)).toEqual({ outcome: 'held' });
    expect(await readFile(storeFor().manifestPath)).toEqual(manifest);
    release();
    await projection;
    expect(['v2', 'v3']).toContain(await storeFor().format());
    await target.drainAll();
  });

  it('after promotion, the next projection writes format 4 and the manifest stays at version 4', async () => {
    await seedViewer();
    const sweeper = repository();
    expect(await sweeper.sweepFormat4(VIEWER)).toEqual({
      outcome: 'promoted',
    });
    await sweeper.drainAll();

    const target = repository();
    await project(
      target,
      projected([viewerTab('next', 'Published after promotion')], 'next'),
    );
    await target.drainAll();
    expect(await storeFor().format()).toBe('v4');
    const manifest = JSON.parse(
      await readFile(storeFor().manifestPath, 'utf8'),
    ) as { version: number };
    expect(manifest.version).toBe(4);
    const reader = repository();
    expect(
      (await reader.getState(VIEWER)).tabsFile.tabs.map((tab) => tab.id),
    ).toEqual(['next']);
    await reader.drainAll();
  });

  it('records no Code Review namespace effect when it promotes a viewer scope, while a code-review scope still records its promotion', async () => {
    await seedViewer();
    const note = jest.mocked(noteCodeReviewNamespaceEffect);
    note.mockClear();
    const target = repository();
    expect(await target.sweepFormat4(VIEWER)).toEqual({
      outcome: 'promoted',
    });
    expect(note).not.toHaveBeenCalled();
    await target.getState(REVIEW);
    expect(note).toHaveBeenCalledWith('promotion');
    await target.drainAll();
  });
});

describe('a viewer promotion that fails (review of #10197)', () => {
  it('is a load failure: the scope is released, not left ready on a backend that failed to reopen, and the next sweep promotes it', async () => {
    await seedViewer();
    const failures: string[] = [];
    const target = new ChatStateV2Repository({
      resolvePaths: pathsFor,
      enableFormat4: true,
      format4Promotion: (): boolean => promotion,
      deltaJournalIncrementalStreamMetadata: true,
      deltaJournalIdleCheckpointMs: 60_000,
      idleScopeUnloadMs: 0,
      storageFailure: (failure): void => {
        failures.push(failure.kind);
      },
    });
    const resident = (): number =>
      target
        .residencySnapshot()
        .filter(
          (entry) => entry.lifecycle !== 'unloaded' || entry.backendResident,
        ).length;
    // A reopen that fails leaves a backend that can't flush either.
    let broken = false;
    /* eslint-disable @typescript-eslint/unbound-method -- Called with apply(this) below. */
    const flush = ChatStateV2Backend.prototype.flush;
    const promoteToFormat4 = ChatStateV2Backend.prototype.promoteToFormat4;
    /* eslint-enable @typescript-eslint/unbound-method */
    const flushes = jest
      .spyOn(ChatStateV2Backend.prototype, 'flush')
      .mockImplementation(function (this: ChatStateV2Backend) {
        return broken
          ? Promise.reject(new Error('fault:flush'))
          : flush.apply(this);
      });
    const promote = jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockImplementation(function (this: ChatStateV2Backend) {
        if (broken) return promoteToFormat4.apply(this);
        broken = true;
        return Promise.reject(new Error('fault:reopen'));
      });
    try {
      expect((await target.sweepFormat4(VIEWER)).outcome).toBe('failed');
      expect(failures).toContain('load');
      expect(target.getLifecycle(VIEWER)).toBe('unloaded');
      expect(resident()).toBe(0);
    } finally {
      broken = false;
      flushes.mockRestore();
      promote.mockRestore();
    }
    expect(await target.sweepFormat4(VIEWER)).toEqual({
      outcome: 'promoted',
    });
    expect(await storeFor().format()).toBe('v4');
    expect(resident()).toBe(0);
    await target.drainAll();
  });
});

describe('the inventory', () => {
  it('offers a stored viewer scope below format 4 (code-review scopes: chat-format4-sweep-code-review-scopes.test.ts)', async () => {
    await seedViewer();
    const inventory = await listChatFormat4SweepCandidates(dataDir, storeFor);
    expect(inventory.candidates.map((item) => item.scope.projectId)).toEqual([
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
    ]);
    expect(inventory.candidates[0]?.format).not.toBe('v4');
  });
});
