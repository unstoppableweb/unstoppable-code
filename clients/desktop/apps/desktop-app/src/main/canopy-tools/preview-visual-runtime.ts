import type { z } from 'zod/v4';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { previewVisualSchema } from './definitions';
import type { VisualPreparationHost } from './prepare-visual-html';
import {
  VISUAL_PREVIEW_BUDGETS,
  VISUAL_PREVIEW_LIMITS,
  type VisualPreviewResult,
} from '../browser/visual-preview-types';
import { inlineVisualImages, validateVisualHtml } from './prepare-visual-html';
import { previewVisualThroughCore } from './visual-core-client';

/** Shown when the host has no render engine, as a daemon-hosted chat's (CAN-6216). */
export const PREVIEW_VISUAL_UNAVAILABLE_TEXT =
  "Preview isn't available in this chat: its host has no render engine for visuals. ShowVisual still shows a visual, without measured heights.";

export type PreviewVisualInput = z.infer<typeof previewVisualSchema>;

export interface PreviewVisualResult {
  text: string;
  isError?: boolean;
  imageDataUrl?: string;
}

function boundedLine(value: string): string {
  return value.slice(0, VISUAL_PREVIEW_LIMITS.diagnostics.chars);
}

function formatDiagnostics(result: VisualPreviewResult): string[] {
  const lines: string[] = [];
  for (const item of result.console)
    lines.push(
      `Console ${item.level} (untrusted page output): ${boundedLine(item.message)}`,
    );
  if (result.omitted.console)
    lines.push(`${result.omitted.console} more console messages omitted.`);
  for (const item of result.cspViolations)
    lines.push(
      `CSP violation (untrusted page output): ${boundedLine(item.directive)} blocked ${boundedLine(item.blockedUri)}`,
    );
  if (result.omitted.cspViolations)
    lines.push(`${result.omitted.cspViolations} more CSP violations omitted.`);
  for (const url of result.blockedRequests)
    lines.push(`Blocked request: ${boundedLine(url)}`);
  if (result.omitted.blockedRequests)
    lines.push(
      `${result.omitted.blockedRequests} more blocked requests omitted.`,
    );
  if (result.blockedRequests.length || result.omitted.blockedRequests)
    lines.push(
      'Blocked requests are not a complete network log; WebRTC and preconnect can bypass it.',
    );
  return lines;
}

/** Preview without staging or publishing a chat artifact. */
export async function executePreviewVisual(
  input: PreviewVisualInput,
  host: VisualPreparationHost,
  options: { imageBudgetBytes: number; signal?: AbortSignal },
): Promise<PreviewVisualResult> {
  const valid = validateVisualHtml(input.html);
  if (!valid.ok) return { text: valid.error, isError: true };
  const inlined = await inlineVisualImages(valid.value, host, {
    unresolved: 'report',
  });
  if (!inlined.ok) return { text: inlined.error, isError: true };
  let result: VisualPreviewResult;
  try {
    result = await previewVisualThroughCore(
      {
        prepared: { html: inlined.value.html },
        width: input.width ?? VISUAL_PREVIEW_LIMITS.defaultWidth,
        ...(input.appearance ? { appearance: input.appearance } : {}),
        imageBudgetBytes: options.imageBudgetBytes,
      },
      options.signal,
    );
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    if (error.payload.kind === 'capability_unavailable')
      return { text: PREVIEW_VISUAL_UNAVAILABLE_TEXT, isError: true };
    if (error.payload.kind === 'cancelled')
      return { text: 'Preview was stopped.', isError: true };
    throw error;
  }
  const lines = [
    result.status === 'ok'
      ? `Preview rendered at ${input.width ?? VISUAL_PREVIEW_LIMITS.defaultWidth}px. Content height: ${result.contentHeight}px; captured height: ${result.capturedHeight}px.`
      : result.status === 'busy'
        ? 'Preview is busy. Try again shortly.'
        : result.status === 'timeout'
          ? 'Preview timed out. Simplify the HTML and try again.'
          : result.status === 'aborted'
            ? 'Preview was stopped.'
            : 'Preview failed. Check the HTML and try again.',
    result.image
      ? `Screenshot: ${result.image.mime}, ${result.image.width}×${result.image.height}, ${result.image.bytes} bytes.`
      : options.imageBudgetBytes === VISUAL_PREVIEW_BUDGETS.acpImageBytes
        ? "A screenshot isn't available in Cursor or OpenCode chats."
        : `Screenshot omitted: ${result.imageOmittedReason ?? 'no image was captured'}.`,
    ...inlined.value.unresolvedImagePaths.map(
      (path) => `Unresolved image path: ${boundedLine(path)}`,
    ),
    ...formatDiagnostics(result),
  ];
  const maxTextBytes = VISUAL_PREVIEW_BUDGETS.codexTextBytes;
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > maxTextBytes) {
    while (
      lines.length > 2 &&
      Buffer.byteLength(
        `${lines.join('\n')}\nMore diagnostics omitted.`,
        'utf8',
      ) > maxTextBytes
    )
      lines.pop();
    text = `${lines.join('\n')}\nMore diagnostics omitted.`;
  }
  return {
    text,
    ...(result.status !== 'ok' ? { isError: true } : {}),
    ...(result.image ? { imageDataUrl: result.image.dataUrl } : {}),
  };
}
