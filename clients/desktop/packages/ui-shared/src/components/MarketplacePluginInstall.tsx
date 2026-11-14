import { Badge } from './Badge';
import type { JSX } from 'react';
import { CheckIcon, DownloadIcon, StopIcon } from '../icons';
import { Button } from './Button';
import { Tooltip } from './Tooltip';
import { RefreshSpinner } from './RefreshSpinner';

// ---------------------------------------------------------------------------
// Portable marketplace install presentation, moved out of the desktop
// renderer (apps/desktop-app/.../pages/MarketplacePluginInstall.tsx, which is
// now a re-export shim) for reuse by the portal Plugins section — see
// docs/planning/2026-08-27-portal-plugins-section/design.md.
//
// These three components were already pure and callback-driven: no IPC, no
// stores, no `window.*`. The only host coupling was the desktop's
// `IconTooltip`, itself a pass-through wrapper over this package's `Tooltip`
// with the same `label`/`className`/`children` props, so importing `Tooltip`
// directly here renders identically to the previous desktop output.
// ---------------------------------------------------------------------------

interface MissingPluginsBadgeProps {
  count: number;
  testId?: string;
}

interface PluginInstallStatusCellProps {
  pluginName: string;
  needsInstall: boolean;
  installing: boolean;
  disabled?: boolean;
  error?: string;
  onInstall: () => void;
}

interface BulkInstallButtonProps {
  disabled?: boolean;
  missingCount: number;
  installing: boolean;
  progress?: { done: number; total: number };
  summary?: string;
  onClick: () => void;
}

/**
 * Warning-colored "[download] N" badge shown on a marketplace row when some of
 * its plugins still need installing. Renders nothing when count is 0.
 */
export function MissingPluginsBadge({
  count,
  testId,
}: MissingPluginsBadgeProps): JSX.Element | null {
  if (count <= 0) {
    return null;
  }
  const label = `${count} ${count === 1 ? 'plugin' : 'plugins'} not installed`;
  return (
    <Tooltip label={label}>
      <Badge tone="warning" icon={DownloadIcon} data-testid={testId}>
        {count}
      </Badge>
    </Tooltip>
  );
}

/**
 * Per-plugin install status cell for the marketplace plugins modal.
 *
 * - installing → spinner
 * - needsInstall + error → destructive retry button (message in tooltip)
 * - needsInstall → warning install button
 * - otherwise (installed external or inline) → green check
 */
export function PluginInstallStatusCell({
  pluginName,
  needsInstall,
  installing,
  disabled = false,
  error,
  onInstall,
}: PluginInstallStatusCellProps): JSX.Element {
  if (installing) {
    return (
      <span
        data-testid={`plugin-install-status-${pluginName}`}
        className="inline-flex justify-end"
      >
        <span role="status" aria-label="Installing plugin">
          <RefreshSpinner spinning />
        </span>
      </span>
    );
  }

  if (needsInstall) {
    const button = (
      <Button
        variant={error ? 'ghost-destructive' : 'ghost-warning'}
        size="sm"
        iconOnly
        data-testid={`plugin-install-${pluginName}`}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) {
            return;
          }
          onInstall();
        }}
        aria-label={
          error ? `Try again to install ${pluginName}` : `Install ${pluginName}`
        }
      >
        <DownloadIcon />
      </Button>
    );
    return error ? (
      <Tooltip label={error} clamp={false}>
        {button}
      </Tooltip>
    ) : (
      button
    );
  }

  return (
    <span
      data-testid={`plugin-install-status-${pluginName}`}
      className="inline-flex justify-end fg-success"
      aria-label="Installed"
    >
      <CheckIcon />
    </span>
  );
}

/**
 * Header action that installs every plugin in the marketplace that still needs
 * installing, plus an inline summary after a run. Renders nothing when there is
 * nothing to install and no summary to show.
 */
export function BulkInstallButton({
  disabled = false,
  missingCount,
  installing,
  progress,
  summary,
  onClick,
}: BulkInstallButtonProps): JSX.Element | null {
  const showButton = missingCount > 0 || installing;
  const showSummary = !!summary && !installing;
  if (!showButton && !showSummary) {
    return null;
  }
  return (
    <div className="flex items-center gap-2">
      {showButton && (
        <Tooltip
          label="Cancel after the current install finishes"
          suppressed={!installing}
        >
          <Button
            variant="warning"
            size="compact"
            data-testid="bulk-install-plugins"
            disabled={disabled}
            onClick={onClick}
          >
            {installing ? <StopIcon /> : <DownloadIcon />}
            {installing && progress
              ? `Installing ${progress.done}/${progress.total}… (cancel)`
              : `Install ${missingCount} ${
                  missingCount === 1 ? 'plugin' : 'plugins'
                }`}
          </Button>
        </Tooltip>
      )}
      {showSummary && (
        <span
          data-testid="bulk-install-summary"
          className="text-xs fg-secondary"
        >
          {summary}
        </span>
      )}
    </div>
  );
}
