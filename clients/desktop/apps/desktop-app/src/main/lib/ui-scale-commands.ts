import {
  adjustUiScale,
  type UiScaleAdjustment,
} from '@canopy/desktop-shared/lib/ui-scale';
import {
  projectPreferencesForRuntime,
  updatePreferencesFileWithPrevious,
} from './preferences-store';
import { broadcastPreferencesSynced } from './preferences-broadcast';
import { applyUiZoomToAllWindows, uiScaleToZoomFactor } from './ui-zoom';

/**
 * Applies one Zoom In / Zoom Out / Actual Size command from the View menu.
 *
 * Deliberately NOT Electron's `zoomIn`/`zoomOut`/`resetZoom` menu roles:
 * those move `webContents` zoom directly and never touch `uiScale`, so the
 * live zoom would drift away from the saved preference and the next
 * `preferences:save`, window reload or `did-finish-load` would silently
 * revert it. Stepping the preference instead keeps the Display slider, the
 * shortcuts and every open window (main, App Advisor, panel pull-outs) in
 * agreement — this is the same persist → fan out → broadcast sequence the
 * slider's `savePreferences({ uiScale })` takes.
 *
 * Resolves to the scale now in effect. A command that cannot move the scale
 * (Zoom In at 200%, Actual Size at 100%) commits nothing and skips the fan
 * out, so holding a shortcut at the end of the range costs no writes.
 */
export async function applyUiScaleCommand(
  adjustment: UiScaleAdjustment,
): Promise<number> {
  const { previous, next, domainUnread } =
    await updatePreferencesFileWithPrevious((current) => {
      const uiScale = adjustUiScale(current.uiScale, adjustment);
      // `null` is what actually skips the write. Returning a patch and
      // filtering afterwards would still commit preferences.json and its
      // last-good backup for a command that changed nothing, and a held
      // shortcut at either end of the range would queue one such write per
      // repeat ahead of unrelated preference saves on the same queue.
      return uiScale === current.uiScale ? null : { uiScale };
    });
  if (previous.uiScale === next.uiScale) return next.uiScale;
  applyUiZoomToAllWindows(uiScaleToZoomFactor(next.uiScale));
  // Its domain keys are defaults standing in for an unread document.
  if (domainUnread !== true)
    broadcastPreferencesSynced(next, projectPreferencesForRuntime);
  return next.uiScale;
}
