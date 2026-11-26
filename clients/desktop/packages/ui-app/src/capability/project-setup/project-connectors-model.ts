import type {
  CapabilitySetupConnectorItem,
  CapabilitySetupConnectorRef,
  CatalogProjectConnectorSetup,
  OrganizationConnection,
  SharedConnectionTool,
  StoredProjectConnectorSetup,
} from '@canopy/protocol/canopy-core';
import {
  projectSetupCurrentWrite,
  type ProjectSetupRowSource,
  type ProjectSetupState,
  type ProjectSetupWrite,
} from './project-setup-model';

// The Connectors section of an organization project's shared setup
// (CAN-6246, CAN-6248; spec FR-4.1–4.3): the organization's connections the
// project inherits or adds, each with the project's tool limit. Kept apart
// from the item sections because connections are written in a field of their
// own (`connectors`): the item writes leave it out, so they never change the
// stored connections, and a connector write sends the whole of it.

/** One connection row of the Connectors section. */
export interface ProjectConnectorRow {
  readonly key: string;
  /** Stable and DOM-safe, for test ids. */
  readonly testKey: string;
  readonly ref: CapabilitySetupConnectorRef;
  readonly name: string;
  /** False when the connection was deleted or is no longer the organization's. */
  readonly available: boolean;
  readonly status: CapabilitySetupConnectorItem['status'];
  readonly source: ProjectSetupRowSource;
  /**
   * For an organization default, whether this project keeps it on; a project
   * addition is always on.
   */
  readonly on: boolean;
  /** The project's tool limit, or null for every tool the connection allows. */
  readonly limit: readonly string[] | null;
}

/** How a project limits one connection's tools. */
export type ConnectorLimitChoice = 'all' | 'readOnly' | 'chosen';

/** A project in "Also in", as the Connectors page lists it. */
export interface ConnectorOtherProject {
  readonly id: string;
  readonly name: string;
}

function connectorKey(ref: CapabilitySetupConnectorRef): string {
  return `connector:${ref.id}`;
}

function connectorTestKey(ref: CapabilitySetupConnectorRef): string {
  return `connector-${ref.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/**
 * A connection that left the organization comes back with no name of its
 * own, only its id, which means nothing to a person.
 */
function connectorName(item: CapabilitySetupConnectorItem): string {
  if (item.available || (item.name !== '' && item.name !== item.ref.id))
    return item.name;
  return 'Removed connection';
}

function limitOf(
  limits: CatalogProjectConnectorSetup['limits'],
  ref: CapabilitySetupConnectorRef,
): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(limits, ref.id)
    ? (limits[ref.id] ?? null)
    : null;
}

function connectorRow(
  connectors: CatalogProjectConnectorSetup,
  item: CapabilitySetupConnectorItem,
  source: ProjectSetupRowSource,
  on: boolean,
): ProjectConnectorRow {
  return {
    key: connectorKey(item.ref),
    testKey: connectorTestKey(item.ref),
    ref: item.ref,
    name: connectorName(item),
    available: item.available,
    status: item.status,
    source,
    on,
    limit: limitOf(connectors.limits, item.ref),
  };
}

/**
 * The section's rows, by the rule of the item sections: the organization's
 * default connections in their order, each on unless the project switched it
 * off, then the project's own additions. A connection the project added is
 * the project's even while it is also a default.
 */
export function projectConnectorRows(
  connectors: CatalogProjectConnectorSetup,
): ProjectConnectorRow[] {
  const added = new Set(connectors.added.map((item) => item.ref.id));
  const removed = new Set(connectors.removed.map((ref) => ref.id));
  const seen = new Set<string>();
  const rows: ProjectConnectorRow[] = [];
  for (const item of connectors.organizationDefaults) {
    const id = item.ref.id;
    if (added.has(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push(connectorRow(connectors, item, 'organization', !removed.has(id)));
  }
  for (const item of connectors.added) {
    if (seen.has(item.ref.id)) continue;
    seen.add(item.ref.id);
    rows.push(connectorRow(connectors, item, 'project', true));
  }
  return rows;
}

/**
 * The organization's connections an editor can add to this project:
 * available, and neither a default nor already added.
 */
export function projectConnectorCandidates(
  connectors: CatalogProjectConnectorSetup,
): CapabilitySetupConnectorItem[] {
  const taken = new Set(
    [...connectors.organizationDefaults, ...connectors.added].map(
      (item) => item.ref.id,
    ),
  );
  const seen = new Set<string>();
  return connectors.candidates.filter((item) => {
    if (!item.available || taken.has(item.ref.id) || seen.has(item.ref.id))
      return false;
    seen.add(item.ref.id);
    return true;
  });
}

// --- Tool limits ------------------------------------------------------------

/** The tools the server marks as changing nothing, in the server's order. */
export function connectorReadOnlyTools(
  tools: readonly SharedConnectionTool[],
): string[] {
  return tools
    .filter((tool) => tool.readOnly === true)
    .map((tool) => tool.name);
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((name) => b.has(name));
}

/**
 * Which choice a stored limit is. "Read only" needs the connection's tools to
 * tell it from a hand-picked list, so without them a limit reads as chosen.
 */
export function connectorLimitChoiceOf(
  limit: readonly string[] | null,
  tools: readonly SharedConnectionTool[] | null,
): ConnectorLimitChoice {
  if (limit === null) return 'all';
  if (tools !== null) {
    const readOnly = connectorReadOnlyTools(tools);
    if (readOnly.length > 0 && sameNames(limit, readOnly)) return 'readOnly';
  }
  return 'chosen';
}

/** A row's limit in a few words: `All tools`, `Read only`, `3 tools`. */
export function connectorLimitSummary(
  limit: readonly string[] | null,
  tools: readonly SharedConnectionTool[] | null,
): string {
  const choice = connectorLimitChoiceOf(limit, tools);
  if (choice === 'all' || limit === null) return 'All tools';
  if (choice === 'readOnly') return 'Read only';
  const count = new Set(limit).size;
  if (count === 0) return 'No tools';
  return count === 1 ? '1 tool' : `${count} tools`;
}

/**
 * The limit a choice saves: none for every tool, the read-only tools, or the
 * chosen ones in the server's order (then any chosen name it no longer
 * lists). An empty choice allows no tools.
 */
export function connectorLimitFor(
  choice: ConnectorLimitChoice,
  chosen: ReadonlySet<string>,
  tools: readonly SharedConnectionTool[],
): string[] | null {
  if (choice === 'all') return null;
  if (choice === 'readOnly') return connectorReadOnlyTools(tools);
  const listed = tools.map((tool) => tool.name);
  const listedSet = new Set(listed);
  return [
    ...listed.filter((name) => chosen.has(name)),
    ...[...chosen].filter((name) => !listedSet.has(name)),
  ];
}

/**
 * The tools the editor lists: the server's, then any name the stored limit
 * keeps that the server no longer offers (or every stored name while the
 * server's list is unknown), so each one can still be unticked.
 */
export function connectorToolOptions(
  tools: readonly SharedConnectionTool[] | null,
  limit: readonly string[] | null,
): SharedConnectionTool[] {
  const listed = tools ?? [];
  const names = new Set(listed.map((tool) => tool.name));
  const kept: SharedConnectionTool[] = [];
  for (const name of limit ?? []) {
    if (names.has(name)) continue;
    names.add(name);
    kept.push({ name });
  }
  return [...listed, ...kept];
}

// --- Writes -----------------------------------------------------------------

function uniqueRefs(
  refs: readonly CapabilitySetupConnectorRef[],
): CapabilitySetupConnectorRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

function withoutRef(
  refs: readonly CapabilitySetupConnectorRef[],
  ref: CapabilitySetupConnectorRef,
): CapabilitySetupConnectorRef[] {
  return refs.filter((candidate) => candidate.id !== ref.id);
}

/**
 * Keeps only limits on connections the project uses after the write: the
 * service refuses a limit on any other, which would block every save.
 */
function withUsedLimits(
  connectors: CatalogProjectConnectorSetup,
  setup: StoredProjectConnectorSetup,
): StoredProjectConnectorSetup {
  const removed = new Set(setup.removed.map((ref) => ref.id));
  const inUse = new Set([
    ...connectors.organizationDefaults
      .map((item) => item.ref.id)
      .filter((id) => !removed.has(id)),
    ...setup.added.map((ref) => ref.id),
  ]);
  const limits: Record<string, string[]> = {};
  for (const [id, tools] of Object.entries(setup.limits)) {
    if (inUse.has(id)) limits[id] = [...new Set(tools)];
  }
  return { ...setup, limits };
}

/**
 * The project's connections as they stand, ready to save: the additions
 * still available (the service refuses one that is gone), every switched-off
 * default, and the limits.
 */
function currentConnectorWrite(
  connectors: CatalogProjectConnectorSetup,
): StoredProjectConnectorSetup {
  const limits: Record<string, string[]> = {};
  for (const [id, tools] of Object.entries(connectors.limits))
    limits[id] = [...tools];
  return {
    added: uniqueRefs(
      connectors.added.filter((item) => item.available).map((item) => item.ref),
    ),
    removed: uniqueRefs(connectors.removed),
    limits,
  };
}

/**
 * The whole write for a connector change: the other items exactly as they
 * stand, and the connections changed by `change`. Without connectors (an
 * older server) the write leaves them out, so it changes nothing of theirs.
 */
function withConnectorsChanged(
  state: ProjectSetupState,
  change: (current: StoredProjectConnectorSetup) => StoredProjectConnectorSetup,
): ProjectSetupWrite {
  const write = projectSetupCurrentWrite(state);
  const connectors = state.connectors;
  if (connectors === undefined) return write;
  return {
    ...write,
    connectors: withUsedLimits(
      connectors,
      change(currentConnectorWrite(connectors)),
    ),
  };
}

/** Keeps an organization default connection on in this project, or switches it off. */
export function withConnectorDefaultSwitched(
  state: ProjectSetupState,
  ref: CapabilitySetupConnectorRef,
  on: boolean,
): ProjectSetupWrite {
  return withConnectorsChanged(state, (current) => {
    const removed = withoutRef(current.removed, ref);
    return { ...current, removed: on ? removed : [...removed, ref] };
  });
}

/** Adds one of the organization's connections to this project. */
export function withConnectorAdded(
  state: ProjectSetupState,
  ref: CapabilitySetupConnectorRef,
): ProjectSetupWrite {
  return withConnectorsChanged(state, (current) => ({
    ...current,
    added: [...withoutRef(current.added, ref), ref],
  }));
}

/**
 * Takes a connection the project added out of it. When it is also an
 * organization default, that default is switched off too, so the project
 * stops using it rather than inheriting it again.
 */
export function withConnectorRemoved(
  state: ProjectSetupState,
  ref: CapabilitySetupConnectorRef,
): ProjectSetupWrite {
  const isDefault = (state.connectors?.organizationDefaults ?? []).some(
    (item) => item.ref.id === ref.id,
  );
  return withConnectorsChanged(state, (current) => ({
    ...current,
    added: withoutRef(current.added, ref),
    removed: isDefault
      ? [...withoutRef(current.removed, ref), ref]
      : current.removed,
  }));
}

/** Sets the project's tool limit on a connection; null removes it. */
export function withConnectorLimit(
  state: ProjectSetupState,
  ref: CapabilitySetupConnectorRef,
  limit: readonly string[] | null,
): ProjectSetupWrite {
  return withConnectorsChanged(state, (current) => {
    const limits: Record<string, string[]> = {};
    for (const [id, tools] of Object.entries(current.limits))
      if (id !== ref.id) limits[id] = tools;
    if (limit !== null) limits[ref.id] = [...new Set(limit)];
    return { ...current, limits };
  });
}

// --- Also in ----------------------------------------------------------------

/**
 * The other projects that use each connection, from the organization's
 * Connectors list, by connection id. This project is left out.
 */
export function connectorOtherProjects(
  connections: readonly Pick<OrganizationConnection, 'id' | 'projects'>[],
  projectId: string,
): ReadonlyMap<string, readonly ConnectorOtherProject[]> {
  const byId = new Map<string, readonly ConnectorOtherProject[]>();
  for (const connection of connections) {
    byId.set(
      connection.id,
      connection.projects
        .filter((project) => project.id !== projectId)
        .map((project) => ({ id: project.id, name: project.name })),
    );
  }
  return byId;
}
