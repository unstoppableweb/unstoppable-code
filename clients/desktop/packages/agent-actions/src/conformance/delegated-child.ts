import {
  agentActionCallEffect,
  agentActionEffect,
  delegatedChildAllows,
  type DelegatedChildGrant,
} from '../delegated-child';
import type { AgentActionSurface } from '../surface/engine';
import type { AgentActionCall } from '../surface/family';
import { AGENT_ACTION_TOOL_KEYS, type AgentActionToolKey } from '../tool-keys';
import type { AgentActionToolResult } from '../tools/definition';
import { at, check, checkEqual } from './assert';
import type {
  AgentConformanceCallIdentity,
  AgentConformanceTestApi,
} from './suite';
import { loadConformanceWorld, type ConformanceWorld } from './world';

/**
 * A host that serves managed delegation children a restricted surface
 * (CAN-6302). Both surfaces are built through the host's real path over the
 * same backend, so the suite can see that a refused call wrote nothing.
 */
export interface DelegatedChildConformanceHost<H> {
  /** The surface a root chat of the world's current chat gets. */
  root: AgentActionSurface<H>;
  /** The surface a delegated child with this grant gets. */
  child(grant: DelegatedChildGrant): AgentActionSurface<H>;
  call(identity: AgentConformanceCallIdentity): AgentActionCall<H>;
  /** Every write the backend accepted so far: chats, posts, forks, stops. */
  writeCount(): number;
}

export type MakeDelegatedChildConformanceHost<H> = (
  world: ConformanceWorld,
) =>
  | DelegatedChildConformanceHost<H>
  | Promise<DelegatedChildConformanceHost<H>>;

const GRANTS: readonly [string, DelegatedChildGrant][] = [
  ['read-only', { writeGrant: 'read_only', nestedAllowed: false }],
  ['full-write', { writeGrant: 'full', nestedAllowed: false }],
];

/** An action type no family classifies, as a newly added one would be. */
const UNCLASSIFIED_TYPE = 'conformance.unclassified';

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

function errorCode(result: AgentActionToolResult): unknown {
  return at(parseJson(result.text), 'error', 'code');
}

/** The action types a surface's DispatchAction schema advertises. */
function advertisedTypes<H>(surface: AgentActionSurface<H>): string[] {
  const dispatch = surface
    .toolDefinitions()
    .find((definition) => definition.key === 'dispatch_action');
  const types = at(
    dispatch?.inputSchema,
    'properties',
    'action',
    'properties',
    'type',
    'enum',
  );
  return Array.isArray(types)
    ? types.filter((type): type is string => typeof type === 'string')
    : [];
}

function toolKeys<H>(surface: AgentActionSurface<H>): AgentActionToolKey[] {
  return surface.toolDefinitions().map((definition) => definition.key);
}

/** Arguments that reach a tool past its schema, for the tools that need them. */
function argsFor(key: AgentActionToolKey): unknown {
  switch (key) {
    case 'start_forked_agent':
    case 'start_branched_agent':
      return { followUpInstruction: 'Continue the task.' };
    case 'setup_watchers':
      return { watchers: [{ target: { chatId: 'c2' } }] };
    case 'delete_watchers':
      return { watcherIds: ['watcher-1'] };
    case 'get_github_pull_request_status':
      return { pullRequest: 'octo/repo#1' };
    case 'schedule_wakeup':
      return { delaySeconds: 60 };
    case 'save_memory':
      return { text: 'Prefers short answers.', scope: 'user' };
    case 'search_memory':
      return { query: 'short answers' };
    case 'read_memory':
      return { scope: 'user', file: 'MEMORY.md' };
    case 'delegate_task':
      return { model: 'M1', description: 'Review', prompt: 'Review it.' };
    case 'get_delegate_output':
    case 'inspect_delegate':
    case 'stop_delegate':
      return { delegationId: 'delegation-1' };
    case 'list_delegates':
      return {};
    case 'message_delegate':
      return {
        delegationId: 'delegation-1',
        operation: 'follow_up',
        message: 'Continue.',
      };
    case 'request_steering':
      return { message: 'Should I continue?' };
    case 'add_ledger_entry':
      return { type: 'TASK', title: 'Delegated work', content: 'Details.' };
    case 'update_ledger_entry':
      return {
        entryId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 1,
        status: 'COMPLETED',
      };
    case 'search_ledger_entries':
    case 'search_actions':
    case 'search_watchers':
    case 'dispatch_action':
      return {};
  }
}

/**
 * The delegated child conformance suite: every action and tool a host offers
 * is classified, and a child gets exactly what its grant allows. Refused
 * calls answer `policy_blocked` and write nothing, an unclassified action is
 * refused, and the child's tool list and DispatchAction schema leave out
 * what it may not run.
 */
export function runDelegatedChildConformance<H>(
  t: AgentConformanceTestApi,
  makeHost: MakeDelegatedChildConformanceHost<H>,
): void {
  const world = loadConformanceWorld();
  let calls = 0;
  const identity = (): AgentConformanceCallIdentity => {
    calls += 1;
    return {
      actorKey: 'conformance-actor',
      turnKey: 'delegated-child-turn',
      toolUseId: `delegated-child-tool-${String(calls)}`,
    };
  };

  t.describe('delegated child surface', () => {
    t.it('classifies every action and tool the host offers', async () => {
      const host = await makeHost(world);
      const unclassified = advertisedTypes(host.root).filter(
        (type) => agentActionEffect(type) === undefined,
      );
      checkEqual(unclassified, [], 'offered action types with no effect');
      for (const key of toolKeys(host.root)) {
        check(
          key === 'dispatch_action' ||
            agentActionCallEffect(key, {}) !== undefined,
          `${key} has no effect`,
        );
      }
    });

    for (const [label, grant] of GRANTS) {
      t.it(`lists only what a ${label} child may run`, async () => {
        const host = await makeHost(world);
        const allowedTypes = advertisedTypes(host.root).filter((type) =>
          delegatedChildAllows(agentActionEffect(type), grant),
        );
        const child = host.child(grant);
        checkEqual(
          advertisedTypes(child),
          allowedTypes,
          `${label} child DispatchAction types`,
        );
        const allowedTools = toolKeys(host.root).filter(
          (key) =>
            key === 'dispatch_action' ||
            delegatedChildAllows(agentActionCallEffect(key, {}), grant),
        );
        // RequestSteering is a delegate's own tool, which no root has.
        checkEqual(
          toolKeys(child).filter((key) => key !== 'request_steering'),
          allowedTools,
          `${label} child tools`,
        );
        if (toolKeys(host.root).includes('delegate_task'))
          check(
            toolKeys(child).includes('request_steering'),
            `${label} child of a chat that may delegate can ask for steering`,
          );
        const search = parseJson(
          (
            await child.execute(
              'search_actions',
              { limit: 50 },
              host.call(identity()),
            )
          ).text,
        );
        const listed = at(search, 'actions');
        const listedTypes = Array.isArray(listed)
          ? listed.map((action) => at(action, 'type'))
          : [];
        check(
          listedTypes.every(
            (type) => typeof type === 'string' && allowedTypes.includes(type),
          ),
          `${label} child SearchActions lists only allowed actions: ${listedTypes.join(', ')}`,
        );
      });

      t.it(
        `refuses a ${label} child what its grant doesn't allow, writing nothing`,
        async () => {
          const host = await makeHost(world);
          const child = host.child(grant);
          const before = host.writeCount();
          const refusedTypes = [
            ...advertisedTypes(host.root).filter(
              (type) => !delegatedChildAllows(agentActionEffect(type), grant),
            ),
            UNCLASSIFIED_TYPE,
          ];
          for (const type of refusedTypes) {
            const result = await child.execute(
              'dispatch_action',
              { action: { type, chatId: 'c2', message: 'Hello' } },
              host.call(identity()),
            );
            check(result.isError === true, `${label} child ${type} is refused`);
            checkEqual(
              errorCode(result),
              'policy_blocked',
              `${label} child ${type} error code`,
            );
          }
          const refusedTools = AGENT_ACTION_TOOL_KEYS.filter(
            (key) =>
              key !== 'dispatch_action' &&
              !delegatedChildAllows(agentActionCallEffect(key, {}), grant),
          );
          for (const key of refusedTools) {
            const result = await child.execute(
              key,
              argsFor(key),
              host.call(identity()),
            );
            checkEqual(
              errorCode(result),
              'policy_blocked',
              `${label} child ${key} error code`,
            );
          }
          checkEqual(
            host.writeCount(),
            before,
            `${label} child writes after refused calls`,
          );
        },
      );

      t.it(`lets a ${label} child read`, async () => {
        const host = await makeHost(world);
        const child = host.child(grant);
        for (const type of ['workspace.get', 'chat.list']) {
          if (!advertisedTypes(host.root).includes(type)) continue;
          const call = host.call(identity());
          const result = await child.execute(
            'dispatch_action',
            { action: { type } },
            call,
          );
          checkEqual(
            parseJson(result.text),
            parseJson(
              (
                await host.root.execute(
                  'dispatch_action',
                  { action: { type } },
                  call,
                )
              ).text,
            ),
            `${label} child ${type} reads what the root reads`,
          );
        }
      });
    }
  });
}
