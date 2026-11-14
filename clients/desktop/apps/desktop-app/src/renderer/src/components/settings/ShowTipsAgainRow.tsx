import { useEffect, useState, type JSX } from 'react';
import { useOnboardingTipsStore } from '@canopy/app-state';
import { Button, ErrorBanner } from '@canopy/ui-shared/components';
import { useStore } from 'zustand';
import { getPlanModeHintStore, resetPlanModeHint } from '@/lib/planModeHint';
import { SettingsRow } from './SettingsLayout';

/**
 * "Show tips again" (CAN-4904): brings back every onboarding tip the user
 * dismissed, on this desktop and in Portal sessions it serves. Shows only
 * once a contextual tip or the plan hint has been retired.
 */
export function ShowTipsAgainRow(): JSX.Element | null {
  const planHintRetired = useStore(getPlanModeHintStore(), (state) =>
    Boolean(state.record?.dismissedAt || state.record?.triedAt),
  );
  const status = useOnboardingTipsStore((state) => state.status);
  const dismissed = useOnboardingTipsStore((state) => state.dismissed);
  const load = useOnboardingTipsStore((state) => state.load);
  const reset = useOnboardingTipsStore((state) => state.reset);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  const hasDismissed = Object.keys(dismissed).length > 0;
  if (
    status !== 'ready' ||
    (!hasDismissed && !planHintRetired && error === null)
  )
    return null;

  const showAgain = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await reset();
      await resetPlanModeHint();
    } catch {
      setError("Couldn't bring the tips back. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <SettingsRow
      label="Tips"
      description="Show the one-time tips you dismissed again."
      dataTestId="settings-canopy-tips"
      control={
        <Button
          size="compact"
          disabled={pending}
          onClick={(): void => {
            void showAgain();
          }}
          data-testid="settings-canopy-show-tips-again"
        >
          Show tips again
        </Button>
      }
    >
      {error && <ErrorBanner errorSource="show-tips-again-row" error={error} />}
    </SettingsRow>
  );
}
