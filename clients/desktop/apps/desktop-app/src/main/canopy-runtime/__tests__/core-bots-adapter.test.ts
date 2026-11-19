import { APP_ADVISOR_BOT_ID, isBotId } from '@canopy/protocol/chat-targets';
import {
  BOT_GRANTS,
  BotIdSchema,
  type CanopyCallerDescriptor,
  type BotRecord,
  type BotResult,
} from '@canopy/protocol/canopy-core';
import { createBotRegistryStore } from '../../bots/registry-store';
import { createBotVisibility } from '../../bots/visibility';
import type { CoreBotsHost } from '../core-bots-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import { createDesktopRuntime } from '../desktop-runtime';

const PROJECT_ID = 'workspace-one';

interface ExperimentState {
  enabled: boolean;
}

interface BotsFixture {
  readonly host: CoreBotsHost;
  readonly experiment: ExperimentState;
  readonly writeCount: () => number;
  readonly createHost: () => CoreBotsHost;
}

function caller(
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor {
  return {
    principalId: 'desktop-main-bots-test',
    clientInstanceId: 'desktop-main-bots-test',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants,
  };
}

function meta(idempotencyKey: string): { idempotencyKey: string } {
  return { idempotencyKey };
}

function createFixture(experiment: ExperimentState): BotsFixture {
  let persisted: string | undefined;
  let writes = 0;
  let timestamp = 0;
  const projectExists = (projectId: string): Promise<boolean> =>
    Promise.resolve(projectId === PROJECT_ID);
  const createHost = (): CoreBotsHost => {
    const store = createBotRegistryStore({
      filePath: '/scratch/bots.json',
      now: (): Date => new Date(Date.UTC(2026, 10, 14, 0, 0, timestamp++)),
      isEnabled: (): boolean => experiment.enabled,
      projectExists,
      log: (): void => undefined,
      fileSystem: {
        readFile: (): Promise<string> => {
          if (persisted !== undefined) return Promise.resolve(persisted);
          const missingFileError: Error & { code: string } = Object.assign(
            new Error('The isolated registry starts empty.'),
            { code: 'ENOENT' },
          );
          return Promise.reject(missingFileError);
        },
        rename: (): Promise<void> => Promise.resolve(),
        readdir: (): Promise<string[]> => Promise.resolve([]),
        unlink: (): Promise<void> => Promise.resolve(),
      },
      writeAtomically: (...[, contents]: [string, string]): Promise<void> => {
        persisted = contents;
        writes += 1;
        return Promise.resolve();
      },
    });
    const visibility = createBotVisibility({
      store,
      isEnabled: (): boolean => experiment.enabled,
      projectExists,
    });
    return { store, visibility };
  };
  return {
    host: createHost(),
    experiment,
    writeCount: (): number => writes,
    createHost,
  };
}

describe('core.bots on the desktop dispatcher (BOTS-02)', () => {
  it('accepts exactly the Bot IDs that chat-targets accepts', (): void => {
    const ulid = '01jcrb6qz2v0m4n8t9xyz5abcd';
    const samples = [
      APP_ADVISOR_BOT_ID,
      `bot_${ulid}`,
      `bot_${ulid.toUpperCase()}`,
      `bot_${ulid.slice(1)}`,
      `bot_${ulid}0`,
      `bot_${ulid.slice(0, 25)}i`,
      `bot--${ulid}`,
      'app-advisor',
      'bot_',
      '',
    ];
    for (const sample of samples)
      expect([sample, BotIdSchema.safeParse(sample).success]).toEqual([
        sample,
        isBotId(sample),
      ]);
  });

  it('uses Bot visibility when the experiment is off and refuses writes', async (): Promise<void> => {
    const experiment: ExperimentState = { enabled: true };
    const fixture = createFixture(experiment);
    const runtime = createDesktopRuntime({ botsHost: fixture.host });
    const reader = caller([BOT_GRANTS.read]);
    const writer = caller([BOT_GRANTS.write]);
    const both = caller([BOT_GRANTS.read, BOT_GRANTS.write]);
    try {
      await expect(
        runtime.query('core.bots.list', {}, { caller: caller([]) }),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        runtime.instruction(
          'core.bots.create',
          { name: 'Denied', _meta: meta('denied-create') },
          { caller: reader, metadata: meta('denied-create') },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        runtime.query('core.bots.list', {}, { caller: writer }),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      expect(fixture.writeCount()).toBe(0);

      const createBeforeOffMetadata = meta('create-before-off');
      const createBeforeOffParams = {
        name: 'Hidden Bot',
        _meta: createBeforeOffMetadata,
      };
      const created = await runtime.instruction(
        'core.bots.create',
        createBeforeOffParams,
        { caller: both, metadata: createBeforeOffMetadata },
      );
      fixture.experiment.enabled = false;

      await expect(
        runtime.instruction('core.bots.create', createBeforeOffParams, {
          caller: both,
          metadata: createBeforeOffMetadata,
        }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          code: 'core.bots.unavailable',
        },
      });

      const list = await runtime.query(
        'core.bots.list',
        {},
        { caller: reader },
      );
      expect(list.bots.map((bot) => bot.botId)).toEqual([APP_ADVISOR_BOT_ID]);
      await expect(
        runtime.query(
          'core.bots.get',
          { botId: APP_ADVISOR_BOT_ID },
          { caller: reader },
        ),
      ).resolves.toMatchObject({ bot: { botId: APP_ADVISOR_BOT_ID } });
      await expect(
        runtime.query(
          'core.bots.get',
          { botId: created.bot.botId },
          { caller: reader },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'not_found',
          code: 'core.bots.notFound',
          details: { reason: 'unknown_bot' },
        },
      });
      await expect(
        runtime.instruction(
          'core.bots.create',
          { name: 'Unavailable', _meta: meta('create-while-off') },
          { caller: both, metadata: meta('create-while-off') },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          code: 'core.bots.unavailable',
          details: { reason: 'experiment_off' },
        },
      });
      expect(fixture.writeCount()).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it('replays the original create result after a restart and a rename', async (): Promise<void> => {
    const fixture = createFixture({ enabled: true });
    const both = caller([BOT_GRANTS.read, BOT_GRANTS.write]);
    const createMetadata = meta('restart-create');
    const createParams = {
      name: 'Before restart rename',
      _meta: createMetadata,
    };
    const firstRuntime = createDesktopRuntime({ botsHost: fixture.host });
    let created: BotResult;
    try {
      created = await firstRuntime.instruction(
        'core.bots.create',
        createParams,
        { caller: both, metadata: createMetadata },
      );
    } finally {
      await firstRuntime.shutdown();
    }

    const updateMetadata = meta('restart-update');
    const secondRuntime = createDesktopRuntime({
      botsHost: fixture.createHost(),
    });
    try {
      await secondRuntime.instruction(
        'core.bots.update',
        {
          botId: created.bot.botId,
          expectedRevision: created.bot.revision,
          patch: { name: 'After restart rename' },
          _meta: updateMetadata,
        },
        { caller: both, metadata: updateMetadata },
      );
    } finally {
      await secondRuntime.shutdown();
    }

    const restartedRuntime = createDesktopRuntime({
      botsHost: fixture.createHost(),
    });
    try {
      await expect(
        restartedRuntime.instruction('core.bots.create', createParams, {
          caller: both,
          metadata: createMetadata,
        }),
      ).resolves.toEqual(created);
      const list = await restartedRuntime.query(
        'core.bots.list',
        {},
        { caller: caller([BOT_GRANTS.read]) },
      );
      expect(list.bots.map((bot) => bot.botId)).toEqual([
        APP_ADVISOR_BOT_ID,
        created.bot.botId,
      ]);
      expect(fixture.writeCount()).toBe(2);
    } finally {
      await restartedRuntime.shutdown();
    }
  });

  it('serves CRUD and pins, fences revisions, and replays operation receipts', async (): Promise<void> => {
    const fixture = createFixture({ enabled: true });
    const runtime = createDesktopRuntime({ botsHost: fixture.host });
    const reader = caller([BOT_GRANTS.read]);
    const both = caller([BOT_GRANTS.read, BOT_GRANTS.write]);
    const createMetadata = meta('create-review-bot');
    const updateMetadata = meta('update-review-bot');
    const pinsMetadata = meta('pins-review-bot');
    const deleteMetadata = meta('delete-review-bot');
    try {
      const initial = await runtime.query(
        'core.bots.list',
        {},
        { caller: reader },
      );
      const defaultBot = initial.bots[0];
      expect(defaultBot?.botId).toBe(APP_ADVISOR_BOT_ID);

      const createParams = {
        name: 'Review Bot',
        pins: [PROJECT_ID],
        _meta: createMetadata,
      };
      const created = await runtime.instruction(
        'core.bots.create',
        createParams,
        { caller: both, metadata: createMetadata },
      );
      const retryCreateMetadata = {
        ...createMetadata,
        traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      };
      const createReplay = await runtime.instruction(
        'core.bots.create',
        { ...createParams, _meta: retryCreateMetadata },
        { caller: both, metadata: retryCreateMetadata },
      );
      expect(createReplay).toEqual(created);
      expect(created.bot.pins.map((pin) => pin.projectId)).toEqual([
        PROJECT_ID,
      ]);
      expect(fixture.writeCount()).toBe(1);
      await expect(
        runtime.instruction(
          'core.bots.create',
          { name: 'Changed Params', pins: [PROJECT_ID], _meta: createMetadata },
          { caller: both, metadata: createMetadata },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'conflict' } });

      const updateParams = {
        botId: created.bot.botId,
        expectedRevision: created.bot.revision,
        patch: { name: 'Review Bot 2' },
        _meta: updateMetadata,
      };
      const updated = await runtime.instruction(
        'core.bots.update',
        updateParams,
        { caller: both, metadata: updateMetadata },
      );
      const updateReplay = await runtime.instruction(
        'core.bots.update',
        updateParams,
        { caller: both, metadata: updateMetadata },
      );
      expect(updateReplay).toEqual(updated);
      expect(updated.bot.revision).toBe(2);
      expect(fixture.writeCount()).toBe(2);
      await expect(
        runtime.instruction(
          'core.bots.update',
          {
            ...updateParams,
            patch: { pinnedToTop: true },
          },
          { caller: both, metadata: updateMetadata },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
      await expect(
        runtime.instruction(
          'core.bots.update',
          {
            botId: created.bot.botId,
            expectedRevision: created.bot.revision,
            patch: { pinnedToTop: true },
            _meta: meta('stale-revision'),
          },
          { caller: both, metadata: meta('stale-revision') },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'conflict',
          code: 'core.bots.revisionConflict',
          details: { reason: 'revision_conflict' },
        },
      });
      expect(fixture.writeCount()).toBe(2);

      await expect(
        runtime.instruction(
          'core.bots.create',
          { name: 'Review Bot 2', _meta: meta('duplicate-name') },
          { caller: both, metadata: meta('duplicate-name') },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'already_exists',
          code: 'core.bots.nameConflict',
          details: { reason: 'name_conflict' },
        },
      });
      await expect(
        runtime.instruction(
          'core.bots.pins.set',
          {
            botId: created.bot.botId,
            expectedRevision: updated.bot.revision,
            projectIds: ['missing-project'],
            _meta: meta('unknown-project'),
          },
          { caller: both, metadata: meta('unknown-project') },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'not_found',
          code: 'core.bots.unknownProject',
          details: { reason: 'unknown_project' },
        },
      });

      const pinsSet = await runtime.instruction(
        'core.bots.pins.set',
        {
          botId: created.bot.botId,
          expectedRevision: updated.bot.revision,
          projectIds: [],
          _meta: pinsMetadata,
        },
        { caller: both, metadata: pinsMetadata },
      );
      expect(pinsSet.bot.revision).toBe(3);
      expect(pinsSet.bot.pins).toEqual([]);
      expect(fixture.writeCount()).toBe(3);
      await expect(
        runtime.instruction('core.bots.update', updateParams, {
          caller: both,
          metadata: updateMetadata,
        }),
      ).resolves.toEqual(updated);

      const protectedDeleteRevision = defaultBot?.revision ?? 0;
      await expect(
        runtime.instruction(
          'core.bots.delete',
          {
            botId: APP_ADVISOR_BOT_ID,
            expectedRevision: protectedDeleteRevision,
            _meta: meta('protected-delete'),
          },
          { caller: both, metadata: meta('protected-delete') },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.bots.defaultBotProtected',
          details: { reason: 'default_bot_protected' },
        },
      });

      const deleteParams = {
        botId: created.bot.botId,
        expectedRevision: pinsSet.bot.revision,
        _meta: deleteMetadata,
      };
      const deleted = await runtime.instruction(
        'core.bots.delete',
        deleteParams,
        { caller: both, metadata: deleteMetadata },
      );
      expect(deleted.bot.deletedAt).not.toBeNull();
      expect(fixture.writeCount()).toBe(4);
      await expect(
        runtime.query(
          'core.bots.get',
          { botId: created.bot.botId },
          { caller: reader },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'not_found', code: 'core.bots.notFound' },
      });
      const finalList = await runtime.query(
        'core.bots.list',
        {},
        { caller: reader },
      );
      expect(finalList.bots.map((bot) => bot.botId)).toEqual([
        APP_ADVISOR_BOT_ID,
      ]);
      await expect(
        runtime.instruction('core.bots.delete', deleteParams, {
          caller: both,
          metadata: deleteMetadata,
        }),
      ).resolves.toEqual(deleted);
    } finally {
      await runtime.shutdown();
    }
  });

  it('maps unknown host failures to a content-free storage failure', async (): Promise<void> => {
    const fixture = createFixture({ enabled: true });
    const brokenHost: CoreBotsHost = {
      store: fixture.host.store,
      visibility: {
        readVisibleBots: (): Promise<BotRecord[]> =>
          Promise.reject(new Error('private registry path')),
        readVisibleBot: (botId: string): Promise<BotRecord> =>
          fixture.host.visibility.readVisibleBot(botId),
      },
    };
    const runtime = createDesktopRuntime({ botsHost: brokenHost });
    try {
      await expect(
        runtime.query(
          'core.bots.list',
          {},
          { caller: caller([BOT_GRANTS.read]) },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          code: 'core.bots.storageFailed',
          message: 'The Bots registry could not be read or updated.',
          details: { reason: 'storage_failed' },
        },
      });
    } finally {
      await runtime.shutdown();
    }
  });
});
