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
 */
import { createHash } from 'node:crypto';
import { CatalogHostRefusedError } from '@canopy/core-runtime/node/catalog';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import {
  findPackageFileCredentialRule,
  type InstalledSkillInfo,
  type SharedSkillDetail,
} from '@canopy/protocol/skills';
import { requestCanopyCloudJson } from '../../canopy-cloud/client';

jest.mock('../../canopy-cloud/client', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/client'),
  requestCanopyCloudJson: jest.fn(),
  resolveCanopyCloudCredentialContext: (): Promise<unknown> =>
    Promise.resolve({ apiKey: 'k', account: { id: 'acct-1' } }),
  assertCanopyCloudCapability: (): Promise<void> => Promise.resolve(),
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
});
beforeEach(() => {
  request.mockReset();
  mockWarnings.length = 0;
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
      expect(error).toMatchObject({ refusal: 'publish-package-blocked' });
      const cause = error instanceof Error ? error.cause : undefined;
      expect(cause instanceof Error && cause.message).toBe(
        `The skill "helper" looks like it contains a secret (${label} in SKILL.md). Remove it, or replace it with a placeholder such as \${{ secrets.NAME }}, then share again.`,
      );
      expect(commits).toEqual([]);
      expect(creates).toEqual([]);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('maps a custom skill the package carries that looks like it holds a secret to the existing blocked refusal', async () => {
    const { deps, creates } = publishFakes(PLACEHOLDER_SKILL);
    // The upload's own check refuses a dependency skill; that's a blocked
    // package, never an unreachable cloud.
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
    expect(error).toMatchObject({ refusal: 'publish-package-blocked' });
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
