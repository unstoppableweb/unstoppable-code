// CAN-6183 (plan CP-71): a workflow schedule moved to the cloud is stored
// server-side, kept here as a stub the scheduler never fires, and moving it
// back deletes the server record before the stub turns into a local record,
// so one slot never has two live records. The real automations service runs
// over a temporary automations file; the web core is an in-memory remote.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PipelineSchedule,
  PipelineScheduleCreateParams,
} from '@canopy/protocol/canopy-core';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type * as Paths from '../../lib/paths';
import type * as ResourceContext from '../../lib/resource-context';
import {
  CloudScheduleRemoteError,
  firesLocally,
  type CloudScheduleRemote,
} from '../cloud-schedules';
import type { AutomationsService } from '../service';

let mockDirectory = '';
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof Paths>('../../lib/paths'),
  getAutomationsFilePath: (): string => join(mockDirectory, 'automations.json'),
  getDataDir: (): string => mockDirectory,
}));
jest.mock('../../lib/resource-context', () => ({
  ...jest.requireActual<typeof ResourceContext>('../../lib/resource-context'),
  resourceContextEnabled: (): boolean => false,
}));
jest.setTimeout(30_000);

const ACCOUNT = 'account-1';
const REMOTE_ID = '00000000-0000-4000-8000-0000000000f1';

interface MemoryRemote {
  readonly remote: CloudScheduleRemote;
  readonly records: Map<string, PipelineSchedule>;
  readonly failures: {
    create?: 'lost' | 'refused';
    delete?: 'unreachable' | 'lost';
  };
}

/** The web core's schedule store, in memory, with its refusals. */
function memoryRemote(): MemoryRemote {
  const records = new Map<string, PipelineSchedule>();
  const failures: MemoryRemote['failures'] = {};
  const deletes = new Map<string, PipelineSchedule | null>();
  const now = (): string => new Date().toISOString();
  // Synchronous bodies: a thrown refusal rejects the promise it returns.
  const settle = <T>(run: () => T): Promise<T> => {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };
  const create = (
    params: Omit<PipelineScheduleCreateParams, '_meta'>,
  ): PipelineSchedule => {
    if (failures.create === 'refused')
      throw new CloudScheduleRemoteError({
        kind: 'permission_denied',
        code: 'core.pipeline.schedule.ownerDenied',
        message: "You can't schedule runs for this owner.",
        retry: { kind: 'never' },
      });
    const taken = [...records.values()].find(
      (record) => record.sourceRecordId === params.sourceRecordId,
    );
    if (taken)
      throw new CloudScheduleRemoteError({
        kind: 'already_exists',
        code: 'core.pipeline.schedule.sourceRecordTaken',
        message: 'This schedule is already in the cloud.',
        details: { scheduleId: taken.scheduleId },
        retry: { kind: 'never' },
      });
    const record: PipelineSchedule = {
      scheduleId: randomUUID(),
      revision: 1,
      owner: params.owner,
      name: params.name,
      sourcePipelineId: params.sourcePipelineId,
      sourceRecordId: params.sourceRecordId,
      workflow:
        params.workflow.kind === 'definition'
          ? params.workflow
          : {
              kind: 'snapshot',
              contentHash: params.workflow.contentHash,
              packageDigest: params.workflow.packageDigest,
            },
      trigger: params.trigger,
      runCondition: params.runCondition ?? null,
      enabled: params.enabled,
      inputs: { ...(params.inputs ?? {}) },
      destination: params.destination,
      createdAt: now(),
      updatedAt: now(),
    };
    records.set(record.scheduleId, record);
    // The server stored it, but its answer never arrived.
    if (failures.create === 'lost') {
      delete failures.create;
      throw new CloudScheduleRemoteError(null);
    }
    return record;
  };
  const update = (
    params: Parameters<CloudScheduleRemote['update']>[0],
  ): PipelineSchedule => {
    const current = records.get(params.scheduleId);
    if (!current || current.revision !== params.expectedRevision)
      throw new CloudScheduleRemoteError({
        kind: 'conflict',
        message: 'This schedule changed.',
        retry: { kind: 'never' },
      });
    const { owner, workflow, ...fields } = params;
    const rest: Partial<typeof fields> = { ...fields };
    delete rest.scheduleId;
    delete rest.expectedRevision;
    const next: PipelineSchedule = {
      ...current,
      ...rest,
      ...(owner === undefined ? {} : { owner }),
      ...(workflow === undefined || workflow.kind === 'definition'
        ? workflow === undefined
          ? {}
          : { workflow }
        : {
            workflow: {
              kind: 'snapshot',
              contentHash: workflow.contentHash,
              packageDigest: workflow.packageDigest,
            },
          }),
      runCondition:
        params.runCondition === undefined
          ? current.runCondition
          : params.runCondition,
      revision: current.revision + 1,
      updatedAt: now(),
    };
    records.set(params.scheduleId, next);
    return next;
  };
  const remote: CloudScheduleRemote = {
    accountId: () => Promise.resolve(ACCOUNT),
    create: (params) => settle(() => create(params)),
    get: (scheduleId) => Promise.resolve(records.get(scheduleId) ?? null),
    findBySourceRecord: (sourceRecordId) =>
      Promise.resolve(
        [...records.values()].find(
          (record) => record.sourceRecordId === sourceRecordId,
        ) ?? null,
      ),
    list: () => Promise.resolve([...records.values()]),
    update: (params) => settle(() => update(params)),
    delete: (scheduleId, idempotencyKey) =>
      settle(() => {
        // A resend with the same key replays the first answer.
        const replayed = deletes.get(idempotencyKey);
        if (replayed !== undefined) return replayed;
        if (failures.delete === 'unreachable')
          throw new CloudScheduleRemoteError(null);
        const record = records.get(scheduleId) ?? null;
        records.delete(scheduleId);
        deletes.set(idempotencyKey, record);
        // The server deleted it, but its answer never arrived.
        if (failures.delete === 'lost') {
          delete failures.delete;
          throw new CloudScheduleRemoteError(null);
        }
        return record;
      }),
  };
  return { remote, records, failures };
}

function schedule(
  id: string,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: 'Morning digest',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: `shared:canopy-cloud:${REMOTE_ID}`,
      pipelineSource: 'shared',
      sharedPipeline: { serverId: 'canopy-cloud', remoteId: REMOTE_ID },
      inputs: { project_id: 'p-1' },
    },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

async function seed(activities: ScheduledActivity[]): Promise<void> {
  await writeFile(
    join(mockDirectory, 'automations.json'),
    JSON.stringify({ version: 1, activities, recentRuns: [] }),
  );
}

function isActivity(value: unknown): value is ScheduledActivity {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string'
  );
}

async function stored(): Promise<ScheduledActivity[]> {
  const file: unknown = JSON.parse(
    await readFile(join(mockDirectory, 'automations.json'), 'utf8'),
  );
  if (
    typeof file !== 'object' ||
    file === null ||
    !('activities' in file) ||
    !Array.isArray(file.activities)
  )
    throw new Error('Unreadable automations file.');
  const activities: unknown[] = file.activities;
  return activities.filter(isActivity);
}

async function service(): Promise<
  MemoryRemote & { automations: AutomationsService }
> {
  const { AutomationsService } = await import('../service');
  const automations = new AutomationsService();
  const memory = memoryRemote();
  automations.setCloudScheduleRemote(memory.remote);
  return { automations, ...memory };
}

/** Records that fire for `id`: here when the local record is on, and in the cloud. */
async function liveRecords(
  id: string,
  records: Map<string, PipelineSchedule>,
): Promise<number> {
  const local = (await stored()).filter(
    (activity) =>
      activity.id === id && activity.enabled && firesLocally(activity),
  ).length;
  const cloud = [...records.values()].filter(
    (record) => record.sourceRecordId === id,
  ).length;
  return local + cloud;
}

beforeEach(async () => {
  mockDirectory = await mkdtemp(
    join(process.env.TMPDIR ?? process.cwd(), 'cloud-schedule-moves-'),
  );
});

afterEach(async () => {
  await rm(mockDirectory, { recursive: true, force: true });
});

describe('cloud workflow schedule moves (CAN-6183)', () => {
  it('stores a moved schedule server-side and keeps a stub this desktop never runs', async () => {
    await seed([schedule('s-1')]);
    const { automations, records } = await service();
    const moved = await automations.moveScheduleToCloud('s-1');
    expect(moved.ok).toBe(true);

    const [record] = [...records.values()];
    expect(record).toMatchObject({
      sourceRecordId: 's-1',
      owner: 'personal',
      enabled: true,
      workflow: {
        kind: 'definition',
        source: 'shared',
        definitionId: `shared:canopy-cloud:${REMOTE_ID}`,
      },
      trigger: { kind: 'cron', expression: '0 9 * * 1-5' },
      inputs: { project_id: 'p-1' },
      destination: { kind: 'global' },
    });
    const [stub] = await stored();
    // Stored off, so a desktop that predates the field never fires it.
    expect(stub).toMatchObject({
      executionLocation: 'cloud',
      enabled: false,
      cloudSchedule: {
        scheduleId: record.scheduleId,
        accountId: ACCOUNT,
        localEnabled: true,
      },
    });
    expect(stub.nextRunAt).toBeUndefined();
    expect(await liveRecords('s-1', records)).toBe(1);

    // The server record is authoritative: the service calls behind
    // IPC_CHANNELS.automationsUpdate and IPC_CHANNELS.automationsRunNow
    // refuse a stub.
    expect((await automations.update({ id: 's-1', enabled: true })).ok).toBe(
      false,
    );
    expect((await automations.runNow({ id: 's-1' })).ok).toBe(false);

    // Desktop and web show one schedule: IPC_CHANNELS.automationsList's
    // projection shows the stub with the server's values.
    const edited = await automations.updateCloudSchedule('s-1', {
      enabled: false,
      schedule: { kind: 'cron', expression: '30 7 * * *', timezone: 'local' },
    });
    expect(edited.ok).toBe(true);
    const { projectOwnedChatAutomations } =
      await import('../owned-chat-projection');
    const [shown] = projectOwnedChatAutomations(
      await automations.list(),
    ).activities;
    expect(shown).toMatchObject({
      enabled: false,
      schedule: { expression: '30 7 * * *' },
      cloudRecord: { scheduleId: record.scheduleId, revision: 2 },
    });
  });

  it('stores several schedules of one workflow', async () => {
    await seed([schedule('s-1'), schedule('s-2', { name: 'Evening digest' })]);
    const { automations, records } = await service();
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    expect((await automations.moveScheduleToCloud('s-2')).ok).toBe(true);
    expect(
      [...records.values()].map((record) => [
        record.sourceRecordId,
        record.sourcePipelineId,
      ]),
    ).toEqual([
      ['s-1', `shared:canopy-cloud:${REMOTE_ID}`],
      ['s-2', `shared:canopy-cloud:${REMOTE_ID}`],
    ]);
  });

  it('moves back by deleting the server record first, never leaving two live records', async () => {
    await seed([schedule('s-1')]);
    const { automations, records, failures } = await service();
    await automations.moveScheduleToCloud('s-1');
    const [record] = [...records.values()];
    // Edited in the cloud since this desktop last read it.
    records.set(record.scheduleId, {
      ...record,
      revision: 2,
      trigger: { kind: 'cron', expression: '15 6 * * *', timeZone: 'UTC' },
      runCondition: 'test -f ready',
    });

    // The server can't be reached: nothing here changes, the stub stays off.
    failures.delete = 'unreachable';
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(false);
    expect((await stored())[0].executionLocation).toBe('cloud');
    expect(await liveRecords('s-1', records)).toBe(1);

    // The server deleted it but the answer was lost: the stub stays off, and
    // the retry replays the deleted record under the same key.
    failures.delete = 'lost';
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(false);
    expect(records.size).toBe(0);
    expect((await stored())[0].executionLocation).toBe('cloud');
    expect(await liveRecords('s-1', records)).toBe(0);
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(true);
    expect(records.size).toBe(0);
    const [local] = await stored();
    expect(local.executionLocation).toBeUndefined();
    expect(local.cloudSchedule).toBeUndefined();
    // It comes back as the cloud held it.
    expect(local).toMatchObject({
      enabled: true,
      schedule: { kind: 'cron', expression: '15 6 * * *', timezone: 'local' },
      ifCommand: 'test -f ready',
    });
    expect(local.nextRunAt).toBeDefined();
    expect(await liveRecords('s-1', records)).toBe(1);

    // And back again: still exactly one live record.
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    expect(await liveRecords('s-1', records)).toBe(1);
  });

  it('moves back with the owner and workflow the cloud record holds', async () => {
    await seed([schedule('s-1')]);
    const { automations, records } = await service();
    await automations.moveScheduleToCloud('s-1');
    const [record] = [...records.values()];
    const org = 'org:00000000-0000-4000-8000-00000000000a';
    records.set(record.scheduleId, {
      ...record,
      revision: 2,
      owner: org,
      workflow: {
        kind: 'definition',
        source: 'curated',
        definitionId: 'curated:digest',
      },
    });
    expect((await automations.moveScheduleToLocal('s-1')).ok).toBe(true);
    const [local] = await stored();
    expect(local.executionContext).toBe(org);
    expect(local.action).toMatchObject({
      type: 'worktree_pipeline',
      pipelineSource: 'curated',
      pipelineId: 'curated:digest',
    });
    expect(
      local.action.type === 'worktree_pipeline' && local.action.sharedPipeline,
    ).toBeFalsy();
  });

  it('keeps a move whose answer was lost paused until it is resolved', async () => {
    await seed([schedule('s-1'), schedule('s-2')]);
    const { automations, records, failures } = await service();

    // A refused move puts the local record back as it was.
    failures.create = 'refused';
    expect((await automations.moveScheduleToCloud('s-2')).ok).toBe(false);
    expect((await stored())[1]).toMatchObject({ enabled: true });
    expect((await stored())[1].executionLocation).toBeUndefined();

    // The server stored it but the answer was lost: paused here, live there.
    failures.create = 'lost';
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(false);
    const [pending] = await stored();
    expect(pending).toMatchObject({
      executionLocation: 'cloud',
      enabled: false,
    });
    expect(pending.cloudSchedule?.scheduleId).toBeUndefined();
    expect(await liveRecords('s-1', records)).toBe(1);

    // Moving again takes over the record the first move left.
    expect((await automations.moveScheduleToCloud('s-1')).ok).toBe(true);
    expect(records.size).toBe(1);
    const [record] = [...records.values()];
    expect((await stored())[0].cloudSchedule?.scheduleId).toBe(
      record.scheduleId,
    );
    expect(await liveRecords('s-1', records)).toBe(1);
  });

  // IPC_CHANNELS.automationsDelete calls the service's delete.
  it('deletes a cloud schedule server-side before its stub', async () => {
    await seed([schedule('s-1')]);
    const { automations, records, failures } = await service();
    await automations.moveScheduleToCloud('s-1');
    failures.delete = 'unreachable';
    expect((await automations.delete({ id: 's-1' })).ok).toBe(false);
    expect(await stored()).toHaveLength(1);
    delete failures.delete;
    expect((await automations.delete({ id: 's-1' })).ok).toBe(true);
    expect(records.size).toBe(0);
    expect(await stored()).toHaveLength(0);
  });

  it('never fires a stub or a location it does not know, and keeps both', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await seed([
      // As if a stub were stored on: the location alone keeps it unfired.
      schedule('stub', {
        executionLocation: 'cloud',
        cloudSchedule: {
          scheduleId: randomUUID(),
          accountId: ACCOUNT,
          movedAt: past,
          localEnabled: true,
        },
        nextRunAt: past,
      }),
      schedule('elsewhere', {
        executionLocation: 'device:other',
        nextRunAt: past,
      }),
    ]);
    const { automations } = await service();
    await automations.start();
    automations.stop();
    const snapshot = await automations.list();
    expect(snapshot.recentRuns).toEqual([]);
    expect(
      snapshot.activities.map((activity) => [
        activity.id,
        activity.executionLocation,
      ]),
    ).toEqual([
      ['stub', 'cloud'],
      ['elsewhere', 'device:other'],
    ]);
    expect((await automations.runNow({ id: 'elsewhere' })).ok).toBe(false);
    expect((await automations.update({ id: 'elsewhere', name: 'x' })).ok).toBe(
      false,
    );
  });
});
