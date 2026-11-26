/**
 * A feedback bundle leaves out a scope's legacy tabs file once the scope has
 * an authority manifest (CAN-7178 follow-up 2, SWAN 18 Nov). With the format 4
 * switch on, migrated scopes keep that file until format 4 reads back, and
 * nothing reads it again; a scope that is still legacy keeps sending it.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { z } from 'zod';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  MAX_FEEDBACK_ARCHIVE_BYTES,
  MAX_FEEDBACK_ARCHIVE_EXPANDED_BYTES,
} from '@canopy/protocol/feedback-report';

const mockPaths = { root: '' };
let mockWorkEntryIds: string[] = [];
jest.mock('electron', () => ({
  app: {
    getPath: (name: string): string => join(mockPaths.root, name),
    getVersion: (): string => '0.0.0-test',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: (): never[] => [] },
}));
jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<object>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): string => 'linux',
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  ...jest.requireActual<object>('../../lib/cowork-work-entries'),
  listWorkEntryIds: (): Promise<string[]> => Promise.resolve(mockWorkEntryIds),
}));

import { FeedbackBundleBuilder } from '../feedback-archive';
import { feedbackChatDetailsForTests } from '../feedback-bundle';
import { getAgentObservabilityTranscriptFilePath } from '../../lib/paths';
import {
  prepareFeedbackDiagnostics,
  readFeedbackDiagnosticsEntry,
  revokeFeedbackDiagnostics,
} from '../feedback-snapshots';

let dataDir: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  mockPaths.root = await mkdtemp(join(tmpdir(), 'feedback-legacy-tabs-'));
  dataDir = join(mockPaths.root, 'data');
  mockWorkEntryIds = [];
  for (const path of ['data', 'logs', 'temp', 'downloads', 'crashDumps'])
    await mkdir(join(mockPaths.root, path));
  process.env.CANOPY_DATA_DIR = dataDir;
  resetResolvedCanopyDataDirForTests();
});

afterEach(async () => {
  await revokeFeedbackDiagnostics();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(mockPaths.root, { recursive: true, force: true });
});

const ORCHESTRATOR_ROOT = 'app-workspaces/app-advisor';
const REPORTING_STORAGE = `${ORCHESTRATOR_ROOT}/chat-storage-v2/reporting`;
const REPORT_CONTEXT = {
  activePage: 'chat',
  chatProjectId: 'app-advisor',
  workspaceId: 'app-advisor',
  worktreeId: 'reporting',
};

async function sparse(path: string, sizeMiB: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try {
    await handle.truncate(sizeMiB * 1024 * 1024);
  } finally {
    await handle.close();
  }
}

describe('prepared diagnostics for Work Entry chat storage', () => {
  it('attaches an oversized Orchestrator project with only the reporting entry and notes the largest omitted transcript', async () => {
    mockWorkEntryIds = [
      'reporting',
      ...Array.from({ length: 16 }, (_, index) => `other-${index}`),
    ];
    // 348 MiB of source data: the expanded cap fails even though zeros compress.
    for (const id of mockWorkEntryIds)
      await sparse(
        join(dataDir, ORCHESTRATOR_ROOT, 'chat-storage-v2', id, 'large.jsonl'),
        id === 'reporting' ? 16 : 20,
      );
    const medium = `${REPORTING_STORAGE}/medium.jsonl`;
    await sparse(join(dataDir, medium), 12);
    const small = `${REPORTING_STORAGE}/small.jsonl`;
    await put(join(dataDir, small), 'reporting evidence\n');
    const manifest = `${ORCHESTRATOR_ROOT}/chat-storage-manifests/reporting.json`;
    await put(join(dataDir, manifest), '{}');
    const snapshot = await prepareFeedbackDiagnostics('owner', {
      context: REPORT_CONTEXT,
    });
    const paths = snapshot.entries.map((entry) => entry.path);
    expect(snapshot.sizeBytes).toBeLessThanOrEqual(MAX_FEEDBACK_ARCHIVE_BYTES);
    expect(
      snapshot.entries.reduce((size, entry) => size + entry.sizeBytes, 0),
    ).toBeLessThanOrEqual(MAX_FEEDBACK_ARCHIVE_EXPANDED_BYTES);
    expect(paths).toEqual(expect.arrayContaining([small, manifest, medium]));
    expect(paths.some((path) => path.includes('/other-'))).toBe(false);
    expect(snapshot.skippedEntries).toEqual(
      expect.arrayContaining([
        { path: `${REPORTING_STORAGE}/large.jsonl`, reason: 'too-large' },
        {
          path: `${ORCHESTRATOR_ROOT}/chat-storage-v2/other-0`,
          reason: 'policy-excluded',
        },
        { path: 'system-logs/crash-dumps', reason: 'too-large' },
      ]),
    );
    expect(
      await readFeedbackDiagnosticsEntry('owner', snapshot.id, small),
    ).toEqual({ kind: 'text', text: 'reporting evidence\n' });
  });

  it('keeps the original broad collection when a bundle already fits, even above the reduced raw-byte budget', async () => {
    mockWorkEntryIds = ['reporting', 'other'];
    const reporting = `${REPORTING_STORAGE}/large.jsonl`;
    const other = `${ORCHESTRATOR_ROOT}/chat-storage-v2/other/large.jsonl`;
    await sparse(join(dataDir, reporting), 16);
    await sparse(join(dataDir, other), 12);
    const snapshot = await prepareFeedbackDiagnostics('owner', {
      context: REPORT_CONTEXT,
    });
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([reporting, other]),
    );
    expect(snapshot.skippedEntries).not.toContainEqual({
      path: 'system-logs/crash-dumps',
      reason: 'too-large',
    });
  });

  it('also reduces incompressible transcripts when only the compressed upload cap is exceeded', async () => {
    mockWorkEntryIds = ['reporting'];
    const large = `${REPORTING_STORAGE}/large.jsonl`;
    const smaller = `${REPORTING_STORAGE}/smaller.jsonl`;
    await mkdir(join(dataDir, REPORTING_STORAGE), { recursive: true });
    await writeFile(join(dataDir, large), randomBytes(20 * 1024 * 1024));
    await writeFile(join(dataDir, smaller), randomBytes(8 * 1024 * 1024));
    const snapshot = await prepareFeedbackDiagnostics('owner', {
      context: REPORT_CONTEXT,
    });
    expect(snapshot.sizeBytes).toBeLessThanOrEqual(MAX_FEEDBACK_ARCHIVE_BYTES);
    expect(snapshot.entries.map((entry) => entry.path)).toContain(smaller);
    expect(snapshot.skippedEntries).toContainEqual({
      path: large,
      reason: 'too-large',
    });
  }, 30000);

  it('keeps transcripts that fit and records only the one that crosses the expanded cap, on the first attempt', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `transcript-${index}`,
      eventType: 'app_advisor' as const,
      startedAt: '2026-11-23T00:00:00.000Z',
      hasTranscript: true,
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'app-advisor',
      chatId: 'reporting-chat',
    }));
    const transcriptPaths: string[] = [];
    for (const row of rows) {
      const path = getAgentObservabilityTranscriptFilePath(row);
      await sparse(path, 24);
      transcriptPaths.push(relative(dataDir, path).split('\\').join('/'));
    }
    await put(
      join(dataDir, 'agent-observability/audit/2026-11-23.jsonl'),
      rows.map((row) => JSON.stringify(row)).join('\n'),
    );
    const snapshot = await prepareFeedbackDiagnostics('owner', {
      context: { ...REPORT_CONTEXT, chatId: 'reporting-chat' },
    });
    const paths = snapshot.entries.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(transcriptPaths.slice(0, 4)));
    expect(paths).not.toContain(transcriptPaths[4]);
    expect(snapshot.skippedEntries).toContainEqual({
      path: transcriptPaths[4],
      reason: 'too-large',
    });
    // Crash dumps are only skipped by a retry.
    expect(snapshot.skippedEntries).not.toContainEqual({
      path: 'system-logs/crash-dumps',
      reason: 'too-large',
    });
  }, 30000);

  it('attaches an inspectable ZIP when thousands of small transcripts exceed the header and manifest budgets', async () => {
    mockWorkEntryIds = ['reporting'];
    const root = join(dataDir, REPORTING_STORAGE);
    await mkdir(root, { recursive: true });
    const contents = randomBytes(6100);
    // Raw bytes fit the old retry budget; long names make the real ZIP and
    // the manifest exceed their independent limits.
    for (let index = 0; index < 4050; index += 1)
      await writeFile(
        join(
          root,
          `${String(index).padStart(4, '0')}-${'x'.repeat(210)}.jsonl`,
        ),
        contents,
      );
    const snapshot = await prepareFeedbackDiagnostics('owner', {
      context: REPORT_CONTEXT,
    });
    expect(snapshot.sizeBytes).toBeLessThanOrEqual(MAX_FEEDBACK_ARCHIVE_BYTES);
    expect(Buffer.byteLength(snapshot.manifest, 'utf8')).toBeLessThanOrEqual(
      1024 * 1024,
    );
    const manifest = z
      .object({
        inventorySummary: z.object({ includedFilesOmitted: z.number() }),
      })
      .parse(JSON.parse(snapshot.manifest));
    expect(typeof manifest.inventorySummary.includedFilesOmitted).toBe(
      'number',
    );
    expect(
      snapshot.entries.some((entry) =>
        entry.path.startsWith(`${REPORTING_STORAGE}/`),
      ),
    ).toBe(true);
    expect(
      snapshot.skippedEntries.some(
        (entry) =>
          entry.path.startsWith(`${REPORTING_STORAGE}/`) &&
          entry.reason === 'too-large',
      ),
    ).toBe(true);
    // Preparing 4,050 entries takes ~8 s on an idle machine and over 30 s on a
    // loaded merge-queue shard.
  }, 120_000);

  it('attaches core diagnostics with a cutoff note when the reporting entry has too many empty directories', async () => {
    mockWorkEntryIds = ['reporting'];
    const root = join(dataDir, REPORTING_STORAGE);
    await mkdir(root, { recursive: true });
    for (let index = 0; index < 5010; index += 1)
      await mkdir(join(root, `empty-${index}`));
    // Chat history metadata is read after the cutoff but is not chat evidence.
    const meta = 'workspaces/app-advisor/chat-history/pre-entry/meta.json';
    await put(join(dataDir, meta), '{}');
    const snapshot = await prepareFeedbackDiagnostics('owner', {
      context: REPORT_CONTEXT,
    });
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['feedback.json', meta]),
    );
    const manifest = z
      .object({
        collectionLimits: z
          .object({
            traversalPaths: z.number(),
            cutoffPath: z.string(),
          })
          .strict(),
      })
      .parse(JSON.parse(snapshot.manifest));
    expect(manifest.collectionLimits.traversalPaths).toBe(5000);
    expect(manifest.collectionLimits.cutoffPath).toEqual(
      expect.stringContaining(`${REPORTING_STORAGE}/`),
    );
    expect(snapshot.skippedEntries).toContainEqual({
      path: manifest.collectionLimits.cutoffPath,
      reason: 'too-large',
    });
  }, 30000);

  it('collects project-wide and trims largest-first when an oversized report has no captured entry identity', async () => {
    mockWorkEntryIds = Array.from(
      { length: 6 },
      (_, index) => `other-${index}`,
    );
    for (const id of mockWorkEntryIds) {
      await sparse(
        join(dataDir, ORCHESTRATOR_ROOT, 'chat-storage-v2', id, 'large.jsonl'),
        20,
      );
      await put(
        join(dataDir, ORCHESTRATOR_ROOT, 'chat-storage-v2', id, 'small.jsonl'),
        `evidence from ${id}`,
      );
    }
    const snapshot = await prepareFeedbackDiagnostics('owner', {
      context: { activePage: 'chat', chatProjectId: 'app-advisor' },
    });
    const paths = snapshot.entries.map((entry) => entry.path);
    for (const id of mockWorkEntryIds)
      expect(paths).toContain(
        `${ORCHESTRATOR_ROOT}/chat-storage-v2/${id}/small.jsonl`,
      );
    expect(snapshot.sizeBytes).toBeLessThanOrEqual(MAX_FEEDBACK_ARCHIVE_BYTES);
    expect(snapshot.entries.map((entry) => entry.path)).toContain(
      'feedback.json',
    );
    expect(snapshot.skippedEntries).toContainEqual({
      path: `${ORCHESTRATOR_ROOT}/chat-storage-v2/other-0/large.jsonl`,
      reason: 'too-large',
    });
    expect(snapshot.skippedEntries).not.toContainEqual({
      path: `${ORCHESTRATOR_ROOT}/chat-storage-v2/other-0`,
      reason: 'policy-excluded',
    });
  });

  it.each([
    REPORT_CONTEXT,
    { activePage: 'chat', chatProjectId: 'app-advisor' },
  ])(
    'keeps home archives, legacy history and project audit evidence on the reduced retry regardless of chat ID: %j',
    async (context) => {
      mockWorkEntryIds = [
        'reporting',
        'other-0',
        'other-1',
        'other-2',
        'other-3',
      ];
      for (const id of mockWorkEntryIds.slice(1))
        await sparse(
          join(
            dataDir,
            ORCHESTRATOR_ROOT,
            'chat-storage-v2',
            id,
            'large.jsonl',
          ),
          20,
        );
      const home = `${ORCHESTRATOR_ROOT}/chat-storage-v2/home`;
      const legacy =
        'workspaces/app-advisor/chat-history/pre-entry/conversation.json';
      await sparse(join(dataDir, REPORTING_STORAGE, 'reporting.jsonl'), 12);
      await sparse(join(dataDir, home, 'large.jsonl'), 24);
      await put(
        join(dataDir, home, 'pre-entry.jsonl'),
        'home archive evidence',
      );
      await put(join(dataDir, legacy), 'legacy history evidence');
      await put(join(dataDir, ORCHESTRATOR_ROOT, 'chats/home.json'), TABS);
      const auditRows = ['first-chat', 'second-chat'].map((chatId) => ({
        id: `audit-${chatId}`,
        eventType: 'app_advisor' as const,
        startedAt: '2026-11-23T00:00:00.000Z',
        hasTranscript: true,
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'app-advisor',
        chatId,
      }));
      const transcriptPaths: string[] = [];
      for (const row of auditRows) {
        const path = getAgentObservabilityTranscriptFilePath(row);
        await put(path, `audit evidence for ${row.chatId}`);
        transcriptPaths.push(relative(dataDir, path).split('\\').join('/'));
      }
      await put(
        join(dataDir, 'agent-observability/audit/2026-11-23.jsonl'),
        [
          'not JSON',
          JSON.stringify({ ...auditRows[0], startedAt: 'invalid-date' }),
          ...auditRows.map((row) => JSON.stringify(row)),
        ].join('\n'),
      );
      const snapshot = await prepareFeedbackDiagnostics('owner', {
        context: { ...context, chatId: 'live-chat' },
      });
      expect(snapshot.entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining([
          `${home}/pre-entry.jsonl`,
          `${REPORTING_STORAGE}/reporting.jsonl`,
          `${ORCHESTRATOR_ROOT}/chats/home.json`,
          legacy,
          ...transcriptPaths,
        ]),
      );
      expect(snapshot.skippedEntries).toContainEqual({
        path: `${home}/large.jsonl`,
        reason: 'too-large',
      });
    },
  );
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const TABS = JSON.stringify({ version: 1, tabs: [] });

describe('legacy chat tabs in a feedback bundle', () => {
  it('a worktree scope with a manifest sends its manifest but not its leftover legacy tabs; a legacy-only scope still sends its tabs', async () => {
    const root = join(dataDir, 'workspaces', 'project');
    await put(join(root, 'chats', 'migrated.json'), TABS);
    await put(join(root, 'chat-storage-manifests', 'migrated.json'), '{}');
    await put(join(root, 'chats', 'legacy.json'), TABS);
    const builder = new FeedbackBundleBuilder();
    await feedbackChatDetailsForTests.includeWorktreeChatDetails(builder, [
      { workspaceId: 'project', worktreeIds: ['migrated', 'legacy'] },
    ]);
    expect(builder.includedFiles()).toContain(
      posix.join(
        'workspaces',
        'project',
        'chat-storage-manifests',
        'migrated.json',
      ),
    );
    expect(builder.includedFiles()).not.toContain(
      posix.join('workspaces', 'project', 'chats', 'migrated.json'),
    );
    expect(builder.includedFiles()).toContain(
      posix.join('workspaces', 'project', 'chats', 'legacy.json'),
    );
  });

  it('a cowork home with a manifest leaves out its leftover legacy tabs too', async () => {
    const root = join(dataDir, 'workspaces', 'cowork-1');
    await put(join(root, 'chats', 'home.json'), TABS);
    await put(join(root, 'chat-storage-manifests', 'home.json'), '{}');
    const builder = new FeedbackBundleBuilder();
    await feedbackChatDetailsForTests.includeStandaloneChatDetails(builder, [
      'cowork-1',
    ]);
    expect(builder.includedFiles()).toContain(
      posix.join(
        'workspaces',
        'cowork-1',
        'chat-storage-manifests',
        'home.json',
      ),
    );
    expect(builder.includedFiles()).not.toContain(
      posix.join('workspaces', 'cowork-1', 'chats', 'home.json'),
    );
  });

  it('a cowork home with no manifest still sends its legacy tabs', async () => {
    await put(
      join(dataDir, 'workspaces', 'cowork-2', 'chats', 'home.json'),
      TABS,
    );
    const builder = new FeedbackBundleBuilder();
    await feedbackChatDetailsForTests.includeStandaloneChatDetails(builder, [
      'cowork-2',
    ]);
    expect(builder.includedFiles()).toContain(
      posix.join('workspaces', 'cowork-2', 'chats', 'home.json'),
    );
  });
});
