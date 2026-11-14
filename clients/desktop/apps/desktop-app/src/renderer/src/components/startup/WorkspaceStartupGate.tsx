import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { LoadingRegion, Surface } from '@canopy/ui-shared/components';
import { applyDisplayPreferences } from '@/lib/theme';

type StartupState =
  | { state: 'pending' | 'ready' }
  | { state: 'failed'; error: Error };

export function WorkspaceStartupGate({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [startup, setStartup] = useState<StartupState>({ state: 'pending' });
  useEffect(() => {
    let disposed = false;
    let waiting = true;
    // Display preferences are not workspace records; keep the waiting screen
    // on the saved theme while the workspace-dependent app stays unmounted.
    void window.api.loadPreferences().then(
      (preferences) => {
        if (!disposed && waiting) applyDisplayPreferences(preferences);
      },
      () => undefined,
    );
    void window.api.waitForWorkspaceStartup().then(
      () => {
        waiting = false;
        if (!disposed) setStartup({ state: 'ready' });
      },
      (error: unknown) => {
        waiting = false;
        if (!disposed)
          setStartup({
            state: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
      },
    );
    return (): void => {
      disposed = true;
    };
  }, []);

  if (startup.state === 'failed') throw startup.error;
  if (startup.state === 'ready') return <>{children}</>;
  return (
    <Surface
      variant="pane"
      extent="viewport"
      padding="roomy"
      className="flex w-full items-center justify-center"
      data-testid="workspace-startup-loading"
      aria-busy="true"
    >
      <div className="max-w-full text-center">
        <LoadingRegion
          layout="intrinsic"
          slowNote="Still loading workspaces…"
        />
      </div>
    </Surface>
  );
}
