/**
 * CAN-4475 R0-F5 on the in-app host (CAN-7176): the resume queue's existing
 * guarantees are the floor any owner keeps. Against a real queue file it
 * pins strict schema refusal with the file preserved, an all-or-nothing
 * publication at every storage step, a durable claim before dispatch,
 * restart reconciliation that never replays an ambiguous resume, quit
 * during the claim, Stop suppression across a restart, and the pace
 * between starts. Chat and pipeline targets keep their identity throughout.
 */
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ResumeQueueEntry,
  ResumeQueueItem,
  ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import {
  ResumeQueueService,
  type ResumeQueueDependencies,
} from '../resume-queue-service';
import { ResumeQueueStorage } from '../resume-queue-storage';

type Fault = 'temp-written' | 'temp-synced' | 'renamed';

// Fails one storage step, as a crash there would stop the save.
const mockFault: { at?: Fault; file?: string } = {};
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  const crash = (): Promise<never> =>
    Promise.reject(new Error('simulated crash'));
  return {
    ...actual,
    open: async (
      ...args: Parameters<typeof FsPromises.open>
    ): ReturnType<typeof FsPromises.open> => {
      const path = String(args[0]);
      const target = mockFault.file;
      if (
        target &&
        mockFault.at === 'renamed' &&
        path === dirname(target) &&
        args[1] === 'r'
      )
        return crash();
      const handle = await actual.open(...args);
      if (
        target &&
        mockFault.at === 'temp-written' &&
        path.startsWith(`${target}.`) &&
        path.endsWith('.tmp')
      )
        handle.sync = crash;
      return handle;
    },
    rename: (from: string, to: string): Promise<void> =>
      mockFault.file && mockFault.at === 'temp-synced' && to === mockFault.file
        ? crash()
        : actual.rename(from, to),
  };
});

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'r0-resume-queue-'));
  file = join(root, 'resume-queue.json');
});

afterEach(async () => {
  delete mockFault.at;
  delete mockFault.file;
  await rm(root, { recursive: true, force: true });
});

const chatItem: ResumeQueueItem = {
  target: {
    kind: 'chat',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
  },
  title: 'Chat',
  workspaceName: 'Workspace',
  interruptionId: 'interruption-chat',
};
const pipelineItem: ResumeQueueItem = {
  target: {
    kind: 'pipeline',
    executionId: 'execution',
    statusReasonIds: ['reason-a', 'reason-b'],
  },
  title: 'Pipeline',
  workspaceName: 'Workspace',
  interruptionId: 'interruption-pipeline',
};

function entry(
  item: ResumeQueueItem,
  id: string,
  status: ResumeQueueEntry['status'],
): ResumeQueueEntry {
  return { ...item, id, status, createdAt: 1 };
}

function snapshot(
  revision: number,
  entries: ResumeQueueEntry[],
): ResumeQueueSnapshot {
  return { version: 1, revision, paused: false, entries };
}

interface Harness {
  service: ResumeQueueService;
  order: string[];
  dispatched: string[];
  reconciled: string[];
  clock: { now: number };
}

function harness(overrides: Partial<ResumeQueueDependencies> = {}): Harness {
  const storage = new ResumeQueueStorage(file);
  const order: string[] = [];
  const dispatched: string[] = [];
  const reconciled: string[] = [];
  const clock = { now: 1_000_000 };
  const service = new ResumeQueueService({
    load: (): Promise<ResumeQueueSnapshot | null> => storage.load(),
    save: async (next): Promise<void> => {
      await storage.save(next);
      order.push(
        `saved:${next.entries.map((item) => `${item.id}=${item.status}`).join(',')}`,
      );
    },
    dispatch: (item): Promise<'resumed'> => {
      order.push(`dispatch:${item.id}`);
      dispatched.push(item.id);
      return Promise.resolve('resumed');
    },
    reconcile: (item): Promise<{ status: 'resumed' }> => {
      reconciled.push(item.id);
      return Promise.resolve({ status: 'resumed' });
    },
    now: (): number => clock.now,
    changed: (): void => undefined,
    ...overrides,
  });
  return { service, order, dispatched, reconciled, clock };
}

async function stored(): Promise<ResumeQueueSnapshot | null> {
  return new ResumeQueueStorage(file).load();
}

describe('R0-F5 storage', () => {
  const before = snapshot(1, [entry(chatItem, 'a', 'waiting')]);
  const after = snapshot(2, [
    entry(chatItem, 'a', 'resuming'),
    entry(pipelineItem, 'b', 'waiting'),
  ]);

  // Off Windows only: the queue syncs its folder after the rename everywhere
  // else, and skips that step on Windows by design.
  const faults: [Fault, ResumeQueueSnapshot][] = [
    ['temp-written', before],
    ['temp-synced', before],
    ...(process.platform === 'win32'
      ? []
      : [['renamed', after] satisfies [Fault, ResumeQueueSnapshot]]),
  ];

  it.each(faults)(
    'R0-F5 a save stopped at %s leaves the whole old or whole new queue, with chat and pipeline identities intact',
    async (fault, expected) => {
      const storage = new ResumeQueueStorage(file);
      await storage.save(before);
      mockFault.file = file;
      mockFault.at = fault;
      await expect(storage.save(after)).rejects.toThrow('simulated crash');
      delete mockFault.at;
      expect(await stored()).toEqual(expected);
      expect(
        (await readdir(root)).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
    },
  );

  it('R0-F5 a temporary file a crash left behind is never read as the queue', async () => {
    const storage = new ResumeQueueStorage(file);
    await storage.save(before);
    await writeFile(`${file}.left-by-a-crash.tmp`, '{"version":1,"revis');
    expect(await stored()).toEqual(before);
  });

  it.each<[string, string]>([
    ['truncated JSON', '{"version":1,"revision":3,"paused":false,"entr'],
    ['a newer version', JSON.stringify({ ...before, version: 2 })],
    [
      'an unknown status',
      JSON.stringify({
        ...before,
        entries: [{ ...entry(chatItem, 'a', 'waiting'), status: 'later' }],
      }),
    ],
    [
      'more than 2000 entries',
      JSON.stringify(
        snapshot(
          4,
          Array.from({ length: 2001 }, (_, index) =>
            entry(chatItem, `e${index}`, 'waiting'),
          ),
        ),
      ),
    ],
  ])(
    'R0-F5 %s is refused: the queue pauses with its error and the file keeps every byte',
    async (_label, bytes) => {
      await writeFile(file, bytes);
      const { service, dispatched } = harness();
      await expect(service.initialize()).rejects.toThrow(
        'Resume queue state is unsupported or corrupt.',
      );
      expect(service.snapshot().paused).toBe(true);
      expect(service.snapshot().error).toContain(
        'could not be saved or loaded',
      );
      await expect(service.enqueue([pipelineItem])).rejects.toThrow();
      await expect(service.tick()).rejects.toThrow();
      expect(dispatched).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe(bytes);
    },
  );

  it('R0-F5 a failed save pauses the queue and keeps the last saved state in memory and on disk', async () => {
    const { service } = harness();
    await service.enqueue([chatItem]);
    const saved = await stored();
    mockFault.file = file;
    mockFault.at = 'temp-synced';
    await expect(service.enqueue([pipelineItem])).rejects.toThrow(
      'simulated crash',
    );
    expect(service.snapshot().paused).toBe(true);
    expect(service.snapshot().entries).toEqual(saved?.entries);
    expect(await stored()).toEqual(saved);
  });
});

describe('R0-F5 dispatch and restart', () => {
  it('R0-F5 the claim is durable before dispatch', async () => {
    const { service, order } = harness();
    await service.enqueue([chatItem]);
    const id = service.snapshot().entries[0]?.id;
    await service.tick();
    expect(order.slice(-3)).toEqual([
      `saved:${id}=resuming`,
      `dispatch:${id}`,
      `saved:${id}=resumed`,
    ]);
  });

  it('R0-F5 a resume interrupted after its claim is reconciled on restart and never dispatched again', async () => {
    // The first process dies inside dispatch: past its durable claim, with no
    // write of its own left to make.
    let dispatchEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => (dispatchEntered = resolve));
    const first = harness({
      dispatch: (): Promise<'resumed'> => {
        dispatchEntered();
        return new Promise<'resumed'>(() => undefined);
      },
    });
    await first.service.enqueue([chatItem, pipelineItem]);
    void first.service.tick();
    await entered;
    first.service.stop();
    expect((await stored())?.entries[0]?.status).toBe('resuming');

    const second = harness({
      reconcile: (item) => {
        second.reconciled.push(item.id);
        return Promise.resolve({
          status: 'failed',
          error: 'Could not verify the interrupted resume.',
        });
      },
    });
    await second.service.initialize();
    const claimed = (await stored())?.entries[0];
    expect(second.reconciled).toEqual([claimed?.id]);
    expect(claimed?.status).toBe('failed');
    expect(second.dispatched).toEqual([]);
    second.clock.now += 20_000;
    await second.service.tick();
    expect(second.dispatched).toEqual([(await stored())?.entries[1]?.id]);
    expect(second.dispatched).not.toContain(claimed?.id);
  });

  it('R0-F5 a reconcile that throws records a failure instead of returning the resume to the queue', async () => {
    await new ResumeQueueStorage(file).save(
      snapshot(1, [entry(chatItem, 'claimed', 'resuming')]),
    );
    const { service, dispatched } = harness({
      reconcile: () => Promise.reject(new Error('session unreadable')),
    });
    await service.initialize();
    await service.tick();
    expect(dispatched).toEqual([]);
    expect((await stored())?.entries[0]).toMatchObject({
      id: 'claimed',
      status: 'failed',
      error:
        'Could not verify the interrupted resume. Check the session before trying again.',
    });
  });

  it('R0-F5 quit during the durable claim returns the entry to waiting without dispatching it', async () => {
    let releaseClaim = (): void => undefined;
    const claimHeld = new Promise<void>((resolve) => (releaseClaim = resolve));
    let claimReached = (): void => undefined;
    const reached = new Promise<void>((resolve) => (claimReached = resolve));
    const storage = new ResumeQueueStorage(file);
    const fixture = harness({
      save: async (next) => {
        if (next.entries.some((item) => item.status === 'resuming')) {
          claimReached();
          await claimHeld;
        }
        await storage.save(next);
      },
    });
    await fixture.service.enqueue([chatItem]);
    const tick = fixture.service.tick();
    await reached;
    fixture.service.stop();
    releaseClaim();
    await tick;
    expect(fixture.dispatched).toEqual([]);
    expect((await stored())?.entries[0]?.status).toBe('waiting');
  });

  it('R0-F5 a quitting host that refuses a started dispatch keeps its claim for recovery', async () => {
    const stopping: { service?: ResumeQueueService } = {};
    const fixture = harness({
      dispatch: (): Promise<'resumed'> => {
        stopping.service?.stop();
        return Promise.reject(new Error('The application is shutting down.'));
      },
    });
    stopping.service = fixture.service;
    await fixture.service.enqueue([chatItem]);
    await fixture.service.tick();
    expect((await stored())?.entries[0]?.status).toBe('resuming');
  });

  it('R0-F5 starts are paced 10 s apart', async () => {
    const { service, dispatched, clock } = harness();
    await service.enqueue([chatItem, pipelineItem]);
    await service.tick();
    await service.tick();
    expect(dispatched).toHaveLength(1);
    clock.now += 9_999;
    await service.tick();
    expect(dispatched).toHaveLength(1);
    clock.now += 1;
    await service.tick();
    expect(dispatched).toHaveLength(2);
  });
});

describe('R0-F5 Stop suppression', () => {
  const proxied: ResumeQueueItem = {
    ...chatItem,
    accountProxyConnectionId: 'proxy',
  };

  it('R0-F5 a stopped and dismissed automatic resume stays suppressed after a restart, while a manual resume is still accepted', async () => {
    const first = harness({
      readLiveAutomaticResumeInterruptionKeys: (keys) =>
        Promise.resolve(
          new Set(keys.map((key) => `${key.targetKey}:${key.interruptionId}`)),
        ),
    });
    await first.service.enqueue([proxied], { automatic: true });
    await first.service.control('stop');
    await first.service.control('dismiss');
    expect((await stored())?.suppressedAutomaticResumes).toEqual([
      {
        targetKey: 'chat:project/worktree/chat',
        interruptionId: 'interruption-chat',
      },
    ]);

    const second = harness({
      readLiveAutomaticResumeInterruptionKeys: () =>
        Promise.resolve(
          new Set(['chat:project/worktree/chat:interruption-chat']),
        ),
    });
    await second.service.enqueue([proxied], { automatic: true });
    expect(second.service.snapshot().entries).toEqual([]);
    await second.service.pruneAutomaticResumeSuppressions();
    expect((await stored())?.suppressedAutomaticResumes).toHaveLength(1);
    await second.service.enqueue([proxied]);
    expect(second.service.snapshot().entries).toHaveLength(1);
  });

  it('R0-F5 pruning drops only interruptions their owners no longer report', async () => {
    await new ResumeQueueStorage(file).save({
      ...snapshot(1, []),
      suppressedAutomaticResumes: [
        { targetKey: 'chat:project/worktree/chat', interruptionId: 'live' },
        { targetKey: 'chat:project/worktree/chat', interruptionId: 'gone' },
      ],
    });
    const { service } = harness({
      readLiveAutomaticResumeInterruptionKeys: () =>
        Promise.resolve(new Set(['chat:project/worktree/chat:live'])),
    });
    await service.pruneAutomaticResumeSuppressions();
    expect((await stored())?.suppressedAutomaticResumes).toEqual([
      { targetKey: 'chat:project/worktree/chat', interruptionId: 'live' },
    ]);
  });
});
