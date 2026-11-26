import {
  SHARE_LANDER_BUTTON_CLASS_NAME,
  SHARE_LANDER_SECONDARY_BUTTON_CLASS_NAME,
} from '../lib/share-lander';

const projectDestination =
  'focus-ring flex w-full flex-1 flex-col items-start gap-1 rounded-md px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed';

export const WEB_CONTROL_RECIPES = {
  'project-destination': `${projectDestination} hover:bg-subtle`,
  'project-destination-unavailable': projectDestination,
  'cloud-repository-account':
    'focus-ring flex w-full items-center gap-3 px-3 py-2 text-left transition-colors aria-pressed:bg-accent-subtle aria-[pressed=false]:hover:bg-secondary/30',
  'share-lander-primary': SHARE_LANDER_BUTTON_CLASS_NAME,
  'share-lander-secondary': SHARE_LANDER_SECONDARY_BUTTON_CLASS_NAME,
  'marketing-prompt': 'focus-ring',
  'marketing-download-options': 'focus-ring',
  'marketing-chat-send': '',
  'marketing-hero-send': '',
  'marketing-site-build': '',
  'marketing-site-example': '',
  'marketing-site-examples-previous': '',
  'marketing-site-examples-next': '',
  'marketing-nav-disclosure': '',
  'marketing-nav-menu': '',
  'blog-copy-link': '',
  'support-search': 'text-s font-medium',
} as const;
