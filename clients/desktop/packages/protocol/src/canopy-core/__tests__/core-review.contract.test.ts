import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
} from '..';
import {
  CORE_REVIEW_INSTRUCTION_DEFINITIONS,
  CORE_REVIEW_QUERY_DEFINITIONS,
  CORE_REVIEW_STREAM_DEFINITIONS,
  REVIEW_ERROR_CODES,
} from '../core';

const scope = { projectId: 'project-1', worktreeId: 'task-1' };

const QUERIES = ['core.review.get'] as const;
const INSTRUCTIONS = [
  'core.review.arm',
  'core.review.create',
  'core.review.comment.upsert',
  'core.review.comment.reply',
  'core.review.comment.resolve',
] as const;
const STREAMS = ['core.review.events'] as const;
const PLACEHOLDERS = ['core.review.list', 'core.review.finding.update'];

const thread = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 'thread-1',
  status: 'open',
  createdAt: '2026-11-16T00:00:00.000Z',
  anchor: {
    source: 'code',
    view: 'diff',
    diff: { source: 'committed', snapshotId: 'snapshot-1' },
    quote: 'const a = 1;',
    repoId: 'default',
    filePath: 'src/a.ts',
    side: 'new',
    lineStart: 3,
    lineEnd: 3,
  },
  anchorState: 'matched',
  comments: [
    {
      id: 'comment-1',
      author: 'user',
      body: 'Why?',
      createdAt: '2026-11-16T00:00:00.000Z',
      staged: true,
    },
  ],
  ...overrides,
});

const review = {
  version: 1,
  armed: true,
  armedAt: '2026-11-16T00:00:00.000Z',
  commentThreads: [thread()],
  annotations: {
    data: { schemaVersion: 1, annotations: [] },
    derivedFromFingerprint: 'fingerprint-1',
    status: 'ready',
  },
  diagrams: {
    logicDiff: {
      data: null,
      derivedFromFingerprint: 'fingerprint-1',
      status: 'generating',
    },
  },
};

describe('core.review contract (CAN-4167)', () => {
  it('retries a keyed write under its key and a read with the same request', () => {
    const unavailable = (kind: string): unknown => ({
      kind: 'unavailable',
      message: 'temporarily unavailable',
      retry: { kind },
    });
    for (const name of INSTRUCTIONS) {
      const { error } = CORE_REVIEW_INSTRUCTION_DEFINITIONS[name];
      expect(error.safeParse(unavailable('same_idempotency_key')).success).toBe(
        true,
      );
      expect(error.safeParse(unavailable('same_request')).success).toBe(false);
    }
    for (const name of QUERIES) {
      const { error } = CORE_REVIEW_QUERY_DEFINITIONS[name];
      expect(error.safeParse(unavailable('same_request')).success).toBe(true);
    }
    expect(
      CORE_REVIEW_STREAM_DEFINITIONS['core.review.events'].error.safeParse(
        unavailable('same_request'),
      ).success,
    ).toBe(true);
  });

  it('reads with core.review.read and writes with core.review.write', () => {
    for (const name of QUERIES) {
      expect(CORE_REVIEW_QUERY_DEFINITIONS[name].requiredGrants).toEqual([
        'core.review.read',
      ]);
    }
    for (const name of INSTRUCTIONS) {
      expect(CORE_REVIEW_INSTRUCTION_DEFINITIONS[name].requiredGrants).toEqual([
        'core.review.write',
      ]);
      expect(CORE_REVIEW_INSTRUCTION_DEFINITIONS[name].idempotency).toBe(
        'keyed',
      );
    }
    expect(
      CORE_REVIEW_STREAM_DEFINITIONS['core.review.events'].requiredGrants,
    ).toEqual(['core.review.read']);
  });

  it('stays out of the composed registries until a handler serves it', () => {
    for (const name of QUERIES) {
      expect(Object.keys(CANOPY_QUERY_DEFINITIONS)).not.toContain(name);
    }
    for (const name of INSTRUCTIONS) {
      expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)).not.toContain(name);
    }
    for (const name of STREAMS) {
      expect(Object.keys(CANOPY_STREAM_DEFINITIONS)).not.toContain(name);
    }
  });

  it('defines no list or finding operation, which desktop does not have', () => {
    const defined = [
      ...Object.keys(CORE_REVIEW_QUERY_DEFINITIONS),
      ...Object.keys(CORE_REVIEW_INSTRUCTION_DEFINITIONS),
      ...Object.keys(CORE_REVIEW_STREAM_DEFINITIONS),
      ...Object.keys(CANOPY_QUERY_DEFINITIONS),
      ...Object.keys(CANOPY_INSTRUCTION_DEFINITIONS),
    ];
    for (const name of PLACEHOLDERS) expect(defined).not.toContain(name);
  });

  it('scopes every operation to a slug project and worktree', () => {
    const { params } = CORE_REVIEW_QUERY_DEFINITIONS['core.review.get'];
    expect(params.safeParse({ scope }).success).toBe(true);
    for (const bad of ['../x', 'A', 'a/b', 'a.b', 'a%2e']) {
      expect(
        params.safeParse({ scope: { ...scope, worktreeId: bad } }).success,
      ).toBe(false);
    }
    for (const name of ['core.review.arm', 'core.review.create'] as const) {
      const definition = CORE_REVIEW_INSTRUCTION_DEFINITIONS[name];
      expect(definition.params.safeParse({ scope }).success).toBe(true);
      expect(definition.params.safeParse({ scope, extra: true }).success).toBe(
        false,
      );
    }
  });

  it('reads the stored review with its fingerprint and skipped threads', () => {
    const { result } = CORE_REVIEW_QUERY_DEFINITIONS['core.review.get'];
    expect(
      result.safeParse({ review, fingerprint: 'fingerprint-1' }).success,
    ).toBe(true);
    expect(
      result.safeParse({
        review: {
          version: 1,
          armed: false,
          commentThreads: [],
          diagrams: {},
        },
        fingerprint: 'fingerprint-1',
        skippedCommentThreads: 2,
      }).success,
    ).toBe(true);
    expect(
      result.safeParse({
        review,
        fingerprint: 'fingerprint-1',
        skippedCommentThreads: 0,
      }).success,
    ).toBe(false);
    expect(
      result.safeParse({ review: null, fingerprint: 'fingerprint-1' }).success,
    ).toBe(false);
  });

  it('answers generation with exactly the desktop statuses', () => {
    for (const name of ['core.review.arm', 'core.review.create'] as const) {
      const { result } = CORE_REVIEW_INSTRUCTION_DEFINITIONS[name];
      for (const status of [
        'fresh',
        'empty',
        'generated',
        'error',
        'queued',
        'stopped',
      ]) {
        expect(result.safeParse({ status }).success).toBe(true);
      }
      expect(result.safeParse({ status: 'failed' }).success).toBe(false);
      expect(
        result.safeParse({ status: 'error', error: 'Unable to generate.' })
          .success,
      ).toBe(true);
    }
  });

  it('refuses a malformed comment thread instead of saving it', () => {
    const { params } =
      CORE_REVIEW_INSTRUCTION_DEFINITIONS['core.review.comment.upsert'];
    const saving = (commentThreads: unknown[]): boolean =>
      params.safeParse({ scope, commentThreads }).success;
    expect(saving([thread()])).toBe(true);
    expect(
      params.safeParse({
        scope,
        commentThreads: [thread()],
        baseCommentThreadIds: ['thread-1'],
        baseCommentThreads: [thread()],
      }).success,
    ).toBe(true);
    expect(
      saving([
        thread({
          anchor: { source: 'diagram', quote: 'Node', nodeId: 'n1' },
          futureField: true,
        }),
      ]),
    ).toBe(true);
    for (const bad of [
      thread({ status: 'closed' }),
      thread({ anchorState: 'moved' }),
      thread({ anchor: undefined }),
      thread({ anchor: { source: 'code', view: 'diff', quote: 'x' } }),
      thread({ anchor: { source: 'code', quote: 'x', side: 'left' } }),
      thread({ comments: [{ id: 'c', author: 'bot', body: 'x' }] }),
    ]) {
      expect(saving([thread(), bad])).toBe(false);
    }
  });

  it('keeps anchors and annotations inside the repository on any host', () => {
    const { params } =
      CORE_REVIEW_INSTRUCTION_DEFINITIONS['core.review.comment.upsert'];
    const anchoredAt = (filePath: string): boolean =>
      params.safeParse({
        scope,
        commentThreads: [
          thread({ anchor: { source: 'code', quote: 'x', filePath } }),
        ],
      }).success;
    expect(anchoredAt('src/a.ts')).toBe(true);
    for (const path of [
      'src/../a.ts',
      'src/..\\..\\outside.ts',
      'C:\\repo\\a.ts',
      '/abs/a.ts',
      './a.ts',
    ]) {
      expect(anchoredAt(path)).toBe(false);
    }
    const { result } = CORE_REVIEW_QUERY_DEFINITIONS['core.review.get'];
    const annotated = (filePath: string): boolean =>
      result.safeParse({
        fingerprint: 'fingerprint-1',
        review: {
          ...review,
          annotations: {
            ...review.annotations,
            data: {
              schemaVersion: 1,
              annotations: [
                {
                  id: 'a1',
                  repoId: 'default',
                  filePath,
                  side: 'new',
                  lineStart: 1,
                  lineEnd: 2,
                  kind: 'caution',
                  title: 'Title',
                  body: 'Body',
                },
              ],
            },
          },
        },
      }).success;
    expect(annotated('src/a.ts')).toBe(true);
    expect(annotated('/abs/a.ts')).toBe(false);
  });

  it('replies to and resolves a thread named by id', () => {
    const reply =
      CORE_REVIEW_INSTRUCTION_DEFINITIONS['core.review.comment.reply'].params;
    expect(
      reply.safeParse({ scope, threadId: 'thread-1', body: 'Done.' }).success,
    ).toBe(true);
    expect(
      reply.safeParse({
        scope,
        threadId: 'thread-1',
        body: 'Done.',
        resolve: true,
      }).success,
    ).toBe(true);
    expect(reply.safeParse({ scope, body: 'Done.' }).success).toBe(false);
    const resolve =
      CORE_REVIEW_INSTRUCTION_DEFINITIONS['core.review.comment.resolve'].params;
    expect(
      resolve.safeParse({ scope, threadId: 'thread-1', resolved: false })
        .success,
    ).toBe(true);
    expect(
      resolve.safeParse({
        scope,
        threadId: 'thread-1',
        resolved: true,
        expectedRevision: 1,
      }).success,
    ).toBe(false);
  });

  it('types each refusal with a reason and its code', () => {
    expect(REVIEW_ERROR_CODES).toEqual({
      THREAD_NOT_FOUND: 'core.review.threadNotFound',
      THREAD_NOT_SUBMITTED: 'core.review.threadNotSubmitted',
      STOPPED: 'core.review.stopped',
      MODEL_UNAVAILABLE: 'core.review.modelUnavailable',
      DAMAGED_STATE: 'core.review.damagedState',
    });
    const { error } =
      CORE_REVIEW_INSTRUCTION_DEFINITIONS['core.review.comment.reply'];
    expect(
      error.safeParse({
        kind: 'not_found',
        message: 'Comment thread not found.',
        code: 'core.review.threadNotFound',
        details: { reason: 'THREAD_NOT_FOUND' },
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
    expect(
      error.safeParse({
        kind: 'failed_precondition',
        message: 'Unknown.',
        code: 'core.review.unknown',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });

  it('refuses a write over an unreadable review, while reads stay empty', () => {
    const damaged = {
      kind: 'failed_precondition',
      message: 'The stored review cannot be read.',
      code: 'core.review.damagedState',
      details: { reason: 'DAMAGED_STATE' },
      retry: { kind: 'never' },
    };
    for (const name of INSTRUCTIONS) {
      expect(
        CORE_REVIEW_INSTRUCTION_DEFINITIONS[name].error.safeParse(damaged)
          .success,
      ).toBe(true);
    }
    expect(
      CORE_REVIEW_QUERY_DEFINITIONS['core.review.get'].error.safeParse(damaged)
        .success,
    ).toBe(false);
    expect(
      CORE_REVIEW_STREAM_DEFINITIONS['core.review.events'].error.safeParse(
        damaged,
      ).success,
    ).toBe(false);
  });

  it('streams a review update with a cursor', () => {
    const definition = CORE_REVIEW_STREAM_DEFINITIONS['core.review.events'];
    expect(definition.params.safeParse({ scope }).success).toBe(true);
    expect(definition.params.safeParse({ scope, cursor: null }).success).toBe(
      true,
    );
    expect(
      definition.item.safeParse({
        type: 'review.updated',
        scope,
        fingerprint: 'fingerprint-1',
        review,
        skippedCommentThreads: 1,
      }).success,
    ).toBe(true);
    expect(
      definition.item.safeParse({ type: 'review.removed', scope }).success,
    ).toBe(false);
  });
});
