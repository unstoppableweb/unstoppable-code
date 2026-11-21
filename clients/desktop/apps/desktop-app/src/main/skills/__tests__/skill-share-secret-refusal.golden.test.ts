/**
 * CAN-7226: sharing a single skill never uploads SKILL.md text that looks
 * like it holds a secret. `createSharedSkill` and `updateSharedSkill` in the
 * skill cloud client are what the share dialog's IPC handlers and the
 * `skills.share` agent action send through; they refuse before sending any
 * request, with a message naming the skill, file and rule, never the secret,
 * even when the secret sits in the skill's name. The publish flow carries
 * SKILL.md in its package, so it refuses before the package commit. An
 * update that resends the stored text unchanged, or makes it private, isn't a
 * new share and still goes through, as on the server.
 *
 * Sharing a collection does the same for each inline custom skill:
 * `createSharedCollection` and `updateSharedCollection` in the collection
 * cloud client, which the share dialog, the Collections tab, Remote Control
 * and App Advisor all reach through the collection handlers, refuse before
 * any read or request, so a refused share or update makes no network call.
 */
import { createHash } from 'node:crypto';
import { CatalogHostRefusedError } from '@canopy/core-runtime/node/catalog';
import { COLLECTIONS_CHANNELS } from '@canopy/desktop-shared/constants/collection-channels';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import { buildSharedCollectionPayload } from '@canopy/desktop-shared/collections/shared-collection-payload';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';
import type {
  SharedCollectionCustomSkillPayload,
  SharedCollectionDetail,
} from '@canopy/protocol/collections';
import {
  findPackageFileCredentialRule,
  type InstalledSkillInfo,
  type SharedSkillDetail,
} from '@canopy/protocol/skills';
import { requestCanopyCloudJson } from '../../canopy-cloud/client';

// Every other cloud request a collection share could make is recorded, so a
// refusal can show it made none at all.
const mockOtherRequests: string[] = [];
jest.mock('../../canopy-cloud/client', () => {
  const actual = jest.requireActual<
    Record<string, (...args: unknown[]) => unknown>
  >('../../canopy-cloud/client');
  const recorded =
    (name: string) =>
    (...args: unknown[]): unknown => {
      mockOtherRequests.push(name);
      return actual[name]?.(...args);
    };
  return {
    ...actual,
    requestCanopyCloudJson: jest.fn(),
    requestCanopyCloudJsonConditional: recorded(
      'requestCanopyCloudJsonConditional',
    ),
    requestCanopyCloudNoContent: recorded('requestCanopyCloudNoContent'),
    requestCanopyCloudBinary: recorded('requestCanopyCloudBinary'),
    requestCanopyCloudPublicBinary: recorded('requestCanopyCloudPublicBinary'),
    requestCanopyCloudPublicJson: recorded('requestCanopyCloudPublicJson'),
    resolveCanopyCloudCredentialContext: (): Promise<unknown> =>
      Promise.resolve({ apiKey: 'k', account: { id: 'acct-1' } }),
    assertCanopyCloudCapability: (): Promise<void> => Promise.resolve(),
  };
});
// Off unless a case turns it on: with it on, an update reads the stored
// share before its PUT, and a refusal must come before that read too.
let mockResourceContextOn = false;
jest.mock('../../lib/resource-context', () => ({
  ...jest.requireActual<object>('../../lib/resource-context'),
  resourceContextEnabled: (): boolean => mockResourceContextOn,
  resourceContextSnapshot: (): Promise<string> => Promise.resolve('snapshot'),
  assertResourceContext: (): Promise<void> => Promise.resolve(),
}));
const mockStoreReads: string[] = [];
jest.mock('../../collections/collection-store', () => ({
  readCollectionConfig: (id: string): Promise<unknown> => {
    mockStoreReads.push(id);
    return Promise.resolve({
      collection: { id, name: 'Deploy kit', mcpServers: [] },
    });
  },
  writeCollectionRemoteMetadata: (): Promise<boolean> => Promise.resolve(true),
  clearCollectionRemoteMetadataByRemoteId: (): Promise<void> =>
    Promise.resolve(),
}));
jest.mock('../resource-lanes', () => ({
  ...jest.requireActual<object>('../resource-lanes'),
  skillResourceContextEnabled: (): boolean => false,
}));
jest.mock('../skill-service', () => ({
  writeSkillRemoteMetadata: (): void => undefined,
}));
const mockWarnings: string[] = [];
jest.mock('../../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../../lib/main-process-logging'),
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarnings.push(JSON.stringify(args));
  },
}));
type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockIpcHandlers = new Map<string, IpcHandler>();
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
}));
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: IpcHandler): void => {
    mockIpcHandlers.set(channel, handler);
  },
}));

import { registerSkillHandlers } from '../skill-handlers';
import {
  createSharedCollectionForCaller,
  registerCollectionHandlers,
  updateSharedCollectionForCaller,
} from '../../collections/collection-handlers';
import {
  createSharedCollection,
  updateSharedCollection,
} from '../../collections/canopy-server-client';
import {
  dispatchAdvisorCollectionSharingAction,
  type AdvisorCollectionSharingHost,
} from '../../app-advisor/advisor-collection-sharing-actions';
import { createSharedSkill, updateSharedSkill } from '../canopy-server-client';
import { SkillSecretDetectedError } from '../../sharing/share-operation-result';
import {
  publishSkillToCloud,
  type PublishSkillDeps,
} from '../publish-skill-to-cloud';

// Built at runtime so no secret-shaped literal is committed.
const SENTINEL = `gh${'p'}_${'Q'.repeat(30)}`;
const SECRET_SKILL = `---\nname: deploy-helper\ndescription: Deploys.\n---\nUse ${SENTINEL} to deploy.\n`;
const PLACEHOLDER_SKILL =
  '---\nname: deploy-helper\ndescription: Deploys.\n---\nSet api_key: ${{ secrets.API_KEY }}\n';
const MESSAGE =
  'The skill "deploy-helper" looks like it contains a secret (a GitHub token in SKILL.md). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.';
const AT = '2026-11-19T00:00:00.000Z';
const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const detail = (rawSkill: string): SharedSkillDetail => ({
  id: 'remote-1',
  name: 'deploy-helper',
  description: 'Deploys.',
  contentHash: sha256(rawSkill),
  shareScope: 'private',
  owner: { type: 'user', id: 'u1', name: null },
  createdBy: { id: 'u1', name: null, email: null },
  createdAt: AT,
  updatedAt: AT,
  canUpdate: true,
  canDelete: true,
  publicShare: null,
  rawSkill,
});

const request = jest.mocked(requestCanopyCloudJson);
const invoke = (channel: string, body: object): Promise<unknown> => {
  const handler = mockIpcHandlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return handler({}, body);
};

beforeAll(() => {
  registerSkillHandlers();
  registerCollectionHandlers();
});
beforeEach(() => {
  request.mockReset();
  mockWarnings.length = 0;
  mockOtherRequests.length = 0;
  mockStoreReads.length = 0;
  mockResourceContextOn = false;
});
afterEach(() => {
  // The sentinel reaches no main-process log line on any path.
  expect(mockWarnings.join('\n')).not.toContain(SENTINEL);
});

describe('desktop single-skill share refuses secret-looking text before upload (CAN-7226)', () => {
  it.each([
    [
      'create',
      SKILLS_CHANNELS.SHARED_CREATE,
      { rawSkill: SECRET_SKILL, shareScope: 'private' },
    ],
    [
      'update',
      SKILLS_CHANNELS.SHARED_UPDATE,
      { skillId: 'remote-1', rawSkill: SECRET_SKILL },
    ],
  ])(
    'the share dialog %s fails as unavailable, naming skill, file and rule, and sends nothing',
    async (_case, channel, body) => {
      const result = await invoke(channel, body);
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'unavailable', stage: 'access', message: MESSAGE },
      });
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('the client every share path calls refuses create and update before any request', async () => {
    for (const call of [
      (): Promise<unknown> =>
        createSharedSkill({ rawSkill: SECRET_SKILL, shareScope: 'private' }),
      (): Promise<unknown> =>
        updateSharedSkill({ skillId: 'remote-1', rawSkill: SECRET_SKILL }),
      (): Promise<unknown> =>
        // The same stored text reaching a team that may not own it is a share.
        updateSharedSkill({
          skillId: 'remote-1',
          rawSkill: SECRET_SKILL,
          expectedContentHash: sha256(SECRET_SKILL),
          shareScope: 'team',
          teamId: 'team-1',
        }),
    ]) {
      const error: unknown = await call().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        name: 'SkillSecretDetectedError',
        kind: 'unavailable',
        stage: 'access',
        message: MESSAGE,
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('names a skill without frontmatter by its first heading', async () => {
    const error: unknown = await createSharedSkill({
      rawSkill: `# Deploy helper\n\nUse ${SENTINEL} to deploy.\n`,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error instanceof Error && error.message).toContain(
      'The skill "Deploy helper"',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('never repeats a secret that sits in the skill name', async () => {
    const error: unknown = await createSharedSkill({
      rawSkill: `# Deploy ${SENTINEL}\n\nUse ${SENTINEL} to deploy.\n`,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // The person sees a rename ask, never the name or a placeholder for it.
    expect(error instanceof Error && error.message).toBe(
      "This skill's name looks like it contains a secret (a GitHub token). Rename the skill, then share again.",
    );
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
    expect(request).not.toHaveBeenCalled();
  });

  it('still shares skill text that only names a placeholder, with one request', async () => {
    request.mockResolvedValue(detail(PLACEHOLDER_SKILL));
    await expect(
      invoke(SKILLS_CHANNELS.SHARED_CREATE, {
        rawSkill: PLACEHOLDER_SKILL,
        shareScope: 'private',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never rescans a stored skill: resending its text unchanged still updates', async () => {
    request.mockResolvedValue(detail(SECRET_SKILL));
    await expect(
      updateSharedSkill({
        skillId: 'remote-1',
        rawSkill: SECRET_SKILL,
        expectedContentHash: sha256(SECRET_SKILL),
      }),
    ).resolves.toMatchObject({ id: 'remote-1' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a takedown that keeps the stored package sends one PUT with preservePackage and no package fields', async () => {
    request.mockResolvedValue(detail(SECRET_SKILL));
    await expect(
      invoke(SKILLS_CHANNELS.SHARED_UPDATE, {
        skillId: 'remote-1',
        rawSkill: SECRET_SKILL,
        expectedContentHash: sha256(SECRET_SKILL),
        shareScope: 'private',
        preservePackage: true,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
    const init = request.mock.calls[0]?.[1];
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    expect(body).toMatchObject({
      preservePackage: true,
      shareScope: 'private',
    });
    expect(body).not.toHaveProperty('capabilityPackage');
    expect(body).not.toHaveProperty('committedPackageUploadId');
  });

  it('never blocks a takedown: stored text made private still updates', async () => {
    request.mockResolvedValue(detail(SECRET_SKILL));
    await expect(
      invoke(SKILLS_CHANNELS.SHARED_UPDATE, {
        skillId: 'remote-1',
        rawSkill: SECRET_SKILL,
        expectedContentHash: sha256(SECRET_SKILL),
        shareScope: 'private',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('publishing a skill to the cloud (core.catalog.entry.publish) refuses a secret-looking SKILL.md before its package uploads (CAN-7226)', () => {
  const ENTRY = 'skill:custom:app/helper';
  // Each trips only the shared profile: the package check lets it through,
  // so before this the package commit carried it to the cloud.
  const SHARED_ONLY = [
    [
      'a credential variable',
      `---\nname: helper\n---\nRun with NPM_TOKEN=npm_${'x'.repeat(8)} set.\n`,
    ],
    [
      'a password in a URL',
      '---\nname: helper\n---\nConnect to postgres://admin:pw@db/app.\n',
    ],
  ] as const;

  function publishFakes(rawSkill: string): {
    deps: PublishSkillDeps;
    commits: unknown[];
    creates: unknown[];
  } {
    const commits: unknown[] = [];
    const creates: unknown[] = [];
    const hash = sha256(rawSkill);
    const skill: InstalledSkillInfo = {
      name: 'helper',
      sourceId: 'custom:app',
      description: '',
      source: 'Custom',
      installedAt: AT,
      updatedAt: AT,
      updateAvailable: false,
    };
    const deps: PublishSkillDeps = {
      loadSkills: () => Promise.resolve([skill]),
      readRawSkill: () => Promise.resolve(rawSkill),
      installedSkillsEnabled: () => Promise.resolve(false),
      readInstalledSkill: () => Promise.reject(new Error('not installed')),
      fingerprintInstalledSkill: () =>
        Promise.reject(new Error('not installed')),
      assertCreateAudienceSupported: () =>
        Promise.reject(new Error('not asked for a custom skill')),
      analysisSubject: () =>
        Promise.resolve({
          sourceId: 'custom:app',
          skillName: 'helper',
          contentHash: hash,
          cloudCopy: true,
          audience: 'private',
          accountId: 'acct-1',
        }),
      analysisFacts: () =>
        Promise.resolve({
          contentHash: hash,
          ready: true,
          files: ['skill|claude|helper/SKILL.md'],
          withheld: [],
        }),
      credentials: () =>
        Promise.resolve({
          accountId: 'acct-1',
          context: { baseUrl: 'https://cloud.example', apiKey: 'k' },
        }),
      commitPackage: (pkg) => {
        commits.push(pkg);
        return Promise.resolve({
          capabilityPackage: { version: 1, digest: 'pp:v1:abc' },
          committedPackageUploadId: 'upload-1',
        });
      },
      createSharedSkill: (createRequest) => {
        creates.push(createRequest);
        return Promise.resolve({ ...detail(rawSkill), id: 'remote-new' });
      },
      updateSharedSkill: () => Promise.reject(new Error('no linked copy')),
      writeLink: () => Promise.resolve(),
      writeConsent: () => Promise.resolve(),
      now: () => AT,
      linkedCopyAudience: () => Promise.resolve('private'),
    };
    return { deps, commits, creates };
  }

  const PKG = {
    analysisId: 'analysis-1',
    selectedOptionalResourceIds: [],
    keepInStep: true,
  };

  it.each(SHARED_ONLY)(
    'refuses SKILL.md holding %s with no package upload and no request',
    async (label, rawSkill) => {
      expect(
        findPackageFileCredentialRule(new TextEncoder().encode(rawSkill)),
      ).toBeNull();
      const { deps, commits, creates } = publishFakes(rawSkill);
      const error: unknown = await publishSkillToCloud(ENTRY, PKG, deps, {
        expectedAccountId: 'acct-1',
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(CatalogHostRefusedError);
      // Its own refusal, so core shows the skill, file and rule.
      expect(error).toMatchObject({ refusal: 'publish-secret-detected' });
      const cause = error instanceof Error ? error.cause : undefined;
      expect(cause instanceof Error && cause.message).toBe(
        `The skill "helper" looks like it contains a secret (${label} in SKILL.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`,
      );
      expect(commits).toEqual([]);
      expect(creates).toEqual([]);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('maps a custom skill the package carries that looks like it holds a secret to its own refusal', async () => {
    const { deps, creates } = publishFakes(PLACEHOLDER_SKILL);
    // The upload's own check refuses a dependency skill; that's a secret
    // refusal naming it, never an unreachable cloud.
    deps.commitPackage = (): Promise<never> =>
      Promise.reject(
        new SkillSecretDetectedError(
          'The skill "deploy-env" looks like it contains a secret (a credential variable in SKILL.md). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.',
          'prepare',
        ),
      );
    const error: unknown = await publishSkillToCloud(ENTRY, PKG, deps, {
      expectedAccountId: 'acct-1',
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CatalogHostRefusedError);
    expect(error).toMatchObject({ refusal: 'publish-secret-detected' });
    expect(creates).toEqual([]);
  });

  it('names a skill the copy carries that looks like it holds a secret, never calling the files changed', async () => {
    const { deps, commits, creates } = publishFakes(PLACEHOLDER_SKILL);
    const message =
      'The skill "deploy-env" looks like it contains a secret (a credential variable in SKILL.md). Remove it, or replace it with a placeholder such as ${{ secrets.NAME }}, then share again.';
    const ready = deps.analysisFacts;
    deps.analysisFacts = async (
      analysisId,
      selected,
    ): ReturnType<typeof ready> => {
      const facts = await ready(analysisId, selected);
      return facts === null
        ? null
        : { ...facts, ready: false, secretRefusal: message };
    };
    const error: unknown = await publishSkillToCloud(ENTRY, PKG, deps, {
      expectedAccountId: 'acct-1',
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ refusal: 'publish-secret-detected' });
    const cause = error instanceof Error ? error.cause : undefined;
    expect(cause instanceof Error && cause.message).toBe(message);
    expect(commits).toEqual([]);
    expect(creates).toEqual([]);
  });

  it('still uploads the package of a SKILL.md that only names a placeholder', async () => {
    const { deps, commits, creates } = publishFakes(PLACEHOLDER_SKILL);
    await expect(
      publishSkillToCloud(ENTRY, PKG, deps, { expectedAccountId: 'acct-1' }),
    ).resolves.toMatchObject({ publicationId: 'remote-new' });
    expect(commits).toEqual([PKG]);
    expect(creates).toHaveLength(1);
  });
});

describe('desktop collection share refuses an inline custom skill holding secret-looking text before any request (CAN-7226)', () => {
  const COLLECTION_MESSAGE = MESSAGE;
  const RENAME_MESSAGE =
    "One of this collection's skills has a name that looks like it contains a secret (a GitHub token). Rename it, then share again.";
  const RAW_COLLECTION = JSON.stringify({
    version: 1,
    name: 'Deploy kit',
    description: '',
    items: [
      { type: 'custom_skill', clientKey: 'k1', skill_name: 'deploy-helper' },
    ],
  });
  const skills = (
    rawSkill: string,
    name = 'deploy-helper',
  ): SharedCollectionCustomSkillPayload[] => [
    { clientKey: 'k1', name, rawSkill },
  ];
  const collectionDetail = (): SharedCollectionDetail => ({
    id: 'remote-c1',
    name: 'Deploy kit',
    description: '',
    contentHash: sha256(RAW_COLLECTION),
    itemCounts: { skills: 0, plugins: 0, customSkills: 1 },
    shareScope: 'private',
    owner: { type: 'user', id: 'u1', name: null },
    createdBy: { id: 'u1', name: null, email: null },
    createdAt: AT,
    updatedAt: AT,
    canUpdate: true,
    canDelete: true,
    publicShare: null,
    rawCollection: RAW_COLLECTION,
    collection: {
      version: 1,
      name: 'Deploy kit',
      description: '',
      items: [],
    },
    customSkills: [],
  });

  const consoleLines: string[] = [];
  const spies: jest.SpyInstance[] = [];
  beforeEach(() => {
    consoleLines.length = 0;
    for (const method of ['log', 'info', 'warn', 'error'] as const)
      spies.push(
        jest.spyOn(console, method).mockImplementation((...args) => {
          consoleLines.push(JSON.stringify(args));
        }),
      );
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    expect(consoleLines.join('\n')).not.toContain(SENTINEL);
  });

  const expectNoRequest = (): void => {
    expect(request).not.toHaveBeenCalled();
    expect(mockOtherRequests).toEqual([]);
    expect(mockStoreReads).toEqual([]);
  };
  const caught = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  it.each([
    [
      'create',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        rawCollection: RAW_COLLECTION,
        customSkills: skills(SECRET_SKILL),
        shareScope: 'private',
      },
    ],
    [
      'update',
      COLLECTIONS_CHANNELS.SHARED_UPDATE,
      {
        collectionId: 'remote-c1',
        rawCollection: RAW_COLLECTION,
        customSkills: skills(SECRET_SKILL),
      },
    ],
  ])(
    'the share dialog %s fails as unavailable, naming skill, file and rule, and sends nothing',
    async (_case, channel, body) => {
      const result = await invoke(channel, body);
      expect(result).toMatchObject({
        ok: false,
        failure: {
          kind: 'unavailable',
          stage: 'access',
          message: COLLECTION_MESSAGE,
        },
      });
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      expectNoRequest();
    },
  );

  it('the client refuses create and update, even an update that would first read the stored share, with zero requests', async () => {
    mockResourceContextOn = true;
    for (const call of [
      (): Promise<unknown> =>
        createSharedCollection({
          sourceCollectionId: 'local-c1',
          rawCollection: RAW_COLLECTION,
          customSkills: skills(PLACEHOLDER_SKILL).concat(skills(SECRET_SKILL)),
          shareScope: 'team',
          teamId: 'team-1',
        }),
      (): Promise<unknown> =>
        updateSharedCollection({
          sourceCollectionId: 'local-c1',
          collectionId: 'remote-c1',
          rawCollection: RAW_COLLECTION,
          customSkills: skills(SECRET_SKILL),
          shareScope: 'organization',
          organizationId: 'org-1',
        }),
    ]) {
      const error = await caught(call());
      expect(error).toBeInstanceOf(SkillSecretDetectedError);
      expect(error).toMatchObject({
        kind: 'unavailable',
        stage: 'access',
        message: COLLECTION_MESSAGE,
      });
      expect(JSON.stringify(error)).not.toContain(SENTINEL);
    }
    expectNoRequest();
  });

  it('never repeats a secret that sits in a custom skill name', async () => {
    for (const call of [
      (): Promise<unknown> =>
        createSharedCollectionForCaller({
          rawCollection: RAW_COLLECTION,
          customSkills: skills(PLACEHOLDER_SKILL, `deploy-${SENTINEL}`),
        }),
      (): Promise<unknown> =>
        updateSharedCollectionForCaller({
          collectionId: 'remote-c1',
          rawCollection: RAW_COLLECTION,
          customSkills: skills(SECRET_SKILL, `deploy-${SENTINEL}`),
        }),
    ]) {
      const result = await call();
      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'unavailable', message: RENAME_MESSAGE },
      });
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    }
    expectNoRequest();
  });

  describe('App Advisor, through the real collection handlers', () => {
    const LOCAL: CollectionConfig = {
      id: 'local-c1',
      name: 'Deploy kit',
      description: '',
      skills: [],
      plugins: [],
      mcpServers: [],
      createdAt: AT,
      updatedAt: AT,
    };
    const advisorHost = (rawSkill: string): AdvisorCollectionSharingHost => ({
      selectedOrganizationId: () => undefined,
      memberOrganizationIds: () => Promise.resolve(new Set<string>()),
      loadCollection: () => Promise.resolve(LOCAL),
      editable: () =>
        Promise.resolve({
          remoteId: '',
          name: 'Deploy kit',
          description: '',
          items: [
            {
              kind: 'draft_custom_skill',
              clientKey: 'k1',
              localSkillId: 'custom:app/deploy-helper',
              skillName: 'deploy-helper',
            },
          ],
        }),
      payload: (editable) =>
        buildSharedCollectionPayload({
          ...editable,
          customSkillReader: () => Promise.resolve(rawSkill),
        }),
      listShared: () => Promise.reject(new Error('not listed')),
      // The advisor's own read of the current share carries no skill text.
      getShared: () => Promise.resolve(collectionDetail()),
      createShared: createSharedCollectionForCaller,
      updateShared: updateSharedCollectionForCaller,
      deleteShared: () => Promise.reject(new Error('not deleted')),
      resolveImport: () => Promise.reject(new Error('not imported')),
      saveCollection: () => Promise.reject(new Error('not saved')),
      installPackage: () => Promise.reject(new Error('not installed')),
      confirm: () => Promise.reject(new Error('not asked')),
    });

    it.each([
      [
        'collections.share',
        {
          type: 'collections.share',
          id: 'local-c1',
          shareScope: 'team',
          teamId: 'team-1',
        },
      ],
      [
        'collections.update_shared',
        {
          type: 'collections.update_shared',
          id: 'local-c1',
          collectionId: 'remote-c1',
        },
      ],
    ] as const)(
      '%s fails as execution_failed with the refusal and sends nothing',
      async (_case, action) => {
        const response = await dispatchAdvisorCollectionSharingAction(
          action,
          advisorHost(SECRET_SKILL),
        );
        expect(response).toMatchObject({
          ok: false,
          error: { code: 'execution_failed', message: COLLECTION_MESSAGE },
        });
        expect(JSON.stringify(response)).not.toContain(SENTINEL);
        expectNoRequest();
      },
    );

    it('still shares a collection whose skill only names a placeholder, with one request', async () => {
      request.mockResolvedValue(collectionDetail());
      const response = await dispatchAdvisorCollectionSharingAction(
        {
          type: 'collections.share',
          id: 'local-c1',
          shareScope: 'team',
          teamId: 'team-1',
        },
        advisorHost(PLACEHOLDER_SKILL),
      );
      expect(response).toMatchObject({ ok: true });
      expect(request).toHaveBeenCalledTimes(1);
      const init = request.mock.calls[0]?.[1];
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      expect(body).toMatchObject({
        customSkills: skills(PLACEHOLDER_SKILL),
      });
    });
  });

  it.each([
    [
      'create',
      COLLECTIONS_CHANNELS.SHARED_CREATE,
      {
        rawCollection: RAW_COLLECTION,
        customSkills: skills(PLACEHOLDER_SKILL),
        shareScope: 'private',
      },
    ],
    [
      'update',
      COLLECTIONS_CHANNELS.SHARED_UPDATE,
      {
        collectionId: 'remote-c1',
        rawCollection: RAW_COLLECTION,
        customSkills: skills(PLACEHOLDER_SKILL),
      },
    ],
  ])(
    'still sends a %s whose skills only name a placeholder, with one request',
    async (_case, channel, body) => {
      request.mockResolvedValue(collectionDetail());
      await expect(invoke(channel, body)).resolves.toMatchObject({
        ok: true,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(mockOtherRequests).toEqual([]);
    },
  );

  it('still sends an update that links its custom skills and carries no inline text', async () => {
    request.mockResolvedValue(collectionDetail());
    await expect(
      updateSharedCollection({
        collectionId: 'remote-c1',
        rawCollection: RAW_COLLECTION,
        shareScope: 'private',
      }),
    ).resolves.toMatchObject({ id: 'remote-c1' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
