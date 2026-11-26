import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  composeCoreItemStore,
  CORE_ITEM_STORE_SOURCE_UNCHANGED,
  CoreItemStoreRelocationRollbackError,
  type CoreItemStoreHost,
  type CoreItemStoreParticipant,
  type CoreItemStoreRelocation,
} from '@canopy/core-runtime/node/worktree/item-store';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  createInitialState,
  loadExecutionState,
  normalizePipeline,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/execution-engine/node/pipelines/executor/types';

jest.mock('../../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(),
}));
// No chat moves in these splits; the chat stores have goldens of their own.
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): { flushScope: () => Promise<void> } => ({
    flushScope: (): Promise<void> => Promise.resolve(),
  }),
}));
jest.mock('../chat-tabs-reader', () => ({
  readChatTabsFile: (): Promise<never> =>
    Promise.reject(Object.assign(new Error('absent'), { code: 'ENOENT' })),
  readChatTabsFileForIndex: (): Promise<never> =>
    Promise.reject(Object.assign(new Error('absent'), { code: 'ENOENT' })),
}));
jest.mock('../chat-tabs', () => ({
  writeChatTabsFile: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../chat-archives', () => ({
  readChatArchivesFileForIndex: (): Promise<never> =>
    Promise.reject(Object.assign(new Error('absent'), { code: 'ENOENT' })),
  writeChatArchivesFile: (): Promise<void> => Promise.resolve(),
  removeChatArchive: (): Promise<void> => Promise.resolve(),
}));

import { createElectronExecutionRuntime } from '../../pipelines/execution-runtime';
import {
  getWorkspaceDir,
  getWorktreeAttachmentsDir,
  getWorktreeDataDir,
} from '../paths';
import {
  installRestoredTrackedPlans,
  listTrackedPlans,
} from '../plan-persistence';
import type {
  SplitItemsMigrationTarget,
  SplitWorktreeRepoItems,
} from '../split-temporary-workspace-items';
import {
  getWorktreeItemStore,
  splitExecutionsRelocation,
  splitItemsRelocation,
  splitRelocationDestination,
} from '../worktree-item-store';

/*
 * CAN-4098 item store port (CAN-7909): Electron's purges and split's
 * relocations keep their effects behind the port, and a store that flips out
 * of Electron plugs in as a participant ahead of the host.
 */

const WORKSPACE = 'item-store-ws';
const SOURCE = 'item-store-source';

let root: string;
let priorRoot: string | undefined;
let runtime: ExecutionRuntime;

function put(path: string, contents = '{}'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  priorRoot = process.env.CANOPY_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), 'item-store-'));
  process.env.CANOPY_DATA_DIR = root;
  runtime = {
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: join(root, 'pipeline-executions'),
    tempRootDir: root,
    bundledActionsDir: root,
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
  };
  jest.mocked(createElectronExecutionRuntime).mockReturnValue(runtime);
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = priorRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('purge', () => {
  it('removes one worktree’s data and keeps its siblings', async () => {
    const data = getWorktreeDataDir(WORKSPACE, SOURCE);
    put(join(data, 'panel-layout.json'));
    put(join(data, 'file-annotations.json'));
    put(join(data, 'nested', 'deep.json'));
    const sibling = join(getWorktreeDataDir(WORKSPACE, 'sibling'), 'keep.json');
    put(sibling);

    await getWorktreeItemStore().purge({
      scope: 'worktree',
      workspaceId: WORKSPACE,
      worktreeId: SOURCE,
    });

    expect(existsSync(data)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it('removes an app-managed workspace’s worktree data from its own root', async () => {
    const data = getWorktreeDataDir(SHARED_CONTAINER_VIEWER_PROJECT_ID, 'c1');
    expect(data).toContain('app-workspaces');
    put(join(data, 'run', 'state.json'));

    await getWorktreeItemStore().purge({
      scope: 'worktree',
      workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'c1',
    });

    expect(existsSync(data)).toBe(false);
  });

  it('refuses an unsafe worktree id and removes nothing', async () => {
    const data = join(getWorkspaceDir(WORKSPACE), 'worktree-data');
    put(join(data, 'keep.json'));
    await expect(
      getWorktreeItemStore().purge({
        scope: 'worktree',
        workspaceId: WORKSPACE,
        worktreeId: '..',
      }),
    ).rejects.toThrow();
    expect(existsSync(join(data, 'keep.json'))).toBe(true);
  });

  it('removes a workspace’s items, keeps its records, then removes its emptied folder', async () => {
    const workspace = getWorkspaceDir(WORKSPACE);
    put(join(workspace, 'workspace.json'), '{"manifest":true}');
    put(join(workspace, 'worktrees.json'), '{"list":true}');
    put(join(workspace, 'notes', 'n.md'), 'note');
    put(join(workspace, 'prompts', 'p.md'), 'prompt');
    put(join(getWorktreeDataDir(WORKSPACE, SOURCE), 'x.json'));

    await getWorktreeItemStore().purge({
      scope: 'workspace',
      workspaceId: WORKSPACE,
      stage: 'items',
    });

    expect(readdirSync(workspace).sort()).toEqual([
      'workspace.json',
      'worktrees.json',
    ]);
    expect(readFileSync(join(workspace, 'workspace.json'), 'utf8')).toBe(
      '{"manifest":true}',
    );

    // The records go with their own commit.
    rmSync(join(workspace, 'workspace.json'));
    rmSync(join(workspace, 'worktrees.json'));
    await getWorktreeItemStore().purge({
      scope: 'workspace',
      workspaceId: WORKSPACE,
      stage: 'folder',
      worktreeIds: [SOURCE],
    });

    expect(existsSync(workspace)).toBe(false);
  });

  it('removes a worktree’s data written after the items stage, keeping the folder it recreated', async () => {
    const workspace = getWorkspaceDir(WORKSPACE);
    put(join(getWorktreeDataDir(WORKSPACE, SOURCE), 'x.json'));
    put(join(workspace, 'recreated.json'));

    await getWorktreeItemStore().purge({
      scope: 'workspace',
      workspaceId: WORKSPACE,
      stage: 'folder',
      worktreeIds: [SOURCE],
    });

    expect(existsSync(getWorktreeDataDir(WORKSPACE, SOURCE))).toBe(false);
    expect(existsSync(join(workspace, 'recreated.json'))).toBe(true);
  });
});

describe('split relocation', () => {
  const repos = ['repo-a', 'repo-b'] as const;
  // Checkout paths only label the executions; nothing reads them.
  const checkouts = join(tmpdir(), 'item-store-checkouts');
  const sourceCheckout = (repo: string): string =>
    join(checkouts, SOURCE, 'repos', repo);
  const targets: SplitItemsMigrationTarget[] = repos.map((repo) => ({
    repoId: repo,
    destinationWorkspaceId: `${repo}-ws`,
    destinationWorktreeId: `${repo}-wt`,
    oldCheckoutPath: sourceCheckout(repo),
    newCheckoutPath: join(checkouts, `${repo}-wt`),
  }));
  const [targetA, targetB] = targets;

  function plan(id: string, repo: string): TrackedPlanData {
    const at = '2026-11-01T00:00:00.000Z';
    return {
      id,
      projectId: WORKSPACE,
      worktreeId: SOURCE,
      source: 'imported',
      sourceRepoId: repo,
      sourceFilePath: `${id}.md`,
      title: id,
      content: `# ${id}`,
      reviewStatus: 'pending',
      createdAt: at,
      updatedAt: at,
      latestRevisionNumber: 1,
      revisions: [
        {
          revisionNumber: 1,
          content: `# ${id}`,
          source: 'imported',
          reviewStatus: 'pending',
          createdAt: at,
        },
      ],
      linkedExecutionIds: [],
    };
  }

  function repoItems(repo: string): SplitWorktreeRepoItems {
    return {
      chatTabs: [],
      fileTabs: [],
      archivedChats: [],
      executions: [],
      plans: [plan(`${repo}-plan`, repo)],
      attachmentNames: [`${repo}.png`],
    };
  }

  async function seedSource(): Promise<void> {
    await installRestoredTrackedPlans(
      WORKSPACE,
      SOURCE,
      repos.map((repo) => plan(`${repo}-plan`, repo)),
    );
    for (const repo of repos)
      put(
        join(getWorktreeAttachmentsDir(WORKSPACE, SOURCE), `${repo}.png`),
        repo,
      );
  }

  async function relocateItems(): Promise<CoreItemStoreRelocation> {
    return getWorktreeItemStore().relocate(
      splitItemsRelocation({
        workspaceId: WORKSPACE,
        worktreeId: SOURCE,
        analysis: {
          perRepo: new Map(repos.map((repo) => [repo, repoItems(repo)])),
          root: {
            chatTabs: [],
            fileTabs: [],
            archivedChats: [],
            executions: [],
            plans: [],
            attachmentNames: [],
          },
        },
        targets,
        hardDeleteRepoIds: new Set(),
      }),
    );
  }

  const planIds = async (
    workspaceId: string,
    worktreeId: string,
  ): Promise<string[]> =>
    (await listTrackedPlans(workspaceId, worktreeId)).map((entry) => entry.id);
  const attachment = (
    workspaceId: string,
    worktreeId: string,
    name: string,
  ): string => join(getWorktreeAttachmentsDir(workspaceId, worktreeId), name);

  it('moves each repository’s plans and attachments to its destination and commits', async () => {
    await seedSource();
    const relocation = await relocateItems();

    expect(await planIds(WORKSPACE, SOURCE)).toEqual([]);
    for (const target of targets) {
      expect(
        await planIds(
          target.destinationWorkspaceId,
          target.destinationWorktreeId,
        ),
      ).toEqual([`${target.repoId}-plan`]);
      expect(
        readFileSync(
          attachment(
            target.destinationWorkspaceId,
            target.destinationWorktreeId,
            `${target.repoId}.png`,
          ),
          'utf8',
        ),
      ).toBe(target.repoId);
      expect(
        existsSync(attachment(WORKSPACE, SOURCE, `${target.repoId}.png`)),
      ).toBe(false);
    }

    await relocation.commit();
    const attachmentsParent = dirname(
      getWorktreeAttachmentsDir(WORKSPACE, SOURCE),
    );
    // The source's backup goes; the destinations keep their copies.
    expect(
      readdirSync(attachmentsParent).filter((name) => name.includes('-split-')),
    ).toEqual([]);
    expect(
      existsSync(
        attachment(
          targetA.destinationWorkspaceId,
          targetA.destinationWorktreeId,
          'repo-a.png',
        ),
      ),
    ).toBe(true);
  });

  it('returns one destination’s items to the source and leaves the other moved', async () => {
    await seedSource();
    const relocation = await relocateItems();

    await relocation.revertDestination(splitRelocationDestination(targetA));

    expect(await planIds(WORKSPACE, SOURCE)).toEqual(['repo-a-plan']);
    expect(
      readFileSync(attachment(WORKSPACE, SOURCE, 'repo-a.png'), 'utf8'),
    ).toBe('repo-a');
    expect(
      await planIds(
        targetA.destinationWorkspaceId,
        targetA.destinationWorktreeId,
      ),
    ).toEqual([]);
    expect(
      existsSync(
        attachment(
          targetA.destinationWorkspaceId,
          targetA.destinationWorktreeId,
          'repo-a.png',
        ),
      ),
    ).toBe(false);
    expect(
      await planIds(
        targetB.destinationWorkspaceId,
        targetB.destinationWorktreeId,
      ),
    ).toEqual(['repo-b-plan']);
    expect(existsSync(attachment(WORKSPACE, SOURCE, 'repo-b.png'))).toBe(false);
  });

  it('returns every item to the source on revert', async () => {
    await seedSource();
    const relocation = await relocateItems();

    await relocation.revert();

    expect((await planIds(WORKSPACE, SOURCE)).sort()).toEqual([
      'repo-a-plan',
      'repo-b-plan',
    ]);
    for (const target of targets) {
      expect(
        readFileSync(
          attachment(WORKSPACE, SOURCE, `${target.repoId}.png`),
          'utf8',
        ),
      ).toBe(target.repoId);
      expect(
        await planIds(
          target.destinationWorkspaceId,
          target.destinationWorktreeId,
        ),
      ).toEqual([]);
      expect(
        existsSync(
          attachment(
            target.destinationWorkspaceId,
            target.destinationWorktreeId,
            `${target.repoId}.png`,
          ),
        ),
      ).toBe(false);
    }
  });

  it('refuses to revert a destination nothing went to', async () => {
    await seedSource();
    const relocation = await relocateItems();
    await expect(
      relocation.revertDestination({
        workspaceId: 'other-ws',
        worktreeId: 'other-wt',
        repoId: 'repo-a',
      }),
    ).rejects.toThrow('No split items went to worktree other-wt');
  });

  async function seedExecution(id: string, repo: string): Promise<void> {
    const state = createInitialState(
      normalizePipeline({
        name: id,
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      {
        cwd: join(sourceCheckout(repo), 'src'),
        pipelineId: id,
        runtime,
        projectId: WORKSPACE,
        worktreeId: SOURCE,
      },
      id,
    );
    state.status = 'success';
    await saveExecutionState(state, runtime.executionsDir);
  }

  async function executionHome(
    id: string,
  ): Promise<[string | undefined, string | undefined, string]> {
    const state = await loadExecutionState(id, runtime.executionsDir);
    if (!state) throw new Error(`Missing execution ${id}`);
    return [state.project_id, state.worktree_id, state.cwd];
  }

  it('re-homes repository executions and takes them back per destination or all at once', async () => {
    await seedExecution('run-a', 'repo-a');
    await seedExecution('run-b', 'repo-b');
    const relocation = await getWorktreeItemStore().relocate(
      splitExecutionsRelocation({
        workspaceId: WORKSPACE,
        worktreeId: SOURCE,
        targets,
      }),
    );

    expect(await executionHome('run-a')).toEqual([
      'repo-a-ws',
      'repo-a-wt',
      join(targetA.newCheckoutPath, 'src'),
    ]);
    expect(await executionHome('run-b')).toEqual([
      'repo-b-ws',
      'repo-b-wt',
      join(targetB.newCheckoutPath, 'src'),
    ]);

    await relocation.revertDestination(splitRelocationDestination(targetA));
    expect(await executionHome('run-a')).toEqual([
      WORKSPACE,
      SOURCE,
      join(sourceCheckout('repo-a'), 'src'),
    ]);
    expect((await executionHome('run-b'))[0]).toBe('repo-b-ws');

    await relocation.revert();
    expect(await executionHome('run-b')).toEqual([
      WORKSPACE,
      SOURCE,
      join(sourceCheckout('repo-b'), 'src'),
    ]);
  });
});

describe('participants', () => {
  function recordingHost(log: string[]): CoreItemStoreHost<string> {
    return {
      purge: ({ target, keepStores }) => {
        log.push(
          `host purge ${target.scope} keeping [${keepStores.join(',')}]`,
        );
        return Promise.resolve();
      },
      relocate: ({ plan }) => {
        log.push(`host relocate ${plan}`);
        return Promise.resolve({
          commit: () => {
            log.push('host commit');
            return Promise.resolve();
          },
          revert: () => {
            log.push('host revert');
            return Promise.resolve();
          },
          revertDestination: () => {
            log.push('host revert destination');
            return Promise.resolve();
          },
        });
      },
    };
  }

  function participant(
    log: string[],
    store: string,
    fail?: 'purge' | 'relocate',
  ): CoreItemStoreParticipant {
    return {
      store,
      purge: () => {
        log.push(`${store} purge`);
        return fail === 'purge'
          ? Promise.reject(new Error(`${store} refused`))
          : Promise.resolve();
      },
      relocate: ({ mode }) => {
        log.push(`${store} relocate ${mode}`);
        if (fail === 'relocate')
          return Promise.reject(new Error(`${store} refused`));
        return Promise.resolve({
          commit: () => {
            log.push(`${store} commit`);
            return Promise.resolve();
          },
          revert: () => {
            log.push(`${store} revert`);
            return Promise.resolve();
          },
          revertDestination: () => {
            log.push(`${store} revert destination`);
            return Promise.resolve();
          },
        });
      },
    };
  }

  const request = {
    mode: 'move' as const,
    source: { kind: 'worktree' as const, workspaceId: 'w', worktreeId: 's' },
    destinations: [{ workspaceId: 'w', worktreeId: 'd' }],
    plan: 'host-plan',
  };

  it('purges each participant’s store first, and the host keeps those stores', async () => {
    const log: string[] = [];
    const store = composeCoreItemStore(recordingHost(log), [
      participant(log, 'file_annotations'),
      participant(log, 'notes'),
    ]);
    await store.purge({ scope: 'worktree', workspaceId: 'w', worktreeId: 's' });
    expect(log).toEqual([
      'file_annotations purge',
      'notes purge',
      'host purge worktree keeping [file_annotations,notes]',
    ]);
  });

  it('stops before the host removes anything when a participant refuses', async () => {
    const log: string[] = [];
    const store = composeCoreItemStore(recordingHost(log), [
      participant(log, 'file_annotations', 'purge'),
    ]);
    await expect(
      store.purge({ scope: 'workspace', workspaceId: 'w', stage: 'items' }),
    ).rejects.toThrow('file_annotations refused');
    expect(log).toEqual(['file_annotations purge']);
  });

  it('relocates participants first, commits host first, and reverts in reverse', async () => {
    const log: string[] = [];
    const store = composeCoreItemStore(recordingHost(log), [
      participant(log, 'one'),
      participant(log, 'two'),
    ]);
    const relocation = await store.relocate(request);
    await relocation.commit();
    await relocation.revert();
    await relocation.revertDestination(request.destinations[0]);
    expect(log).toEqual([
      'one relocate move',
      'two relocate move',
      'host relocate host-plan',
      'host commit',
      'one commit',
      'two commit',
      'host revert',
      'two revert',
      'one revert',
      'host revert destination',
      'two revert destination',
      'one revert destination',
    ]);
  });

  it('takes back the participants that relocated when a later one fails', async () => {
    const log: string[] = [];
    const store = composeCoreItemStore(recordingHost(log), [
      participant(log, 'one'),
      participant(log, 'two', 'relocate'),
    ]);
    await expect(store.relocate(request)).rejects.toThrow('two refused');
    expect(log).toEqual([
      'one relocate move',
      'two relocate move',
      'one revert',
    ]);
  });

  it('reports a relocation it could not take back as a failed rollback', async () => {
    const log: string[] = [];
    const stuck: CoreItemStoreParticipant = {
      ...participant(log, 'one'),
      relocate: () =>
        Promise.resolve({
          ...CORE_ITEM_STORE_SOURCE_UNCHANGED,
          revert: () => Promise.reject(new Error('one stuck')),
        }),
    };
    const store = composeCoreItemStore(recordingHost(log), [
      stuck,
      participant(log, 'two', 'relocate'),
    ]);
    const failure = await store
      .relocate(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreItemStoreRelocationRollbackError);
    expect(
      failure instanceof CoreItemStoreRelocationRollbackError
        ? failure.errors.map((error) =>
            error instanceof Error ? error.message : String(error),
          )
        : [],
    ).toEqual(['two refused', 'one stuck']);
  });
});
