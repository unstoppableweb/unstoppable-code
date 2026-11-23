// CAN-7522: Electron main answers the definitions' owner requests for a
// daemon that commits definition writes: the in-process checks before the
// commit, the desktop's own effects around it, and a reconcile pass. Every
// effect is keyed by the definition, so applying it twice changes nothing,
// and a reconcile after a crash on either side of a commit leaves the state
// as if the effects had run, never touching a live definition's.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { WorkerPipelineHostRequest } from '@canopy/protocol/canopy-core';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import {
  GOLDEN_BUNDLED_PIPELINE_ID,
  GOLDEN_BUNDLED_PIPELINE_YAML,
} from '@canopy/execution-engine/node/pipelines/__tests__/golden-fixtures';
import * as pluginCollectionStore from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import { getUserPipelineIndexPath } from '@canopy/execution-engine/pipelines/config-paths';
import {
  deleteStoredPipeline,
  getStoredPipelinePath,
  getStoredPipelineText,
  saveStoredPipeline,
  updateStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import {
  readSharedItemSubscriptionLedger,
  recordSharedItemInstall,
} from '../../canopy-cloud/shared-item-subscriptions';
import { getPipelinePackageInstallStorePath } from '../../lib/paths';
import { answerDaemonDefinitionOwnerRequest } from '../../pipelines/daemon-definition-owner-requests';
import * as installContext from '../../pipelines/pipeline-install-context';
import {
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
} from '../../pipelines/pipeline-local-metadata-store';
import {
  listPipelinePackageInstalls,
  upsertPipelinePackageInstall,
} from '../../pipelines/pipeline-package-install-store';
import * as packageService from '../../pipelines/pipeline-package-service';
import * as resourceLanes from '../../pipelines/resource-lanes';
import {
  createPipelineGoldenWorld,
  GOLDEN_CURATED_KEY,
  GOLDEN_CURATED_YAML,
  GOLDEN_WORKSPACE_ID,
  GOLDEN_WORKTREE_ID,
  type GoldenWorld,
} from './world';

jest.setTimeout(120_000);

let world: GoldenWorld;

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
});

afterAll(async () => {
  await world.dispose();
});

type DefinitionAction = Extract<
  WorkerPipelineHostRequest['request'],
  { action: 'owner.definition.precheck' | 'owner.definition.effects' }
>;

function envelope(request: DefinitionAction): WorkerPipelineHostRequest {
  return {
    requestId: randomUUID(),
    executionId: 'core:pipeline-definitions',
    jobId: '_run',
    stepId: '_run',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: null,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    request,
  };
}

async function answer(
  request: DefinitionAction,
  signal = new AbortController().signal,
): Promise<unknown> {
  return (await answerDaemonDefinitionOwnerRequest(envelope(request), signal))
    .result;
}

const RECONCILE: DefinitionAction = {
  action: 'owner.definition.effects',
  op: 'reconcile',
  phase: 'reconcile',
  definitionId: null,
};

/** What a request came to: its result, or the message it failed with. */
async function outcomeOf(request: Promise<unknown>): Promise<unknown> {
  return request.then(
    (result) => result,
    (error: unknown) => (error instanceof Error ? error.message : error),
  );
}

/** A call that waits at its start until released, then runs as it would. */
function pausedAt<A extends unknown[], R>(
  real: (...args: A) => Promise<R>,
  spy: jest.SpyInstance<Promise<R>, A>,
): { reached: Promise<void>; release: () => void; restore: () => void } {
  let reach = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  spy.mockImplementationOnce(async (...args: A) => {
    reach();
    await released;
    return real(...args);
  });
  return { reached, release, restore: () => spy.mockRestore() };
}

const ALLOWED = {
  status: 'owner',
  value: { kind: 'definition.precheck', answer: { allowed: true } },
};
const APPLIED = { status: 'owner', value: { kind: 'definition.effects' } };

function yaml(name: string): string {
  return [
    'pipeline:',
    `  name: ${name}`,
    '  on: { dispatch: {} }',
    '  jobs:',
    '    run:',
    '      steps:',
    '        - run: echo effects',
    '',
  ].join('\n');
}

const locator = (
  value: string,
): { type: 'stored'; source: 'user'; value: string } => ({
  type: 'stored',
  source: 'user',
  value,
});

/** A user definition with every desktop sidecar a delete takes with it. */
async function withSidecars(name: string): Promise<string> {
  const id = await world.saveUserPipeline(
    yaml(name),
    `pipeline:${name.toLowerCase().replaceAll(' ', '-')}`,
  );
  recordUserPipelineOwner(id, 'personal');
  await pluginCollectionStore.savePipelinePluginCollectionPreferences(
    locator(id),
    {
      'golden-collection': {
        disabledDefaultKeys: [],
        extraSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      },
    },
    'electron_main',
  );
  await upsertPipelinePackageInstall(getPipelinePackageInstallStorePath(), {
    localPipelineId: id,
    pipelineContentHash: hashPipelinePackageYaml(
      getStoredPipelineText(id).data ?? '',
    ),
    distributionMode: 'package',
    packageDigest: `pp:v1:${'a'.repeat(43)}`,
    installedAt: new Date().toISOString(),
  });
  recordSharedItemInstall({
    kind: 'pipeline',
    remoteId: `golden-remote-${id}`,
    sourceKind: 'shared',
    contentHash: null,
    localId: id,
  });
  return id;
}

interface Sidecars {
  readonly owner: string | null;
  readonly collections: readonly string[];
  readonly install: boolean;
  readonly ledger: boolean;
}

async function sidecarsOf(id: string): Promise<Sidecars> {
  const installs = await listPipelinePackageInstalls(
    getPipelinePackageInstallStorePath(),
  );
  const ledger = await readSharedItemSubscriptionLedger();
  return {
    owner: readPipelineLocalMetadata(locator(id)).owner ?? null,
    collections: Object.keys(
      pluginCollectionStore.loadPipelinePluginCollectionPreferences(
        locator(id),
      ),
    ),
    install: installs.some((install) => install.localPipelineId === id),
    ledger: ledger.installs.some(
      (install) => install.kind === 'pipeline' && install.localIds.includes(id),
    ),
  };
}

const ALL: Sidecars = {
  owner: 'personal',
  collections: ['golden-collection'],
  install: true,
  ledger: true,
};
const NONE: Sidecars = {
  owner: null,
  collections: [],
  install: false,
  ledger: false,
};

/** Waits for the effects a write leaves in the background to land. */
async function settled(id: string, expected: Sidecars): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (JSON.stringify(await sidecarsOf(id)) === JSON.stringify(expected))
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await sidecarsOf(id)).toEqual(expected);
}

describe('daemon definition owner requests (CAN-7522)', () => {
  it('each effect applied twice leaves the same state, and a resent precheck writes nothing', async () => {
    const deleted = await withSidecars('Owner effects deleted');
    const edited = await withSidecars('Owner effects edited');
    await settled(deleted, ALL);
    await settled(edited, ALL);

    // A precheck is a read: sent twice, both allowed, nothing written.
    for (let round = 0; round < 2; round += 1) {
      await expect(
        answer({
          action: 'owner.definition.precheck',
          op: 'delete',
          definitionId: deleted,
          scope: {},
        }),
      ).resolves.toEqual(ALLOWED);
      await expect(
        answer({
          action: 'owner.definition.precheck',
          op: 'upsert',
          definitionId: edited,
          scope: {},
        }),
      ).resolves.toEqual(ALLOWED);
    }
    expect(await sidecarsOf(deleted)).toEqual(ALL);
    expect(await sidecarsOf(edited)).toEqual(ALL);

    // The daemon committed the delete; its effects land once or twice alike.
    deleteStoredPipeline(deleted);
    for (let round = 0; round < 2; round += 1) {
      await expect(
        answer({
          action: 'owner.definition.effects',
          op: 'delete',
          phase: 'afterCommit',
          definitionId: deleted,
        }),
      ).resolves.toEqual(APPLIED);
      await settled(deleted, NONE);
    }

    // An edit drops the copy's package install, once or twice alike, and
    // leaves its other sidecars.
    for (let round = 0; round < 2; round += 1) {
      await expect(
        answer({
          action: 'owner.definition.effects',
          op: 'upsert',
          phase: 'afterCommit',
          definitionId: edited,
        }),
      ).resolves.toEqual(APPLIED);
      await settled(edited, { ...ALL, install: false });
    }
    deleteStoredPipeline(edited);
  });

  it('a reconcile after a crash on either side of a commit leaves the state as if the effects had run', async () => {
    const live = await withSidecars('Owner effects live');
    const crashedDelete = await withSidecars('Owner effects crashed delete');
    const crashedEdit = await withSidecars('Owner effects crashed edit');
    for (const id of [live, crashedDelete, crashedEdit]) await settled(id, ALL);

    // After the commit, before the effects: the delete and the edit
    // committed, and the app never heard.
    deleteStoredPipeline(crashedDelete);
    const edit = updateStoredPipeline(crashedEdit, {
      name: 'Edited after install',
      description: '',
      icon: '',
      content: {
        name: 'Edited after install',
        on: { dispatch: {} },
        jobs: { run: { steps: [{ id: 'echo', run: 'echo edited' }] } },
      },
    });
    expect(edit.success).toBe(true);
    // Before the commit: a copy's effects applied, and the copy never stored.
    const uncommitted = randomUUID();
    await expect(
      answer({
        action: 'owner.definition.effects',
        op: 'duplicate',
        phase: 'beforeCommit',
        definitionId: uncommitted,
        origin: { source: 'user', definitionId: live },
      }),
    ).resolves.toEqual(APPLIED);

    await expect(
      answer({
        action: 'owner.definition.effects',
        op: 'reconcile',
        phase: 'reconcile',
        definitionId: null,
      }),
    ).resolves.toEqual(APPLIED);

    await settled(crashedDelete, NONE);
    // The edited copy's install no longer matches its document.
    await settled(crashedEdit, { ...ALL, install: false });
    await settled(uncommitted, NONE);
    // A live definition keeps everything.
    expect(await sidecarsOf(live)).toEqual(ALL);
    for (const id of [live, crashedEdit]) deleteStoredPipeline(id);
  });

  it('a reconcile over an index that is not sound reconciles nothing and fails', async () => {
    const live = await withSidecars('Owner effects unsound index');
    await settled(live, ALL);
    const indexPath = getUserPipelineIndexPath();
    const sound = readFileSync(indexPath);
    const mode = statSync(indexPath).mode & 0o777;
    const spoils: readonly (readonly [string, () => void])[] = [
      ['unreadable', (): void => chmodSync(indexPath, 0o000)],
      ['damaged', (): void => writeFileSync(indexPath, '{ not json')],
      [
        'newer',
        (): void =>
          writeFileSync(
            indexPath,
            JSON.stringify({ version: 2, pipelines: [] }),
          ),
      ],
    ];
    for (const [status, spoil] of spoils) {
      spoil();
      try {
        await expect(
          answer({
            action: 'owner.definition.effects',
            op: 'reconcile',
            phase: 'reconcile',
            definitionId: null,
          }),
        ).rejects.toThrow(`The workflow list is ${status}`);
        expect(await sidecarsOf(live)).toEqual(ALL);
      } finally {
        chmodSync(indexPath, mode);
        writeFileSync(indexPath, sound);
      }
    }
    deleteStoredPipeline(live);
  });

  it('a reconcile keeps every record of a definition it cannot read, and fails', async () => {
    const malformed = await withSidecars('Owner effects malformed row');
    const unreadable = await withSidecars('Owner effects unreadable document');
    const missing = await withSidecars('Owner effects missing document');
    const unlisted = await withSidecars('Owner effects unlisted document');
    const ids = [malformed, unreadable, missing, unlisted];
    for (const id of ids) await settled(id, ALL);
    // A row whose document is gone, or a document no row lists, holds no
    // definition, as the store reads it.
    unlinkSync(getStoredPipelinePath(missing).data ?? '');
    const indexPath = getUserPipelineIndexPath();
    const sound = readFileSync(indexPath, 'utf8');
    const document = getStoredPipelinePath(unreadable).data ?? '';
    const mode = statSync(document).mode & 0o777;
    // The index still reads as sound: one row holds a field of the wrong type.
    const index = JSON.parse(sound) as { pipelines: Record<string, unknown>[] };
    index.pipelines = index.pipelines.filter((row) => row.id !== unlisted);
    for (const row of index.pipelines)
      if (row.id === malformed) row.updatedAt = 42;
    writeFileSync(indexPath, JSON.stringify(index));
    chmodSync(document, 0o000);
    try {
      const outcome = await outcomeOf(answer(RECONCILE));
      expect({
        malformed: await sidecarsOf(malformed),
        unreadable: await sidecarsOf(unreadable),
      }).toEqual({ malformed: ALL, unreadable: ALL });
      await settled(missing, NONE);
      await settled(unlisted, NONE);
      expect(outcome).toBe(
        '2 workflows could not be read, so their records were kept.',
      );
    } finally {
      chmodSync(document, mode);
      writeFileSync(indexPath, sound);
    }
    for (const id of ids) deleteStoredPipeline(id);
  });

  it('a withdrawn reconcile never touches a definition committed after it', async () => {
    const paused = pausedAt(
      packageService.listPackageInstalls,
      jest.spyOn(packageService, 'listPackageInstalls'),
    );
    const withdraw = new AbortController();
    try {
      const reconcile = outcomeOf(answer(RECONCILE, withdraw.signal));
      await paused.reached;
      withdraw.abort();
      const committed = await withSidecars('Owner effects after withdrawal');
      await settled(committed, ALL);
      paused.release();
      const outcome = await reconcile;
      expect(await sidecarsOf(committed)).toEqual(ALL);
      // The withdrawal ends the pass.
      expect(outcome).toBe(withdraw.signal.reason);
      deleteStoredPipeline(committed);
    } finally {
      paused.restore();
    }
  });

  it('a withdrawn reconcile removes nothing past the point it stopped', async () => {
    const orphan = await withSidecars('Owner effects withdrawn orphan');
    await settled(orphan, ALL);
    deleteStoredPipeline(orphan);
    const paused = pausedAt(
      pluginCollectionStore.prunePipelinePreferenceSelections,
      jest.spyOn(pluginCollectionStore, 'prunePipelinePreferenceSelections'),
    );
    const withdraw = new AbortController();
    try {
      const reconcile = outcomeOf(answer(RECONCILE, withdraw.signal));
      await paused.reached;
      withdraw.abort();
      paused.release();
      const outcome = await reconcile;
      // The install and local metadata went before the withdrawal; the plugin
      // collection preferences and the ledger entry come after it.
      expect(await sidecarsOf(orphan)).toEqual({
        ...ALL,
        owner: null,
        install: false,
      });
      expect(outcome).toBe(withdraw.signal.reason);
    } finally {
      paused.restore();
    }
    await answer(RECONCILE);
    await settled(orphan, NONE);
  });

  it('a reconcile whose index goes missing during the pass removes nothing', async () => {
    const live = await withSidecars('Owner effects index removed');
    await settled(live, ALL);
    const indexPath = getUserPipelineIndexPath();
    const sound = readFileSync(indexPath);
    const mode = statSync(indexPath).mode & 0o777;
    const paused = pausedAt(
      packageService.listPackageInstalls,
      jest.spyOn(packageService, 'listPackageInstalls'),
    );
    try {
      const reconcile = outcomeOf(answer(RECONCILE));
      await paused.reached;
      unlinkSync(indexPath);
      paused.release();
      const outcome = await reconcile;
      expect(await sidecarsOf(live)).toEqual(ALL);
      expect(String(outcome)).toMatch(
        /could not be read, so their records were kept\.$/,
      );
    } finally {
      paused.restore();
      writeFileSync(indexPath, sound);
      chmodSync(indexPath, mode);
    }
    deleteStoredPipeline(live);
  });

  it("a reconcile keeps a bundled definition's install, and drops it from an edited user copy that shadows it", async () => {
    const installs = getPipelinePackageInstallStorePath();
    const installed = async (): Promise<boolean> =>
      (await listPipelinePackageInstalls(installs)).some(
        (install) => install.localPipelineId === GOLDEN_BUNDLED_PIPELINE_ID,
      );
    await upsertPipelinePackageInstall(installs, {
      localPipelineId: GOLDEN_BUNDLED_PIPELINE_ID,
      pipelineContentHash: hashPipelinePackageYaml(
        GOLDEN_BUNDLED_PIPELINE_YAML,
      ),
      distributionMode: 'package',
      packageDigest: `pp:v1:${'b'.repeat(43)}`,
      installedAt: new Date().toISOString(),
    });
    await expect(answer(RECONCILE)).resolves.toEqual(APPLIED);
    expect(await installed()).toBe(true);

    // A user copy under the bundled id holds other bytes than the install's.
    const copy = saveStoredPipeline(
      {
        name: 'Shadowing copy',
        description: '',
        icon: '',
        content: {
          name: 'Shadowing copy',
          on: { dispatch: {} },
          jobs: { run: { steps: [{ id: 'echo', run: 'echo shadowing' }] } },
        },
      },
      { id: GOLDEN_BUNDLED_PIPELINE_ID },
    );
    expect(copy.success).toBe(true);
    try {
      await expect(answer(RECONCILE)).resolves.toEqual(APPLIED);
      expect(await installed()).toBe(false);
    } finally {
      deleteStoredPipeline(GOLDEN_BUNDLED_PIPELINE_ID);
    }
  });

  it("a precheck answers the in-process check's refusal, and a copy's source only this app can read", async () => {
    const contexts = jest
      .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
      .mockReturnValue(true);
    const projectOwner = jest
      .spyOn(installContext, 'readProjectPipelineOwner')
      .mockResolvedValue({
        type: 'organization',
        id: 'org-golden',
        name: null,
      });
    try {
      await expect(
        answer({
          action: 'owner.definition.precheck',
          op: 'duplicate',
          definitionId: null,
          origin: { source: 'project', definitionId: 'project--golden.yaml' },
          scope: {
            workspaceId: GOLDEN_WORKSPACE_ID,
            worktreeId: GOLDEN_WORKTREE_ID,
          },
        }),
      ).resolves.toEqual({
        status: 'owner',
        value: {
          kind: 'definition.precheck',
          answer: {
            allowed: false,
            code: 'contextMismatch',
            message: 'Workflow unavailable (context-mismatch)',
          },
        },
      });
    } finally {
      projectOwner.mockRestore();
      contexts.mockRestore();
    }

    const curated = await answer({
      action: 'owner.definition.precheck',
      op: 'duplicate',
      definitionId: null,
      origin: {
        source: 'curated',
        definitionId: `curated:${GOLDEN_CURATED_KEY}`,
      },
      scope: {},
    });
    expect(curated).toMatchObject({
      status: 'owner',
      value: {
        kind: 'definition.precheck',
        answer: { allowed: true, source: { format: 'yaml' } },
      },
    });
    expect(JSON.stringify(curated)).toContain(
      JSON.stringify(GOLDEN_CURATED_YAML).slice(1, 40),
    );

    // A stored source is the daemon's own to read.
    await expect(
      answer({
        action: 'owner.definition.precheck',
        op: 'duplicate',
        definitionId: null,
        origin: { source: 'user', definitionId: world.userPipelineId },
        scope: {},
      }),
    ).resolves.toEqual(ALLOWED);
  });
});
