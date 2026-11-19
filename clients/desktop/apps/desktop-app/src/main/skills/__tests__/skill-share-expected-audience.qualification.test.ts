/**
 * The desktop share dialog's new share with "Only me" names its audience
 * (CAN-7037): the cloud refuses an identical skill the account already shares
 * by link, with a team or with an organization, and a cloud that predates
 * that precondition and returns such a skill anyway gets the same answer.
 * Either way the local skill is never linked to it. A share that names no
 * audience behaves as before.
 */
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import type { SharedSkillDetail } from '@canopy/protocol/skills';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
} from '../../canopy-cloud/client';

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
const mockLinks: [string, unknown][] = [];
jest.mock('../skill-service', () => ({
  writeSkillRemoteMetadata: (localId: string, remote: unknown): void => {
    mockLinks.push([localId, remote]);
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

const AT = '2026-11-17T00:00:00.000Z';
const RAW = '---\nname: notes\ndescription: Notes.\n---\nNotes.\n';
const PUBLIC_SHARE = {
  externalId: 'b1b2b3b4-c5c6-4d7d-8e9e-f0f1f2f3f4f5',
  pinnedContentHash: 'a'.repeat(64),
  upToDate: true,
  sharePath: '/s/skill',
  createdAt: AT,
  updatedAt: AT,
};

const detail = (
  overrides: Partial<SharedSkillDetail> = {},
): SharedSkillDetail => ({
  id: 'remote-1',
  name: 'notes',
  description: 'Notes.',
  contentHash: 'a'.repeat(64),
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

const ONLY_ME = {
  sourceSkillId: 'custom:app/notes',
  rawSkill: RAW,
  shareScope: 'private',
  expectedAudience: 'private',
} as const;

const request = jest.mocked(requestCanopyCloudJson);
const share = (body: object): Promise<unknown> => {
  const handler = mockIpcHandlers.get(SKILLS_CHANNELS.SHARED_CREATE);
  if (handler === undefined) throw new Error('no share handler');
  return handler({}, body);
};
const sentBodies = (): unknown[] =>
  request.mock.calls.flatMap(([, init]) =>
    typeof init?.body === 'string' ? [JSON.parse(init.body) as unknown] : [],
  );

beforeAll(() => {
  registerSkillHandlers();
});
beforeEach(() => {
  request.mockReset();
  mockLinks.length = 0;
});

describe('a new skill share with "Only me" never reuses a skill shared more widely (CAN-7037)', () => {
  it('names the private audience on the create and links the private skill it gets', async () => {
    request.mockResolvedValue(detail());
    await expect(share(ONLY_ME)).resolves.toMatchObject({ ok: true });
    expect(sentBodies()).toEqual([
      expect.objectContaining({ expectedAudience: 'private' }),
    ]);
    expect(mockLinks.map(([localId]) => localId)).toEqual(['custom:app/notes']);
  });

  it('fails with audience_changed and links nothing when the cloud refuses it', async () => {
    request.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'This skill is already in your cloud account, shared with more people than this copy would be.',
        409,
        'audience_changed',
      ),
    );
    await expect(share(ONLY_ME)).resolves.toMatchObject({
      ok: false,
      failure: { httpStatus: 409, serverCode: 'audience_changed' },
    });
    expect(mockLinks).toEqual([]);
  });

  it('gives an older cloud returning a skill shared by link, with a team or with an organization the same answer, and links nothing', async () => {
    for (const wider of [
      { publicShare: PUBLIC_SHARE },
      { shareScope: 'team' as const },
      { shareScope: 'organization' as const },
    ]) {
      request.mockResolvedValue(detail(wider));
      await expect(share(ONLY_ME)).resolves.toMatchObject({
        ok: false,
        failure: { httpStatus: 409, serverCode: 'audience_changed' },
      });
    }
    expect(mockLinks).toEqual([]);
  });

  it('sends an "Only me" update its audience, and links nothing when the cloud says a public link appeared since', async () => {
    const update = (body: object): Promise<unknown> => {
      const handler = mockIpcHandlers.get(SKILLS_CHANNELS.SHARED_UPDATE);
      if (handler === undefined) throw new Error('no share update handler');
      return handler({}, body);
    };
    const ONLY_ME_UPDATE = {
      sourceSkillId: 'custom:app/notes',
      skillId: 'remote-1',
      rawSkill: RAW,
      expectedContentHash: 'a'.repeat(64),
      shareScope: 'private',
      expectedAudience: 'private',
    } as const;
    // A link published elsewhere after the dialog loaded: the cloud refuses
    // under the row lock and writes nothing, and the desktop links nothing.
    request.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'Who can see this skill changed since it was checked',
        409,
        'audience_changed',
      ),
    );
    await expect(update(ONLY_ME_UPDATE)).resolves.toMatchObject({
      ok: false,
      failure: { httpStatus: 409, serverCode: 'audience_changed' },
    });
    expect(sentBodies()).toEqual([
      expect.objectContaining({ expectedAudience: 'private' }),
    ]);
    expect(mockLinks).toEqual([]);
    // Still private, the same update goes ahead and keeps its link.
    request.mockReset();
    request.mockResolvedValue(detail());
    await expect(update(ONLY_ME_UPDATE)).resolves.toMatchObject({ ok: true });
    expect(mockLinks.map(([localId]) => localId)).toEqual(['custom:app/notes']);
  });

  it('behaves as before for a share that names no audience', async () => {
    const unnamed = {
      sourceSkillId: ONLY_ME.sourceSkillId,
      rawSkill: ONLY_ME.rawSkill,
      shareScope: ONLY_ME.shareScope,
    };
    request.mockResolvedValue(detail({ publicShare: PUBLIC_SHARE }));
    await expect(share(unnamed)).resolves.toMatchObject({ ok: true });
    const bodies = sentBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('expectedAudience');
    expect(mockLinks.map(([localId]) => localId)).toEqual(['custom:app/notes']);
  });
});
