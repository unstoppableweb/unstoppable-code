import { access, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  capabilitySetupItemKey,
  type CatalogProjectSetupGetResult,
  type CatalogProjectSetupItem,
} from '@canopy/protocol/canopy-core';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { ConnectorScope } from '@canopy/desktop-shared/lib/connector-scope';
import {
  organizationCapabilityScopeKey,
  organizationLayerItems,
  organizationLayerSelections,
  type AllowedOrganizationItems,
  type OrganizationLayerItem,
  type InstalledOrganizationItem,
  type OrganizationCapabilityScope,
  type OrganizationCapabilitySnapshot,
} from '@canopy/desktop-shared/lib/organization-capabilities';
import { importSharedMarketplacePlugin } from '@canopy/desktop-shared/lib/shared-import/shared-plugin-marketplace-import';
import { writeFileAtomically } from '../lib/atomic-file';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getOrganizationCapabilitiesCachePath } from '../lib/paths';
import { readOrganizationPlugin, readOrganizationSkill } from './detail-reads';
import { getSkillDir, getSourceDir } from '../skills/paths';
import {
  bumpProjectPluginDefaultsRevision,
  pluginDefaultsWorkspaceId,
} from '../plugins/plugin-defaults-revision';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import {
  heldAgentIds,
  installOrganizationItem,
  organizationCreatedAgentIds,
  ownedByOrganization,
  pruneOrganizationSkills,
  type OrganizationInstallDeps,
} from './install';
import {
  agentResourceContextEnabled,
  agentResourceContextSettledOff,
  onAgentResourceContextFlagChanged,
} from '../agents/resource-lanes';
import {
  createWebCoreOrganizationCapabilityCalls,
  type OrganizationCapabilityCalls,
} from './web-core-calls';

// ---------------------------------------------------------------------------
// An organization's shared skills and plugins on this computer (CAN-6236,
// CAN-6237).
//
// For each organization workspace a chat runs in, the shared set is read from
// the web core, installed, and kept in memory and in one cache file, so a
// restart offline keeps the last known set. Reads are stale-while-revalidate:
// a set younger than a minute answers at once; an older one answers at once
// and refreshes behind it; a workspace with none waits briefly for the first
// read. A refresh that changes the set advances the workspace's defaults
// revision, so its running sessions are recreated on their next turn, as
// for a project defaults change. A failed read keeps the last known set;
// none known is no organization layer.
// ---------------------------------------------------------------------------

const FRESH_FOR_MS = 60_000;
const FIRST_READ_WAIT_MS = 5_000;

export interface OrganizationLayer {
  readonly layer: ChatTabPluginSelections;
  readonly allowed: AllowedOrganizationItems;
  /** The installed items with their names, for the pickers (CAN-6237). */
  readonly items: readonly OrganizationLayerItem[];
}

const InstalledItemSchema = z.union([
  z.strictObject({
    key: z.string(),
    name: z.string(),
    source: z.enum(['organization', 'project']),
    status: z.literal('installed'),
    skillRef: z
      .strictObject({ sourceId: z.string(), skillName: z.string() })
      .optional(),
    pluginRef: z
      .strictObject({ marketplaceId: z.string(), pluginName: z.string() })
      .optional(),
    agentRef: z
      .strictObject({
        agentId: z.string(),
        createdByOrganization: z.boolean(),
      })
      .optional(),
    // Added in phase 10b.
    pipelineRef: z.strictObject({ remoteId: z.string() }).optional(),
    contentHash: z.string().optional(),
  }),
  z.strictObject({
    key: z.string(),
    name: z.string(),
    source: z.enum(['organization', 'project']),
    status: z.enum(['failed', 'unsupported']),
  }),
]);

const CacheFileSchema = z.strictObject({
  version: z.literal(1),
  snapshots: z.array(
    z.strictObject({
      scope: z.strictObject({
        organizationId: z.string().min(1),
        projectId: z.string().min(1).nullable(),
      }),
      accountId: z.string().min(1),
      setupRevision: z.number().int().nullable(),
      defaultsRevision: z.number().int(),
      fetchedAt: z.number(),
      items: z.array(InstalledItemSchema),
      // Added in phase 10b; written only when the project switched one off.
      switchedOffPipelines: z.array(z.string().min(1)).optional(),
    }),
  ),
  // Added in phase 10a; written only while a removal is due, so a file
  // without one still reads in an older app.
  pendingAgentRemovals: z.array(z.string().min(1)).optional(),
});

export interface OrganizationCapabilityCache {
  readonly snapshots: readonly OrganizationCapabilitySnapshot[];
  /**
   * Agent copies the organization layer made that no set holds anymore and
   * that are not removed yet: each publish tries them again.
   */
  readonly pendingAgentRemovals: readonly string[];
}

/**
 * The organization's default pipelines a project switched off (phase 10b).
 * The server keeps `removed` as stored and lets an explicit addition win, so
 * a removed ref counts only while it is still an organization default and
 * the project's effective set does not hold it.
 */
function switchedOffPipelines(
  setup: Pick<
    CatalogProjectSetupGetResult,
    'removed' | 'organizationDefaults' | 'effective'
  >,
): string[] {
  const defaults = new Set(
    setup.organizationDefaults.map((item) => capabilitySetupItemKey(item.ref)),
  );
  const effective = new Set(
    setup.effective.map((entry) => capabilitySetupItemKey(entry.item.ref)),
  );
  return setup.removed.flatMap((ref) => {
    const key = capabilitySetupItemKey(ref);
    return ref.kind === 'pipeline' && defaults.has(key) && !effective.has(key)
      ? [ref.id]
      : [];
  });
}

export interface OrganizationCapabilityStore {
  read(): Promise<OrganizationCapabilityCache>;
  write(cache: OrganizationCapabilityCache): Promise<void>;
}

const EMPTY_CACHE: OrganizationCapabilityCache = {
  snapshots: [],
  pendingAgentRemovals: [],
};

function fileStore(path: string): OrganizationCapabilityStore {
  return {
    async read() {
      try {
        const parsed = CacheFileSchema.safeParse(
          JSON.parse(await readFile(path, 'utf8')),
        );
        return parsed.success
          ? {
              snapshots: parsed.data.snapshots,
              pendingAgentRemovals: parsed.data.pendingAgentRemovals ?? [],
            }
          : EMPTY_CACHE;
      } catch {
        return EMPTY_CACHE;
      }
    },
    async write({ snapshots, pendingAgentRemovals }) {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomically(
        path,
        JSON.stringify(
          pendingAgentRemovals.length > 0
            ? { version: 1, snapshots, pendingAgentRemovals }
            : { version: 1, snapshots },
        ),
        { durable: true, encoding: 'utf8', mode: 0o600 },
      );
    },
  };
}

/** The shared set a workspace of `scope` reads, or none. */
export function organizationCapabilityScope(
  scope: ConnectorScope | undefined,
): OrganizationCapabilityScope | undefined {
  if (scope?.kind === 'org-project')
    return {
      organizationId: scope.organizationId,
      projectId: scope.orgProjectId,
    };
  if (scope?.kind === 'org-workspace' && scope.organizationId)
    return { organizationId: scope.organizationId, projectId: null };
  return undefined;
}

function sameItems(
  a: OrganizationCapabilitySnapshot | undefined,
  b: OrganizationCapabilitySnapshot,
): boolean {
  return JSON.stringify(a?.items ?? null) === JSON.stringify(b.items);
}

/** A workspace's organization pipelines, by hosted id (phase 10b). */
export interface OrganizationPipelines {
  readonly held: ReadonlySet<string>;
  readonly switchedOff: ReadonlySet<string>;
}

export interface OrganizationCapabilityService {
  layerFor(
    workspaceId: string,
    connectorScope: ConnectorScope | undefined,
  ): Promise<OrganizationLayer | undefined>;
  refresh(
    scope: OrganizationCapabilityScope,
  ): Promise<OrganizationCapabilitySnapshot | null>;
  /** Reads every set of `organizationId` this device keeps again. */
  refreshOrganization(organizationId: string): Promise<void>;
  /** Reads every set of the organization project `projectId` this device keeps again. */
  refreshProject(projectId: string): Promise<void>;
  /**
   * Removes the Agent copies still due, and every copy this layer made once
   * organization projects are known to be off.
   */
  reconcileAgents(): Promise<void>;
  skillAllowed(
    workspaceId: string,
    ref: { sourceId: string; skillName: string },
  ): Promise<boolean>;
  /**
   * The organization pipelines of `workspaceId`'s set (phase 10b): the ones
   * it holds and the defaults its project switched off; undefined outside an
   * organization workspace, while organization projects are off, or with no
   * known set.
   */
  pipelinesFor(
    workspaceId: string,
    connectorScope: ConnectorScope | undefined,
  ): Promise<OrganizationPipelines | undefined>;
  /**
   * Whether the Agent `agentId` may be used in `workspaceId`: always for an
   * Agent this layer did not make (the person's own); a copy it made only
   * while the workspace's organization set holds it.
   */
  agentAllowed(
    workspaceId: string,
    agentId: string,
    connectorScope: () => Promise<ConnectorScope | undefined>,
  ): Promise<boolean>;
}

const skillKey = (ref: { sourceId: string; skillName: string }): string =>
  JSON.stringify([ref.sourceId, ref.skillName]);

export function createOrganizationCapabilityService(deps: {
  calls: OrganizationCapabilityCalls;
  install: OrganizationInstallDeps;
  store: OrganizationCapabilityStore;
  /** The signed-in account; a set is served only to the account that read it. */
  accountId: () => Promise<string | null>;
  now?: () => number;
  onChanged?: (workspaceId: string) => void;
}): OrganizationCapabilityService {
  const now = deps.now ?? Date.now;
  let loaded: Promise<Map<string, OrganizationCapabilitySnapshot>> | null =
    null;
  const inFlight = new Map<
    string,
    Promise<OrganizationCapabilitySnapshot | null>
  >();
  /** One install-to-prune pass at a time per organization: they share a source. */
  const organizationQueues = new Map<string, Promise<unknown>>();
  /** The local workspaces that read each scope, to tell of a change. */
  const readers = new Map<string, Set<string>>();
  /**
   * Each workspace's allowed organization skill copies as last resolved, and
   * the account they were resolved for.
   */
  const allowedSkills = new Map<
    string,
    { readonly accountId: string; readonly skills: ReadonlySet<string> }
  >();

  /**
   * Agent copies the organization layer made that no set holds and that are
   * not removed yet, kept in the cache file so a failed removal is retried,
   * also after a restart.
   */
  const pendingAgentRemovals = new Set<string>();
  /**
   * Copies an install made that its set does not hold yet: due (recorded in
   * the cache) but not removed while the install that made them runs.
   */
  const installingAgents = new Set<string>();

  const snapshots = (): Promise<Map<string, OrganizationCapabilitySnapshot>> =>
    (loaded ??= deps.store.read().then((cache) => {
      for (const agentId of cache.pendingAgentRemovals)
        pendingAgentRemovals.add(agentId);
      return new Map(
        cache.snapshots.map((snapshot) => [
          organizationCapabilityScopeKey(snapshot.scope),
          snapshot,
        ]),
      );
    }));

  function inOrganizationQueue<T>(
    organizationId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous =
      organizationQueues.get(organizationId) ?? Promise.resolve();
    const next = previous.then(work, work);
    organizationQueues.set(
      organizationId,
      next.catch(() => undefined),
    );
    return next;
  }

  type Fetched =
    | {
        readonly kind: 'ok';
        readonly entries: readonly CatalogProjectSetupItem[];
        readonly setupRevision: number | null;
        readonly defaultsRevision: number;
        /** The organization's default pipelines the project switched off. */
        readonly switchedOffPipelines: readonly string[];
      }
    | { readonly kind: 'unavailable' | 'refused' };

  async function fetchEntries(
    scope: OrganizationCapabilityScope,
  ): Promise<Fetched> {
    if (scope.projectId !== null) {
      const setup = await deps.calls.projectSetup(scope.projectId);
      return setup.kind === 'ok'
        ? {
            kind: 'ok',
            entries: setup.value.effective,
            setupRevision: setup.value.revision,
            defaultsRevision: setup.value.organizationDefaultsRevision,
            switchedOffPipelines: switchedOffPipelines(setup.value),
          }
        : { kind: setup.kind };
    }
    const defaults = await deps.calls.organizationDefaults(
      scope.organizationId,
    );
    return defaults.kind === 'ok'
      ? {
          kind: 'ok',
          entries: defaults.value.items.map((item) => ({
            item,
            source: 'organization' as const,
          })),
          setupRevision: null,
          defaultsRevision: defaults.value.revision,
          switchedOffPipelines: [],
        }
      : { kind: defaults.kind };
  }

  /**
   * One cache file holds every organization's sets, so its writes run one at
   * a time, each writing the sets as they are when it runs: the last write
   * always carries the newest state.
   */
  let writes: Promise<void> = Promise.resolve();
  function writeCache(
    map: Map<string, OrganizationCapabilitySnapshot>,
  ): Promise<void> {
    writes = writes
      .catch(() => undefined)
      .then(() =>
        deps.store.write({
          snapshots: [...map.values()],
          pendingAgentRemovals: [...pendingAgentRemovals],
        }),
      )
      .catch(() => undefined);
    return writes;
  }

  /** The Agent copies the organization layer made, as recorded anywhere here. */
  function createdAgentIds(
    map: Map<string, OrganizationCapabilitySnapshot>,
  ): Set<string> {
    return new Set([
      ...organizationCreatedAgentIds(map.values()),
      ...pendingAgentRemovals,
    ]);
  }

  /**
   * The Agent copies the sets hold. Once organization projects are known to
   * be off, none: every copy this layer made goes, so none stays usable
   * outside the organization's workspaces.
   */
  function holdingAgents(
    map: Map<string, OrganizationCapabilitySnapshot>,
  ): Set<string> {
    return deps.install.agentsSettledOff()
      ? new Set()
      : heldAgentIds(map.values());
  }

  /**
   * Removes the due Agent copies no set holds, one pass at a time across
   * organizations, since they share the Agent store. A copy that is removed,
   * already gone or the person's now is no longer due; one whose removal
   * failed stays due for the next publish.
   */
  let agentRemovals: Promise<void> = Promise.resolve();
  function removeDueAgents(
    map: Map<string, OrganizationCapabilitySnapshot>,
  ): Promise<void> {
    agentRemovals = agentRemovals.then(async () => {
      let removed = false;
      let settled = false;
      const held = holdingAgents(map);
      for (const agentId of [...pendingAgentRemovals]) {
        if (installingAgents.has(agentId)) continue;
        if (!held.has(agentId)) {
          try {
            removed =
              (await deps.install.removeOrganizationAgent(agentId)) || removed;
          } catch {
            // Still due: the copy shows only in the organization's
            // workspaces until a later publish removes it.
            continue;
          }
        }
        pendingAgentRemovals.delete(agentId);
        settled = true;
      }
      if (settled) await writeCache(map);
      if (removed)
        await deps.install.publishAgentChanges().catch(() => undefined);
    });
    return agentRemovals;
  }

  /**
   * Writes the cache and removes copies no set of the organization uses:
   * its skill copies, and the Agent copies this layer created (`agentsBefore`,
   * read before the change, and those still due) that no set on this
   * computer holds, whichever set created them.
   */
  async function publish(
    map: Map<string, OrganizationCapabilitySnapshot>,
    organizationId: string,
    agentsBefore: ReadonlySet<string>,
  ): Promise<void> {
    const held = holdingAgents(map);
    for (const agentId of [...agentsBefore, ...createdAgentIds(map)])
      if (!held.has(agentId)) pendingAgentRemovals.add(agentId);
    for (const agentId of pendingAgentRemovals)
      if (held.has(agentId)) pendingAgentRemovals.delete(agentId);
    // Recorded as due before any removal, so a crash midway retries it.
    await writeCache(map);
    if (pendingAgentRemovals.size > 0) await removeDueAgents(map);
    await pruneOrganizationSkills(
      deps.install,
      organizationId,
      new Set(
        [...map.values()]
          .filter((s) => s.scope.organizationId === organizationId)
          .flatMap((s) => s.items)
          .flatMap((item) =>
            item.status === 'installed' && item.skillRef
              ? [item.skillRef.skillName]
              : [],
          ),
      ),
    ).catch(() => undefined);
  }

  /**
   * Tries the due Agent removals again where nothing is published, as on a
   * read that failed or was refused for a set this computer no longer keeps.
   */
  async function retryDueAgents(
    map: Map<string, OrganizationCapabilitySnapshot>,
  ): Promise<void> {
    if (pendingAgentRemovals.size > 0) await removeDueAgents(map);
  }

  async function reconcileAgents(): Promise<void> {
    const map = await snapshots();
    if (deps.install.agentsSettledOff())
      for (const agentId of organizationCreatedAgentIds(map.values()))
        pendingAgentRemovals.add(agentId);
    if (pendingAgentRemovals.size === 0) return;
    // Recorded as due before any removal, so a crash midway retries it.
    await writeCache(map);
    await removeDueAgents(map);
  }

  function tellReaders(key: string): void {
    for (const workspaceId of readers.get(key) ?? [])
      deps.onChanged?.(workspaceId);
  }

  async function refresh(
    scope: OrganizationCapabilityScope,
  ): Promise<OrganizationCapabilitySnapshot | null> {
    const key = organizationCapabilityScopeKey(scope);
    const running = inFlight.get(key);
    if (running) return running;
    const run = (async (): Promise<OrganizationCapabilitySnapshot | null> => {
      const accountId = await deps.accountId();
      const map = await snapshots();
      const previous = map.get(key);
      const kept = previous?.accountId === accountId ? previous : undefined;
      if (accountId === null) return null;
      let fetched: Fetched;
      try {
        fetched = await fetchEntries(scope);
      } catch {
        // Transient: keep serving the account's last known set.
        await inOrganizationQueue(scope.organizationId, () =>
          retryDueAgents(map),
        );
        return kept ?? null;
      }
      const result = fetched;
      return inOrganizationQueue(scope.organizationId, async () => {
        // A read made for one account is never published for another.
        if ((await deps.accountId()) !== accountId) return null;
        if (result.kind !== 'ok') {
          // The account may no longer read this set, or the web serves none:
          // nothing from before keeps applying, and unused copies go.
          const agentsBefore = organizationCreatedAgentIds(map.values());
          if (map.delete(key)) {
            await publish(map, scope.organizationId, agentsBefore);
            tellReaders(key);
          } else {
            // Already gone: a removal that failed when it went is tried again.
            await retryDueAgents(map);
          }
          return null;
        }
        const prior = new Map(
          (kept?.items ?? []).map((item) => [item.key, item]),
        );
        const items: InstalledOrganizationItem[] = [];
        // A copy another set made stays the organization's when this set
        // reuses it, so it goes only when no set holds it.
        const createdAgents = createdAgentIds(map);
        const made = new Set<string>();
        // A new copy is due for removal (in the cache) as soon as it is
        // saved: once this set holds it, it is not; if the set is never
        // recorded (the account changed meanwhile), a later pass removes it.
        const recordMade = async (agentId: string): Promise<void> => {
          made.add(agentId);
          installingAgents.add(agentId);
          pendingAgentRemovals.add(agentId);
          await writeCache(map);
        };
        try {
          for (const entry of result.entries) {
            if (!entry.item.available) continue;
            items.push(
              await installOrganizationItem(
                deps.install,
                scope.organizationId,
                entry,
                prior.get(capabilitySetupItemKey(entry.item.ref)),
                createdAgents,
                recordMade,
              ),
            );
          }
          const snapshot: OrganizationCapabilitySnapshot = {
            scope,
            accountId,
            setupRevision: result.setupRevision,
            defaultsRevision: result.defaultsRevision,
            fetchedAt: now(),
            items,
            ...(result.switchedOffPipelines.length > 0
              ? { switchedOffPipelines: [...result.switchedOffPipelines] }
              : {}),
          };
          if ((await deps.accountId()) !== accountId) return null;
          const agentsBefore = organizationCreatedAgentIds(map.values());
          map.set(key, snapshot);
          for (const agentId of made) installingAgents.delete(agentId);
          await publish(map, scope.organizationId, agentsBefore);
          if (!sameItems(previous, snapshot)) tellReaders(key);
          return snapshot;
        } finally {
          for (const agentId of made) installingAgents.delete(agentId);
        }
      });
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  /**
   * The organization layer a chat in `workspaceId` (of `connectorScope`)
   * inherits, and what organization refs it may use; undefined outside an
   * organization workspace, when signed out, or when no set is known.
   */
  async function layerFor(
    workspaceId: string,
    connectorScope: ConnectorScope | undefined,
  ): Promise<OrganizationLayer | undefined> {
    return (await resolveLayer(workspaceId, connectorScope))?.layer;
  }

  /** `layerFor`, with the set it was resolved from. */
  async function resolveLayer(
    workspaceId: string,
    connectorScope: ConnectorScope | undefined,
  ): Promise<
    | {
        readonly layer: OrganizationLayer;
        readonly snapshot: OrganizationCapabilitySnapshot;
      }
    | undefined
  > {
    const scope = organizationCapabilityScope(connectorScope);
    // Any answer without a layer also ends what the workspace was allowed.
    if (!scope) {
      allowedSkills.delete(workspaceId);
      return undefined;
    }
    const accountId = await deps.accountId();
    if (accountId === null) {
      allowedSkills.delete(workspaceId);
      return undefined;
    }
    const key = organizationCapabilityScopeKey(scope);
    const seen = readers.get(key) ?? new Set<string>();
    seen.add(workspaceId);
    readers.set(key, seen);
    const stored = (await snapshots()).get(key);
    // Another account's set is never served; it is replaced on the next read.
    const cached = stored?.accountId === accountId ? stored : undefined;
    let snapshot: OrganizationCapabilitySnapshot | null | undefined = cached;
    if (!cached) {
      snapshot = await Promise.race([
        refresh(scope),
        // A deadline on this read, not a job: the refresh itself goes on.
        new Promise<null>((resolve) => {
          AbortSignal.timeout(FIRST_READ_WAIT_MS).addEventListener(
            'abort',
            () => resolve(null),
            { once: true },
          );
        }),
      ]);
    } else if (now() - cached.fetchedAt > FRESH_FOR_MS) {
      void refresh(scope);
    }
    // The account may have changed while the read and install ran.
    if (!snapshot || snapshot.accountId !== (await deps.accountId())) {
      allowedSkills.delete(workspaceId);
      return undefined;
    }
    const layer = organizationLayerSelections(snapshot);
    allowedSkills.set(workspaceId, {
      accountId: snapshot.accountId,
      skills: new Set(layer.skillRefs.map((ref) => skillKey(ref))),
    });
    return {
      layer: {
        layer,
        allowed: { organizationId: scope.organizationId, selections: layer },
        items: organizationLayerItems(snapshot),
      },
      snapshot,
    };
  }

  async function pipelinesFor(
    workspaceId: string,
    connectorScope: ConnectorScope | undefined,
  ): Promise<OrganizationPipelines | undefined> {
    // Organization pipelines apply only while resources keep to the context
    // that owns them, as Agents (phase 10b).
    if (!deps.install.agentsEnabled()) return undefined;
    const resolved = await resolveLayer(workspaceId, connectorScope);
    if (!resolved) return undefined;
    return {
      held: new Set(
        resolved.snapshot.items.flatMap((item) =>
          item.status === 'installed' && item.pipelineRef
            ? [item.pipelineRef.remoteId]
            : [],
        ),
      ),
      switchedOff: new Set(resolved.snapshot.switchedOffPipelines ?? []),
    };
  }

  async function agentAllowed(
    workspaceId: string,
    agentId: string,
    connectorScope: () => Promise<ConnectorScope | undefined>,
  ): Promise<boolean> {
    if (!createdAgentIds(await snapshots()).has(agentId)) return true;
    // The workspace's set as a turn there resolves it, read if needed.
    const resolved = await resolveLayer(workspaceId, await connectorScope());
    return (
      resolved !== undefined && heldAgentIds([resolved.snapshot]).has(agentId)
    );
  }

  /**
   * Whether an organization skill copy may load for `workspaceId`: only one
   * the workspace's organization layer held when its chat last resolved
   * (CAN-6240). A copy reached any other way (a collection, another
   * workspace's install) never loads.
   */
  async function skillAllowed(
    workspaceId: string,
    ref: { sourceId: string; skillName: string },
  ): Promise<boolean> {
    const grant = allowedSkills.get(workspaceId);
    if (!grant?.skills.has(skillKey(ref))) return false;
    // A grant holds only for the account it was resolved for.
    return grant.accountId === (await deps.accountId());
  }

  /**
   * Reads again every set this device keeps for the organization (its
   * workspace set and each project's, which includes the defaults), after
   * any read already running, so a change saved here applies at once.
   */
  function refreshOrganization(organizationId: string): Promise<void> {
    return refreshKept((scope) => scope.organizationId === organizationId);
  }

  /**
   * Reads again the sets this device keeps for one organization project,
   * after any read already running, so a setup saved here applies at once.
   */
  function refreshProject(projectId: string): Promise<void> {
    return refreshKept((scope) => scope.projectId === projectId);
  }

  async function refreshKept(
    matches: (scope: OrganizationCapabilityScope) => boolean,
  ): Promise<void> {
    const scopes = [...(await snapshots()).values()]
      .map((snapshot) => snapshot.scope)
      .filter(matches);
    await Promise.all(
      scopes.map(async (scope) => {
        await inFlight
          .get(organizationCapabilityScopeKey(scope))
          ?.catch(() => null);
        await refresh(scope);
      }),
    );
  }

  return {
    layerFor,
    refresh,
    refreshOrganization,
    refreshProject,
    reconcileAgents,
    skillAllowed,
    agentAllowed,
    pipelinesFor,
  };
}

function productionInstallDeps(): OrganizationInstallDeps {
  return {
    getSharedSkill: (id) => readOrganizationSkill(id),
    getSharedPluginRef: async (id) => {
      const detail = await readOrganizationPlugin(id);
      return { ref: detail.ref, owner: detail.owner };
    },
    importMarketplacePlugin: async (ref) => {
      if (ref.type !== 'plugin' && ref.type !== 'claude_plugin') return null;
      // Loaded on use: the shared import port reaches the plugin handlers,
      // which import the plugin resolver, which imports this module.
      const { mainSharedImportPort } =
        await import('../app-advisor/shared-import-port');
      const imported = await importSharedMarketplacePlugin(
        mainSharedImportPort({ remote: false }),
        ref.marketplace,
        ref.plugin_name,
      );
      return {
        marketplaceId: imported.marketplaceId,
        pluginName: imported.pluginName,
      };
    },
    writeSkill: async (sourceId, skillName, rawSkill) => {
      const dir = getSkillDir(sourceId, skillName);
      await mkdir(dir, { recursive: true });
      await writeFileAtomically(join(dir, 'SKILL.md'), rawSkill, {
        durable: true,
        encoding: 'utf8',
      });
    },
    listSkills: async (sourceId) => {
      try {
        return (await readdir(getSourceDir(sourceId), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    removeSkill: (sourceId, skillName) =>
      rm(getSkillDir(sourceId, skillName), { recursive: true, force: true }),
    // Organization Agents install only while Agents keep to the context
    // that owns them (CAN-6237, phase 10a).
    agentsEnabled: agentResourceContextEnabled,
    agentsSettledOff: agentResourceContextSettledOff,
    importOrganizationAgent: async (id, organizationId, organizationCopy) => {
      const [
        { getSharedAgent },
        store,
        { importSharedAgentForOrganization, updateOrganizationAgentFromShare },
      ] = await Promise.all([
        import('../agents/canopy-server-client'),
        import('../agents/agent-model-store'),
        import('../ipc/agent-models'),
      ]);
      const detail = await getSharedAgent(id);
      if (!ownedByOrganization(detail.owner, organizationId)) return null;
      // An edit of the organization's Agent updates the copy this layer made
      // in place (same id and name), so chats that picked it keep working.
      if (
        organizationCopy !== undefined &&
        (await updateOrganizationAgentFromShare(organizationCopy, detail))
      )
        return {
          agentId: organizationCopy,
          existedBefore: true,
          updated: true,
        };
      const before = new Set(
        (await store.listAgentModelsForInstallBackfill()).map(
          (agent) => agent.id,
        ),
      );
      const imported = await importSharedAgentForOrganization(detail);
      return {
        agentId: imported.finalId,
        existedBefore: before.has(imported.finalId),
      };
    },
    removeOrganizationAgent: async (agentId) => {
      const { removeOrganizationAgentCopy } =
        await import('../agents/agent-model-store');
      return removeOrganizationAgentCopy(agentId);
    },
    publishAgentChanges: async () => {
      const { publishOrganizationAgentChanges } =
        await import('../ipc/agent-models');
      // Logged, not thrown: the copy is recorded either way, and the next
      // change (or context switch) reads the registry again.
      await publishOrganizationAgentChanges().catch((failure: unknown) => {
        logMainProcessWarn(
          'Could not publish organization Agent changes',
          failure,
        );
      });
    },
    skillExists: async (sourceId, skillName) => {
      try {
        await access(join(getSkillDir(sourceId, skillName), 'SKILL.md'));
        return true;
      } catch {
        return false;
      }
    },
  };
}

let service: OrganizationCapabilityService | null = null;

function productionService(): OrganizationCapabilityService {
  service ??= createOrganizationCapabilityService({
    calls: createWebCoreOrganizationCapabilityCalls(),
    install: productionInstallDeps(),
    store: fileStore(getOrganizationCapabilitiesCachePath()),
    accountId: currentAccountId,
    onChanged: organizationLayerChanged,
  });
  return service;
}

/** The organization layer for a chat's workspace; see `layerFor`. */
export function organizationLayerForWorkspace(
  workspaceId: string,
  connectorScope: ConnectorScope | undefined,
): Promise<OrganizationLayer | undefined> {
  // Outside an organization workspace there is nothing to read, but a grant
  // the workspace held before (it was moved to Personal) must still end.
  if (organizationCapabilityScope(connectorScope) === undefined)
    return service
      ? service.layerFor(workspaceId, connectorScope)
      : Promise.resolve(undefined);
  return productionService().layerFor(workspaceId, connectorScope);
}

/**
 * Reads the organization's sets on this device again, after its Project
 * defaults were saved here (CAN-6237). A set that changes tells its
 * workspaces, as any refresh does.
 */
export function refreshOrganizationCapabilities(
  organizationId: string,
): Promise<void> {
  return productionService().refreshOrganization(organizationId);
}

/**
 * Reads an organization project's sets on this device again, after its
 * shared setup was saved here (CAN-6239).
 */
export function refreshProjectCapabilities(projectId: string): Promise<void> {
  return productionService().refreshProject(projectId);
}

/**
 * Removes the organization's Agent copies once organization projects are
 * known to be off (CAN-6237, phase 10a), checked now and on each flag
 * change, so none stays usable in a Personal workspace. Nothing runs while
 * the flag is on or not known yet.
 */
export function watchOrganizationAgentsFlag(): () => void {
  const check = (): void => {
    if (!agentResourceContextSettledOff()) return;
    void productionService()
      .reconcileAgents()
      .catch(() => undefined);
  };
  check();
  return onAgentResourceContextFlagChanged(check);
}

/**
 * Whether the Agent `agentId` may run in the chat workspace `projectId` (a
 * project, or a standalone chat's workspace): an organization Agent copy
 * only while that workspace's organization set holds it, as for skills
 * (CAN-6237, phase 10a); every other Agent always.
 */
export function organizationAgentAllowed(
  projectId: string,
  agentId: string,
): Promise<boolean> {
  const target = { projectId, worktreeId: projectId };
  return productionService().agentAllowed(
    pluginDefaultsWorkspaceId(target),
    agentId,
    async () => {
      const { resolveCachedConnectorScope } =
        await import('../plugins/connector-scope');
      return resolveCachedConnectorScope(target);
    },
  );
}

/**
 * The organization pipelines of the workspace `projectId` (CAN-6237, phase
 * 10b), or undefined outside an organization workspace: the shared
 * pipelines source leaves out, and refuses, the defaults its project
 * switched off.
 */
export async function organizationPipelinesFor(
  projectId: string,
): Promise<OrganizationPipelines | undefined> {
  const target = { projectId, worktreeId: projectId };
  const { resolveCachedConnectorScope } =
    await import('../plugins/connector-scope');
  const scope = await resolveCachedConnectorScope(target);
  // Nothing to read outside an organization workspace.
  if (organizationCapabilityScope(scope) === undefined) return undefined;
  return productionService().pipelinesFor(
    pluginDefaultsWorkspaceId(target),
    scope,
  );
}

const layerChangeListeners = new Set<(workspaceId: string) => void>();

/** Called with a workspace whose organization layer changed. */
export function subscribeOrganizationLayerChanged(
  listener: (workspaceId: string) => void,
): () => void {
  layerChangeListeners.add(listener);
  return () => {
    layerChangeListeners.delete(listener);
  };
}

function organizationLayerChanged(workspaceId: string): void {
  bumpProjectPluginDefaultsRevision(workspaceId);
  for (const listener of Array.from(layerChangeListeners)) {
    try {
      listener(workspaceId);
    } catch {
      // A listener never stops the change reaching the others.
    }
  }
}

async function currentAccountId(): Promise<string | null> {
  const account = await readCanopyCloudAccountWithStatus().catch(() => null);
  return account?.status === 'ok' ? (account.entry?.account?.id ?? null) : null;
}

/**
 * Whether an organization skill copy may load in `workspaceId`'s chat; false
 * before its organization layer was resolved on this run of the app.
 */
export async function organizationSkillAllowed(
  workspaceId: string | undefined,
  ref: { sourceId: string; skillName: string },
): Promise<boolean> {
  if (workspaceId === undefined || service === null) return false;
  // A chat's project id, or the workspace its defaults come from (a migrated
  // Cowork chat's), which is what its organization layer was keyed by.
  return (
    (await service.skillAllowed(workspaceId, ref)) ||
    (await service.skillAllowed(resolveCoworkWorkspaceId(workspaceId), ref))
  );
}
