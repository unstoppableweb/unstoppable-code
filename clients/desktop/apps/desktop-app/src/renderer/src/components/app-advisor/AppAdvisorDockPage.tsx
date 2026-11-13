/**
 * The Orchestrator as a page in the main window, in the same layout as a
 * cowork chat: the main sidebar stays, this page draws the cowork top bar
 * (`CoworkTopBar` in its custom-slot mode), and below it a slot where the
 * main process places the Orchestrator's own page (its `WebContentsView`,
 * docked; see `main/app-advisor/advisor-host.ts`). That page keeps the
 * single writer for Orchestrator chats and draws the panel grid: tabs, Side
 * Panel and composer.
 *
 * The slot reports its rectangle on every layout change. A native view
 * paints over this page, so while a menu, dialog or palette of this window
 * covers the slot, the slot asks for a still frame of the Orchestrator page,
 * shows it, and hides the live page until the overlay closes.
 */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { AppAdvisorDockRect } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { Heading, TitlebarIconButton } from '@canopy/ui-shared/components';
import {
  AppAdvisorIcon,
  ArchiveBoxIcon,
  EditBigIcon,
  ExternalIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { CoworkTopBar } from '@/components/panels/CoworkTopBar';
import { CollapsedTitlebarToggle } from '@/components/sidebar/CollapsedTitlebarToggle';
import { OpenDropdown } from '@/components/worktree/OpenDropdown';
import {
  hasBrowserNativeViewOverlay,
  subscribeBrowserOverlayTopology,
} from '@/lib/browserNativeOverlay';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

/** The Orchestrator's active Work Entry, as its page last reported it. */
function useActiveWorkEntryId(): string | null {
  return useCurrentUiStateStore((s) => {
    const slice = s.slices['appAdvisor.window'];
    if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) {
      return null;
    }
    const id = slice.activeWorkEntryId;
    return typeof id === 'string' ? id : null;
  });
}

function sameRect(
  a: AppAdvisorDockRect | null,
  b: AppAdvisorDockRect | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height)
  );
}

function AppAdvisorDockTopBar(): JSX.Element {
  const openDocked = useAppAdvisorStore((s) => s.openDocked);
  const openSeparateWindow = useAppAdvisorStore((s) => s.openSeparateWindow);
  const activeWorkEntryId = useActiveWorkEntryId();
  return (
    <CoworkTopBar
      workspaceId={APP_ADVISOR_PROJECT_ID}
      readOnlyContent={{
        leadingAccessory: <CollapsedTitlebarToggle />,
        statusContent: (
          <div
            className="flex min-w-0 items-center gap-2 pl-1"
            data-testid="app-advisor-dock-title"
          >
            <AppAdvisorIcon
              size={16}
              aria-hidden="true"
              className="shrink-0 fg-secondary"
            />
            <Heading level={1} variant="title" truncate className="min-w-0">
              {ORCHESTRATOR_LABEL}
            </Heading>
          </div>
        ),
        trailingAccessory: (
          <div className="electron-drag flex shrink-0 items-center gap-1 pr-2.25">
            <div className="electron-no-drag flex items-center gap-1">
              <TitlebarIconButton
                icon={EditBigIcon}
                aria-label="New chat"
                data-testid="app-advisor-dock-new-chat"
                onClick={(): void => openDocked({ newWorkEntry: true })}
              />
              <TitlebarIconButton
                icon={ArchiveBoxIcon}
                aria-label="Archived and deleted"
                data-testid="app-advisor-dock-archived"
                onClick={(): void => openDocked({ archivedOverview: {} })}
              />
              <TitlebarIconButton
                icon={SettingsIcon}
                aria-label={`${ORCHESTRATOR_LABEL} settings`}
                data-testid="app-advisor-dock-settings"
                onClick={(): void => openDocked({ openSettings: true })}
              />
              {/* Pin, rename, archive, delete and groups stay in the
                  separate window's nav for now (see the step 1 plan). */}
              <TitlebarIconButton
                icon={ExternalIcon}
                aria-label="Open in separate window"
                data-testid="app-advisor-dock-open-window"
                onClick={openSeparateWindow}
              />
            </div>
            {activeWorkEntryId !== null && (
              <OpenDropdown
                projectId={APP_ADVISOR_PROJECT_ID}
                worktreeId={activeWorkEntryId}
              />
            )}
          </div>
        ),
      }}
    />
  );
}

/** Where the Orchestrator's page goes, kept in step with this element. */
function AppAdvisorDockSlot(): JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const reported = useRef<{
    rect: AppAdvisorDockRect | null;
    visible: boolean;
  }>({ rect: null, visible: true });

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot === null) return undefined;
    let disposed = false;
    // Requests go out in order: a covered-then-uncovered pair must not land
    // reversed.
    let queue: Promise<void> = Promise.resolve();

    const send = (
      rect: AppAdvisorDockRect | null,
      visible: boolean,
      captureFrame: boolean,
    ): void => {
      queue = queue.then(async (): Promise<void> => {
        // A request queued by a page that has since closed does nothing: its
        // late visibility would overwrite the reopened page's.
        if (disposed) return;
        if (captureFrame) {
          // The still frame first, while the page still shows, then hide it
          // once the frame stands in, so nothing flashes.
          const result = await window.api.appAdvisor
            .setDock({ rect, visible: true, captureFrame: true })
            .catch((error: unknown) => {
              reportClientAppError(error);
              return null;
            });
          if (disposed) return;
          setFrame(result?.frame ?? null);
        }
        await window.api.appAdvisor
          .setDock({ rect, visible })
          .catch((error: unknown) => {
            reportClientAppError(error);
          });
        if (visible && !disposed) {
          // The live page is back over the frame; drop it a frame later.
          requestAnimationFrame(() => {
            if (!disposed) setFrame(null);
          });
        }
      });
    };

    const update = (): void => {
      const box = slot.getBoundingClientRect();
      const rect: AppAdvisorDockRect = {
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
      };
      const visible = !hasBrowserNativeViewOverlay(document, {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      });
      const previous = reported.current;
      if (sameRect(previous.rect, rect) && previous.visible === visible) {
        return;
      }
      reported.current = { rect, visible };
      send(rect, visible, previous.visible && !visible);
    };

    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(slot);
    window.addEventListener('resize', update);
    const unsubscribeOverlays = subscribeBrowserOverlayTopology(update);
    return (): void => {
      disposed = true;
      resizeObserver.disconnect();
      window.removeEventListener('resize', update);
      unsubscribeOverlays();
      reported.current = { rect: null, visible: true };
      void window.api.appAdvisor
        .setDock({ rect: null, visible: false })
        .catch((error: unknown) => {
          reportClientAppError(error);
        });
    };
  }, []);

  return (
    <div
      ref={slotRef}
      className="relative min-h-0 flex-1"
      data-testid="app-advisor-dock-slot"
    >
      {frame !== null && (
        <img
          src={frame}
          alt=""
          aria-hidden="true"
          // A picture of the Orchestrator page, chats and files included:
          // its pixels never reach session replay.
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} pointer-events-none absolute inset-0 size-full select-none`}
          data-testid="app-advisor-dock-frame"
        />
      )}
    </div>
  );
}

export function AppAdvisorDockPage(): JSX.Element {
  return (
    <section
      className="flex h-full flex-col"
      data-testid="app-advisor-dock-page"
    >
      <AppAdvisorDockTopBar />
      <AppAdvisorDockSlot />
    </section>
  );
}
