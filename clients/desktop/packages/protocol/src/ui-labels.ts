import type { WorkspaceContext } from './workspace-context';

// Product-level UI feature labels. Fixed product labels, not brand-configurable.
// Product section label. Internal plugins/marketplace identifiers and
// plugin-source marketplace terminology remain unchanged.
export const CUSTOMIZE_LABEL = 'Customize';
export const WORKTREE_LABEL = 'Code';
// Intentionally identical to WORKTREE_LABEL — 'Code' has no distinct plural form
// in this product vocabulary (unlike CHAT_LABEL/CHAT_LABEL_PLURAL).
export const WORKTREE_LABEL_PLURAL = 'Code';
export const CHAT_LABEL = 'Cowork';
// Intentionally identical to CHAT_LABEL for now — kept as a separate variable
// so the plural form can diverge again later without touching call sites.
export const CHAT_LABEL_PLURAL = 'Cowork';
// A single unit within Code or Cowork is a "Chat" in user-facing copy,
// distinct from the CHAT_LABEL feature name ("Cowork"). Capitalized for use as a
// title/heading; lowercase it inline (.toLowerCase()) for mid-sentence copy.
export const CHAT_UNIT_LABEL = 'Chat';
export const CHAT_UNIT_LABEL_PLURAL = 'Chats';
// A single unit within Code is a "Worktree" in user-facing copy, distinct from
// the WORKTREE_LABEL feature name ("Code"). Capitalized for use as a
// title/heading; lowercase it inline (.toLowerCase()) for mid-sentence copy.
export const WORKTREE_UNIT_LABEL = 'Worktree';
export const WORKTREE_UNIT_LABEL_PLURAL = 'Worktrees';
// User-facing name for a sidebar container (a code repository set or a
// Cowork folder). Internally these are still "workspaces" everywhere —
// `workspaceId`, `Workspace*` types, IPC channels, `workspace.*` App Advisor
// action ids, the CLI `workspace` command, `data-testid` values — and this
// label is the ONLY user-visible representation (CAN-1817). Capitalized for
// headings, buttons, and sentence starts; lowercase it inline
// (.toLowerCase()) for mid-sentence copy. Mobile Dart mirrors hard-code the
// same word and must be updated by hand on a rename.
export const WORKSPACE_LABEL = 'Project';
export const WORKSPACE_LABEL_PLURAL = 'Projects';
// User-facing name for the remote-control surface. Internally this feature is
// still called "Portal" in places (routes, IPC channels, Portal* types) —
// this label is the ONLY user-visible representation. It is a
// fixed product label, deliberately brand-neutral (no "<Brand>" prefix), so a
// future rename touches just this line — plus the Dart mirror below, which
// cannot import it:
//   - apps/mobile/lib/ui/features/device_link/computer_connect/connection_view.dart
//     hardcodes "Remote Control" in the setup steps that tell users which
//     desktop setting lets Computer connect find the computer.
// A rename here must update it too, or that screen names a setting that no
// longer exists. No test checks the mirror.
// Capitalized for use as a title/heading/button/nav label and at the start of a
// sentence; lowercase it inline (.toLowerCase()) for mid-sentence prose copy
// (e.g. "...before enabling remote control.").
export const REMOTE_CONTROL_LABEL = 'Remote Control';
// User-facing name for the app-wide agent formerly called "App Advisor".
// Internally this feature is still `app_advisor` / `app-advisor` /
// `APP_ADVISOR_*` (the bot id, action families, IPC channels, Portal commands,
// `AppAdvisor*` files and components, data-testid values, persisted keys and
// telemetry names) — this label is the ONLY user-visible representation. A
// proper noun: use it bare ("Open Orchestrator", no "the") and never lowercase
// it for prose. The one lowercased use is the collapsed-turn chip
// (CollapsedTurnSummary), which matches its lowercase sibling chips. The Dart
// mirrors below cannot import it and hard-code the word:
//   - apps/mobile/lib/ui/features/home/views/widgets/home_navigation_drawer.dart
//   - apps/mobile/lib/ui/core/chat/view_models/tool_call_display.dart
//   - apps/mobile/lib/ui/core/chat/view_models/turn_grouping.dart (lowercased
//     chip label, like its siblings)
//   - apps/mobile/lib/ui/features/stats/stats_aggregation.dart
//   - apps/mobile/lib/device_link/orchestrator/catalog.dart
//   - apps/mobile/lib/ui/features/device_link/computer_connect/orchestrator/controller.dart
//   - apps/mobile/lib/ui/features/device_link/computer_connect/orchestrator/screen.dart
// A rename here must update them too. No test checks the mirror.
export const ORCHESTRATOR_LABEL = 'Orchestrator';
// The name this feature shipped under. Only for matching labels stored or sent
// by older builds ({@link isOrchestratorLabel}) and for the agent-facing
// "(formerly App Advisor)" note; never render it in app UI.
export const ORCHESTRATOR_FORMER_LABEL = 'App Advisor';
// The name agents learn the feature by, at the first point a prompt introduces
// it. Later mentions in the same prompt use ORCHESTRATOR_LABEL.
export const ORCHESTRATOR_AGENT_NAME = `${ORCHESTRATOR_LABEL} (formerly ${ORCHESTRATOR_FORMER_LABEL})`;

/**
 * Whether a stored or remote-fed label names Orchestrator under its current or
 * former name. Trimmed and case-insensitive, because transcripts, notification
 * metadata and mirrored tab titles written by older builds still carry
 * "App Advisor". The one place that knows both names.
 */
export function isOrchestratorLabel(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === ORCHESTRATOR_LABEL.toLowerCase() ||
    normalized === ORCHESTRATOR_FORMER_LABEL.toLowerCase()
  );
}
// Execution-location label for cloud-backed rows, the counterpart to
// REMOTE_CONTROL_LABEL. A bare noun on purpose: it names WHERE the work runs,
// not the hosted product (which is brand-derived as "<Brand> Cloud"), so it
// stays correct under every brand pack and needs no brand runtime.
export const CLOUD_BACKEND_LABEL = 'Cloud';
// Stable provisioned name for the automatic first cloud workspace. Separate
// from desktop catch-all names, so it never affects desktop rename policy.
export const CLOUD_FIRST_WORKSPACE_NAME = 'My project';
// The catch-all Cowork workspace's stable id. Its name is user-editable, so
// anything that must find THAT workspace (the desktop Chats section, the
// shared sidebar's Chats hoist) keys on this id and uses the name only for
// the label.
export const DEFAULT_COWORK_WORKSPACE_ID = 'cowork-default';
export const DEFAULT_COWORK_WORKSPACE_NAME = CHAT_UNIT_LABEL_PLURAL;

// Each organization's own catch-all Cowork workspace (its `Chats` section) has
// a deterministic id derived from the organization id, so concurrent
// provisioning can never create two and no lookup table is needed. The lower
// case UUID keeps the id inside `validateId`'s `/^[a-z0-9][a-z0-9-]*$/`.
export const ORG_DEFAULT_COWORK_WORKSPACE_ID_PREFIX = 'cowork-org-';
export const ORG_COWORK_PROJECT_WORKSPACE_ID_PREFIX = 'cowork-project-';

const ORG_DEFAULT_COWORK_WORKSPACE_ID_PATTERN =
  /^cowork-org-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The default Chats workspace id for one organization. */
export function orgDefaultCoworkWorkspaceId(organizationId: string): string {
  return `${ORG_DEFAULT_COWORK_WORKSPACE_ID_PREFIX}${organizationId.trim().toLowerCase()}`;
}

/** The deterministic local Cowork workspace id for an organization project. */
export function orgCoworkProjectWorkspaceId(projectId: string): string {
  return `${ORG_COWORK_PROJECT_WORKSPACE_ID_PREFIX}${projectId.trim().toLowerCase()}`;
}

/** Whether `id` is an organization's default Chats workspace id. */
export function isOrgDefaultCoworkWorkspaceId(id: string): boolean {
  return ORG_DEFAULT_COWORK_WORKSPACE_ID_PATTERN.test(id);
}

/** Whether `id` is the Personal or an organization default Chats workspace. */
export function isDefaultCoworkWorkspaceId(id: string): boolean {
  return (
    id === DEFAULT_COWORK_WORKSPACE_ID || isOrgDefaultCoworkWorkspaceId(id)
  );
}

/**
 * The default Chats workspace for a navigation context: the organization's
 * own for an organization, and the Personal `cowork-default` otherwise
 * (including before the context is known).
 */
export function defaultCoworkWorkspaceIdForContext(
  context: WorkspaceContext | undefined,
): string {
  return context?.kind === 'organization'
    ? orgDefaultCoworkWorkspaceId(context.organizationId)
    : DEFAULT_COWORK_WORKSPACE_ID;
}

// Names earlier desktop versions auto-assigned to the catch-all Cowork
// workspace (the one that renders as the `Chats` section). A stored name
// outside this set was chosen by the user and is never rewritten by the
// desktop rename migration, nor withheld by the surfaces that decline to name
// the catch-all. Lives here, not beside the migration, because the shared
// sidebar in `@canopy/ui-app` and the desktop renderer ask the same question
// of a workspace name and neither can import main-process modules.
export const LEGACY_DEFAULT_COWORK_WORKSPACE_NAMES: readonly string[] = [
  'Personal',
  'Default',
];

const DEFAULT_COWORK_WORKSPACE_NAMES: readonly string[] = [
  DEFAULT_COWORK_WORKSPACE_NAME,
  ...LEGACY_DEFAULT_COWORK_WORKSPACE_NAMES,
];

/**
 * Whether a Cowork workspace name is one the app assigned rather than one the
 * user chose. A blank name counts as default: it is not a deliberate choice
 * either. A deliberate rename *to* a legacy name is indistinguishable from an
 * install the migration has not reached yet, so it is treated as app-assigned.
 *
 * Kept in one place because several surfaces ask the same question — the
 * desktop sidebar's Chats header, the New task composer's trigger, and the
 * shared sidebar that hoists the catch-all above Projects — and answering it
 * differently is what puts them out of step.
 */
export function isDefaultCoworkWorkspaceName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === '' || DEFAULT_COWORK_WORKSPACE_NAMES.includes(trimmed);
}

/**
 * The synthetic repo id standing for "the workspace root itself", and the name
 * shown for it. This is the one declaration: `@canopy/desktop-shared/types`
 * re-exports it for the desktop runtime, and `apps/web` re-exports it from
 * `remote-control-chat-selectors`, so neither keeps a copy that could drift. The
 * desktop send path resolves an omitted `selectedRepoId` to this sentinel and
 * `validateOptionalRepoId` whitelists it, so it is the correct wire value for
 * an explicit workspace-root selection.
 */
export const WORKSPACE_ROOT_REPO_ID = '__workspace_root__';
export const WORKSPACE_ROOT_REPO_NAME = 'Project root';

/** Stable identity of the Cowork working-folder root; its display name is user-owned. */
export const COWORK_WORKSPACE_FILE_ROOT_ID = 'workspace';
