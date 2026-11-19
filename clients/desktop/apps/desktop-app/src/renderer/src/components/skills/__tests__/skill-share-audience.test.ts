/**
 * A new skill share with "Only me" asks the cloud for a private skill, so an
 * identical skill the account already shares by link, with a team or with an
 * organization is refused rather than reused, and the dialog says why
 * (CAN-7037). The other audiences ask nothing, as before.
 */
import type { ShareFailure } from '@canopy/protocol/sharing';
import type { SharedSkillDetail } from '@canopy/protocol/skills';
import { ShareFailureError } from '@canopy/ui-app/sharing';
import {
  SKILL_SHARE_AUDIENCE_WIDER_MESSAGE,
  skillShareCreateAudience,
  skillShareCreateRefusal,
  skillShareUpdateAudience,
} from '../skill-share-audience';

const PUBLIC_SHARE: NonNullable<SharedSkillDetail['publicShare']> = {
  externalId: 'b1b2b3b4-c5c6-4d7d-8e9e-f0f1f2f3f4f5',
  pinnedContentHash: 'a'.repeat(64),
  upToDate: true,
  sharePath: '/s/skill',
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
};

const failure = (overrides: Partial<ShareFailure> = {}): ShareFailure => ({
  version: 1,
  kind: 'conflict',
  stage: 'publish',
  message: 'This skill is already in your cloud account.',
  commitState: 'not-committed',
  retryable: false,
  httpStatus: 409,
  serverCode: 'audience_changed',
  ...overrides,
});

describe('a new skill share names its audience only for "Only me" (CAN-7037)', () => {
  it('asks for a private skill with "Only me", and nothing for the other audiences', () => {
    expect(skillShareCreateAudience('private')).toEqual({
      expectedAudience: 'private',
    });
    for (const scope of ['team', 'organization', 'public'] as const)
      expect(skillShareCreateAudience(scope)).toEqual({});
  });

  it('asks an "Only me" update for the audience the dialog loaded, and nothing for the other audiences', () => {
    const loaded = (
      overrides: Partial<Pick<SharedSkillDetail, 'shareScope' | 'publicShare'>>,
    ): Pick<SharedSkillDetail, 'shareScope' | 'publicShare'> => ({
      shareScope: 'private',
      publicShare: null,
      ...overrides,
    });
    // Loaded private: a public link published elsewhere since then makes the
    // cloud refuse the update under its row lock, and nothing is written.
    expect(skillShareUpdateAudience('private', loaded({}))).toEqual({
      expectedAudience: 'private',
    });
    // Loaded with the link the dialog is revoking, or with the team or
    // organization it is moving the skill away from.
    expect(
      skillShareUpdateAudience(
        'private',
        loaded({ publicShare: PUBLIC_SHARE }),
      ),
    ).toEqual({ expectedAudience: 'public_link' });
    expect(
      skillShareUpdateAudience('private', loaded({ shareScope: 'team' })),
    ).toEqual({ expectedAudience: 'team' });
    expect(
      skillShareUpdateAudience(
        'private',
        loaded({ shareScope: 'organization' }),
      ),
    ).toEqual({ expectedAudience: 'organization' });
    for (const scope of ['team', 'organization', 'public'] as const)
      expect(skillShareUpdateAudience(scope, loaded({}))).toEqual({});
  });

  it('asks an "Only me" update for a private skill when the dialog loaded nothing, which fails closed for anything wider', () => {
    // The skill's cloud detail didn't load, so the dialog doesn't know who it
    // reaches. Naming no audience would let the update land on a skill shared
    // by link, with a team or with an organization; naming private makes the
    // cloud refuse any of those under its row lock, writing nothing.
    expect(skillShareUpdateAudience('private', null)).toEqual({
      expectedAudience: 'private',
    });
  });

  it('explains a refusal for a skill shared more widely, however the failure arrives', () => {
    const refused = failure();
    for (const error of [
      new ShareFailureError(refused),
      refused,
      { ok: false, failure: refused },
    ])
      expect(skillShareCreateRefusal(error)).toBe(
        SKILL_SHARE_AUDIENCE_WIDER_MESSAGE,
      );
    expect(SKILL_SHARE_AUDIENCE_WIDER_MESSAGE).toBe(
      "This skill is already in your cloud account and shared by link, with a team or with an organization, so sharing it with only you can't use it. Stop sharing it in the cloud, or change this skill, then share it again.",
    );
  });

  it("explains an older cloud's wider answer, which main refuses after the create, the same way", () => {
    // Main never links a returned skill shared more widely and fails with the
    // cloud's own code; whatever the failure says about the commit, the
    // dialog shows the same explanation, not "shared, but finishing up failed".
    for (const commitState of [
      'not-committed',
      'unknown',
      'committed',
    ] as const)
      expect(
        skillShareCreateRefusal(
          new ShareFailureError(failure({ commitState })),
        ),
      ).toBe(SKILL_SHARE_AUDIENCE_WIDER_MESSAGE);
  });

  it('leaves every other failure to the dialog as before', () => {
    expect(
      skillShareCreateRefusal(
        new ShareFailureError(failure({ serverCode: 'version_conflict' })),
      ),
    ).toBeNull();
    expect(
      skillShareCreateRefusal(
        new ShareFailureError(failure({ serverCode: undefined })),
      ),
    ).toBeNull();
    expect(skillShareCreateRefusal(new Error('Offline'))).toBeNull();
  });
});
