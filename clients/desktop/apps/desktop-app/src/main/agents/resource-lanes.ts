import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { classifyResourceOwner } from '@canopy/execution-engine/lib/resource-context';
import type { ResourceContextInput } from '@canopy/execution-engine/lib/resource-context-policy';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  LanePartitioned,
  composeLanePages,
  type LanePagePosition,
  type ResourceLanePage,
  laneKey,
  lanesForContext,
  type ResourceLane,
} from '@canopy/desktop-shared/lib/resource-lanes';
import type {
  ListSharedAgentsRequest,
  SharedAgentSummary,
} from '@canopy/execution-engine/types/agent-models';
import { getFeatureFlagService } from '../feature-flags';
import { getWorkspaceContextService } from '../lib/workspace-context-service';

export function agentResourceContextEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}

/**
 * Whether organization projects are known to be off: a settled verdict
 * (flags ready, or not configured), not the default served while flags load
 * or after a failed start. Organization Agent copies are removed then
 * (CAN-6237, phase 10a), since Agents are no longer kept to their context.
 */
export function agentResourceContextSettledOff(): boolean {
  const snapshot = getFeatureFlagService().getSnapshot();
  return (
    (snapshot.status === 'ready' || snapshot.status === 'not_configured') &&
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] !== true
  );
}

/** Calls `listener` whenever the feature flags change. */
export function onAgentResourceContextFlagChanged(
  listener: () => void,
): () => void {
  return getFeatureFlagService().onSnapshotChanged(listener);
}

export async function agentContextSnapshot(): Promise<string> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  const state = service.getState();
  return JSON.stringify([
    service.accountEpoch(),
    state.revision,
    state.context,
  ]);
}

export async function assertAgentContextSnapshot(
  snapshot: string,
): Promise<void> {
  if (snapshot !== (await agentContextSnapshot()))
    throw new Error('Agent unavailable (context-mismatch)');
}

export async function agentContextAllowed(
  resource: ResourceContextInput['resource'],
): Promise<boolean> {
  if (!agentResourceContextEnabled()) return true;
  // Defer the policy service and its account/observability graph until the flag is enabled.
  const { getResourceContextPolicyService } =
    await import('../services/resource-context-policy-service');
  const decision = await getResourceContextPolicyService().decide({
    resource,
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
  });
  return decision.allow;
}

export async function assertAgentContext(
  resource: ResourceContextInput['resource'],
  projectId?: string,
): Promise<void> {
  if (!agentResourceContextEnabled()) return;
  let target: ResourceContextInput['target'];
  const appSurface =
    (projectId !== undefined && isBotProjectId(projectId)) ||
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    projectId === PIPELINE_EDITOR_PROJECT_ID;
  if (projectId && !appSurface) {
    // Defer the heavy workspace/catalog graph until a project target is checked.
    const { resolveWorkspaceTarget, WorkspaceTargetResolutionError } =
      await import('../services/workspace-target');
    const context = getWorkspaceContextService().getState().context;
    try {
      target = await resolveWorkspaceTarget(projectId, {
        ...(context.kind === 'organization'
          ? { organizationId: context.organizationId }
          : {}),
      });
    } catch (error) {
      if (error instanceof WorkspaceTargetResolutionError)
        throw new Error(`Agent unavailable (${error.reason})`);
      throw error;
    }
  }
  // Defer the policy service and its account/observability graph until the flag is enabled.
  const { getResourceContextPolicyService } =
    await import('../services/resource-context-policy-service');
  const decision = await getResourceContextPolicyService().decide({
    resource,
    ...(target ? { target } : {}),
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
  });
  if (!decision.allow)
    throw new Error(`Agent unavailable (${decision.reason})`);
}

interface Page {
  agents: SharedAgentSummary[];
  nextCursor?: string;
}
interface Cursor {
  snapshot: string;
  query: string;
  lanes: Record<string, LanePagePosition>;
}
const inventories = new Map<string, LanePartitioned<Page>>();
let currentSnapshot: string | undefined;

function decodeCursor(value: string, snapshot: string, query: string): Cursor {
  const parsed: unknown = JSON.parse(
    Buffer.from(value, 'base64url').toString('utf8'),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('snapshot' in parsed) ||
    parsed.snapshot !== snapshot ||
    !('query' in parsed) ||
    parsed.query !== query ||
    !('lanes' in parsed) ||
    typeof parsed.lanes !== 'object' ||
    parsed.lanes === null ||
    Array.isArray(parsed.lanes)
  )
    throw new Error('Agent unavailable (context-mismatch)');
  const lanes: Record<string, LanePagePosition> = {};
  const entries: [string, unknown][] = Object.entries(parsed.lanes);
  for (const [key, cursor] of entries) {
    if (
      typeof cursor !== 'object' ||
      cursor === null ||
      !('cursor' in cursor) ||
      (cursor.cursor !== null && typeof cursor.cursor !== 'string') ||
      !('offset' in cursor) ||
      typeof cursor.offset !== 'number' ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    )
      throw new Error('Invalid agent cursor');
    lanes[key] = { cursor: cursor.cursor, offset: cursor.offset };
  }
  return { snapshot, query, lanes };
}

/** Each lane keeps its own conditional response, cursor and in-flight request. */
export async function listAgentLanes(
  params: ListSharedAgentsRequest,
  fetch: (
    lane: ResourceLane,
    cursor: string | undefined,
    etag: string | null,
  ) => Promise<
    | { status: 'not-modified' }
    | { status: 'fresh'; body: Page; etag: string | null }
  >,
): Promise<Page> {
  const snapshot = await agentContextSnapshot();
  if (snapshot !== currentSnapshot) {
    for (const inventory of Array.from(inventories.values())) inventory.clear();
    inventories.clear();
    currentSnapshot = snapshot;
  }
  const query = JSON.stringify([params.limit, params.query, params.createdBy]);
  const cursor = params.cursor
    ? decodeCursor(params.cursor, snapshot, query)
    : undefined;
  const key = JSON.stringify([query, params.cursor]);
  let inventory = inventories.get(key);
  if (!inventory) {
    if (inventories.size >= 32) {
      for (const previous of Array.from(inventories.values())) previous.clear();
      inventories.clear();
    }
    inventory = new LanePartitioned<Page>();
    inventories.set(key, inventory);
  }
  const partition = inventory;
  const version = {
    account: String(getWorkspaceContextService().accountEpoch()),
    authorization: snapshot,
  };
  const lanes = lanesForContext(
    getWorkspaceContextService().getState().context,
    getWorkspaceContextService().personalOrganizationId?.() ?? null,
  );
  const next: Cursor = { snapshot, query, lanes: {} };
  const pages = await Promise.all(
    lanes.map(async (lane): Promise<ResourceLanePage<SharedAgentSummary>> => {
      const position = cursor?.lanes[laneKey(lane)];
      const laneCursor = position?.cursor;
      if (cursor && position === undefined)
        throw new Error('Invalid agent cursor');
      if (cursor && laneCursor === null) {
        return {
          lane,
          position: { cursor: null, offset: 0 },
          data: [],
          nextCursor: null,
        };
      }
      const state = partition.get(lane, version);
      const page = await partition.run(
        lane,
        version,
        async (): Promise<Page> => {
          const result = await fetch(
            lane,
            laneCursor || undefined,
            state.etag ?? null,
          );
          await assertAgentContextSnapshot(snapshot);
          if (result.status === 'not-modified') {
            if (!state.value) throw new Error('Agent inventory unavailable');
            return state.value;
          }
          state.etag = result.etag ?? undefined;
          state.cursor = result.body.nextCursor ?? null;
          return result.body;
        },
      );
      const allowed = await Promise.all(
        page.agents.map(
          async (row): Promise<boolean> =>
            agentContextAllowed({ owner: row.owner }),
        ),
      );
      const data = page.agents.filter((row, index) => {
        const owner = classifyResourceOwner(row.owner, { strict: false });
        const matchesLane =
          typeof owner === 'object'
            ? lane.kind === 'organization' &&
              owner.organizationId === lane.organizationId
            : lane.kind === 'personal';
        return matchesLane && allowed[index];
      });
      return {
        lane,
        position: position ?? { cursor: '', offset: 0 },
        data,
        nextCursor: page.nextCursor ?? null,
      };
    }),
  );
  await assertAgentContextSnapshot(snapshot);
  const composed = composeLanePages(pages, params.limit ?? 25);
  next.lanes = composed.lanes;
  return {
    agents: Array.from(
      new Map(composed.data.map((row) => [row.id, row])).values(),
    ),
    nextCursor: Object.values(next.lanes).some((value) => value.cursor !== null)
      ? Buffer.from(JSON.stringify(next)).toString('base64url')
      : undefined,
  };
}
