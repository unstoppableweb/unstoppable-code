import type { JSX } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state/CanopyClientProvider';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { OpenCodeConnectionRow } from '@canopy/ui-app/harness-setup';
import { DesktopHarnessSetupHost } from './DesktopHarnessSetupHost';
import { SettingsGroup, SettingsSection } from './SettingsLayout';

interface OpenCodeConnectionProps {
  /**
   * `row`: one provider row inside the caller's group, as on Accounts beside
   * Claude and Codex. `section` (default): its own untitled section and box,
   * as on Labs.
   */
  readonly placement?: 'row' | 'section';
}

/**
 * The shared OpenCode row (`@canopy/ui-app/harness-setup`). Closing its
 * provider sign-in reloads OpenCode's models on this computer.
 */
export function OpenCodeConnection({
  placement = 'section',
}: OpenCodeConnectionProps = {}): JSX.Element | null {
  const client = useOptionalCanopyClient()?.harnessSetup?.opencode;
  if (!client) return null;
  return (
    <DesktopHarnessSetupHost>
      <OpenCodeConnectionRow
        client={client}
        onSignInClosed={(): void => {
          void window.api.opencodeConnection
            ?.listModels()
            .catch((reason: unknown) => {
              reportClientAppError(reason);
            });
        }}
        {...(placement === 'row'
          ? {}
          : {
              frame: (row: JSX.Element): JSX.Element => (
                // Untitled: the row itself names OpenCode, so a heading would
                // repeat it.
                <SettingsSection>
                  <SettingsGroup>{row}</SettingsGroup>
                </SettingsSection>
              ),
            })}
      />
    </DesktopHarnessSetupHost>
  );
}
