import type { JSX } from 'react';
import {
  ComposerSendButton,
  TerminalModeLabel,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const demoAction = (): void => undefined;

export function ComposerActionsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <SpecimenPanel title="Send">
        <SpecimenGrid>
          <SpecimenCell label="Ready">
            <ComposerSendButton
              kind="send"
              onSend={demoAction}
              disabled={false}
              pending={false}
            />
          </SpecimenCell>
          <SpecimenCell label="Empty draft">
            <ComposerSendButton
              kind="send"
              onSend={demoAction}
              disabled
              pending={false}
            />
          </SpecimenCell>
          <SpecimenCell label="Updating model">
            <ComposerSendButton
              kind="send"
              onSend={demoAction}
              disabled={false}
              pending
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Stop">
        <SpecimenGrid>
          <SpecimenCell label="Generating">
            <ComposerSendButton kind="stop" onStop={demoAction} shortcutReady />
          </SpecimenCell>
          <SpecimenCell label="Escape confirmation">
            <ComposerSendButton
              kind="stop"
              onStop={demoAction}
              shortcutReady
              armed
            />
          </SpecimenCell>
          <SpecimenCell label="Updating model">
            <ComposerSendButton kind="stop" onStop={demoAction} pending />
          </SpecimenCell>
          <SpecimenCell label="Unavailable">
            <ComposerSendButton kind="stop" onStop={demoAction} disabled />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Terminal mode">
        <SpecimenGrid min={300}>
          <SpecimenCell label="Empty command">
            <TerminalModeLabel />
            <ComposerSendButton kind="terminal" onRun={demoAction} disabled />
          </SpecimenCell>
          <SpecimenCell label="Ready">
            <div className="flex min-w-0 items-center gap-2">
              <TerminalModeLabel hint="Runs in apps/web" />
              <ComposerSendButton
                kind="terminal"
                onRun={demoAction}
                disabled={false}
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Failed command">
            <div className="flex min-w-0 items-center gap-2">
              <TerminalModeLabel error="Couldn't start the terminal." />
              <div className="shrink-0">
                <ComposerSendButton
                  kind="terminal"
                  onRun={demoAction}
                  disabled={false}
                  failed
                />
              </div>
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
