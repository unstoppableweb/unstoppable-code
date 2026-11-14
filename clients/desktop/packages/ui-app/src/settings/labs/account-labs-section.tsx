'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  accountLabsResponseSchema,
  type AccountLabsExperiment,
} from '@canopy/protocol/experiments';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
  type LabsExperimentRowView,
} from '@canopy/ui-shared/components';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy } from '../errors';
import { LabsSettingsSection } from './LabsSettingsSection';
import {
  LabsSettingsPortProvider,
  type LabsSettingsPort,
} from './labs-settings-port';
import type { SettingsFailure } from '../errors';

const ACCOUNT_LABS_ERROR_SCOPE = 'settings.account.labs';

function parseExperiments(value: unknown): AccountLabsExperiment[] {
  const parsed = accountLabsResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid account Labs response');
  return parsed.data.experiments;
}

/**
 * A sample experiment for the loading state. It never shows: `Skeleton`
 * measures the real section rendered with it into bars.
 */
const SAMPLE_PORT: LabsSettingsPort = {
  rows: [
    {
      id: 'sample-experiment',
      name: 'Sample experiment',
      description: 'Try a page before it ships.',
      checked: false,
      disabled: true,
      group: 'pages',
    },
  ],
  error: null,
  onToggle: () => undefined,
};

/**
 * Account Labs over the `account.labs.*` settings operations, for hosts
 * without a Labs port of their own. The server lists the experiments and
 * resolves each one's state; a switch shows its requested value while the
 * save runs and goes back if the save fails.
 */
export function AccountLabsSection(): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(ACCOUNT_LABS_ERROR_SCOPE);
  const [experiments, setExperiments] = useState<
    AccountLabsExperiment[] | null
  >(null);
  const [pending, setPending] = useState<Readonly<Record<string, boolean>>>({});
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // Bumped by Retry so the load effect runs again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const next = parseExperiments(
          await client.read('account.labs.read', {}),
        );
        if (!active) return;
        setExperiments(next);
        setLoadError(null);
      } catch (caught: unknown) {
        if (active) setLoadError(errorCopy.loadFailure(caught));
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [client, errorCopy, loadAttempt]);

  const retryLoad = useCallback((): void => {
    setLoadError(null);
    setExperiments(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const onToggle = useCallback(
    (experimentId: string, enabled: boolean): void => {
      setPending((current) => ({ ...current, [experimentId]: enabled }));
      setError(null);
      const save = async (): Promise<void> => {
        try {
          const next = parseExperiments(
            await client.write('account.labs.update', {
              experimentId,
              enabled,
            }),
          );
          if (mounted.current) setExperiments(next);
        } catch (caught: unknown) {
          if (mounted.current)
            setError(
              errorCopy.actionFailure(caught, { action: 'save your choice' }),
            );
        } finally {
          if (mounted.current)
            setPending((current) =>
              Object.fromEntries(
                Object.entries(current).filter(([id]) => id !== experimentId),
              ),
            );
        }
      };
      void save();
    },
    [client, errorCopy],
  );

  const rows = useMemo(
    (): LabsExperimentRowView[] =>
      (experiments ?? []).map((experiment) => {
        const requested = pending[experiment.id];
        return {
          id: experiment.id,
          name: experiment.name,
          description: experiment.description,
          checked: requested ?? experiment.enabled,
          disabled: requested !== undefined,
          group: 'pages',
        };
      }),
    [experiments, pending],
  );

  const port = useMemo(
    (): LabsSettingsPort => ({
      rows,
      error: error?.copy ?? null,
      ...(error?.details !== undefined ? { errorDetails: error.details } : {}),
      onToggle,
    }),
    [rows, error, onToggle],
  );

  if (loadError !== null)
    return (
      <ErrorBanner
        errorSource="account-labs-section-load"
        error={loadError?.copy}
        details={loadError?.details}
        onRetry={retryLoad}
      />
    );
  if (experiments === null)
    return (
      <DelayedLoadingPlaceholder>
        <Skeleton
          loading
          label="Loading experiments"
          testId="settings-skeleton-form"
        >
          <LabsSettingsPortProvider value={SAMPLE_PORT}>
            <LabsSettingsSection />
          </LabsSettingsPortProvider>
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  if (experiments.length === 0)
    return (
      <p className="text-s fg-secondary" data-testid="account-labs-empty">
        Nothing to try right now. New experiments show up here.
      </p>
    );
  return (
    <LabsSettingsPortProvider value={port}>
      <LabsSettingsSection />
    </LabsSettingsPortProvider>
  );
}
