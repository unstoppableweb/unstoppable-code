/** Loaded only after a visible, settled Mermaid block requests a diagram. */
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import {
  canonicalizeMermaidEscapes,
  hasMermaidExternalCssResource,
  planMermaidRender,
} from './markdown-mermaid-policy';
import { resolveTokenHex } from '../lib/token-color';

const MAX_SVG_LENGTH = 1_000_000;
const MAX_PENDING_RENDERS = 40;
let renderQueue: Promise<unknown> = Promise.resolve();
let pendingRenders = 0;
let nextDiagramId = 0;

/** Mermaid requires concrete hex colors; the application owns their values. */
function tokenColor(
  element: HTMLElement,
  token: string,
  background?: string,
): string {
  // Border/foreground tokens may be translucent. Composite onto the semantic
  // surface before converting to hex, rather than accidentally making them opaque.
  const color = resolveTokenHex(element, token, background);
  if (color === null) throw new Error('Color conversion unavailable');
  return color;
}

export function sanitizeMermaidSvg(svg: string): string {
  if (svg.length > MAX_SVG_LENGTH) throw new Error('Diagram output too large');
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      'foreignObject',
      'image',
      'a',
      'script',
      'animate',
      'animateMotion',
      'animateTransform',
      'set',
    ],
  });
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || parsed.querySelector('parsererror'))
    throw new Error('Invalid diagram output');
  // The React wrapper provides one accessible image; avoid a second nested image.
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  const diagramWidth = Number(
    root.getAttribute('viewBox')?.trim().split(/[ ,]+/)[2],
  );
  if (
    Number.isFinite(diagramWidth) &&
    diagramWidth > 0 &&
    diagramWidth <= 10_000
  ) {
    root.setAttribute('width', String(diagramWidth));
  }
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(node.attributes)) {
      const canonical = canonicalizeMermaidEscapes(attr.value).trim();
      if (
        (attr.localName === 'href' && !canonical.startsWith('#')) ||
        hasMermaidExternalCssResource(attr.value)
      ) {
        node.removeAttributeNode(attr);
      }
    }
    if (
      node.localName === 'style' &&
      hasMermaidExternalCssResource(node.textContent ?? '')
    )
      node.remove();
  }
  return new XMLSerializer().serializeToString(root);
}

/** Serialize initialize+render together: Mermaid configuration is global. */
export function renderMermaid(
  source: string,
  element: HTMLElement,
  isCurrent: () => boolean,
): Promise<string> {
  const { issue, prepared } = planMermaidRender(source);
  if (issue) return Promise.reject(new Error(issue));
  if (pendingRenders >= MAX_PENDING_RENDERS)
    return Promise.reject(new Error('Diagram queue full'));
  pendingRenders += 1;
  const result = renderQueue
    .catch(() => undefined)
    .then(async (): Promise<string> => {
      // Yield between layouts. This is scheduling, not interruption of sync work.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await document.fonts?.ready;
      if (!isCurrent()) throw new Error('Diagram no longer visible');
      const background = tokenColor(element, '--bg-base');
      const foreground = tokenColor(element, '--fg-primary', background);
      const surface = tokenColor(element, '--bg-secondary', background);
      const border = tokenColor(element, '--line-base', surface);
      const accent = tokenColor(element, '--fg-accent', background);
      const typography = getComputedStyle(element);
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        htmlLabels: false,
        maxTextSize: 8_000,
        maxEdges: 100,
        theme: 'base',
        look: 'classic',
        sequence: {
          actorFontSize: typography.fontSize,
          noteFontSize: typography.fontSize,
          messageFontSize: typography.fontSize,
        },
        fontFamily: typography.fontFamily,
        themeVariables: {
          dropShadow: 'none',
          nodeShadow: false,
          fontFamily: typography.fontFamily,
          fontSize: typography.fontSize,
          background,
          primaryColor: surface,
          primaryTextColor: foreground,
          primaryBorderColor: border,
          secondaryColor: background,
          secondaryTextColor: foreground,
          secondaryBorderColor: border,
          tertiaryColor: surface,
          tertiaryTextColor: foreground,
          tertiaryBorderColor: border,
          lineColor: foreground,
          textColor: foreground,
          edgeLabelBackground: background,
          actorBkg: surface,
          actorBorder: border,
          actorTextColor: foreground,
          signalColor: foreground,
          signalTextColor: foreground,
          labelBoxBkgColor: background,
          labelBoxBorderColor: border,
          labelTextColor: foreground,
          noteBkgColor: surface,
          noteBorderColor: border,
          noteTextColor: foreground,
          activationBkgColor: surface,
          activationBorderColor: accent,
        },
        secure: [
          'secure',
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'maxEdges',
          'suppressErrorRendering',
          'htmlLabels',
          'theme',
          'themeVariables',
          'themeCSS',
        ],
      });
      const staging = document.createElement('div');
      staging.style.position = 'absolute';
      staging.style.visibility = 'hidden';
      staging.style.pointerEvents = 'none';
      element.append(staging);
      try {
        const { svg } = await mermaid.render(
          `markdown-diagram-${++nextDiagramId}`,
          prepared,
          staging,
        );
        if (!isCurrent()) throw new Error('Diagram superseded');
        return sanitizeMermaidSvg(svg);
      } finally {
        staging.remove();
      }
    })
    .finally(() => {
      pendingRenders -= 1;
    });
  renderQueue = result;
  return result;
}
