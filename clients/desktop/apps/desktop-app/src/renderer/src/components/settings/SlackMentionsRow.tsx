import { useCallback, useEffect, useState, type JSX } from 'react';
import { toAppError } from '@canopy/protocol/app-errors';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  Divider,
  Notice,
  NoticeButton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { SlackIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  EXTERNAL_AGENTS_PATH,
  externalAgentsPathFromDesktop,
} from '@canopy/ui-app/external-agents/paths';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { openAuthenticatedCloudPageReported } from '@/lib/openAuthenticatedCloudPage';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { SettingsRow } from './SettingsLayout';

/**
 * This computer's Slack gate (CAN-7604): whether your Slack mentions may
 * start Orchestrator turns here. Off by default. Browser, mobile and hosted
 * controllers can't change it.
 */
// The row is titled by the app, like GitHub and Linear above it; the switch
// keeps a label that says what it does.
const SLACK_MENTIONS_LABEL = 'Listen for Slack mentions';
// The Slack app's handle, as people type it in Slack (CAN-7607/7608 own it).
const SLACK_MENTION = '@unstoppable';
const SLACK_MENTIONS_HELPER = `When you mention ${SLACK_MENTION} on Slack, your agents on this computer can start work and respond in the chat.`;
// The agents pairing a Slack request rides on is set up on the web for now;
// a one-click Connect Slack folds it in (CAN-7606).
const FINISH_SETUP_TEXT = 'Finish setting up Slack on the web to get replies.';

/**
 * The saved Slack preference. Reads nothing while the flag hides the row; a
 * failed read leaves the switch disabled and reports why.
 */
function useSlackMentionsPreference(
  offered: boolean,
  onLoadError: (failure: InlineFailure) => void,
): {
  readonly enabled: boolean | null;
  readonly saving: boolean;
  readonly save: (next: boolean) => Promise<void>;
} {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!offered) return undefined;
    let live = true;
    // Read now, and again whenever preferences change (a full desktop
    // controller can change it too).
    const load = (): void => {
      void window.api
        .loadPreferences({ view: 'persisted' })
        .then((preferences) => {
          if (live) setEnabled(preferences.slackOrchestratorRequestsEnabled);
        })
        .catch((cause: unknown) => {
          const appError = toAppError(resolveClientAppError(cause));
          if (live && appError)
            onLoadError(
              inlineFailure(appError, "Couldn't load the Slack setting."),
            );
        });
    };
    load();
    const unsubscribe = window.api.onPreferencesChanged(load);
    return (): void => {
      live = false;
      unsubscribe();
    };
  }, [offered, onLoadError]);
  const save = useCallback(async (next: boolean): Promise<void> => {
    setSaving(true);
    try {
      const saved = await window.api.savePreferences(
        { slackOrchestratorRequestsEnabled: next },
        { view: 'persisted' },
      );
      setEnabled(saved.slackOrchestratorRequestsEnabled);
    } finally {
      setSaving(false);
    }
  }, []);
  return { enabled, saving, save };
}

/**
 * The Slack row under Integrations → On this computer, with the divider that
 * separates it from the row above; nothing while the flag hides it. Turning
 * it on also turns on letting other devices control this computer, which
 * every Slack request needs, so one switch is all it takes here. Turning it
 * off leaves that setting alone.
 */
export function SlackMentionsSection(): JSX.Element | null {
  const offered = useFeatureFlagsStore((store) =>
    store.isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopSlackOrchestratorRequests.key,
    ),
  );
  const allowIncoming = useRemoteControlStore(
    (store) => store.state.allowIncoming,
  );
  const setAllowIncoming = useRemoteControlStore(
    (store) => store.setAllowIncoming,
  );
  const agentsPaired = useRemoteControlStore((store) =>
    store.state.controllers.some((controller) => controller.kind === 'hosted'),
  );
  const [error, setError] = useState<InlineFailure | null>(null);
  const preference = useSlackMentionsPreference(offered, setError);
  if (!offered) return null;

  const toggle = (next: boolean): void => {
    setError(null);
    void (async (): Promise<void> => {
      await preference.save(next);
      if (next && !allowIncoming) await setAllowIncoming(true);
    })().catch((cause: unknown) => {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError)
        setError(inlineFailure(appError, "Couldn't save the setting."));
    });
  };

  return (
    <div data-testid="account-device-card-slack">
      <Divider />
      <div className="flex flex-col gap-3" data-settings-card-rows="">
        <DesktopErrorBanner
          errorSource="settings-slack-mentions-error"
          className=""
          error={error?.error}
          {...(error?.details === undefined ? {} : { details: error.details })}
          testId="settings-slack-mentions-error"
        />
        <div className="flex flex-col py-3">
          <SettingsRow
            label={
              <span className="inline-flex items-center gap-2">
                <SlackIcon
                  size="md"
                  className="shrink-0 fg-primary"
                  aria-hidden
                />
                Slack
              </span>
            }
            description={SLACK_MENTIONS_HELPER}
            htmlFor="settings-slack-mentions"
            dataTestId="settings-slack-mentions-row"
            control={
              <ToggleSwitch
                id="settings-slack-mentions"
                checked={preference.enabled === true}
                label={SLACK_MENTIONS_LABEL}
                dataTestId="settings-slack-mentions"
                disabled={preference.enabled === null || preference.saving}
                onChange={toggle}
              />
            }
          >
            {preference.enabled === true && !agentsPaired ? (
              <Notice
                intent="attention"
                data-testid="settings-slack-mentions-finish-setup"
                actions={
                  <NoticeButton
                    onClick={() => {
                      void openAuthenticatedCloudPageReported(
                        externalAgentsPathFromDesktop(EXTERNAL_AGENTS_PATH),
                      );
                    }}
                  >
                    Finish setup
                  </NoticeButton>
                }
              >
                {FINISH_SETUP_TEXT}
              </Notice>
            ) : null}
          </SettingsRow>
        </div>
      </div>
    </div>
  );
}
