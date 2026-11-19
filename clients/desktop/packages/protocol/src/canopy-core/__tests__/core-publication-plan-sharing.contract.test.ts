// CAN-4166: the spec-first core.publication plan sharing contract. Desktop
// composes it in a later PR; until then no composed registry serves it.
import { CANOPY_INSTRUCTION_DEFINITIONS, CANOPY_QUERY_DEFINITIONS } from '..';
import {
  CORE_PUBLICATION_INSTRUCTION_DEFINITIONS,
  CORE_PUBLICATION_QUERY_DEFINITIONS,
  CORE_PUBLICATION_SHARE_INSTRUCTION_DEFINITIONS,
  PUBLICATION_GRANTS,
} from '../core';

const get = CORE_PUBLICATION_QUERY_DEFINITIONS['core.publication.get'];
const list = CORE_PUBLICATION_QUERY_DEFINITIONS['core.publication.list'];
const create =
  CORE_PUBLICATION_SHARE_INSTRUCTION_DEFINITIONS['core.publication.create'];
const update =
  CORE_PUBLICATION_SHARE_INSTRUCTION_DEFINITIONS['core.publication.update'];
const remove =
  CORE_PUBLICATION_INSTRUCTION_DEFINITIONS['core.publication.delete'];

const HASH = 'a'.repeat(64);
const TEAM = 'b4d6f0a2-6c1e-4b0e-8f3d-2a9c7e5d1f60';
const PUBLICATION = '7b0c3a52-1f7e-4a54-9a59-1f3c9d1e2b40';
const scope = { projectId: 'canopy', worktreeId: 'cassowary' };
const plan = { kind: 'plan', id: 'plan-1', scope };

const repository = {
  repoId: 'single-repo',
  repoName: 'canopy',
  remoteUrl: 'https://github.com/acme/widgets.git',
  branch: 'develop',
  commitSha: 'c'.repeat(40),
  defaultBranch: 'develop',
};

const publication = {
  publicationId: PUBLICATION,
  resource: { ...plan, revision: 3, digest: HASH },
  scope: 'team',
  audienceIds: [TEAM],
  sourceRevision: 3,
  sourceDigest: HASH,
  remoteId: PUBLICATION,
  state: 'published',
  consent: 'explicit_user',
  createdAt: '2026-11-17T09:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
  revision: 1,
  repositories: [repository],
};

const shareRequest = {
  resource: plan,
  scope: 'team',
  audienceIds: [TEAM],
  consent: 'explicit_user',
  _meta: { idempotencyKey: 'share-1' },
};

const audienceRequest = {
  publicationId: PUBLICATION,
  expectedRevision: 1,
  scope: 'organization',
  audienceIds: ['0d9a8c7b-6e5f-4a3b-9c2d-1e0f9a8b7c6d'],
  _meta: { idempotencyKey: 'audience-1' },
};

const withRemote = (remoteUrl: string | null): unknown => ({
  ...publication,
  repositories: [{ ...repository, remoteUrl }],
});

const refusal = (code: string, retry: { kind: string }): unknown => ({
  kind: 'permission_denied',
  message: 'Refused.',
  code,
  retry,
});

describe('core.publication plan sharing contract (CAN-4166)', () => {
  it('reads and writes with the existing publication grants only', () => {
    expect(PUBLICATION_GRANTS).toEqual({
      read: 'core.publication.read',
      write: 'core.publication.write',
    });
    expect(get.requiredGrants).toEqual([PUBLICATION_GRANTS.read]);
    expect(list.requiredGrants).toEqual([PUBLICATION_GRANTS.read]);
    expect(create.requiredGrants).toEqual([PUBLICATION_GRANTS.write]);
    expect(update.requiredGrants).toEqual([PUBLICATION_GRANTS.write]);
    expect([get.idempotency, list.idempotency]).toEqual([
      'inherent',
      'inherent',
    ]);
    expect([create.idempotency, update.idempotency]).toEqual([
      'keyed',
      'keyed',
    ]);
  });

  it('is spec-first: no composed registry serves it, and delete is unchanged', () => {
    for (const name of ['core.publication.get', 'core.publication.list'])
      expect(Object.hasOwn(CANOPY_QUERY_DEFINITIONS, name)).toBe(false);
    for (const name of ['core.publication.create', 'core.publication.update'])
      expect(Object.hasOwn(CANOPY_INSTRUCTION_DEFINITIONS, name)).toBe(false);
    expect(Object.keys(CORE_PUBLICATION_INSTRUCTION_DEFINITIONS)).toEqual([
      'core.publication.delete',
    ]);
    expect(
      remove.error.safeParse(
        refusal('core.publication.revoked', { kind: 'never' }),
      ).success,
    ).toBe(false);
    expect(remove.result.safeParse(publication).success).toBe(false);
  });

  it('shares a plan with one team or organization under a key', () => {
    expect(create.params.safeParse(shareRequest).success).toBe(true);
    expect(
      create.params.safeParse({ ...shareRequest, scope: 'organization' })
        .success,
    ).toBe(true);
    for (const invalid of [
      { ...shareRequest, resource: { ...plan, kind: 'workspace' } },
      { ...shareRequest, resource: { ...plan, kind: 'notebook' } },
      {
        ...shareRequest,
        resource: { ...plan, scope: { projectId: '../x', worktreeId: 'w' } },
      },
      { ...shareRequest, scope: 'private_link', audienceIds: [] },
      { ...shareRequest, audienceIds: [] },
      { ...shareRequest, audienceIds: [TEAM, TEAM] },
      { ...shareRequest, consent: 'policy_allowed' },
      { ...shareRequest, _meta: {} },
      { ...shareRequest, repositories: [repository] },
    ])
      expect(create.params.safeParse(invalid).success).toBe(false);
    expect(create.result.safeParse(publication).success).toBe(true);
  });

  it('changes the audience only against the expected revision', () => {
    expect(update.params.safeParse(audienceRequest).success).toBe(true);
    const { expectedRevision, ...unversioned } = audienceRequest;
    expect(expectedRevision).toBe(1);
    expect(update.params.safeParse(unversioned).success).toBe(false);
    expect(
      update.params.safeParse({ ...audienceRequest, _meta: {} }).success,
    ).toBe(false);
    expect(
      update.params.safeParse({
        ...audienceRequest,
        scope: 'private_link',
        audienceIds: [],
      }).success,
    ).toBe(false);
    expect(
      update.params.safeParse({ ...audienceRequest, resource: plan }).success,
    ).toBe(false);
    expect(update.result.safeParse(publication).success).toBe(true);
  });

  it('shows the owner who has access to a plan or a worktree of plans', () => {
    expect(get.params.safeParse({ resource: plan }).success).toBe(true);
    expect(
      get.params.safeParse({ resource: { ...plan, kind: 'chat' } }).success,
    ).toBe(false);
    expect(get.result.safeParse({ publication }).success).toBe(true);
    expect(get.result.safeParse({ publication: null }).success).toBe(true);
    expect(
      get.result.safeParse({
        publication: { ...publication, scope: 'private_link', audienceIds: [] },
      }).success,
    ).toBe(true);

    const request = {
      resource: { kind: 'plan', scope },
      states: ['published', 'failed'],
      limit: 50,
    };
    expect(list.params.safeParse(request).success).toBe(true);
    expect(
      list.params.safeParse({ ...request, cursor: 'next-page' }).success,
    ).toBe(true);
    expect(
      list.params.safeParse({ resource: { kind: 'review', scope } }).success,
    ).toBe(false);
    expect(list.params.safeParse({ ...request, limit: 201 }).success).toBe(
      false,
    );
    expect(
      list.result.safeParse({ publications: [publication], nextCursor: null })
        .success,
    ).toBe(true);
  });

  it('carries repository refs without credentials, local paths or queries', () => {
    for (const remoteUrl of [
      'https://github.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      null,
    ])
      expect(
        get.result.safeParse({ publication: withRemote(remoteUrl) }).success,
      ).toBe(true);
    for (const remoteUrl of [
      'https://x-access-token:secret@github.com/acme/widgets.git',
      'https://token@github.com/acme/widgets.git',
      'https://github.com/acme/widgets.git?access_token=secret',
      'https://github.com/acme/widgets.git#secret',
      'ssh://git@github.com/acme/widgets.git',
      'deploy@github.com:acme/widgets.git',
      'file:///Users/me/canopy',
      '/Users/me/canopy',
      'C:\\Users\\me\\canopy',
    ]) {
      expect(
        get.result.safeParse({ publication: withRemote(remoteUrl) }).success,
      ).toBe(false);
      expect(
        list.result.safeParse({
          publications: [withRemote(remoteUrl)],
          nextCursor: null,
        }).success,
      ).toBe(false);
    }
  });

  it('refuses with typed codes and the retry its idempotency allows', () => {
    for (const code of [
      'core.publication.revoked',
      'core.publication.readOnly',
      'core.publication.noPlanAccess',
      'core.publication.audienceNotAllowed',
      'core.publication.audienceLocked',
      'core.publication.notFound',
      'core.publication.revisionConflict',
    ]) {
      expect(
        create.error.safeParse(refusal(code, { kind: 'never' })).success,
      ).toBe(true);
      expect(
        get.error.safeParse(refusal(code, { kind: 'never' })).success,
      ).toBe(true);
    }
    expect(
      update.error.safeParse(
        refusal('core.publication.leaked', { kind: 'never' }),
      ).success,
    ).toBe(false);
    expect(
      update.error.safeParse(
        refusal('core.publication.notFound', { kind: 'same_idempotency_key' }),
      ).success,
    ).toBe(true);
    expect(
      update.error.safeParse(
        refusal('core.publication.notFound', { kind: 'same_request' }),
      ).success,
    ).toBe(false);
    expect(
      list.error.safeParse(
        refusal('core.publication.noPlanAccess', {
          kind: 'same_idempotency_key',
        }),
      ).success,
    ).toBe(false);
  });
});
