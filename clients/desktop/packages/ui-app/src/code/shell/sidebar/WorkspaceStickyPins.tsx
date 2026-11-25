'use client';

import { useLayoutEffect, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  findSelectedPinHosts,
  sameSelectedPinHosts,
  type SelectedPinHosts,
} from './sticky-selected-item';
import { useStickyWorkspaceSlotHost } from './use-sticky-workspace-slot-host';

export interface WorkspaceStickyPinsProps {
  /** The workspace whose slot this claims. */
  readonly workspaceLocalId: string;

  /**
   * A copy of this workspace's header, for the slot and the pin bands. The
   * surface names the copy so its test ids can be suffixed apart from the
   * in-flow header's (CAN-3127).
   */
  readonly renderHeader: (
    surface: 'sticky-slot' | 'pin-top' | 'pin-bottom',
  ) => ReactNode;
  /**
   * A copy of the selected row, when the selection belongs to THIS workspace
   * and is rendered in flow. Omitted otherwise — the pin bands must never show
   * a row the list is not also showing.
   */
  readonly renderSelectedGroupHeader?: (
    surface: 'pin-top' | 'pin-bottom',
  ) => ReactNode;
  readonly renderSelectedRow?: (surface: 'pin-top' | 'pin-bottom') => ReactNode;
}

/**
 * Pinned copies of a workspace's header and selected row, portaled into hosts
 * the rail owns.
 *
 * The rail occludes in-flow rows beneath its transparent sticky band with a
 * scroll-driven clip, so a header cannot simply stick — it is clipped away
 * with everything else. The rail therefore reserves hosts above the clip and
 * expects whoever renders the rows to portal copies into them. A surface that
 * does not leaves that reserved band empty, which reads as an unexplained gap
 * under Projects rather than as a missing feature.
 *
 * Hosts are resolved in a layout effect rather than passed down: they belong
 * to the rail, are created before this renders, and looking them up keeps the
 * surface from having to thread four element refs through every list level.
 */
export function WorkspaceStickyPins({
  workspaceLocalId,
  renderHeader,
  renderSelectedRow,
  renderSelectedGroupHeader,
}: WorkspaceStickyPinsProps): JSX.Element | null {
  // Its own anchor: the component renders a zero-size marker and walks up from
  // there, so a caller inside a `.map()` — which cannot hold hooks or refs —
  // does not have to thread one down.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const slotHost = useStickyWorkspaceSlotHost(anchor, workspaceLocalId);
  const [pinHosts, setPinHosts] = useState<SelectedPinHosts | null>(null);
  const hasSelectedRow = renderSelectedRow !== undefined;

  useLayoutEffect(() => {
    // Copies go into the pin bands only while this workspace owns the
    // selection (see below): they are singular, and a workspace that merely
    // exists must not take them. The hosts are found ahead, so a selection
    // arriving renders its copies in its own commit rather than in a second
    // render of the rail; hosts that did not change keep their state.
    const next = findSelectedPinHosts(anchor);
    setPinHosts((previous) =>
      sameSelectedPinHosts(previous, next) ? previous : next,
    );
  }, [anchor, hasSelectedRow]);

  return (
    <>
      <span ref={setAnchor} aria-hidden="true" className="hidden" />
      {slotHost && createPortal(renderHeader('sticky-slot'), slotHost)}
      {pinHosts && renderSelectedRow && (
        <>
          {createPortal(renderHeader('pin-top'), pinHosts.topHeader)}
          {renderSelectedGroupHeader &&
            pinHosts.topGroupHeader &&
            createPortal(
              renderSelectedGroupHeader('pin-top'),
              pinHosts.topGroupHeader,
            )}
          {createPortal(renderSelectedRow('pin-top'), pinHosts.topRow)}
          {createPortal(renderHeader('pin-bottom'), pinHosts.bottomHeader)}
          {renderSelectedGroupHeader &&
            pinHosts.bottomGroupHeader &&
            createPortal(
              renderSelectedGroupHeader('pin-bottom'),
              pinHosts.bottomGroupHeader,
            )}
          {createPortal(renderSelectedRow('pin-bottom'), pinHosts.bottomRow)}
        </>
      )}
    </>
  );
}
