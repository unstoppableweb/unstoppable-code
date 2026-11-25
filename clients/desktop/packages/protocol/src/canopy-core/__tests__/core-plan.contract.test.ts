import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
} from '..';
import {
  CORE_PLAN_INSTRUCTION_DEFINITIONS,
  CORE_PLAN_QUERY_DEFINITIONS,
  CORE_PLAN_STREAM_DEFINITIONS,
  PLAN_DIAGRAM_ERROR_CODES,
  PlanRecordSchema,
  PlanSourceSchema,
} from '../core';

const scope = { projectId: 'project-1', worktreeId: 'task-1' };

const QUERIES = [
  'core.plan.list',
  'core.plan.get',
  'core.plan.detected.list',
] as const;
const INSTRUCTIONS = [
  'core.plan.create',
  'core.plan.update',
  'core.plan.delete',
  'core.plan.import',
  'core.plan.detected.scan',
  'core.plan.detected.update',
  'core.plan.diagram.generate',
] as const;
const STREAMS = ['core.plan.events'] as const;

describe('core.plan contract (CAN-4165)', () => {
  it('retries a keyed write under its key and a read with the same request', () => {
    const unavailable = (kind: string): unknown => ({
      kind: 'unavailable',
      message: 'temporarily unavailable',
      retry: { kind },
    });
    for (const name of INSTRUCTIONS) {
      const { error } = CORE_PLAN_INSTRUCTION_DEFINITIONS[name];
      expect(error.safeParse(unavailable('same_idempotency_key')).success).toBe(
        true,
      );
      expect(error.safeParse(unavailable('same_request')).success).toBe(false);
    }
    for (const name of QUERIES) {
      const { error } = CORE_PLAN_QUERY_DEFINITIONS[name];
      expect(error.safeParse(unavailable('same_request')).success).toBe(true);
    }
  });

  it('reads with core.plan.read and writes with core.plan.write', () => {
    for (const name of QUERIES) {
      expect(CORE_PLAN_QUERY_DEFINITIONS[name].requiredGrants).toEqual([
        'core.plan.read',
      ]);
    }
    for (const name of INSTRUCTIONS) {
      expect(CORE_PLAN_INSTRUCTION_DEFINITIONS[name].requiredGrants).toEqual([
        'core.plan.write',
      ]);
      expect(CORE_PLAN_INSTRUCTION_DEFINITIONS[name].idempotency).toBe('keyed');
    }
    expect(
      CORE_PLAN_STREAM_DEFINITIONS['core.plan.events'].requiredGrants,
    ).toEqual(['core.plan.read']);
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

  it('scopes every operation to a slug project and worktree', () => {
    const { params } = CORE_PLAN_QUERY_DEFINITIONS['core.plan.list'];
    expect(params.safeParse({ scope }).success).toBe(true);
    for (const bad of ['../x', 'A', 'a/b', 'a.b', 'a%2e']) {
      expect(
        params.safeParse({ scope: { ...scope, worktreeId: bad } }).success,
      ).toBe(false);
    }
    expect(
      CORE_PLAN_QUERY_DEFINITIONS['core.plan.get'].params.safeParse({
        scope,
        planId: 'plan-1',
      }).success,
    ).toBe(true);
    expect(
      CORE_PLAN_QUERY_DEFINITIONS['core.plan.detected.list'].params.safeParse({
        scope,
      }).success,
    ).toBe(true);
  });

  it('refuses a create from an unknown source', () => {
    const { params } = CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.create'];
    expect(
      params.safeParse({ scope, source: 'claude', content: '# Plan' }).success,
    ).toBe(true);
    expect(
      params.safeParse({ scope, source: 'manual', content: '# Plan' }).success,
    ).toBe(false);
  });

  // Antigravity chats propose plans with this source; leaving it out of the
  // list refused every Google plan with "Unknown plan source: antigravity".
  it('accepts a create from an Antigravity chat', () => {
    const { params } = CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.create'];
    expect(PlanSourceSchema.safeParse('antigravity').success).toBe(true);
    expect(PlanSourceSchema.safeParse('gemini').success).toBe(false);
    expect(
      params.safeParse({ scope, source: 'antigravity', content: '# Plan' })
        .success,
    ).toBe(true);
  });

  it('makes the revision check optional on an update', () => {
    const { params } = CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.update'];
    expect(
      params.safeParse({ scope, planId: 'plan-1', content: 'x' }).success,
    ).toBe(true);
    expect(
      params.safeParse({
        scope,
        planId: 'plan-1',
        expectedRevision: 2,
        content: 'x',
      }).success,
    ).toBe(true);
    expect(
      params.safeParse({
        scope,
        planId: 'plan-1',
        expectedRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      params.safeParse({
        scope,
        planId: 'plan-1',
        expectedRevision: 2,
        expectedSource: 'opencode',
        reviewStatus: 'approved',
      }).success,
    ).toBe(true);
    expect(
      params.safeParse({
        scope,
        planId: 'plan-1',
        expectedSource: 'manual',
      }).success,
    ).toBe(false);
    expect(
      CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.delete'].params.safeParse({
        scope,
        planId: 'plan-1',
      }).success,
    ).toBe(true);
  });

  it('attributes a write to who started it, and counts the records a list left out', () => {
    for (const name of [
      'core.plan.create',
      'core.plan.update',
      'core.plan.import',
    ] as const) {
      const { params } = CORE_PLAN_INSTRUCTION_DEFINITIONS[name];
      const write = {
        scope,
        ...(name === 'core.plan.create'
          ? { source: 'claude', content: 'x' }
          : name === 'core.plan.import'
            ? { repoId: 'repo-1', path: 'plan.md' }
            : { planId: 'plan-1' }),
      };
      expect(
        params.safeParse({ ...write, initiationSource: 'user' }).success,
      ).toBe(true);
      expect(
        params.safeParse({ ...write, initiationSource: 'someone' }).success,
      ).toBe(false);
    }
    const { result } = CORE_PLAN_QUERY_DEFINITIONS['core.plan.list'];
    expect(result.safeParse({ plans: [] }).success).toBe(true);
    expect(result.safeParse({ plans: [], skipped: 2 }).success).toBe(true);
    expect(result.safeParse({ plans: [], skipped: 0 }).success).toBe(false);
  });

  it('imports only a path that stays inside the worktree on any host', () => {
    const { params } = CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.import'];
    const importing = (path: string): boolean =>
      params.safeParse({ scope, repoId: 'repo-1', path }).success;
    expect(importing('docs/plan.md')).toBe(true);
    expect(importing('plan.md')).toBe(true);
    for (const path of [
      'docs/../plan.md',
      'docs/..\\..\\outside.md',
      'C:\\repo\\plan.md',
      'C:plan.md',
      '/abs/plan.md',
      './plan.md',
    ]) {
      expect(importing(path)).toBe(false);
    }
  });

  it('scans and updates detected plans in their own operations', () => {
    expect(
      CORE_PLAN_INSTRUCTION_DEFINITIONS[
        'core.plan.detected.scan'
      ].params.safeParse({
        scope,
        chatId: 'chat-1',
        candidatePaths: ['docs/plan.md'],
      }).success,
    ).toBe(true);
    const { params } =
      CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.detected.update'];
    expect(
      params.safeParse({
        scope,
        entryId: 'entry-1',
        status: 'dismissed',
      }).success,
    ).toBe(true);
    expect(
      params.safeParse({ scope, entryId: 'entry-1', status: 'gone' }).success,
    ).toBe(false);
  });

  // CAN-4167 PR 3a: spec-first, so nothing serves it yet.
  it('requests diagrams for a plan and answers only whether a generation started', () => {
    const { params, result, error } =
      CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.diagram.generate'];
    expect(params.safeParse({ scope, planId: 'plan-1' }).success).toBe(true);
    expect(
      params.safeParse({
        scope,
        planId: 'plan-1',
        expectedRevision: 3,
        kinds: ['sequence', 'logicDiff', 'dataModelDiff'],
        initiationSource: 'user',
      }).success,
    ).toBe(true);
    for (const bad of [
      { scope, planId: 'plan-1', expectedRevision: 0 },
      { scope, planId: 'plan-1', kinds: [] },
      { scope, planId: 'plan-1', kinds: ['flowchart'] },
      { scope, planId: 'plan-1', formats: ['svg'] },
      { scope, planId: 'plan-1', userInitiated: true },
      { planId: 'plan-1' },
    ]) {
      expect(params.safeParse(bad).success).toBe(false);
    }
    expect(result.safeParse({ status: 'started', revision: 2 }).success).toBe(
      true,
    );
    expect(result.safeParse({ status: 'queued', revision: 2 }).success).toBe(
      true,
    );
    expect(result.safeParse({ status: 'missing' }).success).toBe(true);
    expect(result.safeParse({ status: 'ready' }).success).toBe(false);
    const modelUnavailable = {
      kind: 'failed_precondition',
      message: 'No harness serves the diagram model.',
      code: PLAN_DIAGRAM_ERROR_CODES.DIAGRAM_MODEL_UNAVAILABLE,
      details: { reason: 'DIAGRAM_MODEL_UNAVAILABLE' },
      retry: { kind: 'never' },
    };
    expect(error.safeParse(modelUnavailable).success).toBe(true);
    expect(
      CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.update'].error.safeParse(
        modelUnavailable,
      ).success,
    ).toBe(false);
  });

  // Typing the diagrams must hide no plan the desktop store reads today.
  it('reads every stored diagram artifact the desktop store accepts', () => {
    const stored = {
      id: 'plan-1',
      ...scope,
      source: 'claude',
      title: 'Plan',
      content: '# Plan',
      reviewStatus: 'pending',
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      latestRevisionNumber: 2,
      revisions: [],
      linkedExecutionIds: [],
    };
    const graph = { schemaVersion: 1, nodes: [], edges: [] };
    const flow = { nodes: [], edges: [] };
    const diff = {
      schemaVersion: 1,
      current: flow,
      planned: flow,
      changes: [],
    };
    for (const diagrams of [
      {},
      {
        sequence: {
          data: graph,
          derivedFromRevision: 2,
          status: 'ready',
          generatedAt: '2026-11-20T00:00:00.000Z',
        },
        logicDiff: { data: null, derivedFromRevision: 2, status: 'generating' },
        dataModelDiff: {
          data: diff,
          derivedFromRevision: 1,
          status: 'stale',
          generatedAt: '2026-11-19T00:00:00.000Z',
        },
      },
      {
        sequence: {
          data: graph,
          derivedFromRevision: 2,
          status: 'error',
          error: 'Diagram generation returned no graph',
        },
        logicDiff: { data: diff, derivedFromRevision: 2, status: 'pending' },
      },
      // The store never checks generatedAt or error.
      {
        sequence: {
          data: graph,
          derivedFromRevision: 2,
          status: 'ready',
          generatedAt: null,
          error: null,
        },
        logicDiff: {
          data: null,
          derivedFromRevision: 2,
          status: 'error',
          generatedAt: 1763605200000,
          error: { message: 'Diagram generation returned no graph' },
        },
      },
      // The store reads any data and keeps fields it does not know.
      {
        sequence: {
          data: { schemaVersion: 2, shape: 'future' },
          derivedFromRevision: 2,
          status: 'ready',
          renderHint: 'compact',
        },
        futureKind: { data: null, derivedFromRevision: 1, status: 'ready' },
      },
    ]) {
      expect(PlanRecordSchema.safeParse({ ...stored, diagrams }).success).toBe(
        true,
      );
    }
    expect(
      PlanRecordSchema.safeParse({
        ...stored,
        diagrams: {
          sequence: { data: null, derivedFromRevision: 2, status: 'drawn' },
        },
      }).success,
    ).toBe(false);
  });

  it('streams upserts, removals and detected changes with a cursor', () => {
    const definition = CORE_PLAN_STREAM_DEFINITIONS['core.plan.events'];
    expect(definition.params.safeParse({ scope }).success).toBe(true);
    expect(definition.params.safeParse({ scope, cursor: null }).success).toBe(
      true,
    );
    expect(
      definition.item.safeParse({
        type: 'plan.removed',
        scope,
        planId: 'plan-1',
      }).success,
    ).toBe(true);
    expect(
      definition.item.safeParse({
        type: 'detected.changed',
        scope,
        detected: [],
      }).success,
    ).toBe(true);
    expect(
      definition.item.safeParse({ type: 'plan.moved', scope }).success,
    ).toBe(false);
  });
});
