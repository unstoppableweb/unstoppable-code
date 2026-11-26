import { canonicalCatalogEndpoint } from './catalogIntegrationKey';
import type { HarnessCompatibilityHarness } from '@canopy/protocol/plugins';
import { withCopiesIdentity } from './customizeCopyIdentity';
import {
  customizeDiscoveryNeedsAttention,
  type CustomizeDefaultHarness,
  type InstalledEntryStatusStates,
  type UnifiedEntryHarnessInstalls,
  type UnifiedEntryIntegrationCopies,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared/lib';
import { mergeEntryHarnessInstalls } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { marketplaceEntryIsInstalled } from './marketplaceBrowse';
import { curatedMcpConnectionState } from './unifiedPluginEntries';

/**
 * New Customize (CAN-6811): one row per integration. Copies that share an
 * `integrationKey` (CAN-6808), such as the Claude plugin, the Codex plugin
 * and the MCP catalog card of one product, collapse into the row of one
 * representative copy. Pure and display-only: no copy is installed, removed
 * or rewritten, ids never change, and a copy without a key stays its own row.
 */

/** Copies one row can stand for: plugins and MCP rows (servers, connectors). */
function joinsIntegration(
  entry: UnifiedPluginEntry,
): entry is UnifiedPluginEntry & {
  integrationKey: string;
} {
  return (
    (entry.kind === 'plugin' || entry.kind === 'app') &&
    entry.integrationKey !== undefined &&
    entry.pluginServerResult !== true &&
    entry.origin !== 'shared'
  );
}

/** A plugin, or the curated integration card a plugin folded into. */
function isPluginCopy(entry: UnifiedPluginEntry): boolean {
  return entry.kind === 'plugin' || entry.integration?.plugin !== undefined;
}

/** A device index only carries the hostname. The catalog carries the endpoint. */
function mcpVersionKey(entry: UnifiedPluginEntry): string | undefined {
  if (
    !joinsIntegration(entry) ||
    entry.ref.type !== 'curated-mcp' ||
    !entry.siteUrl
  )
    return undefined;
  const endpoint = canonicalCatalogEndpoint(entry.siteUrl);
  return endpoint === undefined
    ? undefined
    : JSON.stringify([entry.integrationKey, endpoint]);
}

function mcpVersion(entry: UnifiedPluginEntry): UnifiedPluginEntry {
  const { integration } = entry;
  if (!integration?.plugin) return entry;
  return {
    ...entry,
    state: curatedMcpConnectionState(
      integration.connections,
      entry.surface === 'desktop',
    ),
    harnessInstalls: integration.mcpHarnessInstalls,
  };
}

/** Same search group as the standalone server, under the original copy ids. */
export function customizeMcpVersionCopies(
  entry: UnifiedPluginEntry,
  entries: readonly UnifiedPluginEntry[],
): UnifiedPluginEntry[] {
  const key = mcpVersionKey(entry);
  if (key === undefined) return [];
  const copies = entries.filter(
    (copy) =>
      copy.id !== entry.id &&
      mcpVersionKey(copy) === key &&
      copy.installedEntryId !== entry.id &&
      copy.id !== entry.installedEntryId,
  );
  return entry.accountProxyMcp || copies.some((copy) => copy.accountProxyMcp)
    ? copies.map(mcpVersion)
    : [];
}

const PROVIDER_OF: Record<CustomizeDefaultHarness, 'Claude' | 'Codex'> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * Whether a copy is the one for the default harness: the harness's own
 * marketplace listing, else a copy installed for it, else one that supports
 * it.
 */
function nativeFor(
  entry: UnifiedPluginEntry,
  harness: CustomizeDefaultHarness,
  installed: boolean,
): boolean {
  if (entry.marketplaceProvider !== undefined)
    return entry.marketplaceProvider === PROVIDER_OF[harness];
  if (installed && entry.installedHarnesses !== undefined)
    return entry.installedHarnesses[harness] === true;
  return entry.providerSupport[harness];
}

function installedAtMs(entry: UnifiedPluginEntry): number {
  const value =
    entry.installedAt === undefined ? NaN : Date.parse(entry.installedAt);
  return Number.isFinite(value) ? value : -Infinity;
}

/**
 * The copy a row shows: installed copies first; for a row with nothing
 * installed, a copy this host can install from Browse, so Install never
 * disappears; then a plugin over a standalone MCP server, because the plugin
 * already includes it; among standalone copies, one with a sign-in to finish,
 * then one whose check fails, so the row's own health, test and Connect are
 * that copy's (a standalone row never needs to route Connect elsewhere: an
 * installed plugin would represent it instead); then the copy native to the
 * default harness; then the most recently installed; then list order.
 */
export function customizeIntegrationRepresentative(
  members: readonly UnifiedPluginEntry[],
  harness: CustomizeDefaultHarness,
  isInstalled: (entry: UnifiedPluginEntry) => boolean,
): UnifiedPluginEntry | undefined {
  const ranked = members.map((entry, index) => {
    const installed = isInstalled(entry);
    return {
      entry,
      index,
      installed: installed ? 0 : 1,
      plugin: isPluginCopy(entry) ? 0 : 1,
      attention:
        isPluginCopy(entry) || !installed
          ? 2
          : needsSignIn(entry)
            ? 0
            : customizeDiscoveryNeedsAttention(entry)
              ? 1
              : 2,
      native: nativeFor(entry, harness, installed) ? 0 : 1,
      installedAt: installed ? installedAtMs(entry) : -Infinity,
      installable: !installed && entry.browseInstallAvailable === false ? 1 : 0,
    };
  });
  ranked.sort(
    (a, b) =>
      a.installed - b.installed ||
      a.installable - b.installable ||
      a.plugin - b.plugin ||
      a.attention - b.attention ||
      a.native - b.native ||
      (b.installedAt > a.installedAt
        ? 1
        : b.installedAt < a.installedAt
          ? -1
          : 0) ||
      a.index - b.index,
  );
  return ranked[0]?.entry;
}

/** The harnesses one copy is installed for, at least one. */
function installedHarnessCount(entry: UnifiedPluginEntry): number {
  // One Add for every harness (CAN-6815) records them per harness.
  const recorded = entry.harnessInstalls?.installed.length ?? 0;
  if (recorded > 0) return recorded;
  const harnesses = entry.installedHarnesses;
  const count =
    (harnesses?.claude === true ? 1 : 0) + (harnesses?.codex === true ? 1 : 0);
  return Math.max(1, count);
}

/** The harness an installed copy names on its row, when it names one. */
function installedHarnessOf(
  entry: UnifiedPluginEntry,
  harness: CustomizeDefaultHarness,
): HarnessCompatibilityHarness | undefined {
  const recorded = entry.harnessInstalls?.installed ?? [];
  if (recorded.length > 0)
    return recorded.includes(harness) ? harness : recorded[0];
  const harnesses = entry.installedHarnesses;
  if (harnesses?.[harness] === true) return harness;
  if (harnesses?.claude === true) return 'claude';
  if (harnesses?.codex === true) return 'codex';
  if (entry.kind !== 'plugin') return undefined;
  if (entry.marketplaceProvider === 'Claude') return 'claude';
  if (entry.marketplaceProvider === 'Codex') return 'codex';
  const { claude, codex } = entry.providerSupport;
  if (claude && codex) return harness;
  if (claude) return 'claude';
  if (codex) return 'codex';
  return undefined;
}

/**
 * What an installed row's line says (CAN-6811): the representative's harness
 * and how many other installed copies the row stands for. A catalog card and
 * its own local install are one copy; a copy installed for two harnesses
 * counts twice.
 */
function installedCopies(
  representative: UnifiedPluginEntry,
  installedMembers: readonly UnifiedPluginEntry[],
  harness: CustomizeDefaultHarness,
): NonNullable<UnifiedEntryIntegrationCopies['installed']> {
  const copies = new Map<string, number>();
  for (const member of installedMembers) {
    const key = member.installedEntryId ?? member.id;
    copies.set(
      key,
      Math.max(copies.get(key) ?? 0, installedHarnessCount(member)),
    );
  }
  let total = 0;
  for (const count of copies.values()) total += count;
  const named = installedHarnessOf(representative, harness);
  return {
    ...(named !== undefined ? { harness: named } : {}),
    moreCount: Math.max(0, total - 1),
  };
}

/** Every installed copy's per-harness result, merged by the shared rule. */
function mergedHarnessInstalls(
  installedMembers: readonly UnifiedPluginEntry[],
): UnifiedEntryHarnessInstalls | undefined {
  return mergeEntryHarnessInstalls(
    installedMembers.flatMap((member) => member.harnessInstalls ?? []),
  );
}

/**
 * A lone row one Add installed for several harnesses gets the same
 * installed line as an integration row (CAN-6815): the default harness when
 * it is one of them, then how many more.
 */
function withRecordedInstalledLine(
  entry: UnifiedPluginEntry,
  harness: CustomizeDefaultHarness,
): UnifiedPluginEntry {
  const recorded = entry.harnessInstalls?.installed ?? [];
  if (recorded.length === 0 || entry.integrationCopies !== undefined)
    return entry;
  return {
    ...entry,
    integrationCopies: {
      memberIds: [entry.id],
      installed: {
        harness: recorded.includes(harness) ? harness : recorded[0],
        moreCount: recorded.length - 1,
      },
    },
  };
}

/** A copy with a sign-in to finish: `needs-auth`, or pending sign-ins. */
function needsSignIn(entry: UnifiedPluginEntry): boolean {
  return entry.state === 'needs-auth' || (entry.pendingSignIns ?? 0) > 0;
}

/** A copy whose connection check fails and is not turned off. */
function failingConnection(
  entry: UnifiedPluginEntry,
): UnifiedPluginEntry['connection'] {
  const connection = entry.aggregateConnection ?? entry.connection;
  return connection !== undefined &&
    connection.disabled !== true &&
    (connection.status === 'auth_required' ||
      connection.status === 'unreachable')
    ? connection
    : undefined;
}

/**
 * Hiding a copy never hides its recovery. The row adds every hidden installed
 * copy's pending sign-ins to its own (servers its plugin already counts
 * once), reads `needs-auth` when a copy does, and shows a hidden copy's
 * failing health when its own is fine, so Attention finds the row. When the
 * row's own copy has no sign-in to finish, Connect signs in to a hidden copy
 * that does (`attentionCopyId`), chosen apart from the copy whose health the
 * row shows.
 */
function hiddenAttention(
  representative: UnifiedPluginEntry,
  installedMembers: readonly UnifiedPluginEntry[],
): { readonly copyId?: string; readonly fields: Partial<UnifiedPluginEntry> } {
  const seen = new Set([
    representative.installedEntryId ?? representative.id,
    ...(representative.bundledServerRows ?? []).map((row) => row.entryId),
  ]);
  const hidden = installedMembers.filter((member) => {
    const key = member.installedEntryId ?? member.id;
    if (seen.has(key) || seen.has(member.id)) return false;
    seen.add(key);
    return true;
  });
  const signIn = needsSignIn(representative)
    ? undefined
    : hidden.find(needsSignIn);
  const failing = failingConnection(representative)
    ? undefined
    : hidden
        .map(failingConnection)
        .find((connection) => connection !== undefined);
  const hiddenSignIns = hidden.reduce(
    (count, member) => count + (member.pendingSignIns ?? 0),
    0,
  );
  const needsAuth =
    representative.state !== 'needs-auth' &&
    hidden.some((member) => member.state === 'needs-auth');
  return {
    ...(signIn !== undefined ? { copyId: signIn.id } : {}),
    fields: {
      ...(hiddenSignIns > 0
        ? {
            pendingSignIns:
              (representative.pendingSignIns ?? 0) + hiddenSignIns,
          }
        : {}),
      ...(needsAuth ? { state: 'needs-auth' } : {}),
      ...(failing !== undefined ? { aggregateConnection: failing } : {}),
    },
  };
}

/** Minimal union-find over integration keys and marketplace groups. */
class Groups {
  private readonly parent = new Map<string, string>();

  find(key: string): string {
    let root = this.parent.get(key) ?? key;
    while (root !== (this.parent.get(root) ?? root))
      root = this.parent.get(root) ?? root;
    if (root !== key) this.parent.set(key, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra);
  }
}

export interface CustomizeIntegrationRows {
  /** The list with each integration once, at its first copy's place. */
  readonly rows: readonly UnifiedPluginEntry[];
  /** Row id to every copy it stands for, itself included, in list order. */
  readonly membersOf: ReadonlyMap<string, readonly UnifiedPluginEntry[]>;
  /** Any copy's id to the id of the row that stands for it. */
  readonly rowIdOf: ReadonlyMap<string, string>;
}

/**
 * Collapses the copies of each integration into one row. A row stands for
 * copies that share an `integrationKey` or a marketplace package group. Its
 * representative keeps its own id, actions and detail page; install targets
 * that copy, which is native to the default harness when one is. The row's
 * installed state covers every installed copy, and the hidden copies stay
 * installed and working.
 */
export function mergeCustomizeIntegrations(
  entries: readonly UnifiedPluginEntry[],
  harness: CustomizeDefaultHarness,
  states?: InstalledEntryStatusStates,
  splitSearchResults = false,
): CustomizeIntegrationRows {
  const groups = new Groups();
  const keyOf = (
    entry: UnifiedPluginEntry & { integrationKey: string },
  ): string => {
    if (!splitSearchResults || isPluginCopy(entry))
      return `key:${entry.integrationKey}`;
    const versionKey = mcpVersionKey(entry);
    return versionKey !== undefined ? `mcp:${versionKey}` : `entry:${entry.id}`;
  };
  for (const entry of entries) {
    if (!joinsIntegration(entry)) continue;
    groups.find(keyOf(entry));
    if (entry.marketplaceGroup !== undefined)
      groups.union(keyOf(entry), `group:${entry.marketplaceGroup}`);
  }
  // A row a host already grouped brings its provider listings along, so the
  // copy for the default harness can still be the one it installs.
  const copiesByRoot = new Map<string, Map<string, UnifiedPluginEntry>>();
  const rootOf = new Map<string, string>();
  for (const entry of entries) {
    if (!joinsIntegration(entry)) continue;
    const root = groups.find(keyOf(entry));
    rootOf.set(entry.id, root);
    const copies =
      copiesByRoot.get(root) ?? new Map<string, UnifiedPluginEntry>();
    copiesByRoot.set(root, copies);
    copies.set(entry.id, entry);
    for (const listing of entry.marketplaceListings ?? [])
      if (!copies.has(listing.id)) copies.set(listing.id, listing);
  }
  const membersByRoot = new Map(
    [...copiesByRoot].map(([root, copies]) => [root, [...copies.values()]]),
  );
  const isInstalled = (entry: UnifiedPluginEntry): boolean =>
    marketplaceEntryIsInstalled(entry, states);
  const merged = new Map<string, UnifiedPluginEntry>();
  const membersOf = new Map<string, readonly UnifiedPluginEntry[]>();
  const rowIdOf = new Map<string, string>();
  for (const [root, members] of membersByRoot) {
    if (members.length < 2) continue;
    const proxy = splitSearchResults
      ? members
          .filter((member) => member.accountProxyMcp === true)
          .sort((a, b) => a.id.localeCompare(b.id))[0]
      : undefined;
    const representative =
      proxy ??
      customizeIntegrationRepresentative(members, harness, isInstalled);
    if (representative === undefined) continue;
    const ordered = [
      representative,
      ...members.filter((member) => member !== representative),
    ];
    if (splitSearchResults && mcpVersionKey(representative) !== undefined) {
      merged.set(root, withCopiesIdentity(representative, members));
      membersOf.set(representative.id, ordered);
      for (const member of members) rowIdOf.set(member.id, representative.id);
      continue;
    }
    const providers = [
      ...new Set(members.flatMap((member) => member.marketplaceProvider ?? [])),
    ].sort();
    const installedMembers = members.filter(isInstalled);
    const attention = hiddenAttention(representative, installedMembers);
    const harnessInstalls = mergedHarnessInstalls(installedMembers);
    const copies: UnifiedEntryIntegrationCopies = {
      memberIds: ordered.map((member) => member.id),
      ...(isInstalled(representative)
        ? {
            installed: installedCopies(
              representative,
              installedMembers,
              harness,
            ),
          }
        : {}),
    };
    // The row subsumes the marketplace package group, so it no longer offers
    // the grouped provider picker: install targets the representative.
    const row: UnifiedPluginEntry = withCopiesIdentity(
      {
        ...representative,
        marketplaceGroup: undefined,
        marketplaceListings: undefined,
        ...(providers.length > 1 ? { marketplaceProviders: providers } : {}),
        ...attention.fields,
        ...(harnessInstalls !== undefined ? { harnessInstalls } : {}),
        integrationCopies: {
          ...copies,
          ...(attention.copyId !== undefined
            ? { attentionCopyId: attention.copyId }
            : {}),
        },
      },
      members,
    );
    merged.set(root, row);
    membersOf.set(row.id, ordered);
    for (const member of members) rowIdOf.set(member.id, row.id);
  }
  if (merged.size === 0)
    return {
      rows: entries.map((entry) => withRecordedInstalledLine(entry, harness)),
      membersOf,
      rowIdOf,
    };
  const emitted = new Set<string>();
  const rows = entries.flatMap((entry): UnifiedPluginEntry[] => {
    const root = rootOf.get(entry.id);
    const row = root === undefined ? undefined : merged.get(root);
    if (root === undefined || row === undefined)
      return [withRecordedInstalledLine(entry, harness)];
    if (emitted.has(root)) return [];
    emitted.add(root);
    return [row];
  });
  return { rows, membersOf, rowIdOf };
}
