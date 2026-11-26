import type { JSX } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state/CanopyClientProvider';
import { CopilotConnectionRow } from '@canopy/ui-app/harness-setup';
import { DesktopHarnessSetupHost } from './DesktopHarnessSetupHost';
import { SettingsGroup, SettingsSection } from './SettingsLayout';

interface CopilotConnectionProps {
  /**
   * `row`: one provider row inside the caller's group, as on Accounts beside
   * Claude and Codex. `section` (default): its own untitled section and box,
   * as on Labs.
   */
  readonly placement?: 'row' | 'section';
}

/**
 * The shared GitHub Copilot row (`@canopy/ui-app/harness-setup`); nothing,
 * not even the section, while Copilot is unsupported on this computer.
 */
export function CopilotConnection({
  placement = 'section',
}: CopilotConnectionProps = {}): JSX.Element | null {
  const client = useOptionalCanopyClient()?.harnessSetup?.copilot;
  if (!client) return null;
  return (
    <DesktopHarnessSetupHost>
      <CopilotConnectionRow
        client={client}
        {...(placement === 'row'
          ? {}
          : {
              frame: (row: JSX.Element): JSX.Element => (
                // Untitled: the row itself names Copilot, so a heading would
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
