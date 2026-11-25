// `not-prose` as a class: see the plugin. The web build uses it too.
const notProseAsClass = require('./scripts/postcss/not-prose-as-class.cjs');
const viewportQueriesAsAttributes = require('./scripts/postcss/viewport-queries-as-attributes.cjs');

module.exports = {
  plugins: [
    require('@tailwindcss/postcss')(),
    notProseAsClass(),
    // The desktop renderer only: its entries load the stylesheet through
    // `styles/app-styles.ts`, which sets the attributes these rules read.
    viewportQueriesAsAttributes({
      files: ['apps/desktop-app/src/renderer/src/styles/globals.css'],
    }),
  ],
};
