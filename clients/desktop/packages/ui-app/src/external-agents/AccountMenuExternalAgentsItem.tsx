'use client';

import type { JSX } from 'react';
import { useStore } from 'zustand';
import type { ExternalAgentsClient } from '@canopy/app-core';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import { createExternalAgentsWaitingCountStore } from '@canopy/app-state/external-agents';
import { MenuItem, MenuItemIcon } from '@canopy/ui-shared/components';
import { Bot } from '@canopy/ui-shared/icons/AppIcons';
import { EXTERNAL_AGENTS_LABEL, EXTERNAL_AGENTS_PATH } from './paths';
import { useMountedStore } from './use-mounted-store';

export interface AccountMenuExternalAgentsItemProps {
  /** Opens a hosted page path and closes the menu (web: router push). */
  readonly onOpenPath: (path: string) => void;
}

/** The External agents destination shared by account menus across hosts. */
export function AccountMenuExternalAgentsItem({
  onOpenPath,
}: AccountMenuExternalAgentsItemProps): JSX.Element {
  const client = useCanopyClient();
  const capabilities = useCapabilities();
  const externalAgents = client.externalAgents;
  if (capabilities.externalAgents !== true || externalAgents === undefined) {
    return <ExternalAgentsMenuRow onOpenPath={onOpenPath} />;
  }

  return (
    <ExternalAgentsWaitingCountItem
      client={externalAgents}
      onOpenPath={onOpenPath}
    />
  );
}

function ExternalAgentsWaitingCountItem({
  client,
  onOpenPath,
}: {
  readonly client: ExternalAgentsClient;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const store = useMountedStore(
    client,
    'waiting-count',
    createExternalAgentsWaitingCountStore,
  );
  if (store === null) return <ExternalAgentsMenuRow onOpenPath={onOpenPath} />;
  return (
    <ExternalAgentsWaitingCountValue store={store} onOpenPath={onOpenPath} />
  );
}

function ExternalAgentsWaitingCountValue({
  store,
  onOpenPath,
}: {
  readonly store: ReturnType<typeof createExternalAgentsWaitingCountStore>;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const state = useStore(store);
  return <ExternalAgentsMenuRow onOpenPath={onOpenPath} count={state.count} />;
}

function ExternalAgentsMenuRow({
  onOpenPath,
  count,
}: {
  readonly onOpenPath: (path: string) => void;
  readonly count?: number | null;
}): JSX.Element {
  const waiting = count !== undefined && count !== null && count > 0;
  const accessibleName = waiting
    ? `${EXTERNAL_AGENTS_LABEL}, ${count} ${count === 1 ? 'request' : 'requests'} waiting`
    : undefined;
  return (
    <MenuItem
      onClick={(): void => onOpenPath(EXTERNAL_AGENTS_PATH)}
      data-testid="account-external-agents-row"
      aria-label={accessibleName}
      status={waiting ? 'unread' : undefined}
    >
      <MenuItemIcon>
        <Bot size={14} />
      </MenuItemIcon>
      <span className="min-w-0 flex-1 truncate">{EXTERNAL_AGENTS_LABEL}</span>
      {waiting ? (
        <span
          aria-hidden="true"
          className="shrink-0 text-xs tabular-nums fg-secondary"
        >
          {count}
        </span>
      ) : null}
    </MenuItem>
  );
}
