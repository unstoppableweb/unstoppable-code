import type { JSX } from 'react';
import { SyncedInventoryPausedNotice } from '@canopy/ui-shared/components';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

// The longest computer name the device record allows (256 characters).
const LONG_NAME = `Studio-MacBook-Pro-${'a'.repeat(237)}`;

/** The web's paused-sync notice (CAN-7262) in each naming state. */
export function SyncedInventoryPausedSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="SyncedInventoryPausedNotice">
      <SpecimenCell label="A named computer" wide>
        <div className="w-full">
          <SyncedInventoryPausedNotice deviceName="Studio MacBook Pro" />
        </div>
      </SpecimenCell>
      <SpecimenCell label='No name or a blank name: "this computer"' wide>
        <div className="w-full">
          <SyncedInventoryPausedNotice deviceName={null} />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Long text: a 256-character name wraps" wide>
        <div className="w-80">
          <SyncedInventoryPausedNotice deviceName={LONG_NAME} />
        </div>
      </SpecimenCell>
    </SpecimenPanel>
  );
}
