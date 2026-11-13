import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type {
  CollectionConfig,
  SharedCollectionDetail,
} from '@canopy/desktop-shared/types/collections';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { AdvisorCollectionSharingHost } from '../advisor-collection-sharing-actions';
import type { PersonConfirmation } from '../advisor-records-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorCollectionSharingHost;
jest.mock('../advisor-collection-sharing-actions-host', () => ({
  mainAdvisorCollectionSharingHost: (): AdvisorCollectionSharingHost =>
    mockHost,
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { routeAppAdvisorAction } from '../action-router';
import { ADVISOR_COLLECTION_SHARING_ACTION_TYPES } from '../advisor-collection-sharing-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;

interface Recorded {
  hosted: string[];
  questions: string[];
  created: unknown[];
  updated: unknown[];
  saved: unknown[];
}
let recorded: Recorded;
let answer: PersonConfirmation;
let selected: string | undefined;
let collection: CollectionConfig | null;

const LOCAL: CollectionConfig = {
  id: 'local-1',
  name: 'Release kit',
  description: 'For releases',
  skills: [{ sourceId: 'builtin:anthropic', skillName: 'changelog' }],
  plugins: [],
  mcpServers: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function shared(): SharedCollectionDetail {
  return {
    id: 'shared-1',
    contentHash: 'hash-1',
    collection: {
      name: 'Release kit',
      description: 'For releases',
      items: [
        {
          type: 'skill',
          source: { type: 'github', repo: 'octo/skills' },
          skill_name: 'changelog',
        },
        {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'octo/plugins' },
          plugin_name: 'release-notes',
        },
        {
          type: 'custom_skill',
          skillId: 'skill-9',
          skill_name: 'tone',
          contentHash: 'h9',
        },
      ],
    },
  } as unknown as SharedCollectionDetail;
}

function recordingHost(): AdvisorCollectionSharingHost {
  return {
    selectedOrganizationId: () => selected,
    memberOrganizationIds: () => Promise.resolve(new Set(['org-1'])),
    loadCollection: () => Promise.resolve(collection),
    editable: (config) =>
      Promise.resolve({
        name: config.name,
        description: config.description ?? '',
        items: [
          {
            kind: 'draft_custom_skill',
            localSkillId: 'custom:app/tone',
            skillName: 'tone',
          },
        ],
      } as never),
    payload: (editable) =>
      Promise.resolve({
        rawCollection: `raw:${editable.name}:${JSON.stringify(editable.items)}`,
        customSkills: [],
      } as never),
    listShared: () => {
      recorded.hosted.push('listShared');
      return Promise.resolve({ collections: [], nextCursor: null } as never);
    },
    getShared: () => {
      recorded.hosted.push('getShared');
      return Promise.resolve(shared());
    },
    createShared: (request) => {
      recorded.hosted.push('createShared');
      recorded.created.push(request);
      return Promise.resolve({ ok: true, value: shared() });
    },
    updateShared: (request) => {
      recorded.hosted.push('updateShared');
      recorded.updated.push(request);
      return Promise.resolve({ ok: true, value: shared() });
    },
    deleteShared: (collectionId) => {
      recorded.hosted.push(`deleteShared:${collectionId}`);
      return Promise.resolve();
    },
    resolveImport: () => {
      recorded.hosted.push('resolveImport');
      return Promise.resolve({
        skills: [{ sourceId: 'github:octo:skills', skillName: 'changelog' }],
        plugins: [],
        failures: [
          {
            label: 'release-notes',
            required: false,
            message: 'No marketplace.',
          },
        ],
      });
    },
    saveCollection: (input) => {
      recorded.hosted.push('saveCollection');
      recorded.saved.push(input);
      return Promise.resolve({ ...LOCAL, id: 'local-2', ...input });
    },
    installPackage: () => Promise.reject(new Error('no package expected')),
    confirm: (question) => {
      recorded.questions.push(question);
      return Promise.resolve(answer);
    },
  };
}

function setup(): {
  route(input: unknown, toolUseId?: string): Promise<AppAdvisorActionResponse>;
} {
  const runtime = createAppAdvisorToolRuntime(
    {
      getMainWindow: jest.fn(() => null),
      getAppAdvisorWindow: jest.fn(() => null),
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    },
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
  );
  let calls = 0;
  return {
    route: async (input, toolUseId) => {
      calls += 1;
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: toolUseId ?? `toolu_${calls}` },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6003b-collections-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  recorded = { hosted: [], questions: [], created: [], updated: [], saved: [] };
  answer = 'confirmed';
  selected = undefined;
  collection = LOCAL;
  mockHost = recordingHost();
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor collection sharing in main (CAN-6003 part B)', () => {
  it('runs as core collection-sharing actions, with strict schemas', () => {
    for (const type of ADVISOR_COLLECTION_SHARING_ACTION_TYPES)
      expect(appAdvisorActionDisposition(type)).toMatchObject({
        kind: 'core',
        executor: 'collection-sharing',
      });
    expect(appAdvisorActionDisposition('collections.import_shared')).toEqual({
      kind: 'core',
      access: 'write',
      executor: 'collection-sharing',
      grants: ['core.sharing.write', 'core.catalog.write'],
      revision: 'none',
    });
    expect(() =>
      dispatchActionSchema.parse({
        action: {
          type: 'collections.import_shared',
          collectionId: 'shared-1',
          install: 'everything',
        },
      }),
    ).toThrow();
  });

  it('S7: imports only after a person confirms a question naming every member', async () => {
    const h = setup();
    for (const refusal of ['no_person', 'declined'] as const) {
      answer = refusal;
      await expect(
        h.route({
          type: 'collections.import_shared',
          collectionId: 'shared-1',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'authorization_conflict' },
      });
    }
    // Asked twice, installed nothing.
    expect(recorded.hosted).toEqual(['getShared', 'getShared']);
    answer = 'confirmed';
    await expect(
      h.route({ type: 'collections.import_shared', collectionId: 'shared-1' }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        id: 'local-2',
        memberFailures: [
          {
            label: 'release-notes',
            required: false,
            message: 'No marketplace.',
          },
        ],
      },
    });
    expect(recorded.questions[2]?.split('\n')).toEqual([
      expect.stringContaining('Import the shared collection "Release kit"'),
      '- Skill changelog, from octo/skills',
      '- Claude plugin release-notes, from octo/plugins',
      '- Custom skill tone',
    ]);
    expect(recorded.saved).toEqual([
      {
        name: 'Release kit',
        description: 'For releases',
        skills: [{ sourceId: 'github:octo:skills', skillName: 'changelog' }],
        plugins: [],
        mcpServers: [],
      },
    ]);
  });

  it('shares to an organization only by the part A rules: a forged one is refused before any hosted call', async () => {
    const h = setup();
    await expect(
      h.route({
        type: 'collections.share',
        id: 'local-1',
        shareScope: 'organization',
        organizationId: 'org-forged',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    await expect(
      h.route({
        type: 'collections.share',
        id: 'local-1',
        shareScope: 'organization',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(recorded.hosted).toEqual([]);
    selected = 'org-1';
    await expect(
      h.route({
        type: 'collections.share',
        id: 'local-1',
        shareScope: 'organization',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(recorded.created).toEqual([
      expect.objectContaining({
        sourceCollectionId: 'local-1',
        shareScope: 'organization',
        organizationId: 'org-1',
      }) as unknown,
    ]);
  });

  it("refuses a collection with MCP servers, and keeps an update's linked custom skills", async () => {
    const h = setup();
    collection = {
      ...LOCAL,
      mcpServers: [{ serverId: 'm1', configId: 'c1' }],
    } as never;
    await expect(
      h.route({
        type: 'collections.share',
        id: 'local-1',
        shareScope: 'team',
        teamId: 't1',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    collection = LOCAL;
    await expect(
      h.route({
        type: 'collections.update_shared',
        collectionId: 'shared-1',
        id: 'local-1',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(recorded.updated).toEqual([
      {
        collectionId: 'shared-1',
        expectedContentHash: 'hash-1',
        rawCollection: expect.stringContaining(
          'linked_custom_skill',
        ) as unknown,
      },
    ]);
  });

  it("maps a hosted share's failure, and lists and deletes through the window's owners", async () => {
    const h = setup();
    mockHost.createShared = (): ReturnType<
      AdvisorCollectionSharingHost['createShared']
    > =>
      Promise.resolve({
        ok: false,
        failure: {
          message: 'The share could not be stored.',
          retryable: true,
          commitState: 'committed',
        },
      } as never);
    await expect(
      h.route({
        type: 'collections.share',
        id: 'local-1',
        shareScope: 'team',
        teamId: 't1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'The share could not be stored.',
      },
    });
    await expect(
      h.route({ type: 'collections.list_shared', query: 'release' }),
    ).resolves.toMatchObject({ ok: true, result: { collections: [] } });
    await expect(
      h.route({ type: 'collections.delete_shared', collectionId: 'shared-1' }),
    ).resolves.toMatchObject({
      ok: true,
      result: { collectionId: 'shared-1' },
    });
    expect(recorded.hosted).toEqual(['listShared', 'deleteShared:shared-1']);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });
});
