import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import type { SharedConnectionTool } from '@canopy/protocol/canopy-core';
import type {
  AutomationSharedWritesConnection,
  AutomationSharedWritesTools,
} from '@canopy/ui-app/capability';
import { registeredHostedSettingsClient } from '@/client/hosted-settings-client-registry';

/** A shared connection in force for the project, before its tools load. */
interface InForceConnection {
  readonly id: string;
  readonly name: string;
  readonly limit: readonly string[] | null;
}

type ToolsRead =
  | { readonly kind: 'loaded'; readonly tools: readonly SharedConnectionTool[] }
  | { readonly kind: 'failed' };

export interface AutomationSharedWritesSource {
  /** The project's shared connections in force, each with its tools' read. */
  readonly connections: AutomationSharedWritesConnection[];
  /** Reads one connection's tools again. */
  readonly retry: (connectionId: string) => void;
}

/**
 * The shared connections an automation's scheduled runs may be allowed to
 * write through (CAN-6252), with each one's tools. They are the connections
 * the organization project's shared setup puts in force for everyone in it
 * (`organization.projects.setup`'s `connectors.effective`), available and
 * connected, when the person may use them in the project. Each one's tools
 * come from `organization.settings.connections.tools` with the project, which
 * a person on the project may read. A setup that can't be read is reported
 * and lists nothing: the run still reads, and writes nothing it wasn't
 * allowed. A connection whose tools can't be read says so in the form with a
 * retry, and holds up nothing else.
 */
export function useAutomationSharedWrites(
  owner: WorkspaceOwnerBinding | undefined,
  active: boolean,
): AutomationSharedWritesSource {
  const organizationId = active ? owner?.organizationId : undefined;
  const projectId = active ? owner?.projectId : undefined;
  const key =
    organizationId !== undefined && projectId !== undefined
      ? `${organizationId}/${projectId}`
      : null;
  const [found, setFound] = useState<{
    readonly key: string;
    readonly organizationId: string;
    readonly connections: readonly InForceConnection[];
  } | null>(null);
  const [reads, setReads] = useState<{
    readonly key: string;
    readonly byId: Readonly<Record<string, ToolsRead>>;
  }>({ key: '', byId: {} });
  // The project whose reads may still land; a read for another one is dropped.
  const currentKey = useRef<string | null>(null);

  const readTools = useCallback(
    (
      readKey: string,
      readOrganizationId: string,
      readProjectId: string,
      connectionId: string,
    ): void => {
      const client = registeredHostedSettingsClient();
      const settle = (read: ToolsRead): void => {
        if (currentKey.current !== readKey) return;
        setReads((current) => ({
          key: readKey,
          byId: {
            ...(current.key === readKey ? current.byId : {}),
            [connectionId]: read,
          },
        }));
      };
      if (client === null) {
        settle({ kind: 'failed' });
        return;
      }
      // A failure shows in the form's ErrorBanner, which records it; it is
      // not reported again here.
      client
        .read('organization.settings.connections.tools', {
          organizationId: readOrganizationId,
          connectionId,
          projectId: readProjectId,
        })
        .then(
          (result): void => settle({ kind: 'loaded', tools: result.tools }),
          (): void => settle({ kind: 'failed' }),
        );
    },
    [],
  );

  useEffect(() => {
    if (key === null || organizationId === undefined || projectId === undefined)
      return;
    const client = registeredHostedSettingsClient();
    if (client === null) return;
    currentKey.current = key;
    let current = true;
    client
      .read('organization.projects.setup', { projectId })
      .then((setup): void => {
        if (!current) return;
        const connectors = setup.connectors;
        const seen = new Set<string>();
        const connections: InForceConnection[] =
          connectors === undefined || connectors.canUse === false
            ? []
            : connectors.effective.flatMap(
                ({ item, limit }): InForceConnection[] => {
                  if (
                    !item.available ||
                    item.status !== 'connected' ||
                    seen.has(item.ref.id)
                  )
                    return [];
                  seen.add(item.ref.id);
                  return [{ id: item.ref.id, name: item.name, limit }];
                },
              );
        setFound({
          key,
          organizationId: setup.organizationId,
          connections,
        });
        for (const connection of connections)
          readTools(key, setup.organizationId, projectId, connection.id);
      })
      .catch((error: unknown): void => {
        reportClientAppError(error);
        if (current) setFound({ key, organizationId, connections: [] });
      });
    return (): void => {
      current = false;
      if (currentKey.current === key) currentKey.current = null;
    };
  }, [key, organizationId, projectId, readTools]);

  const retry = useCallback(
    (connectionId: string): void => {
      if (found === null || found.key !== key || projectId === undefined)
        return;
      const readKey = found.key;
      setReads((current) => {
        if (current.key !== readKey) return current;
        const byId = { ...current.byId };
        delete byId[connectionId];
        return { key: readKey, byId };
      });
      readTools(readKey, found.organizationId, projectId, connectionId);
    },
    [found, key, projectId, readTools],
  );

  const connections = useMemo((): AutomationSharedWritesConnection[] => {
    if (key === null || found === null || found.key !== key) return [];
    const byId = reads.key === key ? reads.byId : {};
    return found.connections.map((connection) => {
      const read = byId[connection.id];
      const tools: AutomationSharedWritesTools =
        read === undefined ? { kind: 'loading' } : read;
      return { ...connection, tools };
    });
  }, [key, found, reads]);

  return useMemo(
    (): AutomationSharedWritesSource => ({ connections, retry }),
    [connections, retry],
  );
}
