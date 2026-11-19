/**
 * The CAN-4475 R0 chat commit workload and its crash images (CAN-7176),
 * shared by the in-app suites and, later, the daemon writer's own pass.
 *
 * A fixed five-step workload (create, a receipt-bearing send, two
 * journal-only stream records, and the turn's end with its checkpoint) runs
 * against a real repository. A crash case stops it at one delta journal
 * boundary of one step, images the scope, and reopens the image.
 */
import fs, {
  cp,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  truncate,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { getChatQueueService } from '../../services/chat-queue-service';
import type { ChatMutationOptions } from '../../services/chat-state-contracts';
import type { DeltaJournalBoundary } from '../../lib/chat-delta-journal/writer';
import type {
  ChatStateV2Repository,
  ChatStateV2RepositoryOptions,
} from '../../services/chat-state-v2-repository';
import { readPopulatedCache, treeDigests } from './chat-delta-journal-harness';
import {
  drainOpenRepositories,
  idle,
  repositoryAt,
  streaming,
  text,
  upsert,
} from './chat-delta-journal-scope';

export const scope = { projectId: 'project', worktreeId: 'scope' };

export type Format = 'format 3' | 'format 4';
export const FORMATS: Record<Format, ChatStateV2RepositoryOptions> = {
  'format 3': {},
  'format 4': {
    enableFormat4: true,
    deltaJournalIncrementalStreamMetadata: true,
  },
};

export interface Step {
  id: string;
  mutations: ChatCoreMutation[];
  options: ChatMutationOptions;
}

/** Revision after step i is i + 1. */
export const STEPS: readonly Step[] = [
  {
    id: 'create',
    mutations: [
      {
        type: 'tab.created',
        tab: {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-11-17',
          messages: [],
        },
      },
    ],
    options: {
      source: 'renderer-command',
      mutationId: 'create',
      chatIds: ['chat'],
    },
  },
  {
    id: 'send',
    mutations: [
      streaming('chat', 'prompt'),
      upsert('chat', text('prompt', 'Hello', 'user')),
    ],
    options: {
      source: 'renderer-command',
      mutationId: 'send',
      commandResult: {
        commandId: 'cmd-send',
        outcome: 'applied',
        messageId: 'prompt',
      },
    },
  },
  {
    id: 'stream-1',
    mutations: [upsert('chat', text('answer', 'Part'))],
    options: { source: 'provider', mutationId: 'stream-1' },
  },
  {
    id: 'stream-2',
    mutations: [upsert('chat', text('answer', 'Part and more'))],
    options: { source: 'provider', mutationId: 'stream-2' },
  },
  {
    id: 'end',
    mutations: [idle('chat')],
    options: { source: 'provider', mutationId: 'end' },
  },
];

export const RECORD = ['record-written', 'record-synced'] as const;
export const CHECKPOINT = {
  'format 3': [
    'checkpoint-transcripts-applied',
    'checkpoint-metadata-staged',
    'checkpoint-publishing-marked',
    'checkpoint-indexes-published',
    'checkpoint-journal-rotated',
    'marker-removed',
  ],
  'format 4': [
    'checkpoint-transcripts-applied',
    'checkpoint-metadata-staged',
    'checkpoint-publishing-marked',
    'checkpoint-descriptors-published',
    'checkpoint-registries-published',
    'checkpoint-catalog-published',
    'checkpoint-indexes-published',
    'checkpoint-journal-rotated',
    'checkpoint-removed-parents',
    'marker-removed',
  ],
} as const satisfies Record<Format, readonly DeltaJournalBoundary[]>;

/**
 * Every boundary is either crashed by this workload or names where it is
 * covered, so a boundary added to the writer fails to compile until it is
 * placed.
 */
export const ELSEWHERE: Record<
  Exclude<
    DeltaJournalBoundary,
    (typeof RECORD)[number] | (typeof CHECKPOINT)['format 4'][number]
  >,
  string
> = {
  'tail-quarantined': 'recovery only: reached by reopening a dropped image',
  'echo-quarantined': 'recovery only (CAN-6902 final-form echo golden)',
  'tail-truncated': 'recovery only: reached by reopening a dropped image',
  'catalog-temp-written': 'promotion (format 4 promotion qualification)',
  'catalog-temp-synced': 'promotion (format 4 promotion qualification)',
  'segment-temp-written': 'promotion (format 4 promotion qualification)',
  'segment-temp-synced': 'promotion (format 4 promotion qualification)',
  'segment-renamed': 'promotion (format 4 promotion qualification)',
  'segment-directory-synced': 'promotion (format 4 promotion qualification)',
  'manifest-published': 'promotion (format 4 promotion qualification)',
  'manifest-temp-written': 'promotion (format 4 promotion qualification)',
  'manifest-temp-synced': 'promotion (format 4 promotion qualification)',
  'manifest-directory-synced': 'promotion (format 4 promotion qualification)',
  'writer-reopened': 'promotion (format 4 promotion qualification)',
  'checkpoint-child-append-prepared': 'delegation streams (CAN-7176 PR 1b)',
  'registry-answer-published': 'delegation registry (CAN-7176 PR 1b)',
  'registry-settle-admitted': 'delegation registry (CAN-7176 PR 1b)',
  'finalize-artifact': 'delegation registry (CAN-7176 PR 1b)',
  'finalize-journal': 'delegation registry (CAN-7176 PR 1b)',
  'finalize-checkpoint': 'delegation registry (CAN-7176 PR 1b)',
  'receipt-effect': 'delegation receipts (CAN-7176 PR 1b)',
};

export type Image = 'kept' | 'dropped';
export interface CrashCase {
  format: Format;
  step: string;
  boundary: DeltaJournalBoundary;
  image: Image;
}

/**
 * The receipt-bearing send and a journal-only stream record crash at the
 * record boundaries; the turn's end crashes through its checkpoint, which
 * folds every pending record. Only record-written has unsynced journal bytes
 * to drop.
 */
export function crashCases(format: Format): CrashCase[] {
  const result: CrashCase[] = [];
  for (const step of ['send', 'stream-2'])
    for (const boundary of RECORD) {
      result.push({ format, step, boundary, image: 'kept' });
      if (boundary === 'record-written')
        result.push({ format, step, boundary, image: 'dropped' });
    }
  for (const boundary of CHECKPOINT[format])
    result.push({ format, step: 'end', boundary, image: 'kept' });
  return result;
}

export interface Observed {
  revision: number;
  messages: { id: string; text: string }[];
  status: string | undefined;
  receiptRevision: number | undefined;
}

/** A fresh data root per test, with every repository drained after it. */
export function useR0Root(): () => string {
  let root = '';
  const previousDataDir = process.env.CANOPY_DATA_DIR;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'r0-chat-'));
    process.env.CANOPY_DATA_DIR = root;
    resetResolvedCanopyDataDirForTests();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    getChatQueueService().resetForTests();
    await drainOpenRepositories();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });
  return () => root;
}

export function openAt(
  at: string,
  format: Format,
  onBoundary?: (point: DeltaJournalBoundary) => Promise<void>,
): ChatStateV2Repository {
  return repositoryAt(at, {
    ...FORMATS[format],
    deltaJournalIdleCheckpointMs: 60_000,
    ...(onBoundary ? { deltaJournalOnBoundary: onBoundary } : {}),
  });
}

export async function observe(
  repository: ChatStateV2Repository,
): Promise<Observed> {
  const state = await repository.getState(scope, {
    chatIds: ['chat'],
    fullTranscript: true,
  });
  const tab = state.tabsFile.tabs.find((candidate) => candidate.id === 'chat');
  return {
    revision: await repository.getRevision(scope),
    messages: (tab?.messages ?? []).map((row) => ({
      id: row.id,
      text: row.blocks
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(''),
    })),
    status: state.runtimeByChatId.chat?.status,
    receiptRevision: (await repository.getReceipt(scope, 'cmd-send'))?.revision,
  };
}

/** The no-crash state after each revision (index = revision). */
export async function referenceStates(
  at: string,
  format: Format,
): Promise<Observed[]> {
  const repository = openAt(at, format);
  const states: Observed[] = [
    {
      revision: 0,
      messages: [],
      status: undefined,
      receiptRevision: undefined,
    },
  ];
  for (const step of STEPS) {
    await repository.transact(scope, step.mutations, step.options);
    states.push(await observe(repository));
  }
  await repository.drainAll();
  return states;
}

async function* files(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

function isJournal(path: string): boolean {
  return /(?:^|[/\\])delta-[^/\\]*$/.test(path);
}

/** Delta journal files under `at`, by path relative to it, with their sizes. */
async function journalSizes(at: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for await (const path of files(at))
    if (isJournal(path)) sizes.set(relative(at, path), (await stat(path)).size);
  return sizes;
}

/**
 * Every boundary the crash cases name is reached at its step, and every
 * boundary the workload reaches is crashed or placed in {@link ELSEWHERE}.
 */
export async function expectCoverage(
  at: string,
  format: Format,
): Promise<void> {
  const hits: { step: string; point: DeltaJournalBoundary }[] = [];
  let current = '';
  const repository = openAt(at, format, (point) => {
    hits.push({ step: current, point });
    return Promise.resolve();
  });
  for (const step of STEPS) {
    current = step.id;
    await repository.transact(scope, step.mutations, step.options);
  }
  for (const crash of crashCases(format))
    expect(hits).toContainEqual({ step: crash.step, point: crash.boundary });
  const crashed = new Set<string>([...RECORD, ...CHECKPOINT['format 4']]);
  for (const { point } of hits)
    expect(crashed.has(point) || point in ELSEWHERE).toBe(true);
}

/**
 * Runs the workload to the crash, images the scope at the boundary, and
 * proves the image: acknowledged commands survive, the in-flight one is
 * wholly present or absent, a second reopen changes no byte, and a retry
 * of the in-flight step reaches the no-crash state.
 */
export async function expectCrashImage(
  root: string,
  { format, step: crashStep, boundary, image }: CrashCase,
  expected: readonly Observed[],
): Promise<void> {
  const live = join(root, 'live');
  const crash = join(root, 'crash');
  const stepIndex = STEPS.findIndex((step) => step.id === crashStep);
  let current = '';
  let injected = false;
  let sizesAtStepStart = new Map<string, number>();
  const repository = openAt(live, format, async (point) => {
    if (injected || current !== crashStep || point !== boundary) return;
    injected = true;
    await cp(live, crash, { recursive: true });
    throw new Error(`fault:${boundary}`);
  });

  let acknowledged = 0;
  for (const step of STEPS.slice(0, stepIndex + 1)) {
    current = step.id;
    if (step.id === crashStep) {
      sizesAtStepStart = await journalSizes(live);
      await expect(
        repository.transact(scope, step.mutations, step.options),
      ).rejects.toThrow(`fault:${boundary}`);
    } else {
      acknowledged = (
        await repository.transact(scope, step.mutations, step.options)
      ).revision;
    }
  }
  expect(injected).toBe(true);
  expect(acknowledged).toBe(stepIndex);

  if (image === 'dropped')
    for (const [path, size] of await journalSizes(crash)) {
      const before = sizesAtStepStart.get(path) ?? 0;
      if (size > before) await truncate(join(crash, path), before);
    }
  // The crashed process is gone; its image reopens where it was written,
  // since format 4 checkpoint markers name absolute paths.
  await repository.drainAll().catch(() => undefined);
  await rm(live, { recursive: true, force: true });
  await rename(crash, live);

  // A dropped image loses the in-flight record. A kept image holds it whole:
  // complete at record-written, durable from record-synced on.
  const recovered = image === 'dropped' ? acknowledged : acknowledged + 1;
  const first = openAt(live, format);
  expect(await observe(first)).toEqual(expected[recovered]);
  expect(first.getLifecycle(scope)).toBe('ready');
  expect(await first.hasMutation(scope, crashStep)).toBe(
    recovered > acknowledged,
  );
  await first.drainAll();
  const settled = await treeDigests(live, readPopulatedCache);

  const second = openAt(live, format);
  expect(await observe(second)).toEqual(expected[recovered]);
  await second.drainAll();
  expect(await treeDigests(live, readPopulatedCache)).toEqual(settled);

  const retried = openAt(live, format);
  const step = STEPS[stepIndex];
  const commit = await retried.transact(scope, step.mutations, step.options);
  expect(commit.applied).toBe(recovered === acknowledged);
  expect(commit.revision).toBe(acknowledged + 1);
  expect(await observe(retried)).toEqual(expected[acknowledged + 1]);
}

/** Whether `promise` settles once pending I/O callbacks have run. */
export async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  return settled;
}

export interface Gate {
  wait: Promise<void>;
  open: () => void;
}

export function gate(): Gate {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/**
 * Records `journal-synced` each time a delta journal file's `sync()`
 * completes, through the module object the writer opens files with.
 */
export function observeJournalSyncs(events: string[]): void {
  const openFile = fs.open.bind(fs);
  jest
    .spyOn(fs, 'open')
    .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await openFile(...args);
      if (isJournal(String(args[0]))) {
        const sync = handle.sync.bind(handle);
        handle.sync = async (): Promise<void> => {
          await sync();
          events.push('journal-synced');
        };
      }
      return handle;
    });
}
