import { useState, type JSX } from 'react';
import {
  MemoryPanel,
  MemorySyncSettings,
  type MemorySyncPanelUiState,
  type MemorySyncSettingsUiState,
} from '@canopy/ui-app/local-memory';
import {
  USER_MEMORY_SCOPE,
  desktopMemorySyncClient,
  notifyLocalMemory,
} from '@/client/ipc-local-memory-client';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useDesktopLocalMemoryClient } from '@/hooks/useDesktopLocalMemoryClient';
import {
  MEMORY_SYNC_SETTINGS_UI_STATE_KEY,
  MEMORY_SYNC_VIEW_UI_STATE_KEYS,
  memorySyncSettingsSlice,
  memorySyncViewSlice,
} from '@/lib/current-ui-state/memory-sync-ui-state';
import { LocalMemorySettings } from './LocalMemorySettings';
import { OrgMemorySettings } from './OrgMemorySettings';
import { SettingsGroup, SettingsPage, SettingsSection } from './SettingsLayout';

const USER_SCOPES = [USER_MEMORY_SCOPE];

export function MemoryTab(): JSX.Element {
  const client = useDesktopLocalMemoryClient();
  const [syncUi, setSyncUi] = useState<MemorySyncSettingsUiState | null>(null);
  const [syncView, setSyncView] = useState<MemorySyncPanelUiState | null>(null);
  useCurrentUiStateReporter(
    MEMORY_SYNC_SETTINGS_UI_STATE_KEY,
    memorySyncSettingsSlice(syncUi),
  );
  useCurrentUiStateReporter(
    MEMORY_SYNC_VIEW_UI_STATE_KEYS.settings,
    memorySyncViewSlice(syncView),
  );
  return (
    <SettingsPage
      title="Memory"
      description="Choose what your chats remember and manage knowledge saved about you"
      dataTestId="settings-tab-memory"
    >
      <LocalMemorySettings />
      <MemorySyncSettings
        sync={desktopMemorySyncClient}
        notify={notifyLocalMemory}
        onUiStateChange={setSyncUi}
      />
      <OrgMemorySettings />
      <SettingsSection
        title="Your memories"
        description="Saved on this device and shared across your projects. Project memories are in each project's Memory panel."
        dataTestId="user-memory-settings"
      >
        {/* The Memory panel is the group's one row: search over the list.
            It grows with its memories and scrolls past 576px. */}
        <SettingsGroup>
          <div className="flex max-h-144 flex-col p-2">
            <MemoryPanel
              client={client}
              notify={notifyLocalMemory}
              scopes={USER_SCOPES}
              onSyncViewChange={setSyncView}
            />
          </div>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
