/**
 * Sets the `data-vq-N` attributes on `<html>` that the desktop stylesheet's
 * responsive rules read.
 *
 * The build rewrites every viewport-size media query in `globals.css` into
 * a rule switched by one of these attributes
 * (`scripts/postcss/viewport-queries-as-attributes.cjs` says why: a media
 * query that flips makes Chromium restyle and lay out the whole page), and
 * publishes the conditions, in attribute order, in
 * `--canopy-viewport-queries`. Each condition is watched with `matchMedia`,
 * so an attribute is present exactly while its media query would match.
 */

const QUERIES_PROPERTY = '--canopy-viewport-queries';

/** The conditions the loaded stylesheet published, in attribute order. */
function publishedQueries(): string[] {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(QUERIES_PROPERTY)
    .trim();
  const list = raw.replace(/^["']|["']$/g, '');
  return list === '' ? [] : list.split('|');
}

let installed: { key: string; stop: () => void } | null = null;

function watch(
  queries: readonly string[],
  root: HTMLElement,
  view: Window,
): () => void {
  const stops = queries.map((query, index) => {
    const attribute = `data-vq-${index}`;
    const media = view.matchMedia(query);
    const apply = (): void => {
      root.toggleAttribute(attribute, media.matches);
    };
    apply();
    media.addEventListener('change', apply);
    return (): void => {
      media.removeEventListener('change', apply);
      root.removeAttribute(attribute);
    };
  });
  return (): void => {
    for (const stop of stops) stop();
  };
}

function sync(): void {
  const queries = publishedQueries();
  const key = queries.join('|');
  if (installed?.key === key) return;
  // Both steps run before the browser draws again, so no frame sees the
  // attributes missing.
  installed?.stop();
  installed = { key, stop: watch(queries, document.documentElement, window) };
}

/**
 * Sets the same attributes on a child window's `<html>` (a pop-out panel or
 * an overlay layer), which clones this document's stylesheets but runs no
 * scripts. Each condition is checked against the child window's own size.
 * Returns the function that stops watching.
 */
export function watchViewportQueryAttributesIn(child: Document): () => void {
  const view = child.defaultView;
  if (view === null || typeof view.matchMedia !== 'function') {
    return (): void => {};
  }
  return watch(publishedQueries(), child.documentElement, view);
}

/**
 * Call once, after the stylesheet is imported and before the first render.
 * Safe where there is no `matchMedia` (tests): nothing is installed.
 */
export function installViewportQueryAttributes(): void {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return;
  }
  sync();
  // The stylesheet can arrive after this runs (a slow link), and a
  // development hot update can publish another list. A built app's list
  // never changes once it is there, so watching stops then: other code adds
  // styles to the head all the time.
  const settled = (): boolean =>
    import.meta.hot === undefined && installed !== null && installed.key !== '';
  if (settled() || typeof MutationObserver === 'undefined') return;
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync();
      if (settled()) observer.disconnect();
    });
  });
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  window.addEventListener('load', sync, { once: true });
}
