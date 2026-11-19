import { ButtonLink } from './ButtonLink';
import { TextLink } from './TextLink';
import type { JSX } from 'react';
import { CloseIcon } from '../icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { Dot } from './Badge';
import { Button } from './Button';
import { LoadingSpinner } from './LoadingSpinner';
import { Tooltip } from './Tooltip';

/** The status of an MCP sign-in that waits in another tab. */
export const MCP_SIGN_IN_WAITING_LABEL = 'Waiting for sign-in';
export const MCP_SIGN_IN_REOPEN_LABEL = 'Reopen sign-in';
export const MCP_SIGN_IN_CANCEL_LABEL = 'Cancel sign-in';

// Waiting on sign-in is an operational state, so it takes the stable active
// status palette rather than the brand accent.
const WAITING_PILL_CLASS_NAME = `${OPERATIONAL_STATUS_COLORS.active.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.active.foreground}`;

interface McpSignInPendingStatusProps {
  /** `row` uses a neutral status dot in Customize. */
  variant?: 'inline' | 'pill' | 'row';
  /** Named for assistive technology only: the row already shows the name. */
  serviceName?: string;
  dataTestId?: string;
}

/** Announces that an MCP sign-in is waiting on its tab. */
export function McpSignInPendingStatus({
  variant = 'inline',
  serviceName,
  dataTestId,
}: McpSignInPendingStatusProps): JSX.Element {
  const accessibleLabel = serviceName
    ? `Waiting for ${serviceName} sign-in`
    : undefined;
  if (variant === 'pill')
    return (
      <span
        role="status"
        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium ${WAITING_PILL_CLASS_NAME}`}
        aria-label={accessibleLabel}
        data-testid={dataTestId}
      >
        <LoadingSpinner decorative />
        {MCP_SIGN_IN_WAITING_LABEL}
      </span>
    );
  return (
    <span
      role="status"
      className="flex items-center gap-2"
      aria-label={accessibleLabel}
      data-testid={dataTestId}
    >
      {variant === 'row' ? (
        <Dot tone="filter" data-testid={dataTestId && `${dataTestId}-dot`} />
      ) : (
        <LoadingSpinner decorative tone="active" />
      )}
      {MCP_SIGN_IN_WAITING_LABEL}
    </span>
  );
}

interface McpSignInPendingActionsProps {
  /** The sign-in page; Reopen opens it in a new tab. */
  authorizationUrl: string;
  serviceName?: string;
  /** Stops waiting. Without it, a compact row offers only Reopen. */
  onCancel?: () => void;
  /**
   * `compact` is a server row's **Reopen** and an icon-only cancel; `full`
   * is a dialog footer's **Cancel** and **Reopen sign-in**.
   */
  variant?: 'compact' | 'full';
  /** Secondary when another shared primary owns the detail header. */
  reopenVariant?: 'primary' | 'secondary';
  /** The full variant's dismiss label, e.g. **Done** where it closes the dialog. */
  cancelLabel?: string;
  /** Prefix for the `-reopen` and `-cancel` hooks. */
  dataTestId?: string;
}

/** Reopens a waiting MCP sign-in, or stops waiting on it. */
export function McpSignInPendingActions({
  authorizationUrl,
  serviceName,
  onCancel,
  variant = 'full',
  reopenVariant = 'primary',
  cancelLabel = 'Cancel',
  dataTestId = 'mcp-sign-in-pending',
}: McpSignInPendingActionsProps): JSX.Element {
  if (variant === 'compact')
    return (
      <span className="flex items-center gap-0.5 pointer-coarse:gap-2">
        <TextLink
          variant="mcp-action"
          href={authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={
            serviceName
              ? `Reopen ${serviceName} sign-in`
              : MCP_SIGN_IN_REOPEN_LABEL
          }
          data-testid={`${dataTestId}-reopen`}
        >
          Reopen
        </TextLink>
        {onCancel !== undefined && (
          <Tooltip label={MCP_SIGN_IN_CANCEL_LABEL}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={
                serviceName
                  ? `Cancel ${serviceName} sign-in`
                  : MCP_SIGN_IN_CANCEL_LABEL
              }
              onClick={onCancel}
              data-testid={`${dataTestId}-cancel`}
            >
              <CloseIcon size={12} aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
      </span>
    );
  return (
    <>
      {onCancel !== undefined && (
        <Button
          variant="ghost"
          size="md"
          onClick={onCancel}
          data-testid={`${dataTestId}-cancel`}
        >
          {cancelLabel}
        </Button>
      )}
      <ButtonLink
        variant={reopenVariant}
        size="md"
        href={authorizationUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`${dataTestId}-reopen`}
      >
        {MCP_SIGN_IN_REOPEN_LABEL}
      </ButtonLink>
    </>
  );
}

interface McpSignInPendingLineProps {
  /** The sign-in page; the link reopens it in a new tab. */
  authorizationUrl: string;
  serviceName?: string;
  /** Stops waiting. */
  onCancel?: () => void;
  dataTestId?: string;
}

/**
 * New Customize's row status for a sign-in waiting in another tab, in place
 * of the status line: a small spinner, a "Signing in…" link that reopens the
 * sign-in page, and a cancel icon. Nothing else sits beside the row's status
 * control (Sergii's QA).
 */
export function McpSignInPendingLine({
  authorizationUrl,
  serviceName,
  onCancel,
  dataTestId,
}: McpSignInPendingLineProps): JSX.Element {
  return (
    <span
      role="status"
      // The row subtitle is `pointer-events-none`, so the link and cancel icon
      // opt back in.
      className="pointer-events-auto flex min-w-0 items-center gap-1.5"
      aria-label={
        serviceName ? `Waiting for ${serviceName} sign-in` : undefined
      }
      data-testid={dataTestId}
    >
      <LoadingSpinner decorative />
      <Tooltip label={MCP_SIGN_IN_REOPEN_LABEL}>
        <TextLink
          variant="mcp-action"
          href={authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={
            serviceName
              ? `Reopen ${serviceName} sign-in`
              : MCP_SIGN_IN_REOPEN_LABEL
          }
          data-testid={dataTestId && `${dataTestId}-reopen`}
        >
          Signing in…
        </TextLink>
      </Tooltip>
      {onCancel !== undefined && (
        <Tooltip label={MCP_SIGN_IN_CANCEL_LABEL}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={
              serviceName
                ? `Cancel ${serviceName} sign-in`
                : MCP_SIGN_IN_CANCEL_LABEL
            }
            onClick={onCancel}
            data-testid={dataTestId && `${dataTestId}-cancel`}
          >
            <CloseIcon size={12} aria-hidden="true" />
          </Button>
        </Tooltip>
      )}
    </span>
  );
}
