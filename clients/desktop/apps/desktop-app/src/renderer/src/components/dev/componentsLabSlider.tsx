import { useState, type JSX } from 'react';
import { Slider } from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const LEVELS = ['None', 'Low', 'Medium', 'High', 'Max'] as const;
const LONG_LEVELS = [
  'Fastest replies, with the lightest thinking the model offers',
  'A balance of speed and depth for most of the work you do here',
  'The deepest thinking available, for hard problems with many parts',
] as const;

function LiveSlider({
  levels = LEVELS,
  initial,
  disabled = false,
  preview = true,
}: {
  readonly levels?: readonly string[];
  readonly initial: number;
  readonly disabled?: boolean;
  /** Follow a drag as it moves, as the effort panel does. */
  readonly preview?: boolean;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const name = levels[shown] ?? 'Default';
  return (
    <div className="flex w-full flex-col gap-2">
      <span className="min-w-0 truncate text-xs fg-primary">{name}</span>
      <Slider
        value={shown}
        stops={levels.length}
        label="Effort"
        valueText={name}
        disabled={disabled}
        onChange={(next): void => {
          setDraft(null);
          setValue(next);
        }}
        {...(preview ? { onPreview: setDraft } : {})}
      />
    </div>
  );
}

function FocusedSlider(): JSX.Element {
  return (
    <div
      ref={(element): void => {
        element
          ?.querySelector<HTMLElement>('[role="slider"]')
          ?.focus({ preventScroll: true });
      }}
      className="w-full"
    >
      <LiveSlider initial={2} />
    </div>
  );
}

export function SliderSpecimen(): JSX.Element {
  return (
    <SpecimenPanel>
      <SpecimenGrid min={240}>
        <SpecimenCell label="Middle stop: drag, click, arrows, Home, End">
          <LiveSlider initial={2} />
        </SpecimenCell>
        <SpecimenCell label="First stop">
          <LiveSlider initial={0} />
        </SpecimenCell>
        <SpecimenCell label="Last stop">
          <LiveSlider initial={LEVELS.length - 1} />
        </SpecimenCell>
        <SpecimenCell label="No stop selected (value -1)">
          <LiveSlider initial={-1} />
        </SpecimenCell>
        <SpecimenCell label="Focused">
          <FocusedSlider />
        </SpecimenCell>
        <SpecimenCell label="Disabled">
          <LiveSlider initial={2} disabled />
        </SpecimenCell>
        <SpecimenCell label="Two stops">
          <LiveSlider levels={['Off', 'On']} initial={1} />
        </SpecimenCell>
        <SpecimenCell label="One stop (nothing to pick)">
          <LiveSlider levels={['Only level']} initial={0} />
        </SpecimenCell>
        <SpecimenCell label="Long value">
          <LiveSlider levels={LONG_LEVELS} initial={1} />
        </SpecimenCell>
        <SpecimenCell label="No preview: moves when a drag lands">
          <LiveSlider initial={2} preview={false} />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
