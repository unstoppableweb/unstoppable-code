import type { JSX, ReactNode } from 'react';
import { CanopyClientProvider } from '@canopy/app-state';
import { AppErrorBoundary } from '@canopy/ui-app';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { rootErrorBoundaryHost } from '@/lib/desktop-error-boundary-host';
import { RenderFaultProbe } from '@/lib/e2e-render-fault';

interface RootErrorBoundaryProps {
  children: ReactNode;
}

/** Starts in a chain so a native reload that throws also gets the fallback. */
function reloadWindow(): Promise<void> {
  return Promise.resolve()
    .then(async () => {
      await window.api.reloadWindow();
    })
    .catch(() => {
      window.location.reload();
    });
}

/** The fallback sits outside the app's provider, and reporting needs one. */
function withReportClient(fallback: JSX.Element): JSX.Element {
  return (
    <CanopyClientProvider client={ipcCanopyClient}>
      {fallback}
    </CanopyClientProvider>
  );
}

export function RootErrorBoundary({
  children,
}: RootErrorBoundaryProps): JSX.Element {
  return (
    <AppErrorBoundary
      layout="window"
      message="Couldn't show this window."
      recoveryLabel="Reload window"
      recoveringLabel="Reloading window…"
      testId="root-error-fallback"
      host={rootErrorBoundaryHost}
      onRecover={reloadWindow}
      recoveryReplacesDocument
      renderFrame={withReportClient}
    >
      {__CANOPY_E2E__ ? <RenderFaultProbe target="window" /> : null}
      {children}
    </AppErrorBoundary>
  );
}
