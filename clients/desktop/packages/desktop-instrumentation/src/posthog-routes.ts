// ---------------------------------------------------------------------------
// Synthetic screen routes — the renderer ↔ instrumentation wire contract.
//
// This module is the single source of truth for the closed catalog of
// `app://…` routes that describe "which screen is the user on" on the PostHog
// wire. It is imported by BOTH sides of the seam:
//   - the renderer (frontend), which derives the current route from its stores
//     and publishes it through `PostHogRouteSource` (see `./types`)
//   - the instrumentation client (backend), which validates the published
//     value and stamps it onto every renderer event
//
// Design rules that must survive review:
//
//   1. Routes are FIXED and ALLOWLISTED. No catalog value may ever contain a
//      workspace name, branch name, ID, filesystem path, filename, or browser
//      website URL. All route variation lives in the enumerated value itself.
//
//   2. The catalog is a CLOSED SET. `isPostHogRoute` performs exact membership
//      against the generated value set. It must NOT accept an arbitrary string
//      merely because it starts with `app://`.
//
//   3. The catalog is built from EXHAUSTIVE MAPPED RECORDS keyed off the
//      canonical type unions (`NavigationPage`, `SettingsSection`,
//      `PanelKind`). Adding a member to any of those unions breaks the build
//      until this file is updated — that compile-time failure IS the guarantee
//      that new screens cannot silently ship without a route decision.
//
//   4. Members that intentionally have NO route map to `null` rather than
//      being omitted, so exhaustiveness still forces an explicit decision for
//      each one. This matters most for panels: a newly added `PanelKind` must
//      never silently acquire a reportable route.
//
// This module must stay dependency-free at RUNTIME beyond its own literals —
// it is reachable from the package's `./electron/preload` entry point, where
// pulling in a `zod`-bearing module would be a real cost. Both workspace
// imports below are therefore type-only.
// ---------------------------------------------------------------------------

import type { PanelKind } from '@canopy/protocol/panels';
import type {
  AccountSettingsPage,
  OrganizationSettingsPage,
  SettingsRoute,
} from '@canopy/protocol/settings';
import type {
  NavigationPage,
  SettingsSection,
} from '@canopy/desktop-shared/types';

/**
 * Structural shape every catalog entry must have. This is deliberately looser
 * than {@link PostHogRoute} (which is the exact closed union derived from the
 * records below) — it exists only so the records can be annotated without a
 * circular reference back to the union they generate.
 */
type RouteLiteral = `app://${string}`;

// ---------------------------------------------------------------------------
// Navigation pages — `app://main/<page>`
// ---------------------------------------------------------------------------

/**
 * Every top-level renderer page. `main` is the one overloaded member: it is
 * both the worktree page and the catalog's bare fallback, so it maps to bare
 * `app://main`. Resolving it to `app://main/worktree-chat` when a worktree
 * chat is actually visible is the renderer's job — the catalog only supplies
 * both members. `kanban` keeps its own route even though it shares a page
 * component with `main`.
 */
export const NAVIGATION_PAGE_ROUTES = Object.freeze({
  'mcp-account-connections': 'app://main/mcp-account-connections',
  main: 'app://main',
  overview: 'app://main/overview',
  home: 'app://main/home',
  chat: 'app://main/chat',
  'cloud-chat': 'app://main/cloud-chat',
  pipelines: 'app://main/pipelines',
  plugins: 'app://main/plugins',
  audit: 'app://main/audit',
  workflows: 'app://main/workflows',
  'workflows-schedule': 'app://main/workflows-schedule',
  'workflows-library': 'app://main/workflows-library',
  automations: 'app://main/automations',
  watchers: 'app://main/watchers',
  statistics: 'app://main/statistics',
  usage: 'app://main/usage',
  // Alias only (CAN-4269): navigating to `environments` opens Settings →
  // Environments without changing the page, so this route is never observed.
  // Kept because the record is exhaustive over NavigationPage.
  environments: 'app://main/environments',
  workers: 'app://main/workers',
  kanban: 'app://main/kanban',
  feed: 'app://main/feed',
  'header-states': 'app://main/header-states',
  'worktree-states': 'app://main/worktree-states',
  'activity-states': 'app://main/activity-states',
  'message-bubble-states': 'app://main/message-bubble-states',
  'change-review': 'app://main/change-review',
  'notice-states': 'app://main/notice-states',
} as const satisfies Record<NavigationPage, RouteLiteral>);

// ---------------------------------------------------------------------------
// Settings sections — `app://settings/<section>`
// ---------------------------------------------------------------------------

/**
 * Every Settings dialog section key.
 *
 * Every member has a route. `environment` is Settings → Environments
 * (CAN-4269); before that it redirected to a top-level Environments page and
 * was the single `null` member.
 *
 * `feedback` stays in the catalog unconditionally. Settings genuinely opens
 * with that section selected (the app-action dispatcher accepts it and
 * `resolveSettingsSection` returns it verbatim), even though no component
 * renders a `feedback` pane today. Reporting `app://settings/feedback` is
 * correct; substituting `canopy` would fabricate a screen the user is not on.
 * The empty pane is a pre-existing UI gap, not something this catalog models.
 *
 * `pipeline-advisor` intentionally has NO entry. It belongs to the separate
 * `LegacySettingsSection` type, and `resolveSettingsSection` migrates it to
 * `app-advisor` before any value can reach this record.
 *
 * The internal `canopy` key is a technical analytics identifier, not
 * user-facing branding.
 */
export const SETTINGS_SECTION_ROUTES = Object.freeze({
  memory: 'app://settings/memory',
  canopy: 'app://settings/canopy',
  performance: 'app://settings/performance',
  shortcuts: 'app://settings/shortcuts',
  display: 'app://settings/display',
  notifications: 'app://settings/notifications',
  account: 'app://settings/account',
  privacy: 'app://settings/privacy',
  'remote-access': 'app://settings/remote-access',
  chat: 'app://settings/chat',
  'code-graph': 'app://settings/code-graph',
  instructions: 'app://settings/instructions',
  harnesses: 'app://settings/harnesses',
  plugins: 'app://settings/plugins',
  'app-advisor': 'app://settings/app-advisor',
  terminal: 'app://settings/terminal',
  browser: 'app://settings/browser',
  files: 'app://settings/files',
  'plan-detection': 'app://settings/plan-detection',
  dictation: 'app://settings/dictation',
  codex: 'app://settings/codex',
  claude: 'app://settings/claude',
  ollama: 'app://settings/ollama',
  'account-proxy': 'app://settings/account-proxy',
  git: 'app://settings/git',
  applications: 'app://settings/applications',
  mcp: 'app://settings/mcp',
  approvals: 'app://settings/approvals',
  experiments: 'app://settings/experiments',
  environment: 'app://settings/environment',
  feedback: 'app://settings/feedback',
  legal: 'app://settings/legal',
} as const satisfies Record<SettingsSection, RouteLiteral>);

// ---------------------------------------------------------------------------
// Hosted settings pages — `app://settings/<scope>/<page>`
// ---------------------------------------------------------------------------

/**
 * A hosted account or organization settings page (CAN-4386), by scope and
 * page only. Detail routes (a digest, an invoice, a member, a fact, a feed
 * permalink) report their page, and the organization Settings subtab is not
 * part of the key, so no organization, user, digest, invoice or fact id and
 * no query value can reach the wire.
 */
export type HostedSettingsPageKey =
  | `account/${AccountSettingsPage}`
  | 'organizations/list'
  | `organization/${OrganizationSettingsPage}`;

/**
 * Every hosted settings page. The `account/` prefix keeps these apart from
 * the local `account` section (`app://settings/account`, desktop Accounts).
 */
export const HOSTED_SETTINGS_PAGE_ROUTES = Object.freeze({
  'account/account': 'app://settings/account/account',
  'account/profile': 'app://settings/account/profile',
  'account/digests': 'app://settings/account/digests',
  'account/notifications': 'app://settings/account/notifications',
  'account/integrations': 'app://settings/account/integrations',
  'account/plugins': 'app://settings/account/plugins',
  'account/mcp': 'app://settings/account/mcp',
  'account/security': 'app://settings/account/security',
  'account/ai-gateway': 'app://settings/account/ai-gateway',
  'account/billing': 'app://settings/account/billing',
  'account/labs': 'app://settings/account/labs',
  'account/appearance': 'app://settings/account/appearance',
  'organizations/list': 'app://settings/organizations/list',
  'organization/feed': 'app://settings/organization/feed',
  'organization/statistics': 'app://settings/organization/statistics',
  'organization/digests': 'app://settings/organization/digests',
  'organization/members': 'app://settings/organization/members',
  'organization/groups': 'app://settings/organization/groups',
  'organization/projects': 'app://settings/organization/projects',
  'organization/memory': 'app://settings/organization/memory',
  'organization/settings': 'app://settings/organization/settings',
} as const satisfies Record<HostedSettingsPageKey, RouteLiteral>);

/** The catalog key for a hosted settings route: its scope and page only. */
export function hostedSettingsPageKey(
  route: SettingsRoute,
): HostedSettingsPageKey {
  switch (route.scope) {
    case 'account':
      return `account/${route.page}`;
    case 'organizations':
      return 'organizations/list';
    case 'organization':
      return `organization/${route.page}`;
  }
}

// ---------------------------------------------------------------------------
// Panel kinds — `app://panel/<kind>`
// ---------------------------------------------------------------------------

/**
 * Every panel kind that can appear on the wire.
 *
 * `chat` maps to `null` on purpose: a focused chat panel does not name a new
 * screen, it retains the containing worktree or Co-Work chat route. The
 * renderer implements that fallback; the catalog only records the decision.
 *
 * A newly added `PanelKind` must break this build rather than silently
 * acquiring a reportable route.
 */
export const PANEL_KIND_ROUTES = Object.freeze({
  chat: null,
  'file-diff': 'app://panel/file-diff',
  terminal: 'app://panel/terminal',
  'activity-section': 'app://panel/activity-section',
  browser: 'app://panel/browser',
  'file-explorer': 'app://panel/file-explorer',
  'change-diagram': 'app://panel/change-diagram',
  'activity-card': 'app://panel/activity-card',
  usage: 'app://panel/usage',
  automations: 'app://panel/automations',
  'pipeline-execution': 'app://panel/pipeline-execution',
  plan: 'app://panel/plan',
  'plan-diagram': 'app://panel/plan-diagram',
  'chat-visuals': 'app://panel/chat-visuals',
  subagents: 'app://panel/subagents',
  'subagent-chat': 'app://panel/subagent-chat',
  ledger: 'app://panel/ledger',
  cost: 'app://panel/cost',
  'session-breakdown': 'app://panel/session-breakdown',
  'new-tab': 'app://panel/new-tab',
} as const satisfies Record<PanelKind, RouteLiteral | null>);

// ---------------------------------------------------------------------------
// Standalone routes
// ---------------------------------------------------------------------------

/**
 * Catalog members that no union keys. They are real screens (or real
 * "awaiting a more specific report" states) that the three records above
 * cannot express:
 *
 * - `app://main` — the main window before a specific destination is available.
 *   Also produced by `NAVIGATION_PAGE_ROUTES.main`; listed here so the bare
 *   fallback survives even if that mapping ever changes.
 * - `app://main/worktree-chat` — a visible worktree chat. Derived by the
 *   renderer from the `main` page plus worktree state; it is not itself a
 *   `NavigationPage`.
 * - `app://settings` — Settings is open but has not yet reported which section
 *   it is displaying.
 * - `app://app-advisor` — the App Advisor renderer surface.
 */
const STANDALONE_ROUTES = [
  'app://main',
  'app://main/worktree-chat',
  'app://settings',
  'app://app-advisor',
] as const satisfies readonly RouteLiteral[];

// ---------------------------------------------------------------------------
// The route union and the runtime membership set
// ---------------------------------------------------------------------------

/**
 * A validated synthetic screen route.
 *
 * This is the exact closed union generated by the three exhaustive records
 * plus {@link STANDALONE_ROUTES}. Deriving it (rather than hand-writing a
 * parallel list) is what keeps the type, the mapping, and the runtime
 * validator from drifting apart.
 */
export type PostHogRoute =
  | (typeof NAVIGATION_PAGE_ROUTES)[NavigationPage]
  | NonNullable<(typeof SETTINGS_SECTION_ROUTES)[SettingsSection]>
  | (typeof HOSTED_SETTINGS_PAGE_ROUTES)[HostedSettingsPageKey]
  | NonNullable<(typeof PANEL_KIND_ROUTES)[PanelKind]>
  | (typeof STANDALONE_ROUTES)[number];

/** The bare main-window route. Safe, always-valid fallback. */
export const POSTHOG_MAIN_ROUTE: PostHogRoute = 'app://main';

/** Settings open, displayed section not yet reported. */
export const POSTHOG_SETTINGS_ROUTE: PostHogRoute = 'app://settings';

/** The App Advisor renderer surface. */
export const POSTHOG_APP_ADVISOR_ROUTE: PostHogRoute = 'app://app-advisor';

/** A visible worktree chat. */
export const POSTHOG_WORKTREE_CHAT_ROUTE: PostHogRoute =
  'app://main/worktree-chat';

/**
 * Every catalog route, deduplicated and sorted. Generated from the same
 * records that supply the mapping, so the enumeration, the validator, and the
 * mapping all share ONE definition and there is no second list that can drift.
 *
 * Exported as an array (not only as the {@link POSTHOG_ROUTES} set) so
 * consumers can enumerate the catalog without needing `downlevelIteration`.
 */
export const POSTHOG_ROUTE_VALUES: readonly PostHogRoute[] = Array.from(
  new Set<PostHogRoute>(
    [
      ...Object.values(NAVIGATION_PAGE_ROUTES),
      ...Object.values(SETTINGS_SECTION_ROUTES),
      ...Object.values(HOSTED_SETTINGS_PAGE_ROUTES),
      ...Object.values(PANEL_KIND_ROUTES),
      ...STANDALONE_ROUTES,
    ].filter((route): route is PostHogRoute => route !== null),
  ),
).sort();

/**
 * Runtime membership set backing {@link isPostHogRoute}. Same contents as
 * {@link POSTHOG_ROUTE_VALUES}, in the shape the validator's hot path needs.
 */
export const POSTHOG_ROUTES: ReadonlySet<PostHogRoute> = new Set<PostHogRoute>(
  POSTHOG_ROUTE_VALUES,
);

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Exact-membership guard for the closed route catalog.
 *
 * Total (accepts `unknown`), side-effect free, never throws, and allocates
 * nothing per call. It is invoked on the outbound path for every renderer
 * event, so it is deliberately a single `Set.has` behind a `typeof` guard.
 *
 * It rejects anything that is not byte-identical to a catalog member —
 * unknown routes, encoded paths, query strings, fragments, trailing slashes,
 * case variants, `String` wrapper objects, and arbitrary `app://` values.
 */
export function isPostHogRoute(value: unknown): value is PostHogRoute {
  return typeof value === 'string' && POSTHOG_ROUTES.has(value as PostHogRoute);
}

/**
 * Narrow an untrusted value to a catalog route, or `null` when it is not one.
 *
 * Total, side-effect free, and idempotent:
 * `toPostHogRoute(toPostHogRoute(x)) === toPostHogRoute(x)` for every input,
 * because `null` is itself rejected and maps back to `null`.
 */
export function toPostHogRoute(value: unknown): PostHogRoute | null {
  return isPostHogRoute(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Lookup helpers
//
// Exported so the renderer never re-derives the mapping. Each helper reads
// through the validator, which makes them safe against prototype-chain keys
// (`'constructor'`, `'toString'`, …) reaching the records at runtime.
// ---------------------------------------------------------------------------

/**
 * Route for a top-level navigation page. Total: an unrecognized value at
 * runtime degrades to the bare `app://main` fallback rather than `undefined`.
 */
export function routeForNavigationPage(page: NavigationPage): PostHogRoute {
  return toPostHogRoute(NAVIGATION_PAGE_ROUTES[page]) ?? POSTHOG_MAIN_ROUTE;
}

/**
 * Route for a Settings section. Every section has a route; `null` only when
 * an unrecognized value reaches this at runtime.
 */
export function routeForSettingsSection(
  section: SettingsSection,
): PostHogRoute | null {
  return toPostHogRoute(SETTINGS_SECTION_ROUTES[section]);
}

/**
 * Route for a hosted settings route, by scope and page. Never carries the
 * route's identifiers or query; `null` only when an unrecognized value
 * reaches this at runtime.
 */
export function routeForHostedSettingsRoute(
  route: SettingsRoute,
): PostHogRoute | null {
  return toPostHogRoute(
    HOSTED_SETTINGS_PAGE_ROUTES[hostedSettingsPageKey(route)],
  );
}

/**
 * Route for a focused panel, or `null` for kinds that deliberately produce no
 * route (currently only `chat`, which retains its containing chat route).
 */
export function routeForPanelKind(kind: PanelKind): PostHogRoute | null {
  return toPostHogRoute(PANEL_KIND_ROUTES[kind]);
}

// ---------------------------------------------------------------------------
// Wire property keys
// ---------------------------------------------------------------------------

/**
 * The validated catalog route. This is the ONLY new custom property key
 * introduced by synthetic screen routes; all route variation lives in its
 * value. It is an ordinary string property and passes through `redactText`
 * like any other — catalog routes are constructed to survive that unchanged.
 */
export const POSTHOG_SCREEN_ROUTE_PROPERTY = 'screen_route';

/**
 * PostHog's standard location key, set to the same validated route value as
 * {@link POSTHOG_SCREEN_ROUTE_PROPERTY}.
 */
export const POSTHOG_CURRENT_URL_PROPERTY = '$current_url';

/**
 * PostHog standard event names used for screen lifecycle. They are intentional
 * exceptions to the repo's custom-event naming rules; no existing event name
 * changes because of them.
 */
export const POSTHOG_PAGEVIEW_EVENT = '$pageview';
export const POSTHOG_PAGELEAVE_EVENT = '$pageleave';

/**
 * The serialized route pair carried by every captured renderer event.
 * Background (Node / main-process) events carry neither key.
 */
export interface PostHogRouteProperties {
  [POSTHOG_SCREEN_ROUTE_PROPERTY]: PostHogRoute;
  [POSTHOG_CURRENT_URL_PROPERTY]: PostHogRoute;
}

/**
 * Serialize a route onto its wire shape. Pure and allocation-light: one fresh
 * object per call, no validation side effects. Callers that hold an untrusted
 * value must run it through {@link toPostHogRoute} first.
 */
export function buildPostHogRouteProperties(
  route: PostHogRoute,
): PostHogRouteProperties {
  return {
    [POSTHOG_SCREEN_ROUTE_PROPERTY]: route,
    [POSTHOG_CURRENT_URL_PROPERTY]: route,
  };
}
