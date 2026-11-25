/**
 * Rewrites the typography plugin's opt-out from `[class~="not-prose"]` to
 * `.not-prose`. The two match the same elements with the same weight, but
 * Chromium treats the first as "depends on the class attribute": with about
 * two hundred such rules reaching every descendant, changing any class on
 * any element restyled everything inside it (15 ms for one class change on
 * the page body of a small desktop chat page). Written as a class, only
 * adding or removing `not-prose` itself does that.
 *
 * Used by the desktop build (root `postcss.config.cjs`) and the web build
 * (`apps/web/postcss.config.mjs`); the web image's build context lists this
 * file in `apps/web/Dockerfile.dockerignore`.
 */
const notProseAsClass = () => ({
  postcssPlugin: 'canopy-not-prose-as-class',
  OnceExit(root) {
    root.walkRules((rule) => {
      if (!rule.selector.includes('not-prose')) return;
      rule.selector = rule.selector.replace(
        /\[class~=(["']?)not-prose\1\]/g,
        '.not-prose',
      );
    });
  },
});
notProseAsClass.postcss = true;

module.exports = notProseAsClass;
