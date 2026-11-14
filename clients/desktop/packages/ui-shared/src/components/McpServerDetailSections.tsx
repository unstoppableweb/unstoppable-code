import { Badge } from './Badge';
import { Stack } from './Stack';
import type { JSX } from 'react';

import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { Skeleton } from './Skeleton';
import { ErrorBanner } from './StatusBlocks';
import { Fact, FactList } from './FactList';
import { pluginDisplayAuthor } from '../lib/official-marketplace-products';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Heading } from './Heading';

// ---------------------------------------------------------------------------
// Narrow structural prop types
//
// These are deliberately minimal shapes covering only the fields the sections
// render. Desktop passes its richer `@canopy/desktop-shared` types
// (`DetectedMcpServerInfo`, `MarketplaceInfo`, `PluginInfo`,
// `McpServerData`) via structural compatibility — do NOT import
// `@canopy/desktop-shared` here; ui-shared must stay pure.
// ---------------------------------------------------------------------------

/** Fallback display fields read off the detected server row. */
export interface McpPluginSectionServer {
  readonly pluginName?: string;
  readonly marketplaceId?: string;
}

/** Plugin display fields rendered by {@link PluginSection}. */
export interface McpPluginSectionPlugin {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
  readonly category?: string;
  readonly homepage?: string;
  readonly externalSource?: {
    readonly url?: string;
    readonly sha?: string;
  };
}

/** Marketplace display fields rendered by {@link PluginSection}. */
export interface McpPluginSectionMarketplace {
  readonly name: string;
  readonly description?: string;
  readonly sourceType?: string;
  readonly sourceUrl?: string;
}

/** Resolved plugin + marketplace context for a plugin-sourced MCP server. */
export interface McpPluginSectionContext {
  readonly marketplace: McpPluginSectionMarketplace | null;
  readonly plugin: McpPluginSectionPlugin | null;
}

/** One configuration variant rendered by {@link StandaloneConfigsSection}. */
export interface McpStandaloneConfig {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  // Only names and whether a token is set are shown; values may be
  // stored-secret references rather than text.
  readonly envVars: Readonly<Record<string, unknown>>;
  readonly extraArgs: readonly string[];
  readonly extraHeaders: Readonly<Record<string, unknown>>;
  readonly authToken?: unknown;
}

/** Standalone server payload rendered by {@link StandaloneConfigsSection}. */
export interface McpStandaloneConfigsData {
  readonly configs: readonly McpStandaloneConfig[];
}

/**
 * The author the section credits: the product's vendor for an official listing
 * OpenAI maintains on another vendor's behalf, as every plugin surface credits
 * it, and otherwise the plugin's own declared author.
 */
function pluginSectionAuthor(
  server: McpPluginSectionServer,
  plugin: McpPluginSectionPlugin | null | undefined,
): string | undefined {
  return plugin ? pluginDisplayAuthor(server.marketplaceId, plugin) : undefined;
}

const SAMPLE_PLUGIN_SERVER: McpPluginSectionServer = {};

const SAMPLE_PLUGIN_CONTEXT: McpPluginSectionContext = {
  plugin: {
    name: 'Issue tracker',
    version: '1.2.0',
    description: 'Reads and updates issues in your tracker',
    author: 'Example',
  },
  marketplace: {
    name: 'Team plugins',
    description: 'Plugins shared across the team',
  },
};

/** The plugin and marketplace facts. */
function PluginSectionCard({
  server,
  context,
}: {
  server: McpPluginSectionServer;
  context: McpPluginSectionContext;
}): JSX.Element {
  const author = pluginSectionAuthor(server, context.plugin);
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-secondary/20 px-4 py-3">
      {/* One label width for both lists, so their values line up. */}
      <FactList labelWidth="6rem" rowGap="2" labelTone="secondary">
        <Fact label="Plugin">
          {context.plugin?.name ?? server.pluginName ?? '—'}
          {context.plugin?.version ? ` · v${context.plugin.version}` : ''}
        </Fact>
        {context.plugin?.description && (
          <Fact label="Description">{context.plugin.description}</Fact>
        )}
        {author && <Fact label="Author">{author}</Fact>}
        {context.plugin?.category && (
          <Fact label="Category">{context.plugin.category}</Fact>
        )}
        {context.plugin?.homepage && (
          <Fact label="Homepage" fit="break-all">
            <a
              href={context.plugin.homepage}
              target="_blank"
              rel="noreferrer"
              className="fg-accent hover:underline"
            >
              {context.plugin.homepage}
            </a>
          </Fact>
        )}
        {context.plugin?.externalSource?.url && (
          <Fact label="Source" fit="break-all" mono>
            <a
              href={context.plugin.externalSource.url}
              target="_blank"
              rel="noreferrer"
              className="fg-accent hover:underline"
            >
              {context.plugin.externalSource.url}
            </a>
            {context.plugin.externalSource.sha && (
              <span className="ml-2 fg-secondary">
                @{context.plugin.externalSource.sha.slice(0, 7)}
              </span>
            )}
          </Fact>
        )}
      </FactList>
      <FactList labelWidth="6rem" rowGap="2" labelTone="secondary" divided>
        <Fact label="Marketplace">
          {context.marketplace?.name ?? server.marketplaceId ?? '—'}
        </Fact>
        {context.marketplace?.description && (
          <Fact label="About">{context.marketplace.description}</Fact>
        )}
        {context.marketplace?.sourceUrl && (
          <Fact label="Source" fit="break-all" mono>
            {context.marketplace.sourceType === 'github' ? (
              <a
                href={`https://github.com/${context.marketplace.sourceUrl}`}
                target="_blank"
                rel="noreferrer"
                className="fg-accent hover:underline"
              >
                {context.marketplace.sourceUrl}
              </a>
            ) : (
              context.marketplace.sourceUrl
            )}
          </Fact>
        )}
      </FactList>
    </div>
  );
}

/**
 * "Plugin & Marketplace" section of the MCP server details view: the plugin's
 * facts, then the marketplace's under a rule.
 */
export function PluginSection({
  server,
  loading,
  error,
  context,
}: {
  server: McpPluginSectionServer;
  loading: boolean;
  error: string | null;
  context: McpPluginSectionContext | null;
}): JSX.Element {
  return (
    <Stack gap="inline" data-testid="mcp-server-details-plugin-section">
      <Heading level={3} variant="title">
        Plugin & marketplace
      </Heading>
      <div>
        {loading && (
          <DelayedLoadingPlaceholder slowNote="Still loading the plugin…">
            <Skeleton
              loading
              label="Loading plugin"
              testId="mcp-server-details-plugin-loading"
            >
              <PluginSectionCard
                server={SAMPLE_PLUGIN_SERVER}
                context={SAMPLE_PLUGIN_CONTEXT}
              />
            </Skeleton>
          </DelayedLoadingPlaceholder>
        )}
        <ErrorBanner errorSource="plugin-section" className="" error={error} />
        {!loading && !error && context && (
          <PluginSectionCard server={server} context={context} />
        )}
      </div>
    </Stack>
  );
}

/** One configuration's settings: names only, never secret values. */
export function McpConfigFacts({
  config,
}: {
  config: McpStandaloneConfig;
}): JSX.Element {
  return (
    <FactList rowGap="2" labelTone="secondary">
      {Object.keys(config.envVars).length > 0 && (
        <Fact label="Env vars">{Object.keys(config.envVars).join(', ')}</Fact>
      )}
      {config.extraArgs.length > 0 && (
        <Fact label="Extra args" mono fit="break-all">
          {/* Args often carry API keys inline. */}
          <span className={REPLAY_BLOCK_CLASS}>
            {config.extraArgs.join(' ')}
          </span>
        </Fact>
      )}
      {Object.keys(config.extraHeaders).length > 0 && (
        <Fact label="Extra headers">
          {Object.keys(config.extraHeaders).join(', ')}
        </Fact>
      )}
      {config.authToken !== undefined && config.authToken !== '' && (
        <Fact label="Auth token">configured</Fact>
      )}
    </FactList>
  );
}

/** A local MCP server's connection: how it runs and where it points. */
export interface McpConnectionFactsProps {
  /** Where the server comes from, for a detected server. */
  readonly source?: string | undefined;
  /** The server's name inside its plugin, for a plugin server. */
  readonly pluginServerName?: string | undefined;
  readonly type: 'command' | 'http';
  /** Shown for an HTTP server. */
  readonly url?: string | undefined;
  /** The full command line; rendered replay-blocked (args carry keys). */
  readonly commandLine?: string | undefined;
  /** Whether OAuth is configured; omitted hides the fact. */
  readonly oauth?: boolean | undefined;
}

/**
 * The connection facts of a local MCP server, in the fact list the web MCP
 * detail uses (design call 4A, 2026-10-31). The desktop MCP page and the MCP
 * details dialog both render it.
 */
export function McpConnectionFacts({
  source,
  pluginServerName,
  type,
  url,
  commandLine,
  oauth,
}: McpConnectionFactsProps): JSX.Element {
  return (
    <FactList
      rowGap="2"
      labelTone="secondary"
      dataTestId="mcp-server-connection-facts"
    >
      {source !== undefined && <Fact label="Source">{source}</Fact>}
      {pluginServerName && (
        <Fact label="Plugin server">{pluginServerName}</Fact>
      )}
      <Fact label="Type">
        {type === 'command' ? 'Command (stdio)' : 'HTTP'}
      </Fact>
      {type === 'http' && url && (
        <Fact label="URL" mono fit="break-all">
          {url}
        </Fact>
      )}
      {commandLine && (
        <Fact label="Command" mono fit="break-all">
          <span className={REPLAY_BLOCK_CLASS}>{commandLine}</span>
        </Fact>
      )}
      {oauth !== undefined && (
        <Fact label="OAuth">{oauth ? 'configured' : 'not configured'}</Fact>
      )}
    </FactList>
  );
}

const SAMPLE_CONFIGS: readonly McpStandaloneConfig[] = [
  {
    id: 'mcp-config-sample-1',
    name: 'Default',
    description: 'Connects with the shared workspace token',
    enabled: true,
    envVars: { API_URL: '' },
    extraArgs: [],
    extraHeaders: {},
  },
  {
    id: 'mcp-config-sample-2',
    name: 'Staging',
    description: 'Points at the staging server',
    enabled: false,
    envVars: { API_URL: '' },
    extraArgs: [],
    extraHeaders: {},
  },
];

/** One card per configuration: its name, state, description and keys. */
function StandaloneConfigCards({
  configs,
}: {
  configs: readonly McpStandaloneConfig[];
}): JSX.Element {
  return (
    <Stack gap="inline">
      {configs.map((config) => (
        <div
          key={config.id}
          className="rounded-lg border bg-secondary/20 px-3 py-2 flex flex-col gap-1"
        >
          <div className="flex items-center gap-2">
            <span className="text-s font-medium fg-primary">{config.name}</span>
            <Badge tone={config.enabled ? 'success' : 'neutral'}>
              {config.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          {config.description && (
            <p className="text-xs fg-secondary">{config.description}</p>
          )}
          <McpConfigFacts config={config} />
        </div>
      ))}
    </Stack>
  );
}

/**
 * "Configurations" section of a standalone MCP server: one card per
 * configuration. The MCP details dialog and the desktop MCP page render it.
 */
export function StandaloneConfigsSection({
  loading,
  error,
  serverData,
}: {
  loading: boolean;
  error: string | null;
  serverData: McpStandaloneConfigsData | null;
}): JSX.Element {
  return (
    <Stack gap="inline">
      <Heading level={3} variant="title">
        Configurations
        {serverData ? ` (${serverData.configs.length})` : ''}
      </Heading>
      <div>
        {loading && (
          <DelayedLoadingPlaceholder slowNote="Still loading configurations…">
            <Skeleton
              loading
              label="Loading configurations"
              testId="mcp-server-details-configs-loading"
            >
              <StandaloneConfigCards configs={SAMPLE_CONFIGS} />
            </Skeleton>
          </DelayedLoadingPlaceholder>
        )}
        <ErrorBanner
          errorSource="standalone-configs-section"
          className=""
          error={error}
        />
        {!loading && !error && serverData && (
          <>
            {serverData.configs.length === 0 ? (
              <p className="text-xs italic fg-secondary">No configurations.</p>
            ) : (
              <StandaloneConfigCards configs={serverData.configs} />
            )}
          </>
        )}
      </div>
    </Stack>
  );
}
