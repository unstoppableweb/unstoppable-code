/**
 * Collapsing a workspace while its sticky header is stuck (pinned below the
 * sidebar's sticky controls group, or already being pushed out) removes the
 * section's rows from flow, which would leave the collapsed header above the
 * sticky line — invisible behind the transparent controls group. Call this
 * before committing the collapse: it detects either the legacy sticky-header
 * offset or the current projected-slot ownership and, after the DOM updates,
 * corrects the viewport scroll so the collapsed header lands just below the
 * sticky controls — still visible instead of scrolled out at the top of the
 * view.
 *
 * The correction runs in a requestAnimationFrame callback (after the collapse
 * has committed and been laid out, before the next paint) and only when the
 * header actually ended up above the sticky line, so collapses that naturally
 * keep the header on screen are left untouched.
 */
/**
 * Scroll anchoring suspensions in flight, per viewport. Two collapses in one
 * frame used to each save the inline value and restore it later, so the
 * second saved the first's `'none'` and restored that last, leaving anchoring
 * off for good. The first suspension keeps the caller's value; the last
 * resume puts it back.
 */
const anchorSuspensions = new WeakMap<
  HTMLElement,
  { depth: number; previous: string }
>();

function suspendOverflowAnchor(viewport: HTMLElement): void {
  const held = anchorSuspensions.get(viewport);
  if (held) {
    held.depth += 1;
    return;
  }
  anchorSuspensions.set(viewport, {
    depth: 1,
    previous: viewport.style.overflowAnchor,
  });
  viewport.style.overflowAnchor = 'none';
}

function resumeOverflowAnchor(viewport: HTMLElement): void {
  const held = anchorSuspensions.get(viewport);
  if (!held) return;
  held.depth -= 1;
  if (held.depth > 0) return;
  anchorSuspensions.delete(viewport);
  viewport.style.overflowAnchor = held.previous;
}

export function scheduleStickyCollapseScrollAdjust(
  sectionRoot: HTMLElement | null,
): void {
  if (!sectionRoot) return;
  const viewport = sectionRoot.closest<HTMLElement>(
    '[data-testid="sidebar-scroll-container"]',
  );
  const header = sectionRoot.querySelector<HTMLElement>(
    '.sidebar-workspace-sticky-header, [data-sidebar-workspace-header]',
  );
  if (!viewport || !header) return;

  // Current workspace headers remain in flow while a portal copy occupies the
  // sticky slot, so their section-relative offset stays zero. Detect that
  // projected ownership explicitly; retaining only the old offset check makes
  // the first collapsed workspace land behind the controls with no clickable
  // flow copy left to expand it again.
  const workspaceId = sectionRoot.dataset.sidebarWorkspaceId;
  const stickySlot = viewport.querySelector<HTMLElement>(
    '[data-testid="sidebar-sticky-workspace-slot"]',
  );
  const ownsProjectedSlot =
    workspaceId !== undefined &&
    stickySlot?.hidden === false &&
    stickySlot.dataset.activeWorkspaceId === workspaceId;
  const stuckOffset =
    header.getBoundingClientRect().top -
    sectionRoot.getBoundingClientRect().top;
  if (!ownsProjectedSlot && stuckOffset <= 1) return;
  // Where the projected copy is drawn right now. Under another project's
  // selected pin the slot sits below the controls, and the flow header must
  // land there: lined up with the controls it would sit behind that pin.
  const projectedSlotTop =
    ownsProjectedSlot && stickySlot
      ? stickySlot.getBoundingClientRect().top
      : null;

  // The rows removed by the collapse sit above most visible workspaces. Native
  // scroll anchoring otherwise keeps one of those trailing rows stationary and
  // can undo the correction below, leaving this header covered even though we
  // wrote the right scrollTop. Suppress it across the collapse layout pass.
  suspendOverflowAnchor(viewport);
  requestAnimationFrame(() => {
    try {
      // Only correct while the collapse is still in effect: a collapse that
      // was immediately re-expanded (or never committed) must not move the
      // scroll out from under subsequent pointer interactions.
      if (sectionRoot.getAttribute('data-workspace-expanded') !== 'false') {
        return;
      }
      const controls = viewport.querySelector<HTMLElement>(
        '[data-testid="sidebar-more-sticky-container"]',
      );
      if (!controls || !viewport.contains(header)) return;
      const headerTop = header.getBoundingClientRect().top;
      // Align with the projected slot, not below its occlusion band. The slot
      // represents this header even when collapse removes its rows container.
      const controlsBottom = controls.getBoundingClientRect().bottom;
      const visibleHeaderTop =
        projectedSlotTop === null
          ? controlsBottom
          : Math.max(controlsBottom, projectedSlotTop);
      if (headerTop >= visibleHeaderTop - 0.5) return;
      // The collapsed section is header-only, so the header tracks scroll 1:1.
      viewport.scrollTop = Math.max(
        0,
        viewport.scrollTop + headerTop - visibleHeaderTop,
      );
      // A correction can clamp at scrollTop 0. Browsers emit no scroll event
      // for that no-op assignment. Synchronize the projection with the new
      // geometry before the next paint, including when clamped at the top.
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    } finally {
      // Chromium applies scroll anchoring during rendering, after this first
      // callback. Keep it disabled through that paint, then restore the
      // caller's prior inline value on the next frame.
      requestAnimationFrame(() => {
        resumeOverflowAnchor(viewport);
      });
    }
  });
}
