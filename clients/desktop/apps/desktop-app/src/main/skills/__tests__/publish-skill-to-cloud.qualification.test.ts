import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  PackageAnalysisBlockedError,
  ShareOperationError,
} from '../../sharing/share-operation-result';
import { createSharedSkill, updateSharedSkill } from '../canopy-server-client';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import {
  consentFactsOf,
  type AnalyzeSkillCapabilityPackageInput,
  type PackageConsentFacts,
  type SkillAnalysisSubject,
} from '../../pipelines/pipeline-package-service';
import {
  CloudCopyConsentStore,
  type CloudCopyConsent,
} from '../cloud-copy-consents';
import {
  keepCloudSkillsInStep,
  publishSkillToCloud,
  unpublishSkillFromCloud,
  type KeepInStepDeps,
  type PublishSkillDeps,
  type UnpublishSkillDeps,
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
const PKG = {
  analysisId: 'analysis-1',
  selectedOptionalResourceIds: ['r1'],
  keepInStep: true,
};
/** The account the person chose in the consent dialog. */
const CHOSEN = { expectedAccountId: 'acct-1' } as const;
const FILES = ['skill|claude|helper/SKILL.md', 'skill|claude|helper/ref.md'];
const facts = (
  overrides: Partial<PackageConsentFacts> = {},
): PackageConsentFacts => ({
  contentHash: HASH,
  ready: true,
  files: FILES,
  withheld: ['helper/.env'],
  ...overrides,
});
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
  consents: [string, CloudCopyConsent][];
  analysed: AnalyzeSkillCapabilityPackageInput[];
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
    consents: [],
    analysed: [],
  };
  const deps: PublishSkillDeps = {
    loadSkills: () => Promise.resolve(skills),
    readRawSkill: () => Promise.resolve(RAW),
    // CAN-6943's flag, off: installed-source skills are its own golden.
    installedSkillsEnabled: () => Promise.resolve(false),
    readInstalledSkill: () => Promise.reject(new Error('flag off')),
    fingerprintInstalledSkill: () => Promise.reject(new Error('flag off')),
    // Asked only for an installed skill's copy (CAN-6943).
    assertCreateAudienceSupported: () =>
      Promise.reject(new Error('not asked for a custom skill')),
    analysisFacts: () => Promise.resolve(facts()),
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
    writeConsent: (localId, consent) => {
      recorded.consents.push([localId, consent]);
      return Promise.resolve();
    },
    now: () => AT,
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
        // An identical skill the account shares more widely is refused.
        expectedAudience: 'private',
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
    expect(recorded.consents).toEqual([
      [
        'custom:app/helper',
        {
          accountId: 'acct-1',
          remoteId: 'remote-new',
          keepInStep: true,
          consentedAt: AT,
          selectedOptionalResourceIds: ['r1'],
          files: FILES,
          withheld: ['helper/.env'],
          audience: 'private',
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

  it('replaces a deleted team copy with a private one, asked and recorded as private (CAN-7037)', async () => {
    // The dialog named the team, as the linked copy reached it; the copy is
    // gone from the cloud, so the publish starts a new private one.
    const link: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'team',
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
            audience: 'team',
          }),
        linkedCopyAudience: () => Promise.resolve(null),
        updateSharedSkill: () =>
          Promise.reject(
            new CanopyCloudClientError('http-error', 'Not found', 404),
          ),
      },
      [installed(link)],
    );
    await expect(
      publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
    ).resolves.toEqual(
      expect.objectContaining({ publicationId: 'remote-new' }),
    );
    expect(recorded.created).toMatchObject([{ expectedAudience: 'private' }]);
    expect(recorded.links.map(([, remote]) => remote.remoteId)).toEqual([
      'remote-new',
    ]);
    expect(recorded.consents).toMatchObject([
      ['custom:app/helper', { remoteId: 'remote-new', audience: 'private' }],
    ]);
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

  it('says so, and links nothing, when a new copy meets an identical skill the account shares by link, with a team or with an organization (CAN-7037)', async () => {
    const PUBLIC_SHARE = {
      externalId: 'b1b2b3b4-c5c6-4d7d-8e9e-f0f1f2f3f4f5',
      pinnedContentHash: HASH,
      upToDate: true,
      sharePath: '/s/skill',
      createdAt: AT,
      updatedAt: AT,
    };
    // A cloud with the precondition refuses it as the copy is created.
    const refused = fakes({
      createSharedSkill: (): Promise<never> =>
        Promise.reject(
          new CanopyCloudClientError(
            'http-error',
            'This skill is already in your cloud account, shared with more people than this copy would be.',
            409,
            'audience_changed',
          ),
        ),
    });
    // An older cloud returns the shared row itself, which is never linked.
    const returned = [
      { publicShare: PUBLIC_SHARE },
      { shareScope: 'team' as const },
      { shareScope: 'organization' as const },
    ].map((wider) =>
      fakes({
        createSharedSkill: () => Promise.resolve(detail('shared-copy', wider)),
      }),
    );
    for (const { deps, recorded } of [refused, ...returned]) {
      await expect(
        publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
      ).rejects.toEqual(refusal('publish-audience-wider'));
      expect(recorded.links).toEqual([]);
      expect(recorded.consents).toEqual([]);
    }
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
    // The files it would carry are read from the same analysis, so one
    // that expired or isn't ready since uploads nothing either.
    for (const analysisFacts of [
      (): Promise<PackageConsentFacts | null> =>
        Promise.resolve(facts({ contentHash: 'e'.repeat(64) })),
      (): Promise<PackageConsentFacts | null> => Promise.resolve(null),
      (): Promise<PackageConsentFacts | null> =>
        Promise.resolve(facts({ ready: false })),
    ]) {
      const { deps, recorded } = fakes({ analysisFacts });
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
    expect(recorded.consents).toEqual([]);
  });

  describe('removing the cloud copy (D10)', () => {
    const LINK: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'private',
      sharedAt: AT,
    };

    function removal(
      overrides: Partial<UnpublishSkillDeps> = {},
      skills: InstalledSkillInfo[] = [installed(LINK)],
    ): { deps: UnpublishSkillDeps; deleted: string[]; cleared: string[] } {
      const deleted: string[] = [];
      const cleared: string[] = [];
      return {
        deleted,
        cleared,
        deps: {
          loadSkills: () => Promise.resolve(skills),
          credentials: () =>
            Promise.resolve({ accountId: 'acct-1', context: { ...CONTEXT } }),
          getSharedSkill: (skillId) =>
            Promise.resolve(detail(skillId, { contentHash: 'd'.repeat(64) })),
          deleteSharedSkill: (skillId) => {
            deleted.push(skillId);
            return Promise.resolve();
          },
          clearLink: (remoteId) => {
            cleared.push(remoteId);
            return Promise.resolve();
          },
          ...overrides,
        },
      };
    }

    it('deletes the linked private copy at the version the caller saw, then the link', async () => {
      for (const expected of ['d'.repeat(64), null]) {
        const { deps, deleted, cleared } = removal();
        await unpublishSkillFromCloud('remote-old', expected, deps);
        expect(deleted).toEqual(['remote-old']);
        expect(cleared).toEqual(['remote-old']);
      }
    });

    it('reads and deletes with the credentials it resolved first, so an account switch cannot split them', async () => {
      const contexts: unknown[] = [];
      const signedIn = { accountId: 'acct-1', context: { ...CONTEXT } };
      const { deps, deleted } = removal({
        credentials: () => Promise.resolve(signedIn),
        getSharedSkill: (skillId, context) => {
          contexts.push(context);
          return Promise.resolve(
            detail(skillId, { contentHash: 'd'.repeat(64) }),
          );
        },
        deleteSharedSkill: (skillId, context) => {
          contexts.push(context);
          deleted.push(skillId);
          return Promise.resolve();
        },
      });
      await unpublishSkillFromCloud('remote-old', 'd'.repeat(64), deps);
      expect(deleted).toEqual(['remote-old']);
      expect(contexts).toHaveLength(3);
      for (const context of contexts) expect(context).toBe(signedIn.context);
    });

    it('keeps a copy shared or edited between its first read and the delete (CAN-6337)', async () => {
      for (const [later, reason] of [
        [
          { contentHash: 'd'.repeat(64), shareScope: 'team' },
          'unpublish-shared',
        ],
        [{ contentHash: 'e'.repeat(64) }, 'unpublish-version-moved'],
      ] as const) {
        let reads = 0;
        const { deps, deleted, cleared } = removal({
          getSharedSkill: (skillId) => {
            reads += 1;
            return Promise.resolve(
              detail(
                skillId,
                reads === 1 ? { contentHash: 'd'.repeat(64) } : later,
              ),
            );
          },
        });
        await expect(
          unpublishSkillFromCloud('remote-old', 'd'.repeat(64), deps),
        ).rejects.toEqual(refusal(reason));
        expect(deleted).toEqual([]);
        expect(cleared).toEqual([]);
      }
    });

    it('only clears the link of a copy already gone from the cloud', async () => {
      const { deps, deleted, cleared } = removal({
        getSharedSkill: (): Promise<never> =>
          Promise.reject(new CanopyCloudClientError('http-error', 'Gone', 404)),
      });
      await unpublishSkillFromCloud('remote-old', null, deps);
      expect(deleted).toEqual([]);
      expect(cleared).toEqual(['remote-old']);
    });

    it('refuses a copy that is not linked here, shared beyond the account, or changed, and deletes nothing', async () => {
      for (const [setup, reason] of [
        [removal({}, [installed()]), 'unpublish-not-found'],
        [
          removal({}, [installed({ ...LINK, accountId: 'acct-2' })]),
          'unpublish-not-found',
        ],
        [
          removal({
            getSharedSkill: (skillId: string): Promise<SharedSkillDetail> =>
              Promise.resolve(
                detail(skillId, {
                  contentHash: 'd'.repeat(64),
                  shareScope: 'team',
                }),
              ),
          }),
          'unpublish-shared',
        ],
        [
          // Still private, but deleting it would revoke its public link.
          removal({
            getSharedSkill: (skillId: string): Promise<SharedSkillDetail> =>
              Promise.resolve(
                detail(skillId, {
                  contentHash: 'd'.repeat(64),
                  publicShare: {
                    externalId: 'pub-1',
                    pinnedContentHash: 'd'.repeat(64),
                    upToDate: true,
                    sharePath: '/s/pub-1',
                    createdAt: AT,
                    updatedAt: AT,
                  },
                }),
              ),
          }),
          'unpublish-shared',
        ],
        [
          removal({
            getSharedSkill: (skillId: string): Promise<SharedSkillDetail> =>
              Promise.resolve(detail(skillId, { contentHash: 'e'.repeat(64) })),
          }),
          'unpublish-version-moved',
        ],
        [
          removal({
            credentials: (): Promise<never> =>
              Promise.reject(
                new CanopyCloudClientError('missing-api-key', 'Sign in'),
              ),
          }),
          'publish-remote-unavailable',
        ],
      ] as const) {
        await expect(
          unpublishSkillFromCloud('remote-old', 'd'.repeat(64), setup.deps),
        ).rejects.toEqual(refusal(reason));
        expect(setup.deleted).toEqual([]);
        expect(setup.cleared).toEqual([]);
      }
    });
  });

  describe('keeping a copy in step on send (D9, revised)', () => {
    const LINK: ShareRemoteMetadata = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      contentHash: 'd'.repeat(64),
      shareScope: 'private',
      sharedAt: AT,
    };
    const CONSENT: CloudCopyConsent = {
      accountId: 'acct-1',
      remoteId: 'remote-old',
      keepInStep: true,
      consentedAt: AT,
      selectedOptionalResourceIds: ['r1'],
      files: FILES,
      withheld: ['helper/.env'],
      audience: 'private',
    };

    function inStep(
      overrides: Partial<KeepInStepDeps> = {},
      options: {
        consent?: CloudCopyConsent | null;
        link?: ShareRemoteMetadata;
      } = {},
    ): { deps: KeepInStepDeps; recorded: Recorded } {
      const base = fakes({}, [installed(options.link ?? LINK)]);
      return {
        recorded: base.recorded,
        deps: {
          ...base.deps,
          readConsent: () =>
            Promise.resolve(
              options.consent === undefined ? CONSENT : options.consent,
            ),
          analyzeSkill: (input) => {
            base.recorded.analysed.push(input);
            return Promise.resolve('analysis-2');
          },
          ...overrides,
        },
      };
    }

    it('republishes a skill whose SKILL.md moved, within its consent, against the last published hash', async () => {
      const { deps, recorded } = inStep();
      await expect(
        keepCloudSkillsInStep(['remote-old'], {}, deps),
      ).resolves.toEqual({ republished: ['helper'], usedLastCopy: [] });
      expect(recorded.committed).toEqual([
        {
          analysisId: 'analysis-2',
          selectedOptionalResourceIds: ['r1'],
          keepInStep: true,
        },
      ]);
      // A cloud copy's analysis, as the consent dialog's was, so a withheld
      // file stays withheld and the files compare with the consented ones.
      expect(recorded.analysed).toEqual([
        {
          sourceId: 'custom:app',
          skillName: 'helper',
          rawSkill: RAW,
          cloudCopy: true,
        },
      ]);
      expect(recorded.updated).toEqual([
        expect.objectContaining({
          skillId: 'remote-old',
          rawSkill: RAW,
          expectedContentHash: 'd'.repeat(64),
          // The cloud checks it as it writes.
          expectedAudience: 'private',
        }),
      ]);
      expect(recorded.links).toEqual([
        [
          'custom:app/helper',
          { ...LINK, contentHash: 'c'.repeat(64), sharedAt: AT },
        ],
      ]);
    });

    it('leaves fresh, unconsented, opted-out and other accounts’ copies alone', async () => {
      for (const setup of [
        inStep({}, { link: { ...LINK, contentHash: HASH } }),
        inStep({}, { consent: null }),
        inStep({}, { consent: { ...CONSENT, keepInStep: false } }),
        inStep({}, { link: { ...LINK, accountId: 'acct-2' } }),
        inStep({
          credentials: (): Promise<never> =>
            Promise.reject(new CanopyCloudClientError('missing-api-key', 'x')),
        }),
      ]) {
        await expect(
          keepCloudSkillsInStep(['remote-old'], {}, setup.deps),
        ).resolves.toEqual({ republished: [], usedLastCopy: [] });
        expect(setup.recorded.committed).toEqual([]);
      }
    });

    it('refuses before any upload when the skill needs consent again', async () => {
      for (const changed of [
        // A file the last package carried is now left out.
        facts({ withheld: ['helper/.env', 'helper/ref.md'] }),
        // A file outside the consented list would travel.
        facts({ files: [...FILES, 'skill|claude|helper/new.md'] }),
        // The analysis found something that blocks the package.
        facts({ ready: false }),
      ]) {
        const { deps, recorded } = inStep({
          analysisFacts: () => Promise.resolve(changed),
        });
        await expect(
          keepCloudSkillsInStep(['remote-old'], {}, deps),
        ).resolves.toEqual({
          republished: [],
          usedLastCopy: [{ name: 'helper', reason: 'needs_consent' }],
        });
        expect(recorded.committed).toEqual([]);
        expect(recorded.updated).toEqual([]);
        expect(recorded.links).toEqual([]);
      }
    });

    it('asks again, uploading nothing, when the copy now reaches more people than the consent named or is gone', async () => {
      for (const audience of [
        'team',
        'organization',
        'public_link',
        null,
      ] as const) {
        const { deps, recorded } = inStep({
          linkedCopyAudience: () => Promise.resolve(audience),
        });
        await expect(
          keepCloudSkillsInStep(['remote-old'], {}, deps),
        ).resolves.toEqual({
          republished: [],
          usedLastCopy: [{ name: 'helper', reason: 'needs_consent' }],
        });
        expect(recorded.committed).toEqual([]);
        expect(recorded.updated).toEqual([]);
        expect(recorded.links).toEqual([]);
      }
    });

    it('sends the audience the person agreed to, for the cloud to check as it writes', async () => {
      const { deps, recorded } = inStep(
        { linkedCopyAudience: () => Promise.resolve('team') },
        { consent: { ...CONSENT, audience: 'team' } },
      );
      await expect(
        keepCloudSkillsInStep(['remote-old'], {}, deps),
      ).resolves.toEqual({ republished: ['helper'], usedLastCopy: [] });
      expect(recorded.updated).toEqual([
        expect.objectContaining({ expectedAudience: 'team' }),
      ]);
    });

    it('asks again, uploading nothing, when a file the copy carried is now left out of the skill itself', async () => {
      // The reviewer's case: a supporting script that went to the cloud is
      // git-ignored since, and SKILL.md changed. A cloud copy's analysis
      // lists such a file as a withheld member file, not a withheld asset.
      const summary = (
        withheldMemberFiles: PipelinePackageAnalysisSummary['withheldMemberFiles'],
      ): PipelinePackageAnalysisSummary =>
        ({
          analysisId: 'analysis-2',
          state: 'ready',
          pipelineContentHash: HASH,
          blockers: [],
          expiresAt: '2099-01-01T00:00:00.000Z',
          withheldMemberFiles,
        }) as unknown as PipelinePackageAnalysisSummary;
      const atConsent = consentFactsOf(summary([]), []);
      const now = consentFactsOf(
        summary([
          {
            rootName: 'helper',
            relativePath: 'scripts/run.sh',
            reason: 'git_ignored',
          },
        ]),
        [],
      );
      expect(now.withheld).toEqual(['member:helper/scripts/run.sh']);
      const { deps, recorded } = inStep(
        { analysisFacts: () => Promise.resolve(now) },
        { consent: { ...CONSENT, withheld: atConsent.withheld, files: [] } },
      );
      await expect(
        keepCloudSkillsInStep(['remote-old'], {}, deps),
      ).resolves.toEqual({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'needs_consent' }],
      });
      expect(recorded.committed).toEqual([]);
      expect(recorded.updated).toEqual([]);
    });

    it('asks once more for a consent recorded before it named an audience', async () => {
      const older: CloudCopyConsent = { ...CONSENT };
      delete older.audience;
      const { deps, recorded } = inStep({}, { consent: older });
      await expect(
        keepCloudSkillsInStep(['remote-old'], {}, deps),
      ).resolves.toEqual({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'needs_consent' }],
      });
      expect(recorded.analysed).toEqual([]);
      expect(recorded.committed).toEqual([]);
      expect(recorded.updated).toEqual([]);
    });

    it('goes with the last copy when the copy changed elsewhere or the upload fails', async () => {
      for (const [error, reason] of [
        [
          new CanopyCloudClientError('http-error', 'Changed', 409),
          'changed_elsewhere',
        ],
        // Shared more widely between its read and the write: the cloud
        // refuses, and the person is asked again.
        [
          new CanopyCloudClientError(
            'http-error',
            'Who can see this skill changed since it was checked',
            409,
            'audience_changed',
          ),
          'needs_consent',
        ],
        [new CanopyCloudClientError('network-error', 'Offline'), 'failed'],
      ] as const) {
        const { deps, recorded } = inStep({
          updateSharedSkill: (): Promise<never> => Promise.reject(error),
        });
        await expect(
          keepCloudSkillsInStep(['remote-old'], {}, deps),
        ).resolves.toEqual({
          republished: [],
          usedLastCopy: [{ name: 'helper', reason }],
        });
        expect(recorded.links).toEqual([]);
      }
    });

    it('notes a skill it cannot read on its own and still keeps the others in step', async () => {
      const OTHER: ShareRemoteMetadata = { ...LINK, remoteId: 'remote-two' };
      const base = fakes({}, [
        { ...installed(LINK), name: 'unreadable' },
        installed(OTHER),
      ]);
      const deps: KeepInStepDeps = {
        ...base.deps,
        readConsent: (localId) =>
          Promise.resolve(
            localId.endsWith('/unreadable')
              ? CONSENT
              : { ...CONSENT, remoteId: 'remote-two' },
          ),
        readRawSkill: (skillId) =>
          skillId.endsWith('/unreadable')
            ? Promise.reject(
                Object.assign(new Error('denied'), { code: 'EACCES' }),
              )
            : Promise.resolve(RAW),
        analyzeSkill: () => Promise.resolve('analysis-2'),
      };
      await expect(
        keepCloudSkillsInStep(['remote-old', 'remote-two'], {}, deps),
      ).resolves.toEqual({
        republished: ['helper'],
        usedLastCopy: [{ name: 'unreadable', reason: 'failed' }],
      });
      expect(base.recorded.updated).toEqual([
        expect.objectContaining({ skillId: 'remote-two', rawSkill: RAW }),
      ]);
    });

    it('counts slow reads against the deadline, and never starts an upload after it', async () => {
      // The skill's read outlasts the wait.
      let readDone: () => void = () => undefined;
      const slowRead = inStep({
        readRawSkill: (): Promise<string> =>
          new Promise((resolve) => {
            readDone = (): void => resolve(RAW);
          }),
      });
      await expect(
        keepCloudSkillsInStep(['remote-old'], { timeoutMs: 20 }, slowRead.deps),
      ).resolves.toEqual({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'timed_out' }],
      });
      readDone();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(slowRead.recorded.committed).toEqual([]);
      expect(slowRead.recorded.updated).toEqual([]);

      // Its analysis outlasts the wait: the upload that would follow never
      // starts.
      let analysed: () => void = () => undefined;
      const slowAnalysis = inStep({
        analyzeSkill: (): Promise<string> =>
          new Promise((resolve) => {
            analysed = (): void => resolve('analysis-2');
          }),
      });
      await expect(
        keepCloudSkillsInStep(
          ['remote-old'],
          { timeoutMs: 20 },
          slowAnalysis.deps,
        ),
      ).resolves.toEqual({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'timed_out' }],
      });
      analysed();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(slowAnalysis.recorded.committed).toEqual([]);
      expect(slowAnalysis.recorded.updated).toEqual([]);
      expect(slowAnalysis.recorded.links).toEqual([]);
    });

    it('never commits the package or writes the copy once slow work inside a helper outlasts the deadline', async () => {
      const later = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      // The package upload runs long before its commit.
      const committedLate: string[] = [];
      const slowPackage = inStep({
        commitPackage: async (_pkg, _context, stillInTime) => {
          await later(60);
          // The next request the upload would start: a blob or the commit.
          stillInTime?.();
          committedLate.push('committed');
          return {
            capabilityPackage: PACKAGE_REF,
            committedPackageUploadId: 'upload-1',
          };
        },
      });
      await expect(
        keepCloudSkillsInStep(
          ['remote-old'],
          { timeoutMs: 20 },
          slowPackage.deps,
        ),
      ).resolves.toEqual({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'timed_out' }],
      });
      await later(80);
      expect(committedLate).toEqual([]);
      expect(slowPackage.recorded.updated).toEqual([]);
      expect(slowPackage.recorded.links).toEqual([]);

      // The update's read before its PUT runs long.
      const written: string[] = [];
      const slowRead = inStep({
        updateSharedSkill: async (_request, _context, beforeWrite) => {
          await later(60);
          beforeWrite?.();
          written.push('PUT');
          return detail('remote-old');
        },
      });
      await expect(
        keepCloudSkillsInStep(['remote-old'], { timeoutMs: 20 }, slowRead.deps),
      ).resolves.toEqual({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'timed_out' }],
      });
      await later(80);
      expect(written).toEqual([]);
      expect(slowRead.recorded.links).toEqual([]);
    });

    it('stops waiting at the timeout and names the skill whose last copy the turn used', async () => {
      let finish: () => void = () => undefined;
      const { deps } = inStep({
        updateSharedSkill: (): Promise<SharedSkillDetail> =>
          new Promise((resolve) => {
            finish = (): void => resolve(detail('remote-old'));
          }),
      });
      await expect(
        keepCloudSkillsInStep(['remote-old'], { timeoutMs: 20 }, deps),
      ).resolves.toEqual({
        republished: [],
        usedLastCopy: [{ name: 'helper', reason: 'timed_out' }],
      });
      finish();
    });
  });

  it('keeps consents per skill, reads an unreadable file as none, and forgets a removed copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-copy-consents-'));
    try {
      const store = CloudCopyConsentStore.inSkillsRoot(dir);
      const consent = (remoteId: string): CloudCopyConsent => ({
        accountId: 'acct-1',
        remoteId,
        keepInStep: true,
        consentedAt: AT,
        selectedOptionalResourceIds: [],
        files: FILES,
        withheld: [],
      });
      store.set('custom:app/a', consent('remote-a'));
      store.set('custom:app/b', consent('remote-b'));
      store.clearByRemoteId('remote-a');
      expect(store.read()).toEqual({ 'custom:app/b': consent('remote-b') });

      // Written in a versioned envelope.
      const file = join(dir, '.cloud-copy-consents.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        version: 1,
        entries: { 'custom:app/b': consent('remote-b') },
      });
      // A bare map is the first format, and still reads.
      writeFileSync(
        file,
        JSON.stringify({ 'custom:app/c': consent('remote-c') }),
      );
      expect(store.get('custom:app/c')).toEqual(consent('remote-c'));
      // The audience the person agreed to is kept; one this app doesn't
      // know reads as none, so the next republish asks again.
      store.set('custom:app/e', { ...consent('remote-e'), audience: 'team' });
      expect(store.get('custom:app/e')?.audience).toBe('team');
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          entries: {
            'custom:app/f': { ...consent('remote-f'), audience: 'everyone' },
          },
        }),
      );
      expect(store.get('custom:app/f')).toEqual(consent('remote-f'));
      // A newer app's file reads as none and is never overwritten.
      const newer = JSON.stringify({ version: 2, entries: {} });
      writeFileSync(file, newer);
      expect(store.read()).toEqual({});
      expect(() => store.set('custom:app/d', consent('remote-d'))).toThrow();
      expect(readFileSync(file, 'utf8')).toBe(newer);

      writeFileSync(file, '{not json');
      expect(store.get('custom:app/b')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
