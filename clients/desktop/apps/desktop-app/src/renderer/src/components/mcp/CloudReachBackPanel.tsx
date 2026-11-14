import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  CloudReachBackActivityView,
  CloudReachBackResult,
  CloudReachBackServerView,
} from '@canopy/desktop-shared/types';
import { useCapabilities } from '@canopy/app-state/CanopyClientProvider';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  CloudReachBackSection,
  type CloudReachBackTool,
} from '@canopy/ui-app/capability';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { useCanopyDesktopCloudChatsEnabled } from '@/hooks/useCanopyDesktopCloudChatsEnabled';
import { withIpcErrorMessage } from '@/lib/ipcErrorMessage';

const RESULT_MESSAGES: Record<
  Extract<CloudReachBackResult, { ok: false }>['reason'],
  string
> = {
  disabled: 'Cloud chats are off on this computer.',
  signed_out: 'Sign in to let cloud chats use this server.',
  rejected: 'This server can’t be allowed in cloud chats.',
  failed: 'This change didn’t go through. Try again.',
};

function settle(result: CloudReachBackResult): void {
  if (!result.ok) throw new Error(RESULT_MESSAGES[result.reason]);
}

/**
 * Whether cloud chats can use this desktop MCP server (CAN-6176 PR 7c), one
 * section per config. Only while the window has `cloudReachBack` and cloud
 * chats are on; main refuses every change otherwise.
 */
export function CloudReachBackPanel({
  serverId,
  serverName,
  configs,
  busy,
}: {
  readonly serverId: string;
  readonly serverName: string;
  readonly configs: readonly { readonly id: string; readonly name: string }[];
  readonly busy: boolean;
}): JSX.Element | null {
  const { cloudReachBack } = useCapabilities();
  const enabled = useCanopyDesktopCloudChatsEnabled();
  // What's shown, and any opt-in, belongs to the account signed in now.
  const accountId = useCanopyCloudAccountState().account?.account?.id ?? null;
  const [servers, setServers] = useState<readonly CloudReachBackServerView[]>(
    [],
  );
  const [calls, setCalls] = useState<readonly CloudReachBackActivityView[]>([]);
  const shown = cloudReachBack === true && enabled && accountId !== null;
  // Each read, and each account change, takes a new generation; a read
  // answers only if it is still the latest, so a late answer for an account
  // signed out since never fills the panel or seeds its dialog.
  const generation = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    const [nextServers, nextCalls] = await Promise.all([
      window.api.cloudReachBack.list(),
      window.api.cloudReachBack.activity(),
    ]);
    if (generation.current !== mine) return;
    setServers(nextServers.filter((item) => item.serverId === serverId));
    setCalls(nextCalls.filter((item) => item.serverId === serverId));
  }, [serverId]);

  useEffect(() => {
    generation.current += 1;
    setServers([]);
    setCalls([]);
    if (!shown) return;
    void reload().catch((caught: unknown) => reportClientAppError(caught));
  }, [reload, shown, accountId]);

  // One loader per config, kept across renders so an open dialog keeps its
  // choices.
  const loaders = useMemo(
    () =>
      new Map(
        configs.map((config) => [
          config.id,
          async (): Promise<readonly CloudReachBackTool[]> => {
            const outcome = await withIpcErrorMessage(() =>
              window.mcpServers.testConnection(serverId, config.id),
            );
            if (!outcome.success) throw new Error(outcome.message);
            return (outcome.tools ?? []).map((tool) => ({ name: tool }));
          },
        ]),
      ),
    [configs, serverId],
  );

  if (!shown || accountId === null) return null;
  return (
    <>
      {configs.map((config) => {
        const allowed = servers.find((item) => item.configId === config.id);
        const name =
          configs.length > 1 ? `${serverName} (${config.name})` : serverName;
        return (
          <CloudReachBackSection
            // Another account closes an open dialog rather than reusing it.
            key={`${accountId}:${config.id}`}
            serverName={name}
            state={
              allowed === undefined
                ? null
                : {
                    enabledTools: allowed.enabledTools,
                    allowWithoutAsking: allowed.allowWithoutAsking,
                    unreachable: allowed.unreachable,
                  }
            }
            loadTools={
              loaders.get(config.id) ??
              ((): Promise<readonly CloudReachBackTool[]> =>
                Promise.resolve([]))
            }
            onAllow={async (selection): Promise<void> => {
              settle(
                await window.api.cloudReachBack.allow({
                  serverId,
                  configId: config.id,
                  displayName: name,
                  enabledTools: selection.enabledTools,
                  allowWithoutAsking: selection.allowWithoutAsking,
                  expectedAccountId: accountId,
                }),
              );
              await reload();
            }}
            onTurnOff={async (): Promise<void> => {
              settle(
                await window.api.cloudReachBack.disallow(serverId, config.id),
              );
              await reload();
            }}
            calls={calls
              .filter((call) => call.configId === config.id)
              .map((call) => ({
                at: call.at,
                chatTitle: call.chat?.title ?? null,
                toolName: call.toolName,
                decision: call.decision,
              }))}
            busy={busy}
          />
        );
      })}
    </>
  );
}
