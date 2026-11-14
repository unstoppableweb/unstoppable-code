import { SettingsChartLoading } from '@canopy/ui-app/settings/pages';
import {
  AskUserQuestionPreparingRow,
  Heading,
  Surface,
} from '@canopy/ui-shared/components';
import { useState, type JSX } from 'react';
import {
  BusyLabel,
  Button,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  InlineTextSkeleton,
  LoadingButton,
  LoadingIndicatorStyleProvider,
  LoadingSpinner,
  PickerMenuSampleOptions,
  Skeleton,
  SKELETON_KEEP,
  SlowLoadNote,
  type SpinnerTone,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const SPINNER_TONES: readonly SpinnerTone[] = [
  'primary',
  'secondary',
  'tertiary',
  'accent',
  'warning',
  'destructive',
];

function SampleAgentCard(): JSX.Element {
  return (
    <Surface variant="outline" padding="default" gap="item" className="w-full">
      <Heading level={3} variant="title" {...SKELETON_KEEP}>
        Connected agents
      </Heading>
      {['Release notes writer', 'Support triage'].map((name) => (
        <div key={name} className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs fg-accent-strong">
            {name.slice(0, 1)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-s fg-primary">{name}</span>
            <span className="text-xs fg-secondary">Last run 2 hours ago</span>
          </div>
          <Button size="compact">Open</Button>
        </div>
      ))}
    </Surface>
  );
}

export function LoadingSpecimen(): JSX.Element {
  const [busy, setBusy] = useState(true);
  const [replay, setReplay] = useState(0);
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="Inline text: a bar on the text's own line">
        <SpecimenCell
          label="InlineTextSkeleton (active), inside a sentence"
          wide
        >
          <p className="text-s fg-secondary">
            Last synced <InlineTextSkeleton active className="w-16" /> by the
            daemon.
          </p>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Waiting on the agent's question">
        <SpecimenCell
          label="AskUserQuestionPreparingRow: one line, as wide as its text, in a shrink-to-fit message column"
          wide
        >
          <div className="flex min-w-0 max-w-full flex-col items-start">
            <AskUserQuestionPreparingRow />
          </div>
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Skeleton: measured by skullet from the content's own layout">
        <SpecimenGrid min={300}>
          <SpecimenCell label="Loading (sample data, the heading kept)">
            <Skeleton loading className="w-full">
              <SampleAgentCard />
            </Skeleton>
          </SpecimenCell>
          <SpecimenCell label="Loaded">
            <Skeleton loading={false} className="w-full">
              <SampleAgentCard />
            </Skeleton>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Skeleton around shared sample content">
        <SpecimenGrid min={260}>
          <SpecimenCell label="PickerMenuSampleOptions, leading icon rail">
            <Skeleton loading className="w-full">
              <PickerMenuSampleOptions rows={3} />
            </Skeleton>
          </SpecimenCell>
          <SpecimenCell label="PickerMenuSampleOptions, no rail">
            <Skeleton loading className="w-full">
              <PickerMenuSampleOptions rows={3} leading={false} />
            </Skeleton>
          </SpecimenCell>
        </SpecimenGrid>
        <SpecimenCell label="SettingsChartLoading" wide>
          <SettingsChartLoading />
        </SpecimenCell>
      </SpecimenPanel>
      <SpecimenPanel title="Busy controls: the spinner lives in the control whose work runs">
        <SpecimenGrid min={200}>
          <SpecimenCell label="LoadingButton, busy keeps its width">
            <LoadingButton
              variant="primary"
              loading={busy}
              loadingLabel="Applying…"
              onClick={(): void => setBusy(!busy)}
            >
              Apply
            </LoadingButton>
          </SpecimenCell>
          <SpecimenCell label="LoadingButton at rest">
            <LoadingButton onClick={(): void => setBusy(!busy)}>
              Apply
            </LoadingButton>
          </SpecimenCell>
          <SpecimenCell label="BusyLabel, text style (default)">
            <BusyLabel busy busyText="Loading more…">
              Load more
            </BusyLabel>
          </SpecimenCell>
          <SpecimenCell label="BusyLabel, spinner style">
            <LoadingIndicatorStyleProvider value="spinner">
              <BusyLabel busy>Load more</BusyLabel>
            </LoadingIndicatorStyleProvider>
          </SpecimenCell>
        </SpecimenGrid>
        <SpecimenGrid min={110}>
          {SPINNER_TONES.map((tone) => (
            <SpecimenCell key={tone} label={`LoadingSpinner ${tone}`}>
              <LoadingSpinner tone={tone} />
            </SpecimenCell>
          ))}
        </SpecimenGrid>
      </SpecimenPanel>
      <SpecimenPanel title="Where no skeleton fits: nothing for 200ms, a spinner, then a slow note">
        <SpecimenCell
          label="DelayedLoadingPlaceholder (slow note after 2s here; 8s in the app)"
          wide
        >
          <div className="flex w-full flex-col gap-2">
            <div className="h-24 w-full">
              <DelayedLoadingPlaceholder
                key={replay}
                slowNote="Still loading plugin…"
                slowAfterMs={2000}
              >
                <CenteredLoadingSpinner />
              </DelayedLoadingPlaceholder>
            </div>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Replay the sequence">
          <Button size="compact" onClick={(): void => setReplay(replay + 1)}>
            Replay
          </Button>
        </SpecimenCell>
        <SpecimenCell label="SlowLoadNote on its own" wide>
          <SlowLoadNote show>Still loading workflows…</SlowLoadNote>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}
