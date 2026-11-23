/**
 * The host's recorder for a panel view that threw during layout. The engine
 * contains the throw so the split view keeps working; the host decides
 * whether anything is reported, so this subtree stays free of
 * instrumentation and host imports.
 */
export type PanelErrorSink = (error: unknown) => void;

let registration: { readonly sink: PanelErrorSink } | null = null;

/**
 * Layout runs on every resize, so a view that throws once usually throws on
 * each one. A view is reported once per session.
 */
const reportedViews = new WeakSet<object>();

/**
 * Installs the host's recorder. The returned uninstaller only removes its own
 * registration, so a stale one cannot remove a newer install.
 */
export function setPanelErrorSink(sink: PanelErrorSink): () => void {
  const own = { sink };
  registration = own;
  return (): void => {
    if (registration === own) registration = null;
  };
}

/** Reports a contained view throw once per view. Never throws. */
export function reportPanelError(view: object, error: unknown): void {
  const current = registration;
  // Without a sink the view stays unreported, so a later install records it.
  if (current === null || reportedViews.has(view)) return;
  reportedViews.add(view);
  try {
    current.sink(error);
  } catch {
    // Recording is best effort and must not break layout.
  }
}
