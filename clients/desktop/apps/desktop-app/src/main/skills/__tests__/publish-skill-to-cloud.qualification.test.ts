import { createHash } from 'node:crypto';
import { CatalogHostRefusedError } from '@canopy/core-runtime/node/catalog';
import type { ShareRemoteMetadata } from '@canopy/protocol/sharing';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/protocol/skills';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
} from '../../canopy-cloud/client';
import type { SkillAnalysisSubject } from '../../pipelines/pipeline-package-service';
import { ShareOperationError } from '../../sharing/share-operation-result';
import { createSharedSkill, updateSharedSkill } from '../canopy-server-client';
import {
  publishSkillToCloud,
  type PublishSkillDeps,
} from '../publish-skill-to-cloud';

jest.mock('../../canopy-cloud/client', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/client'),
  requestCanopyCloudJson: jest.fn(),
}));
jest.mock('../resource-lanes', () => ({
  ...jest.requireActual<object>('../resource-lanes'),
  skillResourceContextEnabled: (): boolean => false,
}));

const RAW = '---\nname: helper\n---\nHelp.\n';
const HASH = createHash('sha256').update(RAW).digest('hex');
const AT = '2026-11-10T00:00:00.000Z';
const ENTRY = 'skill:custom:app/helper';
const PKG = { analysisId: 'analysis-1', selectedOptionalResourceIds: ['r1'] };
const PACKAGE_REF = { version: 1, digest: 'pp:v1:abc' } as const;

const installed = (remote?: ShareRemoteMetadata): InstalledSkillInfo => ({
  name: 'helper',
  sourceId: 'custom:app',
  description: '',
  source: 'Custom',
  installedAt: AT,
  updatedAt: AT,
  updateAvailable: false,
  ...(remote === undefined ? {} : { remote }),
});

const detail = (
  id: string,
  overrides: Partial<SharedSkillDetail> = {},
): SharedSkillDetail => ({
  id,
  name: 'helper',
  description: '',
  contentHash: 'c'.repeat(64),
  shareScope: 'private',
  owner: { type: 'user', id: 'u1', name: null },
  createdBy: { id: 'u1', name: null, email: null },
  createdAt: AT,
  updatedAt: AT,
  canUpdate: true,
  canDelete: true,
  publicShare: null,
  rawSkill: RAW,
  ...overrides,
});

/** The one context a publish resolves; another account's never reaches a call. */
const CONTEXT = {
  baseUrl: 'https://cloud.example',
  apiKey: 'key-acct-1',
} as const;

interface Recorded {
  contexts: unknown[];
  committed: unknown[];
  created: unknown[];
  updated: unknown[];
  links: [string, ShareRemoteMetadata][];
}

function fakes(
  overrides: Partial<PublishSkillDeps> = {},
  skills: InstalledSkillInfo[] = [installed()],
): { deps: PublishSkillDeps; recorded: Recorded } {
  const recorded: Recorded = {
    contexts: [],
    committed: [],
    created: [],
    updated: [],
    links: [],
  };
  const deps: PublishSkillDeps = {
    loadSkills: () => Promise.resolve(skills),
    readRawSkill: () => Promise.resolve(RAW),
    analysisSubject: () =>
      Promise.resolve({
        sourceId: 'custom:app',
        skillName: 'helper',
        contentHash: HASH,
      }),
    credentials: () =>
      Promise.resolve({ accountId: 'acct-1', context: { ...CONTEXT } }),
    commitPackage: (pkg, context) => {
      recorded.contexts.push(context);
      recorded.committed.push(pkg);
      return Promise.resolve({
        capabilityPackage: PACKAGE_REF,
        committedPackageUploadId: 'upload-1',
      });
    },
    createSharedSkill: (request, context) => {
      recorded.contexts.push(context);
      recorded.created.push(request);
      return Promise.resolve(detail('remote-new'));
    },
    updateSharedSkill: (request, context) => {
      recorded.contexts.push(context);
      recorded.updated.push(request);
      return Promise.resolve(detail('remote-old'));
    },
    writeLink: (localId, remote) => {
      recorded.links.push([localId, remote]);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, recorded };
}

const refusal = (reason: string): unknown =>
  expect.objectContaining({ refusal: reason });

describe('publishing a desktop skill to the cloud (CAN-6176)', () => {
  it('uploads an unlinked custom skill and its consented package as a private copy, and links it', async () => {
    const { deps, recorded } = fakes();
    await expect(publishSkillToCloud(ENTRY, PKG, deps)).resolves.toEqual({
      publicationId: 'remote-new',
      remoteEntryId: 'skill:cloud-custom/remote-new',
      revision: 'c'.repeat(64),
    });
    expect(recorded.committed).toEqual([PKG]);
    expect(recorded.created).toEqual([
      {
        sourceSkillId: 'custom:app/helper',
        rawSkill: RAW,
        shareScope: 'private',
        capabilityPackage: PACKAGE_REF,
        committedPackageUploadId: 'upload-1',
        expectedSourceSha256: HASH,
      },
    ]);
    expect(recorded.links).toEqual([
      [
        'custom:app/helper',
        {
          accountId: 'acct-1',
          remoteId: 'remote-new',
          contentHash: 'c'.repeat(64),
          shareScope: 'private',
          sharedAt: AT,
        },
      ],
    ]);
  });

  it('updates a linked copy in its own scope against the hash it was last published with', async () => {
    const link: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'team',
      sharedAt: AT,
    };
    const { deps, recorded } = fakes({}, [installed(link)]);
    await publishSkillToCloud(ENTRY, PKG, deps);
    expect(recorded.created).toEqual([]);
    expect(recorded.updated).toEqual([
      {
        sourceSkillId: 'custom:app/helper',
        skillId: 'remote-old',
        rawSkill: RAW,
        expectedContentHash: 'd'.repeat(64),
        capabilityPackage: PACKAGE_REF,
        committedPackageUploadId: 'upload-1',
        expectedSourceSha256: HASH,
      },
    ]);

    // Another account's link is not this account's copy.
    const other = fakes({}, [installed({ ...link, accountId: 'acct-2' })]);
    await publishSkillToCloud(ENTRY, PKG, other.deps);
    expect(other.recorded.updated).toEqual([]);
    expect(other.recorded.created).toHaveLength(1);

    // A linked copy deleted in the cloud starts a new private one.
    const gone = fakes(
      {
        updateSharedSkill: () =>
          Promise.reject(
            new CanopyCloudClientError('http-error', 'Not found', 404),
          ),
      },
      [installed(link)],
    );
    await expect(publishSkillToCloud(ENTRY, PKG, gone.deps)).resolves.toEqual(
      expect.objectContaining({ publicationId: 'remote-new' }),
    );
  });

  it('uploads nothing when the skill changed after its package was analysed', async () => {
    for (const analysisSubject of [
      (): Promise<SkillAnalysisSubject | null> =>
        Promise.resolve({
          sourceId: 'custom:app',
          skillName: 'helper',
          contentHash: 'e'.repeat(64),
        }),
      (): Promise<SkillAnalysisSubject | null> => Promise.resolve(null),
    ]) {
      const { deps, recorded } = fakes({ analysisSubject });
      await expect(publishSkillToCloud(ENTRY, PKG, deps)).rejects.toEqual(
        refusal('publish-package-stale'),
      );
      expect(recorded.committed).toEqual([]);
      expect(recorded.created).toEqual([]);
    }
  });

  it("uploads nothing when the package's analysis covered another skill, even with these exact bytes", async () => {
    for (const subject of [
      { sourceId: 'custom:app', skillName: 'another-skill' },
      { sourceId: 'project:repo', skillName: 'helper' },
    ]) {
      const { deps, recorded } = fakes({
        analysisSubject: () =>
          Promise.resolve({ ...subject, contentHash: HASH }),
      });
      await expect(publishSkillToCloud(ENTRY, PKG, deps)).rejects.toEqual(
        refusal('publish-package-stale'),
      );
      expect(recorded.contexts).toEqual([]);
      expect(recorded.committed).toEqual([]);
      expect(recorded.created).toEqual([]);
    }
  });

  it('answers packageStale when the package commit or the share client finds the checked content outdated', async () => {
    const outdated = new ShareOperationError(
      'dependency-review',
      'Dependency analysis expired. Run the analysis again.',
      'prepare',
    );
    for (const overrides of [
      { commitPackage: (): Promise<never> => Promise.reject(outdated) },
      { createSharedSkill: (): Promise<never> => Promise.reject(outdated) },
    ]) {
      const { deps, recorded } = fakes(overrides);
      await expect(publishSkillToCloud(ENTRY, PKG, deps)).rejects.toEqual(
        refusal('publish-package-stale'),
      );
      expect(recorded.links).toEqual([]);
    }
  });

  it('sends no SKILL.md bytes other than the ones the publish checked', async () => {
    const request = jest.mocked(requestCanopyCloudJson);
    request.mockClear();
    const edited = `${RAW}An edit made after the check.\n`;
    await expect(
      createSharedSkill({ rawSkill: edited, expectedSourceSha256: HASH }),
    ).rejects.toMatchObject({ kind: 'dependency-review' });
    await expect(
      updateSharedSkill({
        skillId: 'remote-old',
        rawSkill: edited,
        expectedSourceSha256: HASH,
      }),
    ).rejects.toMatchObject({ kind: 'dependency-review' });
    expect(request).not.toHaveBeenCalled();
  });

  it('resolves the account once and sends the package, the copy and the link under it', async () => {
    let resolved = 0;
    const { deps, recorded } = fakes({
      // A later resolution would name another account; none may happen.
      credentials: () => {
        resolved += 1;
        return Promise.resolve(
          resolved === 1
            ? { accountId: 'acct-1', context: { ...CONTEXT } }
            : {
                accountId: 'acct-2',
                context: { ...CONTEXT, apiKey: 'key-acct-2' },
              },
        );
      },
    });
    await publishSkillToCloud(ENTRY, PKG, deps);
    expect(resolved).toBe(1);
    expect(recorded.contexts).toHaveLength(2);
    const [commit, create] = recorded.contexts;
    expect(create).toBe(commit);
    expect(commit).toEqual(CONTEXT);
    expect(recorded.links.map(([, link]) => link.accountId)).toEqual([
      'acct-1',
    ]);
  });

  it('never starts a new copy when a 404 comes after an account switch', async () => {
    const link: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'private',
      sharedAt: AT,
    };
    let resolved = 0;
    const { deps, recorded } = fakes(
      {
        credentials: () => {
          resolved += 1;
          return Promise.resolve(
            resolved === 1
              ? { accountId: 'acct-1', context: { ...CONTEXT } }
              : {
                  accountId: 'acct-2',
                  context: { ...CONTEXT, apiKey: 'key-acct-2' },
                },
          );
        },
        updateSharedSkill: (): Promise<never> =>
          Promise.reject(new CanopyCloudClientError('http-error', 'Gone', 404)),
      },
      [installed(link)],
    );
    await expect(publishSkillToCloud(ENTRY, PKG, deps)).rejects.toEqual(
      refusal('publish-remote-unavailable'),
    );
    expect(recorded.created).toEqual([]);
    expect(recorded.links).toEqual([]);
  });

  it('refuses built-in, project and missing skills before reading the cloud', async () => {
    for (const [entryId, reason] of [
      ['skill:builtin:app/helper', 'publish-source-unsupported'],
      ['skill:workspace/helper', 'publish-source-unsupported'],
      ['skill:custom:app/gone', 'publish-entry-not-found'],
    ] as const) {
      const { deps, recorded } = fakes();
      await expect(publishSkillToCloud(entryId, PKG, deps)).rejects.toEqual(
        refusal(reason),
      );
      expect(recorded.committed).toEqual([]);
    }
  });

  it('maps a signed-out desktop, a moved copy and an unreachable cloud to refusals, and links nothing', async () => {
    for (const [overrides, reason] of [
      [
        {
          credentials: (): Promise<never> =>
            Promise.reject(
              new CanopyCloudClientError('missing-api-key', 'Sign in'),
            ),
        },
        'publish-remote-unavailable',
      ],
      [
        {
          createSharedSkill: (): Promise<never> =>
            Promise.reject(
              new CanopyCloudClientError('http-error', 'Changed', 409),
            ),
        },
        'publish-revision-moved',
      ],
      [
        {
          commitPackage: (): Promise<never> =>
            Promise.reject(new CanopyCloudClientError('network-error', 'x')),
        },
        'publish-remote-unavailable',
      ],
    ] as const) {
      const { deps, recorded } = fakes(overrides);
      const failure = publishSkillToCloud(ENTRY, PKG, deps);
      await expect(failure).rejects.toBeInstanceOf(CatalogHostRefusedError);
      await expect(failure).rejects.toEqual(refusal(reason));
      expect(recorded.links).toEqual([]);
    }
  });

  it('does not link a deduplicated copy this account cannot update', async () => {
    const { deps, recorded } = fakes({
      createSharedSkill: () =>
        Promise.resolve(detail('someone-else', { canUpdate: false })),
    });
    await expect(publishSkillToCloud(ENTRY, PKG, deps)).resolves.toEqual(
      expect.objectContaining({ publicationId: 'someone-else' }),
    );
    expect(recorded.links).toEqual([]);
  });
});
