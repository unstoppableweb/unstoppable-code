import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type { JSX } from 'react';
import { RunningGlyph, Tooltip } from '@canopy/ui-shared/components';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib/operational-status-colors';
import { AppAdvisorIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';

/**
 * Early access: the floating App Advisor panel, minimized. A round bubble
 * in this window's bottom-right corner, where the panel's corner was (16px
 * from the edges), on the panel's surface and shadow. Clicking it opens the
 * panel again as it was. The main process only reports `minimized` with
 * early access, for a floating panel. While the Orchestrator works, its
 * orbit turns in the running ink, as on its sidebar row.
 */
export function AppAdvisorMinimizedBubble({
  running,
}: {
  readonly running: boolean;
}): JSX.Element | null {
  const minimized = useAppAdvisorStore((s) => s.minimized && !s.open);
  const openDialog = useAppAdvisorStore((s) => s.openDialog);
  if (!minimized) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-drawer"
      // The bubble stays up for as long as the advisor is minimized. Counted
      // as an overlay it would hold any Browser page under this corner on its
      // still frame the whole time, so it opts out of the layer default.
      data-canopy-browser-native-overlay="false"
    >
      <Tooltip label={`Open ${ORCHESTRATOR_LABEL}`} placement="left">
        <button
          type="button"
          aria-label={
            running
              ? `Open ${ORCHESTRATOR_LABEL}: thinking`
              : `Open ${ORCHESTRATOR_LABEL}`
          }
          data-testid="app-advisor-minimized-bubble"
          onClick={openDialog}
          className={`focus-ring inline-flex size-10 items-center justify-center rounded-full bg-tertiary shadow-xl transition-colors ${
            running
              ? OPERATIONAL_STATUS_COLORS.active.foreground
              : 'fg-secondary hover:fg-primary'
          }`}
        >
          <RunningGlyph running={running}>
            <AppAdvisorIcon size={20} aria-hidden="true" />
          </RunningGlyph>
        </button>
      </Tooltip>
    </div>
  );
}
