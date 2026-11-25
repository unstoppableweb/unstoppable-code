/**
 * Rewrites the viewport-size media queries of one stylesheet into rules
 * that an attribute on `<html>` switches:
 *
 *   @media (width >= 64rem) { .lg\:flex { display: flex } }
 *   =>  :where(html[data-vq-0]) .lg\:flex { display: flex }
 *
 * Why: when a media query in a stylesheet starts or stops matching,
 * Chromium rebuilds that stylesheet's rules, and if the stylesheet also
 * holds `@layer` or `@property` rules (Tailwind's output always does) it
 * then restyles and lays out the whole document. Measured in the desktop
 * app, dragging the window across 1024 px or 1280 px cost a 30 ms stall
 * each time (2,600 elements restyled, every line of text laid out again).
 * An attribute change restyles only the elements the rewritten rules name.
 *
 * `:where()` adds no specificity and the rules keep their place, so the
 * cascade is the one the media queries gave. The page must set the
 * attributes: the conditions are published in `--canopy-viewport-queries`
 * on `:root`, and `installViewportQueryAttributes` (desktop renderer) turns
 * each into a `matchMedia` listener. A stylesheet rewritten here and loaded
 * without that script would never apply its responsive rules, which is why
 * only the files named in `files` are rewritten.
 */

const postcss = require('postcss');

/** Features whose answer changes when the window is resized. */
const VIEWPORT_FEATURE = /\b(width|height|aspect-ratio|orientation)\b/;
/** A prefix this plugin already wrote: a nested query adds to it. */
const WRITTEN_PREFIX = /^:where\(html((?:\[data-vq-\d+\])+)\)\s+/;
/** A selector that starts at the root element itself. */
const ROOT_COMPOUND = /^(:root|html)(?![\w-])/;
/** Wrappers whose rules can be prefixed in place. */
const TRANSPARENT_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'scope',
  'starting-style',
]);

const QUERIES_PROPERTY = '--canopy-viewport-queries';

function isViewportQuery(node) {
  return (
    node.type === 'atrule' &&
    node.name === 'media' &&
    VIEWPORT_FEATURE.test(node.params) &&
    // The published list is one quoted, `|`-separated string.
    !/["'|\\]/.test(node.params)
  );
}

function prefixSelector(selector, attribute) {
  const trimmed = selector.trim();
  const written = WRITTEN_PREFIX.exec(trimmed);
  if (written) {
    return `:where(html${written[1]}[${attribute}]) ${trimmed.slice(written[0].length)}`;
  }
  const root = ROOT_COMPOUND.exec(trimmed);
  if (root) {
    return `${root[1]}:where([${attribute}])${trimmed.slice(root[0].length)}`;
  }
  return `:where(html[${attribute}]) ${trimmed}`;
}

/**
 * Whether everything inside `container` can carry the prefix: style rules,
 * and wrappers around style rules. Keyframes, font faces and the like
 * cannot, and their media query is left as it is.
 */
function canPrefixContents(container) {
  return (container.nodes ?? []).every((node) => {
    if (node.type === 'rule' || node.type === 'comment') return true;
    if (node.type === 'atrule') {
      return TRANSPARENT_AT_RULES.has(node.name) && canPrefixContents(node);
    }
    return false;
  });
}

/** Prefixes the style rules directly inside `container` and its wrappers. */
function prefixContents(container, attribute) {
  for (const node of container.nodes ?? []) {
    if (node.type === 'rule') {
      node.selectors = node.selectors.map((selector) =>
        prefixSelector(selector, attribute),
      );
    } else if (node.type === 'atrule') {
      prefixContents(node, attribute);
    }
  }
}

function insideStyleRule(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'rule') return true;
  }
  return false;
}

module.exports = function viewportQueriesAsAttributes(options = {}) {
  const files = options.files ?? [];
  return {
    postcssPlugin: 'canopy-viewport-queries-as-attributes',
    OnceExit(root) {
      const file = (root.source?.input?.file ?? '').replace(/\\/g, '/');
      if (!files.some((name) => file.endsWith(name))) return;

      const conditions = [];
      const attributeFor = (params) => {
        const condition = params.replace(/\s+/g, ' ').trim();
        let index = conditions.indexOf(condition);
        if (index === -1) index = conditions.push(condition) - 1;
        return `data-vq-${index}`;
      };

      /**
       * A style rule with queries nested in it becomes a run of rules: its
       * own declarations, then each query's contents under the prefixed
       * selector, in the order they were written.
       */
      const splitRule = (rule) => {
        if (!rule.nodes?.some(isViewportQuery)) return [rule];
        // Nested inside another style rule its selector is relative, and
        // cannot be prefixed from here.
        if (insideStyleRule(rule)) return [rule];
        const parts = [];
        let own = rule.clone({ nodes: [] });
        for (const child of rule.nodes) {
          if (!isViewportQuery(child)) {
            own.append(child.clone());
            continue;
          }
          if (own.nodes.length > 0) parts.push(own);
          own = rule.clone({ nodes: [] });
          const under = rule.clone({ nodes: [] });
          const attribute = attributeFor(child.params);
          under.selectors = rule.selectors.map((selector) =>
            prefixSelector(selector, attribute),
          );
          for (const inner of child.nodes ?? []) under.append(inner.clone());
          // A query nested in this one adds its attribute to the prefix.
          parts.push(...splitRule(under));
        }
        if (own.nodes.length > 0) parts.push(own);
        return parts;
      };

      /**
       * A query in a rule that is itself nested in a rule: its contents go
       * under `&`, which stands for the rule around it. `&` cannot stand
       * for a pseudo-element, so such a rule keeps its query.
       */
      const rewriteNested = (rule, pseudoElement) => {
        const hasPseudoElement = pseudoElement || rule.selector.includes('::');
        for (const child of [...(rule.nodes ?? [])]) {
          if (child.type === 'rule') {
            rewriteNested(child, hasPseudoElement);
          } else if (
            isViewportQuery(child) &&
            !hasPseudoElement &&
            rule.parent?.type === 'rule'
          ) {
            const under = postcss.rule({
              selector: `:where(html[${attributeFor(child.params)}]) &`,
            });
            for (const inner of [...(child.nodes ?? [])]) under.append(inner);
            child.replaceWith(under);
            rewriteNested(under, hasPseudoElement);
          } else if (child.type === 'atrule') {
            for (const inner of child.nodes ?? []) {
              if (inner.type === 'rule') rewriteNested(inner, hasPseudoElement);
            }
          }
        }
      };

      const rewrite = (container) => {
        for (const node of [...(container.nodes ?? [])]) {
          if (node.type === 'rule') {
            const parts = splitRule(node);
            if (parts.length !== 1 || parts[0] !== node) {
              node.replaceWith(parts);
            }
            for (const part of parts) rewriteNested(part, false);
            continue;
          }
          if (node.type !== 'atrule') continue;
          if (isViewportQuery(node) && canPrefixContents(node)) {
            prefixContents(node, attributeFor(node.params));
            const lifted = node.nodes ?? [];
            const holder = postcss.root();
            for (const inner of [...lifted]) holder.append(inner);
            // What it held may hold more queries (one inside another).
            rewrite(holder);
            node.replaceWith(holder.nodes);
            continue;
          }
          rewrite(node);
        }
      };
      rewrite(root);

      if (conditions.length === 0) return;
      root.append(
        postcss.rule({
          selector: ':root',
          nodes: [
            postcss.decl({
              prop: QUERIES_PROPERTY,
              value: `"${conditions.join('|')}"`,
            }),
          ],
        }),
      );
    },
  };
};
module.exports.postcss = true;
