import type { McpServer } from '@agentclientprotocol/sdk';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  EFFECTIVE_CAPABILITY_SNAPSHOT_VERSION,
  saveEffectiveCapabilitySnapshot,
  type EffectiveCapabilityBinding,
  type EffectiveCapabilityGrants,
  type EffectiveCapabilityMcpServer,
  type EffectiveCapabilitySnapshot,
} from '@canopy/desktop-shared/node/capabilities/effective-snapshot';
import { readOpenCodeMcpSnapshot } from '@canopy/desktop-shared/node/opencode/mcp-snapshot';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { ANTIGRAVITY_RUNTIME_VERSION } from '@canopy/desktop-shared/node/antigravity/runtime-metadata';
import type { AntigravityExtensionSnapshot } from './extensions';
import { antigravityProfileDirectory } from './runtime';

/** The chat budget: a chat never waits on evidence. Workflow steps pass a longer one and do wait. */
const DISCOVERY_BUDGET_MS = 10_000;
const BUDGET_REASON = 'Not read within the evidence budget.';
const UNREADABLE_REASON = 'The tool list could not be read.';

/**
 * Tool lists of selected servers, reused within one session while the server
 * identity is unchanged, so each turn neither starts another stdio copy nor
 * calls an upstream tools/list again. A server that changes its tools without
 * changing identity keeps its first list for the rest of the session.
 */
export type AntigravityToolListCache = Map<string, readonly Tool[]>;

/** Reads one server's tool catalog; a failure leaves it recorded, not dropped. */
async function discover(
  server: McpServer,
  role: EffectiveCapabilityMcpServer['role'],
  identity: string,
  signal: AbortSignal,
  budget: AbortSignal,
  cache: AntigravityToolListCache | undefined,
): Promise<EffectiveCapabilityMcpServer> {
  const transport = 'command' in server ? 'stdio' : 'http';
  const cacheKey = role === 'selected' ? identity : undefined;
  const cached = cacheKey ? cache?.get(cacheKey) : undefined;
  if (cached)
    return { name: server.name, role, transport, identity, tools: [...cached] };
  try {
    const [entry] = await readOpenCodeMcpSnapshot(
      [server],
      { [server.name]: identity },
      budget,
      // Selected stdio servers already run through this turn's broker route;
      // listing never calls a tool, so the route's call gate is not reached.
      (stdio) => Promise.resolve(stdio),
      'Antigravity',
    );
    const tools = entry ? [...entry.tools] : [];
    if (cacheKey) cache?.set(cacheKey, tools);
    return { name: server.name, role, transport, identity, tools };
  } catch (error) {
    signal.throwIfAborted();
    // The detail can name a route, token or command line: log it, never save it.
    if (!budget.aborted)
      logMainProcessWarn('[antigravity-snapshot] Tool list unreadable', {
        server: server.name,
        error,
      });
    return {
      name: server.name,
      role,
      transport,
      identity,
      tools: null,
      unavailable: budget.aborted ? BUDGET_REASON : UNREADABLE_REASON,
    };
  }
}

/**
 * The turn's effective capabilities: the app route's and each selected
 * server's listed tools, the delivered content and the selection layers.
 * A chat runs it beside the native turn and never waits on it before sending
 * the prompt. A workflow step waits on it before Google opens and passes a
 * longer budget, still bounded by the step's own deadline.
 */
export async function captureAntigravityCapabilitySnapshot(input: {
  appServers: readonly McpServer[];
  extensions: AntigravityExtensionSnapshot;
  grants: EffectiveCapabilityGrants;
  signal: AbortSignal;
  /** Ends discovery early: what has not finished is recorded as unavailable. */
  stop?: AbortSignal;
  toolLists?: AntigravityToolListCache;
  /** Defaults to the chat budget. */
  budgetMs?: number;
}): Promise<EffectiveCapabilitySnapshot> {
  const budget = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.budgetMs ?? DISCOVERY_BUDGET_MS),
    ...(input.stop ? [input.stop] : []),
  ]);
  const [files, mcp] = await Promise.all([
    input.extensions.files(budget).then(
      (files): { files: Record<string, string> } | { reason: string } => ({
        files,
      }),
      (error: unknown) => {
        input.signal.throwIfAborted();
        if (budget.aborted) return { reason: BUDGET_REASON };
        logMainProcessWarn('[antigravity-snapshot] Files unreadable', error);
        return { reason: 'The delivered files could not be read.' };
      },
    ),
    Promise.all([
      ...input.appServers.map((server) =>
        discover(
          server,
          'app',
          `app:${input.grants.toolSurface}:${server.name}`,
          input.signal,
          budget,
          undefined,
        ),
      ),
      ...input.extensions.selectedMcp.map((entry) =>
        discover(
          entry.server,
          'selected',
          entry.identity,
          input.signal,
          budget,
          input.toolLists,
        ),
      ),
    ]),
  ]);
  // Record what the route actually listed, not what its allowlist permits.
  const app = mcp.filter((server) => server.role === 'app');
  const listed =
    app.length > 0 && app.every((server) => server.tools !== null)
      ? app.flatMap((server) =>
          (server.tools ?? []).flatMap((tool) =>
            Object.values(CANOPY_INJECTED_TOOL_REGISTRY)
              .filter((entry) => entry.displayName === tool.name)
              .map((entry) => entry.canonicalKey),
          ),
        )
      : undefined;
  return {
    version: EFFECTIVE_CAPABILITY_SNAPSHOT_VERSION,
    harness: 'antigravity',
    runtimeVersion: ANTIGRAVITY_RUNTIME_VERSION,
    selections: input.extensions.selections,
    grants: listed
      ? { ...input.grants, appTools: [...new Set(listed)].sort() }
      : input.grants,
    content: {
      ...input.extensions.content,
      files: 'files' in files ? files.files : {},
    },
    mcp,
    omitted: [
      ...input.extensions.omitted,
      ...('reason' in files
        ? [{ subject: 'delivered file digests', reason: files.reason }]
        : []),
    ],
    complete: 'files' in files && mcp.every((server) => server.tools !== null),
  };
}

/** Bind the snapshot to the native conversation in the private profile. */
export function saveAntigravityCapabilitySnapshot(
  nativeSessionId: string,
  snapshot: EffectiveCapabilitySnapshot,
  signal: AbortSignal,
): Promise<EffectiveCapabilityBinding> {
  return saveEffectiveCapabilitySnapshot(
    antigravityProfileDirectory(),
    nativeSessionId,
    snapshot,
    signal,
  );
}
