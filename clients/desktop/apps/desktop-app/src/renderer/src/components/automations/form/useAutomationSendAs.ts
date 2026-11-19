import { useEffect, useMemo, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { choseOtherSignIn } from '@canopy/desktop-shared/lib/automation-accounts';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { McpServerRef } from '@canopy/protocol/mcp-servers';
import {
  excludeDisabledInstalledItems,
  installedItemKey,
} from '@canopy/protocol/installed-items';
import {
  automationSendAsConnectors,
  type AutomationSendAsConnection,
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
 * The automation form's "Send as" connectors (CAN-6233): the ones its
 * selections use, directly, through what the target inherits, or through its
 * collections or plugins, that the person holds several accounts of. Reads the account list
 * once and the plugins' servers whenever the plugins change. A read that
 * fails is reported and asks for no choice; the run's own check still stops
 * a run that cannot pick an account.
 */
export function useAutomationSendAs(
  selections: ChatTabPluginSelections,
  inherited: ChatTabPluginSelections | undefined,
  active: boolean,
): AutomationSendAsConnector[] {
  const [connections, setConnections] = useState<
    readonly AutomationSendAsConnection[]
  >([]);
  const [pluginKeys, setPluginKeys] = useState<readonly string[]>([]);
  const [collectionRefs, setCollectionRefs] = useState<readonly McpServerRef[]>(
    [],
  );
  // Turned-off items the run never loads (`null` until read).
  const [disabledKeys, setDisabledKeys] = useState<readonly string[] | null>(
    null,
  );

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
    window.mcpServers
      .listAccountConnections()
      .then((rows): void => {
        if (current) setConnections(rows);
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
      });
    return (): void => {
      current = false;
    };
  }, [active]);

  const ownCollections = selections.collectionIds;
  const ownPlugins = selections.pluginRefs;
  const inheritedCollections = inherited?.collectionIds;
  const inheritedPlugins = inherited?.pluginRefs;
  const authPreferences =
    selections.mcpHttpAuthPreferences ?? inherited?.mcpHttpAuthPreferences;
  useEffect(() => {
    if (!active || disabledKeys === null) return;
    let current = true;
    // What the run loads: turned-off collections and plugins drop out, as
    // the run's own filter drops them.
    const loaded = excludeDisabledInstalledItems(
      {
        collectionIds: [...ownCollections, ...(inheritedCollections ?? [])],
        pluginRefs: [...ownPlugins, ...(inheritedPlugins ?? [])],
        skillRefs: [],
      },
      disabledKeys,
    );
    collectionMcpRefs(loaded.collectionIds)
      .then((refs): void => {
        if (current) setCollectionRefs(refs);
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
        if (current) setCollectionRefs([]);
      });
    pluginCuratedKeys({
      collectionIds: loaded.collectionIds,
      skillRefs: [],
      pluginRefs: loaded.pluginRefs,
      ...(authPreferences ? { mcpHttpAuthPreferences: authPreferences } : {}),
    })
      .then((keys): void => {
        if (current) setPluginKeys(keys);
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
        if (current) setPluginKeys([]);
      });
    return (): void => {
      current = false;
    };
  }, [
    active,
    ownCollections,
    ownPlugins,
    inheritedCollections,
    inheritedPlugins,
    authPreferences,
    disabledKeys,
  ]);

  return useMemo(
    (): AutomationSendAsConnector[] =>
      active
        ? automationSendAsConnectors({
            ownRefs: selections.mcpServerRefs ?? [],
            inheritedRefs: inherited?.mcpServerRefs ?? [],
            collectionRefs,
            pluginCuratedKeys: pluginKeys,
            connections,
          })
        : [],
    [active, selections, inherited, collectionRefs, pluginKeys, connections],
  );
}
