import {
  buildAgentVisualExportDocument,
  downloadBlob,
  type AgentVisualTheme,
} from '@canopy/ui-shared/lib';

/** A file name from a visual's title, safe on every platform. */
export function chatVisualFilename(title: string): string {
  const safe = title
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100);
  return `${safe || 'visual'}.html`;
}

/**
 * Download a visual as a standalone HTML file in the current theme. The
 * browser's own download does the saving, so both hosts behave the same.
 */
export function saveChatVisualAsHtml({
  document: visual,
  theme,
  title,
  ownerDocument,
  remoteAssets,
}: {
  document: string;
  theme: AgentVisualTheme;
  title: string;
  ownerDocument?: Document;
  /** Whether the saved visual may load CDN assets; see `agentVisualRemoteAssets`. */
  remoteAssets: boolean;
}): void {
  const blob = new Blob(
    [buildAgentVisualExportDocument(visual, theme, title, { remoteAssets })],
    {
      type: 'text/html;charset=utf-8',
    },
  );
  downloadBlob(blob, chatVisualFilename(title), ownerDocument);
}
