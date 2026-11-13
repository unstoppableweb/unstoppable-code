import type { Plugin } from 'vite';

// A stage moves an authored cursor. Let the production selectors respond
// to its marks as well as to the real pointer, only in the two catalogs.
export function componentsLabScriptedPointer(): Plugin {
  return {
    name: 'components-lab-scripted-pointer',
    // A normal plugin: after vite:css compiles the CSS and before
    // vite:css-post, which empties plain CSS modules in a build.
    transform(code, id) {
      if (!/\.css(?:$|\?)/.test(id)) return null;
      // An escaped colon belongs to a class name, not a pseudo-class.
      return code
        .replace(/(?<!\\):hover\b/g, ':is(:hover,[data-hover])')
        .replace(/(?<!\\):active\b/g, ':is(:active,[data-pressed])');
    },
  };
}
