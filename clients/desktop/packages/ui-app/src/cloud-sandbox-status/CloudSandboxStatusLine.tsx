import { useState, type JSX, type ReactNode } from 'react';
import type { CloudSandboxStatus } from '@canopy/protocol/cloud-session';
import { Button, LoadingSpinner, Surface } from '@canopy/ui-shared/components';
import {
  cloudSandboxStatusCopy,
  type CloudSandboxStatusAction,
} from './cloud-sandbox-status-copy';

export interface CloudSandboxStatusLineProps {
  readonly kind: Exclude<CloudSandboxStatus['kind'], 'ready'>;
  /** A wake the host started is still running. */
  readonly pending: boolean;
  /**
   * Wakes a sleeping sandbox. Without it the line offers no Wake and says
   * that a message wakes it.
   */
  readonly onWake?: () => void;
  /**
   * Starts a failed sandbox again. Without it the line offers no Try again
   * and says that a message starts it.
   */
  readonly onTryAgain?: () => void;
  /** Prefixes the line's test ids: `<prefix>-<kind>`, `<prefix>-wake`, `<prefix>-retry-wake`. */
  readonly testIdPrefix: string;
  /** Host notes under the state line, such as the web's saved copy badge. */
  readonly children?: ReactNode;
}

/**
 * The cloud sandbox state above a files surface. An action the user
 * activated stays mounted while the wake it started runs.
 */
export function CloudSandboxStatusLine({
  kind,
  pending,
  onWake,
  onTryAgain,
  testIdPrefix,
  children,
}: CloudSandboxStatusLineProps): JSX.Element {
  const [pendingAction, setPendingAction] =
    useState<CloudSandboxStatusAction | null>(null);
  const { action, copy } = cloudSandboxStatusCopy(kind, pendingAction, {
    wake: onWake !== undefined,
    tryAgain: onTryAgain !== undefined,
  });
  const run = action === 'Wake' ? onWake : onTryAgain;
  return (
    <Surface variant="section" boundary="bottom" className="min-w-0">
      <div
        className="flex min-w-0 flex-col gap-2 px-3 py-2 text-xs fg-secondary"
        aria-live="polite"
        aria-atomic="true"
      >
        <div
          className="flex min-w-0 flex-wrap items-center gap-2"
          data-testid={`${testIdPrefix}-${kind}`}
        >
          {kind === 'waking' && (
            <LoadingSpinner key="spinner" className="shrink-0" decorative />
          )}
          <span key="copy">{copy}</span>
          {action !== null && (
            <Button
              key="recovery"
              size="compact"
              data-testid={
                action === 'Wake'
                  ? `${testIdPrefix}-wake`
                  : `${testIdPrefix}-retry-wake`
              }
              aria-disabled={kind === 'waking' || pending}
              onClick={() => {
                if (kind === 'waking' || pending) return;
                setPendingAction(action);
                run?.();
              }}
            >
              {action}
            </Button>
          )}
        </div>
        {children}
      </div>
    </Surface>
  );
}
