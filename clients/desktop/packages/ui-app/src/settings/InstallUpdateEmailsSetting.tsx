import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useCanopyClient } from '@canopy/app-state';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
  SettingsRowsRow,
  SettingsRowsSection,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCardSwitch,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import {
  settingsActionErrorCopy,
  settingsFailure,
  settingsLoadErrorCopy,
  type SettingsFailure,
} from './errors';

/** The default frame's heading, exported so a host frame can reuse it. */
export const INSTALL_UPDATE_EMAILS_TITLE = 'Update emails';

const TOGGLE_ID = 'install-update-emails-toggle';
const LABEL = "Updates to things I've installed";
const DESCRIPTION =
  'Get an email when someone updates a skill, workflow, automation or other item you installed.';

const noop = (): void => undefined;

/** The setting's row; `control` is absent while the value is unknown. */
function InstallUpdateEmailsRow({
  control,
}: {
  readonly control?: ReactNode;
}): JSX.Element {
  return (
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <SettingsRowsRow
          label={LABEL}
          description={DESCRIPTION}
          htmlFor={control === undefined ? undefined : TOGGLE_ID}
          control={control}
        />
      </div>
    </div>
  );
}

type SettingState =
  | { readonly kind: 'loading' }
  // The load failed, so there is no real value to show or write.
  | { readonly kind: 'locked'; readonly failure: SettingsFailure }
  | {
      readonly kind: 'ready';
      /** Always the server's value, never the requested one. */
      readonly enabled: boolean;
      readonly saving: boolean;
      /** The value a failed save asked for, kept so Retry can resend it. */
      readonly failedRequest: boolean | null;
      /** The failed save (our sentence and its details); null when nothing failed. */
      readonly failure: SettingsFailure | null;
    };

/**
 * The account's "Updates to things I've installed" email preference
 * (CAN-2334), mounted on desktop Settings → Notifications and web Account →
 * Notifications.
 *
 * Renders nothing unless the host reports `installUpdateEmails`. Updates are
 * pessimistic: the switch shows the value the server returned, stays
 * disabled while a save is in flight, and keeps the last server value when a
 * save fails. A failed load shows no switch at all, because a switch can only
 * say on or off and either would claim a value nobody read.
 *
 * The row and its error notice are the shared unit, styled like the other
 * Account → Notifications card rows. The section around them is host chrome:
 * by default a text heading, or the host's own frame through `renderFrame`.
 */
export function InstallUpdateEmailsSetting({
  renderFrame = renderDefaultFrame,
}: InstallUpdateEmailsSettingProps): JSX.Element | null {
  const client = useCanopyClient();
  if (client.capabilities.installUpdateEmails !== true) return null;
  return <InstallUpdateEmailsContent renderFrame={renderFrame} />;
}

export interface InstallUpdateEmailsSettingProps {
  /**
   * Wraps the row and its error notice in the host's settings chrome.
   * Defaults to a text heading over the row.
   */
  readonly renderFrame?: (content: ReactNode) => ReactNode;
}

function renderDefaultFrame(content: ReactNode): ReactNode {
  return (
    <SettingsRowsSection
      title={INSTALL_UPDATE_EMAILS_TITLE}
      headingId="install-update-emails-heading"
    >
      {content}
    </SettingsRowsSection>
  );
}

function InstallUpdateEmailsContent({
  renderFrame,
}: {
  readonly renderFrame: (content: ReactNode) => ReactNode;
}): JSX.Element {
  const client = useCanopyClient();
  const [state, setState] = useState<SettingState>({ kind: 'loading' });
  const mounted = useRef(true);
  // Rendered state lags a burst of clicks; this does not.
  const saveInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback((): void => {
    setState({ kind: 'loading' });
    client
      .query('account.installUpdateEmails.get', {})
      .then((preference) => {
        if (!mounted.current) return;
        setState({
          kind: 'ready',
          enabled: preference.enabled,
          saving: false,
          failedRequest: null,
          failure: null,
        });
      })
      .catch((caught: unknown) => {
        if (mounted.current) {
          setState({
            kind: 'locked',
            failure: settingsFailure(caught, settingsLoadErrorCopy(caught)),
          });
        }
      });
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    (requested: boolean): void => {
      if (saveInFlight.current) return;
      saveInFlight.current = true;
      setState((current) =>
        current.kind === 'ready' && !current.saving
          ? { ...current, saving: true, failedRequest: null, failure: null }
          : current,
      );
      client
        .command('account.installUpdateEmails.set', { enabled: requested })
        .then((preference) => {
          saveInFlight.current = false;
          if (!mounted.current) return;
          setState({
            kind: 'ready',
            enabled: preference.enabled,
            saving: false,
            failedRequest: null,
            failure: null,
          });
        })
        .catch((caught: unknown) => {
          saveInFlight.current = false;
          if (!mounted.current) return;
          const failure = settingsFailure(
            caught,
            settingsActionErrorCopy(caught, { action: 'save this setting' }),
          );
          setState((current) =>
            current.kind === 'ready'
              ? {
                  ...current,
                  saving: false,
                  failedRequest: requested,
                  failure,
                }
              : current,
          );
        });
    },
    [client],
  );

  const handleToggle = (next: boolean): void => {
    // The switch is disabled while saving; `save` also drops a click that
    // lands before the disabled state renders.
    if (state.kind !== 'ready' || state.saving) return;
    save(next);
  };

  const handleRetry = (): void => {
    if (state.kind === 'locked') {
      load();
      return;
    }
    if (state.kind === 'ready' && state.failedRequest !== null) {
      save(state.failedRequest);
    }
  };

  const error =
    state.kind === 'locked'
      ? state.failure
      : state.kind === 'ready' && state.failedRequest !== null
        ? state.failure
        : null;

  const content = (
    <div
      className="flex flex-col gap-3"
      aria-busy={state.kind === 'loading' || undefined}
      data-testid="install-update-emails-setting"
    >
      <ErrorBanner
        errorSource="install-update-emails-error"
        className=""
        error={error?.copy}
        {...(error?.details === undefined ? {} : { details: error.details })}
        onRetry={handleRetry}
        testId="install-update-emails-error"
      />
      {state.kind === 'loading' ? (
        <DelayedLoadingPlaceholder>
          <Skeleton
            loading
            label="Loading email settings"
            testId="settings-skeleton-form"
          >
            <InstallUpdateEmailsRow
              control={
                <SettingsCardSwitch
                  checked={false}
                  label={LABEL}
                  onChange={noop}
                />
              }
            />
          </Skeleton>
        </DelayedLoadingPlaceholder>
      ) : (
        <InstallUpdateEmailsRow
          control={
            state.kind === 'ready' ? (
              <SettingsCardSwitch
                id={TOGGLE_ID}
                checked={state.enabled}
                disabled={state.saving}
                label={LABEL}
                onChange={handleToggle}
                dataTestId="install-update-emails-toggle"
              />
            ) : undefined
          }
        />
      )}
    </div>
  );
  return <>{renderFrame(content)}</>;
}
