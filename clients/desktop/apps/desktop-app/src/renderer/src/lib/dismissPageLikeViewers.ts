/**
 * Close every page-like viewer overlay before navigating somewhere else
 * (CAN-2551).
 *
 * The archived-container viewer, the shared-container recipient surface, and
 * the recipient's Past shares page all render as full-height overlays in the same slot as the destination
 * content. Several navigation paths only closed the archived one, so the z-40
 * `SharedContainerWorkspace` stayed on top of wherever the user had just gone.
 *
 * Every navigation that leaves a viewer behind calls this instead of listing
 * the stores itself, so a future overlay is added in one place rather than
 * remembered at a dozen call sites.
 */
import { leaveAppAdvisorDock } from '@/stores/appAdvisorDockCover';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';

export interface DismissPageLikeViewersOptions {
  /**
   * Keep the shared-container viewer mounted because the destination *is* a
   * shared container.
   *
   * `closeViewer()` clears the viewer, which is the state `openContainer`'s
   * already-mounted no-op guard reads. Closing first would turn a click on the
   * share already on screen into a full re-open: back to `loading`, through
   * the access gate again, under a new viewer session.
   *
   * This flag is no longer what protects live updates. A close names the
   * viewer session it belongs to (CAN-3559), so main ignores one that lands
   * after a newer open of the same share instead of releasing that open's
   * subscription and fallback pull.
   */
  keepSharedContainerViewer?: boolean;
}

export function dismissPageLikeViewers(
  options?: DismissPageLikeViewersOptions,
): void {
  // The docked Orchestrator page covers this window's pages too: an explicit
  // navigation leaves it, even to the destination already open under it.
  leaveAppAdvisorDock();
  useArchivedContainersStore.getState().closeViewer();
  // The Past shares page shares the overlay slot and is never a destination
  // of the navigations that call this, so it always closes.
  useSharedContainerReplicasStore.getState().closePastShares();
  if (options?.keepSharedContainerViewer === true) return;
  useSharedContainerReplicasStore.getState().closeViewer();
}
