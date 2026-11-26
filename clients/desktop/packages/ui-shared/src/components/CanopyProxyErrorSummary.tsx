import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { CanopyProxyError } from '@canopy/protocol';
import { createCanopyProxyAppError } from '@canopy/protocol/app-errors';
import { CanopyProxyErrorPresentation } from './CanopyProxyErrorPresentation';
import { AiCreditsStopLine } from './AiCreditsStopLine';
import { NoticeButton } from '../primitives/Notice';
import { recordSurfacedError } from '../lib/surfaced-error-port';
import { CopyDetailsButton } from '../primitives/CopyDetailsButton';

const AccountRecoveryContext = createContext<(() => void) | null>(null);

export interface CanopyProxyRetryRecovery {
  checkAvailability: (messageId: string) => Promise<boolean>;
  retry: (messageId: string) => Promise<void>;
}
const RetryRecoveryContext = createContext<CanopyProxyRetryRecovery | null>(
  null,
);

/** A host supplies authoritative availability and a guarded recovery port. */
export function CanopyProxyRetryRecoveryProvider({
  value,
  children,
}: {
  value: CanopyProxyRetryRecovery;
  children: ReactNode;
}): JSX.Element {
  return (
    <RetryRecoveryContext.Provider value={value}>
      {children}
    </RetryRecoveryContext.Provider>
  );
}

/** Hosts supply their existing account destination; read-only views omit it. */
export function CanopyProxyAccountRecoveryProvider({
  onOpenSettings,
  children,
}: {
  onOpenSettings: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <AccountRecoveryContext.Provider value={onOpenSettings}>
      {children}
    </AccountRecoveryContext.Provider>
  );
}

/** Same settings action for the desktop notice and Portal recovery. */
export function CanopyProxySettingsAction({
  onClick,
  dataTestId = 'chat-canopy-proxy-error-open-settings',
}: {
  onClick: () => void;
  dataTestId?: string;
}): JSX.Element {
  return (
    <NoticeButton variant="primary" data-testid={dataTestId} onClick={onClick}>
      Open settings
    </NoticeButton>
  );
}

/**
 * The catalog copy for a refusal, recorded as a surfaced error once per
 * reference id. Hosts that own their notice read the title and description
 * here instead of nesting the summary inside it. Pass `shown: false` while
 * the host hides its notice, so a refusal nobody saw is not recorded.
 */
export function useCanopyProxyErrorCopy(
  error: CanopyProxyError,
  shown = true,
): ReturnType<typeof createCanopyProxyAppError>['copy'] {
  const { code, correlationId } = error;
  const appError = useMemo(
    () => createCanopyProxyAppError({ code, correlationId, message: null }),
    [code, correlationId],
  );
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (!shown || recorded.current === appError.referenceId) return;
    recorded.current = appError.referenceId;
    // Rebuilt on every mount, so a reopened transcript would refill the
    // feedback slot with a fresh timestamp: record it, never remember it.
    recordSurfacedError({
      chokePoint: 'notice',
      identifier: 'chat-ai-credits-refusal',
      surface: 'inline',
      error: appError,
    });
  }, [appError, shown]);
  return appError.copy;
}

export interface CanopyProxyErrorSummaryProps {
  error: CanopyProxyError;
  dataTestId?: string;
  messageId?: string;
}

/** One plain, catalog-owned refusal on desktop and every Portal transcript. */
export function CanopyProxyErrorSummary({
  error,
  dataTestId = 'canopy-proxy-error-summary',
  messageId,
}: CanopyProxyErrorSummaryProps): JSX.Element {
  const openSettings = useContext(AccountRecoveryContext);
  const recovery = useContext(RetryRecoveryContext);
  const [availability, setAvailability] = useState<{
    recovery: CanopyProxyRetryRecovery;
    messageId: string;
    allowed: boolean;
  } | null>(null);
  const available =
    availability?.recovery === recovery &&
    availability?.messageId === messageId &&
    availability?.allowed === true;
  const [retrying, setRetrying] = useState(false);
  const sending = useRef(false);
  const { code, correlationId } = error;
  useEffect(() => {
    let current = true;
    if (code === 'upstream_unavailable' && recovery && messageId) {
      void recovery.checkAvailability(messageId).then(
        (allowed) => {
          if (current) setAvailability({ recovery, messageId, allowed });
        },
        () => {
          if (current) setAvailability(null);
        },
      );
    }
    return (): void => {
      current = false;
    };
  }, [code, recovery, messageId]);
  const copy = useCanopyProxyErrorCopy(error);
  if (code === 'no_billing_source')
    return <AiCreditsStopLine dataTestId={dataTestId} />;
  const description = copy.description ?? null;
  const copyDetails = correlationId ? (
    <CopyDetailsButton
      details={correlationId}
      data-testid={`${dataTestId}-copy-details`}
    />
  ) : null;
  if (code === 'upstream_unavailable' && recovery) {
    return (
      <CanopyProxyErrorPresentation
        state="unresolved"
        announcement="live"
        dataTestId={`${dataTestId}-notice`}
        title={copy.title}
        actions={
          copyDetails !== null || (available && Boolean(messageId)) ? (
            <>
              {copyDetails}
              {available && messageId ? (
                <NoticeButton
                  variant="primary"
                  data-testid={`${dataTestId}-retry`}
                  disabled={retrying}
                  onClick={() => {
                    if (sending.current) return;
                    sending.current = true;
                    setRetrying(true);
                    void recovery
                      .retry(messageId)
                      .then(
                        () => setAvailability(null),
                        () => setAvailability(null),
                      )
                      .finally(() => {
                        sending.current = false;
                        setRetrying(false);
                      });
                  }}
                >
                  Try again
                </NoticeButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {description}
      </CanopyProxyErrorPresentation>
    );
  }
  return code === 'credentials_unavailable' && openSettings ? (
    <CanopyProxyErrorPresentation
      state="unresolved"
      announcement="live"
      dataTestId={`${dataTestId}-notice`}
      title={copy.title}
      actions={
        <>
          {copyDetails}
          <CanopyProxySettingsAction
            onClick={openSettings}
            dataTestId={`${dataTestId}-open-settings`}
          />
        </>
      }
    >
      {description}
    </CanopyProxyErrorPresentation>
  ) : (
    // A plain inline line inside an assistant message, not a notice.
    <span data-testid={dataTestId} className="text-xs text-pretty">
      <span className="fg-primary">{copy.title}</span>
      {description ? (
        <span className="fg-tertiary">{` ${description}`}</span>
      ) : null}
    </span>
  );
}
