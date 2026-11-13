import type {
  WorkerVisualRenderParams,
  WorkerVisualRenderResult,
} from '@canopy/protocol/canopy-core';
import type { VisualPreviewService } from '../browser/visual-preview-types';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** The render engine behind `worker.visual.render`; Electron main's offscreen service by default, tests inject one. */
export type WorkerVisualHost = Pick<
  VisualPreviewService,
  'measure' | 'preview'
>;

const desktopVisualHost: WorkerVisualHost = {
  // Window code is loaded only when a visual reaches rendering.
  measure: async (request) =>
    (await import('../browser/visual-preview-service'))
      .getVisualPreviewService()
      .measure(request),
  preview: async (request) =>
    (await import('../browser/visual-preview-service'))
      .getVisualPreviewService()
      .preview(request),
};

/**
 * `worker.visual.render` on the desktop dispatcher (CAN-6040): measures or
 * previews a prepared visual in Electron main's offscreen preview service and
 * returns its result unchanged. The dispatcher's cancellation reaches the run
 * as its abort signal. The daemon has no render engine and does not serve the
 * operation (CAN-6216).
 */
export function createWorkerVisualAdapter(
  host: WorkerVisualHost = desktopVisualHost,
): DesktopDomainAdapter {
  return {
    queries: {
      'worker.visual.render': async (
        params: WorkerVisualRenderParams,
        context,
      ): Promise<WorkerVisualRenderResult> => {
        const prepared = {
          html: params.prepared.html,
          // The render never reads them; host paths stay with the caller.
          unresolvedImagePaths: [],
        };
        const appearance = params.appearance
          ? { appearance: params.appearance }
          : {};
        if (params.mode === 'measure') {
          const result = await host.measure({
            prepared,
            ...appearance,
            maxHeight: params.maxHeight,
            widths: params.widths,
            deadlineMs: params.deadlineMs,
            signal: context.signal,
          });
          return {
            mode: 'measure',
            status: result.status,
            heights: result.heights.map(([width, height]): [number, number] => [
              width,
              height,
            ]),
          };
        }
        const result = await host.preview({
          prepared,
          ...appearance,
          width: params.width,
          imageBudgetBytes: params.imageBudgetBytes,
          signal: context.signal,
        });
        return {
          mode: 'preview',
          status: result.status,
          image: result.image ? { ...result.image } : null,
          ...(result.imageOmittedReason === undefined
            ? {}
            : { imageOmittedReason: result.imageOmittedReason }),
          contentHeight: result.contentHeight,
          capturedHeight: result.capturedHeight,
          console: result.console.map((item) => ({ ...item })),
          cspViolations: result.cspViolations.map((item) => ({ ...item })),
          blockedRequests: [...result.blockedRequests],
          omitted: { ...result.omitted },
          timing: { ...result.timing },
        };
      },
    },
  };
}
