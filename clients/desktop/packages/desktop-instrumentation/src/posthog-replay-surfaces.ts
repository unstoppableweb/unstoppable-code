// ---------------------------------------------------------------------------
// Session-replay surface classification — the renderer ↔ recorder contract
// for whole panels, pages, and Settings sections.
//
// Each surface is one of:
//
//   - `blocked`: the surface root carries `POSTHOG_REPLAY_BLOCK_CLASS`, so the
//     recorder keeps only a same-size placeholder and nothing inside it.
//   - `reviewed`: the surface is recorded; only input values are masked.
//     Conversation content, terminal and log output, file/diff/preview
//     content, secrets rendered as text, and the browser page area inside it
//     are blocked by markers on their own subtree roots, below their titles.
//
// The maps are exhaustive records keyed off the canonical unions, mirroring
// `NAVIGATION_PAGE_ROUTES` and `PANEL_KIND_ROUTES` in `./posthog-routes`.
// Adding a `PanelKind`, `NavigationPage`, or `SettingsSection` member breaks
// type-checking until it is classified here. Classify a whole surface
// `blocked` only when all of it is one of the content kinds above (a terminal
// or file-diff panel); otherwise classify it `reviewed` and block its content
// subtree so its title stays readable.
//
// Apply a classification on an element that mounts together with the content
// it classifies. The recorder ignores a block class added to an element it has
// already recorded, so toggling the class on a long-lived container leaves
// stale content in the replay until the next full snapshot. That is why each
// Settings section applies its class on its own `SettingsPage` root rather
// than on the shared scroll container.
//
// Like `./posthog-routes`, this module must stay dependency-free at RUNTIME
// beyond its own literals and the browser-safe marker constants: it is
// reachable from the package's `./electron/preload` entry. The workspace
// imports below are therefore type-only.
// ---------------------------------------------------------------------------

import type { PanelKind } from '@canopy/protocol/panels';
import type {
  NavigationPage,
  SettingsSection,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from './posthog-replay-privacy';
import type { HostedSettingsPageKey } from './posthog-routes';

/** How session replay records a whole surface. */
export type ReplaySurfacePrivacy = 'blocked' | 'reviewed';

/**
 * Every panel kind, applied on the `PanelContentFrame` root. A panel never
 * changes kind, so the frame mounts with the classification it keeps.
 */
export const PANEL_KIND_REPLAY_PRIVACY = Object.freeze({
  chat: 'reviewed',
  'file-diff': 'blocked',
  terminal: 'blocked',
  'activity-section': 'reviewed',
  browser: 'reviewed',
  'file-explorer': 'reviewed',
  'change-diagram': 'reviewed',
  'activity-card': 'reviewed',
  usage: 'reviewed',
  automations: 'reviewed',
  'pipeline-execution': 'reviewed',
  plan: 'reviewed',
  'plan-diagram': 'reviewed',
  // Each visual's frame is blocked and its title masked; the rest is fixed
  // copy and controls.
  'chat-visuals': 'reviewed',
  subagents: 'reviewed',
  'subagent-chat': 'reviewed',
  ledger: 'reviewed',
  // Figures, model names and chat names only; never transcript content.
  cost: 'reviewed',
  'session-breakdown': 'reviewed',
  'new-tab': 'reviewed',
} as const satisfies Record<PanelKind, ReplaySurfacePrivacy>);

/**
 * Every top-level renderer page, applied on `<main>` keyed to the active
 * page. Pages are recorded; their content subtrees carry their own blocks.
 */
export const NAVIGATION_PAGE_REPLAY_PRIVACY = Object.freeze({
  'mcp-account-connections': 'reviewed',
  main: 'reviewed',
  overview: 'reviewed',
  home: 'reviewed',
  chat: 'reviewed',
  // Legacy id; `navigate` opens the cowork page instead (CAN-6175).
  'cloud-chat': 'reviewed',
  pipelines: 'reviewed',
  plugins: 'reviewed',
  audit: 'reviewed',
  workflows: 'reviewed',
  'workflows-schedule': 'reviewed',
  'workflows-library': 'reviewed',
  automations: 'reviewed',
  watchers: 'reviewed',
  statistics: 'reviewed',
  usage: 'reviewed',
  environments: 'reviewed',
  workers: 'reviewed',
  kanban: 'reviewed',
  feed: 'reviewed',
  'header-states': 'reviewed',
  'worktree-states': 'reviewed',
  'activity-states': 'reviewed',
  'message-bubble-states': 'reviewed',
  'change-review': 'reviewed',
  'notice-states': 'reviewed',
} as const satisfies Record<NavigationPage, ReplaySurfacePrivacy>);

/**
 * Every Settings section, applied on the displayed section's `SettingsPage`
 * root. A missing classification provider there means `blocked`. Sections
 * are recorded; file editors and secrets shown as text inside them carry their
 * own blocks.
 */
export const SETTINGS_SECTION_REPLAY_PRIVACY = Object.freeze({
  memory: 'reviewed',
  canopy: 'reviewed',
  performance: 'reviewed',
  shortcuts: 'reviewed',
  display: 'reviewed',
  notifications: 'reviewed',
  account: 'reviewed',
  privacy: 'reviewed',
  // Pairing codes in its dialogs carry their own block markers.
  'remote-access': 'reviewed',
  chat: 'reviewed',
  'code-graph': 'reviewed',
  instructions: 'reviewed',
  harnesses: 'reviewed',
  plugins: 'reviewed',
  'app-advisor': 'reviewed',
  terminal: 'reviewed',
  browser: 'reviewed',
  files: 'reviewed',
  'plan-detection': 'reviewed',
  dictation: 'reviewed',
  codex: 'reviewed',
  claude: 'reviewed',
  ollama: 'reviewed',
  // Account emails and the server URL carry their own blocks.
  'account-proxy': 'reviewed',
  git: 'reviewed',
  applications: 'reviewed',
  mcp: 'reviewed',
  approvals: 'reviewed',
  experiments: 'reviewed',
  environment: 'reviewed',
  feedback: 'reviewed',
  legal: 'reviewed',
} as const satisfies Record<SettingsSection, ReplaySurfacePrivacy>);

/**
 * Every hosted account and organization settings page (CAN-4386), applied on
 * an element that mounts with the page's content inside the Settings overlay.
 * Shared pages block names, emails, avatars, transcripts and secrets through
 * the settings privacy port; pages whose body is mostly people's work or
 * transcripts (the feed, digests, member lists and profiles, memory facts and
 * their sources, per-member statistics) are blocked whole. The rail and the
 * page chrome around them stay recorded, so navigation remains observable.
 */
export const HOSTED_SETTINGS_PAGE_REPLAY_PRIVACY = Object.freeze({
  // Names, emails and avatars carry their own blocks.
  'account/account': 'reviewed',
  'account/profile': 'reviewed',
  // Digest reports are summaries of the viewer's work.
  'account/digests': 'blocked',
  'account/notifications': 'reviewed',
  'account/integrations': 'reviewed',
  // Installed names and counts, like Customize and the local sections.
  'account/plugins': 'reviewed',
  'account/mcp': 'reviewed',
  // API keys and backup codes carry their own blocks.
  'account/security': 'reviewed',
  // Gateway name, URL and key suffix carry their own masks.
  'account/ai-gateway': 'reviewed',
  'account/billing': 'reviewed',
  // Experiment names and switches, like the local Labs section.
  'account/labs': 'reviewed',
  'account/appearance': 'reviewed',
  'organizations/list': 'reviewed',
  'organization/feed': 'blocked',
  'organization/statistics': 'blocked',
  'organization/digests': 'blocked',
  'organization/members': 'blocked',
  'organization/groups': 'reviewed',
  'organization/projects': 'reviewed',
  'organization/memory': 'blocked',
  'organization/settings': 'reviewed',
} as const satisfies Record<HostedSettingsPageKey, ReplaySurfacePrivacy>);

/**
 * The class a surface root carries for its classification:
 * {@link POSTHOG_REPLAY_BLOCK_CLASS} for `blocked`, `undefined` otherwise, so
 * callers can pass the result straight into a class list.
 */
export function replayBlockClassFor(
  privacy: ReplaySurfacePrivacy,
): typeof POSTHOG_REPLAY_BLOCK_CLASS | undefined {
  return privacy === 'blocked' ? POSTHOG_REPLAY_BLOCK_CLASS : undefined;
}
