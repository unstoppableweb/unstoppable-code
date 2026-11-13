import { useActivationJourneyEnabled } from '@/hooks/useActivationJourneyEnabled';
import {
  cancelOsNotificationOfferOptIn,
  markOsNotificationOfferAnswered,
} from '@/lib/osNotificationOffer';
import {
  fireTestOsNotification,
  refreshInAppNotificationPrefs,
  refreshOsNotificationPrefs,
} from '@/lib/osNotifications';
import { withChosenInAppNotificationPlacement } from '@/lib/useInAppNotificationPlacement';
import { DEFAULT_PROMOTIONAL_NOTIFICATIONS } from '@canopy/desktop-shared/lib/promotional-notifications';
import type {
  ActivationQuietHours,
  InAppNotificationPlacement,
  InAppNotificationPreferences,
  NotificationCategoryKey,
  OsNotificationCategorySound,
  OsNotificationPreferences,
  OsNotificationTopLevelSound,
  PromotionalNotificationPreferences,
} from '@canopy/desktop-shared/types';
import { useEffect, useState } from 'react';

const DEFAULT_OS_NOTIFICATIONS: OsNotificationPreferences = {
  enabled: false,
  skipWhenFocused: true,
  defaultSound: 'System',
  categories: {
    chat: true,
    script: true,
    hook: true,
    gitCommit: true,
    gitPush: true,
    prCreate: true,
    pipeline: true,
    terminal: true,
    runComment: true,
    activation: true,
  },
  categorySounds: {
    chat: 'Default',
    script: 'Default',
    hook: 'Default',
    gitCommit: 'Default',
    gitPush: 'Default',
    prCreate: 'Default',
    pipeline: 'Default',
    terminal: 'Default',
    runComment: 'Default',
    activation: 'Default',
  },
};

const DEFAULT_IN_APP_NOTIFICATIONS: InAppNotificationPreferences = {
  enabled: true,
  categories: {
    chat: true,
    script: true,
    hook: true,
    gitCommit: true,
    gitPush: true,
    prCreate: true,
    pipeline: true,
    terminal: true,
    runComment: true,
    activation: true,
  },
};

const DEFAULT_QUIET_HOURS: ActivationQuietHours = {
  enabled: true,
  startHour: 22,
  endHour: 8,
};

function persistSavedOsPreferences(
  next: OsNotificationPreferences,
): Promise<void> {
  return window.api.savePreferences({ osNotifications: next }).then(() => {
    refreshOsNotificationPrefs(next);
  });
}

function persistSavedInAppPreferences(
  next: InAppNotificationPreferences,
): Promise<void> {
  return window.api.savePreferences({ inAppNotifications: next }).then(() => {
    refreshInAppNotificationPrefs(next);
  });
}

export type NotificationTestStatus =
  | 'idle'
  | 'sending'
  | 'shown'
  | 'failed'
  | 'unsupported';

/**
 * This computer's notification preferences and the handlers that save them.
 * Shared by the local Notifications tab and the hosted Notifications page's
 * device sections, which render the same rows from it.
 */
export interface NotificationSettingsController {
  /** Preferences were read (or the read failed and defaults are shown). */
  loaded: boolean;
  /**
   * The read failed: rows show defaults the user never chose, so the
   * promotional, quiet-hours and close-to-tray controls are locked.
   */
  loadFailed: boolean;
  testStatus: NotificationTestStatus;
  osPrefs: OsNotificationPreferences;
  inAppPrefs: InAppNotificationPreferences;
  closeToTray: boolean;
  quietHours: ActivationQuietHours;
  promoPrefs: PromotionalNotificationPreferences;
  /**
   * The promotional controls are hidden while the journey is dark: a live
   * toggle for notifications that cannot fire is a silently-lying control.
   */
  activationJourneyEnabled: boolean;
  /** Always true: every window renders the shared toast stack. */
  toastStackEnabled: boolean;
  /** Close-to-tray applies only on Windows. */
  isWindows: boolean;
  persistQuietHours: (next: ActivationQuietHours) => Promise<void>;
  persistPromotional: (
    patch: Partial<PromotionalNotificationPreferences>,
  ) => Promise<void>;
  handleCloseToTrayToggle: (next: boolean) => Promise<void>;
  handleMasterToggle: (nextEnabled: boolean) => Promise<void>;
  handleDefaultSoundChange: (
    value: OsNotificationTopLevelSound,
  ) => Promise<void>;
  handleTestNotification: () => Promise<void>;
  handleSkipWhenFocusedToggle: (nextValue: boolean) => Promise<void>;
  handleInAppEnabledToggle: (nextValue: boolean) => Promise<void>;
  handleInAppPlacementChange: (
    nextPlacement: InAppNotificationPlacement,
  ) => Promise<void>;
  handleInAppCategoryToggle: (
    key: NotificationCategoryKey,
    nextValue: boolean,
  ) => Promise<void>;
  handleOsCategoryToggle: (
    key: NotificationCategoryKey,
    nextValue: boolean,
  ) => Promise<void>;
  handleCategorySoundChange: (
    key: NotificationCategoryKey,
    value: OsNotificationCategorySound,
  ) => Promise<void>;
  handleTestCategory: (key: NotificationCategoryKey) => Promise<void>;
}

/** Load this computer's notification preferences and expose their handlers. */
export function useNotificationSettings(): NotificationSettingsController {
  const [osPrefs, setOsPrefs] = useState<OsNotificationPreferences>(
    DEFAULT_OS_NOTIFICATIONS,
  );
  const [inAppPrefs, setInAppPrefs] = useState<InAppNotificationPreferences>(
    DEFAULT_IN_APP_NOTIFICATIONS,
  );
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [testStatus, setTestStatus] = useState<NotificationTestStatus>('idle');
  const [closeToTray, setCloseToTray] = useState(true);
  const [quietHours, setQuietHours] =
    useState<ActivationQuietHours>(DEFAULT_QUIET_HOURS);
  const [promoPrefs, setPromoPrefs] =
    useState<PromotionalNotificationPreferences>(
      DEFAULT_PROMOTIONAL_NOTIFICATIONS,
    );
  const activationJourneyEnabled = useActivationJourneyEnabled();

  const isWindows = window.platform === 'win32';

  useEffect(() => {
    void window.api
      .loadPreferences()
      .then((loadedPrefs) => {
        setOsPrefs(loadedPrefs.osNotifications ?? DEFAULT_OS_NOTIFICATIONS);
        setInAppPrefs(
          loadedPrefs.inAppNotifications ?? DEFAULT_IN_APP_NOTIFICATIONS,
        );
        setCloseToTray(loadedPrefs.closeToTray ?? true);
        setQuietHours(loadedPrefs.activationQuietHours ?? DEFAULT_QUIET_HOURS);
        setPromoPrefs(
          loadedPrefs.promotionalNotifications ??
            DEFAULT_PROMOTIONAL_NOTIFICATIONS,
        );
        setLoaded(true);
      })
      .catch(() => {
        setOsPrefs(DEFAULT_OS_NOTIFICATIONS);
        setInAppPrefs(DEFAULT_IN_APP_NOTIFICATIONS);
        setPromoPrefs(DEFAULT_PROMOTIONAL_NOTIFICATIONS);
        setLoadFailed(true);
        setLoaded(true);
      });
  }, []);

  // Send a partial patch and let main own the merge, matching every other
  // handler here. Reading the whole object first and writing it back
  // clobbers any preference saved between the read and the write -- easy to
  // hit by clicking the quiet-hours selects quickly, or from another tab.
  async function persistQuietHours(next: ActivationQuietHours): Promise<void> {
    // Same rule as `persistPromotional`: after a failed load these show
    // defaults the user never chose (quiet hours default ON), so a write
    // would persist a default as their choice.
    if (loadFailed) return;
    setQuietHours(next);
    await window.api.savePreferences({ activationQuietHours: next });
  }

  // Toggling the master never rewrites the children: their stored values are
  // the user's own choices, so switching the master back on restores them.
  async function persistPromotional(
    patch: Partial<PromotionalNotificationPreferences>,
  ): Promise<void> {
    // A failed load shows defaults the user never chose; writing a patch over
    // them could silently re-enable a category they had turned off.
    if (loadFailed) return;
    const next: PromotionalNotificationPreferences = {
      ...promoPrefs,
      ...patch,
    };
    setPromoPrefs(next);
    await window.api.savePreferences({ promotionalNotifications: next });
  }

  async function handleCloseToTrayToggle(next: boolean): Promise<void> {
    if (loadFailed) return;
    setCloseToTray(next);
    await window.api.savePreferences({ closeToTray: next });
  }

  async function handleMasterToggle(nextEnabled: boolean): Promise<void> {
    cancelOsNotificationOfferOptIn();
    const next: OsNotificationPreferences = {
      ...osPrefs,
      enabled: nextEnabled,
    };
    setOsPrefs(next);
    // An explicit master-toggle choice answers the one-time notification
    // offer. Main keeps the first stamp, so an existing answer is preserved.
    await window.api.savePreferences({
      osNotifications: next,
      osNotificationOfferAnsweredAt: new Date().toISOString(),
    });
    refreshOsNotificationPrefs(next);
    markOsNotificationOfferAnswered();

    if (!nextEnabled) {
      setTestStatus('idle');
    }
  }

  async function handleDefaultSoundChange(
    value: OsNotificationTopLevelSound,
  ): Promise<void> {
    const next: OsNotificationPreferences = {
      ...osPrefs,
      defaultSound: value,
    };
    setOsPrefs(next);
    await persistSavedOsPreferences(next);
  }

  async function handleTestNotification(): Promise<void> {
    setTestStatus('sending');
    const result = await fireTestOsNotification();
    if (result === 'unsupported') {
      setTestStatus('unsupported');
      return;
    }
    setTestStatus(result === 'shown' ? 'shown' : 'failed');
  }

  async function handleSkipWhenFocusedToggle(
    nextValue: boolean,
  ): Promise<void> {
    const next: OsNotificationPreferences = {
      ...osPrefs,
      skipWhenFocused: nextValue,
    };
    setOsPrefs(next);
    await persistSavedOsPreferences(next);
  }

  async function handleInAppEnabledToggle(nextValue: boolean): Promise<void> {
    const next: InAppNotificationPreferences = {
      ...inAppPrefs,
      enabled: nextValue,
    };
    setInAppPrefs(next);
    await persistSavedInAppPreferences(next);
  }

  async function handleInAppPlacementChange(
    nextPlacement: InAppNotificationPlacement,
  ): Promise<void> {
    const next = withChosenInAppNotificationPlacement(
      inAppPrefs,
      nextPlacement,
    );
    setInAppPrefs(next);
    await persistSavedInAppPreferences(next);
  }

  async function handleInAppCategoryToggle(
    key: NotificationCategoryKey,
    nextValue: boolean,
  ): Promise<void> {
    const next: InAppNotificationPreferences = {
      ...inAppPrefs,
      categories: { ...inAppPrefs.categories, [key]: nextValue },
    };
    setInAppPrefs(next);
    await persistSavedInAppPreferences(next);
  }

  async function handleOsCategoryToggle(
    key: NotificationCategoryKey,
    nextValue: boolean,
  ): Promise<void> {
    const next: OsNotificationPreferences = {
      ...osPrefs,
      categories: { ...osPrefs.categories, [key]: nextValue },
    };
    setOsPrefs(next);
    await persistSavedOsPreferences(next);
  }

  async function handleCategorySoundChange(
    key: NotificationCategoryKey,
    value: OsNotificationCategorySound,
  ): Promise<void> {
    const next: OsNotificationPreferences = {
      ...osPrefs,
      categorySounds: { ...osPrefs.categorySounds, [key]: value },
    };
    setOsPrefs(next);
    await persistSavedOsPreferences(next);
  }

  async function handleTestCategory(
    key: NotificationCategoryKey,
  ): Promise<void> {
    await fireTestOsNotification({ categoryKey: key });
  }

  return {
    loaded,
    loadFailed,
    testStatus,
    osPrefs,
    inAppPrefs,
    closeToTray,
    quietHours,
    promoPrefs,
    activationJourneyEnabled,
    toastStackEnabled: true,
    isWindows,
    persistQuietHours,
    persistPromotional,
    handleCloseToTrayToggle,
    handleMasterToggle,
    handleDefaultSoundChange,
    handleTestNotification,
    handleSkipWhenFocusedToggle,
    handleInAppEnabledToggle,
    handleInAppPlacementChange,
    handleInAppCategoryToggle,
    handleOsCategoryToggle,
    handleCategorySoundChange,
    handleTestCategory,
  };
}
