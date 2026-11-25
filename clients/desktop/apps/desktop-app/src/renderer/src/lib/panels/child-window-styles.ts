/**
 * Child-window stylesheet + `<html>` attribute mirroring (Phase 7 of the VS
 * Code-style panel system).
 *
 * Production graft of the proven Phase 0 pull-out spike helpers
 * (`docs/planning/2026-06-27-vs-code-panels/phase0-pullout-spike/renderer-spike-pullout/childWindow.ts.txt`,
 * findings in doc 13), following VS Code's auxiliary-window CSS propagation
 * design (doc 05 §4: clone `<style>`/`<link rel="stylesheet">` from the
 * opener head, keep them in sync with a `MutationObserver`, and track the
 * theme-bearing `<html>` attributes).
 *
 * Canopy theming is CSS-variable + attribute based (`class` for dark mode,
 * `data-theme`, `data-ui-scale`, inline `style` on `<html>`), so mirroring
 * these two surfaces is sufficient for a child document to resolve the exact
 * same theme as the opener — no rule-injection registry is needed. The
 * inline `style` also carries the interface-scale metrics `lib/theme.ts`
 * publishes (`--ui-zoom`, the one-device-pixel `--border-hairline`); the
 * zoom itself reaches the child window from the main process, which creates
 * it at the opener's zoom and fans preference changes out to every window.
 *
 * Phase 8 calls both helpers right after opening an `about:blank` child
 * window and disposes them when the window closes/merges back.
 */

import { toDisposable, type IDisposable } from '@canopy/ui-shared/panels';
import { watchViewportQueryAttributesIn } from '@/styles/viewport-query-attributes';

/**
 * The `<html>` attributes Canopy's theme system writes (doc 05 §4;
 * `apps/desktop-app/src/renderer/src/lib/theme.ts`).
 */
const MIRRORED_HTML_ATTRIBUTES = [
  'class',
  // Scrollbar mode (`useAlwaysVisibleScrollbars`): the always/overlay
  // geometry selectors key off the ROOT of whichever document hosts the
  // scroll area, and the measured `--canopy-native-scrollbar-width` rides
  // the already-mirrored inline `style`.
  'data-scrollbars',
  'data-scrollbar-behavior',
  'data-theme',
  'data-ui-scale',
  'style',
] as const;

const STYLESHEET_SELECTOR = 'style, link[rel="stylesheet"]';

/**
 * Mirrors one opener `<style>`/`<link rel="stylesheet">` into the child
 * head, returning the clone (or `null` for nodes that are neither).
 *
 * Clones are created via the CHILD document deliberately: style/link
 * elements are presentation-only, never touched by `instanceof` checks, so
 * the opener-realm rule (doc 13) does not apply to them — and a `<link>`
 * clone needs the opener's RESOLVED absolute `href` because the child
 * `about:blank` document has no usable base URL for relative hrefs (spike
 * finding). In dev, Vite injects `<style>` tags; packaged builds ship the
 * bundled CSS as a `<link>`.
 */
function cloneStylesheetNode(
  child: Document,
  source: Node,
): HTMLElement | null {
  if (source instanceof HTMLLinkElement) {
    const link = child.createElement('link');
    link.rel = 'stylesheet';
    link.href = source.href; // resolved absolute URL
    if (source.media) {
      link.media = source.media;
    }
    return link;
  }

  if (source instanceof HTMLStyleElement) {
    const style = child.createElement('style');
    style.textContent = source.textContent;
    return style;
  }

  return null;
}

/**
 * Clones every existing `<style>`/`<link rel="stylesheet">` from the opener
 * `document.head` into `child.head`, and keeps them in sync with a
 * `MutationObserver`: stylesheets added later (Vite HMR, dynamically
 * injected styles) are mirrored, removed ones are dropped, and `<style>`
 * text changes (HMR updates swap the style's text content) are re-copied.
 *
 * Disposing disconnects the observer and stops propagation; already-mirrored
 * clones are left in the child document (its window is closing anyway).
 */
export function mirrorStylesheetsInto(child: Document): IDisposable {
  const openerHead = document.head;
  /** Opener source node → child clone, for removal + text sync. */
  const clones = new Map<Node, HTMLElement>();

  const mirror = (source: Node): void => {
    if (clones.has(source)) {
      return;
    }

    const clone = cloneStylesheetNode(child, source);

    if (clone) {
      child.head.appendChild(clone);
      clones.set(source, clone);
    }
  };

  openerHead.querySelectorAll(STYLESHEET_SELECTOR).forEach((source) => {
    mirror(source);
  });

  const syncStyleText = (source: Node): void => {
    const clone = clones.get(source);

    if (clone instanceof HTMLStyleElement) {
      clone.textContent = source.textContent;
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList' && record.target === openerHead) {
        // Direct head children added/removed: mirror matching stylesheets.
        record.addedNodes.forEach((added) => {
          mirror(added);
        });
        record.removedNodes.forEach((removed) => {
          const clone = clones.get(removed);

          if (clone) {
            clone.remove();
            clones.delete(removed);
          }
        });
        continue;
      }

      // Any other mutation is inside a head child (e.g. Vite HMR replacing a
      // mirrored <style>'s text node, or characterData edits): re-copy the
      // owning mirrored <style>'s text.
      const target = record.target;
      const owner =
        target instanceof HTMLStyleElement ? target : target.parentNode;

      if (owner) {
        syncStyleText(owner);
      }
    }
  });

  // subtree + characterData so `<style>` text updates are seen no matter
  // whether they arrive as text-node replacement (childList on the style) or
  // in-place text edits (characterData on the text node).
  observer.observe(openerHead, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return toDisposable(() => {
    observer.disconnect();
    clones.clear();
  });
}

/** Copies the theme-bearing `<html>` attributes from opener to child. */
function copyHtmlAttributes(child: Document): void {
  const from = document.documentElement;
  const to = child.documentElement;

  for (const attribute of MIRRORED_HTML_ATTRIBUTES) {
    const value = from.getAttribute(attribute);

    if (value === null) {
      to.removeAttribute(attribute);
    } else {
      to.setAttribute(attribute, value);
    }
  }
}

/**
 * Copies the theme-bearing `<html>` attributes (`class` for dark mode,
 * `data-theme`, `data-ui-scale`, inline `style`) from the opener to the
 * child document, then observes the opener's `<html>` element and re-copies
 * on every change so live theme/color-mode/UI-scale switches propagate.
 *
 * Also seeds the child `<body>` with the themed surface defaults from the
 * spike (zero margin, `var(--bg-base)`/`var(--fg-primary)`) so the child
 * paints themed immediately once stylesheets resolve.
 *
 * Also sets the child's own `data-vq-N` viewport attributes (see
 * `styles/viewport-query-attributes.ts`).
 *
 * Disposing disconnects the observer and stops propagation.
 */
export function mirrorHtmlAttributesInto(child: Document): IDisposable {
  copyHtmlAttributes(child);

  child.body.style.margin = '0';
  child.body.style.background = 'var(--bg-base)';
  child.body.style.color = 'var(--fg-primary)';

  const observer = new MutationObserver(() => {
    copyHtmlAttributes(child);
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [...MIRRORED_HTML_ATTRIBUTES],
  });
  // The responsive rules read `data-vq-N`, which follows each window's own
  // size, so the child gets its own watcher instead of the opener's values.
  const stopViewportQueries = watchViewportQueryAttributesIn(child);

  return toDisposable(() => {
    observer.disconnect();
    stopViewportQueries();
  });
}
