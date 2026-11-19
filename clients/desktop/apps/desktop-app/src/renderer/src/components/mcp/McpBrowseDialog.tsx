import { type JSX, type ReactNode, useEffect, useState } from 'react';
import {
  curatedMcpProviderOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import { McpServerLogo } from '../shared/McpServerLogo';
import {
  CuratedMcpDetail,
  type CuratedMcpDetailProps,
  type CuratedMcpDetailRoutes,
  type McpDetailEntry,
} from '@canopy/ui-app/capability';

// ---------------------------------------------------------------------------
// Curated logo (remote CDN <img> with icon fallback)
// ---------------------------------------------------------------------------

interface CuratedLogoProps {
  curatedKey?: string;
  logoUrl?: string;
  name?: string;
  size: number;
  className?: string;
}

/**
 * Curated entry logo: the shared circular {@link McpServerLogo} with the
 * monogram fallback (entries are identified by name in this dialog).
 */
function CuratedLogo({
  curatedKey,
  logoUrl,
  name,
  size,
  className = '',
}: CuratedLogoProps): JSX.Element {
  return (
    <McpServerLogo
      curatedKey={curatedKey}
      logoUrl={logoUrl}
      size={size}
      fallback="monogram"
      name={name}
      className={className}
      imgTestId="mcp-curated-logo"
      fallbackTestId="mcp-curated-logo-fallback"
    />
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

export interface CuratedDetailProps<
  T extends McpDetailEntry = CuratedMcpServerEntry,
> extends Pick<
  CuratedMcpDetailProps<T>,
  | 'logo'
  | 'publisher'
  | 'updated'
  | 'configuration'
  | 'related'
  | 'worksWith'
  | 'renderAccounts'
  | 'availability'
> {
  entry: T;
  /** Installed server id when this curated entry is already added, else null. */
  installedServerId: string | null;
  onAdd?: (entry: T) => void;
  /** Open the installed server's configuration editor. */
  onConfigure?: () => void;
  actions?: ReactNode;
  connectionContent?: ReactNode;
  /** Other ways to reach the service, after this entry's own route. */
  routes?: CuratedMcpDetailRoutes;
  toolsRevision?: number;
  statusContent?: ReactNode;
  renderManagement?: () => ReactNode;
  flush?: boolean;
}

/**
 * Read-only detail for one curated MCP catalog entry, with the Add affordance
 * the caller wires to `McpServerDialog`. Exported so the Plugins discovery
 * detail wrapper renders the same surface as the browse dialog instead of
 * forking it (API-2153, design section 4).
 */
export function CuratedDetail<T extends McpDetailEntry>({
  entry,
  installedServerId,
  onAdd,
  onConfigure,
  actions,
  connectionContent,
  routes,
  toolsRevision,
  statusContent,
  renderManagement,
  flush,
  ...layoutSlots
}: CuratedDetailProps<T>): JSX.Element {
  // Discovered tools are INSTALLED-ONLY: the catalog carries none, and
  // discovery needs a live endpoint + the user's credentials that do not exist
  // before the server is added. `null` = not installed (section omitted);
  // an array (possibly empty) = installed and resolved.
  const providerOnly = curatedMcpProviderOnly(entry);
  const [tools, setTools] = useState<string[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState('');

  useEffect(() => {
    if (!installedServerId || providerOnly) {
      setTools(null);
      setToolsLoading(false);
      setToolsError('');
      return;
    }
    let cancelled = false;
    setTools(null);
    setToolsLoading(true);
    setToolsError('');
    void window.mcpServers
      .getTools(installedServerId)
      .then((result) => {
        if (!cancelled) {
          setTools(result?.tools ?? []);
          setToolsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setToolsError('Unable to load tools.');
          setToolsLoading(false);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [installedServerId, toolsRevision, providerOnly]);

  return (
    <CuratedMcpDetail
      entry={entry}
      installedServerId={installedServerId}
      toolNames={tools}
      toolsLoading={toolsLoading}
      toolsError={toolsError}
      onAdd={onAdd}
      onConfigure={onConfigure}
      actions={actions}
      connectionContent={connectionContent}
      routes={routes}
      statusContent={statusContent}
      renderManagement={renderManagement}
      flush={flush}
      {...layoutSlots}
      renderLogo={(catalogEntry) => (
        <CuratedLogo
          curatedKey={catalogEntry.key}
          logoUrl={catalogEntry.logoUrl}
          name={catalogEntry.name}
          size={40}
        />
      )}
    />
  );
}
