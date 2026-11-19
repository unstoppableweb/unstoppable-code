import { powerMonitor, type BrowserWindow } from 'electron';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { ActivationCampaignNavigateEvent } from '@canopy/desktop-shared/types';
import { isPromotionalCategoryEnabled } from '@canopy/desktop-shared/lib/promotional-notifications';
import { getFeatureFlagService } from '../../feature-flags/service';
import { readPreferencesFile } from '../../lib/preferences-store';
import { recordActivationCampaignTelemetry } from '../../lib/desktop-telemetry';
import { showOsNotification } from '../../ipc/os-notifications';
import { onRemoteControlStateChanged } from '../../remote-control/electron-remote-control';
import {
  hasMeaningfullyActivated,
  isCampaignEligible,
  latchMobilePaired,
} from './activation-signals';
import {
  setCampaignClickObserver,
  setCampaignClickSender,
} from './click-router';
import {
  drainActivationJourneyWrites,
  latchCampaignClicked,
  recordFirstOpen,
} from './journey-state';
import { resolveCampaignVariantKey } from './variant-resolver';
import type { ActivationNotificationPreferences } from './scheduler';
import { fetchServedCampaignConfig } from './served-config-fetch';
import {
  loadCachedServedCampaigns,
  refreshServedCampaigns,
} from './served-config-sync';
import {
  drainActivationEvaluations,
  requestActivationRecompute,
  startActivationJourney,
  stopActivationJourney,
  type ActivationJourneyDeps,
} from './scheduler';
import { sendToWebContents } from '../../lib/web-contents-send';

/**
 * Electron composition root for the activation journey (CAN-1967). Every
 * dependency the scheduler and click router need is assembled here so those
 * modules stay Electron-free and unit-testable.
 */

interface ActivationJourneyWiringOptions {
  getMainWindow: () => BrowserWindow | null;
  /**
   * Creates the main window when a campaign click arrives with none open.
   * Delivery is retried once the new renderer reports startup-unlocked.
   */
  createMainWindow: () => void;
  focusMainWindow: () => void;
}

function buildDeps(
  options: ActivationJourneyWiringOptions,
): ActivationJourneyDeps {
  return {
    now: () => Date.now(),
    showNotification: (request, onFailed): void => {
      // Native notification authorization belongs to the host OS, so an
      // ad-hoc-signed E2E app can be accepted by Electron and then rejected
      // asynchronously by macOS. The journey spec opts into this build-gated
      // seam to exercise scheduling and send-once persistence independently
      // of the runner's notification permissions. Production builds erase
      // this branch because __CANOPY_E2E__ is compile-time false.
      if (
        __CANOPY_E2E__ &&
        process.env.CANOPY_E2E_ASSUME_OS_NOTIFICATION_SUCCESS === '1'
      ) {
        return;
      }
      showOsNotification(request, options.getMainWindow, onFailed);
    },
    recordOutcome: (outcome): void => {
      recordActivationCampaignTelemetry(
        outcome.outcome === 'delivered'
          ? {
              campaignId: outcome.campaignId,
              outcome: 'delivered',
              destination: outcome.destination,
            }
          : {
              campaignId: outcome.campaignId,
              outcome: 'suppressed',
              reason: outcome.reason,
            },
      );
    },
    isCampaignFlagEnabled: () =>
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key,
      ),
    readNotificationPreferences:
      async (): Promise<ActivationNotificationPreferences> => {
        const preferences = await readPreferencesFile();
        return {
          enabled: preferences.osNotifications.enabled,
          skipWhenFocused: preferences.osNotifications.skipWhenFocused,
          // The promotional hierarchy (CAN-3013) replaced the single OS
          // `activation` category as the opt-in for every campaign send. An
          // existing opt-out is carried over by the preferences normalizer.
          activationCategoryEnabled: isPromotionalCategoryEnabled(
            preferences.promotionalNotifications,
            'arbitrary',
          ),
          quietHours: preferences.activationQuietHours,
        };
      },
    isAppFocused: (): boolean => {
      const window = options.getMainWindow();
      return window !== null && !window.isDestroyed() && window.isFocused();
    },
    hasActivated: hasMeaningfullyActivated,
    isCampaignEligible,
    resolveVariantKey: resolveCampaignVariantKey,
    onPowerResume: (handler): (() => void) => {
      powerMonitor.on('resume', handler);
      powerMonitor.on('unlock-screen', handler);
      return (): void => {
        powerMonitor.removeListener('resume', handler);
        powerMonitor.removeListener('unlock-screen', handler);
      };
    },
  };
}

let unsubscribeRemoteControlState: (() => void) | null = null;

export async function initializeActivationJourney(
  options: ActivationJourneyWiringOptions,
): Promise<void> {
  // Mobile pairing has no backfill, so a mobile controller connected over
  // Remote Control is the only observation available. Latching is
  // idempotent, so seeing it connected again after a reconnect costs nothing.
  unsubscribeRemoteControlState?.();
  unsubscribeRemoteControlState = onRemoteControlStateChanged((state) => {
    if (
      state.controllers.some(
        (controller) => controller.kind === 'mobile' && controller.connected,
      )
    ) {
      void latchMobilePaired(new Date().toISOString());
    }
  });

  // Served config, applied before the first evaluation so a scheduled campaign
  // uses hub timing rather than compiled timing on this launch. The cached
  // document is applied first and synchronously enough to matter: a launch
  // with no network keeps the last served config instead of silently
  // reverting to the compiled table.
  await loadCachedServedCampaigns();
  // The refresh is deliberately NOT awaited. A slow or unreachable endpoint
  // must not delay journey start -- the cached (or compiled) table is already
  // usable, and a newly fetched document applies on the next evaluation.
  void refreshServedCampaigns(fetchServedCampaignConfig)
    .then((applied) => {
      if (applied) requestActivationRecompute();
    })
    // `applyDocument` runs outside `refreshServedCampaigns`'s try, so a throw
    // there would otherwise surface as `main_unhandled_rejection` instead of
    // the intended silent fallback.
    .catch(() => undefined);

  setCampaignClickObserver((campaignId) => {
    void latchCampaignClicked(campaignId, new Date().toISOString());
    recordActivationCampaignTelemetry({
      campaignId,
      outcome: 'clicked',
    });
  });

  setCampaignClickSender((payload): boolean => {
    const window = options.getMainWindow();
    if (window === null || window.isDestroyed()) {
      // A campaign click with no window: create one and leave the payload
      // buffered. The new renderer's startup-unlocked flush delivers it.
      options.createMainWindow();
      return false;
    }
    options.focusMainWindow();
    const event: ActivationCampaignNavigateEvent = {
      campaignId: payload.campaignId,
      destination: payload.destination,
    };
    sendToWebContents(
      window.webContents,
      IPC_CHANNELS.activationCampaignNavigate,
      event,
    );
    return true;
  });

  await recordFirstOpen(new Date().toISOString());
  await startActivationJourney(buildDeps(options));
}

export async function shutdownActivationJourney(): Promise<void> {
  unsubscribeRemoteControlState?.();
  unsubscribeRemoteControlState = null;
  stopActivationJourney();
  // Order matters: an evaluation in flight may still be between
  // `showNotification()` and `latchCampaignSent()`, so drain it before the
  // state chains. Writes are fire-and-forget during normal operation, so a
  // `sentAt` latch recorded moments before quit would otherwise be lost --
  // and a lost send latch re-fires that campaign on the next launch.
  await drainActivationEvaluations();
  await drainActivationJourneyWrites();
}
