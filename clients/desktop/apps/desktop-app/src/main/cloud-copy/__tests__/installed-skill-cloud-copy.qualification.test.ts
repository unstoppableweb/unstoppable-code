/**
 * A skill installed from GitHub, a URL or a local folder going to the cloud
 * account (CAN-6943), behind `canopy-desktop-cloud-copy-installed-skills`:
 * main refuses it while the flag is off; on, it goes only to a private copy,
 * is never kept in step (any change asks again), reads only its own folder
 * (links are left out, a package over the caps is refused), and uninstalling
 * it leaves its cloud copy, link and consent untouched.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeCapabilityPackage } from '@canopy/desktop-shared/node';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  PIPELINE_PACKAGE_MAX_FILE_BYTES,
  type PipelinePackageAnalysisSummary,
} from '@canopy/protocol/pipelines';
import type { ShareRemoteMetadata } from '@canopy/protocol/sharing';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/protocol/skills';
import type { CloudCopyAudience } from '@canopy/desktop-shared/types';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
} from '../../canopy-cloud/client';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import { consentFactsOf } from '../../pipelines/pipeline-package-service';
import { registerSkillHandlers } from '../../skills/skill-handlers';
import {
  createSharedSkill,
  updateSharedSkill,
} from '../../skills/canopy-server-client';
import {
  CloudCopyConsentStore,
  type CloudCopyConsent,
} from '../../skills/cloud-copy-consents';
import {
  keepCloudSkillsInStep,
  publishSkillToCloud,
  unpublishSkillFromCloud,
  type KeepInStepDeps,
  type PublishSkillDeps,
  type ShareSourceOptions,
} from '../../skills/publish-skill-to-cloud';
import {
  analyzeForCloudCopy,
  type AnalyzeForCloudCopyDeps,
} from '../analyze-for-cloud-copy';
import { installedSkillCloudCopyEnabled } from '../installed-skills-flag';
import {
  disposeFeatureFlagService,
  initializeFeatureFlagService,
} from '../../feature-flags';

jest.mock('../../canopy-cloud/client', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/client'),
  requestCanopyCloudJson: jest.fn(),
  resolveCanopyCloudCredentialContext: (): Promise<unknown> =>
    Promise.resolve({ apiKey: 'k', account: { id: 'acct-1' } }),
  assertCanopyCloudCapability: (): Promise<void> => Promise.resolve(),
}));
type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockIpcHandlers = new Map<string, IpcHandler>();
jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
}));
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: IpcHandler): void => {
    mockIpcHandlers.set(channel, handler);
  },
}));
jest.mock('../../skills/resource-lanes', () => ({
  ...jest.requireActual<object>('../../skills/resource-lanes'),
  skillResourceContextEnabled: (): boolean => true,
  assertSkillContext: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../skills/skill-install-context', () => ({
  assertStoredSkillContext: (): Promise<void> => Promise.resolve(),
  assertSkillShareOrigin: (): Promise<void> => Promise.resolve(),
}));
const mockReads = { raw: [] as string[], installed: [] as string[] };
jest.mock('../../skills/skill-service', () => ({
  readRawSkill: (localId: string): Promise<string> => {
    mockReads.raw.push(localId);
    return Promise.resolve('---\nname: lint\n---\nLint.\n');
  },
  readInstalledSkillForCloudCopy: (localId: string): Promise<string> => {
    mockReads.installed.push(localId);
    return Promise.resolve('---\nname: lint\n---\nLint.\n');
  },
}));

const RAW = '---\nname: lint\n---\nLint.\n';
const HASH = createHash('sha256').update(RAW).digest('hex');
const AT = '2026-11-17T00:00:00.000Z';
const GITHUB = 'github:acme:tools';
const ENTRY = `skill:${GITHUB}/lint`;
const LOCAL_ID = `${GITHUB}/lint`;
const SUMMARY = { analysisId: 'a-1' } as PipelinePackageAnalysisSummary;
const PKG = {
  analysisId: 'analysis-1',
  selectedOptionalResourceIds: [],
  // Asked for, and still never kept in step for an installed skill.
  keepInStep: true,
};
const CHOSEN = { expectedAccountId: 'acct-1' } as const;
const CONTEXT = { baseUrl: 'https://cloud.example', apiKey: 'k' } as const;

const skill = (
  overrides: Partial<InstalledSkillInfo> = {},
): InstalledSkillInfo => ({
  name: 'lint',
  sourceId: GITHUB,
  description: '',
  source: 'acme/tools',
  installedAt: AT,
  updatedAt: AT,
  updateAvailable: false,
  ...overrides,
});

const LINK: ShareRemoteMetadata = {
  accountId: 'acct-1',
  remoteId: 'remote-1',
  contentHash: 'c'.repeat(64),
  shareScope: 'private',
  sharedAt: AT,
};

const PUBLIC_SHARE = {
  externalId: 'b1b2b3b4-c5c6-4d7d-8e9e-f0f1f2f3f4f5',
  pinnedContentHash: HASH,
  upToDate: true,
  sharePath: '/s/skill',
  createdAt: AT,
  updatedAt: AT,
};

const detail = (id: string): SharedSkillDetail => ({
  id,
  name: 'lint',
  description: '',
  contentHash: HASH,
  shareScope: 'private',
  owner: { type: 'user', id: 'u1', name: null },
  createdBy: { id: 'u1', name: null, email: null },
  createdAt: AT,
  updatedAt: AT,
  canUpdate: true,
  canDelete: true,
  publicShare: null,
  rawSkill: RAW,
});

function analyzeFakes(
  enabled: boolean,
  skills: readonly InstalledSkillInfo[],
  live: CloudCopyAudience | null = 'private',
): { deps: AnalyzeForCloudCopyDeps; analysed: unknown[]; raw: string[] } {
  const analysed: unknown[] = [];
  const raw: string[] = [];
  return {
    analysed,
    raw,
    deps: {
      loadSkills: () => Promise.resolve(skills),
      linkedCopyAudience: () => Promise.resolve(live),
      readRawSkill: (localId) => {
        raw.push(localId);
        return Promise.reject(new Error('readRawSkill reads no GitHub skill'));
      },
      installedSkillsEnabled: () => Promise.resolve(enabled),
      readInstalledSkill: (localId) => {
        raw.push(`installed:${localId}`);
        return Promise.resolve(RAW);
      },
      analyzeSkill: (request) => {
        analysed.push(request);
        return Promise.resolve(SUMMARY);
      },
      marketplaces: () => Promise.resolve([]),
      analyzePlugin: () => Promise.reject(new Error('no plugin here')),
    },
  };
}

interface Recorded {
  committed: unknown[];
  created: { request: unknown; options: ShareSourceOptions | undefined }[];
  updated: { request: unknown; options: ShareSourceOptions | undefined }[];
  links: [string, ShareRemoteMetadata][];
  consents: [string, CloudCopyConsent][];
}

function publishFakes(
  overrides: Partial<PublishSkillDeps> = {},
  skills: InstalledSkillInfo[] = [skill()],
): { deps: PublishSkillDeps; recorded: Recorded } {
  const recorded: Recorded = {
    committed: [],
    created: [],
    updated: [],
    links: [],
    consents: [],
  };
  const deps: PublishSkillDeps = {
    loadSkills: () => Promise.resolve(skills),
    readRawSkill: () => Promise.reject(new Error('not this reader')),
    installedSkillsEnabled: () => Promise.resolve(true),
    readInstalledSkill: () => Promise.resolve(RAW),
    fingerprintInstalledSkill: () => Promise.resolve('f'.repeat(64)),
    assertCreateAudienceSupported: () => Promise.resolve(),
    analysisSubject: () =>
      Promise.resolve({
        sourceId: GITHUB,
        skillName: 'lint',
        contentHash: HASH,
        cloudCopy: true,
        audience: 'private',
        accountId: 'acct-1',
      }),
    analysisFacts: () =>
      Promise.resolve({
        contentHash: HASH,
        ready: true,
        files: ['skill|claude|lint/SKILL.md'],
        withheld: [],
      }),
    credentials: () =>
      Promise.resolve({ accountId: 'acct-1', context: { ...CONTEXT } }),
    commitPackage: (pkg) => {
      recorded.committed.push(pkg);
      return Promise.resolve({
        capabilityPackage: { version: 1, digest: 'pp:v1:abc' },
        committedPackageUploadId: 'upload-1',
      });
    },
    createSharedSkill: (request, _context, options) => {
      recorded.created.push({ request, options });
      return Promise.resolve(detail('remote-new'));
    },
    updateSharedSkill: (request, _context, _beforeWrite, options) => {
      recorded.updated.push({ request, options });
      return Promise.resolve(detail('remote-1'));
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
/** A partial match, typed as the unknown the recorded request is. */
const containing = (fields: Record<string, unknown>): unknown =>
  expect.objectContaining(fields);

describe("an installed skill's cloud-copy analysis (CAN-6943)", () => {
  it('answers unsupported while the flag is off, and reads nothing', async () => {
    const { deps, analysed, raw } = analyzeFakes(false, [skill()]);
    await expect(analyzeForCloudCopy(ENTRY, 'acct-1', deps)).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(analysed).toEqual([]);
    expect(raw).toEqual([]);
  });

  it('with the flag on, analyses a GitHub, URL or local-folder skill from its own SKILL.md, for a private copy', async () => {
    for (const sourceId of [
      GITHUB,
      'url:https:__example.com_skills',
      'local:_Users_me_skills',
    ]) {
      const { deps, analysed, raw } = analyzeFakes(true, [skill({ sourceId })]);
      await expect(
        analyzeForCloudCopy(`skill:${sourceId}/lint`, 'acct-1', deps),
      ).resolves.toEqual({ ok: true, analysis: SUMMARY, audience: 'private' });
      expect(analysed).toEqual([
        { sourceId, skillName: 'lint', rawSkill: RAW },
      ]);
      expect(raw).toEqual([`installed:${sourceId}/lint`]);
    }
  });

  it("refuses one installed from someone's cloud share, a custom or built-in flag, another source, and a malformed id", async () => {
    const cases: [string, InstalledSkillInfo][] = [
      [ENTRY, skill({ installedFromShare: { remoteId: 'theirs' } })],
      [ENTRY, skill({ custom: true })],
      [ENTRY, skill({ builtIn: true })],
      ['skill:marketplace:acme/lint', skill({ sourceId: 'marketplace:acme' })],
      [`skill:${GITHUB}/nested/lint`, skill()],
    ];
    for (const [entryId, row] of cases) {
      const { deps, analysed } = analyzeFakes(true, [row]);
      await expect(
        analyzeForCloudCopy(entryId, 'acct-1', deps),
      ).resolves.toEqual({ ok: false, reason: 'unsupported' });
      expect(analysed).toEqual([]);
    }
  });

  it('refuses one whose linked copy is shared more widely: a third-party copy stays private', async () => {
    for (const live of ['team', 'organization', 'public_link'] as const) {
      const { deps, analysed } = analyzeFakes(
        true,
        [skill({ remote: LINK })],
        live,
      );
      await expect(analyzeForCloudCopy(ENTRY, 'acct-1', deps)).resolves.toEqual(
        { ok: false, reason: 'unsupported' },
      );
      expect(analysed).toEqual([]);
    }
  });
});

describe("a local-only build keeps an installed skill's cloud copy off (CAN-6943, CAN-7021)", () => {
  const ENV_KEYS = [
    'CANOPY_E2E_LOCAL_ONLY',
    'CANOPY_E2E_CLIENT_FEATURE_FLAGS',
    'LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID',
  ] as const;
  const globals = globalThis as { __CANOPY_E2E__?: boolean };
  let savedEnv: Record<string, string | undefined>;
  let savedE2e: boolean | undefined;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    savedE2e = globals.__CANOPY_E2E__;
    await disposeFeatureFlagService();
    // An E2E build whose flag override turns the installed-skill flag on.
    globals.__CANOPY_E2E__ = true;
    process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify({
      'canopy-desktop-cloud-copy-installed-skills': true,
    });
    delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
    delete process.env.CANOPY_E2E_LOCAL_ONLY;
  });

  afterEach(async () => {
    await disposeFeatureFlagService();
    globals.__CANOPY_E2E__ = savedE2e;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const analyseThroughTheFlag = (): ReturnType<typeof analyzeFakes> => {
    const fakes = analyzeFakes(true, [skill()]);
    return {
      ...fakes,
      deps: {
        ...fakes.deps,
        installedSkillsEnabled: (): Promise<boolean> =>
          Promise.resolve(installedSkillCloudCopyEnabled()),
      },
    };
  };

  it('outside a local-only build, the override turns the flag on and the analysis runs', async () => {
    await initializeFeatureFlagService();
    expect(installedSkillCloudCopyEnabled()).toBe(true);
    const { deps } = analyseThroughTheFlag();
    await expect(analyzeForCloudCopy(ENTRY, 'acct-1', deps)).resolves.toEqual({
      ok: true,
      analysis: SUMMARY,
      audience: 'private',
    });
  });

  it('in a local-only build the same override is ignored: the analysis answers unsupported and reads nothing', async () => {
    process.env.CANOPY_E2E_LOCAL_ONLY = '1';
    // Off from the first read, before the service starts.
    expect(installedSkillCloudCopyEnabled()).toBe(false);
    await initializeFeatureFlagService();
    expect(installedSkillCloudCopyEnabled()).toBe(false);
    const { deps, analysed, raw } = analyseThroughTheFlag();
    await expect(analyzeForCloudCopy(ENTRY, 'acct-1', deps)).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(analysed).toEqual([]);
    expect(raw).toEqual([]);
  });
});

describe("publishing an installed skill's cloud copy (CAN-6943)", () => {
  it('is refused while the flag is off, and nothing uploads', async () => {
    const { deps, recorded } = publishFakes({
      installedSkillsEnabled: () => Promise.resolve(false),
    });
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
      refusal('publish-source-unsupported'),
    );
    expect(recorded).toEqual({
      committed: [],
      created: [],
      updated: [],
      links: [],
      consents: [],
    });
  });

  it("never hands the share client the installed-source option while the flag is off, even from main's own publish, and reads the flag on every publish", async () => {
    let enabled = false;
    const reads: string[] = [];
    const custom = skill({ sourceId: 'custom:app', custom: true });
    const { deps, recorded } = publishFakes(
      {
        installedSkillsEnabled: () => Promise.resolve(enabled),
        readInstalledSkill: (localId) => {
          reads.push(localId);
          return Promise.resolve(RAW);
        },
        readRawSkill: () => Promise.resolve(RAW),
      },
      [skill({ remote: LINK }), custom],
    );
    // Off: neither the linked copy's update nor a new copy is reached, and
    // the installed skill is never read.
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
      refusal('publish-source-unsupported'),
    );
    expect(recorded.created).toEqual([]);
    expect(recorded.updated).toEqual([]);
    expect(reads).toEqual([]);

    // A custom skill's publish, off or on, never carries the option.
    const customDeps: PublishSkillDeps = {
      ...deps,
      analysisSubject: () =>
        Promise.resolve({
          sourceId: 'custom:app',
          skillName: 'lint',
          contentHash: HASH,
          cloudCopy: true,
          audience: 'private',
          accountId: 'acct-1',
        }),
    };
    await publishSkillToCloud('skill:custom:app/lint', PKG, customDeps, CHOSEN);
    expect(recorded.created.map(({ options }) => options)).toEqual([
      { installedSource: false },
    ]);

    // Turned on, the next publish carries it: the flag is read each time.
    enabled = true;
    await publishSkillToCloud(ENTRY, PKG, deps, CHOSEN);
    expect(recorded.updated.map(({ options }) => options)).toEqual([
      { installedSource: true },
    ]);
    expect(reads).toEqual([LOCAL_ID]);
  });

  it('with the flag on, creates a private copy, links it, and records a consent never kept in step', async () => {
    const { deps, recorded } = publishFakes();
    await expect(
      publishSkillToCloud(ENTRY, PKG, deps, CHOSEN),
    ).resolves.toEqual(
      expect.objectContaining({ publicationId: 'remote-new' }),
    );
    expect(recorded.created).toEqual([
      {
        request: containing({
          sourceSkillId: LOCAL_ID,
          rawSkill: RAW,
          shareScope: 'private',
          expectedSourceSha256: HASH,
          expectedAudience: 'private',
        }),
        options: { installedSource: true },
      },
    ]);
    expect(recorded.links.map(([localId]) => localId)).toEqual([LOCAL_ID]);
    expect(recorded.consents).toEqual([
      [
        LOCAL_ID,
        expect.objectContaining({
          keepInStep: false,
          audience: 'private',
          remoteId: 'remote-new',
          // Its whole folder, so a change to any file asks again.
          sourceFingerprint: 'f'.repeat(64),
        }),
      ],
    ]);
  });

  it('updates a linked private copy in place, still never kept in step', async () => {
    const { deps, recorded } = publishFakes({}, [skill({ remote: LINK })]);
    await publishSkillToCloud(ENTRY, PKG, deps, CHOSEN);
    expect(recorded.created).toEqual([]);
    expect(recorded.updated).toEqual([
      {
        request: containing({
          sourceSkillId: LOCAL_ID,
          skillId: 'remote-1',
          expectedContentHash: LINK.contentHash,
          expectedAudience: 'private',
        }),
        options: { installedSource: true },
      },
    ]);
    expect(recorded.consents[0]?.[1].keepInStep).toBe(false);
  });

  it('uploads nothing for an analysis bound to a wider audience, or made over another skill', async () => {
    const wider = publishFakes({
      analysisSubject: () =>
        Promise.resolve({
          sourceId: GITHUB,
          skillName: 'lint',
          contentHash: HASH,
          cloudCopy: true,
          audience: 'team',
          accountId: 'acct-1',
        }),
    });
    await expect(
      publishSkillToCloud(ENTRY, PKG, wider.deps, CHOSEN),
    ).rejects.toEqual(refusal('publish-source-unsupported'));
    // A custom skill of the same name is another skill.
    const other = publishFakes({
      analysisSubject: () =>
        Promise.resolve({
          sourceId: 'custom:app',
          skillName: 'lint',
          contentHash: HASH,
          cloudCopy: true,
          audience: 'private',
          accountId: 'acct-1',
        }),
    });
    await expect(
      publishSkillToCloud(ENTRY, PKG, other.deps, CHOSEN),
    ).rejects.toEqual(refusal('publish-package-stale'));
    for (const { recorded } of [wider, other]) {
      expect(recorded.committed).toEqual([]);
      expect(recorded.created).toEqual([]);
      expect(recorded.links).toEqual([]);
    }
  });

  it('links and consents nothing when the cloud answers with an identical skill the account shares more widely', async () => {
    // The account already shares this exact SKILL.md with a public link or a
    // team. A cloud with the create precondition refuses it (409
    // audience_changed); one without it returns that row, which is never
    // linked or recorded as a private copy.
    const refused = publishFakes({
      createSharedSkill: () =>
        Promise.reject(
          new CanopyCloudClientError(
            'http-error',
            'This skill is already in your cloud account, shared with more people than this copy would be.',
            409,
            'audience_changed',
          ),
        ),
    });
    await expect(
      publishSkillToCloud(ENTRY, PKG, refused.deps, CHOSEN),
    ).rejects.toEqual(refusal('publish-audience-wider'));
    for (const wider of [
      { publicShare: PUBLIC_SHARE },
      { shareScope: 'team' as const },
    ]) {
      const returned = publishFakes({
        createSharedSkill: () =>
          Promise.resolve({ ...detail('theirs-public'), ...wider }),
      });
      await expect(
        publishSkillToCloud(ENTRY, PKG, returned.deps, CHOSEN),
      ).rejects.toEqual(refusal('publish-audience-wider'));
      expect(returned.recorded.links).toEqual([]);
      expect(returned.recorded.consents).toEqual([]);
    }
    expect(refused.recorded.links).toEqual([]);
    expect(refused.recorded.consents).toEqual([]);
  });

  it('uploads nothing to a cloud that would ignore the create audience', async () => {
    // An older cloud relinks an identical public skill's package before the
    // desktop could see the row, so the copy never starts there.
    const asked: unknown[] = [];
    const { deps, recorded } = publishFakes({
      assertCreateAudienceSupported: (context) => {
        asked.push(context);
        return Promise.reject(
          new CanopyCloudClientError(
            'unsupported-capability',
            'Cloud does not support skill-create-expected-audience-v1',
          ),
        );
      },
    });
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
      refusal('publish-source-unsupported'),
    );
    expect(asked).toEqual([{ ...CONTEXT }]);
    expect(recorded).toEqual({
      committed: [],
      created: [],
      updated: [],
      links: [],
      consents: [],
    });
  });

  it("refuses one installed from someone's cloud share", async () => {
    const { deps, recorded } = publishFakes({}, [
      skill({ installedFromShare: { remoteId: 'theirs' } }),
    ]);
    await expect(publishSkillToCloud(ENTRY, PKG, deps, CHOSEN)).rejects.toEqual(
      refusal('publish-source-unsupported'),
    );
    expect(recorded.committed).toEqual([]);
  });
});

function keepInStepFakes(
  skills: InstalledSkillInfo[],
  consent: CloudCopyConsent,
): { deps: KeepInStepDeps; calls: string[] } {
  const calls: string[] = [];
  const { deps } = publishFakes({}, skills);
  return {
    calls,
    deps: {
      ...deps,
      readRawSkill: (localId) => {
        calls.push(`read:${localId}`);
        return Promise.resolve(`${RAW}changed\n`);
      },
      readConsent: (localId) => {
        calls.push(`consent:${localId}`);
        return Promise.resolve(consent);
      },
      analyzeSkill: () => {
        calls.push('analyse');
        return Promise.resolve('analysis-2');
      },
      commitPackage: () => {
        calls.push('commit');
        return Promise.reject(new Error('nothing uploads'));
      },
      updateSharedSkill: () => {
        calls.push('update');
        return Promise.reject(new Error('nothing uploads'));
      },
    },
  };
}

const CONSENT: CloudCopyConsent = {
  accountId: 'acct-1',
  remoteId: 'remote-1',
  // Even a consent saying so (hand-edited, or from a later build) never
  // republishes an installed skill.
  keepInStep: true,
  consentedAt: AT,
  selectedOptionalResourceIds: [],
  files: ['skill|claude|lint/SKILL.md'],
  withheld: [],
  audience: 'private',
};

describe("an installed skill's cloud copy is never kept in step (CAN-6943)", () => {
  it('a source update changes its hash, and the send republishes nothing', async () => {
    const { deps, calls } = keepInStepFakes([skill({ remote: LINK })], CONSENT);
    await expect(
      keepCloudSkillsInStep(['remote-1'], {}, deps),
    ).resolves.toEqual({ republished: [], usedLastCopy: [] });
    expect(calls).toEqual([]);
  });
});

describe('once an installed skill is no longer installed, nothing reaches its cloud copy (CAN-6943)', () => {
  // The real uninstall, which keeps the link and consent so a reinstall
  // finds the same copy, is in core-skill-catalog-host.qualification.test.ts.
  it('nothing in the cloud is deleted, nothing republishes, and the consent stays as it was', async () => {
    const root = mkdtempSync(join(tmpdir(), 'can-6943-uninstall-'));
    try {
      const store = CloudCopyConsentStore.inSkillsRoot(root);
      store.set(LOCAL_ID, CONSENT);
      const before = store.read();
      // Gone from the lock file, so main no longer loads it.
      const gone: InstalledSkillInfo[] = [];

      const analysis = analyzeFakes(true, gone);
      await expect(
        analyzeForCloudCopy(ENTRY, 'acct-1', analysis.deps),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });

      const publish = publishFakes({}, gone);
      await expect(
        publishSkillToCloud(ENTRY, PKG, publish.deps, CHOSEN),
      ).rejects.toEqual(refusal('publish-entry-not-found'));
      expect(publish.recorded.committed).toEqual([]);
      expect(publish.recorded.consents).toEqual([]);

      const keep = keepInStepFakes(gone, CONSENT);
      await expect(
        keepCloudSkillsInStep(['remote-1'], {}, keep.deps),
      ).resolves.toEqual({ republished: [], usedLastCopy: [] });
      expect(keep.calls).toEqual([]);

      // The desktop's "Remove from cloud" acts on a custom skill's copy only:
      // an installed skill's copy is removed in the cloud, by the person.
      const deleted: string[] = [];
      const cleared: string[] = [];
      await expect(
        unpublishSkillFromCloud('remote-1', null, {
          loadSkills: () => Promise.resolve(gone),
          credentials: publish.deps.credentials,
          getSharedSkill: () => Promise.resolve(detail('remote-1')),
          deleteSharedSkill: (id) => {
            deleted.push(id);
            return Promise.resolve();
          },
          clearLink: (id) => {
            cleared.push(id);
            return Promise.resolve();
          },
        }),
      ).rejects.toEqual(refusal('unpublish-not-found'));
      expect(deleted).toEqual([]);
      expect(cleared).toEqual([]);
      expect(store.read()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the share client opens to an installed skill only for its private cloud copy (CAN-6943)', () => {
  const request = jest.mocked(requestCanopyCloudJson);
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue(detail('remote-new'));
    mockReads.raw = [];
    mockReads.installed = [];
  });
  const create = {
    sourceSkillId: LOCAL_ID,
    rawSkill: RAW,
    shareScope: 'private' as const,
    expectedSourceSha256: HASH,
  };

  it('refuses an installed skill on every other share, and sends nothing', async () => {
    await expect(createSharedSkill(create)).rejects.toThrow(
      'A source-qualified local skill is required.',
    );
    expect(request).not.toHaveBeenCalled();
    expect(mockReads).toEqual({ raw: [], installed: [] });
  });

  it('reads it through the installed-source reader for its private copy, and refuses a wider one', async () => {
    await createSharedSkill(create, undefined, { allowInstalledSource: true });
    expect(mockReads).toEqual({ raw: [], installed: [LOCAL_ID] });
    await expect(
      createSharedSkill(
        { ...create, shareScope: 'team', teamId: 'team-1' },
        undefined,
        { allowInstalledSource: true },
      ),
    ).rejects.toThrow('A copy of an installed skill stays private.');
    await expect(
      updateSharedSkill(
        {
          sourceSkillId: LOCAL_ID,
          skillId: 'remote-1',
          rawSkill: RAW,
          expectedSourceSha256: HASH,
          shareScope: 'organization',
          organizationId: 'org-1',
        },
        undefined,
        undefined,
        { allowInstalledSource: true },
      ),
    ).rejects.toThrow('A copy of an installed skill stays private.');
  });
});

describe("the share client's installed-source option is main's own, reachable from no other share (CAN-6943)", () => {
  const request = jest.mocked(requestCanopyCloudJson);
  beforeAll(() => {
    registerSkillHandlers();
  });
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue(detail('remote-new'));
    mockReads.raw = [];
    mockReads.installed = [];
  });
  const handler = (channel: string): IpcHandler => {
    const found = mockIpcHandlers.get(channel);
    if (found === undefined) throw new Error(`no handler for ${channel}`);
    return found;
  };

  it("refuses an installed skill on the renderer's share channels, even with the option smuggled into the request", async () => {
    // What a renderer can send: a request object over IPC. The option is a
    // separate argument of main's share client, so naming it here is inert.
    const smuggled = {
      sourceSkillId: LOCAL_ID,
      rawSkill: RAW,
      shareScope: 'private',
      expectedSourceSha256: HASH,
      allowInstalledSource: true,
      installedSource: true,
    };
    for (const [channel, body] of [
      [SKILLS_CHANNELS.SHARED_CREATE, smuggled],
      [SKILLS_CHANNELS.SHARED_UPDATE, { ...smuggled, skillId: 'remote-1' }],
    ] as const) {
      const result = await handler(channel)({}, body);
      expect(result).toMatchObject({ ok: false });
    }
    // Nothing was sent to the cloud and no installed skill was read.
    expect(
      request.mock.calls.filter(([, init]) => init?.method !== undefined),
    ).toEqual([]);
    expect(mockReads.installed).toEqual([]);
  });

  it('is set by the cloud-copy publish alone: no other source names it', () => {
    // Every production file that names the option or the publish's own flag.
    const named = (pattern: string): string[] =>
      execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-e',
          pattern,
          '--',
          ':(glob)apps/*/src/**',
          ':(glob)packages/*/src/**',
          ':(glob,exclude)**/__tests__/**',
        ],
        { cwd: join(__dirname, '../../../../../..'), encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean)
        .sort();
    expect(named('allowInstalledSource')).toEqual([
      'apps/desktop-app/src/main/skills/canopy-server-client.ts',
      'apps/desktop-app/src/main/skills/publish-skill-to-cloud.ts',
    ]);
    expect(named('installedSource: ')).toEqual([
      'apps/desktop-app/src/main/skills/publish-skill-to-cloud.ts',
    ]);
  });
});

describe("an installed skill's analysis stays inside its own folder (CAN-6943)", () => {
  /** As main's inventory describes an installed skill: its folder is the root. */
  const analyse = (
    skillDir: string,
    sourceId: string,
  ): ReturnType<typeof analyzeCapabilityPackage> =>
    analyzeCapabilityPackage({
      rawContent: RAW,
      cloudCopy: {
        gitIgnored: () =>
          Promise.resolve({ isIgnored: () => false, checked: true }),
      },
      invocableInventory: {
        version: 6,
        builtAt: AT,
        entries: [
          {
            id: 'e1',
            provider: 'claude',
            kind: 'skill',
            name: 'lint',
            displayName: 'lint',
            description: '',
            insertText: '/lint',
            invocationKey: 'lint',
            enableRef: { kind: 'skill', sourceId, skillName: 'lint' },
          },
        ],
      },
      capabilityInventoryEntryIdsByKey: { [`skill:${sourceId}:lint`]: ['e1'] },
      sourceByInventoryEntryId: {
        e1: {
          sourceRoot: skillDir,
          memberPath: '.',
          sourceVisibility: 'local',
          runtimeKind: 'standalone_skill',
          rootName: 'lint',
        },
      },
      requests: [
        {
          key: `skill:${sourceId}:lint`,
          provider: 'claude',
          required: true,
          bindingKey: CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
        },
      ],
    });

  it('leaves out a link to a file outside the folder or into a sibling skill, and never sends either', async () => {
    const root = mkdtempSync(join(tmpdir(), 'can-6943-escape-'));
    try {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'secret.md'), 'Not this skill.\n');
      const source = join(root, 'skills', 'local:_Users_me_skills');
      const lint = join(source, 'lint');
      const sibling = join(source, 'other');
      mkdirSync(lint, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'notes.md'), 'Another skill.\n');
      writeFileSync(join(lint, 'SKILL.md'), RAW);
      writeFileSync(join(lint, 'guide.md'), 'How to lint.\n');
      symlinkSync(join(outside, 'secret.md'), join(lint, 'escape.md'));
      symlinkSync(sibling, join(lint, 'sibling'));

      const { summary } = await analyse(lint, 'local:_Users_me_skills');
      const facts = consentFactsOf(summary, []);
      expect(facts.files.join('\n')).not.toMatch(/escape|sibling|secret|notes/);
      expect(facts.files.some((file) => file.endsWith('lint/guide.md'))).toBe(
        true,
      );
      expect(
        (summary.withheldMemberFiles ?? [])
          .map((file) => [file.relativePath, file.reason])
          .sort(),
      ).toEqual([
        ['escape.md', 'symlink'],
        ['sibling', 'symlink'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a package over the size cap: blocked, so the dialog offers no Add', async () => {
    const root = mkdtempSync(join(tmpdir(), 'can-6943-cap-'));
    try {
      const lint = join(root, 'lint');
      mkdirSync(lint);
      writeFileSync(join(lint, 'SKILL.md'), RAW);
      writeFileSync(
        join(lint, 'data.bin'),
        Buffer.alloc(PIPELINE_PACKAGE_MAX_FILE_BYTES + 1),
      );
      const { summary } = await analyse(lint, GITHUB);
      expect(summary.state).toBe('blocked');
      expect(consentFactsOf(summary, []).ready).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
