// CAN-4489 Q: selected CAN-5512 persistence, scheduler and publication evidence
// from db7db93a5bb (5c15612d262^); assertions retained, host fixtures updated.
import type * as WorktreeSummaryPersistence from '../lib/worktree-summary-persistence';
import type * as SummaryPublication from '../ledger/summary-publication';
import type * as ResolveWorktree from '../lib/resolve-worktree';
import type * as WorkspaceSource from '../lib/workspace-source';
import type * as WorkspaceRegistry from '../lib/workspace-registry';
import type * as Git from '../lib/git';
import type * as Paths from '../lib/paths';
import type * as SummaryReconciliation from '../ledger/summary-reconciliation';

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  readdir: jest.fn().mockResolvedValue([]),
  stat: jest.fn(),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));

jest.mock('../lib/worktree-summary-persistence', () => ({
  ...jest.requireActual<typeof WorktreeSummaryPersistence>(
    '../lib/worktree-summary-persistence',
  ),
  readWorktreeSummary: jest.fn(),
  readWorktreeSummaryWriteAbortReason: jest.fn(),
  writeWorktreeSummarySnapshot: jest.fn(),
}));

const mockLedgerEnabled = jest.fn<boolean, []>(() => false);
const mockTurnRunning = jest.fn<boolean, [string, string]>(() => false);

jest.mock('../agents/session-manager', () => ({
  hasActiveChatTurnsForWorktree: (
    projectId: string,
    worktreeId: string,
  ): boolean => mockTurnRunning(projectId, worktreeId),
}));

jest.mock('../ledger/summary-publication', () => ({
  ...jest.requireActual<typeof SummaryPublication>(
    '../ledger/summary-publication',
  ),
  DESKTOP_SUMMARY_PUBLICATION_HOST: {
    isEnabled: (): boolean => mockLedgerEnabled(),
  },
  isSummaryScopePublishable: (): boolean => mockLedgerEnabled(),
  reportAbortedSummaryWrite: jest.fn(),
  reportDroppedSummarySnapshots: jest.fn(),
  reportInvalidSummarySnapshots: jest.fn(),
  reportReplacedSummaryFile: jest.fn(),
  reportStrippedSummaryProvenance: jest.fn(),
}));

jest.mock('../ledger/summary-reconciliation', () => ({
  publishPendingSummarySnapshots: jest.fn(),
}));

jest.mock('../lib/worktree-summary-generator', () => ({
  generateWorktreeSummary: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  ...jest.requireActual<typeof ResolveWorktree>('../lib/resolve-worktree'),
  resolveWorktreeCwd: jest.fn(() => '/repo'),
  resolveWorktreeSummaryFilePath: jest.fn(),
}));

jest.mock('../lib/workspace-source', () => ({
  ...jest.requireActual<typeof WorkspaceSource>('../lib/workspace-source'),
  readEffectiveWorkspaceConfig: jest.fn(),
}));

const mockIsCoworkWorkspace = jest.fn<boolean, [string]>(() => false);

jest.mock('../lib/workspace-registry', () => ({
  ...jest.requireActual<typeof WorkspaceRegistry>('../lib/workspace-registry'),
  isMultiRepoWorkspace: jest.fn(() => false),
  isCoworkWorkspace: (projectId: string): boolean =>
    mockIsCoworkWorkspace(projectId),
  isWorkEntryWorkspace: (projectId: string): boolean =>
    projectId === 'app-advisor' || mockIsCoworkWorkspace(projectId),
}));

jest.mock('../lib/git', () => ({
  ...jest.requireActual<typeof Git>('../lib/git'),
  getRemoteDefaultBranch: jest.fn(),
  getComparisonDiff: jest.fn(),
  getUncommittedDiff: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof Paths>('../lib/paths'),
  getWorkspaceWorktreeRepoDir: jest.fn(() => '/repo'),
}));

jest.mock('../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
}));

jest.mock('../lib/helper-plugin-resolution', () => ({
  withResolvedHelperPlugins: jest.fn(),
}));

const mockIsE2eBuild = jest.fn<boolean, []>();

jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));

const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined]
>(() => Promise.resolve(false));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    modelId: string | undefined,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(modelId),
}));

const startObservedTaskMock = jest.fn();
const finalizeObservedTaskMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: startObservedTaskMock,
    finalizeObservedTask: finalizeObservedTaskMock,
  })),
}));

import {
  IPC_CHANNELS,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type ChatTabsFile,
  type PreferencesData,
  type WorktreeSummaryData,
  type WorktreeSummaryProvenance,
} from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../lib/preferences-store';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import {
  readWorktreeSummary,
  readWorktreeSummaryWriteAbortReason,
  writeWorktreeSummarySnapshot,
  type WorktreeSummaryWriteResult,
} from '../lib/worktree-summary-persistence';
import {
  reportAbortedSummaryWrite,
  reportDroppedSummarySnapshots,
  reportInvalidSummarySnapshots,
  reportReplacedSummaryFile,
  reportStrippedSummaryProvenance,
} from '../ledger/summary-publication';
import { publishPendingSummarySnapshots } from '../ledger/summary-reconciliation';
import {
  generateWorktreeSummary,
  type WorktreeSummaryResult,
} from '../lib/worktree-summary-generator';
import {
  getComparisonDiff,
  getRemoteDefaultBranch,
  getUncommittedDiff,
} from '../lib/git';
import { getWorkspaceWorktreeRepoDir } from '../lib/paths';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { sendToAllWindows } from '../lib/window-send';
import { withResolvedHelperPlugins } from '../lib/helper-plugin-resolution';
import { backgroundHelperQueueTestExports } from '../lib/background-helper-queue';
import {
  readEffectiveWorkspaceConfig,
  type EffectiveWorkspaceConfig,
} from '../lib/workspace-source';
import {
  cancelScheduledGeneration,
  triggerManualRefresh,
} from '../lib/worktree-summary-scheduler';

const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedReadWorktreeSummary = jest.mocked(readWorktreeSummary);
const mockedWriteWorktreeSummary = jest.mocked(writeWorktreeSummarySnapshot);
const mockedReadWriteAbortReason = jest.mocked(
  readWorktreeSummaryWriteAbortReason,
);
const mockedPublishPending = jest.mocked(publishPendingSummarySnapshots);
const mockedReportDropped = jest.mocked(reportDroppedSummarySnapshots);
const mockedReportReplaced = jest.mocked(reportReplacedSummaryFile);
const mockedReportAborted = jest.mocked(reportAbortedSummaryWrite);
const mockedReportInvalid = jest.mocked(reportInvalidSummarySnapshots);
const mockedReportStripped = jest.mocked(reportStrippedSummaryProvenance);
const mockedGenerateWorktreeSummary = jest.mocked(generateWorktreeSummary);
const mockedGetRemoteDefaultBranch = jest.mocked(getRemoteDefaultBranch);
const mockedGetComparisonDiff = jest.mocked(getComparisonDiff);
const mockedGetUncommittedDiff = jest.mocked(getUncommittedDiff);
const mockedGetWorkspaceWorktreeRepoDir = jest.mocked(
  getWorkspaceWorktreeRepoDir,
);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedReadEffectiveWorkspaceConfig = jest.mocked(
  readEffectiveWorkspaceConfig,
);
const mockedSendToAllWindows = jest.mocked(sendToAllWindows);
const mockedWithResolvedHelperPlugins = jest.mocked(withResolvedHelperPlugins);

initClaudeModels([
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'sonnet', label: 'Sonnet' },
]);
initCodexModels([
  { id: 'gpt-5.5', label: 'GPT 5.5' },
  { id: 'o4-mini', label: 'o4-mini' },
]);
initClaudeModels([
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
]);
initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });

jest.mock('../lib/atomic-file', () => ({ writeFileAtomically: jest.fn() }));
jest.mock('../lib/worktree-display-label', () => ({
  readWorktreeDisplayLabelContext: jest.fn().mockResolvedValue({}),
  applyGeneratedDisplayLabel: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: jest.fn().mockResolvedValue(undefined),
}));

import { mkdir, readFile } from 'node:fs/promises';
import { MAX_TELEMETRY_SUMMARIES_PER_WORKTREE } from '@canopy/protocol';
import type {
  WorktreeSummaryFile,
  WorktreeSummarySnapshot,
} from '@canopy/desktop-shared/types';
import type {
  LedgerContainer,
  LedgerEntrySearchItem,
} from '@canopy/protocol/canopy-core';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { LEDGER_COMMAND_OPERATIONS } from '@canopy/desktop-shared/node/ledger';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import {
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from '../ledger/__tests__/fixtures/in-process-ledger-store-client';
import type {
  SummaryPublicationHost,
  SummaryScope,
} from '../ledger/summary-publication';
import type { SummaryReconciliationHost } from '../ledger/summary-reconciliation';
import { writeFileAtomically } from '../lib/atomic-file';
import { resolveWorktreeSummaryFilePath } from '../lib/resolve-worktree';
import type { WorktreeSummaryChangeListener } from '../lib/worktree-summary-persistence';

{
  const {
    addWorktreeSummaryChangeListener,
    removeWorktreeSummaryChangeListener,
    writeWorktreeSummarySnapshot,
    readWorktreeSummaryFile,
  } = jest.requireActual<typeof WorktreeSummaryPersistence>(
    '../lib/worktree-summary-persistence',
  );
  function lastWrittenFile(): WorktreeSummaryFile {
    const calls = mockedWriteFileAtomically.mock.calls;
    const raw = calls[calls.length - 1][1];
    if (typeof raw !== 'string') {
      throw new Error('expected a string write payload');
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing JSON this test itself produced.
    const parsed: WorktreeSummaryFile = JSON.parse(raw);
    return parsed;
  }

  const mockedMkdir = jest.mocked(mkdir);
  const mockedReadFile = jest.mocked(readFile);
  const mockedWriteFileAtomically = jest.mocked(writeFileAtomically);
  const mockedResolveWorktreeSummaryFilePath = jest.mocked(
    resolveWorktreeSummaryFilePath,
  );

  function makeSummary(): WorktreeSummaryData {
    return {
      title: 'Summary title',
      description: 'Summary description',
      highlights: ['One', 'Two'],
      generatedAt: '2026-03-25T12:00:00.000Z',
      turnCountAtGeneration: 3,
      lastFullRefreshAt: '2026-03-25T12:00:00.000Z',
      lastFullRefreshTurnCount: 3,
    };
  }

  describe('writeWorktreeSummarySnapshot', () => {
    const provenance: WorktreeSummaryProvenance = {
      generationId: 'generation-1',
      harness: 'claude',
      model: 'claude-sonnet',
      thinkingEffort: 'medium',
      observedTaskKey: 'helper:worktree-summary:project-a/wt-1:1',
      capturedAt: '2026-09-30T12:00:00.000Z',
      ledgerPublishable: true,
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockedResolveWorktreeSummaryFilePath.mockReturnValue(
        '/tmp/project-a/summaries/wt-1.json',
      );
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFileAtomically.mockResolvedValue(undefined);
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    });

    it('records provenance on a new snapshot', async () => {
      const listener = jest.fn<
        void,
        Parameters<WorktreeSummaryChangeListener>
      >();
      addWorktreeSummaryChangeListener(listener);
      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        makeSummary(),
        provenance,
      ).finally(() => removeWorktreeSummaryChangeListener(listener));
      // Telemetry hears about the change without the provenance.
      expect(Object.keys(listener.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
        'isNewSnapshot',
        'projectId',
        'snapshotId',
        'summary',
        'worktreeId',
      ]);

      expect(result).toMatchObject({
        isNewSnapshot: true,
        snapshot: { provenance },
        droppedPublishableSnapshotIds: [],
        replacedCorruptFile: false,
      });
      expect(lastWrittenFile().history[0].provenance).toEqual(provenance);
    });

    it('writes nothing while the existing file cannot be read', async () => {
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );

      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        makeSummary(),
        provenance,
      );

      // Its unpublished snapshots stay for a later write or reconciliation.
      expect(result).toEqual({ kind: 'aborted', reason: 'unreadable' });
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    });

    it.each([3, 2.5])(
      'writes nothing over a version %s file a newer app wrote',
      async (version) => {
        const summary = makeSummary();
        mockedReadFile.mockResolvedValue(
          JSON.stringify({
            version,
            summary,
            history: [{ snapshotId: 'snap-1', summary, provenance }],
          }),
        );
        const listener = jest.fn<
          void,
          Parameters<WorktreeSummaryChangeListener>
        >();
        addWorktreeSummaryChangeListener(listener);

        const result = await writeWorktreeSummarySnapshot(
          'project-a',
          'wt-1',
          { ...summary, description: 'A different description' },
          provenance,
        ).finally(() => removeWorktreeSummaryChangeListener(listener));

        expect(result).toEqual({ kind: 'aborted', reason: 'future_version' });
        expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
      },
    );

    it('still replaces a file whose version is not a number', async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ version: '3', summary: makeSummary(), history: [] }),
      );

      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        makeSummary(),
        provenance,
      );

      expect(result).toMatchObject({
        kind: 'written',
        replacedCorruptFile: true,
      });
    });

    it('counts the history entries and publishable provenance it discards', async () => {
      const summary = makeSummary();
      const invalidProvenance = { ...provenance, generationId: '' };
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 2,
          summary,
          history: [
            { snapshotId: '', summary },
            { snapshotId: 'snap-broken', summary: { title: 'x' } },
            'not a snapshot',
            {
              snapshotId: 'snap-stripped',
              summary,
              provenance: invalidProvenance,
            },
            {
              snapshotId: 'snap-unpublishable',
              summary,
              provenance: { ...invalidProvenance, ledgerPublishable: false },
            },
            { snapshotId: 'snap-kept', summary, provenance },
          ],
        }),
      );

      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        { ...summary, description: 'A different description' },
        provenance,
      );

      expect(result).toMatchObject({
        kind: 'written',
        droppedInvalidSnapshotCount: 3,
        strippedPublishableSnapshotIds: ['snap-stripped'],
        droppedPublishableSnapshotIds: [],
        replacedCorruptFile: false,
      });
      const history = lastWrittenFile().history;
      expect(history.map((snapshot) => snapshot.snapshotId)).toEqual([
        'snap-stripped',
        'snap-unpublishable',
        'snap-kept',
        expect.any(String),
      ]);
      expect(history[0]?.provenance).toBeUndefined();
      expect(history[2]?.provenance).toEqual(provenance);
    });

    it('discards nothing from a valid or legacy file', async () => {
      const summary = makeSummary();
      mockedReadFile.mockResolvedValue(JSON.stringify({ version: 1, summary }));

      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        summary,
        provenance,
      );

      expect(result).toMatchObject({
        kind: 'written',
        isNewSnapshot: false,
        droppedInvalidSnapshotCount: 0,
        strippedPublishableSnapshotIds: [],
      });
    });

    it.each([
      ['is not JSON', '{"version": 2, "history": ['],
      ['is not a summary file', JSON.stringify({ version: 2, history: 'x' })],
    ])(
      'replaces an existing file that %s and reports it',
      async (_case, content) => {
        mockedReadFile.mockResolvedValue(content);

        const result = await writeWorktreeSummarySnapshot(
          'project-a',
          'wt-1',
          makeSummary(),
          provenance,
        );

        expect(result).toMatchObject({
          isNewSnapshot: true,
          replacedCorruptFile: true,
        });
        expect(lastWrittenFile().history).toEqual([
          result?.kind === 'written' ? result.snapshot : null,
        ]);
      },
    );

    it('keeps the matched snapshot and its provenance when nothing changed', async () => {
      const summary = makeSummary();
      const existing: WorktreeSummarySnapshot = {
        snapshotId: 'snap-1',
        summary,
        provenance: { ...provenance, generationId: 'generation-0' },
      };
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ version: 2, summary, history: [existing] }),
      );

      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        { ...summary, generatedAt: '2026-09-30T13:00:00.000Z' },
        provenance,
      );

      expect(result).toMatchObject({
        isNewSnapshot: false,
        snapshot: existing,
      });
      expect(lastWrittenFile().history).toEqual([existing]);
    });

    it('reports the publishable snapshots the history cap drops', async () => {
      const seeded: WorktreeSummarySnapshot[] = Array.from(
        { length: MAX_TELEMETRY_SUMMARIES_PER_WORKTREE },
        (_unused, index) => ({
          snapshotId: `snap-${index}`,
          summary: { ...makeSummary(), description: `desc-${index}` },
          ...(index === 0 ? { provenance } : {}),
        }),
      );
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 2,
          summary: seeded[seeded.length - 1].summary,
          history: seeded,
        }),
      );

      const result = await writeWorktreeSummarySnapshot(
        'project-a',
        'wt-1',
        { ...makeSummary(), description: 'desc-new' },
        provenance,
      );

      expect(result).toMatchObject({
        droppedPublishableSnapshotIds: ['snap-0'],
      });
    });
    it('normalizes a v1 file to v2 with a single history entry', async () => {
      const summary = makeSummary();
      mockedReadFile.mockResolvedValue(JSON.stringify({ version: 1, summary }));

      const file = await readWorktreeSummaryFile('project-a', 'wt-1');

      expect(file?.version).toBe(2);
      expect(file?.summary).toEqual(summary);
      expect(file?.history).toHaveLength(1);
      expect(file?.history[0].summary).toEqual(summary);
    });
  });
}
function makeChatTabs(turns: number): ChatTabsFile {
  return {
    version: 1,
    activeTabId: 'tab-1',
    tabs: [
      {
        id: 'tab-1',
        title: 'Main',
        createdAt: '2026-03-25T10:00:00.000Z',
        messages: Array.from({ length: turns }).flatMap((_, index) => [
          {
            id: `u-${index}`,
            role: 'user' as const,
            timestamp: index * 2 + 1,
            blocks: [{ type: 'text' as const, text: `User turn ${index + 1}` }],
          },
          {
            id: `a-${index}`,
            role: 'assistant' as const,
            timestamp: index * 2 + 2,
            blocks: [
              { type: 'text' as const, text: `Assistant reply ${index + 1}` },
            ],
          },
        ]),
      },
    ],
  };
}

function makePreferences(): PreferencesData {
  return {
    ...DEFAULT_PREFERENCES,
    worktreeSummaryEnabled: true,
    worktreeSummaryModel: 'claude-haiku-4-5-20251001',
    worktreeSummaryThinkingLevel: 'off',
  };
}
function makeSummaryData(turnCountAtGeneration: number): WorktreeSummaryData {
  return {
    title: 'Summary',
    description: 'Description',
    highlights: ['One highlight'],
    generatedAt: '2026-03-25T10:00:00.000Z',
    turnCountAtGeneration,
    lastFullRefreshAt: '2026-03-25T10:00:00.000Z',
    lastFullRefreshTurnCount: turnCountAtGeneration,
  };
}

function makeSummary(turnCountAtGeneration: number): WorktreeSummaryResult {
  return {
    summary: makeSummaryData(turnCountAtGeneration),
    displayLabel: null,
    usage: {},
  };
}

function makeEffectiveWorkspaceConfig(
  overrides: Partial<EffectiveWorkspaceConfig> = {},
): EffectiveWorkspaceConfig {
  return {
    sourceRepoPath: undefined,
    manifest: null,
    repos: [],
    scripts: undefined,
    defaultPluginSelections: undefined,
    suppressedRepoIds: undefined,
    suppressedManifestRepos: [],
    unresolvedManifestRepoIds: [],
    localConfig: {
      version: 1,
      type: 'multi-repo',
      repos: [],
    },
    ...overrides,
  };
}

/** A write that appended a new snapshot carrying `provenance`. */
function newSnapshotWrite(
  summary: WorktreeSummaryData,
  provenance?: WorktreeSummaryProvenance,
): WorktreeSummaryWriteResult {
  return {
    kind: 'written',
    snapshot: {
      snapshotId: 'snapshot-new',
      summary,
      ...(provenance === undefined ? {} : { provenance }),
    },
    isNewSnapshot: true,
    droppedPublishableSnapshotIds: [],
    strippedPublishableSnapshotIds: [],
    droppedInvalidSnapshotCount: 0,
    replacedCorruptFile: false,
  };
}

async function flushMicrotasks(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
}

describe('worktree summary scheduler', () => {
  let runtime: ReturnType<typeof createDesktopRuntime>;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    backgroundHelperQueueTestExports.reset();
    mockIsE2eBuild.mockReturnValue(false);
    mockIsCoworkWorkspace.mockReturnValue(false);
    mockIsModelBlockedByStoredPolicy.mockReset();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    startObservedTaskMock.mockReset();
    finalizeObservedTaskMock.mockReset();
    mockedReadPreferencesFile.mockResolvedValue(makePreferences());
    mockedReadChatTabsFile.mockResolvedValue(makeChatTabs(2));
    mockedReadWorktreeSummary.mockResolvedValue(makeSummaryData(1));
    mockedReadWriteAbortReason.mockResolvedValue(null);
    jest
      .mocked(readFile)
      .mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    mockedGenerateWorktreeSummary.mockResolvedValue(makeSummary(2));
    mockLedgerEnabled.mockReturnValue(false);
    mockTurnRunning.mockReturnValue(false);
    mockedWriteWorktreeSummary.mockImplementation(
      (_projectId, _worktreeId, summary, provenance) =>
        Promise.resolve(newSnapshotWrite(summary, provenance)),
    );
    mockedGetRemoteDefaultBranch.mockResolvedValue(null);
    mockedGetComparisonDiff.mockResolvedValue('');
    mockedGetUncommittedDiff.mockResolvedValue('');
    mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
      (_projectId, _worktreeId, repoId): string => `/repo/repos/${repoId}`,
    );
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    mockedReadEffectiveWorkspaceConfig.mockResolvedValue(
      makeEffectiveWorkspaceConfig(),
    );
    runtime = createDesktopRuntime();
    mockedWithResolvedHelperPlugins.mockImplementation((_, run) => {
      const pluginRuntime: Parameters<typeof run>[0] = {
        claudePlugins: [],
        claudeMcpServers: {},
        codexCapabilityRoots: [],
        codexMcpServers: {},
      };
      return run(pluginRuntime);
    });
  });

  afterEach(async () => {
    cancelScheduledGeneration('proj', 'wt');
    await runtime.shutdown();
    backgroundHelperQueueTestExports.reset();
    jest.useRealTimers();
  });

  it('publishes a new snapshot, in order with any earlier pending one', async () => {
    mockLedgerEnabled.mockReturnValue(true);

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedPublishPending).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
    });
  });

  it('reports publishable snapshots the history cap dropped', async () => {
    mockLedgerEnabled.mockReturnValue(true);
    mockedWriteWorktreeSummary.mockImplementation(
      (_projectId, _worktreeId, summary, provenance) =>
        Promise.resolve({
          ...newSnapshotWrite(summary, provenance),
          droppedPublishableSnapshotIds: ['snapshot-old'],
        }),
    );

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedReportDropped).toHaveBeenCalledWith(
      { projectId: 'proj', worktreeId: 'wt' },
      ['snapshot-old'],
    );
    expect(mockedReportReplaced).not.toHaveBeenCalled();
  });

  it('reports a summary file that did not parse and was replaced', async () => {
    mockLedgerEnabled.mockReturnValue(true);
    mockedWriteWorktreeSummary.mockImplementation(
      (_projectId, _worktreeId, summary, provenance) =>
        Promise.resolve({
          ...newSnapshotWrite(summary, provenance),
          replacedCorruptFile: true,
        }),
    );

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    expect(mockedReportReplaced).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
    });
    // The new snapshot still publishes.
    expect(mockedPublishPending).toHaveBeenCalledTimes(1);
  });

  it('reports what the write discarded from the history it read', async () => {
    mockLedgerEnabled.mockReturnValue(true);
    mockedWriteWorktreeSummary.mockImplementation(
      (_projectId, _worktreeId, summary, provenance) =>
        Promise.resolve({
          ...newSnapshotWrite(summary, provenance),
          strippedPublishableSnapshotIds: ['snapshot-stripped'],
          droppedInvalidSnapshotCount: 2,
        }),
    );

    triggerManualRefresh('proj', 'wt', () => null);
    await flushMicrotasks();

    const scope = { projectId: 'proj', worktreeId: 'wt' };
    expect(mockedReportStripped).toHaveBeenCalledWith(scope, [
      'snapshot-stripped',
    ]);
    expect(mockedReportInvalid).toHaveBeenCalledWith(scope, 2);
    expect(mockedPublishPending).toHaveBeenCalledTimes(1);
  });

  it.each(['unreadable', 'future_version'] as const)(
    'reports a write aborted because the file is %s, and publishes nothing',
    async (reason) => {
      mockLedgerEnabled.mockReturnValue(true);
      mockedWriteWorktreeSummary.mockResolvedValue({
        kind: 'aborted',
        reason,
      });

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedReportAborted).toHaveBeenCalledWith(
        { projectId: 'proj', worktreeId: 'wt' },
        reason,
      );
      expect(mockedPublishPending).not.toHaveBeenCalled();
      expect(
        mockedSendToAllWindows.mock.calls.filter(
          (call) => call[0] === IPC_CHANNELS.worktreeSummaryUpdated,
        ),
      ).toHaveLength(0);
    },
  );

  it.each(['unreadable', 'future_version'] as const)(
    'generates nothing over a summary file that is %s',
    async (reason) => {
      mockLedgerEnabled.mockReturnValue(true);
      mockedReadWriteAbortReason.mockResolvedValue(reason);

      triggerManualRefresh('proj', 'wt', () => null);
      await flushMicrotasks();

      expect(mockedReportAborted).toHaveBeenCalledTimes(1);
      expect(mockedReportAborted).toHaveBeenCalledWith(
        { projectId: 'proj', worktreeId: 'wt' },
        reason,
      );
      expect(mockedGenerateWorktreeSummary).not.toHaveBeenCalled();
      expect(mockedWriteWorktreeSummary).not.toHaveBeenCalled();
      expect(
        mockedSendToAllWindows.mock.calls.filter(
          (call) => call[0] === IPC_CHANNELS.worktreeSummaryGenerating,
        ),
      ).toHaveLength(0);
    },
  );
});

{
  const {
    reportAbortedSummaryWrite,
    reportDroppedSummarySnapshots,
    reportInvalidSummarySnapshots,
    reportReplacedSummaryFile,
    reportStrippedSummaryProvenance,
  } = jest.requireActual<typeof SummaryPublication>(
    '../ledger/summary-publication',
  );
  const { publishPendingSummarySnapshots } = jest.requireActual<
    typeof SummaryReconciliation
  >('../ledger/summary-reconciliation');
  const filesystemServices = {
    listFileTreeRoots: (): Promise<{ roots: [] }> =>
      Promise.resolve({ roots: [] }),
    listFileTreeDirectory: (): Promise<{ entries: [] }> =>
      Promise.resolve({ entries: [] }),
  };

  // The harness binds TEST_CONTAINER: worktree-1 of workspace-1.
  const SCOPE: SummaryScope = {
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
  };

  function summary(title: string): WorktreeSummaryData {
    return {
      title,
      description: `${title} in detail.`,
      highlights: [`${title} highlight`],
      generatedAt: '2026-09-30T12:00:00.000Z',
      turnCountAtGeneration: 3,
      lastFullRefreshAt: '2026-09-30T12:00:00.000Z',
      lastFullRefreshTurnCount: 3,
    };
  }

  function provenance(
    generationId: string,
    overrides: Partial<WorktreeSummaryProvenance> = {},
  ): WorktreeSummaryProvenance {
    return {
      generationId,
      harness: 'claude',
      model: 'claude-haiku',
      thinkingEffort: 'low',
      observedTaskKey: `helper:worktree-summary:workspace-1/worktree-1:${generationId}`,
      capturedAt: '2026-09-30T11:59:00.000Z',
      ledgerPublishable: true,
      ...overrides,
    };
  }

  function snapshot(
    snapshotId: string,
    title: string,
    snapshotProvenance?: WorktreeSummaryProvenance,
  ): WorktreeSummarySnapshot {
    return {
      snapshotId,
      summary: summary(title),
      ...(snapshotProvenance === undefined
        ? {}
        : { provenance: snapshotProvenance }),
    };
  }

  describe('Summary publication', () => {
    let harness: LedgerServiceHarness;
    let dispatcher: ReturnType<typeof createDesktopRuntime>;
    let state: {
      enabled: boolean;
      createdAt: string | null;
      history: WorktreeSummarySnapshot[];
    };
    let gaps: string[];
    let host: SummaryPublicationHost;
    let reconciliation: SummaryReconciliationHost;

    function summaryEntries(): LedgerEntrySearchItem[] {
      const scopes = harness.store.repository.listScopes();
      return scopes.flatMap(
        (scope) =>
          harness.store.repository.searchEntries({
            ledgerId: scope.scope.ledgerId,
            types: ['SUMMARY'],
            sort: 'created_desc',
          }).entries,
      );
    }

    beforeEach(() => {
      let lastStoreMs = 0;
      harness = createLedgerServiceHarness({
        store: {
          now: (): Date => {
            lastStoreMs = Math.max(Date.now(), lastStoreMs + 1);
            return new Date(lastStoreMs);
          },
        },
      });
      dispatcher = createDesktopRuntime({
        services: filesystemServices,
        ledgerService: harness.service,
      });
      state = {
        enabled: true,
        createdAt: TEST_CONTAINER_CREATED_AT,
        history: [],
      };
      gaps = [];
      host = {
        isEnabled: (): boolean => state.enabled,
        dispatcher: (): ReturnType<SummaryPublicationHost['dispatcher']> =>
          dispatcher,
        registry: (): LedgerServiceHarness['bindings'] => harness.bindings,
        container: (projectId, worktreeId): LedgerContainer | null =>
          projectId === SCOPE.projectId && worktreeId === SCOPE.worktreeId
            ? TEST_CONTAINER
            : null,
        containerCreatedAt: (): Promise<string | null> =>
          Promise.resolve(state.createdAt),
        ledgerId: async (container, containerCreatedAt): Promise<string> =>
          (await harness.service.scopes.resolve(container, containerCreatedAt))
            .ledgerId,
        publishedKeys: (ledgerId, keys): Promise<string[]> =>
          harness.store.client.listReceiptKeys({
            ledgerId,
            operation: LEDGER_COMMAND_OPERATIONS.publishSummary,
            idempotencyKeys: keys,
          }),
        recordGap: (reason): void => {
          gaps.push(reason);
        },
      };
      reconciliation = {
        publication: host,
        listScopes: (): Promise<SummaryScope[]> => Promise.resolve([SCOPE]),
        readHistory: (): Promise<readonly WorktreeSummarySnapshot[]> =>
          Promise.resolve(state.history),
      };
    });

    afterEach(async () => {
      await dispatcher.shutdown();
      harness.dispose();
    });

    it('keeps order: a failed publication holds back later snapshots', async () => {
      state.history = [
        snapshot('snapshot-1', 'Adds login', provenance('gen-1')),
        snapshot('snapshot-2', 'Adds logout', provenance('gen-2')),
      ];
      harness.store.client.failNext('publishSummary', new Error('busy'));

      await expect(
        publishPendingSummarySnapshots(SCOPE, reconciliation),
      ).resolves.toEqual({ published: 0, pending: 2 });
      expect(summaryEntries()).toEqual([]);

      await expect(
        publishPendingSummarySnapshots(SCOPE, reconciliation),
      ).resolves.toEqual({ published: 2, pending: 0 });
      expect(summaryEntries().map((entry) => entry.title)).toEqual([
        'Adds logout',
        'Adds login',
      ]);
    });

    it('reports and skips a snapshot the Ledger rejects', async () => {
      state.history = [
        // Nothing but a control character: the projection has no title left.
        snapshot('snapshot-1', '\u0007', provenance('gen-1')),
        snapshot('snapshot-2', 'Adds logout', provenance('gen-2')),
      ];

      await expect(
        publishPendingSummarySnapshots(SCOPE, reconciliation),
      ).resolves.toEqual({ published: 1, pending: 1 });

      expect(gaps).toEqual(['rejected: 1']);
      expect(summaryEntries().map((entry) => entry.title)).toEqual([
        'Adds logout',
      ]);
    });

    it('reports dropped snapshots that never published, by count only', async () => {
      state.history = [
        snapshot('snapshot-1', 'Adds login', provenance('gen-1')),
      ];
      await publishPendingSummarySnapshots(SCOPE, reconciliation);

      await reportDroppedSummarySnapshots(
        SCOPE,
        ['snapshot-1', 'snapshot-unpublished'],
        host,
      );
      expect(gaps).toEqual(['aged_out: 1']);

      host = {
        ...host,
        publishedKeys: (): Promise<string[]> =>
          Promise.reject(new Error('storage unavailable')),
      };
      await reportDroppedSummarySnapshots(SCOPE, ['snapshot-1'], host);
      expect(gaps).toEqual(['aged_out: 1', 'aged_out_unverified: 1']);
    });

    it('reports a replaced summary file only while the Ledger is on', () => {
      reportReplacedSummaryFile(SCOPE, host);
      expect(gaps).toEqual(['journal_replaced: 1']);

      state.enabled = false;
      reportReplacedSummaryFile(SCOPE, host);
      reportReplacedSummaryFile({ projectId: 'other', worktreeId: 'wt' }, host);
      expect(gaps).toEqual(['journal_replaced: 1']);
    });

    it('reports an aborted summary write only while the Ledger is on', () => {
      reportAbortedSummaryWrite(SCOPE, 'unreadable', host);
      reportAbortedSummaryWrite(SCOPE, 'future_version', host);
      expect(gaps).toEqual([
        'journal_unreadable: 1',
        'journal_future_version: 1',
      ]);

      state.enabled = false;
      reportAbortedSummaryWrite(SCOPE, 'future_version', host);
      expect(gaps).toHaveLength(2);
    });

    it('reports invalid history entries a write dropped, by count only', () => {
      reportInvalidSummarySnapshots(SCOPE, 0, host);
      reportInvalidSummarySnapshots(SCOPE, 3, host);
      reportInvalidSummarySnapshots(
        { projectId: 'other', worktreeId: 'wt' },
        2,
        host,
      );
      expect(gaps).toEqual(['journal_entries_dropped: 3']);
    });

    it('reports stripped provenance of snapshots that never published, by count only', async () => {
      state.history = [
        snapshot('snapshot-1', 'Adds login', provenance('gen-1')),
      ];
      await publishPendingSummarySnapshots(SCOPE, reconciliation);

      await reportStrippedSummaryProvenance(
        SCOPE,
        ['snapshot-1', 'snapshot-unpublished'],
        host,
      );
      await reportStrippedSummaryProvenance(SCOPE, [], host);
      expect(gaps).toEqual(['provenance_stripped: 1']);

      state.enabled = false;
      await reportStrippedSummaryProvenance(SCOPE, ['snapshot-2'], host);
      expect(gaps).toEqual([
        'provenance_stripped: 1',
        'provenance_stripped_unverified: 1',
      ]);
    });
  });
}
