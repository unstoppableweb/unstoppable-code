import { useLayoutEffect } from 'react';
import type { TerminalClient } from '@canopy/app-core';
import { bindTerminalClient } from '@canopy/app-state/terminal';
import { cloudTerminalsEnabled } from '@/lib/web-core-scope-capabilities';
import { recordTerminalOutputApplied } from '@/lib/renderer-diagnostics/recorder';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { createDesktopCloudTerminalClient } from './cloud-terminal-client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  canopyCloudAccountIdentity,
  isConclusiveAccountRead,
} from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { ipcTerminalClient } from './ipc-terminal-client';
import { createWindowTerminalRouter } from './window-terminal-router';

let windowRouter: TerminalClient | null = null;

/**
 * One router per window (CAN-8070): main keeps one grant per terminal for a
 * window, so only one router may order that terminal's route and release.
 */
function localTerminalClient(): TerminalClient {
  windowRouter ??= createWindowTerminalRouter({
    relay: ipcTerminalClient,
    window: window.api.terminalWindow,
    observeOutput: (event, startedAt) =>
      recordTerminalOutputApplied(event.terminalId, event.seq, startedAt),
  });
  return windowRouter;
}

/** Owns the local terminal binding before sibling renderer effects use it. */
export function DesktopTerminalRuntime(): null {
  const cloudTerminals = useFeatureFlagsStore((s) =>
    cloudTerminalsEnabled(s.isEnabled),
  );
  useLayoutEffect(() => {
    // Daemon terminals main grants this window stream on its own connection
    // (CAN-8070); every other terminal keeps main's relay.
    const local = localTerminalClient();
    const bind = (): (() => void) => {
      if (!cloudTerminals) return bindTerminalClient(local);
      const cloud = createDesktopCloudTerminalClient(local);
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
