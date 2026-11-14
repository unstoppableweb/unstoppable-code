import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
} from '..';
import {
  CORE_PLAN_INSTRUCTION_DEFINITIONS,
  CORE_PLAN_QUERY_DEFINITIONS,
  CORE_PLAN_STREAM_DEFINITIONS,
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
      CORE_PLAN_INSTRUCTION_DEFINITIONS['core.plan.delete'].params.safeParse({
        scope,
        planId: 'plan-1',
      }).success,
    ).toBe(true);
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
