// CAN-5904: the `core.publication.delete` contract the web core serves for
// plans and desktop never registers. CAN-4169: the shared-run
// `core.publication.comment.markSeen` contract the desktop dispatcher serves.
import { CANOPY_INSTRUCTION_DEFINITIONS } from '..';
import {
  CORE_PUBLICATION_COMMENT_INSTRUCTION_DEFINITIONS,
  CORE_PUBLICATION_INSTRUCTION_DEFINITIONS,
} from '../core';

const remove =
  CORE_PUBLICATION_INSTRUCTION_DEFINITIONS['core.publication.delete'];
const HASH = 'a'.repeat(64);

const tombstone = {
  publicationId: '7b0c3a52-1f7e-4a54-9a59-1f3c9d1e2b40',
  resource: { kind: 'plan', id: 'plan-1', revision: 3, digest: HASH },
  scope: 'team',
  audienceIds: ['b4d6f0a2-6c1e-4b0e-8f3d-2a9c7e5d1f60'],
  sourceRevision: 3,
  sourceDigest: HASH,
  remoteId: '7b0c3a52-1f7e-4a54-9a59-1f3c9d1e2b40',
  state: 'revoked',
  consent: 'explicit_user',
  createdAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  revision: 2,
};

describe('core.publication.delete contract (CAN-5904)', () => {
  it('is a keyed core write that no composed core registry carries', () => {
    expect(remove.requiredGrants).toEqual(['core.publication.write']);
    expect(remove.idempotency).toBe('keyed');
    expect(remove.placement).toBe('core-only');
    expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)).not.toContain(
      'core.publication.delete',
    );
  });

  it('requires the publication, its expected revision and a key', () => {
    const request = {
      publicationId: tombstone.publicationId,
      expectedRevision: 2,
      _meta: { idempotencyKey: 'unshare-1' },
    };
    expect(remove.params.safeParse(request).success).toBe(true);
    expect(
      remove.params.safeParse({ ...request, expectedRevision: undefined })
        .success,
    ).toBe(false);
    expect(remove.params.safeParse({ ...request, _meta: {} }).success).toBe(
      false,
    );
    expect(remove.params.safeParse({ ...request, scope: 'team' }).success).toBe(
      false,
    );
  });

  it('answers a revoked tombstone of the publication as it was', () => {
    expect(remove.result.safeParse(tombstone).success).toBe(true);
    expect(
      remove.result.safeParse({
        ...tombstone,
        scope: 'private_link',
        audienceIds: [],
      }).success,
    ).toBe(true);
    expect(
      remove.result.safeParse({ ...tombstone, sourceDigest: 'not-a-digest' })
        .success,
    ).toBe(false);
    expect(
      remove.result.safeParse({ ...tombstone, content: 'plan body' }).success,
    ).toBe(false);
  });

  it('refuses with not_found, a revision conflict, or a reused key', () => {
    expect(
      remove.error.safeParse({
        kind: 'not_found',
        message: 'No such publication.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
    expect(
      remove.error.safeParse({
        kind: 'conflict',
        message: 'The publication has changed.',
        code: 'core.publication.revisionConflict',
        retry: { kind: 'after_refresh', resource: tombstone.publicationId },
      }).success,
    ).toBe(true);
    expect(
      remove.error.safeParse({
        kind: 'invalid_argument',
        message: 'The idempotency key was used with different params.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
    // Keyed: only the same key replays, never the same request.
    expect(
      remove.error.safeParse({
        kind: 'unavailable',
        message: 'Try again.',
        retry: { kind: 'same_request' },
      }).success,
    ).toBe(false);
  });
});

const markSeen =
  CORE_PUBLICATION_COMMENT_INSTRUCTION_DEFINITIONS[
    'core.publication.comment.markSeen'
  ];

describe('core.publication.comment.markSeen contract (CAN-4169)', () => {
  it('is a keyed core write under core.publication.write', () => {
    expect(markSeen.requiredGrants).toEqual(['core.publication.write']);
    expect(markSeen.idempotency).toBe('keyed');
    expect(markSeen.placement).toBe('core-only');
  });

  it('takes a publication and a nonnegative revision, nothing else', () => {
    const request = {
      publicationId: '7b0c3a52-1f7e-5a54-9a59-1f3c9d1e2b40',
      throughRevision: 4,
    };
    expect(markSeen.params.safeParse(request).success).toBe(true);
    for (const throughRevision of [-1, 1.5, undefined])
      expect(
        markSeen.params.safeParse({ ...request, throughRevision }).success,
      ).toBe(false);
    expect(
      markSeen.params.safeParse({ ...request, projectId: 'p' }).success,
    ).toBe(false);
  });

  it('answers the seen revision and unread count, and refuses an unwatched run', () => {
    expect(
      markSeen.result.safeParse({ seenRevision: 4, unreadCount: 0 }).success,
    ).toBe(true);
    expect(
      markSeen.result.safeParse({ seenRevision: 4, unreadCount: -1 }).success,
    ).toBe(false);
    expect(
      markSeen.error.safeParse({
        kind: 'not_found',
        code: 'core.publication.notFound',
        message: 'This shared run is not watched for comments.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
  });
});
