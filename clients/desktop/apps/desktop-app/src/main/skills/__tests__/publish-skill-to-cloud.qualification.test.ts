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
import {
  PackageAnalysisBlockedError,
  ShareOperationError,
} from '../../sharing/share-operation-result';
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
/** The account the person chose in the consent dialog. */
const CHOSEN = { expectedAccountId: 'acct-1' } as const;
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
        cloudCopy: true,
        audience: 'private',
        accountId: 'acct-1',
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
    linkedCopyAudience: () => Promise.resolve('private'),
    ...overrides,
  };
  return { deps, recorded };
}

const refusal = (reason: string): unknown =>
  expect.objectContaining({ refusal: reason });

describe('publishing a desktop skill to the cloud (CAN-6176)', () => {
  it('uploads an unlinked custom skill and its consented package as a private copy, and links it', async () => {
    const { deps, recorded } = fakes();
    await expect(
      publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
    ).resolves.toEqual({
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
    // The dialog named the team, and the copy still reaches only the team.
    const { deps, recorded } = fakes(
      {
        analysisSubject: () =>
          Promise.resolve({
            sourceId: 'custom:app',
            skillName: 'helper',
            contentHash: HASH,
            cloudCopy: true,
            accountId: 'acct-1',
            audience: 'team',
          }),
        linkedCopyAudience: () => Promise.resolve('team'),
      },
      [installed(link)],
    );
    await publishSkillToCloud(ENTRY, PKG, deps, CHOSEN);
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
        // The audience the dialog named, which the cloud checks as it writes.
        expectedAudience: 'team',
      },
    ]);

    // Another account's link is not this account's copy.
    const other = fakes({}, [installed({ ...link, accountId: 'acct-2' })]);
    await publishSkillToCloud(ENTRY, PKG, other.deps, CHOSEN);
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
    await expect(
      publishSkillToCloud(ENTRY, PKG, gone.deps, CHOSEN),
    ).resolves.toEqual(
      expect.objectContaining({ publicationId: 'remote-new' }),
    );
  });

  it('uploads nothing to a linked copy that reaches more people than the consent dialog said', async () => {
    const link: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'private',
      sharedAt: AT,
    };
    // The dialog said private; the copy is now shared with the team, or has
    // a public link.
    for (const now of ['team', 'organization', 'public_link'] as const) {
      const { deps, recorded } = fakes(
        { linkedCopyAudience: () => Promise.resolve(now) },
        [installed(link)],
      );
      await expect(
        publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
      ).rejects.toEqual(refusal('publish-package-stale'));
      // Not even the package leaves.
      expect(recorded.committed).toEqual([]);
      expect(recorded.updated).toEqual([]);
      expect(recorded.created).toEqual([]);
      expect(recorded.links).toEqual([]);
    }
    // An analysis whose dialog never named an audience uploads nothing.
    const unshown = fakes(
      {
        analysisSubject: () =>
          Promise.resolve({
            sourceId: 'custom:app',
            skillName: 'helper',
            contentHash: HASH,
            cloudCopy: true,
            accountId: 'acct-1',
            audience: null,
          }),
      },
      [installed(link)],
    );
    await expect(
      publishSkillToCloud(ENTRY, PKG, unshown.deps, CHOSEN),
    ).rejects.toEqual(refusal('publish-package-stale'));
    expect(unshown.recorded.committed).toEqual([]);
  });

  it("uploads nothing when the linked copy's audience can't be read at publish, whatever the local link says", async () => {
    // The local link says private even for a copy with a public link, so it
    // is never enough on its own.
    const link: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'private',
      sharedAt: AT,
    };
    const { deps, recorded } = fakes(
      {
        linkedCopyAudience: () =>
          Promise.reject(
            new CanopyCloudClientError(
              'network-error',
              'The cloud is unreachable.',
            ),
          ),
      },
      [installed(link)],
    );
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
      refusal('publish-remote-unavailable'),
    );
    expect(recorded.committed).toEqual([]);
    expect(recorded.updated).toEqual([]);
    expect(recorded.created).toEqual([]);
    expect(recorded.links).toEqual([]);
  });

  it('updates a publicly linked copy once the dialog named its public link', async () => {
    // As the desktop writes a public share: 'private' with no link recorded.
    const link: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'private',
      sharedAt: AT,
    };
    const { deps, recorded } = fakes(
      {
        analysisSubject: () =>
          Promise.resolve({
            sourceId: 'custom:app',
            skillName: 'helper',
            contentHash: HASH,
            cloudCopy: true,
            accountId: 'acct-1',
            audience: 'public_link',
          }),
        linkedCopyAudience: () => Promise.resolve('public_link'),
      },
      [installed(link)],
    );
    await publishSkillToCloud(ENTRY, PKG, deps, CHOSEN);
    expect(recorded.updated).toHaveLength(1);
    // The cloud checks the same audience again as it writes.
    expect(recorded.updated[0]).toMatchObject({
      expectedAudience: 'public_link',
    });
    expect(recorded.created).toEqual([]);
  });

  it('links nothing and asks again when the cloud finds, as it writes, that the copy reaches more people', async () => {
    const link: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'private',
      sharedAt: AT,
    };
    // The desktop's own read still saw a private copy; a public link was
    // published before the update reached the cloud.
    const { deps, recorded } = fakes(
      {
        linkedCopyAudience: () => Promise.resolve('private'),
        updateSharedSkill: (request) => {
          recorded.updated.push(request);
          return Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'Who can see this skill changed since it was checked',
              409,
              'audience_changed',
            ),
          );
        },
      },
      [installed(link)],
    );
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
      refusal('publish-package-stale'),
    );
    expect(recorded.updated).toMatchObject([{ expectedAudience: 'private' }]);
    expect(recorded.created).toEqual([]);
    expect(recorded.links).toEqual([]);
  });

  it('uploads nothing when the skill changed after its package was analysed', async () => {
    for (const analysisSubject of [
      (): Promise<SkillAnalysisSubject | null> =>
        Promise.resolve({
          sourceId: 'custom:app',
          skillName: 'helper',
          contentHash: 'e'.repeat(64),
          cloudCopy: true,
          audience: 'private',
          accountId: 'acct-1',
        }),
      (): Promise<SkillAnalysisSubject | null> => Promise.resolve(null),
    ]) {
      const { deps, recorded } = fakes({ analysisSubject });
      await expect(
        publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
      ).rejects.toEqual(refusal('publish-package-stale'));
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
          Promise.resolve({
            ...subject,
            contentHash: HASH,
            cloudCopy: true,
            audience: 'private',
            accountId: 'acct-1',
          }),
      });
      await expect(
        publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
      ).rejects.toEqual(refusal('publish-package-stale'));
      expect(recorded.contexts).toEqual([]);
      expect(recorded.committed).toEqual([]);
      expect(recorded.created).toEqual([]);
    }
  });

  it('uploads nothing from a review made for sharing, even of this skill with these bytes', async () => {
    // A share's review (SKILLS_CHANNELS.PACKAGE_ANALYZE) blocks on
    // secret-looking and git-ignored files rather than withholding them, and
    // isn't what the cloud copy dialog showed.
    const { deps, recorded } = fakes({
      analysisSubject: () =>
        Promise.resolve({
          sourceId: 'custom:app',
          skillName: 'helper',
          contentHash: HASH,
          cloudCopy: false,
          audience: 'private',
          accountId: 'acct-1',
        }),
    });
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
      refusal('publish-package-stale'),
    );
    expect(recorded.contexts).toEqual([]);
    expect(recorded.committed).toEqual([]);
    expect(recorded.created).toEqual([]);
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
      await expect(
        publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
      ).rejects.toEqual(refusal('publish-package-stale'));
      expect(recorded.links).toEqual([]);
    }
    // A blocked analysis has its own refusal: checking again won't help
    // until the file or dependency is dealt with.
    const { deps, recorded } = fakes({
      commitPackage: (): Promise<never> =>
        Promise.reject(new PackageAnalysisBlockedError()),
    });
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
      refusal('publish-package-blocked'),
    );
    expect(recorded.created).toEqual([]);
  });

  it('uploads nothing from an analysis issued for another account, or for none', async () => {
    for (const accountId of ['acct-2', null]) {
      const { deps, recorded } = fakes({
        analysisSubject: () =>
          Promise.resolve({
            sourceId: 'custom:app',
            skillName: 'helper',
            contentHash: HASH,
            cloudCopy: true,
            audience: 'private',
            accountId,
          }),
      });
      await expect(
        publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
      ).rejects.toEqual(refusal('publish-package-stale'));
      expect(recorded.contexts).toEqual([]);
      expect(recorded.committed).toEqual([]);
    }
    // Nor without the account the person chose.
    const { deps, recorded } = fakes();
    await expect(publishSkillToCloud(ENTRY, PKG, deps)).rejects.toEqual(
      refusal('publish-package-stale'),
    );
    expect(recorded.committed).toEqual([]);
  });

  it('uploads nothing when the desktop is signed in to another account than the person chose', async () => {
    // The dialog's analysis was for acct-2; the desktop is now on acct-1.
    const { deps, recorded } = fakes({
      analysisSubject: () =>
        Promise.resolve({
          sourceId: 'custom:app',
          skillName: 'helper',
          contentHash: HASH,
          cloudCopy: true,
          audience: 'private',
          accountId: 'acct-2',
        }),
    });
    await expect(
      publishSkillToCloud(ENTRY, PKG, deps, { expectedAccountId: 'acct-2' }),
    ).rejects.toEqual(refusal('publish-account-mismatch'));
    expect(recorded.committed).toEqual([]);
    expect(recorded.created).toEqual([]);
    expect(recorded.updated).toEqual([]);
    expect(recorded.links).toEqual([]);
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
    await publishSkillToCloud(ENTRY, PKG, deps, CHOSEN);
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
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
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
      await expect(
        publishSkillToCloud(entryId, PKG, deps, CHOSEN),
      ).rejects.toEqual(refusal(reason));
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
      const failure = publishSkillToCloud(ENTRY, PKG, deps, CHOSEN);
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
    await expect(
      publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
    ).resolves.toEqual(
      expect.objectContaining({ publicationId: 'someone-else' }),
    );
    expect(recorded.links).toEqual([]);
  });
});
