import type { McpHttpAuthHandler } from '../../../types/mcp-servers';

/*
 * Which Codex workflow steps the daemon serves their plugins' MCP servers to
 * (CAN-6168 part 4b), decided in one place from everything a run could merge.
 *
 * A step's plugins come from up to two sources: its own plugin collection and
 * its model alias (an Agent's selections or the alias's collection). When the
 * step runs, their selections are merged, so a step is judged on the merge:
 * every source it draws on must be one the daemon can serve, and every plugin
 * HTTP server any of them brings must be reached the way Electron main's own
 * owner.mcp.bind reaches it. That bind serves only the canopy handler under a
 * canopy default, so the default must be canopy and no source the step draws
 * on may hand that server to another handler. Electron main holds at most
 * `routesMax` routes per run, so a run whose admitted steps would bind more
 * distinct servers keeps every Codex plugin step in process.
 *
 * Nothing here reads a file, the network or preferences: the caller gathers
 * the facts, so the rule is tested as a table.
 */

/** One plugin HTTP server a source brings, by what the owner binds. */
export interface CodexPluginAdmissionServer {
  /** The server's MCP auth target key (mcpHttpAuthTargetKey). */
  readonly target: string;
  /** Distinct per declaration the run binds a route for. */
  readonly identity: string;
}

/** What one plugin source's selections bring, as the daemon would read them. */
export interface CodexPluginSourceFacts {
  /**
   * The daemon can serve its plugins at all: native Codex plugins that all
   * resolve, no collection left unexpanded, no standalone skill or server,
   * no server turned off, and every server one the daemon serves (stdio
   * without env, HTTP without credential headers from no curated plugin).
   */
  readonly servable: boolean;
  /** The plugin HTTP servers it brings. */
  readonly httpServers: readonly CodexPluginAdmissionServer[];
  /** Its MCP auth overrides: target key and handler, in order. */
  readonly overrides: readonly {
    readonly target: string;
    readonly handler: McpHttpAuthHandler;
  }[];
}

/** A model alias, as the run resolved it. */
export interface CodexPluginAdmissionAlias {
  /** The alias adds plugins to a step. */
  readonly plugins: boolean;
  /** Where its selections come from; absent when the launch can't tell. */
  readonly source?:
    | { readonly kind: 'agent'; readonly facts: CodexPluginSourceFacts }
    | { readonly kind: 'collection'; readonly collectionId: string };
}

export interface CodexPluginAdmissionInput {
  /** The run's plugin collections, by trimmed id. */
  readonly collections: Readonly<Record<string, CodexPluginSourceFacts>>;
  /** The run's model aliases, by id. */
  readonly aliases: Readonly<Record<string, CodexPluginAdmissionAlias>>;
  /** The MCP HTTP auth default; null when the preferences can't be read. */
  readonly defaultHandler: McpHttpAuthHandler | null;
  /** The most routes Electron main binds for one run. */
  readonly routesMax: number;
}

export type CodexPluginAdmissionRefusal =
  | 'unknown_source'
  | 'unservable_source'
  | 'auth_default'
  | 'auth_override'
  | 'route_cap';

export interface CodexPluginAdmission {
  /**
   * Whether the daemon serves a Codex step with this collection and alias
   * (either may be absent) its plugins, or why not.
   */
  decide(
    collectionId: string | undefined,
    aliasId: string | undefined,
  ): 'daemon' | CodexPluginAdmissionRefusal;
  /** Distinct plugin HTTP servers the admitted combinations would bind. */
  readonly routes: number;
  /** The run would bind more than routesMax: no Codex plugin step goes. */
  readonly routeCapExceeded: boolean;
}

const pairKey = (
  collectionId: string | undefined,
  aliasId: string | undefined,
): string => JSON.stringify([collectionId ?? null, aliasId ?? null]);

/** The rule for one combination, before the run-wide route cap. */
function decidePair(
  input: CodexPluginAdmissionInput,
  collectionId: string | undefined,
  aliasId: string | undefined,
):
  | { readonly kind: 'refused'; readonly why: CodexPluginAdmissionRefusal }
  | { readonly kind: 'admitted'; readonly servers: readonly string[] } {
  const sources: CodexPluginSourceFacts[] = [];
  if (collectionId !== undefined) {
    const facts = input.collections[collectionId];
    if (!facts) return { kind: 'refused', why: 'unknown_source' };
    sources.push(facts);
  }
  if (aliasId !== undefined) {
    const alias = input.aliases[aliasId];
    if (!alias) return { kind: 'refused', why: 'unknown_source' };
    const source = alias.source;
    if (source?.kind === 'agent') sources.push(source.facts);
    else if (source?.kind === 'collection') {
      const facts = input.collections[source.collectionId];
      if (!facts) return { kind: 'refused', why: 'unknown_source' };
      sources.push(facts);
    } else if (alias.plugins) return { kind: 'refused', why: 'unknown_source' };
  }
  if (sources.some((facts) => !facts.servable))
    return { kind: 'refused', why: 'unservable_source' };
  const servers = sources.flatMap((facts) => facts.httpServers);
  if (servers.length === 0) return { kind: 'admitted', servers: [] };
  if (input.defaultHandler !== 'canopy')
    return { kind: 'refused', why: 'auth_default' };
  // The merge's overrides, from every source the step draws on: any that
  // hands one of its servers to another handler wins in some merge order.
  const elsewhere = new Set(
    sources.flatMap((facts) =>
      facts.overrides
        .filter((override) => override.handler !== 'canopy')
        .map((override) => override.target),
    ),
  );
  if (servers.some((server) => elsewhere.has(server.target)))
    return { kind: 'refused', why: 'auth_override' };
  return {
    kind: 'admitted',
    servers: servers.map((server) => server.identity),
  };
}

/**
 * Decides every combination of the run's collections and aliases (each
 * possibly absent) at once, so the route cap counts what the run could bind.
 */
export function admitCodexPluginSteps(
  input: CodexPluginAdmissionInput,
): CodexPluginAdmission {
  const collectionIds = [undefined, ...Object.keys(input.collections)];
  const aliasIds = [undefined, ...Object.keys(input.aliases)];
  const decisions = new Map<string, ReturnType<typeof decidePair>>();
  const routes = new Set<string>();
  for (const collectionId of collectionIds)
    for (const aliasId of aliasIds) {
      const decision = decidePair(input, collectionId, aliasId);
      decisions.set(pairKey(collectionId, aliasId), decision);
      if (decision.kind === 'admitted')
        for (const server of decision.servers) routes.add(server);
    }
  const routeCapExceeded = routes.size > input.routesMax;
  return {
    routes: routes.size,
    routeCapExceeded,
    decide(collectionId, aliasId) {
      const decision = decisions.get(pairKey(collectionId, aliasId)) ?? {
        kind: 'refused' as const,
        why: 'unknown_source' as const,
      };
      if (decision.kind === 'refused') return decision.why;
      // A step that brings no plugin server binds nothing, so the cap keeps
      // only steps that would bind one.
      const plugins =
        collectionId !== undefined ||
        (aliasId !== undefined && input.aliases[aliasId]?.plugins === true);
      if (routeCapExceeded && plugins) return 'route_cap';
      return 'daemon';
    },
  };
}
