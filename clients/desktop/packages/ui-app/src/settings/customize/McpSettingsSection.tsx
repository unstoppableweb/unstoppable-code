'use client';

import type { JSX } from 'react';
import { summarizeInstalledMcpServers } from '@canopy/protocol/installed-items';
import {
  Button,
  InstalledItemsSyncedAt,
  MANAGE_IN_CUSTOMIZE_LABEL,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  Skeleton,
  StatusLabel,
  SyncedInventoryPausedNotice,
} from '@canopy/ui-shared/components';
import {
  installedMcpServersSummaryText,
  type InstalledItemSnapshotState,
} from '@canopy/ui-shared/lib';
import {
  useCustomizeSettingsPort,
  type CustomizeSettingsPort,
} from './customize-settings-port';

/** The counts the loading line is measured from: a typical summary. */
const SAMPLE_SUMMARY = { installed: 3, active: 1 };

function McpServersLine({
  state,
}: {
  readonly state: InstalledItemSnapshotState;
}): JSX.Element {
  switch (state.kind) {
    case 'loading':
      return (
        <Skeleton loading label="Loading MCP servers" className="inline-block">
          <span>{installedMcpServersSummaryText(SAMPLE_SUMMARY)}</span>
        </Skeleton>
      );
    case 'error':
      return <StatusLabel>{state.message}</StatusLabel>;
    case 'unsupported':
      return <span className="fg-tertiary">{state.reason}</span>;
    case 'ready': {
      const summary = summarizeInstalledMcpServers(state.snapshot);
      return (
        <>
          <span
            className={summary.installed > 0 ? 'fg-primary' : 'fg-tertiary'}
          >
            {installedMcpServersSummaryText(summary)}
          </span>
          {state.syncedAt !== undefined ? (
            <InstalledItemsSyncedAt
              syncedAt={state.syncedAt}
              testId="settings-mcp-synced-at"
            />
          ) : null}
        </>
      );
    }
  }
}

function McpSettingsContent({
  port: { useInstalledItemSnapshotState: useSnapshotState, openCustomize },
}: {
  readonly port: CustomizeSettingsPort;
}): JSX.Element {
  const state = useSnapshotState();
  return (
    <SettingsRowsSection title="Installed MCP servers">
      {/* Only a synced copy carries a pause (web); desktop never sets it. */}
      {state.kind === 'ready' && state.syncPaused ? (
        <SyncedInventoryPausedNotice deviceName={state.syncPaused.deviceName} />
      ) : null}
      <SettingsRowsGroup>
        <SettingsRowsRow
          dataTestId="settings-mcp-summary"
          label={<McpServersLine state={state} />}
          control={
            <Button
              size="compact"
              variant="secondary"
              data-testid="settings-mcp-manage"
              onClick={(): void => {
                openCustomize('mcp');
              }}
            >
              {MANAGE_IN_CUSTOMIZE_LABEL}
            </Button>
          }
        />
      </SettingsRowsGroup>
    </SettingsRowsSection>
  );
}

/**
 * Settings → MCP servers: how many are installed and active, read-only, with
 * the way into Customize. Shared by desktop Settings and web account settings;
 * the host supplies the snapshot and the hand-off through
 * `CustomizeSettingsPortProvider`.
 */
export function McpSettingsSection(): JSX.Element | null {
  const port = useCustomizeSettingsPort();
  return port === null ? null : <McpSettingsContent port={port} />;
}
