'use client';

import { useMemo, type JSX } from 'react';
import { countActiveInstalledItems } from '@canopy/protocol/installed-items';
import {
  ActiveItemsSummary,
  SettingsRowsGroup,
  SettingsRowsSection,
  SyncedInventoryPausedNotice,
  type ActiveItemsSummaryState,
} from '@canopy/ui-shared/components';
import type { InstalledItemSnapshotState } from '@canopy/ui-shared/lib';
import {
  useCustomizeSettingsPort,
  type CustomizeSettingsPort,
} from './customize-settings-port';

function summaryStateFor(
  state: InstalledItemSnapshotState,
): ActiveItemsSummaryState {
  switch (state.kind) {
    case 'ready':
      return {
        kind: 'ready',
        counts: countActiveInstalledItems(state.snapshot),
        ...(state.syncedAt !== undefined ? { syncedAt: state.syncedAt } : {}),
      };
    case 'loading':
      return { kind: 'loading' };
    case 'error':
      return { kind: 'error', message: state.message };
    case 'unsupported':
      return { kind: 'unsupported', reason: state.reason };
  }
}

function PluginsSettingsContent({
  port: { useInstalledItemSnapshotState: useSnapshotState, openCustomize },
}: {
  readonly port: CustomizeSettingsPort;
}): JSX.Element {
  const state = useSnapshotState();
  const summary = useMemo(() => summaryStateFor(state), [state]);
  return (
    <SettingsRowsSection
      title="Active items"
      dataTestId="settings-plugins-active"
    >
      {/* Only a synced copy carries a pause (web); desktop never sets it. */}
      {state.kind === 'ready' && state.syncPaused ? (
        <SyncedInventoryPausedNotice deviceName={state.syncPaused.deviceName} />
      ) : null}
      <SettingsRowsGroup>
        <ActiveItemsSummary
          state={summary}
          onManage={(): void => {
            openCustomize('active');
          }}
        />
      </SettingsRowsGroup>
    </SettingsRowsSection>
  );
}

/**
 * Settings → Plugins: what loads into every new chat, read-only, with the way
 * into Customize. Shared by desktop Settings and web account settings; the
 * host supplies the snapshot and the hand-off through
 * `CustomizeSettingsPortProvider`.
 */
export function PluginsSettingsSection(): JSX.Element | null {
  const port = useCustomizeSettingsPort();
  return port === null ? null : <PluginsSettingsContent port={port} />;
}
