import { type JSX, useEffect, useRef, useState } from 'react';
import { Button, ProgressBar, StatusLabel } from '@canopy/ui-shared/components';
import {
  formatModelSize,
  percentOf,
  useSpeechModelStatus,
} from '@/hooks/useSpeechModelStatus';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

/**
 * The speech model the Linux dictation helper needs (CAN-7231): its size, a
 * download with progress, and "Remove speech model". Hosts whose dictation
 * uses the system's speech assets report `unsupported`, and the section
 * renders nothing.
 */
export function SpeechModelSection({
  onInstalledChange,
}: {
  /** Called when the model becomes installed or stops being installed. */
  readonly onInstalledChange?: () => void;
}): JSX.Element | null {
  // Polls only once the first read says this host manages a model.
  const [managed, setManaged] = useState(false);
  const { status, readError, busy, actionError, act } = useSpeechModelStatus({
    fetchOnMount: true,
    poll: managed,
  });
  useEffect(() => {
    setManaged(status !== null && status.state !== 'unsupported');
  }, [status]);

  // Tell the page when installation changes, so its Compatibility row
  // re-checks support.
  const installedNow = status?.state === 'installed';
  const installedBefore = useRef<boolean | null>(null);
  useEffect(() => {
    if (status === null) return;
    if (
      installedBefore.current !== null &&
      installedBefore.current !== installedNow
    ) {
      onInstalledChange?.();
    }
    installedBefore.current = installedNow;
  }, [status, installedNow, onInstalledChange]);

  if (!status || status.state === 'unsupported' || !status.model) return null;
  const { model } = status;
  const size = formatModelSize(model.sizeBytes);

  const install = (): void =>
    void act(() => window.api.voice.speechModel.install());
  const cancel = (): void =>
    void act(() => window.api.voice.speechModel.cancel());
  const remove = (): void =>
    void act(() => window.api.voice.speechModel.remove());
  const removeButton = (
    <Button
      size="compact"
      variant="secondary"
      onClick={remove}
      disabled={busy}
      data-testid="dictation-model-remove"
    >
      Remove speech model
    </Button>
  );

  let description: JSX.Element;
  let control: JSX.Element | null = null;
  switch (status.state) {
    case 'installed':
      description = (
        <span className="font-medium fg-success">
          Downloaded. Dictation works offline.
        </span>
      );
      control = removeButton;
      break;
    case 'downloading':
    case 'verifying': {
      const percent = percentOf(status);
      const received = formatModelSize(status.progress?.receivedBytes ?? 0);
      const label =
        status.state === 'verifying' ? 'Checking files' : 'Downloading';
      description = (
        <span className="flex flex-col gap-1.5">
          <span>
            {label}… {received} of {size}
          </span>
          <ProgressBar
            value={percent}
            label={`${label} the speech model`}
            hideLabel
            size="compact"
            valueText={`${percent}%`}
            dataTestId="dictation-model-progress"
          />
        </span>
      );
      control = (
        <Button
          size="compact"
          variant="secondary"
          onClick={cancel}
          disabled={busy}
          data-testid="dictation-model-cancel"
        >
          Cancel download
        </Button>
      );
      break;
    }
    case 'failed':
      description = (
        <StatusLabel>
          {status.failure?.code === 'sourceUnavailable'
            ? 'This build has no download location for the speech model.'
            : `Download failed. ${status.failure?.message ?? ''}`.trim()}
        </StatusLabel>
      );
      if (status.sourceConfigured) {
        control = (
          <Button
            size="compact"
            variant="secondary"
            onClick={install}
            disabled={busy}
            data-testid="dictation-model-retry"
          >
            Try again
          </Button>
        );
      }
      break;
    case 'notInstalled':
    default:
      description = status.sourceConfigured ? (
        <span>Not downloaded. Dictation needs it to run.</span>
      ) : (
        <StatusLabel>
          This build has no download location for the speech model.
        </StatusLabel>
      );
      if (status.sourceConfigured) {
        control = (
          <Button
            size="compact"
            variant="primary"
            onClick={install}
            disabled={busy}
            data-testid="dictation-model-download"
          >
            Download ({size})
          </Button>
        );
      }
      break;
  }
  // Files of an older model, or a partial download a cancel kept, stay until
  // this model installs; let the person delete them from here too.
  if (
    status.extraFilesStored &&
    (status.state === 'notInstalled' || status.state === 'failed')
  ) {
    control = (
      <span className="flex gap-2">
        {control}
        {removeButton}
      </span>
    );
  }

  return (
    <SettingsSection
      title="Speech model"
      description={`Dictation runs on this computer with a speech model you download once (${size}, ${model.license} license). After that it works offline.`}
    >
      <SettingsGroup>
        <SettingsRow
          label={model.displayName}
          description={
            <span
              className="flex flex-col gap-1"
              data-testid="dictation-model-status"
            >
              {description}
              {(readError ?? actionError) ? (
                <StatusLabel>{readError ?? actionError}</StatusLabel>
              ) : null}
            </span>
          }
          control={control ?? undefined}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
