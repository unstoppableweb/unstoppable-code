import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryTarget } from '@canopy/protocol/canopy-core';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type * as MemoryHostModule from '../advisor-memory-actions-host';
import type {
  AdvisorMemoryActionHost,
  PersonConfirmation,
} from '../advisor-memory-actions';

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

let mockHost: AdvisorMemoryActionHost;
jest.mock('../advisor-memory-actions-host', () => ({
  mainAdvisorMemoryActionHost: (): AdvisorMemoryActionHost => mockHost,
}));

import { BRAND } from '@canopy/brand/current';
import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { ADVISOR_MEMORY_ACTION_TYPES } from '../advisor-memory-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const PROJECT: MemoryTarget = { scope: 'workspace', workspaceId: 'ws' };

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;

interface Recorded {
  consolidated: MemoryTarget[];
  rebuilt: Array<{ target: MemoryTarget; expectedRevision: string }>;
  restored: Array<{ snapshotId: string; expectedRevision: string }>;
  imported: Array<{ workspaceId: string | undefined; digest: string }>;
  questions: string[];
}
let recorded: Recorded;
let answer: PersonConfirmation;
let sources: Array<{ tool: 'claude-code' | 'codex'; label: string }>;

const STATUS = {
  pendingNotes: 1,
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastReason: null,
  lastConsolidatedAt: null,
};

function recordingHost(): AdvisorMemoryActionHost {
  return {
    consolidate: (target) => {
      recorded.consolidated.push(target);
      return Promise.resolve(STATUS);
    },
    listSnapshots: () =>
      Promise.resolve({
        revision: 'rev-1',
        snapshots: [
          {
            snapshotId: 'snap-1',
            createdAt: '2026-11-08T00:00:00.000Z',
            reason: 'consolidation',
            topicCount: 3,
          },
        ],
      }),
    rebuild: (target, expectedRevision) => {
      recorded.rebuilt.push({ target, expectedRevision });
      return Promise.resolve({
        status: 'completed',
        reason: null,
        snapshotId: 'snap-2',
        restoredInboxNotes: 4,
        restoredImports: 1,
        runs: 2,
        consolidation: STATUS,
      });
    },
    restoreSnapshot: (_target, snapshotId, expectedRevision) => {
      recorded.restored.push({ snapshotId, expectedRevision });
      return Promise.resolve({
        status: 'restored',
        reason: null,
        previousSnapshotId: 'snap-3',
      });
    },
    importSources: () => Promise.resolve({ digest: 'digest-1', sources }),
    importExternal: (workspaceId, digest) => {
      recorded.imported.push({ workspaceId, digest });
      return Promise.resolve({
        disabled: false,
        staged: sources.length,
        skipped: 0,
        deferred: 0,
        errors: [],
      });
    },
    projectName: () => Promise.resolve('Canopy'),
    confirm: (question) => {
      recorded.questions.push(question);
      return Promise.resolve(answer);
    },
  };
}

function setup(): {
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
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
  return {
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6005-memory-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  recorded = {
    consolidated: [],
    rebuilt: [],
    restored: [],
    imported: [],
    questions: [],
  };
  answer = 'confirmed';
  sources = [
    { tool: 'claude-code', label: 'canopy: MEMORY.md' },
    { tool: 'codex', label: 'Codex: notes.md' },
  ];
  mockHost = recordingHost();
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor memory actions in main (CAN-6005)', () => {
  it('runs as core memory actions with core.memory.write; listing snapshots reads', () => {
    expect(appAdvisorActionDisposition('memory.list_snapshots')).toEqual({
      kind: 'core',
      access: 'read',
      executor: 'memory',
    });
    for (const type of ADVISOR_MEMORY_ACTION_TYPES.filter(
      (entry) => entry !== 'memory.list_snapshots',
    ))
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'memory',
        grants: ['core.memory.write'],
        revision: 'none',
      });
  });

  it("consolidates the user's memory, and a project's only when named", async () => {
    const h = setup();
    await expect(
      h.route({ type: 'memory.consolidate_now' }, { toolUseId: 'c1' }),
    ).resolves.toMatchObject({ ok: true, result: { workspace: null } });
    await expect(
      h.route(
        { type: 'memory.consolidate_now', workspaceId: 'ws' },
        { toolUseId: 'c2' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { user: { pendingNotes: 1 }, workspace: { pendingNotes: 1 } },
    });
    expect(recorded.consolidated).toEqual([
      { scope: 'user' },
      { scope: 'user' },
      PROJECT,
    ]);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('lists snapshots in the window’s shape, and asks for a project when none is named', async () => {
    const h = setup();
    await expect(
      h.route({
        type: 'memory.list_snapshots',
        scope: 'workspace',
        workspaceId: 'ws',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        snapshots: [
          {
            id: 'snap-1',
            createdAt: '2026-11-08T00:00:00.000Z',
            reason: 'consolidation',
            topicCount: 3,
          },
        ],
      },
    });
    await expect(
      h.route(
        { type: 'memory.list_snapshots', scope: 'workspace' },
        { toolUseId: 'l2' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_target' } });
  });

  it('rebuilds only on a person’s answer, naming the revision it asked about, once per tool call', async () => {
    const h = setup();
    for (const refused of ['no_person', 'declined'] as const) {
      answer = refused;
      await expect(
        h.route(
          { type: 'memory.rebuild', scope: 'workspace', workspaceId: 'ws' },
          { toolUseId: `r-${refused}` },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'authorization_conflict' },
      });
    }
    expect(recorded.rebuilt).toEqual([]);
    answer = 'confirmed';
    const input = {
      type: 'memory.rebuild',
      scope: 'workspace',
      workspaceId: 'ws',
    };
    const first = await h.route(input, { toolUseId: 'r-ok' });
    const second = await h.route(input, { toolUseId: 'r-ok' });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      result: { status: 'completed', snapshotId: 'snap-2', pendingNotes: 1 },
    });
    expect(recorded.rebuilt).toEqual([
      { target: PROJECT, expectedRevision: 'rev-1' },
    ]);
    expect(recorded.questions[2]).toContain('the project "Canopy"');
  });

  it('restores only a listed snapshot, on a person’s answer, naming the revision it asked about', async () => {
    const h = setup();
    await expect(
      h.route(
        {
          type: 'memory.restore_snapshot',
          scope: 'user',
          snapshotId: 'missing',
        },
        { toolUseId: 's0' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    answer = 'no_person';
    await expect(
      h.route(
        {
          type: 'memory.restore_snapshot',
          scope: 'user',
          snapshotId: 'snap-1',
        },
        { toolUseId: 's1' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'authorization_conflict' },
    });
    answer = 'confirmed';
    await expect(
      h.route(
        {
          type: 'memory.restore_snapshot',
          scope: 'user',
          snapshotId: 'snap-1',
        },
        { toolUseId: 's2' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { status: 'restored', previousSnapshotId: 'snap-3' },
    });
    expect(recorded.restored).toEqual([
      { snapshotId: 'snap-1', expectedRevision: 'rev-1' },
    ]);
    expect(recorded.questions.at(-1)).toContain('your user memory');
  });

  it('imports only after a person confirms a question that lists the files, naming the listed set', async () => {
    const h = setup();
    answer = 'no_person';
    await expect(
      h.route(
        { type: 'memory.import_external', workspaceId: 'ws' },
        { toolUseId: 'i1' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'authorization_conflict' },
    });
    expect(recorded.imported).toEqual([]);
    answer = 'confirmed';
    await expect(
      h.route(
        { type: 'memory.import_external', workspaceId: 'ws' },
        { toolUseId: 'i2' },
      ),
    ).resolves.toMatchObject({ ok: true, result: { staged: 2 } });
    expect(recorded.imported).toEqual([
      { workspaceId: 'ws', digest: 'digest-1' },
    ]);
    expect(recorded.questions[1]).toBe(
      [
        `Import these 2 memory files from Claude Code and Codex into ${BRAND.displayName} memory?`,
        '- canopy: MEMORY.md',
        '- Codex: notes.md',
      ].join('\n'),
    );
    // However many files there are, the question names every one it reads.
    sources = Array.from({ length: 51 }, (_, index) => ({
      tool: 'claude-code' as const,
      label: `canopy: topic-${index}.md`,
    }));
    await h.route(
      { type: 'memory.import_external', workspaceId: 'ws' },
      { toolUseId: 'i4' },
    );
    for (const source of sources)
      expect(recorded.questions[2]).toContain(`- ${source.label}`);
    sources = [];
    await expect(
      h.route({ type: 'memory.import_external' }, { toolUseId: 'i3' }),
    ).resolves.toMatchObject({ ok: true, result: { staged: 0 } });
    expect(recorded.questions).toHaveLength(3);
  });
});

describe("the memory host's person confirmation (CAN-6005)", () => {
  const { mainAdvisorMemoryActionHost } = jest.requireActual<
    typeof MemoryHostModule
  >('../advisor-memory-actions-host');
  const confirmWith = (
    answers: () => Promise<
      Array<{ selectedOptions: string[]; answeredBy?: 'person' | 'agent' }>
    >,
  ): Promise<PersonConfirmation> =>
    mainAdvisorMemoryActionHost({
      chatId: 'advisor-chat',
      callKey: 'k',
      requestUserAnswers: answers,
    }).confirm('Rebuild?', { confirm: 'Rebuild', decline: 'Cancel' });

  it('confirms only a person’s answer', async () => {
    await expect(
      confirmWith(() =>
        Promise.resolve([
          { selectedOptions: ['Rebuild'], answeredBy: 'person' },
        ]),
      ),
    ).resolves.toBe('confirmed');
    await expect(
      confirmWith(() =>
        Promise.resolve([
          { selectedOptions: ['Rebuild'], answeredBy: 'agent' },
        ]),
      ),
    ).resolves.toBe('no_person');
    await expect(
      confirmWith(() => Promise.resolve([{ selectedOptions: ['Rebuild'] }])),
    ).resolves.toBe('no_person');
    await expect(
      confirmWith(() =>
        Promise.resolve([
          { selectedOptions: ['Cancel'], answeredBy: 'person' },
        ]),
      ),
    ).resolves.toBe('declined');
    await expect(
      confirmWith(() => Promise.reject(new Error('No one is available.'))),
    ).resolves.toBe('no_person');
  });
});
