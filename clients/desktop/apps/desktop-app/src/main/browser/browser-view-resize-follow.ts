import type { BrowserRectangle } from '@canopy/desktop-shared/types';

/**
 * Where a Browser page area will sit at a window size the renderer has not
 * laid out yet.
 *
 * A page is a native view over the window. The renderer reports the page
 * area's rectangle after each layout, so during a window resize the view
 * used to reach its place one to four frames after the window and the card
 * around it: it visibly trailed the edge being dragged. The window's own
 * `resize` event arrives first, in the main process, so the view is moved
 * there, to where the last reports say the area is heading, and the
 * renderer's report then confirms or corrects it.
 *
 * An edge of the area moves in a straight line against the window size
 * between layout limits (a fixed sidebar, a proportional split), so each
 * edge is extended from the latest report along the slope the reports of
 * this resize have shown. Until they have shown one (the first steps of a
 * drag, or just after the layout jumped at a breakpoint) an edge keeps its
 * share of the window, which is what a panel grid does and is never further
 * off than leaving the view where it was.
 */

export interface PageAreaReport {
  /** The renderer's viewport when it measured, in its CSS px. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** The page area it measured, in the same CSS px. */
  readonly bounds: BrowserRectangle;
  readonly at: number;
}

/** Reports kept: enough to find one a useful distance back. */
const REPORTS_KEPT = 8;
/**
 * A report this far away in viewport size gives a steady slope: closer ones
 * differ by a pixel or two of rounding, which a slope would magnify.
 */
const SLOPE_BASELINE_PX = 24;
/** Reports this close in time belong to one resize. */
const ACTIVE_RESIZE_MS = 400;

const EDGES = ['left', 'right', 'top', 'bottom'] as const;
type Edge = (typeof EDGES)[number];

const EDGE_AXIS: Record<Edge, 'width' | 'height'> = {
  left: 'width',
  right: 'width',
  top: 'height',
  bottom: 'height',
};

function edgeOf(report: PageAreaReport, edge: Edge): number {
  const { x, y, width, height } = report.bounds;
  if (edge === 'left') return x;
  if (edge === 'right') return x + width;
  if (edge === 'top') return y;
  return y + height;
}

/** An edge follows the window's own edge, or part of the way, or stays. */
function plausibleSlope(slope: number): boolean {
  return Number.isFinite(slope) && slope >= -0.01 && slope <= 1.01;
}

export class PageAreaFollower {
  private reports: PageAreaReport[] = [];
  /** How far each edge moves per px of window size, as last measured. */
  private slopes = new Map<Edge, number>();

  record(report: PageAreaReport): void {
    const latest = this.reports[this.reports.length - 1];
    // A report from before this resize sits under another layout, so it says
    // where the area is but nothing about how it moves now.
    if (latest && report.at - latest.at > ACTIVE_RESIZE_MS) {
      this.reports = [latest];
    }
    // The pane reports twice per layout (the resize event and its observer).
    if (
      latest &&
      latest.viewport.width === report.viewport.width &&
      latest.viewport.height === report.viewport.height
    ) {
      // The same window, another place: a panel was dragged or the layout
      // changed. The edges most likely still move the way they did, but
      // nothing can be measured across the change.
      if (EDGES.some((edge) => edgeOf(latest, edge) !== edgeOf(report, edge))) {
        this.reports = [];
      } else {
        this.reports.pop();
      }
      this.reports.push(report);
      return;
    }
    this.reports.push(report);
    if (this.reports.length > REPORTS_KEPT) this.reports.shift();
    this.measure();
  }

  forget(): void {
    this.reports = [];
    this.slopes.clear();
  }

  /** The area at `viewport`, or `null` before the first report. */
  predict(viewport: {
    width: number;
    height: number;
  }): BrowserRectangle | null {
    const latest = this.reports[this.reports.length - 1];
    if (!latest) return null;
    const at = (edge: Edge): number => {
      const axis = EDGE_AXIS[edge];
      const from = latest.viewport[axis];
      const position = edgeOf(latest, edge);
      if (viewport[axis] === from || from <= 0) return position;
      // Its measured slope, else its share of the window.
      const slope =
        this.slopes.get(edge) ?? Math.min(1, Math.max(0, position / from));
      return position + slope * (viewport[axis] - from);
    };
    const left = Math.round(at('left'));
    const top = Math.round(at('top'));
    const predicted = {
      x: left,
      y: top,
      width: Math.round(at('right')) - left,
      height: Math.round(at('bottom')) - top,
    };
    if (predicted.width < 1 || predicted.height < 1) return null;
    return predicted;
  }

  /** Updates each edge's slope from the newest report. */
  private measure(): void {
    const latest = this.reports[this.reports.length - 1];
    if (!latest) return;
    for (const axis of ['width', 'height'] as const) {
      const size = latest.viewport[axis];
      // The nearest earlier report that is far enough away.
      let base: PageAreaReport | null = null;
      let previous: PageAreaReport | null = null;
      for (let index = this.reports.length - 2; index >= 0; index -= 1) {
        const candidate = this.reports[index];
        if (!candidate || candidate.viewport[axis] === size) continue;
        previous ??= candidate;
        if (Math.abs(candidate.viewport[axis] - size) >= SLOPE_BASELINE_PX) {
          base = candidate;
          break;
        }
      }
      const edges = EDGES.filter((edge) => EDGE_AXIS[edge] === axis);
      const slopeFrom = (from: PageAreaReport, edge: Edge): number =>
        (edgeOf(latest, edge) - edgeOf(from, edge)) /
        (size - from.viewport[axis]);
      // An edge that outran the window since the last report means the
      // layout jumped (a breakpoint, a panel closing): start over from here.
      if (
        previous !== null &&
        edges.some((edge) => !plausibleSlope(slopeFrom(previous, edge)))
      ) {
        this.reports = [latest];
        this.slopes.clear();
        return;
      }
      if (base === null) continue;
      for (const edge of edges) {
        const slope = slopeFrom(base, edge);
        if (plausibleSlope(slope)) this.slopes.set(edge, slope);
        else this.slopes.delete(edge);
      }
    }
  }
}
