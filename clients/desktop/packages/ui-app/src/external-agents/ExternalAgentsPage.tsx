'use client';

import type { JSX } from 'react';
import { useStore } from 'zustand';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import {
  createExternalAgentsOverviewStore,
  type ExternalAgentsOverviewStore,
} from '@canopy/app-state/external-agents';
import type {
  ExternalAgentComputersClient,
  ExternalAgentsClient,
} from '@canopy/app-core';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import {
  AgentRow,
  ConnectSection,
  ExternalAgentsUnavailable,
  NoticeList,
  SettingsGroup,
  SettingsSection,
  WaitingRows,
} from './external-agents-parts';
import { ExternalAgentsOverviewSkeleton } from './external-agents-skeletons';
import {
  ExternalAgentComputersSection,
  type ExternalAgentsNotify,
} from './external-agents-computers';
import { externalAgentPath } from './paths';
import { useMountedStore } from './use-mounted-store';
import {
  shouldShowConnectComputerNotice,
  useExternalAgentComputers,
  type ExternalAgentComputersState,
} from './use-external-agent-computers';

export type { ExternalAgentsNotify } from './external-agents-computers';

interface ComputersHostProps {
  readonly onOpenPath: (path: string) => void;
  /** Confirms a connected computer through the host's notification stack. */
  readonly notify: ExternalAgentsNotify;
  /**
   * The host can link to the desktop app's download page and this visit
   * isn't from the app. Only the empty Computers state uses it.
   */
  readonly desktopDownloadAvailable: boolean;
}

export type ExternalAgentsPageProps = ComputersHostProps;

interface ComputersSlot {
  readonly client: ExternalAgentComputersClient;
  readonly state: ExternalAgentComputersState;
}

export function ExternalAgentsPage({
  onOpenPath,
  notify,
  desktopDownloadAvailable,
}: ExternalAgentsPageProps): JSX.Element {
  const client = useCanopyClient();
  const capabilities = useCapabilities();
  const externalAgents = client.externalAgents;
  if (capabilities.externalAgents !== true || externalAgents === undefined) {
    return <ExternalAgentsUnavailable />;
  }

  return (
    <ExternalAgentsOverviewContent
      client={externalAgents}
      computersClient={externalAgents.computers}
      onOpenPath={onOpenPath}
      notify={notify}
      desktopDownloadAvailable={desktopDownloadAvailable}
    />
  );
}

/**
 * Owns the Computers list across the skeleton and the view, so it loads in
 * parallel with the overview and is fetched once.
 */
function ExternalAgentsOverviewContent({
  client,
  computersClient,
  ...host
}: ComputersHostProps & {
  readonly client: ExternalAgentsClient;
  readonly computersClient: ExternalAgentComputersClient | undefined;
}): JSX.Element {
  const store = useMountedStore(client, 'overview', (agents) =>
    createExternalAgentsOverviewStore(agents),
  );
  const computersState = useExternalAgentComputers(computersClient);
  if (store === null) {
    return (
      <div
        data-testid="external-agents-page"
        className="flex w-full flex-col pb-16"
      >
        <ExternalAgentsOverviewSkeleton />
      </div>
    );
  }
  return (
    <ExternalAgentsOverviewView
      store={store}
      computers={
        computersClient === undefined
          ? undefined
          : { client: computersClient, state: computersState }
      }
      {...host}
    />
  );
}

function ExternalAgentsOverviewView({
  store,
  computers,
  onOpenPath,
  notify,
  desktopDownloadAvailable,
}: ComputersHostProps & {
  readonly store: ExternalAgentsOverviewStore;
  readonly computers: ComputersSlot | undefined;
}): JSX.Element {
  const state = useStore(store);

  const overview = state.overview;
  const isInitialLoading = overview === null && state.status !== 'problem';

  return (
    <div
      data-testid="external-agents-page"
      className="flex w-full flex-col gap-10 pb-16"
    >
      {state.status !== 'loading' && state.problem !== null ? (
        <Notice
          intent="attention"
          actions={
            <NoticeButton
              variant="secondary"
              data-testid="external-agents-retry"
              onClick={(): void => void state.load()}
            >
              Try again
            </NoticeButton>
          }
          data-testid="external-agents-error"
        >
          Couldn’t load your agents.
        </Notice>
      ) : null}

      {overview ? (
        <NoticeList notices={overview.notices} onOpenPath={onOpenPath} />
      ) : null}

      {overview && overview.waiting.length > 0 ? (
        <SettingsSection
          title="Waiting for you"
          description="An agent asked to do something that needs your confirmation."
          testId="external-agents-waiting"
        >
          <WaitingRows
            waiting={overview.waiting}
            onOpenPath={onOpenPath}
            showAgent
          />
        </SettingsSection>
      ) : null}

      {overview && overview.connections.length > 0 ? (
        <SettingsSection title="Agents" testId="external-agents-list">
          <SettingsGroup>
            {overview.connections.map((connection) => (
              <AgentRow
                key={connection.id}
                connection={connection}
                onOpen={(): void =>
                  onOpenPath(externalAgentPath(connection.id))
                }
              />
            ))}
          </SettingsGroup>
          {shouldShowConnectComputerNotice(
            overview.connections,
            computers?.state,
          ) ? (
            <Notice
              intent="attention"
              data-testid="external-agents-connect-computer-notice"
            >
              Your agents can’t work on a computer yet. Connect one under
              Computers.
            </Notice>
          ) : null}
        </SettingsSection>
      ) : null}

      {computers && !isInitialLoading ? (
        <ExternalAgentComputersSection
          client={computers.client}
          state={computers.state}
          onOpenPath={onOpenPath}
          notify={notify}
          desktopDownloadAvailable={desktopDownloadAvailable}
        />
      ) : null}

      {overview ? (
        <ConnectSection
          servers={overview.servers}
          cursorClientId={overview.cursorClientId}
          showComputersHint={computers !== undefined}
        />
      ) : isInitialLoading ? (
        <ExternalAgentsOverviewSkeleton />
      ) : null}
    </div>
  );
}
