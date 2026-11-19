/**
 * CAN-4475 R0-F1 on the in-app host (CAN-7176): a chat write is saved only
 * once its durable commit is observed. The repository's commit, the
 * service's command result and its published change all come after the
 * journal file's fsync completes; records queued behind a sync settle only
 * with their own batch, in revision order; and a retried command returns
 * its existing receipt without applying again.
 */
import { join } from 'node:path';
import { ChatStateService } from '../services/chat-state-service';
import type { DeltaJournalBoundary } from '../lib/chat-delta-journal/writer';
import {
  FORMATS,
  RECORD,
  STEPS,
  gate,
  observeJournalSyncs,
  openAt,
  scope,
  settledYet,
  useR0Root,
  type Format,
  type Gate,
} from './helpers/chat-r0-commit-workload';

// Real syncs dominate case time (CAN-6971).
jest.setTimeout(60_000);

const root = useR0Root();
const formats = Object.keys(FORMATS) as Format[];

it.each(formats)(
  'R0-F1 repository (%s): every acknowledged commit follows a completed fsync of its journal file',
  async (format) => {
    const events: string[] = [];
    observeJournalSyncs(events);
    const repository = openAt(join(root(), 'fsync'), format);
    for (const step of STEPS) {
      const before = events.length;
      await repository.transact(scope, step.mutations, step.options);
      events.push(`acknowledged:${step.id}`);
      expect(events.slice(before, -1)).toContain('journal-synced');
    }
  },
);

it.each(formats)(
  'R0-F1 repository (%s): a commit held at record-written or record-synced has not resolved',
  async (format) => {
    const held = new Map<DeltaJournalBoundary, Gate>();
    const reached = new Map<DeltaJournalBoundary, Gate>();
    let watching = false;
    const repository = openAt(join(root(), 'ack'), format, async (point) => {
      if (!watching) return;
      reached.get(point)?.open();
      await held.get(point)?.wait;
    });
    await repository.transact(scope, STEPS[0].mutations, STEPS[0].options);

    for (const point of RECORD) {
      held.set(point, gate());
      reached.set(point, gate());
    }
    watching = true;
    const commit = repository.transact(
      scope,
      STEPS[1].mutations,
      STEPS[1].options,
    );
    await reached.get('record-written')?.wait;
    expect(await settledYet(commit)).toBe(false);
    held.get('record-written')?.open();
    await reached.get('record-synced')?.wait;
    expect(await settledYet(commit)).toBe(false);
    held.get('record-synced')?.open();
    expect((await commit).revision).toBe(2);
  },
);

it('R0-F1 group commit (format 4): records queued behind a sync settle only after their own batch is synced, in revision order', async () => {
  const resolved: number[] = [];
  let hold: Gate | undefined;
  const held = gate();
  let syncs = 0;
  const repository = openAt(
    join(root(), 'group'),
    'format 4',
    async (point) => {
      if (point === 'record-written' && hold) {
        const current = hold;
        hold = undefined;
        held.open();
        await current.wait;
      }
      if (point === 'record-synced') syncs += 1;
    },
  );
  await repository.transact(scope, STEPS[0].mutations, STEPS[0].options);
  await repository.transact(scope, STEPS[1].mutations, STEPS[1].options);
  syncs = 0;

  const release = gate();
  hold = release;
  const commits = [
    repository.transact(scope, STEPS[2].mutations, STEPS[2].options),
  ];
  await held.wait;
  commits.push(
    repository.transact(scope, STEPS[3].mutations, STEPS[3].options),
    repository.transact(scope, STEPS[4].mutations, STEPS[4].options),
  );
  commits.forEach(
    (commit, index) => void commit.then(() => resolved.push(index)),
  );
  for (const commit of commits) expect(await settledYet(commit)).toBe(false);
  release.open();
  const revisions = (await Promise.all(commits)).map(
    (commit) => commit.revision,
  );
  expect(revisions).toEqual([3, 4, 5]);
  expect(resolved).toEqual([0, 1, 2]);
  expect(syncs).toBeGreaterThanOrEqual(2);
});

it('R0-F1 service (format 4): the command result and its published change follow the sync, and a retried command returns its receipt without applying again', async () => {
  const order: string[] = [];
  const hold = gate();
  const reached = gate();
  let watching = false;
  const repository = openAt(
    join(root(), 'service'),
    'format 4',
    async (point) => {
      if (!watching) return;
      order.push(point);
      if (point === 'record-written') {
        reached.open();
        await hold.wait;
      }
    },
  );
  let ids = 0;
  const service = new ChatStateService({
    repository,
    now: (): number => 1_786_104_000_000,
    createId: (): string => `event-${(ids += 1)}`,
    dispatch: (): Promise<void> => Promise.resolve(),
    onInputPickup: (): Promise<void> => Promise.resolve(),
    authorizeSend: (): Promise<void> => Promise.resolve(),
    approvePlanReview: (): Promise<boolean> => Promise.resolve(true),
    withPlanReviewRevision: async <T>(
      _request: unknown,
      commit: () => Promise<T>,
    ): Promise<{ accepted: true; result: T }> => ({
      accepted: true,
      result: await commit(),
    }),
    cleanupSession: (): Promise<void> => Promise.resolve(),
    recordDiagnostic: (): void => undefined,
  });
  const created = await service.command({
    schemaVersion: 1,
    commandId: 'create',
    ...scope,
    command: {
      type: 'chat.create_tab',
      tabId: 'chat',
      title: 'Chat',
      providerType: 'claude',
      model: 'claude-opus-4-6',
    },
  });
  expect(created.outcome).toBe('applied');
  service.subscribe((event) => {
    if (event.projectId === scope.projectId)
      order.push(`published:${event.revision}`);
  });

  watching = true;
  const envelope = {
    schemaVersion: 1 as const,
    commandId: 'cmd-unread',
    ...scope,
    command: {
      type: 'chat.mark_unread' as const,
      chatId: 'chat',
      manual: true as const,
    },
  };
  const command = service.command(envelope);
  await reached.wait;
  expect(await settledYet(command)).toBe(false);
  expect(order.some((entry) => entry.startsWith('published:'))).toBe(false);
  hold.open();
  const result = await command;
  order.push(`acknowledged:${result.revision}`);
  expect(result.outcome).toBe('applied');
  const synced = order.indexOf('record-synced');
  expect(synced).toBeGreaterThanOrEqual(0);
  expect(order.indexOf(`published:${result.revision}`)).toBeGreaterThan(synced);
  expect(order.indexOf(`acknowledged:${result.revision}`)).toBeGreaterThan(
    synced,
  );

  const retried = await service.command(envelope);
  expect(retried).toMatchObject({
    commandId: 'cmd-unread',
    revision: result.revision,
    outcome: 'already_applied',
  });
  expect(await repository.getRevision(scope)).toBe(result.revision);
});
