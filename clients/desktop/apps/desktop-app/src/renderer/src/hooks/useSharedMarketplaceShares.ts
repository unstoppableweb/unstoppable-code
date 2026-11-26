import { useCallback, useEffect, useRef, useState } from 'react';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type { SharedAgentSummary } from '@canopy/execution-engine/types/agent-models';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const PAGE_SIZE = 25;
/**
 * Shared agents read up to this many pages (500 agents). Shares fold into
 * their local copies, so a first page alone can leave the tab empty while
 * uninstalled agents sit on a later page. Search reaches anything past it.
 */
const MAX_SHARED_AGENT_PAGES = 20;
/** Dispatched on `window` after a plugin share is created or its audience changes. */
export const SHARED_PLUGINS_CHANGED_EVENT = 'canopy:shared-plugins-changed';
/** Dispatched on `window` after an agent share is unshared from Marketplace. */
export const SHARED_AGENTS_CHANGED_EVENT = 'canopy:shared-agents-changed';
const AGENTS_CRUD_CAPABILITY = 'agents-crud-v1';
const PLUGINS_CRUD_CAPABILITY = 'plugins-crud-v1';
const TEMPLATES_CRUD_CAPABILITY = 'workspace-templates-v1';

export interface SharedMarketplaceSharesOptions {
  /**
   * The cloud account another Marketplace list already loaded. This hook
   * never reads the account itself, so listing two more kinds adds no account
   * read at mount.
   */
  account: CanopyCloudAccountPublicState | null;
  /** List shared agents: the Agents flag is on and the tab shows them. */
  agents: boolean;
  /** List shared plugins: the tab shows them. */
  plugins: boolean;
  /** List project templates shared with a team or organization. */
  templates?: boolean;
  /** Narrows the agents page on the server; plugins are filtered locally. */
  query?: string;
  /**
   * `'me'` lists only the viewer's own shares, filtered on the server
   * ("Shared by me", CAN-4263). Unset lists every share in reach.
   */
  createdBy?: 'me';
}

export interface SharedMarketplaceShares {
  sharedAgents: SharedAgentSummary[];
  sharedPlugins: SharedPluginSummary[];
  sharedBlueprints: WorkspaceTemplateShareSummary[];
  loading: boolean;
  agentsError: string | null;
  pluginsError: string | null;
  templatesError: string | null;
  /** Reload the shared agents page, after a share or public-link change. */
  refreshAgents: () => void;
}

interface KindState<T> {
  rows: T[];
  loading: boolean;
  error: string | null;
}

function emptyState<T>(): KindState<T> {
  return { rows: [], loading: false, error: null };
}

function canLoad(
  account: CanopyCloudAccountPublicState | null,
  capability: string,
): boolean {
  return (
    account !== null &&
    isCanopyCloudConnected(account) &&
    account.capabilities.includes(capability)
  );
}

/**
 * Agents and plugin references shared with the viewer, for the Marketplace.
 *
 * Read-only and deliberately small: the first page of each kind, loaded only
 * while its tab (or All) is showing, and reloaded when the account, the
 * sidebar context, or the search changes, or a plugin share changes here. A kind that is disabled, or that
 * the account cannot read, holds no rows and makes no call. Shared agents
 * follow their cursor up to {@link MAX_SHARED_AGENT_PAGES} pages, since local
 * copies fold their shares away; search reaches the rest on the server.
 */
export function useSharedMarketplaceShares({
  account,
  agents,
  plugins,
  templates,
  query,
  createdBy,
}: SharedMarketplaceSharesOptions): SharedMarketplaceShares {
  const contextGeneration = useWorkspaceContextStore(
    (state) => state.appliedGeneration,
  );
  const [agentState, setAgentState] =
    useState<KindState<SharedAgentSummary>>(emptyState);
  const [pluginState, setPluginState] =
    useState<KindState<SharedPluginSummary>>(emptyState);
  const [templateState, setTemplateState] =
    useState<KindState<WorkspaceTemplateShareSummary>>(emptyState);

  const accountId = account?.account?.id ?? null;
  const accountRevision = account?.updatedAt;
  const personalOrganizationId = account?.personalOrganizationId ?? null;
  const loadAgents = agents && canLoad(account, AGENTS_CRUD_CAPABILITY);
  const loadPlugins = plugins && canLoad(account, PLUGINS_CRUD_CAPABILITY);
  const loadTemplates =
    templates && canLoad(account, TEMPLATES_CRUD_CAPABILITY);
  const normalizedQuery = query?.trim() || undefined;

  // An agent unshared in this window drops from the list without a remount;
  // the new read retires any older one still in flight.
  const [agentRefresh, setAgentRefresh] = useState(0);
  const refreshAgents = useCallback(
    (): void => setAgentRefresh((count) => count + 1),
    [],
  );
  useEffect(() => {
    window.addEventListener(SHARED_AGENTS_CHANGED_EVENT, refreshAgents);
    return (): void =>
      window.removeEventListener(SHARED_AGENTS_CHANGED_EVENT, refreshAgents);
  }, [refreshAgents]);

  const agentSeq = useRef(0);
  useEffect(() => {
    const seq = agentSeq.current + 1;
    agentSeq.current = seq;
    if (!loadAgents) {
      setAgentState(emptyState());
      return;
    }
    setAgentState({ rows: [], loading: true, error: null });
    const read = async (): Promise<SharedAgentSummary[]> => {
      const rows = new Map<string, SharedAgentSummary>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        pages += 1;
        const response = await window.agents.listShared({
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
          ...(createdBy ? { createdBy } : {}),
        });
        if (agentSeq.current !== seq) return [];
        for (const row of response.agents) rows.set(row.id, row);
        cursor = response.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor))
          throw new Error("Couldn't load shared model presets. Try again.");
        if (cursor) cursors.add(cursor);
      } while (cursor && pages < MAX_SHARED_AGENT_PAGES);
      return Array.from(rows.values());
    };
    void read()
      .then((rows) => {
        if (agentSeq.current !== seq) return;
        setAgentState({ rows, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (agentSeq.current !== seq) return;
        setAgentState({
          rows: [],
          loading: false,
          error: resolveSharedResourceErrorMessage(error, {
            unsupportedResource: 'agents',
          }),
        });
      });
    return (): void => {
      agentSeq.current += 1;
    };
  }, [
    accountId,
    accountRevision,
    personalOrganizationId,
    contextGeneration,
    loadAgents,
    normalizedQuery,
    agentRefresh,
    createdBy,
  ]);

  // A plugin share made in this window lists without waiting for a remount.
  const [pluginRefresh, setPluginRefresh] = useState(0);
  useEffect(() => {
    const refresh = (): void => setPluginRefresh((count) => count + 1);
    window.addEventListener(SHARED_PLUGINS_CHANGED_EVENT, refresh);
    return (): void =>
      window.removeEventListener(SHARED_PLUGINS_CHANGED_EVENT, refresh);
  }, []);

  const pluginSeq = useRef(0);
  useEffect(() => {
    const seq = pluginSeq.current + 1;
    pluginSeq.current = seq;
    if (!loadPlugins) {
      setPluginState(emptyState());
      return;
    }
    setPluginState({ rows: [], loading: true, error: null });
    window.plugins
      .listShared({
        serverId: CANOPY_CLOUD_SERVER_ID,
        ...(createdBy ? { createdBy } : {}),
      })
      .then((result) => {
        if (pluginSeq.current !== seq) return;
        if (!result.success || !result.data) {
          setPluginState({
            rows: [],
            loading: false,
            error: result.error ?? 'Shared plugins could not be loaded.',
          });
          return;
        }
        setPluginState({
          rows: result.data.data,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (pluginSeq.current !== seq) return;
        setPluginState({
          rows: [],
          loading: false,
          error: resolveSharedResourceErrorMessage(error),
        });
      });
    return (): void => {
      pluginSeq.current += 1;
    };
  }, [
    accountId,
    accountRevision,
    personalOrganizationId,
    contextGeneration,
    loadPlugins,
    pluginRefresh,
    createdBy,
  ]);

  const templateSeq = useRef(0);
  useEffect(() => {
    const seq = templateSeq.current + 1;
    templateSeq.current = seq;
    if (!loadTemplates) {
      setTemplateState(emptyState());
      return;
    }
    setTemplateState({ rows: [], loading: true, error: null });
    window.api.chatProject
      .listSharedTemplates(createdBy ? { createdBy } : undefined)
      .then((result) => {
        if (templateSeq.current !== seq) return;
        setTemplateState({ rows: result.shares, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (templateSeq.current !== seq) return;
        setTemplateState({
          rows: [],
          loading: false,
          error: resolveSharedResourceErrorMessage(error),
        });
      });
    return (): void => {
      templateSeq.current += 1;
    };
  }, [
    accountId,
    accountRevision,
    personalOrganizationId,
    contextGeneration,
    loadTemplates,
    createdBy,
  ]);

  return {
    sharedAgents: agentState.rows,
    sharedPlugins: pluginState.rows,
    sharedBlueprints: templateState.rows,
    loading: agentState.loading || pluginState.loading || templateState.loading,
    agentsError: agentState.error,
    pluginsError: pluginState.error,
    templatesError: templateState.error,
    refreshAgents,
  };
}
