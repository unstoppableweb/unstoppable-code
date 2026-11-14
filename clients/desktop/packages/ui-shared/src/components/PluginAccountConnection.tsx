import type { JSX, ReactNode } from 'react';
import { CheckIcon } from '../icons/AppIcons';
import { DetailFact, DetailFactList } from './DetailFact';
import { Disclosure } from './Disclosure';
import { Notice } from './Notice';
import { Stack } from './Stack';

/** Statuses that read as a working connection and carry the check. */
const SIGNED_IN_STATUSES = new Set(['Connected', 'Signed in']);

/** One account connection is reused by every supported in-app harness. */
interface PluginAccountConnectionProps {
  status: string;
  /** Marks the status as a working connection; defaults by the status text. */
  connected?: boolean;
  /** Omit when the status needs no explanation and offers no action. */
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  availability?: ReactNode;
}

export function PluginAccountConnection({
  status,
  connected = SIGNED_IN_STATUSES.has(status),
  description,
  actions,
  children,
  availability,
}: PluginAccountConnectionProps): JSX.Element {
  return (
    <Stack gap="block" className="min-w-0">
      <section
        data-testid="plugin-account-connection"
        aria-label="Connection"
        className="flex min-w-0 flex-col gap-1"
      >
        <DetailFactList>
          <DetailFact label="Connection">
            <span
              className="inline-flex items-center gap-1.5"
              aria-live="polite"
            >
              {connected && (
                <CheckIcon
                  size={14}
                  className="fg-success"
                  aria-hidden="true"
                />
              )}
              {status}
            </span>
            {description && (
              <span className="text-pretty text-xs fg-tertiary">
                {description}
              </span>
            )}
            {actions && (
              <span className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
                {actions}
              </span>
            )}
          </DetailFact>
        </DetailFactList>
        {children && (
          <div className="flex min-w-0 flex-col gap-2 empty:hidden">
            {children}
          </div>
        )}
      </section>
      {availability}
    </Stack>
  );
}

/** Keep transport diagnostics available without making them the recovery UI. */
interface PluginConnectionNoticeProps {
  error: string;
  guidance?: string;
  checkingStatus?: boolean;
}

export function PluginConnectionNotice({
  error,
  guidance,
  checkingStatus = false,
}: PluginConnectionNoticeProps): JSX.Element {
  const untrusted = error.includes('endpoints are not trusted');
  const title = checkingStatus
    ? 'Connection status unavailable'
    : untrusted
      ? 'Sign-in unavailable'
      : 'Couldn’t connect';
  const message =
    guidance ??
    (checkingStatus
      ? 'Reopen this plugin to check its connection again.'
      : untrusted
        ? 'Sign-in setup couldn’t be verified. Update the plugin or contact its publisher.'
        : 'Sign-in didn’t finish. Try connecting again.');
  return (
    <Notice
      errorSource="plugin-connection-title"
      intent="destructive"
      title={title}
      detailGap="inline"
      detail={
        !guidance ? (
          <Disclosure
            label="Technical details"
            dataTestId="plugin-connection-technical-details"
          >
            <p className="whitespace-pre-wrap break-words font-mono">{error}</p>
          </Disclosure>
        ) : undefined
      }
    >
      {message}
    </Notice>
  );
}
