import { useState, type JSX } from 'react';
import {
  ColorSwatchPicker,
  SIDEBAR_ITEM_GROUP_SWATCHES,
  WORKSPACE_COLOR_PALETTE,
} from '@canopy/ui-shared/components';
import { SpecimenPanel } from './componentsLabParts';

/**
 * The shared color chooser in every state. Each swatch is a radio named by
 * the color it renders in, so switching the app's theme renames the group
 * swatches with their hues (CAN-6407).
 */
export function ColorSwatchesSpecimen(): JSX.Element {
  const [group, setGroup] = useState<string>('categorical-2');
  const [project, setProject] = useState<string>(WORKSPACE_COLOR_PALETTE[2]);
  const [unset, setUnset] = useState<string | undefined>(undefined);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Sidebar group: theme colors, named by hue">
        <ColorSwatchPicker
          value={group}
          onChange={setGroup}
          palette={SIDEBAR_ITEM_GROUP_SWATCHES}
          label="Group color"
        />
      </SpecimenPanel>
      <SpecimenPanel title="Project: fixed palette, two blues told apart as light and dark">
        <ColorSwatchPicker
          value={project}
          onChange={setProject}
          label="Project color"
        />
      </SpecimenPanel>
      <SpecimenPanel title="Nothing chosen yet: the first swatch takes focus">
        <ColorSwatchPicker value={unset} onChange={setUnset} />
      </SpecimenPanel>
      <SpecimenPanel title="Compact, in a settings row">
        <ColorSwatchPicker
          size="compact"
          value={project}
          onChange={setProject}
          label="Project color"
        />
      </SpecimenPanel>
      <SpecimenPanel title="Disabled while saving">
        <ColorSwatchPicker
          disabled
          value={project}
          onChange={setProject}
          label="Project color"
        />
      </SpecimenPanel>
    </div>
  );
}
