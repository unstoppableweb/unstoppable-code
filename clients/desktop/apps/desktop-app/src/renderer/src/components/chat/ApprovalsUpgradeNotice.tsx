import { useEffect, useState, type JSX } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  subscribePreferencesUpdated,
  emitPreferencesUpdated,
} from '@/lib/preferences-events';

/**
 * One-time dismissible notice explaining that agents act without asking.
 * Renders when `preferences.approvalsUpgradeNoticeDismissed === false`.
 *
 * Full Access is the product default, so a fresh profile is the population
 * that has never been told this — it defaults the field to `false` and sees
 * the explainer once (CAN-3055). The approval-defaults migration re-arms it
 * for an upgrading profile whose persisted posture it overwrites. Dismissing
 * it hides it everywhere, because the underlying preference is global, not
 * per-chat.
 */
export function ApprovalsUpgradeNotice(): JSX.Element | null {
  const openSettings = useNavigationStore((state) => state.openSettings);
  const [visible, setVisible] = useState(false);
  const [settingsOpenFailed, setSettingsOpenFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled) {
          setVisible(prefs.approvalsUpgradeNoticeDismissed === false);
        }
      })
      .catch(() => {
        // Leave hidden if preferences fail to load; there is nothing
        // actionable to show without knowing the dismissed state.
      });
    const unsubscribe = subscribePreferencesUpdated((prefs) => {
      if (!cancelled) {
        setVisible(prefs.approvalsUpgradeNoticeDismissed === false);
      }
    });
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!visible) return null;

  const inOrchestrator =
    document.body.dataset.rendererSurface === 'app-advisor';
  const canOpenSettings =
    !inOrchestrator || window.api.remoteControl.getContext().mode === 'local';

  const handleOpenSettings = (): void => {
    if (!inOrchestrator) {
      openSettings('approvals');
      return;
    }
    setSettingsOpenFailed(false);
    void window.api.appAdvisor
      .openApprovalsSettings()
      .catch((error: unknown) => {
        reportClientAppError(error);
        setSettingsOpenFailed(true);
      });
  };

  const handleDismiss = (): void => {
    setVisible(false);
    void window.api
      .savePreferences({ approvalsUpgradeNoticeDismissed: true })
      .then((prefs) => {
        emitPreferencesUpdated(prefs);
      })
      .catch(() => {
        // Best-effort: the notice already hid locally for this session.
      });
  };

  return (
    <Notice
      intent="neutral"
      title="Agents can act without asking"
      data-testid="approvals-upgrade-notice"
      onDismiss={handleDismiss}
      dismissLabel="Dismiss approvals upgrade notice"
      dismissTestId="approvals-upgrade-notice-dismiss"
      announcement={settingsOpenFailed ? 'assertive' : undefined}
      detail={
        settingsOpenFailed
          ? 'Couldn’t open Approvals settings. Try again.'
          : undefined
      }
      actions={
        canOpenSettings ? (
          <NoticeButton
            variant="secondary"
            data-testid="approvals-upgrade-notice-open-settings"
            onClick={handleOpenSettings}
          >
            Open settings
          </NoticeButton>
        ) : undefined
      }
    >
      {`${brandText.appName} runs agent actions like editing files and running commands without checking with you first. Change this any time in Settings.`}
    </Notice>
  );
}
