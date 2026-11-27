import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import { normalizeCapabilityName } from '@canopy/protocol/capability-name';
import type {
  ProviderConnectorListResult,
  ProviderConnectorProvider,
  ProviderConnectorRow,
} from '@canopy/protocol/mcp-servers';

/** Only display/link facts are needed by shared UI; hosts may redact CLI fields. */
export type ProviderConnectorInput = Omit<
  ProviderConnectorListResult,
  'connectors'
> & {
  connectors: Array<
    Pick<
      ProviderConnectorListResult['connectors'][number],
      'displayName' | 'connected' | 'installUrl'
    >
  >;
};

/** Order the provider columns consistently rather than by read-completion. */
const PROVIDER_ORDER: readonly ProviderConnectorProvider[] = [
  'claude',
  'codex',
];

/** One advertised connector, however it was sourced. */
interface CatalogRow {
  displayName: string;
  providers: readonly ProviderConnectorProvider[];
  /** Catalog key, so the row can resolve a bundled brand mark. */
  curatedKey?: string;
  /** Name on a Claude account, when it differs from the display name. */
  claudeConnectorName?: string;
}

/**
 * Which connectors to advertise, entirely from the served catalog.
 *
 * There is deliberately no bundled fallback. One existed and made failure
 * inconsistent rather than graceful: with an empty catalog the MCP Servers tab
 * correctly hid Browse and every curated entry, while connectors appeared
 * anyway from the compiled-in list — the only capability visible, with no way
 * to tell why. A catalog that cannot be read should hide curated things
 * uniformly. It also removes the second list that the main-process Codex
 * reader used to drift from.
 */
export function resolveProviderConnectorCatalog(
  entries: readonly CuratedMcpServerEntry[],
): CatalogRow[] {
  return entries
    .filter((entry) => entry.providerConnector)
    .map((entry) => {
      // `providers: []` survives rather than being back-filled with every
      // provider. Tolerated on read for forward-compatibility — a catalog
      // served by an older or newer hub must not be reinterpreted here — while
      // the write schema rejects it (`.min(1)` in admin/schemas.ts), because as
      // stored data it is a dead end: it renders "no provider offers this
      // connector yet" while still standing in for the entry it replaces.
      const connector = entry.providerConnector;
      return {
        displayName: entry.name,
        curatedKey: entry.key,
        providers: connector?.providers ?? [],
        ...(connector?.claudeConnectorName
          ? { claudeConnectorName: connector.claudeConnectorName }
          : {}),
      };
    });
}

/**
 * Turn per-provider reads into one row per advertised connector.
 *
 * The catalog drives the rows, not the provider responses. A user with nothing
 * linked gets zero connectors back from both providers, and rendering that
 * directly would show an empty panel.
 *
 * Connectors a provider reports but the catalog does not advertise are
 * appended, so anything else already on the account still appears.
 */
export function buildProviderConnectorRows(
  results: readonly ProviderConnectorInput[],
  entries: readonly CuratedMcpServerEntry[] = [],
): ProviderConnectorRow[] {
  const byProvider = new Map<
    ProviderConnectorProvider,
    ProviderConnectorInput
  >();
  for (const result of results) byProvider.set(result.provider, result);

  const catalog = resolveProviderConnectorCatalog(entries);
  const rows: ProviderConnectorRow[] = catalog.map((row) => ({
    displayName: row.displayName,
    ...(row.curatedKey ? { curatedKey: row.curatedKey } : {}),
    // Every provider the catalog advertises, whether or not it has answered.
    // Filtering on `byProvider.has` meant a row had no providers until the
    // reads landed, which made the whole row vanish from the first paint —
    // so nothing was suppressed and the provider's own marketplace plugin
    // rendered in its place, then swapped. What the catalog advertises is
    // known immediately; only linked-or-not has to wait.
    providers: PROVIDER_ORDER.filter((provider) =>
      row.providers.includes(provider),
    ).map((provider) =>
      resolveProviderEntry(
        provider,
        byProvider.get(provider),
        provider === 'claude'
          ? (row.claudeConnectorName ?? row.displayName)
          : row.displayName,
      ),
    ),
  }));

  // Seeded with every name a row can match under, not just the catalog's. A
  // Claude connector is matched by `claudeConnectorName`, so seeding only the
  // display name let an aliased connector fail to recognise itself below and
  // get appended a second time — a duplicate tile in the Plugins list and a
  // duplicate row in the detail panel, in exactly the case the alias exists
  // for.
  const advertised = new Set(
    catalog.flatMap((row) =>
      row.claudeConnectorName
        ? [row.displayName, row.claudeConnectorName]
        : [row.displayName],
    ),
  );
  // Keyed by name so a connector both providers report becomes one row naming
  // both, rather than a row claiming whichever provider answered first.
  const appended = new Map<string, ProviderConnectorRow>();
  for (const provider of PROVIDER_ORDER) {
    const result = byProvider.get(provider);
    if (result === undefined) continue;
    for (const connector of result.connectors) {
      if (advertised.has(connector.displayName)) continue;
      const entry = resolveProviderEntry(
        provider,
        result,
        connector.displayName,
      );
      const existing = appended.get(connector.displayName);
      if (existing) {
        if (!existing.providers.some((p) => p.provider === provider))
          existing.providers.push(entry);
        continue;
      }
      const row: ProviderConnectorRow = {
        displayName: connector.displayName,
        providers: [entry],
      };
      appended.set(connector.displayName, row);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * The catalog entry describing a connector row: by key when the catalog maps
 * the connector, else the entry with exactly the same name. A connector the
 * catalog does not map (Slack on a Claude account, while the catalog's Slack
 * is a standalone server) is still the same service, so it borrows the
 * entry's brand and description; it never joins the entry's card.
 */
export function providerConnectorCatalogEntry(
  row: Pick<ProviderConnectorRow, 'displayName' | 'curatedKey'>,
  entries: readonly CuratedMcpServerEntry[],
): CuratedMcpServerEntry | undefined {
  return row.curatedKey
    ? entries.find((entry) => entry.key === row.curatedKey)
    : entries.find((entry) => entry.name === row.displayName);
}

function resolveProviderEntry(
  provider: ProviderConnectorProvider,
  result: ProviderConnectorInput | undefined,
  matchName: string,
): ProviderConnectorRow['providers'][number] {
  const match = result?.connectors.find(
    (connector) => connector.displayName === matchName,
  );
  // Only consulted when there is no connector: an account connector is the
  // route this surface manages, and saying "available via plugin" over the top
  // of a real connection would misreport which one is in play.
  const alternate = match?.connected
    ? undefined
    : result?.alternateRoutes?.find(
        (route) => route.normalizedName === normalizeCapabilityName(matchName),
      );
  const connected = match?.connected ?? false;
  // No result for this provider means the read has not answered, not that
  // nothing is linked. Carried so the UI can say "checking" instead of
  // asserting a negative it cannot support yet.
  const pending = result === undefined;
  return {
    provider,
    connected,
    ...(pending ? { pending: true } : {}),
    // Only qualify a NOT-connected answer. A positive is trustworthy — the
    // snapshot recorded a real link — but a negative may simply predate the
    // user linking, and Canopy cannot make the provider refresh.
    ...(!connected && result?.snapshotAt
      ? { staleSince: result.snapshotAt }
      : {}),
    ...(alternate ? { alternateRoute: alternate.serverName } : {}),
    ...(result?.unavailableReason
      ? { unavailable: result.detail ?? result.unavailableReason }
      : {}),
    ...(match?.installUrl ? { installUrl: match.installUrl } : {}),
  };
}
