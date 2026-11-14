import { useLayoutEffect } from 'react';
import { bindTerminalClient } from '@canopy/app-state/terminal';
import { cloudTerminalsEnabled } from '@/lib/web-core-scope-capabilities';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { createDesktopCloudTerminalClient } from './cloud-terminal-client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  canopyCloudAccountIdentity,
  isConclusiveAccountRead,
} from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { ipcTerminalClient } from './ipc-terminal-client';

/** Owns the local terminal binding before sibling renderer effects use it. */
export function DesktopTerminalRuntime(): null {
  const cloudTerminals = useFeatureFlagsStore((s) =>
    cloudTerminalsEnabled(s.isEnabled),
  );
  useLayoutEffect(() => {
    const bind = (): (() => void) => {
      if (!cloudTerminals) return bindTerminalClient(ipcTerminalClient);
      const cloud = createDesktopCloudTerminalClient(ipcTerminalClient);
      const unbind = bindTerminalClient(cloud.client);
      return (): void => {
        unbind();
        cloud.dispose();
      };
    };
    // Local terminals remain available while signed out, offline, or waiting
    // for secure storage. Identity changes reset the old lifetime, then bind
    // the same local transport so existing consumers can reacquire their feeds.
    let dispose = bind();
    let active = true;
    let sequence = 0;
    let identity: string | null | undefined;

    const refresh = (initial = false): void => {
      const current = ++sequence;
      void window.api
        .loadCanopyCloudAccount()
        .then((account) => {
          if (
            !active ||
            current !== sequence ||
            !isConclusiveAccountRead(account)
          )
            return;
          const nextIdentity = canopyCloudAccountIdentity(account);
          if (!initial && nextIdentity !== identity) {
            dispose();
            dispose = bind();
          }
          identity = nextIdentity;
        })
        .catch(() => {
          // A failed account read does not sign out the local terminal host.
        });
    };
    const onAccountChanged = (): void => refresh();
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    refresh(true);
    return (): void => {
      active = false;
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        onAccountChanged,
      );
      dispose();
    };
  }, [cloudTerminals]);
  return null;
}
