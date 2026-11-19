import { useEffect, useMemo, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { choseOtherSignIn } from '@canopy/desktop-shared/lib/automation-accounts';
import { legacyAccountMcpConnectionId } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { McpServerRef } from '@canopy/protocol/mcp-servers';
import {
  excludeDisabledInstalledItems,
  installedItemKey,
} from '@canopy/protocol/installed-items';
import type { AccountMcpConnectionSummary } from '@canopy/execution-engine/types/mcp-servers';
import {
  automationSendAsConnectors,
  type AutomationSendAsConnector,
} from '@canopy/ui-app/capability';

/** The curated keys of the servers a selection's plugins bring. */
async function pluginCuratedKeys(
  selections: ChatTabPluginSelections,
): Promise<string[]> {
  if (
    selections.pluginRefs.length === 0 &&
    selections.collectionIds.length === 0
  )
    return [];
  const { servers } = await window.mcpServers.listDetected({ selections });
  // As the run check counts them: every curated server a plugin brings,
  // unless the person chose another sign-in for it.
  return servers.flatMap((server) =>
    server.source === 'plugin' &&
    server.curatedKey !== undefined &&
    !choseOtherSignIn(server)
      ? [server.curatedKey]
      : [],
  );
}

/** The MCP refs the selected collections bring. */
async function collectionMcpRefs(
  collectionIds: readonly string[],
): Promise<McpServerRef[]> {
  const collections = await Promise.all(
    Array.from(new Set(collectionIds), (id) =>
      window.collections.loadCollection(id),
    ),
  );
  return collections.flatMap((collection) => collection?.mcpServers ?? []);
}

/**
 * Refs with a legacy `account:<connectionId>` key read as the connector and
 * account they name, so a choice stored that way is found and shown; a
 * replacement still removes the legacy ref itself.
 */
function canonicalAccountRefs(
  refs: readonly McpServerRef[],
  connections: readonly AccountMcpConnectionSummary[],
): McpServerRef[] {
  return refs.map((ref) => {
    const id = legacyAccountMcpConnectionId(ref.serverId);
    const row =
      id === undefined
        ? undefined
        : connections.find((connection) => connection.id === id);
    return row ? { serverId: row.serverKey, configId: row.configId } : ref;
  });
}

/** One selection a "Send as" choice is asked for, over what it inherits. */
export interface SendAsSelections {
  readonly own: ChatTabPluginSelections;
  readonly inherited?: ChatTabPluginSelections;
}

interface LoadedSendAs {
  readonly collectionRefs: readonly McpServerRef[];
  readonly pluginKeys: readonly string[];
}

/**
 * What a selection's collections and plugins bring that a "Send as" choice
 * reads. A read that fails is reported and brings nothing.
 */
async function loadSendAs(
  { own, inherited }: SendAsSelections,
  disabledKeys: readonly string[],
): Promise<LoadedSendAs> {
  // What the run loads: turned-off collections and plugins drop out, as
  // the run's own filter drops them.
  const loaded = excludeDisabledInstalledItems(
    {
      collectionIds: [
        ...own.collectionIds,
        ...(inherited?.collectionIds ?? []),
      ],
      pluginRefs: [...own.pluginRefs, ...(inherited?.pluginRefs ?? [])],
      skillRefs: [],
    },
    disabledKeys,
  );
  const authPreferences =
    own.mcpHttpAuthPreferences ?? inherited?.mcpHttpAuthPreferences;
  const reported = <T>(read: Promise<T[]>): Promise<T[]> =>
    read.catch((error: unknown): T[] => {
      reportClientAppError(error);
      return [];
    });
  const [collectionRefs, pluginKeys] = await Promise.all([
    reported(collectionMcpRefs(loaded.collectionIds)),
    reported(
      pluginCuratedKeys({
        collectionIds: loaded.collectionIds,
        skillRefs: [],
        pluginRefs: loaded.pluginRefs,
        ...(authPreferences ? { mcpHttpAuthPreferences: authPreferences } : {}),
      }),
    ),
  ]);
  return { collectionRefs, pluginKeys };
}

/** The parts of a selection that change what its collections and plugins bring. */
function loadKey({ own, inherited }: SendAsSelections): string {
  return JSON.stringify([
    own.collectionIds,
    own.pluginRefs,
    inherited?.collectionIds,
    inherited?.pluginRefs,
    own.mcpHttpAuthPreferences ?? inherited?.mcpHttpAuthPreferences,
  ]);
}

/**
 * The "Send as" connectors of each selection (CAN-6233, CAN-7186): the ones
 * it uses, directly, through what it inherits, or through its collections or
 * plugins, that the person holds several accounts of. Reads the account list
 * once and what the collections and plugins bring whenever they change. A
 * read that fails is reported and asks for no choice; the run's own check
 * still stops a run that cannot pick an account.
 */
export function useSendAsConnectorLists(
  entries: readonly SendAsSelections[],
  active: boolean,
  /**
   * Read the selection's own and inherited legacy `account:<connectionId>`
   * refs as their connector, for a caller whose choice also removes them
   * (the Workflow page, CAN-7186).
   */
  { canonicalizeLegacyRefs = false }: { canonicalizeLegacyRefs?: boolean } = {},
): SendAsConnectorLists {
  const [connections, setConnections] = useState<
    readonly AccountMcpConnectionSummary[]
  >([]);
  // Whether the account list has been read, or failed to be.
  const [connectionsRead, setConnectionsRead] = useState(false);
  // Turned-off items the run never loads (`null` until read).
  const [disabledKeys, setDisabledKeys] = useState<readonly string[] | null>(
    null,
  );
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly values: readonly LoadedSendAs[];
  }>({ key: '', values: [] });

  useEffect(() => {
    if (!active) return;
    let current = true;
    const read = (): void => {
      window.installedItems
        .listStatus()
        .then(({ items }): void => {
          if (!current) return;
          setDisabledKeys(
            items.flatMap((item) =>
              item.status === 'disabled' && item.target.kind !== 'mcp-server'
                ? [installedItemKey(item.target)]
                : [],
            ),
          );
        })
        .catch((error: unknown): void => {
          reportClientAppError(error);
          if (current) setDisabledKeys([]);
        });
    };
    read();
    const unsubscribe = window.installedItems.onChanged(read);
    return (): void => {
      current = false;
      unsubscribe();
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    // Each read supersedes the one before; the list is pending until the
    // newest answers, so a Save gate waits for an account added meanwhile.
    let latest = 0;
    const read = (): void => {
      const request = ++latest;
      setConnectionsRead(false);
      window.mcpServers
        .listAccountConnections()
        .then((rows): void => {
          if (!current || request !== latest) return;
          setConnections(rows);
          setConnectionsRead(true);
        })
        .catch((error: unknown): void => {
          reportClientAppError(error);
          if (current && request === latest) setConnectionsRead(true);
        });
    };
    read();
    const unsubscribe = window.mcpServers.onAuthChanged?.(read);
    return (): void => {
      current = false;
      unsubscribe?.();
    };
  }, [active]);

  // Only a change to what the collections and plugins bring reads again; a
  // "Send as" choice changes the refs alone.
  const key = JSON.stringify(entries.map(loadKey));
  const [loadInput, setLoadInput] = useState({ key, entries });
  if (loadInput.key !== key) setLoadInput({ key, entries });
  useEffect(() => {
    if (!active || disabledKeys === null) return;
    let current = true;
    void Promise.all(
      loadInput.entries.map((entry) => loadSendAs(entry, disabledKeys)),
    ).then((values): void => {
      if (current) setLoaded({ key: loadInput.key, values });
    });
    return (): void => {
      current = false;
    };
  }, [active, disabledKeys, loadInput]);

  const ready = active && connectionsRead && loaded.key === key;
  const lists = useMemo(
    (): AutomationSendAsConnector[][] =>
      entries.map((entry, index) => {
        if (!active) return [];
        const values = loaded.key === key ? loaded.values[index] : undefined;
        const refs = (
          list: readonly McpServerRef[] | undefined,
        ): McpServerRef[] =>
          canonicalizeLegacyRefs
            ? canonicalAccountRefs(list ?? [], connections)
            : [...(list ?? [])];
        return automationSendAsConnectors({
          ownRefs: refs(entry.own.mcpServerRefs),
          inheritedRefs: refs(entry.inherited?.mcpServerRefs),
          // An installed collection's legacy ref can't be replaced from here,
          // so it is never shown as the choice.
          collectionRefs: [...(values?.collectionRefs ?? [])],
          pluginCuratedKeys: values?.pluginKeys ?? [],
          connections,
        });
      }),
    [active, entries, loaded, key, connections, canonicalizeLegacyRefs],
  );
  return { lists, ready, connections };
}

export interface SendAsConnectorLists {
  /** Each selection's connectors, in the order given. */
  readonly lists: readonly AutomationSendAsConnector[][];
  /**
   * The account list and what every selection's collections and plugins
   * bring have been read (or failed to be), so the lists are complete.
   */
  readonly ready: boolean;
  /** The person's account connections, as read. */
  readonly connections: readonly AccountMcpConnectionSummary[];
}

/**
 * The automation form's "Send as" connectors (CAN-6233), for its one prompt
 * over the selections its target inherits.
 */
export function useAutomationSendAs(
  selections: ChatTabPluginSelections,
  inherited: ChatTabPluginSelections | undefined,
  active: boolean,
): AutomationSendAsConnector[] {
  const entries = useMemo(
    (): SendAsSelections[] => [
      { own: selections, ...(inherited ? { inherited } : {}) },
    ],
    [selections, inherited],
  );
  return useSendAsConnectorLists(entries, active).lists[0] ?? [];
}
