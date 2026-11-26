// CAN-5904: the `core.publication.delete` contract the web core serves for
// plans and desktop never registers. CAN-4169: the shared-run
// `core.publication.comment.markSeen` contract the desktop dispatcher serves,
// and the comment list, create, reply and update contracts, which name the
// shared chat as desktop's runs:comments channels do and only the desktop
// dispatcher composes.
import { z } from 'zod';

import { CANOPY_INSTRUCTION_DEFINITIONS, CANOPY_QUERY_DEFINITIONS } from '..';
import {
  CORE_PUBLICATION_COMMENT_INSTRUCTION_DEFINITIONS,
  CORE_PUBLICATION_COMMENT_QUERY_DEFINITIONS,
  CORE_PUBLICATION_COMMENT_THREAD_INSTRUCTION_DEFINITIONS,
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

const list =
  CORE_PUBLICATION_COMMENT_QUERY_DEFINITIONS['core.publication.comment.list'];
const create =
  CORE_PUBLICATION_COMMENT_THREAD_INSTRUCTION_DEFINITIONS[
    'core.publication.comment.create'
  ];
const reply =
  CORE_PUBLICATION_COMMENT_THREAD_INSTRUCTION_DEFINITIONS[
    'core.publication.comment.reply'
  ];
const update =
  CORE_PUBLICATION_COMMENT_THREAD_INSTRUCTION_DEFINITIONS[
    'core.publication.comment.update'
  ];
const CHAT = {
  projectId: 'proj-1',
  worktreeId: 'wt-1',
  chatId: 'chat-9-1795113692073',
};
const comments = {
  commentThreads: [
    {
      id: 'web:3f2a',
      status: 'open',
      anchor: { kind: 'message', messageId: 'turn-1:m1' },
      anchorState: 'matched',
      anchorText: 'Ran the build again',
      createdAt: '2026-11-10T10:00:00.000Z',
      comments: [
        {
          id: 'c1',
          author: { userId: 'user-1', displayName: 'Ada', image: null },
          body: 'Why this?',
          createdAt: '2026-11-10T10:00:00.000Z',
        },
      ],
    },
  ],
  commentRevision: 3,
  viewerUserId: 'user-1',
};
const thread = comments.commentThreads[0];

describe('shared-run comment thread contracts (CAN-4169)', () => {
  it('lists and writes under the publication and workspace grant pairs, kept out of the shared registries', () => {
    expect(list.kind).toBe('query');
    expect(list.idempotency).toBe('inherent');
    expect(list.requiredGrants).toEqual([
      'core.publication.read',
      'core.workspace.read',
    ]);
    for (const write of [create, reply, update]) {
      expect(write.kind).toBe('instruction');
      expect(write.idempotency).toBe('keyed');
      expect(write.placement).toBe('core-only');
      expect(write.requiredGrants).toEqual([
        'core.publication.write',
        'core.workspace.write',
      ]);
    }
    expect(Object.keys(CANOPY_QUERY_DEFINITIONS)).not.toContain(
      'core.publication.comment.list',
    );
    for (const name of Object.keys(
      CORE_PUBLICATION_COMMENT_THREAD_INSTRUCTION_DEFINITIONS,
    ))
      expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)).not.toContain(name);
  });

  it('list names a shared chat by project, worktree and chat id and answers its comment state, or none, with the seen revision', () => {
    expect(list.params.safeParse(CHAT).success).toBe(true);
    expect(list.params.safeParse({ ...CHAT, cursor: 'c' }).success).toBe(false);
    for (const key of ['projectId', 'worktreeId', 'chatId'] as const)
      for (const value of [undefined, '', 'Proj', '-p', 'p/q', 'p'.repeat(513)])
        expect(list.params.safeParse({ ...CHAT, [key]: value }).success).toBe(
          false,
        );
    expect(
      list.params.safeParse({
        publicationId: '7b0c3a52-1f7e-5a54-9a59-1f3c9d1e2b40',
      }).success,
    ).toBe(false);
    expect(
      list.result.safeParse({ comments: null, lastSeenCommentRevision: 0 })
        .success,
    ).toBe(true);
    expect(
      list.result.safeParse({ comments, lastSeenCommentRevision: 2 }).success,
    ).toBe(true);
    expect(
      list.result.safeParse({ comments, lastSeenCommentRevision: -1 }).success,
    ).toBe(false);
    expect(list.result.safeParse({ comments: null }).success).toBe(false);
  });

  it('answers only the comment state: never the hosted diff, transcript or messages', () => {
    // Each hosted-detail field alone is refused; the diff alone may be 5 MiB.
    const forbidden = {
      diff: 'd'.repeat(5 * 1024 * 1024),
      transcript: [],
      messages: [{ messageId: 'turn-1:m1', text: 'Ran the build again' }],
      plans: [],
      externalId: 'run-ext-1',
    };
    for (const [field, value] of Object.entries(forbidden)) {
      const hosted = { ...comments, [field]: value };
      expect(create.result.safeParse({ comments: hosted }).success).toBe(false);
      expect(
        list.result.safeParse({ comments: hosted, lastSeenCommentRevision: 0 })
          .success,
      ).toBe(false);
    }
    expect(create.result.parse({ comments })).toEqual({ comments });
    expect(
      create.result.safeParse({
        comments: { ...comments, commentRevision: undefined },
      }).success,
    ).toBe(false);
    for (const bad of [
      { ...thread, status: 'closed' },
      { ...thread, anchorText: 'a'.repeat(257) },
      { ...thread, comments: [{ ...thread.comments[0], hostedLater: 1 }] },
    ])
      expect(
        create.result.safeParse({
          comments: { ...comments, commentThreads: [bad] },
        }).success,
      ).toBe(false);
    expect(
      create.result.safeParse({
        comments: {
          ...comments,
          commentThreads: [
            { ...thread, anchor: { kind: 'run' }, anchorText: null },
          ],
        },
      }).success,
    ).toBe(true);
    expect(create.result.safeParse({ comments: null }).success).toBe(false);
  });

  it('create takes a non-blank body of at most 16,384 characters and an optional run or message anchor', () => {
    const request = {
      ...CHAT,
      body: 'Why this?',
    };
    expect(create.params.safeParse(request).success).toBe(true);
    for (const anchor of [
      { kind: 'run' },
      { kind: 'message', messageId: 'turn-1:m1' },
      { kind: 'message', messageId: 'm'.repeat(512) },
    ])
      expect(create.params.safeParse({ ...request, anchor }).success).toBe(
        true,
      );
    for (const anchor of [
      { kind: 'message' },
      { kind: 'message', messageId: '' },
      { kind: 'message', messageId: 'm'.repeat(513) },
      { kind: 'thread' },
      { kind: 'run', messageId: 'turn-1:m1' },
      null,
    ])
      expect(create.params.safeParse({ ...request, anchor }).success).toBe(
        false,
      );
    expect(
      create.params.safeParse({ ...request, body: 'b'.repeat(16_384) }).success,
    ).toBe(true);
    for (const body of ['', ' \n\t', 'b'.repeat(16_385), undefined])
      expect(create.params.safeParse({ ...request, body }).success).toBe(false);
    expect(
      create.params.safeParse({ ...request, publicationId: CHAT.chatId })
        .success,
    ).toBe(false);
  });

  it('counts the body and anchor limits in UTF-16 code units, as the hosted routes do, and says so in the schema', () => {
    const request = { ...CHAT, body: 'Why this?' };
    // An emoji is two UTF-16 code units; JSON Schema maxLength counts one.
    const emoji = '\u{1F600}';
    expect(
      create.params.safeParse({ ...request, body: emoji.repeat(8_192) })
        .success,
    ).toBe(true);
    expect(
      create.params.safeParse({ ...request, body: emoji.repeat(8_193) })
        .success,
    ).toBe(false);
    expect(
      reply.params.safeParse({
        ...CHAT,
        threadId: 'web:3f2a',
        body: emoji.repeat(8_193),
      }).success,
    ).toBe(false);
    for (const [count, success] of [
      [256, true],
      [257, false],
    ] as const)
      expect(
        create.params.safeParse({
          ...request,
          anchor: { kind: 'message', messageId: emoji.repeat(count) },
        }).success,
      ).toBe(success);
    // The page drops descriptions; its prose states the unit.
    const schema = JSON.stringify(
      z.toJSONSchema(create.params, { io: 'input' }),
    );
    expect(schema.match(/UTF-16 code units/g)?.length).toBe(2);
  });

  it('reply and update name a thread by 1 to 128 letters, digits, colons, underscores or hyphens', () => {
    const replying = {
      ...CHAT,
      threadId: 'web:3f2a-b_c',
      body: 'Because.',
    };
    const updating = {
      ...CHAT,
      threadId: 'web:3f2a-b_c',
      status: 'resolved',
    };
    expect(reply.params.safeParse(replying).success).toBe(true);
    expect(update.params.safeParse(updating).success).toBe(true);
    for (const threadId of ['t'.repeat(128)]) {
      expect(reply.params.safeParse({ ...replying, threadId }).success).toBe(
        true,
      );
      expect(update.params.safeParse({ ...updating, threadId }).success).toBe(
        true,
      );
    }
    for (const threadId of [
      '',
      't'.repeat(129),
      'web/3f2a',
      '../x',
      'web 3f2a',
      'web%3A3f2a',
      undefined,
    ]) {
      expect(reply.params.safeParse({ ...replying, threadId }).success).toBe(
        false,
      );
      expect(update.params.safeParse({ ...updating, threadId }).success).toBe(
        false,
      );
    }
    expect(reply.params.safeParse({ ...replying, body: '  ' }).success).toBe(
      false,
    );
    expect(
      reply.params.safeParse({ ...replying, anchor: { kind: 'run' } }).success,
    ).toBe(false);
  });

  it('update sets only the thread status, open or resolved', () => {
    const updating = {
      ...CHAT,
      threadId: 'web:3f2a',
      status: 'open',
    };
    expect(update.params.safeParse(updating).success).toBe(true);
    for (const status of ['closed', undefined])
      expect(update.params.safeParse({ ...updating, status }).success).toBe(
        false,
      );
    expect(
      update.params.safeParse({ ...updating, body: 'edited' }).success,
    ).toBe(false);
    expect(
      update.params.safeParse({ ...updating, expectedRevision: 3 }).success,
    ).toBe(false);
  });

  it('refuses where no runtime serves it with capability_unavailable and a never retry', () => {
    const unserved = {
      kind: 'capability_unavailable',
      message: 'This runtime does not serve shared-run comments.',
      retry: { kind: 'never' },
    };
    for (const definition of [list, create, reply, update, markSeen])
      expect(definition.error.safeParse(unserved).success).toBe(true);
    // A hosted write that may have been sent is never retried by key.
    expect(
      create.error.safeParse({
        kind: 'unavailable',
        code: 'core.publication.commentSendUncertain',
        message: 'The connection failed.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
    expect(
      list.error.safeParse({
        kind: 'unavailable',
        message: 'The connection failed.',
        retry: { kind: 'same_request' },
      }).success,
    ).toBe(true);
    expect(
      create.error.safeParse({
        kind: 'unavailable',
        message: 'Try again.',
        retry: { kind: 'same_request' },
      }).success,
    ).toBe(false);
  });

  it('gives each hosted write refusal one code and retry, in the schema and on the page', () => {
    // The page's JSON Schema, as the generator renders it (z.toJSONSchema),
    // read back into a validator, so a rule the conversion drops shows here.
    const generated = (error: z.ZodType): z.ZodType =>
      z.fromJSONSchema(
        z.toJSONSchema(error, {
          io: 'output',
          unrepresentable: 'any',
        }),
      );
    const accepted = [
      // The hosted request left the process and may have landed.
      {
        kind: 'unavailable',
        code: 'core.publication.commentSendUncertain',
        message: 'The connection was reset after the request was sent.',
        retry: { kind: 'never' },
      },
      // The dispatcher's refusal of a keyed call on a draining or closed
      // runtime, before any handler runs: canopyUnavailableError(undefined,
      // retryForDefinition(definition)), packages/core-runtime/src/runtime/
      // dispatcher.ts:304-308 with the keyed retry at dispatcher.ts:156-157
      // and the message at errors.ts:85-89.
      {
        kind: 'unavailable',
        message: 'The runtime is unavailable.',
        retry: { kind: 'same_idempotency_key' },
      },
      // The hosted 429: a thread or comment cap is reached, nothing written.
      {
        kind: 'resource_exhausted',
        code: 'core.publication.commentLimitReached',
        message: 'This run has reached the maximum number of comment threads.',
        retry: { kind: 'never' },
      },
      // The hosted 409: its serializable retries ran out and it rolled back.
      {
        kind: 'conflict',
        code: 'core.publication.commentWriteContended',
        message: 'Another comment was saved at the same time.',
        retry: { kind: 'same_idempotency_key', delayMs: 1_000 },
      },
      {
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      },
      {
        kind: 'deadline_exceeded',
        message: 'The operation deadline was exceeded.',
        retry: { kind: 'same_idempotency_key' },
      },
      {
        kind: 'failed_precondition',
        message: 'This chat is not currently shared as a run.',
        retry: { kind: 'after_refresh', resource: 'run' },
      },
    ];
    const rejected = [
      {
        kind: 'unavailable',
        code: 'core.publication.commentSendUncertain',
        retry: { kind: 'same_idempotency_key' },
      },
      { kind: 'unavailable', retry: { kind: 'never' } },
      {
        kind: 'unavailable',
        code: 'core.publication.other',
        retry: { kind: 'same_idempotency_key' },
      },
      {
        kind: 'unavailable',
        code: 'core.publication.commentWriteContended',
        retry: { kind: 'same_idempotency_key' },
      },
      {
        kind: 'conflict',
        code: 'core.publication.commentWriteContended',
        retry: { kind: 'never' },
      },
      { kind: 'conflict', retry: { kind: 'same_idempotency_key' } },
      // The contended resend must wait: no delay, or a zero delay, is refused.
      ...[
        { kind: 'same_idempotency_key' },
        { kind: 'same_idempotency_key', delayMs: 0 },
      ].map((retry) => ({
        kind: 'conflict',
        code: 'core.publication.commentWriteContended',
        retry,
      })),
      ...['unavailable', 'conflict', 'not_found', 'internal'].map((kind) => ({
        kind,
        code: 'core.publication.commentLimitReached',
        retry: { kind: 'never' },
      })),
      ...[
        { kind: 'same_idempotency_key' },
        { kind: 'after_refresh', resource: 'run' },
      ].map((retry) => ({
        kind: 'resource_exhausted',
        code: 'core.publication.commentLimitReached',
        retry,
      })),
      { kind: 'resource_exhausted', retry: { kind: 'never' } },
      {
        kind: 'not_found',
        code: 'core.publication.commentSendUncertain',
        retry: { kind: 'never' },
      },
    ];
    for (const write of [create, reply, update]) {
      const page = generated(write.error);
      for (const outcome of accepted) {
        expect(write.error.safeParse(outcome).success).toBe(true);
        expect(page.safeParse(outcome).success).toBe(true);
      }
      for (const mismatch of rejected) {
        const outcome = { message: 'Refused.', ...mismatch };
        expect(write.error.safeParse(outcome).success).toBe(false);
        expect(page.safeParse(outcome).success).toBe(false);
      }
    }
    // A read is never capped, contended or uncertain.
    expect(list.error.safeParse(accepted[2]).success).toBe(false);
  });
});
