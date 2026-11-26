'use client';

/**
 * Shared, browser-safe worktree top bar (CAN-1485).
 *
 * THE single source of truth for the worktree top bar's markup and styling on
 * every surface. The desktop renderer mounts it through a thin smart wrapper
 * (`apps/desktop-app/.../panels/WorktreeTopBar.tsx`) that wires stores/IPC and
 * injects its host-only children into the slots below; the web portal mounts it
 * directly with projected data. Neither host authors any bar layout or styles —
 * the frame here is byte-matched to the desktop original it replaced, including
 * the `electron-drag`/`electron-no-drag` classes (inert no-ops on the web).
 *
 * Left to right, mirroring the desktop bar:
 * - {@link WorktreeTopBarProps.leadingAccessory} (desktop: the collapsed-
 *   titlebar spacer in list view);
 * - the status region: {@link WorktreeTopBarProps.statusContent} (desktop:
 *   `PrStatusBar`) or, when absent, the built-in read-only branch/base summary
 *   plus the capability-gated native `Open ▾` (the portal path);
 * - the launch cluster: {@link WorktreeTopBarProps.launchControl} (desktop:
 *   `WorktreeLaunchButton`) or, when absent, the built-in Launch/Stop pair
 *   driven by the script props (the portal path);
 * - {@link WorktreeTopBarProps.pinnedActions}: pinned scripts, rendered only
 *   when the host can execute them (`scriptActions` and `terminalPty`), so
 *   the Portal never shows an executable pin;
 * - the capability-gated panel-layout toggle (dormant on every host until a
 *   real toggle handler exists);
 * - {@link WorktreeTopBarProps.trailingAccessory} (desktop:
 *   `SaveLayoutDefaultControl`).
 *
 * Boundary rules (locked by the transport slice; behavior authored here):
 * - Reuse the established shared script-action contract:
 *   {@link WorktreeTopBarScriptHostActions} is a `Pick` of the existing
 *   `ActivityPanelHostActions.onRunScript` / `.onCancelScript` (imported
 *   type-only from the activity module — no second script-action interface is
 *   created, and files under `code/activity/*` are not edited here).
 * - Those callbacks take the protocol `RemoteControlScriptDescriptor` /
 *   `RemoteControlScriptRunProjection` (both require `scriptKey`), while the portal's
 *   `PortalScript*Entity` values carry an optional `scriptKey`; the portal maps
 *   entity→protocol at the boundary and only offers Launch/Stop when a
 *   `scriptKey` is present.
 * - Active-run classification follows the portal projection
 *   (`launchRun.status === 'queued' || 'running'`); `status` arrives as a loose
 *   `string` on the projection, so it is compared by value.
 * - Capability-gated controls (native `Open`, panel-layout toggle) render only
 *   when their feature surface is available AND the matching handler exists;
 *   capability `true` without a handler still hides the control (no dead UI).
 */
import { WorktreeTopBarSurface } from '@canopy/ui-shared/components';
import type { JSX, ReactNode } from 'react';
import type {
  RemoteControlScriptDescriptor,
  RemoteControlScriptRunProjection,
} from '@canopy/protocol/remote-control/shell';
import { Button } from '@canopy/ui-shared/primitives/Button';
import {
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LayoutWindowIcon,
  RocketLaunchIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  ExecutionActionButton,
  LoadingSpinner,
  TitlebarIconButton,
  Tooltip,
} from '@canopy/ui-shared/components';
import { useCapabilities } from '@canopy/app-state';
import { isFeatureSurfaceAvailable } from '@canopy/app-core/gating';
import type { ActivityPanelHostActions } from '../activity/ActivityPanel';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  WorktreeTopBarPins,
  type WorktreeTopBarPinnedAction,
} from './WorktreeTopBarPins';

export type { WorktreeTopBarPinnedAction } from './WorktreeTopBarPins';

/**
 * Script-action seam consumed by the worktree top bar. Reuses exactly the two
 * shared members of `ActivityPanelHostActions`; the bar never defines its own
 * script-action interface.
 */
export type WorktreeTopBarScriptHostActions = Pick<
  ActivityPanelHostActions,
  'onRunScript' | 'onCancelScript'
>;

/** Public props for the shared worktree top bar. */
export interface WorktreeTopBarProps {
  /**
   * Rendered before the bar's first section (desktop: the animated
   * collapsed-titlebar corner spacer in list view).
   */
  readonly leadingAccessory?: ReactNode;
  /**
   * Fills the flexible status region (desktop: `PrStatusBar`). When absent the
   * bar renders its built-in read-only branch/base summary from
   * {@link branchLabel}/{@link baseBranchLabel} plus the capability-gated
   * native `Open ▾`.
   */
  readonly statusContent?: ReactNode;
  /**
   * Fills the launch cluster (desktop: `WorktreeLaunchButton`). When absent the
   * bar renders its built-in Launch/Stop pair from the script props below.
   */
  readonly launchControl?: ReactNode;
  /** Trailing slot at the bar's right edge (desktop: `SaveLayoutDefaultControl`). */
  readonly trailingAccessory?: ReactNode;
  /**
   * Pinned scripts, placed before the launch cluster. Hosts pass only
   * approved, available actions; the bar additionally renders them only when
   * `scriptActions` and `terminalPty` are both available.
   */
  readonly pinnedActions?: readonly WorktreeTopBarPinnedAction[];
  /**
   * The PR status run beside the built-in summary (unused with
   * `statusContent`): the shared `PullRequestActions`, which desktop renders
   * inside its own `PrStatusBar`. Packs right, on the run's 4px rhythm.
   */
  readonly statusActions?: ReactNode;
  /**
   * The solid-cluster action after the status run (unused with
   * `statusContent`): the shared `PullRequestCreateAction`, as desktop
   * places Create PR beside `Open in`.
   */
  readonly primaryAction?: ReactNode;
  /**
   * Beside the built-in summary's base branch (unused with `statusContent`):
   * the shared base-branch drift warning, where desktop's breadcrumb shows
   * it.
   */
  readonly baseBranchAccessory?: ReactNode;

  /**
   * Leading glyph for the built-in status summary (unused with
   * `statusContent`). Desktop injects a full `PrStatusBar`, which opens with
   * the workspace badge; without this the built-in fallback opened with a bare
   * git glyph instead, so the two surfaces disagreed on what identifies the
   * worktree. Omitted — a repoless host, say — falls back to the git glyph.
   */
  readonly workspaceBadge?: ReactNode;

  /** Branch shown by the built-in status summary (unused with `statusContent`). */
  readonly branchLabel?: string;
  readonly baseBranchLabel?: string;
  readonly launchScript?: RemoteControlScriptDescriptor;
  readonly launchRun?: RemoteControlScriptRunProjection;
  readonly launchPending?: boolean;
  readonly launchStopping?: boolean;
  readonly commandsDisabled?: boolean;
  readonly hostActions?: WorktreeTopBarScriptHostActions;

  readonly panelLayoutActive?: boolean;
  readonly onTogglePanelLayout?: () => void;

  readonly openMenuExpanded?: boolean;
  readonly onOpenWorktreeMenu?: () => void;
}

/**
 * Active-run classification follows the portal projection: a run is in-flight
 * while `queued` or `running`. `status` arrives as a loose `string`, so it is
 * compared by value (see `isRunActive` in the portal scripts panel). Every
 * other status (`completed`/`success`/`failed`/`cancelled`/`timed_out`) is
 * treated as not-active, so the control returns to `Launch` whenever a
 * descriptor remains — the single "not active" source of truth avoids an
 * enumerated terminal list.
 */
function isLaunchRunActive(
  run: RemoteControlScriptRunProjection | undefined,
): boolean {
  return run?.status === 'queued' || run?.status === 'running';
}

/**
 * The shared worktree top bar. Owns the bar frame and every built-in control;
 * hosts inject their smart children through the slots and own all state and
 * mutation — this component only reflects the props it is given.
 */
export function WorktreeTopBar({
  leadingAccessory,
  statusContent,
  launchControl,
  trailingAccessory,
  pinnedActions,
  statusActions,
  primaryAction,
  baseBranchAccessory,
  workspaceBadge,
  branchLabel,
  baseBranchLabel,
  launchScript,
  launchRun,
  launchPending,
  launchStopping,
  commandsDisabled,
  hostActions,
  panelLayoutActive,
  onTogglePanelLayout,
  openMenuExpanded,
  onOpenWorktreeMenu,
}: WorktreeTopBarProps): JSX.Element {
  const capabilities = useCapabilities();
  const onRunScript = hostActions?.onRunScript;
  const onCancelScript = hostActions?.onCancelScript;

  // The native `Open ▾` and the panel-layout toggle each render only when their
  // feature surface is available AND the matching handler exists. On portal both
  // capabilities are `false`, so neither renders; capability `true` without a
  // handler still hides the control (no dead UI).
  const openAvailable =
    isFeatureSurfaceAvailable(capabilities, 'native-worktree-open') &&
    onOpenWorktreeMenu != null;
  const layoutAvailable =
    isFeatureSurfaceAvailable(capabilities, 'panel-layout-controls') &&
    onTogglePanelLayout != null;
  // Pins execute in a local terminal: a host without one (Portal, cloud)
  // never renders them, whatever it passes.
  const pins =
    capabilities.scriptActions === true && capabilities.terminalPty === true
      ? (pinnedActions ?? [])
      : [];

  // Desktop parity (isRunning || isStopping): the Stop control is shown while a
  // launch run is active or a cancel is optimistically in flight; otherwise the
  // idle Launch control is shown whenever a descriptor exists. With neither a
  // descriptor nor an active run there is no launch control at all.
  const stopping = launchStopping === true;
  const showStop = isLaunchRunActive(launchRun) || stopping;
  const showLaunch = !showStop && launchScript != null;

  return (
    // `@container/topbar` measures the WHOLE bar, so the compact variants in
    // the status region (Create PR copy) and in the launch cluster (Launch →
    // icon) key off one width that their own collapsing cannot change.
    // Keying them off the flexible status region instead would oscillate:
    // collapsing Launch widens that region, which would re-expand the label,
    // which re-narrows the region.
    <WorktreeTopBarSurface
      data-testid="worktree-top-bar"
      // `cursor-default` for the whole bar: it is app chrome, not a
      // document. Wrappers and label spans default to `cursor: auto`, which
      // renders an I-beam over their text, so hovering the branch name or a
      // button's label showed a text caret mid-chrome.
      // The surface lives on the ROOT, not only on the status content, so the
      // bar's background and bottom separator run the full width of the window —
      // including the leading spacer that reserves the collapsed titlebar
      // corner. The separator is absolutely positioned so it does not add a
      // pixel to the bar's 46px outer-frame contract. With the surface on the
      // status content alone, that spacer region showed the bare window
      // material as a grey notch and the separator started late.
    >
      {leadingAccessory}
      <div className="min-w-0 flex-1">
        {statusContent ?? (
          /* Byte-matched to desktop `PrStatusBar`'s at-rest frame: same
             container root, row, branch section (icon in a reserved 20px box,
             RTL tail-truncation with an LRM guard, container-query max
             widths), chevron separator, base-branch breadcrumb (chevron-down
             included — on desktop it is the base-branch selector trigger; here
             it is read-only until a portal base-branch flow exists), and the
             right-aligned `Open ▾` slot position. */
          <div
            data-testid="worktree-top-status"
            className="@container/prbar electron-drag min-h-11.5 px-4 py-2.5"
          >
            <div className="flex min-h-6.5 items-center gap-3 text-xs">
              {/* A repoless (cowork) host withholds the branch entirely, so
                  the whole summary — icon, branch chip, and base-branch
                  breadcrumb — drops out rather than rendering an empty label
                  next to a git glyph (CAN-2337). The status region itself
                  stays, keeping the bar's frame, height, and `Open` slot. */}
              {branchLabel != null && branchLabel !== '' && (
                <div className="group/branch electron-no-drag flex items-center gap-1.5 fg-secondary">
                  <span
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
                    data-testid="worktree-top-badge-slot"
                  >
                    {workspaceBadge ?? <BranchIcon size="sm" />}
                  </span>
                  <span
                    data-testid="worktree-top-branch"
                    className="relative min-w-15 max-w-[50cqw] truncate"
                    style={{ direction: 'rtl' }}
                    title={branchLabel}
                  >
                    <span className={`${REPLAY_MASK_CLASS} fg-primary/80`}>
                      {'\u200E'}
                      {branchLabel}
                    </span>
                  </span>
                  {baseBranchLabel != null && baseBranchLabel !== '' && (
                    <>
                      <span className="shrink-0 fg-secondary/50">
                        <ChevronRightIcon size="sm" />
                      </span>
                      {/* No disclosure caret: this summary is read-only (see
                          `statusContent`). Desktop swaps in `PrStatusBar`,
                          whose base-branch control is a real selector; the
                          caret here advertised a menu that could not open
                          (CAN-2522). It comes back with the control, not
                          before it. */}
                      <span
                        data-testid="worktree-top-base-branch"
                        className="inline-flex min-w-0 items-center px-0.5"
                        title={baseBranchLabel}
                      >
                        <span
                          className="max-w-[50cqw] truncate"
                          style={{ direction: 'rtl' }}
                        >
                          {'\u200E'}
                          {baseBranchLabel}
                        </span>
                      </span>
                      {baseBranchAccessory}
                    </>
                  )}
                </div>
              )}

              {statusActions != null && (
                // Desktop's status run: badges and git actions pack right
                // against the cluster on a 4px ghost rhythm.
                <div
                  data-testid="worktree-top-status-actions"
                  className="ml-auto flex min-w-0 items-center gap-1 electron-no-drag"
                >
                  {statusActions}
                </div>
              )}
              {primaryAction != null && (
                // Desktop's solid cluster: an 8px standoff from the run.
                <div className="pl-1 flex shrink-0 items-center gap-2 electron-no-drag">
                  {primaryAction}
                </div>
              )}
              {openAvailable && (
                <div
                  className={`${statusActions == null ? 'ml-auto ' : ''}electron-no-drag`}
                >
                  <Button
                    variant="ghost"
                    size="compact"
                    className="electron-no-drag"
                    data-testid="worktree-top-open"
                    onClick={onOpenWorktreeMenu}
                    aria-haspopup="menu"
                    aria-expanded={openMenuExpanded === true}
                  >
                    Open
                    <ChevronDownIcon size="sm" className="shrink-0" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="electron-drag flex shrink-0 items-center gap-2 pr-2.25">
        <WorktreeTopBarPins pins={pins} />
        {launchControl ?? (
          <div className="flex items-center gap-1.5">
            {showStop && (
              <Tooltip label={stopping ? 'Stopping scripts' : 'Stop scripts'}>
                <Button
                  variant="ghost-destructive"
                  size="compact"
                  className="electron-no-drag"
                  data-testid="worktree-top-stop"
                  onClick={(): void => {
                    if (launchRun != null && onCancelScript != null) {
                      void onCancelScript(launchRun);
                    }
                  }}
                  disabled={
                    commandsDisabled === true ||
                    onCancelScript == null ||
                    stopping
                  }
                  aria-label={stopping ? 'Stopping scripts' : 'Stop scripts'}
                >
                  <LoadingSpinner />
                  {stopping ? 'Stopping' : 'Stop'}
                </Button>
              </Tooltip>
            )}
            {showLaunch && (
              <ExecutionActionButton
                label="Launch"
                ariaLabel="Launch scripts"
                variant="primary"
                dataTestId="worktree-top-launch"
                onClick={(): void => {
                  if (launchScript != null && onRunScript != null) {
                    void onRunScript(launchScript);
                  }
                }}
                disabled={
                  commandsDisabled === true ||
                  launchPending === true ||
                  onRunScript == null
                }
                title={
                  launchPending === true ? 'Launch in progress' : undefined
                }
                icon={<RocketLaunchIcon size="sm" />}
              />
            )}
          </div>
        )}
        {layoutAvailable && (
          <TitlebarIconButton
            data-testid="worktree-top-layout-toggle"
            onClick={onTogglePanelLayout}
            icon={LayoutWindowIcon}
            aria-label="Toggle panel layout"
            aria-pressed={panelLayoutActive === true}
            title="Toggle panel layout"
          />
        )}
        {trailingAccessory}
      </div>
    </WorktreeTopBarSurface>
  );
}
