/**
 * The squared control every public `/share/*` lander uses instead of the app
 * pill: those pages are anonymous, marketing-adjacent surfaces rather than
 * app chrome. One recipe serves a lander's plain buttons and links and the
 * busy `ControlButton` (`presentation="share-lander-primary"` with `loading`), so the two cannot
 * drift. Lives on the component-free `lib` subpath because the landers'
 * server-rendered pages read it too.
 */
export const SHARE_LANDER_BUTTON_CLASS_NAME =
  'inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-s font-medium fg-emphasis transition-colors hover:opacity-90 disabled:opacity-60 aria-disabled:opacity-60';

export const SHARE_LANDER_SECONDARY_BUTTON_CLASS_NAME =
  'inline-flex items-center gap-2 rounded-md bg-base px-3 py-2 text-s font-medium fg-primary ring-1 ring-line-base transition-colors hover:bg-subtle';
